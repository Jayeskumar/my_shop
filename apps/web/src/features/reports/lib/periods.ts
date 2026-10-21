/** Month / date wording of the report screens (Intl, tenant-neutral: periods are plain months). */
import type { Language } from '@/lib/i18n'

const monthFormatters = new Map<string, Intl.DateTimeFormat>()

function formatter(lng: Language, options: Intl.DateTimeFormatOptions, key: string) {
  const id = `${lng}|${key}`
  let f = monthFormatters.get(id)
  if (!f) {
    f = new Intl.DateTimeFormat(lng === 'ta' ? 'ta-IN' : 'en-IN', { timeZone: 'UTC', ...options })
    monthFormatters.set(id, f)
  }
  return f
}

function utcDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 15, 12))
}

/** '2026-09' → "September 2026" / "செப்டம்பர் 2026". */
export function periodLabel(period: string, lng: Language): string {
  return formatter(lng, { month: 'long', year: 'numeric' }, 'month').format(utcDate(`${period}-15`))
}

/** '2026-10-21' → "Wednesday, 21 October 2026" / "புதன், 21 அக்டோபர் 2026". */
export function longDate(date: string, lng: Language): string {
  return formatter(
    lng,
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
    'long',
  ).format(utcDate(date))
}

/** '2026-10-21' → "21 Oct" / "21 அக்." (chart axes). */
export function shortDate(date: string, lng: Language): string {
  return formatter(lng, { day: 'numeric', month: 'short' }, 'short').format(utcDate(date))
}

/** '2026-10-21' → "Wed" / "புத." (tooltips). */
export function weekdayShort(date: string, lng: Language): string {
  return formatter(lng, { weekday: 'short' }, 'weekday').format(utcDate(date))
}
