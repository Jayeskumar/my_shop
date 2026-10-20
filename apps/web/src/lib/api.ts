/**
 * HTTP client for the Kadai API (ARCHITECTURE.md §7.3, §7.4, §16).
 *
 *  - Base path `/api/v1`; JSON bodies are passed through as-is (snake_case, no mapping layer).
 *  - The access token lives in memory only; the refresh token is an httpOnly cookie, so every
 *    request uses `credentials: 'include'` and sends `X-Requested-With: kadai` (CSRF guard).
 *  - A 401 on an authenticated request triggers ONE refresh (single-flight: concurrent 401s share
 *    the same POST /auth/refresh) and the request is retried once with the new token.
 *  - Refresh tokens rotate with reuse detection on the server, so two tabs refreshing with the
 *    same cookie at the same time would revoke the whole session family. Refreshes are therefore
 *    serialised across tabs with the Web Locks API, and the winning tab broadcasts the new
 *    session over BroadcastChannel; tabs waiting on the lock adopt it instead of refreshing again.
 *  - Errors are thrown as {@link ApiError} with the server's `code`, `details` and `request_id`.
 */
import type { SessionResponse } from '@kadai/shared/api/auth'
import type {
  Page,
  RouteBody,
  RouteDef,
  RouteQuery,
  RouteResponse,
} from '@kadai/shared/api/common'
import { routeUrl } from '@kadai/shared/api/common'
import { isErrorCode, type ErrorCode, type ValidationIssue } from '@kadai/shared/errors'
import { reportNetworkFailure, reportNetworkSuccess } from './online'

export const API_BASE = '/api/v1'

/** Error codes produced by the client itself (no HTTP response, or an unusable one). */
export type ClientErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'BAD_RESPONSE'
export type AnyErrorCode = ErrorCode | ClientErrorCode

export interface ApiErrorInit {
  status: number
  code: string
  message: string
  details?: Record<string, unknown> | undefined
  requestId?: string | undefined
  retryAfterSeconds?: number | undefined
  cause?: unknown
}

export class ApiError extends Error {
  override readonly name = 'ApiError'
  /** HTTP status; 0 when no response was received (network error / timeout). */
  readonly status: number
  /** Server error code (shared `ERROR_CODES`) or a {@link ClientErrorCode}. */
  readonly code: string
  readonly details: Record<string, unknown> | undefined
  readonly requestId: string | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.status = init.status
    this.code = init.code
    this.details = init.details
    this.requestId = init.requestId
    this.retryAfterSeconds = init.retryAfterSeconds
  }

  is(...codes: AnyErrorCode[]): boolean {
    return codes.includes(this.code as AnyErrorCode)
  }

  /** No response from the server (offline, DNS, server down, timeout). */
  get isNetworkError(): boolean {
    return this.status === 0
  }

  /** `details.issues` of VALIDATION_ERROR responses (field paths like "lines.2.qty_milli"). */
  get validationIssues(): ValidationIssue[] {
    const issues = this.details?.issues
    if (!Array.isArray(issues)) return []
    return issues.filter(
      (i): i is ValidationIssue =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as ValidationIssue).path === 'string' &&
        typeof (i as ValidationIssue).message === 'string',
    )
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  )
}

// ---------------------------------------------------------------------------------------------
// Envelopes & query strings
// ---------------------------------------------------------------------------------------------

/** `{ data: T }` single-resource envelope. */
export interface Envelope<T> {
  data: T
}
/** `{ data: T[], page }` list envelope. */
export interface ListEnvelope<T> {
  data: T[]
  page: Page
}

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | null | undefined | readonly QueryScalar[]
export type QueryParams = Record<string, QueryValue>

/**
 * `{ q: 'rice', limit: 50, ids: ['a','b'], empty: '' }` → `?q=rice&limit=50&ids=a&ids=b`.
 * null / undefined / '' are dropped; arrays repeat the key.
 */
export function buildQuery(params?: QueryParams): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const v of value as readonly QueryScalar[]) search.append(key, String(v))
    } else {
      search.append(key, String(value as QueryScalar))
    }
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

const ROOT_PATHS = ['/api/', '/public/', '/webhooks/', '/health']

