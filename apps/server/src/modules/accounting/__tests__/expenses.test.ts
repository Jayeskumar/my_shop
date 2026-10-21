/**
 * Expenses API: GST maths (inclusive / exclusive, intra / inter-state), postings with and
 * without ITC, cash / bank / credit (supplier balance), shift attachment, list filters + summary
 * + CSV, detail with supplier payments, cancellation (reversal, 409 with payments), validation,
 * permissions, feature availability on every plan and tenant isolation.
 */
import { newId } from '@kadai/shared'
import type {
  ExpenseDetail,
  ExpenseListResponse,
  JournalEntryDetail,
  ShiftDetail,
} from '@kadai/shared/api/accounting'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancelPayment } from '../../../core/payments'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  type Data,
  accountByCode,
  accountId,
  api,
  auditActions,
  expectError,
  get,
  newSupplier,
  pay,
  post,
  today,
} from './fixtures'

describe('accounting: expenses', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let electricity: string
  let rent: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    electricity = await accountByCode(t, shop, '5310')
    rent = await accountByCode(t, shop, '5300')
  })
  afterAll(() => t.close())

  const base = () => ({ store_id: shop.store.id, expense_date: today() })
  const journalOf = async (expense: ExpenseDetail) =>
    (await get<Data<JournalEntryDetail>>(shop, `/journal-entries/${expense.journal_entry_id}`)).data

  it('records a cash expense with ITC: Dr expense + input tax / Cr cash', async () => {
    const e = (
      await post<Data<ExpenseDetail>>(shop, '/expenses', {
        ...base(),
        expense_account_id: electricity,
        description: 'TNEB bill October',
        total_paise: 11_800,
        gst_rate_bp: 1800,
        itc_eligible: true,
        payment_method: 'cash',
        reference: 'TNEB-123',
      })
    ).data
    expect(e.number).toMatch(/^EXPS1\/\d{4}\/\d+$/)
    expect(e).toMatchObject({
      taxable_paise: 10_000,
      cgst_paise: 900,
      sgst_paise: 900,
      igst_paise: 0,
      tax_paise: 1_800,
      total_paise: 11_800,
      is_interstate: false,
      status: 'posted',
      paid_from_account_id: await accountId(t, shop, 'cash'),
      paid_paise: 11_800,
      due_paise: 0,
      can_cancel: true,
      shift_id: null,
      expense_account_code: '5310',
    })
    const j = await journalOf(e)
    expect(j.source).toMatchObject({
      type: 'expense',
      id: e.id,
      number: e.number,
      path: `/accounting/expenses?id=${e.id}`,
    })
    const by = Object.fromEntries(j.lines.map((l) => [l.account_subtype ?? l.account_code, l]))
    expect(by['5310']).toMatchObject({ debit_paise: 10_000 })
    expect(by.input_cgst).toMatchObject({ debit_paise: 900 })
    expect(by.input_sgst).toMatchObject({ debit_paise: 900 })
    expect(by.cash).toMatchObject({ credit_paise: 11_800, memo: 'TNEB-123' })
    expect(await auditActions(t, shop)).toContain('expense.create')
  })

  it('without ITC the whole bill is the expense; exclusive amounts and IGST from the supplier state', async () => {
    const noItc = (
      await post<Data<ExpenseDetail>>(shop, '/expenses', {
        ...base(),
        expense_account_id: rent,
        total_paise: 5_900,
        gst_rate_bp: 1800,
        payment_method: 'cash',
      })
    ).data
    const j = await journalOf(noItc)
    expect(j.lines).toHaveLength(2)
    expect(j.lines.find((l) => l.account_code === '5300')?.debit_paise).toBe(5_900)

    const karnataka = await newSupplier(t, shop, '29')
    const inter = (
      await post<Data<ExpenseDetail>>(shop, '/expenses', {
        ...base(),
        expense_account_id: electricity,
        taxable_paise: 10_000,
        gst_rate_bp: 1800,
        itc_eligible: true,
        payment_method: 'upi',
        supplier_id: karnataka.id,
      })
    ).data
    expect(inter).toMatchObject({
      taxable_paise: 10_000,
      igst_paise: 1_800,
      cgst_paise: 0,
      total_paise: 11_800,
      is_interstate: true,
      paid_from_account_id: await accountId(t, shop, 'bank'),
      supplier_name: karnataka.name,
    })
    const ji = await journalOf(inter)
    expect(ji.lines.find((l) => l.account_subtype === 'input_igst')?.debit_paise).toBe(1_800)
    expect(ji.lines.find((l) => l.account_subtype === 'bank')?.credit_paise).toBe(11_800)
  })

  it('on credit: Cr payable(supplier), paid later through supplier payments; cancel guarded', async () => {
    const supplier = await newSupplier(t, shop)
    const e = (
      await post<Data<ExpenseDetail>>(shop, '/expenses', {
        ...base(),
        expense_account_id: await accountByCode(t, shop, '5330'),
        total_paise: 20_000,
        payment_method: 'credit',
        supplier_id: supplier.id,
      })
    ).data
    expect(e).toMatchObject({ paid_from_account_id: null, paid_paise: 0, due_paise: 20_000 })
    const balance = async () =>
      (
        await t.deps.db.systemDb
          .selectFrom('suppliers')
          .select('balance_paise')
          .where('id', '=', supplier.id)
          .executeTakeFirstOrThrow()
      ).balance_paise
    expect(await balance()).toBe(20_000)
    const j = await journalOf(e)
    expect(j.lines.find((l) => l.account_subtype === 'payable')).toMatchObject({
      credit_paise: 20_000,
      party_type: 'supplier',
      party_id: supplier.id,
      party_name: supplier.name,
    })

    const payment = await pay(shop, {
      direction: 'out',
      store_id: shop.store.id,
      method: 'cash',
      amount_paise: 5_000,
      payment_date: today(),
      party: { type: 'supplier', id: supplier.id },
      allocations: [{ target_type: 'expense', target_id: e.id, amount_paise: 5_000 }],
    })
    const detail = (await get<Data<ExpenseDetail>>(shop, `/expenses/${e.id}`)).data
    expect(detail).toMatchObject({ paid_paise: 5_000, due_paise: 15_000, can_cancel: false })
    expect(detail.payments).toEqual([
      expect.objectContaining({ payment_id: payment.id, method: 'cash', amount_paise: 5_000 }),
    ])
    expect(await balance()).toBe(15_000)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/expenses/${e.id}/cancel`),
        payload: { reason: 'Wrong supplier' },
      }),
      409,
      'CONFLICT',
      'expense_has_payments',
    )
    await shop.tx((tx) =>
      cancelPayment(tx, shop.ctx, { payment_id: payment.id, reason: 'Paid by mistake' }),
    )
    const cancelled = (
      await post<Data<ExpenseDetail>>(
        shop,
        `/expenses/${e.id}/cancel`,
        { reason: 'Wrong supplier' },
        200,
      )
    ).data
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'Wrong supplier',
      due_paise: 0,
      can_cancel: false,
    })
    expect(cancelled.reversal_entry_id).not.toBeNull()
    expect(cancelled.cancelled_by_name).toBe(shop.owner.user.full_name)
    expect(await balance()).toBe(0)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/expenses/${e.id}/cancel`),
        payload: { reason: 'Again please' },
      }),
      409,
      'CONFLICT',
      'expense_cancelled',
    )
    expect(await auditActions(t, shop)).toContain('expense.cancel')
  })

  it('validates amounts, categories, accounts and ITC eligibility', async () => {
    const bad = async (
      payload: Record<string, unknown>,
      status: number,
      code: string,
      reason?: string,
    ) =>
      expectError(
        await shop.inject({
          method: 'POST',
          url: api('/expenses'),
          payload: { ...base(), expense_account_id: rent, payment_method: 'cash', ...payload },
        }),
        status,
        code,
        reason,
      )
    await bad({}, 400, 'VALIDATION_ERROR')
    await bad({ total_paise: 100, taxable_paise: 100 }, 400, 'VALIDATION_ERROR')
    await bad({ total_paise: 100, itc_eligible: true }, 400, 'VALIDATION_ERROR')
    await bad({ total_paise: 100, gst_rate_bp: 1700 }, 400, 'VALIDATION_ERROR')
    await bad({ total_paise: 100, payment_method: 'credit' }, 400, 'VALIDATION_ERROR')
    const supplier = await newSupplier(t, shop)
    await bad(
      {
        total_paise: 100,
        payment_method: 'credit',
        supplier_id: supplier.id,
        paid_from_account_id: await accountId(t, shop, 'cash'),
      },
      400,
      'VALIDATION_ERROR',
    )
    await bad(
      { total_paise: 100, expense_account_id: await accountId(t, shop, 'cash') },
      422,
      'UNPROCESSABLE',
      'expense_account_required',
    )
    await bad(
      { total_paise: 100, expense_account_id: await accountId(t, shop, 'cogs') },
      422,
      'UNPROCESSABLE',
      'expense_account_required',
    )
    await bad(
      { total_paise: 100, paid_from_account_id: await accountId(t, shop, 'bank') },
      422,
      'UNPROCESSABLE',
      'money_account_required',
    )
    await bad({ total_paise: 100, supplier_id: newId() }, 404, 'NOT_FOUND')
    await bad({ total_paise: 100, store_id: other.store.id }, 404, 'NOT_FOUND')

    const composition = await createTestTenant(t, { gst_scheme: 'composition' })
    expectError(
      await composition.inject({
        method: 'POST',
        url: api('/expenses'),
        payload: {
          store_id: composition.store.id,
          expense_date: today(),
          expense_account_id: await accountByCode(t, composition, '5310'),
          total_paise: 11_800,
          gst_rate_bp: 1800,
          itc_eligible: true,
          payment_method: 'cash',
        },
      }),
      422,
      'UNPROCESSABLE',
      'itc_not_allowed',
    )
  })

  it('attaches cash paid from a counter to its open shift', async () => {
    const shift = (
      await post<Data<ShiftDetail>>(shop, '/shifts/open', {
        register_id: shop.register.id,
        opening_cash_paise: 10_000,
      })
    ).data
    const cashAtCounter = (
      await post<Data<ExpenseDetail>>(shop, '/expenses', {
        ...base(),
        expense_account_id: rent,
        total_paise: 700,
        payment_method: 'cash',
        register_id: shop.register.id,
      })
    ).data
    expect(cashAtCounter.shift_id).toBe(shift.id)
    const upiAtCounter = (
      await post<Data<ExpenseDetail>>(shop, '/expenses', {
        ...base(),
        expense_account_id: rent,
        total_paise: 300,
        payment_method: 'upi',
        register_id: shop.register.id,
      })
    ).data
    expect(upiAtCounter.shift_id).toBeNull()
    const backOffice = (
      await post<Data<ExpenseDetail>>(shop, '/expenses', {
        ...base(),
        expense_account_id: rent,
        total_paise: 200,
        payment_method: 'cash',
      })
    ).data
    expect(backOffice.shift_id).toBeNull()
    const list = await get<ExpenseListResponse>(shop, `/expenses?shift_id=${shift.id}`)
    expect(list.data.map((e) => e.id)).toEqual([cashAtCounter.id])
    const s = (await get<Data<ShiftDetail>>(shop, `/shifts/${shift.id}`)).data
    expect(s.summary.cash.cash_expenses_paise).toBe(700)
    expect(s.summary.cash.expected_cash_paise).toBe(10_000 - 700)
    expect(s.summary.expenses).toEqual({ count: 1, cash_paise: 700 })
    await post(shop, `/shifts/${shift.id}/close`, { counted_cash_paise: 9_300 }, 200)
  })

  it('lists with filters, totals by category / method and CSV', async () => {
    const all = await get<ExpenseListResponse>(shop, '/expenses?limit=200')
    const posted = all.data.filter((e) => e.status === 'posted')
    expect(all.summary.count).toBe(posted.length)
    expect(all.summary.total_paise).toBe(posted.reduce((s, e) => s + e.total_paise, 0))
    expect(all.summary.itc_paise).toBe(
      posted.filter((e) => e.itc_eligible).reduce((s, e) => s + e.tax_paise, 0),
    )
    const rentRow = all.summary.by_category.find((c) => c.expense_account_id === rent)
    expect(rentRow).toMatchObject({ code: '5300' })
    expect(rentRow?.total_paise).toBe(
      posted.filter((e) => e.expense_account_id === rent).reduce((s, e) => s + e.total_paise, 0),
    )
    const methods = all.summary.by_method.map((m) => m.payment_method)
    expect(methods).toEqual(expect.arrayContaining(['cash', 'upi']))

    const upi = await get<ExpenseListResponse>(shop, '/expenses?payment_method=upi')
    expect(upi.data.every((e) => e.payment_method === 'upi')).toBe(true)
    const multi = await get<ExpenseListResponse>(
      shop,
      `/expenses?expense_account_id=${rent}&expense_account_id=${electricity}&sort=total_paise`,
    )
    expect(multi.data.every((e) => [rent, electricity].includes(e.expense_account_id))).toBe(true)
    const totals = multi.data.map((e) => e.total_paise)
    expect([...totals].sort((a, b) => a - b)).toEqual(totals)
    const cancelled = await get<ExpenseListResponse>(shop, '/expenses?status=cancelled')
    expect(cancelled.data.length).toBeGreaterThan(0)
    expect(cancelled.summary.count).toBe(0) // totals cover posted expenses only
    const q = await get<ExpenseListResponse>(shop, '/expenses?q=TNEB')
    expect(q.data).toHaveLength(1)
    const itc = await get<ExpenseListResponse>(shop, '/expenses?itc_eligible=true')
    expect(itc.data.every((e) => e.itc_eligible)).toBe(true)

    const csv = await shop.inject({ method: 'GET', url: api('/expenses?format=csv') })
    expect(csv.statusCode).toBe(200)
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(lines[0]).toContain('தேதி') // Tamil headers for a Tamil member
    expect(lines.length).toBe(all.data.length + 1)
  })

  it('gates permissions (no plan feature needed) and isolates tenants', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/expenses'),
        payload: { ...base(), expense_account_id: rent, total_paise: 100, payment_method: 'cash' },
        as: cashier,
      }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api('/expenses'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const reader = await shop.asRole('reader', { permissions: ['accounting.read'] })
    const list = await get<ExpenseListResponse>(shop, '/expenses', reader)
    const detail = await get<Data<ExpenseDetail>>(shop, `/expenses/${list.data[0]!.id}`, reader)
    expect(detail.data.can_cancel).toBe(false)

    const free = await createTestTenant(t, { plan_code: 'free' })
    const freeExpense = await post<Data<ExpenseDetail>>(free, '/expenses', {
      store_id: free.store.id,
      expense_date: today(),
      expense_account_id: await accountByCode(t, free, '5300'),
      total_paise: 50_000,
      payment_method: 'cash',
    })
    expect(freeExpense.data.status).toBe('posted')

    expectError(
      await other.inject({ method: 'GET', url: api(`/expenses/${list.data[0]!.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'POST',
        url: api(`/expenses/${list.data[0]!.id}/cancel`),
        payload: { reason: 'Not mine' },
      }),
      404,
      'NOT_FOUND',
    )
    const theirs = await get<ExpenseListResponse>(other, '/expenses')
    expect(theirs.data).toEqual([])
    expectError(
      await other.inject({
        method: 'POST',
        url: api('/expenses'),
        payload: {
          store_id: other.store.id,
          expense_date: today(),
          expense_account_id: rent,
          total_paise: 100,
          payment_method: 'cash',
        },
      }),
      404,
      'NOT_FOUND',
    )
  })

  it('is idempotent with client_ref', async () => {
    const payload = {
      ...base(),
      expense_account_id: rent,
      total_paise: 1_500,
      payment_method: 'cash',
      client_ref: `exp-${newId()}`,
    }
    const a = await post<Data<ExpenseDetail>>(shop, '/expenses', payload)
    const b = await shop.inject({ method: 'POST', url: api('/expenses'), payload })
    expect(b.statusCode).toBe(201)
    expect(JSON.parse(b.body).data.id).toBe(a.data.id)
    const count = await t.deps.db.systemDb
      .selectFrom('expenses')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tenant_id', '=', shop.tenant.id)
      .where('total_paise', '=', 1_500)
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(1)
  })
})
