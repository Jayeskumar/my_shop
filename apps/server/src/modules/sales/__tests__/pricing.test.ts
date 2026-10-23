/**
 * Pricing rules (POST /pos/quote and invoice create): totals reconcile with the shared engine,
 * GST schemes and slabs, promotions, price tiers / store prices, overrides, FEFO split, expiry,
 * prescriptions, stock policy, serial numbers, loyalty, back dating and open shifts.
 */
import { addDays, newId, todayIn } from '@kadai/shared'
import { priceCart } from '@kadai/shared/api/sales'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  API,
  type SaleData,
  addStock,
  createSale,
  customerBalance,
  dataOf,
  errorOf,
  insertBatch,
  insertCustomer,
  insertProduct,
  line,
  sell,
  setSettings,
  stockOf,
} from './fixtures'

let t: TestApp
let shop: TestShop
let today: string

interface Quote {
  doc_type: string
  tax_mode: string
  total_paise: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  round_off_paise: number
  bill_discount_paise: number
  item_discount_paise: number
  loyalty_redeem_paise: number
  loyalty_points_redeemed: number
  lines: Array<{
    key: string
    source_key: string
    batch_id: string | null
    qty_milli: number
    gst_rate_bp: number
    unit_price_paise: number
    price_source: string
    promotion_discount_paise: number
    total_paise: number
  }>
  applied_promotions: Array<{ promotion_id: string; level: string; discount_paise: number }>
  issues: Array<{ code: string; severity: string; line_key: string | null }>
  can_complete: boolean
  requires: { rx: boolean; price_override: boolean; discount_override: boolean; credit: boolean }
  tenders: { due_paise: number; change_paise: number } | null
  credit: { due_paise: number; blocked: boolean } | null
  loyalty: { points_available: number; points_to_earn: number } | null
}

async function quote(
  s: TestShop,
  body: Record<string, unknown>,
  as?: Parameters<TestShop['inject']>[0]['as'],
) {
  return s.inject({
    method: 'POST',
    url: `${API}/pos/quote`,
    payload: { store_id: s.store.id, register_id: s.register.id, ...body },
    ...(as !== undefined ? { as } : {}),
  })
}

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t)
  today = todayIn('Asia/Kolkata')
})
afterAll(() => t.close())

