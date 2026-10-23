/**
 * Small HTTP helper shared by the notification provider adapters: one JSON POST with a timeout,
 * the parsed body, and the classification of non-2xx answers into retryable / permanent
 * {@link NotificationProviderError}s (408 / 425 / 429 / 5xx retry; other 4xx fail for good).
 */
import {
  type NotificationErrorCode,
  type NotificationProviderCode,
  NotificationProviderError,
  classifyHttpStatus,
} from '@kadai/shared/api/notifications'

export type FetchLike = typeof fetch

export interface JsonPostInput {
  provider: NotificationProviderCode
  url: string
  headers?: Record<string, string>
  /** Raw JSON text (signed bodies must be sent byte for byte). */
  body: string
  timeoutMs: number
  fetchImpl?: FetchLike
}

export interface JsonPostResult {
  status: number
  ok: boolean
  /** Parsed JSON body (null when empty or not JSON). */
  json: unknown
  /** Raw body, at most 2 000 characters (diagnostics). */
  text: string
  retryAfterSeconds: number | null
}

/** Retry-After header in seconds (delta-seconds or an HTTP date), capped at one hour. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Math.min(3600, Number(v))
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.min(3600, Math.ceil((at - now) / 1000)))
}

/** POSTs a JSON body; network errors and timeouts propagate (classified by the caller). */
export async function postJson(input: JsonPostInput): Promise<JsonPostResult> {
  const doFetch = input.fetchImpl ?? fetch
  const res = await doFetch(input.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'Kadai-Notifications/1',
      ...input.headers,
    },
    body: input.body,
    redirect: 'error',
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text) as unknown
    } catch {
      json = null
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    json,
    text: text.slice(0, 2000),
    retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
  }
}

/** Error for a non-2xx provider answer (code by status: rate_limited, not_configured, …). */
export function httpStatusError(
  provider: NotificationProviderCode,
  res: Pick<JsonPostResult, 'status' | 'retryAfterSeconds'>,
  detail: string,
  code?: NotificationErrorCode,
): NotificationProviderError {
  const kind = classifyHttpStatus(res.status)
  const derived: NotificationErrorCode =
    res.status === 429
      ? 'rate_limited'
      : res.status === 401 || res.status === 403
        ? 'not_configured'
        : 'provider_error'
  return new NotificationProviderError({
    message: `${provider} HTTP ${res.status}: ${detail}`.slice(0, 500),
    kind,
    provider,
    code: code ?? derived,
    http_status: res.status,
    retry_after_seconds: res.retryAfterSeconds,
  })
}

/** A permanent configuration error (missing credentials / template id). */
export function notConfigured(
  provider: NotificationProviderCode,
  message: string,
): NotificationProviderError {
  return new NotificationProviderError({
    message,
    kind: 'permanent',
    provider,
    code: 'not_configured',
  })
}

/** Plain object view of an unknown JSON value. */
export function objectOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function stringOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
