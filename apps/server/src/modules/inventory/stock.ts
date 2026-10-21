/**
 * Stock levels: GET /stock (per product or per batch for a store or all stores, value at average
 * cost and at MRP, status flags, filters, sort, pagination, totals over the whole filtered result,
 * CSV export) and GET /stock/products/:productId (per store and batch + the last 20 movements).
 *
 * Values follow the pack-pricing rule per stock row — round(avg_cost × qty / (pack_size × 1000)),
 * i.e. amountForQty(avg_cost, qty, pack_size) — and are summed over rows, so a product's value is
 * the sum of its batches' values. The average cost of aggregated rows is weighted by the positive
 * quantities (the row's own average when nothing is in stock, the purchase price when the product
 * never moved).
 */
import { type RawBuilder, sql } from 'kysely'
import { milliToDecimalString, paiseToRupeesString } from '@kadai/shared'
import { toCsv, type CsvValue } from '@kadai/shared/api/identity'
import {
  type BatchStock,
  INVENTORY_EXPORT_MAX_ROWS,
  type ProductStock,
  STOCK_STATUS_LABELS,
  type StockListQuerySchema,
  type StockListResponse,
  type StockRow,
  type StockStatus,
  type StockTotals,
  expiryStatus,
  stockStatus,
  stockValuePaise,
} from '@kadai/shared/api/inventory'
import type { z } from 'zod'
import { assertStoreAccess, type PageParams } from '../../core/http'
import { notFound } from '../../core/errors'
import { getSettings } from '../../core/settings'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  type StoreScope,
  andAll,
  businessToday,
  iso,
  likePattern,
  loadStore,
  memberStoresSql,
  reasonError,
  storeScopeSql,
} from './common'
import { movementRows } from './movements'

type StockListQuery = z.output<typeof StockListQuerySchema>

interface StockSqlRow {
  store_id: string | null
  product_id: string
  sku: string | null
  name: string
  name_ta: string | null
  unit: string
  pack_size: number
  allow_loose: boolean
  track_batches: boolean
  category_id: string | null
  category_name: string | null
  brand_name: string | null
  batch_id: string | null
  batch_no: string | null
  expiry_date: string | null
  qty_milli: number
  avg_cost_paise: number
  value_cost_paise: number
  mrp_paise: number | null
  value_mrp_paise: number | null
  sale_price_paise: number
  reorder_level_milli: number | null
  reorder_qty_milli: number | null
  status: StockStatus
  batch_count: number
  nearest_expiry: string | null
  last_movement_at: Date | null
}

/** Product filters shared by the stock list and its totals (alias p = products). */
function productConditions(ctx: Ctx, q: StockListQuery, group: 'product' | 'batch') {
  const conds: RawBuilder<unknown>[] = [
    sql`p.tenant_id = ${ctx.tenantId}`,
    sql`p.track_inventory`,
    sql`p.kind <> 'variant_parent'`,
  ]
  if (!q.include_inactive) conds.push(sql`p.is_active`)
  if (q.q) {
    const like = likePattern(q.q)
    conds.push(sql`(p.search_text like ${like} or lower(coalesce(p.sku, '')) = ${q.q.toLowerCase()}
      or exists (select 1 from product_barcodes pb
                  where pb.tenant_id = p.tenant_id and pb.product_id = p.id and pb.barcode = ${q.q})
      ${group === 'batch' ? sql`or lower(b.batch_no) like ${like}` : sql``})`)
  }
  if (q.category_id) {
    conds.push(sql`p.category_id in (
      with recursive tree(id) as (
        select id from categories where tenant_id = ${ctx.tenantId} and id = ${q.category_id}::uuid
        union
        select c.id from categories c join tree on c.parent_id = tree.id
         where c.tenant_id = ${ctx.tenantId})
      select id from tree)`)
  }
  if (q.brand_id) conds.push(sql`p.brand_id = ${q.brand_id}::uuid`)
  if (q.track_batches !== undefined) conds.push(sql`p.track_batches = ${q.track_batches}`)
  return andAll(conds)
}

const STATUS_SQL = (qty: RawBuilder<unknown>) => sql`(case
  when ${qty} < 0 then 'negative'
  when ${qty} = 0 then 'out'
  when p.reorder_level_milli is not null and ${qty} <= p.reorder_level_milli then 'low'
  else 'ok' end)`

