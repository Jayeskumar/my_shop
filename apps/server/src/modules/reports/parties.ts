/**
 * Party outstanding with ageing.
 *
 * Customers: open bills (completed, due_paise > 0) aged by invoice date, plus the unsettled
 * opening balance (aged from its opening entry); unallocated credits = advances / unapplied
 * receipts (payments in − unallocated refunds out) + credit notes not yet settled + a credit
 * opening balance. Suppliers: posted purchase bills aged by due date (no due date = the bill
 * date; not yet due = 'not_due'), the unsettled opening balance; credits = advance payments out −
 * unallocated refunds in + debit notes not yet adjusted or refunded + a debit opening balance.
 *
 * balance_paise is the ledger balance (customers / suppliers.balance_paise, written only by
 * core/ledger); unreconciled = balance − (due − credit) shows manual journals on the party.
 * A store filter limits documents and credits to that store; opening balances are business-wide
 * and only count without a store scope.
 */
import { sql } from 'kysely'
import type { z } from 'zod'
import {
  type AgeingBucket,
  type CustomerOutstandingQuerySchema,
  type CustomerOutstandingResponse,
  type SupplierOutstandingQuerySchema,
  type SupplierOutstandingResponse,
} from '@kadai/shared/api/reports'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  type ReportEnv,
  type ReportOutcome,
  type Sql,
  type StoreScope,
  inStores,
  likePattern,
  localDate,
  num,
  numOrNull,
  orderBy,
  reportMeta,
  reportOutcome,
  runTabular,
} from './common'

type Out<S extends z.ZodType> = z.output<S>

/** Bucket columns from an age expression (days). */
function bucketColumns(age: string): Sql {
  return sql.raw(`
    coalesce(sum(amount) filter (where ${age} <= 0), 0)::bigint as not_due_paise,
    coalesce(sum(amount) filter (where ${age} > 0 and ${age} <= 30), 0)::bigint as bucket_0_30_paise,
    coalesce(sum(amount) filter (where ${age} > 30 and ${age} <= 60), 0)::bigint as bucket_31_60_paise,
    coalesce(sum(amount) filter (where ${age} > 60 and ${age} <= 90), 0)::bigint as bucket_61_90_paise,
    coalesce(sum(amount) filter (where ${age} > 90), 0)::bigint as bucket_90_plus_paise`)
}

/** "an amount in this bucket or older". */
function bucketFilter(bucket: AgeingBucket | undefined): Sql {
  switch (bucket) {
    case undefined:
      return sql`true`
    case '0_30':
      return sql`(bucket_0_30_paise + bucket_31_60_paise + bucket_61_90_paise + bucket_90_plus_paise) > 0`
    case '31_60':
      return sql`(bucket_31_60_paise + bucket_61_90_paise + bucket_90_plus_paise) > 0`
    case '61_90':
      return sql`(bucket_61_90_paise + bucket_90_plus_paise) > 0`
    case '90_plus':
      return sql`bucket_90_plus_paise > 0`
  }
}

/** Opening entry date of a party (first journal line of source 'opening'), else its creation date. */
function openingDate(
  ctx: Ctx,
  env: ReportEnv,
  partyType: 'customer' | 'supplier',
  alias: string,
): Sql {
  return sql`coalesce(
    (select min(jl.entry_date) from journal_lines jl
       join journal_entries je on je.tenant_id = jl.tenant_id and je.id = jl.entry_id
      where jl.tenant_id = ${ctx.tenantId} and jl.party_type = ${partyType}
        and jl.party_id = ${sql.ref(`${alias}.id`)} and je.source_type = 'opening'),
    ${localDate(`${alias}.created_at`, env)})`
}

/** Σ completed allocations to a party's opening balance in one direction. */
function openingAllocated(ctx: Ctx, alias: string, direction: 'in' | 'out'): Sql {
  return sql`coalesce((select sum(a.amount_paise) from payment_allocations a
       join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
      where a.tenant_id = ${ctx.tenantId} and a.target_type = 'opening_balance'
        and a.target_id = ${sql.ref(`${alias}.id`)} and p.status = 'completed'
        and p.direction = ${direction}), 0)::bigint`
}

