/**
 * Loyalty points ledger and manual adjustments (feature `loyalty`). Points are written only by
 * core/loyalty.ts (row lock on the customer; never below zero); this file reads the ledger.
 *
 * balance_after is the running Σ points in posting order. Ledger ids are UUID v7 generated after
 * the customer row lock is taken, so id order is posting order even for concurrent writers
 * (created_at is the transaction start time and can be out of order).
 */
import type { LoyaltyKind } from '@kadai/shared'
import type {
  LoyaltyAdjustResult,
  LoyaltyEntry,
  LoyaltyListQuerySchema,
} from '@kadai/shared/api/parties'
import { sql } from 'kysely'
import type { z } from 'zod'
import type { Tx } from '../../db/tenant'
import type { RequestContext } from '../../core/context'
import { notFound } from '../../core/errors'
import { type PageEnvelope, parsePage } from '../../core/http'
import { adjustPoints } from '../../core/loyalty'
import { iso } from './common'

type LoyaltyListQuery = z.output<typeof LoyaltyListQuerySchema>

interface EntryRow {
  id: string
  customer_id: string
  points: number
  kind: string
  ref_type: string | null
  ref_id: string | null
  notes: string | null
  created_by: string | null
  created_at: Date
  balance_after: number
  created_by_name: string | null
  ref_number: string | null
}

function toEntry(r: EntryRow): LoyaltyEntry {
  return {
    id: r.id,
    customer_id: r.customer_id,
    points: Number(r.points),
    kind: r.kind as LoyaltyKind,
    ref_type: r.ref_type,
    ref_id: r.ref_id,
    ref_number: r.ref_number,
    notes: r.notes,
    created_by: r.created_by,
    created_by_name: r.created_by_name,
    created_at: iso(r.created_at),
    // Σ ledger = customers.loyalty_points ≥ 0 at every committed point (core/loyalty).
    balance_after: Math.max(0, Number(r.balance_after)),
  }
}

async function assertCustomer(tx: Tx, ctx: RequestContext, customerId: string): Promise<void> {
  const row = await tx
    .selectFrom('customers')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', customerId)
    .executeTakeFirst()
  if (!row) throw notFound('customer', customerId)
}

async function queryEntries(
  tx: Tx,
  ctx: RequestContext,
  customerId: string,
  opts: { kind?: LoyaltyKind | undefined; entryId?: string; limit: number; offset: number },
): Promise<EntryRow[]> {
  const res = await sql<EntryRow>`
    with entries as (
      select ll.id, ll.customer_id, ll.points, ll.kind, ll.ref_type, ll.ref_id, ll.notes,
             ll.created_by, ll.created_at,
             sum(ll.points) over (order by ll.id rows between unbounded preceding and current row)::bigint
               as balance_after
        from loyalty_ledger ll
       where ll.tenant_id = ${ctx.tenantId} and ll.customer_id = ${customerId}
    )
    select e.*, u.full_name as created_by_name,
           case e.ref_type when 'sales_invoice' then si.number when 'credit_note' then cn.number end
             as ref_number
      from entries e
      left join users u on u.id = e.created_by
      left join sales_invoices si
        on e.ref_type = 'sales_invoice' and si.tenant_id = ${ctx.tenantId} and si.id = e.ref_id
      left join credit_notes cn
        on e.ref_type = 'credit_note' and cn.tenant_id = ${ctx.tenantId} and cn.id = e.ref_id
     where true
       ${opts.kind ? sql`and e.kind = ${opts.kind}` : sql``}
       ${opts.entryId ? sql`and e.id = ${opts.entryId}` : sql``}
     order by e.id desc
     limit ${opts.limit} offset ${opts.offset}`.execute(tx)
  return res.rows
}

/** GET /customers/:id/loyalty — newest first. */
export async function listLoyalty(
  tx: Tx,
  ctx: RequestContext,
  customerId: string,
  query: LoyaltyListQuery,
): Promise<PageEnvelope<LoyaltyEntry>> {
  await assertCustomer(tx, ctx, customerId)
  const page = parsePage(query)
  const rows = await queryEntries(tx, ctx, customerId, { kind: query.kind, ...page })
  let countQuery = tx
    .selectFrom('loyalty_ledger')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('customer_id', '=', customerId)
  if (query.kind) countQuery = countQuery.where('kind', '=', query.kind)
  const total = Number((await countQuery.executeTakeFirst())?.n ?? 0)
  return { data: rows.map(toEntry), page: { ...page, total } }
}

/** POST /customers/:id/loyalty/adjust — audited by core adjustPoints ('customer.loyalty_adjust'). */
export async function adjustLoyalty(
  tx: Tx,
  ctx: RequestContext,
  customerId: string,
  body: { points: number; notes: string },
): Promise<LoyaltyAdjustResult> {
  const posted = await adjustPoints(tx, ctx, {
    customer_id: customerId,
    points: body.points,
    notes: body.notes,
  })
  if (!posted.entry_id) throw notFound('loyalty entry')
  const [entry] = await queryEntries(tx, ctx, customerId, {
    entryId: posted.entry_id,
    limit: 1,
    offset: 0,
  })
  if (!entry) throw notFound('loyalty entry', posted.entry_id)
  return { customer_id: customerId, loyalty_points: posted.balance, entry: toEntry(entry) }
}
