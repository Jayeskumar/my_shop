/**
 * Variant generation (cartesian product, names / SKUs / Tamil names, price overrides, idempotency,
 * feature gating, propagation from the parent), barcodes (add / generate / delete, checksums,
 * per-tenant uniqueness) and the scan lookup precedence (barcode → SKU → scale barcode).
 */
import { DEFAULT_SETTINGS, makeEan13, makeScaleBarcode, newId } from '@kadai/shared'
import type {
  ProductBarcode,
  ProductDetail,
  ProductLookupResult,
  VariantGenerateResult,
} from '@kadai/shared/api/catalog'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postStock } from '../../../core/inventory'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { createProduct, dataOf, errorOf, expectIssue, req, uniq } from './helpers'

let t: TestApp
let textile: TestShop
let grocer: TestShop

beforeAll(async () => {
  t = await buildTestApp()
  textile = await createTestTenant(t, { business_type: 'apparel' })
  grocer = await createTestTenant(t, {
    settings: { pos: { scale_barcode: { enabled: true } } },
  })
})
afterAll(() => t.close())

describe('variants', () => {
  it('creates the size × colour matrix with names, SKUs, prices and barcodes; idempotent', async () => {
    const api = req(textile)
    const brand = dataOf<{ id: string }>(await api.post('/brands', { name: uniq('Ramraj ') }), 201)
    const sku = uniq('SHIRT')
    const parent = await createProduct(textile, {
      name: 'Cotton Shirt',
      name_ta: 'பருத்தி சட்டை',
      sku,
      brand_id: brand.id,
      hsn_code: '6205',
      gst_rate_bp: 500,
      sale_price_paise: 1200,
      mrp_paise: 1500,
      attributes: { fabric: 'Cotton' },
    })
    const body = {
      axes: { size: ['S', 'M'], color: ['Red', 'Blue'] },
      value_labels_ta: { color: { Red: 'சிவப்பு', Blue: 'நீலம்' } },
      price_overrides: [{ match: { size: 'M' }, sale_price_paise: 1400 }],
      generate_barcodes: true,
    }
    const first = dataOf<VariantGenerateResult>(
      await api.post(`/products/${parent.id}/variants`, body),
    )
    expect(first.created).toHaveLength(4)
    expect(first.skipped).toEqual([])
    const mRed = first.created.find(
      (v) => v.variant_attributes.size === 'M' && v.variant_attributes.color === 'Red',
    )!
    expect(mRed).toMatchObject({
      name: 'Cotton Shirt - M / Red',
      name_ta: 'பருத்தி சட்டை - M / சிவப்பு',
      sku: `${sku}-M-RED`,
      sale_price_paise: 1400,
      mrp_paise: 1500,
    })
    expect(mRed.primary_barcode).toMatch(/^20\d{11}$/)
    expect(first.created.find((v) => v.variant_attributes.size === 'S')!.sale_price_paise).toBe(
      1200,
    )
    expect(first.parent).toMatchObject({
      kind: 'variant_parent',
      variant_axes: ['size', 'color'],
      track_inventory: false,
    })
    expect(first.parent.variants).toHaveLength(4)

    const child = dataOf<ProductDetail>(await api.get(`/products/${mRed.id}`))
    expect(child).toMatchObject({
      kind: 'variant',
      parent_id: parent.id,
      brand_id: brand.id,
      hsn_code: '6205',
      gst_rate_bp: 500,
      track_inventory: true,
      attributes: { fabric: 'Cotton' },
    })
    expect(child.parent?.id).toBe(parent.id)

    const again = dataOf<VariantGenerateResult>(
      await api.post(`/products/${parent.id}/variants`, body),
    )
    expect(again.created).toEqual([])
    expect(again.skipped).toHaveLength(4)
    // Case-insensitive identity; new values add only the missing combinations.
    const more = dataOf<VariantGenerateResult>(
      await api.post(`/products/${parent.id}/variants`, {
        axes: { size: ['s', 'M', 'L'], color: ['red', 'Blue'] },
      }),
    )
    expect(more.created.map((v) => v.name).sort()).toEqual([
      'Cotton Shirt - L / Blue',
      'Cotton Shirt - L / red',
    ])
    expect(more.skipped).toHaveLength(4)
    expect(more.parent.variants).toHaveLength(6)

    const listed = await api.get(`/products?parent_id=${parent.id}&limit=50`)
    expect(listed.json<{ page: { total: number } }>().page.total).toBe(6)
    const parents = await api.get(`/products?ids=${parent.id}&ids=${mRed.id}&hide_variants=true`)
    const rows = parents.json<{ data: Array<{ id: string; variant_count: number }> }>().data
    expect(rows.map((r) => [r.id, r.variant_count])).toEqual([[parent.id, 6]])
    const kinds = await api.get(`/products?kind=variant&parent_id=${parent.id}&limit=1`)
    expect(kinds.json<{ page: { total: number } }>().page.total).toBe(6)

    expectIssue(
      await api.post(`/products/${parent.id}/variants`, { axes: { size: ['XL'] } }),
      'variant_axes_mismatch',
      'axes',
    )
    expectIssue(
      await api.post(`/products/${parent.id}/variants`, {
        axes: { size: ['XL'], color: ['Red'] },
        price_overrides: [{ match: { fit: 'slim' }, sale_price_paise: 1 }],
      }),
      'variant_override_match',
    )
    const ofVariant = await api.post(`/products/${mRed.id}/variants`, { axes: { size: ['S'] } })
    expect(ofVariant.statusCode).toBe(422)
    expect(errorOf(ofVariant).details?.reason).toBe('product_kind')
  })

  it('parent changes propagate to the variants (tax, status, names)', async () => {
    const api = req(textile)
    const parent = await createProduct(textile, { name: 'Kurti', gst_rate_bp: 500 })
    const gen = dataOf<VariantGenerateResult>(
      await api.post(`/products/${parent.id}/variants`, { axes: { size: ['S', 'M'] } }),
    )
    await api.patch(`/products/${parent.id}`, { gst_rate_bp: 1800, name: 'Cotton Kurti' })
    const v = dataOf<ProductDetail>(await api.get(`/products/${gen.created[0]!.id}`))
    expect(v.gst_rate_bp).toBe(1800)
    expect(v.name).toBe('Cotton Kurti - S')
    await api.patch(`/products/${parent.id}`, { is_active: false })
    const off = dataOf<ProductDetail>(await api.get(`/products/${gen.created[1]!.id}`))
    expect(off.is_active).toBe(false)
  })

  it('a product that gets variants hands in its barcodes (it is not sold itself)', async () => {
    const api = req(textile)
    const code = makeEan13(`890${String(Date.now()).slice(-9)}`)
    const p = await createProduct(textile, { barcodes: [{ barcode: code }] })
    const gen = dataOf<VariantGenerateResult>(
      await api.post(`/products/${p.id}/variants`, { axes: { size: ['S', 'M'] } }),
    )
    expect(gen.parent).toMatchObject({
      kind: 'variant_parent',
      barcodes: [],
      primary_barcode: null,
    })
    // The code is free again — e.g. for one of the variants.
    const moved = await api.post(`/products/${gen.created[0]!.id}/barcodes`, { barcode: code })
    expect(moved.statusCode, moved.body).toBe(201)
    const lookup = dataOf<ProductLookupResult>(await api.get(`/products/lookup?code=${code}`))
    expect(lookup.product.id).toBe(gen.created[0]!.id)
  })

  it('refuses a stocked standard product and is gated by feature variants', async () => {
    const stocked = await createProduct(textile, {})
    await textile.tx((tx) =>
      postStock(tx, textile.ctx, [
        {
          store_id: textile.store.id,
          product_id: stocked.id,
          qty_milli: 1000,
          movement_type: 'opening',
          unit_cost_paise: 10,
        },
      ]),
    )
    const res = await req(textile).post(`/products/${stocked.id}/variants`, {
      axes: { size: ['S'] },
    })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).details?.reason).toBe('product_in_use')

    const free = await createTestTenant(t, { business_type: 'apparel', plan_code: 'free' })
    const p = await createProduct(free, {})
    const gated = await req(free).post(`/products/${p.id}/variants`, { axes: { size: ['S'] } })
    expect(gated.statusCode).toBe(402)
    expect(errorOf(gated)).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      details: { feature: 'variants' },
    })
    const cashier = await textile.asRole('cashier')
    const parent = await createProduct(textile, {})
    expect(
      (
        await req(textile).post(
          `/products/${parent.id}/variants`,
          { axes: { size: ['S'] } },
          { as: cashier },
        )
      ).statusCode,
    ).toBe(403)
  })
})

