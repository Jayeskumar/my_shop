/**
 * Opening stock and stock adjustments (adjustment, stock take, damage, expiry write-off):
 * drafts, posting (numbering, movements, journal), cancellation, validation, permissions,
 * store scope, tenant isolation and the ledger invariants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId, todayIn, addDays } from '@kadai/shared'
import { postStock } from '../../../core/inventory'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  assertJournalsBalanced,
  assertLevelsMatchMovements,
  auditActions,
  dataOf,
  errorOf,
  journalOf,
  levelOf,
  makeBatch,
  makeProduct,
  makeStore,
  netBySubtype,
  openStock,
  req,
} from './fixtures'

interface AdjustmentView {
  id: string
  number: string | null
  status: string
  kind: string
  total_value_paise: number
  gain_value_paise: number
  loss_value_paise: number
  journal_entry_id: string | null
  updated_at: string
  cancel_reason: string | null
  lines: Array<{
    id: string
    product_id: string
    batch_id: string | null
    qty_delta_milli: number
    system_qty_milli: number | null
    counted_qty_milli: number | null
    unit_cost_paise: number
    value_paise: number
    current_qty_milli: number | null
  }>
  movements: Array<{ movement_type: string; qty_milli: number; unit_cost_paise: number | null }>
}

describe('inventory: opening stock and adjustments', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  const today = todayIn('Asia/Kolkata')

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  // -------------------------------------------------------------------------------------------
  // Opening stock
  // -------------------------------------------------------------------------------------------

  describe('POST /stock/opening', () => {
    it('posts opening movements, creates batches and journals Dr inventory / Cr opening balance', async () => {
      const rice = await makeProduct(t, shop.tenant.id, { name: 'Ponni Rice' })
      const syrup = await makeProduct(t, shop.tenant.id, {
        name: 'Cough Syrup',
        track_batches: true,
        pack_size: 1,
      })
      const res = await openStock(shop, shop.store.id, [
        { product_id: rice.id, qty_milli: 10_000, unit_cost_paise: 5_000 },
        {
          product_id: syrup.id,
          qty_milli: 4_000,
          unit_cost_paise: 7_550,
          batch: { batch_no: 'cs-01', expiry_date: addDays(today, 200), mrp_paise: 9_900 },
        },
      ])
      expect(res.total_value_paise).toBe(50_000 + 30_200)
      expect(res.adjustment.number).toMatch(/^ADJS1\/\d{4}\/\d{3,}$/)
      expect(res.batches_created).toEqual([
        { product_id: syrup.id, batch_id: expect.any(String), batch_no: 'cs-01' },
      ])
      const adj = res.adjustment as unknown as AdjustmentView
      expect(adj).toMatchObject({ kind: 'opening', status: 'posted' })
      expect(adj.movements.map((m) => m.movement_type)).toEqual(['opening', 'opening'])
      expect(await levelOf(t, shop.tenant.id, shop.store.id, rice.id)).toBe(10_000)
      expect(
        await levelOf(t, shop.tenant.id, shop.store.id, syrup.id, res.batches_created[0]!.batch_id),
      ).toBe(4_000)

      const journal = await journalOf(t, shop.tenant.id, 'stock_adjustment', adj.id)
      expect(netBySubtype(journal)).toEqual({ inventory: 80_200, opening_balance: -80_200 })
      expect(res.journal_entry_id).toBe(journal[0]!.entry_id)
      expect(await auditActions(t, shop.tenant.id, adj.id)).toEqual(['stock.opening'])

      // The same batch number is reused (case-insensitive), not duplicated.
      const again = await openStock(
        shop,
        shop.store.id,
        [
          {
            product_id: syrup.id,
            qty_milli: 1_000,
            unit_cost_paise: 7_550,
            batch: { batch_no: 'CS-01' },
          },
        ],
        { force: true },
      )
      expect(again.batches_created).toEqual([])
    })

    it('refuses products that already moved unless force, and audits the forced opening', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      await openStock(shop, shop.store.id, [
        { product_id: p.id, qty_milli: 1_000, unit_cost_paise: 100 },
      ])
      const refused = await req(shop, 'POST', '/stock/opening', {
        store_id: shop.store.id,
        lines: [{ product_id: p.id, qty_milli: 2_000, unit_cost_paise: 100 }],
      })
      expect(refused.statusCode).toBe(409)
      expect(errorOf(refused).details).toMatchObject({
        reason: 'has_movements',
        product_ids: [p.id],
      })

      const forced = await openStock(
        shop,
        shop.store.id,
        [{ product_id: p.id, qty_milli: 2_000, unit_cost_paise: 100 }],
        { force: true },
      )
      expect(await auditActions(t, shop.tenant.id, forced.adjustment.id)).toEqual([
        'stock.opening_forced',
      ])
      expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(3_000)
    })

    it('validates lines: batches, stock items, duplicates, dates and stores', async () => {
      const plain = await makeProduct(t, shop.tenant.id)
      const batched = await makeProduct(t, shop.tenant.id, { track_batches: true })
      const service = await makeProduct(t, shop.tenant.id, { kind: 'service' })
      const foreignBatch = await makeBatch(t, shop.tenant.id, plain.id)
      const post = (payload: Record<string, unknown>) =>
        req(shop, 'POST', '/stock/opening', payload)
      const line = (extra: Record<string, unknown>) => ({
        qty_milli: 1_000,
        unit_cost_paise: 100,
        ...extra,
      })

      let res = await post({ store_id: shop.store.id, lines: [line({ product_id: batched.id })] })
      expect(res.statusCode).toBe(422)
      expect(errorOf(res).details?.reason).toBe('batch_required')

      res = await post({
        store_id: shop.store.id,
        lines: [line({ product_id: plain.id, batch: { batch_no: 'X1' } })],
      })
      expect(errorOf(res).details?.reason).toBe('batch_not_allowed')

      res = await post({
        store_id: shop.store.id,
        lines: [line({ product_id: batched.id, batch_id: foreignBatch.id })],
      })
      expect(errorOf(res).details?.reason).toBe('batch_product_mismatch')

      res = await post({ store_id: shop.store.id, lines: [line({ product_id: service.id })] })
      expect(errorOf(res).details?.reason).toBe('not_stock_item')

      res = await post({
        store_id: shop.store.id,
        lines: [line({ product_id: plain.id }), line({ product_id: plain.id })],
      })
      expect(res.statusCode).toBe(400)
      expect(errorOf(res).details?.issues?.[0]).toMatchObject({ message: 'duplicate_line' })

      res = await post({
        store_id: shop.store.id,
        date: addDays(today, 2),
        lines: [line({ product_id: plain.id })],
      })
      expect(res.statusCode).toBe(400)
      expect(errorOf(res).details?.issues?.[0]).toMatchObject({
        path: 'date',
        message: 'future_date',
      })

      res = await post({ store_id: shop.store.id, lines: [] })
      expect(res.statusCode).toBe(400)

      res = await post({ store_id: newId(), lines: [line({ product_id: plain.id })] })
      expect(res.statusCode).toBe(404)

      const closed = await makeStore(t, shop.tenant.id, 'Z9', { is_active: false })
      res = await post({ store_id: closed.id, lines: [line({ product_id: plain.id })] })
      expect(res.statusCode).toBe(422)
      expect(errorOf(res).details?.reason).toBe('store_inactive')
    })

    it('lets only one of two concurrent openings of the same product through', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      const payload = {
        store_id: shop.store.id,
        lines: [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 100 }],
      }
      const results = await Promise.all([
        req(shop, 'POST', '/stock/opening', payload),
        req(shop, 'POST', '/stock/opening', payload),
      ])
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
      expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(1_000)
    })

    it('replays an idempotent opening instead of posting twice', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      const payload = {
        store_id: shop.store.id,
        lines: [{ product_id: p.id, qty_milli: 5_000, unit_cost_paise: 200 }],
      }
      const key = `open-${newId()}`
      const first = await req(shop, 'POST', '/stock/opening', payload, {
        headers: { 'idempotency-key': key },
      })
      const second = await req(shop, 'POST', '/stock/opening', payload, {
        headers: { 'idempotency-key': key },
      })
      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(201)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.json()).toEqual(first.json())
      expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(5_000)
    })
  })

  // -------------------------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------------------------

  describe('draft adjustments', () => {
    it('creates, reads, updates, lists and deletes a draft with live values', async () => {
      const p = await makeProduct(t, shop.tenant.id, { name: 'Sugar 1 kg' })
      await openStock(shop, shop.store.id, [
        { product_id: p.id, qty_milli: 10_000, unit_cost_paise: 4_000 },
      ])
      const created = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          kind: 'adjustment',
          notes: 'Shelf check',
          lines: [{ product_id: p.id, qty_delta_milli: -2_000, reason: 'damaged' }],
        }),
        201,
      )
      expect(created).toMatchObject({ status: 'draft', number: null, total_value_paise: -8_000 })
      expect(created.lines[0]).toMatchObject({
        qty_delta_milli: -2_000,
        unit_cost_paise: 4_000,
        value_paise: -8_000,
        current_qty_milli: 10_000,
      })

      const got = dataOf<AdjustmentView>(await req(shop, 'GET', `/stock-adjustments/${created.id}`))
      expect(got.id).toBe(created.id)

      const updated = dataOf<AdjustmentView>(
        await req(shop, 'PATCH', `/stock-adjustments/${created.id}`, {
          lines: [{ product_id: p.id, qty_delta_milli: 3_000, unit_cost_paise: 4_500 }],
          if_updated_at: created.updated_at,
        }),
      )
      expect(updated.lines[0]).toMatchObject({
        qty_delta_milli: 3_000,
        unit_cost_paise: 4_500,
        value_paise: 13_500,
      })
      expect(updated.total_value_paise).toBe(13_500)

      const stale = await req(shop, 'PATCH', `/stock-adjustments/${created.id}`, {
        notes: 'again',
        if_updated_at: created.updated_at,
      })
      expect(stale.statusCode).toBe(409)
      expect(errorOf(stale).code).toBe('STALE_WRITE')

      const list = await req(
        shop,
        'GET',
        `/stock-adjustments?status=draft&store_id=${shop.store.id}&q=shelf`,
      )
      const page = list.json<{ data: AdjustmentView[]; page: { total: number } }>()
      expect(page.data.map((a) => a.id)).toContain(created.id)
      expect(page.data.find((a) => a.id === created.id)?.total_value_paise).toBe(13_500)

      const del = await req(shop, 'DELETE', `/stock-adjustments/${created.id}`)
      expect(del.statusCode).toBe(204)
      expect((await req(shop, 'GET', `/stock-adjustments/${created.id}`)).statusCode).toBe(404)
      expect(await auditActions(t, shop.tenant.id, created.id)).toEqual(['stock_adjustment.delete'])
    })

    it('rejects invalid lines per kind', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      const create = (payload: Record<string, unknown>) =>
        req(shop, 'POST', '/stock-adjustments', { store_id: shop.store.id, ...payload })
      const messages = async (payload: Record<string, unknown>) => {
        const res = await create(payload)
        expect(res.statusCode).toBe(400)
        return (errorOf(res).details?.issues ?? []).map((i) => i.message)
      }
      expect(await messages({ lines: [{ product_id: p.id, qty_delta_milli: 0 }] })).toContain(
        'qty_delta_zero',
      )
      expect(await messages({ lines: [{ product_id: p.id }] })).toContain('qty_delta_required')
      expect(
        await messages({ kind: 'damage', lines: [{ product_id: p.id, qty_delta_milli: 1_000 }] }),
      ).toContain('loss_must_be_negative')
      expect(
        await messages({
          kind: 'stock_take',
          lines: [{ product_id: p.id, qty_delta_milli: 1_000 }],
        }),
      ).toContain('counted_qty_required')
      expect(await messages({ kind: 'opening', lines: [] })).toEqual(
        expect.arrayContaining([expect.any(String)]),
      )
      expect(
        await messages({
          lines: [
            { product_id: p.id, qty_delta_milli: 1_000 },
            { product_id: p.id, qty_delta_milli: 2_000 },
          ],
        }),
      ).toContain('duplicate_line')
      expect(await messages({ adjustment_date: addDays(today, 1), lines: [] })).toContain(
        'future_date',
      )

      const draft = dataOf<AdjustmentView>(await create({ lines: [] }), 201)
      const empty = await req(shop, 'PATCH', `/stock-adjustments/${draft.id}`, {})
      expect(empty.statusCode).toBe(400)
      expect(errorOf(empty).details?.issues?.[0]?.message).toBe('empty_patch')
      // Switching to a stock take needs lines with counts.
      await req(shop, 'PATCH', `/stock-adjustments/${draft.id}`, {
        lines: [{ product_id: p.id, qty_delta_milli: 1_000 }],
      })
      const kindSwitch = await req(shop, 'PATCH', `/stock-adjustments/${draft.id}`, {
        kind: 'stock_take',
      })
      expect(kindSwitch.statusCode).toBe(400)
      expect(errorOf(kindSwitch).details?.issues?.[0]?.message).toBe('counted_qty_required')
    })

    it('requires a batch on lines of batch-tracked products', async () => {
      const med = await makeProduct(t, shop.tenant.id, { track_batches: true })
      const b = await makeBatch(t, shop.tenant.id, med.id)
      const res = await req(shop, 'POST', '/stock-adjustments', {
        store_id: shop.store.id,
        lines: [{ product_id: med.id, qty_delta_milli: 1_000 }],
      })
      expect(res.statusCode).toBe(422)
      expect(errorOf(res).details).toMatchObject({
        reason: 'batch_required',
        path: 'lines.0.batch_id',
      })
      const ok = await req(shop, 'POST', '/stock-adjustments', {
        store_id: shop.store.id,
        lines: [
          { product_id: med.id, batch_id: b.id, qty_delta_milli: 1_000, unit_cost_paise: 300 },
        ],
      })
      expect(ok.statusCode).toBe(201)
    })
  })

  // -------------------------------------------------------------------------------------------
  // Posting and cancelling
  // -------------------------------------------------------------------------------------------

  describe('posting', () => {
    it('posts gains at the given cost and losses at the average, with the §10 journal', async () => {
      const gain = await makeProduct(t, shop.tenant.id)
      const loss = await makeProduct(t, shop.tenant.id, { pack_size: 10, unit: 'TAB' })
      await openStock(shop, shop.store.id, [
        { product_id: gain.id, qty_milli: 5_000, unit_cost_paise: 1_000 },
        { product_id: loss.id, qty_milli: 100_000, unit_cost_paise: 3_500 },
      ])
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          lines: [
            {
              product_id: gain.id,
              qty_delta_milli: 2_000,
              unit_cost_paise: 1_300,
              reason: 'found',
            },
            // Loss of 15 tablets at ₹35 per strip of 10 → ₹52.50; a given cost is ignored for losses.
            { product_id: loss.id, qty_delta_milli: -15_000, unit_cost_paise: 1 },
          ],
        }),
        201,
      )
      const posted = dataOf<AdjustmentView>(
        await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`),
      )
      expect(posted.status).toBe('posted')
      expect(posted.number).toMatch(/^ADJS1\//)
      expect(posted).toMatchObject({
        gain_value_paise: 2_600,
        loss_value_paise: 5_250,
        total_value_paise: -2_650,
      })
      expect(posted.lines.map((l) => [l.unit_cost_paise, l.value_paise])).toEqual([
        [1_300, 2_600],
        [3_500, -5_250],
      ])
      expect(posted.movements.map((m) => [m.movement_type, m.qty_milli])).toEqual([
        ['adjustment', 2_000],
        ['adjustment', -15_000],
      ])
      const journal = await journalOf(t, shop.tenant.id, 'stock_adjustment', draft.id)
      expect(netBySubtype(journal)).toEqual({ inventory: -2_650, inventory_adjustment: 2_650 })
      expect(posted.journal_entry_id).toBe(journal[0]!.entry_id)
      expect(await auditActions(t, shop.tenant.id, draft.id)).toEqual(['stock_adjustment.post'])

      // Posted documents are immutable; posting twice is a conflict.
      const again = await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`)
      expect(again.statusCode).toBe(409)
      expect(errorOf(again).details?.reason).toBe('not_draft')
      const edit = await req(shop, 'PATCH', `/stock-adjustments/${draft.id}`, { notes: 'x' })
      expect(errorOf(edit).details?.reason).toBe('not_draft')
      const del = await req(shop, 'DELETE', `/stock-adjustments/${draft.id}`)
      expect(errorOf(del).details?.reason).toBe('not_draft')
    })

    it('writes damage and expiry losses off to inventory_writeoff', async () => {
      const med = await makeProduct(t, shop.tenant.id, { track_batches: true })
      const opened = await openStock(shop, shop.store.id, [
        {
          product_id: med.id,
          qty_milli: 20_000,
          unit_cost_paise: 250,
          batch: { batch_no: 'EXP1', expiry_date: addDays(today, -3) },
        },
      ])
      const batchId = opened.batches_created[0]!.batch_id
      for (const kind of ['damage', 'expiry_writeoff'] as const) {
        const draft = dataOf<AdjustmentView>(
          await req(shop, 'POST', '/stock-adjustments', {
            store_id: shop.store.id,
            kind,
            lines: [{ product_id: med.id, batch_id: batchId, qty_delta_milli: -4_000 }],
          }),
          201,
        )
        const posted = dataOf<AdjustmentView>(
          await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`),
        )
        expect(posted.movements[0]).toMatchObject({ movement_type: kind, qty_milli: -4_000 })
        const journal = await journalOf(t, shop.tenant.id, 'stock_adjustment', draft.id)
        expect(netBySubtype(journal)).toEqual({ inventory: -1_000, inventory_writeoff: 1_000 })
      }
      expect(await levelOf(t, shop.tenant.id, shop.store.id, med.id, batchId)).toBe(12_000)
    })

    it('refuses to post an empty draft', async () => {
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', { store_id: shop.store.id }),
        201,
      )
      const res = await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`)
      expect(res.statusCode).toBe(422)
      expect(errorOf(res).details?.reason).toBe('empty_document')
    })

    it('stock take posts counted − system quantity read at posting time', async () => {
      const a = await makeProduct(t, shop.tenant.id, { unit: 'KG' })
      const b = await makeProduct(t, shop.tenant.id, { unit: 'KG' })
      const c = await makeProduct(t, shop.tenant.id, { unit: 'KG' })
      await openStock(shop, shop.store.id, [
        { product_id: a.id, qty_milli: 10_000, unit_cost_paise: 100 },
        { product_id: b.id, qty_milli: 4_000, unit_cost_paise: 200 },
        { product_id: c.id, qty_milli: 6_000, unit_cost_paise: 300 },
      ])
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          kind: 'stock_take',
          lines: [
            { product_id: a.id, counted_qty_milli: 7_000 },
            { product_id: b.id, counted_qty_milli: 5_500 },
            { product_id: c.id, counted_qty_milli: 6_000 },
          ],
        }),
        201,
      )
      expect(draft.lines.map((l) => l.qty_delta_milli)).toEqual([-3_000, 1_500, 0])
      // A sale between counting and posting: the posted difference uses the stock at posting.
      await shop.tx((tx) =>
        postStock(tx, shop.ctx, [
          {
            store_id: shop.store.id,
            product_id: a.id,
            qty_milli: -2_000,
            movement_type: 'sale',
            ref_type: 'sales_invoice',
            ref_id: newId(),
          },
        ]),
      )
      const posted = dataOf<AdjustmentView>(
        await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`),
      )
      expect(
        posted.lines.map((l) => [l.system_qty_milli, l.counted_qty_milli, l.qty_delta_milli]),
      ).toEqual([
        [8_000, 7_000, -1_000],
        [4_000, 5_500, 1_500],
        [6_000, 6_000, 0],
      ])
      // Lines without a difference post no movement.
      expect(posted.movements.map((m) => [m.movement_type, m.qty_milli])).toEqual([
        ['stock_take', -1_000],
        ['stock_take', 1_500],
      ])
      expect(await levelOf(t, shop.tenant.id, shop.store.id, a.id)).toBe(7_000)
      expect(await levelOf(t, shop.tenant.id, shop.store.id, b.id)).toBe(5_500)
      expect(await levelOf(t, shop.tenant.id, shop.store.id, c.id)).toBe(6_000)
      expect(posted.total_value_paise).toBe(-100 + 300)
    })

    it('stock take stays exact when a sale races the posting', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      await openStock(shop, shop.store.id, [
        { product_id: p.id, qty_milli: 50_000, unit_cost_paise: 100 },
      ])
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          kind: 'stock_take',
          lines: [{ product_id: p.id, counted_qty_milli: 40_000 }],
        }),
        201,
      )
      const [postRes] = await Promise.all([
        req(shop, 'POST', `/stock-adjustments/${draft.id}/post`),
        shop.tx((tx) =>
          postStock(tx, shop.ctx, [
            {
              store_id: shop.store.id,
              product_id: p.id,
              qty_milli: -3_000,
              movement_type: 'sale',
              ref_type: 'sales_invoice',
              ref_id: newId(),
            },
          ]),
        ),
      ])
      const posted = dataOf<AdjustmentView>(postRes)
      const line = posted.lines[0]!
      expect(line.system_qty_milli! + line.qty_delta_milli).toBe(40_000)
      const final = await levelOf(t, shop.tenant.id, shop.store.id, p.id)
      // Either the sale came first (final = count) or after the count (final = count − sale).
      expect([40_000, 37_000]).toContain(final)
      await assertLevelsMatchMovements(t, shop.tenant.id)
    })

    it('cancels a posted adjustment once, reversing stock and journal', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      await openStock(shop, shop.store.id, [
        { product_id: p.id, qty_milli: 10_000, unit_cost_paise: 1_000 },
      ])
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          kind: 'damage',
          lines: [{ product_id: p.id, qty_delta_milli: -3_000 }],
        }),
        201,
      )
      const notPosted = await req(shop, 'POST', `/stock-adjustments/${draft.id}/cancel`, {
        reason: 'x',
      })
      expect(notPosted.statusCode).toBe(409)
      expect(errorOf(notPosted).details?.reason).toBe('not_posted')

      await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`)
      expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(7_000)
      const missingReason = await req(shop, 'POST', `/stock-adjustments/${draft.id}/cancel`, {})
      expect(missingReason.statusCode).toBe(400)

      const cancelled = dataOf<AdjustmentView>(
        await req(shop, 'POST', `/stock-adjustments/${draft.id}/cancel`, {
          reason: 'Counted wrongly',
        }),
      )
      expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'Counted wrongly' })
      expect(
        cancelled.movements.map((m) => [m.movement_type, m.qty_milli, m.unit_cost_paise]),
      ).toEqual([
        ['damage', -3_000, 1_000],
        ['adjustment', 3_000, 1_000],
      ])
      expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(10_000)
      const journal = await journalOf(t, shop.tenant.id, 'stock_adjustment', draft.id)
      expect(netBySubtype(journal)).toEqual({})
      expect(journal.filter((l) => l.reverses_entry_id !== null).length).toBeGreaterThan(0)

      const twice = await req(shop, 'POST', `/stock-adjustments/${draft.id}/cancel`, {
        reason: 'again',
      })
      expect(twice.statusCode).toBe(409)
      expect(errorOf(twice).details?.reason).toBe('already_cancelled')
      expect(await auditActions(t, shop.tenant.id, draft.id)).toEqual([
        'stock_adjustment.post',
        'stock_adjustment.cancel',
      ])
    })

    it('books the cost difference when a cancelled gain leaves at a changed average', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      await openStock(shop, shop.store.id, [
        { product_id: p.id, qty_milli: 10_000, unit_cost_paise: 1_000 },
      ])
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          lines: [{ product_id: p.id, qty_delta_milli: 10_000, unit_cost_paise: 2_000 }],
        }),
        201,
      )
      await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`)
      // Average is now ₹15; the gain (at ₹20) leaves at ₹15 on cancel.
      const cancelled = dataOf<AdjustmentView>(
        await req(shop, 'POST', `/stock-adjustments/${draft.id}/cancel`, {
          reason: 'Duplicate entry',
        }),
      )
      expect(cancelled.movements.at(-1)).toMatchObject({
        qty_milli: -10_000,
        unit_cost_paise: 1_500,
      })
      const journal = await journalOf(t, shop.tenant.id, 'stock_adjustment', draft.id)
      // Net effect = what the stock ledger says: +20 000 − 15 000 = +5 000 in inventory.
      expect(netBySubtype(journal)).toEqual({ inventory: 5_000, inventory_adjustment: -5_000 })
    })

    it('replays an idempotent post with the same key', async () => {
      const p = await makeProduct(t, shop.tenant.id, { unit: 'KG' })
      await openStock(shop, shop.store.id, [
        { product_id: p.id, qty_milli: 1_000, unit_cost_paise: 100 },
      ])
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          lines: [{ product_id: p.id, qty_delta_milli: -500 }],
        }),
        201,
      )
      const key = `post-${newId()}`
      const first = await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`, undefined, {
        headers: { 'idempotency-key': key },
      })
      const second = await req(shop, 'POST', `/stock-adjustments/${draft.id}/post`, undefined, {
        headers: { 'idempotency-key': key },
      })
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(500)
    })
  })

  // -------------------------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------------------------

  describe('access', () => {
    it('denies roles without inventory.adjust', async () => {
      const cashier = await shop.asRole('cashier')
      const p = await makeProduct(t, shop.tenant.id)
      const list = await req(shop, 'GET', '/stock-adjustments', undefined, { as: cashier })
      expect(list.statusCode).toBe(403)
      expect(errorOf(list).details).toMatchObject({ required: ['inventory.adjust'] })
      const create = await req(
        shop,
        'POST',
        '/stock-adjustments',
        { store_id: shop.store.id, lines: [{ product_id: p.id, qty_delta_milli: 1_000 }] },
        { as: cashier },
      )
      expect(create.statusCode).toBe(403)
      const opening = await req(
        shop,
        'POST',
        '/stock/opening',
        {
          store_id: shop.store.id,
          lines: [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 1 }],
        },
        { as: cashier },
      )
      expect(opening.statusCode).toBe(403)
      expect(
        (await req(shop, 'GET', '/stock-adjustments', undefined, { as: null })).statusCode,
      ).toBe(401)
    })

    it('limits store-scoped members to their stores', async () => {
      const branch = await makeStore(t, shop.tenant.id, 'B2')
      const clerk = await shop.asRole('inventory_clerk', { store_ids: [branch.id] })
      const p = await makeProduct(t, shop.tenant.id)
      const denied = await req(
        shop,
        'POST',
        '/stock-adjustments',
        { store_id: shop.store.id, lines: [{ product_id: p.id, qty_delta_milli: 1_000 }] },
        { as: clerk },
      )
      expect(denied.statusCode).toBe(403)
      const mine = dataOf<AdjustmentView>(
        await req(
          shop,
          'POST',
          '/stock-adjustments',
          {
            store_id: branch.id,
            lines: [{ product_id: p.id, qty_delta_milli: 1_000, unit_cost_paise: 10 }],
          },
          { as: clerk },
        ),
        201,
      )
      const ownerDraft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', { store_id: shop.store.id }),
        201,
      )
      expect(
        (await req(shop, 'GET', `/stock-adjustments/${ownerDraft.id}`, undefined, { as: clerk }))
          .statusCode,
      ).toBe(403)
      const list = await req(shop, 'GET', '/stock-adjustments?limit=200', undefined, { as: clerk })
      const ids = list.json<{ data: AdjustmentView[] }>().data.map((a) => a.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(ownerDraft.id)
    })

    it('never shows or touches another tenant’s documents and products', async () => {
      const p = await makeProduct(t, shop.tenant.id)
      const draft = dataOf<AdjustmentView>(
        await req(shop, 'POST', '/stock-adjustments', {
          store_id: shop.store.id,
          lines: [{ product_id: p.id, qty_delta_milli: 1_000, unit_cost_paise: 10 }],
        }),
        201,
      )
      expect((await req(other, 'GET', `/stock-adjustments/${draft.id}`)).statusCode).toBe(404)
      expect((await req(other, 'POST', `/stock-adjustments/${draft.id}/post`)).statusCode).toBe(404)
      const list = await req(other, 'GET', '/stock-adjustments?limit=200')
      expect(list.json<{ data: AdjustmentView[] }>().data.map((a) => a.id)).not.toContain(draft.id)
      // Tenant A's product does not exist for tenant B.
      const foreign = await req(other, 'POST', '/stock/opening', {
        store_id: other.store.id,
        lines: [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 1 }],
      })
      expect(foreign.statusCode).toBe(404)
      const foreignStore = await req(other, 'POST', '/stock-adjustments', {
        store_id: shop.store.id,
      })
      expect([403, 404]).toContain(foreignStore.statusCode)
    })
  })

  it('keeps Σ movements = stock levels and every journal balanced', async () => {
    // (Sales posted straight through core above have no journal here, so the inventory account
    // invariant is checked on a clean tenant in invariants.test.ts.)
    await assertLevelsMatchMovements(t, shop.tenant.id)
    await assertJournalsBalanced(t, shop.tenant.id)
  })
})
