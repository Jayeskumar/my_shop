/**
 * Offline POS: bootstrap (full / delta / tombstones / 20k products) and POST /pos/sync (in-order
 * acceptance, renumbering, duplicates, failures that do not block, negative stock, returns).
 */
import { addDays, newId, periodOf, todayIn } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { posBootstrap } from '../bootstrap'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  API,
  addStock,
  clientRef,
  dataOf,
  expectLedgerBalanced,
  expectStockConsistent,
  insertBatch,
  insertCustomer,
  insertProduct,
  line,
  sell,
  stockOf,
} from './fixtures'

let t: TestApp
let shop: TestShop
let today: string

interface Bootstrap {
  mode: 'full' | 'delta'
  cursor: string
  products: Array<{
    id: string
    sale_price_paise: number
    stock_qty_milli: number | null
    tax_slab_rule_id: string | null
  }>
  barcodes: Array<{ barcode: string; product_id: string }>
  barcode_product_ids: string[]
  batches: Array<{ id: string; product_id: string; qty_milli: number; expiry_date: string | null }>
  promotions: Array<{ id: string; data: { kind: string } }>
  customers: Array<{ id: string; balance_paise: number }>
  series: {
    doc_type: string
    next: string
    next_number: number
    prefix: string
    padding: number
  } | null
  open_shift: { id: string } | null
  shift_required: boolean
  register: { id: string; code: string } | null
  payment_providers: Array<{
    provider: string
    vpa: string | null
    capabilities: { manual_confirm: boolean }
  }>
  removed_product_ids: string[]
  removed_barcodes: string[]
  removed_batch_ids: string[]
  removed_promotion_ids: string[]
  settings: { pos: { quick_keys: string[] } }
  features: string[]
}

interface SyncResult {
  results: Array<{
    kind: string
    client_ref: string
    status: 'created' | 'duplicate' | 'renumbered' | 'failed'
    id: string | null
    number: string | null
    offline_number: string | null
    error: { code: string; details: Record<string, unknown> | null } | null
    warnings: Array<{ code: string }>
  }>
  created: number
  duplicates: number
  renumbered: number
  failed: number
  series: { next: string; next_number: number } | null
}

async function bootstrap(s: TestShop, query = '') {
  return dataOf<Bootstrap>(
    await s.inject({
      method: 'GET',
      url: `${API}/pos/bootstrap?register_id=${s.register.id}${query}`,
    }),
  )
}

function offlineInvoice(
  s: TestShop,
  productId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    client_ref: clientRef(),
    store_id: s.store.id,
    register_id: s.register.id,
    lines: [line(productId)],
    tenders: [{ method: 'cash', amount_paise: 10_000 }],
    invoice_date: today,
    offline_created_at: new Date().toISOString(),
    offline_number: null,
    ...extra,
  }
}

async function sync(s: TestShop, body: Record<string, unknown>) {
  return dataOf<SyncResult>(
    await s.inject({
      method: 'POST',
      url: `${API}/pos/sync`,
      payload: { register_id: s.register.id, ...body },
    }),
  )
}

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t)
  today = todayIn('Asia/Kolkata')
})
afterAll(() => t.close())

