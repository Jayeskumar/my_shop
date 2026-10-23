/**
 * Supplier Trust Score: what each supplier really does, learned from the shop's own purchase
 * orders and the bills that received them.
 *
 *  - lead time: order date → first posted delivery against the order (mean and standard deviation);
 *  - on time: share of deliveries on or before the order's expected date;
 *  - fill rate: Σ received ÷ Σ ordered over orders that have been delivered;
 *  - price change: per product, last vs first supplier rate in the window, weighted by spend.
 *
 * Trust (0–100) = 50% on-time + 35% fill rate + 15% consistency (1 − sd ÷ mean lead time); without
 * expected dates it is 70% fill + 30% consistency. Fewer than MIN_ORDERS delivered orders → "learning":
 * no score, and StockSense keeps the lead time the owner entered.
 */

/** Delivered orders needed before a supplier gets a score and a learned lead time. */
export const SUPPLIER_TRUST_MIN_ORDERS = 3
/** History window (days) for lead times and fill rate. */
export const SUPPLIER_TRUST_WINDOW_DAYS = 180
/** History window (days) for price changes. */
export const SUPPLIER_PRICE_WINDOW_DAYS = 90

export interface SupplierDelivery {
  /** YYYY-MM-DD */
  order_date: string
  expected_date: string | null
  /** First posted bill against the order. */
  first_received_date: string
  ordered_milli: number
  /** Received against the order lines (never more than ordered per line). */
  received_milli: number
}

export interface SupplierPricePoint {
  product_id: string
  /** YYYY-MM-DD */
  date: string
  unit_cost_paise: number
  /** Spend of the line, for weighting. */
  amount_paise: number
}

export type SupplierTrustLevel = 'good' | 'watch' | 'poor' | 'learning'

export type SupplierAlert =
  | { code: 'order_earlier'; days: number }
  | { code: 'short_supply'; fill_pct: number }
  | { code: 'price_up'; pct: number }
  | { code: 'reliable' }

export interface SupplierTrust {
  orders_measured: number
  /** Mean days from order to delivery (1 decimal). */
  avg_lead_days: number | null
  /** Standard deviation of those days (1 decimal). */
  sd_lead_days: number | null
  /** Mean promised days (expected − order date), where set. */
  avg_promised_days: number | null
  on_time_bp: number | null
  fill_rate_bp: number | null
  /** Spend-weighted rate change of products bought at least twice, basis points (+ = dearer). */
  price_change_bp: number | null
  trust: number | null
  level: SupplierTrustLevel
  /** Lead time StockSense plans with: the mean rounded up (null while learning). */
  learned_lead_days: number | null
  alerts: SupplierAlert[]
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

const round1 = (n: number): number => Math.round(n * 10) / 10

export function priceChangeBp(points: readonly SupplierPricePoint[]): number | null {
  const byProduct = new Map<string, SupplierPricePoint[]>()
  for (const p of points) {
    if (p.unit_cost_paise <= 0) continue
    const list = byProduct.get(p.product_id) ?? []
    list.push(p)
    byProduct.set(p.product_id, list)
  }
  let weighted = 0
  let weight = 0
  for (const list of byProduct.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => a.date.localeCompare(b.date))
    const first = list[0]!
    const last = list[list.length - 1]!
    const change = (last.unit_cost_paise - first.unit_cost_paise) / first.unit_cost_paise
    const w = list.reduce((s, p) => s + Math.max(0, p.amount_paise), 0) || 1
    weighted += change * w
    weight += w
  }
  return weight > 0 ? Math.round((weighted / weight) * 10_000) : null
}

export function supplierTrust(
  deliveries: readonly SupplierDelivery[],
  prices: readonly SupplierPricePoint[] = [],
): SupplierTrust {
  const leads = deliveries.map((d) => Math.max(0, daysBetween(d.order_date, d.first_received_date)))
  const n = leads.length
  const price = priceChangeBp(prices)

  const promised = deliveries
    .filter((d) => d.expected_date)
    .map((d) => Math.max(0, daysBetween(d.order_date, d.expected_date!)))
  const withExpected = deliveries.filter((d) => d.expected_date)
  const onTime =
    withExpected.length > 0
      ? withExpected.filter((d) => d.first_received_date <= d.expected_date!).length /
        withExpected.length
      : null
  const ordered = deliveries.reduce((s, d) => s + Math.max(0, d.ordered_milli), 0)
  const received = deliveries.reduce(
    (s, d) => s + Math.min(Math.max(0, d.received_milli), Math.max(0, d.ordered_milli)),
    0,
  )
  const fill = ordered > 0 ? received / ordered : null

  const mean = n > 0 ? leads.reduce((s, v) => s + v, 0) / n : null
  const sd =
    n >= 2 && mean !== null
      ? Math.sqrt(leads.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1))
      : n === 1
        ? 0
        : null
  const avgPromised = promised.length > 0 ? promised.reduce((s, v) => s + v, 0) / promised.length : null

  const base = {
    orders_measured: n,
    avg_lead_days: mean === null ? null : round1(mean),
    sd_lead_days: sd === null ? null : round1(sd),
    avg_promised_days: avgPromised === null ? null : round1(avgPromised),
    on_time_bp: onTime === null ? null : Math.round(onTime * 10_000),
    fill_rate_bp: fill === null ? null : Math.round(fill * 10_000),
    price_change_bp: price,
  }

  if (n < SUPPLIER_TRUST_MIN_ORDERS || mean === null) {
    const alerts: SupplierAlert[] = price !== null && price >= 300 ? [{ code: 'price_up', pct: round1(price / 100) }] : []
    return { ...base, trust: null, level: 'learning', learned_lead_days: null, alerts }
  }

  const consistency = mean > 0 ? 1 - Math.min(1, (sd ?? 0) / mean) : 1
  const fillScore = fill ?? 1
  const score =
    onTime === null
      ? 0.7 * fillScore + 0.3 * consistency
      : 0.5 * onTime + 0.35 * fillScore + 0.15 * consistency
  const trust = Math.max(0, Math.min(100, Math.round(score * 100)))
  const level: SupplierTrustLevel = trust >= 80 ? 'good' : trust >= 60 ? 'watch' : 'poor'

  const alerts: SupplierAlert[] = []
  if (onTime !== null && onTime < 0.7 && avgPromised !== null && mean > avgPromised) {
    alerts.push({ code: 'order_earlier', days: Math.max(1, Math.ceil(mean - avgPromised)) })
  }
  if (fill !== null && fill < 0.95) alerts.push({ code: 'short_supply', fill_pct: Math.round(fill * 100) })
  if (price !== null && price >= 300) alerts.push({ code: 'price_up', pct: round1(price / 100) })
  if (alerts.length === 0 && trust >= 85) alerts.push({ code: 'reliable' })

  return { ...base, trust, level, learned_lead_days: Math.max(1, Math.ceil(mean)), alerts }
}
