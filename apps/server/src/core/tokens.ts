/**
 * Access tokens, refresh-token sessions and API keys (ARCHITECTURE.md §7.4).
 *
 * Access token: HS256 JWT, 15 minutes, claims {sub, tid, mid, sid, did, amr}, issuer 'kadai',
 * audience 'kadai-api'. Never stored server-side; the session it references (`sid`) is checked
 * by the auth plugin (cached), so revocation takes effect within the cache TTL.
 *
 * Refresh token: 32 random bytes (base64url), stored only as sha256 in auth_sessions with a
 * `family_id`. Each refresh rotates: the old row is revoked ('rotated', replaced_by → new row) and
 * a new row joins the family. Presenting an already-rotated token again means it was stolen
 * (or replayed): the whole family is revoked and SESSION_REVOKED is returned.
 *
 * auth_sessions is a system-only table: every function here takes the SYSTEM database.
 */
import { randomInt } from 'node:crypto'
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose'
import type { Kysely } from 'kysely'
import { type AccessTokenClaims, AccessTokenClaimsSchema } from '@kadai/shared/api/auth'
import { type AuthMethod, newId } from '@kadai/shared'
import type { Config } from '../config'
import type { DB } from '../db/schema.generated'
import { type Tx, withSystemTx } from '../db/tenant'
import { randomToken, sha256Hex } from './crypto'
import { AppError, unauthenticated } from './errors'
import { CHANNELS, notify } from './events'
import { notifySessionsRevoked } from './session-cache'

const ISSUER = 'kadai'
const AUDIENCE = 'kadai-api'

type SystemDb = Kysely<DB> | Tx

function jwtKey(config: Pick<Config, 'auth'>): Uint8Array {
  return new TextEncoder().encode(config.auth.jwtSecret)
}

export interface AccessTokenInput {
  userId: string
  tenantId: string | null
  membershipId: string | null
  sessionId: string
  deviceId?: string | null
  amr: readonly AuthMethod[]
}

export async function signAccessToken(
  config: Pick<Config, 'auth'>,
  input: AccessTokenInput,
  opts: { ttlSeconds?: number; now?: Date } = {},
): Promise<{ token: string; expiresIn: number }> {
  const ttl = opts.ttlSeconds ?? config.auth.accessTokenTtlSeconds
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  const token = await new SignJWT({
    tid: input.tenantId,
    mid: input.membershipId,
    sid: input.sessionId,
    did: input.deviceId ?? null,
    amr: [...input.amr],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(jwtKey(config))
  return { token, expiresIn: ttl }
}

/** Verifies signature, issuer, audience, expiry and claim shape. Throws UNAUTHENTICATED. */
export async function verifyAccessToken(
  config: Pick<Config, 'auth'>,
  token: string,
  opts: { now?: Date } = {},
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, jwtKey(config), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: 5,
      currentDate: opts.now,
    })
    const parsed = AccessTokenClaimsSchema.safeParse(payload)
    if (!parsed.success) throw unauthenticated('Malformed access token')
    return parsed.data
  } catch (err) {
    if (err instanceof AppError) throw err
    if (err instanceof joseErrors.JWTExpired) throw unauthenticated('Access token expired')
    throw unauthenticated('Invalid access token')
  }
}

// ---------------------------------------------------------------------------------------------
// Refresh-token sessions
// ---------------------------------------------------------------------------------------------

export function hashRefreshToken(token: string): string {
  return sha256Hex(token)
}

export interface CreateSessionInput {
  userId: string
  tenantId: string | null
  deviceId?: string | null
  authMethod: AuthMethod
  ip?: string | null
  userAgent?: string | null
  /** Continue an existing family (rotation); new family when omitted. */
  familyId?: string
  ttlDays?: number
}

export interface CreatedSession {
  sessionId: string
  familyId: string
  /** Plaintext refresh token — returned to the client once, never stored. */
  refreshToken: string
  expiresAt: Date
}

const MAX_USER_AGENT = 512

function cleanIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  return /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : null
}

export async function createSession(
  systemDb: SystemDb,
  config: Pick<Config, 'auth'>,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const sessionId = newId()
  const familyId = input.familyId ?? newId()
  const refreshToken = randomToken(32)
  const ttlDays = input.ttlDays ?? config.auth.refreshTokenTtlDays
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
  await systemDb
    .insertInto('auth_sessions')
    .values({
      id: sessionId,
      user_id: input.userId,
      tenant_id: input.tenantId,
      refresh_token_hash: hashRefreshToken(refreshToken),
      family_id: familyId,
      device_id: input.deviceId ?? null,
      auth_method: input.authMethod,
      user_agent: input.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
      ip: cleanIp(input.ip),
      expires_at: expiresAt,
      last_used_at: new Date(),
    })
    .execute()
  return { sessionId, familyId, refreshToken, expiresAt }
}

export interface RotatedSession extends CreatedSession {
  userId: string
  tenantId: string | null
  deviceId: string | null
  authMethod: AuthMethod
  previousSessionId: string
}

/**
 * Exchanges a refresh token for a new one (rotation with reuse detection).
 * @throws UNAUTHENTICATED unknown/expired token, SESSION_REVOKED revoked token or reuse detected.
 */
