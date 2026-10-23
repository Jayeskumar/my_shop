/**
 * Shared types of the POS feature: the cached bootstrap context (everything of GET /pos/bootstrap
 * except the catalogue rows, which live in the Dexie tables) and the product / batch shapes the
 * cart keeps as snapshots so a bill can be priced, printed and queued without the network.
 */
import type {
  BootstrapCustomerSchema,
  PosBootstrap,
  BootstrapProduct,
} from '@kadai/shared/api/sales'
import type { z } from 'zod'

/** GET /pos/bootstrap minus the catalogue rows (stored in Dexie meta per register). */
export type PosContext = Omit<
  PosBootstrap,
  | 'mode'
  | 'cursor'
  | 'products'
  | 'barcodes'
  | 'barcode_product_ids'
  | 'store_prices'
  | 'store_price_product_ids'
  | 'batches'
  | 'promotions'
  | 'tax_slab_rules'
  | 'removed_product_ids'
  | 'removed_barcodes'
  | 'removed_batch_ids'
  | 'removed_promotion_ids'
> & {
  /** When this context was last refreshed from the server (ISO). */
  synced_at: string
}

/** A sellable product as the POS uses it (= bootstrap product row). */
export type PosProduct = BootstrapProduct

/** A batch snapshot (pharmacy / FEFO). */
export interface PosBatch {
  id: string
  product_id: string
  batch_no: string
  expiry_date: string | null
  mrp_paise: number | null
  sale_price_paise: number | null
  /** Stock of the batch at the store when the catalogue was cached. */
  qty_milli: number
}

export type PosCustomerRow = z.output<typeof BootstrapCustomerSchema>

/** Identifies the counter a POS session bills on: the register, or the store (phone billing). */
export interface PosRegisterScope {
  tenantId: string
  storeId: string
  registerId: string | null
  /** Key for per-counter local state: the register id, or `store:<id>`. */
  key: string
}

export function registerScopeKey(storeId: string, registerId: string | null): string {
  return registerId ?? `store:${storeId}`
}
