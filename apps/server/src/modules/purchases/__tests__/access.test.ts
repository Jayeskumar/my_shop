/**
 * Access control of the purchases routes: every catalogue route is registered; authentication;
 * permissions (cashier: none, accountant: read only, inventory clerk: read + write); the plan
 * feature `purchases` (free plan → 402); tenant isolation (another tenant's documents, suppliers
 * and products are invisible) and membership store scoping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId, todayIn } from '@kadai/shared'
import { routeUrl } from '@kadai/shared/api/common'
import { purchasesRoutes } from '@kadai/shared/api/purchases'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, type TestShopMember, createTestTenant } from '../../../test/tenants'
import { API, dataOf, expectError, makeProduct, makeStore, makeSupplier, req } from './fixtures'

const today = todayIn('Asia/Kolkata')

describe('purchases: access control and isolation', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let freeShop: TestShop
  let cashier: TestShopMember
  let accountant: TestShopMember
  let clerk: TestShopMember
  let supplier: { id: string }
  let product: { id: string }
  let billId: string
  let orderId: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    freeShop = await createTestTenant(t, { plan_code: 'free' })
    cashier = await shop.asRole('cashier')
    accountant = await shop.asRole('accountant')
    clerk = await shop.asRole('inventory_clerk')
    supplier = await makeSupplier(t, shop.tenant.id)
    product = await makeProduct(t, shop.tenant.id)
    billId = dataOf<{ id: string }>(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: supplier.id,
        store_id: shop.store.id,
        supplier_invoice_no: 'ACC-1',
        supplier_invoice_date: today,
        lines: [{ product_id: product.id, qty_milli: 2_000, unit_cost_paise: 1_000 }],
      }),
      201,
    ).id
    orderId = dataOf<{ id: string }>(
      await req(shop, 'POST', '/purchase-orders', {
        store_id: shop.store.id,
        supplier_id: supplier.id,
        lines: [{ product_id: product.id, qty_milli: 1_000 }],
      }),
      201,
    ).id
  })
  afterAll(() => t.close())

  it('registers every route of the purchases catalogue', () => {
    for (const [key, def] of Object.entries(purchasesRoutes)) {
      expect({
        key,
        registered: t.app.hasRoute({ method: def.method, url: `${API}${def.path}` }),
      }).toEqual({
        key,
        registered: true,
      })
    }
  })

  it('requires authentication', async () => {
    expectError(
      await req(shop, 'GET', '/purchase-bills', undefined, { as: null }),
      401,
      'UNAUTHENTICATED',
    )
  })

  it('denies members without purchases permissions (cashier) on every route', async () => {
    const id = newId()
    const line = { product_id: product.id, qty_milli: 1_000, unit_cost_paise: 100 }
    // Valid requests, so the permission guard (not schema validation) decides.
    const bodies: Partial<Record<keyof typeof purchasesRoutes, unknown>> = {
      createOrder: { store_id: shop.store.id, supplier_id: supplier.id, lines: [line] },
      updateOrder: { notes: 'x' },
      createBill: {
        supplier_id: supplier.id,
        store_id: shop.store.id,
        supplier_invoice_no: 'C-1',
        supplier_invoice_date: today,
        lines: [line],
      },
      updateBill: { notes: 'x' },
      cancelBill: { reason: 'Not allowed' },
      createDebitNote: {
        bill_id: id,
        reason: 'return',
        lines: [{ bill_line_id: id, qty_milli: 1_000 }],
      },
      cancelDebitNote: { reason: 'Not allowed' },
      updateStockSenseSettings: {
        suppliers: [{ supplier_id: supplier.id, lead_time_days: 3 }],
      },
      importSalesHistory: {
        store_id: shop.store.id,
        csv: 'product,date,qty\nSKU,2026-10-10,1',
      },
    }
    const queries: Partial<Record<keyof typeof purchasesRoutes, string>> = {
      debitNotePrefill: `?batch_ids=${id}&store_id=${shop.store.id}`,
      reorderSuggestions: `?store_id=${shop.store.id}`,
      stockSense: `?store_id=${shop.store.id}`,
      stockSenseProduct: `?store_id=${shop.store.id}`,
    }
    const results: string[] = []
    for (const [key, def] of Object.entries(purchasesRoutes) as Array<
      [keyof typeof purchasesRoutes, (typeof purchasesRoutes)[keyof typeof purchasesRoutes]]
    >) {
      const url =
        routeUrl(def, { id, orderId: id, productId: id }).slice(API.length) + (queries[key] ?? '')
      const body = def.method === 'GET' || def.method === 'DELETE' ? undefined : (bodies[key] ?? {})
      const res = await req(shop, def.method as 'GET' | 'POST' | 'PATCH' | 'DELETE', url, body, {
        as: cashier,
      })
      results.push(
        `${key} ${String(res.statusCode)} ${res.statusCode === 403 ? errorCode(res.body) : res.body}`,
      )
    }
    expect(results).toEqual(Object.keys(purchasesRoutes).map((k) => `${k} 403 FORBIDDEN`))
  })

  it('lets read-only roles read but not write; inventory clerks write', async () => {
    expect(
      (await req(shop, 'GET', '/purchase-bills', undefined, { as: accountant })).statusCode,
    ).toBe(200)
    expect(
      (await req(shop, 'GET', `/purchase-bills/${billId}`, undefined, { as: accountant }))
        .statusCode,
    ).toBe(200)
    expect((await req(shop, 'GET', '/debit-notes', undefined, { as: accountant })).statusCode).toBe(
      200,
    )
    expect(
      (
        await req(
          shop,
          'GET',
          `/purchases/reorder-suggestions?store_id=${shop.store.id}`,
          undefined,
          { as: accountant },
        )
      ).statusCode,
    ).toBe(200)
    expectError(
      await req(shop, 'POST', `/purchase-bills/${billId}/post`, {}, { as: accountant }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await req(
        shop,
        'POST',
        '/purchase-orders',
        {
          store_id: shop.store.id,
          supplier_id: supplier.id,
          lines: [{ product_id: product.id, qty_milli: 1_000 }],
        },
        { as: accountant },
      ),
      403,
      'FORBIDDEN',
    )
    const created = await req(
      shop,
      'POST',
      '/purchase-orders',
      {
        store_id: shop.store.id,
        supplier_id: supplier.id,
        lines: [{ product_id: product.id, qty_milli: 1_000 }],
      },
      { as: clerk },
    )
    expect(created.statusCode).toBe(201)
  })

  it('gates every route behind the purchases plan feature (free plan → 402)', async () => {
    const s = await makeSupplier(t, freeShop.tenant.id)
    const p = await makeProduct(t, freeShop.tenant.id)
    expectError(await req(freeShop, 'GET', '/purchase-orders'), 402, 'FEATURE_NOT_IN_PLAN')
    expectError(await req(freeShop, 'GET', '/purchase-bills'), 402, 'FEATURE_NOT_IN_PLAN')
    expectError(await req(freeShop, 'GET', '/debit-notes'), 402, 'FEATURE_NOT_IN_PLAN')
    expectError(
      await req(freeShop, 'GET', `/purchases/reorder-suggestions?store_id=${freeShop.store.id}`),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    const err = expectError(
      await req(freeShop, 'POST', '/purchase-bills', {
        supplier_id: s.id,
        store_id: freeShop.store.id,
        supplier_invoice_no: 'F-1',
        supplier_invoice_date: today,
        lines: [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 100 }],
      }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    expect(err.details).toMatchObject({ feature: 'purchases' })
  })

  it('isolates tenants: documents, suppliers and products of another tenant are invisible', async () => {
    expectError(await req(other, 'GET', `/purchase-bills/${billId}`), 404, 'NOT_FOUND')
    expectError(await req(other, 'GET', `/purchase-orders/${orderId}`), 404, 'NOT_FOUND')
    expectError(await req(other, 'GET', `/purchase-bills/${billId}/returnable`), 404, 'NOT_FOUND')
    expectError(await req(other, 'POST', `/purchase-bills/${billId}/post`, {}), 404, 'NOT_FOUND')
    expectError(await req(other, 'DELETE', `/purchase-bills/${billId}`), 404, 'NOT_FOUND')
    expectError(
      await req(other, 'POST', `/purchase-bills/from-order/${orderId}`, {}),
      404,
      'NOT_FOUND',
    )
    const lists = await Promise.all(
      ['/purchase-bills', '/purchase-orders', '/debit-notes'].map((u) =>
        req(other, 'GET', u).then((r) =>
          r.json<{ data: { id: string }[] }>().data.map((x) => x.id),
        ),
      ),
    )
    expect(lists.flat()).not.toContain(billId)
    expect(lists.flat()).not.toContain(orderId)
    // Their own supplier with our product (and vice versa) is not found.
    const theirs = await makeSupplier(t, other.tenant.id)
    expectError(
      await req(other, 'POST', '/purchase-bills', {
        supplier_id: theirs.id,
        store_id: other.store.id,
        supplier_invoice_no: 'X-1',
        supplier_invoice_date: today,
        lines: [{ product_id: product.id, qty_milli: 1_000, unit_cost_paise: 100 }],
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await req(other, 'POST', '/purchase-orders', {
        store_id: other.store.id,
        supplier_id: supplier.id,
        lines: [{ product_id: product.id, qty_milli: 1_000 }],
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await req(other, 'GET', `/purchases/reorder-suggestions?store_id=${shop.store.id}`),
      404,
      'NOT_FOUND',
    )
    expectError(
      await req(other, 'POST', '/debit-notes', {
        bill_id: billId,
        reason: 'return',
        lines: [{ bill_line_id: newId(), qty_milli: 1_000 }],
      }),
      404,
      'NOT_FOUND',
    )
  })

  it('scopes store-restricted members to their stores', async () => {
    const branch = await makeStore(t, shop.tenant.id, 'S2')
    const scoped = await shop.asRole('inventory_clerk', { store_ids: [branch.id] })
    expectError(
      await req(shop, 'GET', `/purchase-bills/${billId}`, undefined, { as: scoped }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await req(shop, 'GET', `/purchase-orders/${orderId}`, undefined, { as: scoped }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await req(shop, 'GET', `/purchase-bills?store_id=${shop.store.id}`, undefined, {
        as: scoped,
      }),
      403,
      'FORBIDDEN',
    )
    const mine = await req(shop, 'GET', '/purchase-bills', undefined, { as: scoped })
    expect(mine.json<{ data: { id: string }[] }>().data.map((r) => r.id)).not.toContain(billId)
    expectError(
      await req(
        shop,
        'POST',
        '/purchase-bills',
        {
          supplier_id: supplier.id,
          store_id: shop.store.id,
          supplier_invoice_no: 'SC-1',
          supplier_invoice_date: today,
          lines: [{ product_id: product.id, qty_milli: 1_000, unit_cost_paise: 100 }],
        },
        { as: scoped },
      ),
      403,
      'FORBIDDEN',
    )
    const own = await req(
      shop,
      'POST',
      '/purchase-bills',
      {
        supplier_id: supplier.id,
        store_id: branch.id,
        supplier_invoice_no: 'SC-2',
        supplier_invoice_date: today,
        lines: [{ product_id: product.id, qty_milli: 1_000, unit_cost_paise: 100 }],
      },
      { as: scoped },
    )
    expect(own.statusCode).toBe(201)
    const ownList = await req(shop, 'GET', '/purchase-bills', undefined, { as: scoped })
    expect(
      ownList.json<{ data: { store_id: string }[] }>().data.every((r) => r.store_id === branch.id),
    ).toBe(true)
  })
})

function errorCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code
}
