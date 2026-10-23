/**
 * Khata / supplier statements and the balance invariant: customers.balance_paise equals the sum
 * of the party's receivable lines after opening balances, sales, receipts and opening changes;
 * running balances, from/to windows, document numbers, CSV export and truncation.
 */
import { addDays, newId, todayIn } from '@kadai/shared'
import type { Customer, PartyLedger, Supplier } from '@kadai/shared/api/parties'
import { LEDGER_MAX_ROWS } from '@kadai/shared/api/parties'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postJournal, systemAccountId } from '../../../core/ledger'
import { recordPayment } from '../../../core/payments'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  api,
  auditActions,
  expectStatus,
  insertInvoice,
  partyBalances,
  postSaleJournal,
} from './fixtures'

type Data<T> = { data: T }

describe('parties: ledger statements', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let today: string
  let customer: Customer
  let sale1: { id: string; number: string }
  let receiptNumber: string | null
  const d = (days: number) => addDays(today, days)

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    today = todayIn('Asia/Kolkata')

    customer = expectStatus<Data<Customer>>(
      await shop.inject({
        method: 'POST',
        url: api('/customers'),
        payload: { name: 'Selvi', opening_balance_paise: 10_000 },
      }),
      201,
    ).data
    sale1 = await insertInvoice(t, shop, {
      customer_id: customer.id,
      invoice_date: d(-30),
      total_paise: 20_000,
      due_paise: 20_000,
    })
    await postSaleJournal(shop, {
      invoice_id: sale1.id,
      customer_id: customer.id,
      amount_paise: 20_000,
      date: d(-30),
    })
    const sale2 = await insertInvoice(t, shop, {
      customer_id: customer.id,
      invoice_date: d(-10),
      total_paise: 5_000,
      due_paise: 5_000,
    })
    await postSaleJournal(shop, {
      invoice_id: sale2.id,
      customer_id: customer.id,
      amount_paise: 5_000,
      date: d(-10),
    })
    const receipt = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        method: 'cash',
        amount_paise: 8_000,
        payment_date: d(-5),
        party: { type: 'customer', id: customer.id },
        number: true,
      }),
    )
    receiptNumber = receipt.number
    const patched = await shop.inject({
      method: 'PATCH',
      url: api(`/customers/${customer.id}`),
      payload: { opening_balance_paise: 12_000 },
    })
    expect(patched.statusCode, patched.body).toBe(200)
  })
  afterAll(() => t.close())

  const statement = async (id: string, qs = '', kind = 'customers') =>
    expectStatus<Data<PartyLedger>>(
      await shop.inject({ method: 'GET', url: api(`/${kind}/${id}/ledger${qs}`) }),
      200,
    ).data

  it('keeps balance_paise equal to the receivable lines after several operations', async () => {
    expect(await partyBalances(t, shop, 'customer', customer.id)).toEqual({
      ledger: 29_000,
      stored: 29_000,
    })
    const got = expectStatus<Data<Customer>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${customer.id}`) }),
      200,
    ).data
    expect(got).toMatchObject({ balance_paise: 29_000, opening_balance_paise: 12_000 })
  })

  it('builds the full statement with running balances and document numbers', async () => {
    const st = await statement(customer.id)
    expect(st.party).toMatchObject({ type: 'customer', id: customer.id, name: 'Selvi' })
    expect(st.from).toBeNull()
    expect(st.to).toBe(today)
    expect(st.opening_balance_paise).toBe(0)
    expect(
      st.rows.map((r) => [r.date, r.source_type, r.debit_paise, r.credit_paise, r.balance_paise]),
    ).toEqual([
      [d(-30), 'sales_invoice', 20_000, 0, 20_000],
      [d(-10), 'sales_invoice', 5_000, 0, 25_000],
      [d(-5), 'payment', 0, 8_000, 17_000],
      [today, 'opening', 10_000, 0, 27_000],
      [today, 'opening', 2_000, 0, 29_000],
    ])
    expect(st.rows[0]!.document_number).toBe(sale1.number)
    expect(st.rows[2]!.document_number).toBe(receiptNumber)
    expect(receiptNumber).toBeTruthy()
    expect(st.rows[0]!.description).toBe('Credit sale')
    expect(st).toMatchObject({
      total_debit_paise: 37_000,
      total_credit_paise: 8_000,
      closing_balance_paise: 29_000,
      truncated: false,
    })
  })

  it('windows the statement with from / to (opening = everything before from)', async () => {
    const st = await statement(customer.id, `?from=${d(-10)}&to=${d(-5)}`)
    expect(st.opening_balance_paise).toBe(20_000)
    expect(st.rows.map((r) => r.balance_paise)).toEqual([25_000, 17_000])
    expect(st).toMatchObject({
      from: d(-10),
      to: d(-5),
      total_debit_paise: 5_000,
      total_credit_paise: 8_000,
      closing_balance_paise: 17_000,
    })
    const quiet = await statement(customer.id, `?from=${d(-20)}&to=${d(-15)}`)
    expect(quiet.rows).toEqual([])
    expect(quiet.opening_balance_paise).toBe(20_000)
    expect(quiet.closing_balance_paise).toBe(20_000)
    const tail = await statement(customer.id, `?from=${d(-4)}`)
    expect(tail.opening_balance_paise).toBe(17_000)
    expect(tail.closing_balance_paise).toBe(29_000)
    expect(tail.to).toBe(today)

    const bad = await shop.inject({
      method: 'GET',
      url: api(`/customers/${customer.id}/ledger?from=${d(-1)}&to=${d(-2)}`),
    })
    expect(bad.statusCode).toBe(400)
  })

  it('exports the statement as CSV (audited)', async () => {
    const res = await shop.inject({
      method: 'GET',
      url: api(`/customers/${customer.id}/ledger?format=csv&from=${d(-10)}`),
      headers: { 'x-locale': 'en' },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="khata-selvi-/)
    // UTF-8 BOM so Excel shows Tamil text correctly.
    expect(res.body.startsWith('\uFEFF')).toBe(true)
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(lines[0]).toBe('Date,Type,Document no.,Description,Debit (₹),Credit (₹),Balance (₹)')
    expect(lines[1]).toContain('Opening balance')
    expect(lines[1]!.endsWith(',200.00')).toBe(true)
    expect(lines.at(-1)).toContain('Closing balance')
    expect(lines.at(-1)!.endsWith(',290.00')).toBe(true)
    expect(lines).toHaveLength(2 + 4 + 1)
    expect(await auditActions(t, shop, customer.id)).toContain('customer.ledger_export')

    const ta = await shop.inject({
      method: 'GET',
      url: api(`/customers/${customer.id}/ledger?format=csv`),
      headers: { 'x-locale': 'ta' },
    })
    expect(ta.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toContain('தேதி')
  })

  it('truncates very long statements but keeps totals and closing balance exact', async () => {
    const id = newId()
    await t.deps.db.systemDb
      .insertInto('customers')
      .values({ id, tenant_id: shop.tenant.id, name: 'Bulk' })
      .execute()
    const receivable = await shop.tx((tx) => systemAccountId(tx, shop.ctx, 'receivable'))
    const sales = await shop.tx((tx) => systemAccountId(tx, shop.ctx, 'sales'))
    const n = LEDGER_MAX_ROWS + 2
    const entries = Array.from({ length: n }, () => newId())
    // Chunked: one statement may carry at most 65535 bind parameters.
    const chunks = <T>(items: T[], size: number) =>
      Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
        items.slice(i * size, (i + 1) * size),
      )
    await t.deps.db.systemDb.transaction().execute(async (trx) => {
      for (const part of chunks(entries, 1000)) {
        await trx
          .insertInto('journal_entries')
          .values(
            part.map((e) => ({
              id: e,
              tenant_id: shop.tenant.id,
              entry_date: d(-1),
              source_type: 'manual',
            })),
          )
          .execute()
        await trx
          .insertInto('journal_lines')
          .values(
            part.flatMap((e) => [
              {
                id: newId(),
                tenant_id: shop.tenant.id,
                entry_id: e,
                account_id: receivable,
                debit_paise: 100,
                party_type: 'customer',
                party_id: id,
                entry_date: d(-1),
              },
              {
                id: newId(),
                tenant_id: shop.tenant.id,
                entry_id: e,
                account_id: sales,
                credit_paise: 100,
                entry_date: d(-1),
              },
            ]),
          )
          .execute()
      }
    })
    const st = await statement(id)
    expect(st.truncated).toBe(true)
    expect(st.rows).toHaveLength(LEDGER_MAX_ROWS)
    expect(st.rows.at(-1)!.balance_paise).toBe(LEDGER_MAX_ROWS * 100)
    expect(st.total_debit_paise).toBe(n * 100)
    expect(st.closing_balance_paise).toBe(n * 100)
  })

  it('is tenant-isolated and permission-checked', async () => {
    const res = await other.inject({ method: 'GET', url: api(`/customers/${customer.id}/ledger`) })
    expect(res.statusCode).toBe(404)
    const clerk = await shop.asRole('inventory_clerk')
    const denied = await shop.inject({
      method: 'GET',
      url: api(`/customers/${customer.id}/ledger`),
      as: clerk,
    })
    expect(denied.statusCode).toBe(403)
  })

  describe('supplier statement', () => {
    let supplier: Supplier
    let billNo: string

    beforeAll(async () => {
      supplier = expectStatus<Data<Supplier>>(
        await shop.inject({
          method: 'POST',
          url: api('/suppliers'),
          payload: { name: 'Sri Murugan Agencies', opening_balance_paise: 50_000 },
        }),
        201,
      ).data
      const billId = newId()
      billNo = `INV-${billId.slice(-5)}`
      await t.deps.db.systemDb
        .insertInto('purchase_bills')
        .values({
          id: billId,
          tenant_id: shop.tenant.id,
          store_id: shop.store.id,
          supplier_id: supplier.id,
          number: `GRN${billId.slice(-6)}`,
          fy: '2627',
          supplier_invoice_no: billNo,
          supplier_invoice_date: d(-3),
          received_date: d(-3),
          status: 'posted',
          taxable_paise: 30_000,
          total_paise: 30_000,
          due_paise: 30_000,
        })
        .execute()
      await shop.tx((tx) =>
        postJournal(tx, shop.ctx, {
          entry_date: d(-3),
          store_id: shop.store.id,
          source_type: 'purchase_bill',
          source_id: billId,
          lines: [
            { account: { subtype: 'inventory' }, debit_paise: 30_000 },
            {
              account: { subtype: 'payable' },
              credit_paise: 30_000,
              party: { type: 'supplier', id: supplier.id },
            },
          ],
        }),
      )
      await shop.tx((tx) =>
        recordPayment(tx, shop.ctx, {
          direction: 'out',
          store_id: shop.store.id,
          method: 'cash',
          amount_paise: 20_000,
          payment_date: d(-1),
          party: { type: 'supplier', id: supplier.id },
          number: true,
        }),
      )
    })

    it('runs on the payable account (+ = the shop owes the supplier)', async () => {
      expect(await partyBalances(t, shop, 'supplier', supplier.id)).toEqual({
        ledger: 60_000,
        stored: 60_000,
      })
      const st = await statement(supplier.id, '', 'suppliers')
      expect(
        st.rows.map((r) => [r.source_type, r.debit_paise, r.credit_paise, r.balance_paise]),
      ).toEqual([
        ['purchase_bill', 0, 30_000, 30_000],
        ['payment', 20_000, 0, 10_000],
        ['opening', 0, 50_000, 60_000],
      ])
      expect(st.rows[0]!.document_number).toBe(billNo)
      expect(st.closing_balance_paise).toBe(60_000)
      const windowed = await statement(supplier.id, `?from=${d(-2)}`, 'suppliers')
      expect(windowed.opening_balance_paise).toBe(30_000)
      expect(windowed.rows.map((r) => r.balance_paise)).toEqual([10_000, 60_000])
    })

    it('exports CSV and needs suppliers.read', async () => {
      const csv = await shop.inject({
        method: 'GET',
        url: api(`/suppliers/${supplier.id}/ledger?format=csv`),
      })
      expect(csv.statusCode).toBe(200)
      expect(csv.headers['content-disposition']).toContain('supplier-ledger-sri-murugan-agencies')
      const cashier = await shop.asRole('cashier')
      const denied = await shop.inject({
        method: 'GET',
        url: api(`/suppliers/${supplier.id}/ledger`),
        as: cashier,
      })
      expect(denied.statusCode).toBe(403)
    })
  })
})