describe('GET /pos/bootstrap', () => {
  it('full: catalogue with stock, barcodes, FEFO batches, promotions, customers, series and providers', async () => {
    const s = await createTestTenant(t)
    const rule = newId()
    await t.deps.db.systemDb
      .insertInto('tax_slab_rules')
      .values({
        id: rule,
        tenant_id: s.tenant.id,
        name: 'Footwear',
        slabs: JSON.stringify([
          { max_unit_value_paise: 100_000, gst_rate_bp: 500 },
          { max_unit_value_paise: null, gst_rate_bp: 1800 },
        ]),
      })
      .execute()
    const cat = newId()
    await t.deps.db.systemDb
      .insertInto('categories')
      .values({
        id: cat,
        tenant_id: s.tenant.id,
        name: `Footwear ${cat.slice(-4)}`,
        tax_slab_rule_id: rule,
      })
      .execute()
    const p = await insertProduct(t, s, { sale_price_paise: 9_900, category_id: cat })
    const med = await insertProduct(t, s, { track_batches: true })
    const inactive = await insertProduct(t, s, { is_active: false })
    await addStock(s, { product_id: p, qty_milli: 7_000 })
    const late = await insertBatch(t, s, med, { expiry_date: addDays(today, 200) })
    const soon = await insertBatch(t, s, med, { expiry_date: addDays(today, 20) })
    const empty = await insertBatch(t, s, med, { expiry_date: addDays(today, 10) })
    await addStock(s, { product_id: med, qty_milli: 2_000, batch_id: late })
    await addStock(s, { product_id: med, qty_milli: 1_000, batch_id: soon })
    await t.deps.db.systemDb
      .insertInto('product_barcodes')
      .values({
        id: newId(),
        tenant_id: s.tenant.id,
        product_id: p,
        barcode: `890${Date.now()}`.slice(0, 13),
      })
      .execute()
    await t.deps.db.systemDb
      .insertInto('promotions')
      .values({
        id: newId(),
        tenant_id: s.tenant.id,
        name: 'Bill 5%',
        kind: 'bill_percent',
        rules: JSON.stringify({ percent_bp: 500 }),
      })
      .execute()
    await t.deps.db.systemDb
      .insertInto('payment_provider_accounts')
      .values({
        id: newId(),
        tenant_id: s.tenant.id,
        provider: 'upi_vpa',
        display_name: 'UPI',
        vpa: 'shop@okicici',
        is_default: true,
      })
      .execute()
    const c = await insertCustomer(t, s, { name: 'Lakshmi' })

    const b = await bootstrap(s)
    expect(b.mode).toBe('full')
    expect(b.register?.id).toBe(s.register.id)
    const prod = b.products.find((x) => x.id === p)!
    expect(prod.stock_qty_milli).toBe(7_000)
    expect(prod.tax_slab_rule_id).toBe(rule)
    expect(b.products.map((x) => x.id)).not.toContain(inactive)
    expect(b.barcodes.map((x) => x.product_id)).toContain(p)
    expect(b.batches.filter((x) => x.product_id === med).map((x) => x.id)).toEqual([soon, late])
    expect(b.batches.map((x) => x.id)).not.toContain(empty)
    expect(b.promotions[0]?.data.kind).toBe('bill_percent')
    expect(b.customers.map((x) => x.id)).toContain(c)
    expect(b.series).toMatchObject({ doc_type: 'sales_invoice', next_number: 1 })
    expect(b.series?.next).toMatch(/^S1-A\/\d{4}\/00001$/)
    expect(b.payment_providers[0]).toMatchObject({
      provider: 'upi_vpa',
      vpa: 'shop@okicici',
      capabilities: { manual_confirm: true },
    })
    expect(b.shift_required).toBe(false)
  })

  it('delta: changed rows since the cursor, deactivations and hard deletes', async () => {
    const s = await createTestTenant(t)
    const keep = await insertProduct(t, s, { sale_price_paise: 1_000 })
    const change = await insertProduct(t, s, { sale_price_paise: 2_000 })
    const deactivate = await insertProduct(t, s)
    const remove = await insertProduct(t, s)
    const sold = await insertProduct(t, s)
    await addStock(s, { product_id: sold, qty_milli: 5_000 })
    const promo = newId()
    await t.deps.db.systemDb
      .insertInto('promotions')
      .values({
        id: promo,
        tenant_id: s.tenant.id,
        name: 'Flat',
        kind: 'bill_flat',
        rules: JSON.stringify({ flat_paise: 500 }),
      })
      .execute()
    const full = await bootstrap(s)
    expect(full.products.map((p) => p.id)).toEqual(
      expect.arrayContaining([keep, change, deactivate, remove, sold]),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ sale_price_paise: 2_500 })
      .where('id', '=', change)
      .execute()
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ is_active: false })
      .where('id', '=', deactivate)
      .execute()
    await t.deps.db.systemDb.deleteFrom('products').where('id', '=', remove).execute()
    await t.deps.db.systemDb.deleteFrom('promotions').where('id', '=', promo).execute()
    await sell(s, { lines: [line(sold)], tenders: [{ method: 'cash', amount_paise: 10_000 }] })

    // Through the route (with the default overlap, recent rows are re-sent too) …
    const viaRoute = await bootstrap(s, `&since=${full.cursor}`)
    expect(viaRoute.mode).toBe('delta')
    expect(viaRoute.products.map((p) => p.id)).toEqual(expect.arrayContaining([change, sold]))
    // … and exactly what changed after the cursor without the overlap.
    const d = await s.tx((tx) =>
      posBootstrap(tx, s.ctx, { register_id: s.register.id, since: full.cursor }, { overlapMs: 0 }),
    )
    expect(d.mode).toBe('delta')
    const ids = d.products.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining([change, sold]))
    expect(ids).not.toContain(keep)
    expect(d.products.find((p) => p.id === change)?.sale_price_paise).toBe(2_500)
    expect(d.products.find((p) => p.id === sold)?.stock_qty_milli).toBe(4_000)
    expect(d.removed_product_ids).toEqual(expect.arrayContaining([deactivate, remove]))
    expect(d.removed_promotion_ids).toContain(promo)
    expect(d.barcode_product_ids).toEqual(expect.arrayContaining([change, sold]))

    // Foreign / garbage / too old cursors give a full bootstrap.
    expect((await bootstrap(s, '&since=garbage')).mode).toBe('full')
    const ancient = Buffer.from(
      JSON.stringify({ v: 1, t: '2020-01-01T00:00:00.000Z', s: s.store.id }),
      'utf8',
    ).toString('base64url')
    expect((await bootstrap(s, `&since=${ancient}`)).mode).toBe('full')
  })

  it('needs pos.use and a register or store of the member', async () => {
    const clerk = await shop.asRole('inventory_clerk')
    const res = await shop.inject({
      method: 'GET',
      url: `${API}/pos/bootstrap?register_id=${shop.register.id}`,
      as: clerk,
    })
    expect(res.statusCode).toBe(403)
    const cashier = await shop.asRole('cashier')
    const ok = await shop.inject({
      method: 'GET',
      url: `${API}/pos/bootstrap?store_id=${shop.store.id}`,
      as: cashier,
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { data: Bootstrap }).data.register).toBeNull()
    const none = await shop.inject({ method: 'GET', url: `${API}/pos/bootstrap` })
    expect(none.statusCode).toBe(400)
    const other = await createTestTenant(t)
    const foreign = await other.inject({
      method: 'GET',
      url: `${API}/pos/bootstrap?register_id=${shop.register.id}`,
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('handles a 20,000-product catalogue with single queries', async () => {
    const big = await createTestTenant(t, { name: 'Big Supermarket' })
    await sql`
      insert into products (id, tenant_id, name, sale_price_paise, gst_rate_bp, hsn_code, unit)
      select gen_random_uuid(), ${big.tenant.id}, 'Item ' || g, 1000 + g, 500, '1006', 'PCS'
        from generate_series(1, 20000) g`.execute(t.deps.db.systemDb)
    await sql`
      insert into product_barcodes (id, tenant_id, product_id, barcode)
      select gen_random_uuid(), p.tenant_id, p.id, '89' || lpad(row_number() over (order by p.id)::text, 11, '0')
        from products p where p.tenant_id = ${big.tenant.id}`.execute(t.deps.db.systemDb)
    const started = performance.now()
    const res = await big.inject({
      method: 'GET',
      url: `${API}/pos/bootstrap?register_id=${big.register.id}`,
    })
    const ms = performance.now() - started
    expect(res.statusCode).toBe(200)
    const b = (res.json() as { data: Bootstrap }).data
    expect(b.products).toHaveLength(20_000)
    expect(b.barcodes).toHaveLength(20_000)
    console.warn(
      `[pos.bootstrap] 20k products: ${Math.round(ms)} ms, ${Math.round(res.body.length / 1024)} KiB`,
    )
    expect(ms).toBeLessThan(15_000)
  }, 60_000)
})

describe('POST /pos/sync', () => {
  it('accepts offline bills in order, keeps matching numbers, renumbers gaps, skips duplicates', async () => {
    const s = await createTestTenant(t)
    const p = await insertProduct(t, s, { sale_price_paise: 10_000, track_inventory: false })
    const b = await bootstrap(s)
    const series = b.series!
    const num = (n: number) => `${series.prefix}${String(n).padStart(series.padding, '0')}`
    const first = offlineInvoice(s, p, { offline_number: num(1) })
    const second = offlineInvoice(s, p, { offline_number: num(2) })
    const gap = offlineInvoice(s, p, { offline_number: num(9) })
    const bad = offlineInvoice(s, p, { lines: [line(newId())] })
    const after = offlineInvoice(s, p, { offline_number: num(4) })
    const r = await sync(s, { invoices: [first, second, gap, bad, after] })
    expect(r.results.map((x) => x.status)).toEqual([
      'created',
      'created',
      'renumbered',
      'failed',
      'created',
    ])
    expect(r.results[0]?.number).toBe(num(1))
    expect(r.results[1]?.number).toBe(num(2))
    expect(r.results[2]).toMatchObject({ number: num(3), offline_number: num(9) })
    expect(r.results[3]?.error?.code).toBe('NOT_FOUND')
    expect(r.results[4]?.number).toBe(num(4))
    expect(r).toMatchObject({ created: 3, renumbered: 1, failed: 1, duplicates: 0 })
    expect(r.series?.next).toBe(num(5))
    const audit = await t.deps.db.systemDb
      .selectFrom('audit_logs')
      .select('action')
      .where('entity_id', '=', r.results[2]!.id!)
      .execute()
    expect(audit.map((a) => a.action)).toContain('sales_invoice.renumbered')
    const inv = dataOf<{ offline: boolean; offline_created_at: string | null; channel: string }>(
      await s.inject({ method: 'GET', url: `${API}/sales/invoices/${r.results[0]!.id}` }),
    )
    expect(inv).toMatchObject({ offline: true, channel: 'pos' })

    const again = await sync(s, { invoices: [first] })
    expect(again.results[0]).toMatchObject({ status: 'duplicate', id: r.results[0]!.id })
    await expectLedgerBalanced(t, s.tenant.id)
  })

  it('posts offline bills into negative stock (flagged and audited) and ignores the monthly limit', async () => {
    const pharmacy = await createTestTenant(t, { business_type: 'pharmacy', plan_code: 'free' })
    await t.deps.db.systemDb
      .insertInto('usage_counters')
      .values({
        tenant_id: pharmacy.tenant.id,
        metric: 'invoices',
        period: periodOf(today),
        value: 300,
      })
      .execute()
    const p = await insertProduct(t, pharmacy, { sale_price_paise: 1_000, track_batches: true })
    const batch = await insertBatch(t, pharmacy, p, { expiry_date: addDays(today, 100) })
    await addStock(pharmacy, { product_id: p, qty_milli: 1_000, batch_id: batch })
    const r = await sync(pharmacy, {
      invoices: [
        offlineInvoice(pharmacy, p, {
          lines: [line(p, 3_000)],
          tenders: [{ method: 'cash', amount_paise: 3_000 }],
        }),
      ],
    })
    expect(r.results[0]?.status).toBe('created')
    expect(r.results[0]?.warnings.map((w) => w.code)).toContain('offline_negative_stock')
    expect(await stockOf(t, pharmacy.tenant.id, p, batch)).toBe(-2_000)
    const lines = await t.deps.db.systemDb
      .selectFrom('sales_invoice_lines')
      .select('meta')
      .where('invoice_id', '=', r.results[0]!.id!)
      .execute()
    expect(lines[0]?.meta).toMatchObject({ offline_negative_stock: true })
    const audit = await t.deps.db.systemDb
      .selectFrom('audit_logs')
      .select('action')
      .where('entity_id', '=', r.results[0]!.id!)
      .execute()
    expect(audit.map((a) => a.action)).toContain('sales_invoice.offline_exceptions')
    await expectStockConsistent(t, pharmacy.tenant.id)
  })

  it('uploads offline returns after the bills, by the offline invoice reference', async () => {
    const s = await createTestTenant(t)
    const p = await insertProduct(t, s, { sale_price_paise: 4_000 })
    await addStock(s, { product_id: p, qty_milli: 5_000 })
    const inv = offlineInvoice(s, p, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 8_000 }],
    })
    const r = await sync(s, {
      invoices: [inv],
      credit_notes: [
        {
          client_ref: clientRef(),
          invoice_client_ref: inv['client_ref'],
          lines: [{ invoice_line_no: 1, qty_milli: 1_000 }],
          reason: 'return',
          settlement: 'cash',
          note_date: today,
          offline_created_at: new Date().toISOString(),
        },
      ],
    })
    expect(r.results.map((x) => [x.kind, x.status])).toEqual([
      ['invoice', 'created'],
      ['credit_note', 'created'],
    ])
    expect(r.results[1]?.number).toMatch(/^CNS1\//)
    expect(await stockOf(t, s.tenant.id, p)).toBe(4_000)
  })

  it('rejects bills of another register / store and empty uploads', async () => {
    const p = await insertProduct(t, shop, { track_inventory: false })
    const other = await createTestTenant(t)
    const r = await sync(shop, {
      invoices: [offlineInvoice(shop, p, { store_id: other.store.id })],
    })
    expect(r.results[0]?.status).toBe('failed')
    const empty = await shop.inject({
      method: 'POST',
      url: `${API}/pos/sync`,
      payload: { register_id: shop.register.id },
    })
    expect(empty.statusCode).toBe(400)
    const foreign = await other.inject({
      method: 'POST',
      url: `${API}/pos/sync`,
      payload: { register_id: shop.register.id, invoices: [offlineInvoice(shop, p)] },
    })
    expect(foreign.statusCode).toBe(404)
  })
})
