/**
 * Offline catalogue of the POS (ARCHITECTURE.md §12): GET /pos/bootstrap fills the Dexie tables
 * (full load, then deltas with the cursor), the rest of the bootstrap (settings, series, shift,
 * providers, customers…) is kept as the register's PosContext in Dexie meta. Lookups and search
 * run against IndexedDB only, so billing keeps working without the server.
 */
import { PromotionSchema, type PromotionLike } from '@kadai/shared/promotions'
import { type PosBootstrap, type PosBootstrapQuery, salesRoutes } from '@kadai/shared/api/sales'
import { type TaxSlab, TaxSlabsSchema } from '@kadai/shared/pricing'
import { normalizePlu, parseScaleBarcode } from '@kadai/shared/scale'
import { callRoute } from '@/lib/api'
import {
  type CachedBatch,
  type CachedProduct,
  catalogCache,
  meta,
  offlineDb,
} from '@/lib/offline/db'
import type { CartStorePrice } from './cart'
import { reconcileSeries } from './series'
import type { PosBatch, PosContext, PosProduct } from './types'

export const posMetaKeys = {
  context: (tenantId: string, registerKey: string) => `pos.context.${tenantId}.${registerKey}`,
  cart: (tenantId: string, registerKey: string) => `pos.cart.${tenantId}.${registerKey}`,
  lastPrint: (tenantId: string, registerKey: string) => `pos.last_print.${tenantId}.${registerKey}`,
}

/** Cached product row → POS product (older rows may miss the newer bootstrap fields). */
export function toPosProduct(row: CachedProduct): PosProduct {
  const extra = row as CachedProduct & Partial<PosProduct>
  return {
    id: row.id,
    parent_id: row.parent_id,
    kind: row.kind,
    sku: row.sku,
    name: row.name,
    name_ta: row.name_ta,
    aliases: row.aliases,
    category_id: row.category_id,
    brand_id: row.brand_id,
    unit: row.unit,
    pack_size: row.pack_size,
    allow_loose: row.allow_loose,
    decimal_qty: row.decimal_qty,
    hsn_code: row.hsn_code,
    gst_rate_bp: row.gst_rate_bp,
    cess_rate_bp: row.cess_rate_bp,
    tax_slab_rule_id: row.tax_slab_rule_id,
    price_includes_tax: row.price_includes_tax,
    mrp_paise: row.mrp_paise,
    sale_price_paise: row.sale_price_paise,
    wholesale_price_paise: row.wholesale_price_paise,
    min_sale_price_paise: row.min_sale_price_paise,
    max_discount_bp: row.max_discount_bp,
    track_inventory: row.track_inventory,
    track_batches: row.track_batches,
    is_weighed: row.is_weighed,
    scale_plu: row.scale_plu,
    variant_attributes: row.variant_attributes,
    variant_axes: extra.variant_axes ?? [],
    attributes: row.attributes,
    stock_qty_milli: extra.stock_qty_milli ?? null,
    reorder_level_milli: extra.reorder_level_milli ?? null,
    is_active: row.is_active,
    updated_at: row.updated_at,
  }
}

function toPosBatch(b: CachedBatch): PosBatch {
  return {
    id: b.id,
    product_id: b.product_id,
    batch_no: b.batch_no,
    expiry_date: b.expiry_date,
    mrp_paise: b.mrp_paise,
    sale_price_paise: b.sale_price_paise,
    qty_milli: b.qty_milli,
  }
}

function contextOf(b: PosBootstrap): PosContext {
  return {
    server_time: b.server_time,
    tenant: b.tenant,
    store: b.store,
    register: b.register,
    doc_type: b.doc_type,
    tax_mode: b.tax_mode,
    settings: b.settings,
    features: b.features,
    series: b.series,
    open_shift: b.open_shift,
    shift_required: b.shift_required,
    quick_keys: b.quick_keys,
    categories: b.categories,
    payment_providers: b.payment_providers,
    customers: b.customers,
    synced_at: new Date().toISOString(),
  }
}

