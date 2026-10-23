/**
 * Journal entries API: manual journal vouchers (validation, JV numbering, audit, idempotency),
 * one-time reversal of manual entries only, the list (filters, search, summary, CSV) and the
 * detail with lines and source document links — plus feature gating, permissions and tenant
 * isolation.
 */
import { addDays, newId } from '@kadai/shared'
import type { JournalEntryDetail, JournalListResponse } from '@kadai/shared/api/accounting'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import {
  type Data,
  accountId,
  api,
  auditActions,
  expectError,
  expectStatus,
  get,
  ledgerTotals,
  newSupplier,
  post,
  postSale,
  stockedProduct,
  today,
} from './fixtures'

describe('accounting: journal entries', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let cash: string
  let capital: string
  let receivable: string
  let payable: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    cash = await accountId(t, shop, 'cash')
    capital = await accountId(t, shop, 'capital')
    receivable = await accountId(t, shop, 'receivable')
    payable = await accountId(t, shop, 'payable')
  })
  afterAll(() => t.close())

  const jv = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
    entry_date: today(),
    narration: 'Owner brought cash into the shop',
    lines,
    ...extra,
  })

  it('posts a balanced manual journal with a JV number, audited', async () => {
    const res = await post<Data<JournalEntryDetail>>(
      shop,
      '/journal-entries',
      jv([
        { account_id: cash, debit_paise: 1_00_000, memo: 'Float' },
        { account_id: capital, credit_paise: 1_00_000 },
      ]),
    )
    const e = res.data
    expect(e.number).toMatch(/^JVS1\/\d{4}\/\d+$/)
    expect(e).toMatchObject({
      source_type: 'manual',
      total_paise: 1_00_000,
      line_count: 2,
      store_id: shop.store.id,
      can_reverse: true,
      reverses: null,
      reversed_by: null,
    })
    expect(e.source).toMatchObject({
      type: 'manual',
      number: e.number,
      path: `/accounting/journal?id=${e.id}`,
    })
    expect(e.lines[0]).toMatchObject({ account_id: cash, debit_paise: 1_00_000, memo: 'Float' })
    expect(e.lines[1]).toMatchObject({ account_id: capital, credit_paise: 1_00_000 })
    expect(e.debit_accounts.length).toBe(1)
    expect(await auditActions(t, shop)).toContain('journal.create')
    const totals = await ledgerTotals(t, shop)
    expect(totals.debit).toBe(totals.credit)
  })

  it('validates: balanced, ≥ 2 lines, one side per line, parties on receivable / payable', async () => {
    const bad = async (payload: unknown, status: number, code: string, reason?: string) =>
      expectError(
        await shop.inject({
          method: 'POST',
          url: api('/journal-entries'),
          payload: payload as object,
        }),
        status,
        code,
        reason,
      )
    await bad(
      jv([
        { account_id: cash, debit_paise: 100 },
        { account_id: capital, credit_paise: 90 },
      ]),
      400,
      'VALIDATION_ERROR',
    )
    await bad(jv([{ account_id: cash, debit_paise: 100 }]), 400, 'VALIDATION_ERROR')
    await bad(
      jv([
        { account_id: cash, debit_paise: 100, credit_paise: 100 },
        { account_id: capital, credit_paise: 0 },
      ]),
      400,
      'VALIDATION_ERROR',
    )
    await bad({ ...jv([]), narration: 'x' }, 400, 'VALIDATION_ERROR')
    await bad(
      jv([
        { account_id: receivable, debit_paise: 500 },
        { account_id: capital, credit_paise: 500 },
      ]),
      422,
      'UNPROCESSABLE',
      'party_required',
    )
    const supplier = await newSupplier(t, shop)
    await bad(
      jv([
        { account_id: receivable, debit_paise: 500, party_type: 'supplier', party_id: supplier.id },
        { account_id: capital, credit_paise: 500 },
      ]),
      422,
      'UNPROCESSABLE',
      'party_not_allowed',
    )
    await bad(
      jv([
        { account_id: newId(), debit_paise: 500 },
        { account_id: capital, credit_paise: 500 },
      ]),
      404,
      'NOT_FOUND',
    )
    // Inactive account.
    const head = (
      await post<Data<{ id: string }>>(shop, '/accounts', { name: 'Old head', type: 'expense' })
    ).data
    expectStatus(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${head.id}`),
        payload: { is_active: false },
      }),
      200,
    )
    await bad(
      jv([
        { account_id: head.id, debit_paise: 500 },
        { account_id: cash, credit_paise: 500 },
      ]),
      422,
      'UNPROCESSABLE',
      'account_inactive',
    )
  })

  it('moves party balances through receivable / payable lines', async () => {
    const customer = await insertTestCustomer(t.deps, shop.tenant.id)
    const supplier = await newSupplier(t, shop)
    await post(
      shop,
      '/journal-entries',
      jv(
        [
          {
            account_id: receivable,
            debit_paise: 7_500,
            party_type: 'customer',
            party_id: customer.id,
          },
          {
            account_id: payable,
            credit_paise: 7_500,
            party_type: 'supplier',
            party_id: supplier.id,
          },
        ],
        { narration: 'Customer to pay the supplier directly' },
      ),
    )
    const c = await t.deps.db.systemDb
      .selectFrom('customers')
      .select('balance_paise')
      .where('id', '=', customer.id)
      .executeTakeFirstOrThrow()
    const s = await t.deps.db.systemDb
      .selectFrom('suppliers')
      .select('balance_paise')
      .where('id', '=', supplier.id)
      .executeTakeFirstOrThrow()
    expect(c.balance_paise).toBe(7_500)
    expect(s.balance_paise).toBe(7_500)
    const list = await get<JournalListResponse>(
      shop,
      `/journal-entries?party_type=customer&party_id=${customer.id}`,
    )
    expect(list.data).toHaveLength(1)
    const detail = await get<Data<JournalEntryDetail>>(shop, `/journal-entries/${list.data[0]!.id}`)
    expect(detail.data.lines.map((l) => l.party_name)).toEqual([customer.name, supplier.name])
  })

  it('is idempotent with a client_ref / Idempotency-Key', async () => {
    const payload = jv(
      [
        { account_id: cash, debit_paise: 4_200 },
        { account_id: capital, credit_paise: 4_200 },
      ],
      { client_ref: `jv-${newId()}` },
    )
    const a = await shop.inject({ method: 'POST', url: api('/journal-entries'), payload })
    const b = await shop.inject({ method: 'POST', url: api('/journal-entries'), payload })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
    expect(JSON.parse(b.body).data.id).toBe(JSON.parse(a.body).data.id)
    const changed = await shop.inject({
      method: 'POST',
      url: api('/journal-entries'),
      payload: { ...payload, narration: 'Something else entirely' },
    })
    expectError(changed, 409, 'IDEMPOTENCY_MISMATCH')
  })

  it('reverses a manual journal exactly once', async () => {
    const e = (
      await post<Data<JournalEntryDetail>>(
        shop,
        '/journal-entries',
        jv([
          { account_id: cash, debit_paise: 9_900 },
          { account_id: capital, credit_paise: 9_900 },
        ]),
      )
    ).data
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/journal-entries/${e.id}/reverse`),
        payload: { reason: 'Entered twice', entry_date: '2020-01-01' },
      }),
      400,
      'VALIDATION_ERROR',
    )
    const rev = (
      await post<Data<JournalEntryDetail>>(shop, `/journal-entries/${e.id}/reverse`, {
        reason: 'Entered twice',
      })
    ).data
    expect(rev.reverses).toMatchObject({ id: e.id, number: e.number })
    expect(rev.can_reverse).toBe(false)
    expect(rev.source.path).toBe(`/accounting/journal?id=${e.id}`)
    expect(rev.source_number).toBe(e.number)
    expect(rev.lines.find((l) => l.account_id === cash)?.credit_paise).toBe(9_900)
    const original = (await get<Data<JournalEntryDetail>>(shop, `/journal-entries/${e.id}`)).data
    expect(original.reversed_by).toMatchObject({ id: rev.id })
    expect(original.can_reverse).toBe(false)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/journal-entries/${e.id}/reverse`),
        payload: { reason: 'Again' },
      }),
      409,
      'CONFLICT',
      'already_reversed',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/journal-entries/${rev.id}/reverse`),
        payload: { reason: 'Reverse the reversal' },
      }),
      409,
      'CONFLICT',
      'not_manual',
    )
    expect(await auditActions(t, shop)).toContain('journal.reverse')
  })

  it('dates the reversal of a future-dated voucher on the voucher date by default', async () => {
    const future = addDays(today(), 3)
    const e = (
      await post<Data<JournalEntryDetail>>(
        shop,
        '/journal-entries',
        jv(
          [
            { account_id: cash, debit_paise: 600 },
            { account_id: capital, credit_paise: 600 },
          ],
          { entry_date: future, narration: 'Post-dated cheque deposit' },
        ),
      )
    ).data
    const rev = (
      await post<Data<JournalEntryDetail>>(shop, `/journal-entries/${e.id}/reverse`, {
        reason: 'Cheque returned',
      })
    ).data
    expect(rev.entry_date).toBe(future)
  })

  it('reverses concurrently at most once', async () => {
    const e = (
      await post<Data<JournalEntryDetail>>(
        shop,
        '/journal-entries',
        jv([
          { account_id: cash, debit_paise: 1_234 },
          { account_id: capital, credit_paise: 1_234 },
        ]),
      )
    ).data
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        shop.inject({
          method: 'POST',
          url: api(`/journal-entries/${e.id}/reverse`),
          payload: { reason: 'Race' },
        }),
      ),
    )
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1)
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3)
  })

  it('refuses to reverse document postings (cancel the document instead)', async () => {
    const product = await stockedProduct(t, shop, { cost_paise: 1_000, qty_milli: 5_000 })
    const sale = await postSale(t, shop, {
      lines: [{ product_id: product.id, qty_milli: 1_000, taxable_paise: 2_000 }],
      tenders: [{ method: 'cash', amount_paise: 2_100 }],
    })
    const list = await get<JournalListResponse>(
      shop,
      `/journal-entries?source_type=sales_invoice&source_id=${sale.id}`,
    )
    expect(list.data).toHaveLength(1)
    const entry = list.data[0]!
    expect(entry).toMatchObject({
      source_number: sale.number,
      source_path: `/sales/invoices/${sale.id}`,
      total_paise: 2_100 + 1_000,
    })
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/journal-entries/${entry.id}/reverse`),
        payload: { reason: 'Not allowed' },
      }),
      409,
      'CONFLICT',
      'not_manual',
    )
    // The tender is a payment entry with a link to the payments page.
    const payments = await get<JournalListResponse>(shop, `/journal-entries?source_type=payment`)
    expect(payments.data[0]?.source_path).toMatch(/^\/payments\?id=/)
    // Search by the document number.
    const found = await get<JournalListResponse>(
      shop,
      `/journal-entries?q=${encodeURIComponent(sale.number)}`,
    )
    expect(found.data.map((d) => d.id)).toEqual([entry.id])
  })

  it('lists with filters, sorting, summary and CSV', async () => {
    const all = await get<JournalListResponse>(shop, '/journal-entries?limit=2')
    expect(all.data).toHaveLength(2)
    expect(all.page.total).toBe(all.summary.count)
    expect(all.summary.count).toBeGreaterThan(5)
    const byAccount = await get<JournalListResponse>(
      shop,
      `/journal-entries?account_id=${capital}&sort=-total_paise`,
    )
    expect(byAccount.data.length).toBeGreaterThan(0)
    const totals = byAccount.data.map((d) => d.total_paise)
    expect([...totals].sort((a, b) => b - a)).toEqual(totals)
    const noReversals = await get<JournalListResponse>(shop, '/journal-entries?reversals=false')
    expect(
      noReversals.data.every(
        (d) => d.reverses_entry_id === null && d.reversed_by_entry_id === null,
      ),
    ).toBe(true)
    const onlyReversals = await get<JournalListResponse>(shop, '/journal-entries?reversals=true')
    expect(onlyReversals.data.length).toBeGreaterThan(0)
    expect(onlyReversals.data.every((d) => d.reverses_entry_id !== null)).toBe(true)
    const future = await get<JournalListResponse>(shop, '/journal-entries?from=2099-01-01')
    expect(future.data).toEqual([])
    expect(future.summary).toEqual({ count: 0, total_paise: 0 })
    expectError(
      await shop.inject({
        method: 'GET',
        url: api('/journal-entries?from=2026-10-10&to=2026-10-01'),
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api(`/journal-entries?party_id=${newId()}`) }),
      400,
      'VALIDATION_ERROR',
    )

    const csv = await shop.inject({
      method: 'GET',
      url: api('/journal-entries?format=csv'),
      headers: { 'x-locale': 'en' },
    })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.headers['content-disposition']).toContain('journal-')
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(lines[0]).toBe(
      'Date,Voucher,Type,Document no.,Narration,Account code,Account,Party,Memo,Debit,Credit',
    )
    expect(lines.length).toBeGreaterThan(10)
    expect(await auditActions(t, shop)).toContain('accounting.export')
  })

  it('gates the feature, permissions and tenants', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    expectError(
      await free.inject({ method: 'GET', url: api('/journal-entries') }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/journal-entries'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const reader = await shop.asRole('reader', { permissions: ['accounting.read'] })
    const list = await get<JournalListResponse>(shop, '/journal-entries', reader)
    expect(list.data.length).toBeGreaterThan(0)
    const detail = await get<Data<JournalEntryDetail>>(
      shop,
      `/journal-entries/${list.data.find((d) => d.source_type === 'manual' && !d.reversed_by_entry_id && !d.reverses_entry_id)!.id}`,
      reader,
    )
    expect(detail.data.can_reverse).toBe(false) // no accounting.write
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/journal-entries'),
        payload: jv([
          { account_id: cash, debit_paise: 1 },
          { account_id: capital, credit_paise: 1 },
        ]),
        as: reader,
      }),
      403,
      'FORBIDDEN',
    )
    // Tenant isolation: neither the entry nor another tenant's accounts are reachable.
    expectError(
      await other.inject({ method: 'GET', url: api(`/journal-entries/${detail.data.id}`) }),
      404,
      'NOT_FOUND',
    )
    const theirs = await get<JournalListResponse>(other, '/journal-entries')
    expect(theirs.data.some((d) => d.id === detail.data.id)).toBe(false)
    expectError(
      await other.inject({
        method: 'POST',
        url: api('/journal-entries'),
        payload: jv([
          { account_id: cash, debit_paise: 100 },
          { account_id: capital, credit_paise: 100 },
        ]),
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'POST',
        url: api(`/journal-entries/${detail.data.id}/reverse`),
        payload: { reason: 'Not mine' },
      }),
      404,
      'NOT_FOUND',
    )
  })
})
