/**
 * Suppliers API: CRUD, bank details sanitisation (never a full account number), UPI VPA, GSTIN /
 * PAN rules, payable opening balance journals, list with dues, delete vs deactivate, permissions
 * and tenant isolation.
 */
import { addDays, makeGstin, newId, todayIn } from '@kadai/shared'
import type { Supplier, SupplierListItem } from '@kadai/shared/api/parties'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { api, auditActions, expectStatus, openingEntries, partyBalances } from './fixtures'

type Data<T> = { data: T }
type List<T> = { data: T[]; page: { limit: number; offset: number; total: number } }

describe('parties: suppliers', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let today: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { business_type: 'pharmacy' })
    other = await createTestTenant(t)
    today = todayIn('Asia/Kolkata')
  })
  afterAll(() => t.close())

  const create = async (payload: Record<string, unknown>, as: TestShop = shop) =>
    expectStatus<Data<Supplier>>(
      await as.inject({ method: 'POST', url: api('/suppliers'), payload }),
      201,
    ).data

  const storedBank = async (id: string) =>
    (
      await t.deps.db.systemDb
        .selectFrom('suppliers')
        .select('bank_details')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).bank_details

  it('creates a supplier and stores only the last 4 digits of the bank account', async () => {
    const gstin = makeGstin('33', 'AAFCS1234K')
    const s = await create({
      name: 'Sri Balaji Pharma Distributors',
      contact_person: 'Ramesh',
      phone: '9840012345',
      gstin,
      drug_license_no: 'TN/MDU/20B/1234',
      payment_terms_days: 30,
      bank_details: {
        account_name: 'Sri Balaji Pharma',
        account_number: '1234 5678 9012',
        ifsc: 'hdfc0001234',
        bank_name: 'HDFC Bank',
      },
      upi_vpa: 'SriBalaji@OKAXIS',
    })
    expect(s).toMatchObject({
      phone: '+919840012345',
      gstin,
      state_code: '33',
      pan: 'AAFCS1234K',
      drug_license_no: 'TN/MDU/20B/1234',
      payment_terms_days: 30,
      upi_vpa: 'sribalaji@okaxis',
      balance_paise: 0,
      overdue_paise: 0,
      last_bill_date: null,
      bank_details: {
        account_name: 'Sri Balaji Pharma',
        account_no_last4: '9012',
        ifsc: 'HDFC0001234',
        bank_name: 'HDFC Bank',
      },
    })
    expect(JSON.stringify(s)).not.toContain('123456789012')
    expect(await storedBank(s.id)).toEqual({
      account_name: 'Sri Balaji Pharma',
      account_no_last4: '9012',
      ifsc: 'HDFC0001234',
      bank_name: 'HDFC Bank',
    })
    expect(await auditActions(t, shop, s.id)).toEqual(['supplier.create'])
  })

  it('merges bank details on PATCH and can clear them', async () => {
    const s = await create({
      name: 'Merge Bank',
      bank_details: { account_number: '000011112222', ifsc: 'SBIN0000001' },
    })
    const kept = expectStatus<Data<Supplier>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/suppliers/${s.id}`),
        payload: { bank_details: { bank_name: 'State Bank of India' } },
      }),
      200,
    ).data
    expect(kept.bank_details).toEqual({
      account_name: null,
      account_no_last4: '2222',
      ifsc: 'SBIN0000001',
      bank_name: 'State Bank of India',
    })
    const replaced = expectStatus<Data<Supplier>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/suppliers/${s.id}`),
        payload: { bank_details: { account_number: '9999888877776666' } },
      }),
      200,
    ).data
    expect(replaced.bank_details.account_no_last4).toBe('6666')
    const cleared = expectStatus<Data<Supplier>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/suppliers/${s.id}`),
        payload: { bank_details: { account_number: null, ifsc: null } },
      }),
      200,
    ).data
    expect(cleared.bank_details).toMatchObject({ account_no_last4: null, ifsc: null })
    expect(JSON.stringify(await storedBank(s.id))).not.toMatch(/9999888877776666|000011112222/)
  })

  it('validates IFSC, account number, unknown bank keys, VPA and PAN', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ bank_details: { ifsc: 'HDFC1234567' } }, 'ifsc'],
      [{ bank_details: { account_number: '12AB' } }, 'bank_account_number'],
      [{ bank_details: { account_no: '1234567890' } }, ''],
      [{ upi_vpa: 'not-a-vpa' }, 'vpa'],
      [{ gstin: makeGstin('33', 'AAFCS1234K'), pan: 'ABCPE1234F' }, 'pan_gstin_mismatch'],
    ]
    for (const [extra, message] of cases) {
      const res = await shop.inject({
        method: 'POST',
        url: api('/suppliers'),
        payload: { name: 'Bad', ...extra },
      })
      expect(res.statusCode, JSON.stringify(extra)).toBe(400)
      if (message)
        expect(
          JSON.parse(res.body).error.details.issues.map((i: { message: string }) => i.message),
        ).toContain(message)
    }
    const s = await create({ name: 'PAN later', gstin: makeGstin('33', 'AAFCS1234K') })
    const res = await shop.inject({
      method: 'PATCH',
      url: api(`/suppliers/${s.id}`),
      payload: { pan: 'ABCPE1234F' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error.details.issues[0]).toMatchObject({
      path: 'pan',
      message: 'pan_gstin_mismatch',
    })
  })

  it('posts the payable opening balance and later deltas (accounting permission)', async () => {
    const s = await create({ name: 'Opening', opening_balance_paise: 40_000 })
    expect(s.balance_paise).toBe(40_000)
    expect(await openingEntries(t, shop, s.id)).toEqual([
      { subtype: 'payable', debit_paise: 0, credit_paise: 40_000 },
      { subtype: 'opening_balance', debit_paise: 40_000, credit_paise: 0 },
    ])
    const clerk = await shop.asRole('inventory_clerk')
    const denied = await shop.inject({
      method: 'PATCH',
      url: api(`/suppliers/${s.id}`),
      payload: { opening_balance_paise: 0 },
      as: clerk,
    })
    expect(denied.statusCode).toBe(403)
    expect(JSON.parse(denied.body).error.details.reason).toBe('opening_balance_permission')
    const changed = expectStatus<Data<Supplier>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/suppliers/${s.id}`),
        payload: { opening_balance_paise: 45_000 },
      }),
      200,
    ).data
    expect(changed).toMatchObject({ opening_balance_paise: 45_000, balance_paise: 45_000 })
    expect((await openingEntries(t, shop, s.id)).slice(2)).toEqual([
      { subtype: 'payable', debit_paise: 0, credit_paise: 5_000 },
      { subtype: 'opening_balance', debit_paise: 5_000, credit_paise: 0 },
    ])
    expect(await partyBalances(t, shop, 'supplier', s.id)).toEqual({
      ledger: 45_000,
      stored: 45_000,
    })
    const advance = await create({ name: 'Advance paid', opening_balance_paise: -3_000 })
    expect(await partyBalances(t, shop, 'supplier', advance.id)).toEqual({
      ledger: -3_000,
      stored: -3_000,
    })
    // The clerk may still create suppliers with an opening balance and edit other fields.
    const own = expectStatus<Data<Supplier>>(
      await shop.inject({
        method: 'POST',
        url: api('/suppliers'),
        payload: { name: 'By clerk', opening_balance_paise: 1_000 },
        as: clerk,
      }),
      201,
    ).data
    expect(
      (
        await shop.inject({
          method: 'PATCH',
          url: api(`/suppliers/${own.id}`),
          payload: { notes: 'Calls on Monday', if_updated_at: own.updated_at },
          as: clerk,
        })
      ).statusCode,
    ).toBe(200)
  })

  describe('list', () => {
    let list: TestShop
    const ids: Record<string, string> = {}

    beforeAll(async () => {
      list = await createTestTenant(t)
      ids.anand = (
        await create({ name: 'Anand Agencies', contact_person: 'Kumar', phone: '9876500011' }, list)
      ).id
      ids.bharat = (
        await create(
          {
            name: 'Bharat Wholesale',
            gstin: makeGstin('33', 'AABCB1234D'),
            opening_balance_paise: 70_000,
          },
          list,
        )
      ).id
      ids.chola = (await create({ name: 'Chola Traders', opening_balance_paise: 10_000 }, list)).id
      // A posted bill of Chola past its due date (overdue) and a newer one of Bharat not yet due.
      const bill = (supplierId: string, due: string, received: string, duePaise: number) => ({
        id: newId(),
        tenant_id: list.tenant.id,
        store_id: list.store.id,
        supplier_id: supplierId,
        number: `GRN${newId().slice(-6)}`,
        fy: '2627',
        supplier_invoice_no: `S-${newId().slice(-6)}`,
        supplier_invoice_date: received,
        received_date: received,
        due_date: due,
        status: 'posted',
        taxable_paise: duePaise,
        total_paise: duePaise,
        due_paise: duePaise,
      })
      await t.deps.db.systemDb
        .insertInto('purchase_bills')
        .values([
          bill(ids.chola!, addDays(today, -1), addDays(today, -31), 10_000),
          bill(ids.bharat!, addDays(today, 10), addDays(today, -2), 20_000),
        ])
        .execute()
    })

    const get = async (qs: string) =>
      expectStatus<List<SupplierListItem>>(
        await list.inject({ method: 'GET', url: api(`/suppliers?${qs}`) }),
        200,
      )
    const names = (l: List<SupplierListItem>) => l.data.map((s) => s.name)

    it('filters, searches and sorts', async () => {
      expect(names(await get(''))).toEqual(['Anand Agencies', 'Bharat Wholesale', 'Chola Traders'])
      expect(names(await get('has_due=true'))).toEqual(['Bharat Wholesale', 'Chola Traders'])
      expect(names(await get('has_due=false'))).toEqual(['Anand Agencies'])
      expect(names(await get('overdue=true'))).toEqual(['Chola Traders'])
      expect(names(await get('q=kumar'))).toEqual(['Anand Agencies'])
      expect(names(await get('q=98765'))).toEqual(['Anand Agencies'])
      expect(names(await get('q=33AABCB'))).toEqual(['Bharat Wholesale'])
      expect(names(await get('sort=-balance_paise'))).toEqual([
        'Bharat Wholesale',
        'Chola Traders',
        'Anand Agencies',
      ])
      expect(names(await get('sort=-last_bill_date'))).toEqual([
        'Bharat Wholesale',
        'Chola Traders',
        'Anand Agencies',
      ])
      const all = await get('')
      expect(all.data.find((s) => s.id === ids.chola)).toMatchObject({
        overdue_paise: 10_000,
        last_bill_date: addDays(today, -31),
      })
      expect(all.data.find((s) => s.id === ids.bharat)!.overdue_paise).toBe(0)
    })

    it('never shows another tenant’s suppliers', async () => {
      const foreign = await create({ name: 'Anand Foreign' }, other)
      expect(names(await get('q=anand'))).toEqual(['Anand Agencies'])
      expect(
        (await list.inject({ method: 'GET', url: api(`/suppliers/${foreign.id}`) })).statusCode,
      ).toBe(404)
    })

    it('deletes a supplier without history and deactivates one with bills', async () => {
      const del = expectStatus<Data<{ id: string; result: string }>>(
        await list.inject({ method: 'DELETE', url: api(`/suppliers/${ids.anand}`) }),
        200,
      )
      expect(del.data.result).toBe('deleted')
      const deact = expectStatus<Data<{ id: string; result: string }>>(
        await list.inject({ method: 'DELETE', url: api(`/suppliers/${ids.chola}`) }),
        200,
      )
      expect(deact.data.result).toBe('deactivated')
      expect(names(await get('is_active=false'))).toEqual(['Chola Traders'])
    })
  })

  it('takes the PAN from a changed GSTIN unless the PATCH sets one', async () => {
    const first = makeGstin('33', 'AAFCK4321M')
    const s = await create({ name: 'Kaveri Distributors', gstin: first })
    expect(s.pan).toBe('AAFCK4321M')
    const moved = makeGstin('29', 'AAFCK4321M')
    const sameOwner = expectStatus<Data<Supplier>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/suppliers/${s.id}`),
        payload: { gstin: moved },
      }),
      200,
    ).data
    expect(sameOwner).toMatchObject({ gstin: moved, state_code: '29', pan: 'AAFCK4321M' })
    const other = makeGstin('33', 'BBGCK9876Q')
    const changed = expectStatus<Data<Supplier>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/suppliers/${s.id}`),
        payload: { gstin: other },
      }),
      200,
    ).data
    expect(changed).toMatchObject({ gstin: other, state_code: '33', pan: 'BBGCK9876Q' })
    const mismatch = await shop.inject({
      method: 'PATCH',
      url: api(`/suppliers/${s.id}`),
      payload: { gstin: first, pan: 'BBGCK9876Q' },
    })
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.body).toContain('pan_gstin_mismatch')
  })

  it('dates bills without a due date by the payment terms and caps overdue at the payable', async () => {
    const own = await createTestTenant(t)
    const termed = await create(
      { name: 'Deepam Oils', payment_terms_days: 15, opening_balance_paise: 50_000 },
      own,
    )
    const cash = await create({ name: 'Ezhil Traders', opening_balance_paise: 1_000 }, own)
    const bill = (supplierId: string, invoiceDate: string, duePaise: number) => ({
      id: newId(),
      tenant_id: own.tenant.id,
      store_id: own.store.id,
      supplier_id: supplierId,
      number: `GRN${newId().slice(-6)}`,
      fy: '2627',
      supplier_invoice_no: `S-${newId().slice(-6)}`,
      supplier_invoice_date: invoiceDate,
      received_date: invoiceDate,
      due_date: null,
      status: 'posted',
      taxable_paise: duePaise,
      total_paise: duePaise,
      due_paise: duePaise,
    })
    await t.deps.db.systemDb
      .insertInto('purchase_bills')
      .values([
        // Within the 15 days of credit: not overdue yet.
        bill(termed.id, addDays(today, -10), 8_000),
        // 20 days old: past the terms.
        bill(termed.id, addDays(today, -20), 3_000),
        // No terms: due on the invoice date, but only ₹10 is still owed (an advance was paid).
        bill(cash.id, addDays(today, -1), 4_000),
      ])
      .execute()
    const list = expectStatus<List<SupplierListItem>>(
      await own.inject({ method: 'GET', url: api('/suppliers') }),
      200,
    )
    const overdue = Object.fromEntries(list.data.map((x) => [x.name, x.overdue_paise]))
    expect(overdue).toEqual({ 'Deepam Oils': 3_000, 'Ezhil Traders': 1_000 })
    const detail = expectStatus<Data<Supplier>>(
      await own.inject({ method: 'GET', url: api(`/suppliers/${cash.id}`) }),
      200,
    )
    expect(detail.data.overdue_paise).toBe(1_000)
  })

  it('enforces suppliers.read / suppliers.write', async () => {
    const s = await create({ name: 'Perm check' })
    const cashier = await shop.asRole('cashier')
    for (const [method, url, payload] of [
      ['GET', api('/suppliers'), undefined],
      ['GET', api(`/suppliers/${s.id}`), undefined],
      ['POST', api('/suppliers'), { name: 'x' }],
      ['PATCH', api(`/suppliers/${s.id}`), { name: 'x' }],
      ['DELETE', api(`/suppliers/${s.id}`), undefined],
    ] as const) {
      const res = await shop.inject({ method, url, payload, as: cashier })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    const accountant = await shop.asRole('accountant')
    expect(
      (await shop.inject({ method: 'GET', url: api(`/suppliers/${s.id}`), as: accountant }))
        .statusCode,
    ).toBe(200)
    expect(
      (
        await shop.inject({
          method: 'PATCH',
          url: api(`/suppliers/${s.id}`),
          payload: { name: 'x' },
          as: accountant,
        })
      ).statusCode,
    ).toBe(403)
  })
})
