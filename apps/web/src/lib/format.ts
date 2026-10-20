/**
 * Display formatting (edge only — data stays in paise / milli / ISO strings).
 * Dates are shown dd-MM-yyyy (ARCHITECTURE.md §16); instants are shown in the tenant timezone
 * (default Asia/Kolkata). Numbers use Indian digit grouping.
 */
import { formatDateDisplay, isDateStr, DEFAULT_TIMEZONE } from '@kadai/shared/fy'
import { formatINR, formatINRCompact, formatBp, type FormatINROptions } from '@kadai/shared/money'
import { formatPhoneDisplay } from '@kadai/shared/phone'
import { formatPacksAndLoose, formatQty as sharedFormatQty } from '@kadai/shared/units'
import { amountInWords as sharedAmountInWords } from '@kadai/shared/words'
import { getLanguage, type Language } from './i18n'

export { formatBp, formatINRCompact }

/** ₹1,23,456.50 */
export function formatMoney(paise: number, options?: FormatINROptions): string {
  return formatINR(paise, options)
}

/** Quantity with unit symbol in the UI language: 1500 milli KG → "1.5 kg" / "1.5 கிலோ". */
export function formatQty(qtyMilli: number, unit: string, lng: Language = getLanguage()): string {
  return sharedFormatQty(qtyMilli, unit, lng)
}

/** Pharmacy strips: 23 tabs in packs of 10 → "2 strips + 3 tabs". */
export function formatPackQty(
  qtyMilli: number,
  packSize: number,
  unit: string,
  packUnit = 'PACK',
  lng: Language = getLanguage(),
): string {
  return formatPacksAndLoose(qtyMilli, packSize, unit, packUnit, lng)
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
function dtf(
  key: string,
  options: Intl.DateTimeFormatOptions,
  locale = 'en-IN',
): Intl.DateTimeFormat {
  const id = `${locale}|${key}|${options.timeZone ?? ''}`
  let f = dateTimeFormatters.get(id)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options)
    dateTimeFormatters.set(id, f)
  }
  return f
}

function toDate(value: string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function partsOf(date: Date, timeZone: string): Record<string, string> {
  const parts = dtf(
    'parts',
    {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h12',
    },
    'en-IN',
  ).formatToParts(date)
  return Object.fromEntries(parts.map((p) => [p.type, p.value]))
}

/**
 * dd-MM-yyyy. Accepts a business date ('2026-10-20', shown as-is — no timezone shift) or an
 * instant (ISO string / Date, converted to the tenant timezone first).
 */
export function formatDate(
  value: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string' && isDateStr(value)) return formatDateDisplay(value)
  const d = toDate(value)
  if (!d) return ''
  const p = partsOf(d, timeZone)
  return `${p.day}-${p.month}-${p.year}`
}

/** dd-MM-yyyy hh:mm AM/PM in the tenant timezone (IST by default). */
export function formatDateTime(
  value: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (!value) return ''
  const d = toDate(value)
  if (!d) return ''
  const p = partsOf(d, timeZone)
  const period = (p.dayPeriod ?? '').toUpperCase()
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}${period ? ` ${period}` : ''}`
}

/** hh:mm AM/PM in the tenant timezone. */
export function formatTime(
  value: string | Date | null | undefined,
  timeZone = DEFAULT_TIMEZONE,
): string {
  if (!value) return ''
  const d = toDate(value)
  if (!d) return ''
  const p = partsOf(d, timeZone)
  const period = (p.dayPeriod ?? '').toUpperCase()
  return `${p.hour}:${p.minute}${period ? ` ${period}` : ''}`
}

const relativeFormatters = new Map<Language, Intl.RelativeTimeFormat>()

/** "5 minutes ago" / "5 நிமிடங்களுக்கு முன்"; beyond a week falls back to dd-MM-yyyy. */
export function formatRelative(
  value: string | Date | null | undefined,
  lng: Language = getLanguage(),
  now: Date = new Date(),
): string {
  if (!value) return ''
  const d = toDate(value)
  if (!d) return ''
  const diffSeconds = Math.round((d.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(diffSeconds)
  let rtf = relativeFormatters.get(lng)
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(lng === 'ta' ? 'ta-IN' : 'en-IN', { numeric: 'auto' })
    relativeFormatters.set(lng, rtf)
  }
  if (abs < 45) return rtf.format(0, 'second')
  if (abs < 45 * 60) return rtf.format(Math.round(diffSeconds / 60), 'minute')
  if (abs < 22 * 3600) return rtf.format(Math.round(diffSeconds / 3600), 'hour')
  if (abs < 7 * 86400) return rtf.format(Math.round(diffSeconds / 86400), 'day')
  return formatDate(d)
}

/** "98765 43210" (or "+91 98765 43210"). */
export function formatPhone(phone: string | null | undefined, withCountryCode = false): string {
  if (!phone) return ''
  return formatPhoneDisplay(phone, { withCountryCode })
}

/** Amount in words in the UI language (invoices print both). */
export function amountInWords(paise: number, lng: Language = getLanguage()): string {
  return sharedAmountInWords(paise, lng)
}

const numberFormatters = new Map<string, Intl.NumberFormat>()

/** Plain number with Indian grouping: 1234567 → "12,34,567". */
export function formatNumber(value: number, maximumFractionDigits = 0): string {
  const key = String(maximumFractionDigits)
  let f = numberFormatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-IN', { maximumFractionDigits })
    numberFormatters.set(key, f)
  }
  return f.format(value)
}

/** Percentage from basis points with sign: 1250 → "+12.5%". */
export function formatChangeBp(bp: number): string {
  const sign = bp > 0 ? '+' : bp < 0 ? '−' : ''
  return `${sign}${formatBp(Math.abs(bp))}`
}