describe('POST /pos/quote', () => {
  it('reconciles with the shared engine (inclusive, exclusive, cess, bill discount) and writes nothing', async () => {
    const a = await insertProduct(t, shop, { sale_price_paise: 11_800, gst_rate_bp: 1800 })
    const b = await insertProduct(t, shop, {
      sale_price_paise: 25_000,
      gst_rate_bp: 2800,
      cess_rate_bp: 1200,
      price_includes_tax: false,
    })
    const c = await insertProduct(t, shop, { sale_price_paise: 3_333, gst_rate_bp: 500 })
    const q = dataOf<Quote>(
      await quote(shop, {
        lines: [
          { key: 'a', ...line(a, 3000), discount_bp: 500 },
          { key: 'b', ...line(b, 1000), discount_paise: 1_000 },
          { key: 'c', ...line(c, 7000) },
        ],
        bill_discount_bp: 300,
      }),
    )
    const local = priceCart({
      lines: [
        {
          key: 'a',
          product_id: a,
          unit_price_paise: 11_800,
          qty_milli: 3000,
          price_includes_tax: true,
          gst_rate_bp: 1800,
          discount_bp: 500,
        },
        {
          key: 'b',
          product_id: b,
          unit_price_paise: 25_000,
          qty_milli: 1000,
          price_includes_tax: false,
          gst_rate_bp: 2800,
          cess_rate_bp: 1200,
          discount_paise: 1_000,
        },
        {
          key: 'c',
          product_id: c,
          unit_price_paise: 3_333,
          qty_milli: 7000,
          price_includes_tax: true,
          gst_rate_bp: 500,
        },
      ],
      tax_mode: 'regular',
      is_interstate: false,
      round_off: 'nearest_rupee',
      bill_discount_bp: 300,
    })
    expect(q.total_paise).toBe(local.total_paise)
    expect(q.taxable_paise).toBe(local.taxable_paise)
    expect(q.cgst_paise).toBe(local.cgst_paise)
    expect(q.cess_paise).toBe(local.cess_paise)
    expect(q.round_off_paise).toBe(local.round_off_paise)
    expect(q.bill_discount_paise).toBe(local.bill_discount_paise)
    expect(q.lines.map((l) => l.total_paise)).toEqual(local.lines.map((l) => l.total_paise))
    expect(q.can_complete).toBe(true)
    const count = await t.deps.db.systemDb
      .selectFrom('sales_invoices')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tenant_id', '=', shop.tenant.id)
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(0)
  })

  it('interstate place of supply charges IGST', async () => {
    const a = await insertProduct(t, shop, { sale_price_paise: 11_800, gst_rate_bp: 1800 })
    const q = dataOf<Quote>(await quote(shop, { lines: [line(a)], place_of_supply: '29' }))
    expect(q.igst_paise).toBe(1_800)
    expect(q.cgst_paise + q.sgst_paise).toBe(0)
  })

  it('reports issues and requirements instead of failing', async () => {
    const pharmacy = await createTestTenant(t, { business_type: 'pharmacy' })
    const drug = await insertProduct(t, pharmacy, {
      sale_price_paise: 3_200,
      gst_rate_bp: 500,
      pack_size: 10,
      unit: 'TAB',
      allow_loose: true,
      track_batches: true,
      attributes: { schedule: 'H' },
    })
    const batch = await insertBatch(t, pharmacy, drug, { expiry_date: addDays(today, 400) })
    await addStock(pharmacy, {
      product_id: drug,
      qty_milli: 50_000,
      batch_id: batch,
      unit_cost_paise: 2_000,
    })
    const q = dataOf<Quote>(await quote(pharmacy, { lines: [{ key: 'd', ...line(drug, 15_000) }] }))
    expect(q.can_complete).toBe(false)
    expect(q.requires.rx).toBe(true)
    expect(q.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'rx_required', severity: 'error', line_key: 'd' }),
      ]),
    )
    // 1.5 strips at Rs 32 per strip of 10.
    expect(q.total_paise).toBe(4_800)

    const withTenders = dataOf<Quote>(
      await quote(pharmacy, {
        lines: [line(drug, 10_000)],
        rx: { doctor_name: 'Dr. Lakshmi', patient_name: 'Ravi' },
        tenders: [{ method: 'cash', amount_paise: 5_000 }],
      }),
    )
    expect(withTenders.can_complete).toBe(true)
    expect(withTenders.tenders?.change_paise).toBe(1_800)
  })

  it('cashier role may quote; members without pos.use / sales.create may not', async () => {
    const p = await insertProduct(t, shop, { track_inventory: false })
    const cashier = await shop.asRole('cashier')
    expect((await quote(shop, { lines: [line(p)] }, cashier)).statusCode).toBe(200)
    const clerk = await shop.asRole('inventory_clerk')
    expect((await quote(shop, { lines: [line(p)] }, clerk)).statusCode).toBe(403)
  })
})

