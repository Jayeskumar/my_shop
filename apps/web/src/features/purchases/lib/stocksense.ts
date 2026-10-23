/**
 * StockSense page helpers: plan settings remembered per browser, quantity text, the translated
 * one-line explanation of a recommendation, and the sales-history CSV template.
 */
import type { StockSenseItem, StockSenseQuery } from '@kadai/shared/api/purchases'
import {
  STOCKSENSE_DEFAULTS,
  STOCKSENSE_WINDOWS,
  type StockSensePriority,
  type StockSenseWindow,
} from '@kadai/shared/stocksense'
import { formatPackQty, formatQty } from '@/lib/format'
import { getLanguage, translate } from '@/lib/i18n'
import { storage } from '@/lib/storage'
import { packUnitFor } from './labels'

export interface PlanSettings {
  lead_time_days: number
  cycle_days: number
  safety_days: number
  window_days: StockSenseWindow
  weekday_adjust: boolean
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  lead_time_days: STOCKSENSE_DEFAULTS.lead_time_days,
  cycle_days: STOCKSENSE_DEFAULTS.cycle_days,
  safety_days: STOCKSENSE_DEFAULTS.safety_days,
  window_days: STOCKSENSE_DEFAULTS.window_days,
  weekday_adjust: STOCKSENSE_DEFAULTS.weekday_adjust,
}

const SETTINGS_KEY = 'purchases.stocksense.settings'

const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function isPlanSettings(v: unknown): v is PlanSettings {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (
    intIn(s.lead_time_days, 1, 180) &&
    intIn(s.cycle_days, 1, 90) &&
    intIn(s.safety_days, 0, 60) &&
    (STOCKSENSE_WINDOWS as readonly unknown[]).includes(s.window_days) &&
    typeof s.weekday_adjust === 'boolean'
  )
}

export function loadPlanSettings(): PlanSettings {
  try {
    return storage.get(SETTINGS_KEY, DEFAULT_PLAN_SETTINGS, isPlanSettings)
  } catch {
    return DEFAULT_PLAN_SETTINGS
  }
}

export function savePlanSettings(s: PlanSettings): void {
  try {
    storage.set(SETTINGS_KEY, s)
  } catch {
    // Storage unavailable: the settings simply are not remembered.
  }
}

export function planQuery(storeId: string, s: PlanSettings): StockSenseQuery {
  return {
    store_id: storeId,
    lead_time_days: s.lead_time_days,
    cycle_days: s.cycle_days,
    safety_days: s.safety_days,
    window_days: s.window_days,
    weekday_adjust: s.weekday_adjust,
  }
}

export const PRIORITY_TONE: Record<StockSensePriority, 'danger' | 'warning' | 'info' | 'neutral'> =
  {
    urgent: 'danger',
    high: 'warning',
    normal: 'info',
    ok: 'neutral',
  }

/** "12 pcs" / "2 strips (20 tabs)" in the UI language. */
export function qtyText(milli: number, item: Pick<StockSenseItem, 'unit' | 'pack_size'>): string {
  if (item.pack_size > 1 && Math.abs(milli) >= item.pack_size * 1000) {
    const packs = formatPackQty(milli, item.pack_size, item.unit, packUnitFor(item.unit))
    const base = formatQty(milli, item.unit)
    return `${packs} (${base})`
  }
  return formatQty(milli, item.unit)
}

function daysPhrase(n: number): string {
  const lang = getLanguage()
  if (lang === 'ta') return n === 1 ? '1 நாள்' : `${String(n)} நாட்கள்`
  return n === 1 ? '1 day' : `${String(n)} days`
}

/** One translated line: why this quantity (or why nothing) is recommended. */
export function explainItem(item: StockSenseItem, cycleDays: number, safetyDays: number): string {
  const cover = item.cover_days ?? 0
  const vars = {
    daily: qtyText(item.daily_milli, item),
    stock: qtyText(item.usable_milli, item),
    cover,
    cover_text: daysPhrase(cover),
    lead: item.lead_time_days,
    lead_text: daysPhrase(item.lead_time_days),
    cycle: cycleDays,
    cycle_text: daysPhrase(cycleDays),
    safety: safetyDays,
    safety_text: daysPhrase(safetyDays),
    shelf: item.shelf_life_days ?? 0,
    incoming: qtyText(item.incoming_milli, item),
    qty: qtyText(item.order_qty_milli, item),
    need: qtyText(item.horizon_demand_milli + item.safety_milli, item),
  }
  const main = translate(`purchases:stocksense.reason.${item.reason}`, vars)
  return item.capped_by_shelf_life && item.order_qty_milli > 0
    ? `${main} ${translate('purchases:stocksense.reason_capped', vars)}`
    : main
}

/** Downloads the sales-history CSV template (product, date, qty). */
export function downloadSalesTemplate(today: string): void {
  const d = new Date(`${today}T00:00:00Z`)
  const day = (n: number): string =>
    new Date(d.getTime() - n * 86_400_000).toISOString().slice(0, 10)
  const csv = `product,date,qty\nSKU-001,${day(2)},12\nSKU-001,${day(1)},9.5\n`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'stocksense-sales-history.csv'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
