/**
 * GET /purchases/reorder-suggestions: products at / below reorder level, stock, average daily
 * sales over the 30-day window (net of returns, older sales excluded), suggested quantity
 * max(reorder_qty, 2 × level − stock), open PO quantity, last supplier / cost / date from the
 * latest posted bill line, grouping by supplier, and the filters (supplier, category, q,
 * product_ids, store access).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { postStock } from '../../../core/inventory'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { dataOf, expectError, makeProduct, makeStore, makeSupplier, req } from './fixtures'

interface Item {
  product_id: string
  current_stock_milli: number
  reorder_level_milli: number
  reorder_qty_milli: number | null
  avg_daily_sales_milli: number
  days_of_cover: number | null
  suggested_qty_milli: number
  open_po_qty_milli: number
  last_cost_paise: number | null
  last_bill_date: string | null
  estimated_cost_paise: number
}
interface Suggestions {
  store_id: string
  window_days: number
  groups: {
    supplier: { id: string; name: string } | null
    items: Item[]
    estimated_cost_paise: number
  }[]
}

const today = todayIn('Asia/Kolkata')

describe('purchases: reorder suggestions', () => {
  let t: TestApp
  let shop: TestShop
  let anbu: { id: string; name: string }
  let balaji: { id: string; name: string }
  const p: Record<string, string> = {}
  let category: { root: string; child: string }

  async function buy(
    supplierId: string,
    productId: string,
    qty: number,
    cost: number,
    date = today,
  ) {
    const bill = dataOf<{ id: string }>(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: supplierId,
        store_id: shop.store.id,
        supplier_invoice_no: `R-${newId().slice(-8)}`,
        supplier_invoice_date: date,
        received_date: date,
        lines: [{ product_id: productId, qty_milli: qty, unit_cost_paise: cost }],
      }),
      201,
    )
    dataOf(await req(shop, 'POST', `/purchase-bills/${bill.id}/post`, {}))
  }

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    anbu = await makeSupplier(t, shop.tenant.id, { name: 'Anbu Agencies' })
    balaji = await makeSupplier(t, shop.tenant.id, { name: 'Balaji Traders' })
    const root = newId()
    const child = newId()
    await t.deps.db.systemDb
      .insertInto('categories')
      .values([
        { id: root, tenant_id: shop.tenant.id, name: `Grocery ${root.slice(-4)}`, parent_id: null },
        {
          id: child,
          tenant_id: shop.tenant.id,
          name: `Pulses ${child.slice(-4)}`,
          parent_id: root,
        },
      ])
      .execute()
    category = { root, child }
    p.p1 = (
      await makeProduct(t, shop.tenant.id, {
        name: 'Sugar 1kg',
        reorder_level_milli: 10_000,
        reorder_qty_milli: 25_000,
        gst_rate_bp: 500,
      })
    ).id
    p.p2 = (
      await makeProduct(t, shop.tenant.id, {
        name: 'Moong dal 500g',
        reorder_level_milli: 5_000,
        category_id: child,
      })
    ).id
    p.p3 = (
      await makeProduct(t, shop.tenant.id, { name: 'Salt 1kg', reorder_level_milli: 1_000 })
    ).id
    p.p4 = (await makeProduct(t, shop.tenant.id, { name: 'Jaggery 1kg' })).id
    p.p5 = (
      await makeProduct(t, shop.tenant.id, {
        name: 'Tamarind 250g',
        reorder_level_milli: 2_000,
        purchase_price_paise: 300,
      })
    ).id

    await buy(anbu.id, p.p1, 2_000, 900, addDays(today, -3))
    await buy(balaji.id, p.p1, 2_000, 1_000)
    await buy(anbu.id, p.p2, 1_000, 2_000)
    await buy(anbu.id, p.p3, 5_000, 500)
    await shop.tx((tx) =>
      postStock(tx, shop.ctx, [
        { store_id: shop.store.id, product_id: p.p1!, qty_milli: -1_500, movement_type: 'sale' },
        { store_id: shop.store.id, product_id: p.p1!, qty_milli: -1_000, movement_type: 'sale' },
        {
          store_id: shop.store.id,
          product_id: p.p1!,
          qty_milli: 500,
          movement_type: 'sale_return',
        },
      ]),
    )
    // A sale 40 days ago is outside the 30-day window (raw ledger row with an old timestamp).
    await t.deps.db.systemDb
      .insertInto('stock_movements')
      .values({
        id: newId(),
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        product_id: p.p1,
        movement_type: 'sale',
        qty_milli: -3_000,
        unit_cost_paise: 900,
        balance_after_milli: 0,
        created_at: new Date(Date.now() - 40 * 86_400_000),
      })
      .execute()
    // Open purchase orders: a sent one counts, a draft does not.
    const sent = dataOf<{ id: string }>(
      await req(shop, 'POST', '/purchase-orders', {
        store_id: shop.store.id,
        supplier_id: balaji.id,
        lines: [{ product_id: p.p1, qty_milli: 7_000 }],
      }),
      201,
    )
    dataOf(await req(shop, 'POST', `/purchase-orders/${sent.id}/send`, {}))
    dataOf(
      await req(shop, 'POST', '/purchase-orders', {
        store_id: shop.store.id,
        supplier_id: balaji.id,
        lines: [{ product_id: p.p1, qty_milli: 1_000 }],
      }),
      201,
    )
  })
  afterAll(() => t.close())

  const get = async (qs = ''): Promise<Suggestions> =>
    dataOf<Suggestions>(
      await req(shop, 'GET', `/purchases/reorder-suggestions?store_id=${shop.store.id}${qs}`),
    )

  it('suggests quantities from reorder levels, stock and 30-day sales, grouped by last supplier', async () => {
    const res = await get()
    expect(res.window_days).toBe(30)
    expect(res.groups.map((g) => g.supplier?.name ?? null)).toEqual([
      'Anbu Agencies',
      'Balaji Traders',
      null,
    ])
    const [anbuGroup, balajiGroup, never] = res.groups
    expect(anbuGroup!.items.map((i) => i.product_id)).toEqual([p.p2])
    expect(anbuGroup!.items[0]).toMatchObject({
      current_stock_milli: 1_000,
      reorder_level_milli: 5_000,
      reorder_qty_milli: null,
      avg_daily_sales_milli: 0,
      days_of_cover: null,
      suggested_qty_milli: 9_000, // 2 × 5 − 1
      last_cost_paise: 2_000,
      estimated_cost_paise: 18_000,
    })
    expect(balajiGroup!.items[0]).toMatchObject({
      product_id: p.p1,
      current_stock_milli: 2_000, // 4 bought, 2.5 sold, 0.5 returned
      avg_daily_sales_milli: 67, // 2000 / 30
      days_of_cover: 29,
      suggested_qty_milli: 25_000, // max(25, 2 × 10 − 2)
      open_po_qty_milli: 7_000,
      last_cost_paise: 1_000, // latest bill (Balaji), not the older Anbu one
      last_bill_date: today,
      estimated_cost_paise: 25_000,
    })
    expect(balajiGroup!.estimated_cost_paise).toBe(25_000)
    expect(never!.items[0]).toMatchObject({
      product_id: p.p5,
      current_stock_milli: 0,
      suggested_qty_milli: 4_000,
      last_cost_paise: null,
      estimated_cost_paise: 1_200, // product purchase price × 4
    })
    // Above the level / without a level: not suggested.
    const all = res.groups.flatMap((g) => g.items.map((i) => i.product_id))
    expect(all).not.toContain(p.p3)
    expect(all).not.toContain(p.p4)
  })

  it('filters by supplier, category (with descendants), search and explicit product ids', async () => {
    expect(
      (await get(`&supplier_id=${balaji.id}`)).groups.map((g) => g.items.map((i) => i.product_id)),
    ).toEqual([[p.p1]])
    expect(
      (await get(`&category_id=${category.root}`)).groups.flatMap((g) =>
        g.items.map((i) => i.product_id),
      ),
    ).toEqual([p.p2])
    expect(
      (await get('&q=tamarind')).groups.flatMap((g) => g.items.map((i) => i.product_id)),
    ).toEqual([p.p5])
    const explicit = await get(`&product_ids=${p.p3},${p.p4}`)
    const items = explicit.groups.flatMap((g) => g.items)
    expect(items.map((i) => [i.product_id, i.suggested_qty_milli]).sort()).toEqual(
      [
        [p.p3, 0],
        [p.p4, 0],
      ].sort(),
    )
  })

  it('needs access to the store', async () => {
    const branch = await makeStore(t, shop.tenant.id, 'S9')
    const scoped = await shop.asRole('inventory_clerk', { store_ids: [branch.id] })
    expectError(
      await req(
        shop,
        'GET',
        `/purchases/reorder-suggestions?store_id=${shop.store.id}`,
        undefined,
        { as: scoped },
      ),
      403,
      'FORBIDDEN',
    )
    const own = dataOf<Suggestions>(
      await req(shop, 'GET', `/purchases/reorder-suggestions?store_id=${branch.id}`, undefined, {
        as: scoped,
      }),
    )
    expect(own.store_id).toBe(branch.id)
    // Nothing is stocked at the branch: every product with a reorder level is suggested there.
    const branchItems = own.groups.flatMap((g) => g.items)
    expect(branchItems.find((i) => i.product_id === p.p3)).toMatchObject({
      current_stock_milli: 0,
      suggested_qty_milli: 2_000,
    })
    expectError(await req(shop, 'GET', '/purchases/reorder-suggestions'), 400, 'VALIDATION_ERROR')
  })
})
