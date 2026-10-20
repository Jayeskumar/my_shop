import { describe, expect, it } from 'vitest'
import { DEFAULT_CHART } from '../../src/accounting'
import {
  ACCOUNT_CODE_PREFIX,
  AccountBalanceSchema,
  AccountCreateSchema,
  AccountDetailSchema,
  AccountLedgerResponseSchema,
  AccountUpdateSchema,
  BalanceSheetQuerySchema,
  BalanceSheetSchema,
  BankDetailsInputSchema,
  CASH_SHORT_EXCESS_ACCOUNT,
  CashBookQuerySchema,
  ChartOfAccountsQuerySchema,
  ChartOfAccountsSchema,
  DayBookQuerySchema,
  DayBookResponseSchema,
  DenominationsSchema,
  EXPENSE_QUICK_TILES,
  ExpenseCancelSchema,
  ExpenseCreateSchema,
  ExpenseDetailSchema,
  ExpenseListQuerySchema,
  ExpenseListResponseSchema,
  JournalEntryDetailSchema,
  JournalListQuerySchema,
  JournalListResponseSchema,
  JournalReverseSchema,
  LedgerQuerySchema,
  ManualJournalCreateSchema,
  ProfitLossQuerySchema,
  ProfitLossSchema,
  ShiftCashEntryCreateSchema,
  ShiftCashEntrySchema,
  ShiftCloseSchema,
  ShiftCurrentQuerySchema,
  ShiftDetailSchema,
  ShiftListQuerySchema,
  ShiftListResponseSchema,
  ShiftOpenSchema,
  type ShiftSummary,
  TrialBalanceQuerySchema,
  TrialBalanceSchema,
  accountCodeMatchesType,
  accountingRoutes,
  balanceSheetTotals,
  balanceSide,
  buildAccountTree,
  cashEntryJournalLines,
  comparisonRange,
  computeExpenseAmounts,
  defaultCashEntryCounter,
  defaultPaidFromKind,
  denominationsTotalPaise,
  expectedShiftCash,
  expenseJournalLines,
  journalSourcePath,
  journalTotals,
  marginBp,
  moneyKindOf,
  profitLossTotals,
  resolveExpenseTile,
  runningBalances,
  shiftDifference,
  shiftDifferenceJournalLines,
  suggestAccountCode,
  trialBalanceSides,
  type PlannedJournalLine,
} from '../../src/api/accounting'
import { routeUrl } from '../../src/api/common'
import { newId } from '../../src/ids'

const id = () => newId()
const NOW = '2026-10-20T10:15:00+05:30'

const issueKeys = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  r.success ? [] : (r.error?.issues.map((i) => i.message) ?? [])

const balanced = (lines: readonly PlannedJournalLine[]) => journalTotals(lines).balanced

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

