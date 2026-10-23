/**
 * Sales reports: sales summary, item / category / brand sales, profit, discounts, cancellations
 * and the shift summary. SQL-aggregated over the fact CTEs of facts.ts; only completed documents
 * count and credit notes reduce sales by note date.
 */
import { sql } from 'kysely'
import type { z } from 'zod'
import { type PaymentMethod, PaymentMethodSchema } from '@kadai/shared'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import {
  type BrandSalesQuerySchema,
  type BrandSalesResponse,
  type CancellationsQuerySchema,
  type CancellationsResponse,
  type CategorySalesQuerySchema,
  type CategorySalesResponse,
  type DiscountsQuerySchema,
  type DiscountsResponse,
  type ItemSalesQuerySchema,
  type ItemSalesResponse,
  type ProfitQuerySchema,
  type ProfitResponse,
  type SalesSummaryGroupBy,
  type SalesSummaryQuerySchema,
  type SalesSummaryResponse,
  type ShiftsReportQuerySchema,
  type ShiftsReportResponse,
  avgBillPaise,
  marginBp,
  shareBp,
} from '@kadai/shared/api/reports'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  type ReportEnv,
  type ReportOutcome,
  type Sql,
  type StoreScope,
  categoryTreeCte,
  eqOpt,
  inStores,
  instantRange,
  iso,
  isoOrNull,
  num,
  numOrNull,
  orderBy,
  reportMeta,
  reportOutcome,
  runTabular,
} from './common'
import { SALES_METRICS_SQL, creditNoteWhere, invoiceWhere, marginSql, salesFactsCte } from './facts'

type Out<S extends z.ZodType> = z.output<S>

/** Raw sales metrics as selected by SALES_METRICS_SQL. */
interface RawMetrics {
  bills: number
  gross_paise: number
  discount_paise: number
  taxable_paise: number
  tax_paise: number
  sales_paise: number
  returns_count: number
  returns_paise: number
  returns_taxable_paise: number
  net_sales_paise: number
  net_taxable_paise: number
  cost_paise: number
  gross_profit_paise: number
  any_zero_cost?: boolean | null
}

function metrics(r: RawMetrics) {
  return {
    bills: num(r.bills),
    gross_paise: num(r.gross_paise),
    discount_paise: num(r.discount_paise),
    taxable_paise: num(r.taxable_paise),
    tax_paise: num(r.tax_paise),
    sales_paise: num(r.sales_paise),
    returns_count: num(r.returns_count),
    returns_paise: num(r.returns_paise),
    returns_taxable_paise: num(r.returns_taxable_paise),
    net_sales_paise: num(r.net_sales_paise),
    net_taxable_paise: num(r.net_taxable_paise),
    cost_paise: num(r.cost_paise),
    gross_profit_paise: num(r.gross_profit_paise),
    margin_bp: marginBp(num(r.gross_profit_paise), num(r.net_taxable_paise)),
  }
}

const UNCATEGORISED = { en: 'Uncategorised', ta: 'வகைப்படுத்தப்படாதவை' }
const NO_BRAND = { en: 'No brand', ta: 'பிராண்ட் இல்லாதவை' }
const ADHOC = { en: 'Items not in the catalogue', ta: 'பட்டியலில் இல்லாத பொருட்கள்' }
const BACK_OFFICE = { en: 'Back office', ta: 'அலுவலக பில்லிங்' }
const UNKNOWN_USER = { en: 'Unknown', ta: 'தெரியவில்லை' }

// =============================================================================================
// Sales summary
// =============================================================================================

function summaryGroup(
  groupBy: SalesSummaryGroupBy,
  kind: 'inv' | 'cn' | 'pay',
  env: ReportEnv,
): Sql {
  const a = kind === 'inv' ? 'i' : kind === 'cn' ? 'c' : 'p'
  const dateCol =
    kind === 'inv' ? 'i.invoice_date' : kind === 'cn' ? 'c.note_date' : 'p.payment_date'
  const instCol = kind === 'inv' ? 'i.invoice_at' : kind === 'cn' ? 'c.created_at' : 'p.paid_at'
  switch (groupBy) {
    case 'day':
      return sql`to_char(${sql.ref(dateCol)}, 'YYYY-MM-DD')`
    case 'month':
      return sql`to_char(${sql.ref(dateCol)}, 'YYYY-MM')`
    case 'hour':
      return sql`to_char(${sql.ref(instCol)} at time zone ${env.timezone}, 'HH24')`
    case 'store':
      return sql`${sql.ref(`${a}.store_id`)}::text`
    case 'register':
      return sql`coalesce(${sql.ref(`${a}.register_id`)}::text, 'none')`
    case 'user':
      return sql`coalesce(${sql.ref(`${a}.created_by`)}::text, 'none')`
    case 'payment_method':
      return kind === 'pay' ? sql`p.method` : sql`null::text`
  }
}

function zeroFillKeys(groupBy: SalesSummaryGroupBy, from: string, to: string): Sql {
  switch (groupBy) {
    case 'day':
      return sql`union select to_char(d, 'YYYY-MM-DD')
        from generate_series(${from}::date, ${to}::date, interval '1 day') d`
    case 'month':
      return sql`union select to_char(d, 'YYYY-MM')
        from generate_series(date_trunc('month', ${from}::date), ${to}::date, interval '1 month') d`
    case 'hour':
      return sql`union select lpad(h::text, 2, '0') from generate_series(0, 23) h`
    default:
      return sql``
  }
}

function summaryLabels(ctx: Ctx, groupBy: SalesSummaryGroupBy): { select: Sql; join: Sql } {
  switch (groupBy) {
    case 'store':
      return {
        select: sql`coalesce(st.name, k.g) as group_label, st.name_ta as group_label_ta`,
        join: sql`left join stores st on st.tenant_id = ${ctx.tenantId} and st.id::text = k.g`,
      }
    case 'register':
      return {
        select: sql`case when k.g = 'none' then ${BACK_OFFICE.en}
                         else coalesce(rs.code || '-' || rg.code || ' · ' || rg.name, k.g) end as group_label,
                    case when k.g = 'none' then ${BACK_OFFICE.ta} end as group_label_ta`,
        join: sql`left join registers rg on rg.tenant_id = ${ctx.tenantId} and rg.id::text = k.g
                  left join stores rs on rs.tenant_id = ${ctx.tenantId} and rs.id = rg.store_id`,
      }
    case 'user':
      return {
        select: sql`case when k.g = 'none' then ${UNKNOWN_USER.en}
                         else coalesce(u.full_name, k.g) end as group_label,
                    case when k.g = 'none' then ${UNKNOWN_USER.ta} end as group_label_ta`,
        join: sql`left join users u on u.id::text = k.g`,
      }
    case 'hour':
      return { select: sql`k.g || ':00' as group_label, null::text as group_label_ta`, join: sql`` }
    default:
      return { select: sql`k.g as group_label, null::text as group_label_ta`, join: sql`` }
  }
}

