/**
 * Stock reports (as of now): valuation at cost / MRP / selling price, ageing since the last
 * inbound movement, expiry and dead stock. Quantities come from stock_levels (the materialised
 * balance of the movement ledger); values = round(per-pack price × qty ÷ (pack size × 1000)),
 * i.e. stockValuePaise() of the inventory contract, per stock row.
 */
import { sql } from 'kysely'
import type { z } from 'zod'
import { addDays, mulDiv } from '@kadai/shared'
import {
  type DeadStockQuerySchema,
  type DeadStockResponse,
  type ExpiryQuerySchema,
  type ExpiryResponse,
  type StockAgeingQuerySchema,
  type StockAgeingResponse,
  type StockSummaryQuerySchema,
  type StockSummaryResponse,
  ageingBucket,
} from '@kadai/shared/api/reports'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  type ReportEnv,
  type ReportOutcome,
  type StoreScope,
  eqOpt,
  inCategoryTree,
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

const UNCATEGORISED = { en: 'Uncategorised', ta: 'வகைப்படுத்தப்படாதவை' }

/** Per-pack value of stock rows `l` (alias) at a price column → bigint paise. */
const VALUE = (price: string) => `round((${price})::numeric * l.qty_milli / (p.pack_size * 1000))`

const INBOUND_TYPES = sql`('purchase', 'opening', 'transfer_in')`

// =============================================================================================
// Stock summary
// =============================================================================================

interface SummaryRaw {
  key_id: string | null
  name: string
  name_ta: string | null
  category_name: string | null
  products: number
  sku: string | null
  unit: string | null
  pack_size: number | null
  qty_milli: number | null
  value_cost_paise: number
  value_mrp_paise: number
  value_sale_paise: number
  negative_count: number
}

