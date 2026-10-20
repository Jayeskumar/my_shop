/**
 * Money helpers. Amounts are integer paise everywhere (₹1 = 100 paise); formatting to rupees
 * happens only at the edge (UI, print, CSV). Indian digit grouping (1,23,456.50) via Intl en-IN.
 */
import { assertSafeInt, mulDiv, roundDiv, sumSafe, toSafeNumber } from './math'

export interface ParseRupeesOptions {
  /** Accept a leading minus sign (opening balances, adjustments). Default false. */
  allowNegative?: boolean
}

const CURRENCY_PREFIX_RE = /^(?:₹|rs\.?|inr)\s*/i
const NUMBER_RE = /^(\d[\d,]*)?(?:\.(\d*))?$/
const INDIAN_GROUPING_RE = /^\d{1,2}(?:,\d{2})*,\d{3}$/
const WESTERN_GROUPING_RE = /^\d{1,3}(?:,\d{3})+$/

/**
 * Parses a rupee amount typed by a user (or a JSON number) into paise.
 * Accepts "1,23,456.50", "123,456.50", "₹ 99", "Rs. 99", "INR 10", "500/-", ".5", 12.5.
 * Rejects more than 2 decimals, malformed digit grouping ("1,5"), exponents and empty input.
 * @throws RangeError when the input is not a valid amount.
 */
export function parseRupees(input: string | number, options: ParseRupeesOptions = {}): number {
  const paise = tryParseRupees(input, options)
  if (paise === null) throw new RangeError(`invalid rupee amount: ${JSON.stringify(input)}`)
  return paise
}

/** Like {@link parseRupees} but returns null instead of throwing. */
export function tryParseRupees(
  input: string | number,
  options: ParseRupeesOptions = {},
): number | null {
  let s: string
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    // Shortest round-trip representation: 19.99 -> "19.99"; 0.1 + 0.2 -> rejected (>2 dp).
    s = String(input)
  } else if (typeof input === 'string') {
    s = input
  } else {
    return null
  }

  s = s.trim()
  // One optional sign, either before or after the currency symbol: "-₹10", "₹ -10".
  let negative = false
  let signSeen = false
  const takeSign = (): void => {
    const c = s[0]
    if (!signSeen && (c === '-' || c === '+' || c === '−')) {
      signSeen = true
      negative = c !== '+'
      s = s.slice(1).trimStart()
    }
  }
  takeSign()
  s = s.replace(CURRENCY_PREFIX_RE, '')
  takeSign()
  s = s.replace(/\s*\/-$/, '').trim()

  const m = NUMBER_RE.exec(s)
  if (!m) return null
  const intPart = m[1] ?? ''
  const fracPart = m[2] ?? ''
  if (intPart === '' && fracPart === '') return null
  if (fracPart.length > 2) return null
  if (
    intPart.includes(',') &&
    !INDIAN_GROUPING_RE.test(intPart) &&
    !WESTERN_GROUPING_RE.test(intPart)
  ) {
    return null
  }
  if (negative && !options.allowNegative) return null

  const digits = intPart.replaceAll(',', '') || '0'
  const paise = BigInt(digits) * 100n + BigInt(fracPart.padEnd(2, '0'))
  try {
    const value = toSafeNumber(paise)
    return negative ? -value + 0 : value
  } catch {
    return null
  }
}

/** Plain decimal rupees without grouping or symbol: 123450 → "1234.50", -5 → "-0.05". */
export function paiseToRupeesString(paise: number): string {
  assertSafeInt(paise, 'paise')
  const abs = Math.abs(paise)
  const paisePart = abs % 100
  const rupees = (abs - paisePart) / 100
  return `${paise < 0 ? '-' : ''}${rupees}.${String(paisePart).padStart(2, '0')}`
}

export interface FormatINROptions {
  /** Prefix with "₹". Default true. */
  symbol?: boolean
  /** 2 = always two decimals (default); 0 = round to whole rupees; 'auto' = omit ".00". */
  decimals?: 2 | 0 | 'auto'
}

