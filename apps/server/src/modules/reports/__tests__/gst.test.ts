/**
 * GST returns: GSTR-1 (every section incl. the B2CL threshold, credit notes, nil, HSN B2B/B2C,
 * documents issued with a cancelled bill, warnings), the offline-tool JSON / CSV export (audited),
 * GSTR-3B (3.1, 3.2, 4 with blocked ITC and RCM, 5, 6.1), the GST registers, multi-GSTIN
 * businesses, composition and unregistered tenants, permissions, plan gating, store scope and
 * tenant isolation — on a realistic month of a Tamil Nadu shop (Aug 2026).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeGstin } from '@kadai/shared'
import {
  GSTR1_PORTAL_SCHEMA_VERSION,
  type Gstr1Report,
  type Gstr1Response,
  type Gstr3bReport,
  type Gstr3bResponse,
  type HsnSummaryResponse,
  type PurchaseRegisterResponse,
  type SalesRegisterResponse,
} from '@kadai/shared/api/reports'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  type CustomerFx,
  type InvoiceFx,
  type ProductFx,
  auditActions,
  badGstin,
  errorOf,
  get,
  makeBill,
  makeCreditNote,
  makeCustomer,
  makeDebitNote,
  makeExpense,
  makeInvoice,
  makeProduct,
  makeStore,
  makeSupplier,
  openingStock,
} from './fixtures'

const PERIOD = '2026-08'

describe('reports: GST returns', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  const p: Record<string, ProductFx> = {}
  const inv: Record<string, InvoiceFx> = {}
  let custA: CustomerFx
  let custB: CustomerFx
  let s2: { id: string; code: string }
  let s2Gstin: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { plan_code: 'pro' })
    other = await createTestTenant(t, { plan_code: 'pro' })
    const tid = shop.tenant.id
    p.rice = await makeProduct(t, tid, {
      name: 'Ponni Rice',
      unit: 'KG',
      hsn_code: '1006',
      gst_rate_bp: 500,
    })
    p.soap = await makeProduct(t, tid, { name: 'Bath Soap', hsn_code: '3401', gst_rate_bp: 1800 })
    p.milk = await makeProduct(t, tid, { name: 'Milk', hsn_code: '0401', gst_rate_bp: 0 })
    p.tv = await makeProduct(t, tid, { name: 'LED TV', hsn_code: '8528', gst_rate_bp: 1800 })
    p.cable = await makeProduct(t, tid, { name: 'HDMI Cable', hsn_code: '8544', gst_rate_bp: 1800 })
    p.loose = await makeProduct(t, tid, { name: 'Loose Item', hsn_code: null, gst_rate_bp: 1800 })
    for (const [k, qty, cost] of [
      ['rice', 100_000, 4000],
      ['soap', 100_000, 7000],
      ['milk', 50_000, 4000],
      ['tv', 5000, 9_000_000],
      ['cable', 5000, 50_000],
      ['loose', 20_000, 6000],
    ] as const) {
      await openingStock(shop, shop.store.id, p[k]!, qty, cost)
    }
    custA = await makeCustomer(t, tid, {
      name: 'Annai Traders',
      gstin: makeGstin('33', 'AABCA1234D', '1'),
      credit_days: 7,
    })
    custB = await makeCustomer(t, tid, {
      name: 'Bengaluru Mart',
      gstin: makeGstin('29', 'AABCB5678E', '1'),
    })

    const n = (i: number) => `S1/2627/${String(i).padStart(5, '0')}`
    inv.i1 = await makeInvoice(t, shop, {
      number: n(1),
      date: '2026-08-05',
      customer: custA,
      lines: [
        { product: p.soap, qty_milli: 10_000, unit_price_paise: 10_000 },
        { product: p.milk, qty_milli: 2000, unit_price_paise: 5000 },
      ],
      tenders: [{ method: 'cash', amount_paise: 28_000 }],
      due_days: 7,
    })
    inv.i2 = await makeInvoice(t, shop, {
      number: n(2),
      date: '2026-08-10',
      lines: [{ product: p.rice, qty_milli: 10_000, unit_price_paise: 5000 }],
      tenders: [{ method: 'upi', amount_paise: 52_500 }],
    })
    inv.i3 = await makeInvoice(t, shop, {
      number: n(3),
      date: '2026-08-12',
      place_of_supply: '29',
      lines: [{ product: p.soap, qty_milli: 5000, unit_price_paise: 10_000 }],
      tenders: [{ method: 'card', amount_paise: 59_000 }],
    })
    inv.i4 = await makeInvoice(t, shop, {
      number: n(4),
      date: '2026-08-15',
      customer_name: 'Ravi Kumar',
      place_of_supply: '29',
      lines: [
        { product: p.tv, qty_milli: 1000, unit_price_paise: 11_900_000 },
        { product: p.cable, qty_milli: 1000, unit_price_paise: 100_000 },
      ],
      tenders: [{ method: 'bank_transfer', amount_paise: 14_160_000 }],
    })
    // Exactly ₹1,00,000: B2CL needs MORE than the threshold → B2CS.
    inv.i5 = await makeInvoice(t, shop, {
      number: n(5),
      date: '2026-08-15',
      place_of_supply: '29',
      lines: [{ product: p.tv, qty_milli: 1000, unit_price_paise: 8_474_576 }],
      tenders: [{ method: 'bank_transfer', amount_paise: 10_000_000 }],
    })
    inv.i6 = await makeInvoice(t, shop, {
      number: n(6),
      date: '2026-08-16',
      lines: [{ product: p.soap, qty_milli: 1000, unit_price_paise: 10_000 }],
      tenders: [{ method: 'cash', amount_paise: 11_800 }],
      cancelled: { at: new Date('2026-08-16T12:00:00+05:30'), reason: 'Billed twice' },
    })
    inv.i7 = await makeInvoice(t, shop, {
      number: n(7),
      date: '2026-08-19',
      customer: custB,
      place_of_supply: '29',
      lines: [{ product: p.soap, qty_milli: 20_000, unit_price_paise: 10_000 }],
      due_days: 30,
    })
    inv.i8 = await makeInvoice(t, shop, {
      number: n(8),
      date: '2026-08-20',
      customer_name: 'Wrong GSTIN Stores',
      customer_gstin: badGstin('33'),
      lines: [{ product: p.soap, qty_milli: 1000, unit_price_paise: 10_000 }],
      tenders: [{ method: 'cash', amount_paise: 11_800 }],
    })
    inv.i9 = await makeInvoice(t, shop, {
      number: n(9),
      date: '2026-08-20',
      lines: [{ product: p.loose, qty_milli: 1000, unit_price_paise: 10_000 }],
      tenders: [{ method: 'cash', amount_paise: 11_800 }],
    })
    const cn = (i: number) => `CNS1/2627/${String(i).padStart(5, '0')}`
    await makeCreditNote(t, shop, {
      number: cn(1),
      date: '2026-08-25',
      invoice: inv.i1,
      lines: [{ line: 0, qty_milli: 2000 }],
      settlement: 'adjust_due',
    })
    await makeCreditNote(t, shop, {
      number: cn(2),
      date: '2026-08-26',
      invoice: inv.i2,
      lines: [{ line: 0, qty_milli: 2000 }],
      settlement: 'cash',
    })
    await makeCreditNote(t, shop, {
      number: cn(3),
      date: '2026-08-27',
      invoice: inv.i4,
      lines: [{ line: 1, qty_milli: 1000 }],
      settlement: 'cash',
    })
    await makeCreditNote(t, shop, {
      number: cn(4),
      date: '2026-08-28',
      invoice: inv.i3,
      lines: [{ line: 0, qty_milli: 1000 }],
      settlement: 'cash',
      cancelled: { at: new Date('2026-08-28T17:00:00+05:30'), reason: 'Entered by mistake' },
    })

    // Inward supplies.
    const supA = await makeSupplier(t, tid, {
      name: 'Chennai Wholesale',
      gstin: makeGstin('33', 'AABCS1111F', '1'),
    })
    const supB = await makeSupplier(t, tid, {
      name: 'Mysuru Agencies',
      gstin: makeGstin('29', 'AABCS2222G', '1'),
    })
    const supC = await makeSupplier(t, tid, { name: 'Village Farmer', gstin: null })
    const b1 = await makeBill(t, shop, {
      supplier: supA,
      number: 'GRNS1/2627/00001',
      supplier_invoice_no: 'CW-101',
      date: '2026-08-03',
      lines: [{ product: p.soap, qty_milli: 40_000, unit_cost_paise: 10_000 }],
    })
    await makeBill(t, shop, {
      supplier: supB,
      number: 'GRNS1/2627/00002',
      supplier_invoice_no: 'MA-55',
      date: '2026-08-04',
      interstate: true,
      lines: [{ product: p.rice, qty_milli: 50_000, unit_cost_paise: 4000 }],
    })
    await makeBill(t, shop, {
      supplier: supA,
      number: 'GRNS1/2627/00003',
      supplier_invoice_no: 'CW-102',
      date: '2026-08-06',
      itc_eligible: false,
      lines: [{ product: p.soap, qty_milli: 10_000, unit_cost_paise: 10_000 }],
    })
    await makeBill(t, shop, {
      supplier: supC,
      number: 'GRNS1/2627/00004',
      supplier_invoice_no: 'SELF-1',
      date: '2026-08-07',
      reverse_charge: true,
      lines: [{ product: p.rice, qty_milli: 10_000, unit_cost_paise: 5000 }],
    })
    await makeBill(t, shop, {
      supplier: supA,
      number: 'GRNS1/2627/00005',
      supplier_invoice_no: 'CW-103',
      date: '2026-08-08',
      lines: [{ product: p.milk, qty_milli: 10_000, unit_cost_paise: 3000 }],
    })
    await makeBill(t, shop, {
      supplier: supC,
      number: 'GRNS1/2627/00006',
      supplier_invoice_no: 'VF-9',
      date: '2026-08-09',
      lines: [{ product: p.loose, qty_milli: 1000, unit_cost_paise: 10_000 }],
    })
    await makeDebitNote(t, shop, {
      bill: b1,
      supplier: supA,
      number: 'DNS1/2627/00001',
      date: '2026-08-28',
      lines: [{ product: p.soap, qty_milli: 4000, unit_cost_paise: 10_000 }],
    })
    await makeExpense(t, shop, {
      date: '2026-08-11',
      number: 'EXPS1/2627/00001',
      account_code: '5340',
      taxable_paise: 100_000,
      gst_rate_bp: 1800,
      itc_eligible: true,
      supplier: supA,
      description: 'Freezer repair',
    })
    await makeExpense(t, shop, {
      date: '2026-08-12',
      number: 'EXPS1/2627/00002',
      account_code: '5390',
      taxable_paise: 50_000,
      gst_rate_bp: 1800,
      itc_eligible: false,
      description: 'Staff lunch',
    })

    // A second registration (Karnataka branch) and a branch without its own GSTIN.
    s2Gstin = makeGstin('29', 'AAKCK7777P', '1')
    s2 = await makeStore(t, tid, 'S2', { gstin: s2Gstin, state_code: '29' })
    await openingStock(shop, s2.id, p.soap, 10_000, 7000)
    await makeInvoice(t, shop, {
      number: 'S2/2627/00001',
      date: '2026-08-14',
      store_id: s2.id,
      store_state: '29',
      register_id: null,
      lines: [{ product: p.soap, qty_milli: 2000, unit_price_paise: 10_000 }],
      tenders: [{ method: 'cash', amount_paise: 23_600 }],
    })
    await makeStore(t, tid, 'S3')

    // Another tenant's B2B bill in the same month must never show up.
    const op = await makeProduct(t, other.tenant.id, {
      name: 'Other Soap',
      hsn_code: '3401',
      gst_rate_bp: 1800,
    })
    const oc = await makeCustomer(t, other.tenant.id, {
      name: 'Other Co',
      gstin: makeGstin('33', 'AABCO9999Q', '1'),
    })
    await makeInvoice(t, other, {
      number: 'S1/2627/00001',
      date: '2026-08-05',
      customer: oc,
      lines: [{ product: op, qty_milli: 1000, unit_price_paise: 50_000 }],
    })
  })

  afterAll(() => t.close())

  async function gstr1(query = ''): Promise<Gstr1Report> {
    const r = await get<{ data: Gstr1Response }>(
      shop,
      `/reports/tax/gstr1?period=${PERIOD}${query}`,
    )
    expect(r.status).toBe(200)
    expect(r.body.data.kind).toBe('gstr1')
    return r.body.data as Gstr1Report
  }

  it('GSTR-1: B2B per customer GSTIN with invoice-wise rate items (0 % lines excluded)', async () => {
    const g = await gstr1()
    expect(g.gstin).toBe(shop.tenant.gstin)
    expect(g.fp).toBe('082026')
    expect(g.store_ids.sort()).toHaveLength(2) // S1 and S3 (S3 inherits the business GSTIN)
    expect(g.gstins.map((o) => o.gstin).sort()).toEqual([shop.tenant.gstin, s2Gstin].sort())
    expect(g.b2b).toHaveLength(2)
    const a = g.b2b.find((x) => x.ctin === custA.gstin)!
    expect(a.receiver_name).toBe('Annai Traders')
    expect(a.invoices).toEqual([
      {
        invoice_id: inv.i1!.id,
        number: 'S1/2627/00001',
        date: '2026-08-05',
        value_paise: 128_000,
        place_of_supply: '33',
        reverse_charge: false,
        invoice_type: 'R',
        customer_name: 'Annai Traders',
        items: [
          {
            rate_bp: 1800,
            taxable_paise: 100_000,
            igst_paise: 0,
            cgst_paise: 9000,
            sgst_paise: 9000,
            cess_paise: 0,
          },
        ],
      },
    ])
    const b = g.b2b.find((x) => x.ctin === custB.gstin)!
    expect(b.invoices[0]).toMatchObject({
      number: 'S1/2627/00007',
      value_paise: 236_000,
      place_of_supply: '29',
      items: [
        { rate_bp: 1800, taxable_paise: 200_000, igst_paise: 36_000, cgst_paise: 0, sgst_paise: 0 },
      ],
    })
  })

  it('GSTR-1: B2CL only above ₹1,00,000 (inter-state, unregistered); B2CS aggregated net of returns', async () => {
    const g = await gstr1()
    expect(g.b2cl).toHaveLength(1)
    expect(g.b2cl[0]!.place_of_supply).toBe('29')
    expect(g.b2cl[0]!.invoices.map((i) => i.number)).toEqual(['S1/2627/00004'])
    expect(g.b2cl[0]!.invoices[0]).toMatchObject({
      value_paise: 14_160_000,
      items: [{ rate_bp: 1800, taxable_paise: 12_000_000, igst_paise: 2_160_000 }],
    })
    expect(g.b2cs).toEqual([
      {
        supply_type: 'INTRA',
        place_of_supply: '33',
        rate_bp: 500,
        type: 'OE',
        taxable_paise: 40_000,
        igst_paise: 0,
        cgst_paise: 1000,
        sgst_paise: 1000,
        cess_paise: 0,
      },
      {
        supply_type: 'INTRA',
        place_of_supply: '33',
        rate_bp: 1800,
        type: 'OE',
        taxable_paise: 20_000,
        igst_paise: 0,
        cgst_paise: 1800,
        sgst_paise: 1800,
        cess_paise: 0,
      },
      {
        supply_type: 'INTER',
        place_of_supply: '29',
        rate_bp: 1800,
        type: 'OE',
        taxable_paise: 8_524_576,
        igst_paise: 1_534_424,
        cgst_paise: 0,
        sgst_paise: 0,
        cess_paise: 0,
      },
    ])
  })

  it('GSTR-1: CDNR / CDNUR, nil (exempt), HSN B2B / B2C and documents issued', async () => {
    const g = await gstr1()
    expect(g.cdnr).toHaveLength(1)
    expect(g.cdnr[0]!.ctin).toBe(custA.gstin)
    expect(g.cdnr[0]!.notes[0]).toMatchObject({
      number: 'CNS1/2627/00001',
      date: '2026-08-25',
      note_type: 'C',
      value_paise: 23_600,
      original_invoice_number: 'S1/2627/00001',
      original_invoice_date: '2026-08-05',
      items: [
        { rate_bp: 1800, taxable_paise: 20_000, cgst_paise: 1800, sgst_paise: 1800, igst_paise: 0 },
      ],
    })
    expect(g.cdnur).toHaveLength(1)
    expect(g.cdnur[0]).toMatchObject({
      type: 'B2CL',
      number: 'CNS1/2627/00003',
      value_paise: 118_000,
      place_of_supply: '29',
      original_invoice_number: 'S1/2627/00004',
      items: [{ rate_bp: 1800, taxable_paise: 100_000, igst_paise: 18_000 }],
    })
    expect(g.nil).toEqual({
      inter_b2b: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
      intra_b2b: { nil_rated_paise: 0, exempt_paise: 10_000, non_gst_paise: 0 },
      inter_b2c: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
      intra_b2c: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
    })
    const row = (
      hsn: string | null,
      uqc: string,
      qty: number,
      rate: number,
      taxable: number,
      igst: number,
      cgst: number,
      total: number,
    ) => ({
      hsn_code: hsn,
      description: null,
      uqc,
      qty_milli: qty,
      rate_bp: rate,
      taxable_paise: taxable,
      igst_paise: igst,
      cgst_paise: cgst,
      sgst_paise: cgst,
      cess_paise: 0,
      total_value_paise: total,
    })
    expect(g.hsn.b2b).toEqual([
      row('0401', 'NOS', 2000, 0, 10_000, 0, 0, 10_000),
      row('3401', 'NOS', 28_000, 1800, 280_000, 36_000, 7200, 330_400),
    ])
    expect(g.hsn.b2c).toEqual([
      row('1006', 'KGS', 8000, 500, 40_000, 0, 1000, 42_000),
      row('3401', 'NOS', 6000, 1800, 60_000, 9000, 900, 70_800),
      row('8528', 'NOS', 2000, 1800, 20_374_576, 3_667_424, 0, 24_042_000),
      row(null, 'NOS', 1000, 1800, 10_000, 0, 900, 11_800),
    ])
    expect(g.doc_issue).toEqual([
      {
        doc_num: 1,
        doc_type: 'Invoices for outward supply',
        series: [
          {
            prefix: 'S1/2627/',
            from: 'S1/2627/00001',
            to: 'S1/2627/00009',
            total: 9,
            cancelled: 1,
            net_issued: 8,
          },
        ],
      },
      {
        doc_num: 5,
        doc_type: 'Credit Note',
        series: [
          {
            prefix: 'CNS1/2627/',
            from: 'CNS1/2627/00001',
            to: 'CNS1/2627/00004',
            total: 4,
            cancelled: 1,
            net_issued: 3,
          },
        ],
      },
    ])
  })

  it('GSTR-1: section summary and data warnings', async () => {
    const g = await gstr1()
    const s = Object.fromEntries(g.summary.map((x) => [x.section, x]))
    expect(s.b2b).toEqual({
      section: 'b2b',
      count: 2,
      value_paise: 364_000,
      taxable_paise: 300_000,
      igst_paise: 36_000,
      cgst_paise: 9000,
      sgst_paise: 9000,
      cess_paise: 0,
    })
    expect(s.b2cl).toMatchObject({
      count: 1,
      value_paise: 14_160_000,
      taxable_paise: 12_000_000,
      igst_paise: 2_160_000,
    })
    expect(s.b2cs).toMatchObject({
      count: 3,
      value_paise: 10_124_600,
      taxable_paise: 8_584_576,
      igst_paise: 1_534_424,
      cgst_paise: 2800,
      sgst_paise: 2800,
    })
    expect(s.cdnr).toMatchObject({ count: 1, value_paise: 23_600, taxable_paise: 20_000 })
    expect(s.cdnur).toMatchObject({ count: 1, value_paise: 118_000, igst_paise: 18_000 })
    expect(s.nil).toMatchObject({ count: 1, value_paise: 10_000 })
    expect(s.hsn_b2b).toMatchObject({ count: 2, value_paise: 340_400, taxable_paise: 290_000 })
    expect(s.hsn_b2c).toMatchObject({
      count: 4,
      value_paise: 24_166_600,
      taxable_paise: 20_484_576,
      igst_paise: 3_676_424,
      cgst_paise: 2800,
    })
    expect(s.doc_issue).toMatchObject({ count: 11, value_paise: 0 })
    // Outward taxable value reconciles with GSTR-3B 3.1(a).
    expect(
      s.b2b!.taxable_paise +
        s.b2cl!.taxable_paise +
        s.b2cs!.taxable_paise -
        s.cdnr!.taxable_paise -
        s.cdnur!.taxable_paise,
    ).toBe(20_764_576)

    const codes = g.warnings.map((w) => `${w.code}:${w.ref_type}:${w.label}`).sort()
    expect(codes).toEqual([
      'invalid_customer_gstin:sales_invoice:S1/2627/00008',
      'missing_hsn:product:Loose Item',
    ])
    const w = g.warnings.find((x) => x.code === 'missing_hsn')!
    expect(w.path).toBe(`/catalog/products/${p.loose!.id}`)
    expect(w.severity).toBe('error')
  })

  it('GSTR-1 for another registration covers only its stores', async () => {
    const g = await gstr1(`&gstin=${s2Gstin.toLowerCase()}`)
    expect(g.gstin).toBe(s2Gstin)
    expect(g.store_ids).toEqual([s2.id])
    expect(g.b2b).toEqual([])
    expect(g.b2cs).toEqual([
      {
        supply_type: 'INTRA',
        place_of_supply: '29',
        rate_bp: 1800,
        type: 'OE',
        taxable_paise: 20_000,
        igst_paise: 0,
        cgst_paise: 1800,
        sgst_paise: 1800,
        cess_paise: 0,
      },
    ])
    expect(g.doc_issue[0]!.series).toEqual([
      {
        prefix: 'S2/2627/',
        from: 'S2/2627/00001',
        to: 'S2/2627/00001',
        total: 1,
        cancelled: 0,
        net_issued: 1,
      },
    ])
    const r = await get(shop, `/reports/tax/gstr1?period=${PERIOD}&gstin=${other.tenant.gstin}`)
    expect(r.status).toBe(404)
    expect(errorOf(r).details?.reason).toBe('gstin_not_found')
  })

  it('exports the GST offline-tool JSON in rupees (audited)', async () => {
    const r = await shop.inject({
      method: 'GET',
      url: `/api/v1/reports/tax/gstr1/export?period=${PERIOD}&format=json`,
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('application/json')
    expect(r.headers['content-disposition']).toContain(`GSTR1_${shop.tenant.gstin}_082026.json`)
    const j = r.json() as Record<string, unknown> & {
      b2b: Array<{ ctin: string; inv: Array<Record<string, unknown>> }>
      b2cl: Array<{ pos: string; inv: Array<Record<string, unknown>> }>
      b2cs: Array<Record<string, unknown>>
      hsn: { hsn_b2b: unknown[]; hsn_b2c: Array<Record<string, unknown>> }
      doc_issue: { doc_det: Array<{ doc_num: number; docs: Array<Record<string, unknown>> }> }
    }
    expect(j.gstin).toBe(shop.tenant.gstin)
    expect(j.fp).toBe('082026')
    expect(j.version).toBe(GSTR1_PORTAL_SCHEMA_VERSION)
    expect(j.hash).toBe('hash')
    const a = j.b2b.find((x) => x.ctin === custA.gstin)!
    expect(a.inv[0]).toEqual({
      inum: 'S1/2627/00001',
      idt: '05-08-2026',
      val: 1280,
      pos: '33',
      rchrg: 'N',
      inv_typ: 'R',
      itms: [{ num: 1, itm_det: { txval: 1000, rt: 18, camt: 90, samt: 90, csamt: 0 } }],
    })
    expect(j.b2cl[0]).toEqual({
      pos: '29',
      inv: [
        {
          inum: 'S1/2627/00004',
          idt: '15-08-2026',
          val: 141_600,
          itms: [{ num: 1, itm_det: { txval: 120_000, rt: 18, iamt: 21_600, csamt: 0 } }],
        },
      ],
    })
    expect(j.b2cs).toContainEqual({
      sply_ty: 'INTER',
      pos: '29',
      typ: 'OE',
      txval: 85_245.76,
      rt: 18,
      iamt: 15_344.24,
      csamt: 0,
    })
    expect(j.hsn.hsn_b2b).toHaveLength(2)
    // Lines without HSN stay out of the portal tables (they are warnings).
    expect(j.hsn.hsn_b2c.map((h) => h.hsn_sc)).toEqual(['1006', '3401', '8528'])
    expect(j.hsn.hsn_b2c[0]).toMatchObject({
      uqc: 'KGS',
      qty: 8,
      rt: 5,
      txval: 400,
      camt: 10,
      samt: 10,
      iamt: 0,
    })
    expect(j.doc_issue.doc_det[0]!.docs[0]).toEqual({
      num: 1,
      from: 'S1/2627/00001',
      to: 'S1/2627/00009',
      totnum: 9,
      cancel: 1,
      net_issue: 8,
    })
    expect(await auditActions(t, shop.tenant.id)).toContain('gst.gstr1_export')
  })

  it('exports GSTR-1 as CSV (all sections or one), rejects section with JSON', async () => {
    const all = await shop.inject({
      method: 'GET',
      url: `/api/v1/reports/tax/gstr1/export?period=${PERIOD}&format=csv`,
    })
    expect(all.statusCode).toBe(200)
    expect(all.headers['content-type']).toContain('text/csv')
    const lines = all.body.replace(/^\uFEFF/, '').split('\r\n')
    expect(lines).toContain('# b2b')
    expect(lines).toContain('# doc_issue')
    const one = await shop.inject({
      method: 'GET',
      url: `/api/v1/reports/tax/gstr1/export?period=${PERIOD}&format=csv&section=b2cs`,
    })
    expect(one.headers['content-disposition']).toContain('_b2cs.csv')
    const rows = one.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
    expect(rows[0]).toBe(
      'Type,Supply Type,Place Of Supply,Rate,Taxable Value,Integrated Tax,Central Tax,State/UT Tax,Cess Amount',
    )
    expect(rows).toContain('OE,Inter State,29-Karnataka,18,85245.76,15344.24,0.00,0.00,0.00')
    expect(rows).toHaveLength(4)
    const bad = await shop.inject({
      method: 'GET',
      url: `/api/v1/reports/tax/gstr1/export?period=${PERIOD}&format=json&section=b2b`,
    })
    expect(bad.statusCode).toBe(400)
  })

  it('GSTR-3B: outward supplies, ITC (blocked + RCM), exempt inward and tax payment', async () => {
    const r = await get<{ data: Gstr3bResponse }>(shop, `/reports/tax/gstr3b?period=${PERIOD}`)
    expect(r.status).toBe(200)
    const g = r.body.data as Gstr3bReport
    expect(g.kind).toBe('gstr3b')
    expect(g.outward.taxable).toEqual({
      taxable_paise: 20_764_576,
      igst_paise: 3_712_424,
      cgst_paise: 10_000,
      sgst_paise: 10_000,
      cess_paise: 0,
    })
    expect(g.outward.nil_exempt.taxable_paise).toBe(10_000)
    expect(g.outward.inward_rcm).toEqual({
      taxable_paise: 50_000,
      igst_paise: 0,
      cgst_paise: 1250,
      sgst_paise: 1250,
      cess_paise: 0,
    })
    expect(g.outward.zero_rated.taxable_paise).toBe(0)
    expect(g.inter_state_unregistered).toEqual([
      { place_of_supply: '29', taxable_paise: 20_424_576, igst_paise: 3_676_424 },
    ])
    const h = (igst: number, cgst: number) => ({
      igst_paise: igst,
      cgst_paise: cgst,
      sgst_paise: cgst,
      cess_paise: 0,
    })
    expect(g.itc.all_other).toEqual(h(10_000, 55_800))
    expect(g.itc.inward_rcm).toEqual(h(0, 1250))
    expect(g.itc.reversed_rules).toEqual(h(0, 13_500))
    expect(g.itc.net).toEqual(h(10_000, 43_550))
    expect(g.exempt_inward.composition_exempt_nil).toEqual({ inter_paise: 0, intra_paise: 30_000 })
    const rows = Object.fromEntries(g.payment.rows.map((x) => [x.head, x]))
    expect(rows.igst).toEqual({
      head: 'igst',
      payable_paise: 3_712_424,
      paid_itc: h(10_000, 33_550),
      paid_cash_paise: 3_635_324,
      rcm_payable_paise: 0,
    })
    expect(rows.cgst).toEqual({
      head: 'cgst',
      payable_paise: 10_000,
      paid_itc: { igst_paise: 0, cgst_paise: 10_000, sgst_paise: 0, cess_paise: 0 },
      paid_cash_paise: 0,
      rcm_payable_paise: 1250,
    })
    expect(g.payment.cash_total_paise).toBe(3_637_824)
    expect(g.payment.itc_balance).toEqual(h(0, 0))
    expect(g.sources).toEqual({
      sales_invoices: 8,
      credit_notes: 3,
      purchase_bills: 6,
      debit_notes: 1,
      expenses: 2,
    })
    expect(g.warnings.map((w) => `${w.code}:${w.label}`)).toEqual([
      'missing_purchase_gstin:GRNS1/2627/00006',
    ])
  })

  it('GST registers: sales register (credit notes negative, cancelled optional)', async () => {
    const base = `/reports/tax/sales-register?period=${PERIOD}&gstin=${shop.tenant.gstin}`
    const r = await get<SalesRegisterResponse>(shop, base)
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(11)
    expect(r.body.totals).toEqual({
      documents: 11,
      taxable_paise: 20_774_576,
      igst_paise: 3_712_424,
      cgst_paise: 10_000,
      sgst_paise: 10_000,
      cess_paise: 0,
      total_paise: 24_507_000,
    })
    const cn1 = r.body.data.find((x) => x.number === 'CNS1/2627/00001')!
    expect(cn1).toMatchObject({
      kind: 'credit_note',
      total_paise: -23_600,
      original_invoice_number: 'S1/2627/00001',
    })
    const withCancelled = await get<SalesRegisterResponse>(shop, `${base}&include_cancelled=true`)
    expect(withCancelled.body.data).toHaveLength(13)
    expect(withCancelled.body.totals.total_paise).toBe(24_507_000)
    const b2b = await get<SalesRegisterResponse>(shop, `${base}&b2b_only=true`)
    expect(b2b.body.data.map((x) => x.number).sort()).toEqual([
      'CNS1/2627/00001',
      'S1/2627/00001',
      'S1/2627/00007',
      'S1/2627/00008',
    ])
    const csv = await shop.inject({ method: 'GET', url: `/api/v1${base}&format=csv` })
    const head = csv.body.replace(/^\uFEFF/, '').split('\r\n')[0]
    expect(head).toBe(
      'Date,Number,Type,Customer,GSTIN,Place of supply,Taxable value,IGST,CGST,SGST,Cess,Round off,Total',
    )
  })

  it('GST registers: purchase register with ITC and HSN summary', async () => {
    const base = `/reports/tax/purchase-register?period=${PERIOD}&gstin=${shop.tenant.gstin}`
    const r = await get<PurchaseRegisterResponse>(shop, base)
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(9)
    expect(r.body.totals).toMatchObject({ documents: 9, taxable_paise: 900_000, itc_paise: 97_100 })
    const dn = r.body.data.find((x) => x.kind === 'debit_note')!
    expect(dn).toMatchObject({
      total_paise: -47_200,
      itc_paise: -7200,
      supplier_invoice_no: 'CW-101',
    })
    const itc = await get<PurchaseRegisterResponse>(shop, `${base}&itc_only=true`)
    expect(itc.body.data).toHaveLength(6)
    const noExp = await get<PurchaseRegisterResponse>(shop, `${base}&include_expenses=false`)
    expect(noExp.body.data).toHaveLength(7)

    const hsn = await get<HsnSummaryResponse>(
      shop,
      `/reports/tax/hsn-summary?period=${PERIOD}&gstin=${shop.tenant.gstin}`,
    )
    expect(hsn.body.data).toHaveLength(6)
    expect(hsn.body.totals.documents).toBe(11)
    const b2b = await get<HsnSummaryResponse>(
      shop,
      `/reports/tax/hsn-summary?from=2026-08-01&to=2026-08-31&gstin=${shop.tenant.gstin}&supply=b2b`,
    )
    expect(b2b.body.data.map((x) => x.hsn_code)).toEqual(['0401', '3401'])
    expect(b2b.body.totals).toMatchObject({
      documents: 3,
      taxable_paise: 290_000,
      total_paise: 340_400,
    })
    const missing = await get(shop, '/reports/tax/hsn-summary')
    expect(missing.status).toBe(400)
  })

  it('validates the period, gates by permission, plan and store scope', async () => {
    expect((await get(shop, '/reports/tax/gstr1?period=2026-13')).status).toBe(400)
    expect((await get(shop, '/reports/tax/gstr1')).status).toBe(400)
    const cashier = await shop.asRole('cashier')
    const pharmacist = await shop.asRole('pharmacist')
    const accountant = await shop.asRole('accountant')
    expect((await get(shop, `/reports/tax/gstr1?period=${PERIOD}`, cashier)).status).toBe(403)
    expect((await get(shop, `/reports/tax/gstr3b?period=${PERIOD}`, pharmacist)).status).toBe(403)
    expect((await get(shop, `/reports/tax/gstr3b?period=${PERIOD}`, accountant)).status).toBe(200)
    // S1 and S3 share the business GSTIN: a member limited to S1 cannot file for it.
    const scoped = await shop.asRole('gst_s1', {
      permissions: ['reports.gst'],
      store_ids: [shop.store.id],
    })
    const denied = await get(shop, `/reports/tax/gstr1?period=${PERIOD}`, scoped)
    expect(denied.status).toBe(403)
    expect(errorOf(denied).details?.reason).toBe('all_stores_required')
    // … but may list its own store's register.
    const reg = await get<SalesRegisterResponse>(
      shop,
      `/reports/tax/sales-register?period=${PERIOD}`,
      scoped,
    )
    expect(reg.status).toBe(200)
    expect(reg.body.data.every((x) => !x.number.startsWith('S2/'))).toBe(true)
    expect(reg.body.meta.notes).toContain('store_filter_applied')

    const free = await createTestTenant(t, { plan_code: 'free' })
    const r = await get(free, `/reports/tax/gstr1?period=${PERIOD}`)
    expect(r.status).toBe(402)
    expect(errorOf(r).code).toBe('FEATURE_NOT_IN_PLAN')
  })

  it('never shows another tenant’s documents', async () => {
    const g = await gstr1()
    expect(g.b2b.map((x) => x.ctin)).not.toContain(makeGstin('33', 'AABCO9999Q', '1'))
    const og = await get<{ data: Gstr1Report }>(other, `/reports/tax/gstr1?period=${PERIOD}`)
    expect(og.body.data.b2b).toHaveLength(1)
    expect(og.body.data.b2b[0]!.invoices).toHaveLength(1)
    expect(og.body.data.doc_issue[1]!.series).toEqual([])
  })
})

describe('reports: composition and unregistered businesses', () => {
  let t: TestApp
  let comp: TestShop
  let unreg: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    comp = await createTestTenant(t, { gst_scheme: 'composition', plan_code: 'pro' })
    unreg = await createTestTenant(t, { gst_scheme: 'unregistered', plan_code: 'pro' })
    const rice = await makeProduct(t, comp.tenant.id, {
      name: 'Rice',
      unit: 'KG',
      hsn_code: '1006',
      gst_rate_bp: 500,
    })
    const milk = await makeProduct(t, comp.tenant.id, {
      name: 'Milk',
      hsn_code: '0401',
      gst_rate_bp: 0,
    })
    await openingStock(comp, comp.store.id, rice, 50_000, 4000)
    await openingStock(comp, comp.store.id, milk, 50_000, 4000)
    const i = await makeInvoice(t, comp, {
      number: 'S1B/2627/00001',
      date: '2026-08-10',
      doc_type: 'bill_of_supply',
      no_tax: true,
      lines: [
        { product: rice, qty_milli: 10_000, unit_price_paise: 5000 },
        { product: milk, qty_milli: 2000, unit_price_paise: 5000 },
      ],
      tenders: [{ method: 'cash', amount_paise: 60_000 }],
    })
    await makeCreditNote(t, comp, {
      number: 'CNS1/2627/00001',
      date: '2026-08-12',
      invoice: i,
      lines: [{ line: 0, qty_milli: 2000 }],
      settlement: 'cash',
    })
    const farmer = await makeSupplier(t, comp.tenant.id, { name: 'Farmer' })
    await makeBill(t, comp, {
      supplier: farmer,
      number: 'GRNS1/2627/00001',
      supplier_invoice_no: 'F-1',
      date: '2026-08-11',
      reverse_charge: true,
      lines: [{ product: rice, qty_milli: 4000, unit_cost_paise: 5000 }],
    })
  })

  afterAll(() => t.close())

  it('composition tenants get the CMP-08 quarterly summary for GSTR-1 and GSTR-3B', async () => {
    for (const path of ['gstr1', 'gstr3b']) {
      const r = await get<{ data: Gstr1Response }>(comp, `/reports/tax/${path}?period=2026-08`)
      expect(r.status).toBe(200)
      const d = r.body.data
      expect(d.kind).toBe('composition')
      if (d.kind !== 'composition') return
      expect(d.fy).toBe('2026-27')
      expect(d.quarter).toBe('Q2')
      expect(d.rate_bp).toBe(100)
      expect(d.quarters.map((q) => q.quarter)).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
      expect(d.quarters[1]).toEqual({
        quarter: 'Q2',
        from: '2026-07-01',
        to: '2026-09-30',
        bills: 1,
        outward_turnover_paise: 50_000,
        taxable_turnover_paise: 40_000,
        cgst_paise: 200,
        sgst_paise: 200,
        inward_rcm_taxable_paise: 20_000,
        inward_rcm_tax_paise: 1000,
      })
      expect(d.quarters[0]!.bills).toBe(0)
    }
    const exp = await get(comp, '/reports/tax/gstr1/export?period=2026-08')
    expect(exp.status).toBe(422)
    expect(errorOf(exp).details?.reason).toBe('gst_not_registered')
  })

  it('a regular business without a GSTIN gets a warning and cannot export', async () => {
    const noGstin = await createTestTenant(t, { plan_code: 'pro' })
    await t.deps.db.systemDb
      .updateTable('tenants')
      .set({ gstin: null })
      .where('id', '=', noGstin.tenant.id)
      .execute()
    await t.deps.db.systemDb
      .updateTable('stores')
      .set({ gstin: null })
      .where('tenant_id', '=', noGstin.tenant.id)
      .execute()
    const r = await get<{ data: Gstr1Response }>(noGstin, '/reports/tax/gstr1?period=2026-08')
    expect(r.status).toBe(200)
    const g = r.body.data as Gstr1Report
    expect(g.gstin).toBe('')
    expect(g.gstins).toEqual([])
    expect(g.store_ids).toEqual([noGstin.store.id])
    expect(g.warnings.map((w) => [w.code, w.ref_type, w.path])).toEqual([
      ['business_gstin_missing', 'tenant', '/settings/business'],
    ])
    const exp = await get(noGstin, '/reports/tax/gstr1/export?period=2026-08')
    expect(exp.status).toBe(422)
    expect(errorOf(exp).details?.reason).toBe('gst_not_registered')
  })

  it('warns about a bad place of supply, a registered customer billed without GSTIN and short HSN codes', async () => {
    const big = await createTestTenant(t, { plan_code: 'pro' })
    // Previous financial year (2025-26): aggregate turnover just above ₹5 crore.
    await makeInvoice(t, big, {
      number: 'S1/2526/00001',
      date: '2025-06-01',
      lines: [
        {
          name: 'Wholesale lot',
          hsn_code: '100630',
          qty_milli: 1000,
          unit_price_paise: 5_000_000_001,
          gst_rate_bp: 0,
        },
      ],
    })
    await makeInvoice(t, big, {
      number: 'S1/2627/00001',
      date: '2026-08-02',
      place_of_supply: '00',
      lines: [
        {
          name: 'Rice bag',
          hsn_code: '1006',
          qty_milli: 1000,
          unit_price_paise: 10_000,
          gst_rate_bp: 500,
        },
      ],
    })
    // A registered customer billed without the GSTIN on the invoice lands in B2CS → warned.
    const regd = await makeCustomer(t, big.tenant.id, {
      name: 'Kaveri Stores',
      gstin: makeGstin('33', 'AABCK4321F', '1'),
    })
    await makeInvoice(t, big, {
      number: 'S1/2627/00002',
      date: '2026-08-03',
      customer: regd,
      customer_gstin: null,
      lines: [
        {
          name: 'Rice bag',
          hsn_code: '100630',
          qty_milli: 1000,
          unit_price_paise: 20_000,
          gst_rate_bp: 500,
        },
      ],
    })
    const r = await get<{ data: Gstr1Response }>(big, '/reports/tax/gstr1?period=2026-08')
    const g = r.body.data as Gstr1Report
    expect(g.warnings.map((w) => [w.code, w.label]).sort()).toEqual([
      ['hsn_too_short', 'Rice bag'],
      ['invalid_customer_gstin', 'S1/2627/00002'],
      ['invalid_place_of_supply', 'S1/2627/00001'],
    ])
    expect(g.warnings.find((w) => w.code === 'invalid_place_of_supply')!.details).toEqual({
      place_of_supply: '00',
    })
    const missing = g.warnings.find((w) => w.code === 'invalid_customer_gstin')!
    expect(missing).toMatchObject({
      section: 'b2b',
      ref_type: 'sales_invoice',
      severity: 'warning',
    })
    expect(missing.details).toEqual({ gstin: null, customer_gstin: regd.gstin })
    expect(g.b2b).toEqual([])
  })

  it('unregistered businesses file no return', async () => {
    const r = await get<{ data: Gstr1Response }>(unreg, '/reports/tax/gstr1?period=2026-08')
    expect(r.body.data).toEqual({ kind: 'unregistered', period: '2026-08' })
    const b = await get<{ data: Gstr3bResponse }>(unreg, '/reports/tax/gstr3b?period=2026-08')
    expect(b.body.data).toEqual({ kind: 'unregistered', period: '2026-08' })
    const exp = await get(unreg, '/reports/tax/gstr1/export?period=2026-08&format=csv')
    expect(exp.status).toBe(422)
  })
})
