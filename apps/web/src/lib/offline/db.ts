/**
 * Offline store (IndexedDB via Dexie) for the POS (ARCHITECTURE.md §12):
 *
 *  - catalogue cache filled from GET /pos/bootstrap (products, barcodes, batches, promotions,
 *    tax slab rules, store prices) with a delta cursor in `meta`;
 *  - `outbox`: invoices / credit notes created offline, uploaded IN ORDER (`seq`) by POST
 *    /pos/sync. Outbox rows are never deleted by sign-out or tenant switches — only after the
 *    server has accepted them (or by an explicit, confirmed "discard");
 *  - `held_carts`: carts parked on this device;
 *  - `meta`: cursors, per-register offline number series, last sync times.
 *
 * Every row carries `tenant_id` so one browser can serve several businesses safely.
 * Schema changes: add a new `this.version(n)` block — never edit an existing one.
 */
import Dexie, { type Table } from 'dexie'
import type { TaxSlab } from '@kadai/shared/pricing'

export const OFFLINE_DB_NAME = 'kadai'

/** Sellable product fields cached for offline billing (snake_case, as sent by the API). */
export interface CachedProduct {
  tenant_id: string
  id: string
  parent_id: string | null
  kind: 'standard' | 'variant_parent' | 'variant' | 'service'
  sku: string | null
  name: string
  name_ta: string | null
  aliases: string[]
  category_id: string | null
  brand_id: string | null
  unit: string
  pack_size: number
  allow_loose: boolean
  decimal_qty: boolean
  hsn_code: string | null
  gst_rate_bp: number
  cess_rate_bp: number
  tax_slab_rule_id: string | null
  price_includes_tax: boolean
  mrp_paise: number | null
  sale_price_paise: number
  wholesale_price_paise: number | null
  min_sale_price_paise: number | null
  max_discount_bp: number | null
  track_inventory: boolean
  track_batches: boolean
  is_weighed: boolean
  scale_plu: string | null
  variant_attributes: Record<string, string>
  attributes: Record<string, unknown>
  is_active: boolean
  updated_at: string
  /** Lower-cased words of name / Tamil name / SKU / aliases (multi-entry search index). */
  search_tokens?: string[]
}

export interface CachedBarcode {
  tenant_id: string
  barcode: string
  product_id: string
  /** Quantity one scan represents (case barcodes), default 1000 = 1 unit. */
  qty_milli: number
}

export interface CachedBatch {
  tenant_id: string
  id: string
  product_id: string
  batch_no: string
  expiry_date: string | null
  mrp_paise: number | null
  sale_price_paise: number | null
  /** Stock of this batch at the register's store when the cache was filled. */
  qty_milli: number
  updated_at: string
}

export interface CachedPromotion {
  tenant_id: string
  id: string
  /** The promotion as returned by the API (validated with shared PromotionSchema on use). */
  data: unknown
  updated_at: string
}

export interface CachedTaxSlabRule {
  tenant_id: string
  id: string
  name: string
  slabs: TaxSlab[]
  is_active: boolean
}

export interface CachedStorePrice {
  tenant_id: string
  store_id: string
  product_id: string
  sale_price_paise: number
  mrp_paise: number | null
}

export type OutboxKind = 'invoice' | 'credit_note'
export type OutboxStatus = 'pending' | 'syncing' | 'synced' | 'failed'

export interface OutboxEntry {
  /** Auto-increment upload order. */
  seq?: number
  /** Idempotency key / `client_ref` of the document (UUID v7). */
  client_ref: string
  tenant_id: string
  store_id: string
  register_id: string
  kind: OutboxKind
  /** Number assigned offline from the register series (may be renumbered by the server). */
  number: string | null
  /** Request body for POST /pos/sync (the sales module owns its shape). */
  payload: unknown
  status: OutboxStatus
  attempts: number
  last_error: { code: string; message: string } | null
  created_at: string
  synced_at: string | null
  /** Server results after sync. */
  server_id: string | null
  server_number: string | null
  renumbered: boolean
}