export async function loadContext(
  tenantId: string,
  registerKey: string,
): Promise<PosContext | null> {
  const v = await meta.get<PosContext>(posMetaKeys.context(tenantId, registerKey))
  return v && typeof v === 'object' && 'settings' in v && 'store' in v ? v : null
}

export async function saveContext(
  tenantId: string,
  registerKey: string,
  context: PosContext,
): Promise<void> {
  await meta.set(posMetaKeys.context(tenantId, registerKey), context)
}

/** Writes a bootstrap response into the offline store (full replace or delta). */
export async function applyBootstrap(
  tenantId: string,
  registerKey: string,
  b: PosBootstrap,
): Promise<PosContext> {
  const products = b.products.map((p) => ({ ...p, tenant_id: tenantId }) as CachedProduct)
  const barcodes = b.barcodes.map((x) => ({ ...x, tenant_id: tenantId }))
  const batches = b.batches.map((x) => ({ ...x, tenant_id: tenantId }))
  const promotions = b.promotions.map((x) => ({
    tenant_id: tenantId,
    id: x.id,
    data: x.data,
    updated_at: x.updated_at,
  }))
  const slabRules = b.tax_slab_rules.map((x) => ({ ...x, tenant_id: tenantId }))
  const storePrices = b.store_prices.map((x) => ({ ...x, tenant_id: tenantId }))

  if (b.mode === 'full') {
    await catalogCache.replaceAll(
      tenantId,
      registerKey,
      {
        products,
        barcodes,
        batches,
        promotions,
        tax_slab_rules: slabRules,
        store_prices: storePrices,
      },
      b.cursor,
    )
  } else {
    await offlineDb.transaction(
      'rw',
      [
        offlineDb.products,
        offlineDb.barcodes,
        offlineDb.batches,
        offlineDb.promotions,
        offlineDb.tax_slab_rules,
        offlineDb.store_prices,
        offlineDb.meta,
      ],
      async () => {
        // The barcode / store-price lists of these products are complete in the response.
        if (b.barcode_product_ids.length) {
          await offlineDb.barcodes
            .where('[tenant_id+product_id]')
            .anyOf(b.barcode_product_ids.map((id) => [tenantId, id]))
            .delete()
        }
        if (b.store_price_product_ids.length) {
          await offlineDb.store_prices.bulkDelete(
            b.store_price_product_ids.map(
              (id) => [tenantId, b.store.id, id] as [string, string, string],
            ),
          )
        }
        // Tax slab rules are always complete.
        await offlineDb.tax_slab_rules.where('tenant_id').equals(tenantId).delete()
        await catalogCache.applyDelta(
          tenantId,
          registerKey,
          {
            products,
            barcodes,
            batches,
            promotions,
            tax_slab_rules: slabRules,
            store_prices: storePrices,
            removed_product_ids: b.removed_product_ids,
            removed_barcodes: b.removed_barcodes,
            removed_batch_ids: b.removed_batch_ids,
            removed_promotion_ids: b.removed_promotion_ids,
          },
          b.cursor,
        )
      },
    )
  }
  const context = contextOf(b)
  await saveContext(tenantId, registerKey, context)
  await reconcileSeries(tenantId, registerKey, b.series)
  return context
}

