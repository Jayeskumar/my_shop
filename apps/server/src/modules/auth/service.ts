/**
 * Auth flows (ARCHITECTURE.md §7.4, docs/API.md "auth"): password / OTP / PIN sign-in with
 * lockouts, password reset & change, tenant selection, refresh rotation, logout and the trusted
 * device checks. Route wiring lives in ./index.ts; sessions are issued by ./session.ts.
 *
 * System database use is limited to what has no tenant context yet or is system-only by design
 * (§6.1, §17): user lookup by phone/email and password columns (the app role cannot read them),
 * auth_sessions, OTP codes and the device lookup that tells which tenant a counter belongs to.
 * Everything after the tenant is known runs in an RLS tenant transaction on the app database.
 */
import { sql } from 'kysely'
import { type AuthMethod, normalizeIndianPhone } from '@kadai/shared'
import type {
  AuthOtpPurpose,
  LoginRequest,
  OtpRequestResponse,
  OtpTokenResponse,
  PinUser,
} from '@kadai/shared/api/auth'
import { AppError, forbidden, invalidField, isAppError } from '../../core/errors'
import { OTP_RESEND_AFTER_SECONDS, OTP_TTL_SECONDS } from '../../core/otp'
import {
  assertPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
  verifyPasswordOrDummy,
  verifyPin,
} from '../../core/passwords'
import { audit } from '../../core/audit'
import { notifyAccessChanged } from '../../core/rbac'
import type { KadaiDeps } from '../../core/runtime'
import { notifySessionsRevoked } from '../../core/session-cache'
import {
  type CreatedSession,
  createSession,
  hashRefreshToken,
  revokeFamily,
  revokeSessions,
  rotateSession,
  verifyDeviceSecret,
} from '../../core/tokens'
import { withSystemTx, withTenant } from '../../db/tenant'
import type { AuthInfo } from '../../plugins/fastify-types'
import {
  LOCK_MINUTES,
  MAX_FAILED_ATTEMPTS,
  type MembershipEntry,
  type RequestMeta,
  type SessionSubject,
  auditInTenants,
  invalidCredentials,
  listMemberships,
  lockedError,
} from './session'

type Deps = Pick<KadaiDeps, 'config' | 'db' | 'otp' | 'rbac' | 'sessions'>
type UserAuth = Extract<AuthInfo, { kind: 'user' }>

/** A precomputed argon2 work item so unknown device/user paths cost the same as real ones. */
const DUMMY_PIN_HASH_SOURCE = '0000'

// ---------------------------------------------------------------------------------------------
// Password & OTP sign-in
// ---------------------------------------------------------------------------------------------

/** Mobile number (any common Indian format) or email. */
export function parseIdentifier(raw: string): { phone: string } | { email: string } | null {
  const v = raw.trim()
  if (v.includes('@')) return /^[^\s@]+@[^\s@]+$/.test(v) ? { email: v.toLowerCase() } : null
  const phone = normalizeIndianPhone(v)
  return phone ? { phone } : null
}

/**
 * After a successful sign-in: clears the failure counter / lock, records the login, upgrades an
 * outdated password hash, accepts pending invitations and picks the tenant (the only active
 * membership; otherwise the client must call select-tenant).
 */
async function completeLogin(
  deps: Deps,
  meta: RequestMeta,
  userId: string,
  method: 'password' | 'otp',
  opts: { rehashPassword?: string | null } = {},
): Promise<SessionSubject> {
  const db = deps.db.systemDb
  const newHash = opts.rehashPassword ? await hashPassword(opts.rehashPassword) : null
  const acceptedTenants = await withSystemTx(db, async (tx) => {
    await tx
      .updateTable('users')
      .set({
        failed_login_count: 0,
        locked_until: null,
        last_login_at: new Date(),
        ...(newHash ? { password_hash: newHash } : {}),
      })
      .where('id', '=', userId)
      .execute()
    // An invitation is accepted by signing in (identity creates invited memberships).
    const accepted = await tx
      .updateTable('memberships')
      .set({ status: 'active' })
      .where('user_id', '=', userId)
      .where('status', '=', 'invited')
      .returning('tenant_id')
      .execute()
    for (const m of accepted)
      await notifyAccessChanged(tx, { tenant_id: m.tenant_id, user_id: userId })
    return accepted.map((m) => m.tenant_id)
  })
  // NOTIFY reaches this process asynchronously; drop our own cache entries right away.
  for (const tenantId of acceptedTenants) deps.rbac.invalidate({ tenantId, userId })
  const memberships = await listMemberships(db, userId)
  const scoped: MembershipEntry | null = memberships.length === 1 ? memberships[0]! : null
  if (scoped) {
    await auditInTenants(db, [scoped.tenant_id], meta, userId, {
      action: 'auth.login',
      entity_type: 'user',
      entity_id: userId,
      summary: `Signed in with ${method === 'otp' ? 'OTP' : 'password'}`,
      changes: { method, ip: meta.ip },
    })
  }
  return {
    userId,
    tenantId: scoped?.tenant_id ?? null,
    membershipId: scoped?.membership_id ?? null,
    amr: [method],
  }
}

