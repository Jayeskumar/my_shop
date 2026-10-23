/**
 * StockSense — GET /purchases/stocksense, GET /purchases/stocksense/products/:productId and
 * PUT /purchases/stocksense/settings. Reads what Kadai already records and plans with the
 * shared engine (packages/shared/src/stocksense.ts):
 *
 *  - sales: net sale / return / cancel movements of the stock ledger per local day, plus
 *    imported history (demand_history, POST /purchases/sales-history) for days without
 *    recorded sales of that product;
 *  - stock: stock_levels per batch (expiry from batches) — expired stock is not usable, stock
 *    expiring before the delivery is not counted for the order;
 *  - incoming: pending quantities of sent / partially received purchase orders;
 *  - supplier & cost: the latest posted purchase bill line (lastPurchases), the supplier's
 *    lead_time_days, else the plan default; selling price and GST from the product.
 *
 * Nothing here writes stock: the report only reads, and the settings route stores the two
 * planning inputs (supplier lead time, product shelf life). Purchase orders are created by the
 * existing POST /purchase-orders.
 */
import { sql } from 'kysely'
import {
  type StockSenseExpiryBatch,
  type StockSenseItem,
  type StockSenseParams,
  type StockSenseProduct,
  type StockSenseProductQuerySchema,
  type StockSenseQuerySchema,
  type StockSenseReport,
  type StockSenseSettings,
} from '@kadai/shared/api/purchases'
import { addDays, dayOfWeek, diffDays, instantRangeForDates } from '@kadai/shared'
import {
  STOCKSENSE_DEFAULTS,
  type ForecastProfile,
  compareStockSense,
  demandOnDay,
  excessStockMilli,
  expiryRisk,
  forecastProfile,
  netSalePricePaise,
  packValuePaise,
  planStockSense,
} from '@kadai/shared/stocksense'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { notFound } from '../../core/errors'
import type { Tx } from '../../db/tenant'
import { type Ctx, businessToday, iso, lastPurchases, loadStore } from './common'
import { likePattern } from './orders'

type ReportQuery = z.output<typeof StockSenseQuerySchema>
type ProductQuery = z.output<typeof StockSenseProductQuerySchema>

/** Products analysed in one report. */
const MAX_ITEMS = 3000
const MAX_EXPIRY_BATCHES = 200
const SALE_MOVEMENTS = ['sale', 'sale_return', 'sale_cancel'] as const

interface Filter {
  product_ids?: readonly string[]
  supplier_id?: string
  category_id?: string
  q?: string
}

interface BatchRow {
  batch_id: string | null
  batch_no: string | null
  expiry_date: string | null
  supplier_id: string | null
  qty_milli: number
  avg_cost_paise: number
}

interface Analysed {
  item: StockSenseItem
  profile: ForecastProfile
  history: { date: string; recorded_milli: number; imported_milli: number; sold_milli: number }[]
  batches: (BatchRow & { at_risk_milli: number })[]
}

function resolveParams(q: Partial<ProductQuery>): StockSenseParams {
  return {
    lead_time_days: q.lead_time_days ?? STOCKSENSE_DEFAULTS.lead_time_days,
    cycle_days: q.cycle_days ?? STOCKSENSE_DEFAULTS.cycle_days,
    safety_days: q.safety_days ?? STOCKSENSE_DEFAULTS.safety_days,
    window_days: q.window_days ?? STOCKSENSE_DEFAULTS.window_days,
    weekday_adjust: q.weekday_adjust ?? STOCKSENSE_DEFAULTS.weekday_adjust,
    slow_cover_days: STOCKSENSE_DEFAULTS.slow_cover_days,
  }
}

function dateKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