export async function rotateSession(
  systemDb: Kysely<DB>,
  config: Pick<Config, 'auth'>,
  refreshToken: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<RotatedSession> {
  const tokenHash = hashRefreshToken(refreshToken)
  const outcome = await withSystemTx(systemDb, async (tx) => {
    const row = await tx
      .selectFrom('auth_sessions')
      .selectAll()
      .where('refresh_token_hash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst()
    if (!row) {
      return { kind: 'error' as const, error: unauthenticated('Invalid refresh token') }
    }
    if (row.revoked_at) {
      if (row.revoked_reason === 'rotated') {
        // Reuse of a rotated token: assume theft, kill every session of the family. Committed
        // even though the request fails (the outer error is raised after the transaction).
        await revokeFamilyTx(tx, row.family_id, 'reuse_detected')
        return { kind: 'error' as const, error: new AppError('SESSION_REVOKED', 'Refresh token reuse detected; all sessions of this login were revoked') }
      }
      return { kind: 'error' as const, error: new AppError('SESSION_REVOKED', 'Session was revoked') }
    }
    if (row.expires_at.getTime() <= Date.now()) {
      return { kind: 'error' as const, error: unauthenticated('Refresh token expired') }
    }
    const next = await createSession(tx, config, {
      userId: row.user_id,
      tenantId: row.tenant_id,
      deviceId: row.device_id,
      authMethod: row.auth_method as AuthMethod,
      ip: meta.ip ?? row.ip,
      userAgent: meta.userAgent ?? row.user_agent,
      familyId: row.family_id,
    })
    await tx
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'rotated', replaced_by: next.sessionId })
      .where('id', '=', row.id)
      .execute()
    return {
      kind: 'ok' as const,
      session: {
        ...next,
        userId: row.user_id,
        tenantId: row.tenant_id,
        deviceId: row.device_id,
        authMethod: row.auth_method as AuthMethod,
        previousSessionId: row.id,
      },
    }
  })
  if (outcome.kind === 'error') throw outcome.error
  return outcome.session
}

async function revokeFamilyTx(tx: SystemDb, familyId: string, reason: string): Promise<string[]> {
  const rows = await tx
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date(), revoked_reason: reason })
    .where('family_id', '=', familyId)
    .where('revoked_at', 'is', null)
    .returning(['id', 'user_id'])
    .execute()
  await broadcast(tx, rows)
  return rows.map((r) => r.id)
}

/**
 * Tells every process to drop cached session checks of the affected users (sent inside the
 * revoking transaction when there is one). User-wide, because access tokens of earlier (rotated)
 * sessions in the same family are only valid while the family is alive.
 */
async function broadcast(db: SystemDb, rows: ReadonlyArray<{ user_id: string }>): Promise<void> {
  for (const userId of new Set(rows.map((r) => r.user_id))) {
    await notifySessionsRevoked(db, { user_id: userId })
  }
}

/** Revokes one session (logout). Returns false when it was already revoked / unknown. */
export async function revokeSession(systemDb: SystemDb, sessionId: string, reason = 'logout'): Promise<boolean> {
  const rows = await systemDb
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date(), revoked_reason: reason })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .returning(['id', 'user_id'])
    .execute()
  await broadcast(systemDb, rows)
  return rows.length > 0
}

/** Revokes a whole refresh family (e.g. the login a session belongs to). */
export function revokeFamily(systemDb: SystemDb, familyId: string, reason = 'logout'): Promise<string[]> {
  return revokeFamilyTx(systemDb, familyId, reason)
}

/**
 * Revokes every live session of a user (logout everywhere, password change, user disabled),
 * optionally keeping one and/or limiting to one tenant. Returns the revoked session ids.
 */
export async function revokeSessions(
  systemDb: SystemDb,
  userId: string,
  opts: { exceptSessionId?: string; tenantId?: string; reason?: string } = {},
): Promise<string[]> {
  let q = systemDb
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date(), revoked_reason: opts.reason ?? 'logout_all' })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
  if (opts.exceptSessionId) q = q.where('id', '<>', opts.exceptSessionId)
  if (opts.tenantId) q = q.where('tenant_id', '=', opts.tenantId)
  const rows = await q.returning(['id', 'user_id']).execute()
  await broadcast(systemDb, rows)
  return rows.map((r) => r.id)
}

// ---------------------------------------------------------------------------------------------
// API keys: `kd_<mode>_<prefix>_<secret>` (mode live|test, prefix 8 [a-z0-9], secret 43 b64url)
// api_keys.key_prefix stores `kd_<mode>_<prefix>` (lookup + UI display); key_hash = sha256(key).
// ---------------------------------------------------------------------------------------------

export type ApiKeyMode = 'live' | 'test'
const API_KEY_RE = /^kd_(live|test)_([a-z0-9]{8})_([A-Za-z0-9_-]{32,64})$/

export interface GeneratedApiKey {
  /** Full key, shown to the user once. */
  key: string
  /** Stored in api_keys.key_prefix. */
  keyPrefix: string
  /** Stored in api_keys.key_hash. */
  keyHash: string
}

export function generateApiKey(mode: ApiKeyMode = 'live'): GeneratedApiKey {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let prefix = ''
  for (let i = 0; i < 8; i++) prefix += alphabet[randomInt(alphabet.length)]
  const keyPrefix = `kd_${mode}_${prefix}`
  const key = `${keyPrefix}_${randomToken(32)}`
  return { key, keyPrefix, keyHash: hashApiKey(key) }
}

export function parseApiKey(key: string): { mode: ApiKeyMode; keyPrefix: string } | null {
  const m = API_KEY_RE.exec(key.trim())
  if (!m) return null
  return { mode: m[1] as ApiKeyMode, keyPrefix: `kd_${m[1]}_${m[2]}` }
}

export function hashApiKey(key: string): string {
  return sha256Hex(key.trim())
}

/** Call inside the transaction that creates/revokes/edits an API key: drops every process's key cache. */
export function notifyApiKeysChanged(db: SystemDb): Promise<void> {
  return notify(db, CHANNELS.cache, { scope: 'api_key' })
}
