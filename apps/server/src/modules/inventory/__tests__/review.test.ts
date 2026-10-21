/**
 * Regression tests from the module review: whole-unit quantities on every stock document,
 * duplicate opening lines that name one batch twice (id + number), and deactivated products
 * that still hold stock staying in the stock list and its valuation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  dataOf,
  errorOf,
  levelOf,
  makeBatch,
  makeProduct,
  makeStore,
  openStock,
  req,
} from './fixtures'

interface StockListBody {
  data: Array<{ product_id: string; qty_milli: number; value_cost_paise: number }>
  totals: { item_count: number; value_cost_paise: number }
}

describe('inventory review regressions', () => {
  let t: TestApp
  let shop: TestShop
  let branch: { id: string; code: string }

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    branch = await makeStore(t, shop.tenant.id, 'S2')
  })
  afterAll(() => t.close())

  const issueOf = (res: Awaited<ReturnType<typeof req>>) => errorOf(res).details?.issues?.[0]

  describe('whole-unit quantities', () => {
    it('refuses fractional pieces on opening stock, adjustments and transfers', async () => {
      const soap = await makeProduct(t, shop.tenant.id, { name: 'Hamam Soap', unit: 'PCS' })

      let res = await req(shop, 'POST', '/stock/opening', {
        store_id: shop.store.id,
        lines: [{ product_id: soap.id, qty_milli: 2_500, unit_cost_paise: 3_000 }],
      })
      expect(res.statusCode).toBe(400)
      expect(issueOf(res)).toMatchObject({
        path: 'lines.0.qty_milli',
        message: 'decimal_qty_not_allowed',
      })

      res = await req(shop, 'POST', '/stock-adjustments', {
        store_id: shop.store.id,
        kind: 'damage',
        lines: [{ product_id: soap.id, qty_delta_milli: -1_500 }],
      })
      expect(res.statusCode).toBe(400)
      expect(issueOf(res)).toMatchObject({
        path: 'lines.0.qty_delta_milli',
        message: 'decimal_qty_not_allowed',
      })

      res = await req(shop, 'POST', '/stock-adjustments', {
        store_id: shop.store.id,
        kind: 'stock_take',
        lines: [{ product_id: soap.id, counted_qty_milli: 4_200 }],
      })
      expect(res.statusCode).toBe(400)
      expect(issueOf(res)).toMatchObject({
        path: 'lines.0.counted_qty_milli',
        message: 'decimal_qty_not_allowed',
      })

      res = await req(shop, 'POST', '/stock-transfers', {
        from_store_id: shop.store.id,
        to_store_id: branch.id,
        lines: [{ product_id: soap.id, qty_milli: 500 }],
      })
      expect(res.statusCode).toBe(400)
      expect(issueOf(res)).toMatchObject({
        path: 'lines.0.qty_milli',
        message: 'decimal_qty_not_allowed',
      })
    })

    it('accepts weighed goods in decimals and checks the received quantity', async () => {
      const rice = await makeProduct(t, shop.tenant.id, { name: 'Ponni Rice', unit: 'KG' })
      const oil = await makeProduct(t, shop.tenant.id, { name: 'Idhayam Oil 1 L', unit: 'PCS' })
      await openStock(shop, shop.store.id, [
        { product_id: rice.id, qty_milli: 25_750, unit_cost_paise: 5_200 },
        { product_id: oil.id, qty_milli: 12_000, unit_cost_paise: 18_000 },
      ])
      expect(await levelOf(t, shop.tenant.id, shop.store.id, rice.id)).toBe(25_750)

      const transfer = dataOf<{ id: string; lines: Array<{ id: string; product_id: string }> }>(
        await req(shop, 'POST', '/stock-transfers', {
          from_store_id: shop.store.id,
          to_store_id: branch.id,
          lines: [
            { product_id: rice.id, qty_milli: 5_250 },
            { product_id: oil.id, qty_milli: 4_000 },
          ],
        }),
        201,
      )
      dataOf(await req(shop, 'POST', `/stock-transfers/${transfer.id}/dispatch`))
      const oilLine = transfer.lines.find((l) => l.product_id === oil.id)!
      const riceLine = transfer.lines.find((l) => l.product_id === rice.id)!

      let res = await req(shop, 'POST', `/stock-transfers/${transfer.id}/receive`, {
        lines: [{ line_id: oilLine.id, received_qty_milli: 3_500 }],
        shortfall_reason: 'Leaked in transit',
      })
      expect(res.statusCode).toBe(400)
      expect(issueOf(res)).toMatchObject({
        path: 'lines.0.received_qty_milli',
        message: 'decimal_qty_not_allowed',
      })

      res = await req(shop, 'POST', `/stock-transfers/${transfer.id}/receive`, {
        lines: [
          { line_id: oilLine.id, received_qty_milli: 3_000 },
          { line_id: riceLine.id, received_qty_milli: 5_100 },
        ],
        shortfall_reason: 'மூட்டை கிழிந்தது, ஒரு பாட்டில் உடைந்தது',
      })
      expect(res.statusCode).toBe(200)
      // Movement reasons keep the user's words as typed (no English prefixes in a Tamil UI).
      const moves = (
        await req(shop, 'GET', `/stock/movements?ref_type=stock_transfer&ref_id=${transfer.id}`)
      ).json<{ data: Array<{ movement_type: string; reason: string | null }> }>().data
      const shortReasons = moves.filter((m) => m.movement_type === 'damage').map((m) => m.reason)
      expect(shortReasons).toEqual([
        'மூட்டை கிழிந்தது, ஒரு பாட்டில் உடைந்தது',
        'மூட்டை கிழிந்தது, ஒரு பாட்டில் உடைந்தது',
      ])
      expect(await levelOf(t, shop.tenant.id, branch.id, rice.id)).toBe(5_100)
      expect(await levelOf(t, shop.tenant.id, branch.id, oil.id)).toBe(3_000)
    })
  })

  it('reports an opening line naming the same batch by id and by number as a duplicate', async () => {
    const syrup = await makeProduct(t, shop.tenant.id, {
      name: 'Benadryl Syrup',
      unit: 'BTL',
      track_batches: true,
    })
    const batch = await makeBatch(t, shop.tenant.id, syrup.id, { batch_no: 'BN2407' })
    const res = await req(shop, 'POST', '/stock/opening', {
      store_id: shop.store.id,
      lines: [
        { product_id: syrup.id, qty_milli: 4_000, unit_cost_paise: 9_000, batch_id: batch.id },
        {
          product_id: syrup.id,
          qty_milli: 2_000,
          unit_cost_paise: 9_000,
          batch: { batch_no: 'bn2407' },
        },
      ],
    })
    expect(res.statusCode).toBe(400)
    expect(issueOf(res)).toMatchObject({ path: 'lines.1.product_id', message: 'duplicate_line' })
    expect(await levelOf(t, shop.tenant.id, shop.store.id, syrup.id)).toBe(0)
  })

  it('keeps deactivated products that still hold stock in the list and its value', async () => {
    const own = await createTestTenant(t)
    const live = await makeProduct(t, own.tenant.id, { name: 'Aachi Masala' })
    const retired = await makeProduct(t, own.tenant.id, { name: 'Old Pickle Jar' })
    const empty = await makeProduct(t, own.tenant.id, { name: 'Discontinued Agarbathi' })
    await openStock(own, own.store.id, [
      { product_id: live.id, qty_milli: 10_000, unit_cost_paise: 4_000 },
      { product_id: retired.id, qty_milli: 3_000, unit_cost_paise: 12_000 },
    ])
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ is_active: false })
      .where('id', 'in', [retired.id, empty.id])
      .execute()

    const list = await req(own, 'GET', `/stock?store_id=${own.store.id}`)
    expect(list.statusCode).toBe(200)
    const listed = list.json<StockListBody>()
    expect(listed.data.map((r) => r.product_id).sort()).toEqual([live.id, retired.id].sort())
    // 10 × ₹40 + 3 × ₹120: the deactivated product's stock is still valued.
    expect(listed.totals).toMatchObject({ item_count: 2, value_cost_paise: 76_000 })

    const all = (
      await req(own, 'GET', `/stock?store_id=${own.store.id}&include_inactive=true`)
    ).json<StockListBody>()
    expect(all.data.map((r) => r.product_id)).toContain(empty.id)
    expect(all.totals.item_count).toBe(3)
  })
})
