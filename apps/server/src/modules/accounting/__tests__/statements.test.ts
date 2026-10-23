/**
 * Financial statements over a realistic scenario seeded through the core posting services
 * (opening stock, purchases, sales with tenders, a customer receipt, a return with refund,
 * supplier payment, expenses with / without ITC and on credit, a shift shortage, a previous-year
 * expense, a branch income):
 *  - trial balance always balanced (and equal to Σ journal lines);
 *  - P&L sections, net sales, margins, comparison period and store filter;
 *  - P&L net profit = balance-sheet current-period profit; balance sheet balanced with earlier
 *    years' profit; tenant-wide statements need access to every store; CSV; gating; isolation.
 */
import { addDays, fyOf, fyRange, newId } from '@kadai/shared'
import type {
  BalanceSheet,
  ProfitLoss,
  ShiftDetail,
  TrialBalance,
} from '@kadai/shared/api/accounting'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import {
  type Data,
  accountByCode,
  accountId,
  api,
  expectError,
  get,
  ledgerTotals,
  newSupplier,
  pay,
  post,
  postPurchase,
  postReturn,
  postSale,
  stockedProduct,
  today,
} from './fixtures'

describe('accounting: statements', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let fyStart: string
  let lastFy: { from: string; to: string }
  let store2: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    const fy = fyOf(today())
    fyStart = fyRange(fy).from
    lastFy = { from: addDays(fyRange(fy).from, -365), to: addDays(fyStart, -1) }
    lastFy.from = fyRange(fyOf(lastFy.to)).from

    const cash = await accountId(t, shop, 'cash')
    await post(shop, '/journal-entries', {
      entry_date: today(),
      narration: 'Capital brought in',
      lines: [
        { account_id: cash, debit_paise: 1_00_000 },
        { account_id: await accountId(t, shop, 'capital'), credit_paise: 1_00_000 },
      ],
    })
    const product = await stockedProduct(t, shop, { cost_paise: 5_000, qty_milli: 10_000 })
    const supplier = await newSupplier(t, shop)
    await postPurchase(t, shop, {
      supplier_id: supplier.id,
      product_id: product.id,
      qty_milli: 4_000,
      unit_cost_paise: 5_000,
    })
    const saleA = await postSale(t, shop, {
      lines: [{ product_id: product.id, qty_milli: 2_000, taxable_paise: 16_000 }],
      tenders: [{ method: 'cash', amount_paise: 16_800 }],
    })
    const customer = await insertTestCustomer(t.deps, shop.tenant.id)
    const saleB = await postSale(t, shop, {
      customer_id: customer.id,
      lines: [{ product_id: product.id, qty_milli: 1_000, taxable_paise: 8_000 }],
      round_off_paise: -10,
    })
    await pay(shop, {
      direction: 'in',
      store_id: shop.store.id,
      method: 'upi',
      amount_paise: 4_000,
      payment_date: today(),
      party: { type: 'customer', id: customer.id },
      allocations: [{ target_type: 'sales_invoice', target_id: saleB.id, amount_paise: 4_000 }],
    })
    await postReturn(t, shop, {
      sale: saleA,
      line: {
        product_id: product.id,
        qty_milli: 1_000,
        taxable_paise: 8_000,
        line_id: saleA.line_ids[0]!,
        unit_cost_paise: 5_000,
      },
      refund: { method: 'cash', amount_paise: 8_400 },
    })
    await pay(shop, {
      direction: 'out',
      store_id: shop.store.id,
      method: 'bank_transfer',
      amount_paise: 10_000,
      payment_date: today(),
      party: { type: 'supplier', id: supplier.id },
    })
    const expense = (body: Record<string, unknown>) =>
      post(shop, '/expenses', { store_id: shop.store.id, expense_date: today(), ...body })
    await expense({
      expense_account_id: await accountByCode(t, shop, '5310'),
      total_paise: 11_800,
      gst_rate_bp: 1800,
      itc_eligible: true,
      payment_method: 'cash',
    })
    const transporter = await newSupplier(t, shop)
    await expense({
      expense_account_id: await accountByCode(t, shop, '5330'),
      total_paise: 5_000,
      payment_method: 'credit',
      supplier_id: transporter.id,
    })
    // An expense of the previous financial year (retained earnings).
    await expense({
      expense_date: addDays(fyStart, -10),
      expense_account_id: await accountByCode(t, shop, '5300'),
      total_paise: 3_000,
      payment_method: 'cash',
    })
    // A shift closed ₹5 short.
    const shift = (
      await post<Data<ShiftDetail>>(shop, '/shifts/open', {
        register_id: shop.register.id,
        opening_cash_paise: 2_000,
      })
    ).data
    await post(shop, `/shifts/${shift.id}/close`, { counted_cash_paise: 1_500 }, 200)
    // Branch income (store filter of the P&L).
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
    await post(shop, '/journal-entries', {
      entry_date: today(),
      store_id: store2,
      narration: 'Scrap sold at the branch',
      lines: [
        { account_id: cash, debit_paise: 2_000 },
        { account_id: await accountId(t, shop, 'other_income'), credit_paise: 2_000 },
      ],
    })
  })
  afterAll(() => t.close())

  const line = (
    section: { lines: Array<{ subtype: string | null; code: string; amount_paise: number }> },
    key: string,
  ) => section.lines.find((l) => l.subtype === key || l.code === key)?.amount_paise ?? 0

  it('trial balance is balanced and matches the journal', async () => {
    const tb = (await get<Data<TrialBalance>>(shop, '/statements/trial-balance')).data
    expect(tb.balanced).toBe(true)
    expect(tb.difference_paise).toBe(0)
    expect(tb.total_debit_paise).toBe(tb.total_credit_paise)
    expect(tb.rows.every((r) => r.debit_paise === 0 || r.credit_paise === 0)).toBe(true)
    const totals = await ledgerTotals(t, shop)
    expect(totals.debit).toBe(totals.credit)
    const codes = tb.rows.map((r) => r.code)
    expect([...codes].sort()).toEqual(codes)
    expect(tb.rows.find((r) => r.subtype === 'capital')).toMatchObject({ credit_paise: 1_00_000 })
    expect(tb.rows.find((r) => r.subtype === 'cash_short_excess')).toMatchObject({
      debit_paise: 500,
    })

    const withZero = (
      await get<Data<TrialBalance>>(shop, '/statements/trial-balance?include_zero=true')
    ).data
    expect(withZero.rows.length).toBeGreaterThan(tb.rows.length)
    expect(withZero.balanced).toBe(true)
    const lastYear = (
      await get<Data<TrialBalance>>(shop, `/statements/trial-balance?as_of=${lastFy.to}`)
    ).data
    expect(lastYear.rows.map((r) => r.subtype ?? r.code).sort()).toEqual(['5300', 'cash'])
    expect(lastYear.balanced).toBe(true)
  })

  it('profit & loss: income − COGS − expenses, net sales and margins', async () => {
    const pl = (await get<Data<ProfitLoss>>(shop, '/statements/profit-loss')).data
    expect(pl.from).toBe(fyStart)
    expect(pl.to).toBe(today())
    expect(line(pl.income, 'sales')).toBe(24_000)
    expect(line(pl.income, 'sales_returns')).toBe(-8_000)
    expect(line(pl.income, 'other_income')).toBe(2_000)
    expect(line(pl.income, 'round_off')).toBe(-10)
    expect(pl.income.total_paise).toBe(24_000 - 8_000 + 2_000 - 10)
    expect(pl.cogs.total_paise).toBe(10_000 + 5_000 - 5_000)
    expect(line(pl.expenses, '5310')).toBe(10_000) // ITC: only the taxable value
    expect(line(pl.expenses, '5330')).toBe(5_000)
    expect(line(pl.expenses, 'cash_short_excess')).toBe(500)
    expect(line(pl.expenses, '5300')).toBe(0) // last year's rent is not in this period
    expect(pl.expenses.total_paise).toBe(15_500)
    expect(pl.net_sales_paise).toBe(16_000)
    expect(pl.gross_profit_paise).toBe(pl.income.total_paise - pl.cogs.total_paise)
    expect(pl.net_profit_paise).toBe(
      pl.income.total_paise - pl.cogs.total_paise - pl.expenses.total_paise,
    )
    expect(pl.gross_margin_bp).toBe(Math.round((pl.gross_profit_paise * 10_000) / 16_000))
    expect(pl.compare).toBeNull()
    expect(pl.net_profit_compare_paise).toBeNull()
  })

  it('profit & loss: comparison period and store filter', async () => {
    const pl = (
      await get<Data<ProfitLoss>>(
        shop,
        `/statements/profit-loss?compare_from=${lastFy.from}&compare_to=${lastFy.to}`,
      )
    ).data
    expect(pl.compare).toEqual(lastFy)
    const rent = pl.expenses.lines.find((l) => l.code === '5300')
    expect(rent).toMatchObject({ amount_paise: 0, compare_paise: 3_000 })
    expect(pl.net_profit_compare_paise).toBe(-3_000)
    expect(pl.expenses.compare_total_paise).toBe(3_000)

    const branch = (await get<Data<ProfitLoss>>(shop, `/statements/profit-loss?store_id=${store2}`))
      .data
    expect(branch.store_id).toBe(store2)
    expect(branch.income.lines.map((l) => l.subtype)).toEqual(['other_income'])
    expect(branch.net_profit_paise).toBe(2_000)
    expect(branch.gross_margin_bp).toBeNull() // no sales at the branch

    const scoped = await shop.asRole('s2_accountant', {
      permissions: ['accounting.read'],
      store_ids: [store2],
    })
    const scopedPl = (await get<Data<ProfitLoss>>(shop, '/statements/profit-loss', scoped)).data
    expect(scopedPl.net_profit_paise).toBe(2_000)
    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/statements/profit-loss?store_id=${shop.store.id}`),
        as: scoped,
      }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/statements/profit-loss?compare_from=${lastFy.from}`),
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api('/statements/profit-loss?from=2099-01-01') }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('balance sheet: balanced, current-period profit = P&L net profit, earlier years', async () => {
    const bs = (await get<Data<BalanceSheet>>(shop, '/statements/balance-sheet')).data
    const pl = (
      await get<Data<ProfitLoss>>(
        shop,
        `/statements/profit-loss?from=${bs.fy_start}&to=${bs.as_of}`,
      )
    ).data
    expect(bs.fy_start).toBe(fyStart)
    expect(bs.balanced).toBe(true)
    expect(bs.difference_paise).toBe(0)
    expect(bs.current_period_profit_paise).toBe(pl.net_profit_paise)
    expect(bs.retained_earnings_paise).toBe(-3_000)
    expect(bs.total_assets_paise).toBe(bs.total_liabilities_equity_paise)
    expect(bs.total_equity_paise).toBe(
      bs.equity.total_paise + bs.current_period_profit_paise + bs.retained_earnings_paise,
    )
    expect(line(bs.equity, 'capital')).toBe(1_00_000)
    expect(line(bs.equity, 'opening_balance')).toBe(50_000)
    // Supplier: 21000 billed − 10000 paid; transporter 5000 on credit.
    expect(line(bs.liabilities, 'payable')).toBe(21_000 - 10_000 + 5_000)
    // Customer B: 8390 billed − 4000 received.
    expect(line(bs.assets, 'receivable')).toBe(8_390 - 4_000)
    expect(line(bs.assets, 'inventory')).toBe(50_000 + 20_000 - 15_000 + 5_000)
    expect(line(bs.assets, 'input_cgst')).toBe(500 + 900)

    const earlier = (
      await get<Data<BalanceSheet>>(shop, `/statements/balance-sheet?as_of=${lastFy.to}`)
    ).data
    expect(earlier.fy_start).toBe(lastFy.from)
    expect(earlier.current_period_profit_paise).toBe(-3_000)
    expect(earlier.retained_earnings_paise).toBe(0)
    expect(earlier.balanced).toBe(true)
  })

  it('exports every statement as CSV', async () => {
    for (const [url, first] of [
      ['/statements/trial-balance?format=csv', 'Code,Account,Type,Debit,Credit'],
      ['/statements/profit-loss?format=csv', `Section,Code,Account,${fyStart} – ${today()}`],
      ['/statements/balance-sheet?format=csv', `Section,Code,Account,${today()}`],
    ] as const) {
      const res = await shop.inject({ method: 'GET', url: api(url), headers: { 'x-locale': 'en' } })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      const rows = res.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n')
      expect(rows[0]).toBe(first)
      expect(rows.length).toBeGreaterThan(3)
    }
    const ta = await shop.inject({ method: 'GET', url: api('/statements/profit-loss?format=csv') })
    expect(ta.body).toContain('நிகர')
  })

  it('needs every store for TB / BS, the accounting feature and accounting.read; isolates tenants', async () => {
    const scoped = await shop.asRole('s1_accountant', {
      permissions: ['accounting.read'],
      store_ids: [shop.store.id],
    })
    for (const url of ['/statements/trial-balance', '/statements/balance-sheet']) {
      expectError(
        await shop.inject({ method: 'GET', url: api(url), as: scoped }),
        403,
        'FORBIDDEN',
        'all_stores_required',
      )
    }
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/statements/profit-loss'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const free = await createTestTenant(t, { plan_code: 'free' })
    for (const url of [
      '/statements/trial-balance',
      '/statements/profit-loss',
      '/statements/balance-sheet',
    ]) {
      expectError(await free.inject({ method: 'GET', url: api(url) }), 402, 'FEATURE_NOT_IN_PLAN')
    }
    const tb = (await get<Data<TrialBalance>>(other, '/statements/trial-balance')).data
    expect(tb).toMatchObject({ rows: [], total_debit_paise: 0, balanced: true })
    const bs = (await get<Data<BalanceSheet>>(other, '/statements/balance-sheet')).data
    expect(bs).toMatchObject({
      total_assets_paise: 0,
      current_period_profit_paise: 0,
      balanced: true,
    })
  })
})
