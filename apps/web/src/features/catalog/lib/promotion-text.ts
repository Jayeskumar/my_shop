/**
 * Human text of promotions in the UI language: the shared `promotionSummary()` key + raw params
 * rendered from catalog:promotion_summary.*, and the schedule line.
 */
import { promotionSummary } from '@kadai/shared/api/catalog'
import { DEFAULT_TIMEZONE, addDays, toDateStr } from '@kadai/shared/fy'
import { formatBp } from '@kadai/shared/money'
import type { PromotionKind } from '@kadai/shared/promotions'
import { formatDate, formatMoney } from '@/lib/format'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'

const tr = (key: string, params?: Record<string, unknown>): string =>
  translate(`catalog:${key}` as TranslationKey, params)

function units(milli: number): string {
  const n = milli / 1000
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '')
}

/** "20% off (when buying 2 or more, up to ₹100)" / "Buy 2 get 1 free". */
export function promotionText(p: { kind: PromotionKind; rules: unknown }): string {
  const { key, params } = promotionSummary(p)
  const main = tr(`promotion_summary.${key}`, {
    percent: params.percent_bp !== undefined ? formatBp(params.percent_bp) : '',
    amount:
      params.flat_paise !== undefined ? formatMoney(params.flat_paise, { decimals: 'auto' }) : '',
    buy: params.buy_qty ?? 0,
    get: params.get_qty ?? 0,
    discount: params.get_discount_bp !== undefined ? formatBp(params.get_discount_bp) : '',
    count: params.item_count ?? 0,
    price:
      params.combo_price_paise !== undefined
        ? formatMoney(params.combo_price_paise, { decimals: 'auto' })
        : '',
  })
  const extras: string[] = []
  if (params.min_qty_milli !== undefined)
    extras.push(tr('promotion_summary.min_qty', { qty: units(params.min_qty_milli) }))
  if (params.min_bill_paise !== undefined)
    extras.push(
      tr('promotion_summary.min_bill', {
        amount: formatMoney(params.min_bill_paise, { decimals: 'auto' }),
      }),
    )
  if (params.max_discount_paise !== undefined)
    extras.push(
      tr('promotion_summary.max_discount', {
        amount: formatMoney(params.max_discount_paise, { decimals: 'auto' }),
      }),
    )
  return extras.length ? `${main} (${extras.join(', ')})` : main
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

export function dayShort(day: number): string {
  return tr(`days.${DAY_KEYS[day] ?? 'sun'}`)
}

/** Date window and weekdays of a promotion: ["01-11-2026 – 15-11-2026", "Sat, Sun"]. */
export function scheduleParts(
  p: { starts_at: string | null; ends_at: string | null; days_of_week: number[] | null },
  timeZone: string = DEFAULT_TIMEZONE,
): { range: string | null; days: string | null } {
  const start = p.starts_at ? formatDate(p.starts_at, timeZone) : null
  const lastDay = p.ends_at
    ? formatDate(addDays(toDateStr(new Date(Date.parse(p.ends_at) - 1), timeZone), 0))
    : null
  const range =
    start && lastDay
      ? `${start} – ${lastDay}`
      : start
        ? tr('promotions.from_date', { date: start })
        : lastDay
          ? tr('promotions.until_date', { date: lastDay })
          : null
  const days =
    p.days_of_week && p.days_of_week.length < 7 ? p.days_of_week.map(dayShort).join(', ') : null
  return { range, days }
}

/** "01-11-2026 – 15-11-2026 · Sat, Sun" / "Every Sat, Sun" / "Always on". */
export function scheduleText(
  p: { starts_at: string | null; ends_at: string | null; days_of_week: number[] | null },
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const { range, days } = scheduleParts(p, timeZone)
  if (range && days) return `${range} · ${days}`
  if (range) return range
  if (days) return tr('promotions.every_days', { days })
  return tr('promotions.always')
}
