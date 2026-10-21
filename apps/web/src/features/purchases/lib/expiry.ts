/**
 * Quick expiry entry of the bill grid: shopkeepers copy "MM/YY" from the strip / carton
 * ("12/27" → 31-12-2027, the last day of the month). A full date (dd-MM-yyyy) is accepted too.
 */
import { formatDateDisplay, isDateStr, parseDisplayDate } from '@kadai/shared/fy'
import { expiryFromMonthYear } from '@kadai/shared/api/purchases'

/** 'YYYY-MM-DD' → the text shown in the expiry cell: 'MM/YY' for a month-end date, else dd-MM-yyyy. */
export function expiryInputText(date: string | null | undefined): string {
  if (!date || !isDateStr(date)) return ''
  const [y, m] = date.split('-')
  if (expiryFromMonthYear(`${m}/${y}`) === date) return `${m}/${y!.slice(2)}`
  return formatDateDisplay(date)
}

/**
 * Normalises typing in the expiry cell: digits and one separator; "1227" → "12/27",
 * "122027" → "12/2027". Longer full dates (dd-MM-yyyy) are left alone.
 */
export function normalizeExpiryTyping(raw: string): string {
  const cleaned = raw.replace(/[^\d/\-.]/g, '')
  if (/^\d{3,6}$/.test(cleaned)) return `${cleaned.slice(0, 2)}/${cleaned.slice(2)}`
  return cleaned.slice(0, 10)
}

export type ExpiryParse =
  | { kind: 'empty' }
  | { kind: 'ok'; date: string }
  | { kind: 'invalid' }

/** Parses the expiry cell: MM/YY, MM/YYYY or dd-MM-yyyy. */
export function parseExpiryText(text: string): ExpiryParse {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'empty' }
  const monthYear = expiryFromMonthYear(trimmed)
  if (monthYear) return { kind: 'ok', date: monthYear }
  const full = parseDisplayDate(trimmed)
  if (full) return { kind: 'ok', date: full }
  return { kind: 'invalid' }
}
