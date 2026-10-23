import { describe, expect, it } from 'vitest'
import {
  BillReturnableResponseSchema,
  DebitNoteCreateSchema,
  DebitNoteDetailSchema,
  DebitNoteListQuerySchema,
  DebitNotePrefillQuerySchema,
  DebitNotePrefillSchema,
  DuplicateSupplierInvoiceDetailsSchema,
  PurchaseBillCreateSchema,
  PurchaseBillDetailSchema,
  PurchaseBillFromOrderSchema,
  PurchaseBillListQuerySchema,
  PurchaseBillListResponseSchema,
  PurchaseBillPostResultSchema,
  PurchaseBillPostSchema,
  PurchaseBillUpdateSchema,
  PurchaseOrderCreateSchema,
  PurchaseOrderDetailSchema,
  PurchaseOrderListQuerySchema,
  PurchaseOrderSendResultSchema,
  PurchaseOrderSendSchema,
  PurchaseOrderUpdateSchema,
  ReorderSuggestionsQuerySchema,
  ReorderSuggestionsSchema,
  averageDailySalesMilli,
  explainReorder,
  expiryFromMonthYear,
  forecastDemandMilli,
  formatPurchaseOrderText,
  marginBp,
  planStockSense,
  purchaseBillActions,
  purchaseBillTotals,
  purchaseLineWarnings,
  purchaseOrderActions,
  purchaseOrderStatusAfterReceipt,
  purchasesRoutes,
  salePriceExclTax,
  suggestedReorderQtyMilli,
} from '../../src/api/purchases'
import { routeUrl } from '../../src/api/common'
import { prorateReturnLine } from '../../src/api/sales'
import { newId } from '../../src/ids'

const id = () => newId()
const NOW = '2026-10-20T10:15:00+05:30'
const STORE = id()
const SUPPLIER = id()
const PRODUCT = id()

const supplier = {
  id: SUPPLIER,
  name: 'Sri Balaji Agencies',
  phone: '+919876500000',
  gstin: '33AAPFU0939F1Z2',
  state_code: '33',
  address: { city: 'Madurai' },
  drug_license_no: 'TN/MDU/20B/1234',
  balance_paise: 118_000,
  payment_terms_days: 30,
}
const product = {
  id: PRODUCT,
  name: 'Paracetamol 650 (15 tabs)',
  name_ta: null,
  sku: 'PCM650',
  unit: 'TAB',
  pack_size: 15,
  hsn_code: '30049099',
  track_batches: true,
}
const tax = { taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, cess_paise: 0 }

