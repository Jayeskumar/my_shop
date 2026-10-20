/**
 * Session issuance shared by every auth flow (ARCHITECTURE.md §7.4): refresh session row →
 * signed access token → SessionResponse, with the refresh token delivered as the httpOnly
 * `kadai_rt` cookie (browsers) or in the body (non-browser clients that ask for it).
 *
 * auth_sessions, users (password columns) and cross-tenant membership lists are only reachable
 * through the SYSTEM database: before a session exists there is no tenant context, and a user's
 * memberships span tenants by definition.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { type AuthMethod, type BusinessType, type Locale } from '@kadai/shared'
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  type MembershipSummary,
  type SessionResponse,
  type SessionUser,
  TOKEN_DELIVERY_HEADER,
} from '@kadai/shared/api/auth'
import type { Config } from '../../config'
import { audit } from '../../core/audit'
import { AppError, forbidden, unauthenticated } from '../../core/errors'
import type { KadaiDeps } from '../../core/runtime'
import { type CreatedSession, createSession, signAccessToken } from '../../core/tokens'
import type { DB } from '../../db/schema.generated'
import { withSystemTx } from '../../db/tenant'

export const REFRESH_COOKIE = 'kadai_rt'
/** The cookie is only sent to /api/v1/auth/* (refresh, logout). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth'

/** Failed attempts before a password / PIN lock, and its duration. */
export const MAX_FAILED_ATTEMPTS = 5
export const LOCK_MINUTES = 15

export type TokenDelivery = 'cookie' | 'body'

export interface RequestMeta {
  ip: string
  userAgent: string
  requestId: string
  locale: Locale
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

export function requestMeta(req: FastifyRequest): RequestMeta {
  const locale = header(req, 'x-locale')
  return {
    ip: req.ip,
    userAgent: header(req, 'user-agent') ?? '',
    requestId: req.id,
    locale: locale === 'en' ? 'en' : 'ta',
  }
}

/** `X-Kadai-Token-Delivery: body` → refresh token in the JSON body instead of the cookie. */
export function deliveryOf(req: FastifyRequest): TokenDelivery {
  return header(req, TOKEN_DELIVERY_HEADER)?.trim().toLowerCase() === 'body' ? 'body' : 'cookie'
}

/** Cookie-borne refresh tokens need the custom header a cross-site form cannot send. */
export function assertCsrfHeader(req: FastifyRequest): void {
  if (header(req, CSRF_HEADER)?.trim().toLowerCase() !== CSRF_HEADER_VALUE) {
    throw forbidden('Missing X-Requested-With header', { reason: 'csrf' })
  }
}

/** Refresh token from the body (non-browser) or the cookie (CSRF header required). */
export function presentedRefreshToken(
  req: FastifyRequest,
  bodyToken: string | undefined,
): { token: string; via: 'body' | 'cookie' } | null {
  if (bodyToken) return { token: bodyToken, via: 'body' }
  const cookie = req.cookies[REFRESH_COOKIE]
  if (!cookie) return null
  assertCsrfHeader(req)
  return { token: cookie, via: 'cookie' }
}

function cookieOptions(config: Pick<Config, 'publicBaseUrl'>) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: REFRESH_COOKIE_PATH,
    // On-prem LAN installs are plain http; the cookie must still work there.
    secure: config.publicBaseUrl.startsWith('https://'),
  }
}

export function setRefreshCookie(
  reply: FastifyReply,
  config: Pick<Config, 'publicBaseUrl'>,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(REFRESH_COOKIE, token, { ...cookieOptions(config), expires: expiresAt })
}

export function clearRefreshCookie(
  reply: FastifyReply,
  config: Pick<Config, 'publicBaseUrl'>,
): void {
  reply.clearCookie(REFRESH_COOKIE, cookieOptions(config))
}

export interface MembershipEntry extends MembershipSummary {
  membership_id: string
  tenant_status: string
}

/** Active memberships of a user in businesses that are not closed (system db: spans tenants). */
export async function listMemberships(
  systemDb: Kysely<DB>,
  userId: string,
): Promise<MembershipEntry[]> {
  const rows = await systemDb
    .selectFrom('memberships as m')
    .innerJoin('tenants as t', 't.id', 'm.tenant_id')
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
    )
    .select([
      'm.id as membership_id',
      'm.tenant_id',
      't.name as tenant_name',
      't.business_type',
      't.status as tenant_status',
      'r.code as role_code',
    ])
    .where('m.user_id', '=', userId)
    .where('m.status', '=', 'active')
    .where('t.status', '<>', 'closed')
    .orderBy('t.name')
    .orderBy('m.tenant_id')
    .execute()
  return rows.map((r) => ({ ...r, business_type: r.business_type as BusinessType }))
}

