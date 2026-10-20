/**
 * API error codes (ARCHITECTURE.md §7.3) with HTTP status and short localized messages.
 * The server always sends English `message`; the web maps `code` → localized text.
 */
import { z } from 'zod'

export const ERROR_CODES = {
  VALIDATION_ERROR: { status: 400 },
  OTP_INVALID: { status: 400 },
  OTP_EXPIRED: { status: 400 },
  UNAUTHENTICATED: { status: 401 },
  INVALID_CREDENTIALS: { status: 401 },
  SESSION_REVOKED: { status: 401 },
  FEATURE_NOT_IN_PLAN: { status: 402 },
  PLAN_LIMIT_REACHED: { status: 402 },
  FORBIDDEN: { status: 403 },
  TENANT_SUSPENDED: { status: 403 },
  DEVICE_NOT_TRUSTED: { status: 403 },
  LICENSE_INVALID: { status: 403 },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  DUPLICATE: { status: 409 },
  IDEMPOTENCY_MISMATCH: { status: 409 },
  IDEMPOTENCY_IN_PROGRESS: { status: 409 },
  STALE_WRITE: { status: 409 },
  SETUP_ALREADY_DONE: { status: 409 },
  NUMBER_SERIES_EXHAUSTED: { status: 409 },
  UNPROCESSABLE: { status: 422 },
  INSUFFICIENT_STOCK: { status: 422 },
  CREDIT_LIMIT_EXCEEDED: { status: 422 },
  RX_REQUIRED: { status: 422 },
  EXPIRED_BATCH: { status: 422 },
  ACCOUNT_LOCKED: { status: 423 },
  PIN_LOCKED: { status: 423 },
  RATE_LIMITED: { status: 429 },
  INTERNAL: { status: 500 },
  PROVIDER_ERROR: { status: 502 },
} as const satisfies Record<string, { status: number }>

export type ErrorCode = keyof typeof ERROR_CODES

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]

export const ErrorCodeSchema = z.enum(ERROR_CODE_LIST)

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(ERROR_CODES, code)
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code].status
}

export interface ValidationIssue {
  /** Dotted path of the offending field, e.g. "lines.2.qty_milli" ('' for the whole body). */
  path: string
  message: string
  code?: string
}

