/**
 * Invoice and credit-note lists (filters, sorting, pagination, summary over the filtered range,
 * CSV export with the same filters).
 */
import { formatDateDisplay, paiseToRupeesString } from '@kadai/shared'
import { toCsv } from '@kadai/shared/api/identity'
import type {
  CreditNoteListQuerySchema,
  CreditNoteListRow,
  InvoiceListQuerySchema,
  InvoiceListResponse,
  SalesInvoiceListRow,
} from '@kadai/shared/api/sales'
import { sql } from 'kysely'
import type { z } from 'zod'
import type { Tx } from '../../db/tenant'
import { assertStoreAccess } from '../../core/http'
import type { SalesCtx } from './common'

export type InvoiceListQueryParsed = z.output<typeof InvoiceListQuerySchema>
export type CreditNoteListQueryParsed = z.output<typeof CreditNoteListQuerySchema>

/** Rows of a CSV export are capped (a bigger export is a report job). */
export const CSV_MAX_ROWS = 50_000

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Invoices matching the list filters (joins for the row columns; no select yet). */
function invoiceBase(tx: Tx, ctx: SalesCtx, q: InvoiceListQueryParsed) {
  let b = tx
    .selectFrom('sales_invoices as i')
    .innerJoin('stores as s', (j) =>
      j.onRef('s.tenant_id', '=', 'i.tenant_id').onRef('s.id', '=', 'i.store_id'),
    )
    .leftJoin('registers as r', (j) =>
      j.onRef('r.tenant_id', '=', 'i.tenant_id').onRef('r.id', '=', 'i.register_id'),
    )
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .where('i.tenant_id', '=', ctx.tenantId)
    .where('i.status', 'in', q.status?.length ? q.status : ['completed', 'cancelled', 'converted'])
    .where('i.doc_type', 'in', q.doc_type?.length ? q.doc_type : ['tax_invoice', 'bill_of_supply'])
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    b = b.where('i.store_id', '=', q.store_id)
  } else if (ctx.storeIds) {
    b = ctx.storeIds.length
      ? b.where('i.store_id', 'in', [...ctx.storeIds])
      : b.where(sql<boolean>`false`)
  }
  if (q.payment_status?.length) b = b.where('i.payment_status', 'in', q.payment_status)
  if (q.channel?.length) b = b.where('i.channel', 'in', q.channel)
  if (q.register_id) b = b.where('i.register_id', '=', q.register_id)
  if (q.customer_id) b = b.where('i.customer_id', '=', q.customer_id)
  if (q.created_by) b = b.where('i.created_by', '=', q.created_by)
  if (q.shift_id) b = b.where('i.shift_id', '=', q.shift_id)
  if (q.has_due !== undefined) {
    b = q.has_due
      ? b.where('i.due_paise', '>', 0).where('i.status', '=', 'completed')
      : b.where('i.due_paise', '<=', 0)
  }
  if (q.offline !== undefined) {
    b = b.where('i.offline_created_at', q.offline ? 'is not' : 'is', null)
  }
  if (q.from) b = b.where('i.invoice_date', '>=', q.from)
  if (q.to) b = b.where('i.invoice_date', '<=', q.to)
  if (q.q) {
    const term = `%${escapeLike(q.q)}%`
    const digits = q.q.replace(/\D/g, '')
    b = b.where((eb) =>
      eb.or([
        eb('i.number', 'ilike', term),
        eb('i.customer_name', 'ilike', term),
        ...(digits.length >= 3 ? [eb('i.customer_phone', 'like', `%${digits}%`)] : []),
      ]),
    )
  }
  return b
}

const INVOICE_SORT: Record<InvoiceListQueryParsed['sort']['field'], string> = {
  invoice_date: 'i.invoice_date',
  invoice_at: 'i.invoice_at',
  number: 'i.number',
  total_paise: 'i.total_paise',
  due_paise: 'i.due_paise',
  created_at: 'i.created_at',
}