/**
 * POST /auth/login. Generic INVALID_CREDENTIALS for unknown identifiers and wrong passwords
 * (with an equivalent argon2 computation either way); 5 consecutive failures lock the account
 * for 15 minutes (423 ACCOUNT_LOCKED, also while locked even with the right password).
 */
export async function passwordLogin(
  deps: Deps,
  meta: RequestMeta,
  body: LoginRequest,
): Promise<SessionSubject> {
  const db = deps.db.systemDb
  const id = parseIdentifier(body.identifier)
  // system db: identities are global and the app role cannot read password columns.
  const user = id
    ? await db
        .selectFrom('users')
        .select(['id', 'password_hash', 'status', 'locked_until'])
        .where('phone' in id ? 'phone' : 'email', '=', 'phone' in id ? id.phone : id.email)
        .executeTakeFirst()
    : undefined
  if (user?.locked_until && user.locked_until.getTime() > Date.now()) {
    throw lockedError('ACCOUNT_LOCKED', user.locked_until)
  }
  const ok = await verifyPasswordOrDummy(user?.password_hash ?? null, body.password)
  if (!user) throw invalidCredentials()
  if (!ok) {
    const res = await db
      .updateTable('users')
      .set({
        failed_login_count: sql<number>`case when failed_login_count + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else failed_login_count + 1 end`,
        locked_until: sql<Date>`case when failed_login_count + 1 >= ${MAX_FAILED_ATTEMPTS}
                                     then now() + make_interval(mins => ${LOCK_MINUTES}) else locked_until end`,
      })
      .where('id', '=', user.id)
      .returning(['locked_until'])
      .executeTakeFirst()
    const lockedUntil =
      res?.locked_until && res.locked_until.getTime() > Date.now() ? res.locked_until : null
    const tenants = (await listMemberships(db, user.id)).map((m) => m.tenant_id)
    await auditInTenants(db, tenants, meta, user.id, {
      action: 'auth.login_failed',
      entity_type: 'user',
      entity_id: user.id,
      summary: lockedUntil
        ? `Wrong password; account locked for ${LOCK_MINUTES} minutes`
        : 'Wrong password',
      changes: { ip: meta.ip, locked: Boolean(lockedUntil) },
    })
    throw lockedUntil ? lockedError('ACCOUNT_LOCKED', lockedUntil) : invalidCredentials()
  }
  if (user.status !== 'active')
    throw forbidden('This account is disabled', { reason: 'user_disabled' })
  return completeLogin(deps, meta, user.id, 'password', {
    rehashPassword: user.password_hash && needsRehash(user.password_hash) ? body.password : null,
  })
}

/**
 * POST /auth/otp/request. Login / reset codes are only sent to registered, active numbers, but
 * the response is identical either way (no account enumeration). Per-phone throttling is done by
 * the OTP service (30 s between codes, 3 per 10 minutes).
 */
export async function requestOtp(
  deps: Deps,
  meta: RequestMeta,
  body: { phone: string; purpose: AuthOtpPurpose },
): Promise<OtpRequestResponse> {
  if (body.purpose !== 'signup') {
    const user = await deps.db.systemDb
      .selectFrom('users')
      .select(['status'])
      .where('phone', '=', body.phone)
      .executeTakeFirst()
    if (!user || user.status !== 'active') {
      return { expires_in: OTP_TTL_SECONDS, resend_after: OTP_RESEND_AFTER_SECONDS }
    }
  }
  const sent = await deps.otp.request({
    phone: body.phone,
    purpose: body.purpose,
    ip: meta.ip,
    locale: meta.locale,
  })
  return { expires_in: sent.expires_in, resend_after: sent.resend_after }
}

