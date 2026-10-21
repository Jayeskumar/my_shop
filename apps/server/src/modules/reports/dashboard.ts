/**
 * GET /reports/dashboard — the owner's home screen: the day vs the day before, a 30-day trend,
 * the day's payment mix, top items, dues to collect and to pay, stock alerts, open shifts and
 * UPI money waiting for reconciliation. Every figure is one SQL aggregate.
 */
import { sql } from 'kysely'
import type { z } from 'zod'
import { addDays, diffDays } from '@kadai/shared'
import {
  DASHBOARD_TOP_DEBTORS,
  DASHBOARD_TOP_ITEMS,
  DASHBOARD_TREND_DAYS,
  type Dashboard,
  type DashboardDay,
  type DashboardQuerySchema,
  type DashboardTopItem,
  PAYMENT_MIX_KEYS,
  type PaymentMixKey,
  avgBillPaise,
  changeBp,
  marginBp,
  shareBp,
} from '@kadai/shared/api/reports'
import { getEntitlements } from '../../core/entitlements'
import type { Tx } from '../../db/tenant'
import { type Ctx, type ReportEnv, type StoreScope, inStores, iso, num } from './common'
import { creditNoteWhere, invoiceWhere, salesFactsCte } from './facts'

interface DayRaw {
  date: string
  bills: number
  sales_paise: number
  taxable_paise: number
  cost_paise: number
  returns_paise: number
  returns_taxable_paise: number
  returns_cost_paise: number
}

function dayOf(r: DayRaw | undefined, date: string): DashboardDay {
  const bills = num(r?.bills)
  const sales = num(r?.sales_paise)
  const returns = num(r?.returns_paise)
  const netTaxable = num(r?.taxable_paise) - num(r?.returns_taxable_paise)
  const cost = num(r?.cost_paise) - num(r?.returns_cost_paise)
  const gp = netTaxable - cost
  return {
    date,
    net_sales_paise: sales - returns,
    sales_paise: sales,
    returns_paise: returns,
    bills,
    avg_bill_paise: avgBillPaise(sales, bills),
    net_taxable_paise: netTaxable,
    gross_profit_paise: gp,
    margin_bp: marginBp(gp, netTaxable),
  }
}

async function dailySeries(
  tx: Tx,
  ctx: Ctx,
  scope: StoreScope,
  from: string,
  to: string,
): Promise<Map<string, DayRaw>> {
  const f = { from, to, scope }
  const res = await sql<DayRaw>`
    with s as (
      select i.invoice_date as date, count(*)::bigint as bills, sum(i.total_paise)::bigint as sales_paise,
             sum(i.taxable_paise)::bigint as taxable_paise, sum(i.cost_paise)::bigint as cost_paise
        from sales_invoices i where ${invoiceWhere(ctx, f)} group by i.invoice_date
    ),
    r as (
      select c.note_date as date, sum(c.total_paise)::bigint as returns_paise,
             sum(c.taxable_paise)::bigint as returns_taxable_paise,
             sum(c.cost_paise)::bigint as returns_cost_paise
        from credit_notes c where ${creditNoteWhere(ctx, f)} group by c.note_date
    )
    select coalesce(s.date, r.date) as date,
           coalesce(s.bills, 0)::bigint as bills, coalesce(s.sales_paise, 0)::bigint as sales_paise,
           coalesce(s.taxable_paise, 0)::bigint as taxable_paise,
           coalesce(s.cost_paise, 0)::bigint as cost_paise,
           coalesce(r.returns_paise, 0)::bigint as returns_paise,
           coalesce(r.returns_taxable_paise, 0)::bigint as returns_taxable_paise,
           coalesce(r.returns_cost_paise, 0)::bigint as returns_cost_paise
      from s full join r on r.date = s.date`.execute(tx)
  return new Map(res.rows.map((r) => [r.date, r]))
}

