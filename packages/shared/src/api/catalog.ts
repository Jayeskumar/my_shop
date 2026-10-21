/**
 * Contract for the catalog module — docs/API.md "catalog": categories (tree), brands, tax slab
 * rules, products (vertical attributes, variants, barcodes, lookup, bulk update, CSV import /
 * export), promotions, store prices, barcode labels, units and the HSN directory.
 *
 * Prices on products/batches are per PACK of `pack_size` base units (ARCHITECTURE.md §5);
 * quantities are milli base units. Validation messages of custom rules are snake_case keys
 * (CATALOG_VALIDATION_KEYS). Pure helpers at the bottom of each section are used by the server
 * and the web alike (rules, variant names/SKUs, price changes, slab explanation, import columns).
 */
import { z } from 'zod'
import {
  BusinessTypeSchema,
  ProductKindSchema,
  type BusinessType,
  type ProductKind,
} from '../enums'
import { mulDiv, roundDiv } from '../math'
import { roundToRupee } from '../money'
import { type TaxSlab, TaxSlabSchema, TaxSlabsSchema, resolveSlabRate } from '../pricing'
import { PROMOTION_RULE_SCHEMAS, type PromotionKind, PromotionKindSchema } from '../promotions'
import { INTERNAL_BARCODE_PREFIX, isValidEan13, isValidGtin, normalizePlu } from '../scale'
import { isDecimalUnit, isUnitCode } from '../units'
import {
  type BilingualLabel,
  dataOf,
  defineRoutes,
  listOf,
  PageQuerySchema,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zGstRateBp,
  zHsn,
  zId,
  zPaise,
  zQtyMilli,
  zSearchQuery,
  zTimestamp,
} from './common'
import {
  DeleteResultSchema,
  type ImportColumnDef,
  ImportJobSchema,
  ImportRequestBaseSchema,
  type RuleIssue,
  toCsv,
  zIfUpdatedAt,
  zNullableText,
  zQueryIds,
  zQueryInt,
} from './identity'

// =============================================================================================
// Validation keys (custom rules; generic min/max/required are mapped by the web's zod error map)
// =============================================================================================

export const CATALOG_VALIDATION_KEYS = [
  'hsn',
  'sku_format',
  'unit_unknown',
  'scale_plu_format',
  'barcode_format',
  'barcode_checksum',
  'barcode_or_generate',
  'mrp_below_sale_price',
  'min_price_above_sale_price',
  'loose_requires_pack',
  'decimal_qty_unit',
  'service_tracks_stock',
  'category_cycle',
  'category_depth',
  'slab_last_unbounded',
  'variant_axis',
  'variant_axes_count',
  'variant_duplicate_value',
  'variant_override_match',
  'variant_combinations_limit',
  'price_change_zero',
  'duplicate_id',
  'promotion_dates',
  'promotion_kind_required',
  'promotion_rules_required',
  'store_price_conflict',
  'label_copies_limit',
  'empty_patch',
] as const
export type CatalogValidationKey = (typeof CATALOG_VALIDATION_KEYS)[number]

const notEmpty = (v: Record<string, unknown>) =>
  Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at')

const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length

/** Optional, clearable HSN in bodies: '' / null → null. */
const zNullableHsn = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || zHsn.safeParse(v).success, { message: 'hsn' })
  .transform((v) => (v === '' ? null : v))

/** Lenient slab shape for responses (stored JSON). */
const StoredSlabSchema = z.object({
  max_unit_value_paise: z.int().nullable(),
  gst_rate_bp: z.int().min(0),
})

// =============================================================================================
// Bilingual labels
// =============================================================================================

export type { BilingualLabel } from './common'

export const PRODUCT_KIND_LABELS: Readonly<Record<ProductKind, BilingualLabel>> = {
  standard: { en: 'Product', ta: 'பொருள்' },
  variant_parent: { en: 'Product with variants', ta: 'வகைகள் கொண்ட பொருள்' },
  variant: { en: 'Variant', ta: 'வகை' },
  service: { en: 'Service', ta: 'சேவை' },
}

export const PROMOTION_KIND_LABELS: Readonly<Record<PromotionKind, BilingualLabel>> = {
  item_percent: { en: '% off items', ta: 'பொருட்களுக்கு % தள்ளுபடி' },
  item_flat: { en: '₹ off items', ta: 'பொருட்களுக்கு ₹ தள்ளுபடி' },
  buy_x_get_y: { en: 'Buy X get Y', ta: 'X வாங்கினால் Y' },
  bill_percent: { en: '% off the bill', ta: 'பில்லுக்கு % தள்ளுபடி' },
  bill_flat: { en: '₹ off the bill', ta: 'பில்லுக்கு ₹ தள்ளுபடி' },
  combo_price: { en: 'Combo price', ta: 'காம்போ விலை' },
}

// =============================================================================================
// Categories (tree, max depth 3)
// =============================================================================================

export const MAX_CATEGORY_DEPTH = 3
export const CATEGORY_PATH_SEPARATOR = ' > '

const CategoryShape = {
  id: zId,
  parent_id: zId.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  /** Defaults inherited by new products of the category when they do not set their own. */
  hsn_code: z.string().nullable(),
  gst_rate_bp: z.int().min(0).nullable(),
  tax_slab_rule_id: zId.nullable(),
  sort_order: z.int(),
  is_active: z.boolean(),
  /** 1 = top level … 3. */
  depth: z.int().min(1),
  /** "Grocery > Rice" (Tamil names in path_ta, falling back to English per level). */
  path: z.string(),
  path_ta: z.string(),
  /** Products directly in this category. */
  product_count: z.int().min(0),
  child_count: z.int().min(0),
  created_at: zTimestamp,
  updated_at: zTimestamp,
}

export const CategorySchema = z.object(CategoryShape)
export type Category = z.output<typeof CategorySchema>

export type CategoryNode = Category & { children: CategoryNode[] }
type CategoryNodeInput = z.input<typeof CategorySchema> & { children: CategoryNodeInput[] }

/** Tree node (GET /categories); with ?flat=true every node is returned at top level, children []. */
export const CategoryNodeSchema: z.ZodType<CategoryNode, CategoryNodeInput> = CategorySchema.extend(
  {
    children: z.lazy(() => z.array(CategoryNodeSchema)),
  },
)

export const CategoryRefSchema = z.object({
  id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  path: z.string(),
})
export type CategoryRef = z.output<typeof CategoryRefSchema>

export const CategoryDetailSchema = CategorySchema.extend({
  ancestors: z.array(z.object({ id: zId, name: z.string(), name_ta: z.string().nullable() })),
  tax_slab_rule: z.object({ id: zId, name: z.string() }).nullable(),
})
export type CategoryDetail = z.output<typeof CategoryDetailSchema>

export const CategoryListQuerySchema = z.object({
  flat: zBooleanQuery.default(false).describe('true = flat list ordered by path'),
  is_active: zBooleanQuery.optional(),
  q: zSearchQuery.optional().describe('Name / Tamil name match (implies a flat result)'),
})
export type CategoryListQuery = z.input<typeof CategoryListQuerySchema>

export const CategoryCreateSchema = z.object({
  parent_id: zId.nullable().default(null),
  name: z.string().trim().min(1).max(100),
  name_ta: zNullableText(100),
  hsn_code: zNullableHsn,
  gst_rate_bp: zGstRateBp.nullable().default(null),
  tax_slab_rule_id: zId.nullable().default(null),
  sort_order: z.int().min(0).max(100_000).default(0),
})
export type CategoryCreate = z.input<typeof CategoryCreateSchema>

/** PATCH /categories/:id — moving (parent_id) is checked for cycles and depth. */
export const CategoryUpdateSchema = z
  .object({
    parent_id: zId.nullable().optional(),
    name: z.string().trim().min(1).max(100).optional(),
    name_ta: zNullableText(100),
    hsn_code: zNullableHsn,
    gst_rate_bp: zGstRateBp.nullable().optional(),
    tax_slab_rule_id: zId.nullable().optional(),
    sort_order: z.int().min(0).max(100_000).optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type CategoryUpdate = z.input<typeof CategoryUpdateSchema>

export interface CategoryLike {
  id: string
  parent_id: string | null
  name: string
  name_ta?: string | null
  sort_order?: number
}

export type CategoryTreeNode<T extends CategoryLike> = T & {
  depth: number
  path: string
  path_ta: string
  children: CategoryTreeNode<T>[]
}

/**
 * Builds the tree (roots ordered by sort_order, then name) with depth and display paths.
 * Rows whose parent is missing are treated as roots; cycles are broken (never loops).
 */
export function categoryTree<T extends CategoryLike>(rows: readonly T[]): CategoryTreeNode<T>[] {
  const byParent = new Map<string | null, T[]>()
  const ids = new Set(rows.map((r) => r.id))
  for (const row of rows) {
    const key = row.parent_id && ids.has(row.parent_id) ? row.parent_id : null
    const list = byParent.get(key) ?? []
    list.push(row)
    byParent.set(key, list)
  }
  const order = (a: T, b: T) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)
  const seen = new Set<string>()
  const build = (
    parent: string | null,
    depth: number,
    path: string,
    pathTa: string,
  ): CategoryTreeNode<T>[] =>
    [...(byParent.get(parent) ?? [])]
      .filter((r) => !seen.has(r.id))
      .sort(order)
      .map((r) => {
        seen.add(r.id)
        const p = path ? `${path}${CATEGORY_PATH_SEPARATOR}${r.name}` : r.name
        const ta = r.name_ta || r.name
        const pTa = pathTa ? `${pathTa}${CATEGORY_PATH_SEPARATOR}${ta}` : ta
        return { ...r, depth, path: p, path_ta: pTa, children: build(r.id, depth + 1, p, pTa) }
      })
  return build(null, 1, '', '')
}

/** Depth-first flattening of a tree (parents before children). */
export function flattenCategoryTree<T extends CategoryLike>(
  nodes: readonly CategoryTreeNode<T>[],
): CategoryTreeNode<T>[] {
  return nodes.flatMap((n) => [n, ...flattenCategoryTree(n.children)])
}

/** The category and all its descendants (product filter "category including descendants"). */
export function categoryDescendantIds(rows: readonly CategoryLike[], id: string): string[] {
  const children = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.parent_id) continue
    children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r.id])
  }
  const out: string[] = []
  const stack = [id]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    out.push(cur)
    stack.push(...(children.get(cur) ?? []))
  }
  return out
}

/**
 * Checks placing category `id` (null for a new one) under `parentId`: a cycle (the parent is
 * the category or one of its descendants) or a resulting depth beyond MAX_CATEGORY_DEPTH.
 */
