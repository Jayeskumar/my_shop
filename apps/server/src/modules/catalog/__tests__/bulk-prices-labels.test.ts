/**
 * Bulk update, store prices (feature store_pricing), barcode labels (feature barcode_labels),
 * units and the HSN directory.
 */
import { newId } from '@kadai/shared'
import type {
  HsnEntry,
  LabelPrintModel,
  ProductBulkUpdateResult,
  ProductDetail,
  StorePriceRow,
  UnitsResponse,
  VariantGenerateResult,
} from '@kadai/shared/api/catalog'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import {
  type TestShop,
  type TestShopMember,
  createTestTenant,
  insertTestBatch,
} from '../../../test/tenants'
import { createProduct, dataOf, errorOf, expectIssue, req, uniq } from './helpers'

let t: TestApp
let shop: TestShop
let cashier: TestShopMember

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t, { business_type: 'apparel' })
  cashier = await shop.asRole('cashier')
})
afterAll(() => t.close())

describe('bulk update', () => {
  it('changes GST, category, status and prices in one audited transaction', async () => {
    const api = req(shop)
    const a = await createProduct(shop, {
      sale_price_paise: 9950,
      mrp_paise: 12000,
      gst_rate_bp: 500,
    })
    const b = await createProduct(shop, {
      sale_price_paise: 11000,
      mrp_paise: 11500,
      gst_rate_bp: 500,
    })
    const cat = dataOf<{ id: string }>(await api.post('/categories', { name: uniq('Bulk ') }), 201)
    const missing = newId()
    const res = dataOf<ProductBulkUpdateResult>(
      await api.post('/products/bulk-update', {
        ids: [a.id, b.id, missing],
        set: {
          gst_rate_bp: 1800,
          category_id: cat.id,
          price_change: { mode: 'percent', percent_bp: 1000, round_to_rupee: true },
        },
      }),
    )
    expect(res).toEqual({
      matched: 2,
      updated: 2,
      unchanged: 0,
      capped_at_mrp: 1,
      not_found: [missing],
    })
    const pa = dataOf<ProductDetail>(await api.get(`/products/${a.id}`))
    const pb = dataOf<ProductDetail>(await api.get(`/products/${b.id}`))
    expect(pa).toMatchObject({ sale_price_paise: 10900, gst_rate_bp: 1800, category_id: cat.id }) // 99.50 + 10% = 109.45 → ₹109
    expect(pb.sale_price_paise).toBe(11500) // capped at MRP
    const audits = await shop.tx((tx) =>
      tx
        .selectFrom('audit_logs')
        .select(['action', 'changes'])
        .where('action', '=', 'product.bulk_update')
        .execute(),
    )
    expect(audits.length).toBeGreaterThan(0)
    const again = dataOf<ProductBulkUpdateResult>(
      await api.post('/products/bulk-update', { ids: [a.id], set: { gst_rate_bp: 1800 } }),
    )
    expect(again).toMatchObject({ updated: 0, unchanged: 1 })
  })

  it('applies a retried price change once (Idempotency-Key)', async () => {
    const p = await createProduct(shop, { sale_price_paise: 10_000, mrp_paise: 20_000 })
    const body = {
      ids: [p.id],
      set: { price_change: { mode: 'percent', percent_bp: 1000 } },
    }
    const headers = { 'idempotency-key': newId() }
    const first = await req(shop).post('/products/bulk-update', body, { headers })
    const retry = await req(shop).post('/products/bulk-update', body, { headers })
    expect(first.statusCode).toBe(200)
    expect(retry.statusCode).toBe(200)
    expect(retry.headers['idempotent-replayed']).toBe('true')
    expect(retry.json()).toEqual(first.json())
    const after = dataOf<ProductDetail>(await req(shop).get(`/products/${p.id}`))
    expect(after.sale_price_paise).toBe(11_000) // +10% once, not 12,100
  })

  it('validates the body, references and permissions', async () => {
    const api = req(shop)
    const p = await createProduct(shop, {})
    expectIssue(await api.post('/products/bulk-update', { ids: [p.id], set: {} }), 'empty_patch')
    expectIssue(
      await api.post('/products/bulk-update', { ids: [p.id, p.id], set: { is_active: false } }),
      'duplicate_id',
    )
    expectIssue(
      await api.post('/products/bulk-update', {
        ids: [p.id],
        set: { price_change: { mode: 'percent', percent_bp: 0 } },
      }),
      'price_change_zero',
    )
    expectIssue(
      await api.post('/products/bulk-update', { ids: [p.id], set: { brand_id: newId() } }),
      'reference_not_found',
      'set.brand_id',
    )
    const tooMany = Array.from({ length: 501 }, () => newId())
    expect(
      (await api.post('/products/bulk-update', { ids: tooMany, set: { is_active: false } }))
        .statusCode,
    ).toBe(400)
    expect(
      (
        await api.post(
          '/products/bulk-update',
          { ids: [p.id], set: { is_active: false } },
          { as: cashier },
        )
      ).statusCode,
    ).toBe(403)
  })
})

