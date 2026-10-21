/**
 * Receipts (in) and payment vouchers (out) — GET/POST /payments, GET /payments/:id,
 * POST /payments/:id/cancel, GET /payments/open-items.
 *
 *  - Money postings go through core recordPayment / cancelPayment only (journal, allocations,
 *    documents' paid/due, intent linkage, RC… / PV… numbering).
 *  - Direction-dependent permission: in → payments.collect, out → payments.pay.
 *  - `auto_allocate: 'fifo'` settles the party's open items oldest first with the shared
 *    allocateFifo() over the same open-items list the web shows (opening balance first, then
 *    documents by date and number); the rest stays as advance (unallocated_paise).
 *  - Only `origin: manual` payments can be cancelled here: POS tenders and return settlements are
 *    cancelled with their document (409 `payment_not_cancellable`).
 *  - Store scoping: members only see / touch payments of their stores (other stores → 404).
 *
 * Open amounts follow core recordPayment's rules: invoices / bills by due_paise, credit notes by
 * total − settled, debit notes, credit expenses and opening balances by their total minus the
 * live (completed-payment) allocations.
 */
import { diffDays, instantRangeForDates, isUuid, paiseToRupeesString } from '@kadai/shared'
import type {
  AllocationTargetType,
  PartyType,
  PaymentDirection,
  PaymentMethod,
  PaymentProviderCode,
} from '@kadai/shared'
import { toCsv } from '@kadai/shared/api/identity'
import {
  type OpenItem,
  type OpenItemsQuerySchema,
  type OpenItemsResponse,
  type Payment,
  type PaymentAllocationDetail,
  type PaymentCreateSchema,
  type PaymentDetail,
  type PaymentListQuerySchema,
  type PaymentListResponse,
  type PaymentOrigin,
  allocateFifo,
  isPaymentCancellable,
  paymentOriginOf,
} from '@kadai/shared/api/payments'
import { type ExpressionBuilder, type SqlBool, type Expression, sql } from 'kysely'
import type { z } from 'zod'
import { canAccessStore } from '../../core/context'
import { notFound, validationError } from '../../core/errors'
import { assertStoreAccess, parsePage } from '../../core/http'
import { cancelPayment, recordPayment, storeCreditBalance } from '../../core/payments'
import type { DB } from '../../db/schema.generated'
import type { Tx } from '../../db/tenant'
import { type Ctx, assertPermission, reasonError, tenantToday } from './common'

type ListQuery = z.output<typeof PaymentListQuerySchema>
type CreateBody = z.output<typeof PaymentCreateSchema>
type OpenItemsQuery = z.output<typeof OpenItemsQuerySchema>

/** Rows of a CSV export are capped (bigger exports belong in reports). */
export const PAYMENTS_CSV_MAX_ROWS = 50_000

/** client_ref prefixes reserved for document-created payments (origin ≠ manual). */
const RESERVED_CLIENT_REF = /^(tender|cn|dn):/

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

function paymentQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('payments as p')
    .leftJoin('customers as c', (j) =>
      j
        .onRef('c.tenant_id', '=', 'p.tenant_id')
        .onRef('c.id', '=', 'p.party_id')
        .on('p.party_type', '=', 'customer'),
    )
    .leftJoin('suppliers as s', (j) =>
      j
        .onRef('s.tenant_id', '=', 'p.tenant_id')
        .onRef('s.id', '=', 'p.party_id')
        .on('p.party_type', '=', 'supplier'),
    )
    .innerJoin('accounts as a', (j) =>
      j.onRef('a.tenant_id', '=', 'p.tenant_id').onRef('a.id', '=', 'p.account_id'),
    )
    .leftJoin('users as u', 'u.id', 'p.created_by')
    .select([
      'p.id',
      'p.store_id',
      'p.register_id',
      'p.shift_id',
      'p.number',
      'p.fy',
      'p.direction',
      'p.party_type',
      'p.party_id',
      'p.method',
      'p.amount_paise',
      'p.unallocated_paise',
      'p.status',
      'p.payment_date',
      'p.paid_at',
      'p.reference',
      'p.payment_intent_id',
      'p.account_id',
      'a.name as account_name',
      'p.notes',
      'p.client_ref',
      'p.created_by',
      'u.full_name as created_by_name',
      'p.created_at',
      'p.updated_at',
      'p.cancelled_at',
      'p.cancelled_by',
      'p.cancel_reason',
    ])
    .select(sql<string | null>`coalesce(c.name, s.name)`.as('party_name'))
    .where('p.tenant_id', '=', ctx.tenantId)
}