export function categoryPlacementIssue(
  rows: readonly CategoryLike[],
  id: string | null,
  parentId: string | null,
): 'category_cycle' | 'category_depth' | null {
  if (!parentId) return null
  if (id && categoryDescendantIds(rows, id).includes(parentId)) return 'category_cycle'
  const byId = new Map(rows.map((r) => [r.id, r]))
  let parentDepth = 0
  let cur: string | null = parentId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    parentDepth += 1
    cur = byId.get(cur)?.parent_id ?? null
  }
  // Height of the moved subtree (1 for a leaf / new category).
  const height = (nodeId: string | null): number => {
    if (!nodeId) return 1
    const kids = rows.filter((r) => r.parent_id === nodeId)
    return 1 + (kids.length ? Math.max(...kids.map((k) => height(k.id))) : 0)
  }
  return parentDepth + height(id) > MAX_CATEGORY_DEPTH ? 'category_depth' : null
}

// =============================================================================================
// Brands
// =============================================================================================

export const BrandSchema = z.object({
  id: zId,
  name: z.string(),
  is_active: z.boolean(),
  product_count: z.int().min(0),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Brand = z.output<typeof BrandSchema>

export const BrandListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional(),
  is_active: zBooleanQuery.optional(),
  sort: sortQuery(['name', 'product_count'] as const).prefault('name'),
})
export type BrandListQuery = z.input<typeof BrandListQuerySchema>

/** POST /brands — names are unique case-insensitively (409 DUPLICATE). */
export const BrandCreateSchema = z.object({ name: z.string().trim().min(1).max(100) })
export type BrandCreate = z.input<typeof BrandCreateSchema>

export const BrandUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type BrandUpdate = z.input<typeof BrandUpdateSchema>

// =============================================================================================
// Tax slab rules (price-dependent GST)
// =============================================================================================

/** Slabs: ascending max values, the last one open-ended (null), rates from GST_RATES_BP. */
export const TaxSlabRuleSlabsSchema = TaxSlabsSchema.refine(
  (slabs) => slabs[slabs.length - 1]?.max_unit_value_paise === null,
  { message: 'slab_last_unbounded' },
)

export const TaxSlabRuleSchema = z.object({
  id: zId,
  name: z.string(),
  description: z.string().nullable(),
  slabs: z.array(StoredSlabSchema),
  is_active: z.boolean(),
  product_count: z.int().min(0),
  category_count: z.int().min(0),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type TaxSlabRule = z.output<typeof TaxSlabRuleSchema>

export const TaxSlabRuleListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional(),
  is_active: zBooleanQuery.optional(),
})

export const TaxSlabRuleCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: zNullableText(300),
  slabs: TaxSlabRuleSlabsSchema,
  is_active: z.boolean().default(true),
})
export type TaxSlabRuleCreate = z.input<typeof TaxSlabRuleCreateSchema>

export const TaxSlabRuleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: zNullableText(300),
    slabs: TaxSlabRuleSlabsSchema.optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type TaxSlabRuleUpdate = z.input<typeof TaxSlabRuleUpdateSchema>

/**
 * GST rate a slab rule gives one piece sold at `price_paise` (the rule-editor calculator:
 * "₹2,400 shirt → 5%, ₹2,800 → 18%"). Same maths as the pricing engine.
 */
export function slabRateForPrice(
  slabs: readonly TaxSlab[],
  price_paise: number,
  opts: { price_includes_tax?: boolean; cess_rate_bp?: number } = {},
): { gst_rate_bp: number; slab_index: number } {
  return resolveSlabRate(slabs, {
    net_paise: price_paise,
    qty_milli: 1000,
    price_includes_tax: opts.price_includes_tax ?? true,
    cess_rate_bp: opts.cess_rate_bp ?? 0,
  })
}

// =============================================================================================
// Products
// =============================================================================================

const SkuSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9\-_./]*$/, 'sku_format')

const zNullableSku = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || SkuSchema.safeParse(v).success, { message: 'sku_format' })
  .transform((v) => (v === '' ? null : v))

const AliasesSchema = z
  .array(z.string().trim().min(1).max(60))
  .max(20)
  .transform((list) => {
    const seen = new Set<string>()
    return list.filter((a) => {
      const k = a.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  })
  .describe('Local / Tanglish search words, e.g. "arisi", "paruppu"')

const UnitCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isUnitCode, { message: 'unit_unknown' })
  .describe('Unit code from GET /units (base / stock unit)')

const AttributeValueSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null()])

/** Vertical attributes; validated on the server with attributesSchemaFor(tenant.business_type). */
export const ProductAttributesInputSchema = z
  .record(z.string().min(1).max(40), AttributeValueSchema)
  .refine((v) => Object.keys(v).length <= 50)

/** Barcode text: 3–48 of [0-9A-Za-z-./]; numeric 8/12/13-digit codes must have a valid check digit. */
export const BarcodeCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z\-./]{3,48}$/, 'barcode_format')
  .refine((v) => barcodeIssue(v) !== 'barcode_checksum', { message: 'barcode_checksum' })

/** Barcode problem: 'barcode_format' | 'barcode_checksum' | null (ok). */
export function barcodeIssue(code: string): 'barcode_format' | 'barcode_checksum' | null {
  if (!/^[0-9A-Za-z\-./]{3,48}$/.test(code)) return 'barcode_format'
  if (/^(\d{8}|\d{12}|\d{13})$/.test(code) && !isValidGtin(code)) return 'barcode_checksum'
  return null
}

/** JsBarcode format for a code: EAN13 / EAN8 / UPC when the check digit is valid, else CODE128. */
export function barcodeFormatFor(code: string): 'EAN13' | 'EAN8' | 'UPC' | 'CODE128' {
  if (isValidEan13(code)) return 'EAN13'
  if (/^\d{8}$/.test(code) && isValidGtin(code)) return 'EAN8'
  if (/^\d{12}$/.test(code) && isValidGtin(code)) return 'UPC'
  return 'CODE128'
}

/** Shop-generated internal barcode ('20…' EAN-13). */
export function isInternalCode(code: string): boolean {
  return isValidEan13(code) && code.startsWith(INTERNAL_BARCODE_PREFIX)
}

/** Automatic SKU (settings.catalog.auto_sku): prefix + sequence, ≥ 5 digits ('P', 42 → 'P00042'). */
export function formatAutoSku(prefix: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError('seq must be a positive integer')
  return `${prefix}${String(seq).padStart(5, '0')}`
}

export const ProductBarcodeSchema = z.object({
  id: zId,
  product_id: zId,
  barcode: z.string(),
  /** Quantity one scan represents (case barcodes, e.g. a box of 12 → 12000). */
  qty_milli: z.int().min(1),
  is_internal: z.boolean(),
  created_at: zTimestamp,
})
export type ProductBarcode = z.output<typeof ProductBarcodeSchema>

export const BarcodeInputSchema = z.object({
  barcode: BarcodeCodeSchema,
  qty_milli: zQtyMilli.default(1000),
})

/** POST /products/:id/barcodes — add a code, or `generate` an internal EAN-13. */
export const BarcodeAddSchema = z
  .object({
    barcode: BarcodeCodeSchema.optional(),
    qty_milli: zQtyMilli.default(1000),
    generate: z.boolean().default(false),
  })
  .refine((v) => (v.barcode === undefined) === v.generate, { message: 'barcode_or_generate' })
export type BarcodeAdd = z.input<typeof BarcodeAddSchema>

const ProductCoreShape = {
  id: zId,
  parent_id: zId.nullable(),
  kind: ProductKindSchema,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  aliases: z.array(z.string()),
  description: z.string().nullable(),
  category_id: zId.nullable(),
  brand_id: zId.nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  allow_loose: z.boolean(),
  decimal_qty: z.boolean(),
  hsn_code: z.string().nullable(),
  gst_rate_bp: z.int().min(0),
  cess_rate_bp: z.int().min(0),
  tax_slab_rule_id: zId.nullable(),
  price_includes_tax: z.boolean(),
  mrp_paise: zPaise.nullable(),
  sale_price_paise: zPaise,
  wholesale_price_paise: zPaise.nullable(),
  purchase_price_paise: zPaise,
  min_sale_price_paise: zPaise.nullable(),
  max_discount_bp: z.int().min(0).max(10_000).nullable(),
  track_inventory: z.boolean(),
  track_batches: z.boolean(),
  is_weighed: z.boolean(),
  scale_plu: z.string().nullable(),
  reorder_level_milli: z.int().min(0).nullable(),
  reorder_qty_milli: z.int().min(0).nullable(),
  /** kind 'variant': {"size": "M", "color": "Red"}. */
  variant_attributes: z.record(z.string(), z.string()),
  /** kind 'variant_parent': axis names in display order, e.g. ['size', 'color']. */
  variant_axes: z.array(z.string()),
  attributes: z.record(z.string(), z.unknown()),
  image_file_id: zId.nullable(),
  is_active: z.boolean(),
}