describe('GST schemes and slabs', () => {
  it('composition dealer: bill of supply, no tax, BOS series', async () => {
    const comp = await createTestTenant(t, { gst_scheme: 'composition' })
    const p = await insertProduct(t, comp, {
      sale_price_paise: 11_800,
      gst_rate_bp: 1800,
      track_inventory: false,
    })
    const r = await sell(comp, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 11_800 }],
    })
    expect(r.invoice['doc_type']).toBe('bill_of_supply')
    expect(r.invoice.total_paise).toBe(11_800)
    expect(r.invoice['taxable_paise']).toBe(11_800)
    expect(r.invoice['cgst_paise']).toBe(0)
    expect(r.invoice.number).toMatch(/^S1-AB\//)
    const print = dataOf<{ composition_declaration: { en: string } | null; title: { en: string } }>(
      await comp.inject({ method: 'GET', url: `${API}/sales/invoices/${r.invoice.id}/print` }),
    )
    expect(print.title.en).toBe('Bill of Supply')
    expect(print.composition_declaration?.en).toMatch(/Composition taxable person/)
  })

  it('apparel price slab: 5% up to Rs 2,500 per piece, 18% above', async () => {
    const rule = newId()
    await t.deps.db.systemDb
      .insertInto('tax_slab_rules')
      .values({
        id: rule,
        tenant_id: shop.tenant.id,
        name: 'Apparel',
        slabs: JSON.stringify([
          { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
          { max_unit_value_paise: null, gst_rate_bp: 1800 },
        ]),
      })
      .execute()
    const shirt = await insertProduct(t, shop, {
      sale_price_paise: 200_000,
      gst_rate_bp: 500,
      tax_slab_rule_id: rule,
      track_inventory: false,
    })
    const saree = await insertProduct(t, shop, {
      sale_price_paise: 300_000,
      gst_rate_bp: 500,
      tax_slab_rule_id: rule,
      track_inventory: false,
    })
    const q = dataOf<Quote>(await quote(shop, { lines: [line(shirt), line(saree)] }))
    expect(q.lines.map((l) => l.gst_rate_bp)).toEqual([500, 1800])
    // A bill discount that brings the saree under the threshold moves it to 5%.
    const discounted = dataOf<Quote>(
      await quote(shop, { lines: [line(saree, 1000, { discount_paise: 60_000 })] }),
    )
    expect(discounted.lines[0]?.gst_rate_bp).toBe(500)
  })
})

