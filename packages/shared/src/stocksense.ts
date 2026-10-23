/**
 * StockSense — demand forecast and reorder planning for small shops. Pure and isomorphic: the
 * server builds the report with it and the web recomputes a row when the owner edits a lead
 * time or shelf life. Quantities are integer milli (base unit × 1000), money integer paise,
 * cost and selling price per pack (pack_size base units) as everywhere in Kadai.
 *
 * Forecast. Net daily sales (sales − returns) of the last `window` complete days (yesterday
 * back). The average divides by the days the product actually had data for, so an item added
 * ten days ago is not diluted by twenty empty days. With the weekday pattern on, each weekday
 * gets a factor = its average ÷ the overall average, from at least two samples per weekday
 * (≥ 14 observed days), clamped to 0.25–3. No sales at all → no forecast: the plan falls back
 * to the product's reorder level / reorder quantity when set and says so.
 *
 * Plan. Day 1 is today. The order arrives after `lead_time` days and has to last one order
 * cycle plus the safety days:
 *   order = demand(lead + cycle + safety) − stock still in date on delivery − open orders
 * capped so the new stock can sell within the product's shelf life after delivery (stock left
 * over at delivery sells first), rounded to whole packs (up; down when shelf life caps it).
 * Priority: urgent = out of stock or runs out before a new order can arrive; high = runs out
 * before the following delivery even with open orders; normal = top-up; ok = nothing to buy.
 * Ranking: priority, then fewest days of stock, then profit lost to the stockout, then profit
 * per day, then name — deterministic.
 */
import { mulDiv, roundDiv } from './math'

export const STOCKSENSE_WINDOWS = [7, 14, 30, 60, 90] as const
export type StockSenseWindow = (typeof STOCKSENSE_WINDOWS)[number]

export const STOCKSENSE_DEFAULTS = {
  /** Used for suppliers without their own lead time. */
  lead_time_days: 3,
  /** Days between two orders to the same supplier (weekly ordering). */
  cycle_days: 7,
  /** Extra days of demand kept as a buffer. */
  safety_days: 2,
  window_days: 30 as StockSenseWindow,
  weekday_adjust: true,
  /** Stock beyond this many days of sales counts as cash locked in slow stock. */
  slow_cover_days: 90,
} as const

export const STOCKSENSE_PRIORITIES = ['urgent', 'high', 'normal', 'ok'] as const
export type StockSensePriority = (typeof STOCKSENSE_PRIORITIES)[number]
export const STOCKSENSE_PRIORITY_RANK: Readonly<Record<StockSensePriority, number>> = {
  urgent: 3,
  high: 2,
  normal: 1,
  ok: 0,
}

export const STOCKSENSE_REASONS = [
  /** Nothing usable on hand and the item sells. */
  'out_of_stock',
  /** Runs out before an order placed today can arrive. */
  'stockout_before_delivery',
  /** Lasts until delivery but not until the following one, even with open orders. */
  'stockout_before_next',
  /** Top-up for the order cycle / safety days. */
  'top_up',
  /** No sales history; at / below the reorder level, so the reorder settings decide. */
  'reorder_level',
  /** Stock and open orders cover lead time + cycle + safety. */
  'covered',
  /** Short before delivery, but open purchase orders already cover it: chase the supplier. */
  'on_order',
  /** Would be needed, but it cannot sell before it expires. */
  'shelf_life',
  /** No sales history and no reorder level. */
  'no_demand',
] as const
export type StockSenseReason = (typeof STOCKSENSE_REASONS)[number]

export const STOCKSENSE_TRENDS = ['up', 'down', 'flat'] as const
export type StockSenseTrend = (typeof STOCKSENSE_TRENDS)[number]

export const STOCKSENSE_CONFIDENCE = ['none', 'low', 'medium', 'high'] as const
export type StockSenseConfidence = (typeof STOCKSENSE_CONFIDENCE)[number]

/** 1000 = 1.0 */
const UNIT = 1000
const FLAT: readonly number[] = [UNIT, UNIT, UNIT, UNIT, UNIT, UNIT, UNIT]
const MAX_COVER_DAYS = 999

export interface ForecastProfile {
  /** Average net daily sales over the observed days (weekday-neutral). */
  daily_milli: number
  /** Average of the last 7 observed days (trend). */
  recent_daily_milli: number
  trend: StockSenseTrend
  /** Per weekday (0 = Sunday), 1000 = an average day. */
  weekday_factors: readonly number[]
  weekday_adjusted: boolean
  has_history: boolean
  /** Days of the window the product had data for. */
  observed_days: number
  /** Observed days with a sale. */
  sale_days: number
  confidence: StockSenseConfidence
  /** Weekday of day 1 (today). */
  today_weekday: number
}