/** A products row (every column; search_text omitted). */
export const ProductSchema = z.object({
  ...ProductCoreShape,
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Product = z.output<typeof ProductSchema>

export const VariantRowSchema = z.object({
  id: zId,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  variant_attributes: z.record(z.string(), z.string()),
  sale_price_paise: zPaise,
  mrp_paise: zPaise.nullable(),
  purchase_price_paise: zPaise,
  is_active: z.boolean(),
  primary_barcode: z.string().nullable(),
  /** Stock in the request's store (null when no store applies). */
  stock_qty_milli: z.int().nullable(),
})
export type VariantRow = z.output<typeof VariantRowSchema>

/** GET /products/:id */
export const ProductDetailSchema = ProductSchema.extend({
  category: CategoryRefSchema.nullable(),
  brand: z.object({ id: zId, name: z.string() }).nullable(),
  tax_slab_rule: z
    .object({ id: zId, name: z.string(), slabs: z.array(StoredSlabSchema) })
    .nullable(),
  barcodes: z.array(ProductBarcodeSchema),
  /** First barcode (by created_at) — what labels and lists show. */
  primary_barcode: z.string().nullable(),
  /** kind 'variant': the parent product. */
  parent: z
    .object({
      id: zId,
      sku: z.string().nullable(),
      name: z.string(),
      name_ta: z.string().nullable(),
      variant_axes: z.array(z.string()),
    })
    .nullable(),
  /** kind 'variant_parent': its variants (others: []). */
  variants: z.array(VariantRowSchema),
  /** Stock in the request's store (?store_id or the device's store), summed over batches. */
  stock_qty_milli: z.int().nullable(),
})
export type ProductDetail = z.output<typeof ProductDetailSchema>

/** Lighter list row (GET /products). */
export const ProductListItemSchema = z.object({
  id: zId,
  parent_id: zId.nullable(),
  kind: ProductKindSchema,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_id: zId.nullable(),
  category_name: z.string().nullable(),
  category_path: z.string().nullable(),
  brand_id: zId.nullable(),
  brand_name: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  hsn_code: z.string().nullable(),
  gst_rate_bp: z.int().min(0),
  tax_slab_rule_id: zId.nullable(),
  price_includes_tax: z.boolean(),
  mrp_paise: zPaise.nullable(),
  sale_price_paise: zPaise,
  purchase_price_paise: zPaise,
  track_inventory: z.boolean(),
  track_batches: z.boolean(),
  is_active: z.boolean(),
  image_file_id: zId.nullable(),
  primary_barcode: z.string().nullable(),
  variant_attributes: z.record(z.string(), z.string()),
  /** kind 'variant_parent': number of variants. */
  variant_count: z.int().min(0),
  reorder_level_milli: z.int().min(0).nullable(),
  /** Stock in the requested store (?store_id, else the device's store); null when none applies. */
  stock_qty_milli: z.int().nullable(),
  /** stock ≤ reorder level (null when stock is not known or no reorder level). */
  low_stock: z.boolean().nullable(),
  updated_at: zTimestamp,
})
export type ProductListItem = z.output<typeof ProductListItemSchema>

/** Filters shared by GET /products and GET /products/export. */
const ProductFilterShape = {
  q: zSearchQuery
    .optional()
    .describe(
      'Name / Tamil name / alias / SKU / generic name; an exact barcode or SKU ranks first',
    ),
  barcode: z.string().trim().min(1).max(48).optional().describe('Exact barcode'),
  category_id: zId.optional().describe('Includes descendant categories'),
  brand_id: zId.optional(),
  kind: ProductKindSchema.optional(),
  is_active: zBooleanQuery.optional(),
  low_stock: zBooleanQuery.optional().describe('Only products at or below their reorder level'),
  track_batches: zBooleanQuery.optional(),
  store_id: zId.optional().describe('Store for stock columns (default: the device store)'),
  parent_id: zId.optional().describe('Variants of this parent'),
  hide_variants: zBooleanQuery.optional().describe('Hide kind variant rows (back-office list)'),
  ids: zQueryIds.optional().describe('Exactly these products (pickers, label printing)'),
}

export const ProductListQuerySchema = PageQuerySchema.extend({
  ...ProductFilterShape,
  sort: sortQuery(['name', 'updated_at', 'sale_price', 'created_at', 'sku'] as const).prefault(
    'name',
  ),
})
export type ProductListQuery = z.input<typeof ProductListQuerySchema>

export const ProductExportQuerySchema = z.object({
  ...ProductFilterShape,
  format: z.literal('csv').default('csv'),
})
export type ProductExportQuery = z.input<typeof ProductExportQuerySchema>

/** Product kinds a client may create directly ('variant' rows come from POST …/variants). */
export const CreatableProductKindSchema = ProductKindSchema.exclude(['variant'])

/**
 * Writable product fields without defaults. Fields left out of a create body are filled by the
 * server: unit ← settings.catalog.default_unit, price_includes_tax ←
 * settings.invoice.default_price_includes_tax, track_batches ← settings.catalog
 * .default_track_batches (forced for pharmacy medicines), hsn_code / gst_rate_bp /
 * tax_slab_rule_id ← the category, then settings.catalog.default_gst_rate_bp, decimal_qty ← the
 * unit's default; sku ← formatAutoSku(settings.catalog.sku_prefix, next) when settings.catalog.auto_sku.
 */
const ProductWritableShape = {
  name: z.string().trim().min(1).max(200),
  name_ta: zNullableText(200),
  aliases: AliasesSchema,
  description: zNullableText(2000),
  sku: zNullableSku,
  category_id: zId.nullable(),
  brand_id: zId.nullable(),
  unit: UnitCodeSchema,
  pack_size: z.int().min(1).max(100_000).describe('Base units per pack (strip of 10 tablets → 10)'),
  allow_loose: z.boolean().describe('Sell less than a pack (loose tablets); needs pack_size > 1'),
  decimal_qty: z
    .boolean()
    .describe('Fractional quantities (weighed / measured; decimal units only)'),
  hsn_code: zNullableHsn,
  gst_rate_bp: zGstRateBp,
  cess_rate_bp: z.int().min(0).max(30_000),
  tax_slab_rule_id: zId.nullable(),
  price_includes_tax: z.boolean(),
  mrp_paise: zPaise.nullable(),
  sale_price_paise: zPaise.describe('Per pack'),
  wholesale_price_paise: zPaise.nullable(),
  purchase_price_paise: zPaise.describe('Per pack, excluding tax'),
  min_sale_price_paise: zPaise.nullable(),
  max_discount_bp: z.int().min(0).max(10_000).nullable(),
  track_inventory: z.boolean(),
  track_batches: z.boolean(),
  is_weighed: z.boolean(),
  scale_plu: z
    .union([z.null(), z.string().trim()])
    .refine((v) => v === null || v === '' || /^\d{1,10}$/.test(v), { message: 'scale_plu_format' })
    .transform((v) => (v === null || v === '' ? null : normalizePlu(v)))
    .describe('Weighing-scale item code (leading zeros dropped)'),
  reorder_level_milli: z.int().min(0).nullable(),
  reorder_qty_milli: z.int().min(0).nullable(),
  attributes: ProductAttributesInputSchema,
  image_file_id: zId.nullable().describe('A file uploaded with purpose product_image'),
  is_active: z.boolean(),
}

/** Inputs of the product rules (create body, or the merged row on PATCH). */
export interface ProductRuleInput {
  kind?: ProductKind | undefined
  unit?: string | undefined
  pack_size?: number | undefined
  allow_loose?: boolean | undefined
  decimal_qty?: boolean | undefined
  track_inventory?: boolean | undefined
  track_batches?: boolean | undefined
  mrp_paise?: number | null | undefined
  sale_price_paise?: number | undefined
  min_sale_price_paise?: number | null | undefined
  /** Accept an MRP below the selling price (explicit override). */
  allow_mrp_below_sale?: boolean | undefined
}

/**
 * Cross-field product rules. Only rules whose inputs are present are checked, so the same helper
 * validates a create body, a PATCH body and (on the server) the merged result.
 */
export function productRuleIssues(p: ProductRuleInput): RuleIssue[] {
  const issues: RuleIssue[] = []
  if (
    p.mrp_paise != null &&
    p.sale_price_paise !== undefined &&
    p.mrp_paise < p.sale_price_paise &&
    !p.allow_mrp_below_sale
  )
    issues.push({ path: 'sale_price_paise', code: 'mrp_below_sale_price' })
  if (
    p.min_sale_price_paise != null &&
    p.sale_price_paise !== undefined &&
    p.min_sale_price_paise > p.sale_price_paise
  )
    issues.push({ path: 'min_sale_price_paise', code: 'min_price_above_sale_price' })
  if (p.allow_loose === true && p.pack_size !== undefined && p.pack_size <= 1)
    issues.push({ path: 'allow_loose', code: 'loose_requires_pack' })
  if (p.decimal_qty === true && p.unit !== undefined && !isDecimalUnit(p.unit))
    issues.push({ path: 'decimal_qty', code: 'decimal_qty_unit' })
  if (p.kind === 'service' && (p.track_inventory === true || p.track_batches === true))
    issues.push({ path: 'track_inventory', code: 'service_tracks_stock' })
  return issues
}

/**
 * Normalised stock flags: services and variant parents never hold stock themselves
 * (track_inventory false; a parent's track_batches is the default of its variants).
 */
export function normalizeProductFlags<
  T extends { kind: ProductKind; track_inventory: boolean; track_batches: boolean },
>(p: T): T {
  if (p.kind === 'service') return { ...p, track_inventory: false, track_batches: false }
  if (p.kind === 'variant_parent') return { ...p, track_inventory: false }
  return p
}

function addRuleIssues(issues: RuleIssue[], ctx: z.RefinementCtx): void {
  for (const issue of issues)
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.code })
}

/** POST /products (plan limit products). */
export const ProductCreateSchema = z
  .object({
    kind: CreatableProductKindSchema.default('standard'),
    name: ProductWritableShape.name,
    name_ta: ProductWritableShape.name_ta,
    aliases: AliasesSchema.default([]),
    description: ProductWritableShape.description,
    sku: ProductWritableShape.sku,
    category_id: zId.nullable().default(null),
    brand_id: zId.nullable().default(null),
    unit: UnitCodeSchema.optional(),
    pack_size: ProductWritableShape.pack_size.default(1),
    allow_loose: z.boolean().default(false),
    decimal_qty: z.boolean().optional(),
    hsn_code: zNullableHsn,
    gst_rate_bp: zGstRateBp.optional(),
    cess_rate_bp: ProductWritableShape.cess_rate_bp.default(0),
    tax_slab_rule_id: zId.nullable().optional(),
    price_includes_tax: z.boolean().optional(),
    mrp_paise: zPaise.nullable().default(null),
    sale_price_paise: zPaise,
    wholesale_price_paise: zPaise.nullable().default(null),
    purchase_price_paise: zPaise.default(0),
    min_sale_price_paise: zPaise.nullable().default(null),
    max_discount_bp: z.int().min(0).max(10_000).nullable().default(null),
    track_inventory: z.boolean().default(true),
    track_batches: z.boolean().optional(),
    is_weighed: z.boolean().default(false),
    scale_plu: ProductWritableShape.scale_plu.optional(),
    reorder_level_milli: z.int().min(0).nullable().default(null),
    reorder_qty_milli: z.int().min(0).nullable().default(null),
    attributes: ProductAttributesInputSchema.default({}),
    image_file_id: zId.nullable().default(null),
    is_active: z.boolean().default(true),
    barcodes: z
      .array(BarcodeInputSchema)
      .max(20)
      .default([])
      .refine((list) => new Set(list.map((b) => b.barcode)).size === list.length, {
        message: 'duplicate_id',
      }),
    generate_barcode: z
      .boolean()
      .optional()
      .describe('Generate an internal EAN-13 when no barcode is given (default: settings)'),
    allow_mrp_below_sale: z.boolean().default(false),
  })
  .superRefine((v, ctx) => addRuleIssues(productRuleIssues(v), ctx))
export type ProductCreate = z.input<typeof ProductCreateSchema>
export type ProductCreateParsed = z.output<typeof ProductCreateSchema>

const productUpdateShape = Object.fromEntries(
  Object.entries(ProductWritableShape).map(([k, s]) => [k, (s as z.ZodType).optional()]),
) as { [K in keyof typeof ProductWritableShape]: z.ZodOptional<(typeof ProductWritableShape)[K]> }

/**
 * PATCH /products/:id — any writable field; `kind` may switch between standard and service only
 * (variant parents are made by POST …/variants). Price / GST changes and deactivation are audited.
 */
