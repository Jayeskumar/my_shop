/**
 * Live intent status for the POS and the customer display (ARCHITECTURE.md §11.2 step 4):
 *
 *  - GET /payments/intents/:id/stream (SSE, event "intent"): the intent now, then on every
 *    NOTIFY kadai_payment_intents for it (core/events, delivered across API processes by
 *    Postgres); a heartbeat comment every 15 s; the stream closes on a terminal status, when the
 *    client goes away or after STREAM_MAX_SECONDS (the client reconnects).
 *  - GET /payments/intents/:id?wait=N&since_status=S: long-poll fallback — answers as soon as
 *    the status differs from S (default: the status at request time) or after N ≤ 25 s.
 *
 * The event subscription is made BEFORE the current state is read, so a change between the two
 * is never missed. No database transaction is held while waiting.
 */
import type { FastifyReply } from 'fastify'
import {
  INTENT_STREAM_EVENT,
  INTENT_STREAM_HEARTBEAT_SECONDS,
  type PaymentIntent,
  PaymentIntentSchema,
  isTerminalIntentStatus,
  type paymentsRoutes,
} from '@kadai/shared/api/payments'
import type { RouteRequestFor } from '../../core/http'
import { CHANNELS } from '../../core/events'
import type { KadaiDeps } from '../../core/runtime'
import { withTenant } from '../../db/tenant'
import { type Ctx, recordOf } from './common'
import { getIntent } from './intents'

/** Longest life of one SSE connection (the client reconnects with Last-Event-ID). */
export const STREAM_MAX_SECONDS = 10 * 60

type StreamDeps = Pick<KadaiDeps, 'events' | 'db' | 'logger'>

/** Subscribes to status events of one intent; returns the unsubscribe function. */
export function subscribeIntent(
  deps: Pick<KadaiDeps, 'events'>,
  tenantId: string,
  intentId: string,
  onEvent: () => void,
): () => void {
  return deps.events.subscribe(CHANNELS.paymentIntents, (payload) => {
    const p = recordOf(payload)
    if (p.tenant_id === tenantId && p.intent_id === intentId) onEvent()
  })
}

const readIntent = (deps: StreamDeps, ctx: Ctx, id: string): Promise<PaymentIntent> =>
  withTenant(deps.db.appDb, ctx, (tx) => getIntent(tx, ctx, id))

/** Open SSE connections of this process (closed when the server shuts down). */
const openStreams = new Set<() => void>()

export function closeAllStreams(): void {
  for (const close of [...openStreams]) close()
}

/** GET /payments/intents/:id (optionally a long poll). */
export async function getIntentWithWait(
  deps: StreamDeps,
  req: RouteRequestFor<typeof paymentsRoutes.getIntent>,
  reply: FastifyReply,
): Promise<{ data: PaymentIntent }> {
  const ctx = req.ctx
  const id = req.params.id
  const waitSeconds = req.query.wait ?? 0
  if (waitSeconds <= 0) return { data: await readIntent(deps, ctx, id) }
  let fired = false
  let wake: (() => void) | null = null
  const unsubscribe = subscribeIntent(deps, ctx.tenantId, id, () => {
    fired = true
    wake?.()
  })
  try {
    const first = await readIntent(deps, ctx, id)
    const since = req.query.since_status ?? first.status
    if (first.status !== since || isTerminalIntentStatus(first.status)) return { data: first }
    await new Promise<void>((resolve) => {
      if (fired) return resolve()
      const timer = setTimeout(resolve, waitSeconds * 1000)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      wake = done
      reply.raw.once('close', done)
    })
    return { data: await readIntent(deps, ctx, id) }
  } finally {
    unsubscribe()
  }
}

function sseHeaders(reply: FastifyReply): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(reply.getHeaders())) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) ? v.map(String) : String(v)
  }
  out['content-type'] = 'text/event-stream; charset=utf-8'
  out['cache-control'] = 'no-store'
  out.connection = 'keep-alive'
  out['x-accel-buffering'] = 'no'
  return out
}

/** GET /payments/intents/:id/stream — server-sent events. */
export async function streamIntent(
  deps: StreamDeps,
  req: RouteRequestFor<typeof paymentsRoutes.streamIntent>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const ctx = req.ctx
  const id = req.params.id
  let dirty = false
  let pumpNow: (() => void) | null = null
  const unsubscribe = subscribeIntent(deps, ctx.tenantId, id, () => {
    dirty = true
    pumpNow?.()
  })
  let first: PaymentIntent
  try {
    first = await readIntent(deps, ctx, id)
  } catch (err) {
    unsubscribe()
    throw err
  }

  reply.hijack()
  const res = reply.raw
  res.writeHead(200, sseHeaders(reply))
  let closed = false
  let lastKey = ''
  const send = (intent: PaymentIntent): void => {
    const key = `${intent.status}|${intent.updated_at}`
    if (key === lastKey || closed) return
    lastKey = key
    const json = JSON.stringify(PaymentIntentSchema.parse(intent))
    res.write(
      `id: ${Date.parse(intent.updated_at)}\nevent: ${INTENT_STREAM_EVENT}\ndata: ${json}\n\n`,
    )
  }
  let heartbeat: NodeJS.Timeout | null = null
  let maxTimer: NodeJS.Timeout | null = null
  const finish = (): void => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (maxTimer) clearTimeout(maxTimer)
    unsubscribe()
    openStreams.delete(finish)
    res.end()
  }
  res.write('retry: 3000\n\n')
  send(first)
  if (isTerminalIntentStatus(first.status)) {
    finish()
    return reply
  }
  openStreams.add(finish)
  heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n')
  }, INTENT_STREAM_HEARTBEAT_SECONDS * 1000)
  heartbeat.unref()
  maxTimer = setTimeout(finish, STREAM_MAX_SECONDS * 1000)
  maxTimer.unref()
  res.on('close', finish)

  let busy = false
  const pump = async (): Promise<void> => {
    if (busy || closed) return
    busy = true
    try {
      while (dirty && !closed) {
        dirty = false
        let intent: PaymentIntent | null = null
        try {
          intent = await readIntent(deps, ctx, id)
        } catch (err) {
          deps.logger.warn({ err, intent_id: id }, 'payment intent stream: reload failed')
        }
        if (!intent || closed) continue
        send(intent)
        if (isTerminalIntentStatus(intent.status)) finish()
      }
    } finally {
      busy = false
    }
  }
  pumpNow = () => void pump()
  if (dirty) pumpNow()
  return reply
}