export async function loadSessionUser(systemDb: Kysely<DB>, userId: string): Promise<SessionUser> {
  const u = await systemDb
    .selectFrom('users')
    .select(['id', 'full_name', 'phone', 'email', 'preferred_locale', 'is_platform_admin'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!u) throw unauthenticated('User not found')
  return { ...u, preferred_locale: u.preferred_locale === 'en' ? 'en' : 'ta' }
}

export interface SessionSubject {
  userId: string
  tenantId: string | null
  membershipId: string | null
  deviceId?: string | null
  amr: readonly AuthMethod[]
}

/**
 * Signs the access token for an existing refresh session and builds the response; delivers the
 * refresh token per `delivery`.
 */
export async function respondWithSession(
  deps: Pick<KadaiDeps, 'config' | 'db'>,
  reply: FastifyReply,
  subject: SessionSubject,
  session: Pick<CreatedSession, 'sessionId' | 'refreshToken' | 'expiresAt'>,
  delivery: TokenDelivery,
): Promise<SessionResponse> {
  const { token, expiresIn } = await signAccessToken(deps.config, {
    userId: subject.userId,
    tenantId: subject.tenantId,
    membershipId: subject.membershipId,
    sessionId: session.sessionId,
    deviceId: subject.deviceId ?? null,
    amr: subject.amr,
  })
  const [user, memberships] = await Promise.all([
    loadSessionUser(deps.db.systemDb, subject.userId),
    listMemberships(deps.db.systemDb, subject.userId),
  ])
  if (delivery === 'cookie')
    setRefreshCookie(reply, deps.config, session.refreshToken, session.expiresAt)
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    ...(delivery === 'body' ? { refresh_token: session.refreshToken } : {}),
    user,
    memberships: memberships.map(({ tenant_id, tenant_name, business_type, role_code }) => ({
      tenant_id,
      tenant_name,
      business_type,
      role_code,
    })),
    tenant_id: subject.tenantId,
  }
}

/** Creates a new refresh session (new family) and responds with it. */
export async function startSession(
  deps: Pick<KadaiDeps, 'config' | 'db'>,
  reply: FastifyReply,
  meta: RequestMeta,
  subject: SessionSubject,
  delivery: TokenDelivery,
): Promise<SessionResponse> {
  const authMethod = subject.amr[0] ?? 'password'
  // system db: auth_sessions is a system-only table (§17).
  const session = await createSession(deps.db.systemDb, deps.config, {
    userId: subject.userId,
    tenantId: subject.tenantId,
    deviceId: subject.deviceId ?? null,
    authMethod,
    ip: meta.ip,
    userAgent: meta.userAgent,
  })
  return respondWithSession(deps, reply, subject, session, delivery)
}

/**
 * Writes the same audit entry into each tenant (login events of an identity that belongs to
 * several businesses). System db: called before any tenant context exists.
 */
export async function auditInTenants(
  systemDb: Kysely<DB>,
  tenantIds: readonly string[],
  meta: RequestMeta,
  userId: string | null,
  entry: Parameters<typeof audit>[2],
): Promise<void> {
  const unique = [...new Set(tenantIds)].slice(0, 20)
  if (unique.length === 0) return
  await withSystemTx(systemDb, async (tx) => {
    for (const tenantId of unique) {
      await audit(
        tx,
        { tenantId, userId, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId },
        entry,
      )
    }
  })
}

/** 423 with Retry-After for password / PIN locks. */
export function lockedError(code: 'ACCOUNT_LOCKED' | 'PIN_LOCKED', until: Date): AppError {
  const seconds = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000))
  return new AppError(
    code,
    code === 'ACCOUNT_LOCKED'
      ? `Too many failed attempts; try again in ${Math.ceil(seconds / 60)} minutes`
      : `Too many wrong PINs; try again in ${Math.ceil(seconds / 60)} minutes`,
    { retry_after_seconds: seconds, locked_until: until.toISOString() },
    { headers: { 'retry-after': String(seconds) } },
  )
}

export const invalidCredentials = (): AppError =>
  new AppError('INVALID_CREDENTIALS', 'The mobile number / email or password is incorrect')
