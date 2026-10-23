import { describe, expect, it } from 'vitest'
import {
  CollectPaymentSchema,
  CreditNoteCreateSchema,
  CreditNoteDetailSchema,
  CreditNoteListQuerySchema,
  CreditNoteListResponseSchema,
  EstimateConvertSchema,
  EstimateCreateSchema,
  HeldBillSchema,
  HeldBillsQuerySchema,
  InvoiceCancelResultSchema,
  InvoiceCancelSchema,
  InvoiceCompleteSchema,
  InvoiceCreateSchema,
  InvoiceListQuerySchema,
  InvoiceListResponseSchema,
  InvoiceSaveResultSchema,
  InvoiceShareResultSchema,
  InvoiceShareSchema,
  InvoiceUpdateSchema,
  PosBootstrapQuerySchema,
  PosBootstrapSchema,
  PosSyncRequestSchema,
  PosSyncResultSchema,
  PrintQuerySchema,
  PublicInvoiceSchema,
  QuoteRequestSchema,
  QuoteResultSchema,
  ReturnableResponseSchema,
  SalesInvoiceDetailSchema,
  SalesPrintModelSchema,
  ShareTokenParamsSchema,
  generateShareToken,
  salesRoutes,
} from '../../src/api/sales'
import { routeUrl } from '../../src/api/common'
import { newId } from '../../src/ids'
import { DEFAULT_SETTINGS, RegisterSettingsSchema } from '../../src/settings'

const id = () => newId()
const NOW = '2026-10-20T10:15:00+05:30'
const STORE = id()
const REGISTER = id()
const CUSTOMER = id()
const PRODUCT = id()

const tax0 = { taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, cess_paise: 0 }

const cart = {
  store_id: STORE,
  register_id: REGISTER,
  customer_id: CUSTOMER,
  lines: [
    { key: 'a', product_id: PRODUCT, qty_milli: 2000 },
    { key: 'b', product_id: id(), qty_milli: 1250, unit_price_paise: 6_000, discount_bp: 500 },
    {
      item: { name: 'Carry bag', gst_rate_bp: 1800, unit: 'PCS' },
      qty_milli: 1000,
      unit_price_paise: 500,
    },
  ],
  bill_discount_paise: 100,
}

const invoiceLine = (over: Record<string, unknown> = {}) => ({
  id: id(),
  line_no: 1,
  product_id: PRODUCT,
  batch_id: null,
  batch_no: null,
  expiry_date: null,
  name: 'Ponni Rice 1 kg',
  name_ta: 'பொன்னி அரிசி 1 கிலோ',
  hsn_code: '1006',
  unit: 'PCS',
  pack_size: 1,
  qty_milli: 2000,
  free_qty_milli: 0,
  mrp_paise: 7_500,
  unit_price_paise: 7_000,
  discount_bp: 0,
  gross_paise: 14_000,
  discount_paise: 0,
  taxable_paise: 13_333,
  gst_rate_bp: 500,
  cgst_paise: 334,
  sgst_paise: 333,
  igst_paise: 0,
  cess_rate_bp: 0,
  cess_paise: 0,
  total_paise: 14_000,
  unit_cost_paise: 6_000,
  cost_paise: 12_000,
  promotion_id: null,
  promotion_name: null,
  returned_qty_milli: 0,
  returnable_qty_milli: 2000,
  serial_numbers: [],
  meta: { price_source: 'product', scanned_code: '8901234567892', extra: 1 },
  ...over,
})

const listRow = {
  id: id(),
  doc_type: 'tax_invoice',
  number: 'S1-A/2627/00042',
  fy: '2026-27',
  invoice_date: '2026-10-20',
  invoice_at: new Date(NOW),
  status: 'completed',
  channel: 'pos',
  store_id: STORE,
  store_code: 'S1',
  register_id: REGISTER,
  register_code: 'A',
  customer_id: CUSTOMER,
  customer_name: 'Murugan',
  customer_phone: '+919876543210',
  item_count: 1,
  total_paise: 14_000,
  paid_paise: 10_000,
  returned_paise: 0,
  due_paise: 4_000,
  payment_status: 'partial',
  due_date: '2026-11-19',
  created_by: id(),
  created_by_name: 'Kavitha',
  offline: false,
  client_ref: id(),
  created_at: NOW,
  updated_at: NOW,
}