export const ProductUpdateSchema = z
  .object({
    ...productUpdateShape,
    kind: ProductKindSchema.extract(['standard', 'service']).optional(),
    allow_mrp_below_sale: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine((v, ctx) => addRuleIssues(productRuleIssues(v), ctx))
  .refine(
    (v) =>
      Object.entries(v).some(
        ([k, x]) => x !== undefined && k !== 'if_updated_at' && k !== 'allow_mrp_below_sale',
      ),
    {
      message: 'empty_patch',
    },
  )
export type ProductUpdate = z.input<typeof ProductUpdateSchema>
export type ProductUpdateParsed = z.output<typeof ProductUpdateSchema>

// ---- lookup (POS scan) ------------------------------------------------------------------------

export const ProductLookupQuerySchema = z.object({
  code: z.string().trim().min(1).max(64).describe('Scanned / typed barcode, SKU or scale barcode'),
  store_id: zId.optional().describe('Applies store prices and stock (default: the device store)'),
})
export type ProductLookupQuery = z.input<typeof ProductLookupQuerySchema>

/** Fields the billing screen needs to price and sell a product. */
export const SellableProductSchema = z.object({
  id: zId,
  parent_id: zId.nullable(),
  kind: ProductKindSchema,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_id: zId.nullable(),
  brand_id: zId.nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  allow_loose: z.boolean(),
  decimal_qty: z.boolean(),
  hsn_code: z.string().nullable(),
  gst_rate_bp: z.int().min(0),
  cess_rate_bp: z.int().min(0),
  tax_slab_rule_id: zId.nullable(),
  price_includes_tax: z.boolean(),
  mrp_paise: zPaise.nullable(),
  /** Effective selling price (store price when applied). */
  sale_price_paise: zPaise,
  wholesale_price_paise: zPaise.nullable(),
  min_sale_price_paise: zPaise.nullable(),
  max_discount_bp: z.int().min(0).max(10_000).nullable(),
  track_inventory: z.boolean(),
  track_batches: z.boolean(),
  is_weighed: z.boolean(),
  variant_attributes: z.record(z.string(), z.string()),
  attributes: z.record(z.string(), z.unknown()),
  image_file_id: zId.nullable(),
  is_active: z.boolean(),
  store_price_applied: z.boolean(),
  stock_qty_milli: z.int().nullable(),
})
export type SellableProduct = z.output<typeof SellableProductSchema>

export const ProductLookupMatchSchema = z.enum(['barcode', 'sku', 'scale'])
export type ProductLookupMatch = z.infer<typeof ProductLookupMatchSchema>

/**
 * GET /products/lookup — precedence: exact barcode (qty from a case barcode) → SKU
 * (case-insensitive) → scale barcode (settings.pos.scale_barcode → products.scale_plu, qty or
 * line price from the code) → 404 NOT_FOUND.
 */
export const ProductLookupResultSchema = z.object({
  match: ProductLookupMatchSchema,
  code: z.string(),
  product: SellableProductSchema,
  /** Quantity represented by the scan (case barcode qty, scale weight); null = 1 unit / ask. */
  qty_milli: z.int().min(1).nullable(),
  /** Line amount embedded in a price scale barcode. */
  price_paise: zPaise.nullable(),
  barcode_id: zId.nullable(),
})
export type ProductLookupResult = z.output<typeof ProductLookupResultSchema>

// ---- variants -------------------------------------------------------------------------------

/** Axis names: lower snake ('size', 'color', 'waist'). */
export const VariantAxisNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, 'variant_axis')
export const VariantValueSchema = z.string().trim().min(1).max(30)

/** At most this many variants per generate call. */
export const MAX_VARIANT_COMBINATIONS = 500

const VariantAxesInputSchema = z
  .record(z.string(), z.array(VariantValueSchema).min(1).max(60))
  .superRefine((axes, ctx) => {
    const names = Object.keys(axes)
    for (const name of names)
      if (!VariantAxisNameSchema.safeParse(name).success)
        ctx.addIssue({ code: 'custom', path: [name], message: 'variant_axis' })
    if (names.length < 1 || names.length > 3)
      ctx.addIssue({ code: 'custom', message: 'variant_axes_count' })
    for (const [name, values] of Object.entries(axes)) {
      if (new Set(values.map((v) => v.toLowerCase())).size !== values.length)
        ctx.addIssue({ code: 'custom', path: [name], message: 'variant_duplicate_value' })
    }
    const count = Object.values(axes).reduce((n, v) => n * v.length, 1)
    if (count > MAX_VARIANT_COMBINATIONS)
      ctx.addIssue({ code: 'custom', message: 'variant_combinations_limit' })
  })
  .describe('Axis → values; key order is the display order, e.g. {size: [S, M], color: [Red]}')

export const VariantPriceOverrideSchema = z.object({
  /** Applies to every combination having these values (e.g. {size: 'XXL'}); later entries win. */
  match: z
    .record(z.string(), VariantValueSchema)
    .refine((m) => Object.keys(m).length > 0, { message: 'variant_override_match' }),
  sale_price_paise: zPaise.optional(),
  mrp_paise: zPaise.nullable().optional(),
  purchase_price_paise: zPaise.optional(),
  wholesale_price_paise: zPaise.nullable().optional(),
})
export type VariantPriceOverride = z.output<typeof VariantPriceOverrideSchema>

/**
 * POST /products/:id/variants (feature variants) — creates the missing combinations as child
 * products (kind 'variant'); the product becomes kind 'variant_parent' with variant_axes.
 * Idempotent: existing combinations (case-insensitive) are skipped.
 */
export const VariantGenerateSchema = z.object({
  axes: VariantAxesInputSchema,
  /** Tamil labels of values for Tamil names, per axis: {color: {Red: 'சிவப்பு'}}. */
  value_labels_ta: z
    .record(z.string(), z.record(z.string(), z.string().trim().min(1).max(30)))
    .default({}),
  price_overrides: z.array(VariantPriceOverrideSchema).max(500).default([]),
  /** Generate internal EAN-13 barcodes for the new variants. */
  generate_barcodes: z.boolean().default(false),
})
export type VariantGenerate = z.input<typeof VariantGenerateSchema>

export const VariantGenerateResultSchema = z.object({
  parent: ProductDetailSchema,
  created: z.array(VariantRowSchema),
  skipped: z.array(
    z.object({ variant_attributes: z.record(z.string(), z.string()), product_id: zId }),
  ),
})
export type VariantGenerateResult = z.output<typeof VariantGenerateResultSchema>

export type VariantAttributes = Record<string, string>

/** Axis order: the parent's stored axes first, then new ones in input order. */
export function variantAxisOrder(
  existing: readonly string[],
  axes: Record<string, readonly string[]>,
): string[] {
  return [...existing, ...Object.keys(axes).filter((a) => !existing.includes(a))]
}

/** Cartesian product of the axes in `order` (axes missing from `axes` are skipped). */
export function variantCombinations(
  axes: Record<string, readonly string[]>,
  order: readonly string[] = Object.keys(axes),
): VariantAttributes[] {
  let combos: VariantAttributes[] = [{}]
  for (const axis of order) {
    const values = axes[axis]
    if (!values || values.length === 0) continue
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axis]: v })))
  }
  return combos
}

/** Case-insensitive identity of a combination ('m|red'), for skipping existing variants. */
export function variantKey(attrs: VariantAttributes, order: readonly string[]): string {
  return order
    .filter((a) => attrs[a] !== undefined)
    .map((a) => attrs[a]!.trim().toLowerCase())
    .join('|')
}

/** 'M / Red' (Tamil labels per axis/value when given). */
export function variantLabel(
  attrs: VariantAttributes,
  order: readonly string[],
  labels?: Record<string, Record<string, string>>,
): string {
  return order
    .filter((a) => attrs[a] !== undefined)
    .map((a) => labels?.[a]?.[attrs[a]!] ?? attrs[a]!)
    .join(' / ')
}

/** '<parent> - M / Red' (max 200 characters). */
export function variantName(
  parentName: string,
  attrs: VariantAttributes,
  order: readonly string[],
  labels?: Record<string, Record<string, string>>,
): string {
  return `${parentName} - ${variantLabel(attrs, order, labels)}`.slice(0, 200)
}

/** '<PARENTSKU>-M-RED': value characters outside A-Z 0-9 dropped, upper case, max 40. */
export function variantSku(
  parentSku: string,
  attrs: VariantAttributes,
  order: readonly string[],
): string {
  const parts = order
    .filter((a) => attrs[a] !== undefined)
    .map((a) => attrs[a]!.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean)
  return [parentSku, ...parts].join('-').slice(0, 40)
}

export interface VariantPrices {
  sale_price_paise: number
  mrp_paise: number | null
  purchase_price_paise: number
  wholesale_price_paise: number | null
}

/** Base prices with every matching override applied in order. */
export function variantPrices(
  base: VariantPrices,
  attrs: VariantAttributes,
  overrides: readonly VariantPriceOverride[],
): VariantPrices {
  const out = { ...base }
  for (const o of overrides) {
    const matches = Object.entries(o.match).every(
      ([axis, value]) => attrs[axis]?.toLowerCase() === value.toLowerCase(),
    )
    if (!matches) continue
    if (o.sale_price_paise !== undefined) out.sale_price_paise = o.sale_price_paise
    if (o.mrp_paise !== undefined) out.mrp_paise = o.mrp_paise
    if (o.purchase_price_paise !== undefined) out.purchase_price_paise = o.purchase_price_paise
    if (o.wholesale_price_paise !== undefined) out.wholesale_price_paise = o.wholesale_price_paise
  }
  return out
}

/** Value presets for the axis chips editor. */
export const VARIANT_PRESETS = {
  size: {
    apparel: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'],
    waist: ['28', '30', '32', '34', '36', '38', '40', '42', '44'],
    kids: ['0-1Y', '1-2Y', '2-3Y', '3-4Y', '4-5Y', '5-6Y', '6-7Y', '7-8Y', '9-10Y', '11-12Y'],
    footwear: ['6', '7', '8', '9', '10', '11'],
    footwear_kids: [
      '5C',
      '6C',
      '7C',
      '8C',
      '9C',
      '10C',
      '11C',
      '12C',
      '13C',
      '1',
      '2',
      '3',
      '4',
      '5',
    ],
  },
  color: [
    { value: 'Black', label_ta: 'கருப்பு' },
    { value: 'White', label_ta: 'வெள்ளை' },
    { value: 'Red', label_ta: 'சிவப்பு' },
    { value: 'Blue', label_ta: 'நீலம்' },
    { value: 'Navy', label_ta: 'கருநீலம்' },
    { value: 'Sky Blue', label_ta: 'வான நீலம்' },
    { value: 'Green', label_ta: 'பச்சை' },
    { value: 'Yellow', label_ta: 'மஞ்சள்' },
    { value: 'Orange', label_ta: 'ஆரஞ்சு' },
    { value: 'Pink', label_ta: 'இளஞ்சிவப்பு' },
    { value: 'Purple', label_ta: 'ஊதா' },
    { value: 'Maroon', label_ta: 'அரக்கு' },
    { value: 'Brown', label_ta: 'பழுப்பு' },
    { value: 'Grey', label_ta: 'சாம்பல்' },
    { value: 'Beige', label_ta: 'இளம் பழுப்பு' },
    { value: 'Cream', label_ta: 'கிரீம்' },
    { value: 'Gold', label_ta: 'தங்க நிறம்' },
    { value: 'Silver', label_ta: 'வெள்ளி நிறம்' },
    { value: 'Multi', label_ta: 'பல வண்ணம்' },
  ],
} as const

// ---- bulk update ------------------------------------------------------------------------------

