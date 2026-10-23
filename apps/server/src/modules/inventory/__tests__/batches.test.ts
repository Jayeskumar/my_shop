/**
 * Batches: GET /batches filters (product, store, supplier, expiring within N days, expired, with
 * stock only, search, ids, sort) and PATCH /batches/:id (prices / dates / active flag, audited;
 * expiry and mfg changes need inventory.adjust), permissions and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestSupplier } from '../../../test/tenants'
import {
  auditActions,
  dataOf,
  errorOf,
  makeBatch,
  makeProduct,
  makeStore,
  openStock,
  req,
} from './fixtures'

interface BatchView {
  id: string
  batch_no: string
  product_id: string
  expiry_date: string | null
  mfg_date: string | null
  mrp_paise: number | null
  sale_price_paise: number | null
  supplier_name: string | null
  qty_milli: number
  value_cost_paise: number
  expiry_status: string
  days_to_expiry: number | null
  is_active: boolean
  updated_at: string
}

describe('inventory: batches', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  const today = todayIn('Asia/Kolkata')
  const b: Record<string, string> = {}
  let productId: string
  let branchId: string
  let supplierId: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, {
      business_type: 'pharmacy',
      settings: { inventory: { expiry_warning_days: 60 } },
    })
    other = await createTestTenant(t)
    const supplier = await insertTestSupplier(t.deps, shop.tenant.id, {
      name: 'Sri Murugan Pharma',
    })
    supplierId = supplier.id
    const p = await makeProduct(t, shop.tenant.id, {
      name: 'Amoxicillin 500',
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
    })
    productId = p.id
    const branch = await makeStore(t, shop.tenant.id, 'S2')
    branchId = branch.id
    const expired = await makeBatch(t, shop.tenant.id, p.id, {
      batch_no: 'AX-EXP',
      expiry_date: addDays(today, -10),
    })
    const soon = await makeBatch(t, shop.tenant.id, p.id, {
      batch_no: 'AX-SOON',
      expiry_date: addDays(today, 25),
      supplier_id: supplierId,
    })
    const later = await makeBatch(t, shop.tenant.id, p.id, {
      batch_no: 'AX-LATER',
      expiry_date: addDays(today, 200),
    })
    const empty = await makeBatch(t, shop.tenant.id, p.id, {
      batch_no: 'AX-EMPTY',
      expiry_date: addDays(today, 40),
    })
    Object.assign(b, { expired: expired.id, soon: soon.id, later: later.id, empty: empty.id })
    await openStock(shop, shop.store.id, [
      { product_id: p.id, batch_id: expired.id, qty_milli: 30_000, unit_cost_paise: 1_000 },
      { product_id: p.id, batch_id: soon.id, qty_milli: 20_000, unit_cost_paise: 1_200 },
      { product_id: p.id, batch_id: later.id, qty_milli: 10_000, unit_cost_paise: 1_100 },
    ])
    await openStock(shop, branch.id, [
      { product_id: p.id, batch_id: later.id, qty_milli: 5_000, unit_cost_paise: 1_100 },
    ])
  })
  afterAll(() => t.close())

  const list = async (query: string, as?: Parameters<typeof req>[4]) => {
    const res = await req(shop, 'GET', `/batches${query}`, undefined, as)
    expect(res.statusCode).toBe(200)
    return res.json<{ data: BatchView[]; page: { total: number } }>()
  }

  it('lists batches with stock, value and expiry status (expiry order by default)', async () => {
    const res = await list(`?product_id=${productId}`)
    expect(res.data.map((r) => [r.batch_no, r.qty_milli, r.expiry_status])).toEqual([
      ['AX-EXP', 30_000, 'expired'],
      ['AX-SOON', 20_000, 'expiring'],
      ['AX-EMPTY', 0, 'expiring'],
      ['AX-LATER', 15_000, 'ok'],
    ])
    const soon = res.data.find((r) => r.batch_no === 'AX-SOON')!
    expect(soon).toMatchObject({
      days_to_expiry: 25,
      value_cost_paise: 2_400,
      supplier_name: 'Sri Murugan Pharma',
    })
  })

  it('filters by expiry window, expired, stock, store, supplier, search and ids', async () => {
    const names = async (q: string) => (await list(q)).data.map((r) => r.batch_no)
    expect(await names(`?product_id=${productId}&expiring_within_days=30`)).toEqual(['AX-SOON'])
    expect(
      await names(`?product_id=${productId}&expiring_within_days=60&with_stock_only=true`),
    ).toEqual(['AX-SOON'])
    expect(await names(`?product_id=${productId}&expired=true`)).toEqual(['AX-EXP'])
    expect(await names(`?product_id=${productId}&expired=false&with_stock_only=true`)).toEqual([
      'AX-SOON',
      'AX-LATER',
    ])
    const branch = await list(`?product_id=${productId}&store_id=${branchId}&with_stock_only=true`)
    expect(branch.data.map((r) => [r.batch_no, r.qty_milli])).toEqual([['AX-LATER', 5_000]])
    expect(await names(`?supplier_id=${supplierId}`)).toEqual(['AX-SOON'])
    expect(await names('?q=ax-lat')).toEqual(['AX-LATER'])
    expect(await names(`?ids=${b.soon},${b.later}`)).toEqual(['AX-SOON', 'AX-LATER'])
    expect(await names(`?product_id=${productId}&sort=-qty&limit=2`)).toEqual(['AX-EXP', 'AX-SOON'])
    expect((await req(shop, 'GET', '/batches?expiring_within_days=5000')).statusCode).toBe(400)
  })

  it('updates prices with catalog.write and audits the change', async () => {
    const pricer = await shop.asRole('pricer', { permissions: ['catalog.write'] })
    const before = (await list(`?ids=${b.later}`)).data[0]!
    const updated = dataOf<BatchView>(
      await req(
        shop,
        'PATCH',
        `/batches/${b.later}`,
        { mrp_paise: 4_500, sale_price_paise: 4_200, if_updated_at: before.updated_at },
        { as: pricer },
      ),
    )
    expect(updated).toMatchObject({ mrp_paise: 4_500, sale_price_paise: 4_200, qty_milli: 15_000 })
    expect(await auditActions(t, shop.tenant.id, b.later!)).toEqual(['batch.update'])
    const audit = await t.deps.db.systemDb
      .selectFrom('audit_logs')
      .select(['changes', 'user_id'])
      .where('tenant_id', '=', shop.tenant.id)
      .where('entity_id', '=', b.later!)
      .executeTakeFirstOrThrow()
    expect(audit.user_id).toBe(pricer.user.id)
    expect(audit.changes).toMatchObject({
      before: { mrp_paise: null },
      after: { mrp_paise: 4_500 },
    })

    // Expiry / mfg changes need inventory.adjust.
    const denied = await req(
      shop,
      'PATCH',
      `/batches/${b.later}`,
      { expiry_date: addDays(today, 100) },
      { as: pricer },
    )
    expect(denied.statusCode).toBe(403)
    expect(errorOf(denied).details?.reason).toBe('expiry_change_forbidden')

    const stale = await req(shop, 'PATCH', `/batches/${b.later}`, {
      mrp_paise: 1,
      if_updated_at: before.updated_at,
    })
    expect(stale.statusCode).toBe(409)
    expect(errorOf(stale).code).toBe('STALE_WRITE')
  })

  it('changes expiry with inventory.adjust and validates dates', async () => {
    const pharmacist = await shop.asRole('pharmacist')
    const res = dataOf<BatchView>(
      await req(
        shop,
        'PATCH',
        `/batches/${b.empty}`,
        { expiry_date: addDays(today, 90), mfg_date: addDays(today, -300) },
        { as: pharmacist },
      ),
    )
    expect(res).toMatchObject({ expiry_date: addDays(today, 90), expiry_status: 'ok' })
    const bad = await req(shop, 'PATCH', `/batches/${b.empty}`, { mfg_date: addDays(today, 100) })
    expect(bad.statusCode).toBe(400)
    expect(errorOf(bad).details?.issues?.[0]?.message).toBe('batch_dates')
    const bothBad = await req(shop, 'PATCH', `/batches/${b.empty}`, {
      expiry_date: addDays(today, 1),
      mfg_date: addDays(today, 2),
    })
    expect(errorOf(bothBad).details?.issues?.[0]?.message).toBe('batch_dates')
    const empty = await req(shop, 'PATCH', `/batches/${b.empty}`, {})
    expect(errorOf(empty).details?.issues?.[0]?.message).toBe('empty_patch')
    const deactivated = dataOf<BatchView>(
      await req(shop, 'PATCH', `/batches/${b.empty}`, { is_active: false }),
    )
    expect(deactivated.is_active).toBe(false)
    expect(
      (await list(`?product_id=${productId}&is_active=false`)).data.map((r) => r.batch_no),
    ).toEqual(['AX-EMPTY'])
    expect((await req(shop, 'PATCH', `/batches/${newId()}`, { mrp_paise: 1 })).statusCode).toBe(404)
  })

  it('needs inventory.read to list and adjust / catalog.write to edit', async () => {
    const accountant = await shop.asRole('accountant')
    expect((await req(shop, 'GET', '/batches', undefined, { as: accountant })).statusCode).toBe(403)
    const cashier = await shop.asRole('cashier')
    expect((await req(shop, 'GET', '/batches', undefined, { as: cashier })).statusCode).toBe(200)
    const edit = await req(shop, 'PATCH', `/batches/${b.soon}`, { mrp_paise: 100 }, { as: cashier })
    expect(edit.statusCode).toBe(403)
  })

  it('keeps batches of other tenants invisible', async () => {
    const res = await req(other, 'GET', `/batches?product_id=${productId}`)
    expect(res.json<{ page: { total: number } }>().page.total).toBe(0)
    expect((await req(other, 'PATCH', `/batches/${b.soon}`, { mrp_paise: 1 })).statusCode).toBe(404)
  })
})