export const invoiceDetail = {
  ...listRow,
  store: { id: STORE, code: 'S1', name: 'Main' },
  register: { id: REGISTER, code: 'A', name: 'Counter A' },
  shift_id: id(),
  customer_gstin: null,
  customer_address: { city: 'Madurai', state_code: '33' },
  customer_state_code: '33',
  place_of_supply: '33',
  is_interstate: false,
  reverse_charge: false,
  price_includes_tax: true,
  gross_paise: 14_000,
  item_discount_paise: 0,
  bill_discount_paise: 0,
  taxable_paise: 13_333,
  cgst_paise: 334,
  sgst_paise: 333,
  igst_paise: 0,
  cess_paise: 0,
  tax_paise: 667,
  round_off_paise: 0,
  cost_paise: 12_000,
  loyalty_points_earned: 1,
  loyalty_points_redeemed: 0,
  loyalty_redeem_paise: 0,
  rx: null,
  salesperson_id: null,
  salesperson_name: null,
  notes: null,
  share_url: null,
  offline_created_at: null,
  converted_to_id: null,
  source_estimate: null,
  completed_at: NOW,
  cancelled_at: null,
  cancelled_by: null,
  cancelled_by_name: null,
  cancel_reason: null,
  lines: [invoiceLine()],
  tax_breakup: [
    {
      gst_rate_bp: 500,
      taxable_paise: 13_333,
      cgst_paise: 334,
      sgst_paise: 333,
      igst_paise: 0,
      cess_paise: 0,
    },
  ],
  mrp_savings_paise: 1_000,
  payments: [
    {
      payment_id: id(),
      number: null,
      direction: 'in',
      method: 'cash',
      amount_paise: 10_000,
      payment_amount_paise: 10_000,
      status: 'completed',
      payment_date: '2026-10-20',
      paid_at: NOW,
      reference: null,
      payment_intent_id: null,
      payer_vpa: null,
      origin: 'sales_tender',
      change_paise: 0,
      created_by_name: 'Kavitha',
    },
  ],
  credit_notes: [],
  journal_entry_id: id(),
  shift: { id: id(), status: 'open', opened_at: NOW, opened_by_name: 'Kavitha' },
  customer: {
    id: CUSTOMER,
    name: 'Murugan',
    phone: '+919876543210',
    balance_paise: 4_000,
    credit_limit_paise: 500_000,
    loyalty_points: 12,
  },
  audit: [
    {
      id: 101,
      action: 'sales_invoice.create',
      summary: 'S1-A/2627/00042',
      user_name: 'Kavitha',
      created_at: NOW,
    },
  ],
}