export const PriceChangeSchema = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('percent'),
      /** Signed: 1000 = +10%, −500 = −5%. */
      percent_bp: z.int().min(-9_999).max(100_000),
      round_to_rupee: z.boolean().default(false),
    }),
    z.object({
      mode: z.literal('amount'),
      /** Signed change per pack. */
      amount_paise: z.int().min(-100_000_000).max(100_000_000),
      round_to_rupee: z.boolean().default(false),
    }),
    z.object({
      mode: z.literal('set'),
      price_paise: zPaise,
      round_to_rupee: z.boolean().default(false),
    }),
  ])
  .refine(
    (c) =>
      c.mode === 'percent' ? c.percent_bp !== 0 : c.mode === 'amount' ? c.amount_paise !== 0 : true,
    {
      message: 'price_change_zero',
    },
  )
export type PriceChange = z.output<typeof PriceChangeSchema>

/**
 * New selling price after a bulk price change: never negative, optionally rounded to the rupee
 * (half away from zero) and capped at the MRP (`capped` tells).
 */
export function applyPriceChange(
  price_paise: number,
  change: PriceChange,
  mrp_paise: number | null = null,
): { price_paise: number; capped: boolean } {
  let next =
    change.mode === 'percent'
      ? price_paise + mulDiv(price_paise, change.percent_bp, 10_000)
      : change.mode === 'amount'
        ? price_paise + change.amount_paise
        : change.price_paise
  if (change.round_to_rupee) next = roundToRupee(next).rounded_paise
  next = Math.max(0, next)
  if (mrp_paise !== null && next > mrp_paise) return { price_paise: mrp_paise, capped: true }
  return { price_paise: next, capped: false }
}

/** POST /products/bulk-update — one transaction, audited. */
export const ProductBulkUpdateSchema = z.object({
  ids: z.array(zId).min(1).max(500).refine(uniqueIds, { message: 'duplicate_id' }),
  set: z
    .object({
      gst_rate_bp: zGstRateBp.optional(),
      tax_slab_rule_id: zId.nullable().optional(),
      category_id: zId.nullable().optional(),
      brand_id: zId.nullable().optional(),
      is_active: z.boolean().optional(),
      /** On sale_price_paise; capped at MRP. */
      price_change: PriceChangeSchema.optional(),
    })
    .refine(notEmpty, { message: 'empty_patch' }),
})
export type ProductBulkUpdate = z.input<typeof ProductBulkUpdateSchema>

export const ProductBulkUpdateResultSchema = z.object({
  matched: z.int().min(0),
  updated: z.int().min(0),
  unchanged: z.int().min(0),
  capped_at_mrp: z.int().min(0),
  /** Requested ids that do not exist (ignored). */
  not_found: z.array(zId),
})
export type ProductBulkUpdateResult = z.output<typeof ProductBulkUpdateResultSchema>

// ---- margins (product form live display) -------------------------------------------------------

/**
 * Margin of a per-pack selling price over the per-pack purchase cost (excl. tax):
 * margin_bp = profit / selling price excl. tax, markup_bp = profit / cost. Rates are null when
 * the denominator is 0.
 */
export function productMargin(p: {
  sale_price_paise: number
  purchase_price_paise: number
  price_includes_tax: boolean
  gst_rate_bp: number
  cess_rate_bp?: number
}): {
  sale_excl_tax_paise: number
  margin_paise: number
  margin_bp: number | null
  markup_bp: number | null
} {
  const tax = p.gst_rate_bp + (p.cess_rate_bp ?? 0)
  const excl = p.price_includes_tax
    ? roundDiv(p.sale_price_paise * 10_000, 10_000 + tax)
    : p.sale_price_paise
  const margin = excl - p.purchase_price_paise
  return {
    sale_excl_tax_paise: excl,
    margin_paise: margin,
    margin_bp: excl > 0 ? roundDiv(margin * 10_000, excl) : null,
    markup_bp:
      p.purchase_price_paise > 0 ? roundDiv(margin * 10_000, p.purchase_price_paise) : null,
  }
}

/** "You save ₹x (y%)" against MRP; zeros when there is no MRP or no saving. */
export function mrpSavings(
  mrp_paise: number | null,
  sale_price_paise: number,
): { savings_paise: number; savings_bp: number } {
  if (mrp_paise === null || mrp_paise <= 0 || sale_price_paise >= mrp_paise)
    return { savings_paise: 0, savings_bp: 0 }
  const savings = mrp_paise - sale_price_paise
  return { savings_paise: savings, savings_bp: roundDiv(savings * 10_000, mrp_paise) }
}

// ---- import / export --------------------------------------------------------------------------

export interface ProductImportColumnDef extends ImportColumnDef {
  /** Where the value goes: a product column, attributes[key], variant_attributes[key], … */
  target: 'product' | 'attribute' | 'variant' | 'barcode' | 'category' | 'brand' | 'parent'
}

const col = (
  key: string,
  target: ProductImportColumnDef['target'],
  type: ProductImportColumnDef['type'],
  example: string,
  description_en: string,
  description_ta: string,
  extra: Partial<Pick<ProductImportColumnDef, 'required' | 'enum_values'>> = {},
): ProductImportColumnDef => ({
  key,
  target,
  type,
  example,
  description_en,
  description_ta,
  required: extra.required ?? false,
  ...(extra.enum_values ? { enum_values: extra.enum_values } : {}),
})

/** Columns every product import / export has (header keys, in template order). */
export const PRODUCT_IMPORT_BASE_COLUMNS: readonly ProductImportColumnDef[] = [
  col(
    'sku',
    'product',
    'text',
    'RICE-PONNI-1KG',
    'Your item code; matches existing products on upsert',
    'உங்கள் பொருள் குறியீடு',
  ),
  col(
    'barcode',
    'barcode',
    'text',
    '8901234567892',
    'Barcode (EAN/UPC check digit verified); several separated by |',
    'பார்கோடு',
  ),
  col(
    'name',
    'product',
    'text',
    'Ponni Rice 1 kg',
    'Product name (English)',
    'பொருளின் பெயர் (ஆங்கிலம்)',
    { required: true },
  ),
  col(
    'name_ta',
    'product',
    'text',
    'பொன்னி அரிசி 1 கிலோ',
    'Product name in Tamil',
    'தமிழில் பெயர்',
  ),
  col(
    'category_path',
    'category',
    'text',
    'Grocery > Rice',
    'Category path, levels separated by >; created when missing',
    'வகை (> ஆல் பிரிக்கவும்)',
  ),
  col('brand', 'brand', 'text', 'Annapoorna', 'Brand; created when missing', 'பிராண்ட்'),
  col('unit', 'product', 'enum', 'PCS', 'Unit code (PCS, KG, L, M, TAB, …)', 'அலகு'),
  col(
    'pack_size',
    'product',
    'int',
    '1',
    'Base units per pack (strip of 10 tablets → 10)',
    'ஒரு பேக்கில் அலகுகள்',
  ),
  col('hsn_code', 'product', 'text', '1006', 'HSN / SAC code (4, 6 or 8 digits)', 'HSN குறியீடு'),
  col(
    'gst_rate',
    'product',
    'percent',
    '5',
    'GST rate in percent (0, 0.25, 3, 5, 18, 40 …)',
    'GST சதவீதம்',
  ),
  col('mrp', 'product', 'money', '72.00', 'MRP per pack in rupees', 'அதிகபட்ச சில்லறை விலை'),
  col(
    'sale_price',
    'product',
    'money',
    '68.00',
    'Selling price per pack in rupees',
    'விற்பனை விலை',
    { required: true },
  ),
  col(
    'purchase_price',
    'product',
    'money',
    '60.00',
    'Purchase cost per pack excl. GST',
    'கொள்முதல் விலை (GST இன்றி)',
  ),
  col('wholesale_price', 'product', 'money', '', 'Wholesale price per pack', 'மொத்த விலை'),
  col(
    'price_includes_tax',
    'product',
    'boolean',
    'yes',
    'Selling price includes GST (yes/no)',
    'விலையில் GST சேர்ந்ததா',
  ),
  col(
    'track_batches',
    'product',
    'boolean',
    'no',
    'Track batches & expiry (yes/no)',
    'பேட்ச் & காலாவதி',
  ),
  col('reorder_level', 'product', 'qty', '10', 'Reorder level in base units', 'மறு ஆர்டர் அளவு'),
  col(
    'aliases',
    'product',
    'list',
    'arisi|ponni',
    'Search words separated by |',
    'தேடல் சொற்கள் (| ஆல் பிரிக்கவும்)',
  ),
]

const PHARMACY_COLUMNS: readonly ProductImportColumnDef[] = [
  col('generic_name', 'attribute', 'text', 'Paracetamol', 'Generic name', 'பொதுப் பெயர்'),
  col('composition', 'attribute', 'text', 'Paracetamol 500 mg', 'Composition', 'கலவை'),
  col('manufacturer', 'attribute', 'text', 'Micro Labs', 'Manufacturer', 'உற்பத்தியாளர்'),
  col('schedule', 'attribute', 'enum', 'OTC', 'Drug schedule', 'மருந்து அட்டவணை', {
    enum_values: ['OTC', 'G', 'H', 'H1', 'X'],
  }),
  col(
    'requires_prescription',
    'attribute',
    'boolean',
    'no',
    'Prescription required (yes/no)',
    'மருந்துச் சீட்டு தேவையா',
  ),
  col('storage', 'attribute', 'enum', 'room', 'Storage', 'சேமிப்பு', {
    enum_values: ['room', 'cool', 'cold'],
  }),
  col('dosage_form', 'attribute', 'enum', 'tablet', 'Dosage form', 'மருந்து வடிவம்', {
    enum_values: [
      'tablet',
      'capsule',
      'syrup',
      'injection',
      'ointment',
      'drops',
      'powder',
      'inhaler',
      'device',
      'other',
    ],
  }),
  col('strength', 'attribute', 'text', '500 mg', 'Strength', 'வலிமை'),
]

const VARIANT_COLUMNS: readonly ProductImportColumnDef[] = [
  col(
    'parent_sku',
    'parent',
    'text',
    'SHIRT-FORMAL',
    'SKU of the variant parent; the row becomes its variant (size/color)',
    'தாய் பொருள் SKU',
  ),
  col('size', 'variant', 'text', 'M', 'Size (variant value when parent_sku is set)', 'அளவு'),
  col('color', 'variant', 'text', 'Blue', 'Colour (variant value when parent_sku is set)', 'நிறம்'),
]

