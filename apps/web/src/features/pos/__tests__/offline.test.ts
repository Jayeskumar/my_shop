/**
 * Offline catalogue (bootstrap full / delta, code lookup, search), local invoice numbering with
 * the outbox, and the POST /pos/sync per-item results — against fake-indexeddb and MSW.
 */
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PosSyncResult } from '@kadai/shared/api/sales'
import { makeScaleBarcode } from '@kadai/shared/scale'
import { offlineDb, outbox } from '@/lib/offline/db'
import { apiPath, errorResponse, server } from '@/test/msw'
import { IDS } from '@/test/fixtures'
import {
  applyBootstrap,
  getBatches,
  getProduct,
  getVariants,
  lookupCode,
  pickFefoBatch,
  searchProducts,
} from '../lib/catalog'
import {
  advanceSeriesPast,
  mergeSeries,
  nextOfflineNumber,
  queueOfflineDocument,
  readSeries,
  reconcileSeries,
} from '../lib/series'
import { nextBatch, syncOutbox } from '../lib/sync'
import { PIDS, TODAY, dal, makeBootstrap, rice } from './fixtures'

const T = IDS.tenant
const KEY = IDS.register

beforeEach(async () => {
  await Promise.all(offlineDb.tables.map((t) => t.clear()))
})

describe('offline catalogue', () => {
  it('full bootstrap fills the cache; lookups follow barcode → SKU → scale barcode', async () => {
    const b = makeBootstrap()
    const context = await applyBootstrap(T, KEY, b)
    expect(context.store.id).toBe(IDS.store)
    expect('products' in context).toBe(false)

    expect(await lookupCode(T, '8901234500011', b)).toMatchObject({
      match: 'barcode',
      qty_milli: null,
      product: { id: PIDS.rice },
    })
    // Case barcode: 10 packs.
    expect(await lookupCode(T, '8901234500099', b)).toMatchObject({
      match: 'barcode',
      qty_milli: 10_000,
      product: { id: PIDS.dal },
    })
    expect(await lookupCode(T, 'TOOR1', b)).toMatchObject({
      match: 'sku',
      product: { id: PIDS.dal },
    })
    const label = makeScaleBarcode('21', '00102', 1250, { item_code_length: 5, value_length: 5 })
    expect(await lookupCode(T, label, b)).toMatchObject({
      match: 'scale',
      qty_milli: 1250,
      product: { id: PIDS.sugar },
    })
    expect(await lookupCode(T, '0000000000000', b)).toBeNull()
  })

  it('search matches English and Tamil word prefixes and hides variants (their parent opens the matrix)', async () => {
    await applyBootstrap(T, KEY, makeBootstrap())
    expect((await searchProducts(T, 'toor')).map((p) => p.id)).toEqual([PIDS.dal])
    expect((await searchProducts(T, 'பருப்பு')).map((p) => p.id)).toEqual([PIDS.dal])
    expect((await searchProducts(T, 'cotton')).map((p) => p.id)).toEqual([PIDS.shirt])
    expect((await getVariants(T, PIDS.shirt)).map((p) => p.sku).sort()).toEqual([
      'SHIRT-L',
      'SHIRT-M',
    ])
  })

  it('batches come FEFO; expired batches are skipped by the default pick', async () => {
    await applyBootstrap(T, KEY, makeBootstrap())
    const list = await getBatches(T, PIDS.para)
    expect(list.map((x) => x.batch_no)).toEqual(['B-EXP', 'B-OLD', 'B-NEW'])
    expect(pickFefoBatch(list, TODAY)?.batch_no).toBe('B-OLD')
  })

  it('delta: changed rows, complete barcode lists of the listed products, removals', async () => {
    await applyBootstrap(T, KEY, makeBootstrap())
    await applyBootstrap(
      T,
      KEY,
      makeBootstrap({
        mode: 'delta',
        cursor: 'cursor-2',
        products: [{ ...rice, sale_price_paise: 38_500 }],
        // Rice's barcode list is now just a new code; dal untouched.
        barcodes: [{ barcode: '8901234599999', product_id: PIDS.rice, qty_milli: 1000 }],
        barcode_product_ids: [PIDS.rice],
        batches: [],
        removed_product_ids: [PIDS.sugar],
      }),
    )
    expect((await getProduct(T, PIDS.rice))?.sale_price_paise).toBe(38_500)
    expect(await getProduct(T, PIDS.sugar)).toBeNull()
    expect(await lookupCode(T, '8901234500011', makeBootstrap())).toBeNull()
    expect((await lookupCode(T, '8901234599999', makeBootstrap()))?.product.id).toBe(PIDS.rice)
    expect((await lookupCode(T, '8901234500028', makeBootstrap()))?.product.id).toBe(dal.id)
  })
})