/** POST /auth/otp/verify: a session subject (login) or an otp_token (signup / reset). */
export async function verifyOtp(
  deps: Deps,
  meta: RequestMeta,
  body: { phone: string; code: string; purpose: AuthOtpPurpose },
): Promise<
  { kind: 'session'; subject: SessionSubject } | { kind: 'token'; token: OtpTokenResponse }
> {
  const { otp_id } = await deps.otp.verify(body)
  if (body.purpose !== 'login') {
    return { kind: 'token', token: await deps.otp.issueOtpToken(body.phone, body.purpose, otp_id) }
  }
  const user = await deps.db.systemDb
    .selectFrom('users')
    .select(['id', 'status'])
    .where('phone', '=', body.phone)
    .executeTakeFirst()
  if (!user) throw invalidCredentials()
  if (user.status !== 'active')
    throw forbidden('This account is disabled', { reason: 'user_disabled' })
  return { kind: 'session', subject: await completeLogin(deps, meta, user.id, 'otp') }
}

// ---------------------------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------------------------

/**
 * POST /auth/password/reset with an otp_token from a reset_password OTP. A token is single use:
 * it is refused once the password changed after its OTP was verified. Every session of the user
 * is revoked.
 */
export async function resetPassword(
  deps: Deps,
  meta: RequestMeta,
  body: { otp_token: string; new_password: string },
): Promise<void> {
  const { phone, otp_id } = await deps.otp.verifyOtpToken(body.otp_token, 'reset_password')
  const expired = () =>
    new AppError('OTP_EXPIRED', 'Phone verification expired; verify the OTP again')
  const db = deps.db.systemDb
  // The token was issued when its OTP was consumed; it is stale once the password changed later.
  const otp = await db
    .selectFrom('otp_codes')
    .select(['consumed_at'])
    .where('id', '=', otp_id)
    .where('phone', '=', phone)
    .where('purpose', '=', 'reset_password')
    .executeTakeFirst()
  const user = await db
    .selectFrom('users')
    .select(['id', 'status', 'email', 'full_name'])
    .where('phone', '=', phone)
    .executeTakeFirst()
  if (!otp?.consumed_at || !user || user.status !== 'active') throw expired()
  const verifiedAt = otp.consumed_at
  assertPasswordPolicy(
    body.new_password,
    { phone, email: user.email, name: user.full_name },
    'new_password',
  )
  const hash = await hashPassword(body.new_password)
  const changed = await withSystemTx(db, async (tx) => {
    // Check-and-set in one statement: a replayed (or concurrent second) use matches no row.
    const row = await tx
      .updateTable('users')
      .set({
        password_hash: hash,
        password_changed_at: new Date(),
        failed_login_count: 0,
        locked_until: null,
      })
      .where('id', '=', user.id)
      .where((eb) =>
        eb.or([eb('password_changed_at', 'is', null), eb('password_changed_at', '<=', verifiedAt)]),
      )
      .returning('id')
      .executeTakeFirst()
    if (row) await revokeSessions(tx, user.id, { reason: 'password_reset' })
    return Boolean(row)
  })
  if (!changed) throw expired()
  deps.sessions.invalidate({ userId: user.id })
  const tenants = (await listMemberships(db, user.id)).map((m) => m.tenant_id)
  await auditInTenants(db, tenants, meta, user.id, {
    action: 'auth.password_reset',
    entity_type: 'user',
    entity_id: user.id,
    summary: 'Password reset by OTP; all sessions signed out',
  })
}

/**
 * POST /auth/password/change. Keeps the current login (its refresh family) and signs out every
 * other session of the user.
 */
export async function changePassword(
  deps: Deps,
  meta: RequestMeta,
  auth: UserAuth,
  body: { current_password: string; new_password: string },
): Promise<void> {
  const db = deps.db.systemDb
  const user = await db
    .selectFrom('users')
    .select(['id', 'password_hash', 'phone', 'email', 'full_name'])
    .where('id', '=', auth.userId)
    .executeTakeFirst()
  const ok = user?.password_hash
    ? await verifyPassword(user.password_hash, body.current_password)
    : false
  if (!user || !ok) throw invalidField('current_password', 'The current password is incorrect')
  assertPasswordPolicy(
    body.new_password,
    { phone: user.phone, email: user.email, name: user.full_name },
    'new_password',
  )
  const hash = await hashPassword(body.new_password)
  await withSystemTx(db, async (tx) => {
    await tx
      .updateTable('users')
      .set({
        password_hash: hash,
        password_changed_at: new Date(),
        failed_login_count: 0,
        locked_until: null,
      })
      .where('id', '=', user.id)
      .execute()
    const revoked = await tx
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'password_change' })
      .where('user_id', '=', user.id)
      .where('revoked_at', 'is', null)
      .where('family_id', '<>', auth.familyId)
      .returning('id')
      .execute()
    if (revoked.length) await notifySessionsRevoked(tx, { user_id: user.id })
  })
  deps.sessions.invalidate({ userId: user.id })
  const tenants = (await listMemberships(db, user.id)).map((m) => m.tenant_id)
  await auditInTenants(db, tenants, meta, user.id, {
    action: 'auth.password_change',
    entity_type: 'user',
    entity_id: user.id,
    summary: 'Password changed; other sessions signed out',
  })
}

