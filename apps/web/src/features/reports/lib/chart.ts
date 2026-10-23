/**
 * Chart helpers shared by the dashboard and the report viewer: Indian-style compact money for axis
 * ticks (₹950 · ₹45K · ₹1.2 L · ₹3.4 Cr) and the series colours (design tokens, so dark mode
 * follows the theme; never colour-alone — every chart also has a legend and a table).
 */
import { formatINR } from '@kadai/shared/money'
import type { Language } from '@/lib/i18n'

/** Series colours in fixed order (identity follows the series, never its rank). */
export const SERIES_COLORS = ['var(--primary)', 'var(--accent)', 'var(--info)'] as const

const LAKH_PAISE = 100_000 * 100
const CRORE_PAISE = 100 * LAKH_PAISE

function trimmed(n: number): string {
  return n.toFixed(n >= 10 ? 0 : 1).replace(/\.0$/, '')
}

/** Short money for axis ticks. */
export function axisMoney(paise: number, lng: Language): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  if (abs >= CRORE_PAISE)
    return `${sign}₹${trimmed(abs / CRORE_PAISE)} ${lng === 'ta' ? 'கோடி' : 'Cr'}`
  if (abs >= LAKH_PAISE)
    return `${sign}₹${trimmed(abs / LAKH_PAISE)} ${lng === 'ta' ? 'லட்சம்' : 'L'}`
  if (abs >= 1_000_000) return `${sign}₹${trimmed(abs / 100_000)}K`
  return `${sign}${formatINR(abs, { decimals: 0 })}`
}

/** Short label for a category axis (long product / category names are cut). */
export function axisText(text: string, max = 14): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Value-axis domain that always includes zero and never collapses: an all-zero (or tiny) series
 * would otherwise print "₹0" on every tick.
 */
export function valueDomain(
  format: 'money' | 'int',
): [(dataMin: number) => number, (dataMax: number) => number] {
  const floor = format === 'money' ? 100 * 100 : 4
  return [(dataMin) => Math.min(0, dataMin), (dataMax) => Math.max(dataMax, floor)]
}
