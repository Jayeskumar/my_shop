/**
 * Contract-shaped fixtures of the reports screens (a Madurai general store), validated against the
 * shared schemas in fixtures.test.ts so MSW answers exactly what the server must answer. Imports
 * only @kadai/shared so the Playwright screenshot mocks can reuse them.
 */
import type {
  CompositionSummary,
  CustomerOutstandingResponse,
  Dashboard,
  DashboardTopItem,
  ExpiryResponse,
  Gstr1Report,
  Gstr3bReport,
  ItemSalesResponse,
  ReportKey,
  ReportMeta,
  SalesSummaryResponse,
} from '@kadai/shared/api/reports'
import { gstr3bPayment } from '@kadai/shared/api/reports'
import { addDays } from '@kadai/shared/fy'

export const TODAY = '2026-10-21'
export const GENERATED_AT = '2026-10-21T05:00:00.000Z'

const id = (n: number): string => `0192f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`

export const FIX_IDS = {
  store: '0192f0a0-0000-7000-8000-000000000301',
  register: '0192f0a0-0000-7000-8000-000000000401',
  rice: id(1001),
  oil: id(1002),
  sambar: id(1003),
  milk: id(1004),
  dal: id(1005),
  sugar: id(1006),
  soap: id(1007),
  salt: id(1008),
  lakshmi: id(2001),
  selvam: id(2002),
  kavitha: id(2003),
  ramesh: id(2004),
  anbu: id(2005),
  shift: id(3001),
  invoice1: id(4001),
  invoice2: id(4002),
  invoice3: id(4003),
  note1: id(4101),
  batch1: id(5001),
  batch2: id(5002),
  batch3: id(5003),
  supplier: id(6001),
} as const

const day = (
  date: string,
  sales: number,
  bills: number,
  profit: number,
  returns = 0,
): Dashboard['today'] => {
  const net = sales - returns
  const taxable = Math.round(net / 1.05)
  return {
    date,
    net_sales_paise: net,
    sales_paise: sales,
    returns_paise: returns,
    bills,
    avg_bill_paise: bills ? Math.round(sales / bills) : 0,
    net_taxable_paise: taxable,
    gross_profit_paise: profit,
    margin_bp: taxable ? Math.round((profit * 10_000) / taxable) : null,
  }
}

/** 30 days of trend ending today: weekly rhythm (Sundays busier) with a festival bump. */
function trend(): Dashboard['trend'] {
  const out: Dashboard['trend'] = []
  for (let i = 29; i >= 0; i--) {
    const date = addDays(TODAY, -i)
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
    const base = 3_200_000 + ((i * 7919) % 900_000)
    const sunday = weekday === 0 ? 1_400_000 : 0
    const festival = i >= 1 && i <= 3 ? 1_800_000 : 0
    const sales = base + sunday + festival
    out.push({
      date,
      net_sales_paise: sales,
      gross_profit_paise: Math.round(sales * 0.16),
      bills: Math.round(sales / 42_000),
    })
  }
  return out
}

const top = (
  product_id: string,
  name: string,
  name_ta: string,
  unit: string,
  qty_milli: number,
  net_sales_paise: number,
): DashboardTopItem => ({
  product_id,
  name,
  name_ta,
  unit,
  pack_size: 1,
  qty_milli,
  net_sales_paise,
})