async function analyse(
  tx: Tx,
  ctx: Ctx,
  storeId: string,
  today: string,
  timezone: string,
  params: StockSenseParams,
  filter: Filter,
): Promise<{ analysed: Analysed[]; truncated: boolean; historyFrom: string; historyTo: string }> {
  const t = ctx.tenantId
  const historyTo = addDays(today, -1)
  const historyFrom = addDays(today, -params.window_days)

  let qb = tx
    .selectFrom('products as p')
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
      'p.shelf_life_days',
    ])
    .where('p.tenant_id', '=', t)
    .where('p.is_active', '=', true)
    .where('p.track_inventory', '=', true)
    .where('p.kind', 'in', ['standard', 'variant'])
  if (filter.product_ids) qb = qb.where('p.id', 'in', filter.product_ids)
  if (filter.category_id) {
    qb = qb.where(
      sql<boolean>`p.category_id in (
        with recursive tree(id) as (
          select id from categories where tenant_id = ${t} and id = ${filter.category_id}
          union all
          select c.id from categories c join tree on c.parent_id = tree.id where c.tenant_id = ${t}
        ) select id from tree)`,
    )
  }
  if (filter.q) {
    const pattern = likePattern(filter.q)
    qb = qb.where((eb) =>
      eb.or([
        eb('p.name', 'ilike', pattern),
        eb('p.name_ta', 'ilike', pattern),
        eb('p.sku', 'ilike', pattern),
        eb('p.search_text', 'ilike', pattern),
      ]),
    )
  }
  const fetched = await qb
    .orderBy('p.name')
    .orderBy('p.id')
    .limit(MAX_ITEMS + 1)
    .execute()
  const truncated = fetched.length > MAX_ITEMS
  const products = truncated ? fetched.slice(0, MAX_ITEMS) : fetched
  const ids = products.map((p) => p.id)
  if (ids.length === 0) return { analysed: [], truncated, historyFrom, historyTo }

  const range = instantRangeForDates(historyFrom, historyTo, timezone)
  // A literal (not a parameter) so the select and the GROUP BY are the same expression.
  const saleDate = sql<string>`(created_at AT TIME ZONE ${sql.lit(timezone)})::date`
  const [levels, recorded, imported, firstMoves, openPo, last] = await Promise.all([
    tx
      .selectFrom('stock_levels as sl')
      .leftJoin('batches as b', (j) =>
        j.onRef('b.tenant_id', '=', 'sl.tenant_id').onRef('b.id', '=', 'sl.batch_id'),
      )
      .select([
        'sl.product_id',
        'sl.batch_id',
        'b.batch_no',
        sql<string | null>`b.expiry_date::text`.as('expiry_date'),
        'b.supplier_id',
        'sl.qty_milli',
        'sl.avg_cost_paise',
      ])
      .where('sl.tenant_id', '=', t)
      .where('sl.store_id', '=', storeId)
      .where('sl.product_id', 'in', ids)
      .where('sl.qty_milli', '<>', 0)
      .execute(),
    tx
      .selectFrom('stock_movements')
      .select([
        'product_id',
        saleDate.as('sale_date'),
        sql<number>`(-sum(qty_milli))::bigint`.as('sold'),
      ])
      .where('tenant_id', '=', t)
      .where('store_id', '=', storeId)
      .where('product_id', 'in', ids)
      .where('movement_type', 'in', SALE_MOVEMENTS)
      .where('created_at', '>=', range.start)
      .where('created_at', '<', range.end)
      .groupBy(['product_id', saleDate])
      .execute(),
    tx
      .selectFrom('demand_history')
      .select(['product_id', sql<string>`sale_date::text`.as('sale_date'), 'qty_milli'])
      .where('tenant_id', '=', t)
      .where('store_id', '=', storeId)
      .where('product_id', 'in', ids)
      .where('sale_date', '>=', historyFrom)
      .where('sale_date', '<=', historyTo)
      .execute(),
    // First day the product had any data at this store (stock movement or imported sale).
    tx
      .selectFrom((eb) =>
        eb
          .selectFrom('stock_movements')
          .select(['product_id', sql<string>`min(${saleDate})::text`.as('first_date')])
          .where('tenant_id', '=', t)
          .where('store_id', '=', storeId)
          .where('product_id', 'in', ids)
          .groupBy('product_id')
          .unionAll(
            eb
              .selectFrom('demand_history')
              .select(['product_id', sql<string>`min(sale_date)::text`.as('first_date')])
              .where('tenant_id', '=', t)
              .where('store_id', '=', storeId)
              .where('product_id', 'in', ids)
              .groupBy('product_id'),
          )
          .as('f'),
      )
      .select(['f.product_id', sql<string>`min(f.first_date)`.as('first_date')])
      .groupBy('f.product_id')
      .execute(),
    tx
      .selectFrom('purchase_order_lines as l')
      .innerJoin('purchase_orders as o', (j) =>
        j.onRef('o.tenant_id', '=', 'l.tenant_id').onRef('o.id', '=', 'l.purchase_order_id'),
      )
      .select([
        'l.product_id',
        sql<number>`sum(greatest(l.qty_milli - l.received_qty_milli, 0))::bigint`.as('pending'),
      ])
      .where('l.tenant_id', '=', t)
      .where('o.store_id', '=', storeId)
      .where('o.status', 'in', ['sent', 'partially_received'])
      .where('l.product_id', 'in', ids)
      .groupBy('l.product_id')
      .execute(),
    lastPurchases(tx, ctx, ids),
  ])

  const supplierIds = [...new Set([...last.values()].map((lp) => lp.supplier_id))]
  const leadOf = new Map<string, number | null>()
  if (supplierIds.length) {
    const rows = await tx
      .selectFrom('suppliers')
      .select(['id', 'lead_time_days'])
      .where('tenant_id', '=', t)
      .where('id', 'in', supplierIds)
      .execute()
    for (const r of rows) leadOf.set(r.id, r.lead_time_days)
  }

  const levelsOf = new Map<string, BatchRow[]>()
  for (const r of levels) {
    let list = levelsOf.get(r.product_id)
    if (!list) levelsOf.set(r.product_id, (list = []))
    list.push({
      batch_id: r.batch_id,
      batch_no: r.batch_no,
      expiry_date: r.expiry_date,
      supplier_id: r.supplier_id,
      qty_milli: Number(r.qty_milli),
      avg_cost_paise: Number(r.avg_cost_paise),
    })
  }
  const recordedOf = new Map<string, Map<string, number>>()
  for (const r of recorded) {
    let days = recordedOf.get(r.product_id)
    if (!days) recordedOf.set(r.product_id, (days = new Map()))
    days.set(dateKey(r.sale_date), Number(r.sold))
  }
  const importedOf = new Map<string, Map<string, number>>()
  for (const r of imported) {
    let days = importedOf.get(r.product_id)
    if (!days) importedOf.set(r.product_id, (days = new Map()))
    const key = dateKey(r.sale_date)
    days.set(key, (days.get(key) ?? 0) + Number(r.qty_milli))
  }
  const firstOf = new Map(firstMoves.map((r) => [r.product_id, dateKey(r.first_date)]))
  const pendingOf = new Map(openPo.map((r) => [r.product_id, Number(r.pending)]))

  const dates: string[] = []
  for (let i = 0; i < params.window_days; i++) dates.push(addDays(historyFrom, i))
  const todayWeekday = dayOfWeek(today)

  const analysed: Analysed[] = []
  for (const p of products) {
    const lp = last.get(p.id)
    if (filter.supplier_id && lp?.supplier_id !== filter.supplier_id) continue
    const rec = recordedOf.get(p.id)
    const imp = importedOf.get(p.id)
    const history = dates.map((date) => {
      const recordedMilli = rec?.get(date)
      const importedMilli = imp?.get(date) ?? 0
      return {
        date,
        recorded_milli: recordedMilli ?? 0,
        imported_milli: importedMilli,
        sold_milli: Math.max(0, recordedMilli ?? importedMilli),
      }
    })
    const first = firstOf.get(p.id)
    const observed =
      first == null || first > historyTo
        ? 0
        : Math.min(
            params.window_days,
            diffDays(first < historyFrom ? historyFrom : first, historyTo) + 1,
          )
    const profile = forecastProfile({
      history_milli: history.map((h) => h.sold_milli),
      observed_days: observed,
      today_weekday: todayWeekday,
      weekday_adjust: params.weekday_adjust,
    })

    const supplierLead = lp ? (leadOf.get(lp.supplier_id) ?? null) : null
    const lead = supplierLead ?? params.lead_time_days
    const delivery = addDays(today, lead)
    const rows = levelsOf.get(p.id) ?? []
    let stock = 0
    let usableRaw = 0
    let durableRaw = 0
    let expired = 0
    let valueQty = 0
    let valuePaise = 0
    for (const b of rows) {
      stock += b.qty_milli
      const isExpired = b.expiry_date != null && b.expiry_date < today
      if (isExpired) {
        if (b.qty_milli > 0) expired += b.qty_milli
      } else {
        usableRaw += b.qty_milli
        if (b.expiry_date == null || b.expiry_date >= delivery) durableRaw += b.qty_milli
      }
      if (b.qty_milli > 0) {
        valueQty += b.qty_milli
        valuePaise += packValuePaise(b.avg_cost_paise, b.qty_milli, p.pack_size)
      }
    }
    const cost = lp?.unit_cost_paise ?? Number(p.purchase_price_paise)
    // Average cost per pack of what is on hand (stock valuation), else the purchase cost.
    const valueOf = (qty: number): number =>
      valueQty > 0
        ? Math.round((valuePaise * qty) / valueQty)
        : packValuePaise(cost, qty, p.pack_size)
    const risk = expiryRisk(
      profile,
      rows
        .filter((b) => b.qty_milli > 0 && b.batch_id != null)
        .map((b) => ({
          batch_id: b.batch_id!,
          expiry_in_days: b.expiry_date == null ? null : diffDays(today, b.expiry_date),
          qty_milli: b.qty_milli,
        })),
    )
    let atRisk = 0
    const batches = rows.map((b) => {
      const r = b.batch_id ? risk.get(b.batch_id) : undefined
      const atRiskMilli = r?.at_risk_milli ?? 0
      atRisk += atRiskMilli
      return { ...b, at_risk_milli: atRiskMilli }
    })
    // Stock that will expire unsold (FEFO at the forecast) does not cover future demand.
    let atRiskInDate = 0
    for (const b of batches) {
      if (b.expiry_date != null && b.expiry_date >= today) atRiskInDate += b.at_risk_milli
    }
    const usable = Math.max(0, usableRaw)
    const durable = Math.max(0, Math.min(usable - atRiskInDate, durableRaw))
    const incoming = pendingOf.get(p.id) ?? 0
    const salePrice = Number(p.sale_price_paise)
    const net =
      salePrice > 0
        ? netSalePricePaise({
            sale_price_paise: salePrice,
            price_includes_tax: p.price_includes_tax,
            gst_rate_bp: p.gst_rate_bp,
            cess_rate_bp: p.cess_rate_bp,
          })
        : 0
    const margin = net > 0 ? net - cost : null
    const plan = planStockSense({
      profile,
      usable_milli: usable,
      durable_milli: durable,
      incoming_milli: incoming,
      lead_time_days: lead,
      cycle_days: params.cycle_days,
      safety_days: params.safety_days,
      shelf_life_days: p.shelf_life_days,
      pack_size: p.pack_size,
      reorder_level_milli: p.reorder_level_milli == null ? null : Number(p.reorder_level_milli),
      reorder_qty_milli: p.reorder_qty_milli == null ? null : Number(p.reorder_qty_milli),
      unit_cost_paise: cost,
      unit_margin_paise: margin,
    })

    const excess = excessStockMilli(profile, usable, params.slow_cover_days)

    analysed.push({
      profile,
      history,
      batches,
      item: {
        product_id: p.id,
        name: p.name,
        name_ta: p.name_ta,
        sku: p.sku,
        unit: p.unit,
        pack_size: p.pack_size,
        category_id: p.category_id,
        supplier: lp
          ? {
              id: lp.supplier_id,
              name: lp.supplier_name,
              phone: lp.supplier_phone,
              lead_time_days: supplierLead,
            }
          : null,
        lead_time_days: lead,
        shelf_life_days: p.shelf_life_days,
        stock_milli: stock,
        usable_milli: usable,
        durable_milli: durable,
        expired_milli: expired,
        incoming_milli: incoming,
        daily_milli: profile.daily_milli,
        recent_daily_milli: profile.recent_daily_milli,
        trend: profile.trend,
        confidence: profile.confidence,
        has_history: profile.has_history,
        observed_days: profile.observed_days,
        weekday_adjusted: profile.weekday_adjusted,
        lead_demand_milli: plan.lead_demand_milli,
        horizon_demand_milli: plan.horizon_demand_milli,
        safety_milli: plan.safety_milli,
        cover_days: plan.cover_days,
        stockout_date:
          plan.cover_days != null && plan.cover_days < 999 ? addDays(today, plan.cover_days) : null,
        short_before_delivery_milli: plan.short_before_delivery_milli,
        order_qty_milli: plan.order_qty_milli,
        uncapped_qty_milli: plan.uncapped_qty_milli,
        capped_by_shelf_life: plan.capped_by_shelf_life,
        priority: plan.priority,
        reason: plan.reason,
        rank: 1,
        unit_cost_paise: cost,
        unit_margin_paise: margin,
        margin_bp: margin != null && net > 0 ? Math.round((margin * 10_000) / net) : null,
        order_cost_paise: plan.order_cost_paise,
        profit_per_day_paise: plan.profit_per_day_paise,
        lost_profit_paise: plan.lost_profit_paise,
        excess_milli: excess,
        excess_value_paise: excess > 0 ? valueOf(excess) : 0,
        expiry_risk_milli: atRisk,
        expiry_risk_value_paise: atRisk > 0 ? valueOf(atRisk) : 0,
        stock_value_paise: valuePaise,
        reorder_level_milli: p.reorder_level_milli == null ? null : Number(p.reorder_level_milli),
        reorder_qty_milli: p.reorder_qty_milli == null ? null : Number(p.reorder_qty_milli),
        gst_rate_bp: p.gst_rate_bp,
        last_bill_date: lp?.received_date ?? null,
      },
    })
  }
  analysed.sort((a, b) => compareStockSense(a.item, b.item))
  analysed.forEach((a, i) => {
    a.item.rank = i + 1
  })
  return { analysed, truncated, historyFrom, historyTo }
}

