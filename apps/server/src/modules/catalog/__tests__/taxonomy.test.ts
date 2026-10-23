/**
 * Categories (tree, paths, depth / cycle rules, unique names, delete semantics, tax defaults
 * inherited by products), brands and tax slab rules — happy paths, validation, permissions and
 * tenant isolation.
 */
import type {
  Brand,
  Category,
  CategoryDetail,
  CategoryNode,
  TaxSlabRule,
} from '@kadai/shared/api/catalog'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

describe('categories', () => {
  it('creates a 3-level tree with paths and rejects a 4th level', async () => {
    const api = req(shop)
    const a = dataOf<Category>(
      await api.post('/categories', {
        name: uniq('Grocery '),
        name_ta: 'மளிகை',
        hsn_code: '1006',
        gst_rate_bp: 500,
      }),
      201,
    )
    expect(a.depth).toBe(1)
    const b = dataOf<Category>(
      await api.post('/categories', { name: 'Rice', parent_id: a.id }),
      201,
    )
    expect(b.path).toBe(`${a.name} > Rice`)
    expect(b.path_ta).toBe('மளிகை > Rice')
    expect(b.depth).toBe(2)
    const c = dataOf<Category>(
      await api.post('/categories', { name: 'Ponni', parent_id: b.id }),
      201,
    )
    expect(c.depth).toBe(3)
    expectIssue(
      await api.post('/categories', { name: 'Too deep', parent_id: c.id }),
      'category_depth',
      'parent_id',
    )

    const flat = dataOf<CategoryNode[]>(await api.get('/categories?flat=true'))
    const row = flat.find((n) => n.id === c.id)!
    expect(row.path).toBe(`${a.name} > Rice > Ponni`)
    expect(row.children).toEqual([])
    const tree = dataOf<CategoryNode[]>(await api.get('/categories'))
    const root = tree.find((n) => n.id === a.id)!
    expect(root.children[0]!.children[0]!.id).toBe(c.id)

    const detail = dataOf<CategoryDetail>(await api.get(`/categories/${c.id}`))
    expect(detail.ancestors.map((x) => x.id)).toEqual([a.id, b.id])
  })

  it('rejects duplicate names per parent (case-insensitive) and cycles on move', async () => {
    const api = req(shop)
    const name = uniq('Snacks ')
    const a = dataOf<Category>(await api.post('/categories', { name }), 201)
    const dup = await api.post('/categories', { name: name.toUpperCase() })
    expect(dup.statusCode).toBe(409)
    expect(errorOf(dup).code).toBe('DUPLICATE')
    expect(errorOf(dup).details?.reason).toBe('name_taken')
    const b = dataOf<Category>(
      await api.post('/categories', { name: 'Chips', parent_id: a.id }),
      201,
    )
    expectIssue(
      await api.patch(`/categories/${a.id}`, { parent_id: b.id }),
      'category_cycle',
      'parent_id',
    )
    expectIssue(
      await api.patch(`/categories/${a.id}`, { parent_id: a.id }),
      'category_cycle',
      'parent_id',
    )
    // Moving a 2-level subtree under a depth-2 node would make depth 4.
    const x = dataOf<Category>(await api.post('/categories', { name: uniq('X ') }), 201)
    const y = dataOf<Category>(await api.post('/categories', { name: 'Y', parent_id: x.id }), 201)
    expectIssue(
      await api.patch(`/categories/${a.id}`, { parent_id: y.id }),
      'category_depth',
      'parent_id',
    )
    expectIssue(await api.patch(`/categories/${a.id}`, {}), 'empty_patch')
  })

  it('PATCH with a stale if_updated_at is 409 STALE_WRITE', async () => {
    const api = req(shop)
    const a = dataOf<Category>(await api.post('/categories', { name: uniq('Oils ') }), 201)
    const ok = dataOf<Category>(
      await api.patch(`/categories/${a.id}`, { name_ta: 'எண்ணெய்', if_updated_at: a.updated_at }),
    )
    expect(ok.name_ta).toBe('எண்ணெய்')
    const stale = await api.patch(`/categories/${a.id}`, {
      sort_order: 3,
      if_updated_at: '2020-01-01T00:00:00.000Z',
    })
    expect(stale.statusCode).toBe(409)
    expect(errorOf(stale).code).toBe('STALE_WRITE')
  })

  it('deletes unused categories only; used ones answer 409 with hint deactivate', async () => {
    const api = req(shop)
    const a = dataOf<Category>(await api.post('/categories', { name: uniq('Dairy ') }), 201)
    const child = dataOf<Category>(
      await api.post('/categories', { name: 'Milk', parent_id: a.id }),
      201,
    )
    const blocked = await api.del(`/categories/${a.id}`)
    expect(blocked.statusCode).toBe(409)
    expect(errorOf(blocked).details).toMatchObject({
      reason: 'in_use_deactivate',
      hint: 'deactivate',
      child_count: 1,
    })
    await createProduct(shop, { category_id: child.id })
    const withProducts = await api.del(`/categories/${child.id}`)
    expect(withProducts.statusCode).toBe(409)
    expect(errorOf(withProducts).details?.product_count).toBe(1)
    const lone = dataOf<Category>(await api.post('/categories', { name: uniq('Lone ') }), 201)
    expect((await api.del(`/categories/${lone.id}`)).statusCode).toBe(204)
    expect((await api.get(`/categories/${lone.id}`)).statusCode).toBe(404)
  })

  it('new products inherit HSN / GST / slab rule from the nearest category', async () => {
    const api = req(shop)
    const rule = dataOf<TaxSlabRule>(
      await api.post('/tax-slab-rules', {
        name: uniq('Garments '),
        slabs: [
          { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
          { max_unit_value_paise: null, gst_rate_bp: 1800 },
        ],
      }),
      201,
    )
    const top = dataOf<Category>(
      await api.post('/categories', {
        name: uniq('Wear '),
        hsn_code: '6205',
        gst_rate_bp: 500,
        tax_slab_rule_id: rule.id,
      }),
      201,
    )
    const sub = dataOf<Category>(
      await api.post('/categories', { name: 'Shirts', parent_id: top.id }),
      201,
    )
    const p = await createProduct(shop, { category_id: sub.id })
    expect(p).toMatchObject({ hsn_code: '6205', gst_rate_bp: 500, tax_slab_rule_id: rule.id })
    expect(p.category?.path).toBe(`${top.name} > Shirts`)
    const own = await createProduct(shop, {
      category_id: sub.id,
      hsn_code: '6109',
      gst_rate_bp: 1800,
      tax_slab_rule_id: null,
    })
    expect(own).toMatchObject({ hsn_code: '6109', gst_rate_bp: 1800, tax_slab_rule_id: null })
  })

  it('needs catalog.write to change and hides other tenants', async () => {
    const api = req(shop)
    const denied = await api.post('/categories', { name: uniq('Nope ') }, { as: cashier })
    expect(denied.statusCode).toBe(403)
    expect(errorOf(denied).code).toBe('FORBIDDEN')
    expect((await api.get('/categories', { as: cashier })).statusCode).toBe(200)
    const mine = dataOf<Category>(await api.post('/categories', { name: uniq('Private ') }), 201)
    expect((await req(other).get(`/categories/${mine.id}`)).statusCode).toBe(404)
    const theirs = dataOf<CategoryNode[]>(await req(other).get('/categories?flat=true'))
    expect(theirs.some((c) => c.id === mine.id)).toBe(false)
    // A foreign parent id is not visible either.
    expectIssue(
      await req(other).post('/categories', { name: 'Child', parent_id: mine.id }),
      'reference_not_found',
      'parent_id',
    )
  })
})

describe('brands', () => {
  it('CRUD with case-insensitive unique names and delete semantics', async () => {
    const api = req(shop)
    const name = uniq('Aachi ')
    const b = dataOf<Brand>(await api.post('/brands', { name }), 201)
    expect(b.product_count).toBe(0)
    const dup = await api.post('/brands', { name: name.toLowerCase() })
    expect(dup.statusCode).toBe(409)
    expect(errorOf(dup).details?.reason).toBe('name_taken')
    const list = await api.get(`/brands?q=${encodeURIComponent(name.slice(0, 7))}&limit=5`)
    const body = list.json<{ data: Brand[]; page: { total: number } }>()
    expect(body.data.some((x) => x.id === b.id)).toBe(true)
    const renamed = dataOf<Brand>(await api.patch(`/brands/${b.id}`, { name: `${name} Masala` }))
    expect(renamed.name).toBe(`${name} Masala`)
    await createProduct(shop, { brand_id: b.id })
    const blocked = await api.del(`/brands/${b.id}`)
    expect(blocked.statusCode).toBe(409)
    expect(errorOf(blocked).details?.hint).toBe('deactivate')
    const off = dataOf<Brand>(await api.patch(`/brands/${b.id}`, { is_active: false }))
    expect(off.is_active).toBe(false)
    const unused = dataOf<Brand>(await api.post('/brands', { name: uniq('Unused ') }), 201)
    expect((await api.del(`/brands/${unused.id}`)).statusCode).toBe(204)
  })

  it('sorts by product count and is tenant-scoped', async () => {
    const api = req(shop)
    const busy = dataOf<Brand>(await api.post('/brands', { name: uniq('Busy ') }), 201)
    await createProduct(shop, { brand_id: busy.id })
    await createProduct(shop, { brand_id: busy.id })
    const sorted = await api.get('/brands?sort=-product_count&limit=1')
    expect(sorted.json<{ data: Brand[] }>().data[0]!.product_count).toBeGreaterThanOrEqual(2)
    const foreign = await req(other).get(`/brands?q=${encodeURIComponent(busy.name)}`)
    expect(foreign.json<{ data: Brand[] }>().data).toHaveLength(0)
    expect((await req(other).patch(`/brands/${busy.id}`, { is_active: false })).statusCode).toBe(
      404,
    )
  })
})

describe('tax slab rules', () => {
  const slabs = [
    { max_unit_value_paise: 100_000, gst_rate_bp: 500 },
    { max_unit_value_paise: null, gst_rate_bp: 1800 },
  ]

  it('validates slabs: ascending, last unbounded, GST rates only', async () => {
    const api = req(shop)
    expectIssue(
      await api.post('/tax-slab-rules', {
        name: uniq('Bad '),
        slabs: [{ max_unit_value_paise: 1000, gst_rate_bp: 500 }],
      }),
      'slab_last_unbounded',
    )
    const unordered = await api.post('/tax-slab-rules', {
      name: uniq('Bad '),
      slabs: [
        { max_unit_value_paise: 5000, gst_rate_bp: 500 },
        { max_unit_value_paise: 1000, gst_rate_bp: 1200 },
        { max_unit_value_paise: null, gst_rate_bp: 1800 },
      ],
    })
    expect(unordered.statusCode).toBe(400)
    const badRate = await api.post('/tax-slab-rules', {
      name: uniq('Bad '),
      slabs: [{ max_unit_value_paise: null, gst_rate_bp: 1700 }],
    })
    expect(badRate.statusCode).toBe(400)
  })

  it('CRUD; referenced rules cannot be deleted', async () => {
    const api = req(shop)
    const rule = dataOf<TaxSlabRule>(
      await api.post('/tax-slab-rules', { name: uniq('Footwear '), slabs }),
      201,
    )
    expect(rule.slabs).toEqual(slabs)
    const got = dataOf<TaxSlabRule>(await api.get(`/tax-slab-rules/${rule.id}`))
    expect(got.name).toBe(rule.name)
    const changed = dataOf<TaxSlabRule>(
      await api.patch(`/tax-slab-rules/${rule.id}`, {
        slabs: [
          { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
          { max_unit_value_paise: null, gst_rate_bp: 1800 },
        ],
      }),
    )
    expect(changed.slabs[0]!.max_unit_value_paise).toBe(250_000)
    const audits = await shop.tx((tx) =>
      tx.selectFrom('audit_logs').select('action').where('entity_id', '=', rule.id).execute(),
    )
    expect(audits.map((a) => a.action)).toContain('tax_slab_rule.update')
    await createProduct(shop, { tax_slab_rule_id: rule.id })
    const blocked = await api.del(`/tax-slab-rules/${rule.id}`)
    expect(blocked.statusCode).toBe(409)
    expect(errorOf(blocked).details).toMatchObject({
      reason: 'in_use_deactivate',
      product_count: 1,
    })
    const list = await api.get('/tax-slab-rules?limit=200')
    expect(
      list.json<{ data: TaxSlabRule[] }>().data.find((r) => r.id === rule.id)?.product_count,
    ).toBe(1)
    const spare = dataOf<TaxSlabRule>(
      await api.post('/tax-slab-rules', { name: uniq('Spare '), slabs }),
      201,
    )
    expect((await api.del(`/tax-slab-rules/${spare.id}`)).statusCode).toBe(204)
    expect((await req(other).get(`/tax-slab-rules/${rule.id}`)).statusCode).toBe(404)
    expect(
      (await api.post('/tax-slab-rules', { name: uniq('X '), slabs }, { as: cashier })).statusCode,
    ).toBe(403)
  })
})