export function dashboardFixture(overrides: Partial<Dashboard> = {}): Dashboard {
  const today = day(TODAY, 4_586_550, 112, 612_480, 32_000)
  const yesterday = day(addDays(TODAY, -1), 5_120_300, 128, 702_150)
  return {
    date: TODAY,
    store_id: null,
    generated_at: GENERATED_AT,
    today,
    yesterday,
    change: {
      net_sales_bp: -1104,
      bills_bp: -1250,
      avg_bill_bp: 191,
      gross_profit_bp: -1277,
      margin_points_bp: -48,
    },
    trend: trend(),
    payment_mix: [
      { key: 'cash', amount_paise: 1_934_250, count: 64, share_bp: 4217 },
      { key: 'upi', amount_paise: 1_812_300, count: 38, share_bp: 3951 },
      { key: 'card', amount_paise: 310_000, count: 4, share_bp: 676 },
      { key: 'credit', amount_paise: 530_000, count: 6, share_bp: 1156 },
      { key: 'other', amount_paise: 0, count: 0, share_bp: 0 },
    ],
    top_items: {
      today: [
        top(FIX_IDS.rice, 'Ponni Rice 25 kg', 'பொன்னி அரிசி 25 கிலோ', 'PCS', 9_000, 1_215_000),
        top(
          FIX_IDS.oil,
          'Gold Winner Sunflower Oil 1 L',
          'கோல்ட் வின்னர் சூரியகாந்தி எண்ணெய் 1 லி',
          'PCS',
          24_000,
          446_400,
        ),
        top(FIX_IDS.dal, 'Toor Dal', 'துவரம் பருப்பு', 'KG', 18_500, 296_000),
        top(FIX_IDS.milk, 'Aavin Milk 500 ml', 'ஆவின் பால் 500 மிலி', 'PCS', 96_000, 211_200),
        top(
          FIX_IDS.sambar,
          'Aachi Sambar Powder 200 g',
          'ஆச்சி சாம்பார் பொடி 200 கி',
          'PCS',
          21_000,
          136_500,
        ),
        top(FIX_IDS.sugar, 'Sugar', 'சர்க்கரை', 'KG', 22_000, 99_000),
      ],
      last_7_days: [
        top(FIX_IDS.rice, 'Ponni Rice 25 kg', 'பொன்னி அரிசி 25 கிலோ', 'PCS', 61_000, 8_235_000),
        top(
          FIX_IDS.oil,
          'Gold Winner Sunflower Oil 1 L',
          'கோல்ட் வின்னர் சூரியகாந்தி எண்ணெய் 1 லி',
          'PCS',
          152_000,
          2_827_200,
        ),
        top(FIX_IDS.dal, 'Toor Dal', 'துவரம் பருப்பு', 'KG', 120_000, 1_920_000),
        top(FIX_IDS.milk, 'Aavin Milk 500 ml', 'ஆவின் பால் 500 மிலி', 'PCS', 640_000, 1_408_000),
      ],
    },
    receivables: {
      total_paise: 4_862_000,
      customers_with_due: 23,
      overdue_paise: 1_745_000,
      top_debtors: [
        {
          customer_id: FIX_IDS.lakshmi,
          name: 'Lakshmi Stores',
          name_ta: 'லட்சுமி ஸ்டோர்ஸ்',
          phone: '+919842012345',
          balance_paise: 1_250_000,
          oldest_due_days: 48,
          whatsapp_opt_in: true,
        },
        {
          customer_id: FIX_IDS.selvam,
          name: 'Selvam K',
          name_ta: 'செல்வம் க',
          phone: '+919790054321',
          balance_paise: 840_000,
          oldest_due_days: 21,
          whatsapp_opt_in: false,
        },
        {
          customer_id: FIX_IDS.kavitha,
          name: 'Kavitha R',
          name_ta: 'கவிதா ர',
          phone: '+919566011122',
          balance_paise: 512_500,
          oldest_due_days: 9,
          whatsapp_opt_in: true,
        },
        {
          customer_id: FIX_IDS.ramesh,
          name: 'Ramesh Tea Stall',
          name_ta: 'ரமேஷ் டீ கடை',
          phone: null,
          balance_paise: 365_000,
          oldest_due_days: 63,
          whatsapp_opt_in: false,
        },
        {
          customer_id: FIX_IDS.anbu,
          name: 'Anbu Mess',
          name_ta: 'அன்பு மெஸ்',
          phone: '+919443300987',
          balance_paise: 290_000,
          oldest_due_days: 5,
          whatsapp_opt_in: true,
        },
      ],
    },
    payables: {
      total_paise: 7_390_000,
      suppliers_with_due: 6,
      overdue_paise: 1_200_000,
      due_next_7_days_paise: 2_450_000,
    },
    stock: {
      low_stock: 14,
      out_of_stock: 3,
      expiring: 7,
      expired: 2,
      expiring_value_paise: 418_000,
      expired_value_paise: 96_500,
      expiry_warning_days: 30,
    },
    shifts: {
      open_count: 1,
      open: [
        {
          shift_id: FIX_IDS.shift,
          register_id: FIX_IDS.register,
          register_code: 'A',
          opened_by_name: 'Priya',
          opened_at: '2026-10-21T03:15:00.000Z',
        },
      ],
    },
    upi: {
      pending_intents: 1,
      pending_paise: 45_000,
      unapplied_count: 2,
      unapplied_paise: 128_000,
    },
    ...overrides,
  }
}