/** The stock rows CTE (`rows`) for a scope and grouping, with every product filter applied. */
function stockRowsCte(ctx: Ctx, scope: StoreScope, q: StockListQuery): RawBuilder<unknown> {
  const storeExpr = scope.kind === 'single' ? sql`${scope.storeId}::uuid` : sql`null::uuid`
  const levels = sql`
    lv as (
      select l.product_id, l.batch_id, l.qty_milli, l.avg_cost_paise, l.last_movement_at,
             b.expiry_date,
             round(l.avg_cost_paise::numeric * l.qty_milli / (lp.pack_size * 1000))::bigint as value_cost,
             case when coalesce(b.mrp_paise, lp.mrp_paise) is null then null
                  else round(coalesce(b.mrp_paise, lp.mrp_paise)::numeric * l.qty_milli
                             / (lp.pack_size * 1000))::bigint end as value_mrp
        from stock_levels l
        join products lp on lp.tenant_id = l.tenant_id and lp.id = l.product_id
        left join batches b on b.tenant_id = l.tenant_id and b.id = l.batch_id
       where l.tenant_id = ${ctx.tenantId}
         and ${storeScopeSql(sql`l.store_id`, scope)}
         and ${memberStoresSql(sql`l.store_id`, ctx)}
    )`
  const aggCols = sql`
    sum(lv.qty_milli)::bigint as qty_milli,
    coalesce(sum(lv.avg_cost_paise::numeric * lv.qty_milli) filter (where lv.qty_milli > 0), 0) as wsum,
    coalesce(sum(lv.qty_milli) filter (where lv.qty_milli > 0), 0)::bigint as wqty,
    max(lv.avg_cost_paise) filter (where lv.last_movement_at is not null) as hist_avg,
    sum(lv.value_cost)::bigint as value_cost,
    sum(lv.value_mrp)::bigint as value_mrp,
    count(*) filter (where lv.batch_id is not null and lv.qty_milli <> 0)::bigint as batch_count,
    min(lv.expiry_date) filter (where lv.qty_milli > 0) as nearest_expiry,
    max(lv.last_movement_at) as last_movement_at`
  const avgExpr = sql`(case when a.wqty > 0 then round(a.wsum / a.wqty)
                            else coalesce(a.hist_avg, p.purchase_price_paise) end)::bigint`
  const common = sql`
    ${storeExpr} as store_id, p.id as product_id, p.sku, p.name, p.name_ta, p.unit, p.pack_size,
    p.allow_loose, p.track_batches, p.category_id, c.name as category_name, br.name as brand_name,
    p.reorder_level_milli, p.reorder_qty_milli`
  const joins = sql`
    left join categories c on c.tenant_id = p.tenant_id and c.id = p.category_id
    left join brands br on br.tenant_id = p.tenant_id and br.id = p.brand_id`

  if (q.group === 'batch') {
    return sql`with ${levels},
      agg as (select lv.product_id, lv.batch_id, ${aggCols} from lv group by lv.product_id, lv.batch_id),
      rows as (
        select ${common}, a.batch_id, b.batch_no, b.expiry_date,
               a.qty_milli, ${avgExpr} as avg_cost_paise, coalesce(a.value_cost, 0)::bigint as value_cost_paise,
               coalesce(b.mrp_paise, p.mrp_paise) as mrp_paise, a.value_mrp as value_mrp_paise,
               coalesce(b.sale_price_paise, p.sale_price_paise) as sale_price_paise,
               a.batch_count, a.nearest_expiry, a.last_movement_at,
               ${STATUS_SQL(sql`a.qty_milli`)} as status
          from agg a
          join products p on p.tenant_id = ${ctx.tenantId} and p.id = a.product_id
          left join batches b on b.tenant_id = p.tenant_id and b.id = a.batch_id
          ${joins}
         where ${productConditions(ctx, q, 'batch')}
      )`
  }
  return sql`with ${levels},
    agg as (select lv.product_id, ${aggCols} from lv group by lv.product_id),
    rows as (
      select ${common}, null::uuid as batch_id, null::text as batch_no, null::date as expiry_date,
             coalesce(a.qty_milli, 0)::bigint as qty_milli, ${avgExpr} as avg_cost_paise,
             coalesce(a.value_cost, 0)::bigint as value_cost_paise,
             p.mrp_paise,
             (case when a.product_id is null then (case when p.mrp_paise is null then null else 0 end)
                   else a.value_mrp end)::bigint as value_mrp_paise,
             p.sale_price_paise,
             coalesce(a.batch_count, 0)::bigint as batch_count, a.nearest_expiry, a.last_movement_at,
             ${STATUS_SQL(sql`coalesce(a.qty_milli, 0)`)} as status
        from products p
        left join agg a on a.product_id = p.id
        ${joins}
       where ${productConditions(ctx, q, 'product')}
    )`
}

