/**
 * TanStack Query client defaults (ARCHITECTURE.md §16). Query keys follow
 * `[module, resource, params]`, e.g. `['catalog', 'products', { q, limit, offset }]`.
 *
 *  - staleTime 30 s; retries only for transient failures (network, timeout, 5xx, 429,
 *    IDEMPOTENCY_IN_PROGRESS) with backoff that honours Retry-After; 4xx never retry.
 *  - Errors are toasted once, centrally: a query opts out with `meta: { errorToast: false }`;
 *    a mutation is toasted unless it has its own `onError` (forms show inline errors) or sets
 *    `meta.errorToast` explicitly. 401s are never toasted (the auth store signs the user out).
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isApiError } from './api'

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: { errorToast?: boolean }
    mutationMeta: { errorToast?: boolean }
  }
}

const TRANSIENT_CODES = new Set(['RATE_LIMITED', 'IDEMPOTENCY_IN_PROGRESS', 'PROVIDER_ERROR'])

export function isTransientError(error: unknown): boolean {
  if (!isApiError(error)) return true
  return error.status === 0 || error.status >= 500 || TRANSIENT_CODES.has(error.code)
}

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (!isTransientError(error)) return false
  return failureCount < 3
}

export function retryDelay(attempt: number, error: unknown): number {
  if (isApiError(error) && error.retryAfterSeconds !== undefined) {
    return Math.min(60_000, Math.max(1_000, error.retryAfterSeconds * 1000))
  }
  return Math.min(15_000, 1_000 * 2 ** attempt)
}

function isUnauthenticated(error: unknown): boolean {
  return isApiError(error) && error.status === 401
}

export interface QueryClientOptions {
  /** Shows an error to the user (the app passes the toast helper). */
  onError?: (error: unknown) => void
}

export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const report = (error: unknown): void => {
    if (isUnauthenticated(error)) return
    options.onError?.(error)
  }
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.errorToast === false) return
        report(error)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const explicit = mutation.meta?.errorToast
        if (explicit === false) return
        if (explicit === undefined && mutation.options.onError) return
        report(error)
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        // Financial creates are idempotent (Idempotency-Key) but retrying is a user decision.
        retry: false,
      },
    },
  })
}
