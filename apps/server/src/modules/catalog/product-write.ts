/**
 * Product writes: create (defaults from settings and the category, vertical attributes, rules,
 * auto SKU / barcode, plan limit), PATCH (optimistic concurrency, merged-rule validation, audit of
 * price / GST changes and deactivation, variant-parent propagation), DELETE (hard delete of a
 * never-used product, else deactivate) and bulk update.
 */
import { sql } from 'kysely'
import {
  type BusinessType,
  type TenantSettings,
  hasPermission,
  isDecimalUnit,
  isUnitCode,
  isValidGstRate,
  newId,
  validateAttributes,
} from '@kadai/shared'
import {
  type ProductBulkUpdate,
  type ProductBulkUpdateResult,
  type ProductCreateParsed,
  type ProductDetail,
  type ProductUpdateParsed,
  applyPriceChange,
  normalizeProductFlags,
  productRuleIssues,
} from '@kadai/shared/api/catalog'
import type { DeleteResult } from '@kadai/shared/api/identity'
import type { ProductBulkUpdateSchema } from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { assertWithinLimit } from '../../core/entitlements'
import { AppError, assertNotStale, forbidden } from '../../core/errors'
import { getSettings } from '../../core/settings'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { inheritedTaxDefaults } from './categories'
import { PRODUCT_COLUMNS, type ProductRow, getProductDetail, loadProductRow } from './product-read'
import { generateAutoSkus, generateInternalBarcodes } from './sequences'
import {
  type Ctx,
  type TenantInfo,
  conflictReason,
  duplicateReason,
  issue,
  issues,
  jsonObject,
  pgCode,
  tenantInfo,
  withSavepoint,
} from './shared'

// ---------------------------------------------------------------------------------------------
// Environment & shared rules
// ---------------------------------------------------------------------------------------------

export interface CatalogEnv {
  settings: TenantSettings
  tenant: TenantInfo
}

