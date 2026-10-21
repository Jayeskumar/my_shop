/**
 * Register shifts API: open (one per register, also under concurrency), current shift, pay-ins /
 * pay-outs with their journals, the expected-cash maths at close with mixed tenders, refunds,
 * supplier payments, dues collected, expenses and cash entries, the short / excess journal, the
 * X / Z reports, own-shift vs shifts.manage rules, list scoping + CSV, feature gating and tenant
 * isolation.
 */
import { newId } from '@kadai/shared'
import type {
  JournalListResponse,
  ShiftCashEntry,
  ShiftDetail,
  ShiftListResponse,
} from '@kadai/shared/api/accounting'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import {
  type Data,
  accountByCode,
  accountId,
  accountNet,
  api,
  auditActions,
  expectError,
  expectStatus,
  get,
  newSupplier,
  pay,
  post,
  postReturn,
  postSale,
  stockedProduct,
  today,
} from './fixtures'

describe('accounting: register shifts', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  async function newRegister(s: TestShop, code: string): Promise<string> {
    const id = newId()
    await t.deps.db.systemDb
      .insertInto('registers')
      .values({ id, tenant_id: s.tenant.id, store_id: s.store.id, code, name: `Counter ${code}` })
      .execute()
    return id
  }

  it('opens one shift per register, also under concurrent requests', async () => {
    const registerId = await newRegister(shop, 'C')
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        shop.inject({
          method: 'POST',
          url: api('/shifts/open'),
          payload: { register_id: registerId, opening_cash_paise: 5_000 },
        }),
      ),
    )
    const ok = results.filter((r) => r.statusCode === 201)
    expect(ok).toHaveLength(1)
    const opened = JSON.parse(ok[0]!.body) as Data<ShiftDetail>
    for (const r of results.filter((x) => x.statusCode !== 201)) {
      const err = expectError(r, 409, 'CONFLICT', 'shift_already_open')
      expect(err.details?.shift_id).toBe(opened.data.id)
    }
    const open = await t.deps.db.systemDb
      .selectFrom('register_shifts')
      .select('id')
      .where('register_id', '=', registerId)
      .where('status', '=', 'open')
      .execute()
    expect(open).toHaveLength(1)
    expect(opened.data).toMatchObject({
      status: 'open',
      register_code: 'C',
      opening_cash_paise: 5_000,
      opened_by: shop.owner.user.id,
      can_close: true,
      expected_cash_paise: null,
    })
    expect(opened.data.summary.report).toBe('X')
    await post(shop, `/shifts/${opened.data.id}/close`, { counted_cash_paise: 5_000 }, 200)
  })

  it('validates the opening count and is idempotent', async () => {
    const registerId = await newRegister(shop, 'D')
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/shifts/open'),
        payload: {
          register_id: registerId,
          opening_cash_paise: 10_000,
          denominations: { '100': 2 },
        },
      }),
      400,
      'VALIDATION_ERROR',
    )
    const payload = {
      register_id: registerId,
      opening_cash_paise: 70_250,
      denominations: { '500': 1, '100': 2, coins: 250 },
      client_ref: `open-${newId()}`,
    }
    const a = await post<Data<ShiftDetail>>(shop, '/shifts/open', payload)
    const b = await shop.inject({ method: 'POST', url: api('/shifts/open'), payload })
    expect(b.statusCode).toBe(201)
    expect(JSON.parse(b.body).data.id).toBe(a.data.id)
    expect(a.data.denominations).toMatchObject({ '500': 1, '100': 2, coins: 250, '2000': 0 })
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/shifts/open'),
        payload: { register_id: newId(), opening_cash_paise: 0 },
      }),
      404,
      'NOT_FOUND',
    )
    await post(shop, `/shifts/${a.data.id}/close`, { counted_cash_paise: 70_250 }, 200)
  })

  it('computes expected cash with mixed tenders, refunds, payments, expenses and cash entries', async () => {
    const product = await stockedProduct(t, shop, { cost_paise: 5_000, qty_milli: 20_000 })
    const customer = await insertTestCustomer(t.deps, shop.tenant.id)
    // An older credit bill of the customer (before the shift), collected during the shift.
    const oldBill = await postSale(t, shop, {
      customer_id: customer.id,
      lines: [{ product_id: product.id, qty_milli: 1_000, taxable_paise: 9_524 }],
    })

    const shift = (
      await post<Data<ShiftDetail>>(shop, '/shifts/open', {
        register_id: shop.register.id,
        opening_cash_paise: 5_00_000,
        notes: 'Morning float',
      })
    ).data
    expect(
      (await get<Data<ShiftDetail | null>>(shop, `/shifts/current?register_id=${shop.register.id}`))
        .data?.id,
    ).toBe(shift.id)

    // Bill 1: cash.
    const sale1 = await postSale(t, shop, {
      shift_id: shift.id,
      lines: [{ product_id: product.id, qty_milli: 2_000, taxable_paise: 16_000 }],
      tenders: [{ method: 'cash', amount_paise: 16_800 }],
      item_discount_paise: 500,
    })
    // Bill 2: UPI + cash split, with a round off.
    const sale2 = await postSale(t, shop, {
      shift_id: shift.id,
      lines: [{ product_id: product.id, qty_milli: 1_000, taxable_paise: 9_510 }],
      round_off_paise: 4,
      tenders: [
        { method: 'upi', amount_paise: 6_000 },
        { method: 'cash', amount_paise: 3_990 },
      ],
    })
    expect(sale2.total_paise).toBe(9_990)
    // Bill 3: cancelled during the shift (no tender).
    await postSale(t, shop, {
      shift_id: shift.id,
      lines: [{ product_id: product.id, qty_milli: 1_000, taxable_paise: 1_000 }],
      status: 'cancelled',
    })
    // Due collected in cash on the shift for the older bill.
    await pay(shop, {
      direction: 'in',
      store_id: shop.store.id,
      shift_id: shift.id,
      method: 'cash',
      amount_paise: 2_500,
      payment_date: today(),
      party: { type: 'customer', id: customer.id },
      allocations: [{ target_type: 'sales_invoice', target_id: oldBill.id, amount_paise: 2_500 }],
    })
    // Return of one unit of bill 1, refunded in cash.
    const ret = await postReturn(t, shop, {
      sale: sale1,
      line: {
        product_id: product.id,
        qty_milli: 1_000,
        taxable_paise: 8_000,
        line_id: sale1.line_ids[0]!,
        unit_cost_paise: 5_000,
      },
      shift_id: shift.id,
      refund: { method: 'cash', amount_paise: 8_400 },
    })
    expect(ret.total_paise).toBe(8_400)
    // Supplier paid in cash from the drawer.
    const supplier = await newSupplier(t, shop)
    await pay(shop, {
      direction: 'out',
      store_id: shop.store.id,
      shift_id: shift.id,
      method: 'cash',
      amount_paise: 7_000,
      payment_date: today(),
      party: { type: 'supplier', id: supplier.id },
    })
    // Pay-in (float), pay-outs (bank deposit, petty expense to an expense head).
    const payIn = await post<Data<ShiftCashEntry>>(shop, `/shifts/${shift.id}/cash-entries`, {
      kind: 'pay_in',
      amount_paise: 10_000,
      reason: 'Change from owner',
    })
    expect(payIn.data).toMatchObject({ kind: 'pay_in', account_code: '3100' })
    await post(shop, `/shifts/${shift.id}/cash-entries`, {
      kind: 'pay_out',
      amount_paise: 20_000,
      reason: 'Deposited in SBI',
      counter: 'bank',
    })
    const petty = await post<Data<ShiftCashEntry>>(shop, `/shifts/${shift.id}/cash-entries`, {
      kind: 'pay_out',
      amount_paise: 500,
      reason: 'Tea for staff',
      account_id: await accountByCode(t, shop, '5390'),
    })
    expect(petty.data.account_code).toBe('5390')
    // Expenses: cash at the counter (counts), UPI (does not), cancelled cash (does not).
    const rent = await accountByCode(t, shop, '5300')
    await post(shop, '/expenses', {
      store_id: shop.store.id,
      expense_date: today(),
      expense_account_id: rent,
      total_paise: 1_180,
      payment_method: 'cash',
      register_id: shop.register.id,
    })
    await post(shop, '/expenses', {
      store_id: shop.store.id,
      expense_date: today(),
      expense_account_id: rent,
      total_paise: 999,
      payment_method: 'upi',
      register_id: shop.register.id,
    })
    const wrong = await post<Data<{ id: string }>>(shop, '/expenses', {
      store_id: shop.store.id,
      expense_date: today(),
      expense_account_id: rent,
      total_paise: 3_333,
      payment_method: 'cash',
      register_id: shop.register.id,
    })
    await post(shop, `/expenses/${wrong.data.id}/cancel`, { reason: 'Typed twice' }, 200)

    const expected =
      5_00_000 + (16_800 + 3_990 + 2_500) - (8_400 + 7_000) + 10_000 - (20_000 + 500) - 1_180
    const x = (await get<Data<ShiftDetail>>(shop, `/shifts/${shift.id}`)).data
    expect(x.summary.report).toBe('X')
    expect(x.summary.cash).toEqual({
      opening_cash_paise: 5_00_000,
      cash_receipts_paise: 16_800 + 3_990 + 2_500,
      cash_payments_paise: 8_400 + 7_000,
      pay_ins_paise: 10_000,
      pay_outs_paise: 20_500,
      cash_expenses_paise: 1_180,
      expected_cash_paise: expected,
      counted_cash_paise: null,
      difference_paise: null,
    })
    expect(x.cash_entries).toHaveLength(3)

    // Close short by ₹6.20.
    const counted = expected - 620
    const z = (
      await post<Data<ShiftDetail>>(
        shop,
        `/shifts/${shift.id}/close`,
        { counted_cash_paise: counted, notes: 'Evening count' },
        200,
      )
    ).data
    expect(z).toMatchObject({
      status: 'closed',
      expected_cash_paise: expected,
      counted_cash_paise: counted,
      difference_paise: -620,
      difference_status: 'short',
      closed_by: shop.owner.user.id,
      bills_count: 2,
      sales_total_paise: sale1.total_paise + sale2.total_paise,
      notes: 'Morning float\nEvening count',
      can_close: false,
    })
    const s = z.summary
    expect(s.report).toBe('Z')
    expect(s.bills).toMatchObject({
      count: 2,
      total_paise: 16_800 + 9_990,
      discount_paise: 500,
      round_off_paise: 4,
      item_lines: 2,
      credit_paise: 0,
      avg_bill_paise: Math.round((16_800 + 9_990) / 2),
    })
    expect(s.payments_in).toEqual([
      { method: 'cash', count: 3, amount_paise: 16_800 + 3_990 + 2_500 },
      { method: 'upi', count: 1, amount_paise: 6_000 },
    ])
    expect(s.payments_out).toEqual([{ method: 'cash', count: 2, amount_paise: 15_400 }])
    expect(s.dues_collected_paise).toBe(2_500)
    expect(s.returns).toEqual({ count: 1, total_paise: 8_400 })
    expect(s.cancelled_bills).toMatchObject({ count: 1, total_paise: 1_050 })
    expect(s.cancelled_bills.items[0]?.reason).toBe('Wrong bill')
    expect(s.top_items[0]).toMatchObject({ product_id: product.id, qty_milli: 3_000 })
    expect(s.expenses).toEqual({ count: 1, cash_paise: 1_180 })
    expect(s.cash.difference_paise).toBe(-620)

    // Journals: pay-in / pay-outs and the shortage, all source 'shift'.
    const journals = await get<JournalListResponse>(
      shop,
      `/journal-entries?source_type=shift&source_id=${shift.id}`,
    )
    expect(journals.data).toHaveLength(4)
    expect(journals.data.every((j) => j.source_path === `/accounting/shifts/${shift.id}`)).toBe(
      true,
    )
    expect(await accountNet(t, await accountId(t, shop, 'cash_short_excess'))).toBe(620)
    expect(await accountNet(t, await accountId(t, shop, 'drawings'))).toBe(0)
    expect(await accountNet(t, await accountId(t, shop, 'capital'))).toBe(-10_000)
    expect(await auditActions(t, shop)).toEqual(
      expect.arrayContaining(['shift.open', 'shift.cash_entry', 'shift.close']),
    )

    // The stored Z report is served afterwards; the shift is closed for further changes.
    const again = (await get<Data<ShiftDetail>>(shop, `/shifts/${shift.id}`)).data
    expect(again.summary.generated_at).toBe(s.generated_at)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/shifts/${shift.id}/close`),
        payload: { counted_cash_paise: 1 },
      }),
      409,
      'CONFLICT',
      'shift_closed',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/shifts/${shift.id}/cash-entries`),
        payload: { kind: 'pay_in', amount_paise: 100, reason: 'Late' },
      }),
      409,
      'CONFLICT',
      'shift_closed',
    )
    expect(
      (await get<Data<ShiftDetail | null>>(shop, `/shifts/current?register_id=${shop.register.id}`))
        .data,
    ).toBeNull()
  })

  it('posts an excess and no journal when the count tallies', async () => {
    const registerId = await newRegister(shop, 'E')
    const before = await accountNet(t, await accountId(t, shop, 'cash_short_excess'))
    const a = (
      await post<Data<ShiftDetail>>(shop, '/shifts/open', {
        register_id: registerId,
        opening_cash_paise: 1_000,
      })
    ).data
    const closed = (
      await post<Data<ShiftDetail>>(
        shop,
        `/shifts/${a.id}/close`,
        { counted_cash_paise: 1_150, denominations: { '10': 1, coins: 150 } },
        200,
      )
    ).data
    expect(closed).toMatchObject({ difference_paise: 150, difference_status: 'excess' })
    expect(closed.denominations).toMatchObject({ '10': 1, coins: 150 })
    expect(await accountNet(t, await accountId(t, shop, 'cash_short_excess'))).toBe(before - 150)
    const b = (
      await post<Data<ShiftDetail>>(shop, '/shifts/open', {
        register_id: registerId,
        opening_cash_paise: 2_000,
      })
    ).data
    const tallied = (
      await post<Data<ShiftDetail>>(
        shop,
        `/shifts/${b.id}/close`,
        { counted_cash_paise: 2_000 },
        200,
      )
    ).data
    expect(tallied.difference_status).toBe('balanced')
    const journals = await get<JournalListResponse>(
      shop,
      `/journal-entries?source_type=shift&source_id=${b.id}`,
    )
    expect(journals.data).toHaveLength(0)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/shifts/${b.id}/close`),
        payload: { counted_cash_paise: 1_000, denominations: { '100': 1 } },
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('validates cash entries', async () => {
    const registerId = await newRegister(shop, 'F')
    const s = (
      await post<Data<ShiftDetail>>(shop, '/shifts/open', {
        register_id: registerId,
        opening_cash_paise: 0,
      })
    ).data
    const bad = async (
      payload: Record<string, unknown>,
      status: number,
      code: string,
      reason?: string,
    ) =>
      expectError(
        await shop.inject({
          method: 'POST',
          url: api(`/shifts/${s.id}/cash-entries`),
          payload: { kind: 'pay_out', amount_paise: 100, reason: 'Test entry', ...payload },
        }),
        status,
        code,
        reason,
      )
    await bad({ amount_paise: 0 }, 400, 'VALIDATION_ERROR')
    await bad({ reason: 'x' }, 400, 'VALIDATION_ERROR')
    await bad(
      { counter: 'bank', account_id: await accountId(t, shop, 'bank') },
      400,
      'VALIDATION_ERROR',
    )
    await bad({ account_id: await accountId(t, shop, 'cash') }, 400, 'VALIDATION_ERROR')
    await bad(
      { account_id: await accountId(t, shop, 'receivable') },
      422,
      'UNPROCESSABLE',
      'party_required',
    )
    await bad({ account_id: newId() }, 404, 'NOT_FOUND')
    const drawings = (
      await post<Data<ShiftCashEntry>>(shop, `/shifts/${s.id}/cash-entries`, {
        kind: 'pay_out',
        amount_paise: 300,
        reason: 'Owner took cash',
      })
    ).data
    expect(drawings.account_code).toBe('3200')
    await post(shop, `/shifts/${s.id}/close`, { counted_cash_paise: 0 }, 200)
    expect(
      (await get<Data<ShiftDetail>>(shop, `/shifts/${s.id}`)).data.summary.cash.expected_cash_paise,
    ).toBe(-300)
  })

  it("enforces own shift vs shifts.manage and lists only a cashier's own shifts", async () => {
    const regA = await newRegister(shop, 'G')
    const regB = await newRegister(shop, 'H')
    const cashier1 = await shop.asRole('cashier')
    const cashier2 = await shop.asRole('cashier')
    const s1 = (
      await post<Data<ShiftDetail>>(
        shop,
        '/shifts/open',
        { register_id: regA, opening_cash_paise: 100 },
        201,
        cashier1,
      )
    ).data
    const s2 = (
      await post<Data<ShiftDetail>>(
        shop,
        '/shifts/open',
        { register_id: regB, opening_cash_paise: 200 },
        201,
        cashier2,
      )
    ).data
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/shifts/${s1.id}/close`),
        payload: { counted_cash_paise: 100 },
        as: cashier2,
      }),
      403,
      'FORBIDDEN',
      'not_own_shift',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/shifts/${s1.id}/cash-entries`),
        payload: { kind: 'pay_in', amount_paise: 100, reason: 'Not mine' },
        as: cashier2,
      }),
      403,
      'FORBIDDEN',
      'not_own_shift',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api(`/shifts/${s1.id}`), as: cashier2 }),
      403,
      'FORBIDDEN',
      'not_own_shift',
    )
    // Any cashier of the store sees the register's current shift (POS gate).
    const current = await get<Data<ShiftDetail | null>>(
      shop,
      `/shifts/current?register_id=${regA}`,
      cashier2,
    )
    expect(current.data?.id).toBe(s1.id)
    expect(current.data?.can_close).toBe(false)

    const own = await get<ShiftListResponse>(shop, '/shifts', cashier1)
    expect(own.data.map((s) => s.id)).toEqual([s1.id])
    const filtered = await get<ShiftListResponse>(
      shop,
      `/shifts?user_id=${cashier2.user.id}`,
      cashier1,
    )
    expect(filtered.data).toEqual([])
    const manager = await shop.asRole('manager')
    const all = await get<ShiftListResponse>(shop, '/shifts?status=open', manager)
    expect(all.data.map((s) => s.id)).toEqual(expect.arrayContaining([s1.id, s2.id]))
    expect(all.summary.open_count).toBe(all.data.length)

    // A manager closes another cashier's shift.
    const closed = (
      await post<Data<ShiftDetail>>(
        shop,
        `/shifts/${s2.id}/close`,
        { counted_cash_paise: 150 },
        200,
        manager,
      )
    ).data
    expect(closed).toMatchObject({ closed_by: manager.user.id, difference_paise: -50 })
    await post(shop, `/shifts/${s1.id}/close`, { counted_cash_paise: 100 }, 200, cashier1)
    const pos = await shop.asRole('pos_only', { permissions: ['pos.use'] })
    expect(
      (await get<Data<ShiftDetail | null>>(shop, `/shifts/current?register_id=${regA}`, pos)).data,
    ).toBeNull()
    expectError(
      await shop.inject({ method: 'GET', url: api('/shifts'), as: pos }),
      403,
      'FORBIDDEN',
    )
  })

  it('lists with filters, difference summary and CSV', async () => {
    const all = await get<ShiftListResponse>(shop, '/shifts?limit=200')
    const closed = all.data.filter((s) => s.status === 'closed')
    expect(all.summary.short_paise).toBe(
      closed
        .filter((s) => (s.difference_paise ?? 0) < 0)
        .reduce((a, s) => a + s.difference_paise!, 0),
    )
    expect(all.summary.excess_paise).toBe(
      closed
        .filter((s) => (s.difference_paise ?? 0) > 0)
        .reduce((a, s) => a + s.difference_paise!, 0),
    )
    const short = await get<ShiftListResponse>(
      shop,
      '/shifts?difference=short&sort=difference_paise',
    )
    expect(short.data.length).toBeGreaterThan(0)
    expect(short.data.every((s) => s.difference_status === 'short')).toBe(true)
    const diffs = short.data.map((s) => s.difference_paise!)
    expect([...diffs].sort((a, b) => a - b)).toEqual(diffs)
    const todays = await get<ShiftListResponse>(shop, `/shifts?from=${today()}&to=${today()}`)
    expect(todays.page.total).toBe(all.page.total)
    const none = await get<ShiftListResponse>(shop, '/shifts?to=2020-01-01')
    expect(none.data).toEqual([])
    const reg = await get<ShiftListResponse>(shop, `/shifts?register_id=${shop.register.id}`)
    expect(reg.data.every((s) => s.register_id === shop.register.id)).toBe(true)
    const csv = await shop.inject({
      method: 'GET',
      url: api('/shifts?format=csv'),
      headers: { 'x-locale': 'en' },
    })
    expect(csv.statusCode).toBe(200)
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(lines[0]?.startsWith('Opened at,Closed at,Store,Counter')).toBe(true)
    expect(lines).toHaveLength(all.data.length + 1)
  })

  it('gates the shifts feature and isolates tenants', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    expectError(
      await free.inject({
        method: 'POST',
        url: api('/shifts/open'),
        payload: { register_id: free.register.id, opening_cash_paise: 0 },
      }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    expectError(
      await free.inject({
        method: 'GET',
        url: api(`/shifts/current?register_id=${free.register.id}`),
      }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    const mine = await get<ShiftListResponse>(shop, '/shifts?limit=1')
    const id = mine.data[0]!.id
    expectError(await other.inject({ method: 'GET', url: api(`/shifts/${id}`) }), 404, 'NOT_FOUND')
    expectError(
      await other.inject({
        method: 'POST',
        url: api(`/shifts/${id}/close`),
        payload: { counted_cash_paise: 0 },
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'POST',
        url: api('/shifts/open'),
        payload: { register_id: shop.register.id, opening_cash_paise: 0 },
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'GET',
        url: api(`/shifts/current?register_id=${shop.register.id}`),
      }),
      404,
      'NOT_FOUND',
    )
    const theirs = await get<ShiftListResponse>(other, '/shifts')
    expect(theirs.data).toEqual([])
    // Store-scoped members cannot open a shift on another store's counter.
    const store2 = newId()
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
    const reg2 = newId()
    await t.deps.db.systemDb
      .insertInto('registers')
      .values({
        id: reg2,
        tenant_id: shop.tenant.id,
        store_id: store2,
        code: 'A',
        name: 'Branch A',
      })
      .execute()
    const scoped = await shop.asRole('cashier', { store_ids: [shop.store.id] })
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/shifts/open'),
        payload: { register_id: reg2, opening_cash_paise: 0 },
        as: scoped,
      }),
      403,
      'FORBIDDEN',
    )
    expectStatus(
      await shop.inject({
        method: 'GET',
        url: api(`/shifts/current?register_id=${shop.register.id}`),
        as: scoped,
      }),
      200,
    )
  })
})