interface SummaryRaw extends RawMetrics {
  group_key: string
  group_label: string
  group_label_ta: string | null
  round_off_paise: number
  payments_count: number
  collected_paise: number
  refunded_paise: number
  net_collected_paise: number
}

export async function salesSummary(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof SalesSummaryQuerySchema>,
): Promise<ReportOutcome<SalesSummaryResponse>> {
  const filter = {
    from: q.from,
    to: q.to,
    scope,
    userId: q.user_id,
    registerId: q.register_id,
    channel: q.channel,
  }
  const gb = q.group_by
  const byMethod = gb === 'payment_method'
  const labels = summaryLabels(ctx, gb)
  const channelPay = q.channel
    ? sql`exists (select 1 from payment_allocations a
                    join sales_invoices si on si.tenant_id = a.tenant_id and si.id = a.target_id
                   where a.tenant_id = p.tenant_id and a.payment_id = p.id
                     and a.target_type = 'sales_invoice' and si.channel = ${q.channel})`
    : sql`true`
  const cte = sql`with recursive
    inv as (select ${summaryGroup(gb, 'inv', env)} as g, i.* from sales_invoices i
             where ${invoiceWhere(ctx, filter)}),
    cn as (select ${summaryGroup(gb, 'cn', env)} as g, c.* from credit_notes c
            where ${creditNoteWhere(ctx, filter)}),
    pay as (
      select ${summaryGroup(gb, 'pay', env)} as g, p.direction, p.amount_paise
        from payments p
       where p.tenant_id = ${ctx.tenantId} and p.status = 'completed'
         and p.method <> 'store_credit'
         and (p.party_type is null or p.party_type = 'customer')
         and p.payment_date between ${q.from}::date and ${q.to}::date
         and ${inStores('p.store_id', scope)}
         and ${eqOpt('p.created_by', q.user_id)}
         and ${eqOpt('p.register_id', q.register_id)}
         and ${channelPay}
    ),
    s as (
      select g, count(*)::bigint as bills, sum(gross_paise)::bigint as gross_paise,
             sum(item_discount_paise + bill_discount_paise)::bigint as discount_paise,
             sum(taxable_paise)::bigint as taxable_paise,
             sum(cgst_paise + sgst_paise + igst_paise + cess_paise)::bigint as tax_paise,
             sum(total_paise)::bigint as sales_paise, sum(round_off_paise)::bigint as round_off_paise,
             sum(cost_paise)::bigint as cost_paise
        from inv where ${byMethod ? sql`false` : sql`true`} group by g
    ),
    rt as (
      select g, count(*)::bigint as returns_count, sum(total_paise)::bigint as returns_paise,
             sum(taxable_paise)::bigint as returns_taxable_paise,
             sum(cost_paise)::bigint as returns_cost_paise
        from cn where ${byMethod ? sql`false` : sql`true`} group by g
    ),
    py as (
      select g, count(*) filter (where direction = 'in')::bigint as payments_count,
             coalesce(sum(amount_paise) filter (where direction = 'in'), 0)::bigint as collected_paise,
             coalesce(sum(amount_paise) filter (where direction = 'out'), 0)::bigint as refunded_paise
        from pay group by g
    ),
    k as (
      select g from s union select g from rt union select g from py
      ${byMethod ? sql`` : zeroFillKeys(gb, q.from, q.to)}
    ),
    rows as (
      select k.g as group_key, ${labels.select},
             coalesce(s.bills, 0)::bigint as bills,
             coalesce(s.gross_paise, 0)::bigint as gross_paise,
             coalesce(s.discount_paise, 0)::bigint as discount_paise,
             coalesce(s.taxable_paise, 0)::bigint as taxable_paise,
             coalesce(s.tax_paise, 0)::bigint as tax_paise,
             coalesce(s.sales_paise, 0)::bigint as sales_paise,
             coalesce(s.round_off_paise, 0)::bigint as round_off_paise,
             coalesce(rt.returns_count, 0)::bigint as returns_count,
             coalesce(rt.returns_paise, 0)::bigint as returns_paise,
             coalesce(rt.returns_taxable_paise, 0)::bigint as returns_taxable_paise,
             (coalesce(s.sales_paise, 0) - coalesce(rt.returns_paise, 0))::bigint as net_sales_paise,
             (coalesce(s.taxable_paise, 0) - coalesce(rt.returns_taxable_paise, 0))::bigint
               as net_taxable_paise,
             (coalesce(s.cost_paise, 0) - coalesce(rt.returns_cost_paise, 0))::bigint as cost_paise,
             (coalesce(s.taxable_paise, 0) - coalesce(rt.returns_taxable_paise, 0)
               - coalesce(s.cost_paise, 0) + coalesce(rt.returns_cost_paise, 0))::bigint
               as gross_profit_paise,
             coalesce(py.payments_count, 0)::bigint as payments_count,
             coalesce(py.collected_paise, 0)::bigint as collected_paise,
             coalesce(py.refunded_paise, 0)::bigint as refunded_paise,
             (coalesce(py.collected_paise, 0) - coalesce(py.refunded_paise, 0))::bigint
               as net_collected_paise
        from k
        left join s on s.g = k.g
        left join rt on rt.g = k.g
        left join py on py.g = k.g
        ${labels.join}
       where k.g is not null
    )`
  const totals = sql`select
      coalesce(sum(bills), 0)::bigint as bills, coalesce(sum(gross_paise), 0)::bigint as gross_paise,
      coalesce(sum(discount_paise), 0)::bigint as discount_paise,
      coalesce(sum(taxable_paise), 0)::bigint as taxable_paise,
      coalesce(sum(tax_paise), 0)::bigint as tax_paise,
      coalesce(sum(sales_paise), 0)::bigint as sales_paise,
      coalesce(sum(round_off_paise), 0)::bigint as round_off_paise,
      coalesce(sum(returns_count), 0)::bigint as returns_count,
      coalesce(sum(returns_paise), 0)::bigint as returns_paise,
      coalesce(sum(returns_taxable_paise), 0)::bigint as returns_taxable_paise,
      coalesce(sum(net_sales_paise), 0)::bigint as net_sales_paise,
      coalesce(sum(net_taxable_paise), 0)::bigint as net_taxable_paise,
      coalesce(sum(cost_paise), 0)::bigint as cost_paise,
      coalesce(sum(gross_profit_paise), 0)::bigint as gross_profit_paise,
      coalesce(sum(payments_count), 0)::bigint as payments_count,
      coalesce(sum(collected_paise), 0)::bigint as collected_paise,
      coalesce(sum(refunded_paise), 0)::bigint as refunded_paise,
      coalesce(sum(net_collected_paise), 0)::bigint as net_collected_paise
    from rows r`
  const order = orderBy(
    q.sort,
    {
      group: 'group_key',
      net_sales_paise: 'net_sales_paise',
      bills: 'bills',
      gross_profit_paise: 'gross_profit_paise',
    },
    'group_key',
  )
  const res = await runTabular<
    SummaryRaw,
    Omit<SummaryRaw, 'group_key' | 'group_label' | 'group_label_ta'>
  >(tx, { cte, order, totals }, q)
  const extra = (r: Omit<SummaryRaw, 'group_key' | 'group_label' | 'group_label_ta'>) => {
    const m = metrics(r)
    return {
      ...m,
      round_off_paise: num(r.round_off_paise),
      avg_bill_paise: avgBillPaise(m.sales_paise, m.bills),
      payments_count: num(r.payments_count),
      collected_paise: num(r.collected_paise),
      refunded_paise: num(r.refunded_paise),
      net_collected_paise: num(r.net_collected_paise),
    }
  }
  const rows = res.rows.map((r) => {
    let label = r.group_label
    let labelTa = r.group_label_ta
    if (byMethod) {
      const m = PaymentMethodSchema.safeParse(r.group_key)
      if (m.success) {
        const l = PAYMENT_METHOD_LABELS[m.data as PaymentMethod]
        label = l.en
        labelTa = l.ta
      }
    }
    return { group_key: r.group_key, group_label: label, group_label_ta: labelTa, ...extra(r) }
  })
  const meta = reportMeta('sales-summary', env, scope, {
    from: q.from,
    to: q.to,
    group_by: gb,
  })
  return reportOutcome(
    tx,
    ctx,
    'sales-summary',
    q,
    { ...res, rows, totals: extra(res.totals) },
    meta,
    {
      from: q.from,
      to: q.to,
      group_by: gb,
      store_id: scope.storeId,
    },
  )
}

