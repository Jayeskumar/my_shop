import { newId } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tx } from '../db/tenant'
import { type TestApp, buildTestApp } from '../test/helpers'
import { type TestShop, createTestTenant, insertTestBatch, insertTestProduct } from '../test/tenants'
import {
  type StockMovementInput,
  getAvailable,
  movingAverage,
  pickBatchesFefo,
  postStock,
  stockValuePaise,
} from './inventory'

/** Σ movements per (store, product, batch) must equal the stock_levels balance. */
async function assertLedgerMatchesLevels(tx: Tx, tenantId: string, productIds: string[]): Promise<void> {
  const rows = await sql<{ store_id: string; product_id: string; batch_id: string | null; level: number; moved: number }>`
    select l.store_id, l.product_id, l.batch_id, l.qty_milli as level,
           coalesce((select sum(m.qty_milli) from stock_movements m
                      where m.tenant_id = l.tenant_id and m.store_id = l.store_id and m.product_id = l.product_id
                        and m.batch_id is not distinct from l.batch_id), 0)::bigint as moved
      from stock_levels l
     where l.tenant_id = ${tenantId} and l.product_id = any(${productIds}::uuid[])`.execute(tx)
  expect(rows.rows.length).toBeGreaterThan(0)
  for (const r of rows.rows) expect(Number(r.moved)).toBe(Number(r.level))
}