export interface HeldCart {
  id: string
  tenant_id: string
  store_id: string
  register_id: string | null
  label: string
  customer_name: string | null
  item_count: number
  total_paise: number
  /** The POS cart state (owned by the POS module). */
  cart: unknown
  created_at: string
  updated_at: string
}

export interface MetaEntry {
  key: string
  value: unknown
  updated_at: string
}

export class KadaiOfflineDb extends Dexie {
  products!: Table<CachedProduct, [string, string]>
  barcodes!: Table<CachedBarcode, [string, string]>
  batches!: Table<CachedBatch, [string, string]>
  promotions!: Table<CachedPromotion, [string, string]>
  tax_slab_rules!: Table<CachedTaxSlabRule, [string, string]>
  store_prices!: Table<CachedStorePrice, [string, string, string]>
  outbox!: Table<OutboxEntry, number>
  held_carts!: Table<HeldCart, string>
  meta!: Table<MetaEntry, string>

  constructor(name: string = OFFLINE_DB_NAME) {
    super(name)
    this.version(1).stores({
      products:
        '[tenant_id+id], tenant_id, [tenant_id+sku], [tenant_id+scale_plu], [tenant_id+category_id], *search_tokens',
      barcodes: '[tenant_id+barcode], tenant_id, [tenant_id+product_id]',
      batches: '[tenant_id+id], tenant_id, [tenant_id+product_id], expiry_date',
      promotions: '[tenant_id+id], tenant_id',
      tax_slab_rules: '[tenant_id+id], tenant_id',
      store_prices: '[tenant_id+store_id+product_id], tenant_id, [tenant_id+store_id]',
      outbox: '++seq, &client_ref, [tenant_id+status], [tenant_id+register_id], created_at',
      held_carts: '&id, [tenant_id+store_id], updated_at',
      meta: '&key',
    })
  }
}

export const offlineDb = new KadaiOfflineDb()

const nowIso = (): string => new Date().toISOString()

