/**
 * Contract-shaped fixtures for the purchases screens (Vitest + MSW tests and the screenshot
 * harness). Imports only @kadai/shared, so it also runs outside Vite. Amounts are computed with
 * the shared maths (purchaseBillTotals / computePurchaseLine), and every factory's output parses
 * with the contract response schemas (fixtures.test.ts).
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import type { BatchRow } from '@kadai/shared/api/inventory'
import type { Supplier, SupplierListItem } from '@kadai/shared/api/parties'
import type { PaymentDetail } from '@kadai/shared/api/payments'
import {
  type BillReturnableResponse,
  type DebitNoteDetail,
  type DebitNoteListResponseSchema,
  type DebitNotePrefill,
  type PurchaseBillDetail,
  type PurchaseBillListResponseSchema,
  type PurchaseBillListRow,
  type PurchaseOrderDetail,
  type PurchaseOrderListRow,
  type ReorderSuggestions,
  purchaseBillTotals,
} from '@kadai/shared/api/purchases'
import { makeGstin } from '@kadai/shared/gst'
import { computePurchaseLine } from '@kadai/shared/pricing'
import type { z } from 'zod'

export type BillListResponse = z.output<typeof PurchaseBillListResponseSchema>
export type DebitNoteListResponse = z.output<typeof DebitNoteListResponseSchema>

export const NOW = '2026-10-20T10:00:00.000Z'
export const TODAY = '2026-10-20'
/** Main store / user of src/test/fixtures (makeMe). */
export const STORE_ID = '0192f0a0-0000-7000-8000-000000000301'
export const USER_ID = '0192f0a0-0000-7000-8000-000000000001'

/** Deterministic UUID v7-shaped ids. */
export function pid(n: number): string {
  return `0192f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`
}

export const page = (total: number, limit = 50, offset = 0) => ({ limit, offset, total })

export const IDS = {
  supplier: pid(2001),
  supplier2: pid(2002),
  atta: pid(3001),
  dolo: pid(3002),
  oil: pid(3003),
  newItem: pid(3004),
  batchDolo: pid(4001),
  batchDolo2: pid(4002),
  billPosted: pid(5001),
  billDraft: pid(5002),
  billOverdue: pid(5003),
  order: pid(6001),
  orderDraft: pid(6002),
  note: pid(7001),
  payment: pid(8001),
  file: pid(9001),
}

// ---------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------

