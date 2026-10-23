/** Small helpers shared by the POS tests. */
import type { PosBootstrap } from '@kadai/shared/api/sales'
import type { PricingEnv } from '../lib/pricing'
import type { PosContext } from '../lib/types'

export function pricingEnvOf(
  b: PosBootstrap,
  now = new Date('2026-10-21T10:00:00.000Z'),
): PricingEnv {
  return {
    tax_mode: b.tax_mode,
    round_off: b.settings.invoice.round_off,
    store_id: b.store.id,
    timezone: b.tenant.timezone,
    promotions: [],
    loyalty: null,
    now,
  }
}

/** The cached context of a bootstrap (what the POS keeps besides the Dexie catalogue rows). */
export function contextOf(b: PosBootstrap): PosContext {
  const {
    mode: _mode,
    cursor: _cursor,
    products: _products,
    barcodes: _barcodes,
    barcode_product_ids: _bpi,
    store_prices: _sp,
    store_price_product_ids: _spi,
    batches: _batches,
    promotions: _promotions,
    tax_slab_rules: _slabs,
    removed_product_ids: _rp,
    removed_barcodes: _rb,
    removed_batch_ids: _rbi,
    removed_promotion_ids: _rpi,
    ...rest
  } = b
  return { ...rest, synced_at: b.server_time }
}