const printModel = {
  kind: 'invoice',
  doc_type: 'tax_invoice',
  format: 'thermal_80',
  locale: { primary: 'ta', bilingual: true },
  title: { en: 'Tax Invoice', ta: 'வரி விலைப்பட்டியல்' },
  copies: [],
  seller: {
    name: 'Murugan Stores',
    name_ta: 'முருகன் ஸ்டோர்ஸ்',
    legal_name: null,
    gstin: '33AAPFU0939F1Z2',
    pan: 'AAPFU0939F',
    state_code: '33',
    state_name: 'Tamil Nadu',
    address_lines: ['12, East Masi St', 'Madurai 625001'],
    phone: '+919876543210',
    email: null,
    logo_url: null,
    drug_license_numbers: null,
    fssai_number: '12345678901234',
    store_code: 'S1',
    store_name: 'Main',
    store_name_ta: null,
  },
  document: {
    number: 'S1-A/2627/00042',
    date: '2026-10-20',
    time: '10:15',
    issued_at: NOW,
    status: 'completed',
    cancelled: false,
    place_of_supply: '33',
    place_of_supply_name: 'Tamil Nadu',
    is_interstate: false,
    reverse_charge: false,
    register_code: 'A',
    cashier_name: 'Kavitha',
    salesperson_name: null,
    due_date: null,
    valid_until: null,
    original_invoice: null,
    reason: null,
  },
  buyer: null,
  lines: [
    {
      line_no: 1,
      name: 'Ponni Rice 1 kg',
      name_ta: 'பொன்னி அரிசி 1 கிலோ',
      variant_text: null,
      note: null,
      hsn_code: '1006',
      batch_no: null,
      expiry_date: null,
      schedule: null,
      serial_numbers: [],
      qty_milli: 2000,
      unit: 'PCS',
      uqc: 'NOS',
      qty_display: { en: '2 pcs', ta: '2 எண்' },
      pack_size: 1,
      mrp_paise: 7_500,
      rate_paise: 7_000,
      price_includes_tax: true,
      discount_paise: 0,
      taxable_paise: 13_333,
      gst_rate_bp: 500,
      cgst_paise: 334,
      sgst_paise: 333,
      igst_paise: 0,
      cess_rate_bp: 0,
      cess_paise: 0,
      total_paise: 14_000,
    },
  ],
  tax_breakup: [
    {
      gst_rate_bp: 500,
      cgst_rate_bp: 250,
      sgst_rate_bp: 250,
      igst_rate_bp: 0,
      taxable_paise: 13_333,
      cgst_paise: 334,
      sgst_paise: 333,
      igst_paise: 0,
      cess_paise: 0,
      tax_paise: 667,
    },
  ],
  hsn_summary: [
    {
      hsn_code: '1006',
      gst_rate_bp: 500,
      taxable_paise: 13_333,
      cgst_paise: 334,
      sgst_paise: 333,
      igst_paise: 0,
      cess_paise: 0,
      tax_paise: 667,
    },
  ],
  tax_labels: { cgst: 'CGST', sgst: 'SGST', igst: 'IGST' },
  totals: {
    item_count: 1,
    gross_paise: 14_000,
    item_discount_paise: 0,
    bill_discount_paise: 0,
    taxable_paise: 13_333,
    cgst_paise: 334,
    sgst_paise: 333,
    igst_paise: 0,
    cess_paise: 0,
    tax_paise: 667,
    round_off_paise: 0,
    total_paise: 14_000,
    loyalty_redeem_paise: 0,
    discount_paise: 0,
    mrp_savings_paise: 1_000,
  },
  amount_in_words: {
    en: 'Rupees One Hundred Forty Only',
    ta: 'ரூபாய் நூற்று நாற்பது மட்டும்',
  },
  payments: [
    { method: 'cash', label: { en: 'Cash', ta: 'ரொக்கம்' }, amount_paise: 10_000, reference: null },
  ],
  paid_paise: 10_000,
  change_paise: 0,
  due_paise: 4_000,
  returned_paise: 0,
  customer_balance_paise: 4_000,
  savings: { mrp_savings_paise: 1_000, discount_paise: 0, total_paise: 1_000 },
  loyalty: { points_earned: 1, points_redeemed: 0, redeem_paise: 0, balance_points: 12 },
  upi: {
    uri: 'upi://pay?pa=murugan@okaxis&pn=Murugan%20Stores&am=40.00&cu=INR',
    amount_paise: 4_000,
    vpa: 'murugan@okaxis',
    payee_name: 'Murugan Stores',
  },
  settlement: null,
  composition_declaration: null,
  footer: { text_en: 'Thank you! Visit again.', text_ta: 'நன்றி! மீண்டும் வருக.', terms: '' },
  signatory: {
    label: { en: 'Authorised Signatory', ta: 'அங்கீகரிக்கப்பட்ட கையொப்பம்' },
    for_name: 'Murugan Stores',
  },
  rx: null,
  flags: { show_hsn: true, show_mrp: true, show_mrp_savings: true, bilingual: true },
  share_url: null,
  generated_at: NOW,
}