/** A day with no bills yet (morning, before opening). */
export function emptyDashboardFixture(): Dashboard {
  const zero = day(TODAY, 0, 0, 0)
  return dashboardFixture({
    today: zero,
    change: {
      net_sales_bp: -10_000,
      bills_bp: -10_000,
      avg_bill_bp: -10_000,
      gross_profit_bp: -10_000,
      margin_points_bp: null,
    },
    payment_mix: (['cash', 'upi', 'card', 'credit', 'other'] as const).map((key) => ({
      key,
      amount_paise: 0,
      count: 0,
      share_bp: 0,
    })),
    top_items: { today: [], last_7_days: [] },
    receivables: { total_paise: 0, customers_with_due: 0, overdue_paise: 0, top_debtors: [] },
  })
}

function meta(report: ReportKey, extra: Partial<ReportMeta> = {}): ReportMeta {
  return {
    report,
    from: '2026-10-01',
    to: TODAY,
    as_of: null,
    store_id: null,
    store_name: null,
    group_by: null,
    generated_at: GENERATED_AT,
    notes: [],
    ...extra,
  }
}

const salesMetrics = (sales: number, bills: number, returns = 0) => {
  const taxable = Math.round(sales / 1.05)
  const returnsTaxable = Math.round(returns / 1.05)
  const netTaxable = taxable - returnsTaxable
  const cost = Math.round(netTaxable * 0.84)
  return {
    bills,
    gross_paise: sales + Math.round(sales * 0.02),
    discount_paise: Math.round(sales * 0.02),
    taxable_paise: taxable,
    tax_paise: sales - taxable,
    sales_paise: sales,
    returns_count: returns ? 1 : 0,
    returns_paise: returns,
    returns_taxable_paise: returnsTaxable,
    net_sales_paise: sales - returns,
    net_taxable_paise: netTaxable,
    cost_paise: cost,
    gross_profit_paise: netTaxable - cost,
    margin_bp: netTaxable ? Math.round(((netTaxable - cost) * 10_000) / netTaxable) : null,
  }
}

export function salesSummaryFixture(): SalesSummaryResponse {
  const rows = Array.from({ length: 21 }, (_, i) => {
    const date = addDays('2026-10-01', i)
    const sales = 3_000_000 + ((i * 7919) % 1_500_000)
    const m = salesMetrics(sales, Math.round(sales / 41_000), i % 6 === 0 ? 25_000 : 0)
    return {
      group_key: date,
      group_label: `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`,
      group_label_ta: null,
      ...m,
      round_off_paise: 12,
      avg_bill_paise: Math.round(sales / m.bills),
      payments_count: m.bills,
      collected_paise: sales - 50_000,
      refunded_paise: 0,
      net_collected_paise: sales - 50_000,
    }
  })
  const sum = (k: keyof (typeof rows)[number]): number =>
    rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)
  const netTaxable = sum('net_taxable_paise')
  const profit = sum('gross_profit_paise')
  return {
    data: rows,
    page: { limit: 100, offset: 0, total: rows.length },
    totals: {
      bills: sum('bills'),
      gross_paise: sum('gross_paise'),
      discount_paise: sum('discount_paise'),
      taxable_paise: sum('taxable_paise'),
      tax_paise: sum('tax_paise'),
      sales_paise: sum('sales_paise'),
      returns_count: sum('returns_count'),
      returns_paise: sum('returns_paise'),
      returns_taxable_paise: sum('returns_taxable_paise'),
      net_sales_paise: sum('net_sales_paise'),
      net_taxable_paise: netTaxable,
      cost_paise: sum('cost_paise'),
      gross_profit_paise: profit,
      margin_bp: Math.round((profit * 10_000) / netTaxable),
      round_off_paise: sum('round_off_paise'),
      avg_bill_paise: Math.round(sum('sales_paise') / sum('bills')),
      payments_count: sum('payments_count'),
      collected_paise: sum('collected_paise'),
      refunded_paise: 0,
      net_collected_paise: sum('net_collected_paise'),
    },
    meta: meta('sales-summary', { group_by: 'day' }),
  }
}

