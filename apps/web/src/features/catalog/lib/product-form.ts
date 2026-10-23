/**
 * Product form model: UI values ↔ contract bodies (POST /products, PATCH /products/:id) and the
 * react-hook-form resolver. Validation runs the CONTRACT schemas (ProductCreateSchema /
 * ProductUpdateSchema incl. productRuleIssues) on the body the form would send, plus the vertical
 * attribute schema, so the browser shows exactly the errors the server would return.
 */
import {
  type Category,
  type ProductCreate,
  ProductCreateSchema,
  type ProductDetail,
  type ProductUpdate,
  ProductUpdateSchema,
} from '@kadai/shared/api/catalog'
import type { BusinessType, ProductKind } from '@kadai/shared/enums'
import type { GstRateBp } from '@kadai/shared/gst'
import type { TenantSettings } from '@kadai/shared/settings'
import { isDecimalUnit } from '@kadai/shared/units'
import { validateAttributes } from '@kadai/shared/verticals'
import { type FieldErrors, type FieldValues, type Resolver, set } from 'react-hook-form'
import type { z } from 'zod'
import type { BrandPickerValue } from '@/components/pickers'
import { validationToken } from '@/lib/validation'

export type AttributeValue = string | number | boolean | null

export interface BarcodeDraft {
  barcode: string
  qty_milli: number
}

export interface ProductFormValues {
  kind: ProductKind
  name: string
  name_ta: string
  aliases: string[]
  description: string
  sku: string
  category_id: string | null
  brand: BrandPickerValue | null
  unit: string
  pack_size: number | null
  allow_loose: boolean
  decimal_qty: boolean
  hsn_code: string
  gst_rate_bp: number | null
  cess_rate_bp: number | null
  tax_slab_rule_id: string | null
  price_includes_tax: boolean
  mrp_paise: number | null
  sale_price_paise: number | null
  wholesale_price_paise: number | null
  purchase_price_paise: number | null
  min_sale_price_paise: number | null
  max_discount_bp: number | null
  track_inventory: boolean
  track_batches: boolean
  is_weighed: boolean
  scale_plu: string
  reorder_level_milli: number | null
  reorder_qty_milli: number | null
  attributes: Record<string, AttributeValue>
  image_file_id: string | null
  is_active: boolean
  /** Explicitly accept an MRP below the selling price. */
  allow_mrp_below_sale: boolean
  // ---- new products only ----
  barcodes: BarcodeDraft[]
  generate_barcode: boolean
  /** Opening stock in the current store (non-batch products; needs inventory.adjust). */
  opening_stock_milli: number | null
}

export interface ProductFormContext {
  settings: TenantSettings
  businessType: BusinessType
}

export type ProductFormMode = 'create' | 'edit'

/** Defaults of a new product from the tenant settings and vertical. */
export function defaultProductValues(ctx: ProductFormContext): ProductFormValues {
  const unit = ctx.settings.catalog.default_unit
  const pharmacy = ctx.businessType === 'pharmacy'
  return {
    kind: 'standard',
    name: '',
    name_ta: '',
    aliases: [],
    description: '',
    sku: '',
    category_id: null,
    brand: null,
    unit,
    pack_size: 1,
    allow_loose: false,
    decimal_qty: isDecimalUnit(unit),
    hsn_code: '',
    gst_rate_bp: ctx.settings.catalog.default_gst_rate_bp ?? 0,
    cess_rate_bp: 0,
    tax_slab_rule_id: null,
    price_includes_tax: ctx.settings.invoice.default_price_includes_tax,
    mrp_paise: null,
    sale_price_paise: null,
    wholesale_price_paise: null,
    purchase_price_paise: null,
    min_sale_price_paise: null,
    max_discount_bp: null,
    track_inventory: true,
    track_batches: ctx.settings.catalog.default_track_batches || pharmacy,
    is_weighed: false,
    scale_plu: '',
    reorder_level_milli: null,
    reorder_qty_milli: null,
    attributes: pharmacy ? { schedule: 'OTC' } : {},
    image_file_id: null,
    is_active: true,
    allow_mrp_below_sale: false,
    barcodes: [],
    generate_barcode: ctx.settings.catalog.auto_generate_barcode,
    opening_stock_milli: null,
  }
}

function attributeValues(raw: Record<string, unknown>): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
      out[k] = v
  }
  return out
}

