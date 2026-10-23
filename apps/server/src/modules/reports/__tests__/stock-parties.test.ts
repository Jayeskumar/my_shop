/**
 * Stock, party and pharmacy reports of a pharmacy, relative to today: stock valuation (cost /
 * MRP / selling price; strips of 10 tablets), stock ageing since the last inbound movement,
 * expiry, dead stock; customer outstanding aged by invoice date (opening balance, advance,
 * store filter) and supplier outstanding aged by due date (debit notes, advance); the Schedule
 * H1 register and scheduled-drug sales — plus CSV, permissions and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, todayIn } from '@kadai/shared'
import type {
  CustomerOutstandingResponse,
  DeadStockResponse,
  ExpiryResponse,
  H1RegisterResponse,
  ScheduleSalesResponse,
  StockAgeingResponse,
  StockSummaryResponse,
  SupplierOutstandingResponse,
} from '@kadai/shared/api/reports'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  type BillFx,
  type CustomerFx,
  type ProductFx,
  type SupplierFx,
  get,
  historicalInbound,
  makeBatch,
  makeBill,
  makeCategory,
  makeCustomer,
  makeDebitNote,
  makeInvoice,
  makeProduct,
  makeStore,
  makeSupplier,
  openingBalance,
  openingStock,
  pay,
} from './fixtures'

const today = todayIn('Asia/Kolkata')
const ago = (n: number) => addDays(today, -n)

describe('reports: stock, outstanding and pharmacy registers', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let s2: { id: string; code: string }
  const p: Record<string, ProductFx> = {}
  const b: Record<string, string> = {}
  let tablets: string
  let cu1: CustomerFx
  let cu3: CustomerFx
  let su1: SupplierFx

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, {
      business_type: 'pharmacy',
      plan_code: 'pro',
      settings: { inventory: { expiry_warning_days: 60 } },
    })
    other = await createTestTenant(t, { business_type: 'pharmacy', plan_code: 'pro' })
    const tid = shop.tenant.id
    s2 = await makeStore(t, tid, 'S2')
    tablets = await makeCategory(t, tid, 'Tablets')
    su1 = await makeSupplier(t, tid, { name: 'Madurai Pharma Distributors' })
    p.para = await makeProduct(t, tid, {
      name: 'Paracetamol 500mg',
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
      gst_rate_bp: 1200,
      hsn_code: '3004',
      category_id: tablets,
      sale_price_paise: 2800,
      mrp_paise: 3000,
      attributes: { schedule: 'H', generic_name: 'Paracetamol' },
    })
    p.alpra = await makeProduct(t, tid, {
      name: 'Alprazolam 0.25mg',
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
      gst_rate_bp: 1200,
      hsn_code: '3004',
      category_id: tablets,
      sale_price_paise: 4500,
      mrp_paise: 5000,
      attributes: { schedule: 'H1', generic_name: 'Alprazolam' },
    })
    p.cream = await makeProduct(t, tid, {
      name: 'Skin Cream',
      sale_price_paise: 12_000,
      mrp_paise: 15_000,
    })
    p.bandage = await makeProduct(t, tid, { name: 'Bandage Roll', sale_price_paise: 1500 })
    p.old = await makeProduct(t, tid, { name: 'Old Tonic', sale_price_paise: 7000 })
    p.cotton = await makeProduct(t, tid, { name: 'Cotton Wool' })
    p.zero = await makeProduct(t, tid, { name: 'Zinc Tablets', category_id: tablets })
    b.p1 = await makeBatch(t, tid, p.para.id, {
      batch_no: 'P1',
      expiry_date: addDays(today, 30),
      mrp_paise: 3000,
      supplier_id: su1.id,
    })
    b.p2 = await makeBatch(t, tid, p.para.id, {
      batch_no: 'P2',
      expiry_date: ago(10),
      mrp_paise: 3000,
    })
    b.p3 = await makeBatch(t, tid, p.para.id, {
      batch_no: 'P3',
      expiry_date: addDays(today, 400),
      mrp_paise: 3000,
    })
    b.a1 = await makeBatch(t, tid, p.alpra.id, { batch_no: 'A1', expiry_date: addDays(today, 200) })
    await openingStock(shop, shop.store.id, p.para, 200_000, 2000, b.p1)
    await openingStock(shop, shop.store.id, p.para, 50_000, 2000, b.p2)
    await openingStock(shop, shop.store.id, p.para, 100_000, 2000, b.p3)
    await openingStock(shop, shop.store.id, p.alpra, 100_000, 3000, b.a1)
    await openingStock(shop, shop.store.id, p.cream, 10_000, 8000)
    await openingStock(shop, shop.store.id, p.bandage, 50_000, 1000)
    await historicalInbound(t, shop, p.old, 4000, 5000, new Date(`${ago(100)}T10:00:00+05:30`))

    // Sales.
    const rx = {
      patient_name: 'Meena',
      patient_age: 45,
      patient_address: 'Madurai',
      doctor_name: 'Dr. Ravi',
      doctor_reg_no: 'TNMC 12345',
    }
    await makeInvoice(t, shop, {
      number: 'S1-A/2627/00101',
      date: ago(3),
      rx,
      lines: [
        {
          product: p.alpra,
          batch_id: b.a1,
          qty_milli: 20_000,
          unit_price_paise: 5000,
          meta: { schedule: 'H1' },
        },
        {
          product: p.para,
          batch_id: b.p1,
          qty_milli: 10_000,
          unit_price_paise: 3000,
          meta: { schedule: 'H' },
        },
      ],
      tenders: [{ method: 'cash', amount_paise: 14_560 }],
    })
    await makeInvoice(t, shop, {
      number: 'S1-A/2627/00102',
      date: ago(1),
      lines: [
        {
          product: p.alpra,
          batch_id: b.a1,
          qty_milli: 10_000,
          unit_price_paise: 5000,
          meta: { schedule: 'H1' },
        },
      ],
      tenders: [{ method: 'cash', amount_paise: 5600 }],
    })
    const cu2 = await makeCustomer(t, tid, { name: 'Paid Up Patient' })
    await makeInvoice(t, shop, {
      number: 'S1-A/2627/00103',
      date: ago(5),
      customer: cu2,
      lines: [{ product: p.cream, qty_milli: 1000, unit_price_paise: 12_000 }],
      tenders: [{ method: 'upi', amount_paise: 12_000 }],
    })
    await makeInvoice(t, shop, {
      number: 'S1-A/2627/00104',
      date: ago(10),
      lines: [{ product: p.bandage, qty_milli: 2000, unit_price_paise: 1500 }],
      tenders: [{ method: 'cash', amount_paise: 3000 }],
    })

    // Customer dues (ad-hoc lines, no GST): 120 / 75 / 45 / 10 days old + an opening balance.
    cu1 = await makeCustomer(t, tid, {
      name: 'Selvi Clinic',
      credit_days: 30,
      phone: '+919876500001',
    })
    const dues = [
      [120, 50_000, 10_000],
      [75, 30_000, 0],
      [45, 20_000, 0],
      [10, 10_000, 0],
    ] as const
    for (const [i, [days, amount, paid]] of dues.entries()) {
      await makeInvoice(t, shop, {
        number: `S1/2627/0090${i}`,
        date: ago(days),
        customer: cu1,
        due_days: 30,
        lines: [{ name: 'Medicines', qty_milli: 1000, unit_price_paise: amount, gst_rate_bp: 0 }],
        tenders: paid ? [{ method: 'cash', amount_paise: paid }] : [],
      })
    }
    await openingBalance(shop, { type: 'customer', id: cu1.id }, 5000, ago(200))
    await pay(shop, {
      direction: 'in',
      party: { type: 'customer', id: cu1.id },
      amount_paise: 3000,
      date: ago(5),
    })
    cu3 = await makeCustomer(t, tid, { name: 'Branch Customer', credit_days: 15 })
    await makeInvoice(t, shop, {
      number: 'S2/2627/00001',
      date: ago(20),
      customer: cu3,
      store_id: s2.id,
      register_id: null,
      due_days: 15,
      lines: [{ name: 'Medicines', qty_milli: 1000, unit_price_paise: 7000, gst_rate_bp: 0 }],
    })

    // Supplier dues: due in 3 days, overdue by 10 days (with a return), 70-day-old bill without due date.
    const bills: BillFx[] = []
    for (const [i, [date, due, qty, cost]] of (
      [
        [ago(2), addDays(today, 3), 10_000, 1180],
        [ago(40), ago(10), 20_000, 1000],
        [ago(70), null, 30_000, 1000],
      ] as const
    ).entries()) {
      bills.push(
        await makeBill(t, shop, {
          supplier: su1,
          number: `GRNS1/2627/0000${i + 1}`,
          supplier_invoice_no: `MPD-${i + 1}`,
          date,
          due_date: due,
          lines: [{ product: p.cotton, qty_milli: qty, unit_cost_paise: cost }],
        }),
      )
    }
    await makeDebitNote(t, shop, {
      bill: bills[1]!,
      supplier: su1,
      number: 'DNS1/2627/00001',
      date: ago(9),
      lines: [{ product: p.cotton, qty_milli: 5000, unit_cost_paise: 1000 }],
    })
    await makeDebitNote(t, shop, {
      bill: null,
      supplier: su1,
      number: 'DNS1/2627/00002',
      date: ago(8),
      lines: [{ product: p.cotton, qty_milli: 1000, unit_cost_paise: 1000 }],
    })
    await pay(shop, {
      direction: 'out',
      party: { type: 'supplier', id: su1.id },
      amount_paise: 2000,
      date: ago(1),
    })

    const oc = await makeCustomer(t, other.tenant.id, { name: 'Other Debtor' })
    await makeInvoice(t, other, {
      number: 'S1/2627/00001',
      date: ago(15),
      customer: oc,
      lines: [{ name: 'Medicines', qty_milli: 1000, unit_price_paise: 99_000, gst_rate_bp: 0 }],
    })
  })

  afterAll(() => t.close())

  it('stock summary by category and product at cost, MRP and selling price', async () => {
    const r = await get<StockSummaryResponse>(shop, '/reports/stock-summary')
    expect(r.status).toBe(200)
    expect(
      r.body.data.map((x) => [
        x.name,
        x.products,
        x.value_cost_paise,
        x.value_mrp_paise,
        x.value_sale_paise,
      ]),
    ).toEqual([
      ['Uncategorised', 4, 195_620, 135_000, 208_000],
      ['Tablets', 2, 89_000, 137_000, 126_700],
    ])
    expect(r.body.totals).toEqual({
      products: 6,
      value_cost_paise: 284_620,
      value_mrp_paise: 272_000,
      value_sale_paise: 334_700,
      negative_count: 0,
    })
    expect(r.body.meta).toMatchObject({
      report: 'stock-summary',
      as_of: today,
      group_by: 'category',
    })
    const prod = await get<StockSummaryResponse>(
      shop,
      `/reports/stock-summary?group_by=product&category_id=${tablets}`,
    )
    expect(
      prod.body.data.map((x) => [
        x.name,
        x.qty_milli,
        x.value_cost_paise,
        x.avg_cost_paise,
        x.pack_size,
      ]),
    ).toEqual([
      ['Paracetamol 500mg', 340_000, 68_000, 2000, 10],
      ['Alprazolam 0.25mg', 70_000, 21_000, 3000, 10],
    ])
    const withZero = await get<StockSummaryResponse>(
      shop,
      `/reports/stock-summary?group_by=product&category_id=${tablets}&include_zero=true`,
    )
    expect(withZero.body.data.map((x) => x.name)).toContain('Zinc Tablets')
    const q = await get<StockSummaryResponse>(
      shop,
      '/reports/stock-summary?group_by=product&q=cream',
    )
    expect(q.body.data.map((x) => [x.name, x.qty_milli, x.value_mrp_paise])).toEqual([
      ['Skin Cream', 9000, 135_000],
    ])
    const s2r = await get<StockSummaryResponse>(shop, `/reports/stock-summary?store_id=${s2.id}`)
    expect(s2r.body.data).toEqual([])
  })

  it('stock ageing since the last inbound movement', async () => {
    const r = await get<StockAgeingResponse>(shop, '/reports/stock-ageing')
    expect(r.status).toBe(200)
    expect(r.body.data[0]).toMatchObject({
      name: 'Old Tonic',
      last_inbound_date: ago(100),
      age_days: 100,
      bucket: '90_plus',
      value_cost_paise: 20_000,
    })
    expect(r.body.totals).toEqual({
      rows: 6,
      value_cost_paise: 284_620,
      bucket_0_30_paise: 264_620,
      bucket_31_60_paise: 0,
      bucket_61_90_paise: 0,
      bucket_90_plus_paise: 20_000,
    })
    const old = await get<StockAgeingResponse>(shop, '/reports/stock-ageing?bucket=90_plus')
    expect(old.body.data.map((x) => x.name)).toEqual(['Old Tonic'])
    const batches = await get<StockAgeingResponse>(
      shop,
      `/reports/stock-ageing?group=batch&category_id=${tablets}&sort=name`,
    )
    expect(batches.body.data.map((x) => x.batch_no).sort()).toEqual(['A1', 'P1', 'P2', 'P3'])
  })

  it('expiry: expired and expiring batches with value', async () => {
    const r = await get<ExpiryResponse>(shop, '/reports/expiry')
    expect(r.status).toBe(200)
    expect(
      r.body.data.map((x) => [
        x.batch_no,
        x.status,
        x.days_to_expiry,
        x.qty_milli,
        x.value_cost_paise,
        x.value_mrp_paise,
      ]),
    ).toEqual([
      ['P2', 'expired', -10, 50_000, 10_000, 15_000],
      ['P1', 'expiring', 30, 190_000, 38_000, 57_000],
    ])
    expect(r.body.data[1]).toMatchObject({
      supplier_name: 'Madurai Pharma Distributors',
      store_id: shop.store.id,
    })
    expect(r.body.totals).toEqual({
      expired_count: 1,
      expired_value_cost_paise: 10_000,
      expiring_count: 1,
      expiring_value_cost_paise: 38_000,
      value_cost_paise: 48_000,
      value_mrp_paise: 72_000,
    })
    const notExpired = await get<ExpiryResponse>(shop, '/reports/expiry?include_expired=false')
    expect(notExpired.body.data.map((x) => x.batch_no)).toEqual(['P1'])
    const soon = await get<ExpiryResponse>(shop, '/reports/expiry?days=20')
    expect(soon.body.data.map((x) => x.batch_no)).toEqual(['P2'])
    const bySupplier = await get<ExpiryResponse>(shop, `/reports/expiry?supplier_id=${su1.id}`)
    expect(bySupplier.body.data.map((x) => x.batch_no)).toEqual(['P1'])
  })

  it('dead stock: in stock but no sale in N days', async () => {
    const r30 = await get<DeadStockResponse>(shop, '/reports/dead-stock?days=30')
    expect(
      r30.body.data.map((x) => [
        x.name,
        x.value_cost_paise,
        x.last_sold_date,
        x.days_since_last_sale,
      ]),
    ).toEqual([
      ['Cotton Wool', 55_620, null, null],
      ['Old Tonic', 20_000, null, null],
    ])
    expect(r30.body.totals).toEqual({ products: 2, value_cost_paise: 75_620 })
    const r5 = await get<DeadStockResponse>(shop, '/reports/dead-stock?days=5')
    expect(r5.body.data.map((x) => [x.name, x.days_since_last_sale])).toEqual([
      ['Skin Cream', 5],
      ['Cotton Wool', null],
      ['Bandage Roll', 10],
      ['Old Tonic', null],
    ])
    const big = await get<DeadStockResponse>(
      shop,
      '/reports/dead-stock?days=30&min_value_paise=50000',
    )
    expect(big.body.data.map((x) => x.name)).toEqual(['Cotton Wool'])
  })

  it('customer outstanding aged by invoice date, with opening balance and advance', async () => {
    const r = await get<CustomerOutstandingResponse>(shop, '/reports/customer-outstanding')
    expect(r.status).toBe(200)
    expect(r.body.data.map((x) => x.name)).toEqual(['Selvi Clinic', 'Branch Customer'])
    expect(r.body.data[0]).toEqual({
      customer_id: cu1.id,
      name: 'Selvi Clinic',
      name_ta: null,
      phone: '+919876500001',
      credit_limit_paise: null,
      credit_days: 30,
      overdue_paise: 95_000,
      whatsapp_opt_in: true,
      balance_paise: 102_000,
      due_paise: 105_000,
      not_due_paise: 0,
      bucket_0_30_paise: 10_000,
      bucket_31_60_paise: 20_000,
      bucket_61_90_paise: 30_000,
      bucket_90_plus_paise: 45_000,
      unallocated_credit_paise: 3000,
      unreconciled_paise: 0,
      open_documents: 5,
      oldest_due_date: ago(200),
      oldest_due_days: 200,
      last_payment_date: ago(5),
    })
    expect(r.body.data[1]).toMatchObject({
      due_paise: 7000,
      bucket_0_30_paise: 7000,
      overdue_paise: 7000,
      balance_paise: 7000,
      unreconciled_paise: 0,
    })
    expect(r.body.totals).toEqual({
      parties: 2,
      balance_paise: 109_000,
      due_paise: 112_000,
      not_due_paise: 0,
      bucket_0_30_paise: 17_000,
      bucket_31_60_paise: 20_000,
      bucket_61_90_paise: 30_000,
      bucket_90_plus_paise: 45_000,
      unallocated_credit_paise: 3000,
      overdue_paise: 102_000,
    })
    expect(r.body.meta.notes).toContain('includes_opening_balances')

    const s1 = await get<CustomerOutstandingResponse>(
      shop,
      `/reports/customer-outstanding?store_id=${shop.store.id}`,
    )
    expect(s1.body.data).toHaveLength(1)
    expect(s1.body.data[0]).toMatchObject({
      due_paise: 100_000,
      bucket_90_plus_paise: 40_000,
      unallocated_credit_paise: 3000,
      balance_paise: 102_000,
      unreconciled_paise: 5000,
    })
    expect(s1.body.meta.notes).not.toContain('includes_opening_balances')
    const old = await get<CustomerOutstandingResponse>(
      shop,
      '/reports/customer-outstanding?bucket=61_90',
    )
    expect(old.body.data.map((x) => x.name)).toEqual(['Selvi Clinic'])
    const big = await get<CustomerOutstandingResponse>(
      shop,
      '/reports/customer-outstanding?min_due_paise=50000',
    )
    expect(big.body.data.map((x) => x.name)).toEqual(['Selvi Clinic'])
    const q = await get<CustomerOutstandingResponse>(shop, '/reports/customer-outstanding?q=98765')
    expect(q.body.data.map((x) => x.name)).toEqual(['Selvi Clinic'])
    const byName = await get<CustomerOutstandingResponse>(
      shop,
      '/reports/customer-outstanding?sort=name',
    )
    expect(byName.body.data.map((x) => x.name)).toEqual(['Branch Customer', 'Selvi Clinic'])
    const csv = await shop.inject({
      method: 'GET',
      url: '/api/v1/reports/customer-outstanding?format=csv',
    })
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
    expect(lines[0]).toBe(
      'Customer,Phone,Due,0–30 days,31–60 days,61–90 days,Over 90 days,Advance / credit,Ledger balance,Oldest due (days),Last payment,Overdue',
    )
    expect(lines[1]).toBe(
      `Selvi Clinic,98765 00001,1050.00,100.00,200.00,300.00,450.00,30.00,1020.00,200,${ago(5)},950.00`,
    )
    expect(lines.at(-1)).toBe('Total,,1120.00,170.00,200.00,300.00,450.00,30.00,1090.00,,,1020.00')
  })

  it('supplier outstanding aged by due date, net of returns and advances', async () => {
    const r = await get<SupplierOutstandingResponse>(shop, '/reports/supplier-outstanding')
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual([
      {
        supplier_id: su1.id,
        name: 'Madurai Pharma Distributors',
        phone: null,
        gstin: null,
        overdue_paise: 45_000,
        due_next_7_days_paise: 11_800,
        balance_paise: 53_800,
        due_paise: 56_800,
        not_due_paise: 11_800,
        bucket_0_30_paise: 15_000,
        bucket_31_60_paise: 0,
        bucket_61_90_paise: 30_000,
        bucket_90_plus_paise: 0,
        unallocated_credit_paise: 3000,
        unreconciled_paise: 0,
        open_documents: 3,
        oldest_due_date: ago(70),
        oldest_due_days: 70,
        last_payment_date: ago(1),
      },
    ])
    const overdue = await get<SupplierOutstandingResponse>(
      shop,
      '/reports/supplier-outstanding?overdue_only=true&bucket=90_plus',
    )
    expect(overdue.body.data).toEqual([])
  })

  it('Schedule H1 register with prescription details', async () => {
    const r = await get<H1RegisterResponse>(
      shop,
      `/reports/pharmacy/h1-register?from=${ago(30)}&to=${today}`,
    )
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(2)
    expect(r.body.data[0]).toMatchObject({
      date: ago(3),
      invoice_number: 'S1-A/2627/00101',
      patient_name: 'Meena',
      patient_age: '45',
      patient_address: 'Madurai',
      doctor_name: 'Dr. Ravi',
      doctor_reg_no: 'TNMC 12345',
      drug_name: 'Alprazolam 0.25mg',
      generic_name: 'Alprazolam',
      schedule: 'H1',
      batch_no: 'A1',
      expiry_date: addDays(today, 200),
      qty_milli: 20_000,
      unit: 'TAB',
      pack_size: 10,
      dispensed_by_name: shop.owner.user.full_name,
    })
    expect(r.body.data[1]).toMatchObject({
      patient_name: null,
      doctor_name: null,
      qty_milli: 10_000,
    })
    expect(r.body.totals).toEqual({ entries: 2, invoices: 2, missing_rx: 1 })
    const both = await get<H1RegisterResponse>(
      shop,
      `/reports/pharmacy/h1-register?from=${ago(30)}&to=${today}&schedule=H&schedule=H1`,
    )
    expect(both.body.data.map((x) => x.schedule).sort()).toEqual(['H', 'H1', 'H1'])
    const q = await get<H1RegisterResponse>(
      shop,
      `/reports/pharmacy/h1-register?from=${ago(30)}&to=${today}&q=meena`,
    )
    expect(q.body.data).toHaveLength(1)
    const pharmacist = await shop.asRole('pharmacist')
    expect(
      (await get(shop, `/reports/pharmacy/h1-register?from=${ago(30)}&to=${today}`, pharmacist))
        .status,
    ).toBe(200)
  })

  it('scheduled drug sales with prescription capture', async () => {
    const r = await get<ScheduleSalesResponse>(
      shop,
      `/reports/pharmacy/schedule-sales?from=${ago(30)}&to=${today}`,
    )
    expect(
      r.body.data.map((x) => [x.schedule, x.bills, x.net_sales_paise, x.rx_captured, x.rx_missing]),
    ).toEqual([
      ['H1', 2, 16_800, 1, 1],
      ['H', 1, 3360, 1, 0],
    ])
    expect(r.body.totals).toEqual({
      bills: 2,
      net_sales_paise: 20_160,
      rx_captured: 1,
      rx_missing: 1,
    })
    const byDrug = await get<ScheduleSalesResponse>(
      shop,
      `/reports/pharmacy/schedule-sales?from=${ago(30)}&to=${today}&group_by=product`,
    )
    expect(byDrug.body.data.map((x) => [x.schedule, x.name, x.qty_milli])).toEqual([
      ['H1', 'Alprazolam 0.25mg', 30_000],
      ['H', 'Paracetamol 500mg', 10_000],
    ])
  })

  it('permissions and tenant isolation', async () => {
    const cashier = await shop.asRole('cashier')
    expect((await get(shop, '/reports/customer-outstanding', cashier)).status).toBe(403)
    expect((await get(shop, '/reports/stock-summary', cashier)).status).toBe(403)
    const theirs = await get<CustomerOutstandingResponse>(other, '/reports/customer-outstanding')
    expect(theirs.body.data.map((x) => x.name)).toEqual(['Other Debtor'])
    const mine = await get<CustomerOutstandingResponse>(shop, '/reports/customer-outstanding')
    expect(mine.body.data.map((x) => x.name)).not.toContain('Other Debtor')
    const otherStock = await get<StockSummaryResponse>(other, '/reports/stock-summary')
    expect(otherStock.body.totals.products).toBe(0)
  })
})