function invoiceRowsQuery(tx: Tx, ctx: SalesCtx, q: InvoiceListQueryParsed) {
  const dir = q.sort.direction
  return invoiceBase(tx, ctx, q)
    .select([
      'i.id',
      'i.doc_type',
      'i.number',
      'i.fy',
      'i.invoice_date',
      'i.invoice_at',
      'i.status',
      'i.channel',
      'i.store_id',
      's.code as store_code',
      'i.register_id',
      'r.code as register_code',
      'i.customer_id',
      'i.customer_name',
      'i.customer_phone',
      'i.item_count',
      'i.total_paise',
      'i.paid_paise',
      'i.returned_paise',
      'i.due_paise',
      'i.payment_status',
      'i.due_date',
      'i.created_by',
      'u.full_name as created_by_name',
      'i.offline_created_at',
      'i.client_ref',
      'i.created_at',
      'i.updated_at',
      'i.taxable_paise',
      sql<number>`(i.cgst_paise + i.sgst_paise + i.igst_paise + i.cess_paise)`.as('tax_paise'),
    ])
    .orderBy(
      sql`${sql.ref(INVOICE_SORT[q.sort.field])} ${sql.raw(dir === 'desc' ? 'desc nulls last' : 'asc nulls first')}`,
    )
    .orderBy('i.id', dir)
}

type InvoiceRowOut = Awaited<ReturnType<ReturnType<typeof invoiceRowsQuery>['execute']>>[number]

function toListRow(r: InvoiceRowOut): SalesInvoiceListRow {
  return {
    id: r.id,
    doc_type: r.doc_type as SalesInvoiceListRow['doc_type'],
    number: r.number,
    fy: r.fy,
    invoice_date: r.invoice_date,
    invoice_at: r.invoice_at.toISOString(),
    status: r.status as SalesInvoiceListRow['status'],
    channel: r.channel as SalesInvoiceListRow['channel'],
    store_id: r.store_id,
    store_code: r.store_code,
    register_id: r.register_id,
    register_code: r.register_code ?? null,
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    item_count: r.item_count,
    total_paise: r.total_paise,
    paid_paise: r.paid_paise,
    returned_paise: r.returned_paise,
    due_paise: r.due_paise,
    payment_status: r.payment_status as SalesInvoiceListRow['payment_status'],
    due_date: r.due_date,
    created_by: r.created_by,
    created_by_name: r.created_by_name ?? null,
    offline: r.offline_created_at !== null,
    client_ref: r.client_ref,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }
}

export async function listInvoices(
  tx: Tx,
  ctx: SalesCtx,
  q: InvoiceListQueryParsed,
): Promise<InvoiceListResponse> {
  const rows = await invoiceRowsQuery(tx, ctx, q)
    .select(sql<number>`count(*) over()`.as('__total'))
    .limit(q.limit)
    .offset(q.offset)
    .execute()
  const summary = await invoiceBase(tx, ctx, q)
    .where('i.status', '=', 'completed')
    .select([
      sql<number>`count(*)::int`.as('count'),
      sql<number>`coalesce(sum(i.total_paise), 0)::bigint`.as('total_paise'),
      sql<number>`coalesce(sum(i.paid_paise), 0)::bigint`.as('paid_paise'),
      sql<number>`coalesce(sum(i.due_paise), 0)::bigint`.as('due_paise'),
      sql<number>`coalesce(sum(i.returned_paise), 0)::bigint`.as('returned_paise'),
      sql<number>`coalesce(sum(i.taxable_paise), 0)::bigint`.as('taxable_paise'),
      sql<number>`coalesce(sum(i.cgst_paise + i.sgst_paise + i.igst_paise + i.cess_paise), 0)::bigint`.as(
        'tax_paise',
      ),
    ])
    .executeTakeFirstOrThrow()
  let total = rows.length ? Number(rows[0]!.__total) : 0
  if (!rows.length && q.offset > 0) {
    const c = await invoiceBase(tx, ctx, q)
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow()
    total = Number(c.n)
  }
  return {
    data: rows.map(toListRow),
    page: { limit: q.limit, offset: q.offset, total },
    summary: {
      count: Number(summary.count),
      total_paise: Number(summary.total_paise),
      paid_paise: Number(summary.paid_paise),
      due_paise: Number(summary.due_paise),
      returned_paise: Number(summary.returned_paise),
      taxable_paise: Number(summary.taxable_paise),
      tax_paise: Number(summary.tax_paise),
    },
  }
}