async function paymentMix(
  tx: Tx,
  ctx: Ctx,
  scope: StoreScope,
  date: string,
  salesPaise: number,
): Promise<Dashboard['payment_mix']> {
  const res = await sql<{ key: PaymentMixKey; amount_paise: number; count: number }>`
    with inv as (
      select i.id, i.total_paise from sales_invoices i
       where ${invoiceWhere(ctx, { from: date, to: date, scope })}
    ),
    al as (
      select a.target_id as invoice_id,
             case when p.method in ('cash', 'upi', 'card') then p.method else 'other' end as key,
             sum(a.amount_paise)::bigint as amount
        from payment_allocations a
        join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
       where a.tenant_id = ${ctx.tenantId} and a.target_type = 'sales_invoice'
         and p.status = 'completed' and p.direction = 'in'
         and a.target_id in (select id from inv)
       group by 1, 2
    ),
    paid as (select invoice_id, sum(amount)::bigint as amount from al group by invoice_id)
    select key, sum(amount)::bigint as amount_paise, count(distinct invoice_id)::bigint as count
      from al group by key
    union all
    select 'credit', coalesce(sum(inv.total_paise - coalesce(paid.amount, 0)), 0)::bigint,
           count(*)::bigint
      from inv left join paid on paid.invoice_id = inv.id
     where inv.total_paise > coalesce(paid.amount, 0)`.execute(tx)
  const byKey = new Map(res.rows.map((r) => [r.key, r]))
  return PAYMENT_MIX_KEYS.map((key) => {
    const r = byKey.get(key)
    const amount = num(r?.amount_paise)
    return {
      key,
      amount_paise: amount,
      count: num(r?.count),
      share_bp: Math.min(10_000, Math.max(0, shareBp(amount, salesPaise))),
    }
  })
}

async function topItems(
  tx: Tx,
  ctx: Ctx,
  scope: StoreScope,
  from: string,
  to: string,
): Promise<DashboardTopItem[]> {
  const res = await sql<{
    product_id: string | null
    name: string
    name_ta: string | null
    unit: string
    pack_size: number
    qty_milli: number
    net_sales_paise: number
  }>`with recursive ${salesFactsCte(ctx, { from, to, scope })}
    select min(ff.product_id::text)::uuid as product_id, min(ff.name) as name,
           min(ff.name_ta) as name_ta, min(ff.unit) as unit, min(ff.pack_size) as pack_size,
           sum(ff.qty_milli + ff.free_qty_milli - ff.returned_qty_milli)::bigint as qty_milli,
           sum(ff.sales_paise - ff.returns_paise)::bigint as net_sales_paise
      from ff
     group by coalesce(ff.product_id::text, 'adhoc:' || ff.line_name)
    having sum(ff.sales_paise) > 0
     order by net_sales_paise desc, name asc
     limit ${DASHBOARD_TOP_ITEMS}`.execute(tx)
  return res.rows.map((r) => ({
    product_id: r.product_id,
    name: r.name,
    name_ta: r.name_ta,
    unit: r.unit,
    pack_size: num(r.pack_size) || 1,
    qty_milli: num(r.qty_milli),
    net_sales_paise: num(r.net_sales_paise),
  }))
}

