import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { notifyAccessChanged } from '../core/rbac'
import { generateApiKey, revokeSession, signAccessToken } from '../core/tokens'
import { fixtureModule } from '../test/fixture-module'
import {
  type TestApp,
  type TestTenant,
  bearer,
  buildTestApp,
  insertTestMember,
  insertTestTenant,
  signTestSession,
  signTestToken,
} from '../test/helpers'

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown>; request_id: string }
}

describe('auth plugin & request context', () => {
  let t: TestApp
  let shop: TestTenant
  let ownerToken: string

  beforeAll(async () => {
    t = await buildTestApp({ modules: [fixtureModule] })
    shop = await insertTestTenant(t.deps.db.systemDb, { plan_code: 'pro' })
    ownerToken = await signTestToken(t.deps, shop.owner)
  })
  afterAll(() => t.close())

  it('rejects tenant routes without credentials (401 UNAUTHENTICATED envelope)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami' })
    expect(res.statusCode).toBe(401)
    const body = res.json<ErrorJson>()
    expect(body.error.code).toBe('UNAUTHENTICATED')
    expect(body.error.request_id).toBe(res.headers['x-request-id'])
  })

  it('rejects malformed / foreign tokens', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer('not.a.jwt') })
    expect(res.statusCode).toBe(401)
    const other = await signAccessToken(
      { auth: { ...t.config.auth, jwtSecret: 'x'.repeat(40) } },
      { userId: shop.owner.user_id, tenantId: shop.tenant.id, membershipId: shop.owner.membership_id, sessionId: newId(), amr: ['password'] },
    )
    const res2 = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(other.token) })
    expect(res2.statusCode).toBe(401)
  })

  it('resolves req.ctx from a valid access token', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: { ...bearer(ownerToken), 'x-locale': 'en' } })
    expect(res.statusCode).toBe(200)
    const { data } = res.json<{ data: Record<string, unknown> }>()
    expect(data).toMatchObject({ tenant_id: shop.tenant.id, user_id: shop.owner.user_id, role_code: 'owner', store_ids: null, locale: 'en' })
    expect(data.permission_count).toBeGreaterThan(30)
  })

  it('enforces permissions (403 FORBIDDEN with required permissions)', async () => {
    const reader = await insertTestMember(t.deps.db.systemDb, shop.tenant.id, { permissions: ['catalog.read'] })
    const token = await signTestToken(t.deps, reader)
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/__test/brands', headers: bearer(token) })
    expect(list.statusCode).toBe(200)
    const create = await t.app.inject({ method: 'POST', url: '/api/v1/__test/brands', headers: bearer(token), payload: { name: 'Aachi' } })
    expect(create.statusCode).toBe(403)
    expect(create.json<ErrorJson>().error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['catalog.write'] } })
  })

  it('expands wildcard and implied permissions', async () => {
    const writer = await insertTestMember(t.deps.db.systemDb, shop.tenant.id, { permissions: ['catalog.*'] })
    const token = await signTestToken(t.deps, writer)
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/__test/brands', headers: bearer(token) })
    expect(list.statusCode).toBe(200)
  })

  it('creates through req.tx (RLS) and paginates with totals', async () => {
    for (const name of ['Sakthi', 'Aachi', 'Everest']) {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/__test/brands', headers: bearer(ownerToken), payload: { name } })
      expect(res.statusCode).toBe(201)
    }
    const page1 = await t.app.inject({ method: 'GET', url: '/api/v1/__test/brands?limit=2&offset=0', headers: bearer(ownerToken) })
    const body1 = page1.json<{ data: Array<{ name: string }>; page: { limit: number; offset: number; total: number } }>()
    expect(body1.page).toEqual({ limit: 2, offset: 0, total: 3 })
    expect(body1.data.map((b) => b.name)).toEqual(['Aachi', 'Everest'])
    const past = await t.app.inject({ method: 'GET', url: '/api/v1/__test/brands?limit=2&offset=10', headers: bearer(ownerToken) })
    expect(past.json<{ page: { total: number } }>().page.total).toBe(3)
    expect(past.json<{ data: unknown[] }>().data).toHaveLength(0)
  })

  it('isolates tenants: another tenant cannot read the brand', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/__test/brands', headers: bearer(ownerToken), payload: { name: 'Mine' } })
    const id = created.json<{ data: { id: string } }>().data.id
    const other = await insertTestTenant(t.deps.db.systemDb)
    const otherToken = await signTestToken(t.deps, other.owner)
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/__test/brands/${id}`, headers: bearer(otherToken) })
    expect(res.statusCode).toBe(404)
    const mine = await t.app.inject({ method: 'GET', url: `/api/v1/__test/brands/${id}`, headers: bearer(ownerToken) })
    expect(mine.statusCode).toBe(200)
  })

  it('rejects revoked sessions with SESSION_REVOKED', async () => {
    const s = await signTestSession(t.deps, shop.owner)
    const ok = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(s.accessToken) })
    expect(ok.statusCode).toBe(200)
    await revokeSession(t.deps.db.systemDb, s.sessionId)
    // The NOTIFY arrives asynchronously; the revocation also invalidates this process directly.
    await t.deps.events.waitUntilConnected()
    await new Promise((r) => setTimeout(r, 150))
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(s.accessToken) })
    expect(res.statusCode).toBe(401)
    expect(res.json<ErrorJson>().error.code).toBe('SESSION_REVOKED')
  })

  it('returns TENANT_SUSPENDED for suspended tenants (after cache invalidation)', async () => {
    const other = await insertTestTenant(t.deps.db.systemDb)
    const token = await signTestToken(t.deps, other.owner)
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(token) })).statusCode).toBe(200)
    await t.deps.db.systemDb.transaction().execute(async (tx) => {
      await tx.updateTable('tenants').set({ status: 'suspended' }).where('id', '=', other.tenant.id).execute()
      await notifyAccessChanged(tx, { tenant_id: other.tenant.id })
    })
    await new Promise((r) => setTimeout(r, 150))
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(token) })
    expect(res.statusCode).toBe(403)
    expect(res.json<ErrorJson>().error.code).toBe('TENANT_SUSPENDED')
  })

  it('blocks disabled memberships and members of other tenants', async () => {
    const disabled = await insertTestMember(t.deps.db.systemDb, shop.tenant.id, { permissions: ['*'], status: 'disabled' })
    const token = await signTestToken(t.deps, disabled)
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(token) })
    expect(res.statusCode).toBe(403)

    const other = await insertTestTenant(t.deps.db.systemDb)
    // A token claiming a tenant the user is not a member of.
    const forged = await signTestToken(t.deps, { ...shop.owner, tenant_id: other.tenant.id })
    const res2 = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(forged) })
    expect(res2.statusCode).toBe(401)
  })

  it('tenant-less tokens: allowed on auth "user" routes, refused on tenant routes', async () => {
    const token = await signTestToken(t.deps, shop.owner, { tenantless: true })
    const userRoute = await t.app.inject({ method: 'GET', url: '/api/v1/__test/tenantless', headers: bearer(token) })
    expect(userRoute.statusCode).toBe(200)
    expect(userRoute.json<{ data: { has_ctx: boolean } }>().data.has_ctx).toBe(false)
    const tenantRoute = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(token) })
    expect(tenantRoute.statusCode).toBe(403)
    expect(tenantRoute.json<ErrorJson>().error.details).toMatchObject({ reason: 'tenant_selection_required' })
  })

  it('scopes stores (requireStoreAccess)', async () => {
    const scoped = await insertTestMember(t.deps.db.systemDb, shop.tenant.id, { permissions: ['*'], store_ids: [shop.store.id] })
    const token = await signTestToken(t.deps, scoped)
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/__test/scoped/${shop.store.id}`, headers: bearer(token) })).statusCode).toBe(200)
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/__test/scoped/${newId()}`, headers: bearer(token) })
    expect(res.statusCode).toBe(403)
  })

  it('binds trusted devices to registers and rejects revoked devices', async () => {
    const deviceId = newId()
    await t.deps.db.systemDb
      .insertInto('devices')
      .values({ id: deviceId, tenant_id: shop.tenant.id, store_id: shop.store.id, register_id: shop.register.id, name: 'Counter PC', device_secret_hash: 'x' })
      .execute()
    const token = await signTestToken(t.deps, shop.owner, { device_id: deviceId, amr: ['pin'] })
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(token) })
    expect(res.json<{ data: { register_id: string } }>().data.register_id).toBe(shop.register.id)
    await t.deps.db.systemDb.transaction().execute(async (tx) => {
      await tx.updateTable('devices').set({ revoked_at: new Date(), is_active: false }).where('id', '=', deviceId).execute()
      await notifyAccessChanged(tx, { tenant_id: shop.tenant.id })
    })
    await new Promise((r) => setTimeout(r, 150))
    const revoked = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(token) })
    expect(revoked.statusCode).toBe(403)
    expect(revoked.json<ErrorJson>().error.code).toBe('DEVICE_NOT_TRUSTED')
  })

  it('authenticates API keys (feature api_access, scoped permissions)', async () => {
    const key = generateApiKey('live')
    await t.deps.db.systemDb
      .insertInto('api_keys')
      .values({ tenant_id: shop.tenant.id, name: 'ERP sync', key_prefix: key.keyPrefix, key_hash: key.keyHash, permissions: ['catalog.read'] })
      .execute()
    const ok = await t.app.inject({ method: 'GET', url: '/api/v1/__test/brands', headers: { 'x-api-key': key.key } })
    expect(ok.statusCode).toBe(200)
    const denied = await t.app.inject({ method: 'POST', url: '/api/v1/__test/brands', headers: { 'x-api-key': key.key }, payload: { name: 'X' } })
    expect(denied.statusCode).toBe(403)
    const wrong = await t.app.inject({ method: 'GET', url: '/api/v1/__test/brands', headers: { 'x-api-key': `${key.keyPrefix}_${'A'.repeat(43)}` } })
    expect(wrong.statusCode).toBe(401)

    // Free plan has no api_access → 402.
    const free = await insertTestTenant(t.deps.db.systemDb, { plan_code: 'free' })
    const freeKey = generateApiKey('live')
    await t.deps.db.systemDb
      .insertInto('api_keys')
      .values({ tenant_id: free.tenant.id, name: 'k', key_prefix: freeKey.keyPrefix, key_hash: freeKey.keyHash, permissions: ['*'] })
      .execute()
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: { 'x-api-key': freeKey.key } })
    expect(res.statusCode).toBe(402)
    expect(res.json<ErrorJson>().error.code).toBe('FEATURE_NOT_IN_PLAN')
  })

  it('leaves public, webhook and health routes unauthenticated', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/public/v1/__test/ping' })).statusCode).toBe(200)
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/__test/public-login' })).statusCode).toBe(200)
    const raw = '{"event":"payment.captured","amount":100}'
    const hook = await t.app.inject({ method: 'POST', url: '/webhooks/__test/hook', headers: { 'content-type': 'application/json' }, payload: raw })
    expect(hook.statusCode).toBe(200)
    const body = hook.json<{ data: { raw_sha256: string; parsed: unknown } }>()
    const { createHash } = await import('node:crypto')
    expect(body.data.raw_sha256).toBe(createHash('sha256').update(raw).digest('hex'))
    expect(body.data.parsed).toEqual({ event: 'payment.captured', amount: 100 })
  })

  it('registers catalogued routes with guards, 204 and deployment mode', async () => {
    const echo = await t.app.inject({ method: 'POST', url: '/api/v1/__test/echo', headers: bearer(ownerToken), payload: { text: 'vanakkam' } })
    expect(echo.statusCode).toBe(200)
    expect(echo.json()).toEqual({ data: { text: 'vanakkam', tenant_id: shop.tenant.id } })
    const invalid = await t.app.inject({ method: 'POST', url: '/api/v1/__test/echo', headers: bearer(ownerToken), payload: { text: '' } })
    expect(invalid.statusCode).toBe(400)
    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/__test/nothing/${newId()}`, headers: bearer(ownerToken) })
    expect(del.statusCode).toBe(204)
    // mode: 'onprem' route is not registered in cloud mode.
    const onprem = await t.app.inject({ method: 'GET', url: '/api/v1/__test/onprem-only', headers: bearer(ownerToken) })
    expect(onprem.statusCode).toBe(404)
  })

  it('requireFeature returns 402 FEATURE_NOT_IN_PLAN with plan details', async () => {
    const free = await insertTestTenant(t.deps.db.systemDb, { plan_code: 'free' })
    const token = await signTestToken(t.deps, free.owner)
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/api-feature', headers: bearer(token) })
    expect(res.statusCode).toBe(402)
    expect(res.json<ErrorJson>().error).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', details: { feature: 'api_access', plan: 'free' } })
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/__test/api-feature', headers: bearer(ownerToken) })).statusCode).toBe(200)
  })
})
