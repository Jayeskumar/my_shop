/**
 * Live status of one payment intent (ARCHITECTURE.md §11.2): server-sent events first
 * (GET /payments/intents/:id/stream, fetch-based reader so the bearer token never goes into a
 * URL), long polling (GET /payments/intents/:id?wait=&since_status=) as the fallback when the
 * stream fails or a proxy buffers it. Stops by itself on a terminal status.
 *
 * Updates are monotonic: once a terminal status (paid / failed / expired / cancelled) has been
 * seen, a late non-terminal frame from the other channel is ignored.
 */
import { routeUrl } from '@kadai/shared/api/common'
import {
  INTENT_LONG_POLL_MAX_SECONDS,
  INTENT_STREAM_EVENT,
  isTerminalIntentStatus,
  type PaymentIntent,
  PaymentIntentSchema,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { callRoute, isApiError, subscribeSse, type SseSubscription } from '@/lib/api'

export type IntentWatchMode = 'connecting' | 'sse' | 'poll' | 'stopped'

export interface IntentWatchOptions {
  /** What the caller already knows (create response); used as since_status for long polls. */
  initial?: PaymentIntent | null
  onIntent: (intent: PaymentIntent) => void
  onMode?: (mode: IntentWatchMode) => void
  /** Permanent failure (intent gone, access lost): watching stops. */
  onError?: (error: unknown) => void
  /** No SSE frame within this time → long polling (default 8 s; the server sends one at once). */
  sseTimeoutMs?: number
  /** Skip SSE entirely (tests, browsers without streams). */
  pollOnly?: boolean
}

export interface IntentWatch {
  close: () => void
  /** Fetch the current status once (manual "check now"). */
  refresh: () => Promise<PaymentIntent | null>
}

const MIN_POLL_GAP_MS = 2_000
const MAX_BACKOFF_MS = 15_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function isPermanent(error: unknown): boolean {
  return isApiError(error) && [401, 403, 404].includes(error.status)
}

/** Parses one SSE `intent` frame; null for malformed data (the next frame carries it again). */
export function parseIntentFrame(data: string): PaymentIntent | null {
  try {
    const parsed = PaymentIntentSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function watchIntent(intentId: string, options: IntentWatchOptions): IntentWatch {
  const controller = new AbortController()
  let latest: PaymentIntent | null = options.initial ?? null
  let stopped = false
  let mode: IntentWatchMode = 'connecting'
  let sse: SseSubscription | null = null
  let sseTimer: ReturnType<typeof setTimeout> | null = null
  let polling = false

  const setMode = (next: IntentWatchMode): void => {
    if (mode === next) return
    mode = next
    options.onMode?.(next)
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (sseTimer) clearTimeout(sseTimer)
    sse?.close()
    controller.abort()
    setMode('stopped')
  }

  const emit = (intent: PaymentIntent): void => {
    if (stopped || intent.id !== intentId) return
    if (latest && isTerminalIntentStatus(latest.status) && !isTerminalIntentStatus(intent.status))
      return
    latest = intent
    options.onIntent(intent)
    if (isTerminalIntentStatus(intent.status)) stop()
  }

  const fail = (error: unknown): void => {
    if (stopped) return
    options.onError?.(error)
    stop()
  }

  const poll = async (): Promise<void> => {
    if (polling || stopped) return
    polling = true
    if (sseTimer) clearTimeout(sseTimer)
    sse?.close()
    setMode('poll')
    let failures = 0
    while (!stopped) {
      const started = Date.now()
      const known = latest?.status
      try {
        const res = await callRoute(paymentsRoutes.getIntent, {
          params: { id: intentId },
          query: {
            wait: INTENT_LONG_POLL_MAX_SECONDS,
            ...(known ? { since_status: known } : {}),
          },
          signal: controller.signal,
          timeoutMs: (INTENT_LONG_POLL_MAX_SECONDS + 10) * 1000,
        })
        failures = 0
        emit(res.data)
        // A server (or proxy) that answers at once without waiting must not cause a busy loop.
        const elapsed = Date.now() - started
        if (!stopped && res.data.status === known && elapsed < MIN_POLL_GAP_MS) {
          await sleep(MIN_POLL_GAP_MS - elapsed, controller.signal)
        }
      } catch (error) {
        if (stopped) break
        if (isPermanent(error)) {
          fail(error)
          break
        }
        failures++
        await sleep(Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures), controller.signal)
      }
    }
    polling = false
  }

  if (latest && isTerminalIntentStatus(latest.status)) {
    stop()
  } else if (options.pollOnly || typeof TextDecoderStream === 'undefined') {
    void poll()
  } else {
    let sawFrame = false
    sse = subscribeSse(routeUrl(paymentsRoutes.streamIntent, { id: intentId }), {
      signal: controller.signal,
      onMessage: (message) => {
        if (message.event !== INTENT_STREAM_EVENT) return
        const intent = parseIntentFrame(message.data)
        if (!intent) return
        sawFrame = true
        if (!polling) setMode('sse')
        emit(intent)
      },
      onError: (error) => {
        if (isPermanent(error)) fail(error)
        else void poll()
      },
    })
    sseTimer = setTimeout(() => {
      if (!sawFrame) void poll()
    }, options.sseTimeoutMs ?? 8_000)
  }

  return {
    close: stop,
    refresh: async () => {
      const res = await callRoute(paymentsRoutes.getIntent, { params: { id: intentId } })
      if (!stopped) emit(res.data)
      return res.data
    },
  }
}