const VERTICAL_COLUMNS: Readonly<Record<BusinessType, readonly ProductImportColumnDef[]>> = {
  pharmacy: PHARMACY_COLUMNS,
  apparel: [
    ...VARIANT_COLUMNS,
    col('fabric', 'attribute', 'text', 'Cotton', 'Fabric', 'துணி'),
    col('gender', 'attribute', 'enum', 'men', 'Gender', 'பாலினம்', {
      enum_values: ['men', 'women', 'kids', 'unisex'],
    }),
  ],
  footwear: [
    ...VARIANT_COLUMNS,
    col('material', 'attribute', 'text', 'Leather', 'Material', 'பொருள்'),
    col('gender', 'attribute', 'enum', 'men', 'Gender', 'பாலினம்', {
      enum_values: ['men', 'women', 'kids', 'unisex'],
    }),
  ],
  electronics: [
    col('model', 'attribute', 'text', 'X100', 'Model', 'மாடல்'),
    col('warranty_months', 'attribute', 'int', '12', 'Warranty in months', 'உத்தரவாதம் (மாதங்கள்)'),
    col(
      'serial_tracked',
      'attribute',
      'boolean',
      'no',
      'Capture serial numbers (yes/no)',
      'வரிசை எண் பதிவு',
    ),
  ],
  general_store: [
    col('veg', 'attribute', 'boolean', 'yes', 'Vegetarian (yes/no)', 'சைவம்'),
    col('loose', 'attribute', 'boolean', 'no', 'Sold loose (yes/no)', 'தளர்வாக விற்பனை'),
    col('scale_plu', 'product', 'text', '', 'Weighing-scale item code', 'எடை இயந்திரக் குறியீடு'),
  ],
  supermarket: [
    col('veg', 'attribute', 'boolean', 'yes', 'Vegetarian (yes/no)', 'சைவம்'),
    col('loose', 'attribute', 'boolean', 'no', 'Sold loose (yes/no)', 'தளர்வாக விற்பனை'),
    col('scale_plu', 'product', 'text', '', 'Weighing-scale item code', 'எடை இயந்திரக் குறியீடு'),
  ],
  bakery_sweets: [
    col('veg', 'attribute', 'boolean', 'yes', 'Vegetarian (yes/no)', 'சைவம்'),
    col(
      'shelf_life_days',
      'attribute',
      'int',
      '3',
      'Shelf life in days',
      'பயன்பாட்டுக் காலம் (நாட்கள்)',
    ),
    col('scale_plu', 'product', 'text', '', 'Weighing-scale item code', 'எடை இயந்திரக் குறியீடு'),
  ],
  hardware: [],
  stationery: [],
  other: [],
}

/** Import / export columns for a vertical (base columns, then vertical ones). */
export function productImportColumns(businessType: BusinessType): ProductImportColumnDef[] {
  return [...PRODUCT_IMPORT_BASE_COLUMNS, ...VERTICAL_COLUMNS[businessType]]
}

/** Template CSV (header + one example row) for GET /products/import/template. */
export function productImportTemplateCsv(businessType: BusinessType): string {
  const cols = productImportColumns(businessType)
  return toCsv([cols.map((c) => c.key), cols.map((c) => c.example)])
}

/** Percent text → basis points: '18' → 1800, '0.25' → 25, '5%' → 500; null when invalid. */
export function parsePercentBp(text: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(text)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

/** Yes/no cells: yes/y/true/1/ஆம் → true, no/n/false/0/இல்லை → false, '' → null; else undefined. */
export function parseYesNo(text: string): boolean | null | undefined {
  const t = text.trim().toLowerCase()
  if (t === '') return null
  if (['yes', 'y', 'true', '1', 'ஆம்', 'ஆமாம்'].includes(t)) return true
  if (['no', 'n', 'false', '0', 'இல்லை'].includes(t)) return false
  return undefined
}

/** POST /products/import — rows > IMPORT_INLINE_MAX_ROWS run as job catalog.import. */
export const ProductImportSchema = ImportRequestBaseSchema.extend({
  match_by: z
    .enum(['sku', 'barcode', 'sku_or_barcode'])
    .default('sku_or_barcode')
    .describe('How rows find existing products on upsert'),
  create_categories: z.boolean().default(true),
  create_brands: z.boolean().default(true),
})
export type ProductImport = z.input<typeof ProductImportSchema>

export const ProductImportTemplateQuerySchema = z.object({
  business_type: BusinessTypeSchema.optional().describe("Default: the tenant's vertical"),
})

// =============================================================================================
// Promotions (feature promotions)
// =============================================================================================

export const PromotionStatusSchema = z.enum(['active', 'scheduled', 'expired', 'inactive'])
export type PromotionStatus = z.infer<typeof PromotionStatusSchema>

export const PROMOTION_STATUS_LABELS: Readonly<Record<PromotionStatus, BilingualLabel>> = {
  active: { en: 'Active', ta: 'நடப்பில்' },
  scheduled: { en: 'Scheduled', ta: 'திட்டமிடப்பட்டது' },
  expired: { en: 'Ended', ta: 'முடிந்தது' },
  inactive: { en: 'Switched off', ta: 'நிறுத்தப்பட்டது' },
}

/** Status shown in lists: inactive (switched off) / scheduled / active / expired (window only). */
export function promotionStatus(
  p: { is_active: boolean; starts_at: string | Date | null; ends_at: string | Date | null },
  now: Date = new Date(),
): PromotionStatus {
  if (!p.is_active) return 'inactive'
  const t = now.getTime()
  const start = p.starts_at === null ? null : new Date(p.starts_at).getTime()
  const end = p.ends_at === null ? null : new Date(p.ends_at).getTime()
  if (end !== null && t >= end) return 'expired'
  if (start !== null && t < start) return 'scheduled'
  return 'active'
}

const PromotionResponseBase = {
  id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  store_ids: z.array(zId).nullable(),
  starts_at: zTimestamp.nullable(),
  ends_at: zTimestamp.nullable(),
  days_of_week: z.array(z.int().min(0).max(6)).nullable(),
  priority: z.int(),
  stackable: z.boolean(),
  is_active: z.boolean(),
  status: PromotionStatusSchema,
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
}

/** A promotion with kind-specific `rules` (shared rule schemas, defaults filled). */
export const PromotionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    ...PromotionResponseBase,
    kind: z.literal('item_percent'),
    rules: PROMOTION_RULE_SCHEMAS.item_percent,
  }),
  z.object({
    ...PromotionResponseBase,
    kind: z.literal('item_flat'),
    rules: PROMOTION_RULE_SCHEMAS.item_flat,
  }),
  z.object({
    ...PromotionResponseBase,
    kind: z.literal('buy_x_get_y'),
    rules: PROMOTION_RULE_SCHEMAS.buy_x_get_y,
  }),
  z.object({
    ...PromotionResponseBase,
    kind: z.literal('bill_percent'),
    rules: PROMOTION_RULE_SCHEMAS.bill_percent,
  }),
  z.object({
    ...PromotionResponseBase,
    kind: z.literal('bill_flat'),
    rules: PROMOTION_RULE_SCHEMAS.bill_flat,
  }),
  z.object({
    ...PromotionResponseBase,
    kind: z.literal('combo_price'),
    rules: PROMOTION_RULE_SCHEMAS.combo_price,
  }),
])
export type PromotionResponse = z.output<typeof PromotionResponseSchema>

const DaysOfWeekSchema = z
  .array(z.int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((d) => new Set(d).size === d.length, { message: 'duplicate_id' })
  .describe('0 = Sunday … 6 = Saturday (tenant timezone); null = every day')

const PromotionWritableBase = {
  name: z.string().trim().min(1).max(120),
  name_ta: zNullableText(120),
  store_ids: z.array(zId).min(1).max(500).nullable().describe('null = all stores'),
  starts_at: zTimestamp.nullable().describe('Inclusive start instant (null = immediately)'),
  ends_at: zTimestamp.nullable().describe('Exclusive end instant (null = open-ended)'),
  days_of_week: DaysOfWeekSchema.nullable(),
  priority: z.int().min(-1000).max(1000),
  stackable: z.boolean(),
  is_active: z.boolean(),
}

const promotionCreateBase = {
  name: PromotionWritableBase.name,
  name_ta: PromotionWritableBase.name_ta,
  store_ids: PromotionWritableBase.store_ids.default(null),
  starts_at: PromotionWritableBase.starts_at.default(null),
  ends_at: PromotionWritableBase.ends_at.default(null),
  days_of_week: PromotionWritableBase.days_of_week.default(null),
  priority: PromotionWritableBase.priority.default(0),
  stackable: PromotionWritableBase.stackable.default(false),
  is_active: PromotionWritableBase.is_active.default(true),
}

const datesInOrder = (p: { starts_at?: string | null; ends_at?: string | null }) =>
  !p.starts_at || !p.ends_at || Date.parse(p.ends_at) > Date.parse(p.starts_at)

/** POST /promotions — `rules` validated by the kind's shared schema. */
export const PromotionCreateSchema = z
  .discriminatedUnion('kind', [
    z.object({
      ...promotionCreateBase,
      kind: z.literal('item_percent'),
      rules: PROMOTION_RULE_SCHEMAS.item_percent,
    }),
    z.object({
      ...promotionCreateBase,
      kind: z.literal('item_flat'),
      rules: PROMOTION_RULE_SCHEMAS.item_flat,
    }),
    z.object({
      ...promotionCreateBase,
      kind: z.literal('buy_x_get_y'),
      rules: PROMOTION_RULE_SCHEMAS.buy_x_get_y,
    }),
    z.object({
      ...promotionCreateBase,
      kind: z.literal('bill_percent'),
      rules: PROMOTION_RULE_SCHEMAS.bill_percent,
    }),
    z.object({
      ...promotionCreateBase,
      kind: z.literal('bill_flat'),
      rules: PROMOTION_RULE_SCHEMAS.bill_flat,
    }),
    z.object({
      ...promotionCreateBase,
      kind: z.literal('combo_price'),
      rules: PROMOTION_RULE_SCHEMAS.combo_price,
    }),
  ])
  .refine(datesInOrder, { message: 'promotion_dates', path: ['ends_at'] })
export type PromotionCreate = z.input<typeof PromotionCreateSchema>

/**
 * PATCH /promotions/:id — base fields, and/or `kind` + `rules` together (rules are validated
 * for that kind and returned parsed with defaults).
 */
export const PromotionUpdateSchema = z
  .object({
    name: PromotionWritableBase.name.optional(),
    name_ta: PromotionWritableBase.name_ta,
    store_ids: PromotionWritableBase.store_ids.optional(),
    starts_at: PromotionWritableBase.starts_at.optional(),
    ends_at: PromotionWritableBase.ends_at.optional(),
    days_of_week: PromotionWritableBase.days_of_week.optional(),
    priority: PromotionWritableBase.priority.optional(),
    stackable: PromotionWritableBase.stackable.optional(),
    is_active: PromotionWritableBase.is_active.optional(),
    kind: PromotionKindSchema.optional(),
    rules: z.record(z.string(), z.unknown()).optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(datesInOrder, { message: 'promotion_dates', path: ['ends_at'] })
  .refine(notEmpty, { message: 'empty_patch' })
  .transform((v, ctx) => {
    if (v.rules !== undefined && v.kind === undefined) {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'promotion_kind_required' })
      return z.NEVER
    }
    if (v.kind !== undefined && v.rules === undefined) {
      ctx.addIssue({ code: 'custom', path: ['rules'], message: 'promotion_rules_required' })
      return z.NEVER
    }
    if (v.kind === undefined || v.rules === undefined)
      return { ...v, kind: undefined, rules: undefined }
    const parsed = PROMOTION_RULE_SCHEMAS[v.kind].safeParse(v.rules)
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: 'custom',
          path: ['rules', ...issue.path.map(String)],
          message: issue.message,
        })
      return z.NEVER
    }
    return { ...v, kind: v.kind, rules: parsed.data as Record<string, unknown> }
  })