describe('barcodes', () => {
  it('adds case barcodes, generates internal codes and deletes; bumps updated_at', async () => {
    const api = req(grocer)
    const p = await createProduct(grocer, {})
    const code = makeEan13(`89${String(Date.now()).slice(-10)}`)
    const added = dataOf<ProductBarcode>(
      await api.post(`/products/${p.id}/barcodes`, { barcode: code, qty_milli: 12000 }),
      201,
    )
    expect(added).toMatchObject({ barcode: code, qty_milli: 12000, is_internal: false })
    const generated = dataOf<ProductBarcode>(
      await api.post(`/products/${p.id}/barcodes`, { generate: true }),
      201,
    )
    expect(generated.is_internal).toBe(true)
    const detail = dataOf<ProductDetail>(await api.get(`/products/${p.id}`))
    expect(detail.barcodes.map((b) => b.barcode)).toEqual([code, generated.barcode])
    expect(new Date(detail.updated_at).getTime()).toBeGreaterThan(new Date(p.updated_at).getTime())

    const taken = await api.post(`/products/${p.id}/barcodes`, { barcode: code })
    expect(taken.statusCode).toBe(409)
    expect(errorOf(taken).details?.reason).toBe('barcode_taken')
    expectIssue(
      await api.post(`/products/${p.id}/barcodes`, { barcode: '012345678906' }),
      'barcode_checksum',
    )
    expectIssue(
      await api.post(`/products/${p.id}/barcodes`, { barcode: uniq('C'), qty_milli: 1500 }),
      'barcode_qty_whole',
    )
    expectIssue(
      await api.post(`/products/${p.id}/barcodes`, { barcode: uniq('C'), generate: true }),
      'barcode_or_generate',
    )
    expect((await api.del(`/products/${p.id}/barcodes/${added.id}`)).statusCode).toBe(204)
    expect((await api.del(`/products/${p.id}/barcodes/${added.id}`)).statusCode).toBe(404)
    expect((await api.post(`/products/${newId()}/barcodes`, { generate: true })).statusCode).toBe(
      404,
    )
  })

  it('concurrent internal barcode generation never repeats a code', async () => {
    const p = await createProduct(grocer, {})
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        req(grocer).post(`/products/${p.id}/barcodes`, { generate: true }),
      ),
    )
    const codes = results.map((r) => dataOf<ProductBarcode>(r, 201).barcode)
    expect(new Set(codes).size).toBe(8)
    for (const c of codes) expect(c).toMatch(/^20\d{11}$/)
  })

  it('barcode uniqueness is per tenant', async () => {
    const code = uniq('SAME').toUpperCase()
    await createProduct(grocer, { barcodes: [{ barcode: code }] })
    const otherShop = await createTestTenant(t)
    const theirs = await createProduct(otherShop, {})
    const res = await req(otherShop).post(`/products/${theirs.id}/barcodes`, { barcode: code })
    expect(res.statusCode).toBe(201)
    const hit = dataOf<ProductLookupResult>(
      await req(otherShop).get(`/products/lookup?code=${code}`),
    )
    expect(hit.product.id).toBe(theirs.id)
  })
})

