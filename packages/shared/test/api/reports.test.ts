import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { type RouteDef, routePermissions } from '../../src/api/common'
import {
  AGEING_BUCKETS,
  B2CL_INVOICE_THRESHOLD_PAISE,
  CompositionSummarySchema,
  CustomerOutstandingQuerySchema,
  CustomerOutstandingResponseSchema,
  DashboardQuerySchema,
  DashboardSchema,
  GSTR1_PORTAL_SCHEMA_VERSION,
  GSTR1_SECTIONS,
  Gstr1ExportQuerySchema,
  Gstr1PortalJsonSchema,
  Gstr1ReportSchema,
  Gstr1ResponseSchema,
  Gstr3bReportSchema,
  Gstr3bResponseSchema,
  GstPeriodQuerySchema,
  H1RegisterQuerySchema,
  H1RegisterResponseSchema,
  HsnSummaryQuerySchema,
  ItemSalesQuerySchema,
  ItemSalesResponseSchema,
  REPORTS,
  REPORTS_BY_KEY,
  REPORT_GROUPS,
  REPORT_KEYS,
  ReportGroupSchema,
  SalesSummaryQuerySchema,
  SalesSummaryResponseSchema,
  type Gstr1Report,
  type TaxHeads,
  ageingBucket,
  avgBillPaise,
  buildGstr1PortalJson,
  changeBp,
  compositionTax,
  getReportDef,
  gstPortalDate,
  gstQuarterOf,
  gstQueryRange,
  gstRateFromBp,
  gstr1Csv,
  gstr1ExportFilename,
  gstr1SectionRows,
  gstr3bPayment,
  overdueBucket,
  paymentMixKey,
  reportCellPath,
  reportColumns,
  reportCsv,
  reportCsvFilename,
  reportDatePresetRange,
  reportRangeIssue,
  reportsRoutes,
  rupeesFromPaise,
  shareBp,
  splitDocumentNumber,
  utiliseItc,
} from '../../src/api/reports'
import { addDays } from '../../src/fy'
import { makeGstin } from '../../src/gst'
import { newId } from '../../src/ids'

const id = () => newId()
const NOW = '2026-10-20T21:30:00+05:30'
const page = (total: number) => ({ limit: 100, offset: 0, total })
const meta = (report: string) => ({
  report,
  from: '2026-10-01',
  to: '2026-10-20',
  as_of: null,
  store_id: null,
  store_name: null,
  group_by: null,
  generated_at: NOW,
  notes: [],
})

const issueKeys = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  r.success ? [] : (r.error?.issues.map((i) => i.message) ?? [])

const heads = (igst: number, cgst: number, sgst: number, cess = 0): TaxHeads => ({
  igst_paise: igst,
  cgst_paise: cgst,
  sgst_paise: sgst,
  cess_paise: cess,
})

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