describe('core/inventory', () => {
  let t: TestApp
  let shop: TestShop
  let pharmacy: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t) // general store: negative stock allowed
    pharmacy = await createTestTenant(t, { business_type: 'pharmacy' }) // negative stock blocked
  })
  afterAll(() => t.close())

  const post = (s: TestShop, movements: StockMovementInput[], opts?: { allowNegative?: boolean }) =>
    s.tx((tx) => postStock(tx, s.ctx, movements, opts))

  it('maintains the moving average cost per pack and costs sales at it', async () => {
    const p = await insertTestProduct(t.deps, shop.tenant.id, { purchase_price_paise: 90 })
    const base = { store_id: shop.store.id, product_id: p.id }
    const [in1] = await post(shop, [{ ...base, qty_milli: 10_000, movement_type: 'purchase', unit_cost_paise: 100 }])
    expect(in1).toMatchObject({ balance_after_milli: 10_000, avg_cost_after_paise: 100, cost_paise: 1000 })
    const [in2] = await post(shop, [{ ...base, qty_milli: 10_000, movement_type: 'purchase', unit_cost_paise: 200 }])
    expect(in2?.avg_cost_after_paise).toBe(150)
    const [sale] = await post(shop, [
      { ...base, qty_milli: -5_000, movement_type: 'sale', ref_type: 'sales_invoice', ref_id: newId() },
    ])
    expect(sale).toMatchObject({
      unit_cost_paise: 150,
      cost_paise: 750,
      value_paise: -750,
      balance_after_milli: 15_000,
      avg_cost_after_paise: 150,
      skipped: false,
    })
    // Fractional average: 15 @150 + 5 @ 101 → (2250 + 505) / 20 = 137.75 → 138
    const [in3] = await post(shop, [{ ...base, qty_milli: 5_000, movement_type: 'purchase', unit_cost_paise: 101 }])
    expect(in3?.avg_cost_after_paise).toBe(138)
    expect(await shop.tx((tx) => getAvailable(tx, shop.ctx, base))).toBe(20_000)
    await shop.tx((tx) => assertLedgerMatchesLevels(tx, shop.tenant.id, [p.id]))
  })

  it('prices by pack: loose tablets of a 10-tablet strip', async () => {
    const strip = await insertTestProduct(t.deps, shop.tenant.id, { unit: 'TAB', pack_size: 10 })
    const base = { store_id: shop.store.id, product_id: strip.id }
    await post(shop, [{ ...base, qty_milli: 100_000, movement_type: 'opening', unit_cost_paise: 1000 }])
    const [sale] = await post(shop, [{ ...base, qty_milli: -3_000, movement_type: 'sale' }])
    expect(sale?.cost_paise).toBe(300) // 3 tablets of a ₹10 strip
    expect(stockValuePaise(1000, 3_000, 10)).toBe(300)
  })

  it('resets the average to the inbound cost when stock was zero or negative', async () => {
    const p = await insertTestProduct(t.deps, shop.tenant.id, { purchase_price_paise: 250 })
    const base = { store_id: shop.store.id, product_id: p.id }
    // Sold before any purchase (allowed for a general store): costed at the product price.
    const [sale] = await post(shop, [{ ...base, qty_milli: -5_000, movement_type: 'sale' }])
    expect(sale).toMatchObject({ unit_cost_paise: 250, balance_after_milli: -5_000 })
    const [inb] = await post(shop, [{ ...base, qty_milli: 10_000, movement_type: 'purchase', unit_cost_paise: 300 }])
    expect(inb).toMatchObject({ avg_cost_after_paise: 300, balance_after_milli: 5_000 })
    expect(movingAverage(-5_000, 250, 10_000, 300)).toBe(300)
    expect(movingAverage(0, 0, 1_000, 77)).toBe(77)
  })

  it('keeps Σ movements equal to the level over a mixed sequence, including several movements per call', async () => {
    const a = await insertTestProduct(t.deps, shop.tenant.id)
    const b = await insertTestProduct(t.deps, shop.tenant.id)
    const s = shop.store.id
    const posted = await post(shop, [
      { store_id: s, product_id: a.id, qty_milli: 7_500, movement_type: 'opening', unit_cost_paise: 4000 },
      { store_id: s, product_id: b.id, qty_milli: 2_000, movement_type: 'opening', unit_cost_paise: 1000 },
      { store_id: s, product_id: a.id, qty_milli: -1_250, movement_type: 'sale' },
      { store_id: s, product_id: a.id, qty_milli: -250, movement_type: 'damage', reason: 'torn bag' },
      { store_id: s, product_id: b.id, qty_milli: 500, movement_type: 'adjustment' },
      { store_id: s, product_id: a.id, qty_milli: 1_250, movement_type: 'sale_return', unit_cost_paise: 4000 },
    ])
    expect(posted.map((m) => m.balance_after_milli)).toEqual([7_500, 2_000, 6_250, 6_000, 2_500, 7_250])
    // The gain without a cost is valued at the current average.
    expect(posted[4]).toMatchObject({ unit_cost_paise: 1000, cost_paise: 500 })
    for (let i = 0; i < 5; i++) {
      await post(shop, [
        { store_id: s, product_id: a.id, qty_milli: -(i + 1) * 100, movement_type: 'sale' },
        { store_id: s, product_id: b.id, qty_milli: (i + 1) * 300, movement_type: 'purchase', unit_cost_paise: 900 + i },
      ])
    }
    await shop.tx((tx) => assertLedgerMatchesLevels(tx, shop.tenant.id, [a.id, b.id]))
    const movementsOfA = await shop.tx((tx) =>
      tx
        .selectFrom('stock_movements')
        .select(['movement_type', 'created_by'])
        .where('product_id', '=', a.id)
        .execute(),
    )
    expect(movementsOfA.every((m) => m.created_by === shop.owner.user.id)).toBe(true)
  })

  it('enforces the negative-stock policy (tenant setting, opts.allowNegative override)', async () => {
    const p = await insertTestProduct(t.deps, pharmacy.tenant.id, { name: 'Paracetamol 500' })
    const base = { store_id: pharmacy.store.id, product_id: p.id }
    await post(pharmacy, [{ ...base, qty_milli: 2_000, movement_type: 'purchase', unit_cost_paise: 100 }])
    const err = await post(pharmacy, [{ ...base, qty_milli: -3_000, movement_type: 'sale' }]).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 422,
      details: {
        product_id: p.id,
        name: 'Paracetamol 500',
        available_milli: 2_000,
        requested_milli: 3_000,
        store_id: pharmacy.store.id,
      },
    })
    // Nothing was written by the failed call.
    expect(await pharmacy.tx((tx) => getAvailable(tx, pharmacy.ctx, base))).toBe(2_000)
    // Offline sync may force it.
    const [forced] = await post(pharmacy, [{ ...base, qty_milli: -3_000, movement_type: 'sale' }], {
      allowNegative: true,
    })
    expect(forced?.balance_after_milli).toBe(-1_000)
  })

  it('skips products that do not track inventory and validates movements', async () => {
    const service = await insertTestProduct(t.deps, shop.tenant.id, { kind: 'service' })
    const [skipped] = await post(shop, [
      { store_id: shop.store.id, product_id: service.id, qty_milli: -1_000, movement_type: 'sale' },
    ])
    expect(skipped).toMatchObject({ skipped: true, movement_id: null, cost_paise: 0 })
    const levels = await shop.tx((tx) =>
      tx.selectFrom('stock_levels').select('id').where('product_id', '=', service.id).execute(),
    )
    expect(levels).toHaveLength(0)

    const p = await insertTestProduct(t.deps, shop.tenant.id)
    const base = { store_id: shop.store.id, product_id: p.id }
    await expect(post(shop, [{ ...base, qty_milli: 1_000, movement_type: 'sale' }])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await expect(post(shop, [{ ...base, qty_milli: 1_000, movement_type: 'purchase' }])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await expect(post(shop, [{ ...base, qty_milli: 0, movement_type: 'adjustment' }])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    const parent = await insertTestProduct(t.deps, shop.tenant.id, { kind: 'variant_parent' })
    await expect(
      post(shop, [{ store_id: shop.store.id, product_id: parent.id, qty_milli: 1_000, movement_type: 'opening', unit_cost_paise: 1 }]),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
  })

  it('requires batches for batch-tracked products and costs them at the batch price', async () => {
    const drug = await insertTestProduct(t.deps, pharmacy.tenant.id, {
      track_batches: true,
      pack_size: 10,
      purchase_price_paise: 999,
    })
    const other = await insertTestProduct(t.deps, pharmacy.tenant.id, { track_batches: true })
    const b1 = await insertTestBatch(t.deps, pharmacy.tenant.id, drug.id, { purchase_price_paise: 500 })
    const b2 = await insertTestBatch(t.deps, pharmacy.tenant.id, drug.id, { purchase_price_paise: 650 })
    const foreign = await insertTestBatch(t.deps, pharmacy.tenant.id, other.id)
    const base = { store_id: pharmacy.store.id, product_id: drug.id }
    await expect(post(pharmacy, [{ ...base, qty_milli: 1_000, movement_type: 'opening', unit_cost_paise: 1 }])).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    })
    await expect(
      post(pharmacy, [{ ...base, batch_id: foreign.id, qty_milli: 1_000, movement_type: 'opening', unit_cost_paise: 1 }]),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })

    await post(pharmacy, [{ ...base, batch_id: b1.id, qty_milli: 50_000, movement_type: 'purchase', unit_cost_paise: 480 }])
    const [s1] = await post(pharmacy, [{ ...base, batch_id: b1.id, qty_milli: -10_000, movement_type: 'sale' }])
    expect(s1).toMatchObject({ unit_cost_paise: 480, cost_paise: 480 }) // the batch row's landed cost
    // A batch without cost history falls back to batches.purchase_price_paise.
    const [s2] = await post(pharmacy, [{ ...base, batch_id: b2.id, qty_milli: -10_000, movement_type: 'sale' }], {
      allowNegative: true,
    })
    expect(s2).toMatchObject({ unit_cost_paise: 650, cost_paise: 650 })

    const plain = await insertTestProduct(t.deps, pharmacy.tenant.id)
    await expect(
      post(pharmacy, [{ store_id: pharmacy.store.id, product_id: plain.id, batch_id: b1.id, qty_milli: 1, movement_type: 'opening', unit_cost_paise: 1 }]),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
    expect(await pharmacy.tx((tx) => getAvailable(tx, pharmacy.ctx, base))).toBe(30_000)
    expect(await pharmacy.tx((tx) => getAvailable(tx, pharmacy.ctx, { ...base, batch_id: b1.id }))).toBe(40_000)
    expect(await pharmacy.tx((tx) => getAvailable(tx, pharmacy.ctx, { ...base, batch_id: null }))).toBe(0)
  })

  it('picks batches first-expiry-first-out and skips expired ones', async () => {
    const drug = await insertTestProduct(t.deps, pharmacy.tenant.id, { track_batches: true })
    const tid = pharmacy.tenant.id
    const late = await insertTestBatch(t.deps, tid, drug.id, { batch_no: 'LATE', expiry_date: '2027-06-30' })
    const soon = await insertTestBatch(t.deps, tid, drug.id, { batch_no: 'SOON', expiry_date: '2026-12-31' })
    const expired = await insertTestBatch(t.deps, tid, drug.id, { batch_no: 'OLD', expiry_date: '2026-09-30' })
    const noExpiry = await insertTestBatch(t.deps, tid, drug.id, { batch_no: 'NOEXP' })
    const empty = await insertTestBatch(t.deps, tid, drug.id, { batch_no: 'EMPTY', expiry_date: '2026-11-30' })
    const base = { store_id: pharmacy.store.id, product_id: drug.id }
    await post(pharmacy, [
      { ...base, batch_id: late.id, qty_milli: 5_000, movement_type: 'purchase', unit_cost_paise: 10 },
      { ...base, batch_id: soon.id, qty_milli: 4_000, movement_type: 'purchase', unit_cost_paise: 10 },
      { ...base, batch_id: expired.id, qty_milli: 9_000, movement_type: 'purchase', unit_cost_paise: 10 },
      { ...base, batch_id: noExpiry.id, qty_milli: 9_000, movement_type: 'purchase', unit_cost_paise: 10 },
      { ...base, batch_id: empty.id, qty_milli: 1_000, movement_type: 'purchase', unit_cost_paise: 10 },
      { ...base, batch_id: empty.id, qty_milli: -1_000, movement_type: 'sale' },
    ])
    const picks = await pharmacy.tx((tx) =>
      pickBatchesFefo(tx, pharmacy.ctx, { ...base, qty_milli: 12_000, today: '2026-10-20' }),
    )
    expect(picks.map((p) => [p.batch_no, p.qty_milli])).toEqual([
      ['SOON', 4_000],
      ['LATE', 5_000],
      ['NOEXP', 3_000],
    ])
    // A batch is sellable on its expiry date.
    const onExpiry = await pharmacy.tx((tx) =>
      pickBatchesFefo(tx, pharmacy.ctx, { ...base, qty_milli: 1_000, today: '2026-12-31' }),
    )
    expect(onExpiry[0]?.batch_no).toBe('SOON')

    // Short: 18 sellable units.
    await expect(
      pharmacy.tx((tx) => pickBatchesFefo(tx, pharmacy.ctx, { ...base, qty_milli: 20_000, today: '2026-10-20' })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available_milli: 18_000, requested_milli: 20_000 } })
    const forced = await pharmacy.tx((tx) =>
      pickBatchesFefo(tx, pharmacy.ctx, { ...base, qty_milli: 20_000, today: '2026-10-20', allowNegative: true }),
    )
    expect(forced.map((p) => [p.batch_no, p.qty_milli])).toEqual([
      ['SOON', 4_000],
      ['LATE', 5_000],
      ['NOEXP', 11_000],
    ])

    // Selling expired stock allowed by the tenant: expired batches come first.
    await pharmacy.tx(async (tx) => {
      await tx
        .updateTable('tenants')
        .set({ settings: sql`jsonb_set(settings, '{inventory,block_expired_sale}', 'false')` })
        .where('id', '=', pharmacy.tenant.id)
        .execute()
      const withExpired = await pickBatchesFefo(tx, pharmacy.ctx, { ...base, qty_milli: 10_000, today: '2026-10-20' })
      expect(withExpired.map((p) => p.batch_no)).toEqual(['OLD', 'SOON'])
      throw new Error('rollback the settings change')
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== 'rollback the settings change') throw e
    })

    // Non-batch products get one unbatched pick.
    const plain = await insertTestProduct(t.deps, pharmacy.tenant.id)
    expect(
      await pharmacy.tx((tx) =>
        pickBatchesFefo(tx, pharmacy.ctx, { store_id: pharmacy.store.id, product_id: plain.id, qty_milli: 1_500, today: '2026-10-20' }),
      ),
    ).toEqual([{ batch_id: null, qty_milli: 1_500, batch_no: null, expiry_date: null }])
  })

  it('does not lose updates under concurrent sales of the same product', async () => {
    const p = await insertTestProduct(t.deps, shop.tenant.id)
    const base = { store_id: shop.store.id, product_id: p.id }
    await post(shop, [{ ...base, qty_milli: 100_000, movement_type: 'purchase', unit_cost_paise: 50 }])
    await Promise.all(
      Array.from({ length: 20 }, () => post(shop, [{ ...base, qty_milli: -1_000, movement_type: 'sale' }])),
    )
    expect(await shop.tx((tx) => getAvailable(tx, shop.ctx, base))).toBe(80_000)
    await shop.tx((tx) => assertLedgerMatchesLevels(tx, shop.tenant.id, [p.id]))
  })

  it('never oversells under concurrency when negative stock is blocked', async () => {
    const p = await insertTestProduct(t.deps, pharmacy.tenant.id)
    const base = { store_id: pharmacy.store.id, product_id: p.id }
    await post(pharmacy, [{ ...base, qty_milli: 10_000, movement_type: 'purchase', unit_cost_paise: 50 }])
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () => post(pharmacy, [{ ...base, qty_milli: -1_000, movement_type: 'sale' }])),
    )
    const ok = outcomes.filter((o) => o.status === 'fulfilled').length
    const rejected = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason as { code?: string }] : []))
    expect(ok).toBe(10)
    expect(rejected.every((r) => r.code === 'INSUFFICIENT_STOCK')).toBe(true)
    expect(await pharmacy.tx((tx) => getAvailable(tx, pharmacy.ctx, base))).toBe(0)
  })

  it('locks rows in a deterministic order (no deadlocks with opposite input orders, transfers)', async () => {
    const a = await insertTestProduct(t.deps, shop.tenant.id)
    const b = await insertTestProduct(t.deps, shop.tenant.id)
    const store2 = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({ id: store2, tenant_id: shop.tenant.id, code: 'S9', name: 'Branch', state_code: '33' })
      .execute()
    const s = shop.store.id
    await post(shop, [
      { store_id: s, product_id: a.id, qty_milli: 100_000, movement_type: 'purchase', unit_cost_paise: 10 },
      { store_id: s, product_id: b.id, qty_milli: 100_000, movement_type: 'purchase', unit_cost_paise: 20 },
    ])
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => {
        const pair: StockMovementInput[] = [
          { store_id: s, product_id: a.id, qty_milli: -1_000, movement_type: 'transfer_out' },
          { store_id: store2, product_id: a.id, qty_milli: 1_000, movement_type: 'transfer_in', unit_cost_paise: 10 },
          { store_id: s, product_id: b.id, qty_milli: -1_000, movement_type: 'sale' },
        ]
        return post(shop, i % 2 ? pair : [...pair].reverse())
      }),
    )
    expect(await shop.tx((tx) => getAvailable(tx, shop.ctx, { store_id: s, product_id: a.id }))).toBe(84_000)
    expect(await shop.tx((tx) => getAvailable(tx, shop.ctx, { store_id: store2, product_id: a.id }))).toBe(16_000)
    expect(await shop.tx((tx) => getAvailable(tx, shop.ctx, { store_id: s, product_id: b.id }))).toBe(84_000)
    await shop.tx((tx) => assertLedgerMatchesLevels(tx, shop.tenant.id, [a.id, b.id]))
  })

  it("cannot touch another tenant's products (RLS)", async () => {
    const theirs = await insertTestProduct(t.deps, pharmacy.tenant.id)
    await expect(
      post(shop, [{ store_id: shop.store.id, product_id: theirs.id, qty_milli: 1_000, movement_type: 'opening', unit_cost_paise: 1 }]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // …nor post to their store with our product (composite FK + RLS).
    const ours = await insertTestProduct(t.deps, shop.tenant.id)
    await expect(
      post(shop, [{ store_id: pharmacy.store.id, product_id: ours.id, qty_milli: 1_000, movement_type: 'opening', unit_cost_paise: 1 }]),
    ).rejects.toThrow()
  })
})
