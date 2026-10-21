/**
 * Dashboard and sales reports on two business days of a two-branch shop: today vs yesterday,
 * trend, payment mix (incl. credit), top items, receivables / payables, stock alerts, open
 * shifts, UPI; sales summary by every grouping (with payments and refunds), item / category /
 * brand sales, profit with margin filter, discounts (item / bill / promotion / user),
 * cancellations and shifts — plus CSV, validation, permissions, plan gating, store scope and
 * tenant isolation. Only completed documents count; credit notes reduce sales.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId } from '@kadai/shared'
import {
  type BrandSalesResponse,
  type CancellationsResponse,
  type CategorySalesResponse,
  type Dashboard,
  type DiscountsResponse,
  type ItemSalesResponse,
  type ProfitResponse,
  type SalesSummaryResponse,
  type ShiftsReportResponse,
  reportsRoutes,
} from '@kadai/shared/api/reports'
import { unimplementedRoutes } from '../../../core/http'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, type TestShopMember, createTestTenant } from '../../../test/tenants'
import { reportsImpls } from '../index'
import {
  type CustomerFx,
  type ProductFx,
  auditActions,
  errorOf,
  get,
  makeBatch,
  makeBill,
  makeBrand,
  makeCategory,
  makeCreditNote,
  makeCustomer,
  makeInvoice,
  makeProduct,
  makeStore,
  makeSupplier,
  openingBalance,
  openingStock,
} from './fixtures'

const D = '2026-09-10'
const Y = addDays(D, -1)
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`)

describe('reports: dashboard and sales reports', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let cashier: TestShopMember
  let s2: { id: string; code: string }
  const p: Record<string, ProductFx> = {}
  const cat: Record<string, string> = {}
  let c1: CustomerFx
  let c2: CustomerFx
  let promoId: string
  let openShift: string
  let closedShift: string
  let x1: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, {
      plan_code: 'pro',
      settings: { inventory: { expiry_warning_days: 30 } },
    })
    other = await createTestTenant(t, { plan_code: 'pro' })
    cashier = await shop.asRole('cashier')
    const tid = shop.tenant.id
    const sys = t.deps.db.systemDb
    s2 = await makeStore(t, tid, 'S2')
    cat.grocery = await makeCategory(t, tid, 'Grocery')
    cat.rice = await makeCategory(t, tid, 'Rice', cat.grocery)
    cat.pulses = await makeCategory(t, tid, 'Pulses', cat.grocery)
    cat.care = await makeCategory(t, tid, 'Personal care')
    const ponni = await makeBrand(t, tid, 'Ponni')
    const medimix = await makeBrand(t, tid, 'Medimix')
    p.rice = await makeProduct(t, tid, {
      name: 'Ponni Rice',
      name_ta: 'பொன்னி அரிசி',
      unit: 'KG',
      hsn_code: '1006',
      gst_rate_bp: 500,
      category_id: cat.rice,
      brand_id: ponni,
      reorder_level_milli: 20_000,
    })
    p.soap = await makeProduct(t, tid, {
      name: 'Bath Soap',
      hsn_code: '3401',
      gst_rate_bp: 1800,
      category_id: cat.care,
      brand_id: medimix,
      reorder_level_milli: 15_000,
    })
    p.dal = await makeProduct(t, tid, {
      name: 'Toor Dal',
      unit: 'KG',
      hsn_code: '0713',
      gst_rate_bp: 500,
      category_id: cat.pulses,
    })
    p.biscuit = await makeProduct(t, tid, {
      name: 'Biscuit',
      hsn_code: '1905',
      gst_rate_bp: 1800,
      reorder_level_milli: 5000,
    })
    p.syrup = await makeProduct(t, tid, {
      name: 'Cough Syrup',
      hsn_code: '3004',
      gst_rate_bp: 1200,
      track_batches: true,
    })
    await openingStock(shop, shop.store.id, p.rice, 100_000, 4000)
    await openingStock(shop, shop.store.id, p.soap, 10_000, 7000)
    await openingStock(shop, s2.id, p.dal, 10_000, 9000)
    const e1 = await makeBatch(t, tid, p.syrup.id, { batch_no: 'E1', expiry_date: addDays(D, 10) })
    const e2 = await makeBatch(t, tid, p.syrup.id, { batch_no: 'E2', expiry_date: addDays(D, -5) })
    await openingStock(shop, shop.store.id, p.syrup, 5000, 1000, e1)
    await openingStock(shop, shop.store.id, p.syrup, 3000, 1000, e2)

    promoId = newId()
    await sys
      .insertInto('promotions')
      .values({
        id: promoId,
        tenant_id: tid,
        name: 'Soap 10% off',
        kind: 'item_percent',
        rules: JSON.stringify({ percent_bp: 1000 }),
      })
      .execute()
    c1 = await makeCustomer(t, tid, { name: 'Kumar', phone: '+919800000001' })
    c2 = await makeCustomer(t, tid, { name: 'Lakshmi Stores' })
    await openingBalance(shop, { type: 'customer', id: c2.id }, 30_000, addDays(D, -40))
    const su = await makeSupplier(t, tid, { name: 'Dal Traders' })
    await makeBill(t, shop, {
      supplier: su,
      number: 'GRNS1/2627/00001',
      supplier_invoice_no: 'DT-1',
      date: addDays(D, -5),
      due_date: addDays(D, -1),
      lines: [{ product: p.dal, qty_milli: 5000, unit_cost_paise: 9000 }],
    })

    // Yesterday: a shift that closed short by ₹5.
    closedShift = newId()
    await sys
      .insertInto('register_shifts')
      .values({
        id: closedShift,
        tenant_id: tid,
        store_id: shop.store.id,
        register_id: shop.register.id,
        opened_by: shop.owner.user.id,
        opened_at: at(Y, '09:00'),
        opening_cash_paise: 100_000,
      })
      .execute()
    const y1 = await makeInvoice(t, shop, {
      number: 'S1-A/2627/00001',
      date: Y,
      at: at(Y, '11:00'),
      shift_id: closedShift,
      lines: [{ product: p.rice, qty_milli: 10_000, unit_price_paise: 5000 }],
      tenders: [{ method: 'cash', amount_paise: 52_500 }],
    })
    await sys
      .updateTable('register_shifts')
      .set({
        status: 'closed',
        closed_by: shop.owner.user.id,
        closed_at: at(Y, '21:00'),
        expected_cash_paise: 152_500,
        counted_cash_paise: 152_000,
        difference_paise: -500,
      })
      .where('id', '=', closedShift)
      .execute()

    // Today.
    openShift = newId()
    await sys
      .insertInto('register_shifts')
      .values({
        id: openShift,
        tenant_id: tid,
        store_id: shop.store.id,
        register_id: shop.register.id,
        opened_by: cashier.user.id,
        opened_at: at(D, '09:00'),
        opening_cash_paise: 100_000,
      })
      .execute()
    await makeInvoice(t, shop, {
      number: 'S1-A/2627/00002',
      date: D,
      at: at(D, '10:00'),
      shift_id: openShift,
      created_by: cashier.user.id,
      lines: [
        {
          product: p.soap,
          qty_milli: 2000,
          unit_price_paise: 10_000,
          discount_paise: 2000,
          promotion_id: promoId,
        },
      ],
      tenders: [{ method: 'cash', amount_paise: 21_240 }],
    })
    await makeInvoice(t, shop, {
      number: 'S1-A/2627/00003',
      date: D,
      at: at(D, '11:00'),
      customer: c1,
      due_days: 30,
      lines: [
        { product: p.rice, qty_milli: 5000, unit_price_paise: 5000, bill_discount_paise: 1000 },
      ],
      tenders: [{ method: 'upi', amount_paise: 20_000 }],
    })
    await makeInvoice(t, shop, {
      number: 'S2/2627/00001',
      date: D,
      at: at(D, '18:00'),
      store_id: s2.id,
      register_id: null,
      lines: [{ product: p.dal, qty_milli: 3000, unit_price_paise: 12_000 }],
      tenders: [{ method: 'card', amount_paise: 37_800 }],
    })
    await makeCreditNote(t, shop, {
      number: 'CNS1/2627/00001',
      date: D,
      invoice: y1,
      lines: [{ line: 0, qty_milli: 2000 }],
      settlement: 'cash',
    })
    const x = await makeInvoice(t, shop, {
      number: 'S1-A/2627/00004',
      date: D,
      at: at(D, '11:00'),
      created_by: cashier.user.id,
      lines: [{ product: p.soap, qty_milli: 1000, unit_price_paise: 10_000 }],
      tenders: [{ method: 'cash', amount_paise: 11_800 }],
      cancelled: { at: at(D, '15:00'), reason: 'Wrong item' },
    })
    x1 = x.id

    // UPI: one QR waiting, one paid but not applied to any bill.
    const acct = newId()
    await sys
      .insertInto('payment_provider_accounts')
      .values({
        id: acct,
        tenant_id: tid,
        provider: 'upi_vpa',
        display_name: 'Shop UPI',
        vpa: 'kadaishop@okaxis',
      })
      .execute()
    await sys
      .insertInto('payment_intents')
      .values([
        {
          id: newId(),
          tenant_id: tid,
          store_id: shop.store.id,
          provider_account_id: acct,
          provider: 'upi_vpa',
          purpose: 'pos_sale',
          reference_code: `KD${newId().slice(-8).toUpperCase()}`,
          amount_paise: 15_000,
          status: 'pending',
          expires_at: new Date(Date.now() + 600_000),
        },
        {
          id: newId(),
          tenant_id: tid,
          store_id: shop.store.id,
          provider_account_id: acct,
          provider: 'upi_vpa',
          purpose: 'pos_sale',
          reference_code: `KD${newId().slice(-8).toUpperCase()}`,
          amount_paise: 9900,
          paid_amount_paise: 9900,
          status: 'paid',
          paid_at: new Date(),
        },
      ])
      .execute()

    // Another tenant's bill on the same day.
    const op = await makeProduct(t, other.tenant.id, {
      name: 'Other Rice',
      unit: 'KG',
      gst_rate_bp: 500,
    })
    await makeInvoice(t, other, {
      number: 'S1-A/2627/00001',
      date: D,
      lines: [{ product: op, qty_milli: 1000, unit_price_paise: 99_900 }],
      tenders: [{ method: 'cash', amount_paise: 104_895 }],
    })
  })

  afterAll(() => t.close())

  it('implements every route of the reports catalogue', () => {
    expect(unimplementedRoutes(reportsRoutes, reportsImpls)).toEqual([])
  })

  it('dashboard: today vs yesterday, change, trend, payment mix and top items', async () => {
    const r = await get<{ data: Dashboard }>(shop, `/reports/dashboard?date=${D}`)
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.date).toBe(D)
    expect(d.store_id).toBeNull()
    expect(d.today).toEqual({
      date: D,
      net_sales_paise: 73_740,
      sales_paise: 84_240,
      returns_paise: 10_500,
      bills: 3,
      avg_bill_paise: 28_080,
      net_taxable_paise: 68_000,
      gross_profit_paise: 15_000,
      margin_bp: 2206,
    })
    expect(d.yesterday).toEqual({
      date: Y,
      net_sales_paise: 52_500,
      sales_paise: 52_500,
      returns_paise: 0,
      bills: 1,
      avg_bill_paise: 52_500,
      net_taxable_paise: 50_000,
      gross_profit_paise: 10_000,
      margin_bp: 2000,
    })
    expect(d.change).toEqual({
      net_sales_bp: 4046,
      bills_bp: 20_000,
      avg_bill_bp: -4651,
      gross_profit_bp: 5000,
      margin_points_bp: 206,
    })
    expect(d.trend).toHaveLength(30)
    expect(d.trend[0]!.date).toBe(addDays(D, -29))
    expect(d.trend.at(-1)).toEqual({
      date: D,
      net_sales_paise: 73_740,
      gross_profit_paise: 15_000,
      bills: 3,
    })
    expect(d.trend.at(-2)).toEqual({
      date: Y,
      net_sales_paise: 52_500,
      gross_profit_paise: 10_000,
      bills: 1,
    })
    expect(d.trend.slice(0, 28).every((x) => x.bills === 0 && x.net_sales_paise === 0)).toBe(true)
    expect(d.payment_mix).toEqual([
      { key: 'cash', amount_paise: 21_240, count: 1, share_bp: 2521 },
      { key: 'upi', amount_paise: 20_000, count: 1, share_bp: 2374 },
      { key: 'card', amount_paise: 37_800, count: 1, share_bp: 4487 },
      { key: 'credit', amount_paise: 5200, count: 1, share_bp: 617 },
      { key: 'other', amount_paise: 0, count: 0, share_bp: 0 },
    ])
    expect(d.payment_mix.reduce((s, m) => s + m.amount_paise, 0)).toBe(d.today.sales_paise)
    expect(d.top_items.today.map((i) => [i.name, i.net_sales_paise, i.qty_milli])).toEqual([
      ['Toor Dal', 37_800, 3000],
      ['Bath Soap', 21_240, 2000],
      ['Ponni Rice', 14_700, 3000],
    ])
    expect(d.top_items.last_7_days.map((i) => [i.name, i.net_sales_paise, i.qty_milli])).toEqual([
      ['Ponni Rice', 67_200, 13_000],
      ['Toor Dal', 37_800, 3000],
      ['Bath Soap', 21_240, 2000],
    ])
    expect(d.top_items.today[2]!.name_ta).toBe('பொன்னி அரிசி')
  })

  it('dashboard: dues, payables, stock alerts, open shifts and UPI', async () => {
    const d = (await get<{ data: Dashboard }>(shop, `/reports/dashboard?date=${D}`)).body.data
    expect(d.receivables.total_paise).toBe(35_200)
    expect(d.receivables.customers_with_due).toBe(2)
    expect(d.receivables.overdue_paise).toBe(0)
    expect(
      d.receivables.top_debtors.map((x) => [x.name, x.balance_paise, x.oldest_due_days]),
    ).toEqual([
      ['Lakshmi Stores', 30_000, null],
      ['Kumar', 5200, 0],
    ])
    expect(d.payables).toEqual({
      total_paise: 47_250,
      suppliers_with_due: 1,
      overdue_paise: 47_250,
      due_next_7_days_paise: 0,
    })
    expect(d.stock).toEqual({
      low_stock: 1,
      out_of_stock: 1,
      expiring: 1,
      expired: 1,
      expiring_value_paise: 5000,
      expired_value_paise: 3000,
      expiry_warning_days: 30,
    })
    expect(d.shifts?.open_count).toBe(1)
    expect(d.shifts?.open[0]).toMatchObject({
      shift_id: openShift,
      register_code: 'A',
      opened_by_name: cashier.user.full_name,
    })
    expect(d.upi).toEqual({
      pending_intents: 1,
      pending_paise: 15_000,
      unapplied_count: 1,
      unapplied_paise: 9900,
    })
  })

  it('dashboard of one store', async () => {
    const d = (
      await get<{ data: Dashboard }>(shop, `/reports/dashboard?date=${D}&store_id=${s2.id}`)
    ).body.data
    expect(d.store_id).toBe(s2.id)
    expect(d.today).toMatchObject({
      bills: 1,
      sales_paise: 37_800,
      net_taxable_paise: 36_000,
      gross_profit_paise: 9000,
      margin_bp: 2500,
    })
    expect(d.yesterday.bills).toBe(0)
    expect(d.change.net_sales_bp).toBeNull()
    expect(d.payment_mix.find((m) => m.key === 'card')).toEqual({
      key: 'card',
      amount_paise: 37_800,
      count: 1,
      share_bp: 10_000,
    })
    expect(d.receivables).toEqual({
      total_paise: 0,
      customers_with_due: 0,
      overdue_paise: 0,
      top_debtors: [],
    })
    expect(d.payables.total_paise).toBe(0)
    expect(d.stock).toMatchObject({ low_stock: 0, out_of_stock: 3, expiring: 0, expired: 0 })
    expect(d.shifts?.open_count).toBe(0)
    expect(d.upi.pending_intents).toBe(0)
  })

  it('sales summary by day: sales, returns, profit, payments in and refunds out', async () => {
    const r = await get<SalesSummaryResponse>(shop, `/reports/sales-summary?from=${Y}&to=${D}`)
    expect(r.status).toBe(200)
    expect(r.body.page).toEqual({ limit: 100, offset: 0, total: 2 })
    expect(r.body.data[0]).toEqual({
      group_key: Y,
      group_label: Y,
      group_label_ta: null,
      bills: 1,
      gross_paise: 50_000,
      discount_paise: 0,
      taxable_paise: 50_000,
      tax_paise: 2500,
      sales_paise: 52_500,
      returns_count: 0,
      returns_paise: 0,
      returns_taxable_paise: 0,
      net_sales_paise: 52_500,
      net_taxable_paise: 50_000,
      cost_paise: 40_000,
      gross_profit_paise: 10_000,
      margin_bp: 2000,
      round_off_paise: 0,
      avg_bill_paise: 52_500,
      payments_count: 1,
      collected_paise: 52_500,
      refunded_paise: 0,
      net_collected_paise: 52_500,
    })
    expect(r.body.data[1]).toMatchObject({
      group_key: D,
      bills: 3,
      gross_paise: 81_000,
      discount_paise: 3000,
      taxable_paise: 78_000,
      tax_paise: 6240,
      sales_paise: 84_240,
      returns_count: 1,
      returns_paise: 10_500,
      returns_taxable_paise: 10_000,
      net_sales_paise: 73_740,
      net_taxable_paise: 68_000,
      cost_paise: 53_000,
      gross_profit_paise: 15_000,
      margin_bp: 2206,
      avg_bill_paise: 28_080,
      payments_count: 3,
      collected_paise: 79_040,
      refunded_paise: 10_500,
      net_collected_paise: 68_540,
    })
    expect(r.body.totals).toMatchObject({
      bills: 4,
      gross_paise: 131_000,
      discount_paise: 3000,
      taxable_paise: 128_000,
      tax_paise: 8740,
      sales_paise: 136_740,
      returns_paise: 10_500,
      net_sales_paise: 126_240,
      net_taxable_paise: 118_000,
      cost_paise: 93_000,
      gross_profit_paise: 25_000,
      margin_bp: 2119,
      avg_bill_paise: 34_185,
      payments_count: 4,
      collected_paise: 131_540,
      refunded_paise: 10_500,
      net_collected_paise: 121_040,
    })
    expect(r.body.meta).toMatchObject({
      report: 'sales-summary',
      from: Y,
      to: D,
      group_by: 'day',
      store_id: null,
      notes: [],
    })
  })

  it('sales summary by payment method, store, user, hour and register', async () => {
    const pm = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&group_by=payment_method`,
    )
    expect(
      pm.body.data.map((x) => [
        x.group_key,
        x.group_label,
        x.payments_count,
        x.collected_paise,
        x.refunded_paise,
        x.net_collected_paise,
        x.bills,
      ]),
    ).toEqual([
      ['card', 'Card', 1, 37_800, 0, 37_800, 0],
      ['cash', 'Cash', 2, 73_740, 10_500, 63_240, 0],
      ['upi', 'UPI', 1, 20_000, 0, 20_000, 0],
    ])
    expect(pm.body.data[1]!.group_label_ta).toBe('ரொக்கம்')
    const st = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&group_by=store&sort=-net_sales_paise`,
    )
    expect(st.body.data.map((x) => [x.group_key, x.bills, x.net_sales_paise])).toEqual([
      [shop.store.id, 3, 88_440],
      [s2.id, 1, 37_800],
    ])
    expect(st.body.data[1]!.group_label).toBe('Branch S2')
    const us = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&group_by=user`,
    )
    const byUser = Object.fromEntries(us.body.data.map((x) => [x.group_label, x]))
    expect(byUser[cashier.user.full_name]).toMatchObject({
      bills: 1,
      sales_paise: 21_240,
      returns_paise: 0,
    })
    expect(byUser[shop.owner.user.full_name]).toMatchObject({
      bills: 3,
      sales_paise: 115_500,
      returns_paise: 10_500,
    })
    const hr = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&group_by=hour`,
    )
    expect(hr.body.data).toHaveLength(24)
    const h = Object.fromEntries(hr.body.data.map((x) => [x.group_key, x]))
    expect(h['11']).toMatchObject({
      group_label: '11:00',
      bills: 2,
      sales_paise: 77_700,
      collected_paise: 72_500,
    })
    expect(h['16']).toMatchObject({ bills: 0, returns_paise: 10_500, refunded_paise: 10_500 })
    expect(h['03']).toMatchObject({ bills: 0, sales_paise: 0 })
    const rg = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&group_by=register&register_id=${shop.register.id}`,
    )
    expect(rg.body.data).toHaveLength(1)
    expect(rg.body.data[0]).toMatchObject({
      group_key: shop.register.id,
      bills: 3,
      sales_paise: 98_940,
      returns_paise: 0,
    })
  })

  it('sales summary CSV: English headers, every row and a totals row (audited)', async () => {
    const r = await shop.inject({
      method: 'GET',
      url: `/api/v1/reports/sales-summary?from=${Y}&to=${D}&format=csv`,
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.headers['content-disposition']).toContain(`sales-summary_${Y}_${D}.csv`)
    const lines = r.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
    expect(lines[0]).toBe(
      'Group,Bills,Sales,Returns,Net sales,Discount,Taxable value,GST,Cost,Gross profit,Margin %,Average bill',
    )
    expect(lines[1]).toBe(`${Y},1,525.00,0.00,525.00,0.00,500.00,25.00,400.00,100.00,20.00,525.00`)
    expect(lines[3]).toBe(
      'Total,4,1367.40,105.00,1262.40,30.00,1180.00,87.40,930.00,250.00,21.19,341.85',
    )
    expect(lines).toHaveLength(4)
    expect(await auditActions(t, shop.tenant.id)).toContain('report.export')
  })

  it('item sales: quantities, returns, cost, profit and margin per item', async () => {
    const r = await get<ItemSalesResponse>(shop, `/reports/item-sales?from=${Y}&to=${D}`)
    expect(r.status).toBe(200)
    expect(r.body.data.map((x) => x.name)).toEqual(['Ponni Rice', 'Toor Dal', 'Bath Soap'])
    expect(r.body.data[0]).toMatchObject({
      product_id: p.rice!.id,
      category_name: 'Rice',
      brand_name: 'Ponni',
      hsn_code: '1006',
      unit: 'KG',
      qty_milli: 15_000,
      returned_qty_milli: 2000,
      net_qty_milli: 13_000,
      bills: 2,
      gross_paise: 75_000,
      discount_paise: 1000,
      taxable_paise: 74_000,
      tax_paise: 3700,
      sales_paise: 77_700,
      returns_count: 1,
      returns_paise: 10_500,
      returns_taxable_paise: 10_000,
      net_sales_paise: 67_200,
      net_taxable_paise: 64_000,
      cost_paise: 52_000,
      gross_profit_paise: 12_000,
      margin_bp: 1875,
    })
    expect(r.body.data[2]).toMatchObject({
      discount_paise: 2000,
      taxable_paise: 18_000,
      cost_paise: 14_000,
      gross_profit_paise: 4000,
      margin_bp: 2222,
    })
    expect(r.body.totals).toMatchObject({
      products: 3,
      bills: 4,
      returns_count: 1,
      sales_paise: 136_740,
      net_sales_paise: 126_240,
      net_taxable_paise: 118_000,
      cost_paise: 93_000,
      gross_profit_paise: 25_000,
      margin_bp: 2119,
    })
    const grocery = await get<ItemSalesResponse>(
      shop,
      `/reports/item-sales?from=${Y}&to=${D}&category_id=${cat.grocery}`,
    )
    expect(grocery.body.data.map((x) => x.name).sort()).toEqual(['Ponni Rice', 'Toor Dal'])
    const q = await get<ItemSalesResponse>(shop, `/reports/item-sales?from=${Y}&to=${D}&q=soap`)
    expect(q.body.data.map((x) => x.name)).toEqual(['Bath Soap'])
    const byCashier = await get<ItemSalesResponse>(
      shop,
      `/reports/item-sales?from=${Y}&to=${D}&user_id=${cashier.user.id}`,
    )
    expect(byCashier.body.totals).toMatchObject({ products: 1, sales_paise: 21_240 })
    const margin = await get<ItemSalesResponse>(
      shop,
      `/reports/item-sales?from=${Y}&to=${D}&sort=margin_bp`,
    )
    expect(margin.body.data.map((x) => x.margin_bp)).toEqual([1875, 2222, 2500])
    const csv = await shop.inject({
      method: 'GET',
      url: `/api/v1/reports/item-sales?from=${Y}&to=${D}&format=csv`,
    })
    expect(csv.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
      'Item,Category,HSN,Net qty,Returned qty,Bills,Sales,Returns,Net sales,Discount,Taxable value,GST,Cost,Gross profit,Margin %',
    )
  })

  it('category and brand sales with share of net sales', async () => {
    const leaf = await get<CategorySalesResponse>(shop, `/reports/category-sales?from=${Y}&to=${D}`)
    expect(leaf.body.data.map((x) => [x.path, x.net_sales_paise, x.share_bp, x.products])).toEqual([
      ['Grocery / Rice', 67_200, 5323, 1],
      ['Grocery / Pulses', 37_800, 2994, 1],
      ['Personal care', 21_240, 1683, 1],
    ])
    const top = await get<CategorySalesResponse>(
      shop,
      `/reports/category-sales?from=${Y}&to=${D}&level=top`,
    )
    expect(
      top.body.data.map((x) => [
        x.category_name,
        x.net_sales_paise,
        x.products,
        x.gross_profit_paise,
      ]),
    ).toEqual([
      ['Grocery', 105_000, 2, 21_000],
      ['Personal care', 21_240, 1, 4000],
    ])
    expect(top.body.totals).toMatchObject({ products: 3, net_sales_paise: 126_240 })
    const brands = await get<BrandSalesResponse>(shop, `/reports/brand-sales?from=${Y}&to=${D}`)
    expect(brands.body.data.map((x) => [x.brand_name, x.net_sales_paise])).toEqual([
      ['Ponni', 67_200],
      ['No brand', 37_800],
      ['Medimix', 21_240],
    ])
  })

  it('profit by item / category with a low-margin filter', async () => {
    const r = await get<ProfitResponse>(shop, `/reports/profit?from=${Y}&to=${D}`)
    expect(
      r.body.data.map((x) => [x.name, x.gross_profit_paise, x.margin_bp, x.profit_share_bp]),
    ).toEqual([
      ['Ponni Rice', 12_000, 1875, 4800],
      ['Toor Dal', 9000, 2500, 3600],
      ['Bath Soap', 4000, 2222, 1600],
    ])
    expect(r.body.totals).toEqual({
      net_taxable_paise: 118_000,
      cost_paise: 93_000,
      gross_profit_paise: 25_000,
      margin_bp: 2119,
    })
    const low = await get<ProfitResponse>(
      shop,
      `/reports/profit?from=${Y}&to=${D}&max_margin_bp=2300`,
    )
    expect(low.body.data.map((x) => x.name)).toEqual(['Ponni Rice', 'Bath Soap'])
    expect(low.body.totals).toEqual({
      net_taxable_paise: 82_000,
      cost_paise: 66_000,
      gross_profit_paise: 16_000,
      margin_bp: 1951,
    })
    const byCat = await get<ProfitResponse>(
      shop,
      `/reports/profit?from=${Y}&to=${D}&group_by=category`,
    )
    expect(byCat.body.data.map((x) => [x.key_id, x.name, x.gross_profit_paise])).toEqual([
      [cat.rice, 'Rice', 12_000],
      [cat.pulses, 'Pulses', 9000],
      [cat.care, 'Personal care', 4000],
    ])
  })

  it('discounts by bill, item, promotion and user', async () => {
    const bill = await get<DiscountsResponse>(shop, `/reports/discounts?from=${Y}&to=${D}`)
    expect(
      bill.body.data.map((x) => [
        x.label,
        x.gross_paise,
        x.item_discount_paise,
        x.bill_discount_paise,
        x.promotion_discount_paise,
        x.discount_paise,
        x.discount_bp,
      ]),
    ).toEqual([
      ['S1-A/2627/00002', 20_000, 2000, 0, 2000, 2000, 1000],
      ['S1-A/2627/00003', 25_000, 0, 1000, 0, 1000, 400],
    ])
    expect(bill.body.data[0]!.user_name).toBe(cashier.user.full_name)
    expect(bill.body.totals).toEqual({
      bills: 2,
      gross_paise: 45_000,
      item_discount_paise: 2000,
      bill_discount_paise: 1000,
      promotion_discount_paise: 2000,
      discount_paise: 3000,
      discount_bp: 667,
    })
    const item = await get<DiscountsResponse>(
      shop,
      `/reports/discounts?from=${Y}&to=${D}&group_by=item`,
    )
    expect(
      item.body.data.map((x) => [
        x.label,
        x.qty_milli,
        x.item_discount_paise,
        x.bill_discount_paise,
      ]),
    ).toEqual([
      ['Bath Soap', 2000, 2000, 0],
      ['Ponni Rice', 5000, 0, 1000],
    ])
    const promo = await get<DiscountsResponse>(
      shop,
      `/reports/discounts?from=${Y}&to=${D}&group_by=promotion`,
    )
    expect(promo.body.data).toHaveLength(1)
    expect(promo.body.data[0]).toMatchObject({
      ref_type: 'promotion',
      ref_id: promoId,
      label: 'Soap 10% off',
      promotion_discount_paise: 2000,
      bills: 1,
    })
    const user = await get<DiscountsResponse>(
      shop,
      `/reports/discounts?from=${Y}&to=${D}&group_by=user`,
    )
    expect(user.body.data.map((x) => [x.label, x.discount_paise])).toEqual([
      [cashier.user.full_name, 2000],
      [shop.owner.user.full_name, 1000],
    ])
    const min = await get<DiscountsResponse>(
      shop,
      `/reports/discounts?from=${Y}&to=${D}&min_discount_bp=500`,
    )
    expect(min.body.data.map((x) => x.label)).toEqual(['S1-A/2627/00002'])
  })

  it('cancellations: who, when, why and the money given back', async () => {
    const r = await get<CancellationsResponse>(shop, `/reports/cancellations?from=${Y}&to=${D}`)
    expect(r.body.data).toEqual([
      {
        kind: 'invoice',
        document_id: x1,
        number: 'S1-A/2627/00004',
        document_date: D,
        created_by_name: cashier.user.full_name,
        cancelled_at: at(D, '15:00').toISOString(),
        cancelled_by: shop.owner.user.id,
        cancelled_by_name: shop.owner.user.full_name,
        reason: 'Wrong item',
        customer_name: null,
        store_name: expect.any(String),
        register_code: 'A',
        total_paise: 11_800,
        refunded_paise: 11_800,
        minutes_after: 240,
      },
    ])
    expect(r.body.totals).toEqual({ count: 1, total_paise: 11_800, refunded_paise: 11_800 })
    const cn = await get<CancellationsResponse>(
      shop,
      `/reports/cancellations?from=${Y}&to=${D}&kind=credit_note`,
    )
    expect(cn.body.data).toEqual([])
  })

  it('shift summary with tenders and cash differences', async () => {
    const r = await get<ShiftsReportResponse>(shop, `/reports/shifts?from=${Y}&to=${D}`)
    expect(
      r.body.data.map((x) => [
        x.shift_id,
        x.status,
        x.bills,
        x.sales_paise,
        x.cash_paise,
        x.difference_paise,
      ]),
    ).toEqual([
      [openShift, 'open', 1, 21_240, 21_240, null],
      [closedShift, 'closed', 1, 52_500, 52_500, -500],
    ])
    expect(r.body.data[1]).toMatchObject({
      expected_cash_paise: 152_500,
      counted_cash_paise: 152_000,
      opening_cash_paise: 100_000,
      register_code: 'A',
    })
    expect(r.body.totals).toEqual({
      shifts: 2,
      bills: 2,
      sales_paise: 73_740,
      cash_paise: 73_740,
      upi_paise: 0,
      card_paise: 0,
      other_paise: 0,
      difference_paise: -500,
    })
  })

  it('validates ranges, paging and sort', async () => {
    const bad = await get(shop, `/reports/sales-summary?from=${D}&to=${Y}`)
    expect(bad.status).toBe(400)
    expect(JSON.stringify(errorOf(bad).details)).toContain('date_order')
    const long = await get(shop, '/reports/item-sales?from=2025-01-01&to=2026-03-01')
    expect(long.status).toBe(400)
    expect(JSON.stringify(errorOf(long).details)).toContain('range_too_long')
    expect((await get(shop, `/reports/sales-summary?from=${Y}&to=${D}&limit=6000`)).status).toBe(
      400,
    )
    expect((await get(shop, `/reports/sales-summary?from=${Y}&to=${D}&sort=bogus`)).status).toBe(
      400,
    )
    expect((await get(shop, '/reports/sales-summary')).status).toBe(400)
    expect((await get(shop, `/reports/sales-summary?from=${Y}&to=${D}&store_id=nope`)).status).toBe(
      400,
    )
    const paged = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&limit=1&offset=1`,
    )
    expect(paged.body.page).toEqual({ limit: 1, offset: 1, total: 2 })
    expect(paged.body.data[0]!.group_key).toBe(D)
    expect(paged.body.totals.bills).toBe(4)
    const past = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&offset=10`,
    )
    expect(past.body.page.total).toBe(2)
    expect(past.body.data).toEqual([])
  })

  it('needs reports.read; advanced and shift reports need their plan feature', async () => {
    expect((await get(shop, `/reports/dashboard?date=${D}`, cashier)).status).toBe(403)
    expect((await get(shop, `/reports/sales-summary?from=${Y}&to=${D}`, cashier)).status).toBe(403)
    const pharmacist = await shop.asRole('pharmacist')
    expect((await get(shop, `/reports/dashboard?date=${D}`, pharmacist)).status).toBe(200)
    const free = await createTestTenant(t, { plan_code: 'free' })
    const dash = await get<{ data: Dashboard }>(free, `/reports/dashboard?date=${D}`)
    expect(dash.status).toBe(200)
    expect(dash.body.data.shifts).toBeNull()
    expect((await get(free, `/reports/sales-summary?from=${Y}&to=${D}`)).status).toBe(200)
    expect((await get(free, `/reports/cancellations?from=${Y}&to=${D}`)).status).toBe(200)
    for (const url of [
      `/reports/brand-sales?from=${Y}&to=${D}`,
      `/reports/profit?from=${Y}&to=${D}`,
      `/reports/discounts?from=${Y}&to=${D}`,
      `/reports/shifts?from=${Y}&to=${D}`,
      '/reports/stock-ageing',
      '/reports/dead-stock',
      '/reports/expiry',
    ]) {
      const r = await get(free, url)
      expect(r.status, url).toBe(402)
      expect(errorOf(r).code).toBe('FEATURE_NOT_IN_PLAN')
    }
  })

  it('respects the member’s store scope', async () => {
    const branch = await shop.asRole('branch_viewer', {
      permissions: ['reports.read'],
      store_ids: [s2.id],
    })
    const r = await get<SalesSummaryResponse>(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&group_by=store`,
      branch,
    )
    expect(r.status).toBe(200)
    expect(r.body.data.map((x) => x.group_key)).toEqual([s2.id])
    expect(r.body.meta.notes).toContain('store_filter_applied')
    const d = await get<{ data: Dashboard }>(shop, `/reports/dashboard?date=${D}`, branch)
    expect(d.body.data.today.bills).toBe(1)
    const denied = await get(
      shop,
      `/reports/sales-summary?from=${Y}&to=${D}&store_id=${shop.store.id}`,
      branch,
    )
    expect(denied.status).toBe(403)
    const deniedDash = await get(
      shop,
      `/reports/dashboard?date=${D}&store_id=${shop.store.id}`,
      branch,
    )
    expect(deniedDash.status).toBe(403)
    const all = await get<{ data: Dashboard }>(
      shop,
      `/reports/dashboard?date=${D}&store_id=all`,
      branch,
    )
    expect(all.body.data.today.bills).toBe(1)
    const ownerAll = await get<{ data: Dashboard }>(
      shop,
      `/reports/dashboard?date=${D}&store_id=all`,
    )
    expect(ownerAll.body.data.today.bills).toBe(3)
  })

  it('never mixes tenants', async () => {
    const mine = await get<SalesSummaryResponse>(shop, `/reports/sales-summary?from=${D}&to=${D}`)
    expect(mine.body.totals.sales_paise).toBe(84_240)
    const theirs = await get<SalesSummaryResponse>(
      other,
      `/reports/sales-summary?from=${D}&to=${D}`,
    )
    expect(theirs.body.totals).toMatchObject({ bills: 1, sales_paise: 104_895 })
    const foreignStore = await get(
      shop,
      `/reports/sales-summary?from=${D}&to=${D}&store_id=${other.store.id}`,
    )
    expect(foreignStore.status).toBe(404)
  })
})
