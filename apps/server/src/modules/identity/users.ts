/**
 * Members of the business (docs/API.md "identity" → users): list, directory, invite by mobile
 * number, update role / stores / name, disable / enable, POS PIN reset and admin password reset.
 *
 * Users are GLOBAL identities (one person may work for several businesses); a membership links a
 * user to this tenant with a role and a store scope. The app role can only read the public user
 * columns of this tenant's members (RLS) and update its OWN user row, so the following use the
 * SYSTEM database, each marked where it happens (ARCHITECTURE.md §6.1):
 *   - looking up a mobile number / email across all Kadai users (invite, uniqueness);
 *   - creating a user and writing users.password_hash (invite, admin password reset);
 *   - updating another member's name / email / language (only when the identity belongs to this
 *     business alone — `shared_identity` otherwise);
 *   - revoking auth_sessions (system-only table).
 * Everything else runs in the request's RLS tenant transaction. Guards on top of users.manage:
 * nobody disables / re-roles / admin-resets themselves; the last active owner stays an owner;
 * only owners grant the owner role or manage owners; a non-owner cannot hand out permissions
 * they lack; store-scoped admins manage only members inside their stores.
 */
import { randomInt } from 'node:crypto'
import type { z } from 'zod'
import { type Permission, expandPermissions, isUuid, newId } from '@kadai/shared'
import type {
  Member,
  MemberCreateResult,
  MemberCreateSchema,
  MemberDisableSchema,
  MemberListQuerySchema,
  MemberUpdateSchema,
  ResetPasswordResult,
  ResetPasswordSchema,
  ResetPinSchema,
  UserDirectoryEntry,
  UserDirectoryQuerySchema,
} from '@kadai/shared/api/identity'
import { USER_DIRECTORY_LIMIT } from '@kadai/shared/api/identity'
import { sql } from 'kysely'
import { audit, diffChanges } from '../../core/audit'
import { assertWithinLimit } from '../../core/entitlements'
import { assertNotStale, notFound, validationError } from '../../core/errors'
import { type PageEnvelope, parsePage } from '../../core/http'
import { assertPasswordPolicy, hashPassword, hashPin, isWeakPin } from '../../core/passwords'
import { notifyAccessChanged } from '../../core/rbac'
import type { KadaiDeps } from '../../core/runtime'
import { revokeSessions } from '../../core/tokens'
import { type Tx, afterCommit, afterRollback, withSystemTx } from '../../db/tenant'
import {
  anyOf,
  assertGrantable,
  assertScopeCovers,
  containsPattern,
  type Ctx,
  iso,
  isoOrNull,
  isOwnerCtx,
  lockKey,
  paginateQuery,
  phoneSearchDigits,
  reasonConflict,
  reasonForbidden,
  reasonUnprocessable,
  scopeCovers,
} from './common'

export type IdentityDeps = Pick<KadaiDeps, 'config' | 'db' | 'otp' | 'rbac' | 'sessions'>

type MemberListQuery = z.output<typeof MemberListQuerySchema>
type MemberCreateBody = z.output<typeof MemberCreateSchema>
type MemberUpdateBody = z.output<typeof MemberUpdateSchema>
type MemberDisableBody = z.output<typeof MemberDisableSchema>
type ResetPinBody = z.output<typeof ResetPinSchema>
type ResetPasswordBody = z.output<typeof ResetPasswordSchema>
type DirectoryQuery = z.output<typeof UserDirectoryQuerySchema>

export const OWNER_ROLE_CODE = 'owner'

// ---------------------------------------------------------------------------------------------
// Reading members
// ---------------------------------------------------------------------------------------------

function memberQuery(tx: Tx, ctx: Ctx) {
  return tx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
    )
    .leftJoin('users as iu', 'iu.id', 'm.invited_by')
    .select([
      'u.id as user_id',
      'm.id as membership_id',
      'u.full_name',
      'u.phone',
      'u.email',
      'u.preferred_locale',
      'u.status as user_status',
      'u.last_login_at',
      'm.role_id',
      'r.code as role_code',
      'r.name as role_name',
      'r.name_ta as role_name_ta',
      'm.store_ids',
      'm.status',
      'm.pin_locked_until',
      'm.invited_by',
      'iu.full_name as invited_by_name',
      'm.created_at',
      'm.updated_at',
    ])
    .select(sql<boolean>`m.pos_pin_hash is not null`.as('has_pin'))
    .where('m.tenant_id', '=', ctx.tenantId)
}