// ---------------------------------------------------------------------------------------------
// Sessions: tenant selection, refresh, logout
// ---------------------------------------------------------------------------------------------

/**
 * POST /auth/select-tenant: the live session of the current login is rotated into one scoped to
 * `tenantId` (same refresh family, so reuse detection keeps working). A device binding is kept
 * only when the device belongs to that tenant.
 */
export async function selectTenant(
  deps: Deps,
  meta: RequestMeta,
  auth: UserAuth,
  tenantId: string,
): Promise<{ subject: SessionSubject; session: CreatedSession }> {
  const access = await deps.rbac.resolve(auth.userId, tenantId)
  if (
    !access ||
    access.membershipStatus !== 'active' ||
    access.userStatus !== 'active' ||
    access.tenantStatus === 'closed'
  ) {
    throw forbidden('You are not a member of this business', { tenant_id: tenantId })
  }
  let deviceId: string | null = null
  if (auth.deviceId) {
    const device = await deps.rbac.resolveDevice(auth.deviceId, tenantId)
    deviceId = device?.isActive ? device.deviceId : null
  }
  // system db: auth_sessions is system-only.
  const session = await withSystemTx(deps.db.systemDb, async (tx) => {
    const head = await tx
      .selectFrom('auth_sessions')
      .select(['id', 'auth_method'])
      .where('family_id', '=', auth.familyId)
      .where('user_id', '=', auth.userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst()
    if (!head) return null
    const next = await createSession(tx, deps.config, {
      userId: auth.userId,
      tenantId,
      deviceId,
      authMethod: head.auth_method as AuthMethod,
      ip: meta.ip,
      userAgent: meta.userAgent,
      familyId: auth.familyId,
    })
    await tx
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'rotated', replaced_by: next.sessionId })
      .where('id', '=', head.id)
      .execute()
    return next
  })
  if (!session) throw new AppError('SESSION_REVOKED', 'Session was revoked')
  await auditInTenants(deps.db.systemDb, [tenantId], meta, auth.userId, {
    action: 'auth.select_tenant',
    entity_type: 'user',
    entity_id: auth.userId,
    summary: 'Opened this business',
  })
  return {
    subject: {
      userId: auth.userId,
      tenantId,
      membershipId: access.membershipId,
      deviceId,
      amr: auth.amr,
    },
    session,
  }
}

/**
 * POST /auth/refresh: rotates the refresh token (reuse → whole family revoked, SESSION_REVOKED),
 * then re-checks the user, membership and trusted device. If access was lost meanwhile the
 * family is revoked.
 */
