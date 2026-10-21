/**
 * Products: create defaults and rules, vertical attributes, SKU / barcode generation, PATCH
 * (concurrency, audit, unit lock), DELETE semantics, detail and list (search, filters, stock,
 * low stock, sorting), plan limit, idempotency, permissions and tenant isolation.
 */
import { makeEan13, newId } from '@kadai/shared'
import type { Category, ProductDetail, ProductListItem } from '@kadai/shared/api/catalog'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postStock } from '../../../core/inventory'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, type TestShopMember, createTestTenant } from '../../../test/tenants'
import { createProduct, dataOf, errorOf, expectIssue, req, uniq } from './helpers'

let t: TestApp
let shop: TestShop
let other: TestShop
let cashier: TestShopMember

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t)
  other = await createTestTenant(t)
  cashier = await shop.asRole('cashier')
})
afterAll(() => t.close())

/** The EAN-13 with its check digit off by one. */
const wrongCheckDigit = (code: string): string =>
  `${code.slice(0, 12)}${String((Number(code[12]) + 1) % 10)}`

async function openingStock(s: TestShop, productId: string, qty: number) {
  await s.tx((tx) =>
    postStock(tx, s.ctx, [
      {
        store_id: s.store.id,
        product_id: productId,
        qty_milli: qty,
        movement_type: 'opening',
        unit_cost_paise: 100,
      },
    ]),
  )
}

async function auditActions(s: TestShop, entityId: string): Promise<string[]> {
  const rows = await s.tx((tx) =>
    tx
      .selectFrom('audit_logs')
      .select('action')
      .where('entity_id', '=', entityId)
      .orderBy('created_at')
      .execute(),
  )
  return rows.map((r) => r.action)
}

