/**
 * Localized validation messages for forms built on the shared zod schemas.
 *
 * Zod messages are produced at parse time, but the UI language can change afterwards, and the
 * shared schemas carry fixed English messages ("Enter a valid 10-digit Indian mobile number").
 * So messages are translated at RENDER time (FormField → localizeValidationMessage):
 *  1. A global zod `customError` turns common issues (required, min/max length, email, enum)
 *     into tokens like `@kadai:min_length?min=8`, rendered from errors:validation.*.
 *  2. Known English messages from @kadai/shared (and identical server VALIDATION_ERROR issue
 *     messages) are mapped to the same keys.
 *  3. Anything else falls back to zod's own ta/en locale (configured on language change) or is
 *     shown as-is.
 */
import { z } from 'zod'
import enLocale from 'zod/v4/locales/en.js'
import taLocale from 'zod/v4/locales/ta.js'
import i18next from 'i18next'
import type { Resources } from './i18n-resources'

export type ValidationKey = keyof Resources['errors']['validation']

const TOKEN_PREFIX = '@kadai:'

function token(key: ValidationKey, params?: Record<string, string | number>): string {
  const query = params
    ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`
    : ''
  return `${TOKEN_PREFIX}${key}${query}`
}

type RawIssue = Parameters<z.core.$ZodErrorMap>[0]

/** Maps generic zod issues to localizable tokens; undefined = let the zod locale decide. */
const customError: z.core.$ZodErrorMap = (issue: RawIssue) => {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null || issue.input === '')
        return token('required')
      if (issue.expected === 'number' || issue.expected === 'int') return token('number')
      return undefined
    case 'too_small': {
      const min = Number(issue.minimum)
      if (issue.origin === 'string') return min <= 1 ? token('required') : token('min_length', { min })
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint')
        return token('min_value', { min })
      if (issue.origin === 'array' && min <= 1) return token('select')
      return undefined
    }
    case 'too_big': {
      const max = Number(issue.maximum)
      if (issue.origin === 'string') return token('max_length', { max })
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint')
        return token('max_value', { max })
      return undefined
    }
    case 'invalid_format':
      if (issue.format === 'email') return token('email')
      if (issue.format === 'date' || issue.format === 'datetime') return token('date')
      return undefined
    case 'invalid_value':
      return token('select')
    case 'invalid_union': {
      // e.g. optional email: union(literal(''), email) — report the email problem.
      const nested = (issue as { errors?: unknown }).errors
      if (Array.isArray(nested) && JSON.stringify(nested).includes('"format":"email"'))
        return token('email')
      return undefined
    }
    default:
      return undefined
  }
}

/** Applies the zod locale for `lng` (fallback messages) plus Kadai's localizable tokens. */
export function configureValidationLocale(lng: 'ta' | 'en'): void {
  const locale = lng === 'ta' ? taLocale() : enLocale()
  z.config({ ...locale, customError })
}

/**
 * Fixed English messages used by @kadai/shared schemas (and returned by the server in
 * VALIDATION_ERROR details) → translation keys. Keep in sync when shared adds messages.
 */
const KNOWN_MESSAGES: Readonly<Record<string, ValidationKey>> = {
  'Enter a valid 10-digit Indian mobile number': 'phone',
  'Invalid GSTIN': 'gstin',
  'GSTIN state code does not match the selected state': 'gstin_state',
  'An unregistered business cannot have a GSTIN': 'gstin_unregistered',
  'GSTIN is required for registered businesses': 'gstin_required',
  'Password must be at least 8 characters': 'password_min',
  'Password cannot be only spaces': 'password_spaces',
  'New password must be different from the current password': 'password_same',
  'Enter the 6-digit OTP': 'otp',
  'PIN must be 4 to 6 digits': 'pin',
  'Enter a valid 6-digit PIN code': 'pincode',
  'HSN/SAC must be 4, 6 or 8 digits': 'hsn',
  'Invalid date': 'date',
  '`from` must not be after `to`': 'date_order',
  'Expected YYYY-MM': 'date',
}

const VALIDATION_KEYS = new Set<string>(Object.values(KNOWN_MESSAGES))

function isValidationKey(key: string): key is ValidationKey {
  return (
    VALIDATION_KEYS.has(key) ||
    i18next.exists(`errors:validation.${key}`, { lng: 'en' }) // keys added later in errors.json
  )
}

/** Builds a token for a validation key (use in custom form refinements: `message: vt('...')`). */
export function validationToken(key: ValidationKey, params?: Record<string, string | number>): string {
  return token(key, params)
}

/** Translates a validation message (token, known shared message, or free text) for display. */
export function localizeValidationMessage(message: string | undefined | null): string | undefined {
  if (!message) return undefined
  if (message.startsWith(TOKEN_PREFIX)) {
    const [rawKey = '', query = ''] = message.slice(TOKEN_PREFIX.length).split('?')
    if (!isValidationKey(rawKey)) return message
    const replace: Record<string, string> = Object.fromEntries(new URLSearchParams(query))
    return i18next.t(`errors:validation.${rawKey}`, { replace })
  }
  const known = KNOWN_MESSAGES[message]
  if (known) return i18next.t(`errors:validation.${known}`)
  if (message.startsWith('Password must be at least')) return i18next.t('errors:validation.password_min')
  return message
}