// =============================================================================================
// Item sales
// =============================================================================================

interface ItemRaw extends RawMetrics {
  product_id: string | null
  sku: string | null
  name: string
  name_ta: string | null
  category_id: string | null
  category_name: string | null
  brand_id: string | null
  brand_name: string | null
  hsn_code: string | null
  unit: string
  pack_size: number
  qty_milli: number
  free_qty_milli: number
  returned_qty_milli: number
  net_qty_milli: number
}

const METRIC_TOTALS_SQL = sql`
  coalesce(sum(r.bills), 0)::bigint as bills_sum,
  coalesce(sum(r.gross_paise), 0)::bigint as gross_paise,
  coalesce(sum(r.discount_paise), 0)::bigint as discount_paise,
  coalesce(sum(r.taxable_paise), 0)::bigint as taxable_paise,
  coalesce(sum(r.tax_paise), 0)::bigint as tax_paise,
  coalesce(sum(r.sales_paise), 0)::bigint as sales_paise,
  coalesce(sum(r.returns_paise), 0)::bigint as returns_paise,
  coalesce(sum(r.returns_taxable_paise), 0)::bigint as returns_taxable_paise,
  coalesce(sum(r.net_sales_paise), 0)::bigint as net_sales_paise,
  coalesce(sum(r.net_taxable_paise), 0)::bigint as net_taxable_paise,
  coalesce(sum(r.cost_paise), 0)::bigint as cost_paise,
  coalesce(sum(r.gross_profit_paise), 0)::bigint as gross_profit_paise,
  bool_or(r.any_zero_cost) as any_zero_cost`

/** Distinct bill / return counts over the filtered facts (a bill may span several groups). */
const DOC_COUNTS_SQL = sql`
  (select count(distinct inv_id) from ff)::bigint as bills,
  (select count(distinct cn_id) from ff)::bigint as returns_count`

export async function itemSales(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof ItemSalesQuerySchema>,
): Promise<ReportOutcome<ItemSalesResponse>> {
  const facts = salesFactsCte(
    ctx,
    { from: q.from, to: q.to, scope, userId: q.user_id },
    { categoryId: q.category_id, brandId: q.brand_id, productId: q.product_id, q: q.q },
  )
  const cte = sql`with recursive ${facts},
    rows as (
      select ff.product_id, min(ff.sku) as sku,
             case when ff.product_id is null then ${ADHOC.en} else min(ff.name) end as name,
             case when ff.product_id is null then ${ADHOC.ta} else min(ff.name_ta) end as name_ta,
             min(ff.category_id::text)::uuid as category_id, min(c.name) as category_name,
             min(ff.brand_id::text)::uuid as brand_id, min(b.name::text) as brand_name,
             min(ff.hsn_code) as hsn_code, min(ff.unit) as unit, min(ff.pack_size) as pack_size,
             coalesce(sum(ff.qty_milli), 0)::bigint as qty_milli,
             coalesce(sum(ff.free_qty_milli), 0)::bigint as free_qty_milli,
             coalesce(sum(ff.returned_qty_milli), 0)::bigint as returned_qty_milli,
             coalesce(sum(ff.qty_milli + ff.free_qty_milli - ff.returned_qty_milli), 0)::bigint
               as net_qty_milli,
             ${SALES_METRICS_SQL}
        from ff
        left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = ff.category_id
        left join brands b on b.tenant_id = ${ctx.tenantId} and b.id = ff.brand_id
       group by ff.product_id
    )`
  const totals = sql`select count(*)::bigint as products, ${METRIC_TOTALS_SQL}, ${DOC_COUNTS_SQL}
    from rows r`
  const order = orderBy(
    q.sort,
    {
      net_sales_paise: 'net_sales_paise',
      net_qty_milli: 'net_qty_milli',
      gross_profit_paise: 'gross_profit_paise',
      margin_bp: marginSql('gross_profit_paise', 'net_taxable_paise'),
      name: 'lower(name)',
    },
    'product_id nulls last',
  )
  const res = await runTabular<ItemRaw, RawMetrics & { products: number }>(
    tx,
    { cte, order, totals },
    q,
  )
  const rows = res.rows.map((r) => ({
    product_id: r.product_id,
    sku: r.sku,
    name: r.name,
    name_ta: r.name_ta,
    category_id: r.category_id,
    category_name: r.category_name,
    brand_id: r.brand_id,
    brand_name: r.brand_name,
    hsn_code: r.hsn_code,
    unit: r.unit,
    pack_size: num(r.pack_size) || 1,
    qty_milli: num(r.qty_milli),
    free_qty_milli: num(r.free_qty_milli),
    returned_qty_milli: num(r.returned_qty_milli),
    net_qty_milli: num(r.net_qty_milli),
    ...metrics(r),
  }))
  const totalsOut = { products: num(res.totals.products), ...metrics(res.totals) }
  const meta = reportMeta('item-sales', env, scope, {
    from: q.from,
    to: q.to,
    notes: res.totals.any_zero_cost ? ['cost_estimated'] : [],
  })
  return reportOutcome(tx, ctx, 'item-sales', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    store_id: scope.storeId,
    category_id: q.category_id ?? null,
    brand_id: q.brand_id ?? null,
  })
}