export function supplierListItem(over: Partial<SupplierListItem> = {}): SupplierListItem {
  return {
    id: IDS.supplier,
    code: 'SLT',
    name: 'Sri Lakshmi Traders',
    contact_person: 'Ravi',
    phone: '+919443012345',
    gstin: makeGstin('33', 'AAKFS1234B'),
    state_code: '33',
    drug_license_no: null,
    payment_terms_days: 30,
    balance_paise: 2_350_000,
    overdue_paise: 1_250_000,
    upi_vpa: 'srilakshmi@okaxis',
    is_active: true,
    last_bill_date: '2026-10-12',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function supplier2ListItem(): SupplierListItem {
  return supplierListItem({
    id: IDS.supplier2,
    code: 'KPD',
    name: 'Kerala Pharma Distributors',
    contact_person: 'Thomas',
    phone: '+919847011122',
    gstin: makeGstin('32', 'AAHCK4321M'),
    state_code: '32',
    drug_license_no: 'KL-EKM-20B-1234',
    payment_terms_days: 21,
    balance_paise: 0,
    overdue_paise: 0,
    upi_vpa: null,
    last_bill_date: null,
  })
}

export function supplier(over: Partial<Supplier> = {}): Supplier {
  return {
    ...supplierListItem(),
    email: 'accounts@srilakshmi.in',
    pan: 'AAKFS1234B',
    address: {
      line1: '14 Kamarajar Salai',
      line2: undefined,
      city: 'Madurai',
      district: 'Madurai',
      state_code: '33',
      pincode: '625009',
    },
    opening_balance_paise: 0,
    bank_details: { account_name: null, account_no_last4: null, ifsc: null, bank_name: null },
    notes: null,
    created_by: USER_ID,
    ...over,
  }
}

const supplierRef = (s: SupplierListItem = supplierListItem()) => ({
  id: s.id,
  name: s.name,
  phone: s.phone,
  gstin: s.gstin,
  state_code: s.state_code,
  address: {
    line1: '14 Kamarajar Salai',
    line2: undefined,
    city: 'Madurai',
    district: 'Madurai',
    state_code: s.state_code ?? undefined,
    pincode: '625009',
  },
  drug_license_no: s.drug_license_no,
  balance_paise: s.balance_paise,
  payment_terms_days: s.payment_terms_days,
})

// ---------------------------------------------------------------------------------------------
// Products & batches
// ---------------------------------------------------------------------------------------------

export function product(over: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: IDS.atta,
    parent_id: null,
    kind: 'standard',
    sku: 'ATTA5',
    name: 'Aashirvaad Atta 5 kg',
    name_ta: 'ஆசீர்வாத் கோதுமை மாவு 5 கிலோ',
    category_id: null,
    category_name: null,
    category_path: null,
    brand_id: null,
    brand_name: null,
    unit: 'PCS',
    pack_size: 1,
    hsn_code: '1101',
    gst_rate_bp: 500,
    tax_slab_rule_id: null,
    price_includes_tax: true,
    mrp_paise: 29_000,
    sale_price_paise: 27_500,
    purchase_price_paise: 24_000,
    track_inventory: true,
    track_batches: false,
    is_active: true,
    image_file_id: null,
    primary_barcode: '8901725121112',
    variant_attributes: {},
    variant_count: 0,
    reorder_level_milli: 10_000,
    stock_qty_milli: 6_000,
    low_stock: true,
    updated_at: NOW,
    ...over,
  }
}

/** Pharmacy strip: unit TAB, pack of 15, batch-tracked, prices per strip. */
export function doloProduct(over: Partial<ProductListItem> = {}): ProductListItem {
  return product({
    id: IDS.dolo,
    sku: 'DOLO650',
    name: 'Dolo 650 Tablet',
    name_ta: 'டோலோ 650 மாத்திரை',
    unit: 'TAB',
    pack_size: 15,
    hsn_code: '30049099',
    gst_rate_bp: 1200,
    mrp_paise: 3_360,
    sale_price_paise: 3_360,
    purchase_price_paise: 2_300,
    track_batches: true,
    primary_barcode: '8901234560012',
    reorder_level_milli: 150_000,
    stock_qty_milli: 45_000,
    ...over,
  })
}

export function oilProduct(): ProductListItem {
  return product({
    id: IDS.oil,
    sku: 'GOLDW1L',
    name: 'Gold Winner Sunflower Oil 1 L',
    name_ta: 'கோல்டு வின்னர் சூரியகாந்தி எண்ணெய் 1 லி',
    hsn_code: '1512',
    mrp_paise: 18_500,
    sale_price_paise: 17_500,
    purchase_price_paise: 15_800,
    primary_barcode: '8906001234567',
    stock_qty_milli: 24_000,
    low_stock: false,
  })
}

export function batchRow(over: Partial<BatchRow> = {}): BatchRow {
  return {
    id: IDS.batchDolo,
    product_id: IDS.dolo,
    product_name: 'Dolo 650 Tablet',
    product_name_ta: 'டோலோ 650 மாத்திரை',
    sku: 'DOLO650',
    unit: 'TAB',
    pack_size: 15,
    batch_no: 'DL2409',
    mfg_date: '2024-09-01',
    expiry_date: '2026-11-30',
    mrp_paise: 3_360,
    purchase_price_paise: 2_300,
    sale_price_paise: null,
    supplier_id: IDS.supplier,
    supplier_name: 'Sri Lakshmi Traders',
    is_active: true,
    qty_milli: 45_000,
    value_cost_paise: 6_900,
    expiry_status: 'expiring',
    days_to_expiry: 41,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

const productRef = (p: ProductListItem) => ({
  id: p.id,
  name: p.name,
  name_ta: p.name_ta,
  sku: p.sku,
  unit: p.unit,
  pack_size: p.pack_size,
  hsn_code: p.hsn_code,
  track_batches: p.track_batches,
})

// ---------------------------------------------------------------------------------------------
// Purchase bills
// ---------------------------------------------------------------------------------------------

interface BillLineSpec {
  product: ProductListItem
  qty_milli: number
  free_qty_milli?: number
  unit_cost_paise: number
  discount_bp?: number
  batch_no?: string
  expiry_date?: string
  mrp_paise?: number | null
  sale_price_paise?: number | null
  returned_qty_milli?: number
}

const DEFAULT_BILL_LINES: BillLineSpec[] = [
  { product: product(), qty_milli: 20_000, unit_cost_paise: 24_500, mrp_paise: 29_000 },
  {
    product: doloProduct(),
    qty_milli: 150_000,
    free_qty_milli: 15_000,
    unit_cost_paise: 2_250,
    discount_bp: 200,
    batch_no: 'DL2410',
    expiry_date: '2028-03-31',
    mrp_paise: 3_360,
  },
]

export function bill(
  over: Partial<PurchaseBillDetail> & { lineSpecs?: BillLineSpec[] } = {},
): PurchaseBillDetail {
  const { lineSpecs = DEFAULT_BILL_LINES, ...rest } = over
  const status = rest.status ?? 'posted'
  const isInterstate = rest.is_interstate ?? false
  const otherCharges = rest.other_charges_paise ?? 15_000
  const doc = purchaseBillTotals({
    lines: lineSpecs.map((l, i) => ({
      key: String(i),
      unit_cost_paise: l.unit_cost_paise,
      qty_milli: l.qty_milli,
      free_qty_milli: l.free_qty_milli ?? 0,
      pack_size: l.product.pack_size,
      discount_bp: l.discount_bp ?? 0,
      gst_rate_bp: l.product.gst_rate_bp,
    })),
    is_interstate: isInterstate,
    other_charges_paise: otherCharges,
  })
  const id = rest.id ?? IDS.billPosted
  const lines = lineSpecs.map((l, i) => {
    const r = doc.lines[i]!
    const returned = l.returned_qty_milli ?? 0
    return {
      id: pid(51_000 + i + (id === IDS.billDraft ? 100 : 0)),
      line_no: i + 1,
      product_id: l.product.id,
      product: productRef(l.product),
      purchase_order_line_id: null,
      batch_id: l.batch_no && status === 'posted' ? IDS.batchDolo2 : null,
      batch_no: l.batch_no ?? null,
      mfg_date: null,
      expiry_date: l.expiry_date ?? null,
      hsn_code: l.product.hsn_code,
      unit: l.product.unit,
      pack_size: l.product.pack_size,
      qty_milli: l.qty_milli,
      free_qty_milli: l.free_qty_milli ?? 0,
      mrp_paise: l.mrp_paise ?? null,
      unit_cost_paise: l.unit_cost_paise,
      discount_bp: l.discount_bp ?? 0,
      discount_paise: 0,
      gross_paise: r.gross_paise,
      taxable_paise: r.taxable_paise,
      cgst_paise: r.cgst_paise,
      sgst_paise: r.sgst_paise,
      igst_paise: r.igst_paise,
      cess_paise: r.cess_paise,
      gst_rate_bp: r.gst_rate_bp,
      cess_rate_bp: r.cess_rate_bp,
      total_paise: r.total_paise,
      landed_unit_cost_paise: r.landed_unit_cost_paise,
      sale_price_paise: l.sale_price_paise ?? null,
      returned_qty_milli: returned,
      returnable_qty_milli:
        status === 'posted' ? l.qty_milli + (l.free_qty_milli ?? 0) - returned : 0,
      current: {
        purchase_price_paise: l.product.purchase_price_paise,
        mrp_paise: l.product.mrp_paise,
        sale_price_paise: l.product.sale_price_paise,
        price_includes_tax: l.product.price_includes_tax,
        gst_rate_bp: l.product.gst_rate_bp,
        last_cost_paise: l.product.purchase_price_paise,
        stock_qty_milli: l.product.stock_qty_milli,
      },
    }
  })
  const paid = rest.paid_paise ?? (status === 'posted' ? 500_000 : 0)
  const returnedPaise = rest.returned_paise ?? 0
  const due = status === 'posted' ? doc.total_paise - paid - returnedPaise : 0
  const base: PurchaseBillDetail = {
    id,
    number: status === 'draft' ? null : 'GRNS1/2627/00018',
    fy: status === 'draft' ? null : '2026-27',
    status,
    store_id: STORE_ID,
    supplier_id: IDS.supplier,
    supplier_name: 'Sri Lakshmi Traders',
    supplier_invoice_no: 'SLT/1182',
    supplier_invoice_date: '2026-10-12',
    received_date: '2026-10-13',
    due_date: '2026-11-11',
    purchase_order_id: null,
    purchase_order_number: null,
    line_count: lines.length,
    taxable_paise: doc.taxable_paise,
    tax_paise: doc.tax_paise,
    total_paise: doc.total_paise,
    paid_paise: paid,
    returned_paise: returnedPaise,
    due_paise: due,
    payment_status:
      status !== 'posted' ? 'unpaid' : due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
    overdue: false,
    days_overdue: null,
    posted_at: status === 'draft' ? null : NOW,
    created_at: NOW,
    updated_at: NOW,
    supplier_gstin: supplierListItem().gstin,
    supplier_state_code: '33',
    is_interstate: isInterstate,
    reverse_charge: false,
    itc_eligible: true,
    gross_paise: doc.gross_paise,
    discount_paise: doc.discount_paise,
    cgst_paise: doc.cgst_paise,
    sgst_paise: doc.sgst_paise,
    igst_paise: doc.igst_paise,
    cess_paise: doc.cess_paise,
    other_charges_paise: otherCharges,
    round_off_paise: doc.round_off_paise,
    notes: null,
    attachment_file_id: null,
    supplier: supplierRef(),
    lines,
    tax_breakup: doc.tax_breakup,
    purchase_order: null,
    payments:
      paid > 0 && status === 'posted'
        ? [
            {
              payment_id: IDS.payment,
              number: 'PVS1/2627/00007',
              method: 'upi',
              amount_paise: paid,
              payment_date: '2026-10-14',
              reference: 'UTR 4521',
              status: 'completed',
              origin: 'manual',
            },
          ]
        : [],
    debit_notes: [],
    journal_entry_id: status === 'posted' ? pid(9501) : null,
    posted_by: status === 'draft' ? null : USER_ID,
    posted_by_name: status === 'draft' ? null : 'Murugan K',
    cancelled_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancel_reason: null,
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    warnings: [],
  }
  return { ...base, ...rest }
}

export function draftBill(over: Partial<PurchaseBillDetail> = {}): PurchaseBillDetail {
  return bill({
    id: IDS.billDraft,
    status: 'draft',
    supplier_invoice_no: 'SLT/1190',
    other_charges_paise: 0,
    ...over,
  })
}

export function billRow(b: PurchaseBillDetail): PurchaseBillListRow {
  return {
    id: b.id,
    number: b.number,
    fy: b.fy,
    status: b.status,
    store_id: b.store_id,
    supplier_id: b.supplier_id,
    supplier_name: b.supplier_name,
    supplier_invoice_no: b.supplier_invoice_no,
    supplier_invoice_date: b.supplier_invoice_date,
    received_date: b.received_date,
    due_date: b.due_date,
    purchase_order_id: b.purchase_order_id,
    purchase_order_number: b.purchase_order_number,
    line_count: b.line_count,
    taxable_paise: b.taxable_paise,
    tax_paise: b.tax_paise,
    total_paise: b.total_paise,
    paid_paise: b.paid_paise,
    returned_paise: b.returned_paise,
    due_paise: b.due_paise,
    payment_status: b.payment_status,
    overdue: b.overdue,
    days_overdue: b.days_overdue,
    posted_at: b.posted_at,
    created_at: b.created_at,
    updated_at: b.updated_at,
  }
}

export function overdueBill(): PurchaseBillDetail {
  return bill({
    id: IDS.billOverdue,
    number: 'GRNS1/2627/00011',
    supplier_invoice_no: 'SLT/1101',
    supplier_invoice_date: '2026-09-02',
    received_date: '2026-09-03',
    due_date: '2026-10-02',
    paid_paise: 0,
    overdue: true,
    days_overdue: 18,
    payments: [],
    lineSpecs: [
      { product: oilProduct(), qty_milli: 60_000, unit_cost_paise: 15_800, mrp_paise: 18_500 },
    ],
    other_charges_paise: 0,
  })
}

export function billList(): BillListResponse {
  const rows = [bill(), overdueBill(), draftBill()].map(billRow)
  const posted = rows.filter((r) => r.status === 'posted')
  return {
    data: rows,
    page: page(rows.length),
    summary: {
      count: rows.length,
      total_paise: rows.reduce((s, r) => s + r.total_paise, 0),
      paid_paise: posted.reduce((s, r) => s + r.paid_paise, 0),
      due_paise: posted.reduce((s, r) => s + r.due_paise, 0),
      overdue_paise: posted.filter((r) => r.overdue).reduce((s, r) => s + r.due_paise, 0),
    },
  }
}

export function returnable(b: PurchaseBillDetail = bill()): BillReturnableResponse {
  return {
    bill: {
      id: b.id,
      number: b.number,
      supplier_id: b.supplier_id,
      supplier_name: b.supplier_name,
      supplier_invoice_no: b.supplier_invoice_no,
      received_date: b.received_date,
      status: b.status,
      is_interstate: b.is_interstate,
      total_paise: b.total_paise,
      due_paise: b.due_paise,
    },
    lines: b.lines.map((l) => ({
      bill_line_id: l.id,
      line_no: l.line_no,
      product_id: l.product_id,
      product: l.product,
      batch_id: l.batch_id,
      batch_no: l.batch_no,
      expiry_date: l.expiry_date,
      unit: l.unit,
      pack_size: l.pack_size,
      qty_milli: l.qty_milli,
      free_qty_milli: l.free_qty_milli,
      returned_qty_milli: l.returned_qty_milli,
      returnable_qty_milli: l.returnable_qty_milli,
      available_qty_milli: l.current.stock_qty_milli,
      unit_cost_paise: l.unit_cost_paise,
      landed_unit_cost_paise: l.landed_unit_cost_paise,
      taxable_paise: l.taxable_paise,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_paise: l.cess_paise,
      gst_rate_bp: l.gst_rate_bp,
      cess_rate_bp: l.cess_rate_bp,
      total_paise: l.total_paise,
      credited: { taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, cess_paise: 0 },
    })),
  }
}

// ---------------------------------------------------------------------------------------------
// Purchase orders & reorder
// ---------------------------------------------------------------------------------------------

export function order(over: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail {
  const specs = [
    { p: product(), qty: 40_000, received: 20_000, cost: 24_000 },
    { p: oilProduct(), qty: 24_000, received: 0, cost: 15_800 },
  ]
  const lines = specs.map((s, i) => {
    const r = computePurchaseLine({
      unit_cost_paise: s.cost,
      qty_milli: s.qty,
      pack_size: s.p.pack_size,
      gst_rate_bp: s.p.gst_rate_bp,
      is_interstate: false,
    })
    return {
      id: pid(61_000 + i),
      line_no: i + 1,
      product: productRef(s.p),
      product_id: s.p.id,
      qty_milli: s.qty,
      received_qty_milli: s.received,
      pending_qty_milli: s.qty - s.received,
      unit_cost_paise: s.cost,
      gst_rate_bp: s.p.gst_rate_bp,
      taxable_paise: r.taxable_paise,
      tax_paise: r.tax_paise,
      total_paise: r.total_paise,
      notes: null,
      current_stock_milli: s.p.stock_qty_milli,
      last_cost_paise: s.p.purchase_price_paise,
    }
  })
  const taxable = lines.reduce((s, l) => s + l.taxable_paise, 0)
  const tax = lines.reduce((s, l) => s + l.tax_paise, 0)
  return {
    id: IDS.order,
    number: 'POS1/2627/00004',
    fy: '2026-27',
    order_date: '2026-10-15',
    expected_date: '2026-10-18',
    status: 'partially_received',
    store_id: STORE_ID,
    supplier_id: IDS.supplier,
    supplier_name: 'Sri Lakshmi Traders',
    line_count: lines.length,
    taxable_paise: taxable,
    tax_paise: tax,
    total_paise: taxable + tax,
    received_bp: 3125,
    sent_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    is_interstate: false,
    notes: 'Please send fresh stock',
    terms: 'Payment in 30 days',
    supplier: supplierRef(),
    lines,
    bills: [
      {
        id: IDS.billPosted,
        number: 'GRNS1/2627/00018',
        supplier_invoice_no: 'SLT/1182',
        received_date: '2026-10-13',
        status: 'posted',
        total_paise: bill().total_paise,
      },
    ],
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    ...over,
  }
}

export function draftOrder(over: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail {
  const o = order()
  return {
    ...o,
    id: IDS.orderDraft,
    number: 'POS1/2627/00005',
    status: 'draft',
    received_bp: 0,
    sent_at: null,
    bills: [],
    lines: o.lines.map((l) => ({ ...l, received_qty_milli: 0, pending_qty_milli: l.qty_milli })),
    ...over,
  }
}

export function orderRow(o: PurchaseOrderDetail): PurchaseOrderListRow {
  return {
    id: o.id,
    number: o.number,
    fy: o.fy,
    order_date: o.order_date,
    expected_date: o.expected_date,
    status: o.status,
    store_id: o.store_id,
    supplier_id: o.supplier_id,
    supplier_name: o.supplier_name,
    line_count: o.line_count,
    taxable_paise: o.taxable_paise,
    tax_paise: o.tax_paise,
    total_paise: o.total_paise,
    received_bp: o.received_bp,
    sent_at: o.sent_at,
    created_at: o.created_at,
    updated_at: o.updated_at,
  }
}

export function reorderSuggestions(): ReorderSuggestions {
  const atta = {
    product_id: IDS.atta,
    name: 'Aashirvaad Atta 5 kg',
    name_ta: 'ஆசீர்வாத் கோதுமை மாவு 5 கிலோ',
    sku: 'ATTA5',
    unit: 'PCS',
    pack_size: 1,
    category_id: null,
    current_stock_milli: 6_000,
    reorder_level_milli: 10_000,
    reorder_qty_milli: 20_000,
    avg_daily_sales_milli: 2_000,
    days_of_cover: 3,
    suggested_qty_milli: 20_000,
    open_po_qty_milli: 0,
    last_cost_paise: 24_000,
    last_bill_date: '2026-10-13',
    gst_rate_bp: 500,
    estimated_cost_paise: 480_000,
  }
  const dolo = {
    ...atta,
    product_id: IDS.dolo,
    name: 'Dolo 650 Tablet',
    name_ta: 'டோலோ 650 மாத்திரை',
    sku: 'DOLO650',
    unit: 'TAB',
    pack_size: 15,
    current_stock_milli: 45_000,
    reorder_level_milli: 150_000,
    reorder_qty_milli: null,
    avg_daily_sales_milli: 12_000,
    days_of_cover: 4,
    suggested_qty_milli: 255_000,
    open_po_qty_milli: 30_000,
    last_cost_paise: 2_250,
    gst_rate_bp: 1200,
    estimated_cost_paise: 38_250,
  }
  const fresh = {
    ...atta,
    product_id: IDS.newItem,
    name: 'Aachi Sambar Powder 200 g',
    name_ta: 'ஆச்சி சாம்பார் பொடி 200 கி',
    sku: 'AACHI-SMB',
    current_stock_milli: 0,
    reorder_level_milli: 5_000,
    reorder_qty_milli: 12_000,
    avg_daily_sales_milli: 0,
    days_of_cover: null,
    suggested_qty_milli: 12_000,
    last_cost_paise: null,
    last_bill_date: null,
    estimated_cost_paise: 0,
  }
  return {
    store_id: STORE_ID,
    generated_at: NOW,
    window_days: 30,
    groups: [
      {
        supplier: { id: IDS.supplier, name: 'Sri Lakshmi Traders', phone: '+919443012345' },
        items: [atta, dolo],
        estimated_cost_paise: atta.estimated_cost_paise + dolo.estimated_cost_paise,
      },
      { supplier: null, items: [fresh], estimated_cost_paise: 0 },
    ],
  }
}

// ---------------------------------------------------------------------------------------------
// Debit notes
// ---------------------------------------------------------------------------------------------

export function debitNote(over: Partial<DebitNoteDetail> = {}): DebitNoteDetail {
  const r = computePurchaseLine({
    unit_cost_paise: 2_208,
    qty_milli: 30_000,
    pack_size: 15,
    gst_rate_bp: 1200,
    is_interstate: false,
  })
  return {
    id: IDS.note,
    number: 'DNS1/2627/00003',
    fy: '2026-27',
    note_date: '2026-10-19',
    store_id: STORE_ID,
    supplier_id: IDS.supplier,
    supplier_name: 'Sri Lakshmi Traders',
    bill_id: IDS.billPosted,
    bill_number: 'GRNS1/2627/00018',
    supplier_invoice_no: 'SLT/1182',
    reason: 'expired',
    status: 'completed',
    settlement: 'adjust_due',
    total_paise: r.total_paise,
    line_count: 1,
    created_at: NOW,
    is_interstate: false,
    taxable_paise: r.taxable_paise,
    cgst_paise: r.cgst_paise,
    sgst_paise: r.sgst_paise,
    igst_paise: r.igst_paise,
    cess_paise: r.cess_paise,
    tax_paise: r.tax_paise,
    round_off_paise: 0,
    notes: null,
    supplier: supplierRef(),
    lines: [
      {
        id: pid(71_001),
        line_no: 1,
        bill_line_id: pid(51_001),
        product_id: IDS.dolo,
        product: productRef(doloProduct()),
        batch_id: IDS.batchDolo2,
        batch_no: 'DL2410',
        expiry_date: '2028-03-31',
        hsn_code: '30049099',
        unit: 'TAB',
        pack_size: 15,
        qty_milli: 30_000,
        unit_cost_paise: 2_208,
        taxable_paise: r.taxable_paise,
        cgst_paise: r.cgst_paise,
        sgst_paise: r.sgst_paise,
        igst_paise: r.igst_paise,
        cess_paise: r.cess_paise,
        gst_rate_bp: 1200,
        cess_rate_bp: 0,
        total_paise: r.total_paise,
      },
    ],
    tax_breakup: [
      {
        gst_rate_bp: 1200,
        taxable_paise: r.taxable_paise,
        cgst_paise: r.cgst_paise,
        sgst_paise: r.sgst_paise,
        igst_paise: r.igst_paise,
        cess_paise: r.cess_paise,
      },
    ],
    payments: [],
    journal_entry_id: pid(9502),
    adjusted_paise: r.total_paise,
    cancelled_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancel_reason: null,
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    updated_at: NOW,
    ...over,
  }
}

export function debitNoteList(): DebitNoteListResponse {
  const n = debitNote()
  const cancelled = debitNote({
    id: pid(7002),
    number: 'DNS1/2627/00002',
    note_date: '2026-10-05',
    status: 'cancelled',
    reason: 'damaged',
    settlement: 'refund_cash',
    bill_id: null,
    bill_number: null,
    supplier_invoice_no: null,
  })
  const rows = [n, cancelled].map((d) => ({
    id: d.id,
    number: d.number,
    fy: d.fy,
    note_date: d.note_date,
    store_id: d.store_id,
    supplier_id: d.supplier_id,
    supplier_name: d.supplier_name,
    bill_id: d.bill_id,
    bill_number: d.bill_number,
    supplier_invoice_no: d.supplier_invoice_no,
    reason: d.reason,
    status: d.status,
    settlement: d.settlement,
    total_paise: d.total_paise,
    line_count: d.line_count,
    created_at: d.created_at,
  }))
  return {
    data: rows,
    page: page(rows.length),
    summary: { count: rows.length, total_paise: n.total_paise },
  }
}

export function debitNotePrefill(): DebitNotePrefill {
  return {
    supplier: { id: IDS.supplier, name: 'Sri Lakshmi Traders' },
    lines: [
      {
        product_id: IDS.dolo,
        product: productRef(doloProduct()),
        batch_id: IDS.batchDolo,
        batch_no: 'DL2409',
        expiry_date: '2026-10-15',
        available_qty_milli: 30_000,
        unit_cost_paise: 2_208,
        gst_rate_bp: 1200,
        cess_rate_bp: 0,
        supplier_id: IDS.supplier,
        supplier_name: 'Sri Lakshmi Traders',
        bill_id: IDS.billPosted,
        bill_line_id: pid(51_001),
        bill_number: 'GRNS1/2627/00018',
        returnable_qty_milli: 165_000,
      },
    ],
  }
}

// ---------------------------------------------------------------------------------------------
// Payments & files
// ---------------------------------------------------------------------------------------------

export function paymentDetail(over: Partial<PaymentDetail> = {}): PaymentDetail {
  return {
    id: IDS.payment,
    store_id: STORE_ID,
    register_id: null,
    shift_id: null,
    number: 'PVS1/2627/00008',
    fy: '2026-27',
    direction: 'out',
    party_type: 'supplier',
    party_id: IDS.supplier,
    party_name: 'Sri Lakshmi Traders',
    method: 'cash',
    amount_paise: 100_000,
    allocated_paise: 100_000,
    unallocated_paise: 0,
    status: 'completed',
    payment_date: TODAY,
    paid_at: NOW,
    reference: null,
    payment_intent_id: null,
    account_id: pid(9101),
    account_name: 'Cash',
    notes: null,
    client_ref: null,
    origin: 'manual',
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    created_at: NOW,
    cancelled_at: null,
    cancel_reason: null,
    allocations: [],
    intent: null,
    journal_entry_id: pid(9503),
    cancelled_by_name: null,
    updated_at: NOW,
    ...over,
  }
}