describe('purchase maths', () => {
  it('landed cost with other charges and free quantity', () => {
    const r = purchaseBillTotals({
      lines: [
        // 10 strips + 1 free at ₹20 / strip, 12%
        {
          unit_cost_paise: 2_000,
          qty_milli: 150_000,
          free_qty_milli: 15_000,
          pack_size: 15,
          gst_rate_bp: 1200,
        },
        { unit_cost_paise: 10_000, qty_milli: 3_000, gst_rate_bp: 1800 },
      ],
      is_interstate: false,
      other_charges_paise: 1_000,
    })
    // taxable 20000 + 30000; freight 1000 split 400 / 600
    expect(r.lines.map((l) => l.other_charges_alloc_paise)).toEqual([400, 600])
    // (20000 + 400) / 11 strips
    expect(r.lines[0]!.landed_unit_cost_paise).toBe(1_855)
    expect(r.lines[1]!.landed_unit_cost_paise).toBe(10_200)
    expect(r.total_paise).toBe(
      r.taxable_paise + r.tax_paise + r.other_charges_paise + r.round_off_paise,
    )
    expect(r.total_paise % 100).toBe(0)
  })
  it('non-ITC tax is capitalised; supplier round-off override', () => {
    const r = purchaseBillTotals({
      lines: [{ unit_cost_paise: 10_050, qty_milli: 1_000, gst_rate_bp: 1800 }],
      is_interstate: true,
      itc_eligible: false,
      round_off_paise: -9,
    })
    expect(r.igst_paise).toBe(1_809)
    expect(r.lines[0]!.landed_unit_cost_paise).toBe(11_859)
    expect(r.round_off_paise).toBe(-9)
    expect(r.total_paise).toBe(11_850)
    expect(() =>
      purchaseBillTotals({ lines: [], is_interstate: false, round_off_paise: 120 }),
    ).toThrow(RangeError)
  })
  it('expiry quick entry', () => {
    expect(expiryFromMonthYear('07/27')).toBe('2027-07-31')
    expect(expiryFromMonthYear('2/2028')).toBe('2028-02-29')
    expect(expiryFromMonthYear('12-26')).toBe('2026-12-31')
    expect(expiryFromMonthYear('13/27')).toBeNull()
    expect(expiryFromMonthYear('abc')).toBeNull()
  })
  it('margins', () => {
    expect(
      salePriceExclTax({ sale_price_paise: 11_200, price_includes_tax: true, gst_rate_bp: 1200 }),
    ).toBe(10_000)
    expect(
      marginBp({
        sale_price_paise: 11_200,
        price_includes_tax: true,
        gst_rate_bp: 1200,
        cost_paise: 8_000,
      }),
    ).toBe(2_000)
    expect(
      marginBp({
        sale_price_paise: 9_000,
        price_includes_tax: false,
        gst_rate_bp: 0,
        cost_paise: 10_000,
      }),
    ).toBe(-1_111)
    expect(
      marginBp({ sale_price_paise: 0, price_includes_tax: false, gst_rate_bp: 0, cost_paise: 1 }),
    ).toBeNull()
  })
  it('reorder maths', () => {
    expect(
      suggestedReorderQtyMilli({
        reorder_level_milli: 10_000,
        reorder_qty_milli: 24_000,
        stock_milli: 4_000,
      }),
    ).toBe(24_000)
    expect(
      suggestedReorderQtyMilli({
        reorder_level_milli: 20_000,
        reorder_qty_milli: 5_000,
        stock_milli: 2_000,
      }),
    ).toBe(38_000)
    expect(
      suggestedReorderQtyMilli({
        reorder_level_milli: 1_000,
        reorder_qty_milli: null,
        stock_milli: 5_000,
      }),
    ).toBe(0)
    expect(averageDailySalesMilli(45_000)).toBe(1_500)
    expect(averageDailySalesMilli(-5)).toBe(0)
    expect(() => averageDailySalesMilli(1, 0)).toThrow(RangeError)
  })
  it('StockSense forecast, shelf-life cap and no-history fallback', () => {
    const flat = Array.from({ length: 7 }, (_, i) => ({ weekday: i, sold_milli: 10_000 }))
    expect(
      forecastDemandMilli({
        days: flat,
        lead_time_days: 7,
        today_weekday: 0,
        weekday_adjusted: false,
      }),
    ).toEqual({ daily_milli: 10_000, demand_milli: 70_000, has_history: true })
    expect(
      forecastDemandMilli({
        days: [],
        lead_time_days: 7,
        today_weekday: 1,
        weekday_adjusted: true,
      }),
    ).toEqual({ daily_milli: 0, demand_milli: 0, has_history: false })

    const weekly = [
      { weekday: 0, sold_milli: 20_000 },
      { weekday: 1, sold_milli: 0 },
      { weekday: 2, sold_milli: 0 },
      { weekday: 3, sold_milli: 0 },
      { weekday: 4, sold_milli: 0 },
      { weekday: 5, sold_milli: 0 },
      { weekday: 6, sold_milli: 0 },
    ]
    const adjusted = forecastDemandMilli({
      days: weekly,
      lead_time_days: 7,
      today_weekday: 6,
      weekday_adjusted: true,
    })
    expect(adjusted.demand_milli).toBe(20_000)
    expect(adjusted.has_history).toBe(true)

    const base = {
      reorder_level_milli: 0,
      reorder_qty_milli: null,
      usable_stock_milli: 20_000,
      durable_stock_milli: 20_000,
      incoming_milli: 0,
      daily_milli: 10_000,
      demand_milli: 70_000,
      lead_time_days: 7,
      shelf_life_days: null as number | null,
      pack_size: 1,
      has_history: true,
      use_forecast: true,
    }
    const order = planStockSense(base)
    expect(order.suggested_qty_milli).toBe(50_000)
    expect(order.days_of_cover).toBe(2)
    expect(order.stockout_urgency_days).toBe(5)
    expect(order.priority).toBe('high')
    expect(order.reason).toBe('stockout')

    const capped = planStockSense({ ...base, shelf_life_days: 3 })
    expect(capped.suggested_qty_milli).toBe(30_000)
    expect(capped.capped_by_shelf_life).toBe(true)
    expect(capped.reason).toBe('shelf_life')
    expect(capped.priority).toBe('high')

    expect(
      planStockSense({
        ...base,
        daily_milli: 100,
        demand_milli: 700,
        usable_stock_milli: 0,
        durable_stock_milli: 0,
        shelf_life_days: 3,
      }).suggested_qty_milli,
    ).toBe(0)

    const fallback = planStockSense({
      ...base,
      has_history: false,
      daily_milli: 0,
      demand_milli: 0,
      usable_stock_milli: 4_000,
      durable_stock_milli: 4_000,
      incoming_milli: 1_000,
      reorder_level_milli: 10_000,
      reorder_qty_milli: 24_000,
    })
    expect(fallback.suggested_qty_milli).toBe(23_000)
    expect(fallback.reason).toBe('no_history')
    expect(fallback.priority).toBe('normal')

    expect(
      explainReorder({
        reason: 'stockout',
        window_days: 7,
        lead_time_days: 7,
        shelf_life_days: null,
        daily_milli: 10_000,
        usable_stock_milli: 20_000,
        urgency_days: 5,
        suggested_qty_milli: 50_000,
      }),
    ).toContain('Order 50')

    expect(
      explainReorder({
        reason: 'stockout',
        window_days: 7,
        lead_time_days: 7,
        shelf_life_days: null,
        daily_milli: 10_000,
        usable_stock_milli: 60_000,
        urgency_days: 1,
        suggested_qty_milli: 10_000,
      }),
    ).toContain('1 day before')

    expect(
      planStockSense({
        ...base,
        use_forecast: false,
        reorder_level_milli: 10_000,
        reorder_qty_milli: 24_000,
        usable_stock_milli: 4_000,
      }).suggested_qty_milli,
    ).toBe(24_000)
  })
  it('PO status and actions', () => {
    expect(
      purchaseOrderStatusAfterReceipt('sent', [{ qty_milli: 10, received_qty_milli: 0 }]),
    ).toBe('sent')
    expect(
      purchaseOrderStatusAfterReceipt('sent', [
        { qty_milli: 10, received_qty_milli: 10 },
        { qty_milli: 10, received_qty_milli: 4 },
      ]),
    ).toBe('partially_received')
    expect(
      purchaseOrderStatusAfterReceipt('partially_received', [
        { qty_milli: 10, received_qty_milli: 12 },
      ]),
    ).toBe('received')
    expect(
      purchaseOrderStatusAfterReceipt('received', [{ qty_milli: 10, received_qty_milli: 0 }]),
    ).toBe('sent')
    expect(
      purchaseOrderStatusAfterReceipt('closed', [{ qty_milli: 10, received_qty_milli: 10 }]),
    ).toBe('closed')
    expect(purchaseOrderActions('draft')).toMatchObject({ edit: true, delete: true, close: false })
    expect(purchaseOrderActions('partially_received')).toMatchObject({
      cancel: false,
      close: true,
      receive: true,
    })
    expect(purchaseBillActions('posted', { due_paise: 10, has_live_payments: true })).toMatchObject(
      {
        cancel: false,
        pay: true,
        edit: false,
      },
    )
  })
  it('line warnings', () => {
    const w = purchaseLineWarnings(
      {
        line_no: 1,
        product_id: PRODUCT,
        unit_cost_paise: 2_100,
        mrp_paise: 3_300,
        expiry_date: '2026-12-31',
        gst_rate_bp: 1200,
        landed_unit_cost_paise: 2_100,
        sale_price_paise: 2_000,
      },
      { last_cost_paise: 2_000, mrp_paise: 3_200, gst_rate_bp: 500, price_includes_tax: true },
      { today: '2026-10-20', expiry_warning_days: 90 },
    )
    expect(w.map((x) => x.code)).toEqual([
      'cost_above_last',
      'mrp_changed',
      'near_expiry',
      'sale_price_below_cost',
      'gst_rate_differs',
    ])
    expect(
      formatPurchaseOrderText([
        { name: 'Rice', qty_display: '25 kg' },
        { name: 'Dal', qty_display: '10 kg' },
      ]),
    ).toBe('1. Rice — 25 kg\n2. Dal — 10 kg')
  })
  it('debit-note proration shares the sales helper (free quantity included)', () => {
    const original = {
      taxable_paise: 20_000,
      cgst_paise: 1_200,
      sgst_paise: 1_200,
      igst_paise: 0,
      cess_paise: 0,
    }
    const first = prorateReturnLine(original, {
      qty_milli: 55_000,
      total_qty_milli: 165_000,
      returned_qty_milli: 0,
      credited: tax,
    })
    const rest = prorateReturnLine(original, {
      qty_milli: 110_000,
      total_qty_milli: 165_000,
      returned_qty_milli: 55_000,
      credited: first,
    })
    expect(first.total_paise + rest.total_paise).toBe(22_400)
  })
})

