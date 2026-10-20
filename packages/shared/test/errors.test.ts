import { describe, expect, it } from 'vitest'
import {
  ERROR_CODE_LIST,
  ERROR_MESSAGES,
  errorMessage,
  errorMessages,
  httpStatusFor,
  isErrorCode,
} from '../src/errors'
import type { ErrorCode } from '../src/errors'

describe('error codes', () => {
  it('includes every §7.3 code with its HTTP status', () => {
    const contract: Record<string, number> = {
      VALIDATION_ERROR: 400,
      UNAUTHENTICATED: 401,
      FEATURE_NOT_IN_PLAN: 402,
      PLAN_LIMIT_REACHED: 402,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      DUPLICATE: 409,
      UNPROCESSABLE: 422,
      INSUFFICIENT_STOCK: 422,
      CREDIT_LIMIT_EXCEEDED: 422,
      RX_REQUIRED: 422,
      EXPIRED_BATCH: 422,
      RATE_LIMITED: 429,
      INTERNAL: 500,
      PROVIDER_ERROR: 502,
      IDEMPOTENCY_MISMATCH: 409,
      STALE_WRITE: 409,
      TENANT_SUSPENDED: 403,
    }
    for (const [code, status] of Object.entries(contract)) {
      expect(isErrorCode(code)).toBe(true)
      expect(httpStatusFor(code as ErrorCode)).toBe(status)
    }
    for (const code of [
      'IDEMPOTENCY_IN_PROGRESS',
      'INVALID_CREDENTIALS',
      'ACCOUNT_LOCKED',
      'OTP_INVALID',
      'OTP_EXPIRED',
      'SESSION_REVOKED',
      'DEVICE_NOT_TRUSTED',
      'PIN_LOCKED',
      'LICENSE_INVALID',
      'SETUP_ALREADY_DONE',
      'NUMBER_SERIES_EXHAUSTED',
    ]) {
      expect(isErrorCode(code)).toBe(true)
    }
  })
  it('has English and Tamil messages for every code', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ERROR_CODE_LIST].sort())
    for (const code of ERROR_CODE_LIST) {
      expect(ERROR_MESSAGES[code].en.length).toBeGreaterThan(3)
      expect(ERROR_MESSAGES[code].ta).toMatch(/[஀-௿]/)
    }
    expect(errorMessages).toBe(ERROR_MESSAGES)
  })
  it('errorMessage localizes and falls back to INTERNAL', () => {
    expect(errorMessage('INSUFFICIENT_STOCK', 'en')).toBe('Not enough stock.')
    expect(errorMessage('INSUFFICIENT_STOCK')).toBe(ERROR_MESSAGES.INSUFFICIENT_STOCK.ta)
    expect(errorMessage('SOMETHING_NEW', 'en')).toBe(ERROR_MESSAGES.INTERNAL.en)
  })
})
