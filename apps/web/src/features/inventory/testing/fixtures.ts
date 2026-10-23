/**
 * Contract-shaped fixtures for the inventory screens (Vitest + MSW tests and the screenshot
 * harness). Imports only @kadai/shared so it also runs outside Vite; every factory returns data
 * that parses with the response schemas of the contracts (checked in fixtures.test.ts).
 */
import type { Category, ProductListItem, ProductLookupResult } from '@kadai/shared/api/catalog'
import type {
  AdjustmentLine,
  BatchRow,
  BatchStock,
  MovementRow,
  ProductStock,
  StockAdjustment,
  StockAdjustmentDetail,
  StockAlerts,
  StockRow,
  StockTotals,
  StockTransfer,
  StockTransferDetail,
  TransferLine,
} from '@kadai/shared/api/inventory'
import type { Store } from '@kadai/shared/api/identity'
import type { SupplierListItem } from '@kadai/shared/api/parties'

export const NOW = '2026-10-20T10:00:00.000Z'
export const TODAY = '2026-10-20'
/** Stores of the signed-in test member (src/test/fixtures IDS.store / IDS.store2). */
export const STORE_ID = '0192f0a0-0000-7000-8000-000000000301'
export const STORE2_ID = '0192f0a0-0000-7000-8000-000000000302'
export const USER_ID = '0192f0a0-0000-7000-8000-000000000001'

/** Deterministic UUID v7-shaped ids. */
export function iid(n: number): string {
  return `0192f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`
}

export const page = (total: number, limit = 50, offset = 0) => ({ limit, offset, total })

/** Product ids of the fixture catalogue. */
export const P = {
  rice: iid(7001),
  oil: iid(7002),
  sambar: iid(7003),
  paracetamol: iid(7004),
  ghee: iid(7005),
  soap: iid(7006),
} as const

/** Batch ids of the fixture batches. */
export const B = {
  para1: iid(7101),
  para2: iid(7102),
  ghee1: iid(7103),
} as const

export const CATEGORY_ID = iid(7201)
export const SUPPLIER_ID = iid(7301)

// ---------------------------------------------------------------------------------------------
// Catalog (used by pickers)
// ---------------------------------------------------------------------------------------------

export function product(over: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: P.rice,
    parent_id: null,
    kind: 'standard',
    sku: 'RICE-25',
    name: 'Ponni Rice 25 kg',
    name_ta: 'பொன்னி அரிசி 25 கிலோ',
    category_id: CATEGORY_ID,
    category_name: 'Rice',
    category_path: 'Grocery > Rice',
    brand_id: null,
    brand_name: null,
    unit: 'PCS',
    pack_size: 1,
    hsn_code: '1006',
    gst_rate_bp: 500,
    tax_slab_rule_id: null,
    price_includes_tax: true,
    mrp_paise: 165_000,
    sale_price_paise: 152_000,
    purchase_price_paise: 138_000,
    track_inventory: true,
    track_batches: false,
    is_active: true,
    image_file_id: null,
    primary_barcode: '8901234500017',
    variant_attributes: {},
    variant_count: 0,
    reorder_level_milli: 5_000,
    stock_qty_milli: 18_000,
    low_stock: false,
    updated_at: NOW,
    ...over,
  }
}

export function catalog(): ProductListItem[] {
  return [
    product(),
    product({
      id: P.oil,
      sku: 'OIL-1L',
      name: 'Gold Winner Sunflower Oil 1 L',
      name_ta: 'கோல்டு வின்னர் சூரியகாந்தி எண்ணெய் 1 லி',
      hsn_code: '1512',
      mrp_paise: 18_500,
      sale_price_paise: 17_200,
      purchase_price_paise: 15_400,
      primary_barcode: '8901234500024',
      reorder_level_milli: 24_000,
      stock_qty_milli: 9_000,
      low_stock: true,
    }),
    product({
      id: P.paracetamol,
      sku: 'PARA-500',
      name: 'Paracetamol 500 mg',
      name_ta: 'பாராசிட்டமால் 500 மி.கி',
      category_id: null,
      category_name: null,
      category_path: null,
      unit: 'TAB',
      pack_size: 10,
      hsn_code: '3004',
      gst_rate_bp: 1200,
      mrp_paise: 3_500,
      sale_price_paise: 3_500,
      purchase_price_paise: 2_200,
      track_batches: true,
      primary_barcode: '8901234500031',
      reorder_level_milli: 100_000,
      stock_qty_milli: 235_000,
      low_stock: false,
    }),
  ]
}