describe('lookup', () => {
  it('precedence: exact barcode, then SKU, then scale barcode; 404 otherwise', async () => {
    const api = req(grocer)
    const code = uniq('LK').toUpperCase()
    const byBarcode = await createProduct(grocer, {
      barcodes: [{ barcode: code, qty_milli: 6000 }],
    })
    const bySku = await createProduct(grocer, { sku: code })
    const hit = dataOf<ProductLookupResult>(await api.get(`/products/lookup?code=${code}`))
    expect(hit).toMatchObject({ match: 'barcode', qty_milli: 6000, price_paise: null })
    expect(hit.product.id).toBe(byBarcode.id)
    expect(hit.barcode_id).not.toBeNull()

    const skuHit = dataOf<ProductLookupResult>(
      await api.get(`/products/lookup?code=${code.toLowerCase()}`),
    )
    expect(skuHit).toMatchObject({ match: 'sku', qty_milli: null })
    expect(skuHit.product.id).toBe(bySku.id)

    const plu = String(Math.floor(Math.random() * 90_000) + 10_000)
    const tomato = await createProduct(grocer, {
      name: 'Tomato',
      unit: 'KG',
      scale_plu: plu,
      is_weighed: true,
      sale_price_paise: 4000,
    })
    const cfg = DEFAULT_SETTINGS.pos.scale_barcode
    const scale = makeScaleBarcode('21', plu, 1250, cfg)
    const scaleHit = dataOf<ProductLookupResult>(await api.get(`/products/lookup?code=${scale}`))
    expect(scaleHit).toMatchObject({ match: 'scale', qty_milli: 1250, price_paise: null })
    expect(scaleHit.product).toMatchObject({ id: tomato.id, decimal_qty: true, is_weighed: true })

    const missing = await api.get(`/products/lookup?code=${uniq('NONE')}`)
    expect(missing.statusCode).toBe(404)
    expect(errorOf(missing).code).toBe('NOT_FOUND')
    // Scale barcodes are ignored when the tenant has them switched off.
    const plain = await createTestTenant(t)
    await createProduct(plain, { scale_plu: plu })
    expect((await req(plain).get(`/products/lookup?code=${scale}`)).statusCode).toBe(404)
  })

  it('price scale barcodes carry the line amount; store prices and stock apply', async () => {
    const shop = await createTestTenant(t, {
      settings: { pos: { scale_barcode: { enabled: true, value_type: 'price' } } },
    })
    const plu = '4321'
    const sweets = await createProduct(shop, {
      name: 'Mysore pak',
      unit: 'KG',
      scale_plu: plu,
      sale_price_paise: 60000,
    })
    const cfg = DEFAULT_SETTINGS.pos.scale_barcode
    const hit = dataOf<ProductLookupResult>(
      await req(shop).get(`/products/lookup?code=${makeScaleBarcode('22', plu, 15000, cfg)}`),
    )
    expect(hit).toMatchObject({ match: 'scale', price_paise: 15000, qty_milli: null })

    await req(shop).put('/store-prices', {
      store_id: shop.store.id,
      upserts: [{ product_id: sweets.id, sale_price_paise: 58000 }],
    })
    await shop.tx((tx) =>
      postStock(tx, shop.ctx, [
        {
          store_id: shop.store.id,
          product_id: sweets.id,
          qty_milli: 4500,
          movement_type: 'opening',
          unit_cost_paise: 40000,
        },
      ]),
    )
    const priced = dataOf<ProductLookupResult>(
      await req(shop).get(
        `/products/lookup?code=${makeScaleBarcode('22', plu, 15000, cfg)}&store_id=${shop.store.id}`,
      ),
    )
    expect(priced.product).toMatchObject({
      sale_price_paise: 58000,
      store_price_applied: true,
      stock_qty_milli: 4500,
    })
    const cashier = await shop.asRole('cashier')
    expect((await req(shop).get(`/products/lookup?code=x${plu}`, { as: cashier })).statusCode).toBe(
      404,
    )
  })
})