/** Absolute URL for an API path: '/products' → <origin>/api/v1/products. */
export function apiUrl(path: string, query?: QueryParams): string {
  const isAbsolute = /^https?:\/\//.test(path)
  const rooted = ROOT_PATHS.some((p) => path.startsWith(p))
  const full = isAbsolute || rooted ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`
  const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin
  return new URL(full + buildQuery(query), origin).toString()
}

// ---------------------------------------------------------------------------------------------
// Token & session state (memory only)
// ---------------------------------------------------------------------------------------------

export type AuthEvent =
  | { type: 'session'; session: SessionResponse; source: 'refresh' | 'broadcast' }
  | { type: 'unauthenticated'; error: ApiError | null }

type AuthListener = (event: AuthEvent) => void

let accessToken: string | null = null
let tokenExpiresAt: number | null = null
let lastSession: SessionResponse | null = null
/** Incremented on every token change; lets a tab waiting for the refresh lock detect adoption. */
let tokenVersion = 0
const listeners = new Set<AuthListener>()

const AUTH_CHANNEL = 'kadai-auth'
type AuthBroadcast = { type: 'session'; session: SessionResponse } | { type: 'logout' }
let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel
  try {
    channel = new BroadcastChannel(AUTH_CHANNEL)
    channel.onmessage = (event: MessageEvent<AuthBroadcast>) => {
      const msg = event.data
      if (msg?.type === 'session') {
        applySession(msg.session)
        emit({ type: 'session', session: msg.session, source: 'broadcast' })
      } else if (msg?.type === 'logout') {
        clearTokens()
        emit({ type: 'unauthenticated', error: null })
      }
    }
  } catch {
    channel = null
  }
  return channel
}

function broadcast(message: AuthBroadcast): void {
  try {
    getChannel()?.postMessage(message)
  } catch {
    // structured clone / closed channel: other tabs will refresh on their own
  }
}

function emit(event: AuthEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      console.error('auth listener failed', error)
    }
  }
}

function applySession(session: SessionResponse): void {
  accessToken = session.access_token
  tokenExpiresAt = Date.now() + session.expires_in * 1000
  lastSession = session
  tokenVersion++
}

function clearTokens(): void {
  accessToken = null
  tokenExpiresAt = null
  lastSession = null
  tokenVersion++
}

/** Subscribe to session changes made by the client (refresh, other tabs, forced logout). */
export function onAuthEvent(listener: AuthListener): () => void {
  getChannel()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Install a session obtained from login / OTP / select-tenant / PIN / signup. */
export function setSession(session: SessionResponse, options: { broadcast?: boolean } = {}): void {
  applySession(session)
  if (options.broadcast !== false) broadcast({ type: 'session', session })
}

/** Forget the session locally (after logout); other tabs are told to sign out too. */
export function clearSession(options: { broadcast?: boolean } = {}): void {
  clearTokens()
  if (options.broadcast !== false) broadcast({ type: 'logout' })
}

export function getAccessToken(): string | null {
  return accessToken
}

function tokenNeedsRefresh(): boolean {
  // Refresh a little early so a request does not race the expiry.
  return accessToken !== null && tokenExpiresAt !== null && Date.now() > tokenExpiresAt - 30_000
}

// ---------------------------------------------------------------------------------------------
// Refresh (single-flight within the tab, serialised across tabs)
// ---------------------------------------------------------------------------------------------

let refreshInFlight: Promise<SessionResponse | null> | null = null

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

function lockManager(): LockManagerLike | null {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const locks = (nav as (Navigator & { locks?: LockManagerLike }) | undefined)?.locks
  return locks && typeof locks.request === 'function' ? locks : null
}

/**
 * Exchanges the refresh cookie for a new access token. Resolves to the new session, or null when
 * the session is gone (401: the user must sign in again — an `unauthenticated` event is emitted).
 * Rejects with an ApiError on network failures: being offline must NOT sign the user out.
 */
export function refreshSession(): Promise<SessionResponse | null> {
  refreshInFlight ??= runRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function runRefresh(): Promise<SessionResponse | null> {
  const versionAtStart = tokenVersion
  const exchange = async (): Promise<SessionResponse | null> => {
    // While we waited for the cross-tab lock another tab may have refreshed and broadcast a
    // session; reuse it instead of spending the (already rotated) cookie again.
    if (tokenVersion !== versionAtStart && lastSession && !tokenNeedsRefresh()) return lastSession
    try {
      const session = await request<{ data: SessionResponse }>('POST', '/auth/refresh', {
        body: {},
        auth: false,
      })
      applySession(session.data)
      broadcast({ type: 'session', session: session.data })
      emit({ type: 'session', session: session.data, source: 'refresh' })
      return session.data
    } catch (error) {
      if (isApiError(error) && (error.status === 401 || error.status === 403)) {
        clearTokens()
        emit({ type: 'unauthenticated', error })
        return null
      }
      throw error
    }
  }
  const locks = lockManager()
  return locks ? locks.request('kadai-auth-refresh', exchange) : exchange()
}

// ---------------------------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------------------------

export type ResponseType = 'json' | 'text' | 'blob' | 'response'

export interface RequestOptions {
  query?: QueryParams | undefined
  body?: unknown
  headers?: Record<string, string> | undefined
  /** Sent as `Idempotency-Key` (financial creates; ARCHITECTURE.md §7.3). */
  idempotencyKey?: string | undefined
  signal?: AbortSignal | undefined
  /** Default 30 s; 0 disables the timeout. */
  timeoutMs?: number | undefined
  /** Attach the access token and refresh on 401 (default true). */
  auth?: boolean | undefined
  responseType?: ResponseType | undefined
}

const DEFAULT_TIMEOUT_MS = 30_000

/** HTTP status → error code when the server did not send an error envelope. */
function codeForStatus(status: number): string {
  if (status === 400) return 'VALIDATION_ERROR'
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 402) return 'FEATURE_NOT_IN_PLAN'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 422) return 'UNPROCESSABLE'
  if (status === 423) return 'ACCOUNT_LOCKED'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 502 || status === 503 || status === 504) return 'PROVIDER_ERROR'
  return 'INTERNAL'
}

function isBodyInit(body: unknown): body is BodyInit {
  return (
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    typeof body === 'string'
  )
}

/** Combines the caller's signal with a timeout; works without AbortSignal.any/timeout. */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; timedOut: () => boolean; dispose: () => void } {
  if (!timeoutMs) return { signal, timedOut: () => false, dispose: () => {} }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('x-request-id') ?? undefined
  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined
  let body: unknown = null
  try {
    const text = await response.text()
    body = text ? (JSON.parse(text) as unknown) : null
  } catch {
    body = null
  }
  const envelope =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: unknown }).error
      : null
  if (typeof envelope === 'object' && envelope !== null) {
    const e = envelope as {
      code?: unknown
      message?: unknown
      details?: unknown
      request_id?: unknown
    }
    const code = typeof e.code === 'string' ? e.code : codeForStatus(response.status)
    return new ApiError({
      status: response.status,
      code,
      message: typeof e.message === 'string' ? e.message : response.statusText || code,
      details:
        typeof e.details === 'object' && e.details !== null
          ? (e.details as Record<string, unknown>)
          : undefined,
      requestId: typeof e.request_id === 'string' ? e.request_id : requestId,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
    })
  }
  const code = codeForStatus(response.status)
  return new ApiError({
    status: response.status,
    code,
    message: response.statusText || code,
    requestId,
    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
  })
}

async function parseSuccess(response: Response, responseType: ResponseType): Promise<unknown> {
  if (responseType === 'response') return response
  if (responseType === 'blob') return response.blob()
  if (responseType === 'text') return response.text()
  if (response.status === 204 || response.status === 205) return undefined
  const text = await response.text()
  if (!text) return undefined
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('json')) return text
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new ApiError({
      status: response.status,
      code: 'BAD_RESPONSE',
      message: 'The server sent an invalid JSON response',
      requestId: response.headers.get('x-request-id') ?? undefined,
      cause: error,
    })
  }
}

/** Paths whose 401 means "bad credentials", never "expired token" (no refresh/retry). */
function isSessionEndpoint(path: string): boolean {
  return /\/auth\/(login|refresh|logout|signup|otp\/|pin-login|password\/reset)/.test(path)
}

/**
 * Sends a request and returns the parsed body (`{ data }` / `{ data, page }` envelopes are
 * returned as-is). Throws ApiError for HTTP errors and network failures; a caller abort rejects
 * with the original AbortError so TanStack Query treats it as a cancellation.
 */
export async function request<T = unknown>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const auth = options.auth !== false
  if (auth && tokenNeedsRefresh()) {
    try {
      await refreshSession()
    } catch {
      // offline: try the request with the current token; it may still be accepted
    }
  }
  const first = await send(method, path, options, auth)
  if (first.ok) return (await parseSuccess(first, options.responseType ?? 'json')) as T

  if (first.status === 401 && auth && !isSessionEndpoint(path)) {
    const session = await refreshSession().catch((error: unknown) => {
      if (isApiError(error)) throw error
      return null
    })
    if (session) {
      const retried = await send(method, path, options, auth)
      if (retried.ok) return (await parseSuccess(retried, options.responseType ?? 'json')) as T
      throw await errorFromResponse(retried)
    }
  }
  throw await errorFromResponse(first)
}

async function send(
  method: string,
  path: string,
  options: RequestOptions,
  auth: boolean,
): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set('X-Requested-With', 'kadai')
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (auth && accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey)

  let body: BodyInit | undefined
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (isBodyInit(options.body)) {
      body = options.body
    } else {
      body = JSON.stringify(options.body)
      headers.set('Content-Type', 'application/json')
    }
  }

  const timeout = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(apiUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: 'include',
      signal: timeout.signal,
    })
    reportNetworkSuccess()
    return response
  } catch (error) {
    if (timeout.timedOut()) {
      reportNetworkFailure()
      throw new ApiError({
        status: 0,
        code: 'TIMEOUT',
        message: 'The server took too long to respond',
        cause: error,
      })
    }
    if (isAbortError(error) || options.signal?.aborted) throw error
    reportNetworkFailure()
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server',
      cause: error,
    })
  } finally {
    timeout.dispose()
  }
}

// ---------------------------------------------------------------------------------------------
// Convenience API
// ---------------------------------------------------------------------------------------------

type BodylessOptions = Omit<RequestOptions, 'body'>

export const api = {
  request,
  get<T = unknown>(path: string, options?: BodylessOptions): Promise<T> {
    return request<T>('GET', path, options)
  },
  post<T = unknown>(path: string, body?: unknown, options?: BodylessOptions): Promise<T> {
    return request<T>('POST', path, { ...options, body })
  },
  put<T = unknown>(path: string, body?: unknown, options?: BodylessOptions): Promise<T> {
    return request<T>('PUT', path, { ...options, body })
  },
  patch<T = unknown>(path: string, body?: unknown, options?: BodylessOptions): Promise<T> {
    return request<T>('PATCH', path, { ...options, body })
  },
  del<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, options)
  },
  /** Typed call through a shared route catalogue entry (`defineRoutes` in shared). */
  call: callRoute,
}

export interface RouteCallInput<R extends RouteDef> {
  params?: Record<string, string | number>
  query?: RouteQuery<R>
  body?: RouteBody<R>
  idempotencyKey?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Calls an endpoint described by a shared `RouteDef`. The response is validated with the route's
 * response schema; a mismatch is logged (contract drift) and the raw body is returned so the UI
 * keeps working with a slightly newer/older server.
 */
export async function callRoute<R extends RouteDef>(
  route: R,
  input: RouteCallInput<R> = {},
): Promise<RouteResponse<R>> {
  const raw = await request<unknown>(route.method, routeUrl(route, input.params), {
    query: input.query as QueryParams | undefined,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    auth: route.auth !== 'public' && (route.scope ?? 'api') === 'api',
  })
  if (!route.response) return raw as RouteResponse<R>
  const parsed = route.response.safeParse(raw)
  if (parsed.success) return parsed.data as RouteResponse<R>
  console.error(`Response of ${route.method} ${route.path} does not match its contract`, parsed.error)
  return raw as RouteResponse<R>
}

// ---------------------------------------------------------------------------------------------
// Files & CSV downloads
// ---------------------------------------------------------------------------------------------

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // fall through to the plain filename
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim() ?? null
}

/** Saves a Blob through a temporary object URL + anchor (works on desktop and Android). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke later: some browsers read the URL asynchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export interface DownloadOptions {
  query?: QueryParams
  /** Used when the server sends no Content-Disposition filename. */
  filename?: string
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
}

/**
 * Downloads a file/CSV export with the user's auth (`?format=csv` report endpoints, backups,
 * GSTR-1 JSON). Returns the filename used.
 */
export async function downloadFile(path: string, options: DownloadOptions = {}): Promise<string> {
  const response = await request<Response>(options.method ?? 'GET', path, {
    query: options.query,
    body: options.body,
    signal: options.signal,
    timeoutMs: 120_000,
    responseType: 'response',
    headers: { Accept: '*/*' },
  })
  const blob = await response.blob()
  const filename =
    filenameFromDisposition(response.headers.get('content-disposition')) ??
    options.filename ??
    'download'
  saveBlob(blob, filename)
  return filename
}

// ---------------------------------------------------------------------------------------------
// Server-sent events over fetch (so the Authorization header can be sent; tokens are never put
// in URLs). Reconnects with backoff and refreshes the token on 401.
// ---------------------------------------------------------------------------------------------

export interface SseMessage {
  /** `event:` field (default 'message'). */
  event: string
  /** Raw `data:` payload (multi-line data joined with '\n'). */
  data: string
  id: string | undefined
}

export interface SseOptions {
  query?: QueryParams
  onMessage: (message: SseMessage) => void
  onOpen?: () => void
  /** Called for every failed attempt; the stream keeps retrying unless `reconnect` is false. */
  onError?: (error: unknown) => void
  signal?: AbortSignal
  reconnect?: boolean
  /** Upper bound of the exponential backoff (default 30 s). */
  maxRetryMs?: number
}

export interface SseSubscription {
  close: () => void
  readonly closed: boolean
}

/** Parses one SSE stream chunk-by-chunk (exported for tests). */
export function createSseParser(dispatch: (message: SseMessage) => void): {
  push: (chunk: string) => void
  retryMs: () => number | undefined
  lastEventId: () => string | undefined
} {
  let buffer = ''
  let dataLines: string[] = []
  let eventName = ''
  let lastId: string | undefined
  let retry: number | undefined

  const processLine = (line: string): void => {
    if (line === '') {
      if (dataLines.length > 0) {
        dispatch({ event: eventName || 'message', data: dataLines.join('\n'), id: lastId })
      }
      dataLines = []
      eventName = ''
      return
    }
    if (line.startsWith(':')) return // comment / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
    else if (field === 'id' && !value.includes('\0')) lastId = value
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
  }

  return {
    push(chunk: string) {
      buffer += chunk
      // Lines end with \n, \r\n or \r.
      let match: RegExpExecArray | null
      const lineEnd = /\r\n|\r|\n/
      while ((match = lineEnd.exec(buffer))) {
        // A trailing '\r' may be the first half of '\r\n': wait for the next chunk.
        if (match[0] === '\r' && match.index === buffer.length - 1) break
        processLine(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
    },
    retryMs: () => retry,
    lastEventId: () => lastId,
  }
}

export function subscribeSse(path: string, options: SseOptions): SseSubscription {
  const controller = new AbortController()
  let closed = false
  const close = (): void => {
    closed = true
    controller.abort()
  }
  if (options.signal) {
    if (options.signal.aborted) close()
    else options.signal.addEventListener('abort', close, { once: true })
  }

  const reconnect = options.reconnect !== false
  const maxRetry = options.maxRetryMs ?? 30_000
  let attempt = 0
  let lastEventId: string | undefined
  let serverRetry: number | undefined

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })

  const connect = async (): Promise<void> => {
    while (!closed) {
      try {
        if (tokenNeedsRefresh()) await refreshSession().catch(() => null)
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Requested-With': 'kadai',
        }
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`
        if (lastEventId) headers['Last-Event-ID'] = lastEventId
        const response = await fetch(apiUrl(path, options.query), {
          headers,
          credentials: 'include',
          signal: controller.signal,
        })
        if (response.status === 401) {
          const session = await refreshSession().catch(() => null)
          if (!session) throw await errorFromResponse(response)
          continue
        }
        if (!response.ok || !response.body) throw await errorFromResponse(response)

        attempt = 0
        reportNetworkSuccess()
        options.onOpen?.()
        const parser = createSseParser(options.onMessage)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          parser.push(value)
          lastEventId = parser.lastEventId() ?? lastEventId
          serverRetry = parser.retryMs() ?? serverRetry
        }
        if (closed) return
        // The server closed the stream normally: reconnect promptly.
        if (!reconnect) return
        await sleep(serverRetry ?? 1_000)
      } catch (error) {
        if (closed) return
        if (!isApiError(error) || error.isNetworkError) reportNetworkFailure()
        options.onError?.(error)
        // 4xx other than 401/429 will not fix themselves.
        if (
          !reconnect ||
          (isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 429)
        ) {
          closed = true
          return
        }
        attempt++
        const backoff = Math.min(maxRetry, (serverRetry ?? 1_000) * 2 ** Math.min(attempt, 6))
        await sleep(backoff)
      }
    }
  }
  void connect()

  return {
    close,
    get closed() {
      return closed
    },
  }
}

/** Test helper: reset module state between tests. */
export function _resetApiStateForTests(): void {
  clearTokens()
  refreshInFlight = null
  listeners.clear()
  if (channel) {
    channel.close()
    channel = null
  }
}

export { isErrorCode }
