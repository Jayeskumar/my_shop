/**
 * Debit notes (purchase returns), ARCHITECTURE.md §10.
 *
 *  - From bill lines: quantity ≤ charged + free − returned; amounts pro-rata per tax head with
 *    prorateReturnLine (the final return of a line takes the exact remainder), batch of the line.
 *  - Free-form lines (product + batch, e.g. pharmacy expiry returns without the bill): cost per
 *    pack defaults to the landed cost of the batch's latest posted bill line, else the batch /
 *    product purchase price; GST from that bill line, else the product.
 *  - Posting: DN number ('debit_note' series of the store); stock 'purchase_return' −qty (core
 *    postStock: INSUFFICIENT_STOCK when the goods are not there and negatives are not allowed);
 *    journal Dr payable (supplier) total, Cr inventory (taxable, + tax when the purchase was not
 *    ITC-eligible), Cr input taxes.
 *  - Settlement: adjust_due reduces the bill's due by min(total, due) — recorded in
 *    debit_notes.adjusted_paise and purchase_bills.returned_paise; the rest is the supplier's
 *    advance (their payable balance already dropped by the full total). refund_cash / refund_bank
 *    record a receipt from the supplier (recordPayment direction 'in', allocated to the note,
 *    client_ref dn:<id>).
 *  - Cancel: refunds cancelled, the bill adjustment given back, stock put back at the cost it
 *    left with, journal reversed, bill lines' returned quantities restored; audited.
 */
import { type Selectable, sql } from 'kysely'
import {
  type DebitNoteReason,
  type DebitNoteSettlement,
  computePurchaseLine,
  newId,
  taxBreakup,
} from '@kadai/shared'
import { toCsv } from '@kadai/shared/api/identity'
import { paymentClientRef } from '@kadai/shared/api/payments'
import type {
  DebitNoteCreateSchema,
  DebitNoteDetail,
  DebitNoteListQuerySchema,
  DebitNoteListRow,
  DebitNotePrefill,
  DebitNotePrefillQuerySchema,
} from '@kadai/shared/api/purchases'
import { prorateReturnLine } from '@kadai/shared/api/sales'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { notFound } from '../../core/errors'
import { type PageParams, assertStoreAccess } from '../../core/http'
import { postStock } from '../../core/inventory'
import { type JournalLineInput, postJournal, reverseJournal } from '../../core/ledger'
import { nextNumber } from '../../core/numbering'
import { cancelPayment, recordPayment } from '../../core/payments'
import type { DB } from '../../db/schema.generated'
import type { Tx } from '../../db/tenant'
import { type BillRow, creditedByLine, loadBill, loadBillLines } from './bills'
import {
  CSV_MAX_ROWS,
  type Ctx,
  type ProductInfo,
  businessToday,
  csvRupees,
  fieldIssue,
  iso,
  journalEntryOf,
  loadProducts,
  loadStore,
  loadSupplier,
  loadTenant,
  paginateQuery,
  paymentsFor,
  productRef,
  reasonError,
  storeFilter,
  supplierRef,
  supplyIsInterstate,
  userNames,
} from './common'
import { likePattern } from './orders'

type DebitNoteCreate = z.output<typeof DebitNoteCreateSchema>
type DebitNoteListQuery = z.output<typeof DebitNoteListQuerySchema>
type DebitNotePrefillQuery = z.output<typeof DebitNotePrefillQuerySchema>
type DebitNoteRow = Selectable<DB['debit_notes']>

interface TaxHeads {
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
}

const ZERO: TaxHeads = {
  taxable_paise: 0,
  cgst_paise: 0,
  sgst_paise: 0,
  igst_paise: 0,
  cess_paise: 0,
}

interface NoteLine extends TaxHeads {
  bill_line_id: string | null
  product: ProductInfo
  batch_id: string | null
  hsn_code: string | null
  unit: string
  pack_size: number
  qty_milli: number
  unit_cost_paise: number
  gst_rate_bp: number
  cess_rate_bp: number
  total_paise: number
}

function paymentStatusOf(paid: number, due: number): 'unpaid' | 'partial' | 'paid' {
  if (due <= 0) return 'paid'
  return paid > 0 ? 'partial' : 'unpaid'
}