describe('prices, promotions and overrides', () => {
  it('wholesale customers get the wholesale tier; store price overrides win', async () => {
    const p = await insertProduct(t, shop, {
      sale_price_paise: 10_000,
      wholesale_price_paise: 9_000,
      track_inventory: false,
    })
    const w = await insertCustomer(t, shop, { price_tier: 'wholesale' })
    const q = dataOf<Quote>(await quote(shop, { customer_id: w, lines: [line(p)] }))
    expect(q.lines[0]).toMatchObject({ unit_price_paise: 9_000, price_source: 'price_tier' })
    await t.deps.db.systemDb
      .insertInto('store_product_prices')
      .values({
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        product_id: p,
        sale_price_paise: 9_500,
      })
      .execute()
    const q2 = dataOf<Quote>(await quote(shop, { customer_id: w, lines: [line(p)] }))
    expect(q2.lines[0]).toMatchObject({ unit_price_paise: 9_500, price_source: 'store_price' })
  })

  it('promotions apply on Pro but not on the free plan', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 10_000, track_inventory: false })
    const promo = newId()
    await t.deps.db.systemDb
      .insertInto('promotions')
      .values({
        id: promo,
        tenant_id: shop.tenant.id,
        name: '10% off',
        kind: 'item_percent',
        rules: JSON.stringify({ product_ids: [p], percent_bp: 1000 }),
      })
      .execute()
    const q = dataOf<Quote>(await quote(shop, { lines: [line(p, 2000)] }))
    expect(q.lines[0]?.promotion_discount_paise).toBe(2_000)
    expect(q.total_paise).toBe(18_000)
    expect(q.applied_promotions[0]).toMatchObject({
      promotion_id: promo,
      level: 'item',
      discount_paise: 2_000,
    })
    const r = await sell(shop, {
      lines: [line(p, 2000)],
      tenders: [{ method: 'cash', amount_paise: 18_000 }],
    })
    expect(r.invoice.lines[0]?.['promotion_id']).toBe(promo)

    const free = await createTestTenant(t, { plan_code: 'free' })
    const fp = await insertProduct(t, free, { sale_price_paise: 10_000, track_inventory: false })
    await t.deps.db.systemDb
      .insertInto('promotions')
      .values({
        id: newId(),
        tenant_id: free.tenant.id,
        name: '10% off',
        kind: 'item_percent',
        rules: JSON.stringify({ product_ids: [fp], percent_bp: 1000 }),
      })
      .execute()
    const fq = dataOf<Quote>(await quote(free, { lines: [line(fp, 2000)] }))
    expect(fq.total_paise).toBe(20_000)
    expect(fq.applied_promotions).toHaveLength(0)
  })

  it('price overrides need sales.price_override (and never go below the minimum price)', async () => {
    const p = await insertProduct(t, shop, {
      sale_price_paise: 10_000,
      min_sale_price_paise: 8_000,
      track_inventory: false,
    })
    const cashier = await shop.asRole('cashier')
    const denied = await createSale(
      shop,
      { lines: [line(p, 1000, { unit_price_paise: 9_000 })] },
      cashier,
    )
    expect(denied.statusCode).toBe(403)
    expect(errorOf(denied).details?.['reason']).toBe('price_override_required')
    const q = dataOf<Quote>(
      await quote(shop, { lines: [line(p, 1000, { unit_price_paise: 9_000 })] }, cashier),
    )
    expect(q.requires.price_override).toBe(true)

    await setSettings(shop, { pos: { allow_price_edit: true } })
    const editable = await sell(
      shop,
      {
        lines: [line(p, 1000, { unit_price_paise: 9_000 })],
        tenders: [{ method: 'cash', amount_paise: 9_000 }],
      },
      cashier,
    )
    expect(editable.invoice.total_paise).toBe(9_000)
    const below = await createSale(
      shop,
      { lines: [line(p, 1000, { unit_price_paise: 7_000 })] },
      cashier,
    )
    expect(below.statusCode).toBe(403)
    expect(errorOf(below).details?.['reason']).toBe('below_min_price')
    await setSettings(shop, { pos: { allow_price_edit: false } })

    const owner = await sell(shop, {
      lines: [line(p, 1000, { unit_price_paise: 7_000 })],
      tenders: [{ method: 'cash', amount_paise: 7_000 }],
    })
    expect(owner.invoice.lines[0]?.['meta']).toMatchObject({
      price_source: 'manual',
      resolved_price_paise: 10_000,
    })
    const audit = await t.deps.db.systemDb
      .selectFrom('audit_logs')
      .select('action')
      .where('entity_id', '=', owner.invoice.id)
      .execute()
    expect(audit.map((a) => a.action)).toContain('sales_invoice.override')
  })

  it('discounts above the cashier limit need sales.discount_override', async () => {
    const p = await insertProduct(t, shop, {
      sale_price_paise: 10_000,
      max_discount_bp: 500,
      track_inventory: false,
    })
    const cashier = await shop.asRole('cashier')
    const tooMuch = await createSale(
      shop,
      { lines: [line(p, 1000, { discount_bp: 800 })] },
      cashier,
    )
    expect(tooMuch.statusCode).toBe(403)
    expect(errorOf(tooMuch).details?.['reason']).toBe('discount_override_required')
    const fine = await sell(
      shop,
      {
        lines: [line(p, 1000, { discount_bp: 500 })],
        tenders: [{ method: 'cash', amount_paise: 9_500 }],
      },
      cashier,
    )
    expect(fine.invoice.total_paise).toBe(9_500)
    const bill = await createSale(shop, { lines: [line(p)], bill_discount_bp: 2000 }, cashier)
    expect(bill.statusCode).toBe(403)
    const manager = await shop.asRole('manager')
    const ok = await sell(
      shop,
      {
        lines: [line(p, 1000, { discount_bp: 800 })],
        tenders: [{ method: 'cash', amount_paise: 9_200 }],
      },
      manager,
    )
    expect(ok.invoice.total_paise).toBe(9_200)
  })
})