/** Status filters on the `rows` CTE. */
function statusConditions(q: StockListQuery): RawBuilder<unknown> {
  const conds: RawBuilder<unknown>[] = []
  if (q.low_stock === true) conds.push(sql`status = 'low'`)
  if (q.out_of_stock === true) conds.push(sql`qty_milli <= 0`)
  if (q.in_stock === true) conds.push(sql`qty_milli > 0`)
  return andAll(conds)
}

function orderBy(q: StockListQuery): RawBuilder<unknown> {
  const dir = q.sort.direction === 'asc' ? sql`asc` : sql`desc`
  const tail = sql`name asc, product_id asc, batch_id asc nulls first`
  switch (q.sort.field) {
    case 'qty':
      return sql`qty_milli ${dir}, ${tail}`
    case 'value':
      return sql`value_cost_paise ${dir}, ${tail}`
    case 'sku':
      return sql`sku ${dir} nulls last, ${tail}`
    case 'last_movement_at':
      return sql`last_movement_at ${dir} nulls last, ${tail}`
    case 'expiry':
      return q.group === 'batch'
        ? sql`expiry_date ${dir} nulls last, ${tail}`
        : sql`nearest_expiry ${dir} nulls last, ${tail}`
    case 'name':
      return sql`name ${dir}, product_id asc, batch_id asc nulls first`
  }
}

function toStockRow(r: StockSqlRow): StockRow {
  return {
    ...r,
    // Weighted averages are ≥ 0; a negative row average cannot exist (costs are ≥ 0).
    avg_cost_paise: Math.max(0, r.avg_cost_paise),
    last_movement_at: r.last_movement_at === null ? null : iso(r.last_movement_at),
  }
}

async function stockTotals(
  tx: Tx,
  cte: RawBuilder<unknown>,
  status: RawBuilder<unknown>,
): Promise<StockTotals> {
  const res = await sql<StockTotals>`${cte}
    select count(*)::bigint as item_count,
           coalesce(sum(value_cost_paise), 0)::bigint as value_cost_paise,
           coalesce(sum(value_mrp_paise), 0)::bigint as value_mrp_paise,
           count(*) filter (where status = 'low')::bigint as low_stock_count,
           count(*) filter (where status = 'out')::bigint as out_of_stock_count,
           count(*) filter (where status = 'negative')::bigint as negative_count
      from rows where ${status}`.execute(tx)
  const t = res.rows[0]
  return {
    item_count: Number(t?.item_count ?? 0),
    value_cost_paise: Number(t?.value_cost_paise ?? 0),
    value_mrp_paise: Number(t?.value_mrp_paise ?? 0),
    low_stock_count: Number(t?.low_stock_count ?? 0),
    out_of_stock_count: Number(t?.out_of_stock_count ?? 0),
    negative_count: Number(t?.negative_count ?? 0),
  }
}

/** GET /stock (JSON): a page of rows plus totals over the whole filtered result. */
export async function listStock(
  tx: Tx,
  ctx: Ctx,
  scope: StoreScope,
  q: StockListQuery,
  page: PageParams,
): Promise<StockListResponse> {
  const cte = stockRowsCte(ctx, scope, q)
  const status = statusConditions(q)
  const res = await sql<StockSqlRow>`${cte}
    select * from rows where ${status}
     order by ${orderBy(q)}
     limit ${page.limit} offset ${page.offset}`.execute(tx)
  const totals = await stockTotals(tx, cte, status)
  return {
    data: res.rows.map(toStockRow),
    page: { limit: page.limit, offset: page.offset, total: totals.item_count },
    totals,
  }
}