async function receivables(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  date: string,
): Promise<Dashboard['receivables']> {
  const creditDays = env.settings.credit.default_credit_days
  const overdue = await sql<{ overdue_paise: number }>`
    select coalesce(sum(i.due_paise), 0)::bigint as overdue_paise
      from sales_invoices i
      left join customers c on c.tenant_id = i.tenant_id and c.id = i.customer_id
     where i.tenant_id = ${ctx.tenantId} and i.status = 'completed' and i.doc_type <> 'estimate' and i.due_paise > 0
       and ${inStores('i.store_id', scope)}
       and coalesce(i.due_date, i.invoice_date + coalesce(c.credit_days, ${creditDays})::int)
           < ${date}::date`.execute(tx)
  // Whole business: customer ledger balances; a store scope: the store's open bills.
  const allStores = scope.storeIds === null
  const head = allStores
    ? await sql<{ total_paise: number; customers: number }>`
        select coalesce(sum(balance_paise), 0)::bigint as total_paise, count(*)::bigint as customers
          from customers where tenant_id = ${ctx.tenantId} and balance_paise > 0`.execute(tx)
    : await sql<{ total_paise: number; customers: number }>`
        select coalesce(sum(i.due_paise), 0)::bigint as total_paise,
               count(distinct i.customer_id)::bigint as customers
          from sales_invoices i
         where i.tenant_id = ${ctx.tenantId} and i.status = 'completed' and i.doc_type <> 'estimate' and i.due_paise > 0
           and i.customer_id is not null and ${inStores('i.store_id', scope)}`.execute(tx)
  const oldest = sql`(select min(i.invoice_date) from sales_invoices i
      where i.tenant_id = c.tenant_id and i.customer_id = c.id and i.status = 'completed'
        and i.doc_type <> 'estimate' and i.due_paise > 0 and ${inStores('i.store_id', scope)})`
  const top = allStores
    ? await sql<DebtorRaw>`
        select c.id as customer_id, c.name, c.name_ta, c.phone, c.balance_paise, c.whatsapp_opt_in,
               ${oldest} as oldest_due_date
          from customers c
         where c.tenant_id = ${ctx.tenantId} and c.balance_paise > 0
         order by c.balance_paise desc, c.name, c.id
         limit ${DASHBOARD_TOP_DEBTORS}`.execute(tx)
    : await sql<DebtorRaw>`
        select c.id as customer_id, c.name, c.name_ta, c.phone, d.due as balance_paise,
               c.whatsapp_opt_in, ${oldest} as oldest_due_date
          from (select i.customer_id, sum(i.due_paise)::bigint as due
                  from sales_invoices i
                 where i.tenant_id = ${ctx.tenantId} and i.status = 'completed' and i.doc_type <> 'estimate' and i.due_paise > 0
                   and i.customer_id is not null and ${inStores('i.store_id', scope)}
                 group by i.customer_id) d
          join customers c on c.tenant_id = ${ctx.tenantId} and c.id = d.customer_id
         order by d.due desc, c.name, c.id
         limit ${DASHBOARD_TOP_DEBTORS}`.execute(tx)
  return {
    total_paise: num(head.rows[0]?.total_paise),
    customers_with_due: num(head.rows[0]?.customers),
    overdue_paise: num(overdue.rows[0]?.overdue_paise),
    top_debtors: top.rows.map((r) => ({
      customer_id: r.customer_id,
      name: r.name,
      name_ta: r.name_ta,
      phone: r.phone,
      balance_paise: num(r.balance_paise),
      oldest_due_days: r.oldest_due_date ? Math.max(0, diffDays(r.oldest_due_date, date)) : null,
      whatsapp_opt_in: r.whatsapp_opt_in,
    })),
  }
}

interface DebtorRaw {
  customer_id: string
  name: string
  name_ta: string | null
  phone: string | null
  balance_paise: number
  whatsapp_opt_in: boolean
  oldest_due_date: string | null
}

async function payables(
  tx: Tx,
  ctx: Ctx,
  scope: StoreScope,
  date: string,
): Promise<Dashboard['payables']> {
  const bills = await sql<{ overdue: number; next7: number; total: number; suppliers: number }>`
    select coalesce(sum(b.due_paise) filter (
             where coalesce(b.due_date, b.supplier_invoice_date) < ${date}::date), 0)::bigint as overdue,
           coalesce(sum(b.due_paise) filter (
             where coalesce(b.due_date, b.supplier_invoice_date)
                   between ${date}::date and ${addDays(date, 7)}::date), 0)::bigint as next7,
           coalesce(sum(b.due_paise), 0)::bigint as total,
           count(distinct b.supplier_id)::bigint as suppliers
      from purchase_bills b
     where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.due_paise > 0
       and ${inStores('b.store_id', scope)}`.execute(tx)
  const b = bills.rows[0]
  if (scope.storeIds !== null) {
    return {
      total_paise: num(b?.total),
      suppliers_with_due: num(b?.suppliers),
      overdue_paise: num(b?.overdue),
      due_next_7_days_paise: num(b?.next7),
    }
  }
  const head = await sql<{ total_paise: number; suppliers: number }>`
    select coalesce(sum(balance_paise), 0)::bigint as total_paise, count(*)::bigint as suppliers
      from suppliers where tenant_id = ${ctx.tenantId} and balance_paise > 0`.execute(tx)
  return {
    total_paise: num(head.rows[0]?.total_paise),
    suppliers_with_due: num(head.rows[0]?.suppliers),
    overdue_paise: num(b?.overdue),
    due_next_7_days_paise: num(b?.next7),
  }
}

