import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../db/tenant'
import { type TestApp, buildTestApp } from '../test/helpers'
import { type TestShop, createTestTenant } from '../test/tenants'
import { AppError } from './errors'
import { acceptOfflineNumber, nextNumber, paddingFor, peekSeries } from './numbering'

describe('core/numbering', () => {
  let t: TestApp
  let shop: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const alloc = (req: Parameters<typeof nextNumber>[2]) => shop.tx((tx) => nextNumber(tx, shop.ctx, req))

  it('numbers register and back-office invoices from separate series with the FY of the date', async () => {
    const pos1 = await alloc({
      docType: 'sales_invoice',
      storeId: shop.store.id,
      registerId: shop.register.id,
      date: '2026-10-20',
    })
    const pos2 = await alloc({
      docType: 'sales_invoice',
      storeId: shop.store.id,
      registerId: shop.register.id,
      date: '2027-03-31',
    })
    const office = await alloc({ docType: 'sales_invoice', storeId: shop.store.id, date: '2026-10-20' })
    const nextFy = await alloc({
      docType: 'sales_invoice',
      storeId: shop.store.id,
      registerId: shop.register.id,
      date: '2027-04-01',
    })
    expect(pos1).toMatchObject({ number: 'S1-A/2627/00001', fy: '2026-27', seq: 1 })
    expect(pos2).toMatchObject({ number: 'S1-A/2627/00002', fy: '2026-27', seq: 2 })
    expect(office).toMatchObject({ number: 'S1/2627/00001', fy: '2026-27', seq: 1 })
    expect(nextFy).toMatchObject({ number: 'S1-A/2728/00001', fy: '2027-28', seq: 1 })
  })

  it('uses per-store series for other document types (register ignored)', async () => {
    const a = await alloc({
      docType: 'credit_note',
      storeId: shop.store.id,
      registerId: shop.register.id,
      date: '2026-10-20',
    })
    const b = await alloc({ docType: 'credit_note', storeId: shop.store.id, date: '2026-10-21' })
    const bos = await alloc({
      docType: 'bill_of_supply',
      storeId: shop.store.id,
      registerId: shop.register.id,
      date: '2026-10-21',
    })
    const rc = await alloc({ docType: 'receipt', storeId: shop.store.id, date: '2026-10-21' })
    expect([a.number, b.number, bos.number, rc.number]).toEqual([
      'CNS1/2627/00001',
      'CNS1/2627/00002',
      'S1-AB/2627/00001',
      'RCS1/2627/00001',
    ])
  })

  it('does not consume a number when the transaction rolls back', async () => {
    const req = { docType: 'estimate', storeId: shop.store.id, date: '2026-10-20' } as const
    const first = await alloc(req)
    await expect(
      shop.tx(async (tx) => {
        await nextNumber(tx, shop.ctx, req)
        throw new Error('document failed')
      }),
    ).rejects.toThrow('document failed')
    const second = await alloc(req)
    expect(second.seq).toBe(first.seq + 1)
  })

  it('allocates 1..25 to 25 concurrent transactions without gaps or duplicates (incl. first-use race)', async () => {
    const other = await createTestTenant(t)
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        other.tx((tx) => nextNumber(tx, other.ctx, { docType: 'expense', storeId: other.store.id, date: '2026-11-01' })),
      ),
    )
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(new Set(results.map((r) => r.number)).size).toBe(25)
    const series = await t.deps.db.systemDb
      .selectFrom('number_series')
      .select(['next_number'])
      .where('tenant_id', '=', other.tenant.id)
      .where('doc_type', '=', 'expense')
      .execute()
    expect(series).toEqual([{ next_number: 26 }])
  })

  it('stays gapless when some of the concurrent transactions roll back', async () => {
    const req = { docType: 'journal', storeId: shop.store.id, date: '2026-11-02' } as const
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        shop.tx(async (tx) => {
          const n = await nextNumber(tx, shop.ctx, req)
          if (i % 4 === 0) throw new Error('rollback')
          return n.seq
        }),
      ),
    )
    const committed = outcomes
      .flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []))
      .sort((a, b) => a - b)
    expect(committed).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
  })

  it('peekSeries reports defaults before first use and the next number afterwards', async () => {
    const req = { docType: 'purchase_bill', storeId: shop.store.id, date: '2026-10-20' } as const
    const before = await shop.tx((tx) => peekSeries(tx, shop.ctx, req))
    expect(before).toMatchObject({
      series_id: null,
      prefix: 'GRNS1/2627/',
      next_number: 1,
      padding: 5,
      fy: '2026-27',
      next: 'GRNS1/2627/00001',
    })
    await alloc(req)
    const after = await shop.tx((tx) => peekSeries(tx, shop.ctx, req))
    expect(after.series_id).toEqual(expect.any(String))
    expect(after.next).toBe('GRNS1/2627/00002')
  })

  it('shrinks padding to fit 16 characters, rejects prefixes that cannot fit and exhausted series', async () => {
    expect(paddingFor('S1/2627/')).toBe(5)
    expect(paddingFor('ABCD-XY/2627/')).toBe(3)
    expect(() => paddingFor('ABCD-XYB/2627/')).toThrow(AppError)

    const storeId = newId()
    const registerId = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({ id: storeId, tenant_id: shop.tenant.id, code: 'ABCD', name: 'Long code', state_code: '33' })
      .execute()
    await t.deps.db.systemDb
      .insertInto('registers')
      .values({ id: registerId, tenant_id: shop.tenant.id, store_id: storeId, code: 'XY', name: 'XY' })
      .execute()
    const first = await alloc({ docType: 'sales_invoice', storeId, registerId, date: '2026-10-20' })
    expect(first.number).toBe('ABCD-XY/2627/001')
    expect(first.number.length).toBeLessThanOrEqual(16)

    const bos = alloc({ docType: 'bill_of_supply', storeId, registerId, date: '2026-10-20' })
    await expect(bos).rejects.toMatchObject({ code: 'CONFLICT' })

    await t.deps.db.systemDb
      .updateTable('number_series')
      .set({ next_number: 999 })
      .where('id', '=', first.series_id)
      .execute()
    const last = await alloc({ docType: 'sales_invoice', storeId, registerId, date: '2026-10-21' })
    expect(last.number).toBe('ABCD-XY/2627/999')
    await expect(
      alloc({ docType: 'sales_invoice', storeId, registerId, date: '2026-10-21' }),
    ).rejects.toMatchObject({ code: 'NUMBER_SERIES_EXHAUSTED', status: 409 })
  })

  it('accepts an offline number equal to the next one and renumbers otherwise', async () => {
    const register = newId()
    await t.deps.db.systemDb
      .insertInto('registers')
      .values({ id: register, tenant_id: shop.tenant.id, store_id: shop.store.id, code: 'B', name: 'B' })
      .execute()
    const base = { docType: 'sales_invoice', storeId: shop.store.id, registerId: register, date: '2026-12-01' } as const
    const ok = await shop.tx((tx) => acceptOfflineNumber(tx, shop.ctx, { ...base, number: 's1-b/2627/00001' }))
    expect(ok).toMatchObject({ number: 'S1-B/2627/00001', renumbered: false })
    const ok2 = await shop.tx((tx) => acceptOfflineNumber(tx, shop.ctx, { ...base, number: 'S1-B/2627/00002' }))
    expect(ok2.renumbered).toBe(false)
    const clash = await shop.tx((tx) =>
      acceptOfflineNumber(tx, shop.ctx, { ...base, number: 'S1-B/2627/00009' }),
    )
    expect(clash).toMatchObject({ number: 'S1-B/2627/00003', renumbered: true, offline_number: 'S1-B/2627/00009' })
  })

  it('validates store, register and input', async () => {
    const other = await createTestTenant(t)
    // Another tenant's store is invisible under RLS.
    await expect(
      alloc({ docType: 'receipt', storeId: other.store.id, date: '2026-10-20' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A register of another store.
    const store2 = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({ id: store2, tenant_id: shop.tenant.id, code: 'S2', name: 'Branch', state_code: '33' })
      .execute()
    await expect(
      alloc({ docType: 'sales_invoice', storeId: store2, registerId: shop.register.id, date: '2026-10-20' }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
    await expect(alloc({ docType: 'receipt', storeId: shop.store.id, date: '20-10-2026' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('derives the financial year from tenants.fy_start_month', async () => {
    const jan = await createTestTenant(t)
    await t.deps.db.systemDb.updateTable('tenants').set({ fy_start_month: 1 }).where('id', '=', jan.tenant.id).execute()
    const n = await withTenant(t.deps.db.appDb, jan.ctx, (tx) =>
      nextNumber(tx, jan.ctx, { docType: 'receipt', storeId: jan.store.id, date: '2026-02-10' }),
    )
    expect(n).toMatchObject({ fy: '2026-26', number: 'RCS1/2626/00001' })
  })
})
