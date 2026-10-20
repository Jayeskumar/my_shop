/**
 * Pure parsing / formatting used by MoneyInput, NumberInput and QtyInput (unit-tested in
 * input-parsing.test.ts). Integer arithmetic only — no float rounding.
 */
import { formatINR, paiseToRupeesString, tryParseRupees } from '@kadai/shared/money'
import { tryParseQty } from '@kadai/shared/units'

/** Grouped display text for a paise value ('' for empty). */
export function formatMoneyInputValue(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return ''
  return formatINR(paise, { symbol: false, decimals: 2 })
}

/** Editing text: no grouping, no trailing ".00" (easy to overwrite). */
export function moneyEditingText(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return ''
  return paiseToRupeesString(paise).replace(/\.00$/, '')
}

/** Parses typed text, ignoring grouping commas typed mid-way (e.g. "1,5" while typing "1,500"). */
export function parseMoneyText(text: string, allowNegative = false): number | null {
  const compact = text.replace(/,/g, '').trim()
  if (compact === '') return null
  return tryParseRupees(compact, { allowNegative })
}

const ZERO_RE = /^0*(\.0*)?$/

/** Parses quantity text; '0' is accepted when the minimum allows it. */
export function parseQtyText(
  text: string,
  unit: string,
  options: { allowDecimal?: boolean; min?: number } = {},
): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (ZERO_RE.test(trimmed) && (options.min ?? 0) <= 0 && /\d/.test(trimmed)) return 0
  return tryParseQty(trimmed, unit, { allowDecimal: options.allowDecimal })
}

/** "12.5" with scale 100 → 1250 (string arithmetic, no float error). */
export function parseScaled(
  text: string,
  scale: number,
  decimals: number,
  allowNegative: boolean,
): number | null {
  const trimmed = text.trim()
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(trimmed)
  if (!m || trimmed === '' || trimmed === '-' || trimmed === '.') return null
  const [, sign, int = '', frac = ''] = m
  if (sign && !allowNegative) return null
  if (frac.length > decimals) return null
  if (int === '' && frac === '') return null
  const scaleDigits = Math.round(Math.log10(scale))
  if (scale === 1) {
    if (decimals === 0) {
      const n = Number(int || '0')
      return Number.isSafeInteger(n) ? (sign ? -n : n) : null
    }
    const n = Number(`${int || '0'}.${frac || '0'}`)
    return Number.isFinite(n) ? (sign ? -n : n) : null
  }
  if (frac.length > scaleDigits) return null
  const n = Number(int || '0') * scale + Number(frac.padEnd(scaleDigits, '0') || '0')
  if (!Number.isSafeInteger(n)) return null
  return sign ? -n : n
}

export function formatScaled(value: number, scale: number): string {
  if (scale === 1) return String(value)
  const digits = Math.round(Math.log10(scale))
  const abs = Math.abs(value)
  const whole = Math.trunc(abs / scale)
  const frac = abs % scale
  const fracText = frac === 0 ? '' : `.${String(frac).padStart(digits, '0').replace(/0+$/, '')}`
  return `${value < 0 ? '-' : ''}${whole}${fracText}`
}