/** Moves a bill's due by `delta` (+ restores, − reduces) through returned_paise. */
async function adjustBillDue(
  tx: Tx,
  ctx: Ctx,
  bill: BillRow,
  adjustedDelta: number,
): Promise<void> {
  const returned = bill.returned_paise + adjustedDelta
  const due = bill.due_paise - adjustedDelta
  await tx
    .updateTable('purchase_bills')
    .set({
      returned_paise: returned,
      due_paise: due,
      payment_status: paymentStatusOf(bill.paid_paise, due),
      updated_at: new Date(),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', bill.id)
    .execute()
}

/** Latest posted bill line per batch (landed cost, GST, returnable), optionally per supplier. */
async function lastBillLinesByBatch(
  tx: Tx,
  ctx: Ctx,
  batchIds: readonly string[],
  opts: { supplierId?: string; storeId?: string } = {},
): Promise<
  Map<
    string,
    {
      bill_id: string
      bill_line_id: string
      bill_number: string | null
      supplier_id: string
      supplier_name: string
      landed_unit_cost_paise: number
      gst_rate_bp: number
      cess_rate_bp: number
      returnable_qty_milli: number
    }
  >
> {
  if (batchIds.length === 0) return new Map()
  let q = tx
    .selectFrom('purchase_bill_lines as l')
    .innerJoin('purchase_bills as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.bill_id'),
    )
    .innerJoin('suppliers as s', (j) =>
      j.onRef('s.tenant_id', '=', 'b.tenant_id').onRef('s.id', '=', 'b.supplier_id'),
    )
    .distinctOn('l.batch_id')
    .select([
      'l.batch_id',
      'b.id as bill_id',
      'l.id as bill_line_id',
      'b.number as bill_number',
      'b.supplier_id',
      's.name as supplier_name',
      'l.landed_unit_cost_paise',
      'l.gst_rate_bp',
      'l.cess_rate_bp',
      sql<number>`greatest(0, l.qty_milli + l.free_qty_milli - l.returned_qty_milli)::bigint`.as(
        'returnable_qty_milli',
      ),
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.batch_id', 'in', [...batchIds])
    .where('b.status', '=', 'posted')
  if (opts.supplierId) q = q.where('b.supplier_id', '=', opts.supplierId)
  q = q.orderBy('l.batch_id')
  // Prefer the bills of the store the goods are returned from.
  if (opts.storeId) q = q.orderBy(sql`(b.store_id = ${opts.storeId}) desc`)
  const rows = await q
    .orderBy('b.received_date', 'desc')
    .orderBy(sql`b.posted_at desc nulls last`)
    .execute()
  return new Map(
    rows.map((r) => [r.batch_id!, { ...r, returnable_qty_milli: Number(r.returnable_qty_milli) }]),
  )
}

/** Latest posted bill line per (non-batch) product. */
async function lastBillLinesByProduct(
  tx: Tx,
  ctx: Ctx,
  productIds: readonly string[],
  supplierId: string,
): Promise<
  Map<string, { landed_unit_cost_paise: number; gst_rate_bp: number; cess_rate_bp: number }>
> {
  if (productIds.length === 0) return new Map()
  const rows = await tx
    .selectFrom('purchase_bill_lines as l')
    .innerJoin('purchase_bills as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.bill_id'),
    )
    .distinctOn('l.product_id')
    .select(['l.product_id', 'l.landed_unit_cost_paise', 'l.gst_rate_bp', 'l.cess_rate_bp'])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.product_id', 'in', [...productIds])
    .where('b.status', '=', 'posted')
    .orderBy('l.product_id')
    .orderBy(sql`(b.supplier_id = ${supplierId}) desc`)
    .orderBy('b.received_date', 'desc')
    .orderBy(sql`b.posted_at desc nulls last`)
    .execute()
  return new Map(rows.map((r) => [r.product_id, r]))
}

function assertReturnable(p: ProductInfo, lineNo: number): void {
  if (p.kind === 'service' || p.kind === 'variant_parent' || !p.track_inventory) {
    throw reasonError(
      'UNPROCESSABLE',
      'product_not_purchasable',
      `${p.name} does not track stock and cannot be returned`,
      { product_id: p.id, line_no: lineNo },
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export async function createDebitNote(
  tx: Tx,
  ctx: Ctx,
  body: DebitNoteCreate,
): Promise<DebitNoteDetail> {
  const cal = await businessToday(tx, ctx)
  const noteDate = body.note_date ?? cal.today
  if (noteDate > cal.today) throw fieldIssue(['note_date'], 'future_date')

  let bill: BillRow | null = null
  if (body.bill_id) {
    bill = await loadBill(tx, ctx, body.bill_id, { forUpdate: true })
    if (bill.status !== 'posted') {
      throw reasonError(
        'UNPROCESSABLE',
        'bill_not_posted',
        'Goods can be returned only against a posted purchase bill',
        { bill_id: bill.id, status: bill.status },
      )
    }
    if (
      (body.supplier_id && body.supplier_id !== bill.supplier_id) ||
      (body.store_id && body.store_id !== bill.store_id)
    ) {
      throw reasonError(
        'UNPROCESSABLE',
        'bill_mismatch',
        'The supplier / store differ from the purchase bill',
        { bill_id: bill.id },
      )
    }
    if (noteDate < bill.received_date) throw fieldIssue(['note_date'], 'date_order')
  }
  const store = await loadStore(tx, ctx, bill?.store_id ?? body.store_id!, { requireActive: true })
  const supplier = await loadSupplier(tx, ctx, bill?.supplier_id ?? body.supplier_id!)
  const interstate = bill
    ? bill.is_interstate
    : (body.is_interstate ?? supplyIsInterstate(store, supplier))
  const itc = bill ? bill.itc_eligible : (await loadTenant(tx, ctx)).gst_scheme === 'regular'
  const freeForm = body.lines.every((l) => l.product_id !== undefined)

  const lines: NoteLine[] = []
  if (!freeForm) {
    const billLines = await loadBillLines(tx, ctx, bill!.id)
    const byId = new Map(billLines.map((l) => [l.id, l]))
    const credited = await creditedByLine(
      tx,
      ctx,
      billLines.map((l) => l.id),
    )
    const products = await loadProducts(
      tx,
      ctx,
      billLines.map((l) => l.product_id),
    )
    for (const [i, input] of body.lines.entries()) {
      const bl = byId.get(input.bill_line_id!)
      if (!bl) throw notFound('purchase_bill_line', input.bill_line_id)
      const total = bl.qty_milli + bl.free_qty_milli
      const returnable = Math.max(0, total - bl.returned_qty_milli)
      if (input.qty_milli > returnable) {
        throw reasonError(
          'UNPROCESSABLE',
          'returnable_exceeded',
          `Line ${i + 1}: only ${returnable / 1000} can still be returned`,
          { line_no: i + 1, bill_line_id: bl.id, returnable_qty_milli: returnable },
        )
      }
      const amounts = prorateReturnLine(
        {
          taxable_paise: bl.taxable_paise,
          cgst_paise: bl.cgst_paise,
          sgst_paise: bl.sgst_paise,
          igst_paise: bl.igst_paise,
          cess_paise: bl.cess_paise,
        },
        {
          qty_milli: input.qty_milli,
          total_qty_milli: total,
          returned_qty_milli: bl.returned_qty_milli,
          credited: credited.get(bl.id) ?? ZERO,
        },
      )
      lines.push({
        bill_line_id: bl.id,
        product: products.get(bl.product_id)!,
        batch_id: bl.batch_id,
        hsn_code: bl.hsn_code,
        unit: bl.unit,
        pack_size: bl.pack_size,
        qty_milli: input.qty_milli,
        unit_cost_paise: bl.landed_unit_cost_paise,
        gst_rate_bp: bl.gst_rate_bp,
        cess_rate_bp: bl.cess_rate_bp,
        ...amounts,
      })
    }
  } else {
    const products = await loadProducts(
      tx,
      ctx,
      body.lines.map((l) => l.product_id!),
    )
    const batchIds = body.lines.flatMap((l) => (l.batch_id ? [l.batch_id] : []))
    const batches = batchIds.length
      ? await tx
          .selectFrom('batches')
          .select(['id', 'product_id', 'purchase_price_paise'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', 'in', batchIds)
          .execute()
      : []
    const batchMap = new Map(batches.map((b) => [b.id, b]))
    const byBatch = await lastBillLinesByBatch(tx, ctx, batchIds, { storeId: store.id })
    const byProduct = await lastBillLinesByProduct(
      tx,
      ctx,
      body.lines.filter((l) => !l.batch_id).map((l) => l.product_id!),
      supplier.id,
    )
    for (const [i, input] of body.lines.entries()) {
      const p = products.get(input.product_id!)!
      assertReturnable(p, i + 1)
      let batch: { id: string; product_id: string; purchase_price_paise: number | null } | null =
        null
      if (p.track_batches) {
        batch = input.batch_id ? (batchMap.get(input.batch_id) ?? null) : null
        if (!batch || batch.product_id !== p.id) {
          throw reasonError(
            'UNPROCESSABLE',
            'batch_mismatch',
            input.batch_id
              ? `Line ${i + 1}: the batch belongs to another product`
              : `Line ${i + 1}: ${p.name} is batch-tracked; choose the batch`,
            { line_no: i + 1, product_id: p.id, batch_id: input.batch_id ?? null },
          )
        }
      } else if (input.batch_id) {
        throw reasonError('UNPROCESSABLE', 'batch_mismatch', `${p.name} does not track batches`, {
          line_no: i + 1,
          product_id: p.id,
          batch_id: input.batch_id,
        })
      }
      const last = batch ? byBatch.get(batch.id) : byProduct.get(p.id)
      const cost =
        input.unit_cost_paise ??
        last?.landed_unit_cost_paise ??
        batch?.purchase_price_paise ??
        p.purchase_price_paise
      if (!cost || cost <= 0) {
        throw fieldIssue(['lines', i, 'unit_cost_paise'], 'debit_note_free_form_cost_required')
      }
      const gst = input.gst_rate_bp ?? last?.gst_rate_bp ?? p.gst_rate_bp
      const cess = input.cess_rate_bp ?? last?.cess_rate_bp ?? p.cess_rate_bp
      const r = computePurchaseLine({
        unit_cost_paise: cost,
        qty_milli: input.qty_milli,
        pack_size: p.pack_size,
        gst_rate_bp: gst,
        cess_rate_bp: cess,
        is_interstate: interstate,
      })
      lines.push({
        bill_line_id: null,
        product: p,
        batch_id: batch?.id ?? null,
        hsn_code: p.hsn_code,
        unit: p.unit,
        pack_size: p.pack_size,
        qty_milli: input.qty_milli,
        unit_cost_paise: cost,
        gst_rate_bp: r.gst_rate_bp,
        cess_rate_bp: r.cess_rate_bp,
        taxable_paise: r.taxable_paise,
        cgst_paise: r.cgst_paise,
        sgst_paise: r.sgst_paise,
        igst_paise: r.igst_paise,
        cess_paise: r.cess_paise,
        total_paise: r.total_paise,
      })
    }
  }

  const sum = (pick: (l: NoteLine) => number): number => lines.reduce((s, l) => s + pick(l), 0)
  const totals = {
    taxable_paise: sum((l) => l.taxable_paise),
    cgst_paise: sum((l) => l.cgst_paise),
    sgst_paise: sum((l) => l.sgst_paise),
    igst_paise: sum((l) => l.igst_paise),
    cess_paise: sum((l) => l.cess_paise),
  }
  const tax = totals.cgst_paise + totals.sgst_paise + totals.igst_paise + totals.cess_paise
  const total = totals.taxable_paise + tax

  if (body.settlement === 'refund_bank' && body.account_id) {
    const account = await tx
      .selectFrom('accounts')
      .select(['id', 'type', 'is_active'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', body.account_id)
      .executeTakeFirst()
    if (!account || account.type !== 'asset' || !account.is_active) {
      throw reasonError(
        'UNPROCESSABLE',
        'refund_account_invalid',
        'Choose an active cash or bank account for the refund',
        { account_id: body.account_id },
      )
    }
  }

  const numbered = await nextNumber(tx, ctx, {
    docType: 'debit_note',
    storeId: store.id,
    date: noteDate,
  })
  const id = newId()
  await tx
    .insertInto('debit_notes')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: store.id,
      supplier_id: supplier.id,
      bill_id: bill?.id ?? null,
      number: numbered.number,
      fy: numbered.fy,
      note_date: noteDate,
      reason: body.reason,
      status: 'completed',
      is_interstate: interstate,
      ...totals,
      round_off_paise: 0,
      total_paise: total,
      settlement: body.settlement,
      notes: body.notes?.trim() ? body.notes.trim() : null,
      created_by: ctx.userId,
    })
    .execute()
  const lineIds = lines.map(() => newId())
  await tx
    .insertInto('debit_note_lines')
    .values(
      lines.map((l, i) => ({
        id: lineIds[i]!,
        tenant_id: ctx.tenantId,
        debit_note_id: id,
        line_no: i + 1,
        bill_line_id: l.bill_line_id,
        product_id: l.product.id,
        batch_id: l.batch_id,
        hsn_code: l.hsn_code,
        unit: l.unit,
        pack_size: l.pack_size,
        qty_milli: l.qty_milli,
        unit_cost_paise: l.unit_cost_paise,
        taxable_paise: l.taxable_paise,
        gst_rate_bp: l.gst_rate_bp,
        cgst_paise: l.cgst_paise,
        sgst_paise: l.sgst_paise,
        igst_paise: l.igst_paise,
        cess_rate_bp: l.cess_rate_bp,
        cess_paise: l.cess_paise,
        total_paise: l.total_paise,
      })),
    )
    .execute()

  // ---- stock ------------------------------------------------------------------------------
  await postStock(
    tx,
    ctx,
    lines.map((l, i) => ({
      store_id: store.id,
      product_id: l.product.id,
      batch_id: l.batch_id,
      qty_milli: -l.qty_milli,
      movement_type: 'purchase_return' as const,
      ref_type: 'debit_note',
      ref_id: id,
      ref_line_id: lineIds[i]!,
      reason: `Debit note ${numbered.number}`,
    })),
  )

  // ---- bill lines -------------------------------------------------------------------------
  for (const l of lines) {
    if (!l.bill_line_id) continue
    await tx
      .updateTable('purchase_bill_lines')
      .set((eb) => ({ returned_qty_milli: eb('returned_qty_milli', '+', l.qty_milli) }))
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', l.bill_line_id)
      .execute()
  }

  // ---- journal ----------------------------------------------------------------------------
  const journal: JournalLineInput[] = [
    {
      account: { subtype: 'payable' },
      debit_paise: total,
      party: { type: 'supplier', id: supplier.id },
    },
    { account: { subtype: 'inventory' }, credit_paise: totals.taxable_paise + (itc ? 0 : tax) },
  ]
  if (itc) {
    journal.push(
      { account: { subtype: 'input_cgst' }, credit_paise: totals.cgst_paise },
      { account: { subtype: 'input_sgst' }, credit_paise: totals.sgst_paise },
      { account: { subtype: 'input_igst' }, credit_paise: totals.igst_paise },
      { account: { subtype: 'input_cess' }, credit_paise: totals.cess_paise },
    )
  }
  await postJournal(tx, ctx, {
    entry_date: noteDate,
    store_id: store.id,
    source_type: 'debit_note',
    source_id: id,
    narration: `Debit note ${numbered.number} — ${supplier.name}${bill?.number ? ` (purchase ${bill.number})` : ''}`,
    lines: journal,
  })

  // ---- settlement -------------------------------------------------------------------------
  let adjusted = 0
  if (body.settlement === 'adjust_due') {
    if (bill && total > 0) {
      adjusted = Math.min(total, Math.max(0, bill.due_paise))
      if (adjusted > 0) {
        await adjustBillDue(tx, ctx, bill, adjusted)
        await tx
          .updateTable('debit_notes')
          .set({ adjusted_paise: adjusted })
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', id)
          .execute()
      }
    }
  } else if (total > 0) {
    await recordPayment(tx, ctx, {
      direction: 'in',
      store_id: store.id,
      method: body.settlement === 'refund_cash' ? 'cash' : 'bank_transfer',
      amount_paise: total,
      payment_date: noteDate,
      party: { type: 'supplier', id: supplier.id },
      reference: body.refund_reference ?? null,
      account_id: body.settlement === 'refund_bank' ? (body.account_id ?? null) : null,
      allocations: [{ target_type: 'debit_note', target_id: id, amount_paise: total }],
      notes: `Refund for debit note ${numbered.number}`,
      client_ref: paymentClientRef.debitNoteSettlement(id),
    })
  }

  await audit(tx, ctx, {
    action: 'debit_note.create',
    entity_type: 'debit_note',
    entity_id: id,
    summary: `Debit note ${numbered.number} to ${supplier.name}: ${total} paise (${body.settlement})`,
    changes: {
      bill_id: bill?.id ?? null,
      reason: body.reason,
      settlement: body.settlement,
      total_paise: total,
      adjusted_paise: adjusted,
      lines: lines.length,
    },
  })
  return debitNoteDetail(tx, ctx, id)
}

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

async function loadNote(
  tx: Tx,
  ctx: Ctx,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<DebitNoteRow> {
  let q = tx
    .selectFrom('debit_notes')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('debit_note', id)
  assertStoreAccess(ctx, row.store_id)
  return row
}

export async function cancelDebitNote(
  tx: Tx,
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<DebitNoteDetail> {
  // Lock order: the bill first (as creation does), then the note.
  const peek = await loadNote(tx, ctx, id)
  const bill = peek.bill_id ? await loadBill(tx, ctx, peek.bill_id, { forUpdate: true }) : null
  const note = await loadNote(tx, ctx, id, { forUpdate: true })
  if (note.status !== 'completed') {
    throw reasonError(
      'CONFLICT',
      'debit_note_cancelled',
      `Debit note ${note.number} is already cancelled`,
      {
        debit_note_id: note.id,
      },
    )
  }
  const settlementRef = paymentClientRef.debitNoteSettlement(note.id)
  const payments = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .select(['p.id', 'p.number', 'p.client_ref'])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', 'debit_note')
    .where('a.target_id', '=', note.id)
    .where('p.status', '=', 'completed')
    .execute()
  const manual = payments.filter((p) => p.client_ref !== settlementRef)
  if (manual.length) {
    throw reasonError(
      'CONFLICT',
      'debit_note_has_payments',
      `Receipts from the supplier are recorded against debit note ${note.number}; cancel them first`,
      { debit_note_id: note.id, payment_ids: manual.map((p) => p.id) },
    )
  }
  const cal = await businessToday(tx, ctx)
  for (const p of payments) {
    await cancelPayment(tx, ctx, {
      payment_id: p.id,
      reason: `Debit note ${note.number} cancelled: ${reason}`.slice(0, 500),
      date: cal.today,
    })
  }
  if (bill && note.adjusted_paise > 0) await adjustBillDue(tx, ctx, bill, -note.adjusted_paise)

  const lines = await tx
    .selectFrom('debit_note_lines')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('debit_note_id', '=', note.id)
    .orderBy('line_no')
    .execute()
  const movements = await tx
    .selectFrom('stock_movements')
    .select(['ref_line_id', 'unit_cost_paise'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('ref_type', '=', 'debit_note')
    .where('ref_id', '=', note.id)
    .where('movement_type', '=', 'purchase_return')
    .execute()
  const costOf = new Map(movements.map((m) => [m.ref_line_id, m.unit_cost_paise]))
  await postStock(
    tx,
    ctx,
    lines.map((l) => ({
      store_id: note.store_id,
      product_id: l.product_id,
      batch_id: l.batch_id,
      qty_milli: l.qty_milli,
      movement_type: 'purchase' as const,
      unit_cost_paise: costOf.get(l.id) ?? l.unit_cost_paise,
      ref_type: 'debit_note',
      ref_id: note.id,
      ref_line_id: l.id,
      reason: `Debit note ${note.number} cancelled`,
    })),
  )
  for (const l of lines) {
    if (!l.bill_line_id) continue
    await tx
      .updateTable('purchase_bill_lines')
      .set((eb) => ({
        returned_qty_milli: sql<number>`greatest(0, ${eb.ref('returned_qty_milli')} - ${l.qty_milli})`,
      }))
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', l.bill_line_id)
      .execute()
  }
  await reverseJournal(tx, ctx, {
    source_type: 'debit_note',
    source_id: note.id,
    entry_date: cal.today,
    narration: `Debit note ${note.number} cancelled: ${reason}`.slice(0, 500),
  })
  const now = new Date()
  await tx
    .updateTable('debit_notes')
    .set({
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: ctx.userId,
      cancel_reason: reason,
      updated_at: now,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', note.id)
    .execute()
  await audit(tx, ctx, {
    action: 'debit_note.cancel',
    entity_type: 'debit_note',
    entity_id: note.id,
    summary: `Debit note ${note.number} cancelled: ${reason}`,
    changes: {
      reason,
      total_paise: note.total_paise,
      adjusted_paise: note.adjusted_paise,
      refunds_cancelled: payments.map((p) => p.id),
    },
  })
  return debitNoteDetail(tx, ctx, note.id)
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function debitNoteDetail(tx: Tx, ctx: Ctx, id: string): Promise<DebitNoteDetail> {
  const note = await loadNote(tx, ctx, id)
  const lines = await tx
    .selectFrom('debit_note_lines as l')
    .leftJoin('batches as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.batch_id'),
    )
    .selectAll('l')
    .select(['b.batch_no', 'b.expiry_date'])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.debit_note_id', '=', note.id)
    .orderBy('l.line_no')
    .execute()
  const [supplier, products, bill, payments, journalId, names] = await Promise.all([
    loadSupplier(tx, ctx, note.supplier_id),
    loadProducts(
      tx,
      ctx,
      lines.map((l) => l.product_id),
    ),
    note.bill_id
      ? tx
          .selectFrom('purchase_bills')
          .select(['number', 'supplier_invoice_no'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', note.bill_id)
          .executeTakeFirst()
      : Promise.resolve(undefined),
    paymentsFor(tx, ctx, 'debit_note', note.id),
    journalEntryOf(tx, ctx, 'debit_note', note.id),
    userNames(tx, [note.created_by, note.cancelled_by]),
  ])
  const name = (uid: string | null): string | null => (uid ? (names.get(uid) ?? null) : null)
  return {
    id: note.id,
    number: note.number,
    fy: note.fy,
    note_date: note.note_date,
    store_id: note.store_id,
    supplier_id: note.supplier_id,
    supplier_name: supplier.name,
    bill_id: note.bill_id,
    bill_number: bill?.number ?? null,
    supplier_invoice_no: bill?.supplier_invoice_no ?? null,
    reason: note.reason as DebitNoteReason,
    status: note.status as 'completed' | 'cancelled',
    settlement: note.settlement as DebitNoteSettlement,
    total_paise: note.total_paise,
    line_count: lines.length,
    created_at: iso(note.created_at),
    is_interstate: note.is_interstate,
    taxable_paise: note.taxable_paise,
    cgst_paise: note.cgst_paise,
    sgst_paise: note.sgst_paise,
    igst_paise: note.igst_paise,
    cess_paise: note.cess_paise,
    tax_paise: note.cgst_paise + note.sgst_paise + note.igst_paise + note.cess_paise,
    round_off_paise: note.round_off_paise,
    notes: note.notes,
    supplier: supplierRef(supplier),
    lines: lines.map((l) => ({
      id: l.id,
      line_no: l.line_no,
      bill_line_id: l.bill_line_id,
      product_id: l.product_id,
      product: productRef(products.get(l.product_id)!),
      batch_id: l.batch_id,
      batch_no: l.batch_no,
      expiry_date: l.expiry_date,
      hsn_code: l.hsn_code,
      unit: l.unit,
      pack_size: l.pack_size,
      qty_milli: l.qty_milli,
      unit_cost_paise: l.unit_cost_paise,
      taxable_paise: l.taxable_paise,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_paise: l.cess_paise,
      gst_rate_bp: l.gst_rate_bp,
      cess_rate_bp: l.cess_rate_bp,
      total_paise: l.total_paise,
    })),
    tax_breakup: taxBreakup(lines),
    payments,
    journal_entry_id: journalId,
    adjusted_paise: note.adjusted_paise,
    cancelled_at: note.cancelled_at ? iso(note.cancelled_at) : null,
    cancelled_by: note.cancelled_by,
    cancelled_by_name: name(note.cancelled_by),
    cancel_reason: note.cancel_reason,
    created_by: note.created_by,
    created_by_name: name(note.created_by),
    updated_at: iso(note.updated_at),
  }
}

function filteredNotes(tx: Tx, ctx: Ctx, q: DebitNoteListQuery) {
  let qb = tx
    .selectFrom('debit_notes as d')
    .innerJoin('suppliers as s', (j) =>
      j.onRef('s.tenant_id', '=', 'd.tenant_id').onRef('s.id', '=', 'd.supplier_id'),
    )
    .leftJoin('purchase_bills as b', (j) =>
      j.onRef('b.tenant_id', '=', 'd.tenant_id').onRef('b.id', '=', 'd.bill_id'),
    )
    .where('d.tenant_id', '=', ctx.tenantId)
  const stores = storeFilter(ctx, q.store_id)
  if (stores)
    qb = stores.length ? qb.where('d.store_id', 'in', stores) : qb.where(sql<boolean>`false`)
  if (q.supplier_id) qb = qb.where('d.supplier_id', '=', q.supplier_id)
  if (q.bill_id) qb = qb.where('d.bill_id', '=', q.bill_id)
  if (q.status?.length) qb = qb.where('d.status', 'in', q.status)
  if (q.reason?.length) qb = qb.where('d.reason', 'in', q.reason)
  if (q.settlement?.length) qb = qb.where('d.settlement', 'in', q.settlement)
  if (q.from) qb = qb.where('d.note_date', '>=', q.from)
  if (q.to) qb = qb.where('d.note_date', '<=', q.to)
  if (q.q) {
    const pattern = likePattern(q.q)
    qb = qb.where((eb) =>
      eb.or([
        eb('d.number', 'ilike', pattern),
        eb('b.number', 'ilike', pattern),
        eb('b.supplier_invoice_no', 'ilike', pattern),
        eb('s.name', 'ilike', pattern),
      ]),
    )
  }
  return qb
}

const NOTE_SORT: Record<DebitNoteListQuery['sort']['field'], string> = {
  note_date: 'd.note_date',
  number: 'd.number',
  total_paise: 'd.total_paise',
  created_at: 'd.created_at',
}

function noteListSelect(qb: ReturnType<typeof filteredNotes>, q: DebitNoteListQuery) {
  return qb
    .select([
      'd.id',
      'd.number',
      'd.fy',
      'd.note_date',
      'd.store_id',
      'd.supplier_id',
      's.name as supplier_name',
      'd.bill_id',
      'b.number as bill_number',
      'b.supplier_invoice_no',
      'd.reason',
      'd.status',
      'd.settlement',
      'd.total_paise',
      'd.created_at',
      sql<number>`(select count(*) from debit_note_lines l where l.tenant_id = d.tenant_id and l.debit_note_id = d.id)::int`.as(
        'line_count',
      ),
    ])
    .orderBy(sql`${sql.ref(NOTE_SORT[q.sort.field])} ${sql.raw(q.sort.direction)}`)
    .orderBy('d.created_at', 'desc')
    .orderBy('d.id', 'desc')
}

type NoteListDbRow = {
  id: string
  number: string
  fy: string
  note_date: string
  store_id: string
  supplier_id: string
  supplier_name: string
  bill_id: string | null
  bill_number: string | null
  supplier_invoice_no: string | null
  reason: string
  status: string
  settlement: string
  total_paise: number
  created_at: Date
  line_count: number
}

function toNoteListRow(r: NoteListDbRow): DebitNoteListRow {
  return {
    id: r.id,
    number: r.number,
    fy: r.fy,
    note_date: r.note_date,
    store_id: r.store_id,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    bill_id: r.bill_id,
    bill_number: r.bill_number,
    supplier_invoice_no: r.supplier_invoice_no,
    reason: r.reason as DebitNoteReason,
    status: r.status as 'completed' | 'cancelled',
    settlement: r.settlement as DebitNoteSettlement,
    total_paise: r.total_paise,
    line_count: Number(r.line_count),
    created_at: iso(r.created_at),
  }
}

/** List + summary (count of the filtered notes; total of the live, non-cancelled ones). */
export async function listDebitNotes(
  tx: Tx,
  ctx: Ctx,
  q: DebitNoteListQuery,
  page: PageParams,
): Promise<{
  data: DebitNoteListRow[]
  page: { limit: number; offset: number; total: number }
  summary: { count: number; total_paise: number }
}> {
  const result = await paginateQuery(noteListSelect(filteredNotes(tx, ctx, q), q), page)
  const summary = await filteredNotes(tx, ctx, q)
    .select([
      sql<number>`count(*)::bigint`.as('count'),
      sql<number>`coalesce(sum(d.total_paise) filter (where d.status = 'completed'), 0)::bigint`.as(
        'total_paise',
      ),
    ])
    .executeTakeFirstOrThrow()
  return {
    data: result.data.map((r) => toNoteListRow(r as NoteListDbRow)),
    page: result.page,
    summary: { count: Number(summary.count), total_paise: Number(summary.total_paise) },
  }
}

export async function debitNotesCsv(
  tx: Tx,
  ctx: Ctx,
  q: DebitNoteListQuery,
): Promise<{ csv: string; rows: number }> {
  const rows = (await noteListSelect(filteredNotes(tx, ctx, q), q)
    .limit(CSV_MAX_ROWS)
    .execute()) as NoteListDbRow[]
  const out = rows.map((r) => {
    const row = toNoteListRow(r)
    return [
      row.number,
      row.note_date,
      row.supplier_name,
      row.bill_number,
      row.supplier_invoice_no,
      row.reason,
      row.settlement,
      row.status,
      row.line_count,
      csvRupees(row.total_paise),
    ]
  })
  return {
    csv: toCsv([
      [
        'Debit note',
        'Date',
        'Supplier',
        'GRN number',
        'Supplier invoice no',
        'Reason',
        'Settlement',
        'Status',
        'Lines',
        'Total (₹)',
      ],
      ...out,
    ]),
    rows: out.length,
  }
}

/** GET /debit-notes/prefill — free-form return lines for batches (expiry returns). */
export async function debitNotePrefill(
  tx: Tx,
  ctx: Ctx,
  q: DebitNotePrefillQuery,
): Promise<DebitNotePrefill> {
  await loadStore(tx, ctx, q.store_id)
  const ids = [...new Set(q.batch_ids)]
  const batches = ids.length
    ? await tx
        .selectFrom('batches')
        .select([
          'id',
          'product_id',
          'batch_no',
          'expiry_date',
          'purchase_price_paise',
          'supplier_id',
        ])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', 'in', ids)
        .execute()
    : []
  const found = new Map(batches.map((b) => [b.id, b]))
  for (const id of ids) if (!found.has(id)) throw notFound('batch', id)
  const products = await loadProducts(
    tx,
    ctx,
    batches.map((b) => b.product_id),
  )
  const last = await lastBillLinesByBatch(tx, ctx, ids, {
    ...(q.supplier_id ? { supplierId: q.supplier_id } : {}),
    storeId: q.store_id,
  })
  const stock = ids.length
    ? await tx
        .selectFrom('stock_levels')
        .select(['batch_id', 'qty_milli'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('store_id', '=', q.store_id)
        .where('batch_id', 'in', ids)
        .execute()
    : []
  const stockOf = new Map(stock.map((s) => [s.batch_id, s.qty_milli]))
  const supplierIds = [
    ...new Set(
      ids.flatMap((id) => {
        const s = last.get(id)?.supplier_id ?? found.get(id)!.supplier_id
        return s ? [s] : []
      }),
    ),
  ]
  const supplierRows = supplierIds.length
    ? await tx
        .selectFrom('suppliers')
        .select(['id', 'name'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', 'in', supplierIds)
        .execute()
    : []
  const supplierName = new Map(supplierRows.map((s) => [s.id, s.name]))

  const lines = ids.map((id) => {
    const b = found.get(id)!
    const p = products.get(b.product_id)!
    const bl = last.get(id)
    const supplierId = bl?.supplier_id ?? b.supplier_id
    return {
      product_id: p.id,
      product: productRef(p),
      batch_id: b.id,
      batch_no: b.batch_no,
      expiry_date: b.expiry_date,
      available_qty_milli: stockOf.get(b.id) ?? 0,
      unit_cost_paise:
        bl?.landed_unit_cost_paise ?? b.purchase_price_paise ?? p.purchase_price_paise,
      gst_rate_bp: bl?.gst_rate_bp ?? p.gst_rate_bp,
      cess_rate_bp: bl?.cess_rate_bp ?? p.cess_rate_bp,
      supplier_id: supplierId,
      supplier_name: supplierId ? (supplierName.get(supplierId) ?? null) : null,
      bill_id: bl?.bill_id ?? null,
      bill_line_id: bl?.bill_line_id ?? null,
      bill_number: bl?.bill_number ?? null,
      returnable_qty_milli: bl ? bl.returnable_qty_milli : null,
    }
  })
  let supplier: { id: string; name: string } | null = null
  if (q.supplier_id) {
    const s = await loadSupplier(tx, ctx, q.supplier_id)
    supplier = { id: s.id, name: s.name }
  } else {
    const distinct = new Set(lines.map((l) => l.supplier_id))
    const only = distinct.size === 1 ? [...distinct][0] : null
    if (only) supplier = { id: only, name: supplierName.get(only) ?? '' }
  }
  return { supplier, lines }
}
