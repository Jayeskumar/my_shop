/**
 * Provider failures → AppError PROVIDER_ERROR (502) with machine-readable details:
 * `{ provider, provider_error_code, http_status, retryable }`.
 */
import type { PaymentProviderCode } from '@kadai/shared'
import { AppError, isAppError } from '../../../core/errors'

export interface ProviderFailureOptions {
  /** Provider error code, e.g. Razorpay 'BAD_REQUEST_ERROR' (or 'TIMEOUT' / 'NETWORK_ERROR'). */
  code?: string | null
  httpStatus?: number | null
  /** Network errors, timeouts, 5xx and 429 may succeed later. */
  retryable?: boolean
  cause?: unknown
}

export function providerFailure(
  provider: PaymentProviderCode,
  message: string,
  opts: ProviderFailureOptions = {},
): AppError {
  return new AppError(
    'PROVIDER_ERROR',
    message,
    {
      provider,
      provider_error_code: opts.code ?? null,
      http_status: opts.httpStatus ?? null,
      retryable: opts.retryable ?? false,
    },
    { cause: opts.cause },
  )
}

export function isProviderFailure(err: unknown): err is AppError {
  return isAppError(err) && err.code === 'PROVIDER_ERROR'
}

/** Provider error code of a PROVIDER_ERROR (null for other errors). */
export function providerErrorCode(err: unknown): string | null {
  if (!isProviderFailure(err)) return null
  const code = err.details?.provider_error_code
  return typeof code === 'string' ? code : null
}

/** Short, storable description of any error (failure_reason / processing_error columns). */
export function errorText(err: unknown, max = 500): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.slice(0, max)
}

/** Thrown by adapters for operations their provider does not support. */
export function notSupported(provider: PaymentProviderCode, operation: string): AppError {
  return new AppError('UNPROCESSABLE', `The ${provider} provider does not support ${operation}`, {
    reason: 'provider_operation_not_supported',
    provider,
    operation,
  })
}