// =============================================================================================
// Category / brand sales
// =============================================================================================

interface GroupRaw extends RawMetrics {
  products: number
}

export async function categorySales(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof CategorySalesQuerySchema>,
): Promise<ReportOutcome<CategorySalesResponse>> {
  const facts = salesFactsCte(ctx, { from: q.from, to: q.to, scope }, { categoryId: q.category_id })
  const keyCol = q.level === 'top' ? sql`t.root_id` : sql`t.id`
  const cte = sql`with recursive ${categoryTreeCte(ctx)}, ${facts},
    g as (
      select ff.*, ${keyCol} as cat_key
        from ff left join cat_tree t on t.id = ff.category_id
    ),
    rows as (
      select g.cat_key as category_id,
             coalesce(ct.name, ${UNCATEGORISED.en}) as category_name,
             case when g.cat_key is null then ${UNCATEGORISED.ta} else ct.name_ta end
               as category_name_ta,
             coalesce(ct.path, ${UNCATEGORISED.en}) as path,
             count(distinct g.product_key)::bigint as products,
             ${metricsOver('g')}
        from g left join cat_tree ct on ct.id = g.cat_key
       group by g.cat_key, ct.name, ct.name_ta, ct.path
    )`
  const totals = sql`select (select count(distinct product_key) from ff)::bigint as products,
      ${METRIC_TOTALS_SQL}, ${DOC_COUNTS_SQL} from rows r`
  const order = orderBy(
    q.sort,
    {
      net_sales_paise: 'net_sales_paise',
      gross_profit_paise: 'gross_profit_paise',
      margin_bp: marginSql('gross_profit_paise', 'net_taxable_paise'),
      name: 'lower(path)',
    },
    'category_id nulls last',
  )
  const res = await runTabular<
    GroupRaw & {
      category_id: string | null
      category_name: string
      category_name_ta: string | null
      path: string
    },
    GroupRaw
  >(tx, { cte, order, totals }, q)
  const totalNet = num(res.totals.net_sales_paise)
  const rows = res.rows.map((r) => ({
    category_id: r.category_id,
    category_name: r.category_name,
    category_name_ta: r.category_name_ta,
    path: r.path,
    products: num(r.products),
    ...metrics(r),
    share_bp: shareBp(num(r.net_sales_paise), totalNet),
  }))
  const totalsOut = { ...metrics(res.totals), products: num(res.totals.products) }
  const meta = reportMeta('category-sales', env, scope, {
    from: q.from,
    to: q.to,
    group_by: q.level,
    notes: res.totals.any_zero_cost ? ['cost_estimated'] : [],
  })
  return reportOutcome(tx, ctx, 'category-sales', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    level: q.level,
    store_id: scope.storeId,
  })
}

/** SALES_METRICS_SQL over another alias of the fact rows. */
function metricsOver(alias: string): Sql {
  const a = (c: string) => sql.ref(`${alias}.${c}`)
  return sql`
    count(distinct ${a('inv_id')})::bigint as bills,
    coalesce(sum(${a('gross_paise')}), 0)::bigint as gross_paise,
    coalesce(sum(${a('discount_paise')}), 0)::bigint as discount_paise,
    coalesce(sum(${a('taxable_paise')}), 0)::bigint as taxable_paise,
    coalesce(sum(${a('tax_paise')}), 0)::bigint as tax_paise,
    coalesce(sum(${a('sales_paise')}), 0)::bigint as sales_paise,
    count(distinct ${a('cn_id')})::bigint as returns_count,
    coalesce(sum(${a('returns_paise')}), 0)::bigint as returns_paise,
    coalesce(sum(${a('returns_taxable_paise')}), 0)::bigint as returns_taxable_paise,
    coalesce(sum(${a('sales_paise')} - ${a('returns_paise')}), 0)::bigint as net_sales_paise,
    coalesce(sum(${a('taxable_paise')} - ${a('returns_taxable_paise')}), 0)::bigint
      as net_taxable_paise,
    coalesce(sum(${a('cost_paise')}), 0)::bigint as cost_paise,
    coalesce(sum(${a('taxable_paise')} - ${a('returns_taxable_paise')} - ${a('cost_paise')}), 0)::bigint
      as gross_profit_paise,
    bool_or(${a('zero_cost')}) as any_zero_cost`
}

export async function brandSales(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof BrandSalesQuerySchema>,
): Promise<ReportOutcome<BrandSalesResponse>> {
  const facts = salesFactsCte(ctx, { from: q.from, to: q.to, scope }, { categoryId: q.category_id })
  const cte = sql`with recursive ${facts},
    rows as (
      select ff.brand_id, coalesce(min(b.name::text), ${NO_BRAND.en}) as brand_name,
             count(distinct ff.product_key)::bigint as products,
             ${metricsOver('ff')}
        from ff left join brands b on b.tenant_id = ${ctx.tenantId} and b.id = ff.brand_id
       group by ff.brand_id
    )`
  const totals = sql`select (select count(distinct product_key) from ff)::bigint as products,
      ${METRIC_TOTALS_SQL}, ${DOC_COUNTS_SQL} from rows r`
  const order = orderBy(
    q.sort,
    {
      net_sales_paise: 'net_sales_paise',
      gross_profit_paise: 'gross_profit_paise',
      margin_bp: marginSql('gross_profit_paise', 'net_taxable_paise'),
      name: 'lower(brand_name)',
    },
    'brand_id nulls last',
  )
  const res = await runTabular<
    GroupRaw & { brand_id: string | null; brand_name: string },
    GroupRaw
  >(tx, { cte, order, totals }, q)
  const totalNet = num(res.totals.net_sales_paise)
  const rows = res.rows.map((r) => ({
    brand_id: r.brand_id,
    brand_name: r.brand_name,
    products: num(r.products),
    ...metrics(r),
    share_bp: shareBp(num(r.net_sales_paise), totalNet),
  }))
  const totalsOut = { ...metrics(res.totals), products: num(res.totals.products) }
  const meta = reportMeta('brand-sales', env, scope, {
    from: q.from,
    to: q.to,
    notes: res.totals.any_zero_cost ? ['cost_estimated'] : [],
  })
  return reportOutcome(tx, ctx, 'brand-sales', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    store_id: scope.storeId,
  })
}

