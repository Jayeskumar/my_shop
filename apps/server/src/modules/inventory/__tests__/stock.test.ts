/**
 * Stock reads: GET /stock (per product / per batch, values at cost and MRP, status filters,
 * search, category descendants, sort, pagination, totals, CSV, store scope 'all'),
 * GET /stock/products/:productId, GET /stock/movements (filters, balances, users, document
 * numbers, CSV) and GET /stock/alerts — plus permissions, tenant isolation and route coverage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { postStock } from '../../../core/inventory'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  API,
  auditActions,
  dataOf,
  errorOf,
  makeCategory,
  makeProduct,
  makeStore,
  openStock,
  req,
} from './fixtures'

interface StockRowView {
  store_id: string | null
  product_id: string
  name: string
  batch_id: string | null
  batch_no: string | null
  qty_milli: number
  avg_cost_paise: number
  value_cost_paise: number
  mrp_paise: number | null
  value_mrp_paise: number | null
  status: string
  batch_count: number
  nearest_expiry: string | null
}
interface StockListView {
  data: StockRowView[]
  page: { limit: number; offset: number; total: number }
  totals: {
    item_count: number
    value_cost_paise: number
    value_mrp_paise: number
    low_stock_count: number
    out_of_stock_count: number
    negative_count: number
  }
}

describe('inventory: stock levels, movements and alerts', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  const today = todayIn('Asia/Kolkata')
  const ids: Record<string, string> = {}
  let branch: { id: string; code: string }
  let catRoot: string
  let catChild: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { settings: { inventory: { expiry_warning_days: 30 } } })
    other = await createTestTenant(t)
    branch = await makeStore(t, shop.tenant.id, 'S2')
    catRoot = await makeCategory(t, shop.tenant.id, `Grocery ${newId().slice(-4)}`)
    catChild = await makeCategory(t, shop.tenant.id, 'Rice', catRoot)
    const rice = await makeProduct(t, shop.tenant.id, {
      name: 'Alpha Ponni Rice',
      sku: 'RICE-01',
      category_id: catChild,
      mrp_paise: 6_000,
      reorder_level_milli: 5_000,
    })
    const oil = await makeProduct(t, shop.tenant.id, {
      name: 'Beta Groundnut Oil',
      sku: 'OIL-01',
      category_id: catRoot,
      mrp_paise: 20_000,
      reorder_level_milli: 2_000,
    })
    const salt = await makeProduct(t, shop.tenant.id, {
      name: 'Gamma Salt',
      reorder_level_milli: 1_000,
    })
    const strips = await makeProduct(t, shop.tenant.id, {
      name: 'Delta Paracetamol',
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
      mrp_paise: 3_000,
    })
    await makeProduct(t, shop.tenant.id, { name: 'Epsilon Never Stocked' })
    await makeProduct(t, shop.tenant.id, { name: 'Zeta Service', kind: 'service' })
    Object.assign(ids, { rice: rice.id, oil: oil.id, salt: salt.id, strips: strips.id })

    const opened = await openStock(shop, shop.store.id, [
      { product_id: rice.id, qty_milli: 20_000, unit_cost_paise: 5_000 },
      { product_id: oil.id, qty_milli: 1_500, unit_cost_paise: 18_000 },
      { product_id: salt.id, qty_milli: 2_000, unit_cost_paise: 1_000 },
      {
        product_id: strips.id,
        qty_milli: 25_000,
        unit_cost_paise: 2_000,
        batch: { batch_no: 'P-OLD', expiry_date: addDays(today, -5), mrp_paise: 2_800 },
      },
      {
        product_id: strips.id,
        qty_milli: 15_000,
        unit_cost_paise: 2_200,
        batch: { batch_no: 'P-NEW', expiry_date: addDays(today, 20) },
      },
    ])
    ids.oldBatch = opened.batches_created.find((b) => b.batch_no === 'P-OLD')!.batch_id
    ids.newBatch = opened.batches_created.find((b) => b.batch_no === 'P-NEW')!.batch_id
    ids.opening = opened.adjustment.id
    await openStock(shop, branch.id, [
      { product_id: rice.id, qty_milli: 3_000, unit_cost_paise: 5_200 },
    ])
    // Salt sold out, then oversold by 0.5 (negative stock is allowed in a general store).
    await shop.tx((tx) =>
      postStock(tx, shop.ctx, [
        {
          store_id: shop.store.id,
          product_id: salt.id,
          qty_milli: -2_500,
          movement_type: 'sale',
          ref_type: 'sales_invoice',
          ref_id: newId(),
        },
      ]),
    )
  })
  afterAll(() => t.close())

  const list = async (query: string, as?: Parameters<typeof req>[4]) => {
    const res = await req(shop, 'GET', `/stock${query}`, undefined, as)
    expect(res.statusCode).toBe(200)
    return res.json<StockListView>()
  }

  it('registers every route of the inventory catalogue', () => {
    for (const def of Object.values(inventoryRoutes)) {
      expect(t.app.hasRoute({ method: def.method, url: `${API}${def.path}` })).toBe(true)
    }
  })

  describe('GET /stock', () => {
    it('lists products of the default store with values at cost and MRP and totals', async () => {
      const res = await list('?sort=name')
      const byName = new Map(res.data.map((r) => [r.name, r]))
      expect(res.data.map((r) => r.name)).toEqual([
        'Alpha Ponni Rice',
        'Beta Groundnut Oil',
        'Delta Paracetamol',
        'Epsilon Never Stocked',
        'Gamma Salt',
      ])
      expect(byName.get('Alpha Ponni Rice')).toMatchObject({
        store_id: shop.store.id,
        qty_milli: 20_000,
        avg_cost_paise: 5_000,
        value_cost_paise: 100_000,
        mrp_paise: 6_000,
        value_mrp_paise: 120_000,
        status: 'ok',
      })
      expect(byName.get('Beta Groundnut Oil')).toMatchObject({
        status: 'low',
        value_cost_paise: 27_000,
      })
      expect(byName.get('Gamma Salt')).toMatchObject({ status: 'negative', qty_milli: -500 })
      expect(byName.get('Epsilon Never Stocked')).toMatchObject({ status: 'out', qty_milli: 0 })
      // Pack pricing: 25 tabs at ₹20 per strip of 10 + 15 tabs at ₹22.
      expect(byName.get('Delta Paracetamol')).toMatchObject({
        qty_milli: 40_000,
        value_cost_paise: 5_000 + 3_300,
        batch_count: 2,
        nearest_expiry: addDays(today, -5),
      })
      const sum = res.data.reduce((acc, r) => acc + r.value_cost_paise, 0)
      expect(res.totals).toMatchObject({
        item_count: 5,
        value_cost_paise: sum,
        low_stock_count: 1,
        out_of_stock_count: 1,
        negative_count: 1,
      })
      expect(res.page).toEqual({ limit: 50, offset: 0, total: 5 })
    })

    it('filters by status, search, category (with descendants) and paginates', async () => {
      expect((await list('?low_stock=true')).data.map((r) => r.name)).toEqual([
        'Beta Groundnut Oil',
      ])
      expect((await list('?out_of_stock=true')).data.map((r) => r.name)).toEqual([
        'Epsilon Never Stocked',
        'Gamma Salt',
      ])
      expect((await list('?in_stock=true')).totals.item_count).toBe(3)
      expect((await list('?q=ponni')).data.map((r) => r.name)).toEqual(['Alpha Ponni Rice'])
      expect((await list('?q=OIL-01')).data.map((r) => r.name)).toEqual(['Beta Groundnut Oil'])
      expect((await list(`?category_id=${catRoot}`)).data.map((r) => r.name)).toEqual([
        'Alpha Ponni Rice',
        'Beta Groundnut Oil',
      ])
      expect((await list(`?category_id=${catChild}`)).data.map((r) => r.name)).toEqual([
        'Alpha Ponni Rice',
      ])
      const sorted = await list('?sort=-value&limit=2&offset=1')
      expect(sorted.page).toEqual({ limit: 2, offset: 1, total: 5 })
      expect(sorted.data.map((r) => r.name)).toEqual(['Beta Groundnut Oil', 'Delta Paracetamol'])
      expect((await list('?sort=qty')).data[0]?.name).toBe('Gamma Salt')
    })

    it('groups by batch with batch MRP and expiry', async () => {
      const res = await list(`?group=batch&q=paracetamol&sort=expiry`)
      expect(
        res.data.map((r) => [r.batch_no, r.qty_milli, r.value_cost_paise, r.mrp_paise]),
      ).toEqual([
        ['P-OLD', 25_000, 5_000, 2_800],
        ['P-NEW', 15_000, 3_300, 3_000],
      ])
      expect(res.data[0]?.value_mrp_paise).toBe(7_000)
    })

    it('shows one store or every store together (owners with multi_store)', async () => {
      const s2 = await list(`?store_id=${branch.id}&in_stock=true`)
      expect(s2.data.map((r) => [r.name, r.qty_milli, r.value_cost_paise])).toEqual([
        ['Alpha Ponni Rice', 3_000, 15_600],
      ])
      const all = await list('?store_id=all&q=ponni')
      expect(all.data[0]).toMatchObject({
        store_id: null,
        qty_milli: 23_000,
        value_cost_paise: 115_600,
        // Weighted: (20 × 50 + 3 × 52) / 23 = 50.26 → 5 026 paise.
        avg_cost_paise: 5_026,
      })
      const scoped = await shop.asRole('manager', { store_ids: [branch.id] })
      const denied = await req(shop, 'GET', '/stock?store_id=all', undefined, { as: scoped })
      expect(denied.statusCode).toBe(403)
      expect(errorOf(denied).details?.reason).toBe('all_stores_required')
      const scopedDefault = await req(shop, 'GET', '/stock?in_stock=true', undefined, {
        as: scoped,
      })
      expect(scopedDefault.json<StockListView>().data.map((r) => r.store_id)).toEqual([branch.id])
      expect(
        (await req(shop, 'GET', `/stock?store_id=${shop.store.id}`, undefined, { as: scoped }))
          .statusCode,
      ).toBe(403)

      const single = await createTestTenant(t, { plan_code: 'growth' })
      const gated = await req(single, 'GET', '/stock?store_id=all')
      expect(gated.statusCode).toBe(402)
      expect(errorOf(gated).details).toMatchObject({ feature: 'multi_store' })
    })

    it('exports the filtered stock as CSV (audited)', async () => {
      const res = await shop.inject({
        method: 'GET',
        url: `${API}/stock?format=csv&in_stock=true`,
        headers: { 'x-locale': 'en' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="stock-\d{4}-\d{2}-\d{2}\.csv"/,
      )
      const lines = res.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n')
      expect(lines[0]).toBe(
        'SKU,Product,Category,Brand,Batch,Expiry,Quantity,Unit,Pack size,Avg cost (Rs),Value at cost (Rs),MRP (Rs),Value at MRP (Rs),Reorder level,Status',
      )
      expect(lines).toHaveLength(4)
      expect(lines[1]).toContain('RICE-01,Alpha Ponni Rice')
      expect(lines[1]).toContain('20,PCS,1,50.00,1000.00,60.00,1200.00,5,In stock')
      const audit = await t.deps.db.systemDb
        .selectFrom('audit_logs')
        .select('action')
        .where('tenant_id', '=', shop.tenant.id)
        .where('action', '=', 'stock.export')
        .execute()
      expect(audit.length).toBeGreaterThan(0)
    })

    it('validates the query and needs inventory.read', async () => {
      expect((await req(shop, 'GET', '/stock?group=store')).statusCode).toBe(400)
      expect((await req(shop, 'GET', '/stock?limit=1000')).statusCode).toBe(400)
      const accountant = await shop.asRole('accountant')
      const res = await req(shop, 'GET', '/stock', undefined, { as: accountant })
      expect(res.statusCode).toBe(403)
      const cashier = await shop.asRole('cashier')
      expect((await req(shop, 'GET', '/stock', undefined, { as: cashier })).statusCode).toBe(200)
    })

    it('never shows another tenant’s stock', async () => {
      const res = await req(other, 'GET', '/stock?store_id=all')
      expect(res.json<StockListView>().totals.item_count).toBe(0)
      expect((await req(other, 'GET', `/stock?store_id=${shop.store.id}`)).statusCode).toBe(404)
      expect((await req(other, 'GET', `/stock/products/${ids.rice}`)).statusCode).toBe(404)
    })
  })

  describe('GET /stock/products/:productId', () => {
    it('shows stock per store and batch with the recent movements', async () => {
      const res = dataOf<{
        product: { id: string; track_batches: boolean }
        stores: Array<{
          store_id: string
          qty_milli: number
          value_cost_paise: number
          status: string
          batches: Array<{
            batch_no: string | null
            qty_milli: number
            expiry_status: string
            avg_cost_paise: number
          }>
        }>
        total_qty_milli: number
        total_value_cost_paise: number
        recent_movements: Array<{
          movement_type: string
          ref_number: string | null
          user_name: string | null
        }>
      }>(await req(shop, 'GET', `/stock/products/${ids.strips}`))
      const main = res.stores.find((s) => s.store_id === shop.store.id)!
      expect(main).toMatchObject({ qty_milli: 40_000, value_cost_paise: 8_300, status: 'ok' })
      expect(
        main.batches.map((b) => [b.batch_no, b.qty_milli, b.expiry_status, b.avg_cost_paise]),
      ).toEqual([
        ['P-OLD', 25_000, 'expired', 2_000],
        ['P-NEW', 15_000, 'expiring', 2_200],
      ])
      expect(res.total_qty_milli).toBe(40_000)
      expect(res.recent_movements).toHaveLength(2)
      expect(res.recent_movements[0]).toMatchObject({
        movement_type: 'opening',
        user_name: shop.owner.user.full_name,
      })
      expect(res.recent_movements[0]?.ref_number).toMatch(/^ADJS1\//)

      const one = dataOf<{ stores: Array<{ store_id: string }> }>(
        await req(shop, 'GET', `/stock/products/${ids.rice}?store_id=${branch.id}`),
      )
      expect(one.stores.map((s) => s.store_id)).toEqual([branch.id])
      expect((await req(shop, 'GET', `/stock/products/${newId()}`)).statusCode).toBe(404)
    })
  })

  describe('GET /stock/movements', () => {
    it('lists movements with balances, users and document numbers, filtered', async () => {
      const res = await req(shop, 'GET', `/stock/movements?product_id=${ids.salt}&sort=created_at`)
      const rows = res.json<{
        data: Array<{
          movement_type: string
          qty_milli: number
          balance_after_milli: number
          value_paise: number | null
          ref_type: string | null
          ref_number: string | null
          user_name: string | null
          store_code: string
        }>
        page: { total: number }
      }>()
      expect(rows.data.map((r) => [r.movement_type, r.qty_milli, r.balance_after_milli])).toEqual([
        ['opening', 2_000, 2_000],
        ['sale', -2_500, -500],
      ])
      expect(rows.data[0]).toMatchObject({
        value_paise: 2_000,
        ref_type: 'stock_adjustment',
        user_name: shop.owner.user.full_name,
        store_code: 'S1',
      })
      expect(rows.data[0]?.ref_number).toMatch(/^ADJS1\//)

      const byType = await req(shop, 'GET', '/stock/movements?type=sale&type=damage')
      expect(
        byType.json<{ data: Array<{ movement_type: string }> }>().data.map((r) => r.movement_type),
      ).toEqual(['sale'])
      const byRef = await req(
        shop,
        'GET',
        `/stock/movements?ref_type=stock_adjustment&ref_id=${ids.opening}`,
      )
      expect(byRef.json<{ page: { total: number } }>().page.total).toBe(5)
      const byStore = await req(shop, 'GET', `/stock/movements?store_id=${branch.id}`)
      expect(byStore.json<{ page: { total: number } }>().page.total).toBe(1)
      const byUser = await req(
        shop,
        'GET',
        `/stock/movements?user_id=${shop.owner.user.id}&limit=1`,
      )
      expect(byUser.json<{ data: unknown[]; page: { total: number } }>()).toMatchObject({
        page: { total: 7 },
      })
      const inRange = await req(shop, 'GET', `/stock/movements?from=${today}&to=${today}`)
      expect(inRange.json<{ page: { total: number } }>().page.total).toBe(7)
      const past = await req(
        shop,
        'GET',
        `/stock/movements?from=${addDays(today, -30)}&to=${addDays(today, -1)}`,
      )
      expect(past.json<{ page: { total: number } }>().page.total).toBe(0)
      const badRange = await req(
        shop,
        'GET',
        `/stock/movements?from=${today}&to=${addDays(today, -1)}`,
      )
      expect(badRange.statusCode).toBe(400)
      expect(errorOf(badRange).details?.issues?.[0]?.message).toBe('date_order')
    })

    it('exports movements as CSV in the user’s language', async () => {
      const res = await req(
        shop,
        'GET',
        `/stock/movements?format=csv&product_id=${ids.salt}&sort=created_at`,
      )
      expect(res.statusCode).toBe(200)
      const lines = res.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n')
      // Default locale of fixture members is Tamil.
      expect(lines[0]?.startsWith('தேதி & நேரம்,கிளை,பொருள்')).toBe(true)
      expect(lines).toHaveLength(3)
      expect(lines[2]).toContain('விற்பனை')
      expect(lines[2]).toContain('-2.5')
    })

    it('scopes movements to the member’s stores and tenant', async () => {
      const scoped = await shop.asRole('inventory_clerk', { store_ids: [branch.id] })
      const res = await req(shop, 'GET', '/stock/movements?limit=200', undefined, { as: scoped })
      const rows = res.json<{ data: Array<{ store_id: string }> }>().data
      expect(rows.length).toBe(1)
      expect(rows.every((r) => r.store_id === branch.id)).toBe(true)
      expect(
        (
          await req(shop, 'GET', `/stock/movements?store_id=${shop.store.id}`, undefined, {
            as: scoped,
          })
        ).statusCode,
      ).toBe(403)
      const foreign = await req(other, 'GET', `/stock/movements?product_id=${ids.salt}`)
      expect(foreign.json<{ page: { total: number } }>().page.total).toBe(0)
    })
  })

  describe('GET /stock/alerts', () => {
    it('counts low, out-of-stock, expiring and expired items with top lists', async () => {
      const res = dataOf<{
        store_id: string
        expiry_warning_days: number
        counts: Record<string, number>
        low_stock: Array<{ name: string }>
        out_of_stock: Array<{ name: string; qty_milli: number }>
        expiring: Array<{ batch_no: string; days_to_expiry: number; value_cost_paise: number }>
        expired: Array<{ batch_no: string; days_to_expiry: number }>
        expiring_value_paise: number
        expired_value_paise: number
      }>(await req(shop, 'GET', '/stock/alerts'))
      expect(res.store_id).toBe(shop.store.id)
      expect(res.expiry_warning_days).toBe(30)
      // Never-stocked products without a reorder level are not alerts.
      expect(res.counts).toEqual({
        low_stock: 1,
        out_of_stock: 0,
        negative: 1,
        expiring: 1,
        expired: 1,
      })
      expect(res.low_stock.map((i) => i.name)).toEqual(['Beta Groundnut Oil'])
      expect(res.out_of_stock.map((i) => [i.name, i.qty_milli])).toEqual([['Gamma Salt', -500]])
      expect(res.expiring.map((i) => [i.batch_no, i.days_to_expiry, i.value_cost_paise])).toEqual([
        ['P-NEW', 20, 3_300],
      ])
      expect(res.expired.map((i) => [i.batch_no, i.days_to_expiry])).toEqual([['P-OLD', -5]])
      expect(res).toMatchObject({ expiring_value_paise: 3_300, expired_value_paise: 5_000 })

      const branchAlerts = dataOf<{ counts: Record<string, number> }>(
        await req(shop, 'GET', `/stock/alerts?store_id=${branch.id}`),
      )
      // Salt has a reorder level but no stock in S2 → out of stock there.
      expect(branchAlerts.counts).toMatchObject({ out_of_stock: 2, expiring: 0, expired: 0 })
      expect((await req(shop, 'GET', '/stock/alerts?limit=0')).statusCode).toBe(400)
      const accountant = await shop.asRole('accountant')
      expect(
        (await req(shop, 'GET', '/stock/alerts', undefined, { as: accountant })).statusCode,
      ).toBe(403)
      const foreign = dataOf<{ counts: Record<string, number> }>(
        await req(other, 'GET', '/stock/alerts'),
      )
      expect(foreign.counts).toEqual({
        low_stock: 0,
        out_of_stock: 0,
        negative: 0,
        expiring: 0,
        expired: 0,
      })
    })
  })

  it('audits nothing for plain reads', async () => {
    expect(await auditActions(t, shop.tenant.id, ids.rice!)).toEqual([])
  })
})
