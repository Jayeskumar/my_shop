/**
 * Stock transfers: drafts, dispatch (numbering, transfer_out at cost), receive (transfer_in at the
 * dispatch cost, shortfall written off at the source with its journal), cancel, store access,
 * feature gating, tenant isolation and conservation of stock.
 */
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  assertInventoryAccountMatchesStock,
  assertJournalsBalanced,
  assertLevelsMatchMovements,
  auditActions,
  dataOf,
  errorOf,
  journalOf,
  levelOf,
  makeProduct,
  makeStore,
  openStock,
  req,
} from './fixtures'

interface TransferView {
  id: string
  number: string | null
  status: string
  from_store_id: string
  to_store_id: string
  total_value_paise: number
  shortfall_value_paise: number
  updated_at: string
  line_count: number
  lines: Array<{
    id: string
    product_id: string
    batch_id: string | null
    qty_milli: number
    received_qty_milli: number | null
    shortfall_qty_milli: number
    unit_cost_paise: number
    value_paise: number
    available_qty_milli: number | null
  }>
  timeline: Array<{ event: string; note: string | null }>
}

describe('inventory: stock transfers', () => {
  let t: TestApp
  let shop: TestShop
  let branch: { id: string; code: string }
  let third: { id: string; code: string }
  const today = todayIn('Asia/Kolkata')

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    branch = await makeStore(t, shop.tenant.id, 'S2')
    third = await makeStore(t, shop.tenant.id, 'S3')
  })
  afterAll(() => t.close())

  const create = async (lines: unknown[], extra: Record<string, unknown> = {}) =>
    dataOf<TransferView>(
      await req(shop, 'POST', '/stock-transfers', {
        from_store_id: shop.store.id,
        to_store_id: branch.id,
        lines,
        ...extra,
      }),
      201,
    )

  it('creates, edits and lists a draft with live source costs', async () => {
    const p = await makeProduct(t, shop.tenant.id, { name: 'Toor Dal' })
    await openStock(shop, shop.store.id, [
      { product_id: p.id, qty_milli: 20_000, unit_cost_paise: 12_000 },
    ])
    const draft = await create([{ product_id: p.id, qty_milli: 5_000 }], { notes: 'Weekly refill' })
    expect(draft).toMatchObject({
      status: 'draft',
      number: null,
      total_value_paise: 60_000,
      line_count: 1,
    })
    expect(draft.lines[0]).toMatchObject({ unit_cost_paise: 12_000, available_qty_milli: 20_000 })
    expect(draft.timeline.map((e) => e.event)).toEqual(['created'])

    const edited = dataOf<TransferView>(
      await req(shop, 'PATCH', `/stock-transfers/${draft.id}`, {
        to_store_id: third.id,
        lines: [{ product_id: p.id, qty_milli: 6_000 }],
        if_updated_at: draft.updated_at,
      }),
    )
    expect(edited).toMatchObject({ to_store_id: third.id, total_value_paise: 72_000 })
    const same = await req(shop, 'PATCH', `/stock-transfers/${draft.id}`, {
      to_store_id: shop.store.id,
    })
    expect(same.statusCode).toBe(400)
    expect(errorOf(same).details?.issues?.[0]?.message).toBe('transfer_same_store')

    const list = await req(
      shop,
      'GET',
      `/stock-transfers?store_id=${third.id}&direction=in&status=draft`,
    )
    const rows = list.json<{ data: TransferView[] }>().data
    expect(rows.map((r) => r.id)).toEqual([edited.id])
    expect(rows[0]?.total_value_paise).toBe(72_000)
    const out = await req(shop, 'GET', `/stock-transfers?store_id=${third.id}&direction=out`)
    expect(out.json<{ data: TransferView[] }>().data).toHaveLength(0)
  })

  it('dispatches at the current cost and receives in full with Dr inventory(to) / Cr inventory(from)', async () => {
    const p = await makeProduct(t, shop.tenant.id, { pack_size: 1 })
    await openStock(shop, shop.store.id, [
      { product_id: p.id, qty_milli: 10_000, unit_cost_paise: 2_500 },
    ])
    const draft = await create([{ product_id: p.id, qty_milli: 4_000 }])
    const dispatched = dataOf<TransferView>(
      await req(shop, 'POST', `/stock-transfers/${draft.id}/dispatch`),
    )
    expect(dispatched.status).toBe('dispatched')
    expect(dispatched.number).toMatch(/^TRS1\/\d{4}\/\d{3,}$/)
    expect(dispatched.lines[0]).toMatchObject({
      unit_cost_paise: 2_500,
      value_paise: 10_000,
      available_qty_milli: null,
    })
    expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(6_000)
    expect(await levelOf(t, shop.tenant.id, branch.id, p.id)).toBe(0)
    // In transit: no journal yet.
    expect(await journalOf(t, shop.tenant.id, 'stock_transfer', draft.id)).toEqual([])

    const again = await req(shop, 'POST', `/stock-transfers/${draft.id}/dispatch`)
    expect(again.statusCode).toBe(409)
    expect(errorOf(again).details?.reason).toBe('not_draft')

    const received = dataOf<TransferView>(
      await req(shop, 'POST', `/stock-transfers/${draft.id}/receive`, {}),
    )
    expect(received.status).toBe('received')
    expect(received.lines[0]).toMatchObject({ received_qty_milli: 4_000, shortfall_qty_milli: 0 })
    expect(received.timeline.map((e) => e.event)).toEqual(['created', 'dispatched', 'received'])
    expect(await levelOf(t, shop.tenant.id, branch.id, p.id)).toBe(4_000)
    const journal = await journalOf(t, shop.tenant.id, 'stock_transfer', draft.id)
    expect(journal.map((l) => [l.subtype, l.store_id, l.debit_paise, l.credit_paise])).toEqual([
      ['inventory', branch.id, 10_000, 0],
      ['inventory', shop.store.id, 0, 10_000],
    ])
    // The destination's average cost is the dispatch cost.
    const level = await t.deps.db.systemDb
      .selectFrom('stock_levels')
      .select('avg_cost_paise')
      .where('tenant_id', '=', shop.tenant.id)
      .where('store_id', '=', branch.id)
      .where('product_id', '=', p.id)
      .executeTakeFirstOrThrow()
    expect(Number(level.avg_cost_paise)).toBe(2_500)

    const receiveTwice = await req(shop, 'POST', `/stock-transfers/${draft.id}/receive`, {})
    expect(errorOf(receiveTwice).details?.reason).toBe('not_dispatched')
    const cancelReceived = await req(shop, 'POST', `/stock-transfers/${draft.id}/cancel`, {
      reason: 'late',
    })
    expect(cancelReceived.statusCode).toBe(409)
    expect(errorOf(cancelReceived).details?.reason).toBe('already_received')
    expect(await auditActions(t, shop.tenant.id, draft.id)).toEqual([
      'stock_transfer.dispatch',
      'stock_transfer.receive',
    ])
  })

  it('writes a receipt shortfall off at the source and conserves stock', async () => {
    const a = await makeProduct(t, shop.tenant.id)
    const b = await makeProduct(t, shop.tenant.id, { track_batches: true })
    const opened = await openStock(shop, shop.store.id, [
      { product_id: a.id, qty_milli: 10_000, unit_cost_paise: 1_000 },
      {
        product_id: b.id,
        qty_milli: 8_000,
        unit_cost_paise: 300,
        batch: { batch_no: 'T1', expiry_date: addDays(today, 90) },
      },
    ])
    const batchId = opened.batches_created[0]!.batch_id
    const totalBefore = async () =>
      (await levelOf(t, shop.tenant.id, shop.store.id, a.id)) +
      (await levelOf(t, shop.tenant.id, branch.id, a.id))
    expect(await totalBefore()).toBe(10_000)

    const draft = await create([
      { product_id: a.id, qty_milli: 6_000 },
      { product_id: b.id, batch_id: batchId, qty_milli: 5_000 },
    ])
    await req(shop, 'POST', `/stock-transfers/${draft.id}/dispatch`)
    const lineA = draft.lines.find((l) => l.product_id === a.id)!
    const lineB = draft.lines.find((l) => l.product_id === b.id)!

    const invalid = await req(shop, 'POST', `/stock-transfers/${draft.id}/receive`, {
      lines: [
        { line_id: lineA.id, received_qty_milli: 7_000 },
        { line_id: newId(), received_qty_milli: 1 },
      ],
    })
    expect(invalid.statusCode).toBe(400)
    expect((errorOf(invalid).details?.issues ?? []).map((i) => i.message)).toEqual([
      'received_exceeds_dispatched',
      'unknown_line',
    ])
    const early = await req(shop, 'POST', `/stock-transfers/${draft.id}/receive`, {
      received_date: addDays(today, 1),
    })
    expect(errorOf(early).details?.issues?.[0]?.message).toBe('future_date')

    const received = dataOf<TransferView>(
      await req(shop, 'POST', `/stock-transfers/${draft.id}/receive`, {
        lines: [{ line_id: lineA.id, received_qty_milli: 5_500 }],
        shortfall_reason: 'Bag torn on the way',
      }),
    )
    expect(received.lines.find((l) => l.id === lineA.id)).toMatchObject({
      received_qty_milli: 5_500,
      shortfall_qty_milli: 500,
    })
    // Line b was not listed: received in full.
    expect(received.lines.find((l) => l.id === lineB.id)).toMatchObject({
      received_qty_milli: 5_000,
    })
    expect(received.shortfall_value_paise).toBe(500)
    expect(received.timeline.at(-1)).toMatchObject({
      event: 'received',
      note: 'Bag torn on the way',
    })

    expect(await levelOf(t, shop.tenant.id, shop.store.id, a.id)).toBe(4_000)
    expect(await levelOf(t, shop.tenant.id, branch.id, a.id)).toBe(5_500)
    expect(await totalBefore()).toBe(10_000 - 500)
    expect(await levelOf(t, shop.tenant.id, branch.id, b.id, batchId)).toBe(5_000)

    const movements = await t.deps.db.systemDb
      .selectFrom('stock_movements')
      .select(['store_id', 'movement_type', 'qty_milli'])
      .where('tenant_id', '=', shop.tenant.id)
      .where('ref_type', '=', 'stock_transfer')
      .where('ref_id', '=', draft.id)
      .where('product_id', '=', a.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    expect(movements.map((m) => [m.store_id, m.movement_type, Number(m.qty_milli)])).toEqual([
      [shop.store.id, 'transfer_out', -6_000],
      [branch.id, 'transfer_in', 5_500],
      [shop.store.id, 'transfer_in', 500],
      [shop.store.id, 'damage', -500],
    ])
    // The only net change across stores is the recorded shortfall.
    const net = await sql<{ type: string; qty: string }>`
      select movement_type as type, sum(qty_milli) as qty from stock_movements
       where tenant_id = ${shop.tenant.id} and ref_type = 'stock_transfer' and ref_id = ${draft.id}
       group by 1`.execute(t.deps.db.systemDb)
    const total = net.rows.reduce((acc, r) => acc + Number(r.qty), 0)
    const damage = net.rows
      .filter((r) => r.type === 'damage')
      .reduce((acc, r) => acc + Number(r.qty), 0)
    expect(total).toBe(damage)
    expect(damage).toBe(-500)

    const journal = await journalOf(t, shop.tenant.id, 'stock_transfer', draft.id)
    const sum = (subtype: string, store: string) =>
      journal
        .filter((l) => l.subtype === subtype && l.store_id === store)
        .reduce((acc, l) => acc + l.debit_paise - l.credit_paise, 0)
    expect(sum('inventory', branch.id)).toBe(5_500 + 1_500)
    expect(sum('inventory', shop.store.id)).toBe(-(5_500 + 1_500) - 500)
    expect(sum('inventory_writeoff', shop.store.id)).toBe(500)
  })

  it('cancels a draft and a dispatched transfer (stock returns at the dispatch cost)', async () => {
    const p = await makeProduct(t, shop.tenant.id)
    await openStock(shop, shop.store.id, [
      { product_id: p.id, qty_milli: 10_000, unit_cost_paise: 700 },
    ])
    const draft = await create([{ product_id: p.id, qty_milli: 1_000 }])
    const cancelledDraft = dataOf<TransferView>(
      await req(shop, 'POST', `/stock-transfers/${draft.id}/cancel`, { reason: 'Not needed' }),
    )
    expect(cancelledDraft).toMatchObject({ status: 'cancelled', number: null })
    const twice = await req(shop, 'POST', `/stock-transfers/${draft.id}/cancel`, {
      reason: 'again',
    })
    expect(errorOf(twice).details?.reason).toBe('already_cancelled')
    const dispatchCancelled = await req(shop, 'POST', `/stock-transfers/${draft.id}/dispatch`)
    expect(errorOf(dispatchCancelled).details?.reason).toBe('already_cancelled')

    const sent = await create([{ product_id: p.id, qty_milli: 3_000 }])
    await req(shop, 'POST', `/stock-transfers/${sent.id}/dispatch`)
    expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(7_000)
    const cancelled = dataOf<TransferView>(
      await req(shop, 'POST', `/stock-transfers/${sent.id}/cancel`, { reason: 'Van broke down' }),
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.timeline.map((e) => e.event)).toEqual(['created', 'dispatched', 'cancelled'])
    expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(10_000)
    expect(await journalOf(t, shop.tenant.id, 'stock_transfer', sent.id)).toEqual([])
    const receiveCancelled = await req(shop, 'POST', `/stock-transfers/${sent.id}/receive`, {})
    expect(errorOf(receiveCancelled).details?.reason).toBe('already_cancelled')
    expect(await auditActions(t, shop.tenant.id, sent.id)).toEqual([
      'stock_transfer.dispatch',
      'stock_transfer.cancel',
    ])
  })

  it('validates drafts: stores, lines, batches and dates', async () => {
    const p = await makeProduct(t, shop.tenant.id)
    const batched = await makeProduct(t, shop.tenant.id, { track_batches: true })
    const closed = await makeStore(t, shop.tenant.id, 'X9', { is_active: false })
    const post = (payload: Record<string, unknown>) =>
      req(shop, 'POST', '/stock-transfers', {
        from_store_id: shop.store.id,
        to_store_id: branch.id,
        lines: [{ product_id: p.id, qty_milli: 1_000 }],
        ...payload,
      })
    let res = await post({ to_store_id: shop.store.id })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).details?.issues?.[0]?.message).toBe('transfer_same_store')
    res = await post({ lines: [] })
    expect(res.statusCode).toBe(400)
    res = await post({ lines: [{ product_id: p.id, qty_milli: 0 }] })
    expect(res.statusCode).toBe(400)
    res = await post({
      lines: [
        { product_id: p.id, qty_milli: 1_000 },
        { product_id: p.id, qty_milli: 2_000 },
      ],
    })
    expect(errorOf(res).details?.issues?.[0]?.message).toBe('duplicate_line')
    res = await post({ lines: [{ product_id: batched.id, qty_milli: 1_000 }] })
    expect(errorOf(res).details?.reason).toBe('batch_required')
    res = await post({ to_store_id: closed.id })
    expect(errorOf(res).details?.reason).toBe('store_inactive')
    res = await post({ transfer_date: addDays(today, 3) })
    expect(errorOf(res).details?.issues?.[0]?.message).toBe('future_date')
    res = await post({ to_store_id: newId() })
    expect(res.statusCode).toBe(404)
  })

  it('checks store access: dispatch needs the source, receive the destination', async () => {
    const p = await makeProduct(t, shop.tenant.id)
    await openStock(shop, shop.store.id, [
      { product_id: p.id, qty_milli: 5_000, unit_cost_paise: 100 },
    ])
    const sourceClerk = await shop.asRole('inventory_clerk', { store_ids: [shop.store.id] })
    const destClerk = await shop.asRole('inventory_clerk', { store_ids: [branch.id] })
    const outsider = await shop.asRole('inventory_clerk', { store_ids: [third.id] })

    // The destination cannot create a transfer out of a store it cannot access.
    const denied = await req(
      shop,
      'POST',
      '/stock-transfers',
      {
        from_store_id: shop.store.id,
        to_store_id: branch.id,
        lines: [{ product_id: p.id, qty_milli: 1_000 }],
      },
      { as: destClerk },
    )
    expect(denied.statusCode).toBe(403)

    const draft = dataOf<TransferView>(
      await req(
        shop,
        'POST',
        '/stock-transfers',
        {
          from_store_id: shop.store.id,
          to_store_id: branch.id,
          lines: [{ product_id: p.id, qty_milli: 1_000 }],
        },
        { as: sourceClerk },
      ),
      201,
    )
    expect(
      (
        await req(shop, 'POST', `/stock-transfers/${draft.id}/dispatch`, undefined, {
          as: destClerk,
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await req(shop, 'GET', `/stock-transfers/${draft.id}`, undefined, { as: outsider }))
        .statusCode,
    ).toBe(403)
    const outsiderList = await req(shop, 'GET', '/stock-transfers?limit=200', undefined, {
      as: outsider,
    })
    expect(outsiderList.json<{ data: TransferView[] }>().data.map((r) => r.id)).not.toContain(
      draft.id,
    )

    await req(shop, 'POST', `/stock-transfers/${draft.id}/dispatch`, undefined, { as: sourceClerk })
    // The destination can see the incoming transfer…
    const incoming = await req(
      shop,
      'GET',
      `/stock-transfers?direction=in&store_id=${branch.id}`,
      undefined,
      { as: destClerk },
    )
    expect(incoming.json<{ data: TransferView[] }>().data.map((r) => r.id)).toContain(draft.id)
    // …and only it can receive.
    const srcReceive = await req(
      shop,
      'POST',
      `/stock-transfers/${draft.id}/receive`,
      {},
      { as: sourceClerk },
    )
    expect(srcReceive.statusCode).toBe(403)
    const ok = await req(
      shop,
      'POST',
      `/stock-transfers/${draft.id}/receive`,
      {},
      { as: destClerk },
    )
    expect(ok.statusCode).toBe(200)
  })

  it('denies roles without inventory.transfer', async () => {
    const cashier = await shop.asRole('cashier')
    const p = await makeProduct(t, shop.tenant.id)
    const res = await req(
      shop,
      'POST',
      '/stock-transfers',
      {
        from_store_id: shop.store.id,
        to_store_id: branch.id,
        lines: [{ product_id: p.id, qty_milli: 1_000 }],
      },
      { as: cashier },
    )
    expect(res.statusCode).toBe(403)
    // Reading needs only inventory.read.
    expect(
      (await req(shop, 'GET', '/stock-transfers', undefined, { as: cashier })).statusCode,
    ).toBe(200)
  })

  it('is gated by the stock_transfers plan feature', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const res = await req(free, 'GET', '/stock-transfers')
    expect(res.statusCode).toBe(402)
    expect(errorOf(res)).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      details: { feature: 'stock_transfers' },
    })
    const growth = await createTestTenant(t, { plan_code: 'growth' })
    const create2 = await req(growth, 'POST', '/stock-transfers', {
      from_store_id: growth.store.id,
      to_store_id: newId(),
      lines: [{ product_id: newId(), qty_milli: 1_000 }],
    })
    expect(create2.statusCode).toBe(402)
  })

  it('keeps transfers of other tenants invisible', async () => {
    const other = await createTestTenant(t)
    const p = await makeProduct(t, shop.tenant.id)
    const draft = await create([{ product_id: p.id, qty_milli: 1_000 }])
    expect((await req(other, 'GET', `/stock-transfers/${draft.id}`)).statusCode).toBe(404)
    expect((await req(other, 'POST', `/stock-transfers/${draft.id}/dispatch`)).statusCode).toBe(404)
    const list = await req(other, 'GET', '/stock-transfers')
    expect(list.json<{ data: unknown[]; page: { total: number } }>().page.total).toBe(0)
  })

  it('keeps the ledger invariants for every transfer outcome', async () => {
    await assertLevelsMatchMovements(t, shop.tenant.id)
    await assertJournalsBalanced(t, shop.tenant.id)
    // Every transfer above is received or cancelled (none in transit), and only opening stock,
    // transfers and shortfalls moved stock: each store's inventory account equals its stock value.
    const inTransit = await t.deps.db.systemDb
      .selectFrom('stock_transfers')
      .select('id')
      .where('tenant_id', '=', shop.tenant.id)
      .where('status', '=', 'dispatched')
      .execute()
    for (const tr of inTransit) {
      await req(shop, 'POST', `/stock-transfers/${tr.id}/receive`, {})
    }
    await assertInventoryAccountMatchesStock(t, shop.tenant.id)
  })
})
