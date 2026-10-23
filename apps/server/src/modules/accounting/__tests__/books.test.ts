/**
 * Books API: day book (entries with lines and source documents, day totals, pagination, CSV),
 * cash book (opening, running balance continued across pages, closing, CSV) and the ledger of any
 * account (party filter on receivable / payable, store filter / scoping) — with feature gating,
 * permissions and tenant isolation.
 */
import { addDays, newId } from '@kadai/shared'
import type { AccountLedgerResponse, DayBookResponse } from '@kadai/shared/api/accounting'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import {
  accountByCode,
  accountId,
  api,
  expectError,
  get,
  pay,
  post,
  postSale,
  stockedProduct,
  today,
} from './fixtures'

describe('accounting: books', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let cash: string
  let capital: string
  let yesterday: string
  let customerA: { id: string; name: string }
  let customerB: { id: string; name: string }
  let store2: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    cash = await accountId(t, shop, 'cash')
    capital = await accountId(t, shop, 'capital')
    yesterday = addDays(today(), -1)
    const jv = (date: string, amount: number, narration: string, store_id?: string) =>
      post(shop, '/journal-entries', {
        entry_date: date,
        narration,
        store_id,
        lines: [
          { account_id: cash, debit_paise: amount },
          { account_id: capital, credit_paise: amount },
        ],
      })
    await jv(addDays(today(), -10), 50_000, 'Capital brought in')
    await jv(yesterday, 20_000, 'More capital')
    await jv(today(), 1_000, 'Small top-up')
    store2 = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({
        id: store2,
        tenant_id: shop.tenant.id,
        code: 'S2',
        name: 'Branch',
        state_code: '33',
      })
      .execute()
    await jv(today(), 3_000, 'Branch float', store2)
    const product = await stockedProduct(t, shop, {
      cost_paise: 1_000,
      qty_milli: 10_000,
      date: addDays(today(), -10),
    })
    customerA = await insertTestCustomer(t.deps, shop.tenant.id)
    customerB = await insertTestCustomer(t.deps, shop.tenant.id)
    const saleA = await postSale(t, shop, {
      customer_id: customerA.id,
      lines: [{ product_id: product.id, qty_milli: 1_000, taxable_paise: 4_000 }],
      tenders: [{ method: 'cash', amount_paise: 1_000 }],
    })
    await postSale(t, shop, {
      customer_id: customerB.id,
      lines: [{ product_id: product.id, qty_milli: 1_000, taxable_paise: 2_000 }],
    })
    await pay(shop, {
      direction: 'in',
      store_id: shop.store.id,
      method: 'upi',
      amount_paise: 500,
      payment_date: today(),
      party: { type: 'customer', id: customerA.id },
      allocations: [{ target_type: 'sales_invoice', target_id: saleA.id, amount_paise: 500 }],
      number: true,
    })
    await post(shop, '/expenses', {
      store_id: shop.store.id,
      expense_date: today(),
      expense_account_id: await accountByCode(t, shop, '5300'),
      total_paise: 2_500,
      payment_method: 'cash',
    })
  })
  afterAll(() => t.close())

  it('day book: every entry of the day with lines, sources and totals', async () => {
    const day = await get<DayBookResponse>(shop, `/books/day-book?date=${today()}`)
    const types = day.data.map((e) => e.source_type)
    expect(types).toEqual(expect.arrayContaining(['manual', 'sales_invoice', 'payment', 'expense']))
    expect(day.data.every((e) => e.entry_date === today() && e.lines.length >= 2)).toBe(true)
    expect(day.day.entry_count).toBe(day.data.length)
    expect(day.day.total_debit_paise).toBe(day.data.reduce((s, e) => s + e.total_paise, 0))
    expect(day.day.total_credit_paise).toBe(day.day.total_debit_paise)
    const exp = day.data.find((e) => e.source_type === 'expense')!
    expect(exp.source.number).toMatch(/^EXP/)
    expect(exp.source.path).toBe(`/accounting/expenses?id=${exp.source_id}`)
    const receipt = day.data.find((e) => e.source_type === 'payment' && e.source_number)
    expect(receipt?.source_number).toMatch(/^RCS1/)
    const bySource = Object.fromEntries(day.day.by_source_type.map((r) => [r.source_type, r.count]))
    expect(bySource.manual).toBe(2)
    expect(bySource.sales_invoice).toBe(2)

    const page = await get<DayBookResponse>(
      shop,
      `/books/day-book?date=${today()}&limit=2&offset=2`,
    )
    expect(page.data.map((e) => e.id)).toEqual(day.data.slice(2, 4).map((e) => e.id))
    expect(page.page.total).toBe(day.data.length)

    const manual = await get<DayBookResponse>(
      shop,
      `/books/day-book?date=${today()}&source_type=manual`,
    )
    expect(manual.data).toHaveLength(2)
    const branch = await get<DayBookResponse>(
      shop,
      `/books/day-book?date=${today()}&store_id=${store2}`,
    )
    expect(branch.data.map((e) => e.narration)).toEqual(['Branch float'])
    const empty = await get<DayBookResponse>(shop, '/books/day-book?date=2020-01-01')
    expect(empty).toMatchObject({ data: [], day: { entry_count: 0, total_debit_paise: 0 } })

    const csv = await shop.inject({
      method: 'GET',
      url: api(`/books/day-book?date=${today()}&format=csv`),
      headers: { 'x-locale': 'en' },
    })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-disposition']).toContain(`day-book-${today()}.csv`)
    const rows = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(rows.at(-1)).toContain('Total')
    expect(rows.length).toBe(1 + day.data.reduce((s, e) => s + e.lines.length, 0) + 1)
    expectError(
      await shop.inject({ method: 'GET', url: api('/books/day-book') }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('cash book: opening, running balance continued across pages, closing', async () => {
    const from = yesterday
    const book = await get<AccountLedgerResponse>(shop, `/books/cash-book?from=${from}`)
    const m = book.ledger
    expect(m.account).toMatchObject({ id: cash, subtype: 'cash' })
    expect(m.opening_balance_paise).toBe(50_000)
    expect(m.from).toBe(from)
    expect(m.to).toBe(today())
    const net = book.data.reduce((s, r) => s + r.debit_paise - r.credit_paise, 0)
    expect(m.closing_balance_paise).toBe(m.opening_balance_paise + net)
    expect(book.data.at(-1)?.balance_paise).toBe(m.closing_balance_paise)
    expect(book.data[0]).toMatchObject({
      date: yesterday,
      debit_paise: 20_000,
      balance_paise: 70_000,
    })
    expect(book.data[0]?.counter_accounts).toEqual(['உரிமையாளர் முதலீடு']) // Tamil member
    const expenseRow = book.data.find((r) => r.source_type === 'expense')
    expect(expenseRow).toMatchObject({ credit_paise: 2_500 })
    expect(expenseRow?.counter_accounts.length).toBe(1)

    const p1 = await get<AccountLedgerResponse>(shop, `/books/cash-book?from=${from}&limit=2`)
    const p2 = await get<AccountLedgerResponse>(
      shop,
      `/books/cash-book?from=${from}&limit=2&offset=2`,
    )
    expect(p1.page.total).toBe(book.data.length)
    expect(p2.ledger.page_opening_balance_paise).toBe(p1.data.at(-1)!.balance_paise)
    expect(p2.data.map((r) => r.line_id)).toEqual(book.data.slice(2, 4).map((r) => r.line_id))
    expect(p1.ledger.page_opening_balance_paise).toBe(50_000)

    const bank = await get<AccountLedgerResponse>(
      shop,
      `/books/cash-book?account_id=${await accountId(t, shop, 'bank')}`,
    )
    expect(bank.ledger.account.subtype).toBe('bank')
    expectError(
      await shop.inject({ method: 'GET', url: api('/books/cash-book?from=2099-01-01') }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api(`/books/cash-book?account_id=${capital}`) }),
      422,
      'UNPROCESSABLE',
      'money_account_required',
    )

    const csv = await shop.inject({
      method: 'GET',
      url: api(`/books/cash-book?from=${from}&format=csv`),
      headers: { 'x-locale': 'en' },
    })
    expect(csv.statusCode).toBe(200)
    const rows = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(rows[1]).toBe('Date,Type,Document no.,Particulars,Party,Narration,Debit,Credit,Balance')
    expect(rows[2]).toContain('Opening balance')
    expect(rows[2]).toContain('500.00')
    expect(rows.at(-1)).toContain('Closing balance')
    expect(rows).toHaveLength(book.data.length + 4)
  })

  it('ledger: any account, party filter on receivable, store filter', async () => {
    const receivable = await accountId(t, shop, 'receivable')
    const all = await get<AccountLedgerResponse>(
      shop,
      `/books/ledger/${receivable}?from=${yesterday}`,
    )
    expect(all.data.length).toBeGreaterThanOrEqual(4)
    const a = await get<AccountLedgerResponse>(
      shop,
      `/books/ledger/${receivable}?from=${yesterday}&party_type=customer&party_id=${customerA.id}`,
    )
    expect(a.ledger.party).toEqual({ type: 'customer', id: customerA.id, name: customerA.name })
    expect(
      a.data.every((r) => r.party_id === customerA.id && r.party_name === customerA.name),
    ).toBe(true)
    // 4200 billed − 1000 cash − 500 UPI.
    expect(a.ledger.closing_balance_paise).toBe(4_200 - 1_000 - 500)
    const customer = await t.deps.db.systemDb
      .selectFrom('customers')
      .select('balance_paise')
      .where('id', '=', customerA.id)
      .executeTakeFirstOrThrow()
    expect(customer.balance_paise).toBe(a.ledger.closing_balance_paise)
    const sale = a.data.find((r) => r.source_type === 'sales_invoice')!
    expect(sale.source_path).toBe(`/sales/invoices/${sale.source_id}`)
    expect(sale.counter_accounts).toEqual(expect.arrayContaining(['விற்பனை']))

    const capitalBranch = await get<AccountLedgerResponse>(
      shop,
      `/books/ledger/${capital}?from=${yesterday}&store_id=${store2}`,
    )
    expect(capitalBranch.data.map((r) => r.credit_paise)).toEqual([3_000])
    expect(capitalBranch.ledger.opening_balance_paise).toBe(0)
    const scoped = await shop.asRole('s1_reader', {
      permissions: ['accounting.read'],
      store_ids: [shop.store.id],
    })
    const s1 = await get<AccountLedgerResponse>(
      shop,
      `/books/ledger/${capital}?from=${yesterday}`,
      scoped,
    )
    expect(s1.data.some((r) => r.credit_paise === 3_000)).toBe(false)
    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/books/ledger/${capital}?store_id=${store2}`),
        as: scoped,
      }),
      403,
      'FORBIDDEN',
    )

    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/books/ledger/${receivable}?party_id=${customerA.id}`),
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/books/ledger/${receivable}?party_type=customer&party_id=${newId()}`),
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api(`/books/ledger/${newId()}`) }),
      404,
      'NOT_FOUND',
    )
    const csv = await shop.inject({
      method: 'GET',
      url: api(
        `/books/ledger/${receivable}?format=csv&party_type=customer&party_id=${customerA.id}`,
      ),
    })
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('தொடக்க இருப்பு')
  })

  it('gates the feature and permissions, isolates tenants', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    for (const url of [`/books/day-book?date=${today()}`, '/books/cash-book']) {
      expectError(await free.inject({ method: 'GET', url: api(url) }), 402, 'FEATURE_NOT_IN_PLAN')
    }
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/books/cash-book'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await other.inject({ method: 'GET', url: api(`/books/ledger/${cash}`) }),
      404,
      'NOT_FOUND',
    )
    const theirs = await get<DayBookResponse>(other, `/books/day-book?date=${today()}`)
    expect(theirs.data).toEqual([])
    const theirCash = await get<AccountLedgerResponse>(other, '/books/cash-book')
    expect(theirCash.data).toEqual([])
    expect(theirCash.ledger.closing_balance_paise).toBe(0)
  })
})