const CSV_HEADERS = {
  en: [
    'SKU',
    'Product',
    'Category',
    'Brand',
    'Batch',
    'Expiry',
    'Quantity',
    'Unit',
    'Pack size',
    'Avg cost (Rs)',
    'Value at cost (Rs)',
    'MRP (Rs)',
    'Value at MRP (Rs)',
    'Reorder level',
    'Status',
  ],
  ta: [
    'SKU',
    'பொருள்',
    'வகை',
    'பிராண்ட்',
    'பேட்ச்',
    'காலாவதி',
    'அளவு',
    'அலகு',
    'பேக் அளவு',
    'சராசரி அடக்க விலை (ரூ)',
    'அடக்க மதிப்பு (ரூ)',
    'MRP (ரூ)',
    'MRP மதிப்பு (ரூ)',
    'மறு ஆர்டர் அளவு',
    'நிலை',
  ],
} as const

/** GET /stock?format=csv — the whole filtered result (≤ INVENTORY_EXPORT_MAX_ROWS rows). */
export async function stockCsv(
  tx: Tx,
  ctx: Ctx,
  scope: StoreScope,
  q: StockListQuery,
): Promise<{ csv: string; rows: number; totals: StockTotals }> {
  const cte = stockRowsCte(ctx, scope, q)
  const status = statusConditions(q)
  const res = await sql<StockSqlRow>`${cte}
    select * from rows where ${status} order by ${orderBy(q)}
     limit ${INVENTORY_EXPORT_MAX_ROWS + 1}`.execute(tx)
  if (res.rows.length > INVENTORY_EXPORT_MAX_ROWS) {
    throw reasonError(
      'UNPROCESSABLE',
      'export_too_large',
      `More than ${String(INVENTORY_EXPORT_MAX_ROWS)} stock rows match; narrow the filters`,
      { max_rows: INVENTORY_EXPORT_MAX_ROWS },
    )
  }
  const locale = ctx.locale
  const lines: CsvValue[][] = [[...CSV_HEADERS[locale]]]
  for (const raw of res.rows) {
    const r = toStockRow(raw)
    lines.push([
      r.sku,
      locale === 'ta' && r.name_ta ? r.name_ta : r.name,
      r.category_name,
      r.brand_name,
      r.batch_no,
      r.expiry_date,
      milliToDecimalString(r.qty_milli),
      r.unit,
      r.pack_size,
      paiseToRupeesString(r.avg_cost_paise),
      paiseToRupeesString(r.value_cost_paise),
      r.mrp_paise === null ? null : paiseToRupeesString(r.mrp_paise),
      r.value_mrp_paise === null ? null : paiseToRupeesString(r.value_mrp_paise),
      r.reorder_level_milli === null ? null : milliToDecimalString(r.reorder_level_milli),
      STOCK_STATUS_LABELS[r.status][locale],
    ])
  }
  return { csv: toCsv(lines), rows: res.rows.length, totals: await stockTotals(tx, cte, status) }
}

// ---------------------------------------------------------------------------------------------
// GET /stock/products/:productId
// ---------------------------------------------------------------------------------------------

/** Weighted average cost per pack of stock rows (positive quantities), with fallbacks. */
export function weightedAverage(
  rows: readonly { qty_milli: number; avg_cost_paise: number; has_history: boolean }[],
  fallback: number,
): number {
  let qty = 0n
  let sum = 0n
  for (const r of rows) {
    if (r.qty_milli <= 0) continue
    qty += BigInt(r.qty_milli)
    sum += BigInt(r.qty_milli) * BigInt(r.avg_cost_paise)
  }
  if (qty > 0n) return Number((sum * 2n + qty) / (qty * 2n))
  const moved = rows.filter((r) => r.has_history)
  return moved.length ? Math.max(...moved.map((r) => r.avg_cost_paise)) : fallback
}

