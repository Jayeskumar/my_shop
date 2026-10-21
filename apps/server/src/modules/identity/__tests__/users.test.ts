/**
 * Members API: list / directory, invite (new user with a one-time temporary password, chosen
 * password or OTP; existing Kadai user → membership only), plan limit `users`, role / store
 * changes with immediate access re-resolution, owner and self protections, privilege-escalation
 * guards, disable (sessions revoked) / enable, POS PIN reset (lock cleared), admin password reset,
 * idempotent replay without the secret, store scoping and tenant isolation.
 */
import { newId } from '@kadai/shared'
import {
  type Member,
  type MemberCreateResult,
  type ResetPasswordResult,
  TEMPORARY_PASSWORD_RE,
  type UserDirectoryEntry,
} from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { systemContext } from '../../../core/context'
import { type TestApp, buildTestApp, randomPhone } from '../../../test/helpers'
import { TEST_PASSWORD, type TestShop, createTestTenant } from '../../../test/tenants'
import { disableMember, updateMember } from '../users'
import {
  type Data,
  type List,
  api,
  auditRows,
  expectError,
  expectStatus,
  liveSessions,
  randomIp,
} from './fixtures'

describe('identity: users', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const invite = async (
    payload: Record<string, unknown>,
    opts: {
      as?: Parameters<TestShop['inject']>[0]['as']
      on?: TestShop
      headers?: Record<string, string>
    } = {},
  ) =>
    (opts.on ?? shop).inject({
      method: 'POST',
      url: api('/users'),
      payload,
      as: opts.as,
      headers: opts.headers,
    })

  const login = (identifier: string, password: string) =>
    t.app.inject({
      method: 'POST',
      url: api('/auth/login'),
      payload: { identifier, password },
      headers: { 'x-kadai-token-delivery': 'body' },
      remoteAddress: randomIp(),
    })

  const getMember = async (userId: string, on: TestShop = shop) =>
    expectStatus<Data<Member>>(
      await on.inject({ method: 'GET', url: api(`/users/${userId}`) }),
      200,
    ).data

  it('lists members with role, stores, status and last sign-in', async () => {
    const cashier = await shop.asRole('cashier', { store_ids: [shop.store.id] })
    const res = expectStatus<List<Member>>(
      await shop.inject({ method: 'GET', url: api('/users?sort=full_name') }),
      200,
    )
    const owner = res.data.find((m) => m.id === shop.owner.user.id)!
    expect(owner).toMatchObject({
      role_code: 'owner',
      is_owner: true,
      is_self: true,
      status: 'active',
      store_ids: null,
    })
    const c = res.data.find((m) => m.id === cashier.user.id)!
    expect(c).toMatchObject({ role_code: 'cashier', is_owner: false, store_ids: [shop.store.id] })
    expect(res.page.total).toBeGreaterThanOrEqual(2)

    const byName = expectStatus<List<Member>>(
      await shop.inject({
        method: 'GET',
        url: api(`/users?q=${encodeURIComponent(cashier.user.full_name)}`),
      }),
      200,
    )
    expect(byName.data.map((m) => m.id)).toEqual([cashier.user.id])
    const byRole = expectStatus<List<Member>>(
      await shop.inject({ method: 'GET', url: api(`/users?role_id=${shop.roles.cashier}`) }),
      200,
    )
    expect(byRole.data.every((m) => m.role_code === 'cashier')).toBe(true)
  })

  it('invites a new user with a temporary password shown once; signing in accepts it', async () => {
    const phone = randomPhone()
    const created = expectStatus<Data<MemberCreateResult>>(
      await invite({
        phone: phone.slice(3),
        full_name: 'Murugan',
        role_id: shop.roles.cashier,
        store_ids: [shop.store.id],
      }),
      201,
    ).data
    expect(created.existing_user).toBe(false)
    expect(created.temporary_password).toMatch(TEMPORARY_PASSWORD_RE)
    expect(created.member).toMatchObject({
      full_name: 'Murugan',
      phone,
      status: 'invited',
      role_code: 'cashier',
      invited_by: shop.owner.user.id,
      invited_by_name: shop.owner.user.full_name,
      has_pin: false,
    })
    // The plaintext is never stored anywhere but as an argon2 hash.
    const stored = await t.deps.db.systemDb
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', created.member.id)
      .executeTakeFirstOrThrow()
    expect(stored.password_hash).toMatch(/^\$argon2id\$/)

    const session = expectStatus<Data<{ tenant_id: string | null }>>(
      await login(phone, created.temporary_password!),
      200,
    ).data
    expect(session.tenant_id).toBe(shop.tenant.id)
    expect((await getMember(created.member.id)).status).toBe('active')
    const [row] = await auditRows(t, shop, { action: 'user.invite', entity_id: created.member.id })
    expect(row).toBeDefined()
    expect(JSON.stringify(row!.changes)).not.toContain(created.temporary_password!)
  })

  it('adds an existing Kadai user as a member without touching their account', async () => {
    const created = expectStatus<Data<MemberCreateResult>>(
      await invite({
        phone: other.owner.user.phone,
        full_name: 'Ignored Name',
        role_id: shop.roles.accountant,
        first_login: 'password',
        password: 'Another-Pass#77',
      }),
      201,
    ).data
    expect(created).toMatchObject({ existing_user: true, temporary_password: null })
    expect(created.member.full_name).toBe(other.owner.user.full_name)
    // Their own password still works.
    expectStatus(await login(other.owner.user.phone, TEST_PASSWORD), 200)

    expectError(
      await invite({
        phone: other.owner.user.phone,
        full_name: 'Again',
        role_id: shop.roles.cashier,
      }),
      409,
      'CONFLICT',
      'already_member',
    )
  })

  it('supports a chosen password and OTP first sign-in', async () => {
    const phone = randomPhone()
    expectStatus(
      await invite({
        phone,
        full_name: 'Weak',
        role_id: shop.roles.cashier,
        first_login: 'password',
        password: 'password123',
      }),
      400,
    )
    expectError(
      await invite({
        phone,
        full_name: 'Missing',
        role_id: shop.roles.cashier,
        first_login: 'password',
      }),
      400,
      'VALIDATION_ERROR',
    )
    const chosen = expectStatus<Data<MemberCreateResult>>(
      await invite({
        phone,
        full_name: 'Selvi',
        role_id: shop.roles.cashier,
        first_login: 'password',
        password: 'Selvi-Counter#2026',
      }),
      201,
    ).data
    expect(chosen.temporary_password).toBeNull()
    expectStatus(await login(phone, 'Selvi-Counter#2026'), 200)

    const otpPhone = randomPhone()
    const viaOtp = expectStatus<Data<MemberCreateResult>>(
      await invite({
        phone: otpPhone,
        full_name: 'Karthik',
        role_id: shop.roles.cashier,
        first_login: 'otp',
      }),
      201,
    ).data
    expect(viaOtp).toMatchObject({ otp_sent: true, temporary_password: null })
    expect(t.otp.lastCode(otpPhone, 'login')).toMatch(/^\d{6}$/)
    const noPassword = await t.deps.db.systemDb
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', viaOtp.member.id)
      .executeTakeFirstOrThrow()
    expect(noPassword.password_hash).toBeNull()
  })

  it('replays an idempotent invite without the one-time password', async () => {
    const payload = { phone: randomPhone(), full_name: 'Retry', role_id: shop.roles.cashier }
    const key = `invite-${newId()}`
    const first = await invite(payload, { headers: { 'idempotency-key': key } })
    const firstBody = expectStatus<Data<MemberCreateResult>>(first, 201).data
    expect(first.headers['idempotent-replayed']).toBe('false')
    expect(firstBody.temporary_password).toMatch(TEMPORARY_PASSWORD_RE)
    const again = await invite(payload, { headers: { 'idempotency-key': key } })
    const againBody = expectStatus<Data<MemberCreateResult>>(again, 201).data
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(againBody.member.id).toBe(firstBody.member.id)
    expect(againBody.temporary_password).toBeNull()
    const stored = await t.deps.db.systemDb
      .selectFrom('idempotency_keys')
      .select('response_body')
      .where('tenant_id', '=', shop.tenant.id)
      .where('key', '=', key)
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(stored.response_body)).not.toContain(firstBody.temporary_password!)
    expectError(
      await invite({ ...payload, full_name: 'Different' }, { headers: { 'idempotency-key': key } }),
      409,
      'IDEMPOTENCY_MISMATCH',
    )
  })

  it('validates the role, the stores and the PIN', async () => {
    const phone = randomPhone()
    const unknownRole = expectError(
      await invite({ phone, full_name: 'X', role_id: newId() }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(unknownRole.details)).toContain('role_unknown')
    // Another business's role is unknown here (tenant isolation).
    expectError(
      await invite({ phone, full_name: 'X', role_id: other.roles.cashier }),
      400,
      'VALIDATION_ERROR',
    )
    const badStore = expectError(
      await invite({
        phone,
        full_name: 'X',
        role_id: shop.roles.cashier,
        store_ids: [other.store.id],
      }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(badStore.details)).toContain('store_unknown')
    const weak = expectError(
      await invite({ phone, full_name: 'X', role_id: shop.roles.cashier, pin: '1234' }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(weak.details)).toContain('pin_weak')
    expectError(
      await invite({ phone: '12345', full_name: 'X', role_id: shop.roles.cashier }),
      400,
      'VALIDATION_ERROR',
    )
    // Nothing was created for the failed attempts.
    const ghost = await t.deps.db.systemDb
      .selectFrom('users')
      .select('id')
      .where('phone', '=', phone)
      .executeTakeFirst()
    expect(ghost).toBeUndefined()
  })

  it('enforces the users limit of the free plan', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    expectStatus(
      await invite(
        { phone: randomPhone(), full_name: 'Second', role_id: free.roles.cashier },
        { on: free },
      ),
      201,
    )
    const err = expectError(
      await invite(
        { phone: randomPhone(), full_name: 'Third', role_id: free.roles.cashier },
        { on: free },
      ),
      402,
      'PLAN_LIMIT_REACHED',
    )
    expect(err.details).toMatchObject({ metric: 'users', limit: 2 })
  })

  it('refuses members without users.manage', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/users'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await invite(
        { phone: randomPhone(), full_name: 'X', role_id: shop.roles.cashier },
        { as: cashier },
      ),
      403,
      'FORBIDDEN',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${shop.owner.user.id}/disable`),
        payload: {},
        as: cashier,
      }),
      403,
      'FORBIDDEN',
    )
  })

  it('stops non-owners from granting the owner role, managing owners or escalating', async () => {
    const manager = await shop.asRole('manager')
    expectError(
      await invite(
        { phone: randomPhone(), full_name: 'Co-owner', role_id: shop.roles.owner },
        { as: manager },
      ),
      403,
      'FORBIDDEN',
      'owner_only',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${shop.owner.user.id}/disable`),
        payload: {},
        as: manager,
      }),
      403,
      'FORBIDDEN',
      'owner_only',
    )
    // A custom role holding billing.manage (which managers lack) cannot be handed out by them.
    const billing = await shop.asRole('billing_admin', { permissions: ['billing.manage'] })
    const escalated = expectError(
      await invite(
        { phone: randomPhone(), full_name: 'Escalate', role_id: billing.membership.role_id },
        { as: manager },
      ),
      403,
      'FORBIDDEN',
      'role_exceeds_own_permissions',
    )
    expect(escalated.details?.missing).toEqual(['billing.manage'])
    // Managers can invite cashiers.
    expectStatus(
      await invite(
        { phone: randomPhone(), full_name: 'Cashier', role_id: shop.roles.cashier },
        { as: manager },
      ),
      201,
    )
  })

  it('never lets you disable or re-role yourself, and keeps an active owner', async () => {
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${shop.owner.user.id}/disable`),
        payload: {},
      }),
      409,
      'CONFLICT',
      'self_action',
    )
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/users/${shop.owner.user.id}`),
        payload: { role_id: shop.roles.manager },
      }),
      409,
      'CONFLICT',
      'self_action',
    )
    // The guard behind both: the only active owner cannot be disabled or demoted (system actor).
    const solo = await createTestTenant(t)
    const sys = systemContext(solo.tenant.id)
    await expect(
      solo.tx((tx) => disableMember(t.deps, tx, sys, solo.owner.user.id, { reason: null })),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'last_owner' } })
    await expect(
      solo.tx((tx) =>
        updateMember(t.deps, tx, sys, solo.owner.user.id, {
          role_id: solo.roles.manager,
          email: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'last_owner' } })
    // With a second active owner the first one can be demoted.
    const coOwner = await solo.asRole('owner')
    await solo.tx(async (tx) => {
      await tx
        .updateTable('memberships')
        .set({ status: 'active' })
        .where('tenant_id', '=', solo.tenant.id)
        .where('id', '=', coOwner.membership.id)
        .execute()
    })
    const demoted = expectStatus<Data<Member>>(
      await solo.inject({
        method: 'PATCH',
        url: api(`/users/${solo.owner.user.id}`),
        payload: { role_id: solo.roles.manager },
        as: coOwner,
      }),
      200,
    ).data
    expect(demoted).toMatchObject({ role_code: 'manager', is_owner: false })
  })

  it('changes role and stores; the member’s access is re-resolved right away', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/users'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const before = await getMember(cashier.user.id)
    const updated = expectStatus<Data<Member>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/users/${cashier.user.id}`),
        payload: {
          role_id: shop.roles.manager,
          store_ids: [shop.store.id],
          if_updated_at: before.updated_at,
        },
      }),
      200,
    ).data
    expect(updated).toMatchObject({ role_code: 'manager', store_ids: [shop.store.id] })
    // No 30-second stale cache: the new role applies to the very next request.
    expectStatus(await shop.inject({ method: 'GET', url: api('/users'), as: cashier }), 200)
    const [row] = await auditRows(t, shop, {
      action: 'user.role_change',
      entity_id: cashier.user.id,
    })
    expect(row?.changes).toMatchObject({
      before: { role_code: 'cashier', store_ids: null },
      after: { role_code: 'manager', store_ids: [shop.store.id] },
    })
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/users/${cashier.user.id}`),
        payload: { store_ids: null, if_updated_at: before.updated_at },
      }),
      409,
      'STALE_WRITE',
    )
    expectError(
      await shop.inject({ method: 'PATCH', url: api(`/users/${cashier.user.id}`), payload: {} }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/users/${cashier.user.id}`),
        payload: { store_ids: [] },
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('edits name / email only of identities that belong to this business alone', async () => {
    const mail = `new.${newId().slice(-12)}@example.com`
    const own = expectStatus<Data<MemberCreateResult>>(
      await invite({ phone: randomPhone(), full_name: 'Old Name', role_id: shop.roles.cashier }),
      201,
    ).data.member
    const renamed = expectStatus<Data<Member>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/users/${own.id}`),
        payload: { full_name: 'புதிய பெயர்', email: mail.toUpperCase(), preferred_locale: 'en' },
      }),
      200,
    ).data
    expect(renamed).toMatchObject({
      full_name: 'புதிய பெயர்',
      email: mail,
      preferred_locale: 'en',
    })
    // The other business's owner (also a member here, see above) owns their identity.
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/users/${other.owner.user.id}`),
        payload: { full_name: 'Hijack' },
      }),
      409,
      'CONFLICT',
      'shared_identity',
    )
    const second = expectStatus<Data<MemberCreateResult>>(
      await invite({ phone: randomPhone(), full_name: 'Second', role_id: shop.roles.cashier }),
      201,
    ).data.member
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/users/${second.id}`),
        payload: { email: mail },
      }),
      409,
      'CONFLICT',
      'email_taken',
    )
    expectError(
      await invite({
        phone: randomPhone(),
        full_name: 'Third',
        email: mail.toUpperCase(),
        role_id: shop.roles.cashier,
      }),
      409,
      'CONFLICT',
      'email_taken',
    )
  })

  it('disables a member — sessions revoked, access refused — and enables again', async () => {
    const cashier = await shop.asRole('cashier')
    expect((await liveSessions(t, cashier.user.id, shop.tenant.id)).length).toBeGreaterThan(0)
    const disabled = expectStatus<Data<Member>>(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${cashier.user.id}/disable`),
        payload: { reason: 'Left the shop' },
      }),
      200,
    ).data
    expect(disabled.status).toBe('disabled')
    expect(await liveSessions(t, cashier.user.id, shop.tenant.id)).toEqual([])
    const me = await shop.inject({ method: 'GET', url: api('/me'), as: cashier })
    expect(me.statusCode).toBe(401)
    const [row] = await auditRows(t, shop, { action: 'user.disable', entity_id: cashier.user.id })
    expect(row?.summary).toContain('Left the shop')
    // Disabling twice is a no-op.
    expectStatus(
      await shop.inject({ method: 'POST', url: api(`/users/${cashier.user.id}/disable`) }),
      200,
    )

    const enabled = expectStatus<Data<Member>>(
      await shop.inject({ method: 'POST', url: api(`/users/${cashier.user.id}/enable`) }),
      200,
    ).data
    // The status before disabling comes back.
    expect(enabled.status).toBe('active')

    const pending = expectStatus<Data<MemberCreateResult>>(
      await invite({
        phone: randomPhone(),
        full_name: 'Not yet joined',
        role_id: shop.roles.cashier,
      }),
      201,
    ).data.member
    expectStatus(
      await shop.inject({ method: 'POST', url: api(`/users/${pending.id}/disable`), payload: {} }),
      200,
    )
    const reinvited = expectStatus<Data<Member>>(
      await shop.inject({ method: 'POST', url: api(`/users/${pending.id}/enable`) }),
      200,
    ).data
    expect(reinvited.status).toBe('invited')
  })

  it('counts enabling against the users limit', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const first = expectStatus<Data<MemberCreateResult>>(
      await invite(
        { phone: randomPhone(), full_name: 'A', role_id: free.roles.cashier },
        { on: free },
      ),
      201,
    ).data.member
    expectStatus(
      await free.inject({ method: 'POST', url: api(`/users/${first.id}/disable`), payload: {} }),
      200,
    )
    expectStatus(
      await invite(
        { phone: randomPhone(), full_name: 'B', role_id: free.roles.cashier },
        { on: free },
      ),
      201,
    )
    expectError(
      await free.inject({ method: 'POST', url: api(`/users/${first.id}/enable`) }),
      402,
      'PLAN_LIMIT_REACHED',
    )
  })

  it('resets the POS PIN and clears a PIN lock', async () => {
    const cashier = await shop.asRole('cashier', { pin: '2580' })
    await t.deps.db.systemDb
      .updateTable('memberships')
      .set({ pin_failed_count: 4, pin_locked_until: new Date(Date.now() + 10 * 60_000) })
      .where('id', '=', cashier.membership.id)
      .execute()
    expect((await getMember(cashier.user.id)).pin_locked_until).not.toBeNull()
    const reset = expectStatus<Data<Member>>(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${cashier.user.id}/reset-pin`),
        payload: { pin: '7391' },
      }),
      200,
    ).data
    expect(reset).toMatchObject({ has_pin: true, pin_locked_until: null })
    const row = await t.deps.db.systemDb
      .selectFrom('memberships')
      .select(['pin_failed_count', 'pin_locked_until', 'pos_pin_hash'])
      .where('id', '=', cashier.membership.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ pin_failed_count: 0, pin_locked_until: null })
    expect(row.pos_pin_hash).toMatch(/^\$argon2id\$/)
    const [audited] = await auditRows(t, shop, {
      action: 'user.pin_reset',
      entity_id: cashier.user.id,
    })
    expect(JSON.stringify(audited?.changes)).not.toContain('7391')

    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${cashier.user.id}/reset-pin`),
        payload: { pin: '1111' },
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${cashier.user.id}/reset-pin`),
        payload: { pin: '12' },
      }),
      400,
      'VALIDATION_ERROR',
    )
    const removed = expectStatus<Data<Member>>(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${cashier.user.id}/reset-pin`),
        payload: { pin: null },
      }),
      200,
    ).data
    expect(removed.has_pin).toBe(false)
  })

  it('admin password reset signs the member out; not for yourself or shared identities', async () => {
    const created = expectStatus<Data<MemberCreateResult>>(
      await invite({ phone: randomPhone(), full_name: 'Reset Me', role_id: shop.roles.cashier }),
      201,
    ).data
    const phone = created.member.phone!
    expectStatus(await login(phone, created.temporary_password!), 200)
    expect((await liveSessions(t, created.member.id)).length).toBeGreaterThan(0)
    const reset = expectStatus<Data<ResetPasswordResult>>(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${created.member.id}/reset-password`),
      }),
      200,
    ).data
    expect(reset.temporary_password).toMatch(TEMPORARY_PASSWORD_RE)
    expect(reset.sessions_revoked).toBeGreaterThan(0)
    expect(await liveSessions(t, created.member.id)).toEqual([])
    expectStatus(await login(phone, created.temporary_password!), 401)
    expectStatus(await login(phone, reset.temporary_password!), 200)

    const chosen = expectStatus<Data<ResetPasswordResult>>(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${created.member.id}/reset-password`),
        payload: { password: 'Brand-New-Pass#9' },
      }),
      200,
    ).data
    expect(chosen.temporary_password).toBeNull()
    expectStatus(await login(phone, 'Brand-New-Pass#9'), 200)

    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${shop.owner.user.id}/reset-password`),
        payload: {},
      }),
      409,
      'CONFLICT',
      'self_action',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/users/${other.owner.user.id}/reset-password`),
        payload: {},
      }),
      409,
      'CONFLICT',
      'shared_identity',
    )
  })

  it('serves the member directory to every member without contact fields', async () => {
    const cashier = await shop.asRole('cashier')
    const dir = expectStatus<Data<UserDirectoryEntry[]>>(
      await shop.inject({ method: 'GET', url: api('/users/directory'), as: cashier }),
      200,
    ).data
    const me = dir.find((e) => e.id === cashier.user.id)!
    expect(me).toEqual({
      id: cashier.user.id,
      full_name: cashier.user.full_name,
      role_code: 'cashier',
      role_name: 'Cashier',
      role_name_ta: 'காசாளர்',
      status: 'active',
      store_ids: null,
    })
    expect(dir.every((e) => !('phone' in e))).toBe(true)
  })

  it('keeps businesses apart', async () => {
    expectError(
      await shop.inject({ method: 'GET', url: api(`/users/${newId()}`) }),
      404,
      'NOT_FOUND',
    )
    const onlyHere = expectStatus<Data<MemberCreateResult>>(
      await invite({ phone: randomPhone(), full_name: 'Only Here', role_id: shop.roles.cashier }),
      201,
    ).data.member
    expectError(
      await other.inject({ method: 'GET', url: api(`/users/${onlyHere.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'POST',
        url: api(`/users/${onlyHere.id}/disable`),
        payload: {},
      }),
      404,
      'NOT_FOUND',
    )
    const list = expectStatus<List<Member>>(
      await other.inject({ method: 'GET', url: api('/users?limit=200') }),
      200,
    )
    expect(list.data.some((m) => m.id === onlyHere.id)).toBe(false)
  })

  it('limits store-scoped admins to the members of their stores', async () => {
    const branch = await createTestTenant(t)
    const store2 = expectStatus<Data<{ id: string }>>(
      await branch.inject({
        method: 'POST',
        url: api('/stores'),
        payload: { code: 'S2', name: 'Branch 2', state_code: '33' },
      }),
      201,
    ).data
    const scoped = await branch.asRole('branch_admin', {
      permissions: ['users.manage'],
      store_ids: [store2.id],
    })
    const everywhere = await branch.asRole('cashier')
    const onlyS1 = await branch.asRole('cashier', { store_ids: [branch.store.id] })
    const list = expectStatus<List<Member>>(
      await branch.inject({ method: 'GET', url: api('/users'), as: scoped }),
      200,
    )
    const ids = list.data.map((m) => m.id)
    expect(ids).toContain(everywhere.user.id)
    expect(ids).not.toContain(onlyS1.user.id)

    const ownRole = scoped.membership.role_id
    expectError(
      await invite(
        { phone: randomPhone(), full_name: 'All stores', role_id: ownRole, store_ids: null },
        { as: scoped, on: branch },
      ),
      403,
      'FORBIDDEN',
      'store_scope',
    )
    const inScope = expectStatus<Data<MemberCreateResult>>(
      await invite(
        {
          phone: randomPhone(),
          full_name: 'Branch staff',
          role_id: ownRole,
          store_ids: [store2.id],
        },
        { as: scoped, on: branch },
      ),
      201,
    ).data.member
    expectStatus(
      await branch.inject({
        method: 'POST',
        url: api(`/users/${inScope.id}/disable`),
        payload: {},
        as: scoped,
      }),
      200,
    )
    expectError(
      await branch.inject({
        method: 'POST',
        url: api(`/users/${everywhere.user.id}/disable`),
        payload: {},
        as: scoped,
      }),
      403,
      'FORBIDDEN',
      'store_scope',
    )
  })
})