describe('chart of accounts helpers', () => {
  it('code prefix by type matches the default chart', () => {
    for (const a of DEFAULT_CHART) expect(accountCodeMatchesType(a.code, a.type)).toBe(true)
    expect(accountCodeMatchesType('5410', 'expense')).toBe(true)
    expect(accountCodeMatchesType('4410', 'expense')).toBe(false)
    expect(accountCodeMatchesType('54', 'expense')).toBe(false)
    expect(ACCOUNT_CODE_PREFIX.liability).toBe('2')
  })

  it('the cash short / excess preset fits the expense range and is unused', () => {
    expect(accountCodeMatchesType(CASH_SHORT_EXCESS_ACCOUNT.code, 'expense')).toBe(true)
    expect(DEFAULT_CHART.some((a) => a.code === CASH_SHORT_EXCESS_ACCOUNT.code)).toBe(false)
  })

  it('suggests the next free code under a parent or in the type range', () => {
    const codes = DEFAULT_CHART.map((a) => a.code)
    expect(suggestAccountCode('asset', codes, '1200')).toBe('1201')
    expect(suggestAccountCode('asset', [...codes, '1201', '1202'], '1200')).toBe('1203')
    expect(suggestAccountCode('expense', codes)).toBe('5410')
    expect(suggestAccountCode('income', codes)).toBe('4510')
    expect(suggestAccountCode('equity', [])).toBe('3010')
    // a full range of tens falls back to any free code
    const tens = Array.from({ length: 100 }, (_, i) => String(5000 + i * 10))
    expect(suggestAccountCode('expense', tens)).toBe('5001')
  })

  it('builds the tree with roll-up balances, parents first and siblings by code', () => {
    const bank = id()
    const hdfc = id()
    const sbi = id()
    const cash = id()
    const tree = buildAccountTree([
      { id: sbi, parent_id: bank, code: '1202', balance_paise: 500 },
      { id: hdfc, parent_id: bank, code: '1201', balance_paise: 1000 },
      { id: bank, parent_id: null, code: '1200', balance_paise: 200 },
      { id: cash, parent_id: 'missing-parent', code: '1100', balance_paise: 50 },
    ])
    expect(tree.map((n) => n.code)).toEqual(['1100', '1200'])
    const bankNode = tree[1]!
    expect(bankNode.rollup_balance_paise).toBe(1700)
    expect(bankNode.children.map((c) => [c.code, c.depth])).toEqual([
      ['1201', 1],
      ['1202', 1],
    ])
    expect(tree[0]!.rollup_balance_paise).toBe(50)
  })

  it('derives money accounts from subtype, ancestors or bank details', () => {
    expect(moneyKindOf({ type: 'asset', subtype: 'cash' })).toBe('cash')
    expect(moneyKindOf({ type: 'asset', subtype: null, ancestor_subtypes: ['bank'] })).toBe('bank')
    expect(moneyKindOf({ type: 'asset', subtype: null, has_bank_details: true })).toBe('bank')
    expect(moneyKindOf({ type: 'asset', subtype: 'receivable' })).toBeNull()
    expect(moneyKindOf({ type: 'expense', subtype: 'cash' })).toBeNull()
  })

  it('presents natural balances as Dr / Cr', () => {
    expect(balanceSide('asset', 500)).toEqual({ amount_paise: 500, side: 'Dr' })
    expect(balanceSide('asset', -500)).toEqual({ amount_paise: 500, side: 'Cr' })
    expect(balanceSide('liability', 300)).toEqual({ amount_paise: 300, side: 'Cr' })
    expect(balanceSide('income', -10)).toEqual({ amount_paise: 10, side: 'Dr' })
  })

  it('validates create / update bodies', () => {
    expect(
      AccountCreateSchema.safeParse({ name: 'HDFC current', type: 'asset', code: '1201' }).success,
    ).toBe(true)
    expect(
      issueKeys(AccountCreateSchema.safeParse({ name: 'Tea', type: 'expense', code: '4100' })),
    ).toContain('account_code_type')
    expect(
      issueKeys(AccountCreateSchema.safeParse({ name: 'Tea', type: 'expense', code: '51' })),
    ).toContain('account_code_format')
    const bank = BankDetailsInputSchema.parse({ ifsc: 'sbin0001234', account_last4: '4321' })
    expect(bank).toMatchObject({ ifsc: 'SBIN0001234', account_last4: '4321' })
    expect(issueKeys(BankDetailsInputSchema.safeParse({ ifsc: 'SBIN1234' }))).toContain('ifsc')
    expect(issueKeys(BankDetailsInputSchema.safeParse({ account_last4: '12345' }))).toContain(
      'bank_last4',
    )
    expect(issueKeys(AccountUpdateSchema.safeParse({ if_updated_at: NOW }))).toContain(
      'empty_patch',
    )
    expect(AccountUpdateSchema.parse({ name_ta: '' })).toEqual({ name_ta: null })
  })
})

// ---------------------------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------------------------

describe('manual journals', () => {
  const cash = id()
  const capital = id()
  it('totals drive the balance indicator', () => {
    expect(journalTotals([{ debit_paise: 500 }, { credit_paise: 300 }])).toEqual({
      debit_paise: 500,
      credit_paise: 300,
      difference_paise: 200,
      balanced: false,
    })
    expect(journalTotals([]).balanced).toBe(false)
  })

  it('accepts a balanced voucher and rejects bad ones', () => {
    const ok = ManualJournalCreateSchema.parse({
      entry_date: '2026-10-20',
      narration: 'Owner brought cash',
      lines: [
        { account_id: cash, debit_paise: 50_000 },
        { account_id: capital, credit_paise: 50_000 },
      ],
    })
    expect(ok.lines[0]!.credit_paise).toBe(0)
    const base = { entry_date: '2026-10-20', narration: 'Correction' }
    expect(
      issueKeys(
        ManualJournalCreateSchema.safeParse({
          ...base,
          lines: [
            { account_id: cash, debit_paise: 500 },
            { account_id: capital, credit_paise: 400 },
          ],
        }),
      ),
    ).toContain('journal_unbalanced')
    expect(
      issueKeys(
        ManualJournalCreateSchema.safeParse({
          ...base,
          lines: [{ account_id: cash, debit_paise: 500, credit_paise: 500 }],
        }),
      ),
    ).toEqual(expect.arrayContaining(['journal_line_side', 'journal_min_lines']))
    expect(
      issueKeys(
        ManualJournalCreateSchema.safeParse({
          ...base,
          lines: [
            { account_id: cash, debit_paise: 500, party_type: 'customer' },
            { account_id: capital, credit_paise: 500 },
          ],
        }),
      ),
    ).toContain('journal_party_pair')
    expect(
      issueKeys(
        ManualJournalCreateSchema.safeParse({
          entry_date: '2026-10-20',
          narration: ' ',
          lines: [
            { account_id: cash, debit_paise: 1 },
            { account_id: capital, credit_paise: 1 },
          ],
        }),
      ),
    ).toContain('narration_required')
    expect(issueKeys(JournalReverseSchema.safeParse({ reason: 'x' }))).toContain('reason_required')
  })

  it('links sources to web pages', () => {
    const sid = id()
    expect(journalSourcePath('sales_invoice', sid)).toBe(`/sales/invoices/${sid}`)
    expect(journalSourcePath('expense', sid)).toBe(`/accounting/expenses?id=${sid}`)
    expect(journalSourcePath('shift', sid)).toBe(`/accounting/shifts/${sid}`)
    expect(journalSourcePath('opening', sid)).toBeNull()
    expect(journalSourcePath('manual', null)).toBeNull()
  })

  it('list query coerces filters and checks pairs', () => {
    const q = JournalListQuerySchema.parse({
      from: '2026-10-01',
      to: '2026-10-31',
      source_type: 'manual',
      reversals: 'false',
      limit: '20',
    })
    expect(q.source_type).toEqual(['manual'])
    expect(q.reversals).toBe(false)
    expect(q.sort).toEqual({ field: 'entry_date', direction: 'desc' })
    expect(issueKeys(JournalListQuerySchema.safeParse({ party_type: 'customer' }))).toContain(
      'party_pair_required',
    )
    expect(
      issueKeys(JournalListQuerySchema.safeParse({ from: '2026-10-31', to: '2026-10-01' })),
    ).toContain('date_order')
  })
})

