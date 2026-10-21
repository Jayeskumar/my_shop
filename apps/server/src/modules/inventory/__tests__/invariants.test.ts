/**
 * Domain invariants over a mixed scenario on a clean two-store tenant, using only the inventory
 * API (opening stock, adjustments, stock take, damage, expiry write-off, cancellations, transfers
 * with and without shortfall — including per-movement rounding on pack-priced items):
 *
 * * Σ stock_movements = stock_levels per (store, product, batch);
 * * every journal entry balances;
 * * each store's inventory account balance = Σ of its movement values at cost;
 * * transfers conserve stock: the total across stores changes only by the recorded shortfall.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, todayIn } from '@kadai/shared'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  assertInventoryAccountMatchesStock,
  assertJournalsBalanced,
  assertLevelsMatchMovements,
  journalOf,
  levelOf,
  makeProduct,
  makeStore,
  openStock,
  req,
} from './fixtures'

describe('inventory invariants (mixed scenario)', () => {
  let t: TestApp
  let shop: TestShop
  let branch: { id: string; code: string }
  const today = todayIn('Asia/Kolkata')

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { business_type: 'supermarket' })
    branch = await makeStore(t, shop.tenant.id, 'S2')
  })
  afterAll(() => t.close())

  const post = async (url: string, payload?: unknown) => {
    const res = await req(shop, 'POST', url, payload)
    if (res.statusCode >= 300) throw new Error(`${url}: ${String(res.statusCode)} ${res.body}`)
    return res.json<{ data: { id: string; lines: Array<{ id: string; product_id: string }> } }>()
      .data
  }
  const adjust = async (kind: string, lines: unknown[]) => {
    const draft = await post('/stock-adjustments', { store_id: shop.store.id, kind, lines })
    return post(`/stock-adjustments/${draft.id}/post`)
  }
  const total = async (productId: string, batchId?: string | null) =>
    (await levelOf(t, shop.tenant.id, shop.store.id, productId, batchId)) +
    (await levelOf(t, shop.tenant.id, branch.id, productId, batchId))

  it('holds after every kind of inventory operation', async () => {
    const dal = await makeProduct(t, shop.tenant.id, { name: 'Toor Dal' })
    // Pack of 3 at ₹1: quantities that are not whole packs round per movement.
    const soap = await makeProduct(t, shop.tenant.id, { name: 'Soap 3-pack', pack_size: 3 })
    const milk = await makeProduct(t, shop.tenant.id, {
      name: 'Milk powder',
      track_batches: true,
      unit: 'KG',
    })

    const opened = await openStock(shop, shop.store.id, [
      { product_id: dal.id, qty_milli: 50_000, unit_cost_paise: 11_000 },
      { product_id: soap.id, qty_milli: 20_000, unit_cost_paise: 100 },
      {
        product_id: milk.id,
        qty_milli: 12_500,
        unit_cost_paise: 45_000,
        batch: { batch_no: 'M1', expiry_date: addDays(today, -2) },
      },
      {
        product_id: milk.id,
        qty_milli: 7_250,
        unit_cost_paise: 47_500,
        batch: { batch_no: 'M2', expiry_date: addDays(today, 120) },
      },
    ])
    const m1 = opened.batches_created.find((b) => b.batch_no === 'M1')!.batch_id
    const m2 = opened.batches_created.find((b) => b.batch_no === 'M2')!.batch_id
    await openStock(shop, branch.id, [
      { product_id: dal.id, qty_milli: 5_000, unit_cost_paise: 11_500 },
    ])

    // Gain at a new cost, loss at the average, damage, expiry write-off, stock take.
    await adjust('adjustment', [
      { product_id: dal.id, qty_delta_milli: 2_333, unit_cost_paise: 12_345 },
      { product_id: soap.id, qty_delta_milli: -1_001 },
    ])
    await adjust('damage', [{ product_id: milk.id, batch_id: m2, qty_delta_milli: -333 }])
    await adjust('expiry_writeoff', [
      { product_id: milk.id, batch_id: m1, qty_delta_milli: -12_500 },
    ])
    const take = await adjust('stock_take', [
      { product_id: dal.id, counted_qty_milli: 49_999 },
      { product_id: soap.id, counted_qty_milli: 19_500 },
    ])
    // A gain that is cancelled after the average moved, and a cancelled stock take.
    const gain = await adjust('adjustment', [
      { product_id: dal.id, qty_delta_milli: 1_000, unit_cost_paise: 20_000 },
    ])
    await post(`/stock-adjustments/${gain.id}/cancel`, { reason: 'Entered twice' })
    await post(`/stock-adjustments/${take.id}/cancel`, { reason: 'Recount' })

    // Transfers: received in full, received short (with rounding), cancelled in transit.
    const before = {
      dal: await total(dal.id),
      soap: await total(soap.id),
      milk: await total(milk.id, m2),
    }
    const full = await post('/stock-transfers', {
      from_store_id: shop.store.id,
      to_store_id: branch.id,
      lines: [
        { product_id: dal.id, qty_milli: 10_000 },
        { product_id: milk.id, batch_id: m2, qty_milli: 2_000 },
      ],
    })
    await post(`/stock-transfers/${full.id}/dispatch`)
    await post(`/stock-transfers/${full.id}/receive`, {})

    const short = await post('/stock-transfers', {
      from_store_id: shop.store.id,
      to_store_id: branch.id,
      lines: [{ product_id: soap.id, qty_milli: 1_000 }],
    })
    await post(`/stock-transfers/${short.id}/dispatch`)
    const soapLine = short.lines[0]!
    await post(`/stock-transfers/${short.id}/receive`, {
      lines: [{ line_id: soapLine.id, received_qty_milli: 500 }],
      shortfall_reason: 'Two soaps missing',
    })
    // 1 000 / 3 packs at ₹1 = 33 p left; 500 received (17 p) and 500 returned (17 p): the 1 p
    // rounding residue is booked to inventory_adjustment.
    const shortJournal = await journalOf(t, shop.tenant.id, 'stock_transfer', short.id)
    expect(
      shortJournal
        .filter((l) => l.subtype === 'inventory_adjustment')
        .map((l) => [l.debit_paise, l.credit_paise]),
    ).toEqual([[0, 1]])

    const back = await post('/stock-transfers', {
      from_store_id: branch.id,
      to_store_id: shop.store.id,
      lines: [{ product_id: dal.id, qty_milli: 3_000 }],
    })
    await post(`/stock-transfers/${back.id}/dispatch`)
    await post(`/stock-transfers/${back.id}/cancel`, { reason: 'Truck unavailable' })

    // Conservation: only the recorded shortfall left the business.
    expect(await total(dal.id)).toBe(before.dal)
    expect(await total(milk.id, m2)).toBe(before.milk)
    expect(await total(soap.id)).toBe(before.soap - 500)

    await assertLevelsMatchMovements(t, shop.tenant.id)
    await assertJournalsBalanced(t, shop.tenant.id)
    await assertInventoryAccountMatchesStock(t, shop.tenant.id)
  })
})
