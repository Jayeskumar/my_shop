/**
 * GET /purchases/reorder-suggestions?store_id= — products at / below their reorder level at a
 * store (or exactly the requested product_ids), with stock, open purchase orders and the last
 * supplier. Without lead_time_days the suggested quantity is the classic
 * max(reorder_qty, 2 × reorder_level − stock) over a 30-day average.
 *
 * With lead_time_days (StockSense) the same list forecasts demand (7- or 30-day moving average,
 * optionally by weekday, or backtested smart model), subtracts usable stock and incoming orders,
 * caps by shelf life, rounds to the pack, and ranks by stockout urgency then margin. Products
 * that will run out before delivery are included even when they are still above the reorder
 * level. Sales history is the stock-movement ledger plus rows imported to demand_history (those
 * imports do not change stock).
 */
import { sql } from 'kysely'
import {
  SMART_FORECAST_HISTORY_DAYS,
  type SmartForecast,
  addDays,
  amountForQty,
  dayOfWeek,
  instantRangeForDates,
  smartForecast,
} from '@kadai/shared'
import {
  REORDER_SALES_WINDOW_DAYS,
  STOCKSENSE_DEFAULT_LEAD_TIME_DAYS,
  type ReorderItem,
  type ReorderSuggestions,
  type ReorderSuggestionsQuerySchema,
  averageDailySalesMilli,
  compareReorderRank,
  explainReorder,
  forecastDemandMilli,
  marginBp,
  planStockSense,
} from '@kadai/shared/api/purchases'
import type { z } from 'zod'
import type { Tx } from '../../db/tenant'
import { type Ctx, businessToday, iso, lastPurchases, loadStore } from './common'
import { likePattern } from './orders'

type ReorderQuery = z.output<typeof ReorderSuggestionsQuerySchema>

/** Upper bound of products considered in one request. */
const MAX_ITEMS = 2000

