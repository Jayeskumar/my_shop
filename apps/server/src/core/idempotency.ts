/**
 * Idempotent POSTs (ARCHITECTURE.md §7.3): same key + same request → the stored response;
 * same key + different request → 409 IDEMPOTENCY_MISMATCH.
 *
 * The key row is written INSIDE the business transaction:
 *
 *   INSERT … (status 'processing') ON CONFLICT DO NOTHING
 *     inserted        → run the work, store {status, body}, mark 'completed' — all in the same
 *                       transaction, so a failure rolls the key back and a retry runs afresh
 *     not inserted    → the key exists (committed): same hash + completed → replay the stored
 *                       response; different hash → IDEMPOTENCY_MISMATCH; still processing →
 *                       IDEMPOTENCY_IN_PROGRESS
 *
 * A concurrent duplicate blocks on the unique index until the first transaction finishes:
 * after a commit it sees the completed row and replays; after a rollback its own insert
 * proceeds and it does the work itself. Expired keys (expires_at < now) are taken over.
 */
import { sql } from 'kysely'
import type { Tx } from '../db/tenant'
import { jsonb } from '../db/json'
import type { RequestContext } from './context'
import { canonicalJson, sha256Hex } from './crypto'
import { AppError } from './errors'

export interface IdempotencyRequest {
  /** Idempotency-Key header or body client_ref (8..200 chars). */
  key: string
  method: string
  /** Route path (pattern or URL without query). */
  path: string
  /** sha256 of the canonical request (see requestHash). */
  requestHash: string
  /** Default 7 days. */
  ttlSeconds?: number
}

export interface IdempotentResponse<T> {
  status: number
  body: T
}

export interface IdempotencyOutcome<T> extends IdempotentResponse<T> {
  /** True when the stored response of an earlier identical request was returned. */
  replayed: boolean
}

/** Stable hash of a request body (key order independent). */
export function requestHash(body: unknown, extra: Record<string, unknown> = {}): string {
  return sha256Hex(canonicalJson({ body: body ?? null, ...extra }))
}

export function assertIdempotencyKey(key: string): void {
  if (key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError('VALIDATION_ERROR', 'Idempotency-Key must be 8-200 visible ASCII characters', {
      issues: [{ path: 'Idempotency-Key', message: 'must be 8-200 visible ASCII characters' }],
    })
  }
}

/**
 * Runs `work` at most once per (tenant, key). `work` returns the response to store; it must be
 * JSON-serialisable (it is stored in jsonb and replayed verbatim).
 */
export async function runIdempotent<T>(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  req: IdempotencyRequest,
  work: () => Promise<IdempotentResponse<T>>,
): Promise<IdempotencyOutcome<T>> {
  assertIdempotencyKey(req.key)
  const ttl = req.ttlSeconds ?? 7 * 86_400
  const claimed = await tx
    .insertInto('idempotency_keys')
    .values({
      tenant_id: ctx.tenantId,
      key: req.key,
      method: req.method,
      path: req.path,
      request_hash: req.requestHash,
      status: 'processing',
      expires_at: sql<Date>`now() + make_interval(secs => ${ttl})`,
    })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'key'])
        // Take over an expired key (cleanup job has not removed it yet).
        .doUpdateSet({
          method: req.method,
          path: req.path,
          request_hash: req.requestHash,
          status: 'processing',
          response_status: null,
          response_body: null,
          created_at: sql<Date>`now()`,
          expires_at: sql<Date>`now() + make_interval(secs => ${ttl})`,
        })
        .where('idempotency_keys.expires_at', '<', sql<Date>`now()`),
    )
    .returning('key')
    .executeTakeFirst()

  if (!claimed) {
    const existing = await tx
      .selectFrom('idempotency_keys')
      .select(['method', 'path', 'request_hash', 'status', 'response_status', 'response_body'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('key', '=', req.key)
      .executeTakeFirstOrThrow()
    if (existing.request_hash !== req.requestHash || existing.method !== req.method || existing.path !== req.path) {
      throw new AppError('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request', {
        key: req.key,
      })
    }
    if (existing.status !== 'completed' || existing.response_status === null) {
      throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed', {
        key: req.key,
      })
    }
    return { status: existing.response_status, body: existing.response_body as T, replayed: true }
  }

  const response = await work()
  await tx
    .updateTable('idempotency_keys')
    .set({
      status: 'completed',
      response_status: response.status,
      response_body: jsonb(response.body ?? null),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('key', '=', req.key)
    .execute()
  return { ...response, replayed: false }
}
