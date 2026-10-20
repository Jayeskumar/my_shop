/**
 * LISTEN/NOTIFY fan-out (ARCHITECTURE.md §8.5, §11.2).
 *
 * * notify(tx, channel, payload) runs `pg_notify` INSIDE the business transaction: Postgres
 *   delivers it only if the transaction commits, so listeners never see rolled-back events.
 * * EventBus holds ONE dedicated LISTEN connection taken from the system pool per process and
 *   fans notifications out to in-process subscribers (SSE streams, cache invalidation). It
 *   reconnects with exponential backoff (1 s → 30 s) and re-LISTENs every channel.
 *
 * Channels:
 *   kadai_payment_intents  {tenant_id, intent_id, status}   payment intent status changes (SSE)
 *   kadai_cache            {scope, tenant_id?, user_id?, …}  in-process cache invalidation
 */
import { type Kysely, sql } from 'kysely'
import type pg from 'pg'
import type { DB } from '../db/schema.generated'
import type { Tx } from '../db/tenant'

export const CHANNELS = {
  paymentIntents: 'kadai_payment_intents',
  cache: 'kadai_cache',
} as const
export type EventChannel = (typeof CHANNELS)[keyof typeof CHANNELS]
const ALL_CHANNELS: readonly EventChannel[] = Object.values(CHANNELS)

/** Postgres limits NOTIFY payloads to 8000 bytes. */
export const MAX_PAYLOAD_BYTES = 7900

export type EventHandler = (payload: unknown) => void | Promise<void>

/** Sends a notification as part of `tx` (delivered on commit). Payload must be a small JSON object. */
export async function notify(tx: Tx | Kysely<DB>, channel: EventChannel, payload: Record<string, unknown>): Promise<void> {
  if (!ALL_CHANNELS.includes(channel)) throw new Error(`unknown event channel ${channel}`)
  const text = JSON.stringify(payload)
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`event payload for ${channel} exceeds ${MAX_PAYLOAD_BYTES} bytes; send ids, not documents`)
  }
  await sql`select pg_notify(${channel}, ${text})`.execute(tx)
}

export interface EventBusLogger {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

export interface EventBusOptions {
  /** System pool to borrow the LISTEN connection from. */
  pool: pg.Pool
  logger?: EventBusLogger
  minBackoffMs?: number
  maxBackoffMs?: number
}

export class EventBus {
  private readonly handlers = new Map<EventChannel, Set<EventHandler>>()
  private client: pg.PoolClient | null = null
  private starting: Promise<void> | null = null
  private stopped = false
  private backoffMs: number
  private reconnectTimer: NodeJS.Timeout | null = null
  private readyWaiters: Array<() => void> = []

  constructor(private readonly opts: EventBusOptions) {
    this.backoffMs = opts.minBackoffMs ?? 1000
  }

  /** True while the LISTEN connection is up. */
  get connected(): boolean {
    return this.client !== null
  }

  /** Connects and LISTENs (idempotent). Resolves once listening; retries in the background on failure. */
  start(): Promise<void> {
    this.stopped = false
    if (this.client) return Promise.resolve()
    this.starting ??= this.connect().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** Resolves when the LISTEN connection is (re)established (tests, readiness). */
  waitUntilConnected(timeoutMs = 10_000): Promise<void> {
    if (this.client) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('event bus did not connect in time')), timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Registers a handler; returns the unsubscribe function. */
  subscribe(channel: EventChannel, handler: EventHandler): () => void {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  subscriberCount(channel: EventChannel): number {
    return this.handlers.get(channel)?.size ?? 0
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    await this.starting?.catch(() => undefined)
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners('notification')
      client.removeAllListeners('error')
      try {
        await client.query('UNLISTEN *')
        client.release()
      } catch {
        client.release(true)
      }
    }
  }

  private async connect(): Promise<void> {
    let client: pg.PoolClient | null = null
    try {
      client = await this.opts.pool.connect()
      client.on('notification', (msg) => this.dispatch(msg.channel, msg.payload))
      client.on('error', (err) => this.handleDisconnect(client!, err))
      for (const ch of ALL_CHANNELS) await client.query(`LISTEN ${ch}`)
      if (this.stopped) {
        client.release()
        return
      }
      this.client = client
      this.backoffMs = this.opts.minBackoffMs ?? 1000
      const waiters = this.readyWaiters
      this.readyWaiters = []
      waiters.forEach((w) => w())
    } catch (err) {
      client?.release(true)
      this.opts.logger?.warn({ err }, 'event bus: LISTEN connection failed')
      this.scheduleReconnect()
    }
  }

  private handleDisconnect(client: pg.PoolClient, err: Error): void {
    if (this.client !== client) return
    this.opts.logger?.warn({ err }, 'event bus: LISTEN connection lost, reconnecting')
    this.client = null
    client.removeAllListeners('notification')
    client.release(true)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.start()
    }, delay)
    this.reconnectTimer.unref()
  }

  private dispatch(channel: string, payloadText: string | undefined): void {
    const set = this.handlers.get(channel as EventChannel)
    if (!set || set.size === 0) return
    let payload: unknown = null
    try {
      payload = payloadText ? (JSON.parse(payloadText) as unknown) : null
    } catch (err) {
      this.opts.logger?.warn({ err, channel }, 'event bus: invalid JSON payload ignored')
      return
    }
    for (const handler of set) {
      try {
        const r = handler(payload)
        if (r instanceof Promise) {
          r.catch((err: unknown) => this.opts.logger?.error({ err, channel }, 'event handler failed'))
        }
      } catch (err) {
        this.opts.logger?.error({ err, channel }, 'event handler failed')
      }
    }
  }
}
