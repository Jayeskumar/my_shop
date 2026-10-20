/**
 * UPI helpers (NPCI UPI linking specification): VPA validation, `upi://pay` intent URIs
 * rendered as QR codes by the POS (works offline), and payment reference codes (`tr`).
 */
import { assertSafeInt } from './math'
import { paiseToRupeesString, tryParseRupees } from './money'

/** Same rule as payment_provider_accounts.vpa CHECK (migration 0006): handle@psp. */
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/

export function isValidVpa(vpa: unknown): vpa is string {
  return typeof vpa === 'string' && VPA_RE.test(vpa)
}

/** Lower-cases and trims a VPA ("Shop.Name@OKSBI " → "shop.name@oksbi"); VPAs are case-insensitive. */
export function normalizeVpa(vpa: string): string {
  return vpa.trim().toLowerCase()
}

export interface UpiUriParams {
  /** Payee VPA (`pa`). */
  vpa: string
  /** Payee name (`pn`). */
  payee_name: string
  /** Fixed amount (`am`, rupees with 2 decimals); omit for a static "enter amount" QR. */
  amount_paise?: number | null
  /** Transaction note (`tn`), truncated to 50 characters. */
  note?: string | null
  /** Transaction reference (`tr`): 1–35 letters/digits, used for reconciliation. */
  reference?: string | null
  /** Merchant category code (`mc`), 4 digits (5411 grocery, 5912 pharmacy, …). */
  mcc?: string | null
}

export const UPI_NOTE_MAX_LENGTH = 50
export const UPI_REFERENCE_RE = /^[A-Za-z0-9]{1,35}$/

/** Truncates to at most `max` code points without splitting a grapheme (Tamil vowel signs etc.). */
function truncateGraphemes(text: string, max: number): string {
  if ([...text].length <= max) return text
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (!Segmenter) return [...text].slice(0, max).join('')
  let out = ''
  let length = 0
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const size = [...segment].length
    if (length + size > max) break
    out += segment
    length += size
  }
  return out
}

function encodeValue(value: string): string {
  return encodeURIComponent(value)
}

/**
 * Builds a UPI intent URI: upi://pay?pa=…&pn=…&am=123.45&cu=INR&tn=…&tr=…&mc=…
 * Values are percent-encoded with encodeURIComponent, except that '@' in `pa` is kept literal
 * (it is a legal query character and some older UPI apps do not decode %40 in the VPA).
 * Absent parameters are omitted; `cu=INR` is always present.
 * @throws RangeError for an invalid VPA, amount, reference or MCC.
 */
export function buildUpiUri(params: UpiUriParams): string {
  const vpa = params.vpa.trim()
  if (!isValidVpa(vpa)) throw new RangeError(`invalid UPI VPA: ${JSON.stringify(params.vpa)}`)
  const name = params.payee_name.trim()
  if (name === '') throw new RangeError('payee_name is required')
  const query: string[] = [`pa=${encodeValue(vpa).replace(/%40/g, '@')}`, `pn=${encodeValue(name)}`]
  if (params.amount_paise != null) {
    assertSafeInt(params.amount_paise, 'amount_paise')
    if (params.amount_paise <= 0) throw new RangeError('amount_paise must be > 0')
    query.push(`am=${paiseToRupeesString(params.amount_paise)}`)
  }
  query.push('cu=INR')
  const note = params.note?.trim()
  if (note) query.push(`tn=${encodeValue(truncateGraphemes(note, UPI_NOTE_MAX_LENGTH))}`)
  if (params.reference != null) {
    if (!UPI_REFERENCE_RE.test(params.reference)) throw new RangeError('reference must be 1-35 letters or digits')
    query.push(`tr=${params.reference}`)
  }
  if (params.mcc != null) {
    if (!/^\d{4}$/.test(params.mcc)) throw new RangeError('mcc must be 4 digits')
    query.push(`mc=${params.mcc}`)
  }
  return `upi://pay?${query.join('&')}`
}

export interface ParsedUpiUri {
  vpa: string
  payee_name: string | null
  amount_paise: number | null
  currency: string | null
  note: string | null
  reference: string | null
  mcc: string | null
  /** Every decoded parameter, including unknown ones (tid, url, mode, …). */
  params: Record<string, string>
}

/** Parses a `upi://pay?…` URI (e.g. a scanned QR). Returns null when it is not a valid UPI intent. */
export function parseUpiUri(uri: string): ParsedUpiUri | null {
  const m = /^upi:\/\/pay\?(.*)$/i.exec(uri.trim())
  if (!m) return null
  const params: Record<string, string> = {}
  for (const pair of (m[1] ?? '').split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1)
    try {
      // '+' as space for form-encoded generators; our own URIs encode '+' as %2B.
      params[decodeURIComponent(rawKey).toLowerCase()] = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      return null
    }
  }
  const vpa = params.pa
  if (!vpa || !isValidVpa(vpa)) return null
  let amount: number | null = null
  if (params.am !== undefined && params.am !== '') {
    amount = tryParseRupees(params.am)
    if (amount === null) return null
  }
  return {
    vpa,
    payee_name: params.pn ?? null,
    amount_paise: amount,
    currency: params.cu ?? null,
    note: params.tn ?? null,
    reference: params.tr ?? null,
    mcc: params.mc ?? null,
    params,
  }
}

const REFERENCE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const REFERENCE_CODE_LENGTH = 12

interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T
}

function getCrypto(): CryptoLike {
  const c = (globalThis as { crypto?: CryptoLike }).crypto
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('Web Crypto (crypto.getRandomValues) is not available')
  return c
}

/**
 * Random payment reference code (UPI `tr`, provider receipt): `prefix` + uppercase alphanumerics,
 * 12 characters in total, e.g. "KD7Q2M9X4LZ0". Uses crypto.getRandomValues with rejection
 * sampling (no modulo bias). 10 random characters ≈ 51.7 bits.
 */
export function generateReferenceCode(prefix = 'KD'): string {
  if (!/^[A-Z0-9]{0,8}$/.test(prefix)) throw new RangeError('prefix must be 0-8 uppercase letters or digits')
  const needed = REFERENCE_CODE_LENGTH - prefix.length
  const crypto = getCrypto()
  let out = prefix
  // 252 = 7 × 36: bytes ≥ 252 are rejected so every character is equally likely.
  while (out.length < REFERENCE_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(needed * 2))
    for (const b of bytes) {
      if (b < 252 && out.length < REFERENCE_CODE_LENGTH) out += REFERENCE_ALPHABET.charAt(b % 36)
    }
  }
  return out
}