export async function refresh(
  deps: Deps,
  meta: RequestMeta,
  token: string,
): Promise<{ subject: SessionSubject; session: CreatedSession }> {
  const db = deps.db.systemDb
  const rotated = await rotateSession(db, deps.config, token, {
    ip: meta.ip,
    userAgent: meta.userAgent,
  }).catch(async (err: unknown) => {
    // Reuse detection revoked the family: make this process forget its sessions now (other
    // processes are told through NOTIFY).
    if (isAppError(err) && err.code === 'SESSION_REVOKED') {
      const row = await db
        .selectFrom('auth_sessions')
        .select('user_id')
        .where('refresh_token_hash', '=', hashRefreshToken(token))
        .executeTakeFirst()
      if (row) deps.sessions.invalidate({ userId: row.user_id })
    }
    throw err
  })
  const fail = async (err: AppError): Promise<never> => {
    await revokeFamily(db, rotated.familyId, 'access_revoked')
    deps.sessions.invalidate({ userId: rotated.userId })
    throw err
  }
  const user = await db
    .selectFrom('users')
    .select('status')
    .where('id', '=', rotated.userId)
    .executeTakeFirst()
  if (!user || user.status !== 'active')
    await fail(new AppError('SESSION_REVOKED', 'This user is disabled'))
  let membershipId: string | null = null
  if (rotated.tenantId) {
    const access = await deps.rbac.resolve(rotated.userId, rotated.tenantId)
    if (!access || access.membershipStatus !== 'active' || access.tenantStatus === 'closed') {
      await fail(new AppError('SESSION_REVOKED', 'You are no longer a member of this business'))
    }
    membershipId = access!.membershipId
    if (rotated.deviceId) {
      const device = await deps.rbac.resolveDevice(rotated.deviceId, rotated.tenantId)
      if (!device?.isActive)
        await fail(new AppError('DEVICE_NOT_TRUSTED', 'This device is no longer trusted'))
    }
  }
  return {
    subject: {
      userId: rotated.userId,
      tenantId: rotated.tenantId,
      membershipId,
      deviceId: rotated.deviceId,
      amr: [rotated.authMethod],
    },
    session: rotated,
  }
}

/**
 * POST /auth/logout: revokes the current login's refresh family, or every session of the user
 * with `all`. Works with an expired access token too, through the refresh cookie / body token.
 */
