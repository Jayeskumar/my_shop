import { DEFAULT_SETTINGS } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../db/tenant'
import { type TestTenant, closeTestDb, insertTestTenant, testDb } from '../test/helpers'
import { audit, diffChanges } from './audit'
import { systemContext } from './context'
import { getSettings, updateSettings } from './settings'

describe('tenant settings & audit', () => {
  let shop: TestTenant
  beforeAll(async () => {
    shop = await insertTestTenant(testDb().systemDb)
  })
  afterAll(() => closeTestDb())

  const ctx = () => ({
    ...systemContext(shop.tenant.id, { requestId: 'req-settings-1' }),
    userId: shop.owner.user_id,
    ip: '192.168.1.20',
    userAgent: 'vitest',
  })

  it('reads defaults for empty stored settings', async () => {
    const s = await withTenant(testDb().appDb, ctx(), (tx) => getSettings(tx, ctx()))
    expect(s).toEqual(DEFAULT_SETTINGS)
  })

  it('patches one field without resetting siblings and audits the diff', async () => {
    const before = DEFAULT_SETTINGS.inventory.allow_negative_stock
    const next = await withTenant(testDb().appDb, ctx(), (tx) =>
      updateSettings(tx, ctx(), { inventory: { allow_negative_stock: !before } }),
    )
    expect(next.inventory.allow_negative_stock).toBe(!before)
    expect(next.invoice).toEqual(DEFAULT_SETTINGS.invoice)
    const reread = await withTenant(testDb().appDb, ctx(), (tx) => getSettings(tx, ctx()))
    expect(reread.inventory.allow_negative_stock).toBe(!before)

    const logs = await testDb()
      .systemDb.selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', shop.tenant.id)
      .where('action', '=', 'settings.update')
      .execute()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      user_id: shop.owner.user_id,
      entity_type: 'tenant',
      ip: '192.168.1.20',
      request_id: 'req-settings-1',
    })
    expect(logs[0]!.changes).toEqual({
      before: { inventory: { allow_negative_stock: before } },
      after: { inventory: { allow_negative_stock: !before } },
    })
  })

  it('does not write or audit a no-op patch', async () => {
    const count = async () =>
      (
        await testDb()
          .systemDb.selectFrom('audit_logs')
          .select('id')
          .where('tenant_id', '=', shop.tenant.id)
          .where('action', '=', 'settings.update')
          .execute()
      ).length
    const n = await count()
    const current = await withTenant(testDb().appDb, ctx(), (tx) => getSettings(tx, ctx()))
    await withTenant(testDb().appDb, ctx(), (tx) =>
      updateSettings(tx, ctx(), {
        inventory: { allow_negative_stock: current.inventory.allow_negative_stock },
      }),
    )
    expect(await count()).toBe(n)
  })

  it('rejects invalid values (ZodError → VALIDATION_ERROR at the HTTP layer)', async () => {
    await expect(
      withTenant(testDb().appDb, ctx(), (tx) =>
        updateSettings(tx, ctx(), { inventory: { expiry_warning_days: -5 } } as never),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('reads stored settings leniently (bad fields fall back to defaults)', async () => {
    await testDb()
      .systemDb.updateTable('tenants')
      .set({
        settings: JSON.stringify({
          inventory: { allow_negative_stock: 'yes please' },
          unknown_section: { a: 1 },
        }),
      })
      .where('id', '=', shop.tenant.id)
      .execute()
    const s = await withTenant(testDb().appDb, ctx(), (tx) => getSettings(tx, ctx()))
    expect(s.inventory.allow_negative_stock).toBe(DEFAULT_SETTINGS.inventory.allow_negative_stock)
  })

  it('audit rows are append-only', async () => {
    await withTenant(testDb().appDb, ctx(), (tx) =>
      audit(tx, ctx(), { action: 'test.audit', summary: 'hello' }),
    )
    await expect(
      withTenant(testDb().appDb, ctx(), (tx) =>
        tx
          .updateTable('audit_logs')
          .set({ summary: 'changed' })
          .where('action', '=', 'test.audit')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      testDb().systemDb.deleteFrom('audit_logs').where('action', '=', 'test.audit').execute(),
    ).rejects.toMatchObject({ code: 'P0001' })
  })

  it('diffChanges masks secrets and reports nested changes only', () => {
    expect(
      diffChanges(
        { a: 1, b: { c: 2, d: 3 }, key_secret: 'x' },
        { a: 1, b: { c: 2, d: 4 }, key_secret: 'y' },
      ),
    ).toEqual({
      before: { b: { d: 3 }, key_secret: '***' },
      after: { b: { d: 4 }, key_secret: '***' },
    })
    expect(diffChanges({ a: 1 }, { a: 1 })).toBeNull()
  })
})