async function stockAlerts(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  date: string,
): Promise<Dashboard['stock']> {
  const warn = env.settings.inventory.expiry_warning_days
  const counts = await sql<{ low: number; out: number }>`
    with agg as (
      select l.product_id, sum(l.qty_milli)::bigint as qty_milli, count(*)::bigint as row_count
        from stock_levels l
       where l.tenant_id = ${ctx.tenantId} and ${inStores('l.store_id', scope)}
       group by l.product_id
    ),
    items as (
      select coalesce(a.qty_milli, 0)::bigint as qty_milli, p.reorder_level_milli,
             coalesce(a.row_count, 0)::bigint as row_count
        from products p left join agg a on a.product_id = p.id
       where p.tenant_id = ${ctx.tenantId} and p.is_active and p.track_inventory
         and p.kind <> 'variant_parent'
    )
    select count(*) filter (where qty_milli > 0 and reorder_level_milli is not null
                              and qty_milli <= reorder_level_milli)::bigint as low,
           count(*) filter (where qty_milli <= 0
                              and (row_count > 0 or reorder_level_milli is not null))::bigint as out
      from items`.execute(tx)
  const expiry = await sql<{
    expiring: number
    expired: number
    expiring_value: number
    expired_value: number
  }>`
    with bagg as (
      select l.batch_id, sum(l.qty_milli)::bigint as qty_milli,
             sum(round(l.avg_cost_paise::numeric * l.qty_milli / (p.pack_size * 1000)))::bigint
               as value_cost_paise
        from stock_levels l
        join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       where l.tenant_id = ${ctx.tenantId} and l.batch_id is not null
         and ${inStores('l.store_id', scope)}
       group by l.batch_id
      having sum(l.qty_milli) > 0
    )
    select count(*) filter (where b.expiry_date >= ${date}::date
                              and b.expiry_date <= ${addDays(date, warn)}::date)::bigint as expiring,
           count(*) filter (where b.expiry_date < ${date}::date)::bigint as expired,
           coalesce(sum(a.value_cost_paise) filter (where b.expiry_date >= ${date}::date
                              and b.expiry_date <= ${addDays(date, warn)}::date), 0)::bigint
             as expiring_value,
           coalesce(sum(a.value_cost_paise) filter (where b.expiry_date < ${date}::date), 0)::bigint
             as expired_value
      from bagg a join batches b on b.tenant_id = ${ctx.tenantId} and b.id = a.batch_id
     where b.expiry_date is not null`.execute(tx)
  const c = counts.rows[0]
  const e = expiry.rows[0]
  return {
    low_stock: num(c?.low),
    out_of_stock: num(c?.out),
    expiring: num(e?.expiring),
    expired: num(e?.expired),
    expiring_value_paise: num(e?.expiring_value),
    expired_value_paise: num(e?.expired_value),
    expiry_warning_days: warn,
  }
}