export async function reorderSuggestions(
  tx: Tx,
  ctx: Ctx,
  q: ReorderQuery,
): Promise<ReorderSuggestions> {
  const store = await loadStore(tx, ctx, q.store_id)
  const cal = await businessToday(tx, ctx)
  const t = ctx.tenantId
  const forecastMode = q.lead_time_days != null
  const leadTime = q.lead_time_days ?? STOCKSENSE_DEFAULT_LEAD_TIME_DAYS
  const windowDays = forecastMode ? (q.window_days ?? 7) : REORDER_SALES_WINDOW_DAYS
  const weekdayAdjusted = forecastMode && (q.weekday_adjust ?? true)
  // Smart (default): per-product model chosen by backtest over a longer history.
  const smart = forecastMode && (q.model ?? 'smart') === 'smart'
  const historyDays = smart ? SMART_FORECAST_HISTORY_DAYS : windowDays
  const deliveryDate = addDays(cal.today, leadTime)

  let qb = tx
    .selectFrom('products as p')
    .leftJoin(
      (eb) =>
        eb
          .selectFrom('stock_levels')
          .select(['product_id', sql<number>`sum(qty_milli)::bigint`.as('qty')])
          .where('tenant_id', '=', t)
          .where('store_id', '=', store.id)
          .groupBy('product_id')
          .as('st'),
      (j) => j.onRef('st.product_id', '=', 'p.id'),
    )
    .select([
      'p.id',
      'p.name',
      'p.name_ta',
      'p.sku',
      'p.unit',
      'p.pack_size',
      'p.category_id',
      'p.gst_rate_bp',
      'p.cess_rate_bp',
      'p.price_includes_tax',
      'p.sale_price_paise',
      'p.purchase_price_paise',
      'p.reorder_level_milli',
      'p.reorder_qty_milli',
      'p.attributes',
      sql<number>`coalesce(st.qty, 0)::bigint`.as('stock_milli'),
    ])
    .where('p.tenant_id', '=', t)
    .where('p.is_active', '=', true)
    .where('p.track_inventory', '=', true)
    .where('p.kind', 'in', ['standard', 'variant'])
  if (q.product_ids?.length) {
    qb = qb.where('p.id', 'in', q.product_ids)
  } else if (!forecastMode) {
    qb = qb
      .where('p.reorder_level_milli', 'is not', null)
      .where(sql<boolean>`coalesce(st.qty, 0) <= p.reorder_level_milli`)
  }
  if (q.category_id) {
    qb = qb.where(
      sql<boolean>`p.category_id in (
        with recursive tree(id) as (
          select id from categories where tenant_id = ${t} and id = ${q.category_id}
          union all
          select c.id from categories c join tree on c.parent_id = tree.id where c.tenant_id = ${t}
        ) select id from tree)`,
    )
  }
  if (q.q) {
    const pattern = likePattern(q.q)
    qb = qb.where((eb) =>
      eb.or([
        eb('p.name', 'ilike', pattern),
        eb('p.name_ta', 'ilike', pattern),
        eb('p.sku', 'ilike', pattern),
        eb('p.search_text', 'ilike', pattern),
      ]),
    )
  }
  const products = await qb.orderBy('p.name').orderBy('p.id').limit(MAX_ITEMS).execute()
  const ids = products.map((p) => p.id)

  const windowStart = addDays(cal.today, -(historyDays - 1))
  const window = instantRangeForDates(windowStart, cal.today, cal.timezone)
  const saleDate = sql<string>`(created_at AT TIME ZONE ${cal.timezone})::date`
  const [sales, saleDays, imported, stockSplit, openPo, last] = await Promise.all([
    ids.length && !forecastMode
      ? tx
          .selectFrom('stock_movements')
          .select(['product_id', sql<number>`(-sum(qty_milli))::bigint`.as('sold')])
          .where('tenant_id', '=', t)
          .where('store_id', '=', store.id)
          .where('product_id', 'in', ids)
          .where('movement_type', 'in', ['sale', 'sale_return', 'sale_cancel'])
          .where('created_at', '>=', window.start)
          .where('created_at', '<', window.end)
          .groupBy('product_id')
          .execute()
      : Promise.resolve([]),
    ids.length && forecastMode
      ? tx
          .selectFrom('stock_movements')
          .select([
            'product_id',
            saleDate.as('sale_date'),
            sql<number>`(-sum(qty_milli))::bigint`.as('sold'),
          ])
          .where('tenant_id', '=', t)
          .where('store_id', '=', store.id)
          .where('product_id', 'in', ids)
          .where('movement_type', 'in', ['sale', 'sale_return', 'sale_cancel'])
          .where('created_at', '>=', window.start)
          .where('created_at', '<', window.end)
          // By the output column: saleDate's timezone is a bind parameter, so repeating the
          // expression here would bind it again and Postgres would not match the two.
          .groupBy(['product_id', sql`sale_date`])
          .execute()
      : Promise.resolve([]),
    ids.length && forecastMode
      ? tx
          .selectFrom('demand_history')
          .select(['product_id', 'sale_date', sql<number>`sum(qty_milli)::bigint`.as('sold')])
          .where('tenant_id', '=', t)
          .where('store_id', '=', store.id)
          .where('product_id', 'in', ids)
          .where('sale_date', '>=', windowStart)
          .where('sale_date', '<=', cal.today)
          .groupBy(['product_id', 'sale_date'])
          .execute()
      : Promise.resolve([]),
    ids.length && forecastMode
      ? tx
          .selectFrom('stock_levels as sl')
          .leftJoin('batches as b', (j) =>
            j.onRef('b.tenant_id', '=', 'sl.tenant_id').onRef('b.id', '=', 'sl.batch_id'),
          )
          .select([
            'sl.product_id',
            sql<number>`sum(case when b.expiry_date is not null and b.expiry_date < ${cal.today}::date then 0 else sl.qty_milli end)::bigint`.as(
              'usable',
            ),
            sql<number>`sum(case when b.expiry_date is not null and b.expiry_date < ${deliveryDate}::date then 0 else sl.qty_milli end)::bigint`.as(
              'durable',
            ),
          ])
          .where('sl.tenant_id', '=', t)
          .where('sl.store_id', '=', store.id)
          .where('sl.product_id', 'in', ids)
          .groupBy('sl.product_id')
          .execute()
      : Promise.resolve([]),
    ids.length
      ? tx
          .selectFrom('purchase_order_lines as l')
          .innerJoin('purchase_orders as o', (j) =>
            j.onRef('o.tenant_id', '=', 'l.tenant_id').onRef('o.id', '=', 'l.purchase_order_id'),
          )
          .select([
            'l.product_id',
            sql<number>`sum(greatest(l.qty_milli - l.received_qty_milli, 0))::bigint`.as('pending'),
          ])
          .where('l.tenant_id', '=', t)
          .where('o.store_id', '=', store.id)
          .where('o.status', 'in', ['sent', 'partially_received'])
          .where('l.product_id', 'in', ids)
          .groupBy('l.product_id')
          .execute()
      : Promise.resolve([]),
    lastPurchases(tx, ctx, ids),
  ])
  const soldOf = new Map(sales.map((r) => [r.product_id, Number(r.sold)]))
  const pendingOf = new Map(openPo.map((r) => [r.product_id, Number(r.pending)]))
  const usableOf = new Map(stockSplit.map((r) => [r.product_id, Number(r.usable)]))
  const durableOf = new Map(stockSplit.map((r) => [r.product_id, Number(r.durable)]))
  const soldByDay = new Map<string, Map<string, number>>()
  if (forecastMode) {
    const addSold = (productId: string, date: unknown, sold: number): void => {
      const key = dateKey(date)
      let days = soldByDay.get(productId)
      if (!days) {
        days = new Map()
        soldByDay.set(productId, days)
      }
      days.set(key, (days.get(key) ?? 0) + sold)
    }
    for (const row of saleDays) addSold(row.product_id, row.sale_date, Number(row.sold))
    for (const row of imported) addSold(row.product_id, row.sale_date, Number(row.sold))
  }
  const dates: string[] = []
  for (let i = 0; i < historyDays; i++) dates.push(addDays(windowStart, i))
  const todayWeekday = dayOfWeek(cal.today)

  const groups = new Map<
    string,
    {
      supplier: { id: string; name: string; phone: string | null } | null
      items: ReorderItem[]
      estimated_cost_paise: number
    }
  >()
  for (const p of products) {
    const lp = last.get(p.id)
    if (q.supplier_id && lp?.supplier_id !== q.supplier_id) continue
    const stock = Number(p.stock_milli)
    const incoming = pendingOf.get(p.id) ?? 0
    const cost = lp?.unit_cost_paise ?? p.purchase_price_paise
    const shelf = shelfLifeDays(p.attributes, q.shelf_life_days)
    const usable = forecastMode ? Math.max(0, usableOf.get(p.id) ?? 0) : Math.max(0, stock)
    const durable = forecastMode ? Math.max(0, Math.min(usable, durableOf.get(p.id) ?? 0)) : usable
    const dayMap = soldByDay.get(p.id)
    const smartResult = smart ? smartForecastFor(dates, dayMap, leadTime) : null
    const forecast = smartResult
      ? smartResult
      : forecastMode
        ? forecastDemandMilli({
            days: dates.map((date) => ({
              weekday: dayOfWeek(date),
              sold_milli: dayMap?.get(date) ?? 0,
            })),
            lead_time_days: leadTime,
            today_weekday: todayWeekday,
            weekday_adjusted: weekdayAdjusted,
          })
        : {
            daily_milli: averageDailySalesMilli(soldOf.get(p.id) ?? 0, REORDER_SALES_WINDOW_DAYS),
            demand_milli: 0,
            has_history: false,
          }
    const plan = planStockSense({
      reorder_level_milli: p.reorder_level_milli ?? 0,
      reorder_qty_milli: p.reorder_qty_milli,
      // Classic mode passes the raw balance so a negative stock still raises the quantity.
      usable_stock_milli: forecastMode ? usable : stock,
      durable_stock_milli: durable,
      incoming_milli: incoming,
      daily_milli: forecast.daily_milli,
      demand_milli: forecast.demand_milli,
      safety_stock_milli: smartResult?.safety_stock_milli ?? 0,
      lead_time_days: leadTime,
      shelf_life_days: forecastMode ? shelf : null,
      pack_size: p.pack_size,
      has_history: forecast.has_history,
      use_forecast: forecastMode,
    })
    const belowLevel = p.reorder_level_milli != null && stock <= Number(p.reorder_level_milli)
    if (
      forecastMode &&
      !q.product_ids?.length &&
      !belowLevel &&
      plan.stockout_urgency_days <= 0 &&
      plan.suggested_qty_milli <= 0
    ) {
      continue
    }
    const margin = marginBp({
      sale_price_paise: Number(p.sale_price_paise),
      price_includes_tax: p.price_includes_tax,
      gst_rate_bp: p.gst_rate_bp,
      cess_rate_bp: p.cess_rate_bp,
      cost_paise: cost,
    })
    const baseExplanation = explainReorder({
      reason: plan.reason,
      window_days: historyDays,
      lead_time_days: leadTime,
      shelf_life_days: forecastMode ? shelf : null,
      daily_milli: forecast.daily_milli,
      usable_stock_milli: usable,
      urgency_days: plan.stockout_urgency_days,
      suggested_qty_milli: plan.suggested_qty_milli,
    })
    const explanation = smartResult
      ? `${baseExplanation} ${explainSmartForecast(smartResult)}`
      : baseExplanation
    const item: ReorderItem = {
      product_id: p.id,
      name: p.name,
      name_ta: p.name_ta,
      sku: p.sku,
      unit: p.unit,
      pack_size: p.pack_size,
      category_id: p.category_id,
      current_stock_milli: stock,
      reorder_level_milli: p.reorder_level_milli ?? 0,
      reorder_qty_milli: p.reorder_qty_milli,
      avg_daily_sales_milli: forecast.daily_milli,
      forecast_demand_milli: forecast.demand_milli,
      days_of_cover: plan.days_of_cover,
      suggested_qty_milli: plan.suggested_qty_milli,
      open_po_qty_milli: incoming,
      usable_stock_milli: usable,
      durable_stock_milli: durable,
      lead_time_days: leadTime,
      shelf_life_days: forecastMode ? shelf : null,
      stockout_urgency_days: plan.stockout_urgency_days,
      priority: plan.priority,
      margin_bp: margin,
      has_sales_history: forecast.has_history,
      capped_by_shelf_life: plan.capped_by_shelf_life,
      reason: plan.reason,
      explanation,
      forecast_method: smartResult?.has_history ? smartResult.method : null,
      forecast_accuracy_bp: smartResult?.has_history ? smartResult.accuracy_bp : null,
      forecast_holdout_days: smartResult?.has_history ? smartResult.holdout_days : 0,
      safety_stock_milli: smartResult?.safety_stock_milli ?? 0,
      last_cost_paise: lp?.unit_cost_paise ?? null,
      last_bill_date: lp?.received_date ?? null,
      gst_rate_bp: p.gst_rate_bp,
      unit_cost_paise: cost,
      estimated_cost_paise: amountForQty(cost, plan.suggested_qty_milli, p.pack_size),
    }
    const key = lp?.supplier_id ?? ''
    let group = groups.get(key)
    if (!group) {
      group = {
        supplier: lp
          ? { id: lp.supplier_id, name: lp.supplier_name, phone: lp.supplier_phone }
          : null,
        items: [],
        estimated_cost_paise: 0,
      }
      groups.set(key, group)
    }
    group.items.push(item)
    group.estimated_cost_paise += item.estimated_cost_paise
  }
  const ordered = [...groups.values()].sort((a, b) => {
    if (!a.supplier) return 1
    if (!b.supplier) return -1
    if (forecastMode) {
      const rank = groupRank(b) - groupRank(a)
      if (rank !== 0) return rank
    }
    return a.supplier.name.localeCompare(b.supplier.name, 'en')
  })
  if (forecastMode) {
    for (const group of ordered) group.items.sort(compareReorderRank)
  }
  return {
    store_id: store.id,
    generated_at: iso(new Date()),
    window_days: historyDays,
    forecast: forecastMode,
    model: smart ? 'smart' : 'average',
    lead_time_days: leadTime,
    weekday_adjusted: weekdayAdjusted,
    assumptions: forecastMode
      ? [
          `Supplier lead time is ${leadTime === 1 ? '1 day' : `${String(leadTime)} days`} for this plan.`,
          smart
            ? `Demand is forecast per product from up to ${historyDays} days of sales: Holt-Winters (trend + weekday pattern), Croston-SBA (irregular sellers) and the weekday average are tested on the last 14 days and the most accurate one is used. Safety stock covers about 95% of days.`
            : weekdayAdjusted
              ? `Demand is a ${windowDays}-day moving average, adjusted by weekday.`
              : `Demand is a ${windowDays}-day moving average.`,
          q.shelf_life_days != null
            ? `Shelf life defaults to ${q.shelf_life_days === 1 ? '1 day' : `${String(q.shelf_life_days)} days`} when the product has none. Order quantities are capped so new stock can sell before it expires.`
            : 'Shelf life is taken from the product when set. Otherwise the order quantity is not capped. Expired batches are left out of usable stock.',
          'Products with no sales in the window use the reorder level and reorder quantity, minus open purchase orders.',
          'Imported sales are added to recorded sales for those dates and do not change stock on hand.',
        ]
      : [],
    groups: ordered,
  }
}

