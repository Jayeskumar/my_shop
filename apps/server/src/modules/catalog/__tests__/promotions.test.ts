/**
 * Promotions (feature promotions): rules validated per kind, references, status / active
 * filters, store scoping, PATCH semantics and delete-or-deactivate.
 */
import { newId } from '@kadai/shared'
import type { PromotionResponse } from '@kadai/shared/api/catalog'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { createProduct, dataOf, errorOf, expectIssue, req, uniq } from './helpers'

let t: TestApp
let shop: TestShop

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t)
})
afterAll(() => t.close())

const DAY = 86_400_000
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

describe('promotions', () => {
  it('creates per-kind rules with defaults and validates references and dates', async () => {
    const api = req(shop)
    const p = await createProduct(shop, {})
    const created = dataOf<PromotionResponse>(
      await api.post('/promotions', {
        name: uniq('Diwali '),
        name_ta: 'தீபாவளி சலுகை',
        kind: 'buy_x_get_y',
        rules: { product_ids: [p.id], buy_qty: 2, get_qty: 1 },
      }),
      201,
    )
    expect(created).toMatchObject({
      kind: 'buy_x_get_y',
      status: 'active',
      priority: 0,
      stackable: false,
    })
    if (created.kind !== 'buy_x_get_y') throw new Error('kind')
    expect(created.rules).toMatchObject({
      get_discount_bp: 10_000,
      all_items: false,
      category_ids: [],
    })

    expectIssue(
      await api.post('/promotions', {
        name: 'x',
        kind: 'item_percent',
        rules: { product_ids: [newId()], percent_bp: 500 },
      }),
      'reference_not_found',
      'rules.product_ids',
    )
    expect(
      (
        await api.post('/promotions', {
          name: 'x',
          kind: 'item_percent',
          rules: { percent_bp: 500 },
        })
      ).statusCode,
    ).toBe(400)
    expectIssue(
      await api.post('/promotions', {
        name: 'x',
        kind: 'bill_flat',
        rules: { flat_paise: 1000 },
        starts_at: iso(DAY),
        ends_at: iso(-DAY),
      }),
      'promotion_dates',
      'ends_at',
    )
    expectIssue(
      await api.post('/promotions', {
        name: 'x',
        kind: 'bill_flat',
        rules: { flat_paise: 100 },
        store_ids: [newId()],
      }),
      'reference_not_found',
      'store_ids',
    )
  })

  it('filters by status, active window and store', async () => {
    const api = req(shop)
    const tag = uniq('pr')
    const mk = async (extra: Record<string, unknown>) =>
      dataOf<PromotionResponse>(
        await api.post('/promotions', {
          name: `${tag} ${uniq()}`,
          kind: 'bill_percent',
          rules: { percent_bp: 500 },
          ...extra,
        }),
        201,
      )
    const now = await mk({})
    const later = await mk({ starts_at: iso(DAY) })
    const past = await mk({ starts_at: iso(-3 * DAY), ends_at: iso(-DAY) })
    const off = await mk({ is_active: false })
    const store2 = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({
        id: store2,
        tenant_id: shop.tenant.id,
        code: 'S9',
        name: 'Branch',
        state_code: '33',
      })
      .execute()
    const elsewhere = await mk({ store_ids: [store2] })
    const list = (qs: string) =>
      api
        .get(`/promotions?q=${tag}&limit=50&${qs}`)
        .then((r) => r.json<{ data: PromotionResponse[] }>().data.map((p) => p.id))
    expect((await list('active=true')).sort()).toEqual([now.id, elsewhere.id].sort())
    expect(await list('status=scheduled')).toEqual([later.id])
    expect(await list('status=expired')).toEqual([past.id])
    expect(await list('status=inactive')).toEqual([off.id])
    expect(await list(`active=true&store_id=${shop.store.id}`)).toEqual([now.id])
    const detail = dataOf<PromotionResponse>(await api.get(`/promotions/${later.id}`))
    expect(detail.status).toBe('scheduled')
  })

  it('PATCH updates base fields and kind + rules together', async () => {
    const api = req(shop)
    const promo = dataOf<PromotionResponse>(
      await api.post('/promotions', {
        name: uniq('Combo '),
        kind: 'bill_flat',
        rules: { flat_paise: 5000 },
      }),
      201,
    )
    expectIssue(
      await api.patch(`/promotions/${promo.id}`, { rules: { flat_paise: 1 } }),
      'promotion_kind_required',
      'kind',
    )
    expectIssue(
      await api.patch(`/promotions/${promo.id}`, { kind: 'bill_percent' }),
      'promotion_rules_required',
      'rules',
    )
    const changed = dataOf<PromotionResponse>(
      await api.patch(`/promotions/${promo.id}`, {
        kind: 'bill_percent',
        rules: { percent_bp: 1000, max_discount_paise: 20000 },
        priority: 5,
        if_updated_at: promo.updated_at,
      }),
    )
    expect(changed).toMatchObject({
      kind: 'bill_percent',
      priority: 5,
      rules: { percent_bp: 1000, max_discount_paise: 20000 },
    })
    const stale = await api.patch(`/promotions/${promo.id}`, {
      name: 'x',
      if_updated_at: promo.updated_at,
    })
    expect(errorOf(stale).code).toBe('STALE_WRITE')
    expectIssue(
      await api.patch(`/promotions/${promo.id}`, { starts_at: iso(DAY), ends_at: iso(DAY / 2) }),
      'promotion_dates',
    )
  })

  it('deletes never-applied promotions and deactivates applied ones', async () => {
    const api = req(shop)
    const unused = dataOf<PromotionResponse>(
      await api.post('/promotions', {
        name: uniq('Once '),
        kind: 'bill_flat',
        rules: { flat_paise: 100 },
      }),
      201,
    )
    expect(dataOf<{ result: string }>(await api.del(`/promotions/${unused.id}`)).result).toBe(
      'deleted',
    )
    expect((await api.get(`/promotions/${unused.id}`)).statusCode).toBe(404)

    const p = await createProduct(shop, {})
    const applied = dataOf<PromotionResponse>(
      await api.post('/promotions', {
        name: uniq('Used '),
        kind: 'item_flat',
        rules: { product_ids: [p.id], flat_paise: 100 },
      }),
      201,
    )
    const invoiceId = newId()
    await t.deps.db.systemDb
      .insertInto('sales_invoices')
      .values({
        id: invoiceId,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        invoice_date: '2026-10-20',
        place_of_supply: '33',
      })
      .execute()
    await t.deps.db.systemDb
      .insertInto('sales_invoice_lines')
      .values({
        tenant_id: shop.tenant.id,
        invoice_id: invoiceId,
        line_no: 1,
        product_id: p.id,
        name: 'x',
        unit: 'PCS',
        qty_milli: 1000,
        unit_price_paise: 1000,
        gross_paise: 1000,
        taxable_paise: 900,
        total_paise: 900,
        promotion_id: applied.id,
      })
      .execute()
    expect(dataOf<{ result: string }>(await api.del(`/promotions/${applied.id}`)).result).toBe(
      'deactivated',
    )
    expect(dataOf<PromotionResponse>(await api.get(`/promotions/${applied.id}`)).status).toBe(
      'inactive',
    )
  })

  it('is gated by feature promotions, permission and tenant', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const gated = await req(free).get('/promotions')
    expect(errorOf(gated)).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      details: { feature: 'promotions' },
    })
    const cashier = await shop.asRole('cashier')
    expect((await req(shop).get('/promotions', { as: cashier })).statusCode).toBe(200)
    expect(
      (
        await req(shop).post(
          '/promotions',
          { name: 'x', kind: 'bill_flat', rules: { flat_paise: 1 } },
          { as: cashier },
        )
      ).statusCode,
    ).toBe(403)
    const mine = dataOf<PromotionResponse>(
      await req(shop).post('/promotions', {
        name: uniq('Mine '),
        kind: 'bill_flat',
        rules: { flat_paise: 1 },
      }),
      201,
    )
    const other = await createTestTenant(t)
    expect((await req(other).get(`/promotions/${mine.id}`)).statusCode).toBe(404)
  })

  it('store-scoped managers write only promotions of their own stores', async () => {
    const manager = await shop.asRole('manager', { store_ids: [shop.store.id] })
    const api = req(shop)
    const body = { name: uniq('Branch '), kind: 'bill_flat', rules: { flat_paise: 500 } }
    // An all-store promotion would change prices in stores the manager cannot see.
    const all = await api.post('/promotions', body, { as: manager })
    expect(all.statusCode, all.body).toBe(403)
    expect(errorOf(all).details?.reason).toBe('all_stores_required')
    const own = dataOf<PromotionResponse>(
      await api.post('/promotions', { ...body, store_ids: [shop.store.id] }, { as: manager }),
      201,
    )
    expect(own.store_ids).toEqual([shop.store.id])
    // Owner-made all-store promotions stay out of reach (edit, widen, delete).
    const owners = dataOf<PromotionResponse>(await api.post('/promotions', body), 201)
    for (const res of [
      await api.patch(`/promotions/${owners.id}`, { priority: 5 }, { as: manager }),
      await api.del(`/promotions/${owners.id}`, { as: manager }),
      await api.patch(`/promotions/${own.id}`, { store_ids: null }, { as: manager }),
    ]) {
      expect(res.statusCode, res.body).toBe(403)
      expect(errorOf(res).details?.reason).toBe('all_stores_required')
    }
    const edited = dataOf<PromotionResponse>(
      await api.patch(`/promotions/${own.id}`, { priority: 7 }, { as: manager }),
    )
    expect(edited.priority).toBe(7)
  })
})