describe('report helpers', () => {
  it('validates date ranges (max 366 days)', () => {
    expect(reportRangeIssue('2026-04-01', '2027-03-31')).toBeNull()
    expect(reportRangeIssue('2027-04-01', '2028-03-31')).toBeNull() // leap year: 366 days
    expect(reportRangeIssue('2026-04-01', '2027-04-02')).toBe('range_too_long')
    expect(reportRangeIssue('2026-10-02', '2026-10-01')).toBe('date_order')
    expect(
      issueKeys(ItemSalesQuerySchema.safeParse({ from: '2025-01-01', to: '2026-10-20' })),
    ).toContain('range_too_long')
    expect(
      issueKeys(ItemSalesQuerySchema.safeParse({ from: '2026-10-20', to: '2026-10-01' })),
    ).toContain('date_order')
    expect(ItemSalesQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false)
  })

  it('change, share and average', () => {
    expect(changeBp(12_000, 10_000)).toBe(2000)
    expect(changeBp(8000, 10_000)).toBe(-2000)
    expect(changeBp(-500, -1000)).toBe(5000)
    expect(changeBp(100, 0)).toBeNull()
    expect(changeBp(10 ** 13, 10 ** 12)).toBe(90_000)
    expect(shareBp(250, 1000)).toBe(2500)
    expect(shareBp(1, 0)).toBe(0)
    expect(avgBillPaise(10_001, 2)).toBe(5001)
    expect(avgBillPaise(500, 0)).toBe(0)
    expect(paymentMixKey('cash')).toBe('cash')
    expect(paymentMixKey('cheque')).toBe('other')
    expect(paymentMixKey('store_credit')).toBe('other')
  })

  it('date presets incl. financial-year quarters', () => {
    const t = '2026-10-20'
    expect(reportDatePresetRange('today', t)).toEqual({ from: t, to: t })
    expect(reportDatePresetRange('yesterday', t)).toEqual({ from: '2026-10-19', to: '2026-10-19' })
    expect(reportDatePresetRange('last_7_days', t)).toEqual({ from: '2026-10-14', to: t })
    expect(reportDatePresetRange('last_30_days', t)).toEqual({ from: '2026-09-21', to: t })
    expect(reportDatePresetRange('this_month', t)).toEqual({ from: '2026-10-01', to: t })
    expect(reportDatePresetRange('last_month', t)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(reportDatePresetRange('this_quarter', t)).toEqual({ from: '2026-10-01', to: t })
    expect(reportDatePresetRange('last_quarter', t)).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    })
    expect(reportDatePresetRange('this_fy', t)).toEqual({ from: '2026-04-01', to: t })
    expect(reportDatePresetRange('last_fy', t)).toEqual({ from: '2025-04-01', to: '2026-03-31' })
    const feb = '2026-02-15'
    expect(reportDatePresetRange('this_fy', feb)).toEqual({ from: '2025-04-01', to: feb })
    expect(reportDatePresetRange('this_quarter', feb)).toEqual({ from: '2026-01-01', to: feb })
    expect(reportDatePresetRange('last_quarter', feb)).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    })
    expect(reportDatePresetRange('last_month', '2026-03-31')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    })
    // January financial year
    expect(reportDatePresetRange('this_fy', t, 1)).toEqual({ from: '2026-01-01', to: t })
  })

  it('ageing buckets', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(ageingBucket)).toEqual([
      '0_30',
      '0_30',
      '31_60',
      '31_60',
      '61_90',
      '61_90',
      '90_plus',
      '90_plus',
    ])
    expect(ageingBucket(-3)).toBe('0_30')
    expect(overdueBucket(0)).toBe('not_due')
    expect(overdueBucket(-10)).toBe('not_due')
    expect(overdueBucket(45)).toBe('31_60')
    expect(AGEING_BUCKETS).toHaveLength(4)
  })

  it('GST formatting helpers', () => {
    expect(gstRateFromBp(1800)).toBe(18)
    expect(gstRateFromBp(25)).toBe(0.25)
    expect(gstRateFromBp(150)).toBe(1.5)
    expect(rupeesFromPaise(123_456_789)).toBe(1_234_567.89)
    expect(rupeesFromPaise(-50)).toBe(-0.5)
    expect(gstPortalDate('2026-10-05')).toBe('05-10-2026')
    expect(splitDocumentNumber('S1-A/2627/00042')).toEqual({ prefix: 'S1-A/2627/', seq: 42 })
    expect(splitDocumentNumber('CNS1/2627/7')).toEqual({ prefix: 'CNS1/2627/', seq: 7 })
    expect(splitDocumentNumber('MANUAL')).toEqual({ prefix: 'MANUAL', seq: null })
    expect(gstQuarterOf('2026-04')).toBe('Q1')
    expect(gstQuarterOf('2026-09')).toBe('Q2')
    expect(gstQuarterOf('2026-12')).toBe('Q3')
    expect(gstQuarterOf('2027-03')).toBe('Q4')
    expect(compositionTax(1_000_001)).toEqual({ cgst_paise: 5000, sgst_paise: 5000 })
    expect(compositionTax(1_000_101)).toEqual({ cgst_paise: 5001, sgst_paise: 5000 })
    expect(gstQueryRange({ period: '2026-02' })).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(gstQueryRange({ from: '2026-10-01', to: '2026-10-15' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-15',
    })
    expect(() => gstQueryRange({})).toThrow()
    expect(gstr1ExportFilename('33ABCDE1234F1Z5', '2026-10', 'json')).toBe(
      'GSTR1_33ABCDE1234F1Z5_102026.json',
    )
    expect(gstr1ExportFilename('33ABCDE1234F1Z5', '2026-10', 'csv', 'b2b')).toBe(
      'GSTR1_33ABCDE1234F1Z5_102026_b2b.csv',
    )
    expect(B2CL_INVOICE_THRESHOLD_PAISE).toBe(100_000 * 100)
  })

  it('GST query schemas', () => {
    expect(GstPeriodQuerySchema.parse({ period: '2026-10', gstin: '33abcde1234f1z5' }).gstin).toBe(
      '33ABCDE1234F1Z5',
    )
    expect(GstPeriodQuerySchema.safeParse({ period: '2026-13' }).success).toBe(false)
    expect(issueKeys(HsnSummaryQuerySchema.safeParse({}))).toContain('period_or_range_required')
    expect(HsnSummaryQuerySchema.safeParse({ period: '2026-10' }).success).toBe(true)
    expect(
      issueKeys(Gstr1ExportQuerySchema.safeParse({ period: '2026-10', section: 'b2b' })),
    ).toContain('section_csv_only')
    expect(
      Gstr1ExportQuerySchema.parse({ period: '2026-10', format: 'csv', section: 'hsn_b2c' })
        .section,
    ).toBe('hsn_b2c')
    expect(
      H1RegisterQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31', schedule: ['H1', 'X'] })
        .schedule,
    ).toEqual(['H1', 'X'])
    expect(DashboardQuerySchema.parse({ store_id: 'all' }).store_id).toBe('all')
    const q = SalesSummaryQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31', limit: '5000' })
    expect(q).toMatchObject({
      group_by: 'day',
      limit: 5000,
      format: 'json',
      sort: { field: 'group', direction: 'asc' },
    })
    expect(
      SalesSummaryQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31', limit: '5001' })
        .success,
    ).toBe(false)
    expect(
      CustomerOutstandingQuerySchema.parse({ overdue_only: 'yes', bucket: '61_90' }),
    ).toMatchObject({
      overdue_only: true,
      bucket: '61_90',
    })
  })
})

