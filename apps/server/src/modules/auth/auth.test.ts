import type { LightMyRequestResponse } from 'fastify'
import { decodeJwt } from 'jose'
import { newId } from '@kadai/shared'
import type { MeResponse, SessionResponse } from '@kadai/shared/api/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateDeviceSecret } from '../../core/tokens'
import { type TestApp, bearer, buildTestApp, randomPhone } from '../../test/helpers'
import { type TestShop, TEST_PASSWORD, createTestTenant } from '../../test/tenants'

const PASSWORD = 'Selvi-Stores#2026'
const CSRF = { 'x-requested-with': 'kadai' }

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

let ipCounter = 0
/** Unique client IP per call so route rate limits (per IP) never interfere between tests. */
const nextIp = (): string => {
  ipCounter += 1
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

const local10 = (e164: string): string => e164.slice(3)
const session = (res: LightMyRequestResponse): SessionResponse =>
  res.json<{ data: SessionResponse }>().data
const errorOf = (res: LightMyRequestResponse) => res.json<ErrorJson>().error
const refreshCookie = (res: LightMyRequestResponse) =>
  res.cookies.find((c) => c.name === 'kadai_rt')

describe('auth module (cloud)', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(() => t.close())

  const post = (
    url: string,
    payload: unknown,
    opts: { headers?: Record<string, string>; cookies?: Record<string, string> } = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      payload: payload as object,
      remoteAddress: nextIp(),
      ...opts,
    })
  const get = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: nextIp() })

  function signupBody(overrides: Record<string, unknown> = {}) {
    return {
      business_name: `Selvi Stores ${newId().slice(-6)}`,
      business_name_ta: 'செல்வி ஸ்டோர்ஸ்',
      business_type: 'general_store',
      owner_name: 'Selvi',
      phone: local10(randomPhone()),
      password: PASSWORD,
      state_code: '33',
      locale: 'ta',
      ...overrides,
    }
  }

  it('signup → /me → login → refresh rotation → reuse detection → logout', async () => {
    const email = `selvi.${newId().slice(-6)}@example.in`
    const body = signupBody({ email })
    const signup = await post('/auth/signup', body)
    expect(signup.statusCode).toBe(201)
    const s1 = session(signup)
    expect(s1).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      tenant_id: expect.any(String),
    })
    expect(s1.refresh_token).toBeUndefined()
    expect(s1.user).toMatchObject({
      full_name: 'Selvi',
      phone: `+91${body.phone}`,
      preferred_locale: 'ta',
    })
    expect(s1.memberships).toEqual([
      {
        tenant_id: s1.tenant_id,
        tenant_name: body.business_name,
        business_type: 'general_store',
        role_code: 'owner',
      },
    ])
    const cookie = refreshCookie(signup)
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' })
    expect(cookie?.secure).toBeFalsy() // PUBLIC_BASE_URL is http in tests
    expect(decodeJwt(s1.access_token)).toMatchObject({ tid: s1.tenant_id, amr: ['password'] })

    const me = await get('/me', bearer(s1.access_token))
    expect(me.statusCode).toBe(200)
    const profile = me.json<{ data: MeResponse }>().data
    expect(profile.tenant).toMatchObject({
      id: s1.tenant_id,
      name: body.business_name,
      name_ta: 'செல்வி ஸ்டோர்ஸ்',
      business_type: 'general_store',
      gst_scheme: 'unregistered',
      status: 'active',
    })
    expect(profile.membership.role_code).toBe('owner')
    expect(profile.membership.permissions).toEqual(
      expect.arrayContaining(['billing.manage', 'sales.create']),
    )
    expect(profile.membership.store_ids).toBeNull()
    expect(profile.entitlements).toMatchObject({ plan_code: 'growth', source: 'plan' })
    expect(profile.entitlements.valid_until).toEqual(expect.any(String))
    expect(profile.settings.inventory.allow_negative_stock).toBe(true)
    expect(profile.stores.map((s) => s.code)).toEqual(['S1'])
    expect(profile.registers.map((r) => r.code)).toEqual(['A'])
    expect(profile).toMatchObject({ mode: 'cloud', device: null })

    const login = await post('/auth/login', { identifier: body.phone, password: PASSWORD })
    expect(login.statusCode).toBe(200)
    expect(session(login).tenant_id).toBe(s1.tenant_id)
    const byEmail = await post('/auth/login', {
      identifier: email.toUpperCase(),
      password: PASSWORD,
    })
    expect(byEmail.statusCode).toBe(200)

    const rt1 = refreshCookie(login)!.value
    const noCsrf = await post('/auth/refresh', {}, { cookies: { kadai_rt: rt1 } })
    expect(noCsrf.statusCode).toBe(403)
    expect(errorOf(noCsrf).details).toMatchObject({ reason: 'csrf' })

    const r1 = await post('/auth/refresh', {}, { cookies: { kadai_rt: rt1 }, headers: CSRF })
    expect(r1.statusCode).toBe(200)
    const rt2 = refreshCookie(r1)!.value
    expect(rt2).not.toBe(rt1)
    const refreshed = session(r1)
    expect(refreshed.tenant_id).toBe(s1.tenant_id)
    expect((await get('/me', bearer(refreshed.access_token))).statusCode).toBe(200)

    // Presenting the rotated token again = theft: the whole family dies.
    const reuse = await post('/auth/refresh', {}, { cookies: { kadai_rt: rt1 }, headers: CSRF })
    expect(reuse.statusCode).toBe(401)
    expect(errorOf(reuse).code).toBe('SESSION_REVOKED')
    expect(refreshCookie(reuse)?.value).toBe('') // cleared
    const after = await post('/auth/refresh', {}, { cookies: { kadai_rt: rt2 }, headers: CSRF })
    expect(after.statusCode).toBe(401)
    expect((await get('/me', bearer(refreshed.access_token))).statusCode).toBe(401)
    // The signup session (another family) is unaffected.
    expect((await get('/me', bearer(s1.access_token))).statusCode).toBe(200)

    // Logout ends the login; its refresh token and access token stop working.
    const l2 = await post('/auth/login', { identifier: body.phone, password: PASSWORD })
    const l2s = session(l2)
    const out = await post('/auth/logout', {}, { headers: bearer(l2s.access_token) })
    expect(out.statusCode).toBe(204)
    expect(refreshCookie(out)?.value).toBe('')
    expect((await get('/me', bearer(l2s.access_token))).statusCode).toBe(401)
    const dead = await post(
      '/auth/refresh',
      {},
      { cookies: { kadai_rt: refreshCookie(l2)!.value }, headers: CSRF },
    )
    expect(dead.statusCode).toBe(401)

    // Logout everywhere, authenticated only by the refresh cookie (expired access token).
    const l3 = await post('/auth/login', { identifier: body.phone, password: PASSWORD })
    const all = await post(
      '/auth/logout',
      { all: true },
      { cookies: { kadai_rt: refreshCookie(l3)!.value }, headers: CSRF },
    )
    expect(all.statusCode).toBe(204)
    expect((await get('/me', bearer(s1.access_token))).statusCode).toBe(401)
  })

  it('delivers refresh tokens in the body for non-browser clients', async () => {
    const body = signupBody()
    await post('/auth/signup', body)
    const login = await post(
      '/auth/login',
      { identifier: `+91 ${body.phone}`, password: PASSWORD },
      { headers: { 'x-kadai-token-delivery': 'body' } },
    )
    expect(login.statusCode).toBe(200)
    expect(refreshCookie(login)).toBeUndefined()
    const rt = session(login).refresh_token!
    expect(rt).toEqual(expect.any(String))
    const r = await post('/auth/refresh', { refresh_token: rt })
    expect(r.statusCode).toBe(200)
    expect(refreshCookie(r)).toBeUndefined()
    const next = session(r).refresh_token
    expect(next).toEqual(expect.any(String))
    expect(next).not.toBe(rt)
    expect((await post('/auth/refresh', { refresh_token: rt })).statusCode).toBe(401)
    expect((await post('/auth/refresh', {})).statusCode).toBe(401)
  })

  it('lets a user with several businesses select one', async () => {
    const phone = local10(randomPhone())
    const first = session(
      await post(
        '/auth/signup',
        signupBody({ phone, business_name: `First ${newId().slice(-5)}` }),
      ),
    )
    const second = session(
      await post(
        '/auth/signup',
        signupBody({
          phone,
          business_name: `Second ${newId().slice(-5)}`,
          business_type: 'pharmacy',
        }),
      ),
    )
    expect(second.tenant_id).not.toBe(first.tenant_id)

    const login = await post('/auth/login', { identifier: phone, password: PASSWORD })
    const s = session(login)
    expect(s.tenant_id).toBeNull()
    expect(s.memberships.map((m) => m.tenant_id).sort()).toEqual(
      [first.tenant_id, second.tenant_id].sort(),
    )
    const me = await get('/me', bearer(s.access_token))
    expect(me.statusCode).toBe(403)
    expect(errorOf(me).details).toMatchObject({ reason: 'tenant_selection_required' })

    const sel = await post(
      '/auth/select-tenant',
      { tenant_id: second.tenant_id },
      { headers: bearer(s.access_token) },
    )
    expect(sel.statusCode).toBe(200)
    const scoped = session(sel)
    expect(scoped.tenant_id).toBe(second.tenant_id)
    const profile = (await get('/me', bearer(scoped.access_token))).json<{ data: MeResponse }>()
      .data
    expect(profile.tenant.business_type).toBe('pharmacy')
    expect(profile.settings.inventory.allow_negative_stock).toBe(false)

    // Switching rotates the login: the old refresh cookie is now a reused token.
    const old = await post(
      '/auth/refresh',
      {},
      { cookies: { kadai_rt: refreshCookie(login)!.value }, headers: CSRF },
    )
    expect(old.statusCode).toBe(401)

    const outsider = await createTestTenant(t)
    const login2 = session(await post('/auth/login', { identifier: phone, password: PASSWORD }))
    const denied = await post(
      '/auth/select-tenant',
      { tenant_id: outsider.tenant.id },
      { headers: bearer(login2.access_token) },
    )
    expect(denied.statusCode).toBe(403)
  })

  it('signs in with an OTP and refuses wrong codes', async () => {
    const body = signupBody()
    await post('/auth/signup', body)
    const phone = `+91${body.phone}`
    const req = await post('/auth/otp/request', { phone: body.phone, purpose: 'login' })
    expect(req.statusCode).toBe(200)
    expect(req.json()).toEqual({ data: { expires_in: 300, resend_after: 30 } })
    const code = t.otp.lastCode(phone, 'login')!
    expect(code).toMatch(/^\d{6}$/)
    const wrong = await post('/auth/otp/verify', {
      phone: body.phone,
      code: code === '000000' ? '111111' : '000000',
      purpose: 'login',
    })
    expect(wrong.statusCode).toBe(400)
    expect(errorOf(wrong)).toMatchObject({ code: 'OTP_INVALID', details: { attempts_left: 4 } })
    const ok = await post('/auth/otp/verify', { phone: body.phone, code, purpose: 'login' })
    expect(ok.statusCode).toBe(200)
    const s = session(ok)
    expect(decodeJwt(s.access_token).amr).toEqual(['otp'])
    expect(s.tenant_id).toEqual(expect.any(String))
    // The code is single use.
    expect(
      (await post('/auth/otp/verify', { phone: body.phone, code, purpose: 'login' })).statusCode,
    ).toBe(400)

    // Unknown numbers get the same answer but no SMS.
    const unknown = randomPhone()
    const fake = await post('/auth/otp/request', { phone: unknown, purpose: 'login' })
    expect(fake.json()).toEqual({ data: { expires_in: 300, resend_after: 30 } })
    expect(t.otp.lastCode(unknown)).toBeNull()
    expect(
      (await post('/auth/otp/request', { phone: unknown, purpose: 'verify_phone' })).statusCode,
    ).toBe(400)
  })

  it('rate-limits OTP requests per IP (3 per 10 minutes)', async () => {
    const ip = nextIp()
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/request',
        payload: { phone: randomPhone(), purpose: 'signup' },
        remoteAddress: ip,
      })
      statuses.push(res.statusCode)
    }
    expect(statuses).toEqual([200, 200, 200, 429])
  })

  it('locks the account for 15 minutes after 5 wrong passwords and audits the attempts', async () => {
    const body = signupBody()
    const tenantId = session(await post('/auth/signup', body)).tenant_id!
    for (let i = 1; i <= 4; i++) {
      const res = await post('/auth/login', { identifier: body.phone, password: `Wrong-Pass-${i}` })
      expect(res.statusCode).toBe(401)
      expect(errorOf(res).code).toBe('INVALID_CREDENTIALS')
    }
    const fifth = await post('/auth/login', { identifier: body.phone, password: 'Wrong-Pass-5' })
    expect(fifth.statusCode).toBe(423)
    expect(errorOf(fifth)).toMatchObject({ code: 'ACCOUNT_LOCKED' })
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(14 * 60)
    const right = await post('/auth/login', { identifier: body.phone, password: PASSWORD })
    expect(right.statusCode).toBe(423)
    const failures = await t.deps.db.systemDb
      .selectFrom('audit_logs')
      .select('action')
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'auth.login_failed')
      .execute()
    expect(failures).toHaveLength(5)
    // Lock expired → the right password works again and resets the counter.
    await t.deps.db.systemDb
      .updateTable('users')
      .set({ locked_until: new Date(Date.now() - 1000) })
      .where('phone', '=', `+91${body.phone}`)
      .execute()
    expect(
      (await post('/auth/login', { identifier: body.phone, password: PASSWORD })).statusCode,
    ).toBe(200)
    const user = await t.deps.db.systemDb
      .selectFrom('users')
      .select(['failed_login_count', 'locked_until', 'last_login_at'])
      .where('phone', '=', `+91${body.phone}`)
      .executeTakeFirstOrThrow()
    expect(user).toMatchObject({ failed_login_count: 0, locked_until: null })
    expect(user.last_login_at).toBeInstanceOf(Date)
    // Unknown identifiers look exactly like wrong passwords.
    const nobody = await post('/auth/login', {
      identifier: local10(randomPhone()),
      password: PASSWORD,
    })
    expect(errorOf(nobody).code).toBe('INVALID_CREDENTIALS')
  })

  it('changing the password keeps this login and signs out every other session', async () => {
    const body = signupBody()
    await post('/auth/signup', body)
    const a = session(await post('/auth/login', { identifier: body.phone, password: PASSWORD }))
    const bLogin = await post('/auth/login', { identifier: body.phone, password: PASSWORD })
    const b = session(bLogin)
    const wrong = await post(
      '/auth/password/change',
      { current_password: 'Not-My-Password#1', new_password: 'Brand-New-Pass#77' },
      { headers: bearer(a.access_token) },
    )
    expect(wrong.statusCode).toBe(400)
    expect(errorOf(wrong).code).toBe('VALIDATION_ERROR')
    const weak = await post(
      '/auth/password/change',
      { current_password: PASSWORD, new_password: `pass${body.phone}` },
      { headers: bearer(a.access_token) },
    )
    expect(weak.statusCode).toBe(400)
    const ok = await post(
      '/auth/password/change',
      { current_password: PASSWORD, new_password: 'Brand-New-Pass#77' },
      { headers: bearer(a.access_token) },
    )
    expect(ok.statusCode).toBe(204)
    expect((await get('/me', bearer(a.access_token))).statusCode).toBe(200)
    expect((await get('/me', bearer(b.access_token))).statusCode).toBe(401)
    expect(
      (
        await post(
          '/auth/refresh',
          {},
          { cookies: { kadai_rt: refreshCookie(bLogin)!.value }, headers: CSRF },
        )
      ).statusCode,
    ).toBe(401)
    expect(
      (await post('/auth/login', { identifier: body.phone, password: PASSWORD })).statusCode,
    ).toBe(401)
    expect(
      (await post('/auth/login', { identifier: body.phone, password: 'Brand-New-Pass#77' }))
        .statusCode,
    ).toBe(200)
  })

  it('resets a forgotten password by OTP (single-use token, all sessions revoked)', async () => {
    const body = signupBody()
    const s = session(await post('/auth/signup', body))
    const phone = `+91${body.phone}`
    await post('/auth/otp/request', { phone: body.phone, purpose: 'reset_password' })
    const verify = await post('/auth/otp/verify', {
      phone: body.phone,
      code: t.otp.lastCode(phone, 'reset_password'),
      purpose: 'reset_password',
    })
    expect(verify.statusCode).toBe(200)
    const { otp_token } = verify.json<{ data: { otp_token: string; expires_in: number } }>().data
    expect(otp_token).toEqual(expect.any(String))
    // An otp_token of another purpose is refused.
    expect(
      (
        await post('/auth/password/reset', {
          otp_token: s.access_token,
          new_password: 'Reset-Pass#2026',
        })
      ).statusCode,
    ).toBe(400)
    const reset = await post('/auth/password/reset', { otp_token, new_password: 'Reset-Pass#2026' })
    expect(reset.statusCode).toBe(204)
    expect((await get('/me', bearer(s.access_token))).statusCode).toBe(401)
    expect(
      (await post('/auth/login', { identifier: body.phone, password: 'Reset-Pass#2026' }))
        .statusCode,
    ).toBe(200)
    const replay = await post('/auth/password/reset', {
      otp_token,
      new_password: 'Another-Pass#2026',
    })
    expect(replay.statusCode).toBe(400)
    expect(errorOf(replay).code).toBe('OTP_EXPIRED')
  })

  it('verifies the phone for signup with an OTP token and protects registered numbers', async () => {
    const body = signupBody()
    await post('/auth/otp/request', { phone: body.phone, purpose: 'signup' })
    const verify = await post('/auth/otp/verify', {
      phone: body.phone,
      code: t.otp.lastCode(`+91${body.phone}`, 'signup'),
      purpose: 'signup',
    })
    const { otp_token } = verify.json<{ data: { otp_token: string } }>().data
    const mismatch = await post('/auth/signup', { ...signupBody(), otp_token })
    expect(errorOf(mismatch).code).toBe('OTP_EXPIRED')
    const ok = await post('/auth/signup', { ...body, otp_token })
    expect(ok.statusCode).toBe(201)
    expect(decodeJwt(session(ok).access_token).amr).toEqual(['password', 'otp'])
    const taken = await post(
      '/auth/signup',
      signupBody({ phone: body.phone, password: 'Other-Pass#999' }),
    )
    expect(taken.statusCode).toBe(409)
    expect(errorOf(taken)).toMatchObject({ code: 'DUPLICATE', details: { field: 'phone' } })
    const invalid = await post('/auth/signup', signupBody({ gstin: '29ABCDE1234F1Z5' }))
    expect(invalid.statusCode).toBe(400)
  })

  it('requires phone verification for signup when a real SMS provider is configured', async () => {
    const sms = await buildTestApp({
      env: { SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'test-key', MSG91_OTP_TEMPLATE_ID: 'tpl' },
    })
    try {
      const res = await sms.app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: signupBody(),
        remoteAddress: nextIp(),
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.stringify(errorOf(res).details)).toContain('otp_token')
    } finally {
      await sms.close()
    }
  })

  it('accepts a pending invitation on first sign-in', async () => {
    const shop = await createTestTenant(t)
    const invited = await shop.asRole('cashier')
    await t.deps.db.systemDb
      .updateTable('memberships')
      .set({ status: 'invited' })
      .where('id', '=', invited.membership.id)
      .execute()
    const login = await post('/auth/login', {
      identifier: invited.user.phone,
      password: TEST_PASSWORD,
    })
    expect(login.statusCode).toBe(200)
    const s = session(login)
    expect(s.tenant_id).toBe(shop.tenant.id)
    const me = await get('/me', bearer(s.access_token))
    expect(me.statusCode).toBe(200)
    expect(me.json<{ data: MeResponse }>().data.membership.role_code).toBe('cashier')
  })

  describe('trusted devices and PIN login', () => {
    let shop: TestShop
    let device: { id: string; secret: string }

    beforeAll(async () => {
      shop = await createTestTenant(t)
      const { secret, hash } = generateDeviceSecret()
      device = { id: newId(), secret }
      await t.deps.db.systemDb
        .insertInto('devices')
        .values({
          id: device.id,
          tenant_id: shop.tenant.id,
          store_id: shop.store.id,
          register_id: shop.register.id,
          name: 'Counter A PC',
          device_secret_hash: hash,
        })
        .execute()
    })

    it('lists PIN users and signs a cashier in bound to the device and register', async () => {
      const cashier = await shop.asRole('cashier', { pin: '2580' })
      await shop.asRole('cashier') // no PIN: not listed
      const otherStore = await shop.asRole('cashier', { pin: '1357', store_ids: [newId()] }) // other store: not listed
      const users = await get(
        `/auth/pin-users?device_id=${device.id}&device_secret=${device.secret}`,
      )
      expect(users.statusCode).toBe(200)
      const listed = users.json<{ data: Array<{ user_id: string; role_code: string }> }>().data
      expect(listed).toEqual([
        {
          user_id: cashier.user.id,
          full_name: cashier.user.full_name,
          role_code: 'cashier',
          role_name: 'Cashier',
        },
      ])
      expect(listed.some((u) => u.user_id === otherStore.user.id)).toBe(false)

      const login = await post('/auth/pin-login', {
        device_id: device.id,
        device_secret: device.secret,
        user_id: cashier.user.id,
        pin: '2580',
      })
      expect(login.statusCode).toBe(200)
      const s = session(login)
      expect(decodeJwt(s.access_token)).toMatchObject({
        did: device.id,
        amr: ['pin'],
        tid: shop.tenant.id,
      })
      const me = (await get('/me', bearer(s.access_token))).json<{ data: MeResponse }>().data
      expect(me.device).toEqual({
        id: device.id,
        store_id: shop.store.id,
        register_id: shop.register.id,
      })
      expect(me.membership.permissions).toContain('pos.use')
      expect(me.membership.permissions).not.toContain('settings.manage')

      const bad = await post('/auth/pin-login', {
        device_id: device.id,
        device_secret: generateDeviceSecret().secret,
        user_id: cashier.user.id,
        pin: '2580',
      })
      expect(bad.statusCode).toBe(403)
      expect(errorOf(bad).code).toBe('DEVICE_NOT_TRUSTED')
    })

    it('locks the PIN after 5 wrong attempts', async () => {
      const cashier = await shop.asRole('cashier', { pin: '4826' })
      const attempt = (pin: string) =>
        post('/auth/pin-login', {
          device_id: device.id,
          device_secret: device.secret,
          user_id: cashier.user.id,
          pin,
        })
      for (let i = 0; i < 4; i++) expect((await attempt('9999')).statusCode).toBe(401)
      const fifth = await attempt('9999')
      expect(fifth.statusCode).toBe(423)
      expect(errorOf(fifth).code).toBe('PIN_LOCKED')
      expect((await attempt('4826')).statusCode).toBe(423)
      const audits = await t.deps.db.systemDb
        .selectFrom('audit_logs')
        .select('action')
        .where('tenant_id', '=', shop.tenant.id)
        .where('user_id', '=', cashier.user.id)
        .where('action', '=', 'auth.pin_login_failed')
        .execute()
      expect(audits).toHaveLength(5)
    })

    it('ends device sessions when the device is revoked', async () => {
      const cashier = await shop.asRole('cashier', { pin: '3691' })
      const login = await post(
        '/auth/pin-login',
        {
          device_id: device.id,
          device_secret: device.secret,
          user_id: cashier.user.id,
          pin: '3691',
        },
        { headers: { 'x-kadai-token-delivery': 'body' } },
      )
      const s = session(login)
      await t.deps.db.systemDb
        .updateTable('devices')
        .set({ revoked_at: new Date(), is_active: false })
        .where('id', '=', device.id)
        .execute()
      t.deps.rbac.invalidate({ tenantId: shop.tenant.id })
      const r = await post('/auth/refresh', { refresh_token: s.refresh_token })
      expect(r.statusCode).toBe(403)
      expect(errorOf(r).code).toBe('DEVICE_NOT_TRUSTED')
      // The failed refresh revoked the login, so its access token is dead as well.
      expect((await get('/me', bearer(s.access_token))).statusCode).toBe(401)
      const users = await get(
        `/auth/pin-users?device_id=${device.id}&device_secret=${device.secret}`,
      )
      expect(users.statusCode).toBe(403)
    })
  })

  it('hides the on-prem setup routes in cloud mode', async () => {
    expect((await get('/setup/status')).statusCode).toBe(404)
    expect((await post('/setup', signupBody())).statusCode).toBe(404)
  })
})