// =============================================================================================
// Profit
// =============================================================================================

interface ProfitRaw {
  key_id: string | null
  name: string
  name_ta: string | null
  category_name: string | null
  unit: string | null
  pack_size: number | null
  net_qty_milli: number | null
  net_taxable_paise: number
  cost_paise: number
  gross_profit_paise: number
}

export async function profit(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof ProfitQuerySchema>,
): Promise<ReportOutcome<ProfitResponse>> {
  const facts = salesFactsCte(ctx, { from: q.from, to: q.to, scope }, { categoryId: q.category_id })
  const base = sql`
    coalesce(sum(ff.taxable_paise - ff.returns_taxable_paise), 0)::bigint as net_taxable_paise,
    coalesce(sum(ff.cost_paise), 0)::bigint as cost_paise,
    coalesce(sum(ff.taxable_paise - ff.returns_taxable_paise - ff.cost_paise), 0)::bigint
      as gross_profit_paise,
    bool_or(ff.zero_cost) as any_zero_cost`
  let grouped: Sql
  switch (q.group_by) {
    case 'item':
      grouped = sql`
        select ff.product_id as key_id,
               case when ff.product_id is null then ${ADHOC.en} else min(ff.name) end as name,
               case when ff.product_id is null then ${ADHOC.ta} else min(ff.name_ta) end as name_ta,
               min(c.name) as category_name, min(ff.unit) as unit, min(ff.pack_size) as pack_size,
               coalesce(sum(ff.qty_milli + ff.free_qty_milli - ff.returned_qty_milli), 0)::bigint
                 as net_qty_milli,
               ${base}
          from ff left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = ff.category_id
         group by ff.product_id`
      break
    case 'category':
      grouped = sql`
        select ff.category_id as key_id, coalesce(min(c.name), ${UNCATEGORISED.en}) as name,
               case when ff.category_id is null then ${UNCATEGORISED.ta} else min(c.name_ta) end
                 as name_ta,
               null::text as category_name, null::text as unit, null::int as pack_size,
               null::bigint as net_qty_milli, ${base}
          from ff left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = ff.category_id
         group by ff.category_id`
      break
    case 'brand':
      grouped = sql`
        select ff.brand_id as key_id, coalesce(min(b.name::text), ${NO_BRAND.en}) as name,
               case when ff.brand_id is null then ${NO_BRAND.ta} end as name_ta,
               null::text as category_name, null::text as unit, null::int as pack_size,
               null::bigint as net_qty_milli, ${base}
          from ff left join brands b on b.tenant_id = ${ctx.tenantId} and b.id = ff.brand_id
         group by ff.brand_id`
      break
  }
  const marginExpr = marginSql('gross_profit_paise', 'net_taxable_paise')
  const maxMargin =
    q.max_margin_bp === undefined ? sql`true` : sql`${sql.raw(marginExpr)} <= ${q.max_margin_bp}`
  const cte = sql`with recursive ${facts},
    grouped as (${grouped}),
    rows as (select * from grouped where ${maxMargin})`
  const totals = sql`select
      coalesce(sum(net_taxable_paise), 0)::bigint as net_taxable_paise,
      coalesce(sum(cost_paise), 0)::bigint as cost_paise,
      coalesce(sum(gross_profit_paise), 0)::bigint as gross_profit_paise,
      bool_or(any_zero_cost) as any_zero_cost
    from rows r`
  const order = orderBy(
    q.sort,
    {
      gross_profit_paise: 'gross_profit_paise',
      margin_bp: marginExpr,
      net_taxable_paise: 'net_taxable_paise',
      name: 'lower(name)',
    },
    'key_id nulls last',
  )
  const res = await runTabular<
    ProfitRaw & { any_zero_cost: boolean | null },
    {
      net_taxable_paise: number
      cost_paise: number
      gross_profit_paise: number
      any_zero_cost: boolean | null
    }
  >(tx, { cte, order, totals }, q)
  const totalGp = num(res.totals.gross_profit_paise)
  const rows = res.rows.map((r) => ({
    key_id: r.key_id,
    name: r.name,
    name_ta: r.name_ta,
    category_name: r.category_name,
    unit: r.unit,
    pack_size: numOrNull(r.pack_size),
    net_qty_milli: numOrNull(r.net_qty_milli),
    net_taxable_paise: num(r.net_taxable_paise),
    cost_paise: num(r.cost_paise),
    gross_profit_paise: num(r.gross_profit_paise),
    margin_bp: marginBp(num(r.gross_profit_paise), num(r.net_taxable_paise)),
    profit_share_bp: shareBp(num(r.gross_profit_paise), totalGp),
  }))
  const totalsOut = {
    net_taxable_paise: num(res.totals.net_taxable_paise),
    cost_paise: num(res.totals.cost_paise),
    gross_profit_paise: totalGp,
    margin_bp: marginBp(totalGp, num(res.totals.net_taxable_paise)),
  }
  const meta = reportMeta('profit', env, scope, {
    from: q.from,
    to: q.to,
    group_by: q.group_by,
    notes: res.totals.any_zero_cost ? ['cost_estimated'] : [],
  })
  return reportOutcome(tx, ctx, 'profit', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    group_by: q.group_by,
    store_id: scope.storeId,
  })
}

// =============================================================================================
// Discounts
// =============================================================================================

interface DiscountRaw {
  group_key: string
  label: string
  label_ta: string | null
  ref_type: 'sales_invoice' | 'product' | 'promotion' | 'user'
  ref_id: string | null
  date: string | null
  customer_name: string | null
  user_name: string | null
  bills: number
  qty_milli: number | null
  unit: string | null
  gross_paise: number
  item_discount_paise: number
  bill_discount_paise: number
  promotion_discount_paise: number
  discount_paise: number
}

/**
 * Lines of the range with the bill-discount part of `discount_paise` (item + allocated bill
 * discount); the report covers discounted lines (item / promotion) and bills (bill / user) only.
 * The bill discount was allocated pro rata to (gross − item discount), hence
 * bill_part = B × (gross − discount) ÷ Σ(gross − discount); the last line takes the remainder so
 * the parts add up to the bill's bill_discount_paise exactly.
 */