let groupingFormatter: Intl.NumberFormat | undefined
function groupRupees(rupees: number): string {
  groupingFormatter ??= new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
    useGrouping: true,
  })
  return groupingFormatter.format(rupees)
}

/**
 * Formats paise for display with Indian digit grouping: 12345650 → "₹1,23,456.50".
 * The integer rupee part is grouped by Intl (en-IN) and the paise are appended from integer
 * arithmetic, so no float rounding ever affects the shown value.
 */
export function formatINR(paise: number, options: FormatINROptions = {}): string {
  assertSafeInt(paise, 'paise')
  const { symbol = true, decimals = 2 } = options
  let abs = Math.abs(paise)
  if (decimals === 0) abs = roundDiv(abs, 100) * 100
  const paisePart = abs % 100
  const rupees = (abs - paisePart) / 100
  let text = groupRupees(rupees)
  if (decimals === 2 || (decimals === 'auto' && paisePart !== 0)) {
    text += `.${String(paisePart).padStart(2, '0')}`
  }
  const negative = paise < 0 && abs !== 0
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${text}`
}

/**
 * Short dashboard format: below ₹1 lakh as whole rupees ("₹56,780"), then lakh / crore with up
 * to two decimals ("₹1.23 L", "₹4.5 Cr"; Tamil: "₹1.23 லட்சம்", "₹4.5 கோடி").
 */
export function formatINRCompact(paise: number, locale: 'en' | 'ta' = 'en'): string {
  assertSafeInt(paise, 'paise')
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  const LAKH = 100_000 * 100
  const CRORE = 100 * LAKH
  const scaled = (divisor: number, label: string): string => {
    const hundredths = mulDiv(abs, 100, divisor)
    const frac = hundredths % 100
    const whole = (hundredths - frac) / 100
    const fracText = frac === 0 ? '' : `.${String(frac).padStart(2, '0').replace(/0$/, '')}`
    return `${sign}₹${groupRupees(whole)}${fracText} ${label}`
  }
  // Escalate on the *rounded* value so ₹99,99,999.99 shows as "₹1 Cr", not "₹100 L".
  if (mulDiv(abs, 100, LAKH) >= 100 * 100) return scaled(CRORE, locale === 'ta' ? 'கோடி' : 'Cr')
  if (abs >= LAKH) return scaled(LAKH, locale === 'ta' ? 'லட்சம்' : 'L')
  return `${sign}${formatINR(abs, { decimals: 0 })}`
}

export interface RoundToRupeeResult {
  rounded_paise: number
  /** rounded − original, in [−50, +50] (… 50 paise rounds up, away from zero). */
  round_off_paise: number
}

/** Rounds to the nearest rupee, half away from zero: 1050 → 1100 (+50), 1049 → 1000 (−49). */
export function roundToRupee(paise: number): RoundToRupeeResult {
  const rounded = roundDiv(paise, 100) * 100
  return { rounded_paise: rounded, round_off_paise: rounded - paise }
}

/** Exact sum of paise amounts (throws if any value or the total is not a safe integer). */
export function sumPaise(values: Iterable<number>): number {
  return sumSafe(values)
}

/** round(paise × bp / 10000): the share of an amount at a basis-point rate. */
export function applyBp(paise: number, bp: number): number {
  return mulDiv(paise, bp, 10_000)
}

/** Basis points as a percentage label: 1800 → "18%", 25 → "0.25%", 250 → "2.5%". */
export function formatBp(bp: number): string {
  assertSafeInt(bp, 'bp')
  const abs = Math.abs(bp)
  const whole = Math.trunc(abs / 100)
  const frac = abs % 100
  const fracText = frac === 0 ? '' : `.${String(frac).padStart(2, '0').replace(/0$/, '')}`
  return `${bp < 0 ? '-' : ''}${whole}${fracText}%`
}