describe('purchase requests', () => {
  it('orders', () => {
    const po = PurchaseOrderCreateSchema.parse({
      store_id: STORE,
      supplier_id: SUPPLIER,
      lines: [{ product_id: PRODUCT, qty_milli: 150_000, unit_cost_paise: 2_000 }],
    })
    expect(po.lines).toHaveLength(1)
    expect(
      PurchaseOrderCreateSchema.safeParse({
        store_id: STORE,
        supplier_id: SUPPLIER,
        lines: [
          { product_id: PRODUCT, qty_milli: 1000 },
          { product_id: PRODUCT, qty_milli: 2000 },
        ],
      }).success,
    ).toBe(false)
    expect(PurchaseOrderUpdateSchema.parse({ notes: '' }).notes).toBeNull()
    expect(PurchaseOrderUpdateSchema.safeParse({}).success).toBe(false)
    expect(PurchaseOrderSendSchema.parse(undefined)).toEqual({ phone: null })
  })
  it('bills', () => {
    const bill = PurchaseBillCreateSchema.parse({
      supplier_id: SUPPLIER,
      store_id: STORE,
      supplier_invoice_no: ' SBA/1234 ',
      supplier_invoice_date: '2026-10-18',
      lines: [
        {
          product_id: PRODUCT,
          batch_no: 'B2401',
          mfg_date: '2026-01-01',
          expiry_date: '2027-12-31',
          mrp_paise: 3_300,
          qty_milli: 150_000,
          free_qty_milli: 15_000,
          unit_cost_paise: 2_000,
          discount_bp: 200,
          sale_price_paise: 3_100,
        },
      ],
    })
    expect(bill).toMatchObject({
      supplier_invoice_no: 'SBA/1234',
      reverse_charge: false,
      itc_eligible: true,
      other_charges_paise: 0,
    })
    const line = bill.lines[0]!
    expect(
      PurchaseBillCreateSchema.safeParse({
        ...bill,
        lines: [{ ...line, mfg_date: '2028-01-01' }],
      }).success,
    ).toBe(false)
    expect(PurchaseBillCreateSchema.safeParse({ ...bill, supplier_invoice_no: '  ' }).success).toBe(
      false,
    )
    expect(PurchaseBillUpdateSchema.parse({ round_off_paise: null }).round_off_paise).toBeNull()
    expect(PurchaseBillUpdateSchema.safeParse({ round_off_paise: 100 }).success).toBe(false)
    expect(PurchaseBillFromOrderSchema.parse(undefined)).toEqual({})
    expect(PurchaseBillPostSchema.parse(undefined)).toEqual({
      update_prices: true,
      allow_past_expiry: false,
    })
    expect(
      DuplicateSupplierInvoiceDetailsSchema.parse({
        reason: 'duplicate_supplier_invoice',
        existing_bill_id: id(),
        existing_number: 'GRNS1/2627/00004',
        existing_status: 'posted',
      }).existing_status,
    ).toBe('posted')
  })
  it('debit notes', () => {
    expect(
      DebitNoteCreateSchema.parse({
        bill_id: id(),
        reason: 'expired',
        lines: [{ bill_line_id: id(), qty_milli: 15_000 }],
      }).settlement,
    ).toBe('adjust_due')
    const free = {
      supplier_id: SUPPLIER,
      store_id: STORE,
      reason: 'expired',
      settlement: 'refund_bank',
      lines: [{ product_id: PRODUCT, batch_id: id(), qty_milli: 30_000 }],
    }
    expect(DebitNoteCreateSchema.safeParse(free).success).toBe(true)
    expect(DebitNoteCreateSchema.safeParse({ ...free, supplier_id: undefined }).success).toBe(false)
    expect(
      DebitNoteCreateSchema.safeParse({
        bill_id: id(),
        reason: 'return',
        lines: [{ bill_line_id: id(), product_id: PRODUCT, qty_milli: 1 }],
      }).success,
    ).toBe(false)
    const lineId = id()
    expect(
      DebitNoteCreateSchema.safeParse({
        bill_id: id(),
        reason: 'return',
        lines: [
          { bill_line_id: lineId, qty_milli: 1 },
          { bill_line_id: lineId, qty_milli: 1 },
        ],
      }).success,
    ).toBe(false)
    expect(
      DebitNotePrefillQuerySchema.parse({ batch_ids: [id(), id()], store_id: STORE }).batch_ids,
    ).toHaveLength(2)
    const [b1, b2] = [id(), id()]
    expect(
      DebitNotePrefillQuerySchema.parse({ batch_ids: `${b1},${b2}`, store_id: STORE }).batch_ids,
    ).toEqual([b1, b2])
    expect(
      ReorderSuggestionsQuerySchema.parse({ store_id: STORE, product_ids: b1 }).product_ids,
    ).toEqual([b1])
  })
  it('queries', () => {
    expect(
      PurchaseBillListQuerySchema.parse({
        status: 'posted',
        overdue: '1',
        sort: '-due_date',
        format: 'csv',
      }),
    ).toMatchObject({
      status: ['posted'],
      overdue: true,
      format: 'csv',
      sort: { field: 'due_date', direction: 'desc' },
    })
    expect(
      PurchaseOrderListQuerySchema.safeParse({ from: '2026-10-21', to: '2026-10-01' }).success,
    ).toBe(false)
    expect(DebitNoteListQuerySchema.parse({ reason: ['expired', 'damaged'] }).reason).toEqual([
      'expired',
      'damaged',
    ])
    expect(ReorderSuggestionsQuerySchema.safeParse({}).success).toBe(false)
  })
})