type MemberRow = Awaited<ReturnType<ReturnType<typeof memberQuery>['executeTakeFirstOrThrow']>>

function toMember(row: MemberRow, ctx: Ctx, now = Date.now()): Member {
  const locked =
    row.pin_locked_until && row.pin_locked_until.getTime() > now ? row.pin_locked_until : null
  return {
    id: row.user_id,
    membership_id: row.membership_id,
    full_name: row.full_name,
    phone: row.phone,
    email: row.email,
    preferred_locale: row.preferred_locale === 'en' ? 'en' : 'ta',
    role_id: row.role_id,
    role_code: row.role_code,
    role_name: row.role_name,
    role_name_ta: row.role_name_ta,
    is_owner: row.role_code === OWNER_ROLE_CODE,
    store_ids: row.store_ids,
    status: row.status as Member['status'],
    user_status: row.user_status as Member['user_status'],
    has_pin: row.has_pin,
    pin_locked_until: isoOrNull(locked),
    last_login_at: isoOrNull(row.last_login_at),
    invited_by: row.invited_by,
    invited_by_name: row.invited_by_name,
    is_self: row.user_id === ctx.userId,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

export async function getMember(tx: Tx, ctx: Ctx, userId: string): Promise<Member> {
  const row = await memberQuery(tx, ctx).where('m.user_id', '=', userId).executeTakeFirst()
  if (!row) throw notFound('member', userId)
  return toMember(row, ctx)
}

export async function listMembers(
  tx: Tx,
  ctx: Ctx,
  query: MemberListQuery,
): Promise<PageEnvelope<Member>> {
  let q = memberQuery(tx, ctx)
  if (query.q) {
    const digits = phoneSearchDigits(query.q)
    q = q.where((eb) =>
      anyOf([
        eb('u.full_name', 'ilike', containsPattern(query.q!)),
        ...(digits ? [eb('u.phone', 'like', `%${digits}%`)] : []),
      ]),
    )
  }
  if (query.role_id) q = q.where('m.role_id', '=', query.role_id)
  if (query.status) q = q.where('m.status', '=', query.status)
  if (query.store_id) {
    q = q.where(sql<boolean>`(m.store_ids is null or ${query.store_id}::uuid = any(m.store_ids))`)
  }
  // Store-scoped admins see the members who can work in (one of) their stores.
  if (ctx.storeIds !== null) {
    q = q.where(sql<boolean>`(m.store_ids is null or m.store_ids && ${[...ctx.storeIds]}::uuid[])`)
  }
  const { field, direction } = query.sort
  const column =
    field === 'full_name'
      ? 'u.full_name'
      : field === 'last_login_at'
        ? 'u.last_login_at'
        : 'm.created_at'
  q = q
    .orderBy(column, (ob) => (direction === 'desc' ? ob.desc().nullsLast() : ob.asc().nullsLast()))
    .orderBy('u.id')
  const page = await paginateQuery(q, parsePage(query))
  return { data: page.data.map((r) => toMember(r, ctx)), page: page.page }
}

/** GET /users/directory: names for pickers (any member; no contact or security fields). */
export async function userDirectory(
  tx: Tx,
  ctx: Ctx,
  query: DirectoryQuery,
): Promise<UserDirectoryEntry[]> {
  let q = tx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
    )
    .select([
      'u.id',
      'u.full_name',
      'r.code as role_code',
      'r.name as role_name',
      'r.name_ta as role_name_ta',
      'm.status',
      'm.store_ids',
    ])
    .where('m.tenant_id', '=', ctx.tenantId)
  if (!query.include_disabled) q = q.where('m.status', '<>', 'disabled')
  if (query.q) q = q.where('u.full_name', 'ilike', containsPattern(query.q))
  if (query.store_id) {
    q = q.where(sql<boolean>`(m.store_ids is null or ${query.store_id}::uuid = any(m.store_ids))`)
  }
  const rows = await q.orderBy('u.full_name').orderBy('u.id').limit(USER_DIRECTORY_LIMIT).execute()
  return rows.map((r) => ({ ...r, status: r.status as UserDirectoryEntry['status'] }))
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

interface RoleRef {
  id: string
  code: string
  name: string
  effective: ReadonlySet<Permission>
}

async function loadRole(tx: Tx, ctx: Ctx, roleId: string): Promise<RoleRef> {
  const role = await tx
    .selectFrom('roles')
    .select(['id', 'code', 'name', 'permissions'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', roleId)
    .executeTakeFirst()
  if (!role) {
    throw validationError([{ path: 'role_id', message: 'role_unknown', code: 'role_unknown' }])
  }
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    effective: expandPermissions(role.permissions),
  }
}

/** The caller may give this role: owner role only by owners, no permissions beyond their own. */
function assertRoleGrantable(ctx: Ctx, role: RoleRef): void {
  if (role.code === OWNER_ROLE_CODE && !isOwnerCtx(ctx)) {
    throw reasonForbidden('owner_only', 'Only an owner can give the owner role')
  }
  assertGrantable(ctx, role.effective)
}

async function assertStoresExist(
  tx: Tx,
  ctx: Ctx,
  storeIds: readonly string[] | null,
): Promise<void> {
  if (storeIds === null) return
  const unique = [...new Set(storeIds)]
  if (!unique.every(isUuid)) {
    throw validationError([{ path: 'store_ids', message: 'store_unknown', code: 'store_unknown' }])
  }
  const found = await tx
    .selectFrom('stores')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', unique)
    .execute()
  if (found.length !== unique.length) {
    const known = new Set(found.map((s) => s.id))
    throw validationError(
      unique
        .filter((id) => !known.has(id))
        .map((id) => ({
          path: `store_ids.${storeIds.indexOf(id)}`,
          message: 'store_unknown',
          code: 'store_unknown',
        })),
    )
  }
}

function assertPinStrength(pin: string | null | undefined): void {
  if (pin && isWeakPin(pin)) {
    throw validationError([{ path: 'pin', message: 'pin_weak', code: 'pin_weak' }])
  }
}

const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** 'k7mq-9x4p-a2bd' (TEMPORARY_PASSWORD_RE): ~59 bits, no look-alike characters. */
export function generateTemporaryPassword(): string {
  const group = () =>
    Array.from({ length: 4 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('')
  return `${group()}-${group()}-${group()}`
}

interface LockedMember {
  user_id: string
  membership_id: string
  role_id: string
  role_code: string
  role_name: string
  store_ids: string[] | null
  status: string
  updated_at: Date
  full_name: string
  phone: string | null
  email: string | null
  preferred_locale: string
  last_login_at: Date | null
}

/** Loads and row-locks the membership of `userId` (404 when not a member). */
async function lockMember(tx: Tx, ctx: Ctx, userId: string): Promise<LockedMember> {
  if (!isUuid(userId)) throw notFound('member', userId)
  const row = await tx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
    )
    .select([
      'u.id as user_id',
      'm.id as membership_id',
      'm.role_id',
      'r.code as role_code',
      'r.name as role_name',
      'm.store_ids',
      'm.status',
      'm.updated_at',
      'u.full_name',
      'u.phone',
      'u.email',
      'u.preferred_locale',
      'u.last_login_at',
    ])
    .where('m.tenant_id', '=', ctx.tenantId)
    .where('m.user_id', '=', userId)
    .forUpdate('m')
    .executeTakeFirst()
  if (!row) throw notFound('member', userId)
  return row
}

/**
 * The caller may manage this member: owners only by owners, store-scoped admins only members
 * whose stores lie inside their own scope. `allowSelf` skips the scope check for yourself.
 */
function assertManageable(
  ctx: Ctx,
  target: LockedMember,
  opts: { allowSelf?: boolean } = {},
): void {
  const self = target.user_id === ctx.userId
  if (self && opts.allowSelf) return
  if (target.role_code === OWNER_ROLE_CODE && !isOwnerCtx(ctx)) {
    throw reasonForbidden('owner_only', 'Only an owner can manage another owner')
  }
  if (!scopeCovers(ctx, target.store_ids)) {
    throw reasonForbidden('store_scope', 'This member works outside your store access', {
      store_ids: target.store_ids,
    })
  }
}

function assertNotSelf(ctx: Ctx, target: LockedMember, action: string): void {
  if (target.user_id === ctx.userId) {
    throw reasonConflict('self_action', `You cannot ${action} yourself`)
  }
}

/** Active owners other than `exceptUserId`, counted under a per-tenant lock (no races). */
async function otherActiveOwners(tx: Tx, ctx: Ctx, exceptUserId: string): Promise<number> {
  await lockKey(tx, `kadai_owner_guard:${ctx.tenantId}`)
  const row = await tx
    .selectFrom('memberships as m')
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
    )
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('m.tenant_id', '=', ctx.tenantId)
    .where('r.code', '=', OWNER_ROLE_CODE)
    .where('m.status', '=', 'active')
    .where('u.status', '=', 'active')
    .where('m.user_id', '<>', exceptUserId)
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

async function assertKeepsAnOwner(tx: Tx, ctx: Ctx, target: LockedMember): Promise<void> {
  if (target.role_code !== OWNER_ROLE_CODE) return
  if ((await otherActiveOwners(tx, ctx, target.user_id)) === 0) {
    throw reasonConflict('last_owner', 'The business must keep at least one active owner')
  }
}

/** Every process drops the member's cached access after commit; this one immediately too. */
async function accessChanged(deps: IdentityDeps, tx: Tx, ctx: Ctx, userId: string): Promise<void> {
  await notifyAccessChanged(tx, { tenant_id: ctx.tenantId, user_id: userId })
  afterCommit(tx, () => deps.rbac.invalidate({ tenantId: ctx.tenantId, userId }))
}

/** Memberships of the user in OTHER businesses (system db: memberships span tenants). */
async function otherMemberships(deps: IdentityDeps, ctx: Ctx, userId: string): Promise<number> {
  const row = await deps.db.systemDb
    .selectFrom('memberships')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('tenant_id', '<>', ctx.tenantId)
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

async function assertOwnIdentity(deps: IdentityDeps, ctx: Ctx, target: LockedMember, what: string) {
  if (target.user_id === ctx.userId) return
  if ((await otherMemberships(deps, ctx, target.user_id)) > 0) {
    throw reasonConflict(
      'shared_identity',
      `This person also works for another business; only they can change their ${what}`,
    )
  }
}

/** Email already used by another Kadai user (system db: emails are globally unique). */
async function emailTaken(
  deps: IdentityDeps,
  email: string,
  exceptUserId?: string,
): Promise<boolean> {
  let q = deps.db.systemDb.selectFrom('users').select('id').where('email', '=', email)
  if (exceptUserId) q = q.where('id', '<>', exceptUserId)
  return Boolean(await q.executeTakeFirst())
}

// ---------------------------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------------------------

/**
 * POST /users. Existing Kadai user (by mobile) → a membership only. New user → a user whose first
 * sign-in is by a generated temporary password (returned once), a password chosen here, or OTP.
 * The membership starts 'invited' (signing in accepts it). Plan limit `users`.
 */
export async function createMember(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  body: MemberCreateBody,
): Promise<MemberCreateResult> {
  const role = await loadRole(tx, ctx, body.role_id)
  assertRoleGrantable(ctx, role)
  await assertStoresExist(tx, ctx, body.store_ids)
  assertScopeCovers(ctx, body.store_ids, 'The new member')
  assertPinStrength(body.pin)
  await assertWithinLimit(tx, ctx, 'users')

  const sys = deps.db.systemDb
  // system db: a mobile number is looked up across every Kadai user, not just this tenant's.
  const existing = await sys
    .selectFrom('users')
    .select(['id', 'status'])
    .where('phone', '=', body.phone)
    .executeTakeFirst()

  let userId: string
  let temporaryPassword: string | null = null
  if (existing) {
    const membership = await tx
      .selectFrom('memberships')
      .select(['status'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', existing.id)
      .executeTakeFirst()
    if (membership) {
      throw reasonConflict('already_member', 'This mobile number is already a member', {
        user_id: existing.id,
        status: membership.status,
      })
    }
    if (existing.status !== 'active') {
      throw reasonConflict('account_disabled', 'This mobile number belongs to a disabled account')
    }
    userId = existing.id
  } else {
    if (
      body.first_login === 'otp' &&
      deps.config.isProduction &&
      deps.config.sms.provider === 'log'
    ) {
      throw reasonUnprocessable(
        'sms_not_configured',
        'OTP sign-in needs an SMS provider; give a temporary password instead',
      )
    }
    if (body.email && (await emailTaken(deps, body.email))) {
      throw reasonConflict('email_taken', 'This email is already used by another account', {
        field: 'email',
      })
    }
    let password: string | null = null
    if (body.first_login === 'password') {
      password = body.password!
      assertPasswordPolicy(password, { phone: body.phone, email: body.email, name: body.full_name })
    } else if (body.first_login === 'temporary_password') {
      temporaryPassword = generateTemporaryPassword()
      password = temporaryPassword
    }
    const passwordHash = password ? await hashPassword(password) : null
    const tenant = await tx
      .selectFrom('tenants')
      .select('default_locale')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirstOrThrow()
    const newUserId = newId()
    // system db: users are global identities and the app role cannot insert them. Serialised
    // per phone (same lock as onboarding) so two invites cannot create the number twice.
    const created = await withSystemTx(sys, async (stx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`kadai_signup:${body.phone}`}, 0))`.execute(
        stx,
      )
      const raced = await stx
        .selectFrom('users')
        .select('id')
        .where('phone', '=', body.phone)
        .executeTakeFirst()
      if (raced) return null
      await stx
        .insertInto('users')
        .values({
          id: newUserId,
          phone: body.phone,
          email: body.email ?? null,
          full_name: body.full_name,
          password_hash: passwordHash,
          password_changed_at: passwordHash ? new Date() : null,
          preferred_locale: body.preferred_locale ?? (tenant.default_locale === 'en' ? 'en' : 'ta'),
        })
        .execute()
      return newUserId
    })
    if (!created) {
      throw reasonConflict('already_member', 'This mobile number was just registered; try again')
    }
    userId = created
    // The user exists only for this invite: remove it again if the invite fails.
    afterRollback(tx, async () => {
      // system db: compensating delete of the identity created above (only while unused).
      await sys
        .deleteFrom('users')
        .where('id', '=', created)
        .where(({ not, exists, selectFrom }) =>
          not(exists(selectFrom('memberships').select('id').where('user_id', '=', created))),
        )
        .execute()
    })
  }

  await tx
    .insertInto('memberships')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      user_id: userId,
      role_id: role.id,
      store_ids: body.store_ids,
      status: 'invited',
      invited_by: ctx.userId,
      pos_pin_hash: body.pin ? await hashPin(body.pin) : null,
    })
    .execute()
  await accessChanged(deps, tx, ctx, userId)
  const member = await getMember(tx, ctx, userId)
  await audit(tx, ctx, {
    action: 'user.invite',
    entity_type: 'user',
    entity_id: userId,
    summary: `${member.full_name} invited as ${role.name}`,
    changes: {
      role_code: role.code,
      store_ids: body.store_ids,
      existing_user: Boolean(existing),
      first_login: existing ? null : body.first_login,
      has_pin: Boolean(body.pin),
    },
  })

  let otpSent = false
  if (body.first_login === 'otp' && !existing) {
    try {
      await deps.otp.request({
        phone: body.phone,
        purpose: 'login',
        ip: ctx.ip,
        locale: ctx.locale,
      })
      otpSent = true
    } catch {
      // Throttled or SMS provider down: the member can request a code on the sign-in screen.
      otpSent = false
    }
  }
  return {
    member,
    existing_user: Boolean(existing),
    temporary_password: temporaryPassword,
    otp_sent: otpSent,
  }
}

// ---------------------------------------------------------------------------------------------
// Update / disable / enable
// ---------------------------------------------------------------------------------------------

export async function updateMember(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  userId: string,
  body: MemberUpdateBody,
): Promise<Member> {
  const target = await lockMember(tx, ctx, userId)
  assertNotStale(target.updated_at, body.if_updated_at, 'member', userId)
  const self = target.user_id === ctx.userId
  const roleChange = body.role_id !== undefined && body.role_id !== target.role_id
  const storesChange =
    body.store_ids !== undefined &&
    JSON.stringify(body.store_ids) !== JSON.stringify(target.store_ids)
  // Your own name / language you may always change; anything else follows the manage rules.
  assertManageable(ctx, target, { allowSelf: !roleChange && !storesChange })

  let newRole: RoleRef | null = null
  if (roleChange) {
    assertNotSelf(ctx, target, 'change the role of')
    newRole = await loadRole(tx, ctx, body.role_id!)
    assertRoleGrantable(ctx, newRole)
    if (newRole.code !== OWNER_ROLE_CODE) await assertKeepsAnOwner(tx, ctx, target)
  }
  if (storesChange) {
    await assertStoresExist(tx, ctx, body.store_ids!)
    assertScopeCovers(ctx, body.store_ids!, 'The member')
  }

  const userPatch: { full_name?: string; email?: string | null; preferred_locale?: string } = {}
  if (body.full_name !== undefined && body.full_name !== target.full_name)
    userPatch.full_name = body.full_name
  if (body.email !== undefined && body.email !== target.email) userPatch.email = body.email
  if (body.preferred_locale !== undefined && body.preferred_locale !== target.preferred_locale)
    userPatch.preferred_locale = body.preferred_locale
  const userChange = Object.keys(userPatch).length > 0
  if (userChange) {
    await assertOwnIdentity(deps, ctx, target, 'name or email')
    if (userPatch.email && (await emailTaken(deps, userPatch.email, target.user_id))) {
      throw reasonConflict('email_taken', 'This email is already used by another account', {
        field: 'email',
      })
    }
  }

  if (roleChange || storesChange) {
    await tx
      .updateTable('memberships')
      .set({
        ...(roleChange ? { role_id: newRole!.id } : {}),
        ...(storesChange ? { store_ids: body.store_ids! } : {}),
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', target.membership_id)
      .execute()
  } else if (userChange && !self) {
    // Touch updated_at so if_updated_at of other editors sees the change.
    await tx
      .updateTable('memberships')
      .set({ updated_at: new Date() })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', target.membership_id)
      .execute()
  }
  // Role, stores and the language are all part of every process's cached access.
  if (roleChange || storesChange || userChange) await accessChanged(deps, tx, ctx, target.user_id)

  const before = {
    full_name: target.full_name,
    email: target.email,
    preferred_locale: target.preferred_locale,
    role_code: target.role_code,
    store_ids: target.store_ids,
  }
  const after = {
    ...before,
    ...userPatch,
    ...(newRole ? { role_code: newRole.code } : {}),
    ...(storesChange ? { store_ids: body.store_ids! } : {}),
  }
  const changes = diffChanges(before, after)
  if (changes) {
    await audit(tx, ctx, {
      action: roleChange ? 'user.role_change' : 'user.update',
      entity_type: 'user',
      entity_id: target.user_id,
      summary: roleChange
        ? `${target.full_name}: role ${target.role_name} → ${newRole!.name}`
        : `${target.full_name} updated`,
      changes,
    })
  }

  if (userChange) {
    // system db: name / email / language live on the global user row (checked above that the
    // identity belongs to this business alone, or is the caller's own). Written last so a
    // failure rolls the tenant changes back too.
    await deps.db.systemDb
      .updateTable('users')
      .set(userPatch)
      .where('id', '=', target.user_id)
      .execute()
  }
  return getMember(tx, ctx, target.user_id)
}

/** POST /users/:id/disable — also signs the member out of this business everywhere. */
export async function disableMember(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  userId: string,
  body: MemberDisableBody,
): Promise<Member> {
  const target = await lockMember(tx, ctx, userId)
  assertNotSelf(ctx, target, 'disable')
  assertManageable(ctx, target)
  if (target.status === 'disabled') return getMember(tx, ctx, userId)
  await assertKeepsAnOwner(tx, ctx, target)
  await tx
    .updateTable('memberships')
    .set({ status: 'disabled' })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', target.membership_id)
    .execute()
  await accessChanged(deps, tx, ctx, target.user_id)
  await audit(tx, ctx, {
    action: 'user.disable',
    entity_type: 'user',
    entity_id: target.user_id,
    summary: `${target.full_name} disabled${body.reason ? `: ${body.reason}` : ''}`,
    changes: { status: { before: target.status, after: 'disabled' }, reason: body.reason ?? null },
  })
  // system db: auth_sessions is system-only. Every session of the member scoped to this business.
  const revoked = await revokeSessions(deps.db.systemDb, target.user_id, {
    tenantId: ctx.tenantId,
    reason: 'membership_disabled',
  })
  if (revoked.length) deps.sessions.invalidate({ userId: target.user_id })
  return getMember(tx, ctx, userId)
}

/**
 * The membership status to restore: the one recorded by the latest `user.disable` audit row
 * (written in the disabling transaction); without one, 'active' when the user ever signed in,
 * else 'invited' (the invitation is still to be accepted).
 */
async function statusBeforeDisable(
  tx: Tx,
  ctx: Ctx,
  target: LockedMember,
): Promise<'active' | 'invited'> {
  const row = await tx
    .selectFrom('audit_logs')
    .select('changes')
    .where('tenant_id', '=', ctx.tenantId)
    .where('action', '=', 'user.disable')
    .where('entity_type', '=', 'user')
    .where('entity_id', '=', target.user_id)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
  const before = (row?.changes as { status?: { before?: unknown } } | null | undefined)?.status
    ?.before
  if (before === 'active' || before === 'invited') return before
  return target.last_login_at ? 'active' : 'invited'
}

export async function enableMember(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  userId: string,
): Promise<Member> {
  const target = await lockMember(tx, ctx, userId)
  assertManageable(ctx, target)
  if (target.status !== 'disabled') return getMember(tx, ctx, userId)
  await assertWithinLimit(tx, ctx, 'users')
  const status = await statusBeforeDisable(tx, ctx, target)
  await tx
    .updateTable('memberships')
    .set({ status })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', target.membership_id)
    .execute()
  await accessChanged(deps, tx, ctx, target.user_id)
  await audit(tx, ctx, {
    action: 'user.enable',
    entity_type: 'user',
    entity_id: target.user_id,
    summary: `${target.full_name} enabled`,
    changes: { status: { before: 'disabled', after: status } },
  })
  return getMember(tx, ctx, userId)
}

// ---------------------------------------------------------------------------------------------
// PIN & password
// ---------------------------------------------------------------------------------------------

/** POST /users/:id/reset-pin — sets / removes the POS PIN and clears the PIN lock. */
export async function resetMemberPin(
  tx: Tx,
  ctx: Ctx,
  userId: string,
  body: ResetPinBody,
): Promise<Member> {
  const target = await lockMember(tx, ctx, userId)
  assertManageable(ctx, target, { allowSelf: true })
  assertPinStrength(body.pin)
  await tx
    .updateTable('memberships')
    .set({
      pos_pin_hash: body.pin ? await hashPin(body.pin) : null,
      pin_failed_count: 0,
      pin_locked_until: null,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', target.membership_id)
    .execute()
  await audit(tx, ctx, {
    action: 'user.pin_reset',
    entity_type: 'user',
    entity_id: target.user_id,
    summary: body.pin
      ? `POS PIN set for ${target.full_name}`
      : `POS PIN removed for ${target.full_name}`,
    changes: { pin: body.pin ? 'set' : 'removed', lock_cleared: true },
  })
  return getMember(tx, ctx, userId)
}

/**
 * POST /users/:id/reset-password — admin reset (on-prem shops have no SMS): a chosen or generated
 * password, every session of the user signed out. Not for yourself (use password change) and
 * only for identities that belong to this business alone.
 */
export async function resetMemberPassword(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  userId: string,
  body: ResetPasswordBody,
): Promise<ResetPasswordResult> {
  const target = await lockMember(tx, ctx, userId)
  assertNotSelf(ctx, target, 'reset the password of')
  assertManageable(ctx, target)
  await assertOwnIdentity(deps, ctx, target, 'password')
  let temporary: string | null = null
  let password: string
  if (body.password) {
    password = body.password
    assertPasswordPolicy(password, {
      phone: target.phone,
      email: target.email,
      name: target.full_name,
    })
  } else {
    temporary = generateTemporaryPassword()
    password = temporary
  }
  const hash = await hashPassword(password)
  await audit(tx, ctx, {
    action: 'user.password_reset',
    entity_type: 'user',
    entity_id: target.user_id,
    summary: `Password of ${target.full_name} reset by an admin; signed out everywhere`,
    changes: { generated: temporary !== null },
  })
  // system db: password_hash is not readable or writable by the app role, and auth_sessions is
  // system-only. Last step: a failure here rolls the audit row back with it.
  const revoked = await withSystemTx(deps.db.systemDb, async (stx) => {
    await stx
      .updateTable('users')
      .set({
        password_hash: hash,
        password_changed_at: new Date(),
        failed_login_count: 0,
        locked_until: null,
      })
      .where('id', '=', target.user_id)
      .execute()
    return revokeSessions(stx, target.user_id, { reason: 'password_reset_admin' })
  })
  deps.sessions.invalidate({ userId: target.user_id })
  return { temporary_password: temporary, sessions_revoked: revoked.length }
}