export type PromotionUpdate = z.input<typeof PromotionUpdateSchema>

export const PromotionListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional(),
  kind: PromotionKindSchema.optional(),
  status: PromotionStatusSchema.optional(),
  /** Shortcut for status=active (now within the window, switched on). */
  active: zBooleanQuery.optional(),
  store_id: zId.optional().describe('Promotions valid in this store (incl. all-store ones)'),
  sort: sortQuery(['priority', 'name', 'created_at', 'starts_at'] as const).prefault('-priority'),
})
export type PromotionListQuery = z.input<typeof PromotionListQuerySchema>

/**
 * Explanation of a promotion as a translation key + raw params (paise / bp / counts) — the web
 * renders "Buy 2 get 1 free" / "2 வாங்கினால் 1 இலவசம்" from `catalog:promotion_summary.<key>`.
 */
export function promotionSummary(p: { kind: PromotionKind; rules: unknown }): {
  key: string
  params: Record<string, number>
} {
  const r = (p.rules ?? {}) as Record<string, unknown>
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0)
  const opt = (k: string) => (typeof r[k] === 'number' ? { [k]: r[k] as number } : {})
  switch (p.kind) {
    case 'item_percent':
      return {
        key: 'item_percent',
        params: {
          percent_bp: num('percent_bp'),
          ...opt('min_qty_milli'),
          ...opt('max_discount_paise'),
        },
      }
    case 'item_flat':
      return {
        key: 'item_flat',
        params: { flat_paise: num('flat_paise'), ...opt('min_qty_milli') },
      }
    case 'buy_x_get_y': {
      const discount = typeof r.get_discount_bp === 'number' ? r.get_discount_bp : 10_000
      return discount >= 10_000
        ? { key: 'buy_x_get_y_free', params: { buy_qty: num('buy_qty'), get_qty: num('get_qty') } }
        : {
            key: 'buy_x_get_y_discount',
            params: { buy_qty: num('buy_qty'), get_qty: num('get_qty'), get_discount_bp: discount },
          }
    }
    case 'bill_percent':
      return {
        key: 'bill_percent',
        params: {
          percent_bp: num('percent_bp'),
          ...opt('min_bill_paise'),
          ...opt('max_discount_paise'),
        },
      }
    case 'bill_flat':
      return {
        key: 'bill_flat',
        params: { flat_paise: num('flat_paise'), ...opt('min_bill_paise') },
      }
    case 'combo_price':
      return {
        key: 'combo_price',
        params: {
          item_count: Array.isArray(r.items) ? r.items.length : 0,
          combo_price_paise: num('combo_price_paise'),
        },
      }
  }
}

// =============================================================================================
// Store prices (feature store_pricing)
// =============================================================================================

export const StorePriceListQuerySchema = PageQuerySchema.extend({
  store_id: zId,
  q: zSearchQuery.optional(),
  category_id: zId.optional(),
  overrides_only: zBooleanQuery.default(false).describe('Only products with a store price'),
  sort: sortQuery(['name', 'updated_at'] as const).prefault('name'),
})
export type StorePriceListQuery = z.input<typeof StorePriceListQuerySchema>

/** One grid row: the product's base prices and the store override (null = none). */
export const StorePriceRowSchema = z.object({
  store_id: zId,
  product_id: zId,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  base_sale_price_paise: zPaise,
  base_mrp_paise: zPaise.nullable(),
  store_sale_price_paise: zPaise.nullable(),
  store_mrp_paise: zPaise.nullable(),
  updated_at: zTimestamp.nullable(),
})
export type StorePriceRow = z.output<typeof StorePriceRowSchema>

/** PUT /store-prices — bulk upsert / delete of one store's overrides (audited). */
export const StorePricesUpdateSchema = z
  .object({
    store_id: zId,
    upserts: z
      .array(
        z
          .object({
            product_id: zId,
            sale_price_paise: zPaise,
            mrp_paise: zPaise.nullable().default(null),
          })
          .refine((u) => u.mrp_paise === null || u.mrp_paise >= u.sale_price_paise, {
            message: 'mrp_below_sale_price',
            path: ['sale_price_paise'],
          }),
      )
      .max(1000)
      .default([]),
    deletes: z.array(zId).max(1000).default([]),
  })
  .superRefine((v, ctx) => {
    const ids = v.upserts.map((u) => u.product_id)
    if (!uniqueIds(ids) || !uniqueIds(v.deletes))
      ctx.addIssue({ code: 'custom', path: ['upserts'], message: 'duplicate_id' })
    if (ids.some((id) => v.deletes.includes(id)))
      ctx.addIssue({ code: 'custom', path: ['deletes'], message: 'store_price_conflict' })
    if (ids.length + v.deletes.length === 0)
      ctx.addIssue({ code: 'custom', message: 'empty_patch' })
  })
export type StorePricesUpdate = z.input<typeof StorePricesUpdateSchema>

export const StorePricesUpdateResultSchema = z.object({
  upserted: z.int().min(0),
  deleted: z.int().min(0),
})

// =============================================================================================
// Labels (feature barcode_labels)
// =============================================================================================

export const LabelTemplateCodeSchema = z.enum(['38x25', '50x25', 'a4_65'])
export type LabelTemplateCode = z.infer<typeof LabelTemplateCodeSchema>

export interface LabelTemplate {
  code: LabelTemplateCode
  name_en: string
  name_ta: string
  media: 'roll' | 'a4'
  label_width_mm: number
  label_height_mm: number
  /** Labels across / down a page (roll: 1 × 1 per page). */
  columns: number
  rows: number
  page_width_mm: number
  page_height_mm: number
  margin_top_mm: number
  margin_left_mm: number
  /** Horizontal / vertical gap between labels. */
  gap_x_mm: number
  gap_y_mm: number
}

/** Exact geometry for @page CSS (lib/print). A4 65-up = 38.1 × 21.2 mm, 5 × 13 (L7651 layout). */
export const LABEL_TEMPLATES: Readonly<Record<LabelTemplateCode, LabelTemplate>> = {
  '38x25': {
    code: '38x25',
    name_en: '38 × 25 mm thermal roll',
    name_ta: '38 × 25 மி.மீ தெர்மல் ரோல்',
    media: 'roll',
    label_width_mm: 38,
    label_height_mm: 25,
    columns: 1,
    rows: 1,
    page_width_mm: 38,
    page_height_mm: 25,
    margin_top_mm: 0,
    margin_left_mm: 0,
    gap_x_mm: 0,
    gap_y_mm: 0,
  },
  '50x25': {
    code: '50x25',
    name_en: '50 × 25 mm thermal roll',
    name_ta: '50 × 25 மி.மீ தெர்மல் ரோல்',
    media: 'roll',
    label_width_mm: 50,
    label_height_mm: 25,
    columns: 1,
    rows: 1,
    page_width_mm: 50,
    page_height_mm: 25,
    margin_top_mm: 0,
    margin_left_mm: 0,
    gap_x_mm: 0,
    gap_y_mm: 0,
  },
  a4_65: {
    code: 'a4_65',
    name_en: 'A4 sheet, 65 labels (38.1 × 21.2 mm)',
    name_ta: 'A4 தாள், 65 லேபிள்கள் (38.1 × 21.2 மி.மீ)',
    media: 'a4',
    label_width_mm: 38.1,
    label_height_mm: 21.2,
    columns: 5,
    rows: 13,
    page_width_mm: 210,
    page_height_mm: 297,
    margin_top_mm: 10.7,
    margin_left_mm: 4.7,
    gap_x_mm: 2.5,
    gap_y_mm: 0,
  },
}

/** Most copies per POST /labels. */
export const MAX_LABEL_COPIES = 5000

export const LabelRequestSchema = z
  .object({
    template: LabelTemplateCodeSchema,
    items: z
      .array(
        z.object({
          product_id: zId,
          batch_id: zId.nullable().default(null).describe('Prints batch no. / expiry / batch MRP'),
          copies: z.int().min(1).max(MAX_LABEL_COPIES).default(1),
        }),
      )
      .min(1)
      .max(500),
    store_id: zId.optional().describe('Use this store’s prices (store_pricing)'),
    /** Create internal barcodes for products that have none (else barcode null). */
    generate_missing_barcodes: z.boolean().default(false),
  })
  .refine((v) => v.items.reduce((n, i) => n + i.copies, 0) <= MAX_LABEL_COPIES, {
    message: 'label_copies_limit',
    path: ['items'],
  })
export type LabelRequest = z.input<typeof LabelRequestSchema>