type PaymentRow = Awaited<ReturnType<ReturnType<typeof paymentQuery>['executeTakeFirstOrThrow']>>

function toPayment(r: PaymentRow): Payment {
  return {
    id: r.id,
    store_id: r.store_id,
    register_id: r.register_id,
    shift_id: r.shift_id,
    number: r.number,
    fy: r.fy,
    direction: r.direction as PaymentDirection,
    party_type: (r.party_type as PartyType | null) ?? null,
    party_id: r.party_id,
    party_name: r.party_name,
    method: r.method as PaymentMethod,
    amount_paise: r.amount_paise,
    allocated_paise: r.amount_paise - r.unallocated_paise,
    unallocated_paise: r.unallocated_paise,
    status: r.status as Payment['status'],
    payment_date: r.payment_date,
    paid_at: r.paid_at.toISOString(),
    reference: r.reference,
    payment_intent_id: r.payment_intent_id,
    account_id: r.account_id,
    account_name: r.account_name,
    notes: r.notes,
    client_ref: r.client_ref,
    origin: paymentOriginOf(r.client_ref),
    created_by: r.created_by,
    created_by_name: r.created_by_name,
    created_at: r.created_at.toISOString(),
    cancelled_at: r.cancelled_at ? r.cancelled_at.toISOString() : null,
    cancel_reason: r.cancel_reason,
  }
}

type PaymentsEB = ExpressionBuilder<
  DB & { p: DB['payments']; c: DB['customers']; s: DB['suppliers'] },
  'p' | 'c' | 's'
>

function originCondition(eb: PaymentsEB, origin: PaymentOrigin): Expression<SqlBool> {
  switch (origin) {
    case 'sales_tender':
      return eb('p.client_ref', 'like', 'tender:%')
    case 'credit_note_settlement':
      return eb('p.client_ref', 'like', 'cn:%')
    case 'debit_note_settlement':
      return eb('p.client_ref', 'like', 'dn:%')
    case 'manual':
      return eb.or([
        eb('p.client_ref', 'is', null),
        eb.and([
          eb('p.client_ref', 'not like', 'tender:%'),
          eb('p.client_ref', 'not like', 'cn:%'),
          eb('p.client_ref', 'not like', 'dn:%'),
        ]),
      ])
  }
}

function filteredPayments(tx: Tx, ctx: Ctx, q: ListQuery) {
  let qb = paymentQuery(tx, ctx)
  if (ctx.storeIds !== null) {
    const ids = [...ctx.storeIds]
    if (ids.length === 0) return qb.where(sql<boolean>`false`)
    qb = qb.where('p.store_id', 'in', ids)
  }
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    qb = qb.where('p.store_id', '=', q.store_id)
  }
  if (q.direction) qb = qb.where('p.direction', '=', q.direction)
  if (q.party_type) qb = qb.where('p.party_type', '=', q.party_type)
  if (q.party_id) qb = qb.where('p.party_id', '=', q.party_id)
  if (q.method?.length) qb = qb.where('p.method', 'in', q.method)
  if (q.status?.length) qb = qb.where('p.status', 'in', q.status)
  if (q.register_id) qb = qb.where('p.register_id', '=', q.register_id)
  if (q.shift_id) qb = qb.where('p.shift_id', '=', q.shift_id)
  if (q.from) qb = qb.where('p.payment_date', '>=', q.from)
  if (q.to) qb = qb.where('p.payment_date', '<=', q.to)
  const origins = q.origin
  if (origins?.length) qb = qb.where((eb) => eb.or(origins.map((o) => originCondition(eb, o))))
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    qb = qb.where((eb) =>
      eb.or([
        eb('p.number', 'ilike', like),
        eb('p.reference', 'ilike', like),
        eb('c.name', 'ilike', like),
        eb('s.name', 'ilike', like),
      ]),
    )
  }
  return qb
}