function coverBucket(item: StockSenseItem): string {
  const d = item.cover_days
  if (d == null) return 'no_sales'
  if (d === 0) return '0'
  if (d <= 3) return '1-3'
  if (d <= 7) return '4-7'
  if (d <= 30) return '8-30'
  if (d <= 90) return '31-90'
  return '90+'
}

const BUCKETS = ['0', '1-3', '4-7', '8-30', '31-90', '90+', 'no_sales'] as const

export async function stockSenseReport(
  tx: Tx,
  ctx: Ctx,
  q: ReportQuery,
): Promise<StockSenseReport> {
  const store = await loadStore(tx, ctx, q.store_id)
  const cal = await businessToday(tx, ctx)
  const params = resolveParams(q)
  const { analysed, truncated, historyFrom, historyTo } = await analyse(
    tx,
    ctx,
    store.id,
    cal.today,
    cal.timezone,
    params,
    {
      ...(q.supplier_id ? { supplier_id: q.supplier_id } : {}),
      ...(q.category_id ? { category_id: q.category_id } : {}),
      ...(q.q ? { q: q.q } : {}),
    },
  )
  const items = analysed.map((a) => a.item)

  const expiry: StockSenseExpiryBatch[] = []
  for (const a of analysed) {
    for (const b of a.batches) {
      if (b.at_risk_milli <= 0 || !b.batch_id || !b.expiry_date) continue
      expiry.push({
        product_id: a.item.product_id,
        batch_id: b.batch_id,
        batch_no: b.batch_no ?? '',
        expiry_date: b.expiry_date,
        days_left: diffDays(cal.today, b.expiry_date),
        qty_milli: Math.max(0, b.qty_milli),
        at_risk_milli: b.at_risk_milli,
        at_risk_value_paise: packValuePaise(b.avg_cost_paise, b.at_risk_milli, a.item.pack_size),
        supplier_id: b.supplier_id,
      })
    }
  }
  expiry.sort((x, y) => y.at_risk_value_paise - x.at_risk_value_paise || x.days_left - y.days_left)

  const importedDays = await tx
    .selectFrom('demand_history')
    .select(sql<number>`count(distinct sale_date)::int`.as('n'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', store.id)
    .where('sale_date', '>=', historyFrom)
    .where('sale_date', '<=', historyTo)
    .executeTakeFirst()

  const counts = new Map<string, number>(BUCKETS.map((b) => [b, 0]))
  for (const item of items) counts.set(coverBucket(item), (counts.get(coverBucket(item)) ?? 0) + 1)
  const sum = (f: (i: StockSenseItem) => number): number => items.reduce((s, i) => s + f(i), 0)
  const ordered = items.filter((i) => i.order_qty_milli > 0)
  return {
    store_id: store.id,
    generated_at: iso(new Date()),
    today: cal.today,
    params,
    history_from: historyFrom,
    history_to: historyTo,
    imported_days: Number(importedDays?.n ?? 0),
    summary: {
      products: items.length,
      urgent: ordered.filter((i) => i.priority === 'urgent').length,
      high: ordered.filter((i) => i.priority === 'high').length,
      normal: ordered.filter((i) => i.priority === 'normal').length,
      order_lines: ordered.length,
      order_cost_paise: sum((i) => i.order_cost_paise),
      lost_profit_paise: sum((i) => i.lost_profit_paise),
      stock_value_paise: sum((i) => i.stock_value_paise),
      excess_value_paise: sum((i) => i.excess_value_paise),
      slow_items: items.filter((i) => i.excess_value_paise > 0).length,
      expiry_risk_value_paise: sum((i) => i.expiry_risk_value_paise),
      expiry_items: items.filter((i) => i.expiry_risk_milli > 0).length,
      no_history: items.filter((i) => !i.has_history).length,
      cover_buckets: BUCKETS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 })),
    },
    items,
    expiry_batches: expiry.slice(0, MAX_EXPIRY_BATCHES),
    truncated,
  }
}

