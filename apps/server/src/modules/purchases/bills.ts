/**
 * Purchase bills (GRN + supplier invoice) — drafts, reads, lists and the order / returnable
 * helpers. Posting and cancellation (stock, batches, journal, prices) live in ./posting.ts.
 *
 *  - Every save recomputes the whole bill server-side with purchaseBillTotals() (shared with the
 *    bill-entry grid): line amounts, other charges allocated pro-rata to taxable value, landed
 *    cost per pack over charged + free quantity (non-ITC tax capitalised), and the round-off
 *    (automatic nearest rupee, or the supplier's exact `round_off_paise`).
 *  - A supplier invoice number may be used once per supplier per financial year (of the supplier
 *    invoice date) across drafts and posted bills: 409 DUPLICATE {reason:
 *    'duplicate_supplier_invoice', existing_bill_id, …}. The check runs under a transaction
 *    advisory lock so two concurrent saves cannot both pass.
 *  - Lines of batch-tracked products need batch_no + expiry_date whenever lines are submitted
 *    (drafts made from a purchase order may lack them until edited; posting re-checks).
 *  - Bills linked to a purchase order: lines are linked to the PO line of the same product
 *    (or the given purchase_order_line_id, validated).
 */
import { type Selectable, sql } from 'kysely'
import {
  type PurchaseBillStatus,
  type PurchasePaymentStatus,
  addDays,
  diffDays,
  fyOf,
  fyRange,
  newId,
  taxBreakup,
} from '@kadai/shared'
import { toCsv } from '@kadai/shared/api/identity'
import {
  type BillReturnableResponse,
  type PurchaseBillCreateSchema,
  type PurchaseBillDetail,
  type PurchaseBillFromOrderSchema,
  type PurchaseBillLineInputSchema,
  type PurchaseBillListQuerySchema,
  type PurchaseBillListRow,
  type PurchaseBillUpdateSchema,
  type PurchaseWarning,
  purchaseBillTotals,
  purchaseLineWarnings,
} from '@kadai/shared/api/purchases'
import type { PurchaseDocumentResult } from '@kadai/shared'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { AppError, assertNotStale, notFound } from '../../core/errors'
import type { PageParams } from '../../core/http'
import { assertStoreAccess } from '../../core/http'
import { getSettings } from '../../core/settings'
import type { DB } from '../../db/schema.generated'
import type { Tx } from '../../db/tenant'
import {
  CSV_MAX_ROWS,
  type Ctx,
  type ProductInfo,
  type StoreInfo,
  type SupplierInfo,
  advisoryLock,
  assertPurchasable,
  businessToday,
  csvRupees,
  fieldIssues,
  iso,
  journalEntryOf,
  lastPurchases,
  loadProducts,
  loadStore,
  loadSupplier,
  loadTenant,
  paginateQuery,
  paymentsFor,
  productRef,
  reasonError,
  stockByBatch,
  stockByProduct,
  storeFilter,
  supplierRef,
  supplyIsInterstate,
  userNames,
} from './common'
import { likePattern, loadOrder } from './orders'

type BillCreate = z.output<typeof PurchaseBillCreateSchema>
type BillUpdate = z.output<typeof PurchaseBillUpdateSchema>
type BillFromOrder = z.output<typeof PurchaseBillFromOrderSchema>
type BillLineIn = z.output<typeof PurchaseBillLineInputSchema>
type BillListQuery = z.output<typeof PurchaseBillListQuerySchema>

export type BillRow = Selectable<DB['purchase_bills']>
export type BillLineRow = Selectable<DB['purchase_bill_lines']>

// ---------------------------------------------------------------------------------------------
// Line sources and totals
// ---------------------------------------------------------------------------------------------

/** One bill line as entered (defaults resolved), the input of the totals. */
export interface BillLineSource {
  product_id: string
  purchase_order_line_id: string | null
  batch_no: string | null
  mfg_date: string | null
  expiry_date: string | null
  mrp_paise: number | null
  qty_milli: number
  free_qty_milli: number
  unit_cost_paise: number
  discount_bp: number
  discount_paise: number
  gst_rate_bp: number
  cess_rate_bp: number
  hsn_code: string | null
  sale_price_paise: number | null
  /** Snapshot of the product's unit / pack size. */
  unit: string
  pack_size: number
}

function sourceFromInput(l: BillLineIn, p: ProductInfo): BillLineSource {
  return {
    product_id: l.product_id,
    purchase_order_line_id: l.purchase_order_line_id ?? null,
    batch_no: l.batch_no ?? null,
    mfg_date: l.mfg_date ?? null,
    expiry_date: l.expiry_date ?? null,
    mrp_paise: l.mrp_paise ?? null,
    qty_milli: l.qty_milli,
    free_qty_milli: l.free_qty_milli ?? 0,
    unit_cost_paise: l.unit_cost_paise,
    discount_bp: l.discount_bp ?? 0,
    discount_paise: l.discount_paise ?? 0,
    gst_rate_bp: l.gst_rate_bp ?? p.gst_rate_bp,
    cess_rate_bp: l.cess_rate_bp ?? p.cess_rate_bp,
    hsn_code: l.hsn_code ?? p.hsn_code,
    sale_price_paise: l.sale_price_paise ?? null,
    unit: p.unit,
    pack_size: p.pack_size,
  }
}

export function sourceFromRow(r: BillLineRow): BillLineSource {
  return {
    product_id: r.product_id,
    purchase_order_line_id: r.purchase_order_line_id,
    batch_no: r.batch_no,
    mfg_date: r.mfg_date,
    expiry_date: r.expiry_date,
    mrp_paise: r.mrp_paise,
    qty_milli: r.qty_milli,
    free_qty_milli: r.free_qty_milli,
    unit_cost_paise: r.unit_cost_paise,
    discount_bp: r.discount_bp,
    discount_paise: r.discount_paise,
    gst_rate_bp: r.gst_rate_bp,
    cess_rate_bp: r.cess_rate_bp,
    hsn_code: r.hsn_code,
    sale_price_paise: r.sale_price_paise,
    unit: r.unit,
    pack_size: r.pack_size,
  }
}

export interface BillTotalsInput {
  is_interstate: boolean
  itc_eligible: boolean
  other_charges_paise: number
  /** null = automatic nearest-rupee round-off. */
  round_off_override: number | null
}

export function computeBill(
  header: BillTotalsInput,
  lines: readonly BillLineSource[],
): PurchaseDocumentResult {
  return purchaseBillTotals({
    lines: lines.map((l, i) => ({
      key: String(i),
      unit_cost_paise: l.unit_cost_paise,
      qty_milli: l.qty_milli,
      free_qty_milli: l.free_qty_milli,
      pack_size: l.pack_size,
      discount_bp: l.discount_bp,
      discount_paise: l.discount_paise,
      gst_rate_bp: l.gst_rate_bp,
      cess_rate_bp: l.cess_rate_bp,
    })),
    is_interstate: header.is_interstate,
    other_charges_paise: header.other_charges_paise,
    itc_eligible: header.itc_eligible,
    round_off_paise: header.round_off_override,
  })
}