/** Lower-cased search words (Latin and Tamil) for the multi-entry index. */
export function searchTokens(
  p: Pick<CachedProduct, 'name' | 'name_ta' | 'sku' | 'aliases'>,
): string[] {
  const text = [p.name, p.name_ta ?? '', p.sku ?? '', ...p.aliases]
    .join(' ')
    .toLocaleLowerCase('en-IN')
  const words = text.split(/[\s,./()[\]{}+\-_*&|:;"'!?#]+/u).filter((w) => w.length > 0)
  return [...new Set(words)]
}

// ---------------------------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------------------------

export const meta = {
  async get<T>(key: string): Promise<T | undefined> {
    const row = await offlineDb.meta.get(key)
    return row?.value as T | undefined
  },
  async set(key: string, value: unknown): Promise<void> {
    await offlineDb.meta.put({ key, value, updated_at: nowIso() })
  },
  async remove(key: string): Promise<void> {
    await offlineDb.meta.delete(key)
  },
}

/** Offline numbering state of a register's series (doc_type per register; §8.1, §12). */
export interface OfflineSeriesState {
  prefix: string
  next_number: number
  padding: number
  fy: string
}

export const metaKeys = {
  catalogCursor: (tenantId: string, registerId: string) =>
    `catalog.cursor.${tenantId}.${registerId}`,
  catalogSyncedAt: (tenantId: string) => `catalog.synced_at.${tenantId}`,
  series: (tenantId: string, registerId: string, docType: string) =>
    `series.${tenantId}.${registerId}.${docType}`,
  lastOutboxSync: (tenantId: string) => `outbox.synced_at.${tenantId}`,
}

// ---------------------------------------------------------------------------------------------
// Catalogue cache
// ---------------------------------------------------------------------------------------------

export interface CatalogSnapshot {
  products: CachedProduct[]
  barcodes: CachedBarcode[]
  batches: CachedBatch[]
  promotions: CachedPromotion[]
  tax_slab_rules: CachedTaxSlabRule[]
  store_prices: CachedStorePrice[]
}

export interface CatalogDelta extends Partial<CatalogSnapshot> {
  /** Ids removed / deactivated since the cursor. */
  removed_product_ids?: string[]
  removed_barcodes?: string[]
  removed_batch_ids?: string[]
  removed_promotion_ids?: string[]
}

const withTokens = (p: CachedProduct): CachedProduct => ({ ...p, search_tokens: searchTokens(p) })

const catalogTables = (): Table<unknown, unknown>[] =>
  [
    offlineDb.products,
    offlineDb.barcodes,
    offlineDb.batches,
    offlineDb.promotions,
    offlineDb.tax_slab_rules,
    offlineDb.store_prices,
    offlineDb.meta,
  ] as unknown as Table<unknown, unknown>[]

export const catalogCache = {
  /** Removes every cached catalogue row of a tenant (not the outbox / held carts). */
  async clearTenant(tenantId: string): Promise<void> {
    await offlineDb.transaction('rw', catalogTables(), async () => {
      await offlineDb.products.where('tenant_id').equals(tenantId).delete()
      await offlineDb.barcodes.where('tenant_id').equals(tenantId).delete()
      await offlineDb.batches.where('tenant_id').equals(tenantId).delete()
      await offlineDb.promotions.where('tenant_id').equals(tenantId).delete()
      await offlineDb.tax_slab_rules.where('tenant_id').equals(tenantId).delete()
      await offlineDb.store_prices.where('tenant_id').equals(tenantId).delete()
      await offlineDb.meta
        .where('key')
        .startsWith(`catalog.`)
        .filter((m) => m.key.includes(tenantId))
        .delete()
    })
  },

  /** Full load (first bootstrap or cursor reset): replaces the tenant's catalogue atomically. */
  async replaceAll(
    tenantId: string,
    registerId: string,
    snapshot: CatalogSnapshot,
    cursor: string | null,
  ): Promise<void> {
    await offlineDb.transaction('rw', catalogTables(), async () => {
      await catalogCache.clearTenant(tenantId)
      await offlineDb.products.bulkPut(snapshot.products.map(withTokens))
      await offlineDb.barcodes.bulkPut(snapshot.barcodes)
      await offlineDb.batches.bulkPut(snapshot.batches)
      await offlineDb.promotions.bulkPut(snapshot.promotions)
      await offlineDb.tax_slab_rules.bulkPut(snapshot.tax_slab_rules)
      await offlineDb.store_prices.bulkPut(snapshot.store_prices)
      await meta.set(metaKeys.catalogCursor(tenantId, registerId), cursor)
      await meta.set(metaKeys.catalogSyncedAt(tenantId), nowIso())
    })
  },

  /** Incremental update from GET /pos/bootstrap?since=<cursor>. */
  async applyDelta(
    tenantId: string,
    registerId: string,
    delta: CatalogDelta,
    cursor: string | null,
  ): Promise<void> {
    await offlineDb.transaction('rw', catalogTables(), async () => {
      if (delta.products?.length) await offlineDb.products.bulkPut(delta.products.map(withTokens))
      if (delta.barcodes?.length) await offlineDb.barcodes.bulkPut(delta.barcodes)
      if (delta.batches?.length) await offlineDb.batches.bulkPut(delta.batches)
      if (delta.promotions?.length) await offlineDb.promotions.bulkPut(delta.promotions)
      if (delta.tax_slab_rules?.length) await offlineDb.tax_slab_rules.bulkPut(delta.tax_slab_rules)
      if (delta.store_prices?.length) await offlineDb.store_prices.bulkPut(delta.store_prices)
      if (delta.removed_product_ids?.length)
        await offlineDb.products.bulkDelete(
          delta.removed_product_ids.map((id) => [tenantId, id] as [string, string]),
        )
      if (delta.removed_barcodes?.length)
        await offlineDb.barcodes.bulkDelete(
          delta.removed_barcodes.map((b) => [tenantId, b] as [string, string]),
        )
      if (delta.removed_batch_ids?.length)
        await offlineDb.batches.bulkDelete(
          delta.removed_batch_ids.map((id) => [tenantId, id] as [string, string]),
        )
      if (delta.removed_promotion_ids?.length)
        await offlineDb.promotions.bulkDelete(
          delta.removed_promotion_ids.map((id) => [tenantId, id] as [string, string]),
        )
      await meta.set(metaKeys.catalogCursor(tenantId, registerId), cursor)
      await meta.set(metaKeys.catalogSyncedAt(tenantId), nowIso())
    })
  },

  getCursor(tenantId: string, registerId: string): Promise<string | null | undefined> {
    return meta.get<string | null>(metaKeys.catalogCursor(tenantId, registerId))
  },

  getProduct(tenantId: string, id: string): Promise<CachedProduct | undefined> {
    return offlineDb.products.get([tenantId, id])
  },

  /** Exact barcode → product and the quantity the scan represents. */
  async findByBarcode(
    tenantId: string,
    code: string,
  ): Promise<{ product: CachedProduct; qty_milli: number } | null> {
    const bc = await offlineDb.barcodes.get([tenantId, code.trim()])
    if (!bc) return null
    const product = await offlineDb.products.get([tenantId, bc.product_id])
    return product?.is_active ? { product, qty_milli: bc.qty_milli } : null
  },

  /** SKU (case-insensitive exact). */
  async findBySku(tenantId: string, sku: string): Promise<CachedProduct | null> {
    const wanted = sku.trim().toLowerCase()
    const hit = await offlineDb.products
      .where('tenant_id')
      .equals(tenantId)
      .filter((p) => p.is_active && p.sku?.toLowerCase() === wanted)
      .first()
    return hit ?? null
  },

  /** Scale PLU (already normalised with shared `normalizePlu`). */
  async findByScalePlu(tenantId: string, plu: string): Promise<CachedProduct | null> {
    const hit = await offlineDb.products
      .where('[tenant_id+scale_plu]')
      .equals([tenantId, plu])
      .first()
    return hit?.is_active ? hit : null
  },

  /**
   * Prefix search on any word of name / Tamil name / SKU / aliases; every query word must match.
   * Sellable products only (no variant parents), sorted by name.
   */
  async search(tenantId: string, query: string, limit = 30): Promise<CachedProduct[]> {
    const words = query.toLocaleLowerCase('en-IN').split(/\s+/u).filter(Boolean)
    const first = words[0]
    if (!first) return []
    const rest = words.slice(1)
    const candidates = await offlineDb.products
      .where('search_tokens')
      .startsWith(first)
      .filter(
        (p) =>
          p.tenant_id === tenantId &&
          p.is_active &&
          p.kind !== 'variant_parent' &&
          rest.every((w) => (p.search_tokens ?? []).some((t) => t.startsWith(w))),
      )
      .limit(limit * 3)
      .toArray()
    const unique = new Map(candidates.map((p) => [p.id, p]))
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit)
  },

  getBatches(tenantId: string, productId: string): Promise<CachedBatch[]> {
    return offlineDb.batches.where('[tenant_id+product_id]').equals([tenantId, productId]).toArray()
  },

  getPromotions(tenantId: string): Promise<CachedPromotion[]> {
    return offlineDb.promotions.where('tenant_id').equals(tenantId).toArray()
  },

  getTaxSlabRules(tenantId: string): Promise<CachedTaxSlabRule[]> {
    return offlineDb.tax_slab_rules.where('tenant_id').equals(tenantId).toArray()
  },

  getStorePrice(
    tenantId: string,
    storeId: string,
    productId: string,
  ): Promise<CachedStorePrice | undefined> {
    return offlineDb.store_prices.get([tenantId, storeId, productId])
  },

  countProducts(tenantId: string): Promise<number> {
    return offlineDb.products.where('tenant_id').equals(tenantId).count()
  },
}

// ---------------------------------------------------------------------------------------------
// Outbox (offline invoices / credit notes)
// ---------------------------------------------------------------------------------------------

export type NewOutboxEntry = Pick<
  OutboxEntry,
  'client_ref' | 'tenant_id' | 'store_id' | 'register_id' | 'kind' | 'number' | 'payload'
>

export const outbox = {
  /** Queues a document; the same client_ref twice is a no-op (idempotent). */
  async enqueue(entry: NewOutboxEntry): Promise<OutboxEntry> {
    return offlineDb.transaction('rw', offlineDb.outbox, async () => {
      const existing = await offlineDb.outbox.where('client_ref').equals(entry.client_ref).first()
      if (existing) return existing
      const row: OutboxEntry = {
        ...entry,
        status: 'pending',
        attempts: 0,
        last_error: null,
        created_at: nowIso(),
        synced_at: null,
        server_id: null,
        server_number: null,
        renumbered: false,
      }
      row.seq = await offlineDb.outbox.add(row)
      return row
    })
  },

  /** Documents to upload, oldest first (failed ones are retried in their original order). */
  async pending(tenantId: string, registerId?: string): Promise<OutboxEntry[]> {
    const rows = await offlineDb.outbox
      .orderBy('seq')
      .filter(
        (r) =>
          r.tenant_id === tenantId &&
          (r.status === 'pending' || r.status === 'failed' || r.status === 'syncing') &&
          (registerId === undefined || r.register_id === registerId),
      )
      .toArray()
    return rows
  },

  list(tenantId: string, status?: OutboxStatus): Promise<OutboxEntry[]> {
    return offlineDb.outbox
      .orderBy('seq')
      .filter((r) => r.tenant_id === tenantId && (status === undefined || r.status === status))
      .toArray()
  },

  /** Number of documents not yet accepted by the server. */
  countUnsynced(tenantId: string): Promise<number> {
    return offlineDb.outbox.filter((r) => r.tenant_id === tenantId && r.status !== 'synced').count()
  },

  async markSyncing(clientRefs: string[]): Promise<void> {
    await offlineDb.outbox
      .where('client_ref')
      .anyOf(clientRefs)
      .modify((r) => {
        r.status = 'syncing'
        r.attempts += 1
      })
  },

  async markSynced(
    clientRef: string,
    result: { server_id: string; server_number: string | null; renumbered?: boolean },
  ): Promise<void> {
    await offlineDb.outbox
      .where('client_ref')
      .equals(clientRef)
      .modify((r) => {
        r.status = 'synced'
        r.synced_at = nowIso()
        r.server_id = result.server_id
        r.server_number = result.server_number
        r.renumbered = result.renumbered ?? false
        r.last_error = null
      })
  },

  async markFailed(clientRef: string, error: { code: string; message: string }): Promise<void> {
    await offlineDb.outbox
      .where('client_ref')
      .equals(clientRef)
      .modify((r) => {
        r.status = 'failed'
        r.last_error = error
      })
  },

  /** Deletes synced rows older than `olderThanDays` (kept a while for reprints / audit). */
  async pruneSynced(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString()
    return offlineDb.outbox
      .filter((r) => r.status === 'synced' && (r.synced_at ?? '') < cutoff)
      .delete()
  },

  get(clientRef: string): Promise<OutboxEntry | undefined> {
    return offlineDb.outbox.where('client_ref').equals(clientRef).first()
  },
}

// ---------------------------------------------------------------------------------------------
// Held carts (on this device)
// ---------------------------------------------------------------------------------------------

export const heldCarts = {
  async save(
    cart: Omit<HeldCart, 'created_at' | 'updated_at'> & { created_at?: string },
  ): Promise<HeldCart> {
    const existing = await offlineDb.held_carts.get(cart.id)
    const row: HeldCart = {
      ...cart,
      created_at: existing?.created_at ?? cart.created_at ?? nowIso(),
      updated_at: nowIso(),
    }
    await offlineDb.held_carts.put(row)
    return row
  },
  list(tenantId: string, storeId: string): Promise<HeldCart[]> {
    return offlineDb.held_carts
      .where('[tenant_id+store_id]')
      .equals([tenantId, storeId])
      .reverse()
      .sortBy('updated_at')
  },
  get(id: string): Promise<HeldCart | undefined> {
    return offlineDb.held_carts.get(id)
  },
  async remove(id: string): Promise<void> {
    await offlineDb.held_carts.delete(id)
  },
}

/**
 * Wipes the whole offline database (Settings → "clear this device"). Refuses while unsynced
 * documents exist unless `force` is set — unsynced bills are real sales.
 */
export async function deleteOfflineData(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force) {
    const unsynced = await offlineDb.outbox.filter((r) => r.status !== 'synced').count()
    if (unsynced > 0) throw new Error(`${unsynced} offline documents are not synced yet`)
  }
  await offlineDb.delete()
  await offlineDb.open()
}