/** `details` of VALIDATION_ERROR responses. */
export interface ValidationErrorDetails {
  issues: ValidationIssue[]
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    /** English, developer-facing. */
    message: string
    details?: Record<string, unknown>
    request_id?: string
  }
}

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, { en: string; ta: string }>> = {
  VALIDATION_ERROR: {
    en: 'Please check the highlighted fields.',
    ta: 'குறிக்கப்பட்ட புலங்களைச் சரிபார்க்கவும்.',
  },
  OTP_INVALID: { en: 'The OTP is incorrect.', ta: 'OTP தவறானது.' },
  OTP_EXPIRED: {
    en: 'The OTP has expired. Please request a new one.',
    ta: 'OTP காலாவதியானது. புதியதைக் கோரவும்.',
  },
  UNAUTHENTICATED: { en: 'Please sign in again.', ta: 'மீண்டும் உள்நுழையவும்.' },
  INVALID_CREDENTIALS: {
    en: 'Wrong mobile number / email or password.',
    ta: 'மொபைல் எண் / மின்னஞ்சல் அல்லது கடவுச்சொல் தவறு.',
  },
  SESSION_REVOKED: {
    en: 'You were signed out. Please sign in again.',
    ta: 'நீங்கள் வெளியேற்றப்பட்டீர்கள். மீண்டும் உள்நுழையவும்.',
  },
  FEATURE_NOT_IN_PLAN: {
    en: 'This feature is not in your plan. Upgrade to use it.',
    ta: 'இந்த வசதி உங்கள் திட்டத்தில் இல்லை. மேம்படுத்தவும்.',
  },
  PLAN_LIMIT_REACHED: {
    en: 'You have reached your plan limit. Upgrade to add more.',
    ta: 'உங்கள் திட்ட வரம்பை அடைந்துவிட்டீர்கள். மேலும் சேர்க்க மேம்படுத்தவும்.',
  },
  FORBIDDEN: {
    en: 'You do not have permission to do this.',
    ta: 'இதைச் செய்ய உங்களுக்கு அனுமதி இல்லை.',
  },
  TENANT_SUSPENDED: {
    en: 'This account is suspended. Please contact support.',
    ta: 'இந்தக் கணக்கு இடைநிறுத்தப்பட்டுள்ளது. ஆதரவைத் தொடர்பு கொள்ளவும்.',
  },
  DEVICE_NOT_TRUSTED: {
    en: 'This device is not registered for PIN login.',
    ta: 'இந்தச் சாதனம் PIN உள்நுழைவுக்குப் பதிவு செய்யப்படவில்லை.',
  },
  LICENSE_INVALID: {
    en: 'The licence is invalid or expired.',
    ta: 'உரிமம் செல்லாதது அல்லது காலாவதியானது.',
  },
  NOT_FOUND: { en: 'Not found.', ta: 'கிடைக்கவில்லை.' },
  CONFLICT: {
    en: 'This conflicts with existing data.',
    ta: 'இது ஏற்கனவே உள்ள தரவுடன் முரண்படுகிறது.',
  },
  DUPLICATE: { en: 'This already exists.', ta: 'இது ஏற்கனவே உள்ளது.' },
  IDEMPOTENCY_MISMATCH: {
    en: 'This request was already sent with different details.',
    ta: 'இந்தக் கோரிக்கை வேறு விவரங்களுடன் ஏற்கனவே அனுப்பப்பட்டது.',
  },
  IDEMPOTENCY_IN_PROGRESS: {
    en: 'This request is still being processed. Please wait.',
    ta: 'இந்தக் கோரிக்கை இன்னும் செயலாக்கப்படுகிறது. காத்திருக்கவும்.',
  },
  STALE_WRITE: {
    en: 'Someone else changed this. Reload and try again.',
    ta: 'வேறொருவர் இதை மாற்றியுள்ளார். புதுப்பித்து மீண்டும் முயலவும்.',
  },
  SETUP_ALREADY_DONE: { en: 'Setup is already complete.', ta: 'அமைப்பு ஏற்கனவே முடிந்தது.' },
  NUMBER_SERIES_EXHAUSTED: {
    en: 'Bill number series is full. Shorten the prefix in settings.',
    ta: 'பில் எண் வரிசை நிரம்பியது. அமைப்புகளில் முன்னொட்டைச் சுருக்கவும்.',
  },
  UNPROCESSABLE: { en: 'This action cannot be completed.', ta: 'இந்தச் செயலை முடிக்க இயலாது.' },
  INSUFFICIENT_STOCK: { en: 'Not enough stock.', ta: 'போதிய சரக்கு இருப்பு இல்லை.' },
  CREDIT_LIMIT_EXCEEDED: {
    en: 'Customer credit limit exceeded.',
    ta: 'வாடிக்கையாளர் கடன் வரம்பு மீறப்பட்டது.',
  },
  RX_REQUIRED: {
    en: 'A prescription is required for this medicine.',
    ta: 'இந்த மருந்துக்கு மருத்துவர் சீட்டு தேவை.',
  },
  EXPIRED_BATCH: {
    en: 'This batch has expired and cannot be sold.',
    ta: 'இந்த பேட்ச் காலாவதியானது; விற்க இயலாது.',
  },
  ACCOUNT_LOCKED: {
    en: 'Too many wrong attempts. Try again after 15 minutes.',
    ta: 'பல தவறான முயற்சிகள். 15 நிமிடங்கள் கழித்து முயலவும்.',
  },
  PIN_LOCKED: {
    en: 'PIN locked after wrong attempts. Try again after 15 minutes.',
    ta: 'தவறான முயற்சிகளால் PIN பூட்டப்பட்டது. 15 நிமிடங்கள் கழித்து முயலவும்.',
  },
  RATE_LIMITED: {
    en: 'Too many requests. Please wait a moment.',
    ta: 'அதிகமான கோரிக்கைகள். சிறிது நேரம் காத்திருக்கவும்.',
  },
  INTERNAL: {
    en: 'Something went wrong. Please try again.',
    ta: 'ஏதோ தவறு நடந்தது. மீண்டும் முயலவும்.',
  },
  PROVIDER_ERROR: {
    en: 'The payment / messaging service did not respond. Please try again.',
    ta: 'பேமெண்ட் / செய்தி சேவை பதிலளிக்கவில்லை. மீண்டும் முயலவும்.',
  },
}

/** Localized user-facing message for an error code (unknown codes → INTERNAL). */
export function errorMessage(code: string, locale: 'ta' | 'en' = 'ta'): string {
  const entry = isErrorCode(code) ? ERROR_MESSAGES[code] : ERROR_MESSAGES.INTERNAL
  return entry[locale]
}

/** Alias of {@link ERROR_MESSAGES}. */
export const errorMessages = ERROR_MESSAGES