export function itemSalesFixture(): ItemSalesResponse {
  const items = [
    [
      FIX_IDS.rice,
      'Ponni Rice 25 kg',
      'பொன்னி அரிசி 25 கிலோ',
      'Rice',
      'PCS',
      1,
      214_000,
      28_890_000,
    ],
    [
      FIX_IDS.oil,
      'Gold Winner Sunflower Oil 1 L',
      'கோல்ட் வின்னர் எண்ணெய் 1 லி',
      'Oil',
      'PCS',
      1,
      512_000,
      9_523_200,
    ],
    [FIX_IDS.dal, 'Toor Dal', 'துவரம் பருப்பு', 'Pulses', 'KG', 1, 405_500, 6_488_000],
    [
      FIX_IDS.milk,
      'Aavin Milk 500 ml',
      'ஆவின் பால் 500 மிலி',
      'Dairy',
      'PCS',
      1,
      2_210_000,
      4_862_000,
    ],
    [
      FIX_IDS.sambar,
      'Aachi Sambar Powder 200 g',
      'ஆச்சி சாம்பார் பொடி',
      'Masala',
      'PCS',
      1,
      380_000,
      2_470_000,
    ],
    [FIX_IDS.sugar, 'Sugar', 'சர்க்கரை', 'Sugar & salt', 'KG', 1, 498_250, 2_242_125],
    [
      FIX_IDS.soap,
      'Hamam Soap 100 g',
      'ஹமாம் சோப் 100 கி',
      'Personal care',
      'PCS',
      1,
      260_000,
      1_014_000,
    ],
    [
      FIX_IDS.salt,
      'Tata Salt 1 kg',
      'டாடா உப்பு 1 கிலோ',
      'Sugar & salt',
      'PCS',
      1,
      310_000,
      868_000,
    ],
  ] as const
  const rows = items.map(([product_id, name, name_ta, category, unit, pack, qty, sales]) => ({
    product_id,
    sku: null,
    name,
    name_ta,
    category_id: null,
    category_name: category,
    brand_id: null,
    brand_name: null,
    hsn_code: '1006',
    unit,
    pack_size: pack,
    qty_milli: qty,
    free_qty_milli: 0,
    returned_qty_milli: 0,
    net_qty_milli: qty,
    ...salesMetrics(sales, Math.round(qty / 2500)),
  }))
  const sum = (
    k:
      | 'bills'
      | 'gross_paise'
      | 'discount_paise'
      | 'taxable_paise'
      | 'tax_paise'
      | 'sales_paise'
      | 'returns_count'
      | 'returns_paise'
      | 'returns_taxable_paise'
      | 'net_sales_paise'
      | 'net_taxable_paise'
      | 'cost_paise'
      | 'gross_profit_paise',
  ) => rows.reduce((s, r) => s + r[k], 0)
  return {
    data: rows,
    page: { limit: 100, offset: 0, total: 186 },
    totals: {
      products: 186,
      bills: 2_412,
      gross_paise: sum('gross_paise'),
      discount_paise: sum('discount_paise'),
      taxable_paise: sum('taxable_paise'),
      tax_paise: sum('tax_paise'),
      sales_paise: sum('sales_paise'),
      returns_count: 0,
      returns_paise: 0,
      returns_taxable_paise: 0,
      net_sales_paise: sum('net_sales_paise'),
      net_taxable_paise: sum('net_taxable_paise'),
      cost_paise: sum('cost_paise'),
      gross_profit_paise: sum('gross_profit_paise'),
      margin_bp: Math.round((sum('gross_profit_paise') * 10_000) / sum('net_taxable_paise')),
    },
    meta: meta('item-sales', { notes: ['cost_estimated'] }),
  }
}

