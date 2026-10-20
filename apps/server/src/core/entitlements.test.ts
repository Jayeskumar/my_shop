import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../db/tenant'
import { closeTestDb, getTestConfig, insertTestTenant, testDb } from '../test/helpers'
import { systemContext } from './context'
import {
  EntitlementsService,
  assertFeature,
  assertWithinLimit,
  getEntitlements,
  incrementUsage,
  setEntitlementsService,
  toEntitlementsDto,
} from './entitlements'

describe('cloud entitlements (plan + subscription)', () => {
  let service: EntitlementsService

  beforeAll(() => {
    service = new EntitlementsService({ config: getTestConfig(), systemDb: testDb().systemDb, ttlMs: 60_000 })
    setEntitlementsService(service)
  })
  afterAll(async () => {
    setEntitlementsService(null)
    await closeTestDb()
  })

  it('uses tenants.plan_code without a live subscription', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'free' })
    const ent = await service.get(t.tenant.id)
    expect(ent).toMatchObject({ plan_code: 'free', source: 'plan', valid_until: null, read_only: false })
    expect(ent.limits).toEqual({ stores: 1, users: 2, registers: 1, products: 1000, invoices_per_month: 300 })
    expect(ent.features.has('pos')).toBe(true)
    expect(ent.features.has('purchases')).toBe(false)
    expect(toEntitlementsDto(ent).features).toContain('khata')
  })

  it('a live subscription overrides the plan and applies limit_overrides', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'free' })
    const end = new Date(Date.now() + 10 * 86_400_000)
    await testDb()
      .systemDb.insertInto('subscriptions')
      .values({
        tenant_id: t.tenant.id,
        plan_code: 'growth',
        status: 'trialing',
        current_period_start: new Date(),
        current_period_end: end,
        trial_ends_at: end,
        limit_overrides: JSON.stringify({ users: 9 }),
      })
      .execute()
    const ent = await service.get(t.tenant.id)
    expect(ent.plan_code).toBe('growth')
    expect(ent.limits).toMatchObject({ users: 9, registers: 3, products: null })
    expect(ent.features.has('purchases')).toBe(true)
    expect(ent.valid_until).toBe(end.toISOString())
  })

  it('ignores a subscription whose period already ended', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'free' })
    await testDb()
      .systemDb.insertInto('subscriptions')
      .values({ tenant_id: t.tenant.id, plan_code: 'pro', status: 'active', current_period_start: new Date(Date.now() - 40 * 86_400_000), current_period_end: new Date(Date.now() - 86_400_000) })
      .execute()
    expect((await service.get(t.tenant.id)).plan_code).toBe('free')
  })

  it('caches per tenant until invalidated', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'free' })
    expect((await service.get(t.tenant.id)).plan_code).toBe('free')
    await testDb().systemDb.updateTable('tenants').set({ plan_code: 'pro' }).where('id', '=', t.tenant.id).execute()
    expect((await service.get(t.tenant.id)).plan_code).toBe('free')
    service.invalidate(t.tenant.id)
    expect((await service.get(t.tenant.id)).plan_code).toBe('pro')
  })

  it('assertFeature → 402 FEATURE_NOT_IN_PLAN', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'free' })
    await expect(assertFeature({ tenantId: t.tenant.id }, 'pos')).resolves.toBeUndefined()
    await expect(assertFeature({ tenantId: t.tenant.id }, 'gst_reports')).rejects.toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      status: 402,
      details: { feature: 'gst_reports', plan: 'free' },
    })
    expect((await getEntitlements({ tenantId: t.tenant.id })).plan_code).toBe('free')
  })

  it('assertWithinLimit counts rows inside the tenant transaction', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'free' }) // stores: 1, registers: 1, users: 2
    const ctx = systemContext(t.tenant.id)
    const { appDb } = testDb()
    await expect(withTenant(appDb, ctx, (tx) => assertWithinLimit(tx, ctx, 'stores'))).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'stores', limit: 1, current: 1, plan: 'free' },
    })
    // users: owner only → one more allowed, two more not.
    await expect(withTenant(appDb, ctx, (tx) => assertWithinLimit(tx, ctx, 'users'))).resolves.toBeUndefined()
    await expect(withTenant(appDb, ctx, (tx) => assertWithinLimit(tx, ctx, 'users', { adding: 2 }))).rejects.toMatchObject({ code: 'PLAN_LIMIT_REACHED' })
    await expect(withTenant(appDb, ctx, (tx) => assertWithinLimit(tx, ctx, 'products'))).resolves.toBeUndefined()
  })

  it('unlimited metrics never block', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'enterprise' })
    const ctx = systemContext(t.tenant.id)
    await expect(withTenant(testDb().appDb, ctx, (tx) => assertWithinLimit(tx, ctx, 'stores', { adding: 1000 }))).resolves.toBeUndefined()
  })

  it('incrementUsage enforces invoices_per_month atomically (and rolls back the increment)', async () => {
    const t = await insertTestTenant(testDb().systemDb, { plan_code: 'free' })
    const ctx = systemContext(t.tenant.id)
    const { appDb, systemDb } = testDb()
    const period = '2026-10'
    await systemDb.insertInto('usage_counters').values({ tenant_id: t.tenant.id, metric: 'invoices', period, value: 299 }).execute()
    expect(await withTenant(appDb, ctx, (tx) => incrementUsage(tx, ctx, 'invoices', { period }))).toBe(300)
    await expect(withTenant(appDb, ctx, (tx) => incrementUsage(tx, ctx, 'invoices', { period }))).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'invoices_per_month', limit: 300, current: 300 },
    })
    const row = await systemDb.selectFrom('usage_counters').select('value').where('tenant_id', '=', t.tenant.id).where('period', '=', period).executeTakeFirstOrThrow()
    expect(row.value).toBe(300)
    // Offline-synced invoices are counted but never refused.
    expect(await withTenant(appDb, ctx, (tx) => incrementUsage(tx, ctx, 'invoices', { period, enforce: false }))).toBe(301)
    // Non-limited metrics just count.
    expect(await withTenant(appDb, ctx, (tx) => incrementUsage(tx, ctx, 'sms', { by: 3, period }))).toBe(3)
  })

  it('unknown tenants are NOT_FOUND', async () => {
    await expect(service.get(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