describe('batches, expiry, prescriptions and stock', () => {
  let pharmacy: TestShop
  beforeAll(async () => {
    pharmacy = await createTestTenant(t, { business_type: 'pharmacy' })
  })

  it('FEFO auto-pick splits a line across batches (earliest expiry first)', async () => {
    const p = await insertProduct(t, pharmacy, { sale_price_paise: 1_000, track_batches: true })
    const later = await insertBatch(t, pharmacy, p, {
      batch_no: 'LATE',
      expiry_date: addDays(today, 300),
      sale_price_paise: 1_100,
    })
    const sooner = await insertBatch(t, pharmacy, p, {
      batch_no: 'SOON',
      expiry_date: addDays(today, 30),
    })
    const expired = await insertBatch(t, pharmacy, p, {
      batch_no: 'OLD',
      expiry_date: addDays(today, -1),
    })
    await addStock(pharmacy, { product_id: p, qty_milli: 3_000, batch_id: sooner })
    await addStock(pharmacy, { product_id: p, qty_milli: 5_000, batch_id: later })
    await addStock(pharmacy, { product_id: p, qty_milli: 9_000, batch_id: expired })
    const r = await sell(pharmacy, {
      lines: [{ key: 'x', ...line(p, 6_000) }],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    expect(r.invoice.lines).toHaveLength(2)
    expect(r.invoice.lines.map((l) => [l['batch_id'], l.qty_milli])).toEqual([
      [sooner, 3_000],
      [later, 3_000],
    ])
    // Each part is priced from its own batch.
    expect(r.invoice.total_paise).toBe(3 * 1_000 + 3 * 1_100)
    expect(r.warnings.map((w) => w.code)).toContain('fefo_split')
    expect(r.invoice.lines[1]?.['meta']).toMatchObject({ source_key: 'x', batch_auto: true })
    expect(await stockOf(t, pharmacy.tenant.id, p, sooner)).toBe(0)
    expect(await stockOf(t, pharmacy.tenant.id, p, later)).toBe(2_000)
    expect(await stockOf(t, pharmacy.tenant.id, p, expired)).toBe(9_000)
    const q = dataOf<Quote>(
      await pharmacy.inject({
        method: 'POST',
        url: `${API}/pos/quote`,
        payload: { store_id: pharmacy.store.id, lines: [{ key: 'y', ...line(p, 1_000) }] },
      }),
    )
    expect(q.lines[0]?.key).toBe('y')
  })

  it('expired batches are blocked; not enough stock is 422 when negatives are off', async () => {
    const p = await insertProduct(t, pharmacy, { sale_price_paise: 1_000, track_batches: true })
    const old = await insertBatch(t, pharmacy, p, { expiry_date: addDays(today, -10) })
    await addStock(pharmacy, { product_id: p, qty_milli: 5_000, batch_id: old })
    const res = await createSale(pharmacy, { lines: [line(p, 1000, { batch_id: old })] })
    expect(res.statusCode).toBe(422)
    expect(errorOf(res).code).toBe('EXPIRED_BATCH')
    const auto = await createSale(pharmacy, { lines: [line(p, 1000)] })
    expect(auto.statusCode).toBe(422)
    expect(errorOf(auto).code).toBe('INSUFFICIENT_STOCK')
  })

  it('schedule H drugs need prescription details', async () => {
    const p = await insertProduct(t, pharmacy, {
      sale_price_paise: 5_000,
      attributes: { schedule: 'H1' },
    })
    await addStock(pharmacy, { product_id: p, qty_milli: 5_000 })
    const res = await createSale(pharmacy, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 5_000 }],
    })
    expect(res.statusCode).toBe(422)
    expect(errorOf(res).code).toBe('RX_REQUIRED')
    const r = await sell(pharmacy, {
      lines: [line(p)],
      rx: {
        doctor_name: 'Dr. Kumar',
        doctor_reg_no: 'TN-1234',
        patient_name: 'Selvi',
        patient_age: 54,
      },
      tenders: [{ method: 'cash', amount_paise: 5_000 }],
    })
    expect(r.invoice['rx']).toMatchObject({ doctor_name: 'Dr. Kumar', patient_name: 'Selvi' })
    expect(r.invoice.lines[0]?.['meta']).toMatchObject({ schedule: 'H1' })
  })

  it('serial-tracked items need one serial number per unit', async () => {
    const p = await insertProduct(t, shop, {
      sale_price_paise: 1_500_000,
      attributes: { serial_tracked: true },
      track_inventory: false,
    })
    const res = await createSale(shop, { lines: [line(p, 2000, { serial_numbers: ['IMEI1'] })] })
    expect(res.statusCode).toBe(422)
    expect(errorOf(res).details?.['reason']).toBe('serial_numbers_required')
    const ok = await sell(shop, {
      lines: [line(p, 2000, { serial_numbers: ['IMEI1', 'IMEI2'] })],
      tenders: [{ method: 'card', amount_paise: 3_000_000 }],
    })
    expect(ok.invoice.lines[0]?.['serial_numbers']).toEqual(['IMEI1', 'IMEI2'])
  })

  it('general stores bill into negative stock with a warning', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 1_000, reorder_level_milli: 1_000 })
    await addStock(shop, { product_id: p, qty_milli: 1_000 })
    const r = await sell(shop, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 2_000 }],
    })
    expect(r.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['negative_stock', 'low_stock']),
    )
    expect(await stockOf(t, shop.tenant.id, p)).toBe(-1_000)
  })
})

