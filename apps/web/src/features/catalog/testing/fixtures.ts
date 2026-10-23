/**
 * Catalog fixtures for component tests and MSW handlers. Every factory parses its result with the
 * contract schema, so handlers answer exactly what the real server must answer.
 */
import {
  BrandSchema,
  type Brand,
  CategoryNodeSchema,
  type CategoryNode,
  ProductDetailSchema,
  type ProductDetail,
  ProductListItemSchema,
  type ProductListItem,
  PromotionResponseSchema,
  type PromotionResponse,
  TaxSlabRuleSchema,
  type TaxSlabRule,
} from '@kadai/shared/api/catalog'
import { ImportJobSchema, type ImportJob } from '@kadai/shared/api/identity'

export const NOW = '2026-10-20T10:00:00.000Z'

let seq = 0
/** Deterministic UUID v7-shaped ids. */
export const uid = (): string => `0192f0a0-0000-7000-8000-${String(++seq + 5000).padStart(12, '0')}`

export const page = (total: number, limit = 50, offset = 0) => ({ limit, offset, total })

export function productItem(over: Partial<ProductListItem> = {}): ProductListItem {
  return ProductListItemSchema.parse({
    id: uid(),
    parent_id: null,
    kind: 'standard',
    sku: 'RICE-1',
    name: 'Ponni Rice 1 kg',
    name_ta: 'பொன்னி அரிசி 1 கிலோ',
    category_id: null,
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
    mrp_paise: 7_200,
    sale_price_paise: 6_800,
    purchase_price_paise: 6_000,
    track_inventory: true,
    track_batches: false,
    is_active: true,
    image_file_id: null,
    primary_barcode: '8901234567890',
    variant_attributes: {},
    variant_count: 0,
    reorder_level_milli: 5_000,
    stock_qty_milli: 24_000,
    low_stock: false,
    updated_at: NOW,
    ...over,
  })
}

export function productDetail(over: Partial<ProductDetail> = {}): ProductDetail {
  const id = over.id ?? uid()
  return ProductDetailSchema.parse({
    id,
    parent_id: null,
    kind: 'standard',
    sku: 'RICE-1',
    name: 'Ponni Rice 1 kg',
    name_ta: 'பொன்னி அரிசி 1 கிலோ',
    aliases: ['arisi'],
    description: null,
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
    mrp_paise: 7_200,
    sale_price_paise: 6_800,
    wholesale_price_paise: null,
    purchase_price_paise: 6_000,
    min_sale_price_paise: null,
    max_discount_bp: null,
    track_inventory: true,
    track_batches: false,
    is_weighed: false,
    scale_plu: null,
    reorder_level_milli: 5_000,
    reorder_qty_milli: null,
    variant_attributes: {},
    variant_axes: [],
    attributes: {},
    image_file_id: null,
    is_active: true,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
    category: null,
    brand: null,
    tax_slab_rule: null,
    barcodes: [
      {
        id: uid(),
        product_id: id,
        barcode: '8901234567890',
        qty_milli: 1000,
        is_internal: false,
        created_at: NOW,
      },
    ],
    primary_barcode: '8901234567890',
    parent: null,
    variants: [],
    stock_qty_milli: 24_000,
    ...over,
  })
}

export function category(over: Partial<CategoryNode> = {}): CategoryNode {
  return CategoryNodeSchema.parse({
    id: uid(),
    parent_id: null,
    name: 'Grocery',
    name_ta: 'மளிகை',
    hsn_code: null,
    gst_rate_bp: null,
    tax_slab_rule_id: null,
    sort_order: 0,
    is_active: true,
    depth: 1,
    path: 'Grocery',
    path_ta: 'மளிகை',
    product_count: 0,
    child_count: 0,
    created_at: NOW,
    updated_at: NOW,
    children: [],
    ...over,
  })
}

export function brand(over: Partial<Brand> = {}): Brand {
  return BrandSchema.parse({
    id: uid(),
    name: 'Aachi',
    is_active: true,
    product_count: 3,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  })
}

export function slabRule(over: Partial<TaxSlabRule> = {}): TaxSlabRule {
  return TaxSlabRuleSchema.parse({
    id: uid(),
    name: 'Readymade garments',
    description: null,
    slabs: [
      { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
      { max_unit_value_paise: null, gst_rate_bp: 1800 },
    ],
    is_active: true,
    product_count: 4,
    category_count: 1,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  })
}

export function promotion(over: Record<string, unknown> = {}): PromotionResponse {
  return PromotionResponseSchema.parse({
    id: uid(),
    name: 'Deepavali 10% off',
    name_ta: 'தீபாவளி 10% தள்ளுபடி',
    store_ids: null,
    starts_at: null,
    ends_at: null,
    days_of_week: null,
    priority: 0,
    stackable: false,
    is_active: true,
    status: 'active',
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
    kind: 'bill_percent',
    rules: { percent_bp: 1000 },
    ...over,
  })
}

export function importJob(over: Partial<ImportJob> = {}): ImportJob {
  return ImportJobSchema.parse({
    id: uid(),
    kind: 'products',
    status: 'completed',
    file_id: uid(),
    filename: 'products.csv',
    store_id: null,
    mode: 'upsert',
    dry_run: true,
    options: {},
    total_rows: 3,
    success_rows: 2,
    error_rows: 1,
    progress_bp: 10_000,
    errors: [{ row: 3, field: 'sale_price', code: 'money_invalid', message: 'not a number' }],
    errors_truncated: false,
    summary: { created: 2, updated: 0, unchanged: 0, skipped: 0, details: {} },
    preview: [
      { row: 2, action: 'create', key: 'RICE-1', name: 'Ponni Rice 1 kg' },
      { row: 3, action: 'error', key: 'DAL-1', name: 'Toor Dal' },
    ],
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
    finished_at: NOW,
    ...over,
  })
}
