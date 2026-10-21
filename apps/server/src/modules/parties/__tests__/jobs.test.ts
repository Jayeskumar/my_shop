/**
 * Loyalty expiry jobs: FIFO expiry of points older than settings.loyalty.expiry_days, idempotent
 * re-runs, tenants skipped without the feature / setting, the fan-out and payload validation.
 */
import { addDays, newId, todayIn } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import { jobs } from '../jobs'
import {
  LOYALTY_EXPIRY_JOB,
  LOYALTY_EXPIRY_TENANT_JOB,
  expireTenantLoyalty,
  loyaltyExpiryTenants,
} from '../loyalty-expiry'

const DAY = 86_400_000

describe('parties: loyalty expiry jobs', () => {
  let t: TestApp
  let shop: TestShop
  let today: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, {
      settings: { loyalty: { enabled: true, expiry_days: 30, min_redeem_points: 1 } },
    })
    today = todayIn('Asia/Kolkata')
  })
  afterAll(() => t.close())

  /** Ledger history with explicit timestamps (fixture: written like core/loyalty would). */
  async function history(
    s: TestShop,
    entries: Array<{ points: number; kind: 'earn' | 'redeem' | 'adjust'; daysAgo: number }>,
  ): Promise<string> {
    const c = await insertTestCustomer(t.deps, s.tenant.id)
    const balance = entries.reduce((a, e) => a + e.points, 0)
    await t.deps.db.systemDb
      .insertInto('loyalty_ledger')
      .values(
        entries.map((e) => ({
          id: newId(),
          tenant_id: s.tenant.id,
          customer_id: c.id,
          points: e.points,
          kind: e.kind,
          created_at: new Date(Date.now() - e.daysAgo * DAY),
        })),
      )
      .execute()
    await t.deps.db.systemDb
      .updateTable('customers')
      .set({ loyalty_points: balance })
      .where('id', '=', c.id)
      .execute()
    return c.id
  }

  async function points(id: string): Promise<{ stored: number; ledger: number; expired: number }> {
    const row = await t.deps.db.systemDb
      .selectFrom('customers')
      .select('loyalty_points')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    const res = await sql<{ total: string; expired: string }>`
      select coalesce(sum(points), 0)::bigint as total,
             coalesce(-sum(points) filter (where kind = 'expire'), 0)::bigint as expired
        from loyalty_ledger where customer_id = ${id}`.execute(t.deps.db.systemDb)
    return {
      stored: Number(row.loyalty_points),
      ledger: Number(res.rows[0]?.total ?? 0),
      expired: Number(res.rows[0]?.expired ?? 0),
    }
  }

  it('expires the unspent part of old points first-in first-out, once', async () => {
    // 100 earned 60 days ago, 30 redeemed 10 days ago, 50 earned 5 days ago (balance 120): the
    // redemption used old points, so 70 old points expire and the 50 recent ones stay.
    const a = await history(shop, [
      { points: 100, kind: 'earn', daysAgo: 60 },
      { points: -30, kind: 'redeem', daysAgo: 10 },
      { points: 50, kind: 'earn', daysAgo: 5 },
    ])
    // Everything old was spent already.
    const b = await history(shop, [
      { points: 40, kind: 'earn', daysAgo: 45 },
      { points: -40, kind: 'redeem', daysAgo: 2 },
      { points: 15, kind: 'adjust', daysAgo: 1 },
    ])
    // Only recent points.
    const c = await history(shop, [{ points: 25, kind: 'earn', daysAgo: 29 }])

    const first = await expireTenantLoyalty(t.deps, shop.tenant.id)
    expect(first).toMatchObject({ skipped: false, customers: 1, points: 70 })
    expect(await points(a)).toEqual({ stored: 50, ledger: 50, expired: 70 })
    expect(await points(b)).toEqual({ stored: 15, ledger: 15, expired: 0 })
    expect(await points(c)).toEqual({ stored: 25, ledger: 25, expired: 0 })

    const again = await expireTenantLoyalty(t.deps, shop.tenant.id)
    expect(again).toMatchObject({ customers: 0, points: 0 })

    // 31 days later the 29-day-old points have expired too (explicit business date).
    const later = await expireTenantLoyalty(t.deps, shop.tenant.id, { today: addDays(today, 31) })
    expect(later).toMatchObject({ customers: 3, points: 50 + 15 + 25 })
    expect(await points(a)).toEqual({ stored: 0, ledger: 0, expired: 120 })
    expect((await points(b)).stored).toBe(0)
    expect((await points(c)).stored).toBe(0)
  })

  it('skips tenants without the feature or without an expiry period', async () => {
    const free = await createTestTenant(t, {
      plan_code: 'free',
      settings: { loyalty: { enabled: true, expiry_days: 30 } },
    })
    const id = await history(free, [{ points: 10, kind: 'earn', daysAgo: 90 }])
    expect(await expireTenantLoyalty(t.deps, free.tenant.id)).toMatchObject({ skipped: true })
    expect((await points(id)).stored).toBe(10)

    const never = await createTestTenant(t, { settings: { loyalty: { enabled: true } } })
    await history(never, [{ points: 10, kind: 'earn', daysAgo: 900 }])
    expect(await expireTenantLoyalty(t.deps, never.tenant.id)).toMatchObject({ skipped: true })

    const tenants = await loyaltyExpiryTenants(t.deps)
    expect(tenants).toContain(shop.tenant.id)
    expect(tenants).not.toContain(never.tenant.id)
  })

  it('registers the jobs; the tenant job validates its payload and runs', async () => {
    const names = jobs.map((j) => j.name)
    expect(names).toEqual([LOYALTY_EXPIRY_JOB, LOYALTY_EXPIRY_TENANT_JOB])
    const cron = jobs.find((j) => j.name === LOYALTY_EXPIRY_JOB)!
    expect(cron.cron).toBe('40 2 * * *')
    const tenantJob = jobs.find((j) => j.name === LOYALTY_EXPIRY_TENANT_JOB)!
    const run = (data: Record<string, unknown>) =>
      tenantJob.handler({ id: newId(), name: tenantJob.name, data, retryCount: 0 }, t.deps)
    await expect(run({ tenant_id: 'nope' })).rejects.toThrow(/invalid tenant_id/)
    await expect(run({ tenant_id: shop.tenant.id, date: '2026-13-01' })).rejects.toThrow(
      /invalid date/,
    )
    const id = await history(shop, [{ points: 12, kind: 'earn', daysAgo: 400 }])
    await run({ tenant_id: shop.tenant.id })
    expect((await points(id)).stored).toBe(0)
  })

  it('the daily job fans out one tenant job per eligible tenant', async () => {
    const cron = jobs.find((j) => j.name === LOYALTY_EXPIRY_JOB)!
    await cron.handler({ id: newId(), name: cron.name, data: {}, retryCount: 0 }, t.deps)
    const queued = await sql<{ n: string }>`
      select count(*)::bigint as n from pgboss.job
       where name = ${LOYALTY_EXPIRY_TENANT_JOB} and data ->> 'tenant_id' = ${shop.tenant.id}`.execute(
      t.deps.db.systemDb,
    )
    expect(Number(queued.rows[0]?.n ?? 0)).toBe(1)
  })
})
