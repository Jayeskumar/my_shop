/**
 * Application errors (ARCHITECTURE.md §7.3). Throw an AppError anywhere (services, hooks, route
 * handlers); the error-handler plugin renders it as
 *   { "error": { "code", "message", "details"?, "request_id" } }
 * with the HTTP status of the code from the shared catalogue (@kadai/shared/errors).
 */
import {
  ERROR_CODES,
  type ErrorCode,
  type Feature,
  type LimitMetric,
  type ValidationIssue,
  httpStatusFor,
  isErrorCode,
} from '@kadai/shared'

export interface AppErrorOptions {
  cause?: unknown
  /** Override the catalogue status (rare: e.g. 413 payload too large mapped to VALIDATION_ERROR). */
  status?: number
  /** Extra response headers (e.g. Retry-After). */
  headers?: Record<string, string>
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined
  readonly headers: Record<string, string> | undefined
  /** Fastify reads statusCode from thrown errors (e.g. inside plugins). */
  readonly statusCode: number

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
    options: AppErrorOptions = {},
  ) {
    super(
      message ?? defaultMessage(code),
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'AppError'
    this.code = code
    this.status = options.status ?? httpStatusFor(code)
    this.statusCode = this.status
    this.details = details
    this.headers = options.headers
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}

function defaultMessage(code: ErrorCode): string {
  return code
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// ---------------------------------------------------------------------------------------------
// Helpers (English, developer-facing messages; the web localises by code)
// ---------------------------------------------------------------------------------------------

export const validationError = (
  issues: ValidationIssue[],
  message = 'Validation failed',
): AppError => new AppError('VALIDATION_ERROR', message, { issues })

/** Single-field validation error. */
export const invalidField = (path: string, message: string): AppError =>
  validationError([{ path, message }], message)

export const unauthenticated = (message = 'Authentication required'): AppError =>
  new AppError('UNAUTHENTICATED', message)

export const forbidden = (
  message = 'You do not have permission to do this',
  details?: Record<string, unknown>,
): AppError => new AppError('FORBIDDEN', message, details)

export const notFound = (entity: string, id?: string): AppError =>
  new AppError('NOT_FOUND', `${entity} not found`, id ? { entity, id } : { entity })

export const conflict = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('CONFLICT', message, details)

export const duplicate = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('DUPLICATE', message, details)

export const unprocessable = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('UNPROCESSABLE', message, details)

export const staleWrite = (entity: string, id: string): AppError =>
  new AppError('STALE_WRITE', `${entity} was changed by someone else`, { entity, id })

export const featureNotInPlan = (feature: Feature, plan: string): AppError =>
  new AppError('FEATURE_NOT_IN_PLAN', `Feature "${feature}" is not included in plan "${plan}"`, {
    feature,
    plan,
  })

export const planLimitReached = (
  metric: LimitMetric,
  limit: number,
  current: number,
  plan: string,
): AppError =>
  new AppError('PLAN_LIMIT_REACHED', `Plan limit reached for ${metric} (${current}/${limit})`, {
    metric,
    limit,
    current,
    plan,
  })

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError(
    'RATE_LIMITED',
    'Too many requests',
    { retry_after_seconds: retryAfterSeconds },
    { headers: { 'retry-after': String(retryAfterSeconds) } },
  )

export const providerError = (provider: string, message: string, cause?: unknown): AppError =>
  new AppError('PROVIDER_ERROR', message, { provider }, { cause })

/** Returns `value` or throws NOT_FOUND for null/undefined. */
export function assertFound<T>(value: T | null | undefined, entity: string, id?: string): T {
  if (value === null || value === undefined) throw notFound(entity, id)
  return value
}

/** Optimistic concurrency (PATCH `if_updated_at`): throws STALE_WRITE when the row changed. */
export function assertNotStale(
  current: Date | string,
  ifUpdatedAt: Date | string | null | undefined,
  entity: string,
  id: string,
): void {
  if (ifUpdatedAt === null || ifUpdatedAt === undefined) return
  const a = new Date(current).getTime()
  const b = new Date(ifUpdatedAt).getTime()
  if (Number.isNaN(b) || a !== b) throw staleWrite(entity, id)
}

/** Coerces any error code string (e.g. from stored data) to a catalogue code. */
export function toErrorCode(code: string): ErrorCode {
  return isErrorCode(code) ? code : 'INTERNAL'
}

export { ERROR_CODES }