/** GET /products/lookup answer for a scanned barcode / typed SKU of a catalogue product. */
export function lookupResult(p: ProductListItem, code: string): ProductLookupResult {
  return {
    match: p.primary_barcode === code ? 'barcode' : 'sku',
    code,
    product: {
      id: p.id,
      parent_id: p.parent_id,
      kind: p.kind,
      sku: p.sku,
      name: p.name,
      name_ta: p.name_ta,
      category_id: p.category_id,
      brand_id: p.brand_id,
      unit: p.unit,
      pack_size: p.pack_size,
      allow_loose: p.pack_size > 1,
      decimal_qty: false,
      hsn_code: p.hsn_code,
      gst_rate_bp: p.gst_rate_bp,
      cess_rate_bp: 0,
      tax_slab_rule_id: p.tax_slab_rule_id,
      price_includes_tax: p.price_includes_tax,
      mrp_paise: p.mrp_paise,
      sale_price_paise: p.sale_price_paise,
      wholesale_price_paise: null,
      min_sale_price_paise: null,
      max_discount_bp: null,
      track_inventory: p.track_inventory,
      track_batches: p.track_batches,
      is_weighed: false,
      variant_attributes: p.variant_attributes,
      attributes: {},
      image_file_id: null,
      is_active: p.is_active,
      store_price_applied: false,
      stock_qty_milli: p.stock_qty_milli,
    },
    qty_milli: null,
    price_paise: null,
    barcode_id: null,
  }
}