/** Form values of an existing product. */
export function valuesFromProduct(p: ProductDetail): ProductFormValues {
  return {
    kind: p.kind,
    name: p.name,
    name_ta: p.name_ta ?? '',
    aliases: [...p.aliases],
    description: p.description ?? '',
    sku: p.sku ?? '',
    category_id: p.category_id,
    brand: p.brand ? { id: p.brand.id, name: p.brand.name } : null,
    unit: p.unit,
    pack_size: p.pack_size,
    allow_loose: p.allow_loose,
    decimal_qty: p.decimal_qty,
    hsn_code: p.hsn_code ?? '',
    gst_rate_bp: p.gst_rate_bp,
    cess_rate_bp: p.cess_rate_bp,
    tax_slab_rule_id: p.tax_slab_rule_id,
    price_includes_tax: p.price_includes_tax,
    mrp_paise: p.mrp_paise,
    sale_price_paise: p.sale_price_paise,
    wholesale_price_paise: p.wholesale_price_paise,
    purchase_price_paise: p.purchase_price_paise,
    min_sale_price_paise: p.min_sale_price_paise,
    max_discount_bp: p.max_discount_bp,
    track_inventory: p.track_inventory,
    track_batches: p.track_batches,
    is_weighed: p.is_weighed,
    scale_plu: p.scale_plu ?? '',
    reorder_level_milli: p.reorder_level_milli,
    reorder_qty_milli: p.reorder_qty_milli,
    attributes: attributeValues(p.attributes),
    image_file_id: p.image_file_id,
    is_active: p.is_active,
    allow_mrp_below_sale: p.mrp_paise !== null && p.mrp_paise < p.sale_price_paise,
    barcodes: [],
    generate_barcode: false,
    opening_stock_milli: null,
  }
}

/**
 * Every attribute key of the vertical present (null when unset), so the attribute inputs are
 * registered with a defined value and a fresh form is not "dirty".
 */
export function withAttributeKeys(
  v: ProductFormValues,
  keys: readonly string[],
): ProductFormValues {
  const attributes: Record<string, AttributeValue> = Object.fromEntries(keys.map((k) => [k, null]))
  return { ...v, attributes: { ...attributes, ...v.attributes } }
}

/** Attributes without empty values ('' / null), strings trimmed. */
export function cleanAttributes(
  attrs: Record<string, AttributeValue>,
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string') {
      const s = v.trim()
      if (s) out[k] = s
    } else out[k] = v
  }
  return out
}

const nullIfBlank = (s: string): string | null => (s.trim() === '' ? null : s.trim())

/** Writable product fields of the form values (shared by create, update and the diff). */
function writable(v: ProductFormValues) {
  return {
    name: v.name.trim(),
    name_ta: nullIfBlank(v.name_ta),
    aliases: v.aliases.map((a) => a.trim()).filter(Boolean),
    description: nullIfBlank(v.description),
    sku: nullIfBlank(v.sku),
    category_id: v.category_id,
    brand_id: v.brand?.id ?? null,
    unit: v.unit,
    pack_size: v.pack_size ?? 1,
    allow_loose: v.allow_loose,
    decimal_qty: v.decimal_qty,
    hsn_code: nullIfBlank(v.hsn_code),
    // Values come from the GST select (GST_RATES_BP); the contract schema re-checks them.
    gst_rate_bp: (v.gst_rate_bp ?? 0) as GstRateBp,
    cess_rate_bp: v.cess_rate_bp ?? 0,
    tax_slab_rule_id: v.tax_slab_rule_id,
    price_includes_tax: v.price_includes_tax,
    mrp_paise: v.mrp_paise,
    sale_price_paise: v.sale_price_paise ?? 0,
    wholesale_price_paise: v.wholesale_price_paise,
    purchase_price_paise: v.purchase_price_paise ?? 0,
    min_sale_price_paise: v.min_sale_price_paise,
    max_discount_bp: v.max_discount_bp,
    track_inventory: v.kind === 'service' ? false : v.track_inventory,
    track_batches: v.kind === 'service' ? false : v.track_batches,
    is_weighed: v.is_weighed,
    scale_plu: v.is_weighed ? nullIfBlank(v.scale_plu) : null,
    reorder_level_milli: v.reorder_level_milli,
    reorder_qty_milli: v.reorder_qty_milli,
    attributes: cleanAttributes(v.attributes),
    image_file_id: v.image_file_id,
    is_active: v.is_active,
  }
}

type Writable = ReturnType<typeof writable>

/** POST /products body. */
export function toCreateBody(v: ProductFormValues): ProductCreate {
  const kind = v.kind === 'variant' ? 'standard' : v.kind
  return {
    kind,
    ...writable(v),
    barcodes: v.barcodes.map((b) => ({ barcode: b.barcode.trim(), qty_milli: b.qty_milli })),
    generate_barcode: v.barcodes.length === 0 ? v.generate_barcode : false,
    allow_mrp_below_sale: v.allow_mrp_below_sale,
  }
}