const OUTSTANDING_TOTALS = sql`select count(*)::bigint as parties,
    coalesce(sum(balance_paise), 0)::bigint as balance_paise,
    coalesce(sum(due_paise), 0)::bigint as due_paise,
    coalesce(sum(not_due_paise), 0)::bigint as not_due_paise,
    coalesce(sum(bucket_0_30_paise), 0)::bigint as bucket_0_30_paise,
    coalesce(sum(bucket_31_60_paise), 0)::bigint as bucket_31_60_paise,
    coalesce(sum(bucket_61_90_paise), 0)::bigint as bucket_61_90_paise,
    coalesce(sum(bucket_90_plus_paise), 0)::bigint as bucket_90_plus_paise,
    coalesce(sum(unallocated_credit_paise), 0)::bigint as unallocated_credit_paise,
    coalesce(sum(overdue_paise), 0)::bigint as overdue_paise,
    bool_or(has_opening) as has_opening
  from rows r`

interface TotalsRaw {
  parties: number
  balance_paise: number
  due_paise: number
  not_due_paise: number
  bucket_0_30_paise: number
  bucket_31_60_paise: number
  bucket_61_90_paise: number
  bucket_90_plus_paise: number
  unallocated_credit_paise: number
  overdue_paise: number
  has_opening: boolean | null
}

function totalsOf(t: TotalsRaw) {
  return {
    parties: num(t.parties),
    balance_paise: num(t.balance_paise),
    due_paise: num(t.due_paise),
    not_due_paise: num(t.not_due_paise),
    bucket_0_30_paise: num(t.bucket_0_30_paise),
    bucket_31_60_paise: num(t.bucket_31_60_paise),
    bucket_61_90_paise: num(t.bucket_61_90_paise),
    bucket_90_plus_paise: num(t.bucket_90_plus_paise),
    unallocated_credit_paise: num(t.unallocated_credit_paise),
    overdue_paise: num(t.overdue_paise),
  }
}

interface OutstandingRaw {
  balance_paise: number
  due_paise: number
  not_due_paise: number
  bucket_0_30_paise: number
  bucket_31_60_paise: number
  bucket_61_90_paise: number
  bucket_90_plus_paise: number
  unallocated_credit_paise: number
  unreconciled_paise: number
  open_documents: number
  oldest_due_date: string | null
  oldest_due_days: number | null
  last_payment_date: string | null
  overdue_paise: number
}

function outstandingOf(r: OutstandingRaw) {
  return {
    balance_paise: num(r.balance_paise),
    due_paise: num(r.due_paise),
    not_due_paise: num(r.not_due_paise),
    bucket_0_30_paise: num(r.bucket_0_30_paise),
    bucket_31_60_paise: num(r.bucket_31_60_paise),
    bucket_61_90_paise: num(r.bucket_61_90_paise),
    bucket_90_plus_paise: num(r.bucket_90_plus_paise),
    unallocated_credit_paise: num(r.unallocated_credit_paise),
    unreconciled_paise: num(r.unreconciled_paise),
    open_documents: num(r.open_documents),
    oldest_due_date: r.oldest_due_date,
    oldest_due_days: numOrNull(r.oldest_due_days),
    last_payment_date: r.last_payment_date,
  }
}

// =============================================================================================
// Customers
// =============================================================================================

interface CustomerRaw extends OutstandingRaw {
  customer_id: string
  name: string
  name_ta: string | null
  phone: string | null
  credit_limit_paise: number | null
  credit_days: number
  whatsapp_opt_in: boolean
}

