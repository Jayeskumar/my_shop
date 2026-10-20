/**
 * Access-token session check (ARCHITECTURE.md §7.4). Every authenticated request verifies that
 * the token's session (`sid`) still exists, belongs to the token's user, is not revoked and not
 * expired. Results are cached in-process for 30 s; revocations (tokens.ts) broadcast
 * NOTIFY kadai_cache {scope:'session'} so every process drops the entry immediately.
 */
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.generated'
import type { Tx } from '../db/tenant'
import { TtlCache } from './cache'
import { CHANNELS, type EventBus, notify } from './events'

export interface SessionState {
  sessionId: string
  userId: string
  tenantId: string | null
  familyId: string
  active: boolean
}

export interface SessionChange {
  scope: 'session'
  session_ids?: string[]
  user_id?: string
}

export class SessionCache {
  private readonly cache: TtlCache<SessionState | null>

  constructor(
    private readonly systemDb: Kysely<DB>,
    opts: { ttlMs?: number } = {},
  ) {
    this.cache = new TtlCache(opts.ttlMs ?? 30_000)
  }

  /** Session state, or null when it does not exist. Keyed by user so user-wide revokes are cheap. */
  get(userId: string, sessionId: string): Promise<SessionState | null> {
    return this.cache.getOrLoad(`${userId}:${sessionId}`, async () => {
      const row = await this.systemDb
        .selectFrom('auth_sessions as s')
        .select((eb) => [
          's.id',
          's.user_id',
          's.tenant_id',
          's.family_id',
          's.revoked_at',
          's.revoked_reason',
          's.expires_at',
          eb
            .exists(
              eb
                .selectFrom('auth_sessions as f')
                .select('f.id')
                .whereRef('f.family_id', '=', 's.family_id')
                .where('f.revoked_at', 'is', null)
                .where('f.expires_at', '>', new Date()),
            )
            .as('family_active'),
        ])
        .where('s.id', '=', sessionId)
        .executeTakeFirst()
      if (!row) return null
      const live = row.revoked_at === null && row.expires_at.getTime() > Date.now()
      // After a refresh the previous session is revoked as 'rotated', but access tokens minted for
      // it stay usable until they expire (≤ 15 min) as long as the login (family) is alive —
      // otherwise requests in flight during a refresh would fail. Logout / reuse detection
      // revoke the live member of the family, which ends the family for rotated ones too.
      const rotatedButAlive = row.revoked_reason === 'rotated' && Boolean(row.family_active)
      return {
        sessionId: row.id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        familyId: row.family_id,
        active: live || rotatedButAlive,
      }
    })
  }

  invalidate(change: { sessionIds?: readonly string[]; userId?: string }): void {
    if (change.userId) {
      const prefix = `${change.userId}:`
      this.cache.deleteWhere((k) => k.startsWith(prefix))
    }
    if (change.sessionIds?.length) {
      const ids = new Set(change.sessionIds)
      this.cache.deleteWhere((k) => ids.has(k.slice(k.indexOf(':') + 1)))
    }
    if (!change.userId && !change.sessionIds) this.cache.clear()
  }

  listen(events: EventBus): () => void {
    return events.subscribe(CHANNELS.cache, (payload) => {
      if (typeof payload !== 'object' || payload === null) return
      const p = payload as Partial<SessionChange> & { scope?: unknown }
      if (p.scope !== 'session') return
      this.invalidate({
        sessionIds: Array.isArray(p.session_ids) ? p.session_ids.filter((s): s is string => typeof s === 'string') : undefined,
        userId: typeof p.user_id === 'string' ? p.user_id : undefined,
      })
    })
  }
}

/** Broadcast a revocation (inside the revoking transaction when there is one). */
export async function notifySessionsRevoked(db: Kysely<DB> | Tx, change: { session_ids?: string[]; user_id?: string }): Promise<void> {
  const ids = change.session_ids ?? []
  // Large id lists would exceed NOTIFY's payload limit: fall back to a user-wide invalidation.
  if (!change.user_id && ids.length === 0) return
  const payload: SessionChange = { scope: 'session' }
  if (change.user_id) payload.user_id = change.user_id
  if (ids.length && ids.length <= 150) payload.session_ids = ids
  await notify(db, CHANNELS.cache, { ...payload })
}