export function customerOutstandingFixture(): CustomerOutstandingResponse {
  const row = (
    customer_id: string,
    name: string,
    name_ta: string,
    phone: string | null,
    buckets: [number, number, number, number],
    oldest: number,
  ) => {
    const due = buckets.reduce((s, b) => s + b, 0)
    return {
      customer_id,
      name,
      name_ta,
      phone,
      credit_limit_paise: 2_000_000,
      credit_days: 30,
      overdue_paise: buckets[1] + buckets[2] + buckets[3],
      whatsapp_opt_in: true,
      balance_paise: due,
      due_paise: due,
      not_due_paise: 0,
      bucket_0_30_paise: buckets[0],
      bucket_31_60_paise: buckets[1],
      bucket_61_90_paise: buckets[2],
      bucket_90_plus_paise: buckets[3],
      unallocated_credit_paise: 0,
      unreconciled_paise: 0,
      open_documents: 4,
      oldest_due_date: addDays(TODAY, -oldest),
      oldest_due_days: oldest,
      last_payment_date: addDays(TODAY, -12),
    }
  }
  const rows = [
    row(
      FIX_IDS.lakshmi,
      'Lakshmi Stores',
      'லட்சுமி ஸ்டோர்ஸ்',
      '+919842012345',
      [500_000, 750_000, 0, 0],
      48,
    ),
    row(FIX_IDS.selvam, 'Selvam K', 'செல்வம் க', '+919790054321', [840_000, 0, 0, 0], 21),
    row(FIX_IDS.ramesh, 'Ramesh Tea Stall', 'ரமேஷ் டீ கடை', null, [0, 0, 365_000, 0], 63),
  ]
  const sum = (
    k:
      | 'due_paise'
      | 'bucket_0_30_paise'
      | 'bucket_31_60_paise'
      | 'bucket_61_90_paise'
      | 'bucket_90_plus_paise'
      | 'overdue_paise',
  ) => rows.reduce((s, r) => s + r[k], 0)
  return {
    data: rows,
    page: { limit: 100, offset: 0, total: rows.length },
    totals: {
      parties: rows.length,
      balance_paise: sum('due_paise'),
      due_paise: sum('due_paise'),
      not_due_paise: 0,
      bucket_0_30_paise: sum('bucket_0_30_paise'),
      bucket_31_60_paise: sum('bucket_31_60_paise'),
      bucket_61_90_paise: sum('bucket_61_90_paise'),
      bucket_90_plus_paise: sum('bucket_90_plus_paise'),
      unallocated_credit_paise: 0,
      overdue_paise: sum('overdue_paise'),
    },
    meta: meta('customer-outstanding', { from: null, to: null, as_of: TODAY }),
  }
}