export async function customerOutstanding(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof CustomerOutstandingQuerySchema>,
): Promise<ReportOutcome<CustomerOutstandingResponse>> {
  const allStores = scope.storeIds === null
  const today = env.today
  const defaultDays = env.settings.credit.default_credit_days
  const search = q.q
    ? sql`(c.name ilike ${likePattern(q.q)} or coalesce(c.name_ta, '') ilike ${likePattern(q.q)}
           or coalesce(c.phone, '') like ${likePattern(q.q.replace(/\D/g, '') || q.q)}
           or coalesce(c.gstin, '') ilike ${likePattern(q.q)})`
    : sql`true`
  const age = `(${sqlDate(today)} - doc_date)`
  const cte = sql`with recursive
    cust as (
      select c.* from customers c where c.tenant_id = ${ctx.tenantId} and ${search}
    ),
    opening as (
      select c.id as party_id, c.opening_balance_paise,
             ${openingDate(ctx, env, 'customer', 'c')} as doc_date,
             ${openingAllocated(ctx, 'c', 'in')} as alloc_in,
             ${openingAllocated(ctx, 'c', 'out')} as alloc_out
        from cust c
       where c.opening_balance_paise <> 0 and ${allStores ? sql`true` : sql`false`}
    ),
    docs as (
      select i.customer_id as party_id, i.invoice_date as doc_date,
             coalesce(i.due_date, i.invoice_date + coalesce(c.credit_days, ${defaultDays})::int) as due_on,
             i.due_paise::bigint as amount, false as is_opening
        from sales_invoices i
        join cust c on c.id = i.customer_id
       where i.tenant_id = ${ctx.tenantId} and i.status = 'completed' and i.doc_type <> 'estimate'
         and i.due_paise > 0 and ${inStores('i.store_id', scope)}
      union all
      select o.party_id, o.doc_date,
             o.doc_date + coalesce(c.credit_days, ${defaultDays})::int,
             (o.opening_balance_paise - o.alloc_in)::bigint, true
        from opening o join cust c on c.id = o.party_id
       where o.opening_balance_paise > 0 and o.opening_balance_paise - o.alloc_in > 0
    ),
    credits as (
      select party_id, sum(amount)::bigint as amount from (
        select p.party_id, p.unallocated_paise as amount
          from payments p
         where p.tenant_id = ${ctx.tenantId} and p.status = 'completed' and p.direction = 'in'
           and p.party_type = 'customer' and p.unallocated_paise > 0
           and ${inStores('p.store_id', scope)}
        union all
        select p.party_id, -p.unallocated_paise
          from payments p
         where p.tenant_id = ${ctx.tenantId} and p.status = 'completed' and p.direction = 'out'
           and p.party_type = 'customer' and p.unallocated_paise > 0
           and ${inStores('p.store_id', scope)}
        union all
        select cn.customer_id, cn.total_paise - cn.settled_paise
          from credit_notes cn
         where cn.tenant_id = ${ctx.tenantId} and cn.status = 'completed'
           and cn.customer_id is not null and cn.total_paise > cn.settled_paise
           and ${inStores('cn.store_id', scope)}
        union all
        select o.party_id, greatest(0, -o.opening_balance_paise - o.alloc_out)
          from opening o where o.opening_balance_paise < 0
      ) x group by party_id
    ),
    lastpay as (
      select p.party_id, max(p.payment_date) as d
        from payments p
       where p.tenant_id = ${ctx.tenantId} and p.status = 'completed' and p.direction = 'in'
         and p.party_type = 'customer' and ${inStores('p.store_id', scope)}
       group by p.party_id
    ),
    agg as (
      select party_id, sum(amount)::bigint as due, ${bucketColumns(`greatest(1, ${age})`)},
             coalesce(sum(amount) filter (where due_on < ${today}::date), 0)::bigint as overdue,
             count(*)::bigint as docs, min(doc_date) as oldest, bool_or(is_opening) as has_opening
        from docs group by party_id
    ),
    base as (
      select c.id as customer_id, c.name, c.name_ta, c.phone, c.credit_limit_paise,
             coalesce(c.credit_days, ${defaultDays})::int as credit_days,
             coalesce(agg.overdue, 0)::bigint as overdue_paise, c.whatsapp_opt_in,
             c.balance_paise, coalesce(agg.due, 0)::bigint as due_paise,
             0::bigint as not_due_paise,
             coalesce(agg.bucket_0_30_paise, 0)::bigint as bucket_0_30_paise,
             coalesce(agg.bucket_31_60_paise, 0)::bigint as bucket_31_60_paise,
             coalesce(agg.bucket_61_90_paise, 0)::bigint as bucket_61_90_paise,
             coalesce(agg.bucket_90_plus_paise, 0)::bigint as bucket_90_plus_paise,
             greatest(0, coalesce(cr.amount, 0))::bigint as unallocated_credit_paise,
             (c.balance_paise - (coalesce(agg.due, 0) - greatest(0, coalesce(cr.amount, 0))))::bigint
               as unreconciled_paise,
             coalesce(agg.docs, 0)::bigint as open_documents,
             agg.oldest as oldest_due_date,
             (${today}::date - agg.oldest)::int as oldest_due_days,
             lp.d as last_payment_date,
             coalesce(agg.has_opening, false) as has_opening
        from cust c
        left join agg on agg.party_id = c.id
        left join credits cr on cr.party_id = c.id
        left join lastpay lp on lp.party_id = c.id
       where (coalesce(agg.due, 0) > 0 or coalesce(cr.amount, 0) > 0
              or (${allStores ? sql`true` : sql`false`} and c.balance_paise <> 0))
    ),
    rows as (
      select * from base
       where ${q.min_due_paise === undefined ? sql`true` : sql`due_paise >= ${q.min_due_paise}`}
         and ${q.overdue_only ? sql`overdue_paise > 0` : sql`true`}
         and ${bucketFilter(q.bucket)}
    )`
  const order = orderBy(
    q.sort,
    {
      due_paise: 'due_paise',
      oldest_due_days: 'oldest_due_days',
      name: 'lower(name)',
      bucket_90_plus_paise: 'bucket_90_plus_paise',
    },
    'customer_id',
  )
  const res = await runTabular<CustomerRaw, TotalsRaw>(
    tx,
    { cte, order, totals: OUTSTANDING_TOTALS },
    q,
  )
  const rows = res.rows.map((r) => ({
    customer_id: r.customer_id,
    name: r.name,
    name_ta: r.name_ta,
    phone: r.phone,
    credit_limit_paise: numOrNull(r.credit_limit_paise),
    credit_days: num(r.credit_days),
    overdue_paise: num(r.overdue_paise),
    whatsapp_opt_in: r.whatsapp_opt_in,
    ...outstandingOf(r),
  }))
  const meta = reportMeta('customer-outstanding', env, scope, {
    as_of: today,
    notes: res.totals.has_opening ? ['includes_opening_balances'] : [],
  })
  return reportOutcome(
    tx,
    ctx,
    'customer-outstanding',
    q,
    { ...res, rows, totals: totalsOf(res.totals) },
    meta,
    { store_id: scope.storeId, overdue_only: q.overdue_only, bucket: q.bucket ?? null },
  )
}

