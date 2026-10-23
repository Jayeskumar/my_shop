/**
 * Read models of sales documents: invoice detail (lines, payments, credit notes, journal entry,
 * shift, customer khata, rx, audit), invoice payments and tax breakups.
 */
import { amountForQty, sumSafe } from '@kadai/shared'
import { paymentOriginOf } from '@kadai/shared/api/payments'
import {
  type InvoicePayment,
  RxSchema,
  type SalesInvoiceDetail,
  type SalesInvoiceLine,
  type TaxBreakupRowOut,
  parseCashTenderNotes,
  publicInvoicePath,
  returnableQtyMilli,
} from '@kadai/shared/api/sales'
import {
  CreditNoteReasonSchema,
  CreditNoteSettlementSchema,
  CreditNoteStatusSchema,
  PaymentDirectionSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  SalesChannelSchema,
  SalesDocTypeSchema,
  SalesInvoiceStatusSchema,
  SalesPaymentStatusSchema,
  ShiftStatusSchema,
} from '@kadai/shared'
import type { Selectable } from 'kysely'
import type { SalesInvoices } from '../../db/schema.generated'
import type { Tx } from '../../db/tenant'
import { notFound } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { type SalesCtx, addressOf, can, recordOf } from './common'

export type InvoiceRow = Selectable<SalesInvoices>

