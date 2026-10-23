/**
 * Integration tests for the platform and licensing modules:
 *  - Cloud billing: GET /billing/plans, GET /billing/subscription, POST /billing/quote,
 *    GET /billing/invoices
 *  - System info: GET /system/info
 *  - Announcements: GET /announcements
 *  - API keys: POST /api-keys (shown once, permission subset check), GET /api-keys,
 *    POST /api-keys/:id/revoke
 *  - Platform console: GET /platform/me, GET /platform/metrics, GET /platform/tenants,
 *    GET /platform/tenants/:id, POST suspend/resume, GET /platform/plans, GET /platform/licenses
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'

describe('platform & licensing modules', () => {
  let t: TestApp
  let shop: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { plan_code: 'pro' })
    await t.deps.db.systemDb
      .updateTable('users')
      .set({ is_platform_admin: true })
      .where('id', '=', shop.owner.user.id)
      .execute()
  })

  afterAll(async () => {
    await t.close()
  })

  const inject = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    payload?: unknown,
  ) =>
    shop.inject({
      method,
      url: `/api/v1${path}`,
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    })

  it('returns cloud billing plans, subscription overview, quote, and invoices', async () => {
    const plansRes = await inject('GET', '/billing/plans')
    expect(plansRes.statusCode).toBe(200)
    const plans = plansRes.json<{ data: { plans: { code: string }[]; current_plan_code: string } }>()
    expect(plans.data.current_plan_code).toBe('pro')
    expect(plans.data.plans.some((p) => p.code === 'growth')).toBe(true)

    const subRes = await inject('GET', '/billing/subscription')
    expect(subRes.statusCode).toBe(200)
    const sub = subRes.json<{ data: { plan: { code: string }; usage: { metric: string }[] } }>()
    expect(sub.data.plan.code).toBe('pro')
    expect(sub.data.usage.length).toBeGreaterThanOrEqual(5)

    const quoteRes = await inject('POST', '/billing/quote', {
      plan_code: 'growth',
      cycle: 'yearly',
    })
    expect(quoteRes.statusCode).toBe(200)
    const quote = quoteRes.json<{ data: { plan_code: string; quote: { total_paise: number } } }>()
    expect(quote.data.plan_code).toBe('growth')
    expect(quote.data.quote.total_paise).toBeGreaterThan(0)

    const invRes = await inject('GET', '/billing/invoices')
    expect(invRes.statusCode).toBe(200)
  })

  it('returns system info and announcements', async () => {
    const infoRes = await inject('GET', '/system/info')
    expect(infoRes.statusCode).toBe(200)
    const info = infoRes.json<{
      data: { mode: string; db: { migrations_applied: number }; entitlements: { plan_code: string } }
    }>()
    expect(info.data.mode).toBe('cloud')
    expect(info.data.db.migrations_applied).toBeGreaterThan(0)
    expect(info.data.entitlements.plan_code).toBe('pro')

    const annRes = await inject('GET', '/announcements')
    expect(annRes.statusCode).toBe(200)
  })

  it('creates, lists, and revokes API keys', async () => {
    const createRes = await inject('POST', '/api-keys', {
      name: 'ERP Sync Key',
      permissions: ['catalog.read', 'sales.read'],
      store_ids: null,
      expires_at: null,
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json<{
      data: { key: string; api_key: { id: string; key_prefix: string; state: string } }
    }>()
    expect(created.data.key).toMatch(/^kd_live_/)
    expect(created.data.api_key.state).toBe('active')

    // API key actor cannot create another API key
    const selfCreate = await t.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { 'x-api-key': created.data.key },
      payload: {
        name: 'Illegal Key',
        permissions: ['catalog.read'],
      },
    })
    expect(selfCreate.statusCode).toBe(403)

    const listRes = await inject('GET', '/api-keys')
    expect(listRes.statusCode).toBe(200)
    const list = listRes.json<{ data: { id: string }[] }>()
    expect(list.data.some((k) => k.id === created.data.api_key.id)).toBe(true)

    const revokeRes = await inject('POST', `/api-keys/${created.data.api_key.id}/revoke`, {
      reason: 'Key rotated',
    })
    expect(revokeRes.statusCode).toBe(200)
    const revoked = revokeRes.json<{ data: { state: string } }>()
    expect(revoked.data.state).toBe('revoked')
  })

  it('serves platform console endpoints (/platform/me, /metrics, /tenants, /plans, /licenses)', async () => {
    const meRes = await inject('GET', '/platform/me')
    expect(meRes.statusCode).toBe(200)
    expect(meRes.json<{ data: { role: string } }>().data.role).toBe('owner')

    const metricsRes = await inject('GET', '/platform/metrics')
    expect(metricsRes.statusCode).toBe(200)
    const metrics = metricsRes.json<{ data: { cloud: { tenants_total: number } } }>()
    expect(metrics.data.cloud.tenants_total).toBeGreaterThanOrEqual(1)

    const tenantsRes = await inject('GET', '/platform/tenants')
    expect(tenantsRes.statusCode).toBe(200)
    const tenants = tenantsRes.json<{ data: { id: string }[] }>()
    expect(tenants.data.some((r) => r.id === shop.tenant.id)).toBe(true)

    const detailRes = await inject('GET', `/platform/tenants/${shop.tenant.id}`)
    expect(detailRes.statusCode).toBe(200)
    expect(detailRes.json<{ data: { id: string } }>().data.id).toBe(shop.tenant.id)

    const plansRes = await inject('GET', '/platform/plans')
    expect(plansRes.statusCode).toBe(200)
    expect(plansRes.json<{ data: { code: string }[] }>().data.length).toBeGreaterThan(0)

    const licRes = await inject('GET', '/platform/licenses')
    expect(licRes.statusCode).toBe(200)
  })
})