export async function logout(
  deps: Deps,
  meta: RequestMeta,
  auth: UserAuth | null,
  presented: string | null,
  all: boolean,
): Promise<void> {
  const db = deps.db.systemDb
  let userId: string | null = auth?.userId ?? null
  let familyId: string | null = auth?.familyId ?? null
  if (!auth && presented) {
    const row = await db
      .selectFrom('auth_sessions')
      .select(['user_id', 'family_id'])
      .where('refresh_token_hash', '=', hashRefreshToken(presented))
      .executeTakeFirst()
    userId = row?.user_id ?? null
    familyId = row?.family_id ?? null
  }
  if (!userId || !familyId) return
  if (all) await revokeSessions(db, userId, { reason: 'logout_all' })
  else await revokeFamily(db, familyId, 'logout')
  // Other processes learn it through NOTIFY; this one immediately.
  deps.sessions.invalidate({ userId })
  if (auth?.tenantId) {
    await auditInTenants(db, [auth.tenantId], meta, userId, {
      action: all ? 'auth.logout_all' : 'auth.logout',
      entity_type: 'user',
      entity_id: userId,
      summary: all ? 'Signed out everywhere' : 'Signed out',
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Trusted devices & PIN
// ---------------------------------------------------------------------------------------------

export interface TrustedDevice {
  id: string
  tenantId: string
  storeId: string
  registerId: string | null
}

/**
 * Verifies a counter's device credentials. System db: the device row is what tells us the tenant.
 * Unknown, revoked or wrong-secret devices are all DEVICE_NOT_TRUSTED (the client then forgets
 * the stored credentials).
 */
export async function verifyDevice(
  deps: Deps,
  deviceId: string,
  secret: string,
): Promise<TrustedDevice> {
  const row = await deps.db.systemDb
    .selectFrom('devices as d')
    .innerJoin('tenants as t', 't.id', 'd.tenant_id')
    .select([
      'd.id',
      'd.tenant_id',
      'd.store_id',
      'd.register_id',
      'd.device_secret_hash',
      'd.is_active',
      'd.revoked_at',
      't.status as tenant_status',
    ])
    .where('d.id', '=', deviceId)
    .executeTakeFirst()
  const secretOk = verifyDeviceSecret(row?.device_secret_hash ?? '', secret)
  if (!row || !secretOk || !row.is_active || row.revoked_at || row.tenant_status === 'closed') {
    throw new AppError('DEVICE_NOT_TRUSTED', 'This device is not registered as a trusted counter')
  }
  return { id: row.id, tenantId: row.tenant_id, storeId: row.store_id, registerId: row.register_id }
}

/** GET /auth/pin-users: members with a PIN who may work at this device's store. */
export async function pinUsers(deps: Deps, device: TrustedDevice): Promise<PinUser[]> {
  return withTenant(deps.db.appDb, { tenantId: device.tenantId, userId: null }, (tx) =>
    tx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .innerJoin('roles as r', (j) =>
        j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
      )
      .select(['u.id as user_id', 'u.full_name', 'r.code as role_code', 'r.name as role_name'])
      .where('m.tenant_id', '=', device.tenantId)
      .where('m.status', '=', 'active')
      .where('u.status', '=', 'active')
      .where('m.pos_pin_hash', 'is not', null)
      .where(sql<boolean>`(m.store_ids is null or ${device.storeId}::uuid = any(m.store_ids))`)
      .orderBy('u.full_name')
      .orderBy('u.id')
      .execute(),
  )
}

/**
 * POST /auth/pin-login on a trusted device: membership PIN, 5 wrong PINs lock the membership's
 * PIN for 15 minutes (423 PIN_LOCKED). The session is bound to the device (and its register).
 */
export async function pinLogin(
  deps: Deps,
  meta: RequestMeta,
  device: TrustedDevice,
  body: { user_id: string; pin: string },
): Promise<SessionSubject> {
  const now = new Date()
  const outcome = await withTenant(
    deps.db.appDb,
    { tenantId: device.tenantId, userId: null },
    async (tx) => {
      const m = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select([
          'm.id',
          'm.status',
          'm.store_ids',
          'm.pos_pin_hash',
          'm.pin_locked_until',
          'u.status as user_status',
        ])
        .where('m.tenant_id', '=', device.tenantId)
        .where('m.user_id', '=', body.user_id)
        .forUpdate('m')
        .executeTakeFirst()
      const auditCtx = {
        tenantId: device.tenantId,
        userId: m ? body.user_id : null,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      }
      const eligible =
        m &&
        m.status === 'active' &&
        m.user_status === 'active' &&
        m.pos_pin_hash &&
        (m.store_ids === null || m.store_ids.includes(device.storeId))
      if (!m || !eligible) {
        await verifyPin(await dummyPinHash(), body.pin) // equal cost for unknown members
        return { kind: 'invalid' as const }
      }
      if (m.pin_locked_until && m.pin_locked_until.getTime() > now.getTime()) {
        return { kind: 'locked' as const, until: m.pin_locked_until }
      }
      if (!(await verifyPin(m.pos_pin_hash!, body.pin))) {
        const res = await tx
          .updateTable('memberships')
          .set({
            pin_failed_count: sql<number>`case when pin_failed_count + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else pin_failed_count + 1 end`,
            pin_locked_until: sql<Date>`case when pin_failed_count + 1 >= ${MAX_FAILED_ATTEMPTS}
                                          then now() + make_interval(mins => ${LOCK_MINUTES}) else pin_locked_until end`,
          })
          .where('tenant_id', '=', device.tenantId)
          .where('id', '=', m.id)
          .returning(['pin_locked_until'])
          .executeTakeFirst()
        const until =
          res?.pin_locked_until && res.pin_locked_until.getTime() > now.getTime()
            ? res.pin_locked_until
            : null
        await audit(tx, auditCtx, {
          action: 'auth.pin_login_failed',
          entity_type: 'device',
          entity_id: device.id,
          summary: until ? `Wrong PIN; PIN locked for ${LOCK_MINUTES} minutes` : 'Wrong PIN',
        })
        return until ? { kind: 'locked' as const, until } : { kind: 'invalid' as const }
      }
      await tx
        .updateTable('memberships')
        .set({ pin_failed_count: 0, pin_locked_until: null })
        .where('tenant_id', '=', device.tenantId)
        .where('id', '=', m.id)
        .execute()
      await tx
        .updateTable('devices')
        .set({ last_seen_at: now })
        .where('tenant_id', '=', device.tenantId)
        .where('id', '=', device.id)
        .execute()
      await audit(tx, auditCtx, {
        action: 'auth.pin_login',
        entity_type: 'device',
        entity_id: device.id,
        summary: 'Signed in with PIN on a trusted device',
      })
      return { kind: 'ok' as const, membershipId: m.id }
    },
  )
  if (outcome.kind === 'locked') throw lockedError('PIN_LOCKED', outcome.until)
  if (outcome.kind === 'invalid') {
    throw new AppError(
      'INVALID_CREDENTIALS',
      'The PIN is incorrect or this user cannot sign in here',
    )
  }
  return {
    userId: body.user_id,
    tenantId: device.tenantId,
    membershipId: outcome.membershipId,
    deviceId: device.id,
    amr: ['pin'],
  }
}

let dummyPin: Promise<string> | null = null
function dummyPinHash(): Promise<string> {
  dummyPin ??= hashPassword(DUMMY_PIN_HASH_SOURCE)
  return dummyPin
}
