/**
 * Customer summary: lifetime sales, monthly series, average bill, last visit, top items, dues /
 * overdue, credit headroom, loyalty value, open payment links, and store scoping of sales data.
 */
import { addDays, addPeriods, newId, periodOf, todayIn } from '@kadai/shared'
import type { Customer, CustomerListItem, CustomerSummary } from '@kadai/shared/api/parties'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postJournal } from '../../../core/ledger'
import { earnPoints } from '../../../core/loyalty'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestProduct } from '../../../test/tenants'
import { api, expectStatus, insertInvoice, postSaleJournal } from './fixtures'

type Data<T> = { data: T }

describe('parties: customer summary', () => {
  let t: TestApp
  let shop: TestShop
  let customer: Customer
  let store2: string
  let today: string
  const d = (n: number) => addDays(today, n)

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, {
      settings: {
        loyalty: { enabled: true, point_value_paise: 50, points_per_100_rupees: 1 },
        credit: { default_credit_days: 30 },
      },
    })
    today = todayIn('Asia/Kolkata')
    customer = expectStatus<Data<Customer>>(
      await shop.inject({
        method: 'POST',
        url: api('/customers'),
        payload: { name: 'Kavitha', credit_limit_paise: 100_000, credit_days: 20 },
      }),
      201,
    ).data
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

    const rice = await insertTestProduct(t.deps, shop.tenant.id, { name: 'Ponni Rice', unit: 'KG' })
    const oil = await insertTestProduct(t.deps, shop.tenant.id, { name: 'Groundnut Oil' })
    const old = await insertInvoice(t, shop, {
      customer_id: customer.id,
      invoice_date: d(-45),
      total_paise: 10_000,
      due_paise: 10_000,
      lines: [
        { product_id: rice.id, name: 'Ponni Rice', qty_milli: 5_000, total_paise: 6_000 },
        { product_id: oil.id, name: 'Groundnut Oil', qty_milli: 1_000, total_paise: 4_000 },
      ],
    })
    await postSaleJournal(shop, {
      invoice_id: old.id,
      customer_id: customer.id,
      amount_paise: 10_000,
      date: d(-45),
    })
    const recent = await insertInvoice(t, shop, {
      customer_id: customer.id,
      invoice_date: d(-5),
      total_paise: 20_000,
      due_paise: 15_000,
      lines: [
        { product_id: rice.id, name: 'Ponni Rice', qty_milli: 10_000, total_paise: 12_000 },
        { name: 'Tailoring charge', qty_milli: 1_000, total_paise: 8_000 },
      ],
    })
    await postSaleJournal(shop, {
      invoice_id: recent.id,
      customer_id: customer.id,
      amount_paise: 15_000,
      date: d(-5),
    })
    // In another store (visible to members with access to every store only).
    await insertInvoice(t, shop, {
      customer_id: customer.id,
      invoice_date: today,
      total_paise: 6_000,
      store_id: store2,
      invoice_at: new Date(),
      lines: [{ product_id: oil.id, name: 'Groundnut Oil', qty_milli: 1_000, total_paise: 6_000 }],
    })
    // Not sales: cancelled, estimate, held.
    await insertInvoice(t, shop, {
      customer_id: customer.id,
      invoice_date: d(-2),
      total_paise: 99_000,
      status: 'cancelled',
    })
    await insertInvoice(t, shop, {
      customer_id: customer.id,
      invoice_date: d(-2),
      total_paise: 77_000,
      doc_type: 'estimate',
    })
    // A return.
    await t.deps.db.systemDb
      .insertInto('credit_notes')
      .values({
        id: newId(),
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        number: `CN${newId().slice(-6)}`,
        fy: '2627',
        note_date: d(-1),
        customer_id: customer.id,
        place_of_supply: '33',
        reason: 'return',
        taxable_paise: 1_000,
        total_paise: 1_000,
        settlement: 'adjust_due',
      })
      .execute()
    // Payment links: one open, one paid, one expired.
    const providerId = newId()
    await t.deps.db.systemDb
      .insertInto('payment_provider_accounts')
      .values({
        id: providerId,
        tenant_id: shop.tenant.id,
        provider: 'mock',
        display_name: 'Mock',
        mode: 'test',
      })
      .execute()
    const link = (status: string, expires: Date | null) => ({
      id: newId(),
      tenant_id: shop.tenant.id,
      store_id: shop.store.id,
      provider_account_id: providerId,
      provider: 'mock',
      kind: 'link',
      purpose: 'customer_due',
      customer_id: customer.id,
      reference_code: `KD${newId().slice(-10).toUpperCase()}`,
      amount_paise: 15_000,
      status,
      short_url: 'https://pay.example/abc',
      expires_at: expires,
    })
    await t.deps.db.systemDb
      .insertInto('payment_intents')
      .values([
        link('created', new Date(Date.now() + 86_400_000)),
        link('paid', null),
        link('created', new Date(Date.now() - 60_000)),
      ])
      .execute()
    await shop.tx((tx) =>
      earnPoints(tx, shop.ctx, {
        customer_id: customer.id,
        points: 40,
        ref_type: 'sales_invoice',
        ref_id: recent.id,
      }),
    )
  })
  afterAll(() => t.close())

  const summary = async (as?: Parameters<TestShop['inject']>[0]['as']) =>
    expectStatus<Data<CustomerSummary>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${customer.id}/summary`), as }),
      200,
    ).data

  it('summarises sales, dues, credit, loyalty and open links', async () => {
    const s = await summary()
    expect(s).toMatchObject({
      customer_id: customer.id,
      lifetime_sales_paise: 36_000,
      invoice_count: 3,
      returns_paise: 1_000,
      average_bill_paise: 12_000,
      balance_paise: 25_000,
      // 45-day-old invoice is past the customer's 20 credit days; the 5-day-old one is not.
      overdue_paise: 10_000,
      overdue_invoice_count: 1,
      oldest_due_date: addDays(d(-45), 20),
      credit_limit_paise: 100_000,
      credit_available_paise: 75_000,
      credit_days: 20,
      loyalty_points: 40,
      loyalty_value_paise: 2_000,
    })
    expect(s.first_invoice_at).not.toBeNull()
    expect(s.last_invoice_at).not.toBeNull()
    expect(s.monthly).toHaveLength(12)
    expect(s.monthly.at(-1)!.period).toBe(periodOf(today))
    expect(s.monthly[0]!.period).toBe(addPeriods(periodOf(today), -11))
    expect(s.monthly.reduce((a, m) => a + m.sales_paise, 0)).toBe(36_000)
    expect(s.monthly.reduce((a, m) => a + m.invoice_count, 0)).toBe(3)
    expect(s.top_items.map((i) => [i.name, i.amount_paise, i.qty_milli, i.invoice_count])).toEqual([
      ['Ponni Rice', 18_000, 15_000, 2],
      ['Groundnut Oil', 10_000, 2_000, 2],
      ['Tailoring charge', 8_000, 1_000, 1],
    ])
    expect(s.top_items[0]!.unit).toBe('KG')
    expect(s.top_items[2]!.product_id).toBeNull()
    expect(s.open_payment_links).toHaveLength(1)
    expect(s.open_payment_links[0]).toMatchObject({ amount_paise: 15_000, status: 'created' })
  })

  it('limits sales figures to the member’s stores (dues stay party-level)', async () => {
    const scoped = await shop.asRole('cashier', { store_ids: [store2] })
    const s = await summary(scoped)
    expect(s).toMatchObject({
      lifetime_sales_paise: 6_000,
      invoice_count: 1,
      returns_paise: 0,
      balance_paise: 25_000,
      overdue_paise: 10_000,
    })
    expect(s.top_items.map((i) => i.name)).toEqual(['Groundnut Oil'])
    expect(s.open_payment_links).toEqual([])
    const list = expectStatus<{ data: CustomerListItem[] }>(
      await shop.inject({ method: 'GET', url: api(`/customers?ids=${customer.id}`), as: scoped }),
      200,
    )
    expect(list.data[0]!.last_invoice_at).not.toBeNull()
    const none = await shop.asRole('cashier', { store_ids: [] })
    const empty = await summary(none)
    expect(empty.invoice_count).toBe(0)
  })

  it('caps overdue at the current due when an unallocated advance offsets old bills', async () => {
    const c = expectStatus<Data<Customer>>(
      await shop.inject({
        method: 'POST',
        url: api('/customers'),
        payload: { name: 'Meenakshi', credit_days: 15 },
      }),
      201,
    ).data
    const inv = await insertInvoice(t, shop, {
      customer_id: c.id,
      invoice_date: d(-40),
      total_paise: 10_000,
      due_paise: 10_000,
    })
    await postSaleJournal(shop, {
      invoice_id: inv.id,
      customer_id: c.id,
      amount_paise: 10_000,
      date: d(-40),
    })
    // Money received without settling the bill (an advance): Dr cash / Cr receivable.
    const receive = (amount: number) =>
      shop.tx((tx) =>
        postJournal(tx, shop.ctx, {
          entry_date: today,
          store_id: shop.store.id,
          source_type: 'payment',
          source_id: newId(),
          narration: 'Advance received',
          lines: [
            { account: { subtype: 'cash' }, debit_paise: amount },
            {
              account: { subtype: 'receivable' },
              credit_paise: amount,
              party: { type: 'customer', id: c.id },
            },
          ],
        }),
      )
    const state = async () => {
      const sum = expectStatus<Data<CustomerSummary>>(
        await shop.inject({ method: 'GET', url: api(`/customers/${c.id}/summary`) }),
        200,
      ).data
      const one = expectStatus<Data<Customer>>(
        await shop.inject({ method: 'GET', url: api(`/customers/${c.id}`) }),
        200,
      ).data
      const overdueList = expectStatus<{ data: CustomerListItem[] }>(
        await shop.inject({ method: 'GET', url: api(`/customers?ids=${c.id}&overdue=true`) }),
        200,
      ).data
      return {
        balance: sum.balance_paise,
        summary: sum.overdue_paise,
        count: sum.overdue_invoice_count,
        detail: one.overdue_paise,
        listed: overdueList.map((x) => x.overdue_paise),
      }
    }
    expect(await state()).toEqual({
      balance: 10_000,
      summary: 10_000,
      count: 1,
      detail: 10_000,
      listed: [10_000],
    })
    await receive(6_000)
    expect(await state()).toEqual({
      balance: 4_000,
      summary: 4_000,
      count: 1,
      detail: 4_000,
      listed: [4_000],
    })
    await receive(5_000)
    expect(await state()).toEqual({ balance: -1_000, summary: 0, count: 0, detail: 0, listed: [] })
  })

  it('answers zeros for a new customer and 404 for unknown ids', async () => {
    const fresh = expectStatus<Data<Customer>>(
      await shop.inject({ method: 'POST', url: api('/customers'), payload: { name: 'New' } }),
      201,
    ).data
    const s = expectStatus<Data<CustomerSummary>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${fresh.id}/summary`) }),
      200,
    ).data
    expect(s).toMatchObject({
      lifetime_sales_paise: 0,
      invoice_count: 0,
      average_bill_paise: 0,
      first_invoice_at: null,
      oldest_due_date: null,
      credit_available_paise: null,
      credit_days: 30,
      top_items: [],
    })
    expect(s.monthly.every((m) => m.sales_paise === 0)).toBe(true)
    const missing = await shop.inject({
      method: 'GET',
      url: api(`/customers/${newId()}/summary`),
    })
    expect(missing.statusCode).toBe(404)
  })
})