// =============================================================================================
// Suppliers
// =============================================================================================

interface SupplierRaw extends OutstandingRaw {
  supplier_id: string
  name: string
  phone: string | null
  gstin: string | null
  due_next_7_days_paise: number
}

export async function supplierOutstanding(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof SupplierOutstandingQuerySchema>,
): Promise<ReportOutcome<SupplierOutstandingResponse>> {
  const allStores = scope.storeIds === null
  const today = env.today
  const search = q.q
    ? sql`(s.name ilike ${likePattern(q.q)}
           or coalesce(s.phone, '') like ${likePattern(q.q.replace(/\D/g, '') || q.q)}
           or coalesce(s.gstin, '') ilike ${likePattern(q.q)})`
    : sql`true`
  const age = `(${sqlDate(today)} - due_on)`
  const cte = sql`with recursive
    sup as (
      select s.* from suppliers s where s.tenant_id = ${ctx.tenantId} and ${search}
    ),
    opening as (
      select s.id as party_id, s.opening_balance_paise,
             ${openingDate(ctx, env, 'supplier', 's')} as doc_date,
             ${openingAllocated(ctx, 's', 'in')} as alloc_in,
             ${openingAllocated(ctx, 's', 'out')} as alloc_out
        from sup s
       where s.opening_balance_paise <> 0 and ${allStores ? sql`true` : sql`false`}
    ),
    docs as (
      select b.supplier_id as party_id, coalesce(b.due_date, b.supplier_invoice_date) as due_on,
             b.due_paise::bigint as amount, false as is_opening
        from purchase_bills b
        join sup s on s.id = b.supplier_id
       where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.due_paise > 0
         and ${inStores('b.store_id', scope)}
      union all
      select o.party_id, o.doc_date, (o.opening_balance_paise - o.alloc_out)::bigint, true
        from opening o
       where o.opening_balance_paise > 0 and o.opening_balance_paise - o.alloc_out > 0
    ),
    credits as (
      select party_id, sum(amount)::bigint as amount from (
        select p.party_id, p.unallocated_paise as amount
          from payments p
         where p.tenant_id = ${ctx.tenantId} and p.status = 'completed' and p.direction = 'out'
           and p.party_type = 'supplier' and p.unallocated_paise > 0
           and ${inStores('p.store_id', scope)}
        union all
        select p.party_id, -p.unallocated_paise
          from payments p
         where p.tenant_id = ${ctx.tenantId} and p.status = 'completed' and p.direction = 'in'
           and p.party_type = 'supplier' and p.unallocated_paise > 0
           and ${inStores('p.store_id', scope)}
        union all
        -- debit notes: total − refunds received (allocations) …
        select dn.supplier_id,
               dn.total_paise - coalesce((select sum(a.amount_paise) from payment_allocations a
                   join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
                  where a.tenant_id = dn.tenant_id and a.target_type = 'debit_note'
                    and a.target_id = dn.id and p.status = 'completed'), 0)
          from debit_notes dn
         where dn.tenant_id = ${ctx.tenantId} and dn.status = 'completed'
           and ${inStores('dn.store_id', scope)}
        union all
        -- … − what was adjusted against bills (purchase_bills.returned_paise)
        select b.supplier_id, -b.returned_paise
          from purchase_bills b
         where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.returned_paise > 0
           and ${inStores('b.store_id', scope)}
        union all
        select o.party_id, greatest(0, -o.opening_balance_paise - o.alloc_in)
          from opening o where o.opening_balance_paise < 0
      ) x group by party_id
    ),
    lastpay as (
      select p.party_id, max(p.payment_date) as d
        from payments p
       where p.tenant_id = ${ctx.tenantId} and p.status = 'completed' and p.direction = 'out'
         and p.party_type = 'supplier' and ${inStores('p.store_id', scope)}
       group by p.party_id
    ),
    agg as (
      select party_id, sum(amount)::bigint as due, ${bucketColumns(age)},
             coalesce(sum(amount) filter (where due_on < ${today}::date), 0)::bigint as overdue,
             coalesce(sum(amount) filter (where due_on >= ${today}::date
                        and due_on <= ${today}::date + 7), 0)::bigint as next7,
             count(*)::bigint as docs, min(due_on) as oldest, bool_or(is_opening) as has_opening
        from docs group by party_id
    ),
    base as (
      select s.id as supplier_id, s.name, s.phone, s.gstin,
             coalesce(agg.overdue, 0)::bigint as overdue_paise,
             coalesce(agg.next7, 0)::bigint as due_next_7_days_paise,
             s.balance_paise, coalesce(agg.due, 0)::bigint as due_paise,
             coalesce(agg.not_due_paise, 0)::bigint as not_due_paise,
             coalesce(agg.bucket_0_30_paise, 0)::bigint as bucket_0_30_paise,
             coalesce(agg.bucket_31_60_paise, 0)::bigint as bucket_31_60_paise,
             coalesce(agg.bucket_61_90_paise, 0)::bigint as bucket_61_90_paise,
             coalesce(agg.bucket_90_plus_paise, 0)::bigint as bucket_90_plus_paise,
             greatest(0, coalesce(cr.amount, 0))::bigint as unallocated_credit_paise,
             (s.balance_paise - (coalesce(agg.due, 0) - greatest(0, coalesce(cr.amount, 0))))::bigint
               as unreconciled_paise,
             coalesce(agg.docs, 0)::bigint as open_documents,
             agg.oldest as oldest_due_date,
             (${today}::date - agg.oldest)::int as oldest_due_days,
             lp.d as last_payment_date,
             coalesce(agg.has_opening, false) as has_opening
        from sup s
        left join agg on agg.party_id = s.id
        left join credits cr on cr.party_id = s.id
        left join lastpay lp on lp.party_id = s.id
       where (coalesce(agg.due, 0) > 0 or coalesce(cr.amount, 0) > 0
              or (${allStores ? sql`true` : sql`false`} and s.balance_paise <> 0))
    ),
    rows as (
      select * from base
       where ${q.min_due_paise === undefined ? sql`true` : sql`due_paise >= ${q.min_due_paise}`}
         and ${q.overdue_only ? sql`overdue_paise > 0` : sql`true`}
         and ${bucketFilter(q.bucket)}
    )`
  const order = orderBy(
    q.sort,
    {
      due_paise: 'due_paise',
      oldest_due_days: 'oldest_due_days',
      name: 'lower(name)',
      not_due_paise: 'not_due_paise',
    },
    'supplier_id',
  )
  const res = await runTabular<SupplierRaw, TotalsRaw>(
    tx,
    { cte, order, totals: OUTSTANDING_TOTALS },
    q,
  )
  const rows = res.rows.map((r) => ({
    supplier_id: r.supplier_id,
    name: r.name,
    phone: r.phone,
    gstin: r.gstin,
    overdue_paise: num(r.overdue_paise),
    due_next_7_days_paise: num(r.due_next_7_days_paise),
    ...outstandingOf(r),
  }))
  const meta = reportMeta('supplier-outstanding', env, scope, {
    as_of: today,
    notes: res.totals.has_opening ? ['includes_opening_balances'] : [],
  })
  return reportOutcome(
    tx,
    ctx,
    'supplier-outstanding',
    q,
    { ...res, rows, totals: totalsOf(res.totals) },
    meta,
    { store_id: scope.storeId, overdue_only: q.overdue_only, bucket: q.bucket ?? null },
  )
}

/** A validated business date as a SQL date literal for sql.raw fragments. */
function sqlDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid business date ${date}`)
  return `'${date}'::date`
}