// ---------------------------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------------------------

describe('expenses', () => {
  it('computes GST from the taxable value or the bill total', () => {
    expect(
      computeExpenseAmounts({ taxable_paise: 10_000, gst_rate_bp: 1800, is_interstate: false }),
    ).toEqual({
      taxable_paise: 10_000,
      cgst_paise: 900,
      sgst_paise: 900,
      igst_paise: 0,
      tax_paise: 1800,
      total_paise: 11_800,
    })
    expect(
      computeExpenseAmounts({ total_paise: 11_800, gst_rate_bp: 1800, is_interstate: true }),
    ).toEqual({
      taxable_paise: 10_000,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 1800,
      tax_paise: 1800,
      total_paise: 11_800,
    })
    // odd tax paisa goes to CGST (pricing.ts splitGst)
    const odd = computeExpenseAmounts({ total_paise: 1001, gst_rate_bp: 500, is_interstate: false })
    expect(odd.taxable_paise + odd.tax_paise).toBe(1001)
    expect(odd.cgst_paise - odd.sgst_paise).toBe(odd.tax_paise % 2)
    expect(
      computeExpenseAmounts({ total_paise: 500, gst_rate_bp: 0, is_interstate: false }),
    ).toMatchObject({ taxable_paise: 500, tax_paise: 0, total_paise: 500 })
    expect(() => computeExpenseAmounts({ gst_rate_bp: 0, is_interstate: false })).toThrow()
  })

  it('posts balanced journals with and without ITC, paid or on credit', () => {
    const amounts = computeExpenseAmounts({
      taxable_paise: 10_000,
      gst_rate_bp: 1800,
      is_interstate: false,
    })
    const expenseAccount = id()
    const bank = id()
    const supplier = id()
    const withItc = expenseJournalLines({
      expense_account_id: expenseAccount,
      amounts,
      itc_eligible: true,
      payment_method: 'bank_transfer',
      paid_from_account_id: bank,
      supplier_id: null,
    })
    expect(balanced(withItc)).toBe(true)
    expect(withItc).toEqual([
      { account: { id: expenseAccount }, debit_paise: 10_000, credit_paise: 0 },
      { account: { subtype: 'input_cgst' }, debit_paise: 900, credit_paise: 0 },
      { account: { subtype: 'input_sgst' }, debit_paise: 900, credit_paise: 0 },
      { account: { id: bank }, debit_paise: 0, credit_paise: 11_800 },
    ])
    const noItc = expenseJournalLines({
      expense_account_id: expenseAccount,
      amounts,
      itc_eligible: false,
      payment_method: 'cash',
      paid_from_account_id: bank,
      supplier_id: null,
    })
    expect(noItc[0]).toEqual({
      account: { id: expenseAccount },
      debit_paise: 11_800,
      credit_paise: 0,
    })
    expect(noItc).toHaveLength(2)
    const credit = expenseJournalLines({
      expense_account_id: expenseAccount,
      amounts,
      itc_eligible: true,
      payment_method: 'credit',
      paid_from_account_id: null,
      supplier_id: supplier,
    })
    expect(balanced(credit)).toBe(true)
    expect(credit.at(-1)).toEqual({
      account: { subtype: 'payable' },
      debit_paise: 0,
      credit_paise: 11_800,
      party: { type: 'supplier', id: supplier },
    })
    expect(() =>
      expenseJournalLines({
        expense_account_id: expenseAccount,
        amounts,
        itc_eligible: false,
        payment_method: 'credit',
        paid_from_account_id: null,
        supplier_id: null,
      }),
    ).toThrow()
  })

  it('default paid-from account kind follows the method', () => {
    expect(defaultPaidFromKind('cash')).toBe('cash')
    expect(defaultPaidFromKind('upi')).toBe('bank')
    expect(defaultPaidFromKind('cheque')).toBe('bank')
    expect(defaultPaidFromKind('credit')).toBeNull()
  })

  it('validates the create body', () => {
    const base = {
      store_id: id(),
      expense_date: '2026-10-20',
      expense_account_id: id(),
      payment_method: 'cash',
    } as const
    const ok = ExpenseCreateSchema.parse({ ...base, total_paise: 25_000, description: 'Tea' })
    expect(ok).toMatchObject({ gst_rate_bp: 0, itc_eligible: false, total_paise: 25_000 })
    expect(issueKeys(ExpenseCreateSchema.safeParse(base))).toContain('expense_amount_required')
    expect(
      issueKeys(ExpenseCreateSchema.safeParse({ ...base, total_paise: 1, taxable_paise: 1 })),
    ).toContain('expense_amount_both')
    expect(
      issueKeys(ExpenseCreateSchema.safeParse({ ...base, total_paise: 100, itc_eligible: true })),
    ).toContain('itc_requires_gst')
    expect(
      issueKeys(
        ExpenseCreateSchema.safeParse({
          ...base,
          payment_method: 'credit',
          total_paise: 100,
          paid_from_account_id: id(),
        }),
      ),
    ).toEqual(
      expect.arrayContaining(['supplier_required_for_credit', 'paid_from_not_allowed_for_credit']),
    )
    expect(
      ExpenseCreateSchema.safeParse({ ...base, total_paise: 100, gst_rate_bp: 1700 }).success,
    ).toBe(false)
  })

  it('quick tiles resolve to preset or custom expense accounts', () => {
    const accounts = [
      ...DEFAULT_CHART.map((a) => ({
        id: id(),
        code: a.code,
        name: a.name,
        type: a.type,
        is_active: true,
      })),
      {
        id: id(),
        code: '5410',
        name: 'Tea & refreshments',
        type: 'expense' as const,
        is_active: true,
      },
    ]
    for (const tile of EXPENSE_QUICK_TILES) {
      const acct = resolveExpenseTile(tile, accounts)
      expect(acct, tile.key).not.toBeNull()
      expect(acct!.type).toBe('expense')
    }
    expect(
      resolveExpenseTile(
        EXPENSE_QUICK_TILES.find((t) => t.key === 'tea')!,
        accounts.slice(0, -1),
      ),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------------------------

describe('shift cash', () => {
  it('counts denominations', () => {
    const d = DenominationsSchema.parse({
      '500': 4,
      '200': 3,
      '100': 10,
      '50': 2,
      '20': 5,
      '10': 8,
      coins: 1250,
    })
    expect(d['2000']).toBe(0)
    expect(denominationsTotalPaise(d)).toBe((2000 + 600 + 1000 + 100 + 100 + 80) * 100 + 1250)
    expect(denominationsTotalPaise({})).toBe(0)
  })

  it('expected cash with mixed tenders, refunds, expenses and pay-ins / outs', () => {
    // opening ₹1,000; cash tenders ₹5,430 (net of change) + dues collected in cash ₹600;
    // cash refund ₹250 and a supplier paid ₹2,000 from the drawer; owner added ₹500 change;
    // ₹3,000 deposited in the bank; tea ₹120 paid in cash. UPI / card tenders don't touch cash.
    const m = {
      opening_cash_paise: 100_000,
      cash_receipts_paise: 543_000 + 60_000,
      cash_payments_paise: 25_000 + 200_000,
      pay_ins_paise: 50_000,
      pay_outs_paise: 300_000,
      cash_expenses_paise: 12_000,
    }
    expect(expectedShiftCash(m)).toBe(216_000)
    expect(shiftDifference(216_000, 215_500)).toEqual({ difference_paise: -500, status: 'short' })
    expect(shiftDifference(216_000, 216_100)).toEqual({ difference_paise: 100, status: 'excess' })
    expect(shiftDifference(216_000, 216_000).status).toBe('balanced')
  })

  it('posts differences and cash entries as balanced journals', () => {
    const cash = id()
    const short = shiftDifferenceJournalLines(-500, cash)
    expect(short).toEqual([
      { account: { subtype: 'cash_short_excess' }, debit_paise: 500, credit_paise: 0 },
      { account: { id: cash }, debit_paise: 0, credit_paise: 500 },
    ])
    expect(balanced(shiftDifferenceJournalLines(300, cash))).toBe(true)
    expect(shiftDifferenceJournalLines(300, cash)[0]).toEqual({
      account: { id: cash },
      debit_paise: 300,
      credit_paise: 0,
    })
    expect(shiftDifferenceJournalLines(0, cash)).toEqual([])
    const payOut = cashEntryJournalLines('pay_out', 300_000, cash, { subtype: 'bank' })
    expect(payOut[0]).toEqual({
      account: { subtype: 'bank' },
      debit_paise: 300_000,
      credit_paise: 0,
    })
    expect(balanced(payOut)).toBe(true)
    const payIn = cashEntryJournalLines('pay_in', 50_000, cash, {
      subtype: defaultCashEntryCounter('pay_in'),
    })
    expect(payIn[0]).toEqual({ account: { id: cash }, debit_paise: 50_000, credit_paise: 0 })
    expect(payIn[1]!.account).toEqual({ subtype: 'capital' })
    expect(defaultCashEntryCounter('pay_out')).toBe('drawings')
  })

  it('open / close bodies check the denomination total', () => {
    expect(
      ShiftOpenSchema.parse({
        register_id: id(),
        opening_cash_paise: 100_000,
        denominations: { '500': 2 },
      }).opening_cash_paise,
    ).toBe(100_000)
    expect(
      issueKeys(
        ShiftOpenSchema.safeParse({
          register_id: id(),
          opening_cash_paise: 100,
          denominations: { '10': 1 },
        }),
      ),
    ).toContain('denominations_total_mismatch')
    expect(
      issueKeys(
        ShiftCloseSchema.safeParse({ counted_cash_paise: 1000, denominations: { coins: 999 } }),
      ),
    ).toContain('denominations_total_mismatch')
    expect(ShiftCloseSchema.safeParse({ counted_cash_paise: 1000 }).success).toBe(true)
    expect(
      issueKeys(
        ShiftCashEntryCreateSchema.safeParse({
          kind: 'pay_out',
          amount_paise: 1,
          reason: 'Deposit',
          account_id: id(),
          counter: 'bank',
        }),
      ),
    ).toContain('cash_entry_counter_both')
    expect(
      issueKeys(
        ShiftCashEntryCreateSchema.safeParse({ kind: 'pay_out', amount_paise: 1, reason: '' }),
      ),
    ).toContain('reason_required')
  })
})

// ---------------------------------------------------------------------------------------------
// Books & statements
// ---------------------------------------------------------------------------------------------

describe('books and statements helpers', () => {
  it('running balances follow the natural side', () => {
    const r = runningBalances('asset', 1000, [
      { debit_paise: 500, credit_paise: 0 },
      { debit_paise: 0, credit_paise: 2000 },
    ])
    expect(r.rows.map((x) => x.balance_paise)).toEqual([1500, -500])
    expect(r.closing_balance_paise).toBe(-500)
    expect(
      runningBalances('liability', 0, [{ debit_paise: 0, credit_paise: 700 }])
        .closing_balance_paise,
    ).toBe(700)
  })

  it('trial balance sides, margins and P&L / balance sheet totals', () => {
    expect(trialBalanceSides(900, 400)).toEqual({ debit_paise: 500, credit_paise: 0 })
    expect(trialBalanceSides(400, 900)).toEqual({ debit_paise: 0, credit_paise: 500 })
    expect(marginBp(2500, 10_000)).toBe(2500)
    expect(marginBp(1, 3)).toBe(3333)
    expect(marginBp(-100, 0)).toBeNull()
    expect(profitLossTotals({ income: 100_000, cogs: 70_000, expenses: 12_000 })).toEqual({
      gross_profit_paise: 30_000,
      net_profit_paise: 18_000,
    })
    // assets 2,00,000 = liabilities 50,000 + capital 1,30,000 + profit 18,000 + retained 2,000
    expect(
      balanceSheetTotals({
        assets: 200_000,
        liabilities: 50_000,
        equity: 130_000,
        current_period_profit: 18_000,
        retained_earnings: 2000,
      }),
    ).toEqual({
      total_equity_paise: 150_000,
      total_liabilities_equity_paise: 200_000,
      difference_paise: 0,
      balanced: true,
    })
  })

  it('comparison ranges', () => {
    expect(comparisonRange('2026-10-01', '2026-10-31', 'previous_period')).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    })
    expect(comparisonRange('2026-04-01', '2026-10-20', 'previous_year')).toEqual({
      from: '2025-04-01',
      to: '2025-10-20',
    })
    expect(comparisonRange('2028-02-29', '2028-02-29', 'previous_year')).toEqual({
      from: '2027-02-28',
      to: '2027-02-28',
    })
  })

  it('query schemas', () => {
    expect(DayBookQuerySchema.parse({ date: '2026-10-20' })).toMatchObject({
      limit: 100,
      offset: 0,
      format: 'json',
    })
    expect(issueKeys(LedgerQuerySchema.safeParse({ party_id: id() }))).toContain(
      'party_pair_required',
    )
    expect(
      CashBookQuerySchema.parse({ account_id: id(), limit: '1000', format: 'csv' }).limit,
    ).toBe(1000)
    expect(CashBookQuerySchema.safeParse({ limit: '1001' }).success).toBe(false)
    expect(TrialBalanceQuerySchema.parse({ include_zero: 'true' }).include_zero).toBe(true)
    expect(issueKeys(ProfitLossQuerySchema.safeParse({ compare_from: '2026-01-01' }))).toContain(
      'compare_range_incomplete',
    )
    expect(
      ProfitLossQuerySchema.safeParse({
        from: '2026-04-01',
        to: '2026-10-20',
        compare_from: '2025-04-01',
        compare_to: '2025-10-20',
        store_id: id(),
      }).success,
    ).toBe(true)
    expect(BalanceSheetQuerySchema.parse({}).format).toBe('json')
    expect(
      ChartOfAccountsQuerySchema.parse({ type: ['asset', 'expense'], balances: '0' }),
    ).toMatchObject({
      type: ['asset', 'expense'],
      balances: false,
      include_inactive: false,
    })
    expect(ExpenseListQuerySchema.parse({ payment_method: 'cash' }).payment_method).toEqual([
      'cash',
    ])
    expect(ShiftListQuerySchema.parse({ difference: 'short' }).sort).toEqual({
      field: 'opened_at',
      direction: 'desc',
    })
    expect(ShiftCurrentQuerySchema.safeParse({}).success).toBe(false)
    expect(ExpenseCancelSchema.parse({ reason: 'Entered twice' }).reason).toBe('Entered twice')
  })
})

// ---------------------------------------------------------------------------------------------
// Response fixtures (schema smoke tests)
// ---------------------------------------------------------------------------------------------

describe('response schemas parse realistic fixtures', () => {
  const store = id()
  const account = {
    id: id(),
    code: '1100',
    name: 'Cash in hand',
    name_ta: 'கையிருப்பு ரொக்கம்',
    type: 'asset',
    subtype: 'cash',
    parent_id: null,
    is_system: true,
    is_active: true,
    store_id: null,
    money_kind: 'cash',
    details: {},
    created_at: new Date(),
    updated_at: NOW,
  }
  const balance = {
    ...account,
    debit_paise: 1_200_000,
    credit_paise: 200_000,
    balance_paise: 1_000_000,
    rollup_balance_paise: 1_000_000,
    depth: 0,
    has_entries: true,
  }

  it('accounts', () => {
    const chart = ChartOfAccountsSchema.parse({
      as_of: '2026-10-20',
      store_id: null,
      accounts: [
        balance,
        {
          ...balance,
          id: id(),
          code: '5250',
          subtype: 'cash_short_excess',
          type: 'expense',
          money_kind: null,
          details: { bank_name: null },
        },
      ],
      totals: [{ type: 'asset', balance_paise: 1_000_000 }],
    })
    expect(chart.accounts[0]!.created_at).toMatch(/Z$/)
    expect(chart.accounts[0]!.details).toEqual({
      bank_name: null,
      account_last4: null,
      ifsc: null,
      branch: null,
      account_holder: null,
    })
    expect(
      AccountBalanceSchema.safeParse({
        ...balance,
        balance_paise: null,
        debit_paise: null,
        credit_paise: null,
        rollup_balance_paise: null,
      }).success,
    ).toBe(true)
    AccountDetailSchema.parse({
      ...balance,
      parent: null,
      store_name: null,
      children_count: 0,
      line_count: 12,
      last_entry_date: '2026-10-20',
      editable_fields: ['name', 'name_ta', 'details'],
      can_delete: false,
      can_deactivate: false,
    })
  })

  const line = (debit: number, credit: number) => ({
    id: id(),
    account_id: id(),
    account_code: '1100',
    account_name: 'Cash in hand',
    account_name_ta: null,
    account_type: 'asset',
    account_subtype: 'cash',
    debit_paise: debit,
    credit_paise: credit,
    party_type: null,
    party_id: null,
    party_name: null,
    store_id: store,
    memo: null,
  })
  const entry = {
    id: id(),
    entry_date: '2026-10-20',
    number: 'JVS1/2627/00001',
    source_type: 'manual',
    source_id: null,
    source_number: 'JVS1/2627/00001',
    source_path: null,
    narration: 'Owner brought cash',
    store_id: store,
    store_name: 'Main',
    total_paise: 50_000,
    line_count: 2,
    debit_accounts: ['Cash in hand'],
    credit_accounts: ["Owner's capital"],
    reverses_entry_id: null,
    reversed_by_entry_id: null,
    created_by: id(),
    created_by_name: 'Murugan',
    created_at: NOW,
  }
  const entryDetail = {
    ...entry,
    lines: [line(50_000, 0), line(0, 50_000)],
    source: { type: 'manual', id: null, number: 'JVS1/2627/00001', path: null },
    reverses: null,
    reversed_by: null,
    can_reverse: true,
  }

  it('journals and books', () => {
    JournalListResponseSchema.parse({
      data: [entry],
      page: { limit: 50, offset: 0, total: 1 },
      summary: { count: 1, total_paise: 50_000 },
    })
    JournalEntryDetailSchema.parse(entryDetail)
    DayBookResponseSchema.parse({
      data: [entryDetail],
      page: { limit: 100, offset: 0, total: 1 },
      day: {
        date: '2026-10-20',
        store_id: null,
        entry_count: 1,
        total_debit_paise: 50_000,
        total_credit_paise: 50_000,
        by_source_type: [{ source_type: 'manual', count: 1, total_paise: 50_000 }],
      },
    })
    AccountLedgerResponseSchema.parse({
      data: [
        {
          entry_id: entry.id,
          line_id: id(),
          date: '2026-10-20',
          source_type: 'manual',
          source_id: null,
          source_number: 'JVS1/2627/00001',
          source_path: null,
          narration: 'Owner brought cash',
          memo: null,
          counter_accounts: ["Owner's capital"],
          party_type: null,
          party_id: null,
          party_name: null,
          debit_paise: 50_000,
          credit_paise: 0,
          balance_paise: 150_000,
        },
      ],
      page: { limit: 200, offset: 0, total: 1 },
      ledger: {
        account: {
          id: account.id,
          code: '1100',
          name: 'Cash in hand',
          name_ta: null,
          type: 'asset',
          subtype: 'cash',
        },
        party: null,
        store_id: null,
        from: '2026-10-01',
        to: '2026-10-20',
        opening_balance_paise: 100_000,
        total_debit_paise: 50_000,
        total_credit_paise: 0,
        closing_balance_paise: 150_000,
        page_opening_balance_paise: 100_000,
      },
    })
  })

  it('expenses', () => {
    const expense = {
      id: id(),
      store_id: store,
      store_name: 'Main',
      number: 'EXPS1/2627/00012',
      fy: '2026-27',
      expense_date: '2026-10-20',
      expense_account_id: id(),
      expense_account_code: '5310',
      expense_account_name: 'Electricity',
      expense_account_name_ta: 'மின்கட்டணம்',
      supplier_id: null,
      supplier_name: null,
      description: 'TNEB bill',
      taxable_paise: 345_000,
      gst_rate_bp: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      tax_paise: 0,
      itc_eligible: false,
      is_interstate: false,
      total_paise: 345_000,
      payment_method: 'upi',
      paid_from_account_id: id(),
      paid_from_account_name: 'Bank account',
      reference: 'UTR 4521',
      attachment_file_id: null,
      status: 'posted',
      shift_id: null,
      cancelled_at: null,
      cancelled_by: null,
      cancelled_by_name: null,
      cancel_reason: null,
      created_by: id(),
      created_by_name: 'Murugan',
      created_at: NOW,
      updated_at: NOW,
    }
    ExpenseListResponseSchema.parse({
      data: [expense],
      page: { limit: 50, offset: 0, total: 1 },
      summary: {
        count: 1,
        taxable_paise: 345_000,
        tax_paise: 0,
        itc_paise: 0,
        total_paise: 345_000,
        by_category: [
          {
            expense_account_id: expense.expense_account_id,
            code: '5310',
            name: 'Electricity',
            name_ta: 'மின்கட்டணம்',
            count: 1,
            total_paise: 345_000,
          },
        ],
        by_method: [{ payment_method: 'upi', count: 1, total_paise: 345_000 }],
      },
    })
    ExpenseDetailSchema.parse({
      ...expense,
      journal_entry_id: id(),
      reversal_entry_id: null,
      paid_paise: 345_000,
      due_paise: 0,
      payments: [],
      can_cancel: true,
    })
  })

  it('shifts', () => {
    const summary: ShiftSummary = {
      version: 1,
      report: 'Z',
      generated_at: NOW,
      from: NOW,
      to: NOW,
      bills: {
        count: 2,
        gross_paise: 64_300,
        discount_paise: 1000,
        taxable_paise: 58_000,
        tax_paise: 5300,
        round_off_paise: -10,
        total_paise: 63_290,
        avg_bill_paise: 31_645,
        item_lines: 7,
        credit_paise: 10_000,
      },
      payments_in: [{ method: 'cash', count: 1, amount_paise: 43_290 }],
      payments_out: [],
      dues_collected_paise: 0,
      returns: { count: 0, total_paise: 0 },
      cancelled_bills: { count: 0, total_paise: 0, items: [] },
      discounts: { item_paise: 1000, bill_paise: 0, total_paise: 1000 },
      top_items: [
        {
          product_id: id(),
          name: 'Ponni rice 25 kg',
          name_ta: 'பொன்னி அரிசி',
          unit: 'BAG',
          pack_size: 1,
          qty_milli: 1000,
          total_paise: 145_000,
        },
      ],
      expenses: { count: 0, cash_paise: 0 },
      cash: {
        opening_cash_paise: 100_000,
        cash_receipts_paise: 43_290,
        cash_payments_paise: 0,
        pay_ins_paise: 0,
        pay_outs_paise: 0,
        cash_expenses_paise: 0,
        expected_cash_paise: 143_290,
        counted_cash_paise: 143_000,
        difference_paise: -290,
      },
    }
    const shift = {
      id: id(),
      store_id: store,
      store_name: 'Main',
      register_id: id(),
      register_code: 'A',
      register_name: 'Counter A',
      status: 'closed',
      opened_by: id(),
      opened_by_name: 'Selvi',
      opened_at: NOW,
      opening_cash_paise: 100_000,
      closed_by: id(),
      closed_by_name: 'Selvi',
      closed_at: NOW,
      expected_cash_paise: 143_290,
      counted_cash_paise: 143_000,
      difference_paise: -290,
      difference_status: 'short',
      bills_count: 2,
      sales_total_paise: 63_290,
      notes: null,
      created_at: NOW,
      updated_at: NOW,
    }
    const cashEntry = {
      id: id(),
      shift_id: shift.id,
      kind: 'pay_out',
      amount_paise: 300_000,
      account_id: id(),
      account_code: '1200',
      account_name: 'Bank account',
      reason: 'Deposited in bank',
      created_by: null,
      created_by_name: null,
      created_at: NOW,
    }
    ShiftCashEntrySchema.parse(cashEntry)
    const detail = ShiftDetailSchema.parse({
      ...shift,
      denominations: { '500': 2 },
      summary,
      cash_entries: [cashEntry],
      can_close: false,
      can_add_cash_entry: false,
    })
    expect(detail.denominations!['2000']).toBe(0)
    ShiftListResponseSchema.parse({
      data: [shift],
      page: { limit: 50, offset: 0, total: 1 },
      summary: { count: 1, open_count: 0, short_paise: -290, excess_paise: 0 },
    })
    expect(accountingRoutes.currentShift.response.parse({ data: null })).toEqual({ data: null })
  })

  it('statements', () => {
    TrialBalanceSchema.parse({
      as_of: '2026-10-20',
      rows: [
        {
          account_id: id(),
          code: '1100',
          name: 'Cash in hand',
          name_ta: null,
          type: 'asset',
          subtype: 'cash',
          parent_id: null,
          debit_paise: 500,
          credit_paise: 0,
        },
        {
          account_id: id(),
          code: '3100',
          name: "Owner's capital",
          name_ta: null,
          type: 'equity',
          subtype: 'capital',
          parent_id: null,
          debit_paise: 0,
          credit_paise: 500,
        },
      ],
      total_debit_paise: 500,
      total_credit_paise: 500,
      difference_paise: 0,
      balanced: true,
    })
    const stLine = (amount: number, compare: number | null = null) => ({
      account_id: id(),
      code: '4100',
      name: 'Sales',
      name_ta: 'விற்பனை',
      subtype: 'sales',
      parent_id: null,
      amount_paise: amount,
      compare_paise: compare,
    })
    ProfitLossSchema.parse({
      from: '2026-04-01',
      to: '2026-10-20',
      store_id: null,
      compare: { from: '2025-04-01', to: '2025-10-20' },
      income: {
        lines: [stLine(100_000, 80_000), stLine(-2000, -1000)],
        total_paise: 98_000,
        compare_total_paise: 79_000,
      },
      cogs: { lines: [stLine(70_000, 60_000)], total_paise: 70_000, compare_total_paise: 60_000 },
      expenses: { lines: [stLine(12_000, 9000)], total_paise: 12_000, compare_total_paise: 9000 },
      net_sales_paise: 98_000,
      net_sales_compare_paise: 79_000,
      gross_profit_paise: 28_000,
      gross_profit_compare_paise: 19_000,
      net_profit_paise: 16_000,
      net_profit_compare_paise: 10_000,
      gross_margin_bp: 2857,
      net_margin_bp: 1633,
    })
    BalanceSheetSchema.parse({
      as_of: '2026-10-20',
      fy: '2026-27',
      fy_start: '2026-04-01',
      assets: { lines: [stLine(200_000)], total_paise: 200_000 },
      liabilities: { lines: [stLine(50_000)], total_paise: 50_000 },
      equity: { lines: [stLine(130_000)], total_paise: 130_000 },
      current_period_profit_paise: 18_000,
      retained_earnings_paise: 2000,
      total_equity_paise: 150_000,
      total_assets_paise: 200_000,
      total_liabilities_equity_paise: 200_000,
      difference_paise: 0,
      balanced: true,
    })
  })

  it('route catalogue builds URLs', () => {
    const accountId = id()
    expect(routeUrl(accountingRoutes.accountLedger, { accountId })).toBe(
      `/api/v1/books/ledger/${accountId}`,
    )
    expect(routeUrl(accountingRoutes.openShift)).toBe('/api/v1/shifts/open')
  })
})