describe('loyalty, back dating and shifts', () => {
  it('redeems and earns points; the free plan refuses redemption', async () => {
    await setSettings(shop, {
      loyalty: {
        enabled: true,
        points_per_100_rupees: 1,
        point_value_paise: 100,
        min_redeem_points: 10,
      },
    })
    const c = await insertCustomer(t, shop, { loyalty_points: 50 })
    const p = await insertProduct(t, shop, { sale_price_paise: 100_000, track_inventory: false })
    const r = await sell(shop, {
      customer_id: c,
      loyalty_redeem_points: 30,
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 97_000 }],
    })
    expect(r.invoice.total_paise).toBe(97_000)
    expect(r.invoice['loyalty_points_redeemed']).toBe(30)
    expect(r.invoice['loyalty_redeem_paise']).toBe(3_000)
    expect(r.invoice['loyalty_points_earned']).toBe(9)
    expect((await customerBalance(t, c)).loyalty_points).toBe(50 - 30 + 9)

    const free = await createTestTenant(t, {
      plan_code: 'free',
      settings: { loyalty: { enabled: true } },
    })
    const fc = await insertCustomer(t, free)
    const fp = await insertProduct(t, free, { track_inventory: false })
    const res = await createSale(free, {
      customer_id: fc,
      loyalty_redeem_points: 100,
      lines: [line(fp)],
    })
    expect(res.statusCode).toBe(422)
    expect(errorOf(res).details?.['reason']).toBe('loyalty_disabled')
  })

  it('back-dated bills: never at the POS, back office with permission only', async () => {
    const p = await insertProduct(t, shop, { track_inventory: false })
    const yesterday = addDays(today, -1)
    const pos = await createSale(shop, { lines: [line(p)], invoice_date: yesterday })
    expect(pos.statusCode).toBe(403)
    expect(errorOf(pos).details?.['reason']).toBe('backdate_not_allowed')
    const cashier = await shop.asRole('cashier')
    const bo = await createSale(
      shop,
      { channel: 'backoffice', register_id: undefined, lines: [line(p)], invoice_date: yesterday },
      cashier,
    )
    expect(bo.statusCode).toBe(403)
    const ok = await sell(shop, {
      channel: 'backoffice',
      register_id: undefined,
      lines: [line(p)],
      invoice_date: yesterday,
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    expect(ok.invoice['invoice_date']).toBe(yesterday)
  })

  it('an open shift is required when configured, and the bill is attached to it', async () => {
    const s = await createTestTenant(t, { settings: { pos: { require_open_shift: true } } })
    const p = await insertProduct(t, s, { track_inventory: false })
    const res = await createSale(s, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    expect(res.statusCode).toBe(422)
    expect(errorOf(res).details?.['reason']).toBe('shift_required')
    const shiftId = newId()
    await t.deps.db.systemDb
      .insertInto('register_shifts')
      .values({
        id: shiftId,
        tenant_id: s.tenant.id,
        store_id: s.store.id,
        register_id: s.register.id,
        opened_by: s.owner.user.id,
        opening_cash_paise: 50_000,
      })
      .execute()
    const r = await sell(s, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    expect(r.invoice['shift_id']).toBe(shiftId)
    const pay = await t.deps.db.systemDb
      .selectFrom('payments')
      .select('shift_id')
      .where('id', '=', r.tenders[0]!.payment_id!)
      .executeTakeFirstOrThrow()
    expect(pay.shift_id).toBe(shiftId)
    // The free plan has no shifts feature: the setting is ignored.
    const free = await createTestTenant(t, {
      plan_code: 'free',
      settings: { pos: { require_open_shift: true } },
    })
    const fp = await insertProduct(t, free, { track_inventory: false })
    const fr = await createSale(free, {
      lines: [line(fp)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    expect(fr.statusCode).toBe(201)
    expect((fr.json() as { data: SaleData }).data.invoice['shift_id']).toBeNull()
  })
})

describe('held bills are re-checked when completed', () => {
  it('FEFO parts of a held bill are re-picked at completion', async () => {
    const pharmacy = await createTestTenant(t, { business_type: 'pharmacy' })
    const p = await insertProduct(t, pharmacy, { sale_price_paise: 1_000, track_batches: true })
    const a = await insertBatch(t, pharmacy, p, { expiry_date: addDays(today, 40) })
    const b = await insertBatch(t, pharmacy, p, { expiry_date: addDays(today, 80) })
    await addStock(pharmacy, { product_id: p, qty_milli: 2_000, batch_id: a })
    await addStock(pharmacy, { product_id: p, qty_milli: 5_000, batch_id: b })
    const held = await sell(pharmacy, { status: 'held', lines: [{ key: 'm', ...line(p, 4_000) }] })
    expect(held.invoice.lines).toHaveLength(2)
    // Batch A is sold out at another counter before the bill is completed.
    await sell(pharmacy, {
      lines: [line(p, 2_000, { batch_id: a })],
      tenders: [{ method: 'cash', amount_paise: 2_000 }],
    })
    const done = dataOf<SaleData>(
      await pharmacy.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${held.invoice.id}/complete`,
        payload: { tenders: [{ method: 'cash', amount_paise: 4_000 }] },
      }),
    )
    expect(done.invoice.lines.map((l) => [l['batch_id'], l.qty_milli])).toEqual([[b, 4_000]])
    expect(await stockOf(t, pharmacy.tenant.id, p, b)).toBe(1_000)
  })

  it('a manual price held by the owner is re-checked for the cashier who completes it', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 10_000, track_inventory: false })
    const held = await sell(shop, {
      status: 'held',
      lines: [line(p, 1_000, { unit_price_paise: 8_000 })],
    })
    const cashier = await shop.asRole('cashier')
    const res = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${held.invoice.id}/complete`,
      payload: { tenders: [{ method: 'cash', amount_paise: 8_000 }] },
      as: cashier,
    })
    expect(res.statusCode).toBe(403)
    expect(errorOf(res).details?.['reason']).toBe('price_override_required')
    const owner = dataOf<SaleData>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${held.invoice.id}/complete`,
        payload: { tenders: [{ method: 'cash', amount_paise: 8_000 }] },
      }),
    )
    expect(owner.invoice.total_paise).toBe(8_000)
  })

  it('held bills are listed per store, only for billing roles', async () => {
    const p = await insertProduct(t, shop, { track_inventory: false })
    const held = await sell(shop, { status: 'held', lines: [line(p)] })
    const clerk = await shop.asRole('accountant')
    const denied = await shop.inject({
      method: 'GET',
      url: `${API}/sales/held?store_id=${shop.store.id}`,
      as: clerk,
    })
    expect(denied.statusCode).toBe(403)
    const other = await createTestTenant(t)
    const foreign = dataOf<unknown[]>(
      await other.inject({ method: 'GET', url: `${API}/sales/held?store_id=${shop.store.id}` }),
    )
    expect(foreign).toHaveLength(0)
    const own = dataOf<Array<{ id: string }>>(
      await shop.inject({
        method: 'GET',
        url: `${API}/sales/held?store_id=${shop.store.id}&status=held`,
      }),
    )
    expect(own.map((h) => h.id)).toContain(held.invoice.id)
  })

  it('store prices are ignored without the store_pricing feature', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const p = await insertProduct(t, free, { sale_price_paise: 10_000, track_inventory: false })
    await t.deps.db.systemDb
      .insertInto('store_product_prices')
      .values({
        tenant_id: free.tenant.id,
        store_id: free.store.id,
        product_id: p,
        sale_price_paise: 9_000,
      })
      .execute()
    const q = dataOf<Quote>(
      await free.inject({
        method: 'POST',
        url: `${API}/pos/quote`,
        payload: { store_id: free.store.id, lines: [line(p)] },
      }),
    )
    expect(q.lines[0]).toMatchObject({ unit_price_paise: 10_000, price_source: 'product' })
  })
})