describe('offline numbering', () => {
  const series = makeBootstrap().series!

  it('merges the server series: higher next number wins, a new prefix / FY replaces', () => {
    const local = { prefix: 'S1-A/2627/', next_number: 9, padding: 5, fy: '2026-27' }
    expect(mergeSeries(local, series).next_number).toBe(9)
    expect(mergeSeries({ ...local, next_number: 2 }, series).next_number).toBe(5)
    expect(
      mergeSeries(local, { ...series, prefix: 'S1-A/2728/', fy: '2027-28', next_number: 1 }),
    ).toMatchObject({
      prefix: 'S1-A/2728/',
      next_number: 1,
    })
  })

  it('a new financial year waits for the server prefix', () => {
    const state = { prefix: 'S1-A/2627/', next_number: 7, padding: 5, fy: '2026-27' }
    expect(nextOfflineNumber(state, TODAY, 4)).toBe('S1-A/2627/00007')
    expect(nextOfflineNumber(state, '2027-04-01', 4)).toBeNull()
    expect(nextOfflineNumber(null, TODAY, 4)).toBeNull()
  })

  it('quick bills get consecutive numbers atomically; the same client_ref is queued once', async () => {
    await reconcileSeries(T, KEY, series)
    const queue = (ref: string) =>
      queueOfflineDocument({
        entry: {
          client_ref: ref,
          tenant_id: T,
          store_id: IDS.store,
          register_id: IDS.register,
          kind: 'invoice',
        },
        docType: series.doc_type,
        date: TODAY,
        fyStartMonth: 4,
        registerKey: KEY,
        build: (number) => ({ client_ref: ref, offline_number: number }),
      })
    const [a, b, c] = await Promise.all([queue('ref-a'), queue('ref-b'), queue('ref-c')])
    expect([a.number, b.number, c.number].sort()).toEqual([
      'S1-A/2627/00005',
      'S1-A/2627/00006',
      'S1-A/2627/00007',
    ])
    const again = await queue('ref-b')
    expect(again.number).toBe(b.number)
    expect((await readSeries(T, KEY, series.doc_type))?.next_number).toBe(8)
    expect(
      (await outbox.pending(T)).map(
        (e) => (e.payload as { offline_number: string }).offline_number,
      ),
    ).toEqual([a.number, b.number, c.number])
  })

  it('an online bill moves the local series past its number', async () => {
    await reconcileSeries(T, KEY, series)
    await advanceSeriesPast(T, KEY, series.doc_type, 'S1-A/2627/00011')
    expect((await readSeries(T, KEY, series.doc_type))?.next_number).toBe(12)
    // Another prefix or an older number changes nothing.
    await advanceSeriesPast(T, KEY, series.doc_type, 'S2-A/2627/00099')
    await advanceSeriesPast(T, KEY, series.doc_type, 'S1-A/2627/00003')
    expect((await readSeries(T, KEY, series.doc_type))?.next_number).toBe(12)
  })
})