describe('create', () => {
  it('fills defaults from settings and the unit', async () => {
    const p = await createProduct(shop, {
      name: 'Ponni rice',
      unit: 'KG',
      sale_price_paise: 6800,
      mrp_paise: 7200,
    })
    expect(p).toMatchObject({
      kind: 'standard',
      unit: 'KG',
      decimal_qty: true,
      pack_size: 1,
      price_includes_tax: true,
      track_inventory: true,
      track_batches: false,
      sku: null,
      barcodes: [],
      variants: [],
    })
    const pcs = await createProduct(shop, {})
    expect(pcs.unit).toBe('PCS')
    expect(pcs.decimal_qty).toBe(false)
    expect(await auditActions(shop, p.id)).toEqual(['product.create'])
  })

  it('validates GST rate, HSN, MRP, loose packs, decimal units and kinds', async () => {
    const api = req(shop)
    const base = { name: uniq('Bad '), sale_price_paise: 1000 }
    expect((await api.post('/products', { ...base, gst_rate_bp: 1700 })).statusCode).toBe(400)
    expectIssue(await api.post('/products', { ...base, hsn_code: '12' }), 'hsn', 'hsn_code')
    expectIssue(
      await api.post('/products', { ...base, mrp_paise: 900 }),
      'mrp_below_sale_price',
      'sale_price_paise',
    )
    const allowed = await api.post('/products', {
      ...base,
      mrp_paise: 900,
      allow_mrp_below_sale: true,
    })
    expect(allowed.statusCode).toBe(201)
    expectIssue(
      await api.post('/products', { ...base, allow_loose: true }),
      'loose_requires_pack',
      'allow_loose',
    )
    expectIssue(
      await api.post('/products', { ...base, decimal_qty: true }),
      'decimal_qty_unit',
      'decimal_qty',
    )
    expectIssue(
      await api.post('/products', { ...base, kind: 'service', track_inventory: true }),
      'service_tracks_stock',
    )
    expect((await api.post('/products', { ...base, kind: 'variant' })).statusCode).toBe(400)
    expectIssue(await api.post('/products', { ...base, unit: 'BOX9' }), 'unit_unknown', 'unit')
    expectIssue(
      await api.post('/products', { ...base, category_id: newId() }),
      'reference_not_found',
      'category_id',
    )
    const service = await createProduct(shop, { kind: 'service', name: uniq('Alteration ') })
    expect(service).toMatchObject({ kind: 'service', track_inventory: false, track_batches: false })
    const loose = await createProduct(shop, { unit: 'TAB', pack_size: 10, allow_loose: true })
    expect(loose).toMatchObject({ pack_size: 10, allow_loose: true })
  })

  it('SKUs are unique case-insensitively; barcodes are unique per tenant', async () => {
    const sku = uniq('RICE-')
    await createProduct(shop, { sku })
    const dup = await req(shop).post('/products', {
      name: 'Other',
      sale_price_paise: 100,
      sku: sku.toLowerCase(),
    })
    expect(dup.statusCode).toBe(409)
    expect(errorOf(dup)).toMatchObject({
      code: 'DUPLICATE',
      details: { reason: 'sku_taken', field: 'sku' },
    })
    const code = makeEan13('890123456789')
    const first = await createProduct(shop, { barcodes: [{ barcode: code }] })
    expect(first.primary_barcode).toBe(code)
    const taken = await req(shop).post('/products', {
      name: 'Again',
      sale_price_paise: 100,
      barcodes: [{ barcode: code }],
    })
    expect(errorOf(taken).details?.reason).toBe('barcode_taken')
    // Another tenant may use the same barcode (uniqueness is per tenant).
    const theirs = await createProduct(other, { barcodes: [{ barcode: code }] })
    expect(theirs.primary_barcode).toBe(code)
    expectIssue(
      await req(shop).post('/products', {
        name: 'Bad',
        sale_price_paise: 1,
        barcodes: [{ barcode: wrongCheckDigit(makeEan13('890123456789')) }],
      }),
      'barcode_checksum',
    )
  })

  it('generates automatic SKUs and internal barcodes when settings say so', async () => {
    const auto = await createTestTenant(t, {
      settings: { catalog: { auto_sku: true, sku_prefix: 'KD', auto_generate_barcode: true } },
    })
    const a = await createProduct(auto, {})
    const b = await createProduct(auto, {})
    expect(a.sku).toBe('KD00001')
    expect(b.sku).toBe('KD00002')
    expect(a.barcodes[0]!.barcode).toMatch(/^20\d{11}$/)
    expect(a.barcodes[0]!.is_internal).toBe(true)
    expect(b.barcodes[0]!.barcode).not.toBe(a.barcodes[0]!.barcode)
    const manual = await createProduct(auto, { sku: 'OWN-1', generate_barcode: false })
    expect(manual).toMatchObject({ sku: 'OWN-1', barcodes: [] })
    const parent = await createProduct(auto, { kind: 'variant_parent' })
    expect(parent.barcodes).toEqual([])
    expect(parent.track_inventory).toBe(false)
  })

  it('validates vertical attributes and forces batches for pharmacy medicines', async () => {
    const pharmacy = await createTestTenant(t, { business_type: 'pharmacy' })
    const med = await createProduct(pharmacy, {
      unit: 'TAB',
      pack_size: 10,
      allow_loose: true,
      track_batches: false,
      attributes: { schedule: 'H', generic_name: 'Paracetamol', dosage_form: 'tablet' },
    })
    expect(med.track_batches).toBe(true)
    expect(med.attributes).toMatchObject({ schedule: 'H', generic_name: 'Paracetamol' })
    const soap = await createProduct(pharmacy, { track_batches: false, attributes: {} })
    expect(soap.track_batches).toBe(false)
    expect(soap.attributes.schedule).toBe('OTC')
    expectIssue(
      await req(pharmacy).post('/products', {
        name: 'x',
        sale_price_paise: 1,
        attributes: { schedule: 'Z' },
      }),
      'attribute_invalid',
      'attributes.schedule',
    )
  })

  it('is idempotent with an Idempotency-Key', async () => {
    const key = `idem-${newId()}`
    const body = { name: uniq('Idem '), sale_price_paise: 500 }
    const a = await req(shop).post('/products', body, { headers: { 'idempotency-key': key } })
    const b = await req(shop).post('/products', body, { headers: { 'idempotency-key': key } })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
    expect(dataOf<ProductDetail>(b, 201).id).toBe(dataOf<ProductDetail>(a, 201).id)
    const mismatch = await req(shop).post(
      '/products',
      { ...body, sale_price_paise: 600 },
      { headers: { 'idempotency-key': key } },
    )
    expect(errorOf(mismatch).code).toBe('IDEMPOTENCY_MISMATCH')
  })

  it('needs catalog.write', async () => {
    const res = await req(shop).post(
      '/products',
      { name: 'x', sale_price_paise: 1 },
      { as: cashier },
    )
    expect(res.statusCode).toBe(403)
    expect((await req(shop).get('/products', { as: cashier })).statusCode).toBe(200)
  })

  it('enforces the products limit of the free plan', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    await t.deps.db.systemDb
      .insertInto('products')
      .values(
        Array.from({ length: 1000 }, (_, i) => ({
          id: newId(),
          tenant_id: free.tenant.id,
          name: `Seed ${String(i)}`,
        })),
      )
      .execute()
    const res = await req(free).post('/products', { name: 'One too many', sale_price_paise: 100 })
    expect(res.statusCode).toBe(402)
    expect(errorOf(res)).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'products', limit: 1000 },
    })
    // Inactive products do not count.
    const inactive = await req(free).post('/products', {
      name: 'Archived',
      sale_price_paise: 100,
      is_active: false,
    })
    expect(inactive.statusCode).toBe(201)
    const id = dataOf<ProductDetail>(inactive, 201).id
    expect((await req(free).patch(`/products/${id}`, { is_active: true })).statusCode).toBe(402)
  })
})