/** The sales_invoices row (404 when missing; 403 outside the member's stores). */
export async function loadInvoiceRow(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<InvoiceRow> {
  let q = tx
    .selectFrom('sales_invoices')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('sales_invoice', id)
  assertStoreAccess(ctx, row.store_id)
  return row
}

export function shareUrlOf(publicBaseUrl: string, token: string | null): string | null {
  return token ? `${publicBaseUrl}${publicInvoicePath(token)}` : null
}

/** Tax summary per GST rate (ascending) of stored lines. */
export function taxBreakupOf(
  lines: ReadonlyArray<{
    gst_rate_bp: number
    taxable_paise: number
    cgst_paise: number
    sgst_paise: number
    igst_paise: number
    cess_paise: number
  }>,
): TaxBreakupRowOut[] {
  const by = new Map<number, TaxBreakupRowOut>()
  for (const l of lines) {
    const row = by.get(l.gst_rate_bp) ?? {
      gst_rate_bp: l.gst_rate_bp,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      cess_paise: 0,
    }
    row.taxable_paise += l.taxable_paise
    row.cgst_paise += l.cgst_paise
    row.sgst_paise += l.sgst_paise
    row.igst_paise += l.igst_paise
    row.cess_paise += l.cess_paise
    by.set(l.gst_rate_bp, row)
  }
  return [...by.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp)
}

/** "You saved" of a stored line: MRP value of charged + free quantity − line total. */
export function lineMrpSavings(l: {
  mrp_paise: number | null
  qty_milli: number
  free_qty_milli: number
  pack_size: number
  total_paise: number
}): number {
  if (l.mrp_paise === null) return 0
  return Math.max(
    0,
    amountForQty(l.mrp_paise, l.qty_milli + l.free_qty_milli, l.pack_size) - l.total_paise,
  )
}

export interface StoredLine {
  id: string
  line_no: number
  product_id: string | null
  batch_id: string | null
  batch_no: string | null
  expiry_date: string | null
  name: string
  name_ta: string | null
  hsn_code: string | null
  unit: string
  pack_size: number
  qty_milli: number
  free_qty_milli: number
  mrp_paise: number | null
  unit_price_paise: number
  discount_bp: number
  gross_paise: number
  discount_paise: number
  taxable_paise: number
  gst_rate_bp: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_rate_bp: number
  cess_paise: number
  total_paise: number
  unit_cost_paise: number
  cost_paise: number
  promotion_id: string | null
  promotion_name: string | null
  returned_qty_milli: number
  serial_numbers: string[]
  meta: unknown
  track_inventory: boolean | null
}

export async function loadStoredLines(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  invoiceId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<StoredLine[]> {
  let q = tx
    .selectFrom('sales_invoice_lines as l')
    .leftJoin('batches as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.batch_id'),
    )
    .leftJoin('promotions as pr', (j) =>
      j.onRef('pr.tenant_id', '=', 'l.tenant_id').onRef('pr.id', '=', 'l.promotion_id'),
    )
    .leftJoin('products as p', (j) =>
      j.onRef('p.tenant_id', '=', 'l.tenant_id').onRef('p.id', '=', 'l.product_id'),
    )
    .select([
      'l.id',
      'l.line_no',
      'l.product_id',
      'l.batch_id',
      'b.batch_no',
      'b.expiry_date',
      'l.name',
      'l.name_ta',
      'l.hsn_code',
      'l.unit',
      'l.pack_size',
      'l.qty_milli',
      'l.free_qty_milli',
      'l.mrp_paise',
      'l.unit_price_paise',
      'l.discount_bp',
      'l.gross_paise',
      'l.discount_paise',
      'l.taxable_paise',
      'l.gst_rate_bp',
      'l.cgst_paise',
      'l.sgst_paise',
      'l.igst_paise',
      'l.cess_rate_bp',
      'l.cess_paise',
      'l.total_paise',
      'l.unit_cost_paise',
      'l.cost_paise',
      'l.promotion_id',
      'pr.name as promotion_name',
      'l.returned_qty_milli',
      'l.serial_numbers',
      'l.meta',
      'p.track_inventory',
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.invoice_id', '=', invoiceId)
    .orderBy('l.line_no')
  if (opts.forUpdate) q = q.forUpdate(['l'])
  return q.execute()
}

/** Payments allocated to an invoice (all statuses; cancelled ones included for history). */
export async function invoicePayments(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  target: { type: 'sales_invoice' | 'credit_note'; id: string },
): Promise<InvoicePayment[]> {
  const rows = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .leftJoin('payment_intents as pi', (j) =>
      j.onRef('pi.tenant_id', '=', 'p.tenant_id').onRef('pi.id', '=', 'p.payment_intent_id'),
    )
    .leftJoin('users as u', 'u.id', 'p.created_by')
    .select([
      'p.id as payment_id',
      'p.number',
      'p.direction',
      'p.method',
      'a.amount_paise',
      'p.amount_paise as payment_amount_paise',
      'p.status',
      'p.payment_date',
      'p.paid_at',
      'p.reference',
      'p.payment_intent_id',
      'pi.payer_vpa',
      'p.client_ref',
      'p.notes',
      'u.full_name as created_by_name',
    ])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', target.type)
    .where('a.target_id', '=', target.id)
    .orderBy('p.paid_at')
    .orderBy('p.id')
    .execute()
  return rows.map((r) => ({
    payment_id: r.payment_id,
    number: r.number,
    direction: PaymentDirectionSchema.parse(r.direction),
    method: PaymentMethodSchema.parse(r.method),
    amount_paise: r.amount_paise,
    payment_amount_paise: r.payment_amount_paise,
    status: PaymentStatusSchema.parse(r.status),
    payment_date: r.payment_date,
    paid_at: r.paid_at.toISOString(),
    reference: r.reference,
    payment_intent_id: r.payment_intent_id,
    payer_vpa: r.payer_vpa ?? null,
    origin: paymentOriginOf(r.client_ref),
    change_paise:
      r.method === 'cash' ? (parseCashTenderNotes(r.notes)?.change_paise ?? null) : null,
    created_by_name: r.created_by_name ?? null,
  }))
}

export function toInvoiceLine(l: StoredLine, showCost: boolean): SalesInvoiceLine {
  return {
    id: l.id,
    line_no: l.line_no,
    product_id: l.product_id,
    batch_id: l.batch_id,
    batch_no: l.batch_no ?? null,
    expiry_date: l.expiry_date ?? null,
    name: l.name,
    name_ta: l.name_ta,
    hsn_code: l.hsn_code,
    unit: l.unit,
    pack_size: l.pack_size,
    qty_milli: l.qty_milli,
    free_qty_milli: l.free_qty_milli,
    mrp_paise: l.mrp_paise,
    unit_price_paise: l.unit_price_paise,
    discount_bp: l.discount_bp,
    gross_paise: l.gross_paise,
    discount_paise: l.discount_paise,
    taxable_paise: l.taxable_paise,
    gst_rate_bp: l.gst_rate_bp,
    cgst_paise: l.cgst_paise,
    sgst_paise: l.sgst_paise,
    igst_paise: l.igst_paise,
    cess_rate_bp: l.cess_rate_bp,
    cess_paise: l.cess_paise,
    total_paise: l.total_paise,
    unit_cost_paise: showCost ? l.unit_cost_paise : 0,
    cost_paise: showCost ? l.cost_paise : 0,
    promotion_id: l.promotion_id,
    promotion_name: l.promotion_name ?? null,
    returned_qty_milli: l.returned_qty_milli,
    returnable_qty_milli: returnableQtyMilli(l),
    serial_numbers: l.serial_numbers,
    meta: recordOf(l.meta),
  }
}

/** Full invoice detail (GET /sales/invoices/:id and every write's response). */
export async function loadInvoiceDetail(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
  publicBaseUrl: string,
): Promise<SalesInvoiceDetail> {
  const t = ctx.tenantId
  const row = await loadInvoiceRow(tx, ctx, id)
  const store = await tx
    .selectFrom('stores')
    .select(['id', 'code', 'name'])
    .where('tenant_id', '=', t)
    .where('id', '=', row.store_id)
    .executeTakeFirstOrThrow()
  const register = row.register_id
    ? await tx
        .selectFrom('registers')
        .select(['id', 'code', 'name'])
        .where('tenant_id', '=', t)
        .where('id', '=', row.register_id)
        .executeTakeFirst()
    : undefined
  const userIds = [row.created_by, row.cancelled_by, row.salesperson_id].filter(
    (x): x is string => x !== null,
  )
  const users = new Map(
    userIds.length
      ? (
          await tx
            .selectFrom('users')
            .select(['id', 'full_name'])
            .where('id', 'in', userIds)
            .execute()
        ).map((u) => [u.id, u.full_name])
      : [],
  )
  const lines = await loadStoredLines(tx, ctx, id)
  const payments = await invoicePayments(tx, ctx, { type: 'sales_invoice', id })
  const creditNotes = await tx
    .selectFrom('credit_notes')
    .select(['id', 'number', 'note_date', 'status', 'reason', 'settlement', 'total_paise'])
    .where('tenant_id', '=', t)
    .where('invoice_id', '=', id)
    .orderBy('note_date')
    .orderBy('created_at')
    .execute()
  const journal = await tx
    .selectFrom('journal_entries')
    .select('id')
    .where('tenant_id', '=', t)
    .where('source_type', '=', 'sales_invoice')
    .where('source_id', '=', id)
    .where('reverses_entry_id', 'is', null)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst()
  const shift = row.shift_id
    ? await tx
        .selectFrom('register_shifts as sh')
        .leftJoin('users as u', 'u.id', 'sh.opened_by')
        .select(['sh.id', 'sh.status', 'sh.opened_at', 'u.full_name as opened_by_name'])
        .where('sh.tenant_id', '=', t)
        .where('sh.id', '=', row.shift_id)
        .executeTakeFirst()
    : undefined
  const customer = row.customer_id
    ? await tx
        .selectFrom('customers')
        .select(['id', 'name', 'phone', 'balance_paise', 'credit_limit_paise', 'loyalty_points'])
        .where('tenant_id', '=', t)
        .where('id', '=', row.customer_id)
        .executeTakeFirst()
    : undefined
  const sourceEstimate = await tx
    .selectFrom('sales_invoices')
    .select(['id', 'number'])
    .where('tenant_id', '=', t)
    .where('converted_to_id', '=', id)
    .executeTakeFirst()
  const auditRows = await tx
    .selectFrom('audit_logs as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .select(['a.id', 'a.action', 'a.summary', 'u.full_name as user_name', 'a.created_at'])
    .where('a.tenant_id', '=', t)
    .where('a.entity_type', '=', 'sales_invoice')
    .where('a.entity_id', '=', id)
    .orderBy('a.created_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(20)
    .execute()

  const showCost = can(ctx, 'reports.read')
  const rx = row.rx ? RxSchema.safeParse(row.rx) : null
  return {
    id: row.id,
    doc_type: SalesDocTypeSchema.parse(row.doc_type),
    number: row.number,
    fy: row.fy,
    invoice_date: row.invoice_date,
    invoice_at: row.invoice_at.toISOString(),
    status: SalesInvoiceStatusSchema.parse(row.status),
    channel: SalesChannelSchema.parse(row.channel),
    store_id: row.store_id,
    store_code: store.code,
    register_id: row.register_id,
    register_code: register?.code ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    item_count: row.item_count,
    total_paise: row.total_paise,
    paid_paise: row.paid_paise,
    returned_paise: row.returned_paise,
    due_paise: row.due_paise,
    payment_status: SalesPaymentStatusSchema.parse(row.payment_status),
    due_date: row.due_date,
    created_by: row.created_by,
    created_by_name: row.created_by ? (users.get(row.created_by) ?? null) : null,
    offline: row.offline_created_at !== null,
    client_ref: row.client_ref,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    store: { id: store.id, code: store.code, name: store.name },
    register: register ? { id: register.id, code: register.code, name: register.name } : null,
    shift_id: row.shift_id,
    customer_gstin: row.customer_gstin,
    customer_address: addressOf(row.customer_address),
    customer_state_code: row.customer_state_code,
    place_of_supply: row.place_of_supply,
    is_interstate: row.is_interstate,
    reverse_charge: row.reverse_charge,
    price_includes_tax: row.price_includes_tax,
    gross_paise: row.gross_paise,
    item_discount_paise: row.item_discount_paise,
    bill_discount_paise: row.bill_discount_paise,
    taxable_paise: row.taxable_paise,
    cgst_paise: row.cgst_paise,
    sgst_paise: row.sgst_paise,
    igst_paise: row.igst_paise,
    cess_paise: row.cess_paise,
    tax_paise: sumSafe([row.cgst_paise, row.sgst_paise, row.igst_paise, row.cess_paise]),
    round_off_paise: row.round_off_paise,
    cost_paise: showCost ? row.cost_paise : 0,
    loyalty_points_earned: row.loyalty_points_earned,
    loyalty_points_redeemed: row.loyalty_points_redeemed,
    loyalty_redeem_paise: row.loyalty_redeem_paise,
    rx: rx?.success ? rx.data : null,
    salesperson_id: row.salesperson_id,
    salesperson_name: row.salesperson_id ? (users.get(row.salesperson_id) ?? null) : null,
    notes: row.notes,
    share_url: shareUrlOf(publicBaseUrl, row.share_token),
    offline_created_at: row.offline_created_at ? row.offline_created_at.toISOString() : null,
    converted_to_id: row.converted_to_id,
    source_estimate: sourceEstimate
      ? { id: sourceEstimate.id, number: sourceEstimate.number }
      : null,
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
    cancelled_at: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    cancelled_by: row.cancelled_by,
    cancelled_by_name: row.cancelled_by ? (users.get(row.cancelled_by) ?? null) : null,
    cancel_reason: row.cancel_reason,
    lines: lines.map((l) => toInvoiceLine(l, showCost)),
    tax_breakup: taxBreakupOf(lines),
    mrp_savings_paise: sumSafe(lines.map(lineMrpSavings)),
    payments,
    credit_notes: creditNotes.map((c) => ({
      id: c.id,
      number: c.number,
      note_date: c.note_date,
      status: CreditNoteStatusSchema.parse(c.status),
      reason: CreditNoteReasonSchema.parse(c.reason),
      settlement: CreditNoteSettlementSchema.parse(c.settlement),
      total_paise: c.total_paise,
    })),
    journal_entry_id: journal?.id ?? null,
    shift: shift
      ? {
          id: shift.id,
          status: ShiftStatusSchema.parse(shift.status),
          opened_at: shift.opened_at.toISOString(),
          opened_by_name: shift.opened_by_name ?? null,
        }
      : null,
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          balance_paise: customer.balance_paise,
          credit_limit_paise: customer.credit_limit_paise,
          loyalty_points: customer.loyalty_points,
        }
      : null,
    audit: auditRows.map((a) => ({
      id: a.id,
      action: a.action,
      summary: a.summary,
      user_name: a.user_name ?? null,
      created_at: a.created_at.toISOString(),
    })),
  }
}
