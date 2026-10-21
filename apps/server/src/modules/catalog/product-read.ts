/**
 * Product reads: row mapping, GET /products (search, filters, stock of a store, low stock), GET
 * /products/:id (barcodes, variants, category path, brand, slab rule, stock).
 *
 * Stock is the sum of stock_levels over batches for one store (?store_id, else the device /
 * only store — resolveStoreId); a variant parent shows the sum of its variants. Products that do
 * not track inventory have no stock (null).
 */
import { type RawBuilder, type Selectable, sql } from 'kysely'
import { ProductKindSchema, isInternalBarcode } from '@kadai/shared'
import {
  type Product,
  type ProductBarcode,
  type ProductDetail,
  type ProductListItem,
  type ProductListQuerySchema,
  type VariantRow,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { notFound } from '../../core/errors'
import { type PageEnvelope, pageResult, parsePage } from '../../core/http'
import type { Products } from '../../db/schema.generated'
import type { Tx } from '../../db/tenant'
import { categorySubtreeIds, loadCategoryPaths } from './categories'
import {
  type Ctx,
  andAll,
  containsPattern,
  iso,
  issue,
  jsonObject,
  resolveStoreId,
  searchTokens,
  stringRecord,
} from './shared'
import { readSlabs } from './tax-slab-rules'

export type ProductRow = Omit<Selectable<Products>, 'search_text' | 'tenant_id'>

/** Every products column except search_text (for selects). */
export const PRODUCT_COLUMNS = [
  'id',
  'parent_id',
  'kind',
  'sku',
  'name',
  'name_ta',
  'aliases',
  'description',
  'category_id',
  'brand_id',
  'unit',
  'pack_size',
  'allow_loose',
  'decimal_qty',
  'hsn_code',
  'gst_rate_bp',
  'cess_rate_bp',
  'tax_slab_rule_id',
  'price_includes_tax',
  'mrp_paise',
  'sale_price_paise',
  'wholesale_price_paise',
  'purchase_price_paise',
  'min_sale_price_paise',
  'max_discount_bp',
  'track_inventory',
  'track_batches',
  'is_weighed',
  'scale_plu',
  'reorder_level_milli',
  'reorder_qty_milli',
  'variant_attributes',
  'variant_axes',
  'attributes',
  'image_file_id',
  'is_active',
  'created_by',
  'created_at',
  'updated_at',
] as const satisfies ReadonlyArray<keyof ProductRow>

export function productKind(kind: string): Product['kind'] {
  const parsed = ProductKindSchema.safeParse(kind)
  return parsed.success ? parsed.data : 'standard'
}

export function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    parent_id: r.parent_id,
    kind: productKind(r.kind),
    sku: r.sku,
    name: r.name,
    name_ta: r.name_ta,
    aliases: r.aliases,
    description: r.description,
    category_id: r.category_id,
    brand_id: r.brand_id,
    unit: r.unit,
    pack_size: r.pack_size,
    allow_loose: r.allow_loose,
    decimal_qty: r.decimal_qty,
    hsn_code: r.hsn_code,
    gst_rate_bp: r.gst_rate_bp,
    cess_rate_bp: r.cess_rate_bp,
    tax_slab_rule_id: r.tax_slab_rule_id,
    price_includes_tax: r.price_includes_tax,
    mrp_paise: r.mrp_paise,
    sale_price_paise: r.sale_price_paise,
    wholesale_price_paise: r.wholesale_price_paise,
    purchase_price_paise: r.purchase_price_paise,
    min_sale_price_paise: r.min_sale_price_paise,
    max_discount_bp: r.max_discount_bp,
    track_inventory: r.track_inventory,
    track_batches: r.track_batches,
    is_weighed: r.is_weighed,
    scale_plu: r.scale_plu,
    reorder_level_milli: r.reorder_level_milli,
    reorder_qty_milli: r.reorder_qty_milli,
    variant_attributes: stringRecord(r.variant_attributes),
    variant_axes: r.variant_axes,
    attributes: jsonObject(r.attributes),
    image_file_id: r.image_file_id,
    is_active: r.is_active,
    created_by: r.created_by,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

export async function loadProductRow(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<ProductRow> {
  let q = tx
    .selectFrom('products')
    .select(PRODUCT_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('product', id)
  return row
}

// ---------------------------------------------------------------------------------------------
// Stock & barcodes helpers
// ---------------------------------------------------------------------------------------------

/** Σ stock (milli, all batches) per product in one store. Variant parents get their variants' sum. */
export async function stockForProducts(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  storeId: string,
  products: ReadonlyArray<{ id: string; kind: string; track_inventory: boolean }>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (products.length === 0) return out
  const ids = products.map((p) => p.id)
  const res = await sql<{ product_id: string; qty: number }>`
    SELECT coalesce(c.parent_id, sl.product_id) AS product_id, sum(sl.qty_milli)::bigint AS qty
      FROM stock_levels sl
      JOIN products c ON c.tenant_id = sl.tenant_id AND c.id = sl.product_id
     WHERE sl.tenant_id = ${ctx.tenantId} AND sl.store_id = ${storeId}
       AND (sl.product_id = ANY(${ids}::uuid[]) OR c.parent_id = ANY(${ids}::uuid[]))
     GROUP BY 1`.execute(tx)
  const sums = new Map(res.rows.map((r) => [r.product_id, Number(r.qty)]))
  for (const p of products) {
    if (p.kind === 'variant_parent' || p.track_inventory) out.set(p.id, sums.get(p.id) ?? 0)
    else out.set(p.id, null)
  }
  return out
}

/** First barcode (by created_at) per product. */
export async function primaryBarcodes(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  productIds: readonly string[],
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map()
  const rows = await sql<{ product_id: string; barcode: string }>`
    SELECT DISTINCT ON (product_id) product_id, barcode
      FROM product_barcodes
     WHERE tenant_id = ${ctx.tenantId} AND product_id = ANY(${[...productIds]}::uuid[])
     ORDER BY product_id, created_at, id`.execute(tx)
  return new Map(rows.rows.map((r) => [r.product_id, r.barcode]))
}

export function toBarcode(r: {
  id: string
  product_id: string
  barcode: string
  qty_milli: number
  created_at: Date
}): ProductBarcode {
  return {
    id: r.id,
    product_id: r.product_id,
    barcode: r.barcode,
    qty_milli: Number(r.qty_milli),
    is_internal: isInternalBarcode(r.barcode),
    created_at: iso(r.created_at),
  }
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

export async function getProductDetail(
  tx: Tx,
  ctx: Ctx,
  id: string,
  requestedStoreId?: string | null,
): Promise<ProductDetail> {
  const storeId = await resolveStoreId(tx, ctx, requestedStoreId)
  const row = await loadProductRow(tx, ctx, id)
  const product = toProduct(row)

  const [paths, brand, rule, barcodeRows, parent, variantRows] = await Promise.all([
    row.category_id ? loadCategoryPaths(tx, ctx) : Promise.resolve(null),
    row.brand_id
      ? tx
          .selectFrom('brands')
          .select(['id', 'name'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', row.brand_id)
          .executeTakeFirst()
      : Promise.resolve(undefined),
    row.tax_slab_rule_id
      ? tx
          .selectFrom('tax_slab_rules')
          .select(['id', 'name', 'slabs'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', row.tax_slab_rule_id)
          .executeTakeFirst()
      : Promise.resolve(undefined),
    tx
      .selectFrom('product_barcodes')
      .select(['id', 'product_id', 'barcode', 'qty_milli', 'created_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('product_id', '=', id)
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
    row.parent_id
      ? tx
          .selectFrom('products')
          .select(['id', 'sku', 'name', 'name_ta', 'variant_axes'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', row.parent_id)
          .executeTakeFirst()
      : Promise.resolve(undefined),
    row.kind === 'variant_parent'
      ? tx
          .selectFrom('products')
          .select([
            'id',
            'kind',
            'sku',
            'name',
            'name_ta',
            'variant_attributes',
            'sale_price_paise',
            'mrp_paise',
            'purchase_price_paise',
            'is_active',
            'track_inventory',
            'created_at',
          ])
          .where('tenant_id', '=', ctx.tenantId)
          .where('parent_id', '=', id)
          .orderBy('created_at')
          .orderBy('id')
          .execute()
      : Promise.resolve([]),
  ])
  const variants = await toVariantRows(tx, ctx, storeId, variantRows)
  const stock = storeId ? await stockForProducts(tx, ctx, storeId, [row]) : null
  const cat = row.category_id ? paths?.byId.get(row.category_id) : undefined
  const barcodes = barcodeRows.map(toBarcode)
  return {
    ...product,
    category: cat ? { id: cat.id, name: cat.name, name_ta: cat.name_ta, path: cat.path } : null,
    brand: brand ?? null,
    tax_slab_rule: rule ? { id: rule.id, name: rule.name, slabs: readSlabs(rule.slabs) } : null,
    barcodes,
    primary_barcode: barcodes[0]?.barcode ?? null,
    parent: parent ?? null,
    variants,
    stock_qty_milli: stock?.get(id) ?? null,
  }
}

export async function toVariantRows(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  storeId: string | null,
  rows: ReadonlyArray<{
    id: string
    kind: string
    sku: string | null
    name: string
    name_ta: string | null
    variant_attributes: unknown
    sale_price_paise: number
    mrp_paise: number | null
    purchase_price_paise: number
    is_active: boolean
    track_inventory: boolean
  }>,
): Promise<VariantRow[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const [codes, stock] = await Promise.all([
    primaryBarcodes(tx, ctx, ids),
    storeId ? stockForProducts(tx, ctx, storeId, rows) : Promise.resolve(null),
  ])
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    name_ta: r.name_ta,
    variant_attributes: stringRecord(r.variant_attributes),
    sale_price_paise: r.sale_price_paise,
    mrp_paise: r.mrp_paise,
    purchase_price_paise: r.purchase_price_paise,
    is_active: r.is_active,
    primary_barcode: codes.get(r.id) ?? null,
    stock_qty_milli: stock?.get(r.id) ?? null,
  }))
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

type FilterInput = Pick<
  z.output<typeof ProductListQuerySchema>,
  | 'q'
  | 'barcode'
  | 'category_id'
  | 'brand_id'
  | 'kind'
  | 'is_active'
  | 'track_batches'
  | 'parent_id'
  | 'hide_variants'
  | 'ids'
>

/** WHERE conditions (alias p) shared by the list and the CSV export. */
export async function productFilterConditions(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  q: FilterInput,
): Promise<RawBuilder<unknown>[]> {
  const t = ctx.tenantId
  const conds: RawBuilder<unknown>[] = [sql`p.tenant_id = ${t}`]
  if (q.q) {
    const tokens = searchTokens(q.q)
    const words = tokens.map((w) => sql`p.search_text LIKE ${containsPattern(w)}`)
    conds.push(sql`(
      ${andAll(words)}
      OR lower(p.sku) = lower(${q.q})
      OR EXISTS (SELECT 1 FROM product_barcodes qb
                  WHERE qb.tenant_id = p.tenant_id AND qb.product_id = p.id AND qb.barcode = ${q.q}))`)
  }
  if (q.barcode)
    conds.push(sql`EXISTS (SELECT 1 FROM product_barcodes fb
                  WHERE fb.tenant_id = p.tenant_id AND fb.product_id = p.id AND fb.barcode = ${q.barcode})`)
  if (q.category_id) {
    const ids = await categorySubtreeIds(tx, ctx, q.category_id)
    conds.push(ids.length ? sql`p.category_id = ANY(${ids}::uuid[])` : sql`FALSE`)
  }
  if (q.brand_id) conds.push(sql`p.brand_id = ${q.brand_id}`)
  if (q.kind) conds.push(sql`p.kind = ${q.kind}`)
  if (q.is_active !== undefined) conds.push(sql`p.is_active = ${q.is_active}`)
  if (q.track_batches !== undefined) conds.push(sql`p.track_batches = ${q.track_batches}`)
  if (q.parent_id) conds.push(sql`p.parent_id = ${q.parent_id}`)
  if (q.hide_variants) conds.push(sql`p.kind <> 'variant'`)
  if (q.ids) conds.push(q.ids.length ? sql`p.id = ANY(${q.ids}::uuid[])` : sql`FALSE`)
  return conds
}

/** Σ stock of the row's product in a store (variant parents: their variants; untracked: NULL). */
function stockExpression(storeId: string | null): RawBuilder<number | null> {
  if (!storeId) return sql<number | null>`NULL::bigint`
  return sql<number | null>`(CASE
      WHEN p.kind = 'variant_parent' THEN (
        SELECT coalesce(sum(sl.qty_milli), 0) FROM stock_levels sl
          JOIN products c ON c.tenant_id = sl.tenant_id AND c.id = sl.product_id
         WHERE sl.tenant_id = p.tenant_id AND sl.store_id = ${storeId}::uuid AND c.parent_id = p.id)
      WHEN p.track_inventory THEN (
        SELECT coalesce(sum(sl.qty_milli), 0) FROM stock_levels sl
         WHERE sl.tenant_id = p.tenant_id AND sl.store_id = ${storeId}::uuid AND sl.product_id = p.id)
      ELSE NULL END)::bigint`
}

interface ListRow {
  id: string
  parent_id: string | null
  kind: string
  sku: string | null
  name: string
  name_ta: string | null
  category_id: string | null
  brand_id: string | null
  brand_name: string | null
  unit: string
  pack_size: number
  hsn_code: string | null
  gst_rate_bp: number
  tax_slab_rule_id: string | null
  price_includes_tax: boolean
  mrp_paise: number | null
  sale_price_paise: number
  purchase_price_paise: number
  track_inventory: boolean
  track_batches: boolean
  is_active: boolean
  image_file_id: string | null
  variant_attributes: unknown
  reorder_level_milli: number | null
  updated_at: Date
  primary_barcode: string | null
  variant_count: number
  stock_qty_milli: number | null
  __total: number
}

const SORT_SQL: Record<string, RawBuilder<unknown>> = {
  name: sql`lower(p.name)`,
  updated_at: sql`p.updated_at`,
  sale_price: sql`p.sale_price_paise`,
  created_at: sql`p.created_at`,
  sku: sql`lower(p.sku)`,
}

export async function listProducts(
  tx: Tx,
  ctx: Ctx,
  q: z.output<typeof ProductListQuerySchema>,
): Promise<PageEnvelope<ProductListItem>> {
  const page = parsePage(q)
  const storeId = await resolveStoreId(tx, ctx, q.store_id)
  if (q.low_stock !== undefined && !storeId) throw issue('store_id', 'store_required')
  const conds = await productFilterConditions(tx, ctx, q)
  const stock = stockExpression(storeId)
  if (q.low_stock === true)
    conds.push(sql`(p.reorder_level_milli IS NOT NULL AND ${stock} <= p.reorder_level_milli)`)
  if (q.low_stock === false)
    conds.push(
      sql`(p.reorder_level_milli IS NULL OR ${stock} IS NULL OR ${stock} > p.reorder_level_milli)`,
    )
  const dir = q.sort.direction === 'desc' ? sql`DESC` : sql`ASC`
  const nulls = q.sort.field === 'sku' ? sql` NULLS LAST` : sql``
  const order: RawBuilder<unknown>[] = []
  if (q.q)
    order.push(sql`(lower(p.sku) = lower(${q.q}) OR EXISTS (SELECT 1 FROM product_barcodes ob
      WHERE ob.tenant_id = p.tenant_id AND ob.product_id = p.id AND ob.barcode = ${q.q})) IS TRUE DESC`)
  order.push(sql`${SORT_SQL[q.sort.field] ?? SORT_SQL.name!} ${dir}${nulls}`, sql`p.id ASC`)
  const res = await sql<ListRow>`
    SELECT p.id, p.parent_id, p.kind, p.sku, p.name, p.name_ta, p.category_id, p.brand_id,
           b.name::text AS brand_name, p.unit, p.pack_size, p.hsn_code, p.gst_rate_bp,
           p.tax_slab_rule_id, p.price_includes_tax, p.mrp_paise, p.sale_price_paise,
           p.purchase_price_paise, p.track_inventory, p.track_batches, p.is_active,
           p.image_file_id, p.variant_attributes, p.reorder_level_milli, p.updated_at,
           (SELECT pb.barcode FROM product_barcodes pb
             WHERE pb.tenant_id = p.tenant_id AND pb.product_id = p.id
             ORDER BY pb.created_at, pb.id LIMIT 1) AS primary_barcode,
           (SELECT count(*) FROM products v WHERE v.tenant_id = p.tenant_id AND v.parent_id = p.id)::int
             AS variant_count,
           ${stock} AS stock_qty_milli,
           count(*) OVER () AS __total
      FROM products p
      LEFT JOIN brands b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id
     WHERE ${andAll(conds)}
     ORDER BY ${sql.join(order, sql`, `)}
     LIMIT ${page.limit} OFFSET ${page.offset}`.execute(tx)
  let total = res.rows[0] ? Number(res.rows[0].__total) : 0
  if (!res.rows[0] && page.offset > 0) {
    const c = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM products p WHERE ${andAll(conds)}`.execute(tx)
    total = Number(c.rows[0]?.n ?? 0)
  }
  const paths = res.rows.some((r) => r.category_id) ? await loadCategoryPaths(tx, ctx) : null
  const data: ProductListItem[] = res.rows.map((r) => {
    const cat = r.category_id ? paths?.byId.get(r.category_id) : undefined
    const stockQty = r.stock_qty_milli === null ? null : Number(r.stock_qty_milli)
    const reorder = r.reorder_level_milli === null ? null : Number(r.reorder_level_milli)
    return {
      id: r.id,
      parent_id: r.parent_id,
      kind: productKind(r.kind),
      sku: r.sku,
      name: r.name,
      name_ta: r.name_ta,
      category_id: r.category_id,
      category_name: cat?.name ?? null,
      category_path: cat?.path ?? null,
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      unit: r.unit,
      pack_size: r.pack_size,
      hsn_code: r.hsn_code,
      gst_rate_bp: r.gst_rate_bp,
      tax_slab_rule_id: r.tax_slab_rule_id,
      price_includes_tax: r.price_includes_tax,
      mrp_paise: r.mrp_paise === null ? null : Number(r.mrp_paise),
      sale_price_paise: Number(r.sale_price_paise),
      purchase_price_paise: Number(r.purchase_price_paise),
      track_inventory: r.track_inventory,
      track_batches: r.track_batches,
      is_active: r.is_active,
      image_file_id: r.image_file_id,
      primary_barcode: r.primary_barcode,
      variant_attributes: stringRecord(r.variant_attributes),
      variant_count: Number(r.variant_count),
      reorder_level_milli: reorder,
      stock_qty_milli: stockQty,
      low_stock: stockQty !== null && reorder !== null ? stockQty <= reorder : null,
      updated_at: iso(r.updated_at),
    }
  })
  return pageResult(data, page, total)
}