describe('store prices', () => {
  it('lists and bulk upserts / deletes overrides of a store', async () => {
    const api = req(shop)
    const tag = uniq('sp')
    const a = await createProduct(shop, {
      name: `Saree ${tag}`,
      sale_price_paise: 50000,
      mrp_paise: 60000,
    })
    const b = await createProduct(shop, { name: `Towel ${tag}`, sale_price_paise: 20000 })
    const put = dataOf<{ upserted: number; deleted: number }>(
      await api.put('/store-prices', {
        store_id: shop.store.id,
        upserts: [
          { product_id: a.id, sale_price_paise: 48000 },
          { product_id: b.id, sale_price_paise: 19000, mrp_paise: 21000 },
        ],
      }),
    )
    expect(put).toEqual({ upserted: 2, deleted: 0 })
    const list = await api.get(
      `/store-prices?store_id=${shop.store.id}&q=${tag}&overrides_only=true`,
    )
    const rows = list.json<{ data: StorePriceRow[] }>().data
    expect(rows.map((r) => [r.name, r.store_sale_price_paise])).toEqual([
      [`Saree ${tag}`, 48000],
      [`Towel ${tag}`, 19000],
    ])
    expect(rows[0]).toMatchObject({ base_sale_price_paise: 50000, base_mrp_paise: 60000 })
    const del = dataOf<{ upserted: number; deleted: number }>(
      await api.put('/store-prices', {
        store_id: shop.store.id,
        upserts: [{ product_id: a.id, sale_price_paise: 47000 }],
        deletes: [b.id],
      }),
    )
    expect(del).toEqual({ upserted: 1, deleted: 1 })
    const after = await api.get(`/store-prices?store_id=${shop.store.id}&q=${tag}`)
    expect(
      after.json<{ data: StorePriceRow[] }>().data.map((r) => r.store_sale_price_paise),
    ).toEqual([47000, null])

    expectIssue(
      await api.put('/store-prices', {
        store_id: shop.store.id,
        upserts: [{ product_id: a.id, sale_price_paise: 70000 }],
      }),
      'mrp_below_sale_price',
    )
    expectIssue(
      await api.put('/store-prices', {
        store_id: shop.store.id,
        upserts: [{ product_id: a.id, sale_price_paise: 1 }],
        deletes: [a.id],
      }),
      'store_price_conflict',
    )
    expectIssue(await api.put('/store-prices', { store_id: shop.store.id }), 'empty_patch')
    expectIssue(
      await api.put('/store-prices', {
        store_id: newId(),
        upserts: [{ product_id: a.id, sale_price_paise: 1 }],
      }),
      'reference_not_found',
      'store_id',
    )
  })

  it('is gated by feature store_pricing and store scope', async () => {
    const growth = await createTestTenant(t, { plan_code: 'growth' })
    const res = await req(growth).get(`/store-prices?store_id=${growth.store.id}`)
    expect(res.statusCode).toBe(402)
    expect(errorOf(res).details?.feature).toBe('store_pricing')
    const scoped = await shop.asRole('manager', { store_ids: [newId()] })
    expect(
      (await req(shop).get(`/store-prices?store_id=${shop.store.id}`, { as: scoped })).statusCode,
    ).toBe(403)
  })
})