describe('sales requests', () => {
  it('quote & create', () => {
    const q = QuoteRequestSchema.parse({
      ...cart,
      tenders: [{ method: 'cash', amount_paise: 50_000 }],
    })
    expect(q.lines).toHaveLength(3)
    expect(q.lines[2]!.item).toMatchObject({ cess_rate_bp: 0, unit: 'PCS' })

    const created = InvoiceCreateSchema.parse({
      ...cart,
      client_ref: id(),
      tenders: [
        { method: 'upi', amount_paise: 10_000, payment_intent_id: id() },
        { method: 'cash', amount_paise: 50_000 },
      ],
      customer: { name: 'Murugan', phone: '98765 43210', gstin: '33aapfu0939f1z2' },
      rx: { doctor_name: 'Dr. Lakshmi', patient_name: 'Selvi', patient_age: 54 },
    })
    expect(created).toMatchObject({
      status: 'completed',
      channel: 'pos',
      credit_limit_override: false,
    })
    expect(created.customer).toMatchObject({ phone: '+919876543210', gstin: '33AAPFU0939F1Z2' })

    // POS saves need a client_ref; held bills carry no tenders.
    expect(InvoiceCreateSchema.safeParse(cart).success).toBe(false)
    expect(InvoiceCreateSchema.safeParse({ ...cart, channel: 'backoffice' }).success).toBe(true)
    expect(
      InvoiceCreateSchema.safeParse({
        ...cart,
        client_ref: id(),
        status: 'held',
        tenders: [{ method: 'cash', amount_paise: 100 }],
      }).success,
    ).toBe(false)
  })

  it('cart line rules', () => {
    const bad = (line: Record<string, unknown>) =>
      QuoteRequestSchema.safeParse({ ...cart, lines: [line] }).success
    expect(bad({ qty_milli: 1000 })).toBe(false) // neither product nor item
    expect(bad({ product_id: PRODUCT, item: { name: 'x', gst_rate_bp: 0 }, qty_milli: 1000 })).toBe(
      false,
    )
    expect(bad({ item: { name: 'x', gst_rate_bp: 0 }, qty_milli: 1000 })).toBe(false) // ad-hoc needs a price
    expect(
      bad({
        item: { name: 'x', gst_rate_bp: 0, unit: 'XYZ' },
        qty_milli: 1000,
        unit_price_paise: 1,
      }),
    ).toBe(false)
    expect(
      bad({ item: { name: 'x', gst_rate_bp: 700 }, qty_milli: 1000, unit_price_paise: 1 }),
    ).toBe(false)
    expect(bad({ product_id: PRODUCT, qty_milli: 0 })).toBe(false)
    expect(
      QuoteRequestSchema.safeParse({
        ...cart,
        lines: [
          { key: 'x', product_id: PRODUCT, qty_milli: 1000 },
          { key: 'x', product_id: PRODUCT, qty_milli: 1000 },
        ],
      }).success,
    ).toBe(false)
    expect(
      QuoteRequestSchema.safeParse({
        ...cart,
        tenders: [{ method: 'cash', amount_paise: 100, payment_intent_id: id() }],
      }).success,
    ).toBe(false)
  })

  it('held / draft update, complete, cancel, collect, share', () => {
    expect(InvoiceUpdateSchema.parse({ notes: '', if_updated_at: NOW })).toEqual({
      notes: null,
      if_updated_at: NOW,
    })
    expect(InvoiceUpdateSchema.safeParse({ if_updated_at: NOW }).success).toBe(false)
    expect(
      InvoiceCompleteSchema.parse({
        tenders: [{ method: 'card', amount_paise: 100, reference: 'APPR12' }],
      }),
    ).toMatchObject({ credit_limit_override: false })
    expect(InvoiceCancelSchema.safeParse({ reason: 'x' }).success).toBe(false)
    expect(InvoiceCancelSchema.parse({ reason: 'Customer changed mind' }).reason).toBe(
      'Customer changed mind',
    )
    expect(CollectPaymentSchema.safeParse({ tenders: [] }).success).toBe(false)
    expect(InvoiceShareSchema.parse({ channel: 'whatsapp' }).phone).toBeNull()
  })

  it('estimates', () => {
    expect(EstimateCreateSchema.parse({ ...cart, valid_until: '2026-10-27' }).valid_until).toBe(
      '2026-10-27',
    )
    expect(EstimateConvertSchema.parse({})).toMatchObject({
      status: 'draft',
      keep_prices: false,
      channel: 'backoffice',
    })
  })

  it('credit notes', () => {
    const ok = CreditNoteCreateSchema.parse({
      client_ref: id(),
      invoice_id: id(),
      lines: [{ invoice_line_id: id(), qty_milli: 1000, restock: true }],
      reason: 'return',
      settlement: 'cash',
    })
    expect(ok.lines[0]!.restock).toBe(true)
    // free-form needs a store and prices
    expect(
      CreditNoteCreateSchema.safeParse({
        client_ref: id(),
        lines: [{ product_id: PRODUCT, qty_milli: 1000, unit_price_paise: 500 }],
        reason: 'expired',
        settlement: 'store_credit',
      }).success,
    ).toBe(false)
    expect(
      CreditNoteCreateSchema.safeParse({
        client_ref: id(),
        store_id: STORE,
        customer_id: CUSTOMER,
        lines: [{ product_id: PRODUCT, qty_milli: 1000, unit_price_paise: 500 }],
        reason: 'expired',
        settlement: 'store_credit',
      }).success,
    ).toBe(true)
    const line = id()
    expect(
      CreditNoteCreateSchema.safeParse({
        client_ref: id(),
        invoice_id: id(),
        lines: [
          { invoice_line_id: line, qty_milli: 1000 },
          { invoice_line_id: line, qty_milli: 1000 },
        ],
        reason: 'return',
        settlement: 'cash',
      }).success,
    ).toBe(false)
    expect(
      CreditNoteCreateSchema.safeParse({
        client_ref: id(),
        invoice_id: id(),
        lines: [
          { invoice_line_id: id(), product_id: PRODUCT, qty_milli: 1000, unit_price_paise: 1 },
        ],
        reason: 'return',
        settlement: 'cash',
      }).success,
    ).toBe(false)
  })

  it('offline sync', () => {
    const body = PosSyncRequestSchema.parse({
      register_id: REGISTER,
      invoices: [
        {
          ...cart,
          client_ref: id(),
          offline_number: 'S1-A/2627/00043',
          offline_created_at: NOW,
          invoice_date: '2026-10-20',
          tenders: [{ method: 'cash', amount_paise: 50_000 }],
        },
      ],
      credit_notes: [
        {
          client_ref: id(),
          invoice_client_ref: id(),
          lines: [{ invoice_line_no: 1, qty_milli: 1000 }],
          reason: 'return',
          settlement: 'cash',
          offline_created_at: NOW,
          note_date: '2026-10-20',
        },
      ],
    })
    expect(body.invoices[0]!.credit_limit_override).toBe(false)
    expect(PosSyncRequestSchema.safeParse({ register_id: REGISTER }).success).toBe(false)
  })

  it('queries', () => {
    const q = InvoiceListQuerySchema.parse({
      status: 'completed',
      doc_type: ['tax_invoice', 'bill_of_supply'],
      payment_status: 'unpaid',
      has_due: 'true',
      from: '2026-10-01',
      to: '2026-10-20',
      sort: '-invoice_at',
      limit: '25',
    })
    expect(q).toMatchObject({
      status: ['completed'],
      doc_type: ['tax_invoice', 'bill_of_supply'],
      has_due: true,
      limit: 25,
      format: 'json',
      sort: { field: 'invoice_at', direction: 'desc' },
    })
    expect(InvoiceListQuerySchema.safeParse({ from: '2026-10-21', to: '2026-10-20' }).success).toBe(
      false,
    )
    expect(InvoiceListQuerySchema.safeParse({ sort: 'cost_paise' }).success).toBe(false)
    expect(CreditNoteListQuerySchema.parse({ settlement: 'cash', format: 'csv' })).toMatchObject({
      settlement: ['cash'],
      format: 'csv',
    })
    expect(HeldBillsQuerySchema.parse({ store_id: STORE }).status).toBeUndefined()
    expect(
      PosBootstrapQuerySchema.parse({ register_id: REGISTER, since: '2026-10-20T04:40:00.000Z' })
        .since,
    ).toBeTruthy()
    expect(PrintQuerySchema.parse({ format: 'a4' }).format).toBe('a4')
    expect(PrintQuerySchema.safeParse({ format: 'a5' }).success).toBe(false)
    expect(ShareTokenParamsSchema.safeParse({ shareToken: generateShareToken() }).success).toBe(
      true,
    )
    expect(ShareTokenParamsSchema.safeParse({ shareToken: 'short' }).success).toBe(false)
  })
})