describe('ITC utilisation (GSTR-3B 6.1)', () => {
  it('IGST credit pays IGST then the CGST / SGST shortfalls', () => {
    const u = utiliseItc(heads(1000, 500, 500), heads(1500, 0, 200))
    expect(u.used.igst).toEqual({ igst: 1000, cgst: 500, sgst: 0, cess: 0 })
    expect(u.used.sgst.sgst).toBe(200)
    expect(u.cash).toEqual(heads(0, 0, 300))
    expect(u.balance).toEqual(heads(0, 0, 0))
  })
  it('CGST and SGST credit never cross; both may pay IGST', () => {
    const u = utiliseItc(heads(100, 1000, 1000), heads(0, 1500, 200))
    expect(u.used.cgst).toEqual({ igst: 100, cgst: 1000, sgst: 0, cess: 0 })
    expect(u.cash).toEqual(heads(0, 0, 800))
    expect(u.balance).toEqual(heads(0, 400, 0))
  })
  it('IGST credit is used up before CGST / SGST credit (rule 88A)', () => {
    const u = utiliseItc(heads(0, 100, 100), heads(500, 100, 100))
    expect(u.used.igst).toEqual({ igst: 0, cgst: 100, sgst: 100, cess: 0 })
    expect(u.cash).toEqual(heads(0, 0, 0))
    expect(u.balance).toEqual(heads(300, 100, 100))
  })
  it('cess only against cess; negatives count as zero', () => {
    const u = utiliseItc(heads(0, 0, 0, 300), heads(-50, 0, 0, 100))
    expect(u.cash).toEqual(heads(0, 0, 0, 200))
    expect(u.balance.igst_paise).toBe(0)
  })
  it('payment rows add reverse charge as cash', () => {
    const p = gstr3bPayment(heads(0, 900, 900), heads(0, 50, 50), heads(0, 400, 1000))
    const cgst = p.rows.find((r) => r.head === 'cgst')!
    expect(cgst).toMatchObject({ payable_paise: 900, paid_cash_paise: 500, rcm_payable_paise: 50 })
    expect(cgst.paid_itc.cgst_paise).toBe(400)
    expect(p.rows.find((r) => r.head === 'sgst')!.paid_cash_paise).toBe(0)
    expect(p.itc_balance.sgst_paise).toBe(100)
    expect(p.cash_total_paise).toBe(500 + 50 + 50)
  })
})

// ---------------------------------------------------------------------------------------------
// GSTR-1 builders
// ---------------------------------------------------------------------------------------------

const GSTIN = makeGstin('33', 'ABCDE1234F')
const CTIN = makeGstin('33', 'AAACR5055K')

const item = (rate_bp: number, taxable: number, inter: boolean) => {
  const tax = Math.round((taxable * rate_bp) / 10_000)
  return {
    rate_bp,
    taxable_paise: taxable,
    igst_paise: inter ? tax : 0,
    cgst_paise: inter ? 0 : tax - Math.floor(tax / 2),
    sgst_paise: inter ? 0 : Math.floor(tax / 2),
    cess_paise: 0,
  }
}