export async function catalogEnv(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<CatalogEnv> {
  const [settings, tenant] = await Promise.all([getSettings(tx, ctx), tenantInfo(tx, ctx)])
  return { settings, tenant }
}

export function defaultUnit(settings: TenantSettings): string {
  const u = settings.catalog.default_unit.trim().toUpperCase()
  return isUnitCode(u) ? u : 'PCS'
}

/**
 * Medicine (pharmacy vertical): scheduled drug, a dosage form other than 'device', or a generic
 * name / composition. Medicines must track batches & expiry when settings.catalog
 * .default_track_batches is on (Drugs & Cosmetics Rules record keeping).
 */
export function isMedicine(attributes: Record<string, unknown>): boolean {
  const schedule = attributes.schedule
  if (typeof schedule === 'string' && ['G', 'H', 'H1', 'X'].includes(schedule)) return true
  const form = attributes.dosage_form
  if (typeof form === 'string' && form !== 'device') return true
  return ['generic_name', 'composition'].some(
    (k) => typeof attributes[k] === 'string' && (attributes[k] as string).trim() !== '',
  )
}

export function forcedTrackBatches(
  env: CatalogEnv,
  kind: string,
  attributes: Record<string, unknown>,
): boolean {
  return (
    env.tenant.business_type === 'pharmacy' &&
    env.settings.catalog.default_track_batches &&
    kind !== 'service' &&
    isMedicine(attributes)
  )
}

/** Validates vertical attributes (normalised, e.g. pharmacy schedule defaults to OTC). */
export function validateProductAttributes(
  businessType: BusinessType,
  attributes: Record<string, unknown>,
  path = 'attributes',
): Record<string, unknown> {
  const res = validateAttributes(businessType, attributes)
  if (!res.success) {
    throw issues(
      res.error.issues.map((i) => ({
        path: [path, ...i.path.map(String)].join('.'),
        message: 'attribute_invalid',
        code: i.code,
      })),
    )
  }
  return res.data
}

export interface ProductRefs {
  category_id?: string | null | undefined
  brand_id?: string | null | undefined
  tax_slab_rule_id?: string | null | undefined
  image_file_id?: string | null | undefined
}

/** Referenced rows must exist in the tenant (400 reference_not_found on the field). */
export async function assertProductRefs(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  refs: ProductRefs,
  pathPrefix = '',
): Promise<void> {
  const t = ctx.tenantId
  const checks: Array<Promise<void>> = []
  const check = (field: string, run: () => Promise<unknown>) =>
    checks.push(
      run().then((row) => {
        if (!row) throw issue(`${pathPrefix}${field}`, 'reference_not_found')
      }),
    )
  if (refs.category_id)
    check('category_id', () =>
      tx
        .selectFrom('categories')
        .select('id')
        .where('tenant_id', '=', t)
        .where('id', '=', refs.category_id!)
        .executeTakeFirst(),
    )
  if (refs.brand_id)
    check('brand_id', () =>
      tx
        .selectFrom('brands')
        .select('id')
        .where('tenant_id', '=', t)
        .where('id', '=', refs.brand_id!)
        .executeTakeFirst(),
    )
  if (refs.tax_slab_rule_id)
    check('tax_slab_rule_id', () =>
      tx
        .selectFrom('tax_slab_rules')
        .select('id')
        .where('tenant_id', '=', t)
        .where('id', '=', refs.tax_slab_rule_id!)
        .executeTakeFirst(),
    )
  if (refs.image_file_id)
    check('image_file_id', () =>
      tx
        .selectFrom('files')
        .select('id')
        .where('tenant_id', '=', t)
        .where('id', '=', refs.image_file_id!)
        .where('purpose', '=', 'product_image')
        .executeTakeFirst(),
    )
  const results = await Promise.allSettled(checks)
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

export async function assertSkuFree(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  sku: string,
  exceptId: string | null,
): Promise<void> {
  let q = tx
    .selectFrom('products')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where(sql<boolean>`lower(sku) = lower(${sku})`)
  if (exceptId) q = q.where('id', '<>', exceptId)
  const row = await q.executeTakeFirst()
  if (row)
    throw duplicateReason('Another product already has this SKU', 'sku_taken', {
      field: 'sku',
      existing_id: row.id,
    })
}

export async function assertScalePluFree(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  plu: string,
  exceptId: string | null,
): Promise<void> {
  let q = tx
    .selectFrom('products')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('scale_plu', '=', plu)
  if (exceptId) q = q.where('id', '<>', exceptId)
  const row = await q.executeTakeFirst()
  if (row)
    throw duplicateReason('Another product already has this scale item code', 'scale_plu_taken', {
      field: 'scale_plu',
      existing_id: row.id,
    })
}

/** 409 DUPLICATE barcode_taken when any code is used by a product of the tenant. */
export async function assertBarcodesFree(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  codes: readonly string[],
  path = 'barcodes',
): Promise<void> {
  if (codes.length === 0) return
  const row = await tx
    .selectFrom('product_barcodes')
    .select(['barcode', 'product_id'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('barcode', 'in', [...codes])
    .executeTakeFirst()
  if (row)
    throw duplicateReason('This barcode is already used by another product', 'barcode_taken', {
      field: path,
      barcode: row.barcode,
      existing_id: row.product_id,
    })
}

/**
 * A variant parent is not sold itself (each size / colour is), so its barcodes would scan to an
 * unsellable product: barcodes go on the variants.
 */
export function variantParentBarcodeError(path: string): AppError {
  return new AppError('UNPROCESSABLE', 'Barcodes belong on the variants, not the parent', {
    reason: 'product_kind',
    path,
  })
}

/** Case barcodes of whole-unit products must represent whole units. */
export function barcodeQtyOk(
  p: { decimal_qty: boolean; allow_loose: boolean },
  qtyMilli: number,
): boolean {
  return p.decimal_qty || p.allow_loose || qtyMilli % 1000 === 0
}

function ruleError(list: ReturnType<typeof productRuleIssues>): never {
  throw issues(list.map((i) => ({ path: i.path, message: i.code, code: 'custom' })))
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export async function createProduct(
  tx: Tx,
  ctx: Ctx,
  body: ProductCreateParsed,
): Promise<ProductDetail> {
  const env = await catalogEnv(tx, ctx)
  await assertProductRefs(tx, ctx, body)
  const inherited = await inheritedTaxDefaults(tx, ctx, body.category_id)
  const unit = body.unit ?? defaultUnit(env.settings)
  const attributes = validateProductAttributes(env.tenant.business_type, body.attributes)
  const flags = normalizeProductFlags({
    kind: body.kind,
    track_inventory: body.track_inventory,
    track_batches:
      forcedTrackBatches(env, body.kind, attributes) ||
      (body.track_batches ?? env.settings.catalog.default_track_batches),
  })
  const inheritedRate =
    inherited.gst_rate_bp !== null && isValidGstRate(inherited.gst_rate_bp)
      ? inherited.gst_rate_bp
      : null
  const draft = {
    kind: body.kind,
    unit,
    pack_size: body.pack_size,
    allow_loose: body.allow_loose,
    decimal_qty: body.decimal_qty ?? isDecimalUnit(unit),
    track_inventory: flags.track_inventory,
    track_batches: flags.track_batches,
    mrp_paise: body.mrp_paise,
    sale_price_paise: body.sale_price_paise,
    min_sale_price_paise: body.min_sale_price_paise,
  }
  const ruleIssues = productRuleIssues({
    ...draft,
    allow_mrp_below_sale: body.allow_mrp_below_sale,
  })
  if (ruleIssues.length) ruleError(ruleIssues)
  if (body.kind === 'variant_parent' && body.barcodes.length > 0)
    throw variantParentBarcodeError('barcodes')
  body.barcodes.forEach((b, i) => {
    if (!barcodeQtyOk(draft, b.qty_milli))
      throw issue(`barcodes.${String(i)}.qty_milli`, 'barcode_qty_whole')
  })

  let sku = body.sku ?? null
  if (sku) await assertSkuFree(tx, ctx, sku, null)
  else if (env.settings.catalog.auto_sku)
    sku = (await generateAutoSkus(tx, ctx, env.settings.catalog.sku_prefix, 1))[0]!
  const scalePlu = body.scale_plu ?? null
  if (scalePlu) await assertScalePluFree(tx, ctx, scalePlu, null)
  await assertBarcodesFree(
    tx,
    ctx,
    body.barcodes.map((b) => b.barcode),
  )
  if (body.is_active) await assertWithinLimit(tx, ctx, 'products')

  const row = await tx
    .insertInto('products')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      kind: body.kind,
      sku,
      name: body.name,
      name_ta: body.name_ta ?? null,
      aliases: body.aliases,
      description: body.description ?? null,
      category_id: body.category_id,
      brand_id: body.brand_id,
      unit,
      pack_size: draft.pack_size,
      allow_loose: draft.allow_loose,
      decimal_qty: draft.decimal_qty,
      hsn_code: body.hsn_code === undefined ? inherited.hsn_code : body.hsn_code,
      gst_rate_bp:
        body.gst_rate_bp ?? inheritedRate ?? env.settings.catalog.default_gst_rate_bp ?? 0,
      cess_rate_bp: body.cess_rate_bp,
      tax_slab_rule_id:
        body.tax_slab_rule_id === undefined ? inherited.tax_slab_rule_id : body.tax_slab_rule_id,
      price_includes_tax:
        body.price_includes_tax ?? env.settings.invoice.default_price_includes_tax,
      mrp_paise: body.mrp_paise,
      sale_price_paise: body.sale_price_paise,
      wholesale_price_paise: body.wholesale_price_paise,
      purchase_price_paise: body.purchase_price_paise,
      min_sale_price_paise: body.min_sale_price_paise,
      max_discount_bp: body.max_discount_bp,
      track_inventory: draft.track_inventory,
      track_batches: draft.track_batches,
      is_weighed: body.is_weighed,
      scale_plu: scalePlu,
      reorder_level_milli: body.reorder_level_milli,
      reorder_qty_milli: body.reorder_qty_milli,
      attributes: jsonb(attributes),
      image_file_id: body.image_file_id,
      is_active: body.is_active,
      created_by: ctx.userId,
    })
    .returning(['id', 'name', 'sku'])
    .executeTakeFirstOrThrow()

  const codes = body.barcodes.map((b) => ({ barcode: b.barcode, qty_milli: b.qty_milli }))
  // Settings generate codes for sellable goods; a service gets one only when asked explicitly.
  const generate =
    body.generate_barcode ??
    (env.settings.catalog.auto_generate_barcode && body.kind === 'standard')
  if (codes.length === 0 && generate && body.kind !== 'variant_parent') {
    const [code] = await generateInternalBarcodes(tx, ctx, 1)
    codes.push({ barcode: code!, qty_milli: 1000 })
  }
  if (codes.length) {
    await tx
      .insertInto('product_barcodes')
      .values(
        codes.map((c) => ({ id: newId(), tenant_id: ctx.tenantId, product_id: row.id, ...c })),
      )
      .execute()
  }
  await audit(tx, ctx, {
    action: 'product.create',
    entity_type: 'product',
    entity_id: row.id,
    summary: row.sku ? `${row.name} (${row.sku})` : row.name,
  })
  return getProductDetail(tx, ctx, row.id)
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

const PRICE_FIELDS = [
  'mrp_paise',
  'sale_price_paise',
  'wholesale_price_paise',
  'purchase_price_paise',
  'min_sale_price_paise',
  'max_discount_bp',
] as const
const TAX_FIELDS = [
  'hsn_code',
  'gst_rate_bp',
  'cess_rate_bp',
  'tax_slab_rule_id',
  'price_includes_tax',
] as const

/** Fields a variant parent passes on to its variants when they change. */
export const PROPAGATED_FIELDS = [
  'category_id',
  'brand_id',
  'hsn_code',
  'gst_rate_bp',
  'cess_rate_bp',
  'tax_slab_rule_id',
  'price_includes_tax',
  'unit',
  'pack_size',
  'allow_loose',
  'decimal_qty',
  'track_batches',
  'is_active',
] as const

type Writable = Omit<ProductRow, 'id' | 'parent_id' | 'created_by' | 'created_at' | 'updated_at'>

const WRITABLE_KEYS = PRODUCT_COLUMNS.filter(
  (k): k is keyof Writable & (typeof PRODUCT_COLUMNS)[number] =>
    !['id', 'parent_id', 'created_by', 'created_at', 'updated_at'].includes(k),
)

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
  return out
}

/** Writes `patch` (product columns) — jsonb columns serialised. */
export async function writeProductPatch(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  id: string,
  patch: Partial<Writable>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return
  const { attributes, variant_attributes, ...rest } = patch
  await tx
    .updateTable('products')
    .set({
      ...rest,
      ...(attributes !== undefined ? { attributes: jsonb(attributes) } : {}),
      ...(variant_attributes !== undefined
        ? { variant_attributes: jsonb(variant_attributes) }
        : {}),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
}

/** True when the products (or their variants) have stock movements. */
export async function productsHaveMovements(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  ids: readonly string[],
): Promise<boolean> {
  if (ids.length === 0) return false
  const res = await sql<{ x: number }>`
    SELECT 1 AS x FROM stock_movements m
     WHERE m.tenant_id = ${ctx.tenantId}
       AND (m.product_id = ANY(${[...ids]}::uuid[])
            OR m.product_id IN (SELECT id FROM products c
                                 WHERE c.tenant_id = ${ctx.tenantId} AND c.parent_id = ANY(${[...ids]}::uuid[])))
     LIMIT 1`.execute(tx)
  return res.rows.length > 0
}

/** True when the products (or their variants) hold stock (any store / batch with qty ≠ 0). */
export async function productsHaveStock(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  ids: readonly string[],
): Promise<boolean> {
  if (ids.length === 0) return false
  const res = await sql<{ x: number }>`
    SELECT 1 AS x FROM stock_levels sl
     WHERE sl.tenant_id = ${ctx.tenantId} AND sl.qty_milli <> 0
       AND (sl.product_id = ANY(${[...ids]}::uuid[])
            OR sl.product_id IN (SELECT id FROM products c
                                  WHERE c.tenant_id = ${ctx.tenantId} AND c.parent_id = ANY(${[...ids]}::uuid[])))
     LIMIT 1`.execute(tx)
  return res.rows.length > 0
}

/**
 * Applies a variant parent's changed shared fields to its variants; a renamed parent renames
 * variants that still carry the old name prefix ("<parent> - M / Red").
 */
export async function propagateToVariants(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  before: Pick<ProductRow, 'id' | 'name' | 'name_ta'>,
  patch: Partial<Writable>,
): Promise<void> {
  const shared: Partial<Pick<Writable, (typeof PROPAGATED_FIELDS)[number]>> = {}
  for (const k of PROPAGATED_FIELDS)
    if (patch[k] !== undefined) Object.assign(shared, { [k]: patch[k] })
  if (Object.keys(shared).length) {
    await tx
      .updateTable('products')
      .set(shared)
      .where('tenant_id', '=', ctx.tenantId)
      .where('parent_id', '=', before.id)
      .execute()
  }
  if (patch.name !== undefined && patch.name !== before.name) {
    const oldPrefix = `${before.name} - `
    const len = [...oldPrefix].length
    await sql`UPDATE products
                 SET name = left(${`${patch.name} - `}::text || substr(name, ${len + 1}::int), 200)
               WHERE tenant_id = ${ctx.tenantId} AND parent_id = ${before.id}
                 AND left(name, ${len}::int) = ${oldPrefix}::text`.execute(tx)
  }
  if (
    patch.name_ta !== undefined &&
    before.name_ta &&
    patch.name_ta &&
    patch.name_ta !== before.name_ta
  ) {
    const oldPrefix = `${before.name_ta} - `
    const len = [...oldPrefix].length
    await sql`UPDATE products
                 SET name_ta = left(${`${patch.name_ta} - `}::text || substr(name_ta, ${len + 1}::int), 200)
               WHERE tenant_id = ${ctx.tenantId} AND parent_id = ${before.id}
                 AND left(name_ta, ${len}::int) = ${oldPrefix}::text`.execute(tx)
  }
}

/** Audit rows for a product change: price, tax, (de)activation and other fields separately. */
export async function auditProductChange(
  tx: Tx,
  ctx: Ctx,
  before: ProductRow,
  after: Partial<Writable>,
  opts: { source?: string } = {},
): Promise<void> {
  const label = before.sku ? `${before.name} (${before.sku})` : before.name
  const group = (keys: readonly (keyof Writable)[]) =>
    diffChanges(pick(before, keys), { ...pick(before, keys), ...pick(after, keys) })
  const price = group(PRICE_FIELDS)
  const tax = group(TAX_FIELDS)
  const restKeys = WRITABLE_KEYS.filter(
    (k) =>
      !(PRICE_FIELDS as readonly string[]).includes(k) &&
      !(TAX_FIELDS as readonly string[]).includes(k) &&
      k !== 'is_active',
  )
  const rest = group(restKeys)
  const base = { entity_type: 'product', entity_id: before.id }
  const extra = opts.source ? { source: opts.source } : {}
  if (price)
    await audit(tx, ctx, {
      ...base,
      action: 'product.price_change',
      summary: label,
      changes: { ...price, ...extra },
    })
  if (tax)
    await audit(tx, ctx, {
      ...base,
      action: 'product.tax_change',
      summary: label,
      changes: { ...tax, ...extra },
    })
  if (after.is_active !== undefined && after.is_active !== before.is_active)
    await audit(tx, ctx, {
      ...base,
      action: after.is_active ? 'product.activate' : 'product.deactivate',
      summary: label,
      changes: extra,
    })
  if (rest)
    await audit(tx, ctx, {
      ...base,
      action: 'product.update',
      summary: label,
      changes: { ...rest, ...extra },
    })
}

/** Active-product count a change adds (reactivation of the product and, for parents, variants). */
async function activationCount(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  row: Pick<ProductRow, 'id' | 'kind' | 'is_active'>,
): Promise<number> {
  let n = row.is_active ? 0 : 1
  if (row.kind === 'variant_parent') {
    const r = await tx
      .selectFrom('products')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tenant_id', '=', ctx.tenantId)
      .where('parent_id', '=', row.id)
      .where('is_active', '=', false)
      .executeTakeFirstOrThrow()
    n += Number(r.n)
  }
  return n
}

export async function updateProduct(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: ProductUpdateParsed,
): Promise<ProductDetail> {
  const env = await catalogEnv(tx, ctx)
  const row = await loadProductRow(tx, ctx, id, { forUpdate: true })
  assertNotStale(row.updated_at, body.if_updated_at, 'product', id)
  if (body.kind !== undefined && body.kind !== row.kind) {
    if (row.kind !== 'standard' && row.kind !== 'service') throw issue('kind', 'kind_change')
  }
  await assertProductRefs(tx, ctx, body)

  const patch: Partial<Writable> = {}
  const set = <K extends keyof Writable>(k: K, v: Writable[K] | undefined) => {
    if (v !== undefined) patch[k] = v
  }
  set('kind', body.kind)
  set('name', body.name)
  set('name_ta', body.name_ta)
  set('aliases', body.aliases)
  set('description', body.description)
  set('sku', body.sku)
  set('category_id', body.category_id)
  set('brand_id', body.brand_id)
  set('unit', body.unit)
  set('pack_size', body.pack_size)
  set('allow_loose', body.allow_loose)
  set('decimal_qty', body.decimal_qty)
  set('hsn_code', body.hsn_code)
  set('gst_rate_bp', body.gst_rate_bp)
  set('cess_rate_bp', body.cess_rate_bp)
  set('tax_slab_rule_id', body.tax_slab_rule_id)
  set('price_includes_tax', body.price_includes_tax)
  set('mrp_paise', body.mrp_paise)
  set('sale_price_paise', body.sale_price_paise)
  set('wholesale_price_paise', body.wholesale_price_paise)
  set('purchase_price_paise', body.purchase_price_paise)
  set('min_sale_price_paise', body.min_sale_price_paise)
  set('max_discount_bp', body.max_discount_bp)
  set('track_inventory', body.track_inventory)
  set('track_batches', body.track_batches)
  set('is_weighed', body.is_weighed)
  set('scale_plu', body.scale_plu)
  set('reorder_level_milli', body.reorder_level_milli)
  set('reorder_qty_milli', body.reorder_qty_milli)
  set('image_file_id', body.image_file_id)
  set('is_active', body.is_active)
  if (body.attributes !== undefined)
    patch.attributes = validateProductAttributes(env.tenant.business_type, body.attributes)

  // Stock on hand fixes how the product is tracked: batch-less stock cannot be sold FEFO, and
  // stock of a product that stops tracking inventory could never be adjusted or valued again.
  let stockMemo: boolean | undefined
  const hasStock = async (): Promise<boolean> =>
    (stockMemo ??= await productsHaveStock(tx, ctx, [id]))
  const merged = { ...row, ...patch }
  const attributes = jsonObject(merged.attributes)
  if (
    (body.attributes !== undefined ||
      body.track_batches !== undefined ||
      body.kind !== undefined) &&
    forcedTrackBatches(env, merged.kind, attributes) &&
    // Existing batch-less stock keeps the product batch-less (forcing would strand that stock).
    (row.track_batches || !(await hasStock()))
  ) {
    merged.track_batches = true
    if (!row.track_batches) patch.track_batches = true
  }
  const flags = normalizeProductFlags({
    kind: productKindOf(merged.kind),
    track_inventory: merged.track_inventory,
    track_batches: merged.track_batches,
  })
  if (flags.track_inventory !== merged.track_inventory) {
    if (body.track_inventory === true && merged.kind === 'service')
      throw issue('track_inventory', 'service_tracks_stock')
    patch.track_inventory = flags.track_inventory
    merged.track_inventory = flags.track_inventory
  }
  if (flags.track_batches !== merged.track_batches) {
    patch.track_batches = flags.track_batches
    merged.track_batches = flags.track_batches
  }
  const priceTouched = body.mrp_paise !== undefined || body.sale_price_paise !== undefined
  const ruleIssues = productRuleIssues({
    kind: productKindOf(merged.kind),
    unit: merged.unit,
    pack_size: merged.pack_size,
    allow_loose: merged.allow_loose,
    decimal_qty: merged.decimal_qty,
    track_inventory: merged.track_inventory,
    track_batches: merged.track_batches,
    mrp_paise: merged.mrp_paise,
    sale_price_paise: merged.sale_price_paise,
    min_sale_price_paise: merged.min_sale_price_paise,
    allow_mrp_below_sale: priceTouched ? (body.allow_mrp_below_sale ?? false) : true,
  })
  if (ruleIssues.length) ruleError(ruleIssues)

  if (row.track_inventory && !merged.track_inventory && (await hasStock()))
    throw conflictReason(
      'This product has stock; bring the stock to zero before it stops tracking inventory',
      'stock_on_hand',
      { field: merged.kind !== row.kind ? 'kind' : 'track_inventory' },
    )
  if (merged.track_batches !== row.track_batches && (await hasStock()))
    throw conflictReason(
      'Batch tracking cannot change while the product has stock',
      'stock_on_hand',
      { field: 'track_batches' },
    )
  const unitChange = patch.unit !== undefined && patch.unit !== row.unit
  const packChange = patch.pack_size !== undefined && patch.pack_size !== row.pack_size
  if ((unitChange || packChange) && (await productsHaveMovements(tx, ctx, [id]))) {
    if (unitChange)
      throw conflictReason('The unit cannot change after stock movements', 'unit_in_use', {
        field: 'unit',
      })
    // Stock costs are per pack: a new pack size would revalue the stock and its history.
    throw conflictReason('The pack size cannot change after stock movements', 'pack_size_in_use', {
      field: 'pack_size',
    })
  }
  if (patch.sku && patch.sku.toLowerCase() !== (row.sku ?? '').toLowerCase())
    await assertSkuFree(tx, ctx, patch.sku, id)
  if (patch.scale_plu && patch.scale_plu !== row.scale_plu)
    await assertScalePluFree(tx, ctx, patch.scale_plu, id)
  if (patch.is_active === true && !row.is_active) {
    const adding = await activationCount(tx, ctx, row)
    if (adding > 0) await assertWithinLimit(tx, ctx, 'products', { adding })
  }

  // Only real changes are written / audited.
  const changed: Partial<Writable> = {}
  for (const [k, v] of Object.entries(patch) as Array<[keyof Writable, unknown]>) {
    if (JSON.stringify(v) !== JSON.stringify(row[k])) (changed as Record<string, unknown>)[k] = v
  }
  if (Object.keys(changed).length) {
    await writeProductPatch(tx, ctx, id, changed)
    if (row.kind === 'variant_parent') await propagateToVariants(tx, ctx, row, changed)
    await auditProductChange(tx, ctx, row, changed)
  }
  return getProductDetail(tx, ctx, id)
}

function productKindOf(kind: string): 'standard' | 'variant_parent' | 'variant' | 'service' {
  return kind === 'variant_parent' || kind === 'variant' || kind === 'service' ? kind : 'standard'
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

export async function deleteProduct(tx: Tx, ctx: Ctx, id: string): Promise<DeleteResult> {
  const row = await loadProductRow(tx, ctx, id, { forUpdate: true })
  const label = row.sku ? `${row.name} (${row.sku})` : row.name
  try {
    await withSavepoint(tx, async () => {
      if (row.kind === 'variant_parent')
        await tx
          .deleteFrom('products')
          .where('tenant_id', '=', ctx.tenantId)
          .where('parent_id', '=', id)
          .execute()
      await tx
        .deleteFrom('products')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', id)
        .execute()
    })
    await audit(tx, ctx, {
      action: 'product.delete',
      entity_type: 'product',
      entity_id: id,
      summary: label,
    })
    return { id, result: 'deleted' }
  } catch (err) {
    // Referenced by stock, batches, bills or documents → keep history, deactivate.
    if (pgCode(err) !== '23503') throw err
  }
  if (row.is_active) {
    await writeProductPatch(tx, ctx, id, { is_active: false })
    if (row.kind === 'variant_parent') await propagateToVariants(tx, ctx, row, { is_active: false })
    await auditProductChange(tx, ctx, row, { is_active: false })
  }
  return { id, result: 'deactivated' }
}

// ---------------------------------------------------------------------------------------------
// Bulk update
// ---------------------------------------------------------------------------------------------

export async function bulkUpdateProducts(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof ProductBulkUpdateSchema>,
): Promise<ProductBulkUpdateResult> {
  const s = body.set
  await assertProductRefs(
    tx,
    ctx,
    { category_id: s.category_id, brand_id: s.brand_id, tax_slab_rule_id: s.tax_slab_rule_id },
    'set.',
  )
  const rows = await tx
    .selectFrom('products')
    .select(PRODUCT_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', body.ids)
    .orderBy('id')
    .forUpdate()
    .execute()
  const found = new Set(rows.map((r) => r.id))
  const notFoundIds = body.ids.filter((id) => !found.has(id))

  if (s.is_active === true) {
    let adding = 0
    for (const r of rows) adding += await activationCount(tx, ctx, r)
    if (adding > 0) await assertWithinLimit(tx, ctx, 'products', { adding })
  }

  let updated = 0
  let capped = 0
  const changes: Array<{
    id: string
    before: Record<string, unknown>
    after: Record<string, unknown>
  }> = []
  for (const row of rows) {
    const patch: Partial<Writable> = {}
    if (s.gst_rate_bp !== undefined) patch.gst_rate_bp = s.gst_rate_bp
    if (s.tax_slab_rule_id !== undefined) patch.tax_slab_rule_id = s.tax_slab_rule_id
    if (s.category_id !== undefined) patch.category_id = s.category_id
    if (s.brand_id !== undefined) patch.brand_id = s.brand_id
    if (s.is_active !== undefined) patch.is_active = s.is_active
    if (s.price_change && row.kind !== 'variant_parent') {
      const next = applyPriceChange(row.sale_price_paise, s.price_change, row.mrp_paise)
      if (next.capped) capped += 1
      patch.sale_price_paise = next.price_paise
      // Keep min price ≤ selling price.
      if (row.min_sale_price_paise !== null && row.min_sale_price_paise > next.price_paise)
        patch.min_sale_price_paise = next.price_paise
    }
    const changed: Partial<Writable> = {}
    for (const [k, v] of Object.entries(patch) as Array<[keyof Writable, unknown]>)
      if (JSON.stringify(v) !== JSON.stringify(row[k])) (changed as Record<string, unknown>)[k] = v
    if (Object.keys(changed).length === 0) continue
    updated += 1
    await writeProductPatch(tx, ctx, row.id, changed)
    if (row.kind === 'variant_parent') await propagateToVariants(tx, ctx, row, changed)
    const keys = Object.keys(changed) as Array<keyof Writable>
    changes.push({
      id: row.id,
      before: pick(row, keys) as Record<string, unknown>,
      after: changed as Record<string, unknown>,
    })
  }
  if (updated > 0) {
    await audit(tx, ctx, {
      action: 'product.bulk_update',
      entity_type: 'product',
      summary: `Bulk update of ${String(updated)} products: ${Object.keys(s).join(', ')}`,
      changes: { set: s, products: changes },
    })
  }
  return {
    matched: rows.length,
    updated,
    unchanged: rows.length - updated,
    capped_at_mrp: capped,
    not_found: notFoundIds,
  }
}

/** Labels may generate barcodes only for members who can edit the catalogue. */
export function assertCanWriteCatalog(ctx: Ctx): void {
  if (!hasPermission(ctx.permissions, 'catalog.write'))
    throw forbidden('Generating barcodes needs catalog.write', { required: ['catalog.write'] })
}

export type { ProductBulkUpdate }