export async function listPayments(tx: Tx, ctx: Ctx, q: ListQuery): Promise<PaymentListResponse> {
  const page = parsePage(q)
  const base = filteredPayments(tx, ctx, q)
  const dir = q.sort.direction
  const sortCol = `p.${q.sort.field}` as const
  const rows = await base
    .select(sql<number>`count(*) over()`.as('__total'))
    .orderBy(sortCol, dir)
    .orderBy('p.created_at', dir)
    .orderBy('p.id', dir)
    .limit(page.limit)
    .offset(page.offset)
    .execute()
  let total = rows[0] ? Number(rows[0].__total) : 0
  if (rows.length === 0 && page.offset > 0) {
    const c = await base
      .clearSelect()
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirst()
    total = Number(c?.n ?? 0)
  }
  const summaryRows = await base
    .clearSelect()
    .select([
      'p.method',
      'p.direction',
      sql<number>`count(*)`.as('n'),
      sql<number>`coalesce(sum(p.amount_paise), 0)::bigint`.as('amount'),
    ])
    .where('p.status', '=', 'completed')
    .groupBy(['p.method', 'p.direction'])
    .execute()
  const byMethod = summaryRows
    .map((r) => ({
      method: r.method as PaymentMethod,
      direction: r.direction as PaymentDirection,
      count: Number(r.n),
      amount_paise: Number(r.amount),
    }))
    .sort((a, b) => a.direction.localeCompare(b.direction) || b.amount_paise - a.amount_paise)
  const inPaise = byMethod
    .filter((m) => m.direction === 'in')
    .reduce((s, m) => s + m.amount_paise, 0)
  const outPaise = byMethod
    .filter((m) => m.direction === 'out')
    .reduce((s, m) => s + m.amount_paise, 0)
  return {
    data: rows.map((r) => toPayment(r)),
    page: { limit: page.limit, offset: page.offset, total },
    summary: {
      count: byMethod.reduce((s, m) => s + m.count, 0),
      in_paise: inPaise,
      out_paise: outPaise,
      net_paise: inPaise - outPaise,
      by_method: byMethod,
    },
  }
}

const rupees = (p: number) => paiseToRupeesString(p)