describe('update & delete', () => {
  it('PATCH checks if_updated_at, merged rules and audits price / tax / status changes', async () => {
    const p = await createProduct(shop, {
      sale_price_paise: 1000,
      mrp_paise: 1200,
      gst_rate_bp: 500,
    })
    const stale = await req(shop).patch(`/products/${p.id}`, {
      name: 'x',
      if_updated_at: '2020-01-01T00:00:00.000Z',
    })
    expect(errorOf(stale).code).toBe('STALE_WRITE')
    expectIssue(
      await req(shop).patch(`/products/${p.id}`, { sale_price_paise: 1300 }),
      'mrp_below_sale_price',
    )
    expectIssue(
      await req(shop).patch(`/products/${p.id}`, { allow_loose: true }),
      'loose_requires_pack',
    )
    const updated = dataOf<ProductDetail>(
      await req(shop).patch(`/products/${p.id}`, {
        sale_price_paise: 1100,
        gst_rate_bp: 1800,
        name_ta: 'பொருள்',
        if_updated_at: p.updated_at,
      }),
    )
    expect(updated).toMatchObject({ sale_price_paise: 1100, gst_rate_bp: 1800, name_ta: 'பொருள்' })
    await req(shop).patch(`/products/${p.id}`, { is_active: false })
    const actions = await auditActions(shop, p.id)
    expect(actions).toEqual(
      expect.arrayContaining([
        'product.price_change',
        'product.tax_change',
        'product.update',
        'product.deactivate',
      ]),
    )
    expectIssue(
      await req(shop).patch(`/products/${p.id}`, { if_updated_at: updated.updated_at }),
      'empty_patch',
    )
  })

  it('switches standard ↔ service, refuses kind changes of variant parents and unit changes after movements', async () => {
    const p = await createProduct(shop, {})
    const service = dataOf<ProductDetail>(
      await req(shop).patch(`/products/${p.id}`, { kind: 'service' }),
    )
    expect(service).toMatchObject({ kind: 'service', track_inventory: false })
    const parent = await createProduct(shop, { kind: 'variant_parent' })
    expectIssue(
      await req(shop).patch(`/products/${parent.id}`, { kind: 'standard' }),
      'kind_change',
      'kind',
    )
    const stocked = await createProduct(shop, {})
    await openingStock(shop, stocked.id, 5000)
    const res = await req(shop).patch(`/products/${stocked.id}`, { unit: 'BOX' })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).details?.reason).toBe('unit_in_use')
  })

  it('keeps pack size, batch tracking and stock tracking of stocked products', async () => {
    const stocked = await createProduct(shop, { pack_size: 10, allow_loose: true })
    await openingStock(shop, stocked.id, 20_000)
    // Costs are per pack: a new pack size would revalue the stock.
    const pack = await req(shop).patch(`/products/${stocked.id}`, { pack_size: 12 })
    expect(pack.statusCode).toBe(409)
    expect(errorOf(pack).details).toMatchObject({ reason: 'pack_size_in_use', field: 'pack_size' })
    // Batch-less stock could not be sold FEFO; untracked stock could never be adjusted.
    for (const [body, field] of [
      [{ track_batches: true }, 'track_batches'],
      [{ track_inventory: false }, 'track_inventory'],
      [{ kind: 'service' }, 'kind'],
    ] as const) {
      const res = await req(shop).patch(`/products/${stocked.id}`, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(409)
      expect(errorOf(res).details).toMatchObject({ reason: 'stock_on_hand', field })
    }
    // Other changes still save; once the stock is gone, batch tracking may switch on.
    const ok = dataOf<ProductDetail>(
      await req(shop).patch(`/products/${stocked.id}`, { sale_price_paise: 1200 }),
    )
    expect(ok.sale_price_paise).toBe(1200)
    await shop.tx((tx) =>
      postStock(tx, shop.ctx, [
        {
          store_id: shop.store.id,
          product_id: stocked.id,
          qty_milli: -20_000,
          movement_type: 'adjustment',
          reason: 'stock count',
        },
      ]),
    )
    const batches = dataOf<ProductDetail>(
      await req(shop).patch(`/products/${stocked.id}`, { track_batches: true }),
    )
    expect(batches.track_batches).toBe(true)
    // Never-stocked products change freely.
    const fresh = await createProduct(shop, {})
    const changed = dataOf<ProductDetail>(
      await req(shop).patch(`/products/${fresh.id}`, { pack_size: 6, track_batches: true }),
    )
    expect(changed).toMatchObject({ pack_size: 6, track_batches: true })
  })

  it('refuses barcodes on variant parents', async () => {
    const res = await req(shop).post('/products', {
      name: uniq('Shirt '),
      sale_price_paise: 50_000,
      kind: 'variant_parent',
      barcodes: [{ barcode: uniq('VP') }],
    })
    expect(res.statusCode, res.body).toBe(422)
    expect(errorOf(res).details?.reason).toBe('product_kind')
    const parent = await createProduct(shop, { kind: 'variant_parent' })
    const add = await req(shop).post(`/products/${parent.id}/barcodes`, { barcode: uniq('VP') })
    expect(add.statusCode).toBe(422)
    expect(errorOf(add).details?.reason).toBe('product_kind')
  })

  it('DELETE removes unused products and deactivates used ones', async () => {
    const unused = await createProduct(shop, { barcodes: [{ barcode: uniq('DEL') }] })
    const del = dataOf<{ id: string; result: string }>(
      await req(shop).del(`/products/${unused.id}`),
    )
    expect(del.result).toBe('deleted')
    expect((await req(shop).get(`/products/${unused.id}`)).statusCode).toBe(404)
    const used = await createProduct(shop, {})
    await openingStock(shop, used.id, 1000)
    const res = dataOf<{ id: string; result: string }>(await req(shop).del(`/products/${used.id}`))
    expect(res.result).toBe('deactivated')
    const after = dataOf<ProductDetail>(await req(shop).get(`/products/${used.id}`))
    expect(after.is_active).toBe(false)
    expect(await auditActions(shop, used.id)).toContain('product.deactivate')
  })

  it('isolates tenants', async () => {
    const p = await createProduct(shop, {})
    expect((await req(other).get(`/products/${p.id}`)).statusCode).toBe(404)
    expect((await req(other).patch(`/products/${p.id}`, { name: 'hijack' })).statusCode).toBe(404)
    expect((await req(other).del(`/products/${p.id}`)).statusCode).toBe(404)
    const list = await req(other).get(`/products?ids=${p.id}`)
    expect(list.json<{ data: ProductListItem[] }>().data).toEqual([])
  })
})