describe('labels', () => {
  it('returns the print model with prices, batches, variants and generated barcodes', async () => {
    const api = req(shop)
    const parent = await createProduct(shop, {
      name: 'Polo',
      sale_price_paise: 79900,
      mrp_paise: 99900,
    })
    const gen = dataOf<VariantGenerateResult>(
      await api.post(`/products/${parent.id}/variants`, { axes: { size: ['M'], color: ['Navy'] } }),
    )
    const variant = gen.created[0]!
    const plain = await createProduct(shop, {
      name: 'Belt',
      sale_price_paise: 25000,
      barcodes: [{ barcode: uniq('BELT') }],
    })
    const batch = await insertTestBatch(t.deps, shop.tenant.id, plain.id, {
      expiry_date: '2027-03-31',
    })
    await t.deps.db.systemDb
      .updateTable('batches')
      .set({ mrp_paise: 30000, sale_price_paise: 24000 })
      .where('id', '=', batch.id)
      .execute()
    await api.put('/store-prices', {
      store_id: shop.store.id,
      upserts: [{ product_id: variant.id, sale_price_paise: 75000 }],
    })
    const model = dataOf<LabelPrintModel>(
      await api.post('/labels', {
        template: '50x25',
        store_id: shop.store.id,
        generate_missing_barcodes: true,
        items: [
          { product_id: variant.id, copies: 3 },
          { product_id: plain.id, batch_id: batch.id, copies: 2 },
        ],
      }),
    )
    expect(model.template).toMatchObject({ code: '50x25', label_width_mm: 50 })
    expect(model.total_copies).toBe(5)
    expect(model.labels[0]).toMatchObject({
      product_id: variant.id,
      price_paise: 75000,
      mrp_paise: 99900,
      size: 'M',
      color: 'Navy',
      variant_label: 'M / Navy',
      barcode_generated: true,
      barcode_format: 'EAN13',
      copies: 3,
    })
    expect(model.labels[1]).toMatchObject({
      batch_no: batch.batch_no,
      expiry_date: '2027-03-31',
      price_paise: 24000,
      mrp_paise: 30000,
      barcode_generated: false,
      barcode_format: 'CODE128',
    })
    const parentLabel = await api.post('/labels', {
      template: '38x25',
      items: [{ product_id: parent.id }],
    })
    expect(parentLabel.statusCode).toBe(422)
    expectIssue(
      await api.post('/labels', {
        template: 'a4_65',
        items: [{ product_id: plain.id, batch_id: newId() }],
      }),
      'reference_not_found',
      'items.0.batch_id',
    )
    expectIssue(
      await api.post('/labels', {
        template: 'a4_65',
        items: [
          { product_id: plain.id, copies: 5000 },
          { product_id: plain.id, copies: 1 },
        ],
      }),
      'label_copies_limit',
    )
  })

  it('cashiers may print but not generate barcodes; feature barcode_labels', async () => {
    const p = await createProduct(shop, { generate_barcode: false })
    const ok = await req(shop).post(
      '/labels',
      { template: '38x25', items: [{ product_id: p.id }] },
      { as: cashier },
    )
    expect(ok.statusCode).toBe(200)
    expect(dataOf<LabelPrintModel>(ok).labels[0]!.barcode).toBeNull()
    const gen = await req(shop).post(
      '/labels',
      { template: '38x25', items: [{ product_id: p.id }], generate_missing_barcodes: true },
      { as: cashier },
    )
    expect(gen.statusCode).toBe(403)
    const free = await createTestTenant(t, { plan_code: 'free' })
    const fp = await createProduct(free, {})
    const gated = await req(free).post('/labels', {
      template: '38x25',
      items: [{ product_id: fp.id }],
    })
    expect(errorOf(gated)).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      details: { feature: 'barcode_labels' },
    })
  })
})

describe('units & HSN', () => {
  it('lists units with the vertical suggestions', async () => {
    const res = dataOf<UnitsResponse>(await req(shop).get('/units', { as: cashier }))
    expect(res.units.some((u) => u.code === 'KG' && u.decimal_allowed)).toBe(true)
    expect(res.suggested.length).toBeGreaterThan(0)
  })

  it('searches HSN codes by prefix and by words', async () => {
    const byCode = dataOf<HsnEntry[]>(await req(shop).get('/hsn/search?q=1006'))
    expect(byCode[0]!.code).toBe('1006')
    expect(byCode.every((e) => e.code.startsWith('1006'))).toBe(true)
    const words = dataOf<HsnEntry[]>(await req(shop).get('/hsn/search?q=cotton%20saree&limit=5'))
    expect(words.length).toBeGreaterThan(0)
    expect(words[0]!.description.toLowerCase()).toContain('cotton')
    const garments = dataOf<HsnEntry[]>(await req(shop).get('/hsn/search?q=6205'))
    expect(garments[0]).toMatchObject({ gst_rate_bp: null, slab_rule_hint: 'apparel_2500' })
    expect(dataOf<HsnEntry[]>(await req(shop).get('/hsn/search?q=zzzzzz'))).toEqual([])
    expect((await req(shop).get('/hsn/search')).statusCode).toBe(400)
  })
})