export async function stockSummary(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof StockSummaryQuerySchema>,
): Promise<ReportOutcome<StockSummaryResponse>> {
  const search = q.q
    ? sql`(p.name ilike ${likePattern(q.q)} or coalesce(p.name_ta, '') ilike ${likePattern(q.q)}
           or coalesce(p.sku, '') ilike ${likePattern(q.q)})`
    : sql`true`
  const items = sql`
    pv as (
      select l.product_id, sum(l.qty_milli)::bigint as qty_milli,
             sum(${sql.raw(VALUE('l.avg_cost_paise'))})::bigint as value_cost_paise,
             sum(${sql.raw(VALUE('coalesce(b.mrp_paise, sp.mrp_paise, p.mrp_paise, 0)'))})::bigint
               as value_mrp_paise,
             sum(${sql.raw(VALUE('coalesce(sp.sale_price_paise, b.sale_price_paise, p.sale_price_paise)'))})::bigint
               as value_sale_paise
        from stock_levels l
        join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
        left join batches b on b.tenant_id = l.tenant_id and b.id = l.batch_id
        left join store_product_prices sp
          on sp.tenant_id = l.tenant_id and sp.store_id = l.store_id and sp.product_id = l.product_id
       where l.tenant_id = ${ctx.tenantId} and ${inStores('l.store_id', scope)}
       group by l.product_id
    ),
    items as (
      select p.id as product_id, p.sku, p.name, p.name_ta, p.unit, p.pack_size, p.category_id,
             coalesce(pv.qty_milli, 0)::bigint as qty_milli,
             coalesce(pv.value_cost_paise, 0)::bigint as value_cost_paise,
             coalesce(pv.value_mrp_paise, 0)::bigint as value_mrp_paise,
             coalesce(pv.value_sale_paise, 0)::bigint as value_sale_paise
        from products p
        left join pv on pv.product_id = p.id
       where p.tenant_id = ${ctx.tenantId} and p.track_inventory and p.kind <> 'variant_parent'
         and (${q.include_zero ? sql`p.is_active` : sql`false`} or coalesce(pv.qty_milli, 0) <> 0)
         and ${inCategoryTree('p.category_id', ctx, q.category_id)}
         and ${eqOpt('p.brand_id', q.brand_id)}
         and ${search}
    )`
  const rowsSql =
    q.group_by === 'product'
      ? sql`rows as (
          select it.product_id as key_id, it.name, it.name_ta, c.name as category_name,
                 1::bigint as products, it.sku, it.unit, it.pack_size, it.qty_milli,
                 it.value_cost_paise, it.value_mrp_paise, it.value_sale_paise,
                 (case when it.qty_milli < 0 then 1 else 0 end)::bigint as negative_count
            from items it
            left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = it.category_id
        )`
      : sql`rows as (
          select it.category_id as key_id, coalesce(min(c.name), ${UNCATEGORISED.en}) as name,
                 case when it.category_id is null then ${UNCATEGORISED.ta} else min(c.name_ta) end
                   as name_ta,
                 null::text as category_name, count(*)::bigint as products,
                 null::text as sku, null::text as unit, null::int as pack_size,
                 null::bigint as qty_milli,
                 sum(it.value_cost_paise)::bigint as value_cost_paise,
                 sum(it.value_mrp_paise)::bigint as value_mrp_paise,
                 sum(it.value_sale_paise)::bigint as value_sale_paise,
                 count(*) filter (where it.qty_milli < 0)::bigint as negative_count
            from items it
            left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = it.category_id
           group by it.category_id
        )`
  const cte = sql`with recursive ${items}, ${rowsSql}`
  const totals = sql`select (select count(*) from items)::bigint as products,
      coalesce(sum(value_cost_paise), 0)::bigint as value_cost_paise,
      coalesce(sum(value_mrp_paise), 0)::bigint as value_mrp_paise,
      coalesce(sum(value_sale_paise), 0)::bigint as value_sale_paise,
      (select count(*) from items where qty_milli < 0)::bigint as negative_count
    from rows r`
  const order = orderBy(
    q.sort,
    {
      value_cost_paise: 'value_cost_paise',
      value_mrp_paise: 'value_mrp_paise',
      name: 'lower(name)',
      qty_milli: 'qty_milli',
    },
    'key_id nulls last',
  )
  const res = await runTabular<
    SummaryRaw,
    {
      products: number
      value_cost_paise: number
      value_mrp_paise: number
      value_sale_paise: number
      negative_count: number
    }
  >(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => {
    const qty = numOrNull(r.qty_milli)
    const pack = numOrNull(r.pack_size)
    const value = num(r.value_cost_paise)
    return {
      key_id: r.key_id,
      name: r.name,
      name_ta: r.name_ta,
      category_name: r.category_name,
      products: num(r.products),
      sku: r.sku,
      unit: r.unit,
      pack_size: pack,
      qty_milli: qty,
      avg_cost_paise:
        qty !== null && qty > 0 && pack !== null && value >= 0
          ? mulDiv(value, pack * 1000, qty)
          : null,
      value_cost_paise: value,
      value_mrp_paise: num(r.value_mrp_paise),
      value_sale_paise: num(r.value_sale_paise),
      negative_count: num(r.negative_count),
    }
  })
  const t = res.totals
  const totalsOut = {
    products: num(t.products),
    value_cost_paise: num(t.value_cost_paise),
    value_mrp_paise: num(t.value_mrp_paise),
    value_sale_paise: num(t.value_sale_paise),
    negative_count: num(t.negative_count),
  }
  const meta = reportMeta('stock-summary', env, scope, { as_of: env.today, group_by: q.group_by })
  return reportOutcome(tx, ctx, 'stock-summary', q, { ...res, rows, totals: totalsOut }, meta, {
    group_by: q.group_by,
    store_id: scope.storeId,
  })
}

// =============================================================================================
// Stock ageing
// =============================================================================================

interface AgeingRaw {
  product_id: string
  batch_id: string | null
  batch_no: string | null
  sku: string | null
  name: string
  name_ta: string | null
  category_name: string | null
  unit: string
  pack_size: number
  qty_milli: number
  value_cost_paise: number
  last_inbound_date: string | null
  age_days: number | null
  bucket: '0_30' | '31_60' | '61_90' | '90_plus' | null
}

const BUCKET_SQL = (days: string) => `(case when ${days} is null then null
  when ${days} <= 30 then '0_30' when ${days} <= 60 then '31_60'
  when ${days} <= 90 then '61_90' else '90_plus' end)`