describe('read', () => {
  it('GET :id has category path, brand, barcodes and store stock', async () => {
    const cat = dataOf<Category>(await req(shop).post('/categories', { name: uniq('Cat ') }), 201)
    const brand = dataOf<{ id: string; name: string }>(
      await req(shop).post('/brands', { name: uniq('Brand ') }),
      201,
    )
    const p = await createProduct(shop, {
      category_id: cat.id,
      brand_id: brand.id,
      barcodes: [{ barcode: uniq('BC') }],
    })
    await openingStock(shop, p.id, 2500)
    const d = dataOf<ProductDetail>(
      await req(shop).get(`/products/${p.id}?store_id=${shop.store.id}`),
    )
    expect(d.category).toMatchObject({ id: cat.id, path: cat.name })
    expect(d.brand).toEqual({ id: brand.id, name: brand.name })
    expect(d.barcodes).toHaveLength(1)
    expect(d.stock_qty_milli).toBe(2500)
    // Single-store tenant: the store applies without ?store_id.
    expect(dataOf<ProductDetail>(await req(shop).get(`/products/${p.id}`)).stock_qty_milli).toBe(
      2500,
    )
  })

  it('lists with search (exact code first), filters, stock, low stock and sorting', async () => {
    const tag = uniq('zq')
    const parentCat = dataOf<Category>(
      await req(shop).post('/categories', { name: uniq('Grocery ') }),
      201,
    )
    const childCat = dataOf<Category>(
      await req(shop).post('/categories', { name: 'Dal', parent_id: parentCat.id }),
      201,
    )
    const a = await createProduct(shop, {
      name: `Toor dal ${tag}`,
      category_id: childCat.id,
      sale_price_paise: 15000,
      reorder_level_milli: 5000,
      aliases: ['paruppu'],
    })
    const b = await createProduct(shop, {
      name: `Moong dal ${tag}`,
      category_id: parentCat.id,
      sale_price_paise: 12000,
      reorder_level_milli: 1000,
    })
    const c = await createProduct(shop, {
      name: `Sugar ${tag}`,
      sku: `${tag}-SUGAR`,
      sale_price_paise: 4500,
    })
    await openingStock(shop, a.id, 3000)
    await openingStock(shop, b.id, 9000)

    const byName = await req(shop).get(
      `/products?q=${encodeURIComponent(`dal ${tag}`)}&sort=-sale_price`,
    )
    const rows = byName.json<{ data: ProductListItem[]; page: { total: number } }>()
    expect(rows.data.map((r) => r.id)).toEqual([a.id, b.id])
    expect(rows.page.total).toBe(2)
    expect(rows.data[0]).toMatchObject({
      category_path: `${parentCat.name} > Dal`,
      stock_qty_milli: 3000,
      low_stock: true,
    })
    expect(rows.data[1]).toMatchObject({ stock_qty_milli: 9000, low_stock: false })

    const alias = await req(shop).get(`/products?q=paruppu&ids=${a.id}`)
    expect(alias.json<{ data: ProductListItem[] }>().data).toHaveLength(1)
    const sku = await req(shop).get(`/products?q=${encodeURIComponent(`${tag}-sugar`)}`)
    expect(sku.json<{ data: ProductListItem[] }>().data[0]!.id).toBe(c.id)
    const inCat = await req(shop).get(`/products?category_id=${parentCat.id}`)
    expect(
      inCat
        .json<{ data: ProductListItem[] }>()
        .data.map((r) => r.id)
        .sort(),
    ).toEqual([a.id, b.id].sort())
    const low = await req(shop).get(`/products?low_stock=true&q=${tag}`)
    expect(low.json<{ data: ProductListItem[] }>().data.map((r) => r.id)).toEqual([a.id])
    const page = await req(shop).get(`/products?q=${tag}&limit=1&offset=1&sort=name`)
    const pageBody = page.json<{
      data: ProductListItem[]
      page: { total: number; limit: number; offset: number }
    }>()
    expect(pageBody.page).toEqual({ total: 3, limit: 1, offset: 1 })
    expect(pageBody.data[0]!.id).toBe(c.id) // Moong, Sugar, Toor
    expect((await req(shop).get('/products?sort=price')).statusCode).toBe(400)
  })

  it('an exact barcode match ranks first in search', async () => {
    const tag = uniq('bq')
    const code = `${tag}X`.toUpperCase()
    const first = await createProduct(shop, { name: `Alpha ${code}` })
    const exact = await createProduct(shop, { name: `Zeta ${tag}`, barcodes: [{ barcode: code }] })
    const res = await req(shop).get(`/products?q=${encodeURIComponent(code)}&sort=name`)
    const ids = res.json<{ data: ProductListItem[] }>().data.map((r) => r.id)
    expect(ids[0]).toBe(exact.id)
    expect(ids).toContain(first.id)
    const byBarcode = await req(shop).get(`/products?barcode=${encodeURIComponent(code)}`)
    expect(byBarcode.json<{ data: ProductListItem[] }>().data.map((r) => r.id)).toEqual([exact.id])
  })

  it('low stock needs a store when several stores exist', async () => {
    const multi = await createTestTenant(t)
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({
        id: newId(),
        tenant_id: multi.tenant.id,
        code: 'S2',
        name: 'Second store',
        state_code: '33',
      })
      .execute()
    expectIssue(await req(multi).get('/products?low_stock=true'), 'store_required', 'store_id')
    expect(
      (await req(multi).get(`/products?low_stock=true&store_id=${multi.store.id}`)).statusCode,
    ).toBe(200)
    const limited = await multi.asRole('cashier', { store_ids: [multi.store.id] })
    const foreign = await multi.tx((tx) =>
      tx.selectFrom('stores').select('id').where('code', '=', 'S2').executeTakeFirstOrThrow(),
    )
    expect(
      (await req(multi).get(`/products?store_id=${foreign.id}`, { as: limited })).statusCode,
    ).toBe(403)
  })
})
