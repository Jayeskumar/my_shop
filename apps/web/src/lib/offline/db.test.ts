import { describe, expect, it } from 'vitest'
import { newId } from '@kadai/shared/ids'
import {
  catalogCache,
  heldCarts,
  meta,
  metaKeys,
  offlineDb,
  outbox,
  searchTokens,
  type CachedProduct,
} from './db'

const T = 'tenant-1'
const R = 'register-1'

function product(overrides: Partial<CachedProduct>): CachedProduct {
  return {
    tenant_id: T,
    id: newId(),
    parent_id: null,
    kind: 'standard',
    sku: null,
    name: 'Product',
    name_ta: null,
    aliases: [],
    category_id: null,
    brand_id: null,
    unit: 'PCS',
    pack_size: 1,
    allow_loose: false,
    decimal_qty: false,
    hsn_code: null,
    gst_rate_bp: 500,
    cess_rate_bp: 0,
    tax_slab_rule_id: null,
    price_includes_tax: true,
    mrp_paise: null,
    sale_price_paise: 1000,
    wholesale_price_paise: null,
    min_sale_price_paise: null,
    max_discount_bp: null,
    track_inventory: true,
    track_batches: false,
    is_weighed: false,
    scale_plu: null,
    variant_attributes: {},
    attributes: {},
    is_active: true,
    updated_at: '2026-10-20T00:00:00.000Z',
    ...overrides,
  }
}

describe('offline db', () => {
  it('tokenizes Latin and Tamil names', () => {
    expect(
      searchTokens({
        name: 'Ponni Rice (25 kg)',
        name_ta: 'பொன்னி அரிசி',
        sku: 'PR-25',
        aliases: ['arisi'],
      }),
    ).toEqual(
      expect.arrayContaining(['ponni', 'rice', '25', 'kg', 'பொன்னி', 'அரிசி', 'pr', 'arisi']),
    )
  })

  it('replaces the catalogue and searches by word prefix, barcode, SKU and scale PLU', async () => {
    const rice = product({
      name: 'Ponni Rice 25 kg',
      name_ta: 'பொன்னி அரிசி',
      aliases: ['arisi'],
      sku: 'RICE25',
    })
    const dal = product({ name: 'Toor Dal 1 kg', name_ta: 'துவரம் பருப்பு', aliases: ['paruppu'] })
    const tomato = product({
      name: 'Tomato',
      unit: 'KG',
      decimal_qty: true,
      is_weighed: true,
      scale_plu: '101',
    })
    const inactive = product({ name: 'Rice flour', is_active: false })
    await catalogCache.replaceAll(
      T,
      R,
      {
        products: [rice, dal, tomato, inactive],
        barcodes: [
          { tenant_id: T, barcode: '8901234567890', product_id: rice.id, qty_milli: 1000 },
        ],
        batches: [],
        promotions: [],
        tax_slab_rules: [],
        store_prices: [],
      },
      'cursor-1',
    )

    expect((await catalogCache.search(T, 'ri')).map((p) => p.name)).toEqual(['Ponni Rice 25 kg'])
    expect((await catalogCache.search(T, 'அரி')).map((p) => p.id)).toEqual([rice.id])
    expect((await catalogCache.search(T, 'paru')).map((p) => p.id)).toEqual([dal.id])
    expect((await catalogCache.search(T, 'toor 1')).map((p) => p.id)).toEqual([dal.id])
    expect(await catalogCache.findByBarcode(T, '8901234567890')).toMatchObject({
      product: { id: rice.id },
      qty_milli: 1000,
    })
    expect(await catalogCache.findByBarcode(T, '000')).toBeNull()
    expect((await catalogCache.findBySku(T, 'rice25'))?.id).toBe(rice.id)
    expect((await catalogCache.findByScalePlu(T, '101'))?.id).toBe(tomato.id)
    expect(await catalogCache.getCursor(T, R)).toBe('cursor-1')
    expect(await catalogCache.countProducts(T)).toBe(4)

    await catalogCache.applyDelta(
      T,
      R,
      { removed_product_ids: [dal.id], products: [{ ...rice, sale_price_paise: 1500 }] },
      'cursor-2',
    )
    expect((await catalogCache.getProduct(T, rice.id))?.sale_price_paise).toBe(1500)
    expect(await catalogCache.getProduct(T, dal.id)).toBeUndefined()
    expect(await catalogCache.getCursor(T, R)).toBe('cursor-2')

    await catalogCache.clearTenant(T)
    expect(await catalogCache.countProducts(T)).toBe(0)
  })

  it('queues offline documents idempotently and returns them in order', async () => {
    await offlineDb.outbox.clear()
    const a = await outbox.enqueue({
      client_ref: 'ref-a',
      tenant_id: T,
      store_id: 's',
      register_id: R,
      kind: 'invoice',
      number: 'S1A/2627/00001',
      payload: { n: 1 },
    })
    const again = await outbox.enqueue({
      client_ref: 'ref-a',
      tenant_id: T,
      store_id: 's',
      register_id: R,
      kind: 'invoice',
      number: 'X',
      payload: { n: 99 },
    })
    expect(again.seq).toBe(a.seq)
    await outbox.enqueue({
      client_ref: 'ref-b',
      tenant_id: T,
      store_id: 's',
      register_id: R,
      kind: 'credit_note',
      number: null,
      payload: { n: 2 },
    })
    expect((await outbox.pending(T)).map((e) => e.client_ref)).toEqual(['ref-a', 'ref-b'])
    expect(await outbox.countUnsynced(T)).toBe(2)

    await outbox.markSyncing(['ref-a'])
    await outbox.markSynced('ref-a', {
      server_id: 'srv-1',
      server_number: 'S1A/2627/00002',
      renumbered: true,
    })
    await outbox.markFailed('ref-b', { code: 'INSUFFICIENT_STOCK', message: 'x' })
    expect((await outbox.pending(T)).map((e) => e.client_ref)).toEqual(['ref-b'])
    expect(await outbox.get('ref-a')).toMatchObject({
      status: 'synced',
      renumbered: true,
      attempts: 1,
    })
    expect(await outbox.countUnsynced(T)).toBe(1)
  })

  it('stores held carts and meta values', async () => {
    await heldCarts.save({
      id: 'h1',
      tenant_id: T,
      store_id: 's',
      register_id: R,
      label: 'Table 2',
      customer_name: null,
      item_count: 3,
      total_paise: 45000,
      cart: { lines: [] },
    })
    expect((await heldCarts.list(T, 's')).map((c) => c.id)).toEqual(['h1'])
    await heldCarts.remove('h1')
    expect(await heldCarts.list(T, 's')).toEqual([])

    await meta.set(metaKeys.series(T, R, 'sales_invoice'), {
      prefix: 'S1A/2627/',
      next_number: 42,
      padding: 5,
      fy: '2026-27',
    })
    expect(await meta.get(metaKeys.series(T, R, 'sales_invoice'))).toMatchObject({
      next_number: 42,
    })
  })
})