export async function stockAgeing(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof StockAgeingQuerySchema>,
): Promise<ReportOutcome<StockAgeingResponse>> {
  const byBatch = q.group === 'batch'
  const batchCol = byBatch ? sql`l.batch_id` : sql`null::uuid`
  const mBatchCol = byBatch ? sql`m.batch_id` : sql`null::uuid`
  const cte = sql`with recursive
    lv as (
      select l.product_id, ${batchCol} as batch_id, sum(l.qty_milli)::bigint as qty_milli,
             sum(${sql.raw(VALUE('l.avg_cost_paise'))})::bigint as value_cost_paise
        from stock_levels l
        join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       where l.tenant_id = ${ctx.tenantId} and ${inStores('l.store_id', scope)}
         and p.track_inventory
         and ${inCategoryTree('p.category_id', ctx, q.category_id)}
       group by 1, 2
      having sum(l.qty_milli) > 0
    ),
    inbound as (
      select m.product_id, ${mBatchCol} as batch_id, max(m.created_at) as last_in
        from stock_movements m
       where m.tenant_id = ${ctx.tenantId} and m.movement_type in ${INBOUND_TYPES}
         and m.qty_milli > 0 and ${inStores('m.store_id', scope)}
         and m.product_id in (select product_id from lv)
       group by 1, 2
    ),
    aged as (
      select lv.product_id, lv.batch_id, b.batch_no, p.sku, p.name, p.name_ta, c.name as category_name,
             p.unit, p.pack_size, lv.qty_milli, lv.value_cost_paise,
             ${localDate('ib.last_in', env)} as last_inbound_date,
             case when ib.last_in is null then null
                  else greatest(0, ${env.today}::date - ${localDate('ib.last_in', env)}) end::int
               as age_days
        from lv
        join products p on p.tenant_id = ${ctx.tenantId} and p.id = lv.product_id
        left join batches b on b.tenant_id = ${ctx.tenantId} and b.id = lv.batch_id
        left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = p.category_id
        left join inbound ib on ib.product_id = lv.product_id
         and ib.batch_id is not distinct from lv.batch_id
    ),
    rows as (
      select aged.*, ${sql.raw(BUCKET_SQL('aged.age_days'))} as bucket from aged
       where ${q.bucket ? sql`${sql.raw(BUCKET_SQL('aged.age_days'))} = ${q.bucket}` : sql`true`}
    )`
  const totals = sql`select count(*)::bigint as rows,
      coalesce(sum(value_cost_paise), 0)::bigint as value_cost_paise,
      coalesce(sum(value_cost_paise) filter (where bucket = '0_30'), 0)::bigint as bucket_0_30_paise,
      coalesce(sum(value_cost_paise) filter (where bucket = '31_60'), 0)::bigint as bucket_31_60_paise,
      coalesce(sum(value_cost_paise) filter (where bucket = '61_90'), 0)::bigint as bucket_61_90_paise,
      coalesce(sum(value_cost_paise) filter (where bucket = '90_plus'), 0)::bigint as bucket_90_plus_paise
    from rows r`
  const order = orderBy(
    q.sort,
    { age_days: 'age_days', value_cost_paise: 'value_cost_paise', name: 'lower(name)' },
    'product_id, batch_id nulls first',
  )
  const res = await runTabular<
    AgeingRaw,
    {
      rows: number
      value_cost_paise: number
      bucket_0_30_paise: number
      bucket_31_60_paise: number
      bucket_61_90_paise: number
      bucket_90_plus_paise: number
    }
  >(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => {
    const age = numOrNull(r.age_days)
    return {
      product_id: r.product_id,
      batch_id: r.batch_id,
      batch_no: r.batch_no,
      sku: r.sku,
      name: r.name,
      name_ta: r.name_ta,
      category_name: r.category_name,
      unit: r.unit,
      pack_size: num(r.pack_size),
      qty_milli: num(r.qty_milli),
      value_cost_paise: num(r.value_cost_paise),
      last_inbound_date: r.last_inbound_date,
      age_days: age,
      bucket: age === null ? null : ageingBucket(age),
    }
  })
  const t = res.totals
  const totalsOut = {
    rows: num(t.rows),
    value_cost_paise: num(t.value_cost_paise),
    bucket_0_30_paise: num(t.bucket_0_30_paise),
    bucket_31_60_paise: num(t.bucket_31_60_paise),
    bucket_61_90_paise: num(t.bucket_61_90_paise),
    bucket_90_plus_paise: num(t.bucket_90_plus_paise),
  }
  const meta = reportMeta('stock-ageing', env, scope, { as_of: env.today, group_by: q.group })
  return reportOutcome(tx, ctx, 'stock-ageing', q, { ...res, rows, totals: totalsOut }, meta, {
    group: q.group,
    bucket: q.bucket ?? null,
    store_id: scope.storeId,
  })
}

// =============================================================================================
// Expiry
// =============================================================================================