export function category(over: Partial<Category> = {}): Category {
  return {
    id: CATEGORY_ID,
    parent_id: null,
    name: 'Rice',
    name_ta: 'அரிசி',
    hsn_code: '1006',
    gst_rate_bp: 500,
    tax_slab_rule_id: null,
    sort_order: 1,
    is_active: true,
    depth: 1,
    path: 'Rice',
    path_ta: 'அரிசி',
    product_count: 4,
    child_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function supplier(over: Partial<SupplierListItem> = {}): SupplierListItem {
  return {
    id: SUPPLIER_ID,
    code: 'SUP-1',
    name: 'Sri Balaji Pharma Distributors',
    contact_person: 'Balaji',
    phone: '+919443012345',
    gstin: null,
    state_code: '33',
    drug_license_no: 'TN-MDU-20B-1234',
    payment_terms_days: 30,
    balance_paise: 0,
    overdue_paise: 0,
    upi_vpa: null,
    is_active: true,
    last_bill_date: '2026-09-28',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

/** Stores of the business (GET /stores — every store, also those outside a member's scope). */
export function stores(): Store[] {
  const base = {
    gstin: '33AAAPL1234C1ZV',
    state_code: '33',
    phone: null,
    email: null,
    drug_license_numbers: null,
    fssai_number: null,
    is_active: true,
    register_count: 1,
    created_at: NOW,
    updated_at: NOW,
  }
  return [
    {
      ...base,
      id: STORE_ID,
      code: 'S1',
      name: 'Main store',
      name_ta: 'முதன்மைக் கிளை',
      address: {
        line1: '12 East Masi Street',
        line2: undefined,
        city: 'Madurai',
        district: 'Madurai',
        state_code: '33',
        pincode: '625001',
      },
    },
    {
      ...base,
      id: STORE2_ID,
      code: 'S2',
      name: 'Anna Nagar',
      name_ta: 'அண்ணா நகர்',
      address: {
        line1: '4 Second Avenue',
        line2: undefined,
        city: 'Madurai',
        district: 'Madurai',
        state_code: '33',
        pincode: '625020',
      },
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------------------------

export function stockRow(over: Partial<StockRow> = {}): StockRow {
  return {
    store_id: STORE_ID,
    product_id: P.rice,
    sku: 'RICE-25',
    name: 'Ponni Rice 25 kg',
    name_ta: 'பொன்னி அரிசி 25 கிலோ',
    unit: 'PCS',
    pack_size: 1,
    allow_loose: false,
    track_batches: false,
    category_id: CATEGORY_ID,
    category_name: 'Rice',
    brand_name: null,
    batch_id: null,
    batch_no: null,
    expiry_date: null,
    qty_milli: 18_000,
    avg_cost_paise: 138_000,
    value_cost_paise: 2_484_000,
    mrp_paise: 165_000,
    value_mrp_paise: 2_970_000,
    sale_price_paise: 152_000,
    reorder_level_milli: 5_000,
    reorder_qty_milli: 20_000,
    status: 'ok',
    batch_count: 0,
    nearest_expiry: null,
    last_movement_at: '2026-10-19T12:30:00.000Z',
    ...over,
  }
}

export function stockRows(): StockRow[] {
  return [
    stockRow(),
    stockRow({
      product_id: P.oil,
      sku: 'OIL-1L',
      name: 'Gold Winner Sunflower Oil 1 L',
      name_ta: 'கோல்டு வின்னர் சூரியகாந்தி எண்ணெய் 1 லி',
      category_id: null,
      category_name: 'Oil',
      qty_milli: 9_000,
      avg_cost_paise: 15_400,
      value_cost_paise: 138_600,
      mrp_paise: 18_500,
      value_mrp_paise: 166_500,
      sale_price_paise: 17_200,
      reorder_level_milli: 24_000,
      reorder_qty_milli: 48_000,
      status: 'low',
    }),
    stockRow({
      product_id: P.paracetamol,
      sku: 'PARA-500',
      name: 'Paracetamol 500 mg',
      name_ta: 'பாராசிட்டமால் 500 மி.கி',
      unit: 'TAB',
      pack_size: 10,
      allow_loose: true,
      track_batches: true,
      category_id: null,
      category_name: 'Medicines',
      qty_milli: 235_000,
      avg_cost_paise: 2_200,
      value_cost_paise: 51_700,
      mrp_paise: 3_500,
      value_mrp_paise: 82_250,
      sale_price_paise: 3_500,
      reorder_level_milli: 100_000,
      reorder_qty_milli: 300_000,
      status: 'ok',
      batch_count: 2,
      nearest_expiry: '2026-11-30',
    }),
    stockRow({
      product_id: P.sambar,
      sku: 'SAMBAR-100',
      name: 'Aachi Sambar Powder 100 g',
      name_ta: 'ஆச்சி சாம்பார் பொடி 100 கி',
      category_id: null,
      category_name: 'Masala',
      qty_milli: 0,
      avg_cost_paise: 4_100,
      value_cost_paise: 0,
      mrp_paise: 5_000,
      value_mrp_paise: 0,
      sale_price_paise: 4_800,
      reorder_level_milli: 12_000,
      reorder_qty_milli: 36_000,
      status: 'out',
    }),
    stockRow({
      product_id: P.soap,
      sku: 'HAMAM-100',
      name: 'Hamam Soap 100 g',
      name_ta: 'ஹமாம் சோப் 100 கி',
      category_id: null,
      category_name: 'Personal care',
      qty_milli: -2_000,
      avg_cost_paise: 3_300,
      value_cost_paise: -6_600,
      mrp_paise: 4_200,
      value_mrp_paise: -8_400,
      sale_price_paise: 4_000,
      reorder_level_milli: null,
      reorder_qty_milli: null,
      status: 'negative',
    }),
  ]
}

export function stockTotals(over: Partial<StockTotals> = {}): StockTotals {
  return {
    item_count: 5,
    value_cost_paise: 2_667_700,
    value_mrp_paise: 3_210_350,
    low_stock_count: 1,
    out_of_stock_count: 1,
    negative_count: 1,
    ...over,
  }
}

export function stockList(rows: StockRow[] = stockRows(), total = rows.length) {
  return { data: rows, page: page(total), totals: stockTotals({ item_count: total }) }
}

export function stockAlerts(over: Partial<StockAlerts> = {}): StockAlerts {
  return {
    store_id: STORE_ID,
    as_of: TODAY,
    expiry_warning_days: 90,
    counts: { low_stock: 1, out_of_stock: 1, negative: 1, expiring: 2, expired: 1 },
    low_stock: [],
    out_of_stock: [],
    expiring: [],
    expired: [],
    expiring_value_paise: 31_350,
    expired_value_paise: 4_400,
    ...over,
  }
}

export function batchStock(over: Partial<BatchStock> = {}): BatchStock {
  return {
    batch_id: B.para1,
    batch_no: 'PCM2408',
    expiry_date: '2026-11-30',
    mfg_date: '2024-12-01',
    mrp_paise: 3_500,
    sale_price_paise: 3_500,
    qty_milli: 85_000,
    avg_cost_paise: 2_200,
    value_cost_paise: 18_700,
    expiry_status: 'expiring',
    days_to_expiry: 41,
    ...over,
  }
}

export function movement(over: Partial<MovementRow> = {}): MovementRow {
  return {
    id: iid(7401),
    created_at: '2026-10-19T12:30:00.000Z',
    store_id: STORE_ID,
    store_code: 'S1',
    product_id: P.rice,
    product_name: 'Ponni Rice 25 kg',
    product_name_ta: 'பொன்னி அரிசி 25 கிலோ',
    sku: 'RICE-25',
    unit: 'PCS',
    pack_size: 1,
    batch_id: null,
    batch_no: null,
    movement_type: 'sale',
    qty_milli: -2_000,
    unit_cost_paise: 138_000,
    value_paise: -276_000,
    balance_after_milli: 18_000,
    ref_type: 'sales_invoice',
    ref_id: iid(7501),
    ref_line_id: iid(7502),
    ref_number: 'S1-A/2627/00042',
    reason: null,
    created_by: USER_ID,
    user_name: 'Murugan K',
    ...over,
  }
}

export function movements(): MovementRow[] {
  return [
    movement(),
    movement({
      id: iid(7402),
      created_at: '2026-10-18T09:15:00.000Z',
      movement_type: 'purchase',
      qty_milli: 10_000,
      value_paise: 1_380_000,
      balance_after_milli: 20_000,
      ref_type: 'purchase_bill',
      ref_id: iid(7503),
      ref_line_id: iid(7504),
      ref_number: 'PB/2627/00007',
    }),
    movement({
      id: iid(7403),
      created_at: '2026-10-17T18:40:00.000Z',
      movement_type: 'damage',
      qty_milli: -1_000,
      value_paise: -138_000,
      balance_after_milli: 10_000,
      ref_type: 'stock_adjustment',
      ref_id: iid(7601),
      ref_line_id: null,
      ref_number: 'ADJS1/2627/00003',
      reason: 'damaged',
    }),
  ]
}

export function productStock(over: Partial<ProductStock> = {}): ProductStock {
  return {
    product: {
      id: P.paracetamol,
      sku: 'PARA-500',
      name: 'Paracetamol 500 mg',
      name_ta: 'பாராசிட்டமால் 500 மி.கி',
      unit: 'TAB',
      pack_size: 10,
      allow_loose: true,
      track_inventory: true,
      track_batches: true,
      reorder_level_milli: 100_000,
      reorder_qty_milli: 300_000,
      mrp_paise: 3_500,
      sale_price_paise: 3_500,
      purchase_price_paise: 2_200,
    },
    stores: [
      {
        store_id: STORE_ID,
        store_code: 'S1',
        store_name: 'Main store',
        qty_milli: 235_000,
        avg_cost_paise: 2_200,
        value_cost_paise: 51_700,
        status: 'ok',
        batches: [
          batchStock(),
          batchStock({
            batch_id: B.para2,
            batch_no: 'PCM2502',
            expiry_date: '2027-08-31',
            mfg_date: '2025-02-01',
            qty_milli: 150_000,
            value_cost_paise: 33_000,
            expiry_status: 'ok',
            days_to_expiry: 315,
          }),
        ],
      },
    ],
    total_qty_milli: 235_000,
    total_value_cost_paise: 51_700,
    recent_movements: [
      movement({
        product_id: P.paracetamol,
        product_name: 'Paracetamol 500 mg',
        product_name_ta: 'பாராசிட்டமால் 500 மி.கி',
        sku: 'PARA-500',
        unit: 'TAB',
        pack_size: 10,
        batch_id: B.para1,
        batch_no: 'PCM2408',
        qty_milli: -15_000,
        unit_cost_paise: 2_200,
        value_paise: -3_300,
        balance_after_milli: 85_000,
      }),
    ],
    ...over,
  }
}

// ---------------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------------

export function batch(over: Partial<BatchRow> = {}): BatchRow {
  return {
    id: B.para1,
    product_id: P.paracetamol,
    product_name: 'Paracetamol 500 mg',
    product_name_ta: 'பாராசிட்டமால் 500 மி.கி',
    sku: 'PARA-500',
    unit: 'TAB',
    pack_size: 10,
    batch_no: 'PCM2408',
    mfg_date: '2024-12-01',
    expiry_date: '2026-11-30',
    mrp_paise: 3_500,
    purchase_price_paise: 2_200,
    sale_price_paise: 3_500,
    supplier_id: SUPPLIER_ID,
    supplier_name: 'Sri Balaji Pharma Distributors',
    is_active: true,
    qty_milli: 85_000,
    value_cost_paise: 18_700,
    expiry_status: 'expiring',
    days_to_expiry: 41,
    created_at: '2025-01-10T10:00:00.000Z',
    updated_at: NOW,
    ...over,
  }
}

export function batches(): BatchRow[] {
  return [
    batch({
      id: B.ghee1,
      product_id: P.ghee,
      product_name: 'Aavin Ghee 500 ml',
      product_name_ta: 'ஆவின் நெய் 500 மி.லி',
      sku: 'GHEE-500',
      unit: 'PCS',
      pack_size: 1,
      batch_no: 'AV0926',
      mfg_date: '2026-03-10',
      expiry_date: '2026-10-12',
      mrp_paise: 36_000,
      purchase_price_paise: 31_000,
      sale_price_paise: 35_000,
      supplier_id: iid(7302),
      supplier_name: 'Aavin Dairy Agency',
      qty_milli: 3_000,
      value_cost_paise: 93_000,
      expiry_status: 'expired',
      days_to_expiry: -8,
    }),
    batch(),
    batch({
      id: B.para2,
      batch_no: 'PCM2502',
      mfg_date: '2025-02-01',
      expiry_date: '2027-08-31',
      qty_milli: 150_000,
      value_cost_paise: 33_000,
      expiry_status: 'ok',
      days_to_expiry: 315,
    }),
  ]
}

// ---------------------------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------------------------

export const ADJ_ID = iid(7601)
export const ADJ_DRAFT_ID = iid(7602)

export function adjustment(over: Partial<StockAdjustment> = {}): StockAdjustment {
  return {
    id: ADJ_ID,
    number: 'ADJS1/2627/00003',
    fy: '2026-27',
    store_id: STORE_ID,
    store_code: 'S1',
    store_name: 'Main store',
    adjustment_date: '2026-10-17',
    kind: 'damage',
    status: 'posted',
    notes: 'Rain water leak in godown',
    total_value_paise: -138_000,
    line_count: 1,
    posted_at: '2026-10-17T18:40:00.000Z',
    posted_by: USER_ID,
    posted_by_name: 'Murugan K',
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    created_at: '2026-10-17T18:30:00.000Z',
    updated_at: '2026-10-17T18:40:00.000Z',
    ...over,
  }
}

export function adjustmentLine(over: Partial<AdjustmentLine> = {}): AdjustmentLine {
  return {
    id: iid(7651),
    line_no: 1,
    product_id: P.rice,
    product_name: 'Ponni Rice 25 kg',
    product_name_ta: 'பொன்னி அரிசி 25 கிலோ',
    sku: 'RICE-25',
    unit: 'PCS',
    pack_size: 1,
    track_batches: false,
    batch_id: null,
    batch_no: null,
    expiry_date: null,
    system_qty_milli: null,
    counted_qty_milli: null,
    qty_delta_milli: -1_000,
    unit_cost_paise: 138_000,
    value_paise: -138_000,
    reason: 'damaged',
    current_qty_milli: null,
    ...over,
  }
}

export function adjustmentDetail(over: Partial<StockAdjustmentDetail> = {}): StockAdjustmentDetail {
  return {
    ...adjustment(),
    lines: [adjustmentLine()],
    gain_value_paise: 0,
    loss_value_paise: 138_000,
    movements: [movements()[2]!],
    journal_entry_id: iid(7690),
    cancelled_at: null,
    cancelled_by_name: null,
    cancel_reason: null,
    ...over,
  }
}

/** List row of the draft stock take below. */
export function draftAdjustmentRow(): StockAdjustment {
  return adjustment({
    id: ADJ_DRAFT_ID,
    number: null,
    fy: null,
    kind: 'stock_take',
    status: 'draft',
    notes: null,
    adjustment_date: TODAY,
    total_value_paise: -15_400,
    line_count: 2,
    posted_at: null,
    posted_by: null,
    posted_by_name: null,
    updated_at: NOW,
  })
}

export function draftStockTake(): StockAdjustmentDetail {
  return adjustmentDetail({
    id: ADJ_DRAFT_ID,
    number: null,
    fy: null,
    kind: 'stock_take',
    status: 'draft',
    notes: null,
    adjustment_date: TODAY,
    total_value_paise: -15_400,
    line_count: 2,
    posted_at: null,
    posted_by: null,
    posted_by_name: null,
    updated_at: NOW,
    lines: [
      adjustmentLine({
        id: iid(7661),
        qty_delta_milli: 0,
        counted_qty_milli: 18_000,
        value_paise: 0,
        reason: null,
        current_qty_milli: 18_000,
      }),
      adjustmentLine({
        id: iid(7662),
        line_no: 2,
        product_id: P.oil,
        product_name: 'Gold Winner Sunflower Oil 1 L',
        product_name_ta: 'கோல்டு வின்னர் சூரியகாந்தி எண்ணெய் 1 லி',
        sku: 'OIL-1L',
        qty_delta_milli: -1_000,
        counted_qty_milli: 8_000,
        unit_cost_paise: 15_400,
        value_paise: -15_400,
        reason: 'count_correction',
        current_qty_milli: 9_000,
      }),
    ],
    gain_value_paise: 0,
    loss_value_paise: 15_400,
    movements: [],
    journal_entry_id: null,
  })
}

// ---------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------

export const TRANSFER_ID = iid(7801)

export function transfer(over: Partial<StockTransfer> = {}): StockTransfer {
  return {
    id: TRANSFER_ID,
    number: 'TRS1/2627/00003',
    fy: '2026-27',
    from_store_id: STORE_ID,
    from_store_code: 'S1',
    from_store_name: 'Main store',
    to_store_id: STORE2_ID,
    to_store_code: 'S2',
    to_store_name: 'Anna Nagar',
    transfer_date: '2026-10-19',
    status: 'dispatched',
    notes: 'For Deepavali rush',
    line_count: 2,
    total_value_paise: 1_536_000,
    shortfall_value_paise: 0,
    dispatched_at: '2026-10-19T08:00:00.000Z',
    dispatched_by_name: 'Murugan K',
    received_at: null,
    received_by_name: null,
    created_by_name: 'Murugan K',
    created_at: '2026-10-19T07:30:00.000Z',
    updated_at: '2026-10-19T08:00:00.000Z',
    ...over,
  }
}

export function transferLine(over: Partial<TransferLine> = {}): TransferLine {
  return {
    id: iid(7851),
    line_no: 1,
    product_id: P.rice,
    product_name: 'Ponni Rice 25 kg',
    product_name_ta: 'பொன்னி அரிசி 25 கிலோ',
    sku: 'RICE-25',
    unit: 'PCS',
    pack_size: 1,
    track_batches: false,
    batch_id: null,
    batch_no: null,
    expiry_date: null,
    qty_milli: 10_000,
    received_qty_milli: null,
    shortfall_qty_milli: 0,
    unit_cost_paise: 138_000,
    value_paise: 1_380_000,
    available_qty_milli: null,
    ...over,
  }
}

export function transferDetail(over: Partial<StockTransferDetail> = {}): StockTransferDetail {
  return {
    ...transfer(),
    lines: [
      transferLine(),
      transferLine({
        id: iid(7852),
        line_no: 2,
        product_id: P.oil,
        product_name: 'Gold Winner Sunflower Oil 1 L',
        product_name_ta: 'கோல்டு வின்னர் சூரியகாந்தி எண்ணெய் 1 லி',
        sku: 'OIL-1L',
        qty_milli: 12_000,
        unit_cost_paise: 13_000,
        value_paise: 156_000,
      }),
    ],
    timeline: [
      {
        event: 'created',
        at: '2026-10-19T07:30:00.000Z',
        user_id: USER_ID,
        user_name: 'Murugan K',
        note: null,
      },
      {
        event: 'dispatched',
        at: '2026-10-19T08:00:00.000Z',
        user_id: USER_ID,
        user_name: 'Murugan K',
        note: null,
      },
    ],
    ...over,
  }
}