const rupees = (p: number): string => paiseToRupeesString(p)

export async function invoicesCsv(
  tx: Tx,
  ctx: SalesCtx,
  q: InvoiceListQueryParsed,
): Promise<string> {
  const rows = await invoiceRowsQuery(tx, ctx, q).limit(CSV_MAX_ROWS).execute()
  return toCsv([
    [
      'Number',
      'Date',
      'Type',
      'Status',
      'Store',
      'Counter',
      'Customer',
      'Phone',
      'Items',
      'Taxable (Rs)',
      'Tax (Rs)',
      'Total (Rs)',
      'Paid (Rs)',
      'Returned (Rs)',
      'Due (Rs)',
      'Payment status',
      'Channel',
      'Created by',
    ],
    ...rows.map((r) => [
      r.number ?? '',
      formatDateDisplay(r.invoice_date),
      r.doc_type,
      r.status,
      r.store_code,
      r.register_code ?? '',
      r.customer_name ?? '',
      r.customer_phone ?? '',
      r.item_count,
      rupees(r.taxable_paise),
      rupees(Number(r.tax_paise)),
      rupees(r.total_paise),
      rupees(r.paid_paise),
      rupees(r.returned_paise),
      rupees(r.due_paise),
      r.payment_status,
      r.channel,
      r.created_by_name ?? '',
    ]),
  ])
}

// ---------------------------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------------------------

const CN_SORT: Record<CreditNoteListQueryParsed['sort']['field'], string> = {
  note_date: 'c.note_date',
  number: 'c.number',
  total_paise: 'c.total_paise',
  created_at: 'c.created_at',
}

function creditNoteQuery(tx: Tx, ctx: SalesCtx, q: CreditNoteListQueryParsed) {
  let b = tx
    .selectFrom('credit_notes as c')
    .leftJoin('sales_invoices as i', (j) =>
      j.onRef('i.tenant_id', '=', 'c.tenant_id').onRef('i.id', '=', 'c.invoice_id'),
    )
    .leftJoin('users as u', 'u.id', 'c.created_by')
    .where('c.tenant_id', '=', ctx.tenantId)
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    b = b.where('c.store_id', '=', q.store_id)
  } else if (ctx.storeIds) {
    b = ctx.storeIds.length
      ? b.where('c.store_id', 'in', [...ctx.storeIds])
      : b.where(sql<boolean>`false`)
  }
  if (q.status?.length) b = b.where('c.status', 'in', q.status)
  if (q.reason?.length) b = b.where('c.reason', 'in', q.reason)
  if (q.settlement?.length) b = b.where('c.settlement', 'in', q.settlement)
  if (q.customer_id) b = b.where('c.customer_id', '=', q.customer_id)
  if (q.invoice_id) b = b.where('c.invoice_id', '=', q.invoice_id)
  if (q.from) b = b.where('c.note_date', '>=', q.from)
  if (q.to) b = b.where('c.note_date', '<=', q.to)
  if (q.q) {
    const term = `%${escapeLike(q.q)}%`
    const digits = q.q.replace(/\D/g, '')
    b = b.where((eb) =>
      eb.or([
        eb('c.number', 'ilike', term),
        eb('i.number', 'ilike', term),
        eb('c.customer_name', 'ilike', term),
        ...(digits.length >= 3 ? [eb('c.customer_phone', 'like', `%${digits}%`)] : []),
      ]),
    )
  }
  return b
}

