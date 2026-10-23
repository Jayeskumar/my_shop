/**
 * Sales jobs: POS tombstone pruning (handler and service) and the delete triggers that feed it.
 */
import { newId } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { TOMBSTONE_RETENTION_DAYS, jobs, prunePosTombstones } from '../jobs'
import { insertProduct } from './fixtures'

let t: TestApp
let shop: TestShop
beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t)
})
afterAll(() => t.close())

async function tombstones(ref: string) {
  return t.deps.db.systemDb
    .selectFrom('pos_tombstones')
    .select(['kind', 'deleted_at'])
    .where('ref', '=', ref)
    .execute()
}

describe('POS tombstones', () => {
  it('a product deleted inside a tenant transaction (app role, RLS) leaves a tombstone', async () => {
    const p = await insertProduct(t, shop)
    await shop.tx((tx) => tx.deleteFrom('products').where('id', '=', p).execute())
    expect((await tombstones(p)).map((r) => r.kind)).toEqual(['product'])
    // Tenant B cannot see tenant A's tombstones.
    const other = await createTestTenant(t)
    const seen = await other.tx((tx) =>
      tx.selectFrom('pos_tombstones').select('ref').where('ref', '=', p).execute(),
    )
    expect(seen).toHaveLength(0)
  })

  it('prunes tombstones older than the retention, keeps recent ones', async () => {
    const oldRef = newId()
    const newRef = newId()
    await t.deps.db.systemDb
      .insertInto('pos_tombstones')
      .values([
        {
          tenant_id: shop.tenant.id,
          kind: 'promotion',
          ref: oldRef,
          deleted_at: sql`now() - make_interval(days => ${TOMBSTONE_RETENTION_DAYS + 1})`,
        },
        { tenant_id: shop.tenant.id, kind: 'promotion', ref: newRef },
      ])
      .execute()
    const deleted = await prunePosTombstones(t.deps.db.systemDb)
    expect(deleted).toBeGreaterThanOrEqual(1)
    expect(await tombstones(oldRef)).toHaveLength(0)
    expect(await tombstones(newRef)).toHaveLength(1)
  })

  it('the job handler runs the pruning', async () => {
    const job = jobs.find((j) => j.name === 'sales.prune-pos-tombstones')!
    expect(job.cron).toBeTruthy()
    const ref = newId()
    await t.deps.db.systemDb
      .insertInto('pos_tombstones')
      .values({
        tenant_id: shop.tenant.id,
        kind: 'batch',
        ref,
        deleted_at: sql`now() - interval '400 days'`,
      })
      .execute()
    await job.handler({ id: newId(), name: job.name, data: {}, retryCount: 0 }, t.deps)
    expect(await tombstones(ref)).toHaveLength(0)
  })
})

describe('module wiring', () => {
  it('implements every route of the sales catalogue', async () => {
    const { unimplementedRoutes } = await import('../../../core/http')
    const { salesRoutes } = await import('@kadai/shared/api/sales')
    const { salesImpls } = await import('../index')
    expect(unimplementedRoutes(salesRoutes, salesImpls)).toEqual([])
  })
})