export function expiryFixture(): ExpiryResponse {
  const row = (
    batch_id: string,
    batch_no: string,
    product_id: string,
    name: string,
    expiry: string,
    qty: number,
    cost: number,
  ) => {
    const days = Math.round(
      (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000,
    )
    return {
      batch_id,
      batch_no,
      product_id,
      sku: null,
      name,
      name_ta: null,
      category_name: 'Dairy',
      unit: 'PCS',
      pack_size: 1,
      store_id: FIX_IDS.store,
      store_name: 'Main store',
      expiry_date: expiry,
      days_to_expiry: days,
      status: days < 0 ? ('expired' as const) : ('expiring' as const),
      qty_milli: qty,
      value_cost_paise: cost,
      value_mrp_paise: Math.round(cost * 1.25),
      supplier_id: FIX_IDS.supplier,
      supplier_name: 'Madurai Agencies',
    }
  }
  const rows = [
    row(FIX_IDS.batch1, 'AV2610A', FIX_IDS.milk, 'Aavin Curd 400 g', '2026-10-19', 6_000, 21_000),
    row(FIX_IDS.batch2, 'BR1022', FIX_IDS.soap, 'Bread 400 g', '2026-10-24', 12_000, 42_000),
    row(FIX_IDS.batch3, 'GH0311', FIX_IDS.oil, 'Aavin Ghee 200 ml', '2026-11-12', 8_000, 104_000),
  ]
  return {
    data: rows,
    page: { limit: 100, offset: 0, total: rows.length },
    totals: {
      expired_count: 1,
      expired_value_cost_paise: 21_000,
      expiring_count: 2,
      expiring_value_cost_paise: 146_000,
      value_cost_paise: 167_000,
      value_mrp_paise: 208_750,
    },
    meta: meta('expiry', { from: null, to: null, as_of: TODAY }),
  }
}

const gstHeader = {
  period: '2026-09',
  fp: '092026',
  gstin: '33AAAPL1234C1ZV',
  legal_name: 'Murugan K',
  trade_name: 'Sri Murugan Stores',
  gstins: [
    {
      gstin: '33AAAPL1234C1ZV',
      state_code: '33',
      store_ids: [FIX_IDS.store],
      store_names: ['Main store'],
    },
  ],
  store_ids: [FIX_IDS.store],
  generated_at: GENERATED_AT,
}

export function gstr1Fixture(overrides: Partial<Gstr1Report> = {}): Gstr1Report {
  const item = (rate_bp: number, taxable: number, inter = false) => {
    const tax = Math.round((taxable * rate_bp) / 10_000)
    const half = Math.floor(tax / 2)
    return inter
      ? {
          rate_bp,
          taxable_paise: taxable,
          igst_paise: tax,
          cgst_paise: 0,
          sgst_paise: 0,
          cess_paise: 0,
        }
      : {
          rate_bp,
          taxable_paise: taxable,
          igst_paise: 0,
          cgst_paise: tax - half,
          sgst_paise: half,
          cess_paise: 0,
        }
  }
  const b2bItems1 = [item(500, 1_200_000), item(1800, 300_000)]
  const b2bItems2 = [item(500, 850_000)]
  const b2clItems = [item(1800, 11_500_000, true)]
  const noteItems = [item(500, 100_000)]
  const total = (
    items: { taxable_paise: number; igst_paise: number; cgst_paise: number; sgst_paise: number }[],
  ) => items.reduce((s, i) => s + i.taxable_paise + i.igst_paise + i.cgst_paise + i.sgst_paise, 0)
  const b2cs = [
    {
      supply_type: 'INTRA' as const,
      place_of_supply: '33',
      type: 'OE' as const,
      ...item(500, 61_250_000),
    },
    {
      supply_type: 'INTRA' as const,
      place_of_supply: '33',
      type: 'OE' as const,
      ...item(1200, 8_400_000),
    },
    {
      supply_type: 'INTRA' as const,
      place_of_supply: '33',
      type: 'OE' as const,
      ...item(1800, 12_700_000),
    },
  ]
  const sumRows = (
    rows: {
      taxable_paise: number
      igst_paise: number
      cgst_paise: number
      sgst_paise: number
      cess_paise: number
    }[],
  ) =>
    rows.reduce(
      (s, r) => ({
        taxable_paise: s.taxable_paise + r.taxable_paise,
        igst_paise: s.igst_paise + r.igst_paise,
        cgst_paise: s.cgst_paise + r.cgst_paise,
        sgst_paise: s.sgst_paise + r.sgst_paise,
        cess_paise: s.cess_paise + r.cess_paise,
      }),
      { taxable_paise: 0, igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0 },
    )
  const hsnB2c = [
    {
      hsn_code: '1006',
      description: 'Rice',
      uqc: 'KGS',
      qty_milli: 9_850_000,
      rate_bp: 500,
      ...sumRows([item(500, 41_000_000)]),
      total_value_paise: 43_050_000,
    },
    {
      hsn_code: '1512',
      description: 'Sunflower oil',
      uqc: 'LTR',
      qty_milli: 2_310_000,
      rate_bp: 500,
      ...sumRows([item(500, 20_250_000)]),
      total_value_paise: 21_262_500,
    },
    {
      hsn_code: '3401',
      description: 'Soap',
      uqc: 'NOS',
      qty_milli: 3_100_000,
      rate_bp: 1800,
      ...sumRows([item(1800, 12_700_000)]),
      total_value_paise: 14_986_000,
    },
    {
      hsn_code: null,
      description: 'Loose items',
      uqc: 'KGS',
      qty_milli: 410_000,
      rate_bp: 1200,
      ...sumRows([item(1200, 8_400_000)]),
      total_value_paise: 9_408_000,
    },
  ]
  const hsnB2b = [
    {
      hsn_code: '1006',
      description: 'Rice',
      uqc: 'KGS',
      qty_milli: 400_000,
      rate_bp: 500,
      ...sumRows([item(500, 2_050_000)]),
      total_value_paise: 2_152_500,
    },
  ]
  const sec = (
    section: Gstr1Report['summary'][number]['section'],
    count: number,
    value: number,
    rows: Parameters<typeof sumRows>[0],
  ) => ({
    section,
    count,
    value_paise: value,
    ...sumRows(rows),
  })
  return {
    kind: 'gstr1',
    ...gstHeader,
    summary: [
      sec('b2b', 2, total(b2bItems1) + total(b2bItems2), [...b2bItems1, ...b2bItems2]),
      sec('b2cl', 1, total(b2clItems), b2clItems),
      sec('b2cs', b2cs.length, 0, b2cs),
      sec('cdnr', 1, total(noteItems), noteItems),
      sec('cdnur', 0, 0, []),
      sec('nil', 1, 0, []),
      sec('hsn_b2b', hsnB2b.length, 0, hsnB2b),
      sec('hsn_b2c', hsnB2c.length, 0, hsnB2c),
      sec('doc_issue', 2, 0, []),
    ],
    b2b: [
      {
        ctin: '33ABCDE1234F1Z5',
        receiver_name: 'Lakshmi Stores',
        invoices: [
          {
            invoice_id: FIX_IDS.invoice1,
            number: 'S1/2627/00412',
            date: '2026-09-04',
            value_paise: total(b2bItems1),
            place_of_supply: '33',
            reverse_charge: false,
            invoice_type: 'R',
            customer_name: 'Lakshmi Stores',
            items: b2bItems1,
          },
          {
            invoice_id: FIX_IDS.invoice2,
            number: 'S1/2627/00498',
            date: '2026-09-18',
            value_paise: total(b2bItems2),
            place_of_supply: '33',
            reverse_charge: false,
            invoice_type: 'R',
            customer_name: 'Lakshmi Stores',
            items: b2bItems2,
          },
        ],
      },
    ],
    b2cl: [
      {
        place_of_supply: '32',
        invoices: [
          {
            invoice_id: FIX_IDS.invoice3,
            number: 'S1/2627/00455',
            date: '2026-09-11',
            value_paise: total(b2clItems),
            place_of_supply: '32',
            reverse_charge: false,
            invoice_type: 'R',
            customer_name: 'Kerala Traders',
            items: b2clItems,
          },
        ],
      },
    ],
    b2cs,
    cdnr: [
      {
        ctin: '33ABCDE1234F1Z5',
        receiver_name: 'Lakshmi Stores',
        notes: [
          {
            credit_note_id: FIX_IDS.note1,
            number: 'CN-S1/2627/0007',
            date: '2026-09-20',
            note_type: 'C',
            value_paise: total(noteItems),
            place_of_supply: '33',
            reverse_charge: false,
            original_invoice_number: 'S1/2627/00412',
            original_invoice_date: '2026-09-04',
            customer_name: 'Lakshmi Stores',
            items: noteItems,
          },
        ],
      },
    ],
    cdnur: [],
    nil: {
      inter_b2b: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
      intra_b2b: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
      inter_b2c: { nil_rated_paise: 0, exempt_paise: 0, non_gst_paise: 0 },
      intra_b2c: { nil_rated_paise: 0, exempt_paise: 3_650_000, non_gst_paise: 0 },
    },
    hsn: { b2b: hsnB2b, b2c: hsnB2c },
    doc_issue: [
      {
        doc_num: 1,
        doc_type: 'Invoices for outward supply',
        series: [
          {
            prefix: 'S1-A/2627/',
            from: 'S1-A/2627/03120',
            to: 'S1-A/2627/05480',
            total: 2361,
            cancelled: 4,
            net_issued: 2357,
          },
        ],
      },
      {
        doc_num: 5,
        doc_type: 'Credit Note',
        series: [
          {
            prefix: 'CN-S1/2627/',
            from: 'CN-S1/2627/0005',
            to: 'CN-S1/2627/0009',
            total: 5,
            cancelled: 0,
            net_issued: 5,
          },
        ],
      },
    ],
    warnings: [
      {
        code: 'invalid_customer_gstin',
        severity: 'error',
        section: 'b2b',
        ref_type: 'customer',
        ref_id: FIX_IDS.selvam,
        label: 'Selvam K',
        path: `/parties/customers/${FIX_IDS.selvam}`,
        details: { gstin: '33ABCDE1234F1Z6' },
      },
      {
        code: 'missing_hsn',
        severity: 'warning',
        section: 'hsn_b2c',
        ref_type: 'product',
        ref_id: FIX_IDS.sugar,
        label: 'Loose jaggery',
        path: `/catalog/products/${FIX_IDS.sugar}`,
        details: {},
      },
    ],
    ...overrides,
  }
}

export function gstr3bFixture(): Gstr3bReport {
  const heads = (igst: number, cgst: number, sgst: number) => ({
    igst_paise: igst,
    cgst_paise: cgst,
    sgst_paise: sgst,
    cess_paise: 0,
  })
  const zero = heads(0, 0, 0)
  const liability = heads(2_070_000, 3_154_000, 3_154_000)
  const itc = heads(310_000, 2_420_000, 2_420_000)
  return {
    kind: 'gstr3b',
    ...gstHeader,
    outward: {
      taxable: { taxable_paise: 96_150_000, ...liability },
      zero_rated: { taxable_paise: 0, ...zero },
      nil_exempt: { taxable_paise: 3_650_000, ...zero },
      inward_rcm: { taxable_paise: 0, ...zero },
      non_gst: { taxable_paise: 0, ...zero },
    },
    inter_state_unregistered: [
      { place_of_supply: '32', taxable_paise: 11_500_000, igst_paise: 2_070_000 },
    ],
    itc: {
      import_goods: zero,
      import_services: zero,
      inward_rcm: zero,
      isd: zero,
      all_other: heads(310_000, 2_480_000, 2_480_000),
      reversed_rules: heads(0, 60_000, 60_000),
      reversed_others: zero,
      net: itc,
      ineligible_16_4: zero,
      ineligible_pos: zero,
    },
    exempt_inward: {
      composition_exempt_nil: { inter_paise: 0, intra_paise: 1_250_000 },
      non_gst: { inter_paise: 0, intra_paise: 0 },
    },
    payment: gstr3bPayment(liability, zero, itc),
    sources: {
      sales_invoices: 2361,
      credit_notes: 5,
      purchase_bills: 48,
      debit_notes: 1,
      expenses: 9,
    },
    warnings: [],
  }
}

export function compositionFixture(): CompositionSummary {
  const q = (
    quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4',
    from: string,
    to: string,
    turnover: number,
    bills: number,
  ) => {
    const tax = Math.round(turnover / 100)
    const sgst = Math.floor(tax / 2)
    return {
      quarter,
      from,
      to,
      bills,
      outward_turnover_paise: turnover + 120_000,
      taxable_turnover_paise: turnover,
      cgst_paise: tax - sgst,
      sgst_paise: sgst,
      inward_rcm_taxable_paise: 0,
      inward_rcm_tax_paise: 0,
    }
  }
  return {
    kind: 'composition',
    ...gstHeader,
    fy: '2026-27',
    rate_bp: 100,
    quarter: 'Q2',
    quarters: [
      q('Q1', '2026-04-01', '2026-06-30', 182_500_000, 5_120),
      q('Q2', '2026-07-01', '2026-09-30', 201_300_000, 5_544),
      q('Q3', '2026-10-01', '2026-12-31', 64_200_000, 1_802),
      q('Q4', '2027-01-01', '2027-03-31', 0, 0),
    ],
    warnings: [],
  }
}
