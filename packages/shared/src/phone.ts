/**
 * Indian mobile numbers. Stored as E.164 ('+919876543210'); users type 10 digits, often with
 * spaces, dashes, a leading 0 or a +91 / 91 / 0091 prefix.
 */

const MOBILE_FORMS = [
  /^\+91([6-9]\d{9})$/,
  /^0091([6-9]\d{9})$/,
  /^91([6-9]\d{9})$/,
  /^0([6-9]\d{9})$/,
  /^([6-9]\d{9})$/,
]

/** E.164: '+' then 8–15 digits (matches the DB CHECK on phone columns). */
const E164_RE = /^\+[1-9][0-9]{7,14}$/
const INDIAN_E164_RE = /^\+91([6-9]\d{4})(\d{5})$/

/**
 * Normalises an Indian mobile number to E.164, or returns null:
 * "98765 43210", "098765-43210", "+91 98765 43210", "(+91) 9876543210", "919876543210" → "+919876543210".
 */
export function normalizeIndianPhone(input: string): string | null {
  if (typeof input !== 'string') return null
  const compact = input.trim().replace(/[\s\-().]/g, '')
  for (const form of MOBILE_FORMS) {
    const m = form.exec(compact)
    if (m) return `+91${m[1]!}`
  }
  return null
}

export function isValidIndianMobile(input: string): boolean {
  return normalizeIndianPhone(input) !== null
}

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_RE.test(value)
}

/**
 * Display form: '+919876543210' → '98765 43210' (or '+91 98765 43210' with the country code).
 * Other valid inputs are normalised first; anything else is returned unchanged.
 */
export function formatPhoneDisplay(phone: string, options: { withCountryCode?: boolean } = {}): string {
  const normalized = INDIAN_E164_RE.test(phone) ? phone : (normalizeIndianPhone(phone) ?? phone)
  const m = INDIAN_E164_RE.exec(normalized)
  if (!m) return phone
  const local = `${m[1]!} ${m[2]!}`
  return options.withCountryCode ? `+91 ${local}` : local
}

/** WhatsApp / wa.me number (country code, no '+'): '+919876543210' → '919876543210'. */
export function toWhatsAppNumber(phone: string): string | null {
  const normalized = normalizeIndianPhone(phone) ?? (isE164(phone) ? phone : null)
  return normalized ? normalized.slice(1) : null
}

/** Masked for receipts/logs: '+919876543210' → '98XXX XX210'. */
export function maskPhone(phone: string): string {
  const normalized = normalizeIndianPhone(phone)
  if (!normalized) return phone.length > 4 ? `${'X'.repeat(phone.length - 3)}${phone.slice(-3)}` : 'XXXX'
  const d = normalized.slice(3)
  return `${d.slice(0, 2)}XXX XX${d.slice(7)}`
}