describe('sales responses', () => {
  it('invoice detail, list, save, cancel results', () => {
    const detail = SalesInvoiceDetailSchema.parse(invoiceDetail)
    expect(detail.invoice_at).toBe(new Date(NOW).toISOString())
    expect(detail.lines[0]!.meta).toMatchObject({ price_source: 'product', extra: 1 })
    expect(
      InvoiceListResponseSchema.parse({
        data: [listRow],
        page: { limit: 50, offset: 0, total: 1 },
        summary: {
          count: 1,
          total_paise: 14_000,
          paid_paise: 10_000,
          due_paise: 4_000,
          returned_paise: 0,
          taxable_paise: 13_333,
          tax_paise: 667,
        },
      }).data,
    ).toHaveLength(1)
    const saved = InvoiceSaveResultSchema.parse({
      invoice: invoiceDetail,
      tenders: [
        {
          index: 0,
          method: 'cash',
          amount_paise: 50_000,
          applied_paise: 10_000,
          change_paise: 40_000,
          payment_id: id(),
        },
      ],
      change_paise: 40_000,
      warnings: [
        {
          code: 'near_expiry',
          severity: 'warning',
          line_key: 'a',
          params: { expiry_date: '2026-11-30' },
        },
      ],
    })
    expect(saved.change_paise).toBe(40_000)
    expect(
      InvoiceCancelResultSchema.parse({
        invoice: {
          ...invoiceDetail,
          status: 'cancelled',
          cancelled_at: NOW,
          cancel_reason: 'wrong bill',
        },
        refunds: [
          {
            payment_id: id(),
            method: 'upi',
            amount_paise: 4_000,
            psp_refund_required: true,
            provider: 'razorpay',
            utr: '123456789012',
          },
        ],
      }).refunds[0]!.psp_refund_required,
    ).toBe(true)
    expect(
      HeldBillSchema.parse({
        id: id(),
        status: 'held',
        store_id: STORE,
        register_id: REGISTER,
        register_code: 'A',
        customer_id: null,
        customer_name: null,
        item_count: 3,
        total_paise: 25_000,
        notes: 'Blue saree lady',
        created_by_name: 'Kavitha',
        created_at: NOW,
        updated_at: NOW,
      }).status,
    ).toBe('held')
    expect(
      InvoiceShareResultSchema.parse({
        url: 'https://shop.example/i/abc',
        share_token: generateShareToken(),
        notification_id: null,
        message: 'Bill S1-A/2627/00042 ₹140.00',
        wa_me_url: 'https://wa.me/919876543210?text=Bill',
      }).notification_id,
    ).toBeNull()
  })

  it('quote result', () => {
    const r = QuoteResultSchema.parse({
      doc_type: 'tax_invoice',
      tax_mode: 'regular',
      place_of_supply: '33',
      is_interstate: false,
      price_includes_tax: true,
      lines: [
        {
          key: 'a',
          source_key: 'a',
          line_no: 1,
          product_id: PRODUCT,
          batch_id: id(),
          batch_no: 'B2401',
          expiry_date: '2027-03-31',
          name: 'Paracetamol 650',
          name_ta: null,
          hsn_code: '30049099',
          unit: 'TAB',
          pack_size: 15,
          qty_milli: 15_000,
          mrp_paise: 3_200,
          unit_price_paise: 3_200,
          resolved_price_paise: 3_200,
          price_source: 'batch',
          price_includes_tax: true,
          manual_discount_bp: 0,
          manual_discount_paise: 0,
          item_discount_paise: 0,
          promotion_discount_paise: 0,
          promotion_ids: [],
          bill_discount_paise: 0,
          gross_paise: 3_200,
          discount_paise: 0,
          taxable_paise: 3_048,
          gst_rate_bp: 500,
          cgst_paise: 76,
          sgst_paise: 76,
          igst_paise: 0,
          cess_rate_bp: 0,
          cess_paise: 0,
          total_paise: 3_200,
          mrp_savings_paise: 0,
          tax_slab_rule_id: null,
          schedule: 'H',
          requires_rx: true,
          serial_numbers: [],
          available_qty_milli: 120_000,
          unit_cost_paise: null,
        },
      ],
      gross_paise: 3_200,
      item_discount_paise: 0,
      bill_discount_paise: 0,
      taxable_paise: 3_048,
      cgst_paise: 76,
      sgst_paise: 76,
      igst_paise: 0,
      cess_paise: 0,
      tax_paise: 152,
      round_off_paise: 0,
      total_paise: 3_200,
      manual_bill_discount_paise: 0,
      promotion_bill_discount_paise: 0,
      loyalty_redeem_paise: 0,
      loyalty_points_redeemed: 0,
      mrp_savings_paise: 0,
      tax_breakup: [
        { gst_rate_bp: 500, ...tax0, taxable_paise: 3_048, cgst_paise: 76, sgst_paise: 76 },
      ],
      applied_promotions: [],
      customer: null,
      tenders: null,
      credit: null,
      loyalty: null,
      issues: [
        { code: 'rx_required', severity: 'error', line_key: 'a', params: { schedule: 'H' } },
      ],
      can_complete: false,
      requires: { rx: true, price_override: false, discount_override: false, credit: false },
    })
    expect(r.can_complete).toBe(false)
  })

  it('print model and public invoice', () => {
    const m = SalesPrintModelSchema.parse(printModel)
    expect(m.tax_labels.sgst).toBe('SGST')
    expect(
      SalesPrintModelSchema.parse({
        ...printModel,
        kind: 'credit_note',
        doc_type: 'credit_note',
        document: {
          ...printModel.document,
          number: 'CNS1/2627/00007',
          original_invoice: { number: 'S1-A/2627/00042', date: '2026-10-18' },
          reason: { en: 'Goods returned', ta: 'பொருள் திருப்பம்' },
        },
        settlement: {
          method: 'cash',
          label: { en: 'Cash refund', ta: 'ரொக்கமாகத் திருப்பித் தருதல்' },
          amount_paise: 7_000,
        },
        upi: null,
      }).settlement?.method,
    ).toBe('cash')
    const pub = PublicInvoiceSchema.parse({
      document: printModel,
      pay: {
        amount_paise: 4_000,
        upi_uri: 'upi://pay?pa=murugan@okaxis&pn=Murugan&am=40.00&cu=INR&tr=S1A262700042',
        vpa: 'murugan@okaxis',
        payee_name: 'Murugan',
        short_url: null,
      },
    })
    expect(JSON.stringify(pub)).not.toContain('cost_paise')
  })

  it('returnable and credit notes', () => {
    const lineId = id()
    expect(
      ReturnableResponseSchema.parse({
        invoice: {
          id: id(),
          number: 'S1-A/2627/00042',
          doc_type: 'tax_invoice',
          invoice_date: '2026-10-18',
          status: 'completed',
          store_id: STORE,
          customer_id: CUSTOMER,
          customer_name: 'Murugan',
          is_interstate: false,
          total_paise: 14_000,
          paid_paise: 14_000,
          due_paise: 0,
          returned_paise: 0,
          payment_status: 'paid',
        },
        lines: [
          {
            invoice_line_id: lineId,
            line_no: 1,
            product_id: PRODUCT,
            batch_id: null,
            batch_no: null,
            expiry_date: null,
            name: 'Ponni Rice 1 kg',
            name_ta: null,
            hsn_code: '1006',
            unit: 'PCS',
            pack_size: 1,
            qty_milli: 2000,
            returned_qty_milli: 0,
            returnable_qty_milli: 2000,
            unit_price_paise: 7_000,
            gross_paise: 14_000,
            discount_paise: 0,
            taxable_paise: 13_333,
            gst_rate_bp: 500,
            cgst_paise: 334,
            sgst_paise: 333,
            igst_paise: 0,
            cess_rate_bp: 0,
            cess_paise: 0,
            total_paise: 14_000,
            credited: tax0,
            unit_cost_paise: 6_000,
            track_inventory: true,
          },
        ],
        refundable_paise: 14_000,
      }).lines,
    ).toHaveLength(1)
    const cnRow = {
      id: id(),
      number: 'CNS1/2627/00007',
      fy: '2026-27',
      note_date: '2026-10-20',
      store_id: STORE,
      register_id: null,
      invoice_id: id(),
      invoice_number: 'S1-A/2627/00042',
      customer_id: CUSTOMER,
      customer_name: 'Murugan',
      customer_phone: null,
      reason: 'return',
      status: 'completed',
      settlement: 'cash',
      total_paise: 7_000,
      settled_paise: 7_000,
      item_count: 1,
      created_by_name: 'Kavitha',
      client_ref: id(),
      created_at: NOW,
    }
    expect(
      CreditNoteListResponseSchema.parse({
        data: [cnRow],
        page: { limit: 50, offset: 0, total: 1 },
        summary: { count: 1, total_paise: 7_000 },
      }).summary.total_paise,
    ).toBe(7_000)
    expect(
      CreditNoteDetailSchema.parse({
        ...cnRow,
        customer_gstin: null,
        customer_state_code: '33',
        place_of_supply: '33',
        is_interstate: false,
        taxable_paise: 6_667,
        cgst_paise: 167,
        sgst_paise: 166,
        igst_paise: 0,
        cess_paise: 0,
        tax_paise: 333,
        round_off_paise: 0,
        cost_paise: 6_000,
        restock: true,
        notes: null,
        lines: [
          {
            id: id(),
            line_no: 1,
            invoice_line_id: lineId,
            product_id: PRODUCT,
            batch_id: null,
            batch_no: null,
            expiry_date: null,
            name: 'Ponni Rice 1 kg',
            name_ta: null,
            hsn_code: '1006',
            unit: 'PCS',
            pack_size: 1,
            qty_milli: 1000,
            unit_price_paise: 7_000,
            taxable_paise: 6_667,
            gst_rate_bp: 500,
            cgst_paise: 167,
            sgst_paise: 166,
            igst_paise: 0,
            cess_rate_bp: 0,
            cess_paise: 0,
            total_paise: 7_000,
            unit_cost_paise: 6_000,
            cost_paise: 6_000,
            restock: true,
          },
        ],
        tax_breakup: [],
        invoice: {
          id: id(),
          number: 'S1-A/2627/00042',
          invoice_date: '2026-10-18',
          total_paise: 14_000,
        },
        payments: [],
        journal_entry_id: id(),
        loyalty_points_reversed: 0,
        cancelled_at: null,
        cancelled_by: null,
        cancelled_by_name: null,
        cancel_reason: null,
        updated_at: NOW,
      }).lines[0]!.restock,
    ).toBe(true)
  })

  it('bootstrap and sync result', () => {
    const boot = PosBootstrapSchema.parse({
      mode: 'full',
      cursor: '2026-10-20T04:40:00.000Z',
      server_time: NOW,
      tenant: {
        id: id(),
        name: 'Murugan Stores',
        name_ta: null,
        legal_name: null,
        business_type: 'general_store',
        gst_scheme: 'regular',
        gstin: '33AAPFU0939F1Z2',
        state_code: '33',
        timezone: 'Asia/Kolkata',
        fy_start_month: 4,
        logo_url: null,
      },
      store: {
        id: STORE,
        code: 'S1',
        name: 'Main',
        name_ta: null,
        state_code: '33',
        gstin: null,
        address: {},
        phone: null,
        drug_license_numbers: null,
        fssai_number: null,
      },
      register: {
        id: REGISTER,
        code: 'A',
        name: 'Counter A',
        settings: RegisterSettingsSchema.parse({}),
      },
      doc_type: 'tax_invoice',
      tax_mode: 'regular',
      settings: DEFAULT_SETTINGS,
      features: ['pos', 'upi_static'],
      series: {
        doc_type: 'sales_invoice',
        series_id: null,
        prefix: 'S1-A/2627/',
        next_number: 1,
        padding: 5,
        fy: '2026-27',
        next: 'S1-A/2627/00001',
      },
      open_shift: null,
      shift_required: false,
      quick_keys: [PRODUCT],
      categories: [
        {
          id: id(),
          parent_id: null,
          name: 'Rice',
          name_ta: 'அரிசி',
          sort_order: 1,
          is_active: true,
        },
      ],
      products: [
        {
          id: PRODUCT,
          parent_id: null,
          kind: 'standard',
          sku: 'RICE1',
          name: 'Ponni Rice 1 kg',
          name_ta: 'பொன்னி அரிசி 1 கிலோ',
          aliases: ['arisi'],
          category_id: null,
          brand_id: null,
          unit: 'PCS',
          pack_size: 1,
          allow_loose: false,
          decimal_qty: false,
          hsn_code: '1006',
          gst_rate_bp: 500,
          cess_rate_bp: 0,
          tax_slab_rule_id: null,
          price_includes_tax: true,
          mrp_paise: 7_500,
          sale_price_paise: 7_000,
          wholesale_price_paise: null,
          min_sale_price_paise: null,
          max_discount_bp: null,
          track_inventory: true,
          track_batches: false,
          is_weighed: false,
          scale_plu: null,
          variant_attributes: {},
          variant_axes: [],
          attributes: {},
          stock_qty_milli: 48_000,
          reorder_level_milli: 10_000,
          is_active: true,
          updated_at: NOW,
        },
      ],
      barcodes: [{ barcode: '8901234567892', product_id: PRODUCT, qty_milli: 1000 }],
      barcode_product_ids: [PRODUCT],
      store_prices: [],
      store_price_product_ids: [],
      batches: [],
      promotions: [
        {
          id: id(),
          updated_at: NOW,
          data: {
            id: id(),
            name: 'Diwali 5% off',
            kind: 'bill_percent',
            rules: { percent_bp: 500 },
          },
        },
      ],
      tax_slab_rules: [
        {
          id: id(),
          name: 'Apparel',
          slabs: [
            { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
            { max_unit_value_paise: null, gst_rate_bp: 1800 },
          ],
          is_active: true,
        },
      ],
      payment_providers: [
        {
          id: id(),
          store_id: null,
          provider: 'upi_vpa',
          display_name: 'Shop UPI',
          mode: 'live',
          vpa: 'murugan@okaxis',
          payee_name: 'Murugan Stores',
          merchant_code: '5411',
          is_default: true,
          capabilities: {
            dynamic_qr: false,
            links: false,
            webhooks: false,
            polling: false,
            refunds: false,
            manual_confirm: true,
            implemented: true,
          },
        },
      ],
      customers: [
        {
          id: CUSTOMER,
          name: 'Murugan',
          name_ta: null,
          phone: '+919876543210',
          customer_type: 'retail',
          price_tier: 'retail',
          gstin: null,
          state_code: null,
          balance_paise: 4_000,
          credit_limit_paise: null,
          loyalty_points: 12,
        },
      ],
      removed_product_ids: [],
      removed_barcodes: [],
      removed_batch_ids: [],
      removed_promotion_ids: [],
    })
    expect(boot.promotions[0]!.data.stackable).toBe(false)
    expect(boot.register?.settings.scale.enabled).toBe(false)
    const sync = PosSyncResultSchema.parse({
      results: [
        {
          kind: 'invoice',
          client_ref: id(),
          status: 'renumbered',
          id: id(),
          number: 'S1-A/2627/00044',
          offline_number: 'S1-A/2627/00043',
          error: null,
          warnings: [
            { code: 'offline_negative_stock', severity: 'warning', line_key: 'a', params: {} },
          ],
        },
        {
          kind: 'credit_note',
          client_ref: id(),
          status: 'failed',
          id: null,
          number: null,
          offline_number: null,
          error: {
            code: 'UNPROCESSABLE',
            message: 'Return exceeds the sold quantity',
            details: null,
          },
          warnings: [],
        },
      ],
      created: 0,
      duplicates: 0,
      renumbered: 1,
      failed: 1,
      series: null,
    })
    expect(sync.results).toHaveLength(2)
  })
})

describe('sales route catalogue', () => {
  it('builds URLs', () => {
    expect(routeUrl(salesRoutes.printInvoice, { id: 'x' })).toBe('/api/v1/sales/invoices/x/print')
    expect(routeUrl(salesRoutes.publicInvoice, { shareToken: 'tok' })).toBe(
      '/public/v1/invoices/tok',
    )
  })
})