interface ExpiryRaw {
  batch_id: string
  batch_no: string
  product_id: string
  sku: string | null
  name: string
  name_ta: string | null
  category_name: string | null
  unit: string
  pack_size: number
  store_id: string
  store_name: string
  expiry_date: string
  days_to_expiry: number
  status: 'expired' | 'expiring'
  qty_milli: number
  value_cost_paise: number
  value_mrp_paise: number
  supplier_id: string | null
  supplier_name: string | null
}

export async function expiry(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof ExpiryQuerySchema>,
): Promise<ReportOutcome<ExpiryResponse>> {
  const days = q.days ?? env.settings.inventory.expiry_warning_days
  const until = addDays(env.today, days)
  const window = q.include_expired
    ? sql`b.expiry_date <= ${until}::date`
    : sql`b.expiry_date >= ${env.today}::date and b.expiry_date <= ${until}::date`
  const cte = sql`with recursive
    lv as (
      select l.store_id, l.product_id, l.batch_id, sum(l.qty_milli)::bigint as qty_milli,
             sum(${sql.raw(VALUE('l.avg_cost_paise'))})::bigint as value_cost_paise,
             sum(${sql.raw(VALUE('coalesce(b.mrp_paise, p.mrp_paise, 0)'))})::bigint as value_mrp_paise
        from stock_levels l
        join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
        join batches b on b.tenant_id = l.tenant_id and b.id = l.batch_id
       where l.tenant_id = ${ctx.tenantId} and l.batch_id is not null
         and ${inStores('l.store_id', scope)}
         and b.expiry_date is not null and ${window}
         and ${inCategoryTree('p.category_id', ctx, q.category_id)}
         and ${eqOpt('b.supplier_id', q.supplier_id)}
       group by l.store_id, l.product_id, l.batch_id
      having sum(l.qty_milli) > 0
    ),
    rows as (
      select b.id as batch_id, b.batch_no, p.id as product_id, p.sku, p.name, p.name_ta,
             c.name as category_name, p.unit, p.pack_size, st.id as store_id, st.name as store_name,
             b.expiry_date, (b.expiry_date - ${env.today}::date)::int as days_to_expiry,
             case when b.expiry_date < ${env.today}::date then 'expired' else 'expiring' end as status,
             lv.qty_milli, lv.value_cost_paise, lv.value_mrp_paise,
             b.supplier_id, s.name as supplier_name
        from lv
        join batches b on b.tenant_id = ${ctx.tenantId} and b.id = lv.batch_id
        join products p on p.tenant_id = ${ctx.tenantId} and p.id = lv.product_id
        join stores st on st.tenant_id = ${ctx.tenantId} and st.id = lv.store_id
        left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = p.category_id
        left join suppliers s on s.tenant_id = ${ctx.tenantId} and s.id = b.supplier_id
    )`
  const totals = sql`select
      count(*) filter (where status = 'expired')::bigint as expired_count,
      coalesce(sum(value_cost_paise) filter (where status = 'expired'), 0)::bigint
        as expired_value_cost_paise,
      count(*) filter (where status = 'expiring')::bigint as expiring_count,
      coalesce(sum(value_cost_paise) filter (where status = 'expiring'), 0)::bigint
        as expiring_value_cost_paise,
      coalesce(sum(value_cost_paise), 0)::bigint as value_cost_paise,
      coalesce(sum(value_mrp_paise), 0)::bigint as value_mrp_paise
    from rows r`
  const order = orderBy(
    q.sort,
    { expiry_date: 'expiry_date', value_cost_paise: 'value_cost_paise', name: 'lower(name)' },
    'batch_id, store_id',
  )
  const res = await runTabular<
    ExpiryRaw,
    {
      expired_count: number
      expired_value_cost_paise: number
      expiring_count: number
      expiring_value_cost_paise: number
      value_cost_paise: number
      value_mrp_paise: number
    }
  >(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => ({
    ...r,
    pack_size: num(r.pack_size),
    days_to_expiry: num(r.days_to_expiry),
    qty_milli: num(r.qty_milli),
    value_cost_paise: num(r.value_cost_paise),
    value_mrp_paise: num(r.value_mrp_paise),
  }))
  const t = res.totals
  const totalsOut = {
    expired_count: num(t.expired_count),
    expired_value_cost_paise: num(t.expired_value_cost_paise),
    expiring_count: num(t.expiring_count),
    expiring_value_cost_paise: num(t.expiring_value_cost_paise),
    value_cost_paise: num(t.value_cost_paise),
    value_mrp_paise: num(t.value_mrp_paise),
  }
  const meta = reportMeta('expiry', env, scope, { as_of: env.today, from: env.today, to: until })
  return reportOutcome(tx, ctx, 'expiry', q, { ...res, rows, totals: totalsOut }, meta, {
    days,
    include_expired: q.include_expired,
    store_id: scope.storeId,
  })
}