/**
 * The stored bill's round-off mode: automatic when the stored round-off equals the automatic
 * one for the stored lines, else the supplier's override.
 */
export function storedRoundOffOverride(
  bill: BillRow,
  lines: readonly BillLineSource[],
): number | null {
  const auto = computeBill(
    {
      is_interstate: bill.is_interstate,
      itc_eligible: bill.itc_eligible,
      other_charges_paise: bill.other_charges_paise,
      round_off_override: null,
    },
    lines,
  )
  return auto.round_off_paise === bill.round_off_paise ? null : bill.round_off_paise
}

/** Payable to the supplier: the total, less the GST for reverse-charge bills. */
export function supplierPayable(
  totals: Pick<PurchaseDocumentResult, 'total_paise' | 'tax_paise'>,
  reverseCharge: boolean,
): number {
  return reverseCharge ? Math.max(0, totals.total_paise - totals.tax_paise) : totals.total_paise
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** batch_no + expiry_date for batch-tracked products (400 with every missing field). */
export function assertBatchFields(
  lines: readonly BillLineSource[],
  products: ReadonlyMap<string, ProductInfo>,
): void {
  const issues: Array<{
    path: Array<string | number>
    key: 'batch_no_required' | 'expiry_required'
  }> = []
  lines.forEach((l, i) => {
    if (!products.get(l.product_id)?.track_batches) return
    if (!l.batch_no) issues.push({ path: ['lines', i, 'batch_no'], key: 'batch_no_required' })
    if (!l.expiry_date) issues.push({ path: ['lines', i, 'expiry_date'], key: 'expiry_required' })
  })
  if (issues.length) throw fieldIssues(issues)
}

interface OrderLink {
  id: string
  supplier_id: string
  store_id: string
  status: string
  number: string
  lines: Map<
    string,
    { id: string; product_id: string; qty_milli: number; received_qty_milli: number }
  >
}

const RECEIVABLE_ORDER_STATUSES = new Set(['draft', 'sent', 'partially_received'])

/** Loads the bill's purchase order and checks it can receive goods for this supplier / store. */
export async function loadOrderLink(
  tx: Tx,
  ctx: Ctx,
  orderId: string,
  bill: { supplier_id: string; store_id: string },
): Promise<OrderLink> {
  const o = await loadOrder(tx, ctx, orderId)
  if (o.supplier_id !== bill.supplier_id || o.store_id !== bill.store_id) {
    throw reasonError(
      'UNPROCESSABLE',
      'order_mismatch',
      `Purchase order ${o.number} belongs to another supplier or store`,
      { purchase_order_id: o.id },
    )
  }
  if (!RECEIVABLE_ORDER_STATUSES.has(o.status)) {
    throw reasonError(
      'UNPROCESSABLE',
      'order_not_receivable',
      `Purchase order ${o.number} is ${o.status}; goods cannot be received against it`,
      { purchase_order_id: o.id, status: o.status },
    )
  }
  const lines = await tx
    .selectFrom('purchase_order_lines')
    .select(['id', 'product_id', 'qty_milli', 'received_qty_milli'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('purchase_order_id', '=', o.id)
    .orderBy('line_no')
    .execute()
  return {
    id: o.id,
    supplier_id: o.supplier_id,
    store_id: o.store_id,
    status: o.status,
    number: o.number,
    lines: new Map(lines.map((l) => [l.id, l])),
  }
}

/** Links lines to PO lines (same product), validating explicit links. */
function linkOrderLines(lines: BillLineSource[], order: OrderLink | null): void {
  const byProduct = new Map<string, string>()
  if (order)
    for (const l of order.lines.values())
      if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, l.id)
  lines.forEach((l, i) => {
    if (!order) {
      if (l.purchase_order_line_id) {
        throw reasonError(
          'UNPROCESSABLE',
          'order_line_mismatch',
          'A line refers to a purchase order line but the bill has no purchase order',
          { line_no: i + 1, purchase_order_line_id: l.purchase_order_line_id },
        )
      }
      return
    }
    if (l.purchase_order_line_id) {
      const pl = order.lines.get(l.purchase_order_line_id)
      if (!pl || pl.product_id !== l.product_id) {
        throw reasonError(
          'UNPROCESSABLE',
          'order_line_mismatch',
          `Line ${i + 1} does not match a line of purchase order ${order.number}`,
          { line_no: i + 1, purchase_order_line_id: l.purchase_order_line_id },
        )
      }
    } else {
      l.purchase_order_line_id = byProduct.get(l.product_id) ?? null
    }
  })
}

/**
 * Dates may not lie in the future (supplier invoice date, received date), and the bill cannot
 * fall due before it was issued.
 */
function assertDates(
  h: { supplier_invoice_date: string; received_date: string; due_date: string | null },
  today: string,
): void {
  const issues: Array<{ path: string[]; key: 'future_date' | 'date_order' }> = []
  if (h.supplier_invoice_date > today)
    issues.push({ path: ['supplier_invoice_date'], key: 'future_date' })
  if (h.received_date > today) issues.push({ path: ['received_date'], key: 'future_date' })
  if (h.due_date !== null && h.due_date < h.supplier_invoice_date)
    issues.push({ path: ['due_date'], key: 'date_order' })
  if (issues.length) throw fieldIssues(issues)
}

/**
 * Duplicate guard: the supplier invoice number is unique per supplier per financial year (of the
 * supplier invoice date) among non-cancelled bills. Serialised with an advisory lock.
 */
export async function assertUniqueSupplierInvoice(
  tx: Tx,
  ctx: Ctx,
  input: {
    supplier_id: string
    supplier_invoice_no: string
    supplier_invoice_date: string
    exclude_bill_id?: string | null
    /** GRN financial year being assigned (posting): also unique per (supplier, fy) in the DB. */
    grn_fy?: string | null
  },
): Promise<void> {
  const no = input.supplier_invoice_no.trim()
  if (!no) return
  await advisoryLock(
    tx,
    `purchase_bill_invoice:${ctx.tenantId}:${input.supplier_id}:${no.toLowerCase()}`,
  )
  const { fyStartMonth } = await businessToday(tx, ctx)
  const range = fyRange(fyOf(input.supplier_invoice_date, fyStartMonth), fyStartMonth)
  let q = tx
    .selectFrom('purchase_bills')
    .select(['id', 'number', 'status'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('supplier_id', '=', input.supplier_id)
    .where(sql<boolean>`lower(supplier_invoice_no) = ${no.toLowerCase()}`)
    .where('status', '<>', 'cancelled')
    .where((eb) => {
      const sameInvoiceFy = eb.and([
        eb('supplier_invoice_date', '>=', range.from),
        eb('supplier_invoice_date', '<=', range.to),
      ])
      return input.grn_fy ? eb.or([sameInvoiceFy, eb('fy', '=', input.grn_fy)]) : sameInvoiceFy
    })
  if (input.exclude_bill_id) q = q.where('id', '<>', input.exclude_bill_id)
  const existing = await q.orderBy('created_at').executeTakeFirst()
  if (existing) {
    throw new AppError(
      'DUPLICATE',
      `Supplier invoice ${no} was already entered for this supplier in this financial year`,
      {
        reason: 'duplicate_supplier_invoice',
        existing_bill_id: existing.id,
        existing_number: existing.number,
        existing_status: existing.status,
      },
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Save (create / update / from order)
// ---------------------------------------------------------------------------------------------

interface BillHeader {
  store: StoreInfo
  supplier: SupplierInfo
  purchase_order_id: string | null
  supplier_invoice_no: string
  supplier_invoice_date: string
  received_date: string
  due_date: string | null
  is_interstate: boolean
  reverse_charge: boolean
  itc_eligible: boolean
  other_charges_paise: number
  round_off_override: number | null
  notes: string | null
  attachment_file_id: string | null
}

function defaultDueDate(supplier: SupplierInfo, invoiceDate: string): string | null {
  return supplier.payment_terms_days != null
    ? addDays(invoiceDate, supplier.payment_terms_days)
    : null
}

/** Composition / unregistered shops cannot claim input tax credit (tax becomes cost). */
async function itcAllowed(tx: Tx, ctx: Ctx): Promise<boolean> {
  return (await loadTenant(tx, ctx)).gst_scheme === 'regular'
}

function lineValues(
  ctx: Ctx,
  billId: string,
  lines: readonly BillLineSource[],
  totals: PurchaseDocumentResult,
): Array<Omit<BillLineRow, 'returned_qty_milli' | 'batch_id'> & { batch_id: null }> {
  return lines.map((l, i) => {
    const r = totals.lines[i]!
    return {
      id: newId(),
      tenant_id: ctx.tenantId,
      bill_id: billId,
      line_no: i + 1,
      product_id: l.product_id,
      purchase_order_line_id: l.purchase_order_line_id,
      batch_id: null,
      batch_no: l.batch_no,
      mfg_date: l.mfg_date,
      expiry_date: l.expiry_date,
      hsn_code: l.hsn_code,
      unit: l.unit,
      pack_size: l.pack_size,
      qty_milli: l.qty_milli,
      free_qty_milli: l.free_qty_milli,
      mrp_paise: l.mrp_paise,
      unit_cost_paise: l.unit_cost_paise,
      discount_bp: l.discount_bp,
      // The flat discount as entered (the bp part is recomputed from discount_bp).
      discount_paise: l.discount_paise,
      gross_paise: r.gross_paise,
      taxable_paise: r.taxable_paise,
      gst_rate_bp: r.gst_rate_bp,
      cgst_paise: r.cgst_paise,
      sgst_paise: r.sgst_paise,
      igst_paise: r.igst_paise,
      cess_rate_bp: r.cess_rate_bp,
      cess_paise: r.cess_paise,
      total_paise: r.total_paise,
      landed_unit_cost_paise: r.landed_unit_cost_paise,
      sale_price_paise: l.sale_price_paise,
    }
  })
}

function headerValues(h: BillHeader, totals: PurchaseDocumentResult) {
  return {
    store_id: h.store.id,
    supplier_id: h.supplier.id,
    purchase_order_id: h.purchase_order_id,
    supplier_invoice_no: h.supplier_invoice_no,
    supplier_invoice_date: h.supplier_invoice_date,
    received_date: h.received_date,
    due_date: h.due_date,
    supplier_gstin: h.supplier.gstin,
    supplier_state_code: h.supplier.state_code,
    is_interstate: h.is_interstate,
    reverse_charge: h.reverse_charge,
    itc_eligible: h.itc_eligible,
    gross_paise: totals.gross_paise,
    discount_paise: totals.discount_paise,
    taxable_paise: totals.taxable_paise,
    cgst_paise: totals.cgst_paise,
    sgst_paise: totals.sgst_paise,
    igst_paise: totals.igst_paise,
    cess_paise: totals.cess_paise,
    other_charges_paise: totals.other_charges_paise,
    round_off_paise: totals.round_off_paise,
    total_paise: totals.total_paise,
    notes: h.notes,
    attachment_file_id: h.attachment_file_id,
  }
}

async function prepareLines(
  tx: Tx,
  ctx: Ctx,
  inputs: readonly BillLineIn[],
  opts: { validateBatches: boolean },
): Promise<{ lines: BillLineSource[]; products: Map<string, ProductInfo> }> {
  const products = await loadProducts(
    tx,
    ctx,
    inputs.map((l) => l.product_id),
  )
  const lines = inputs.map((l, i) => {
    const p = products.get(l.product_id)!
    assertPurchasable(p, i + 1)
    return sourceFromInput(l, p)
  })
  if (opts.validateBatches) assertBatchFields(lines, products)
  return { lines, products }
}

export async function createBill(tx: Tx, ctx: Ctx, body: BillCreate): Promise<PurchaseBillDetail> {
  const store = await loadStore(tx, ctx, body.store_id, { requireActive: true })
  const supplier = await loadSupplier(tx, ctx, body.supplier_id, { requireActive: true })
  const { today } = await businessToday(tx, ctx)
  const header: BillHeader = {
    store,
    supplier,
    purchase_order_id: body.purchase_order_id ?? null,
    supplier_invoice_no: body.supplier_invoice_no.trim(),
    supplier_invoice_date: body.supplier_invoice_date,
    received_date: body.received_date ?? today,
    due_date: body.due_date ?? defaultDueDate(supplier, body.supplier_invoice_date),
    is_interstate: body.is_interstate ?? supplyIsInterstate(store, supplier),
    reverse_charge: body.reverse_charge,
    itc_eligible: body.itc_eligible && (await itcAllowed(tx, ctx)),
    other_charges_paise: body.other_charges_paise,
    round_off_override: body.round_off_paise ?? null,
    notes: body.notes?.trim() ? body.notes.trim() : null,
    attachment_file_id: body.attachment_file_id ?? null,
  }
  assertDates(header, today)
  const { lines } = await prepareLines(tx, ctx, body.lines, { validateBatches: true })
  return insertDraft(tx, ctx, header, lines)
}

async function insertDraft(
  tx: Tx,
  ctx: Ctx,
  header: BillHeader,
  lines: BillLineSource[],
): Promise<PurchaseBillDetail> {
  const order = header.purchase_order_id
    ? await loadOrderLink(tx, ctx, header.purchase_order_id, {
        supplier_id: header.supplier.id,
        store_id: header.store.id,
      })
    : null
  linkOrderLines(lines, order)
  await assertUniqueSupplierInvoice(tx, ctx, {
    supplier_id: header.supplier.id,
    supplier_invoice_no: header.supplier_invoice_no,
    supplier_invoice_date: header.supplier_invoice_date,
  })
  const totals = computeBill(header, lines)
  const id = newId()
  await tx
    .insertInto('purchase_bills')
    .values({
      id,
      tenant_id: ctx.tenantId,
      ...headerValues(header, totals),
      status: 'draft',
      created_by: ctx.userId,
    })
    .execute()
  await tx
    .insertInto('purchase_bill_lines')
    .values(lineValues(ctx, id, lines, totals))
    .execute()
  return billDetail(tx, ctx, id)
}

export async function loadBill(
  tx: Tx,
  ctx: Ctx,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<BillRow> {
  let q = tx
    .selectFrom('purchase_bills')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('purchase_bill', id)
  assertStoreAccess(ctx, row.store_id)
  return row
}

export async function loadBillLines(tx: Tx, ctx: Ctx, billId: string): Promise<BillLineRow[]> {
  return tx
    .selectFrom('purchase_bill_lines')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('bill_id', '=', billId)
    .orderBy('line_no')
    .execute()
}

export function assertBillDraft(bill: BillRow, action: string): void {
  if (bill.status !== 'draft') {
    throw reasonError(
      'CONFLICT',
      'bill_not_draft',
      `Purchase bill ${bill.number ?? bill.supplier_invoice_no} is ${bill.status}; only drafts can be ${action}`,
      { bill_id: bill.id, status: bill.status },
    )
  }
}

export async function updateBill(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: BillUpdate,
): Promise<PurchaseBillDetail> {
  const bill = await loadBill(tx, ctx, id, { forUpdate: true })
  assertNotStale(bill.updated_at, body.if_updated_at, 'purchase_bill', bill.id)
  assertBillDraft(bill, 'edited')
  const { today } = await businessToday(tx, ctx)
  const store = await loadStore(tx, ctx, bill.store_id)
  const oldSupplier = await loadSupplier(tx, ctx, bill.supplier_id)
  const supplierChanged = body.supplier_id !== undefined && body.supplier_id !== bill.supplier_id
  const supplier = supplierChanged
    ? await loadSupplier(tx, ctx, body.supplier_id!, { requireActive: true })
    : oldSupplier
  const storedRows = await loadBillLines(tx, ctx, bill.id)
  const storedLines = storedRows.map(sourceFromRow)

  const invoiceDate = body.supplier_invoice_date ?? bill.supplier_invoice_date
  let dueDate: string | null
  if (body.due_date !== undefined) dueDate = body.due_date
  else if (
    (supplierChanged || invoiceDate !== bill.supplier_invoice_date) &&
    bill.due_date === defaultDueDate(oldSupplier, bill.supplier_invoice_date)
  ) {
    dueDate = defaultDueDate(supplier, invoiceDate)
  } else dueDate = bill.due_date

  const header: BillHeader = {
    store,
    supplier,
    purchase_order_id:
      body.purchase_order_id === undefined ? bill.purchase_order_id : body.purchase_order_id,
    supplier_invoice_no: (body.supplier_invoice_no ?? bill.supplier_invoice_no).trim(),
    supplier_invoice_date: invoiceDate,
    received_date: body.received_date ?? bill.received_date,
    due_date: dueDate,
    is_interstate:
      body.is_interstate ??
      (supplierChanged ? supplyIsInterstate(store, supplier) : bill.is_interstate),
    reverse_charge: body.reverse_charge ?? bill.reverse_charge,
    itc_eligible: (body.itc_eligible ?? bill.itc_eligible) && (await itcAllowed(tx, ctx)),
    other_charges_paise: body.other_charges_paise ?? bill.other_charges_paise,
    round_off_override:
      body.round_off_paise === undefined
        ? storedRoundOffOverride(bill, storedLines)
        : body.round_off_paise,
    notes: body.notes === undefined ? bill.notes : body.notes,
    attachment_file_id:
      body.attachment_file_id === undefined ? bill.attachment_file_id : body.attachment_file_id,
  }
  assertDates(header, today)

  let lines: BillLineSource[]
  if (body.lines) {
    lines = (await prepareLines(tx, ctx, body.lines, { validateBatches: true })).lines
  } else {
    lines = storedLines
    if (header.purchase_order_id !== bill.purchase_order_id) {
      for (const l of lines) l.purchase_order_line_id = null
    }
  }
  const order = header.purchase_order_id
    ? await loadOrderLink(tx, ctx, header.purchase_order_id, {
        supplier_id: header.supplier.id,
        store_id: header.store.id,
      })
    : null
  linkOrderLines(lines, order)
  await assertUniqueSupplierInvoice(tx, ctx, {
    supplier_id: header.supplier.id,
    supplier_invoice_no: header.supplier_invoice_no,
    supplier_invoice_date: header.supplier_invoice_date,
    exclude_bill_id: bill.id,
  })
  const totals = computeBill(header, lines)
  await tx
    .updateTable('purchase_bills')
    .set({ ...headerValues(header, totals), updated_at: new Date() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', bill.id)
    .execute()
  if (body.lines) {
    await tx
      .deleteFrom('purchase_bill_lines')
      .where('tenant_id', '=', ctx.tenantId)
      .where('bill_id', '=', bill.id)
      .execute()
    await tx
      .insertInto('purchase_bill_lines')
      .values(lineValues(ctx, bill.id, lines, totals))
      .execute()
  } else {
    const values = lineValues(ctx, bill.id, lines, totals)
    for (const [i, row] of storedRows.entries()) {
      const { id: _newId, tenant_id: _t, bill_id: _b, line_no: _n, ...rest } = values[i]!
      await tx
        .updateTable('purchase_bill_lines')
        .set(rest)
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', row.id)
        .execute()
    }
  }
  return billDetail(tx, ctx, bill.id)
}

export async function deleteBill(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const bill = await loadBill(tx, ctx, id, { forUpdate: true })
  assertBillDraft(bill, 'deleted')
  await tx
    .deleteFrom('purchase_bills')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', bill.id)
    .execute()
  await audit(tx, ctx, {
    action: 'purchase_bill.delete',
    entity_type: 'purchase_bill',
    entity_id: bill.id,
    summary: `Draft purchase bill (supplier invoice ${bill.supplier_invoice_no || '—'}) deleted`,
    changes: {
      supplier_id: bill.supplier_id,
      supplier_invoice_no: bill.supplier_invoice_no,
      total_paise: bill.total_paise,
    },
  })
}

/** POST /purchase-bills/from-order/:orderId — a draft with the order's pending quantities. */
export async function billFromOrder(
  tx: Tx,
  ctx: Ctx,
  orderId: string,
  body: BillFromOrder,
): Promise<PurchaseBillDetail> {
  const o = await loadOrder(tx, ctx, orderId, { forUpdate: true })
  const store = await loadStore(tx, ctx, o.store_id, { requireActive: true })
  const supplier = await loadSupplier(tx, ctx, o.supplier_id, { requireActive: true })
  if (!RECEIVABLE_ORDER_STATUSES.has(o.status)) {
    throw reasonError(
      'UNPROCESSABLE',
      'order_not_receivable',
      `Purchase order ${o.number} is ${o.status}; goods cannot be received against it`,
      { purchase_order_id: o.id, status: o.status },
    )
  }
  const poLines = await tx
    .selectFrom('purchase_order_lines')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('purchase_order_id', '=', o.id)
    .orderBy('line_no')
    .execute()
  const pending = poLines.filter((l) => l.qty_milli > l.received_qty_milli)
  if (pending.length === 0) {
    throw reasonError(
      'UNPROCESSABLE',
      'order_not_receivable',
      `Nothing is pending on purchase order ${o.number}`,
      { purchase_order_id: o.id, status: o.status },
    )
  }
  const products = await loadProducts(
    tx,
    ctx,
    pending.map((l) => l.product_id),
  )
  const lines = pending.map((l, i): BillLineSource => {
    const p = products.get(l.product_id)!
    assertPurchasable(p, i + 1)
    return {
      product_id: l.product_id,
      purchase_order_line_id: l.id,
      batch_no: null,
      mfg_date: null,
      expiry_date: null,
      mrp_paise: p.mrp_paise,
      qty_milli: l.qty_milli - l.received_qty_milli,
      free_qty_milli: 0,
      unit_cost_paise: l.unit_cost_paise,
      discount_bp: 0,
      discount_paise: 0,
      gst_rate_bp: l.gst_rate_bp,
      cess_rate_bp: p.cess_rate_bp,
      hsn_code: p.hsn_code,
      sale_price_paise: null,
      unit: p.unit,
      pack_size: p.pack_size,
    }
  })
  const { today } = await businessToday(tx, ctx)
  const invoiceDate = body.supplier_invoice_date ?? today
  const header: BillHeader = {
    store,
    supplier,
    purchase_order_id: o.id,
    supplier_invoice_no: (body.supplier_invoice_no ?? '').trim(),
    supplier_invoice_date: invoiceDate,
    received_date: body.received_date ?? today,
    due_date: defaultDueDate(supplier, invoiceDate),
    is_interstate: o.is_interstate,
    reverse_charge: false,
    itc_eligible: await itcAllowed(tx, ctx),
    other_charges_paise: 0,
    round_off_override: null,
    notes: null,
    attachment_file_id: null,
  }
  assertDates(header, today)
  return insertDraft(tx, ctx, header, lines)
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

function overdueOf(
  b: { status: string; due_paise: number; due_date: string | null },
  today: string,
): { overdue: boolean; days_overdue: number | null } {
  const overdue =
    b.status === 'posted' && b.due_paise > 0 && b.due_date !== null && b.due_date < today
  return { overdue, days_overdue: overdue ? diffDays(b.due_date!, today) : null }
}

/** Live debit-note amounts per bill line (input of prorateReturnLine). */
export async function creditedByLine(
  tx: Tx,
  ctx: Ctx,
  billLineIds: readonly string[],
): Promise<
  Map<
    string,
    {
      taxable_paise: number
      cgst_paise: number
      sgst_paise: number
      igst_paise: number
      cess_paise: number
    }
  >
> {
  if (billLineIds.length === 0) return new Map()
  const rows = await tx
    .selectFrom('debit_note_lines as l')
    .innerJoin('debit_notes as d', (j) =>
      j.onRef('d.tenant_id', '=', 'l.tenant_id').onRef('d.id', '=', 'l.debit_note_id'),
    )
    .select([
      'l.bill_line_id',
      sql<number>`sum(l.taxable_paise)::bigint`.as('taxable_paise'),
      sql<number>`sum(l.cgst_paise)::bigint`.as('cgst_paise'),
      sql<number>`sum(l.sgst_paise)::bigint`.as('sgst_paise'),
      sql<number>`sum(l.igst_paise)::bigint`.as('igst_paise'),
      sql<number>`sum(l.cess_paise)::bigint`.as('cess_paise'),
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.bill_line_id', 'in', [...billLineIds])
    .where('d.status', '=', 'completed')
    .groupBy('l.bill_line_id')
    .execute()
  return new Map(
    rows.map((r) => [
      r.bill_line_id!,
      {
        taxable_paise: Number(r.taxable_paise),
        cgst_paise: Number(r.cgst_paise),
        sgst_paise: Number(r.sgst_paise),
        igst_paise: Number(r.igst_paise),
        cess_paise: Number(r.cess_paise),
      },
    ]),
  )
}

async function billWarnings(
  tx: Tx,
  ctx: Ctx,
  bill: BillRow,
  lines: readonly BillLineRow[],
  products: ReadonlyMap<string, ProductInfo>,
  lastCost: ReadonlyMap<string, { unit_cost_paise: number }>,
  today: string,
): Promise<PurchaseWarning[]> {
  const settings = await getSettings(tx, ctx)
  const out: PurchaseWarning[] = []
  const store = await loadStore(tx, ctx, bill.store_id)
  const supplier = await loadSupplier(tx, ctx, bill.supplier_id)
  const expected = supplyIsInterstate(store, supplier)
  if (expected !== bill.is_interstate) {
    out.push({
      code: 'interstate_mismatch',
      line_no: null,
      product_id: null,
      params: { expected_interstate: expected },
    })
  }
  // Existing batches (MRP of the batch rather than the product).
  const batchKeys = lines.filter((l) => l.batch_no)
  const batches = batchKeys.length
    ? await tx
        .selectFrom('batches')
        .select(['product_id', 'batch_no', 'mrp_paise'])
        .where('tenant_id', '=', ctx.tenantId)
        .where(
          'product_id',
          'in',
          batchKeys.map((l) => l.product_id),
        )
        .execute()
    : []
  const batchMrp = new Map(batches.map((b) => [`${b.product_id}|${b.batch_no}`, b.mrp_paise]))
  const pending = new Map<string, number>()
  if (bill.purchase_order_id) {
    const poLines = await tx
      .selectFrom('purchase_order_lines')
      .select(['id', 'qty_milli', 'received_qty_milli'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('purchase_order_id', '=', bill.purchase_order_id)
      .execute()
    for (const l of poLines) pending.set(l.id, Math.max(0, l.qty_milli - l.received_qty_milli))
  }
  const receivedPerPoLine = new Map<string, number>()
  for (const l of lines) {
    const p = products.get(l.product_id)!
    const mrp = l.batch_no
      ? (batchMrp.get(`${l.product_id}|${l.batch_no}`) ?? p.mrp_paise)
      : p.mrp_paise
    out.push(
      ...purchaseLineWarnings(
        {
          line_no: l.line_no,
          product_id: l.product_id,
          unit_cost_paise: l.unit_cost_paise,
          mrp_paise: l.mrp_paise,
          expiry_date: l.expiry_date,
          gst_rate_bp: l.gst_rate_bp,
          landed_unit_cost_paise: l.landed_unit_cost_paise,
          sale_price_paise: l.sale_price_paise,
        },
        {
          last_cost_paise: lastCost.get(l.product_id)?.unit_cost_paise ?? null,
          mrp_paise: mrp,
          gst_rate_bp: p.gst_rate_bp,
          price_includes_tax: p.price_includes_tax,
          cess_rate_bp: p.cess_rate_bp,
        },
        { today, expiry_warning_days: settings.inventory.expiry_warning_days },
      ),
    )
    if (l.purchase_order_line_id && pending.has(l.purchase_order_line_id)) {
      const total = (receivedPerPoLine.get(l.purchase_order_line_id) ?? 0) + l.qty_milli
      receivedPerPoLine.set(l.purchase_order_line_id, total)
      const open = pending.get(l.purchase_order_line_id)!
      if (total > open) {
        out.push({
          code: 'received_more_than_ordered',
          line_no: l.line_no,
          product_id: l.product_id,
          params: { pending_qty_milli: open, qty_milli: total },
        })
      }
    }
  }
  return out
}

export async function billDetail(tx: Tx, ctx: Ctx, id: string): Promise<PurchaseBillDetail> {
  const bill = await loadBill(tx, ctx, id)
  const { today } = await businessToday(tx, ctx)
  const lines = await loadBillLines(tx, ctx, bill.id)
  const productIds = lines.map((l) => l.product_id)
  const [supplier, products, stock, last, payments, debitNotes, order, journalId, names] =
    await Promise.all([
      loadSupplier(tx, ctx, bill.supplier_id),
      loadProducts(tx, ctx, productIds),
      stockByProduct(tx, ctx, bill.store_id, productIds),
      lastPurchases(tx, ctx, productIds, { excludeBillId: bill.id }),
      paymentsFor(tx, ctx, 'purchase_bill', bill.id),
      tx
        .selectFrom('debit_notes')
        .select(['id', 'number', 'note_date', 'status', 'settlement', 'total_paise'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('bill_id', '=', bill.id)
        .orderBy('note_date')
        .orderBy('created_at')
        .execute(),
      bill.purchase_order_id
        ? tx
            .selectFrom('purchase_orders')
            .select(['id', 'number'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', bill.purchase_order_id)
            .executeTakeFirst()
        : Promise.resolve(undefined),
      journalEntryOf(tx, ctx, 'purchase_bill', bill.id),
      userNames(tx, [bill.created_by, bill.posted_by, bill.cancelled_by]),
    ])
  const posted = bill.status === 'posted'
  const warnings =
    bill.status === 'draft' ? await billWarnings(tx, ctx, bill, lines, products, last, today) : []
  const { overdue, days_overdue } = overdueOf(bill, today)
  const name = (uid: string | null): string | null => (uid ? (names.get(uid) ?? null) : null)
  return {
    id: bill.id,
    number: bill.number,
    fy: bill.fy,
    status: bill.status as PurchaseBillStatus,
    store_id: bill.store_id,
    supplier_id: bill.supplier_id,
    supplier_name: supplier.name,
    supplier_invoice_no: bill.supplier_invoice_no,
    supplier_invoice_date: bill.supplier_invoice_date,
    received_date: bill.received_date,
    due_date: bill.due_date,
    purchase_order_id: bill.purchase_order_id,
    purchase_order_number: order?.number ?? null,
    line_count: lines.length,
    taxable_paise: bill.taxable_paise,
    tax_paise: bill.cgst_paise + bill.sgst_paise + bill.igst_paise + bill.cess_paise,
    total_paise: bill.total_paise,
    paid_paise: bill.paid_paise,
    returned_paise: bill.returned_paise,
    due_paise: bill.due_paise,
    payment_status: bill.payment_status as PurchasePaymentStatus,
    overdue,
    days_overdue,
    posted_at: bill.posted_at ? iso(bill.posted_at) : null,
    created_at: iso(bill.created_at),
    updated_at: iso(bill.updated_at),
    supplier_gstin: bill.supplier_gstin,
    supplier_state_code: bill.supplier_state_code,
    is_interstate: bill.is_interstate,
    reverse_charge: bill.reverse_charge,
    itc_eligible: bill.itc_eligible,
    gross_paise: bill.gross_paise,
    discount_paise: bill.discount_paise,
    cgst_paise: bill.cgst_paise,
    sgst_paise: bill.sgst_paise,
    igst_paise: bill.igst_paise,
    cess_paise: bill.cess_paise,
    other_charges_paise: bill.other_charges_paise,
    round_off_paise: bill.round_off_paise,
    notes: bill.notes,
    attachment_file_id: bill.attachment_file_id,
    supplier: supplierRef(supplier),
    lines: lines.map((l) => {
      const p = products.get(l.product_id)!
      return {
        id: l.id,
        line_no: l.line_no,
        product_id: l.product_id,
        product: productRef(p),
        purchase_order_line_id: l.purchase_order_line_id,
        batch_id: l.batch_id,
        batch_no: l.batch_no,
        mfg_date: l.mfg_date,
        expiry_date: l.expiry_date,
        hsn_code: l.hsn_code,
        unit: l.unit,
        pack_size: l.pack_size,
        qty_milli: l.qty_milli,
        free_qty_milli: l.free_qty_milli,
        mrp_paise: l.mrp_paise,
        unit_cost_paise: l.unit_cost_paise,
        discount_bp: l.discount_bp,
        discount_paise: l.discount_paise,
        gross_paise: l.gross_paise,
        taxable_paise: l.taxable_paise,
        cgst_paise: l.cgst_paise,
        sgst_paise: l.sgst_paise,
        igst_paise: l.igst_paise,
        cess_paise: l.cess_paise,
        gst_rate_bp: l.gst_rate_bp,
        cess_rate_bp: l.cess_rate_bp,
        total_paise: l.total_paise,
        landed_unit_cost_paise: l.landed_unit_cost_paise,
        sale_price_paise: l.sale_price_paise,
        returned_qty_milli: l.returned_qty_milli,
        returnable_qty_milli: posted
          ? Math.max(0, l.qty_milli + l.free_qty_milli - l.returned_qty_milli)
          : 0,
        current: {
          purchase_price_paise: p.purchase_price_paise,
          mrp_paise: p.mrp_paise,
          sale_price_paise: p.sale_price_paise,
          price_includes_tax: p.price_includes_tax,
          gst_rate_bp: p.gst_rate_bp,
          last_cost_paise: last.get(l.product_id)?.unit_cost_paise ?? null,
          stock_qty_milli: stock.get(l.product_id) ?? 0,
        },
      }
    }),
    tax_breakup: taxBreakup(lines),
    purchase_order: order ? { id: order.id, number: order.number } : null,
    payments,
    debit_notes: debitNotes.map((d) => ({
      id: d.id,
      number: d.number,
      note_date: d.note_date,
      status: d.status as 'completed' | 'cancelled',
      settlement: d.settlement as 'adjust_due' | 'refund_cash' | 'refund_bank',
      total_paise: d.total_paise,
    })),
    journal_entry_id: journalId,
    posted_by: bill.posted_by,
    posted_by_name: name(bill.posted_by),
    cancelled_at: bill.cancelled_at ? iso(bill.cancelled_at) : null,
    cancelled_by: bill.cancelled_by,
    cancelled_by_name: name(bill.cancelled_by),
    cancel_reason: bill.cancel_reason,
    created_by: bill.created_by,
    created_by_name: name(bill.created_by),
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// List / CSV
// ---------------------------------------------------------------------------------------------

function filteredBills(tx: Tx, ctx: Ctx, q: BillListQuery, today: string) {
  let qb = tx
    .selectFrom('purchase_bills as b')
    .innerJoin('suppliers as s', (j) =>
      j.onRef('s.tenant_id', '=', 'b.tenant_id').onRef('s.id', '=', 'b.supplier_id'),
    )
    .leftJoin('purchase_orders as po', (j) =>
      j.onRef('po.tenant_id', '=', 'b.tenant_id').onRef('po.id', '=', 'b.purchase_order_id'),
    )
    .where('b.tenant_id', '=', ctx.tenantId)
  const stores = storeFilter(ctx, q.store_id)
  if (stores)
    qb = stores.length ? qb.where('b.store_id', 'in', stores) : qb.where(sql<boolean>`false`)
  if (q.supplier_id) qb = qb.where('b.supplier_id', '=', q.supplier_id)
  if (q.purchase_order_id) qb = qb.where('b.purchase_order_id', '=', q.purchase_order_id)
  if (q.status?.length) qb = qb.where('b.status', 'in', q.status)
  if (q.payment_status?.length) {
    qb = qb.where('b.payment_status', 'in', q.payment_status).where('b.status', '=', 'posted')
  }
  if (q.from) qb = qb.where('b.received_date', '>=', q.from)
  if (q.to) qb = qb.where('b.received_date', '<=', q.to)
  if (q.has_due !== undefined) {
    qb = q.has_due
      ? qb.where('b.status', '=', 'posted').where('b.due_paise', '>', 0)
      : qb.where((eb) => eb.or([eb('b.status', '<>', 'posted'), eb('b.due_paise', '<=', 0)]))
  }
  if (q.overdue !== undefined) {
    const cond = sql<boolean>`(b.status = 'posted' and b.due_paise > 0 and b.due_date is not null and b.due_date < ${today}::date)`
    qb = q.overdue ? qb.where(cond) : qb.where(sql<boolean>`not ${cond}`)
  }
  if (q.q) {
    const pattern = likePattern(q.q)
    qb = qb.where((eb) =>
      eb.or([
        eb('b.number', 'ilike', pattern),
        eb('b.supplier_invoice_no', 'ilike', pattern),
        eb('s.name', 'ilike', pattern),
      ]),
    )
  }
  return qb
}

const BILL_SORT: Record<BillListQuery['sort']['field'], string> = {
  received_date: 'b.received_date',
  supplier_invoice_date: 'b.supplier_invoice_date',
  due_date: 'b.due_date',
  number: 'b.number',
  total_paise: 'b.total_paise',
  due_paise: 'b.due_paise',
  created_at: 'b.created_at',
}

function billListSelect(qb: ReturnType<typeof filteredBills>, q: BillListQuery) {
  return qb
    .select([
      'b.id',
      'b.number',
      'b.fy',
      'b.status',
      'b.store_id',
      'b.supplier_id',
      's.name as supplier_name',
      'b.supplier_invoice_no',
      'b.supplier_invoice_date',
      'b.received_date',
      'b.due_date',
      'b.purchase_order_id',
      'po.number as purchase_order_number',
      'b.taxable_paise',
      sql<number>`(b.cgst_paise + b.sgst_paise + b.igst_paise + b.cess_paise)::bigint`.as(
        'tax_paise',
      ),
      'b.total_paise',
      'b.paid_paise',
      'b.returned_paise',
      'b.due_paise',
      'b.payment_status',
      'b.posted_at',
      'b.created_at',
      'b.updated_at',
      sql<number>`(select count(*) from purchase_bill_lines l where l.tenant_id = b.tenant_id and l.bill_id = b.id)::int`.as(
        'line_count',
      ),
    ])
    .orderBy(sql`${sql.ref(BILL_SORT[q.sort.field])} ${sql.raw(q.sort.direction)} nulls last`)
    .orderBy('b.created_at', 'desc')
    .orderBy('b.id', 'desc')
}

type BillListDbRow = {
  id: string
  number: string | null
  fy: string | null
  status: string
  store_id: string
  supplier_id: string
  supplier_name: string
  supplier_invoice_no: string
  supplier_invoice_date: string
  received_date: string
  due_date: string | null
  purchase_order_id: string | null
  purchase_order_number: string | null
  taxable_paise: number
  tax_paise: number
  total_paise: number
  paid_paise: number
  returned_paise: number
  due_paise: number
  payment_status: string
  posted_at: Date | null
  created_at: Date
  updated_at: Date
  line_count: number
}

function toBillListRow(r: BillListDbRow, today: string): PurchaseBillListRow {
  return {
    id: r.id,
    number: r.number,
    fy: r.fy,
    status: r.status as PurchaseBillStatus,
    store_id: r.store_id,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    supplier_invoice_no: r.supplier_invoice_no,
    supplier_invoice_date: r.supplier_invoice_date,
    received_date: r.received_date,
    due_date: r.due_date,
    purchase_order_id: r.purchase_order_id,
    purchase_order_number: r.purchase_order_number,
    line_count: Number(r.line_count),
    taxable_paise: r.taxable_paise,
    tax_paise: Number(r.tax_paise),
    total_paise: r.total_paise,
    paid_paise: r.paid_paise,
    returned_paise: r.returned_paise,
    due_paise: r.due_paise,
    payment_status: r.payment_status as PurchasePaymentStatus,
    ...overdueOf(r, today),
    posted_at: r.posted_at ? iso(r.posted_at) : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

export async function listBills(
  tx: Tx,
  ctx: Ctx,
  q: BillListQuery,
  page: PageParams,
): Promise<{
  data: PurchaseBillListRow[]
  page: { limit: number; offset: number; total: number }
  summary: {
    count: number
    total_paise: number
    paid_paise: number
    due_paise: number
    overdue_paise: number
  }
}> {
  const { today } = await businessToday(tx, ctx)
  const result = await paginateQuery(billListSelect(filteredBills(tx, ctx, q, today), q), page)
  // Cancelled bills are listed (count) but add no value, unless the filter asks for them.
  const valued = q.status?.includes('cancelled')
    ? sql<boolean>`true`
    : sql<boolean>`b.status <> 'cancelled'`
  const summary = await filteredBills(tx, ctx, q, today)
    .select([
      sql<number>`count(*)::bigint`.as('count'),
      sql<number>`coalesce(sum(b.total_paise) filter (where ${valued}), 0)::bigint`.as(
        'total_paise',
      ),
      sql<number>`coalesce(sum(b.paid_paise) filter (where ${valued}), 0)::bigint`.as('paid_paise'),
      sql<number>`coalesce(sum(b.due_paise), 0)::bigint`.as('due_paise'),
      sql<number>`coalesce(sum(b.due_paise) filter (where b.status = 'posted' and b.due_paise > 0 and b.due_date is not null and b.due_date < ${today}::date), 0)::bigint`.as(
        'overdue_paise',
      ),
    ])
    .executeTakeFirstOrThrow()
  return {
    data: result.data.map((r) => toBillListRow(r as BillListDbRow, today)),
    page: result.page,
    summary: {
      count: Number(summary.count),
      total_paise: Number(summary.total_paise),
      paid_paise: Number(summary.paid_paise),
      due_paise: Number(summary.due_paise),
      overdue_paise: Number(summary.overdue_paise),
    },
  }
}

export async function billsCsv(
  tx: Tx,
  ctx: Ctx,
  q: BillListQuery,
): Promise<{ csv: string; rows: number }> {
  const { today } = await businessToday(tx, ctx)
  const rows = (await billListSelect(filteredBills(tx, ctx, q, today), q)
    .limit(CSV_MAX_ROWS)
    .execute()) as BillListDbRow[]
  const out = rows.map((r) => {
    const row = toBillListRow(r, today)
    return [
      row.number,
      row.status,
      row.received_date,
      row.supplier_name,
      row.supplier_invoice_no,
      row.supplier_invoice_date,
      row.due_date,
      row.purchase_order_number,
      row.line_count,
      csvRupees(row.taxable_paise),
      csvRupees(row.tax_paise),
      csvRupees(row.total_paise),
      csvRupees(row.paid_paise),
      csvRupees(row.returned_paise),
      csvRupees(row.due_paise),
      row.payment_status,
      row.days_overdue,
    ]
  })
  return {
    csv: toCsv([
      [
        'GRN number',
        'Status',
        'Received date',
        'Supplier',
        'Supplier invoice no',
        'Invoice date',
        'Due date',
        'PO number',
        'Lines',
        'Taxable (₹)',
        'Tax (₹)',
        'Total (₹)',
        'Paid (₹)',
        'Returned (₹)',
        'Due (₹)',
        'Payment status',
        'Days overdue',
      ],
      ...out,
    ]),
    rows: out.length,
  }
}

// ---------------------------------------------------------------------------------------------
// Returnable
// ---------------------------------------------------------------------------------------------

export async function billReturnable(
  tx: Tx,
  ctx: Ctx,
  id: string,
): Promise<BillReturnableResponse> {
  const bill = await loadBill(tx, ctx, id)
  const lines = await loadBillLines(tx, ctx, bill.id)
  const productIds = lines.map((l) => l.product_id)
  const [supplier, products, credited, productStock, batchStock] = await Promise.all([
    loadSupplier(tx, ctx, bill.supplier_id),
    loadProducts(tx, ctx, productIds),
    creditedByLine(
      tx,
      ctx,
      lines.map((l) => l.id),
    ),
    stockByProduct(tx, ctx, bill.store_id, productIds),
    stockByBatch(
      tx,
      ctx,
      bill.store_id,
      lines.flatMap((l) => (l.batch_id ? [l.batch_id] : [])),
    ),
  ])
  const posted = bill.status === 'posted'
  const zero = { taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, cess_paise: 0 }
  return {
    bill: {
      id: bill.id,
      number: bill.number,
      supplier_id: bill.supplier_id,
      supplier_name: supplier.name,
      supplier_invoice_no: bill.supplier_invoice_no,
      received_date: bill.received_date,
      status: bill.status as PurchaseBillStatus,
      is_interstate: bill.is_interstate,
      total_paise: bill.total_paise,
      due_paise: bill.due_paise,
    },
    lines: lines.map((l) => {
      const p = products.get(l.product_id)!
      return {
        bill_line_id: l.id,
        line_no: l.line_no,
        product_id: l.product_id,
        product: productRef(p),
        batch_id: l.batch_id,
        batch_no: l.batch_no,
        expiry_date: l.expiry_date,
        unit: l.unit,
        pack_size: l.pack_size,
        qty_milli: l.qty_milli,
        free_qty_milli: l.free_qty_milli,
        returned_qty_milli: l.returned_qty_milli,
        returnable_qty_milli: posted
          ? Math.max(0, l.qty_milli + l.free_qty_milli - l.returned_qty_milli)
          : 0,
        available_qty_milli: l.batch_id
          ? (batchStock.get(l.batch_id) ?? 0)
          : (productStock.get(l.product_id) ?? 0),
        unit_cost_paise: l.unit_cost_paise,
        landed_unit_cost_paise: l.landed_unit_cost_paise,
        taxable_paise: l.taxable_paise,
        cgst_paise: l.cgst_paise,
        sgst_paise: l.sgst_paise,
        igst_paise: l.igst_paise,
        cess_paise: l.cess_paise,
        gst_rate_bp: l.gst_rate_bp,
        cess_rate_bp: l.cess_rate_bp,
        total_paise: l.total_paise,
        credited: credited.get(l.id) ?? zero,
      }
    }),
  }
}