describe('POST /pos/sync', () => {
  async function queueBills(n: number): Promise<string[]> {
    const refs: string[] = []
    for (let i = 0; i < n; i++) {
      const ref = `0192f0a0-0000-7000-8000-0000000071${String(i).padStart(2, '0')}`
      refs.push(ref)
      await outbox.enqueue({
        client_ref: ref,
        tenant_id: T,
        store_id: IDS.store,
        register_id: IDS.register,
        kind: 'invoice',
        number: `S1-A/2627/0000${i + 5}`,
        payload: { client_ref: ref, offline_number: `S1-A/2627/0000${i + 5}` },
      })
    }
    return refs
  }

  it('applies per-item results: created, renumbered, duplicate, failed', async () => {
    const [a, b, c, d] = await queueBills(4)
    let body: { register_id: string; invoices: Array<{ client_ref: string }> } | null = null
    server.use(
      http.post(apiPath('/pos/sync'), async ({ request }) => {
        body = (await request.json()) as typeof body
        const result: PosSyncResult = {
          results: [
            {
              kind: 'invoice',
              client_ref: a!,
              status: 'created',
              id: PIDS.invoice,
              number: 'S1-A/2627/00005',
              offline_number: 'S1-A/2627/00005',
              error: null,
              warnings: [],
            },
            {
              kind: 'invoice',
              client_ref: b!,
              status: 'renumbered',
              id: PIDS.rice,
              number: 'S1-A/2627/00009',
              offline_number: 'S1-A/2627/00006',
              error: null,
              warnings: [],
            },
            {
              kind: 'invoice',
              client_ref: c!,
              status: 'duplicate',
              id: PIDS.dal,
              number: 'S1-A/2627/00007',
              offline_number: 'S1-A/2627/00007',
              error: null,
              warnings: [],
            },
            {
              kind: 'invoice',
              client_ref: d!,
              status: 'failed',
              id: null,
              number: null,
              offline_number: 'S1-A/2627/00008',
              error: { code: 'INSUFFICIENT_STOCK', message: 'Out of stock', details: null },
              warnings: [],
            },
          ],
          created: 1,
          duplicates: 1,
          renumbered: 1,
          failed: 1,
          series: { ...makeBootstrap().series!, next_number: 10, next: 'S1-A/2627/00010' },
        }
        return HttpResponse.json({ data: result })
      }),
    )
    const run = await syncOutbox({ tenantId: T, registerId: IDS.register, registerKey: KEY })
    expect(body!.register_id).toBe(IDS.register)
    expect(body!.invoices.map((i) => i.client_ref)).toEqual([a, b, c, d])
    expect(run).toMatchObject({
      attempted: 4,
      created: 1,
      renumbered: 1,
      duplicates: 1,
      failed: 1,
      error: null,
    })

    const rows = await outbox.list(T)
    expect(rows.map((r) => [r.status, r.server_number, r.renumbered])).toEqual([
      ['synced', 'S1-A/2627/00005', false],
      ['synced', 'S1-A/2627/00009', true],
      ['synced', 'S1-A/2627/00007', false],
      ['failed', null, false],
    ])
    expect(rows[3]?.last_error).toEqual({ code: 'INSUFFICIENT_STOCK', message: 'Out of stock' })
    // The failed bill is not resent in the same run; the series realigned.
    expect((await readSeries(T, KEY, 'sales_invoice'))?.next_number).toBe(10)
  })

  it('a failed request keeps everything queued with the reason', async () => {
    await queueBills(2)
    server.use(
      http.post(apiPath('/pos/sync'), () =>
        errorResponse(503, 'SERVICE_UNAVAILABLE', 'Down for maintenance'),
      ),
    )
    const run = await syncOutbox({ tenantId: T, registerId: IDS.register, registerKey: KEY })
    expect(run.error).not.toBeNull()
    const rows = await outbox.pending(T)
    expect(rows).toHaveLength(2)
    expect(
      rows.every((r) => r.status === 'failed' && r.last_error?.code === 'SERVICE_UNAVAILABLE'),
    ).toBe(true)
  })

  it('batches oldest first, invoices and credit notes separately', () => {
    const entry = (seq: number, kind: 'invoice' | 'credit_note') => ({
      seq,
      client_ref: `r${seq}`,
      tenant_id: T,
      store_id: IDS.store,
      register_id: IDS.register,
      kind,
      number: null,
      payload: {},
      status: 'pending' as const,
      attempts: 0,
      last_error: null,
      created_at: '',
      synced_at: null,
      server_id: null,
      server_number: null,
      renumbered: false,
    })
    const b = nextBatch([entry(3, 'invoice'), entry(1, 'credit_note'), entry(2, 'invoice')])
    expect(b.invoices.map((e) => e.seq)).toEqual([2, 3])
    expect(b.credit_notes.map((e) => e.seq)).toEqual([1])
  })
})