export const LabelSchema = z.object({
  product_id: zId,
  batch_id: zId.nullable(),
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  /** Selling price per pack (batch / store price applied). */
  price_paise: zPaise,
  mrp_paise: zPaise.nullable(),
  barcode: z.string().nullable(),
  barcode_format: z.enum(['EAN13', 'EAN8', 'UPC', 'CODE128']).nullable(),
  /** The barcode was generated by this request. */
  barcode_generated: z.boolean(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  mfg_date: zDateStr.nullable(),
  size: z.string().nullable(),
  color: z.string().nullable(),
  /** 'M / Red' for variants. */
  variant_label: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  copies: z.int().min(1),
})
export type Label = z.output<typeof LabelSchema>

export const LabelTemplateSchema = z.object({
  code: LabelTemplateCodeSchema,
  name_en: z.string(),
  name_ta: z.string(),
  media: z.enum(['roll', 'a4']),
  label_width_mm: z.number(),
  label_height_mm: z.number(),
  columns: z.int(),
  rows: z.int(),
  page_width_mm: z.number(),
  page_height_mm: z.number(),
  margin_top_mm: z.number(),
  margin_left_mm: z.number(),
  gap_x_mm: z.number(),
  gap_y_mm: z.number(),
})

/** POST /labels response: everything the label renderer prints. */
export const LabelPrintModelSchema = z.object({
  template: LabelTemplateSchema,
  shop: z.object({ name: z.string(), name_ta: z.string().nullable() }),
  labels: z.array(LabelSchema),
  total_copies: z.int().min(0),
})
export type LabelPrintModel = z.output<typeof LabelPrintModelSchema>

// =============================================================================================
// Units & HSN directory
// =============================================================================================

export const UnitSchema = z.object({
  code: z.string(),
  name_en: z.string(),
  name_ta: z.string(),
  uqc: z.string(),
  decimal_allowed: z.boolean(),
  family: z.enum(['count', 'weight', 'volume', 'length', 'area', 'pack']),
  symbol_en: z.string(),
  symbol_en_plural: z.string(),
  symbol_ta: z.string(),
})
export const UnitsResponseSchema = z.object({
  units: z.array(UnitSchema),
  /** Codes suggested for the tenant's vertical (show first). */
  suggested: z.array(z.string()),
})
export type UnitsResponse = z.output<typeof UnitsResponseSchema>

export const HsnSearchQuerySchema = z.object({
  q: zSearchQuery.describe('Code prefix (e.g. 1006) or words (e.g. "rice")'),
  limit: zQueryInt(1, 50).default(20),
})
export type HsnSearchQuery = z.input<typeof HsnSearchQuerySchema>

/** Curated HSN entry (modules/catalog/data/hsn.json; verify rates with current notifications). */
export const HsnEntrySchema = z.object({
  code: z.string(),
  description: z.string(),
  /** Suggested GST rate (null when it depends on value / form). */
  gst_rate_bp: z.int().min(0).nullable(),
  /** Group label, e.g. 'Groceries', 'Pharma'. */
  group: z.string().nullable(),
  /** A price-slab rule usually applies (apparel/footwear). */
  slab_rule_hint: z.string().nullable(),
})
export type HsnEntry = z.output<typeof HsnEntrySchema>

// =============================================================================================
// Route catalogue (docs/API.md "catalog")
// =============================================================================================

const IdParams = z.object({ id: zId })
const BarcodeParams = z.object({ id: zId, barcodeId: zId })

export const catalogRoutes = defineRoutes({
  // ---- categories ----------------------------------------------------------------------------
  listCategories: {
    method: 'GET',
    path: '/categories',
    permission: 'catalog.read',
    query: CategoryListQuerySchema,
    response: dataOf(z.array(CategoryNodeSchema)),
    summary: 'Category tree (or ?flat=true list with paths); not paginated',
  },
  createCategory: {
    method: 'POST',
    path: '/categories',
    permission: 'catalog.write',
    body: CategoryCreateSchema,
    response: dataOf(CategorySchema),
    status: 201,
    summary: 'Create a category (max depth 3; name unique per parent)',
  },
  getCategory: {
    method: 'GET',
    path: '/categories/:id',
    permission: 'catalog.read',
    params: IdParams,
    response: dataOf(CategoryDetailSchema),
  },
  updateCategory: {
    method: 'PATCH',
    path: '/categories/:id',
    permission: 'catalog.write',
    params: IdParams,
    body: CategoryUpdateSchema,
    response: dataOf(CategorySchema),
  },
  deleteCategory: {
    method: 'DELETE',
    path: '/categories/:id',
    permission: 'catalog.write',
    params: IdParams,
    summary: 'Delete an unused category (409 with hint "deactivate" when it has products/children)',
  },

  // ---- brands --------------------------------------------------------------------------------
  listBrands: {
    method: 'GET',
    path: '/brands',
    permission: 'catalog.read',
    query: BrandListQuerySchema,
    response: listOf(BrandSchema),
  },
  createBrand: {
    method: 'POST',
    path: '/brands',
    permission: 'catalog.write',
    body: BrandCreateSchema,
    response: dataOf(BrandSchema),
    status: 201,
  },
  updateBrand: {
    method: 'PATCH',
    path: '/brands/:id',
    permission: 'catalog.write',
    params: IdParams,
    body: BrandUpdateSchema,
    response: dataOf(BrandSchema),
  },
  deleteBrand: {
    method: 'DELETE',
    path: '/brands/:id',
    permission: 'catalog.write',
    params: IdParams,
    summary: 'Delete an unused brand (409 with hint "deactivate" when products use it)',
  },

  // ---- tax slab rules ------------------------------------------------------------------------
  listTaxSlabRules: {
    method: 'GET',
    path: '/tax-slab-rules',
    permission: 'catalog.read',
    query: TaxSlabRuleListQuerySchema,
    response: listOf(TaxSlabRuleSchema),
  },
  createTaxSlabRule: {
    method: 'POST',
    path: '/tax-slab-rules',
    permission: 'catalog.write',
    body: TaxSlabRuleCreateSchema,
    response: dataOf(TaxSlabRuleSchema),
    status: 201,
  },
  getTaxSlabRule: {
    method: 'GET',
    path: '/tax-slab-rules/:id',
    permission: 'catalog.read',
    params: IdParams,
    response: dataOf(TaxSlabRuleSchema),
  },
  updateTaxSlabRule: {
    method: 'PATCH',
    path: '/tax-slab-rules/:id',
    permission: 'catalog.write',
    params: IdParams,
    body: TaxSlabRuleUpdateSchema,
    response: dataOf(TaxSlabRuleSchema),
  },
  deleteTaxSlabRule: {
    method: 'DELETE',
    path: '/tax-slab-rules/:id',
    permission: 'catalog.write',
    params: IdParams,
    summary: 'Delete a rule (409 when products or categories reference it)',
  },

  // ---- products ------------------------------------------------------------------------------
  listProducts: {
    method: 'GET',
    path: '/products',
    permission: 'catalog.read',
    query: ProductListQuerySchema,
    response: listOf(ProductListItemSchema),
  },
  lookupProduct: {
    method: 'GET',
    path: '/products/lookup',
    permission: 'catalog.read',
    query: ProductLookupQuerySchema,
    response: dataOf(ProductLookupResultSchema),
    summary: 'Scan lookup: barcode → SKU → scale barcode (404 when nothing matches)',
  },
  exportProducts: {
    method: 'GET',
    path: '/products/export',
    permission: 'catalog.read',
    query: ProductExportQuerySchema,
    stream: 'csv',
    summary: 'CSV export with the import columns of the tenant vertical (audited)',
  },
  productImportTemplate: {
    method: 'GET',
    path: '/products/import/template',
    permission: 'catalog.write',
    query: ProductImportTemplateQuerySchema,
    stream: 'csv',
    summary: 'Import template CSV for a vertical',
  },
  importProducts: {
    method: 'POST',
    path: '/products/import',
    permission: 'catalog.write',
    idempotent: true,
    body: ProductImportSchema,
    response: dataOf(ImportJobSchema),
    status: 201,
    summary: 'Validate (dry run) or import a CSV; > 1000 rows run as a job (poll GET /imports/:id)',
  },
  bulkUpdateProducts: {
    method: 'POST',
    path: '/products/bulk-update',
    permission: 'catalog.write',
    body: ProductBulkUpdateSchema,
    response: dataOf(ProductBulkUpdateResultSchema),
    summary: 'Change GST, category, brand, status or price of up to 500 products (audited)',
  },
  createProduct: {
    method: 'POST',
    path: '/products',
    permission: 'catalog.write',
    idempotent: true,
    body: ProductCreateSchema,
    response: dataOf(ProductDetailSchema),
    status: 201,
    summary: 'Create a product (plan limit products)',
  },
  getProduct: {
    method: 'GET',
    path: '/products/:id',
    permission: 'catalog.read',
    params: IdParams,
    query: z.object({ store_id: zId.optional() }),
    response: dataOf(ProductDetailSchema),
  },
  updateProduct: {
    method: 'PATCH',
    path: '/products/:id',
    permission: 'catalog.write',
    params: IdParams,
    body: ProductUpdateSchema,
    response: dataOf(ProductDetailSchema),
  },
  deleteProduct: {
    method: 'DELETE',
    path: '/products/:id',
    permission: 'catalog.write',
    params: IdParams,
    response: dataOf(DeleteResultSchema),
    summary: 'Delete a never-used product, otherwise deactivate it (audited)',
  },
  generateVariants: {
    method: 'POST',
    path: '/products/:id/variants',
    permission: 'catalog.write',
    feature: 'variants',
    params: IdParams,
    body: VariantGenerateSchema,
    response: dataOf(VariantGenerateResultSchema),
    summary: 'Create the missing size × colour combinations as variants (idempotent)',
  },
  addBarcode: {
    method: 'POST',
    path: '/products/:id/barcodes',
    permission: 'catalog.write',
    params: IdParams,
    body: BarcodeAddSchema,
    response: dataOf(ProductBarcodeSchema),
    status: 201,
    summary: 'Add a barcode (unique per business) or generate an internal EAN-13',
  },
  deleteBarcode: {
    method: 'DELETE',
    path: '/products/:id/barcodes/:barcodeId',
    permission: 'catalog.write',
    params: BarcodeParams,
  },

  // ---- imports -------------------------------------------------------------------------------
  getImport: {
    method: 'GET',
    path: '/imports/:id',
    permission: ['catalog.write', 'customers.write'],
    params: IdParams,
    response: dataOf(ImportJobSchema),
    summary: 'Import status, progress and errors (products and customers)',
  },

  // ---- promotions ----------------------------------------------------------------------------
  listPromotions: {
    method: 'GET',
    path: '/promotions',
    permission: 'catalog.read',
    feature: 'promotions',
    query: PromotionListQuerySchema,
    response: listOf(PromotionResponseSchema),
  },
  createPromotion: {
    method: 'POST',
    path: '/promotions',
    permission: 'catalog.write',
    feature: 'promotions',
    body: PromotionCreateSchema,
    response: dataOf(PromotionResponseSchema),
    status: 201,
  },
  getPromotion: {
    method: 'GET',
    path: '/promotions/:id',
    permission: 'catalog.read',
    feature: 'promotions',
    params: IdParams,
    response: dataOf(PromotionResponseSchema),
  },
  updatePromotion: {
    method: 'PATCH',
    path: '/promotions/:id',
    permission: 'catalog.write',
    feature: 'promotions',
    params: IdParams,
    body: PromotionUpdateSchema,
    response: dataOf(PromotionResponseSchema),
  },
  deletePromotion: {
    method: 'DELETE',
    path: '/promotions/:id',
    permission: 'catalog.write',
    feature: 'promotions',
    params: IdParams,
    response: dataOf(DeleteResultSchema),
    summary: 'Delete a never-applied promotion, otherwise deactivate it',
  },

  // ---- store prices --------------------------------------------------------------------------
  listStorePrices: {
    method: 'GET',
    path: '/store-prices',
    permission: 'catalog.write',
    feature: 'store_pricing',
    query: StorePriceListQuerySchema,
    response: listOf(StorePriceRowSchema),
  },
  updateStorePrices: {
    method: 'PUT',
    path: '/store-prices',
    permission: 'catalog.write',
    feature: 'store_pricing',
    body: StorePricesUpdateSchema,
    response: dataOf(StorePricesUpdateResultSchema),
    summary: 'Bulk upsert / delete store price overrides (audited)',
  },

  // ---- labels, units, HSN --------------------------------------------------------------------
  printLabels: {
    method: 'POST',
    path: '/labels',
    permission: 'catalog.read',
    feature: 'barcode_labels',
    body: LabelRequestSchema,
    response: dataOf(LabelPrintModelSchema),
    summary: 'Label print model (generating missing barcodes needs catalog.write)',
  },
  listUnits: {
    method: 'GET',
    path: '/units',
    response: dataOf(UnitsResponseSchema),
  },
  searchHsn: {
    method: 'GET',
    path: '/hsn/search',
    query: HsnSearchQuerySchema,
    response: dataOf(z.array(HsnEntrySchema)),
    summary: 'Curated HSN directory search with suggested GST rates',
  },
})

/** Re-exported for forms that edit one slab. */
export { TaxSlabSchema }