describe('purchase responses', () => {
  const billLine = {
    id: id(),
    line_no: 1,
    product_id: PRODUCT,
    product,
    purchase_order_line_id: null,
    batch_id: id(),
    batch_no: 'B2401',
    mfg_date: '2026-01-01',
    expiry_date: '2027-12-31',
    hsn_code: '30049099',
    unit: 'TAB',
    pack_size: 15,
    qty_milli: 150_000,
    free_qty_milli: 15_000,
    mrp_paise: 3_300,
    unit_cost_paise: 2_000,
    discount_bp: 0,
    discount_paise: 0,
    gross_paise: 20_000,
    taxable_paise: 20_000,
    cgst_paise: 1_200,
    sgst_paise: 1_200,
    igst_paise: 0,
    cess_paise: 0,
    gst_rate_bp: 1200,
    cess_rate_bp: 0,
    total_paise: 22_400,
    landed_unit_cost_paise: 1_818,
    sale_price_paise: 3_100,
    returned_qty_milli: 0,
    returnable_qty_milli: 165_000,
    current: {
      purchase_price_paise: 1_900,
      mrp_paise: 3_200,
      sale_price_paise: 3_000,
      price_includes_tax: true,
      gst_rate_bp: 1200,
      last_cost_paise: 1_950,
      stock_qty_milli: 45_000,
    },
  }
  const billRow = {
    id: id(),
    number: 'GRNS1/2627/00005',
    fy: '2026-27',
    status: 'posted',
    store_id: STORE,
    supplier_id: SUPPLIER,
    supplier_name: supplier.name,
    supplier_invoice_no: 'SBA/1234',
    supplier_invoice_date: '2026-10-18',
    received_date: '2026-10-20',
    due_date: '2026-11-17',
    purchase_order_id: null,
    purchase_order_number: null,
    line_count: 1,
    taxable_paise: 20_000,
    tax_paise: 2_400,
    total_paise: 22_400,
    paid_paise: 0,
    returned_paise: 0,
    due_paise: 22_400,
    payment_status: 'unpaid',
    overdue: false,
    days_overdue: null,
    posted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  }
  const billDetail = {
    ...billRow,
    supplier_gstin: supplier.gstin,
    supplier_state_code: '33',
    is_interstate: false,
    reverse_charge: false,
    itc_eligible: true,
    gross_paise: 20_000,
    discount_paise: 0,
    cgst_paise: 1_200,
    sgst_paise: 1_200,
    igst_paise: 0,
    cess_paise: 0,
    other_charges_paise: 0,
    round_off_paise: 0,
    notes: null,
    attachment_file_id: null,
    supplier,
    lines: [billLine],
    tax_breakup: [
      {
        gst_rate_bp: 1200,
        taxable_paise: 20_000,
        cgst_paise: 1_200,
        sgst_paise: 1_200,
        igst_paise: 0,
        cess_paise: 0,
      },
    ],
    purchase_order: null,
    payments: [],
    debit_notes: [],
    journal_entry_id: id(),
    posted_by: id(),
    posted_by_name: 'Ravi',
    cancelled_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancel_reason: null,
    created_by: id(),
    created_by_name: 'Ravi',
    warnings: [
      {
        code: 'mrp_changed',
        line_no: 1,
        product_id: PRODUCT,
        params: { previous_mrp_paise: 3_200 },
      },
    ],
  }

  it('bills', () => {
    expect(PurchaseBillDetailSchema.parse(billDetail).lines[0]!.landed_unit_cost_paise).toBe(1_818)
    expect(
      PurchaseBillPostResultSchema.parse({
        bill: billDetail,
        price_updates: [
          {
            product_id: PRODUCT,
            product_name: product.name,
            batch_id: null,
            field: 'sale_price_paise',
            old_paise: 3_000,
            new_paise: 3_100,
          },
        ],
        batches_created: 1,
        stock_lines: 1,
      }).price_updates,
    ).toHaveLength(1)
    expect(
      PurchaseBillListResponseSchema.parse({
        data: [billRow],
        page: { limit: 50, offset: 0, total: 1 },
        summary: {
          count: 1,
          total_paise: 22_400,
          paid_paise: 0,
          due_paise: 22_400,
          overdue_paise: 0,
        },
      }).data,
    ).toHaveLength(1)
    expect(
      BillReturnableResponseSchema.parse({
        bill: {
          id: billRow.id,
          number: billRow.number,
          supplier_id: SUPPLIER,
          supplier_name: supplier.name,
          supplier_invoice_no: 'SBA/1234',
          received_date: '2026-10-20',
          status: 'posted',
          is_interstate: false,
          total_paise: 22_400,
          due_paise: 22_400,
        },
        lines: [
          {
            bill_line_id: billLine.id,
            line_no: 1,
            product_id: PRODUCT,
            product,
            batch_id: billLine.batch_id,
            batch_no: 'B2401',
            expiry_date: '2027-12-31',
            unit: 'TAB',
            pack_size: 15,
            qty_milli: 150_000,
            free_qty_milli: 15_000,
            returned_qty_milli: 0,
            returnable_qty_milli: 165_000,
            available_qty_milli: 165_000,
            unit_cost_paise: 2_000,
            landed_unit_cost_paise: 1_818,
            taxable_paise: 20_000,
            cgst_paise: 1_200,
            sgst_paise: 1_200,
            igst_paise: 0,
            cess_paise: 0,
            gst_rate_bp: 1200,
            cess_rate_bp: 0,
            total_paise: 22_400,
            credited: tax,
          },
        ],
      }).lines,
    ).toHaveLength(1)
  })

  it('orders', () => {
    const order = {
      id: id(),
      number: 'POS1/2627/00003',
      fy: '2026-27',
      order_date: '2026-10-15',
      expected_date: null,
      status: 'sent',
      store_id: STORE,
      supplier_id: SUPPLIER,
      supplier_name: supplier.name,
      line_count: 1,
      taxable_paise: 20_000,
      tax_paise: 2_400,
      total_paise: 22_400,
      received_bp: 0,
      sent_at: NOW,
      created_at: NOW,
      updated_at: NOW,
      is_interstate: false,
      notes: null,
      terms: null,
      supplier,
      lines: [
        {
          id: id(),
          line_no: 1,
          product,
          product_id: PRODUCT,
          qty_milli: 150_000,
          received_qty_milli: 0,
          pending_qty_milli: 150_000,
          unit_cost_paise: 2_000,
          gst_rate_bp: 1200,
          taxable_paise: 20_000,
          tax_paise: 2_400,
          total_paise: 22_400,
          notes: null,
          current_stock_milli: 15_000,
          last_cost_paise: 1_950,
        },
      ],
      bills: [],
      created_by: null,
      created_by_name: null,
    }
    expect(PurchaseOrderDetailSchema.parse(order).status).toBe('sent')
    expect(
      PurchaseOrderSendResultSchema.parse({
        order,
        notification_id: null,
        message: '1. Paracetamol — 10 strips',
        wa_me_url: null,
      }).message,
    ).toContain('Paracetamol')
  })

  it('debit notes, prefill, reorder', () => {
    expect(
      DebitNoteDetailSchema.parse({
        id: id(),
        number: 'DNS1/2627/00002',
        fy: '2026-27',
        note_date: '2026-10-20',
        store_id: STORE,
        supplier_id: SUPPLIER,
        supplier_name: supplier.name,
        bill_id: null,
        bill_number: null,
        supplier_invoice_no: null,
        reason: 'expired',
        status: 'completed',
        settlement: 'adjust_due',
        total_paise: 4_480,
        line_count: 1,
        created_at: NOW,
        is_interstate: false,
        taxable_paise: 4_000,
        cgst_paise: 240,
        sgst_paise: 240,
        igst_paise: 0,
        cess_paise: 0,
        tax_paise: 480,
        round_off_paise: 0,
        notes: null,
        supplier,
        lines: [
          {
            id: id(),
            line_no: 1,
            bill_line_id: null,
            product_id: PRODUCT,
            product,
            batch_id: id(),
            batch_no: 'B2301',
            expiry_date: '2026-09-30',
            hsn_code: '30049099',
            unit: 'TAB',
            pack_size: 15,
            qty_milli: 30_000,
            unit_cost_paise: 2_000,
            taxable_paise: 4_000,
            cgst_paise: 240,
            sgst_paise: 240,
            igst_paise: 0,
            cess_paise: 0,
            gst_rate_bp: 1200,
            cess_rate_bp: 0,
            total_paise: 4_480,
          },
        ],
        tax_breakup: [],
        payments: [],
        journal_entry_id: id(),
        supplier_amount_paise: 4_480,
        cancelled_at: null,
        cancelled_by: null,
        cancelled_by_name: null,
        cancel_reason: null,
        created_by: null,
        created_by_name: null,
        updated_at: NOW,
      }).total_paise,
    ).toBe(4_480)
    expect(
      DebitNotePrefillSchema.parse({
        supplier: { id: SUPPLIER, name: supplier.name },
        lines: [
          {
            product_id: PRODUCT,
            product,
            batch_id: id(),
            batch_no: 'B2301',
            expiry_date: '2026-09-30',
            available_qty_milli: 30_000,
            unit_cost_paise: 1_818,
            gst_rate_bp: 1200,
            cess_rate_bp: 0,
            supplier_id: SUPPLIER,
            supplier_name: supplier.name,
            bill_id: id(),
            bill_line_id: id(),
            bill_number: 'GRNS1/2627/00001',
            returnable_qty_milli: 30_000,
          },
        ],
      }).lines,
    ).toHaveLength(1)
    expect(
      ReorderSuggestionsSchema.parse({
        store_id: STORE,
        generated_at: NOW,
        window_days: 30,
        groups: [
          {
            supplier: { id: SUPPLIER, name: supplier.name, phone: null },
            items: [
              {
                product_id: PRODUCT,
                name: product.name,
                name_ta: null,
                sku: 'PCM650',
                unit: 'TAB',
                pack_size: 15,
                category_id: null,
                current_stock_milli: 15_000,
                reorder_level_milli: 30_000,
                reorder_qty_milli: 150_000,
                avg_daily_sales_milli: 2_000,
                days_of_cover: 7,
                suggested_qty_milli: 150_000,
                open_po_qty_milli: 0,
                last_cost_paise: 2_000,
                last_bill_date: '2026-09-01',
                gst_rate_bp: 1200,
                unit_cost_paise: 2_000,
                estimated_cost_paise: 20_000,
              },
            ],
            estimated_cost_paise: 20_000,
          },
        ],
      }).groups,
    ).toHaveLength(1)
  })
})

describe('purchases route catalogue', () => {
  it('paths', () => {
    expect(routeUrl(purchasesRoutes.billFromOrder, { orderId: 'o1' })).toBe(
      '/api/v1/purchase-bills/from-order/o1',
    )
    expect(routeUrl(purchasesRoutes.reorderSuggestions)).toBe(
      '/api/v1/purchases/reorder-suggestions',
    )
  })
})