/** GET /pos/bootstrap (delta when a cursor exists) and store the result. */
export async function syncCatalog(
  tenantId: string,
  registerKey: string,
  query: Pick<PosBootstrapQuery, 'register_id' | 'store_id'>,
  options: { full?: boolean; signal?: AbortSignal } = {},
): Promise<PosContext> {
  const cursor = options.full ? null : await catalogCache.getCursor(tenantId, registerKey)
  const count = cursor ? await catalogCache.countProducts(tenantId) : 0
  const res = await callRoute(salesRoutes.posBootstrap, {
    query: { ...query, ...(cursor && count > 0 ? { since: cursor } : {}) },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return applyBootstrap(tenantId, registerKey, res.data)
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function getProduct(tenantId: string, id: string): Promise<PosProduct | null> {
  const row = await catalogCache.getProduct(tenantId, id)
  return row ? toPosProduct(row) : null
}

export async function getProducts(tenantId: string, ids: readonly string[]): Promise<PosProduct[]> {
  if (ids.length === 0) return []
  const rows = await offlineDb.products.bulkGet(ids.map((id) => [tenantId, id] as [string, string]))
  return rows.filter((r): r is CachedProduct => r !== undefined).map(toPosProduct)
}

export async function getVariants(tenantId: string, parentId: string): Promise<PosProduct[]> {
  const rows = await offlineDb.products
    .where('tenant_id')
    .equals(tenantId)
    .filter((p) => p.parent_id === parentId && p.is_active)
    .toArray()
  return rows.map(toPosProduct)
}

export async function productsOfCategory(
  tenantId: string,
  categoryIds: readonly string[],
  limit = 60,
): Promise<PosProduct[]> {
  if (categoryIds.length === 0) return []
  const rows = await offlineDb.products
    .where('[tenant_id+category_id]')
    .anyOf(categoryIds.map((id) => [tenantId, id]))
    .filter((p) => p.is_active && p.kind !== 'variant')
    .limit(limit)
    .toArray()
  return rows.map(toPosProduct).sort((a, b) => a.name.localeCompare(b.name))
}

/** Batches of a product at the store, FEFO order (expiry asc, no expiry last). */
export async function getBatches(tenantId: string, productId: string): Promise<PosBatch[]> {
  const rows = await catalogCache.getBatches(tenantId, productId)
  return rows.map(toPosBatch).sort(fefoCompare)
}

export function fefoCompare(a: PosBatch, b: PosBatch): number {
  if (a.expiry_date === b.expiry_date) return a.batch_no.localeCompare(b.batch_no)
  if (a.expiry_date === null) return 1
  if (b.expiry_date === null) return -1
  return a.expiry_date < b.expiry_date ? -1 : 1
}

/**
 * FEFO default batch: the earliest-expiring batch that is not expired and has stock, else the
 * earliest non-expired one (stock may lag offline), else null.
 */
export function pickFefoBatch(batches: readonly PosBatch[], today: string): PosBatch | null {
  const sellable = [...batches]
    .sort(fefoCompare)
    .filter((b) => b.expiry_date === null || b.expiry_date >= today)
  return sellable.find((b) => b.qty_milli > 0) ?? sellable[0] ?? null
}

export async function getStorePrice(
  tenantId: string,
  storeId: string,
  productId: string,
): Promise<CartStorePrice | null> {
  const row = await catalogCache.getStorePrice(tenantId, storeId, productId)
  return row ? { sale_price_paise: row.sale_price_paise, mrp_paise: row.mrp_paise } : null
}

export async function getTaxSlabs(
  tenantId: string,
  ruleId: string | null,
): Promise<TaxSlab[] | null> {
  if (!ruleId) return null
  const row = await offlineDb.tax_slab_rules.get([tenantId, ruleId])
  if (!row || !row.is_active) return null
  const parsed = TaxSlabsSchema.safeParse(row.slabs)
  return parsed.success ? parsed.data : null
}

/** Active promotions of the store (validated; feature gating is the caller's job). */
export async function getPromotions(tenantId: string, storeId: string): Promise<PromotionLike[]> {
  const rows = await catalogCache.getPromotions(tenantId)
  const out: PromotionLike[] = []
  for (const r of rows) {
    const parsed = PromotionSchema.safeParse(r.data)
    if (!parsed.success || !parsed.data.is_active) continue
    if (parsed.data.store_ids && !parsed.data.store_ids.includes(storeId)) continue
    out.push(parsed.data)
  }
  return out
}

export interface CodeMatch {
  product: PosProduct
  match: 'barcode' | 'sku' | 'scale'
  /** Quantity the code stands for (case barcode, scale weight); null = default quantity. */
  qty_milli: number | null
  /** Line amount of a price scale barcode. */
  price_paise: number | null
  code: string
}

/**
 * Local code lookup, same precedence as GET /products/lookup: exact barcode (case quantity) →
 * SKU → scale barcode (settings.pos.scale_barcode).
 */
export async function lookupCode(
  tenantId: string,
  code: string,
  context: Pick<PosContext, 'settings'>,
): Promise<CodeMatch | null> {
  const trimmed = code.trim()
  if (!trimmed) return null
  const byBarcode = await catalogCache.findByBarcode(tenantId, trimmed)
  if (byBarcode) {
    return {
      product: toPosProduct(byBarcode.product),
      match: 'barcode',
      qty_milli: byBarcode.qty_milli === 1000 ? null : byBarcode.qty_milli,
      price_paise: null,
      code: trimmed,
    }
  }
  const bySku = await catalogCache.findBySku(tenantId, trimmed)
  if (bySku) {
    return {
      product: toPosProduct(bySku),
      match: 'sku',
      qty_milli: null,
      price_paise: null,
      code: trimmed,
    }
  }
  const scale = parseScaleBarcode(trimmed, context.settings.pos.scale_barcode)
  if (scale) {
    const product = await catalogCache.findByScalePlu(tenantId, normalizePlu(scale.plu))
    if (product) {
      return {
        product: toPosProduct(product),
        match: 'scale',
        qty_milli: scale.qty_milli ?? null,
        price_paise: scale.price_paise ?? null,
        code: trimmed,
      }
    }
  }
  return null
}

/**
 * Search by any word prefix of name / Tamil name / SKU / aliases (every query word must match),
 * including variant parents (they open the size × colour matrix). Exact SKU and name-prefix
 * matches rank first.
 */
export async function searchProducts(
  tenantId: string,
  query: string,
  limit = 20,
): Promise<PosProduct[]> {
  const words = query.toLocaleLowerCase('en-IN').split(/\s+/u).filter(Boolean)
  const first = words[0]
  if (!first) return []
  const rest = words.slice(1)
  const rows = await offlineDb.products
    .where('search_tokens')
    .startsWith(first)
    .filter(
      (p) =>
        p.tenant_id === tenantId &&
        p.is_active &&
        p.kind !== 'variant' &&
        rest.every((w) => (p.search_tokens ?? []).some((t) => t.startsWith(w))),
    )
    .limit(limit * 4)
    .toArray()
  const unique = new Map(rows.map((p) => [p.id, p]))
  const q = query.trim().toLocaleLowerCase('en-IN')
  const score = (p: CachedProduct): number => {
    if (p.sku?.toLowerCase() === q) return 0
    if (p.name.toLocaleLowerCase('en-IN').startsWith(q)) return 1
    if (p.name_ta?.startsWith(query.trim())) return 1
    return 2
  }
  return [...unique.values()]
    .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(toPosProduct)
}

/** Everything a new cart line needs besides the product (store price, slabs, FEFO batch). */
export async function lineExtras(
  tenantId: string,
  context: Pick<PosContext, 'store' | 'features'>,
  product: PosProduct,
  today: string,
): Promise<{
  store_price: CartStorePrice | null
  tax_slabs: TaxSlab[] | null
  batches: PosBatch[]
  batch: PosBatch | null
}> {
  const storePricing = context.features.includes('store_pricing')
  const [storePrice, slabs, batches] = await Promise.all([
    storePricing ? getStorePrice(tenantId, context.store.id, product.id) : Promise.resolve(null),
    getTaxSlabs(tenantId, product.tax_slab_rule_id),
    product.track_batches ? getBatches(tenantId, product.id) : Promise.resolve([]),
  ])
  return {
    store_price: storePrice,
    tax_slabs: slabs,
    batches,
    batch: product.track_batches ? pickFefoBatch(batches, today) : null,
  }
}