function discountLinesCte(
  ctx: Ctx,
  from: string,
  to: string,
  scope: StoreScope,
  userId?: string,
): Sql {
  return sql`dl0 as (
      select l.invoice_id, l.line_no, l.product_id, l.name, l.name_ta, l.unit, l.qty_milli,
             l.gross_paise, l.discount_paise, l.promotion_id,
             i.bill_discount_paise as inv_bill,
             sum(l.gross_paise - l.discount_paise) over w as inv_net,
             sum(l.gross_paise) over w as inv_gross,
             row_number() over (partition by l.invoice_id order by l.line_no desc) as rn_desc
        from sales_invoice_lines l
        join sales_invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
       where l.tenant_id = ${ctx.tenantId}
         and ${invoiceWhere(ctx, { from, to, scope, userId })}
      window w as (partition by l.invoice_id)
    ),
    dl1 as (
      select dl0.*,
             case when inv_bill = 0 then 0
                  when inv_net > 0 then round(inv_bill::numeric * (gross_paise - discount_paise) / inv_net)
                  when inv_gross > 0 then round(inv_bill::numeric * gross_paise / inv_gross)
                  else 0 end::bigint as raw_bill
        from dl0
    ),
    dl as (
      select dl1.*,
             greatest(0, least(discount_paise,
               case when rn_desc = 1
                    then inv_bill - (sum(raw_bill) over (partition by invoice_id) - raw_bill)
                    else raw_bill end))::bigint as bill_part
        from dl1
    ),
    dlx as (
      select dl.*, (dl.discount_paise - dl.bill_part)::bigint as item_part from dl
    ),
    promo as (
      select invoice_id, sum(item_part)::bigint as promo_paise
        from dlx where promotion_id is not null group by invoice_id
    )`
}

export async function discounts(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof DiscountsQuerySchema>,
): Promise<ReportOutcome<DiscountsResponse>> {
  const lines = discountLinesCte(ctx, q.from, q.to, scope, q.user_id)
  let grouped: Sql
  switch (q.group_by) {
    case 'bill':
      grouped = sql`
        select i.id::text as group_key, i.number as label, null::text as label_ta,
               'sales_invoice' as ref_type, i.id as ref_id, i.invoice_date as date,
               i.customer_name, u.full_name as user_name, 1::bigint as bills,
               null::bigint as qty_milli, null::text as unit,
               i.gross_paise, i.item_discount_paise, i.bill_discount_paise,
               coalesce(pp.promo_paise, 0)::bigint as promotion_discount_paise,
               (i.item_discount_paise + i.bill_discount_paise)::bigint as discount_paise
          from sales_invoices i
          left join users u on u.id = i.created_by
          left join promo pp on pp.invoice_id = i.id
         where ${invoiceWhere(ctx, { from: q.from, to: q.to, scope, userId: q.user_id })}
           and i.item_discount_paise + i.bill_discount_paise > 0`
      break
    case 'item':
      grouped = sql`
        select coalesce(x.product_id::text, 'adhoc') as group_key,
               case when x.product_id is null then ${ADHOC.en} else min(coalesce(p.name, x.name)) end
                 as label,
               case when x.product_id is null then ${ADHOC.ta} else min(coalesce(p.name_ta, x.name_ta)) end
                 as label_ta,
               'product' as ref_type, x.product_id as ref_id, null::date as date,
               null::text as customer_name, null::text as user_name,
               count(distinct x.invoice_id)::bigint as bills,
               sum(x.qty_milli)::bigint as qty_milli, min(x.unit) as unit,
               sum(x.gross_paise)::bigint as gross_paise,
               sum(x.item_part)::bigint as item_discount_paise,
               sum(x.bill_part)::bigint as bill_discount_paise,
               coalesce(sum(x.item_part) filter (where x.promotion_id is not null), 0)::bigint
                 as promotion_discount_paise,
               sum(x.discount_paise)::bigint as discount_paise
          from dlx x
          left join products p on p.tenant_id = ${ctx.tenantId} and p.id = x.product_id
         where x.discount_paise > 0
         group by x.product_id`
      break
    case 'promotion':
      grouped = sql`
        select x.promotion_id::text as group_key, min(pm.name) as label, min(pm.name_ta) as label_ta,
               'promotion' as ref_type, x.promotion_id as ref_id, null::date as date,
               null::text as customer_name, null::text as user_name,
               count(distinct x.invoice_id)::bigint as bills,
               null::bigint as qty_milli, null::text as unit,
               sum(x.gross_paise)::bigint as gross_paise,
               sum(x.item_part)::bigint as item_discount_paise,
               sum(x.bill_part)::bigint as bill_discount_paise,
               sum(x.item_part)::bigint as promotion_discount_paise,
               sum(x.discount_paise)::bigint as discount_paise
          from dlx x
          join promotions pm on pm.tenant_id = ${ctx.tenantId} and pm.id = x.promotion_id
         where x.promotion_id is not null and x.discount_paise > 0
         group by x.promotion_id`
      break
    case 'user':
      grouped = sql`
        select coalesce(i.created_by::text, 'none') as group_key,
               coalesce(min(u.full_name), ${UNKNOWN_USER.en}) as label,
               case when i.created_by is null then ${UNKNOWN_USER.ta} end as label_ta,
               'user' as ref_type, i.created_by as ref_id, null::date as date,
               null::text as customer_name, min(u.full_name) as user_name,
               count(*)::bigint as bills, null::bigint as qty_milli, null::text as unit,
               sum(i.gross_paise)::bigint as gross_paise,
               sum(i.item_discount_paise)::bigint as item_discount_paise,
               sum(i.bill_discount_paise)::bigint as bill_discount_paise,
               coalesce(sum(pp.promo_paise), 0)::bigint as promotion_discount_paise,
               sum(i.item_discount_paise + i.bill_discount_paise)::bigint as discount_paise
          from sales_invoices i
          left join users u on u.id = i.created_by
          left join promo pp on pp.invoice_id = i.id
         where ${invoiceWhere(ctx, { from: q.from, to: q.to, scope, userId: q.user_id })}
           and i.item_discount_paise + i.bill_discount_paise > 0
         group by i.created_by`
      break
  }
  const bpExpr =
    '(case when gross_paise > 0 then round(discount_paise::numeric * 10000 / gross_paise) else 0 end)'
  const minBp =
    q.min_discount_bp === undefined ? sql`true` : sql`${sql.raw(bpExpr)} >= ${q.min_discount_bp}`
  const cte = sql`with recursive ${lines},
    grouped as (${grouped}),
    rows as (select * from grouped where ${minBp})`
  const totalsBills =
    q.group_by === 'bill' || q.group_by === 'user'
      ? sql`coalesce(sum(r.bills), 0)::bigint`
      : sql`(select count(distinct x.invoice_id) from dlx x where x.discount_paise > 0
              and (${q.group_by === 'promotion' ? sql`x.promotion_id is not null` : sql`true`}))::bigint`
  const totals = sql`select ${totalsBills} as bills,
      coalesce(sum(gross_paise), 0)::bigint as gross_paise,
      coalesce(sum(item_discount_paise), 0)::bigint as item_discount_paise,
      coalesce(sum(bill_discount_paise), 0)::bigint as bill_discount_paise,
      coalesce(sum(promotion_discount_paise), 0)::bigint as promotion_discount_paise,
      coalesce(sum(discount_paise), 0)::bigint as discount_paise
    from rows r`
  const order = orderBy(
    q.sort,
    {
      discount_paise: 'discount_paise',
      discount_bp: bpExpr,
      date: 'date',
      label: 'lower(label)',
    },
    'group_key',
  )
  const res = await runTabular<
    DiscountRaw,
    {
      bills: number
      gross_paise: number
      item_discount_paise: number
      bill_discount_paise: number
      promotion_discount_paise: number
      discount_paise: number
    }
  >(tx, { cte, order, totals }, q)
  const bp = (d: number, g: number) => (g > 0 ? shareBp(d, g) : 0)
  const rows = res.rows.map((r) => ({
    group_key: r.group_key,
    label: r.label ?? r.group_key,
    label_ta: r.label_ta,
    ref_type: r.ref_type,
    ref_id: r.ref_id,
    date: r.date,
    customer_name: r.customer_name,
    user_name: r.user_name,
    bills: num(r.bills),
    qty_milli: numOrNull(r.qty_milli),
    unit: r.unit,
    gross_paise: num(r.gross_paise),
    item_discount_paise: num(r.item_discount_paise),
    bill_discount_paise: num(r.bill_discount_paise),
    promotion_discount_paise: num(r.promotion_discount_paise),
    discount_paise: num(r.discount_paise),
    discount_bp: Math.max(0, bp(num(r.discount_paise), num(r.gross_paise))),
  }))
  const t = res.totals
  const totalsOut = {
    bills: num(t.bills),
    gross_paise: num(t.gross_paise),
    item_discount_paise: num(t.item_discount_paise),
    bill_discount_paise: num(t.bill_discount_paise),
    promotion_discount_paise: num(t.promotion_discount_paise),
    discount_paise: num(t.discount_paise),
    discount_bp: Math.max(0, bp(num(t.discount_paise), num(t.gross_paise))),
  }
  const meta = reportMeta('discounts', env, scope, { from: q.from, to: q.to, group_by: q.group_by })
  return reportOutcome(tx, ctx, 'discounts', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    group_by: q.group_by,
    store_id: scope.storeId,
  })
}