/** CSV of every payment matching the filters (English headers, rupees with 2 decimals). */
export async function paymentsCsv(tx: Tx, ctx: Ctx, q: ListQuery): Promise<string> {
  const rows = await filteredPayments(tx, ctx, q)
    .orderBy(`p.${q.sort.field}`, q.sort.direction)
    .orderBy('p.id', q.sort.direction)
    .limit(PAYMENTS_CSV_MAX_ROWS)
    .execute()
  return toCsv([
    [
      'Date',
      'Number',
      'Direction',
      'Party type',
      'Party',
      'Method',
      'Amount',
      'Allocated',
      'Advance',
      'Reference',
      'Account',
      'Status',
      'Origin',
      'Created by',
    ],
    ...rows.map((r) => {
      const p = toPayment(r)
      return [
        p.payment_date,
        p.number,
        p.direction === 'in' ? 'Receipt' : 'Payment',
        p.party_type,
        p.party_name,
        p.method,
        rupees(p.amount_paise),
        rupees(p.allocated_paise),
        rupees(p.unallocated_paise),
        p.reference,
        p.account_name,
        p.status,
        p.origin,
        p.created_by_name,
      ]
    }),
  ])
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

/** Σ live (completed-payment) allocations per target. */
async function liveAllocations(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  targetType: AllocationTargetType,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .select(['a.target_id', sql<number>`coalesce(sum(a.amount_paise), 0)::bigint`.as('total')])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', targetType)
    .where('a.target_id', 'in', [...ids])
    .where('p.status', '=', 'completed')
    .groupBy('a.target_id')
    .execute()
  return new Map(rows.map((r) => [r.target_id ?? '', Number(r.total)]))
}

interface DocInfo {
  number: string | null
  date: string | null
  total: number
  due: number
}

async function documentInfo(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  type: AllocationTargetType,
  ids: string[],
  partyType: PartyType | null,
): Promise<Map<string, DocInfo>> {
  const out = new Map<string, DocInfo>()
  if (ids.length === 0) return out
  const t = ctx.tenantId
  switch (type) {
    case 'sales_invoice': {
      const rows = await tx
        .selectFrom('sales_invoices')
        .select(['id', 'number', 'invoice_date', 'total_paise', 'due_paise'])
        .where('tenant_id', '=', t)
        .where('id', 'in', ids)
        .execute()
      for (const r of rows)
        out.set(r.id, {
          number: r.number,
          date: r.invoice_date,
          total: r.total_paise,
          due: r.due_paise,
        })
      return out
    }
    case 'purchase_bill': {
      const rows = await tx
        .selectFrom('purchase_bills')
        .select([
          'id',
          'number',
          'supplier_invoice_no',
          'supplier_invoice_date',
          'total_paise',
          'due_paise',
        ])
        .where('tenant_id', '=', t)
        .where('id', 'in', ids)
        .execute()
      for (const r of rows)
        out.set(r.id, {
          number: r.number ?? r.supplier_invoice_no,
          date: r.supplier_invoice_date,
          total: r.total_paise,
          due: r.due_paise,
        })
      return out
    }
    case 'credit_note': {
      const rows = await tx
        .selectFrom('credit_notes')
        .select(['id', 'number', 'note_date', 'total_paise', 'settled_paise'])
        .where('tenant_id', '=', t)
        .where('id', 'in', ids)
        .execute()
      for (const r of rows)
        out.set(r.id, {
          number: r.number,
          date: r.note_date,
          total: r.total_paise,
          due: Math.max(0, r.total_paise - r.settled_paise),
        })
      return out
    }
    case 'debit_note': {
      const rows = await tx
        .selectFrom('debit_notes')
        .select(['id', 'number', 'note_date', 'total_paise'])
        .where('tenant_id', '=', t)
        .where('id', 'in', ids)
        .execute()
      const live = await liveAllocations(tx, ctx, 'debit_note', ids)
      for (const r of rows)
        out.set(r.id, {
          number: r.number,
          date: r.note_date,
          total: r.total_paise,
          due: Math.max(0, r.total_paise - (live.get(r.id) ?? 0)),
        })
      return out
    }
    case 'expense': {
      const rows = await tx
        .selectFrom('expenses')
        .select(['id', 'number', 'expense_date', 'total_paise', 'payment_method'])
        .where('tenant_id', '=', t)
        .where('id', 'in', ids)
        .execute()
      const live = await liveAllocations(tx, ctx, 'expense', ids)
      for (const r of rows)
        out.set(r.id, {
          number: r.number,
          date: r.expense_date,
          total: r.total_paise,
          due:
            r.payment_method === 'credit' ? Math.max(0, r.total_paise - (live.get(r.id) ?? 0)) : 0,
        })
      return out
    }
    case 'opening_balance': {
      const table = partyType === 'supplier' ? 'suppliers' : 'customers'
      const rows = await tx
        .selectFrom(table)
        .select(['id', 'opening_balance_paise'])
        .where('tenant_id', '=', t)
        .where('id', 'in', ids)
        .execute()
      const live = await liveAllocations(tx, ctx, 'opening_balance', ids)
      for (const r of rows) {
        const total = Math.abs(r.opening_balance_paise)
        out.set(r.id, {
          number: null,
          date: null,
          total,
          due: Math.max(0, total - (live.get(r.id) ?? 0)),
        })
      }
      return out
    }
  }
}

async function loadVisiblePayment(tx: Tx, ctx: Ctx, id: string): Promise<PaymentRow> {
  if (!isUuid(id)) throw notFound('payment', id)
  const row = await paymentQuery(tx, ctx).where('p.id', '=', id).executeTakeFirst()
  if (!row || !canAccessStore(ctx, row.store_id)) throw notFound('payment', id)
  return row
}

export async function getPaymentDetail(tx: Tx, ctx: Ctx, id: string): Promise<PaymentDetail> {
  const row = await loadVisiblePayment(tx, ctx, id)
  const allocations = await tx
    .selectFrom('payment_allocations')
    .select(['id', 'target_type', 'target_id', 'amount_paise'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('payment_id', '=', id)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const byType = new Map<AllocationTargetType, string[]>()
  for (const a of allocations) {
    if (!a.target_id) continue
    const type = a.target_type as AllocationTargetType
    byType.set(type, [...(byType.get(type) ?? []), a.target_id])
  }
  const info = new Map<string, DocInfo>()
  for (const [type, ids] of byType) {
    const docs = await documentInfo(
      tx,
      ctx,
      type,
      [...new Set(ids)],
      row.party_type as PartyType | null,
    )
    for (const [docId, d] of docs) info.set(`${type}:${docId}`, d)
  }
  const details: PaymentAllocationDetail[] = allocations.map((a) => {
    const d = a.target_id ? info.get(`${a.target_type}:${a.target_id}`) : undefined
    return {
      id: a.id,
      target_type: a.target_type as AllocationTargetType,
      target_id: a.target_id,
      amount_paise: a.amount_paise,
      document_number: d?.number ?? null,
      document_date: d?.date ?? null,
      document_total_paise: d?.total ?? null,
      document_due_paise: d?.due ?? null,
    }
  })
  const intent = row.payment_intent_id
    ? await tx
        .selectFrom('payment_intents')
        .select(['id', 'reference_code', 'provider', 'payer_vpa', 'utr', 'paid_at'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', row.payment_intent_id)
        .executeTakeFirst()
    : undefined
  const entry = await tx
    .selectFrom('journal_entries')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('source_type', '=', 'payment')
    .where('source_id', '=', id)
    .where('reverses_entry_id', 'is', null)
    .orderBy('created_at')
    .executeTakeFirst()
  const cancelledBy = row.cancelled_by
    ? await tx
        .selectFrom('users')
        .select('full_name')
        .where('id', '=', row.cancelled_by)
        .executeTakeFirst()
    : undefined
  return {
    ...toPayment(row),
    allocations: details,
    intent: intent
      ? {
          id: intent.id,
          reference_code: intent.reference_code,
          provider: intent.provider as PaymentProviderCode,
          payer_vpa: intent.payer_vpa,
          utr: intent.utr,
          paid_at: intent.paid_at ? intent.paid_at.toISOString() : null,
        }
      : null,
    journal_entry_id: entry?.id ?? null,
    cancelled_by_name: cancelledBy?.full_name ?? null,
    updated_at: row.updated_at.toISOString(),
  }
}

// ---------------------------------------------------------------------------------------------
// Open items (FIFO)
// ---------------------------------------------------------------------------------------------

export async function openItemsFor(
  tx: Tx,
  ctx: Ctx,
  q: Pick<OpenItemsQuery, 'party_type' | 'party_id' | 'direction' | 'store_id'>,
): Promise<OpenItemsResponse> {
  if (q.store_id) assertStoreAccess(ctx, q.store_id)
  const t = ctx.tenantId
  const isCustomer = q.party_type === 'customer'
  const party = isCustomer
    ? await tx
        .selectFrom('customers')
        .select(['id', 'name', 'balance_paise', 'opening_balance_paise'])
        .where('tenant_id', '=', t)
        .where('id', '=', q.party_id)
        .executeTakeFirst()
    : await tx
        .selectFrom('suppliers')
        .select(['id', 'name', 'balance_paise', 'opening_balance_paise'])
        .where('tenant_id', '=', t)
        .where('id', '=', q.party_id)
        .executeTakeFirst()
  if (!party) throw notFound(q.party_type, q.party_id)
  const direction: PaymentDirection = q.direction ?? (isCustomer ? 'in' : 'out')
  const today = await tenantToday(tx, ctx)
  const overdue = (dueDate: string | null) =>
    dueDate === null ? null : Math.max(0, diffDays(dueDate, today))
  const items: OpenItem[] = []

  // Opening balance first: customers owe the shop when positive, suppliers are owed.
  const ob = party.opening_balance_paise
  const obDirection: PaymentDirection | null =
    ob === 0 ? null : isCustomer ? (ob > 0 ? 'in' : 'out') : ob > 0 ? 'out' : 'in'
  if (obDirection === direction) {
    const live = await liveAllocations(tx, ctx, 'opening_balance', [party.id])
    const open = Math.abs(ob) - (live.get(party.id) ?? 0)
    if (open > 0) {
      items.push({
        target_type: 'opening_balance',
        target_id: party.id,
        number: null,
        date: null,
        due_date: null,
        total_paise: Math.abs(ob),
        due_paise: open,
        days_overdue: null,
        store_id: null,
      })
    }
  }

  const docs: OpenItem[] = []
  if (isCustomer && direction === 'in') {
    let qb = tx
      .selectFrom('sales_invoices')
      .select(['id', 'number', 'invoice_date', 'due_date', 'total_paise', 'due_paise', 'store_id'])
      .where('tenant_id', '=', t)
      .where('customer_id', '=', party.id)
      .where('status', '=', 'completed')
      .where('doc_type', '<>', 'estimate')
      .where('due_paise', '>', 0)
    if (q.store_id) qb = qb.where('store_id', '=', q.store_id)
    for (const r of await qb.execute()) {
      docs.push({
        target_type: 'sales_invoice',
        target_id: r.id,
        number: r.number,
        date: r.invoice_date,
        due_date: r.due_date,
        total_paise: r.total_paise,
        due_paise: r.due_paise,
        days_overdue: overdue(r.due_date),
        store_id: r.store_id,
      })
    }
  } else if (isCustomer) {
    let qb = tx
      .selectFrom('credit_notes')
      .select(['id', 'number', 'note_date', 'total_paise', 'settled_paise', 'store_id'])
      .where('tenant_id', '=', t)
      .where('customer_id', '=', party.id)
      .where('status', '=', 'completed')
      .where(sql<boolean>`total_paise > settled_paise`)
    if (q.store_id) qb = qb.where('store_id', '=', q.store_id)
    for (const r of await qb.execute()) {
      docs.push({
        target_type: 'credit_note',
        target_id: r.id,
        number: r.number,
        date: r.note_date,
        due_date: null,
        total_paise: r.total_paise,
        due_paise: r.total_paise - r.settled_paise,
        days_overdue: null,
        store_id: r.store_id,
      })
    }
  } else if (direction === 'out') {
    let bills = tx
      .selectFrom('purchase_bills')
      .select([
        'id',
        'number',
        'supplier_invoice_no',
        'supplier_invoice_date',
        'due_date',
        'total_paise',
        'due_paise',
        'store_id',
      ])
      .where('tenant_id', '=', t)
      .where('supplier_id', '=', party.id)
      .where('status', '=', 'posted')
      .where('due_paise', '>', 0)
    if (q.store_id) bills = bills.where('store_id', '=', q.store_id)
    for (const r of await bills.execute()) {
      docs.push({
        target_type: 'purchase_bill',
        target_id: r.id,
        number: r.number ?? r.supplier_invoice_no,
        date: r.supplier_invoice_date,
        due_date: r.due_date,
        total_paise: r.total_paise,
        due_paise: r.due_paise,
        days_overdue: overdue(r.due_date),
        store_id: r.store_id,
      })
    }
    let expenses = tx
      .selectFrom('expenses')
      .select(['id', 'number', 'expense_date', 'total_paise', 'store_id'])
      .where('tenant_id', '=', t)
      .where('supplier_id', '=', party.id)
      .where('status', '=', 'posted')
      .where('payment_method', '=', 'credit')
    if (q.store_id) expenses = expenses.where('store_id', '=', q.store_id)
    const expenseRows = await expenses.execute()
    const live = await liveAllocations(
      tx,
      ctx,
      'expense',
      expenseRows.map((r) => r.id),
    )
    for (const r of expenseRows) {
      const open = r.total_paise - (live.get(r.id) ?? 0)
      if (open <= 0) continue
      docs.push({
        target_type: 'expense',
        target_id: r.id,
        number: r.number,
        date: r.expense_date,
        due_date: null,
        total_paise: r.total_paise,
        due_paise: open,
        days_overdue: null,
        store_id: r.store_id,
      })
    }
  } else {
    let qb = tx
      .selectFrom('debit_notes')
      .select(['id', 'number', 'note_date', 'total_paise', 'store_id'])
      .where('tenant_id', '=', t)
      .where('supplier_id', '=', party.id)
      .where('status', '=', 'completed')
    if (q.store_id) qb = qb.where('store_id', '=', q.store_id)
    const rows = await qb.execute()
    const live = await liveAllocations(
      tx,
      ctx,
      'debit_note',
      rows.map((r) => r.id),
    )
    for (const r of rows) {
      const open = r.total_paise - (live.get(r.id) ?? 0)
      if (open <= 0) continue
      docs.push({
        target_type: 'debit_note',
        target_id: r.id,
        number: r.number,
        date: r.note_date,
        due_date: null,
        total_paise: r.total_paise,
        due_paise: open,
        days_overdue: null,
        store_id: r.store_id,
      })
    }
  }
  docs.sort(
    (a, b) =>
      (a.date ?? '').localeCompare(b.date ?? '') ||
      (a.number ?? '').localeCompare(b.number ?? '') ||
      a.target_id.localeCompare(b.target_id),
  )
  items.push(...docs)
  return {
    party: {
      type: q.party_type,
      id: party.id,
      name: party.name,
      balance_paise: party.balance_paise,
      store_credit_paise: isCustomer ? await storeCreditBalance(tx, ctx, party.id) : null,
    },
    direction,
    items,
    total_due_paise: items.reduce((s, i) => s + i.due_paise, 0),
  }
}

/** FIFO allocations of `amount` over the party's open items (shared allocateFifo). */
export async function fifoAllocations(
  tx: Tx,
  ctx: Ctx,
  input: {
    party_type: PartyType
    party_id: string
    direction: PaymentDirection
    amount_paise: number
  },
) {
  const open = await openItemsFor(tx, ctx, input)
  return allocateFifo(
    open.items.map((i) => ({
      target_type: i.target_type,
      target_id: i.target_id,
      due_paise: i.due_paise,
    })),
    input.amount_paise,
  )
}

// ---------------------------------------------------------------------------------------------
// Create / cancel
// ---------------------------------------------------------------------------------------------

export async function createManualPayment(
  tx: Tx,
  ctx: Ctx,
  body: CreateBody,
): Promise<PaymentDetail> {
  assertPermission(ctx, body.direction === 'in' ? ['payments.collect'] : ['payments.pay'])
  assertStoreAccess(ctx, body.store_id)
  if (body.client_ref && RESERVED_CLIENT_REF.test(body.client_ref)) {
    throw validationError([{ path: 'client_ref', message: 'client_ref_reserved' }])
  }
  const paymentDate = body.payment_date ?? (await tenantToday(tx, ctx))
  const party = { type: body.party_type, id: body.party_id }
  const allocations = body.auto_allocate
    ? (
        await fifoAllocations(tx, ctx, {
          party_type: body.party_type,
          party_id: body.party_id,
          direction: body.direction,
          amount_paise: body.amount_paise,
        })
      ).allocations
    : (body.allocations ?? []).map((a) => ({
        target_type: a.target_type,
        target_id:
          a.target_type === 'opening_balance' ? (a.target_id ?? body.party_id) : a.target_id,
        amount_paise: a.amount_paise,
      }))
  const recorded = await recordPayment(tx, ctx, {
    direction: body.direction,
    store_id: body.store_id,
    register_id: body.register_id ?? null,
    shift_id: body.shift_id ?? null,
    method: body.method,
    amount_paise: body.amount_paise,
    payment_date: paymentDate,
    party,
    reference: body.reference ?? null,
    account_id: body.account_id ?? null,
    allocations,
    notes: body.notes ?? null,
    client_ref: body.client_ref ?? null,
    number: true,
  })
  return getPaymentDetail(tx, ctx, recorded.id)
}

export async function cancelManualPayment(
  tx: Tx,
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<PaymentDetail> {
  const row = await loadVisiblePayment(tx, ctx, id)
  assertPermission(ctx, row.direction === 'in' ? ['payments.collect'] : ['payments.pay'])
  const origin = paymentOriginOf(row.client_ref)
  if (row.status !== 'completed') {
    throw reasonError('CONFLICT', `The payment is already ${row.status}`, 'payment_not_completed', {
      status: row.status,
    })
  }
  if (!isPaymentCancellable({ status: row.status, origin })) {
    throw reasonError(
      'CONFLICT',
      'This payment belongs to a bill or a return: cancel that document instead',
      'payment_not_cancellable',
      { origin },
    )
  }
  await cancelPayment(tx, ctx, { payment_id: id, reason })
  return getPaymentDetail(tx, ctx, id)
}

/** Created-at instant range of a business-date filter (intent lists filter by instant). */
export function dateRangeInstants(
  from: string | undefined,
  to: string | undefined,
  timezone: string,
): { start: Date | null; end: Date | null } {
  return {
    start: from ? instantRangeForDates(from, from, timezone).start : null,
    end: to ? instantRangeForDates(to, to, timezone).end : null,
  }
}
