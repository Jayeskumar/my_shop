/**
 * StockSense end to end through the API: imported sales history (CSV) + stock from posted
 * bills / opening batches + supplier lead time and product shelf life (settings route) → the
 * ranked plan, shelf-life cap, expiry risk, slow stock, no-history fallback and the product
 * detail. Numbers are worked out in the comments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import type { StockSenseProduct, StockSenseReport } from '@kadai/shared/api/purchases'
import { postStock } from '../../../core/inventory'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { dataOf, makeBatch, makeProduct, makeSupplier, req } from './fixtures'

const today = todayIn('Asia/Kolkata')

describe('purchases: StockSense', () => {
  let t: TestApp
  let shop: TestShop
  let anbu: { id: string; name: string }
  const p: Record<string, string> = {}

  async function buy(productId: string, qty: number, cost: number) {
    const bill = dataOf<{ id: string }>(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: anbu.id,
        store_id: shop.store.id,
        supplier_invoice_no: `S-${newId().slice(-8)}`,
        supplier_invoice_date: today,
        received_date: today,
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
    const make = async (key: string, opts: Parameters<typeof makeProduct>[2]) => {
      p[key] = (await makeProduct(t, shop.tenant.id, { sku: key.toUpperCase(), ...opts })).id
    }
    await make('rice', { name: 'Ponni rice 1kg', sale_price_paise: 6_300, gst_rate_bp: 500 })
    await make('milk', { name: 'Aavin milk 500ml', sale_price_paise: 3_000, gst_rate_bp: 0 })
    await make('soap', { name: 'Neem soap', sale_price_paise: 4_000, gst_rate_bp: 1800 })
    await make('tab', {
      name: 'Paracetamol 500',
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
      sale_price_paise: 3_000,
      gst_rate_bp: 1200,
    })
    await make('new', {
      name: 'Rava 500g',
      sale_price_paise: 4_500,
      purchase_price_paise: 3_000,
      reorder_level_milli: 5_000,
      reorder_qty_milli: 12_000,
    })

    await buy(p.rice!, 5_000, 4_500)
    await buy(p.milk!, 10_000, 2_500)
    await buy(p.soap!, 500_000, 2_000)
    const near = await makeBatch(t, shop.tenant.id, p.tab!, {
      batch_no: 'NEAR',
      expiry_date: addDays(today, 5),
    })
    const far = await makeBatch(t, shop.tenant.id, p.tab!, {
      batch_no: 'FAR',
      expiry_date: addDays(today, 400),
    })
    await shop.tx((tx) =>
      postStock(tx, shop.ctx, [
        {
          store_id: shop.store.id,
          product_id: p.tab!,
          batch_id: near.id,
          qty_milli: 100_000,
          movement_type: 'opening',
          unit_cost_paise: 2_000,
        },
        {
          store_id: shop.store.id,
          product_id: p.tab!,
          batch_id: far.id,
          qty_milli: 50_000,
          movement_type: 'opening',
          unit_cost_paise: 2_000,
        },
      ]),
    )

    // 28 days of past sales, flat: rice 4/day, milk 20, soap 1, tablets 5.
    const rows = ['product,date,qty']
    for (let d = 1; d <= 28; d++) {
      const date = addDays(today, -d)
      rows.push(`RICE,${date},4`, `MILK,${date},20`, `SOAP,${date},1`, `TAB,${date},5`)
    }
    const imported = dataOf<{ imported_rows: number; skipped_count: number }>(
      await req(
        shop,
        'POST',
        '/purchases/sales-history',
        { store_id: shop.store.id, csv: rows.join('\n') },
        { headers: { 'idempotency-key': newId() } },
      ),
    )
    expect(imported).toMatchObject({ imported_rows: 112, skipped_count: 0 })

    const settings = dataOf<{ suppliers: number; products: number }>(
      await shop.inject({
        method: 'PUT',
        url: '/api/v1/purchases/stocksense/settings',
        payload: {
          suppliers: [{ supplier_id: anbu.id, lead_time_days: 2 }],
          products: [{ product_id: p.milk!, shelf_life_days: 2 }],
        },
      }),
    )
    expect(settings).toEqual({ suppliers: 1, products: 1 })
  })

  afterAll(async () => {
    await t?.close()
  })

  async function report(query = '') {
    return dataOf<StockSenseReport>(
      await req(shop, 'GET', `/purchases/stocksense?store_id=${shop.store.id}${query}`),
    )
  }

  it('ranks what runs out before delivery first, with exact quantities', async () => {
    const r = await report()
    const by = new Map(r.items.map((i) => [i.product_id, i]))
    const rice = by.get(p.rice!)!
    // 4/day; 5 on hand lasts 1 day < 2-day lead time. Order 4 × (2 + 7 + 2) − 5 = 39.
    expect(rice).toMatchObject({
      daily_milli: 4_000,
      lead_time_days: 2,
      cover_days: 1,
      priority: 'urgent',
      reason: 'stockout_before_delivery',
      order_qty_milli: 39_000,
      has_history: true,
      observed_days: 28,
    })
    expect(rice.supplier).toMatchObject({ id: anbu.id, lead_time_days: 2 })

    // Milk: 20/day, 2-day shelf life → only what sells in the 2 days after delivery (40).
    const milk = by.get(p.milk!)!
    expect(milk).toMatchObject({
      priority: 'urgent',
      uncapped_qty_milli: 210_000,
      order_qty_milli: 40_000,
      capped_by_shelf_life: true,
    })

    // Soap: 500 on hand at 1/day — nothing to buy, 410 beyond 90 days of sales.
    const soap = by.get(p.soap!)!
    expect(soap).toMatchObject({ order_qty_milli: 0, priority: 'ok', reason: 'covered' })
    expect(soap.excess_milli).toBe(410_000)
    expect(soap.excess_value_paise).toBe(820_000)

    // Tablets: 5/day; batch NEAR (100, expires in 5 days) sells 30 by then → 70 at risk.
    const tab = by.get(p.tab!)!
    expect(tab.expiry_risk_milli).toBe(70_000)
    expect(tab.lead_time_days).toBe(3)
    const near = r.expiry_batches.find((b) => b.batch_no === 'NEAR')!
    expect(near).toMatchObject({ at_risk_milli: 70_000, days_left: 5, at_risk_value_paise: 14_000 })

    // No history: reorder level / quantity decide.
    expect(by.get(p.new!)).toMatchObject({
      has_history: false,
      reason: 'reorder_level',
      order_qty_milli: 12_000,
      priority: 'high',
    })

    const ranked = r.items.map((i) => i.product_id)
    expect(ranked.slice(0, 2).sort()).toEqual([p.rice!, p.milk!].sort())
    expect(r.items[0]!.rank).toBe(1)
    expect(r.summary).toMatchObject({ urgent: 2, order_lines: 3, slow_items: 1, expiry_items: 1 })
    expect(r.summary.order_cost_paise).toBe(39 * 4_500 + 40 * 2_500 + 12 * 3_000)
    expect(r.imported_days).toBe(28)
  })

  it('follows the plan inputs (default lead time, cycle, safety, window)', async () => {
    const r = await report('&lead_time_days=5&cycle_days=3&safety_days=0&window_days=7')
    const tab = r.items.find((i) => i.product_id === p.tab!)!
    expect(r.params).toMatchObject({ lead_time_days: 5, cycle_days: 3, window_days: 7 })
    expect(tab.lead_time_days).toBe(5)
    // Supplier lead time still wins for rice.
    expect(r.items.find((i) => i.product_id === p.rice!)!.lead_time_days).toBe(2)
  })

  it('explains one product day by day', async () => {
    const d = dataOf<StockSenseProduct>(
      await req(shop, 'GET', `/purchases/stocksense/products/${p.rice}?store_id=${shop.store.id}`),
    )
    expect(d.history).toHaveLength(30)
    expect(d.history.at(-1)).toMatchObject({ date: addDays(today, -1), sold_milli: 4_000 })
    expect(d.forecast).toHaveLength(2 + 7 + 2)
    expect(d.forecast[0]).toMatchObject({
      date: today,
      demand_milli: 4_000,
      projected_stock_milli: 1_000,
    })
    expect(d.weekday_factors).toHaveLength(7)
  })

  it('404s for an unknown product', async () => {
    const res = await req(
      shop,
      'GET',
      `/purchases/stocksense/products/${newId()}?store_id=${shop.store.id}`,
    )
    expect(res.statusCode).toBe(404)
  })

  it('serves reorder-suggestions in forecast mode without GROUP BY errors', async () => {
    const res = await req(
      shop,
      'GET',
      `/purchases/reorder-suggestions?store_id=${shop.store.id}&lead_time_days=7&model=smart`,
    )
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { forecast: boolean; model: string; groups: unknown[] } }>()
    expect(body.data.forecast).toBe(true)
    expect(body.data.model).toBe('smart')
    expect(body.data.groups.length).toBeGreaterThan(0)
  })
})