// =============================================================================================
// Cancellations
// =============================================================================================

interface CancellationRaw {
  kind: 'invoice' | 'credit_note'
  document_id: string
  number: string | null
  document_date: string
  created_by_name: string | null
  cancelled_at: Date
  cancelled_by: string | null
  cancelled_by_name: string | null
  reason: string | null
  customer_name: string | null
  store_name: string
  register_code: string | null
  total_paise: number
  refunded_paise: number
  minutes_after: number
}

export async function cancellations(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof CancellationsQuerySchema>,
): Promise<ReportOutcome<CancellationsResponse>> {
  // Business dates of the cancellation instant (tenant timezone) as a half-open instant range.
  const range = instantRange(env, q.from, q.to)
  const inRange = (col: string) =>
    sql`${sql.ref(col)} >= ${range.start} and ${sql.ref(col)} < ${range.end}`
  const wantInv = q.kind === undefined || q.kind === 'invoice'
  const wantCn = q.kind === undefined || q.kind === 'credit_note'
  const cte = sql`with recursive
    inv as (
      select 'invoice'::text as kind, i.id as document_id, i.number, i.invoice_date as document_date,
             cu.full_name as created_by_name, i.cancelled_at, i.cancelled_by,
             xu.full_name as cancelled_by_name, i.cancel_reason as reason, i.customer_name,
             st.name as store_name, rg.code as register_code, i.total_paise,
             coalesce((select sum(a.amount_paise)
                         from payment_allocations a
                         join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
                        where a.tenant_id = i.tenant_id and a.target_type = 'sales_invoice'
                          and a.target_id = i.id and p.direction = 'in'
                          and p.status = 'cancelled'), 0)::bigint as refunded_paise,
             greatest(0, floor(extract(epoch from (i.cancelled_at - i.invoice_at)) / 60))::int
               as minutes_after
        from sales_invoices i
        join stores st on st.tenant_id = i.tenant_id and st.id = i.store_id
        left join registers rg on rg.tenant_id = i.tenant_id and rg.id = i.register_id
        left join users cu on cu.id = i.created_by
        left join users xu on xu.id = i.cancelled_by
       where i.tenant_id = ${ctx.tenantId} and i.status = 'cancelled'
         and i.cancelled_at is not null and ${wantInv ? sql`true` : sql`false`}
         and ${inRange('i.cancelled_at')}
         and ${inStores('i.store_id', scope)}
         and ${eqOpt('i.cancelled_by', q.user_id)}
    ),
    cnx as (
      select 'credit_note'::text as kind, c.id, c.number, c.note_date, cu.full_name,
             c.cancelled_at, c.cancelled_by, xu.full_name, c.cancel_reason, c.customer_name,
             st.name, rg.code, c.total_paise, 0::bigint,
             greatest(0, floor(extract(epoch from (c.cancelled_at - c.created_at)) / 60))::int
        from credit_notes c
        join stores st on st.tenant_id = c.tenant_id and st.id = c.store_id
        left join registers rg on rg.tenant_id = c.tenant_id and rg.id = c.register_id
        left join users cu on cu.id = c.created_by
        left join users xu on xu.id = c.cancelled_by
       where c.tenant_id = ${ctx.tenantId} and c.status = 'cancelled'
         and c.cancelled_at is not null and ${wantCn ? sql`true` : sql`false`}
         and ${inRange('c.cancelled_at')}
         and ${inStores('c.store_id', scope)}
         and ${eqOpt('c.cancelled_by', q.user_id)}
    ),
    rows as (select * from inv union all select * from cnx)`
  const totals = sql`select count(*)::bigint as count,
      coalesce(sum(total_paise), 0)::bigint as total_paise,
      coalesce(sum(refunded_paise), 0)::bigint as refunded_paise
    from rows r`
  const order = orderBy(
    q.sort,
    { cancelled_at: 'cancelled_at', total_paise: 'total_paise', number: 'number' },
    'document_id',
  )
  const res = await runTabular<
    CancellationRaw,
    { count: number; total_paise: number; refunded_paise: number }
  >(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => ({
    kind: r.kind,
    document_id: r.document_id,
    number: r.number,
    document_date: r.document_date,
    created_by_name: r.created_by_name,
    cancelled_at: iso(r.cancelled_at),
    cancelled_by: r.cancelled_by,
    cancelled_by_name: r.cancelled_by_name,
    reason: r.reason,
    customer_name: r.customer_name,
    store_name: r.store_name,
    register_code: r.register_code,
    total_paise: num(r.total_paise),
    refunded_paise: num(r.refunded_paise),
    minutes_after: num(r.minutes_after),
  }))
  const totalsOut = {
    count: num(res.totals.count),
    total_paise: num(res.totals.total_paise),
    refunded_paise: num(res.totals.refunded_paise),
  }
  const meta = reportMeta('cancellations', env, scope, { from: q.from, to: q.to })
  return reportOutcome(tx, ctx, 'cancellations', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    kind: q.kind ?? null,
    store_id: scope.storeId,
  })
}