async function openShifts(tx: Tx, ctx: Ctx, scope: StoreScope): Promise<Dashboard['shifts']> {
  const ent = await getEntitlements(ctx)
  if (!ent.features.has('shifts')) return null
  const res = await sql<{
    shift_id: string
    register_id: string
    register_code: string
    opened_by_name: string | null
    opened_at: Date
  }>`
    select s.id as shift_id, s.register_id, rg.code as register_code,
           u.full_name as opened_by_name, s.opened_at
      from register_shifts s
      join registers rg on rg.tenant_id = s.tenant_id and rg.id = s.register_id
      left join users u on u.id = s.opened_by
     where s.tenant_id = ${ctx.tenantId} and s.status = 'open' and ${inStores('s.store_id', scope)}
     order by s.opened_at, rg.code`.execute(tx)
  return {
    open_count: res.rows.length,
    open: res.rows.map((r) => ({ ...r, opened_at: iso(r.opened_at) })),
  }
}

async function upi(tx: Tx, ctx: Ctx, scope: StoreScope, now: Date): Promise<Dashboard['upi']> {
  const res = await sql<{
    pending: number
    pending_paise: number
    unapplied: number
    unapplied_paise: number
  }>`
    select count(*) filter (where status in ('created', 'pending')
                              and (expires_at is null or expires_at > ${now}))::bigint as pending,
           coalesce(sum(amount_paise) filter (where status in ('created', 'pending')
                              and (expires_at is null or expires_at > ${now})), 0)::bigint as pending_paise,
           count(*) filter (where status = 'paid' and payment_id is null)::bigint as unapplied,
           coalesce(sum(coalesce(paid_amount_paise, amount_paise))
                      filter (where status = 'paid' and payment_id is null), 0)::bigint as unapplied_paise
      from payment_intents
     where tenant_id = ${ctx.tenantId} and ${inStores('store_id', scope)}`.execute(tx)
  const r = res.rows[0]
  return {
    pending_intents: num(r?.pending),
    pending_paise: num(r?.pending_paise),
    unapplied_count: num(r?.unapplied),
    unapplied_paise: num(r?.unapplied_paise),
  }
}

export async function dashboard(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: z.output<typeof DashboardQuerySchema>,
): Promise<Dashboard> {
  const date = q.date ?? env.today
  const trendFrom = addDays(date, -(DASHBOARD_TREND_DAYS - 1))
  const yesterdayDate = addDays(date, -1)
  const series = await dailySeries(tx, ctx, scope, trendFrom, date)
  const today = dayOf(series.get(date), date)
  const yesterday = dayOf(series.get(yesterdayDate), yesterdayDate)
  const trend: Dashboard['trend'] = []
  for (let d = trendFrom; d <= date; d = addDays(d, 1)) {
    const day = dayOf(series.get(d), d)
    trend.push({
      date: d,
      net_sales_paise: day.net_sales_paise,
      gross_profit_paise: day.gross_profit_paise,
      bills: day.bills,
    })
  }
  const marginPoints =
    today.margin_bp !== null && yesterday.margin_bp !== null
      ? today.margin_bp - yesterday.margin_bp
      : null
  return {
    date,
    store_id: scope.storeId,
    generated_at: env.generatedAt.toISOString(),
    today,
    yesterday,
    change: {
      net_sales_bp: changeBp(today.net_sales_paise, yesterday.net_sales_paise),
      bills_bp: changeBp(today.bills, yesterday.bills),
      avg_bill_bp: changeBp(today.avg_bill_paise, yesterday.avg_bill_paise),
      gross_profit_bp: changeBp(today.gross_profit_paise, yesterday.gross_profit_paise),
      margin_points_bp: marginPoints,
    },
    trend,
    payment_mix: await paymentMix(tx, ctx, scope, date, today.sales_paise),
    top_items: {
      today: await topItems(tx, ctx, scope, date, date),
      last_7_days: await topItems(tx, ctx, scope, addDays(date, -6), date),
    },
    receivables: await receivables(tx, ctx, env, scope, date),
    payables: await payables(tx, ctx, scope, date),
    stock: await stockAlerts(tx, ctx, env, scope, date),
    shifts: await openShifts(tx, ctx, scope),
    upi: await upi(tx, ctx, scope, env.generatedAt),
  }
}