const gstr1: Gstr1Report = Gstr1ReportSchema.parse({
  kind: 'gstr1',
  period: '2026-10',
  fp: '102026',
  gstin: GSTIN,
  legal_name: 'Murugan Traders',
  trade_name: 'Sri Murugan Stores',
  gstins: [{ gstin: GSTIN, state_code: '33', store_ids: [id()], store_names: ['Main'] }],
  store_ids: [id()],
  generated_at: NOW,
  summary: [
    {
      section: 'b2b',
      count: 1,
      value_paise: 1_180_000,
      taxable_paise: 1_000_000,
      igst_paise: 0,
      cgst_paise: 90_000,
      sgst_paise: 90_000,
      cess_paise: 0,
    },
  ],
  b2b: [
    {
      ctin: CTIN,
      receiver_name: 'Ravi Hotels',
      invoices: [
        {
          invoice_id: id(),
          number: 'S1/2627/00001',
          date: '2026-10-05',
          value_paise: 1_180_000,
          place_of_supply: '33',
          reverse_charge: false,
          invoice_type: 'R',
          customer_name: 'Ravi Hotels',
          items: [item(1800, 1_000_000, false)],
        },
      ],
    },
  ],
  b2cl: [
    {
      place_of_supply: '29',
      invoices: [
        {
          invoice_id: id(),
          number: 'S1/2627/00002',
          date: '2026-10-06',
          value_paise: 11_800_000,
          place_of_supply: '29',
          reverse_charge: false,
          invoice_type: 'R',
          customer_name: null,
          items: [item(1800, 10_000_000, true)],
        },
      ],
    },
  ],
  b2cs: [
    {
      supply_type: 'INTRA',
      place_of_supply: '33',
      type: 'OE',
      ...item(500, 200_000, false),
    },
    {
      supply_type: 'INTER',
      place_of_supply: '32',
      type: 'OE',
      ...item(1800, 100_000, true),
    },
  ],
  cdnr: [
    {
      ctin: CTIN,
      receiver_name: 'Ravi Hotels',
      notes: [
        {
          credit_note_id: id(),
          number: 'CNS1/2627/00001',
          date: '2026-10-10',
          note_type: 'C',
          value_paise: 118_000,
          place_of_supply: '33',
          reverse_charge: false,
          original_invoice_number: 'S1/2627/00001',
          original_invoice_date: '2026-10-05',
          customer_name: 'Ravi Hotels',
          items: [item(1800, 100_000, false)],
        },
      ],
    },
  ],
  cdnur: [
    {
      type: 'B2CL',
      credit_note_id: id(),
      number: 'CNS1/2627/00002',
      date: '2026-10-12',
      note_type: 'C',
      value_paise: 1_180_000,
      place_of_supply: '29',
      reverse_charge: false,
      original_invoice_number: 'S1/2627/00002',
      original_invoice_date: '2026-10-06',
      customer_name: null,
      items: [item(1800, 1_000_000, true)],
    },
  ],
  nil: {
    inter_b2b: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
    intra_b2b: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
    inter_b2c: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
    intra_b2c: { nil_rated_paise: 0, exempt_paise: 50_000, non_gst_paise: 0 },
  },
  hsn: {
    b2b: [
      {
        hsn_code: '1006',
        description: 'Rice, not in pre-packaged and labelled form',
        uqc: 'KGS',
        qty_milli: 25_500,
        rate_bp: 500,
        taxable_paise: 200_000,
        igst_paise: 0,
        cgst_paise: 5000,
        sgst_paise: 5000,
        cess_paise: 0,
        total_value_paise: 210_000,
      },
    ],
    b2c: [
      {
        hsn_code: null,
        description: 'Ad-hoc item',
        uqc: 'NOS',
        qty_milli: 1000,
        rate_bp: 1800,
        taxable_paise: 100,
        igst_paise: 0,
        cgst_paise: 9,
        sgst_paise: 9,
        cess_paise: 0,
        total_value_paise: 118,
      },
    ],
  },
  doc_issue: [
    {
      doc_num: 1,
      doc_type: 'Invoices for outward supply',
      series: [
        {
          prefix: 'S1/2627/',
          from: 'S1/2627/00001',
          to: 'S1/2627/00120',
          total: 120,
          cancelled: 2,
          net_issued: 118,
        },
      ],
    },
    { doc_num: 5, doc_type: 'Credit Note', series: [] },
  ],
  warnings: [
    {
      code: 'missing_hsn',
      severity: 'warning',
      section: 'hsn_b2c',
      ref_type: 'product',
      ref_id: id(),
      label: 'Ad-hoc item',
      path: null,
      details: { rate_bp: 1800 },
    },
  ],
})