// =============================================================================================
// Shifts
// =============================================================================================

interface ShiftRaw {
  shift_id: string
  store_name: string
  register_code: string
  status: 'open' | 'closed'
  opened_by_name: string | null
  opened_at: Date
  closed_by_name: string | null
  closed_at: Date | null
  bills: number
  sales_paise: number
  cash_paise: number
  upi_paise: number
  card_paise: number
  other_paise: number
  opening_cash_paise: number
  expected_cash_paise: number | null
  counted_cash_paise: number | null
  difference_paise: number | null
}

export async function shiftsReport(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof ShiftsReportQuerySchema>,
): Promise<ReportOutcome<ShiftsReportResponse>> {
  const opened = instantRange(env, q.from, q.to)
  const cte = sql`with recursive
    sh as (
      select s.* from register_shifts s
       where s.tenant_id = ${ctx.tenantId}
         and s.opened_at >= ${opened.start} and s.opened_at < ${opened.end}
         and ${inStores('s.store_id', scope)}
         and ${eqOpt('s.register_id', q.register_id)}
         and ${eqOpt('s.opened_by', q.user_id)}
    ),
    bills as (
      select i.shift_id, count(*)::bigint as bills, sum(i.total_paise)::bigint as sales_paise
        from sales_invoices i
       where i.tenant_id = ${ctx.tenantId} and i.status = 'completed' and i.doc_type <> 'estimate'
         and i.shift_id in (select id from sh)
       group by i.shift_id
    ),
    tenders as (
      select p.shift_id,
             coalesce(sum(p.amount_paise) filter (where p.method = 'cash'), 0)::bigint as cash_paise,
             coalesce(sum(p.amount_paise) filter (where p.method = 'upi'), 0)::bigint as upi_paise,
             coalesce(sum(p.amount_paise) filter (where p.method = 'card'), 0)::bigint as card_paise,
             coalesce(sum(p.amount_paise) filter (where p.method not in ('cash', 'upi', 'card')), 0)::bigint
               as other_paise
        from payments p
       where p.tenant_id = ${ctx.tenantId} and p.status = 'completed' and p.direction = 'in'
         and p.method <> 'store_credit' and p.shift_id in (select id from sh)
       group by p.shift_id
    ),
    rows as (
      select sh.id as shift_id, st.name as store_name, rg.code as register_code, sh.status,
             ou.full_name as opened_by_name, sh.opened_at, cu.full_name as closed_by_name,
             sh.closed_at, coalesce(b.bills, 0)::bigint as bills,
             coalesce(b.sales_paise, 0)::bigint as sales_paise,
             coalesce(t.cash_paise, 0)::bigint as cash_paise,
             coalesce(t.upi_paise, 0)::bigint as upi_paise,
             coalesce(t.card_paise, 0)::bigint as card_paise,
             coalesce(t.other_paise, 0)::bigint as other_paise,
             sh.opening_cash_paise, sh.expected_cash_paise, sh.counted_cash_paise,
             sh.difference_paise
        from sh
        join stores st on st.tenant_id = sh.tenant_id and st.id = sh.store_id
        join registers rg on rg.tenant_id = sh.tenant_id and rg.id = sh.register_id
        left join users ou on ou.id = sh.opened_by
        left join users cu on cu.id = sh.closed_by
        left join bills b on b.shift_id = sh.id
        left join tenders t on t.shift_id = sh.id
    )`
  const totals = sql`select count(*)::bigint as shifts,
      coalesce(sum(bills), 0)::bigint as bills,
      coalesce(sum(sales_paise), 0)::bigint as sales_paise,
      coalesce(sum(cash_paise), 0)::bigint as cash_paise,
      coalesce(sum(upi_paise), 0)::bigint as upi_paise,
      coalesce(sum(card_paise), 0)::bigint as card_paise,
      coalesce(sum(other_paise), 0)::bigint as other_paise,
      coalesce(sum(difference_paise) filter (where status = 'closed'), 0)::bigint as difference_paise
    from rows r`
  const order = orderBy(
    q.sort,
    { opened_at: 'opened_at', difference_paise: 'difference_paise', sales_paise: 'sales_paise' },
    'shift_id',
  )
  const res = await runTabular<
    ShiftRaw,
    {
      shifts: number
      bills: number
      sales_paise: number
      cash_paise: number
      upi_paise: number
      card_paise: number
      other_paise: number
      difference_paise: number
    }
  >(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => ({
    shift_id: r.shift_id,
    store_name: r.store_name,
    register_code: r.register_code,
    status: r.status,
    opened_by_name: r.opened_by_name,
    opened_at: iso(r.opened_at),
    closed_by_name: r.closed_by_name,
    closed_at: isoOrNull(r.closed_at),
    bills: num(r.bills),
    sales_paise: num(r.sales_paise),
    cash_paise: num(r.cash_paise),
    upi_paise: num(r.upi_paise),
    card_paise: num(r.card_paise),
    other_paise: num(r.other_paise),
    opening_cash_paise: num(r.opening_cash_paise),
    expected_cash_paise: numOrNull(r.expected_cash_paise),
    counted_cash_paise: numOrNull(r.counted_cash_paise),
    difference_paise: numOrNull(r.difference_paise),
  }))
  const t = res.totals
  const totalsOut = {
    shifts: num(t.shifts),
    bills: num(t.bills),
    sales_paise: num(t.sales_paise),
    cash_paise: num(t.cash_paise),
    upi_paise: num(t.upi_paise),
    card_paise: num(t.card_paise),
    other_paise: num(t.other_paise),
    difference_paise: num(t.difference_paise),
  }
  const meta = reportMeta('shifts', env, scope, { from: q.from, to: q.to })
  return reportOutcome(tx, ctx, 'shifts', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    store_id: scope.storeId,
  })
}
