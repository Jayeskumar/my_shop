/**
 * Number series: every series of a FY listed (unused ones with id null and the default prefix
 * core/numbering would use), customisation before the first document, next_number only
 * increases, prefix changes after documents need `force` (audited), the 16-character GST limit
 * and character set, unique prefixes per FY, permissions and tenant isolation.
 */
import { fyOf, fyShort, newId, todayIn } from '@kadai/shared'
import type { NumberSeries } from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nextNumber } from '../../../core/numbering'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { type Data, api, auditRows, expectError, expectStatus } from './fixtures'

describe('identity: number series', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  const today = todayIn('Asia/Kolkata')
  const fy = fyOf(today)
  const short = fyShort(fy)

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const list = async (query = '', on: TestShop = shop) =>
    expectStatus<Data<NumberSeries[]>>(
      await on.inject({ method: 'GET', url: api(`/number-series${query}`) }),
      200,
    ).data
  const find = (rows: NumberSeries[], docType: string, registerId: string | null = null) =>
    rows.find((r) => r.doc_type === docType && r.register_id === registerId)!

  it('lists every series of the FY, unused ones with their default prefix', async () => {
    const rows = await list()
    // 14 store-level series + the POS series of register A (invoice, bill of supply).
    expect(rows).toHaveLength(16)
    const pos = find(rows, 'sales_invoice', shop.register.id)
    expect(pos).toMatchObject({
      id: null,
      fy,
      prefix: `S1-A/${short}/`,
      padding: 5,
      next_number: 1,
      next: `S1-A/${short}/00001`,
      issued_count: 0,
      max_length: 16,
      is_gst_document: true,
      register_code: 'A',
      updated_at: null,
    })
    expect(find(rows, 'purchase_bill')).toMatchObject({
      prefix: `GRNS1/${short}/`,
      max_length: 32,
      is_gst_document: false,
    })

    await shop.tx((tx) =>
      nextNumber(tx, shop.ctx, {
        docType: 'sales_invoice',
        storeId: shop.store.id,
        registerId: shop.register.id,
        date: today,
      }),
    )
    const used = find(await list(), 'sales_invoice', shop.register.id)
    expect(used.id).not.toBeNull()
    expect(used).toMatchObject({ next_number: 2, issued_count: 1, next: `S1-A/${short}/00002` })
    const filtered = await list(`?doc_type=credit_note&store_id=${shop.store.id}`)
    expect(filtered.map((r) => r.doc_type)).toEqual(['credit_note'])
    expectError(
      await shop.inject({ method: 'GET', url: api('/number-series?fy=2026-28') }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('customises a series before its first document (continue old numbering)', async () => {
    const created = expectStatus<Data<NumberSeries>>(
      await shop.inject({
        method: 'POST',
        url: api('/number-series'),
        payload: {
          store_id: shop.store.id,
          doc_type: 'credit_note',
          fy,
          prefix: 'crn/',
          padding: 4,
          next_number: 101,
        },
      }),
      201,
    ).data
    expect(created).toMatchObject({
      prefix: 'CRN/',
      padding: 4,
      next_number: 101,
      next: 'CRN/0101',
    })
    const issued = await shop.tx((tx) =>
      nextNumber(tx, shop.ctx, { docType: 'credit_note', storeId: shop.store.id, date: today }),
    )
    expect(issued.number).toBe('CRN/0101')
    const exists = expectError(
      await shop.inject({
        method: 'POST',
        url: api('/number-series'),
        payload: { store_id: shop.store.id, doc_type: 'credit_note', fy },
      }),
      409,
      'CONFLICT',
      'series_exists',
    )
    expect(exists.details?.id).toBe(created.id)
    expect(
      (await auditRows(t, shop, { action: 'number_series.create', entity_id: created.id! })).length,
    ).toBe(1)
  })

  it('enforces the GST length limit, characters, register series and FY', async () => {
    const post = (payload: Record<string, unknown>) =>
      shop.inject({ method: 'POST', url: api('/number-series'), payload })
    const tooLong = expectError(
      await post({
        store_id: shop.store.id,
        doc_type: 'debit_note',
        fy,
        prefix: 'DEBITNOTE/2627/',
        padding: 5,
      }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(tooLong.details)).toContain('series_too_long')
    // Internal documents may be longer (32 characters).
    expectStatus(
      await post({
        store_id: shop.store.id,
        doc_type: 'journal',
        fy,
        prefix: 'JOURNAL-VOUCHER/2627/',
      }),
      201,
    )
    const chars = expectError(
      await post({ store_id: shop.store.id, doc_type: 'receipt', fy, prefix: 'RC#1/' }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(chars.details)).toContain('series_prefix_chars')
    const regOnly = expectError(
      await post({
        store_id: shop.store.id,
        register_id: shop.register.id,
        doc_type: 'receipt',
        fy,
      }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(regOnly.details)).toContain('register_series_only')
    expectError(
      await post({ store_id: shop.store.id, doc_type: 'receipt', fy: '2026-29' }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await post({ store_id: other.store.id, doc_type: 'receipt', fy }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('only increases next_number and guards prefix changes after documents', async () => {
    const series = find(await list(), 'sales_invoice', shop.register.id)
    const patch = (payload: Record<string, unknown>, on: TestShop = shop) =>
      on.inject({ method: 'PATCH', url: api(`/number-series/${series.id}`), payload })
    const dec = expectError(await patch({ next_number: 1 }), 400, 'VALIDATION_ERROR')
    expect(JSON.stringify(dec.details)).toContain('next_number_decrease')
    const bumped = expectStatus<Data<NumberSeries>>(await patch({ next_number: 500 }), 200).data
    expect(bumped).toMatchObject({ next_number: 500, next: `S1-A/${short}/00500` })
    const inUse = expectError(await patch({ prefix: 'A/' }), 409, 'CONFLICT', 'series_in_use')
    expect(inUse.details?.issued_count).toBe(499)
    // Another series' prefix (the store-level invoice default) would duplicate numbers.
    expectError(
      await patch({ prefix: `S1/${short}/`, force: true }),
      409,
      'CONFLICT',
      'prefix_in_use',
    )
    const forced = expectStatus<Data<NumberSeries>>(
      await patch({ prefix: 'SA/', padding: 6, force: true, if_updated_at: bumped.updated_at }),
      200,
    ).data
    expect(forced).toMatchObject({ prefix: 'SA/', padding: 6, next: 'SA/000500' })
    const [row] = await auditRows(t, shop, {
      action: 'number_series.prefix_force_change',
      entity_id: series.id!,
    })
    expect(row?.changes).toMatchObject({
      before: { prefix: `S1-A/${short}/` },
      after: { prefix: 'SA/' },
      forced: true,
    })
    expectError(
      await patch({ next_number: 600, if_updated_at: bumped.updated_at }),
      409,
      'STALE_WRITE',
    )
    const tooLong = expectError(
      await patch({ prefix: 'SA/COUNTER-A/', force: true }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(tooLong.details)).toContain('series_too_long')
    const issued = await shop.tx((tx) =>
      nextNumber(tx, shop.ctx, {
        docType: 'sales_invoice',
        storeId: shop.store.id,
        registerId: shop.register.id,
        date: today,
      }),
    )
    expect(issued.number).toBe('SA/000500')
    expectError(await patch({ next_number: 900 }, other), 404, 'NOT_FOUND')
  })

  it('is for settings managers within their stores', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/number-series'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const scoped = await shop.asRole('series_admin', {
      permissions: ['settings.manage'],
      store_ids: [newId()],
    })
    const rows = expectStatus<Data<NumberSeries[]>>(
      await shop.inject({ method: 'GET', url: api('/number-series'), as: scoped }),
      200,
    ).data
    expect(rows).toEqual([])
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/number-series'),
        payload: { store_id: shop.store.id, doc_type: 'expense', fy },
        as: scoped,
      }),
      403,
      'FORBIDDEN',
    )
    // Other businesses never see these series.
    expect((await list('', other)).every((r) => r.store_id === other.store.id)).toBe(true)
  })
})
