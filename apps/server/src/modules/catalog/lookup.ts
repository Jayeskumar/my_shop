/**
 * GET /products/lookup?code= — the counter scan. Precedence: exact barcode (qty from a case
 * barcode) → SKU (case-insensitive) → weighing-scale barcode (settings.pos.scale_barcode →
 * products.scale_plu, weight or line price from the code) → 404. Every step is a single indexed
 * lookup (product_barcodes (tenant_id, barcode), products (tenant_id, lower(sku)),
 * products (tenant_id, scale_plu)).
 */
import { sql } from 'kysely'
import { normalizePlu, parseScaleBarcode } from '@kadai/shared'
import type {
  ProductLookupMatch,
  ProductLookupQuerySchema,
  ProductLookupResult,
  SellableProduct,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { getEntitlements } from '../../core/entitlements'
import { AppError } from '../../core/errors'
import { getSettings } from '../../core/settings'
import type { Tx } from '../../db/tenant'
import { loadProductRow, stockForProducts, toProduct } from './product-read'
import { type Ctx, resolveStoreId } from './shared'

/** Sellable view of a product with the store's price override and stock applied. */
export async function sellableProduct(
  tx: Tx,
  ctx: Ctx,
  productId: string,
  storeId: string | null,
): Promise<SellableProduct> {
  const p = toProduct(await loadProductRow(tx, ctx, productId))
  let sale = p.sale_price_paise
  let mrp = p.mrp_paise
  let applied = false
  if (storeId) {
    const ent = await getEntitlements(ctx)
    if (ent.features.has('store_pricing')) {
      const sp = await tx
        .selectFrom('store_product_prices')
        .select(['sale_price_paise', 'mrp_paise'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('store_id', '=', storeId)
        .where('product_id', '=', productId)
        .executeTakeFirst()
      if (sp) {
        sale = sp.sale_price_paise
        mrp = sp.mrp_paise ?? mrp
        applied = true
      }
    }
  }
  const stock = storeId ? await stockForProducts(tx, ctx, storeId, [p]) : null
  return {
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
    allow_loose: p.allow_loose,
    decimal_qty: p.decimal_qty,
    hsn_code: p.hsn_code,
    gst_rate_bp: p.gst_rate_bp,
    cess_rate_bp: p.cess_rate_bp,
    tax_slab_rule_id: p.tax_slab_rule_id,
    price_includes_tax: p.price_includes_tax,
    mrp_paise: mrp,
    sale_price_paise: sale,
    wholesale_price_paise: p.wholesale_price_paise,
    min_sale_price_paise: p.min_sale_price_paise,
    max_discount_bp: p.max_discount_bp,
    track_inventory: p.track_inventory,
    track_batches: p.track_batches,
    is_weighed: p.is_weighed,
    variant_attributes: p.variant_attributes,
    attributes: p.attributes,
    image_file_id: p.image_file_id,
    is_active: p.is_active,
    store_price_applied: applied,
    stock_qty_milli: stock?.get(p.id) ?? null,
  }
}

export async function lookupProduct(
  tx: Tx,
  ctx: Ctx,
  q: z.output<typeof ProductLookupQuerySchema>,
): Promise<ProductLookupResult> {
  const code = q.code.trim()
  const storeId = await resolveStoreId(tx, ctx, q.store_id)
  let match: ProductLookupMatch | null = null
  let productId: string | null = null
  let qty: number | null = null
  let price: number | null = null
  let barcodeId: string | null = null

  const barcode = await tx
    .selectFrom('product_barcodes')
    .select(['id', 'product_id', 'qty_milli'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('barcode', '=', code)
    .executeTakeFirst()
  if (barcode) {
    match = 'barcode'
    productId = barcode.product_id
    qty = barcode.qty_milli
    barcodeId = barcode.id
  }
  if (!productId) {
    const bySku = await tx
      .selectFrom('products')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where(sql<boolean>`lower(sku) = lower(${code})`)
      .executeTakeFirst()
    if (bySku) {
      match = 'sku'
      productId = bySku.id
    }
  }
  if (!productId) {
    const settings = await getSettings(tx, ctx)
    const scale = parseScaleBarcode(code, settings.pos.scale_barcode)
    if (scale) {
      const byPlu = await tx
        .selectFrom('products')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('scale_plu', '=', normalizePlu(scale.plu))
        .executeTakeFirst()
      if (byPlu) {
        match = 'scale'
        productId = byPlu.id
        qty = scale.qty_milli ?? null
        price = scale.price_paise ?? null
      }
    }
  }
  if (!productId || !match)
    throw new AppError('NOT_FOUND', 'No product matches this code', { entity: 'product', code })
  return {
    match,
    code,
    product: await sellableProduct(tx, ctx, productId, storeId),
    qty_milli: qty,
    price_paise: price,
    barcode_id: barcodeId,
  }
}