const METHOD_LABELS: Readonly<Record<SmartForecast['method'], string>> = {
  holt_winters: 'Holt-Winters (trend + weekday pattern)',
  croston_sba: 'Croston-SBA (irregular sales)',
  weekday_average: 'weekday average',
}

/** Smart forecast on the product's daily history, leading days before its first sale dropped. */
function smartForecastFor(
  dates: readonly string[],
  dayMap: Map<string, number> | undefined,
  leadTime: number,
): SmartForecast {
  const series = dates.map((date) => dayMap?.get(date) ?? 0)
  const first = series.findIndex((v) => v > 0)
  const start = first < 0 ? series.length : first
  return smartForecast({
    history_milli: series.slice(start),
    first_weekday: dayOfWeek(dates[start] ?? dates[dates.length - 1]!),
    lead_time_days: leadTime,
  })
}

function explainSmartForecast(f: SmartForecast): string {
  if (!f.has_history) return ''
  const accuracy =
    f.accuracy_bp === null
      ? 'not enough history to test accuracy yet'
      : `${(f.accuracy_bp / 100).toFixed(0)}% accurate on the last ${f.holdout_days} days`
  const safety =
    f.safety_stock_milli > 0 ? `, safety stock ${(f.safety_stock_milli / 1000).toFixed(1)}` : ''
  return `Forecast: ${METHOD_LABELS[f.method]}, ${accuracy}${safety}.`
}

function dateKey(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 10)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

/** Product attribute shelf_life_days, else the plan default, else no cap. */
function shelfLifeDays(attributes: unknown, fallback: number | undefined): number | null {
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    const raw = (attributes as Record<string, unknown>).shelf_life_days
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : NaN
    if (Number.isInteger(n) && n >= 0 && n <= 3650) return n
  }
  return fallback ?? null
}

function groupRank(group: { items: readonly { priority: ReorderItem['priority'] }[] }): number {
  let best = -1
  for (const item of group.items) {
    const rank =
      item.priority === 'urgent'
        ? 3
        : item.priority === 'high'
          ? 2
          : item.priority === 'normal'
            ? 1
            : 0
    if (rank > best) best = rank
  }
  return best
}