describe('GSTR-1 export', () => {
  it('builds the offline-tool JSON in rupees', () => {
    const json = buildGstr1PortalJson(gstr1)
    expect(Gstr1PortalJsonSchema.parse(json)).toEqual(json)
    expect(json).toMatchObject({
      gstin: GSTIN,
      fp: '102026',
      version: GSTR1_PORTAL_SCHEMA_VERSION,
      hash: 'hash',
    })
    expect(json.b2b![0]!.inv[0]).toEqual({
      inum: 'S1/2627/00001',
      idt: '05-10-2026',
      val: 11_800,
      pos: '33',
      rchrg: 'N',
      inv_typ: 'R',
      itms: [{ num: 1, itm_det: { txval: 10_000, rt: 18, camt: 900, samt: 900, csamt: 0 } }],
    })
    expect(json.b2cl![0]!.inv[0]!.itms[0]!.itm_det).toEqual({
      txval: 100_000,
      rt: 18,
      iamt: 18_000,
      csamt: 0,
    })
    expect(json.b2cs).toEqual([
      { sply_ty: 'INTRA', pos: '33', typ: 'OE', txval: 2000, rt: 5, camt: 50, samt: 50, csamt: 0 },
      { sply_ty: 'INTER', pos: '32', typ: 'OE', txval: 1000, rt: 18, iamt: 180, csamt: 0 },
    ])
    expect(json.cdnr![0]!.nt[0]).toMatchObject({
      ntty: 'C',
      nt_num: 'CNS1/2627/00001',
      nt_dt: '10-10-2026',
      val: 1180,
    })
    expect(json.cdnur![0]).toMatchObject({ typ: 'B2CL', pos: '29', val: 11_800 })
    expect(json.nil).toEqual({
      inv: [{ sply_ty: 'INTRAB2C', expt_amt: 500, nil_amt: 0, ngsup_amt: 0 }],
    })
    expect(json.hsn).toEqual({
      hsn_b2b: [
        {
          num: 1,
          hsn_sc: '1006',
          desc: 'Rice, not in pre-packaged and labelled form'.slice(0, 30),
          uqc: 'KGS',
          qty: 25.5,
          rt: 5,
          txval: 2000,
          iamt: 0,
          camt: 50,
          samt: 50,
          csamt: 0,
        },
      ],
    })
    expect(json.doc_issue).toEqual({
      doc_det: [
        {
          doc_num: 1,
          doc_typ: 'Invoices for outward supply',
          docs: [
            {
              num: 1,
              from: 'S1/2627/00001',
              to: 'S1/2627/00120',
              totnum: 120,
              cancel: 2,
              net_issue: 118,
            },
          ],
        },
      ],
    })
  })

  it('omits empty sections', () => {
    const empty = buildGstr1PortalJson({
      ...gstr1,
      b2b: [],
      b2cl: [],
      b2cs: [],
      cdnr: [],
      cdnur: [],
      nil: { ...gstr1.nil, intra_b2c: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 } },
      hsn: { b2b: [], b2c: [] },
      doc_issue: [],
    })
    expect(Object.keys(empty).sort()).toEqual(['fp', 'gstin', 'hash', 'version'])
  })

  it('CSV sections use the offline-tool columns', () => {
    const b2b = gstr1SectionRows(gstr1, 'b2b')
    expect(b2b[0]![0]).toBe('GSTIN/UIN of Recipient')
    expect(b2b[1]).toEqual([
      CTIN,
      'Ravi Hotels',
      'S1/2627/00001',
      '05-10-2026',
      '11800.00',
      '33-Tamil Nadu',
      'N',
      'Regular B2B',
      '18',
      '10000.00',
      '0.00',
      '900.00',
      '900.00',
      '0.00',
    ])
    expect(gstr1SectionRows(gstr1, 'doc_issue')[1]).toEqual([
      'Invoices for outward supply',
      'S1/2627/00001',
      'S1/2627/00120',
      120,
      2,
    ])
    for (const s of GSTR1_SECTIONS)
      expect(gstr1SectionRows(gstr1, s).length).toBeGreaterThanOrEqual(1)
    const all = gstr1Csv(gstr1)
    for (const s of GSTR1_SECTIONS) expect(all).toContain(`# ${s}`)
    expect(gstr1Csv(gstr1, 'b2cs').trimEnd().split('\r\n')).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------------------------
// REPORTS catalogue consistency
// ---------------------------------------------------------------------------------------------

type AnyObject = z.ZodObject<Record<string, z.ZodType>>

function responseParts(route: { response?: z.ZodType }) {
  const shape = (route.response as AnyObject).shape
  const data = shape.data as unknown as z.ZodArray<AnyObject>
  return {
    row: Object.keys(data.element.shape),
    totals: Object.keys((shape.totals as unknown as AnyObject).shape),
  }
}

const BASE_QUERY = { from: '2026-10-01', to: '2026-10-31' }

describe('REPORTS catalogue', () => {
  it('covers every report key once, in known groups', () => {
    expect(REPORTS.map((r) => r.key).sort()).toEqual([...REPORT_KEYS].sort())
    for (const r of REPORTS) {
      expect(ReportGroupSchema.safeParse(r.group).success).toBe(true)
      expect(getReportDef(r.key)).toBe(r)
      expect(REPORTS_BY_KEY[r.key]).toBe(r)
      expect(r.title_key).toBe(`reports:titles.${r.key.replaceAll('-', '_')}`)
    }
    expect(getReportDef('nope')).toBeUndefined()
    expect(new Set(REPORT_GROUPS.map((g) => g.key)).size).toBe(REPORT_GROUPS.length)
  })

  it.each(REPORTS.map((r) => [r.key, r] as const))('%s matches its route schemas', (_k, r) => {
    const route: RouteDef = reportsRoutes[r.route]
    expect(route, r.route).toBeDefined()
    expect(routePermissions(route)).toEqual([r.permission])
    expect(route.feature).toBe(r.feature)
    const { row, totals } = responseParts(route)
    const query = route.query as unknown as AnyObject
    const queryKeys = Object.keys(query.shape)
    for (const c of r.columns) {
      expect(row, `${r.key}.${c.key}`).toContain(c.key)
      if (c.total) expect(totals, `${r.key} totals.${c.key}`).toContain(c.key)
      if (c.unit_field) expect(row).toContain(c.unit_field)
      if (c.pack_size_field) expect(row).toContain(c.pack_size_field)
      if (c.link) {
        expect(row).toContain(c.link.id_field)
        if (c.link.type_by) expect(row).toContain(c.link.type_by.field)
      }
      if (c.sort)
        expect(
          query.safeParse({ ...BASE_QUERY, sort: c.sort }).success,
          `${r.key} sort ${c.sort}`,
        ).toBe(true)
      if (c.group_by) {
        const groupFilter = r.filters.find((f) => f.key === 'group_by' || f.key === 'group')
        expect(groupFilter, `${r.key} has a group filter`).toBeDefined()
        const values = groupFilter!.options!.map((o) => o.value)
        for (const g of c.group_by) expect(values, `${r.key}.${c.key} group ${g}`).toContain(g)
      }
    }
    for (const k of r.row_key) expect(row).toContain(k)
    if (r.chart) {
      expect(row).toContain(r.chart.x)
      for (const s of r.chart.series) expect(row).toContain(s.key)
    }
    expect(query.safeParse({ ...BASE_QUERY, sort: r.default_sort }).success).toBe(true)
    for (const f of r.filters) {
      if (f.key === 'date_range') {
        expect(queryKeys).toEqual(expect.arrayContaining(['from', 'to']))
        continue
      }
      expect(queryKeys, `${r.key} filter ${f.key}`).toContain(f.key)
      for (const o of f.options ?? [])
        expect(
          query.safeParse({ ...BASE_QUERY, [f.key]: o.value }).success,
          `${r.key} ${f.key}=${o.value}`,
        ).toBe(true)
      if (f.default !== undefined)
        expect(
          query.safeParse({ ...BASE_QUERY, [f.key]: f.default }).success,
          `${r.key} ${f.key} default`,
        ).toBe(true)
    }
  })

  it('reportColumns honours group_by', () => {
    const def = REPORTS_BY_KEY['sales-summary']
    expect(reportColumns(def, 'payment_method').map((c) => c.key)).toEqual([
      'group_label',
      'payments_count',
      'collected_paise',
      'refunded_paise',
      'net_collected_paise',
    ])
    expect(reportColumns(def, 'day').map((c) => c.key)).toContain('net_sales_paise')
    expect(reportColumns(def, null).map((c) => c.key)).toEqual(['group_label'])
  })

  it('links cells to documents', () => {
    const register = REPORTS_BY_KEY['sales-register']
    const numberCol = register.columns.find((c) => c.key === 'number')!
    const docId = id()
    expect(reportCellPath(numberCol, { kind: 'credit_note', document_id: docId })).toBe(
      `/sales/returns/${docId}`,
    )
    expect(reportCellPath(numberCol, { kind: 'invoice', document_id: docId })).toBe(
      `/sales/invoices/${docId}`,
    )
    const purchase = REPORTS_BY_KEY['purchase-register'].columns.find((c) => c.key === 'number')!
    expect(reportCellPath(purchase, { kind: 'expense', document_id: docId })).toBe(
      `/accounting/expenses?id=${docId}`,
    )
    expect(reportCellPath(purchase, { kind: 'bill', document_id: null })).toBeNull()
  })

  it('writes CSV with English headers and a totals row', () => {
    const def = REPORTS_BY_KEY['customer-outstanding']
    const csv = reportCsv(
      def,
      [
        {
          customer_id: id(),
          name: '=Lakshmi',
          phone: '+919876543210',
          due_paise: 245_000,
          bucket_0_30_paise: 45_000,
          bucket_31_60_paise: 200_000,
          bucket_61_90_paise: 0,
          bucket_90_plus_paise: 0,
          unallocated_credit_paise: 0,
          balance_paise: 245_000,
          oldest_due_days: 45,
          last_payment_date: '2026-09-01',
          overdue_paise: 200_000,
        },
      ],
      {
        due_paise: 245_000,
        bucket_0_30_paise: 45_000,
        bucket_31_60_paise: 200_000,
        bucket_61_90_paise: 0,
        bucket_90_plus_paise: 0,
        unallocated_credit_paise: 0,
        balance_paise: 245_000,
        overdue_paise: 200_000,
      },
    )
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n')
    expect(lines[0]).toBe(
      'Customer,Phone,Due,0–30 days,31–60 days,61–90 days,Over 90 days,Advance / credit,Ledger balance,Oldest due (days),Last payment,Overdue',
    )
    expect(lines[1]).toBe(
      "'=Lakshmi,98765 43210,2450.00,450.00,2000.00,0.00,0.00,0.00,2450.00,45,2026-09-01,2000.00",
    )
    expect(lines[2]).toBe('Total,,2450.00,450.00,2000.00,0.00,0.00,0.00,2450.00,,,2000.00')
    expect(reportCsvFilename('item-sales', '2026-10-01', '2026-10-31')).toBe(
      'item-sales_2026-10-01_2026-10-31.csv',
    )
    expect(reportCsvFilename('stock-summary')).toBe('stock-summary.csv')
  })
})

// ---------------------------------------------------------------------------------------------
// Response fixtures
// ---------------------------------------------------------------------------------------------

describe('response schemas parse realistic fixtures', () => {
  const day = (date: string, net: number) => ({
    date,
    net_sales_paise: net,
    sales_paise: net + 1000,
    returns_paise: 1000,
    bills: 40,
    avg_bill_paise: Math.round((net + 1000) / 40),
    net_taxable_paise: Math.round(net / 1.05),
    gross_profit_paise: Math.round(net * 0.18),
    margin_bp: 1890,
  })

  it('dashboard', () => {
    const today = day('2026-10-20', 4_856_000)
    const yesterday = day('2026-10-19', 4_100_000)
    DashboardSchema.parse({
      date: '2026-10-20',
      store_id: null,
      generated_at: NOW,
      today,
      yesterday,
      change: {
        net_sales_bp: changeBp(today.net_sales_paise, yesterday.net_sales_paise),
        bills_bp: 0,
        avg_bill_bp: changeBp(today.avg_bill_paise, yesterday.avg_bill_paise),
        gross_profit_bp: changeBp(today.gross_profit_paise, yesterday.gross_profit_paise),
        margin_points_bp: 0,
      },
      trend: Array.from({ length: 30 }, (_, i) => ({
        date: addDays('2026-10-20', i - 29),
        net_sales_paise: 4_000_000 + i,
        gross_profit_paise: 700_000,
        bills: 38,
      })),
      payment_mix: [
        { key: 'cash', amount_paise: 2_130_000, count: 120, share_bp: 4377 },
        { key: 'upi', amount_paise: 1_986_000, count: 80, share_bp: 4081 },
        { key: 'card', amount_paise: 410_000, count: 6, share_bp: 843 },
        { key: 'credit', amount_paise: 330_000, count: 6, share_bp: 678 },
        { key: 'other', amount_paise: 10_000, count: 1, share_bp: 21 },
      ],
      top_items: {
        today: [
          {
            product_id: id(),
            name: 'Ponni rice 25 kg',
            name_ta: 'பொன்னி அரிசி 25 கிலோ',
            unit: 'BAG',
            pack_size: 1,
            qty_milli: 12_000,
            net_sales_paise: 1_740_000,
          },
        ],
        last_7_days: [],
      },
      receivables: {
        total_paise: 12_450_000,
        customers_with_due: 37,
        overdue_paise: 3_200_000,
        top_debtors: [
          {
            customer_id: id(),
            name: 'Lakshmi',
            name_ta: 'லட்சுமி',
            phone: '+919876543210',
            balance_paise: 245_000,
            oldest_due_days: 45,
            whatsapp_opt_in: true,
          },
        ],
      },
      payables: {
        total_paise: 8_000_000,
        suppliers_with_due: 5,
        overdue_paise: 0,
        due_next_7_days_paise: 1_200_000,
      },
      stock: {
        low_stock: 7,
        out_of_stock: 2,
        expiring: 4,
        expired: 1,
        expiring_value_paise: 342_000,
        expired_value_paise: 12_000,
        expiry_warning_days: 90,
      },
      shifts: {
        open_count: 1,
        open: [
          {
            shift_id: id(),
            register_id: id(),
            register_code: 'A',
            opened_by_name: 'Selvi',
            opened_at: NOW,
          },
        ],
      },
      upi: {
        pending_intents: 1,
        pending_paise: 45_000,
        unapplied_count: 2,
        unapplied_paise: 90_000,
      },
    })
  })

  it('sales reports', () => {
    const metrics = {
      bills: 212,
      gross_paise: 5_000_000,
      discount_paise: 44_000,
      taxable_paise: 4_600_000,
      tax_paise: 356_000,
      sales_paise: 4_956_000,
      returns_count: 2,
      returns_paise: 100_000,
      returns_taxable_paise: 95_000,
      net_sales_paise: 4_856_000,
      net_taxable_paise: 4_505_000,
      cost_paise: 3_700_000,
      gross_profit_paise: 805_000,
      margin_bp: 1787,
    }
    const payments = {
      payments_count: 200,
      collected_paise: 4_626_000,
      refunded_paise: 10_000,
      net_collected_paise: 4_616_000,
    }
    SalesSummaryResponseSchema.parse({
      data: [
        {
          group_key: '2026-10-20',
          group_label: '2026-10-20',
          group_label_ta: null,
          ...metrics,
          round_off_paise: -12,
          avg_bill_paise: 23_377,
          ...payments,
        },
      ],
      page: page(1),
      totals: { ...metrics, round_off_paise: -12, avg_bill_paise: 23_377, ...payments },
      meta: { ...meta('sales-summary'), group_by: 'day' },
    })
    ItemSalesResponseSchema.parse({
      data: [
        {
          product_id: null,
          sku: null,
          name: 'Ad-hoc items',
          name_ta: null,
          category_id: null,
          category_name: null,
          brand_id: null,
          brand_name: null,
          hsn_code: null,
          unit: 'PCS',
          pack_size: 1,
          qty_milli: 3000,
          free_qty_milli: 0,
          returned_qty_milli: 0,
          net_qty_milli: 3000,
          ...metrics,
          margin_bp: null,
        },
      ],
      page: page(1),
      totals: { products: 1, ...metrics },
      meta: meta('item-sales'),
    })
  })

  it('outstanding and pharmacy', () => {
    const ageing = {
      balance_paise: 245_000,
      due_paise: 245_000,
      not_due_paise: 0,
      bucket_0_30_paise: 45_000,
      bucket_31_60_paise: 200_000,
      bucket_61_90_paise: 0,
      bucket_90_plus_paise: 0,
      unallocated_credit_paise: 0,
      unreconciled_paise: 0,
      open_documents: 3,
      oldest_due_date: '2026-09-05',
      oldest_due_days: 45,
      last_payment_date: '2026-09-01',
    }
    CustomerOutstandingResponseSchema.parse({
      data: [
        {
          customer_id: id(),
          name: 'Lakshmi',
          name_ta: 'லட்சுமி',
          phone: '+919876543210',
          credit_limit_paise: null,
          credit_days: 30,
          overdue_paise: 200_000,
          whatsapp_opt_in: true,
          ...ageing,
        },
      ],
      page: page(1),
      totals: {
        parties: 1,
        balance_paise: 245_000,
        due_paise: 245_000,
        not_due_paise: 0,
        bucket_0_30_paise: 45_000,
        bucket_31_60_paise: 200_000,
        bucket_61_90_paise: 0,
        bucket_90_plus_paise: 0,
        unallocated_credit_paise: 0,
        overdue_paise: 200_000,
      },
      meta: { ...meta('customer-outstanding'), from: null, to: null, as_of: '2026-10-20' },
    })
    H1RegisterResponseSchema.parse({
      data: [
        {
          date: '2026-10-20',
          invoice_id: id(),
          invoice_number: 'S1-A/2627/00042',
          invoice_at: NOW,
          patient_name: 'Kumar',
          patient_age: '54',
          patient_address: 'Anna Nagar, Madurai',
          doctor_name: 'Dr. Priya',
          doctor_reg_no: 'TNMC 12345',
          product_id: id(),
          drug_name: 'Azithromycin 500',
          generic_name: 'Azithromycin',
          schedule: 'H1',
          batch_no: 'AZ2231',
          expiry_date: '2027-06-30',
          qty_milli: 3000,
          unit: 'TAB',
          pack_size: 3,
          prescription_file_id: null,
          dispensed_by_name: 'Selvi',
        },
      ],
      page: page(1),
      totals: { entries: 1, invoices: 1, missing_rx: 0 },
      meta: meta('h1-register'),
    })
  })

  it('GST responses (regular, composition, unregistered)', () => {
    expect(Gstr1ResponseSchema.parse(gstr1).kind).toBe('gstr1')
    const zero = { taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0 }
    const h = { igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0 }
    const gstr3b = Gstr3bReportSchema.parse({
      kind: 'gstr3b',
      period: '2026-10',
      fp: '102026',
      gstin: GSTIN,
      legal_name: null,
      trade_name: 'Sri Murugan Stores',
      gstins: [],
      store_ids: [],
      generated_at: NOW,
      outward: {
        taxable: {
          taxable_paise: 11_300_000,
          igst_paise: 1_818_000,
          cgst_paise: 95_000,
          sgst_paise: 95_000,
          cess_paise: 0,
        },
        zero_rated: zero,
        nil_exempt: { ...zero, taxable_paise: 50_000 },
        inward_rcm: zero,
        non_gst: zero,
      },
      inter_state_unregistered: [
        { place_of_supply: '29', taxable_paise: 9_000_000, igst_paise: 1_620_000 },
      ],
      itc: {
        import_goods: h,
        import_services: h,
        inward_rcm: h,
        isd: h,
        all_other: { ...h, cgst_paise: 40_000, sgst_paise: 40_000 },
        reversed_rules: h,
        reversed_others: h,
        net: { ...h, cgst_paise: 40_000, sgst_paise: 40_000 },
        ineligible_16_4: h,
        ineligible_pos: h,
      },
      exempt_inward: {
        composition_exempt_nil: { inter_paise: 0, intra_paise: 0 },
        non_gst: { inter_paise: 0, intra_paise: 0 },
      },
      payment: gstr3bPayment(
        heads(1_818_000, 95_000, 95_000),
        heads(0, 0, 0),
        heads(0, 40_000, 40_000),
      ),
      sources: {
        sales_invoices: 120,
        credit_notes: 2,
        purchase_bills: 14,
        debit_notes: 0,
        expenses: 3,
      },
      warnings: [],
    })
    expect(Gstr3bResponseSchema.parse(gstr3b).kind).toBe('gstr3b')
    const composition = CompositionSummarySchema.parse({
      kind: 'composition',
      period: '2026-10',
      fp: '102026',
      gstin: GSTIN,
      legal_name: null,
      trade_name: 'Sri Murugan Stores',
      gstins: [],
      store_ids: [],
      generated_at: NOW,
      fy: '2026-27',
      rate_bp: 100,
      quarter: 'Q3',
      quarters: [
        {
          quarter: 'Q3',
          from: '2026-10-01',
          to: '2026-12-31',
          bills: 900,
          outward_turnover_paise: 120_000_000,
          taxable_turnover_paise: 100_000_000,
          ...compositionTax(100_000_000),
          inward_rcm_taxable_paise: 0,
          inward_rcm_tax_paise: 0,
        },
      ],
      warnings: [],
    })
    expect(Gstr1ResponseSchema.parse(composition).kind).toBe('composition')
    expect(Gstr3bResponseSchema.parse({ kind: 'unregistered', period: '2026-10' }).kind).toBe(
      'unregistered',
    )
  })
})
