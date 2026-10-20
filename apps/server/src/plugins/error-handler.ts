/**
 * Error envelope (ARCHITECTURE.md §7.1 step 3, §7.3):
 *   { "error": { "code", "message", "details"?, "request_id" } }
 *
 *   AppError                           → its code/status/details
 *   request schema validation (zod)    → 400 VALIDATION_ERROR {issues:[{path,message,code}], location}
 *   ZodError thrown by a service       → 400 VALIDATION_ERROR {issues}
 *   pg 23505 unique                    → 409 DUPLICATE {constraint}
 *   pg 23503 FK / 23514 check / 23502  → 422 UNPROCESSABLE {constraint|column}
 *   pg 22P02 / 22007 / 22008 bad input → 400 VALIDATION_ERROR
 *   pg 42501 (RLS / privilege)         → 403 FORBIDDEN
 *   pg P0001 'append-only'             → 409 CONFLICT; other P0001 (our triggers) → 422
 *   pg 40001 / 40P01 (serialization)   → 409 CONFLICT {retryable: true}
 *   Fastify 4xx (bad JSON, 413, 415)   → VALIDATION_ERROR / NOT_FOUND …
 *   anything else                      → 500 INTERNAL (message and stack hidden in production)
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod'
import { $ZodError } from 'zod/v4/core'
import type { ErrorCode, ValidationIssue } from '@kadai/shared'
import { AppError, isAppError } from '../core/errors'

export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
    details?: Record<string, unknown>
    request_id: string
  }
}

interface PgError extends Error {
  code: string
  constraint?: string
  column?: string
  table?: string
  detail?: string
}

function isPgError(err: unknown): err is PgError {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as { code: string }).code) &&
    'severity' in err
  )
}

function zodIssues(err: $ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message, code: i.code }))
}

/** Maps any thrown value to an AppError (pure; exported for tests). */
export function toAppError(err: unknown, exposeInternal: boolean): AppError {
  if (isAppError(err)) return err

  if (hasZodFastifySchemaValidationErrors(err)) {
    const issues: ValidationIssue[] = err.validation.map((v) => ({
      path: v.instancePath.replace(/^\//, '').split('/').filter(Boolean).join('.'),
      message: v.message ?? 'Invalid value',
      code: v.keyword,
    }))
    const location = (err as { validationContext?: string }).validationContext ?? 'body'
    const first = issues[0]
    return new AppError('VALIDATION_ERROR', first ? `${location}${first.path ? `.${first.path}` : ''}: ${first.message}` : 'Validation failed', {
      issues,
      location,
    })
  }

  if (err instanceof $ZodError) {
    const issues = zodIssues(err)
    return new AppError('VALIDATION_ERROR', issues[0]?.message ?? 'Validation failed', { issues })
  }

  if (isPgError(err)) {
    switch (err.code) {
      case '23505':
        return new AppError('DUPLICATE', 'A record with these details already exists', { constraint: err.constraint ?? null }, { cause: err })
      case '23503':
        return new AppError('UNPROCESSABLE', 'A referenced record does not exist or is still in use', { constraint: err.constraint ?? null }, { cause: err })
      case '23514':
        return new AppError('UNPROCESSABLE', 'The data violates a business rule', { constraint: err.constraint ?? null }, { cause: err })
      case '23502':
        return new AppError('UNPROCESSABLE', 'A required value is missing', { column: err.column ?? null }, { cause: err })
      case '23P01':
        return new AppError('CONFLICT', 'This overlaps with an existing record', { constraint: err.constraint ?? null }, { cause: err })
      case '22P02':
      case '22007':
      case '22008':
      case '22003':
        return new AppError('VALIDATION_ERROR', 'Invalid value', { issues: [] }, { cause: err })
      case '22001':
        return new AppError('UNPROCESSABLE', 'A value is too long', {}, { cause: err })
      case '42501':
        return new AppError('FORBIDDEN', 'Access to this data is not allowed', {}, { cause: err })
      case '40001':
      case '40P01':
      case '55P03':
        return new AppError('CONFLICT', 'The record is busy; please retry', { retryable: true }, { cause: err })
      case 'P0001':
        if (/append-only/i.test(err.message)) {
          return new AppError('CONFLICT', 'This record cannot be changed (append-only ledger)', {}, { cause: err })
        }
        return new AppError('UNPROCESSABLE', err.message, {}, { cause: err })
      default:
        break
    }
  }

  if (isResponseSerializationError(err as object) && (err as { cause?: unknown }).cause instanceof $ZodError) {
    return new AppError('INTERNAL', exposeInternal ? `Response does not match its schema: ${zodIssues((err as { cause: $ZodError }).cause).map((i) => `${i.path} ${i.message}`).join('; ')}` : 'Internal error', undefined, {
      cause: err,
    })
  }

  const fe = err as Partial<FastifyError>
  const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500
  if (status >= 400 && status < 500) {
    const message = fe.message || 'Bad request'
    const byStatus: Record<number, ErrorCode> = {
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      405: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE',
      429: 'RATE_LIMITED',
    }
    const code = byStatus[status] ?? 'VALIDATION_ERROR'
    return new AppError(code, message, code === 'VALIDATION_ERROR' ? { issues: [], reason: fe.code ?? null } : undefined, {
      status,
      cause: err,
    })
  }

  const message = exposeInternal && err instanceof Error ? err.message : 'Internal error'
  return new AppError('INTERNAL', message, undefined, { cause: err })
}

export function errorBody(err: AppError, requestId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      request_id: requestId,
    },
  }
}

function send(reply: FastifyReply, err: AppError): FastifyReply {
  if (err.headers) reply.headers(err.headers)
  return reply
    .code(err.status)
    .type('application/json; charset=utf-8')
    .serializer((p: unknown) => JSON.stringify(p))
    .send(errorBody(err, reply.request.id))
}

export interface ErrorHandlerOptions {
  /** Show internal error messages (and stack in details) — never in production. */
  exposeInternalErrors: boolean
  /** Called for unmatched routes first (SPA fallback); return true when it handled the reply. */
  notFoundFallback?: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean>
}

export function registerErrorHandler(app: FastifyInstance, opts: ErrorHandlerOptions): void {
  app.setErrorHandler(async (err, req, reply) => {
    const appErr = toAppError(err, opts.exposeInternalErrors)
    if (appErr.status >= 500) {
      req.log.error({ err: appErr.cause ?? err, code: appErr.code }, 'request error')
      if (opts.exposeInternalErrors && appErr.code === 'INTERNAL') {
        const original = appErr.cause instanceof Error ? appErr.cause : err instanceof Error ? err : null
        if (original?.stack) {
          return send(reply, new AppError('INTERNAL', appErr.message, { stack: original.stack.split('\n').slice(0, 15) }))
        }
      }
    } else {
      req.log.debug({ code: appErr.code, message: appErr.message }, 'request rejected')
    }
    return send(reply, appErr)
  })

  app.setNotFoundHandler(async (req, reply) => {
    if (opts.notFoundFallback && (await opts.notFoundFallback(req, reply))) return reply
    return send(reply, new AppError('NOT_FOUND', `Route ${req.method} ${req.url.split('?')[0]} not found`, { entity: 'route' }))
  })
}