export async function productStock(
  tx: Tx,
  ctx: Ctx,
  productId: string,
  storeId: string | undefined,
): Promise<ProductStock> {
  const product = await tx
    .selectFrom('products')
    .select([
      'id',
      'sku',
      'name',
      'name_ta',
      'unit',
      'pack_size',
      'allow_loose',
      'track_inventory',
      'track_batches',
      'reorder_level_milli',
      'reorder_qty_milli',
      'mrp_paise',
      'sale_price_paise',
      'purchase_price_paise',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', productId)
    .executeTakeFirst()
  if (!product) throw notFound('product', productId)

  let stores: { id: string; code: string; name: string }[]
  if (storeId) {
    assertStoreAccess(ctx, storeId)
    const s = await loadStore(tx, ctx, storeId)
    stores = [{ id: s.id, code: s.code, name: s.name }]
  } else {
    let sq = tx
      .selectFrom('stores as s')
      .select(['s.id', 's.code', 's.name'])
      .where('s.tenant_id', '=', ctx.tenantId)
      .where((eb) =>
        eb.or([
          eb('s.is_active', '=', true),
          eb.exists(
            eb
              .selectFrom('stock_levels as l')
              .select('l.id')
              .whereRef('l.tenant_id', '=', 's.tenant_id')
              .whereRef('l.store_id', '=', 's.id')
              .where('l.product_id', '=', productId)
              .where('l.qty_milli', '<>', 0),
          ),
        ]),
      )
    if (ctx.storeIds !== null) {
      sq = ctx.storeIds.length
        ? sq.where('s.id', 'in', [...ctx.storeIds])
        : sq.where(sql<boolean>`false`)
    }
    stores = await sq.orderBy('s.code').execute()
  }
  const storeIds = stores.map((s) => s.id)

  const levels = storeIds.length
    ? await tx
        .selectFrom('stock_levels as l')
        .leftJoin('batches as b', (j) =>
          j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.batch_id'),
        )
        .select([
          'l.store_id',
          'l.batch_id',
          'l.qty_milli',
          'l.avg_cost_paise',
          'l.last_movement_at',
          'b.batch_no',
          'b.expiry_date',
          'b.mfg_date',
          'b.mrp_paise',
          'b.sale_price_paise',
          'b.purchase_price_paise as batch_cost',
        ])
        .where('l.tenant_id', '=', ctx.tenantId)
        .where('l.product_id', '=', productId)
        .where('l.store_id', 'in', storeIds)
        .execute()
    : []

  const settings = await getSettings(tx, ctx)
  const { today } = await businessToday(tx, ctx)
  const warn = settings.inventory.expiry_warning_days

  const out: ProductStock['stores'] = stores.map((s) => {
    const rows = levels
      .filter((l) => l.store_id === s.id)
      .map((l) => ({ ...l, has_history: l.last_movement_at !== null }))
    const qty = rows.reduce((acc, r) => acc + r.qty_milli, 0)
    const value = rows.reduce(
      (acc, r) => acc + stockValuePaise(r.avg_cost_paise, r.qty_milli, product.pack_size),
      0,
    )
    const batches: BatchStock[] = rows
      .filter((r) => r.qty_milli !== 0)
      .sort((a, b) => {
        const ea = a.expiry_date ?? '9999-12-31'
        const eb = b.expiry_date ?? '9999-12-31'
        return ea === eb ? (a.batch_no ?? '').localeCompare(b.batch_no ?? '') : ea < eb ? -1 : 1
      })
      .map((r) => {
        const exp = expiryStatus(r.expiry_date, today, warn)
        const cost = r.has_history
          ? r.avg_cost_paise
          : (r.batch_cost ?? product.purchase_price_paise)
        return {
          batch_id: r.batch_id,
          batch_no: r.batch_no,
          expiry_date: r.expiry_date,
          mfg_date: r.mfg_date,
          mrp_paise: r.batch_id ? r.mrp_paise : product.mrp_paise,
          sale_price_paise: r.batch_id ? r.sale_price_paise : product.sale_price_paise,
          qty_milli: r.qty_milli,
          avg_cost_paise: cost,
          value_cost_paise: stockValuePaise(r.avg_cost_paise, r.qty_milli, product.pack_size),
          expiry_status: exp.status,
          days_to_expiry: exp.days_to_expiry,
        }
      })
    return {
      store_id: s.id,
      store_code: s.code,
      store_name: s.name,
      qty_milli: qty,
      avg_cost_paise: weightedAverage(rows, product.purchase_price_paise),
      value_cost_paise: value,
      status: stockStatus(qty, product.reorder_level_milli),
      batches,
    }
  })

  const recent = storeIds.length
    ? await movementRows(
        tx,
        ctx,
        sql`m.product_id = ${productId}::uuid and m.store_id = any(${storeIds}::uuid[])`,
        { limit: 20, newestFirst: true },
      )
    : []

  return {
    product,
    stores: out,
    total_qty_milli: out.reduce((a, s) => a + s.qty_milli, 0),
    total_value_cost_paise: out.reduce((a, s) => a + s.value_cost_paise, 0),
    recent_movements: recent,
  }
}