function creditNoteRows(tx: Tx, ctx: SalesCtx, q: CreditNoteListQueryParsed) {
  const dir = q.sort.direction
  return creditNoteQuery(tx, ctx, q)
    .select([
      'c.id',
      'c.number',
      'c.fy',
      'c.note_date',
      'c.store_id',
      'c.register_id',
      'c.invoice_id',
      'i.number as invoice_number',
      'c.customer_id',
      'c.customer_name',
      'c.customer_phone',
      'c.reason',
      'c.status',
      'c.settlement',
      'c.total_paise',
      'c.settled_paise',
      sql<number>`(select count(*)::int from credit_note_lines l where l.tenant_id = c.tenant_id and l.credit_note_id = c.id)`.as(
        'item_count',
      ),
      'u.full_name as created_by_name',
      'c.client_ref',
      'c.created_at',
    ])
    .orderBy(sql.ref(CN_SORT[q.sort.field]), dir)
    .orderBy('c.id', dir)
}

type CnRowOut = Awaited<ReturnType<ReturnType<typeof creditNoteRows>['execute']>>[number]

function toCnRow(r: CnRowOut): CreditNoteListRow {
  return {
    id: r.id,
    number: r.number,
    fy: r.fy,
    note_date: r.note_date,
    store_id: r.store_id,
    register_id: r.register_id,
    invoice_id: r.invoice_id,
    invoice_number: r.invoice_number ?? null,
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    reason: r.reason as CreditNoteListRow['reason'],
    status: r.status as CreditNoteListRow['status'],
    settlement: r.settlement as CreditNoteListRow['settlement'],
    total_paise: r.total_paise,
    settled_paise: r.settled_paise,
    item_count: Number(r.item_count),
    created_by_name: r.created_by_name ?? null,
    client_ref: r.client_ref,
    created_at: r.created_at.toISOString(),
  }
}

export async function listCreditNotes(tx: Tx, ctx: SalesCtx, q: CreditNoteListQueryParsed) {
  const rows = await creditNoteRows(tx, ctx, q)
    .select(sql<number>`count(*) over()`.as('__total'))
    .limit(q.limit)
    .offset(q.offset)
    .execute()
  const summary = await creditNoteQuery(tx, ctx, q)
    .where('c.status', '=', 'completed')
    .select([
      sql<number>`count(*)::int`.as('count'),
      sql<number>`coalesce(sum(c.total_paise), 0)::bigint`.as('total_paise'),
    ])
    .executeTakeFirstOrThrow()
  let total = rows.length ? Number(rows[0]!.__total) : 0
  if (!rows.length && q.offset > 0) {
    const c = await creditNoteQuery(tx, ctx, q)
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow()
    total = Number(c.n)
  }
  return {
    data: rows.map(toCnRow),
    page: { limit: q.limit, offset: q.offset, total },
    summary: { count: Number(summary.count), total_paise: Number(summary.total_paise) },
  }
}

export async function creditNotesCsv(
  tx: Tx,
  ctx: SalesCtx,
  q: CreditNoteListQueryParsed,
): Promise<string> {
  const rows = await creditNoteRows(tx, ctx, q).limit(CSV_MAX_ROWS).execute()
  return toCsv([
    [
      'Number',
      'Date',
      'Bill',
      'Customer',
      'Phone',
      'Reason',
      'Settlement',
      'Status',
      'Items',
      'Total (Rs)',
      'Settled (Rs)',
      'Created by',
    ],
    ...rows.map((r) => [
      r.number,
      formatDateDisplay(r.note_date),
      r.invoice_number ?? '',
      r.customer_name ?? '',
      r.customer_phone ?? '',
      r.reason,
      r.settlement,
      r.status,
      Number(r.item_count),
      rupees(r.total_paise),
      rupees(r.settled_paise),
      r.created_by_name ?? '',
    ]),
  ])
}