function assertInt(name: string, n: number, min: number, max: number): void {
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}`)
  }
}

/**
 * Builds the forecast from daily net sales, oldest first; the last element is yesterday.
 * `observed_days` (≤ history length) is how many of the most recent days count — the rest are
 * before the product or the shop had any data.
 */
export function forecastProfile(input: {
  history_milli: readonly number[]
  observed_days: number
  /** Weekday of today, 0 = Sunday. */
  today_weekday: number
  weekday_adjust: boolean
}): ForecastProfile {
  const all = input.history_milli
  assertInt('today_weekday', input.today_weekday, 0, 6)
  assertInt('observed_days', input.observed_days, 0, all.length)
  const observed = all.slice(all.length - input.observed_days).map((n) => {
    if (!Number.isSafeInteger(n)) throw new RangeError('history_milli must be integers')
    return Math.max(0, n)
  })
  const n = observed.length
  const total = observed.reduce((s, v) => s + v, 0)
  const saleDays = observed.filter((v) => v > 0).length
  const base = {
    weekday_factors: FLAT,
    weekday_adjusted: false,
    observed_days: n,
    sale_days: saleDays,
    today_weekday: input.today_weekday,
  }
  if (n === 0 || total <= 0) {
    return {
      ...base,
      daily_milli: 0,
      recent_daily_milli: 0,
      trend: 'flat',
      has_history: false,
      confidence: 'none',
    }
  }
  const daily = Math.max(1, roundDiv(total, n))
  const recentDays = observed.slice(-7)
  const recent = roundDiv(
    recentDays.reduce((s, v) => s + v, 0),
    recentDays.length,
  )
  let trend: StockSenseTrend = 'flat'
  if (n >= 14) {
    if (recent * 4 > daily * 5) trend = 'up'
    else if (recent * 4 < daily * 3) trend = 'down'
  }

  let factors: readonly number[] = FLAT
  let adjusted = false
  if (input.weekday_adjust && n >= 14) {
    // Weekday of each observed day: the last one is yesterday.
    const sums = [0, 0, 0, 0, 0, 0, 0]
    const counts = [0, 0, 0, 0, 0, 0, 0]
    for (let i = 0; i < n; i++) {
      const daysAgo = n - i
      const dow = (((input.today_weekday - daysAgo) % 7) + 7) % 7
      sums[dow]! += observed[i]!
      counts[dow]! += 1
    }
    if (counts.every((c) => c >= 2)) {
      factors = sums.map((s, d) => {
        const avg = s / counts[d]!
        const f = Math.round((avg / (total / n)) * UNIT)
        return Math.min(3 * UNIT, Math.max(UNIT / 4, f))
      })
      adjusted = true
    }
  }

  const confidence: StockSenseConfidence =
    n < 7 || saleDays < 3 ? 'low' : n >= 28 && saleDays >= 14 ? 'high' : 'medium'
  return {
    ...base,
    weekday_factors: factors,
    weekday_adjusted: adjusted,
    daily_milli: daily,
    recent_daily_milli: recent,
    trend,
    has_history: true,
    confidence,
  }
}

/** Forecast demand of one day; day 1 = today. */
export function demandOnDay(p: ForecastProfile, day: number): number {
  if (!p.has_history || day < 1) return 0
  const dow = (p.today_weekday + day - 1) % 7
  return roundDiv(p.daily_milli * p.weekday_factors[dow]!, UNIT)
}

/** Forecast demand of days `from`..`to` (inclusive, day 1 = today). */
export function demandBetween(p: ForecastProfile, from: number, to: number): number {
  if (!p.has_history) return 0
  let sum = 0
  for (let d = Math.max(1, from); d <= to; d++) sum += demandOnDay(p, d)
  return sum
}

/**
 * Whole days `stock_milli` lasts at the forecast (0 = runs out today). Null when nothing sells.
 */
export function coverDays(p: ForecastProfile, stockMilli: number): number | null {
  if (!p.has_history || p.daily_milli <= 0) return null
  let left = Math.max(0, stockMilli)
  for (let d = 1; d <= MAX_COVER_DAYS; d++) {
    left -= demandOnDay(p, d)
    if (left < 0) return d - 1
  }
  return MAX_COVER_DAYS
}

function packMilli(packSize: number): number {
  return (Number.isSafeInteger(packSize) && packSize >= 1 ? packSize : 1) * 1000
}

export function roundUpToPack(qtyMilli: number, packSize: number): number {
  if (qtyMilli <= 0) return 0
  const pack = packMilli(packSize)
  return Math.ceil(qtyMilli / pack) * pack
}

export function roundDownToPack(qtyMilli: number, packSize: number): number {
  if (qtyMilli <= 0) return 0
  const pack = packMilli(packSize)
  return Math.floor(qtyMilli / pack) * pack
}

/** Selling price per pack without GST / cess. */
export function netSalePricePaise(input: {
  sale_price_paise: number
  price_includes_tax: boolean
  gst_rate_bp: number
  cess_rate_bp: number
}): number {
  if (!input.price_includes_tax) return input.sale_price_paise
  return roundDiv(input.sale_price_paise * 10_000, 10_000 + input.gst_rate_bp + input.cess_rate_bp)
}

/** Value of a quantity at a per-pack price. */
export function packValuePaise(pricePerPack: number, qtyMilli: number, packSize: number): number {
  return mulDiv(pricePerPack, qtyMilli, packMilli(packSize))
}

export interface StockSensePlanInput {
  profile: ForecastProfile
  /** On hand that has not expired. */
  usable_milli: number
  /** Usable stock still in date when the delivery arrives (≤ usable). */
  durable_milli: number
  /** Pending on sent / partially received purchase orders. */
  incoming_milli: number
  lead_time_days: number
  cycle_days: number
  safety_days: number
  /** Null = not capped by shelf life. */
  shelf_life_days: number | null
  pack_size: number
  reorder_level_milli: number | null
  reorder_qty_milli: number | null
  /** Per pack, excl. tax. */
  unit_cost_paise: number
  /** Net selling price − cost per pack; null when the product has no selling price. */
  unit_margin_paise: number | null
}

export interface StockSensePlan {
  lead_demand_milli: number
  horizon_demand_milli: number
  safety_milli: number
  /** Days the stock on hand lasts (null = nothing sells). */
  cover_days: number | null
  /** Demand before the delivery that stock on hand and open orders cannot meet. */
  short_before_delivery_milli: number
  order_qty_milli: number
  /** Before the shelf-life cap. */
  uncapped_qty_milli: number
  capped_by_shelf_life: boolean
  priority: StockSensePriority
  reason: StockSenseReason
  order_cost_paise: number
  /** Gross profit of one average day of sales (null without a selling price). */
  profit_per_day_paise: number | null
  /** Gross profit lost on the demand short before delivery. */
  lost_profit_paise: number
}

export function planStockSense(input: StockSensePlanInput): StockSensePlan {
  const p = input.profile
  assertInt('lead_time_days', input.lead_time_days, 1, 365)
  assertInt('cycle_days', input.cycle_days, 1, 365)
  assertInt('safety_days', input.safety_days, 0, 365)
  const lead = input.lead_time_days
  const horizonDays = lead + input.cycle_days
  const usable = Math.max(0, input.usable_milli)
  const durable = Math.max(0, Math.min(usable, input.durable_milli))
  const incoming = Math.max(0, input.incoming_milli)
  const pack = input.pack_size
  const margin = input.unit_margin_paise

  const leadDemand = demandBetween(p, 1, lead)
  const horizonDemand = demandBetween(p, 1, horizonDays)
  const safety = demandBetween(p, horizonDays + 1, horizonDays + input.safety_days)
  const cover = coverDays(p, usable)
  const shortBefore = p.has_history ? Math.max(0, leadDemand - usable - incoming) : 0

  let uncapped: number
  let order: number
  let capped = false
  let priority: StockSensePriority
  let reason: StockSenseReason

  if (!p.has_history) {
    const level = input.reorder_level_milli
    if (level != null && usable <= level) {
      const classic = Math.max(input.reorder_qty_milli ?? 0, 2 * level - usable)
      uncapped = roundUpToPack(Math.max(0, classic - incoming), pack)
      order = uncapped
      reason = order > 0 ? 'reorder_level' : 'on_order'
      priority = order > 0 ? (usable <= 0 ? 'high' : 'normal') : 'ok'
    } else {
      uncapped = 0
      order = 0
      reason = 'no_demand'
      priority = 'ok'
    }
  } else {
    uncapped = roundUpToPack(horizonDemand + safety - durable - incoming, pack)
    order = uncapped
    if (input.shelf_life_days != null && order > 0) {
      const leftover = Math.max(0, durable + incoming - leadDemand)
      const sellable = Math.max(
        0,
        demandBetween(p, lead + 1, lead + input.shelf_life_days) - leftover,
      )
      if (order > sellable) {
        order = roundDownToPack(sellable, pack)
        capped = true
      }
    }
    if (order <= 0) {
      priority = 'ok'
      reason = capped ? 'shelf_life' : leadDemand > usable && incoming > 0 ? 'on_order' : 'covered'
    } else if (usable <= 0) {
      priority = 'urgent'
      reason = 'out_of_stock'
    } else if (cover != null && cover < lead) {
      priority = 'urgent'
      reason = 'stockout_before_delivery'
    } else {
      const withIncoming = coverDays(p, usable + incoming)
      if (withIncoming != null && withIncoming < horizonDays) {
        priority = 'high'
        reason = 'stockout_before_next'
      } else {
        priority = 'normal'
        reason = 'top_up'
      }
    }
  }

  return {
    lead_demand_milli: leadDemand,
    horizon_demand_milli: horizonDemand,
    safety_milli: safety,
    cover_days: cover,
    short_before_delivery_milli: shortBefore,
    order_qty_milli: order,
    uncapped_qty_milli: uncapped,
    capped_by_shelf_life: capped,
    priority,
    reason,
    order_cost_paise: packValuePaise(input.unit_cost_paise, order, pack),
    profit_per_day_paise: margin == null ? null : packValuePaise(margin, p.daily_milli, pack),
    lost_profit_paise:
      margin == null || margin <= 0 ? 0 : packValuePaise(margin, shortBefore, pack),
  }
}

export interface ExpiryBatchInput {
  batch_id: string
  /** Days from today to the expiry date (0 = expires today, negative = expired); null = none. */
  expiry_in_days: number | null
  qty_milli: number
}

/**
 * First-expiry-first-out sell-through of the batches at the forecast: how much of each batch is
 * expected to sell by its expiry date and how much is left at risk (all of it when expired).
 */
export function expiryRisk(
  p: ForecastProfile,
  batches: readonly ExpiryBatchInput[],
): Map<string, { sellable_milli: number; at_risk_milli: number }> {
  const out = new Map<string, { sellable_milli: number; at_risk_milli: number }>()
  const sorted = [...batches].sort((a, b) => {
    if (a.expiry_in_days == null) return b.expiry_in_days == null ? 0 : 1
    if (b.expiry_in_days == null) return -1
    return a.expiry_in_days - b.expiry_in_days
  })
  let consumed = 0
  for (const b of sorted) {
    const qty = Math.max(0, b.qty_milli)
    if (b.expiry_in_days == null) {
      out.set(b.batch_id, { sellable_milli: qty, at_risk_milli: 0 })
      continue
    }
    if (b.expiry_in_days < 0) {
      out.set(b.batch_id, { sellable_milli: 0, at_risk_milli: qty })
      continue
    }
    const demand = demandBetween(p, 1, b.expiry_in_days + 1)
    const sellable = Math.min(qty, Math.max(0, demand - consumed))
    consumed += sellable
    out.set(b.batch_id, { sellable_milli: sellable, at_risk_milli: qty - sellable })
  }
  return out
}

/**
 * Usable stock beyond `slowCoverDays` of sales: cash locked in slow stock. Items with no sales
 * count in full once they have two weeks of data (new items are not flagged).
 */
export function excessStockMilli(
  p: ForecastProfile,
  usableMilli: number,
  slowCoverDays: number,
): number {
  const usable = Math.max(0, usableMilli)
  if (!p.has_history) return p.observed_days >= 14 ? usable : 0
  return Math.max(0, usable - demandBetween(p, 1, slowCoverDays))
}

export interface StockSenseRankable {
  priority: StockSensePriority
  cover_days: number | null
  lost_profit_paise: number
  profit_per_day_paise: number | null
  name: string
}

/** Most important first. */
export function compareStockSense(a: StockSenseRankable, b: StockSenseRankable): number {
  const byPriority = STOCKSENSE_PRIORITY_RANK[b.priority] - STOCKSENSE_PRIORITY_RANK[a.priority]
  if (byPriority !== 0) return byPriority
  const ca = a.cover_days ?? Number.MAX_SAFE_INTEGER
  const cb = b.cover_days ?? Number.MAX_SAFE_INTEGER
  if (ca !== cb) return ca - cb
  if (a.lost_profit_paise !== b.lost_profit_paise) return b.lost_profit_paise - a.lost_profit_paise
  const pa = a.profit_per_day_paise ?? Number.MIN_SAFE_INTEGER
  const pb = b.profit_per_day_paise ?? Number.MIN_SAFE_INTEGER
  if (pa !== pb) return pb - pa
  return a.name.localeCompare(b.name, 'en')
}