// =============================================================================================
// Dead stock
// =============================================================================================

interface DeadRaw {
  product_id: string
  sku: string | null
  name: string
  name_ta: string | null
  category_name: string | null
  unit: string
  pack_size: number
  qty_milli: number
  value_cost_paise: number
  last_sold_date: string | null
  days_since_last_sale: number | null
  last_inbound_date: string | null
}

export async function deadStock(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof DeadStockQuerySchema>,
): Promise<ReportOutcome<DeadStockResponse>> {
  // No sale in the last `days` days = the last sale is before today − days + 1.
  const sinceDate = addDays(env.today, -(q.days - 1))
  const minValue =
    q.min_value_paise === undefined ? sql`true` : sql`lv.value_cost_paise >= ${q.min_value_paise}`
  const cte = sql`with recursive
    lv as (
      select l.product_id, sum(l.qty_milli)::bigint as qty_milli,
             sum(${sql.raw(VALUE('l.avg_cost_paise'))})::bigint as value_cost_paise
        from stock_levels l
        join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       where l.tenant_id = ${ctx.tenantId} and ${inStores('l.store_id', scope)}
         and p.track_inventory
         and ${inCategoryTree('p.category_id', ctx, q.category_id)}
       group by l.product_id
      having sum(l.qty_milli) > 0
    ),
    sold as (
      select sl.product_id, max(i.invoice_date) as last_sold
        from sales_invoice_lines sl
        join sales_invoices i on i.tenant_id = sl.tenant_id and i.id = sl.invoice_id
       where sl.tenant_id = ${ctx.tenantId} and i.status = 'completed' and i.doc_type <> 'estimate'
         and ${inStores('i.store_id', scope)}
         and sl.product_id in (select product_id from lv)
       group by sl.product_id
    ),
    inbound as (
      select m.product_id, max(m.created_at) as last_in
        from stock_movements m
       where m.tenant_id = ${ctx.tenantId} and m.movement_type in ${INBOUND_TYPES}
         and m.qty_milli > 0 and ${inStores('m.store_id', scope)}
         and m.product_id in (select product_id from lv)
       group by m.product_id
    ),
    rows as (
      select p.id as product_id, p.sku, p.name, p.name_ta, c.name as category_name, p.unit,
             p.pack_size, lv.qty_milli, lv.value_cost_paise, sold.last_sold as last_sold_date,
             (${env.today}::date - sold.last_sold)::int as days_since_last_sale,
             ${localDate('ib.last_in', env)} as last_inbound_date
        from lv
        join products p on p.tenant_id = ${ctx.tenantId} and p.id = lv.product_id
        left join categories c on c.tenant_id = ${ctx.tenantId} and c.id = p.category_id
        left join sold on sold.product_id = lv.product_id
        left join inbound ib on ib.product_id = lv.product_id
       where (sold.last_sold is null or sold.last_sold < ${sinceDate}::date)
         and ${minValue}
    )`
  const totals = sql`select count(*)::bigint as products,
      coalesce(sum(value_cost_paise), 0)::bigint as value_cost_paise from rows r`
  const order = orderBy(
    q.sort,
    {
      value_cost_paise: 'value_cost_paise',
      days_since_last_sale: 'coalesce(days_since_last_sale, 1000000)',
      name: 'lower(name)',
    },
    'product_id',
  )
  const res = await runTabular<DeadRaw, { products: number; value_cost_paise: number }>(
    tx,
    { cte, order, totals },
    q,
  )
  const rows = res.rows.map((r) => ({
    ...r,
    pack_size: num(r.pack_size),
    qty_milli: num(r.qty_milli),
    value_cost_paise: num(r.value_cost_paise),
    days_since_last_sale: numOrNull(r.days_since_last_sale),
  }))
  const totalsOut = {
    products: num(res.totals.products),
    value_cost_paise: num(res.totals.value_cost_paise),
  }
  const meta = reportMeta('dead-stock', env, scope, {
    as_of: env.today,
    from: sinceDate,
    to: env.today,
  })
  return reportOutcome(tx, ctx, 'dead-stock', q, { ...res, rows, totals: totalsOut }, meta, {
    days: q.days,
    store_id: scope.storeId,
  })
}