/** Every writable field as a PATCH body (validation of the whole edited product). */
function fullUpdateBody(v: ProductFormValues): ProductUpdate {
  return {
    ...writable(v),
    ...(v.kind === 'standard' || v.kind === 'service' ? { kind: v.kind } : {}),
    allow_mrp_below_sale: v.allow_mrp_below_sale,
  }
}

/**
 * PATCH /products/:id body: only the fields the user changed (values vs the baseline the form was
 * loaded / last saved with), plus `if_updated_at` of the product as last fetched (409 STALE_WRITE
 * when someone else saved in between). null = nothing changed.
 */
export function toUpdateBody(
  v: ProductFormValues,
  baseline: ProductFormValues,
  original: Pick<ProductDetail, 'kind' | 'updated_at'>,
): ProductUpdate | null {
  const next = writable(v)
  const before = writable(baseline)
  const patch: Partial<Record<keyof Writable, unknown>> = {}
  for (const key of Object.keys(next) as (keyof Writable)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(before[key])) patch[key] = next[key]
  }
  const kindChanged =
    v.kind !== baseline.kind &&
    (v.kind === 'standard' || v.kind === 'service') &&
    (original.kind === 'standard' || original.kind === 'service')
  if (Object.keys(patch).length === 0 && !kindChanged) return null
  return {
    ...(patch as ProductUpdate),
    ...(kindChanged ? { kind: v.kind as 'standard' | 'service' } : {}),
    ...(v.allow_mrp_below_sale ? { allow_mrp_below_sale: true } : {}),
    if_updated_at: original.updated_at,
  }
}

/** Form field that a contract issue path points at. */
function fieldPath(path: readonly PropertyKey[]): string {
  const [head, ...rest] = path.map(String)
  if (head === 'brand_id') return 'brand'
  return [head ?? 'root', ...rest].join('.')
}

/** Issues → nested react-hook-form errors (first issue per field wins). */
function toFieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): FieldErrors<ProductFormValues> {
  const errors: FieldErrors<ProductFormValues> = {}
  const seen = new Set<string>()
  for (const issue of issues) {
    const path = fieldPath(issue.path)
    if (seen.has(path)) continue
    seen.add(path)
    set(errors, path, { type: 'validate', message: issue.message })
  }
  return errors
}

/** All validation issues of the form values (contract + attributes + required fields). */
export function productFormIssues(
  v: ProductFormValues,
  mode: ProductFormMode,
  ctx: ProductFormContext,
): { path: readonly PropertyKey[]; message: string }[] {
  const issues: { path: readonly PropertyKey[]; message: string }[] = []
  const required = validationToken('required')
  if (v.sale_price_paise === null) issues.push({ path: ['sale_price_paise'], message: required })
  if (v.pack_size === null) issues.push({ path: ['pack_size'], message: required })
  if (v.gst_rate_bp === null)
    issues.push({ path: ['gst_rate_bp'], message: validationToken('select') })
  if (!v.unit) issues.push({ path: ['unit'], message: validationToken('select') })
  if (v.is_weighed && !v.scale_plu.trim() && ctx.settings.pos.scale_barcode.enabled)
    issues.push({ path: ['scale_plu'], message: required })

  const schema: z.ZodType = mode === 'create' ? ProductCreateSchema : ProductUpdateSchema
  const body = mode === 'create' ? toCreateBody(v) : fullUpdateBody(v)
  const parsed = schema.safeParse(body)
  if (!parsed.success) issues.push(...parsed.error.issues)

  const attrs = validateAttributes(ctx.businessType, cleanAttributes(v.attributes))
  if (!attrs.success)
    issues.push(...attrs.error.issues.map((i) => ({ ...i, path: ['attributes', ...i.path] })))
  return issues
}

/** react-hook-form resolver running {@link productFormIssues}. */
export function productResolver(
  mode: ProductFormMode,
  ctx: ProductFormContext,
): Resolver<ProductFormValues> {
  return (values) => {
    const issues = productFormIssues(values, mode, ctx)
    if (issues.length === 0) return { values, errors: {} }
    return { values: {}, errors: toFieldErrors(issues) as FieldErrors<FieldValues> }
  }
}

/**
 * Tax defaults a category gives a new product (its own values, else the nearest ancestor's):
 * what the server would fill in when the product leaves them empty.
 */
export function categoryTaxDefaults(
  categories: readonly Category[],
  categoryId: string | null,
): { hsn_code: string | null; gst_rate_bp: number | null; tax_slab_rule_id: string | null } {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const out = {
    hsn_code: null as string | null,
    gst_rate_bp: null as number | null,
    tax_slab_rule_id: null as string | null,
  }
  let cur = categoryId ? byId.get(categoryId) : undefined
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.hsn_code ??= cur.hsn_code
    out.gst_rate_bp ??= cur.gst_rate_bp
    out.tax_slab_rule_id ??= cur.tax_slab_rule_id
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return out
}