export async function stockSenseProduct(
  tx: Tx,
  ctx: Ctx,
  productId: string,
  q: ProductQuery,
): Promise<StockSenseProduct> {
  const store = await loadStore(tx, ctx, q.store_id)
  const cal = await businessToday(tx, ctx)
  const params = resolveParams(q)
  const { analysed } = await analyse(tx, ctx, store.id, cal.today, cal.timezone, params, {
    product_ids: [productId],
  })
  const a = analysed[0]
  if (!a) throw notFound('product', productId)
  const item = a.item

  const days = item.lead_time_days + params.cycle_days + params.safety_days
  const forecast: StockSenseProduct['forecast'] = []
  let left = item.usable_milli
  for (let d = 1; d <= days; d++) {
    const demand = demandOnDay(a.profile, d)
    left -= demand
    forecast.push({
      date: addDays(cal.today, d - 1),
      demand_milli: demand,
      projected_stock_milli: left,
    })
  }

  const orders = await tx
    .selectFrom('purchase_order_lines as l')
    .innerJoin('purchase_orders as o', (j) =>
      j.onRef('o.tenant_id', '=', 'l.tenant_id').onRef('o.id', '=', 'l.purchase_order_id'),
    )
    .select([
      'o.id',
      'o.number',
      sql<string | null>`o.expected_date::text`.as('expected_date'),
      sql<number>`sum(greatest(l.qty_milli - l.received_qty_milli, 0))::bigint`.as('pending'),
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('o.store_id', '=', store.id)
    .where('o.status', 'in', ['sent', 'partially_received'])
    .where('l.product_id', '=', productId)
    .groupBy(['o.id', 'o.number', 'o.expected_date'])
    .orderBy('o.expected_date')
    .execute()

  return {
    item,
    params,
    weekday_factors: [...a.profile.weekday_factors],
    history: a.history,
    forecast,
    batches: a.batches
      .filter((b) => b.batch_id != null)
      .sort((x, y) => (x.expiry_date ?? '9999').localeCompare(y.expiry_date ?? '9999'))
      .map((b) => ({
        batch_id: b.batch_id!,
        batch_no: b.batch_no ?? '',
        expiry_date: b.expiry_date,
        qty_milli: b.qty_milli,
        at_risk_milli: b.at_risk_milli,
      })),
    open_orders: orders
      .map((o) => ({
        id: o.id,
        number: o.number,
        expected_date: o.expected_date,
        pending_milli: Number(o.pending),
      }))
      .filter((o) => o.pending_milli > 0),
  }
}

export async function updateStockSenseSettings(
  tx: Tx,
  ctx: Ctx,
  body: StockSenseSettings,
): Promise<{ suppliers: number; products: number }> {
  const t = ctx.tenantId
  let suppliers = 0
  let products = 0
  for (const s of body.suppliers ?? []) {
    const row = await tx
      .updateTable('suppliers')
      .set({ lead_time_days: s.lead_time_days })
      .where('tenant_id', '=', t)
      .where('id', '=', s.supplier_id)
      .returning(['id', 'name'])
      .executeTakeFirst()
    if (!row) throw notFound('supplier', s.supplier_id)
    suppliers += 1
    await audit(tx, ctx, {
      action: 'supplier.lead_time',
      entity_type: 'supplier',
      entity_id: row.id,
      summary: `StockSense lead time of ${row.name}: ${s.lead_time_days ?? 'default'}`,
      changes: { lead_time_days: s.lead_time_days },
    })
  }
  for (const p of body.products ?? []) {
    const row = await tx
      .updateTable('products')
      .set({ shelf_life_days: p.shelf_life_days })
      .where('tenant_id', '=', t)
      .where('id', '=', p.product_id)
      .returning(['id', 'name'])
      .executeTakeFirst()
    if (!row) throw notFound('product', p.product_id)
    products += 1
    await audit(tx, ctx, {
      action: 'product.shelf_life',
      entity_type: 'product',
      entity_id: row.id,
      summary: `StockSense shelf life of ${row.name}: ${p.shelf_life_days ?? 'none'}`,
      changes: { shelf_life_days: p.shelf_life_days },
    })
  }
  return { suppliers, products }
}
