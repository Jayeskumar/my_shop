/**
 * Contract-shaped fixtures for the accounting screens (Vitest + MSW tests). Imports only
 * @kadai/shared so it runs anywhere; every factory returns data that parses with the response
 * schemas of the contract (checked in fixtures.test.ts), so the tests exercise real shapes.
 */
import type { AccountType } from '@kadai/shared'
import type {
  AccountBalance,
  AccountDetail,
  AccountLedgerResponse,
  AccountSubtype,
  BalanceSheet,
  ChartOfAccounts,
  DayBookResponse,
  Expense,
  ExpenseDetail,
  ExpenseListResponse,
  JournalEntry,
  JournalEntryDetail,
  JournalLine,
  JournalListResponse,
  ProfitLoss,
  Shift,
  ShiftCashEntry,
  ShiftDetail,
  ShiftListResponse,
  ShiftSummary,
  TrialBalance,
} from '@kadai/shared/api/accounting'
import type { UserDirectoryEntry } from '@kadai/shared/api/identity'
import type { SupplierListItem } from '@kadai/shared/api/parties'

export const NOW = '2026-10-20T10:00:00.000Z'
export const TODAY = '2026-10-20'
/** Ids of the signed-in test member (src/test/fixtures IDS). */
export const STORE_ID = '0192f0a0-0000-7000-8000-000000000301'
export const STORE2_ID = '0192f0a0-0000-7000-8000-000000000302'
export const REGISTER_ID = '0192f0a0-0000-7000-8000-000000000401'
export const USER_ID = '0192f0a0-0000-7000-8000-000000000001'

/** Deterministic UUID v7-shaped ids. */
export function iid(n: number): string {
  return `0192f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`
}

export const page = (total: number, limit = 50, offset = 0) => ({ limit, offset, total })

// ---------------------------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------------------------

/** Account ids by code. */
export const A = {
  cash: iid(1100),
  bank: iid(1200),
  receivable: iid(1300),
  inputCgst: iid(1510),
  payable: iid(2100),
  capital: iid(3100),
  drawings: iid(3200),
  sales: iid(4100),
  otherIncome: iid(4300),
  cogs: iid(5100),
  shortExcess: iid(5250),
  rent: iid(5300),
  electricity: iid(5310),
  salaries: iid(5320),
  transport: iid(5330),
  repairs: iid(5340),
  phone: iid(5350),
  packing: iid(5370),
  misc: iid(5390),
  /** Custom expense head under Rent (5300). */
  godownRent: iid(5301),
} as const

interface AccountSeed {
  id: string
  code: string
  name: string
  name_ta: string | null
  type: AccountType
  subtype: AccountSubtype | null
  balance: number
  parent_id?: string | null
  is_system?: boolean
  money_kind?: 'cash' | 'bank' | null
}

const SEEDS: AccountSeed[] = [
  {
    id: A.cash,
    code: '1100',
    name: 'Cash in hand',
    name_ta: 'கையிருப்பு ரொக்கம்',
    type: 'asset',
    subtype: 'cash',
    balance: 1_250_000,
    money_kind: 'cash',
  },
  {
    id: A.bank,
    code: '1200',
    name: 'Bank account',
    name_ta: 'வங்கிக் கணக்கு',
    type: 'asset',
    subtype: 'bank',
    balance: 8_400_000,
    money_kind: 'bank',
  },
  {
    id: A.receivable,
    code: '1300',
    name: 'Accounts receivable (Sundry debtors)',
    name_ta: 'வர வேண்டிய தொகை',
    type: 'asset',
    subtype: 'receivable',
    balance: 320_000,
  },
  {
    id: A.inputCgst,
    code: '1510',
    name: 'Input CGST',
    name_ta: 'உள்ளீட்டு CGST',
    type: 'asset',
    subtype: 'input_cgst',
    balance: 27_000,
  },
  {
    id: A.payable,
    code: '2100',
    name: 'Accounts payable (Sundry creditors)',
    name_ta: 'செலுத்த வேண்டிய தொகை',
    type: 'liability',
    subtype: 'payable',
    balance: 1_500_000,
  },
  {
    id: A.capital,
    code: '3100',
    name: "Owner's capital",
    name_ta: 'உரிமையாளர் முதலீடு',
    type: 'equity',
    subtype: 'capital',
    balance: 5_000_000,
  },
  {
    id: A.drawings,
    code: '3200',
    name: "Owner's drawings",
    name_ta: 'உரிமையாளர் எடுப்பு',
    type: 'equity',
    subtype: 'drawings',
    balance: -30_000,
  },
  {
    id: A.sales,
    code: '4100',
    name: 'Sales',
    name_ta: 'விற்பனை',
    type: 'income',
    subtype: 'sales',
    balance: 9_800_000,
  },
  {
    id: A.otherIncome,
    code: '4300',
    name: 'Other income',
    name_ta: 'இதர வருமானம்',
    type: 'income',
    subtype: 'other_income',
    balance: 0,
  },
  {
    id: A.cogs,
    code: '5100',
    name: 'Cost of goods sold',
    name_ta: 'விற்ற சரக்கின் அடக்க விலை',
    type: 'expense',
    subtype: 'cogs',
    balance: 7_200_000,
  },
  {
    id: A.shortExcess,
    code: '5250',
    name: 'Cash short / excess',
    name_ta: 'ரொக்கக் குறைவு / மிகுதி',
    type: 'expense',
    subtype: 'cash_short_excess',
    balance: 2_000,
  },
  {
    id: A.rent,
    code: '5300',
    name: 'Rent',
    name_ta: 'வாடகை',
    type: 'expense',
    subtype: null,
    balance: 1_500_000,
  },
  {
    id: A.electricity,
    code: '5310',
    name: 'Electricity',
    name_ta: 'மின்கட்டணம்',
    type: 'expense',
    subtype: null,
    balance: 384_000,
  },
  {
    id: A.salaries,
    code: '5320',
    name: 'Salaries & wages',
    name_ta: 'சம்பளம் & கூலி',
    type: 'expense',
    subtype: null,
    balance: 2_200_000,
  },
  {
    id: A.transport,
    code: '5330',
    name: 'Transport & freight',
    name_ta: 'போக்குவரத்து & சரக்குக் கட்டணம்',
    type: 'expense',
    subtype: null,
    balance: 57_000,
  },
  {
    id: A.repairs,
    code: '5340',
    name: 'Repairs & maintenance',
    name_ta: 'பழுது பார்த்தல் & பராமரிப்பு',
    type: 'expense',
    subtype: null,
    balance: 250_000,
  },
  {
    id: A.phone,
    code: '5350',
    name: 'Telephone & internet',
    name_ta: 'தொலைபேசி & இணையம்',
    type: 'expense',
    subtype: null,
    balance: 50_763,
  },
  {
    id: A.packing,
    code: '5370',
    name: 'Packing materials',
    name_ta: 'பேக்கிங் பொருட்கள்',
    type: 'expense',
    subtype: null,
    balance: 82_600,
  },
  {
    id: A.misc,
    code: '5390',
    name: 'Miscellaneous expenses',
    name_ta: 'இதர செலவுகள்',
    type: 'expense',
    subtype: null,
    balance: 0,
  },
  {
    id: A.godownRent,
    code: '5301',
    name: 'Godown rent',
    name_ta: null,
    type: 'expense',
    subtype: null,
    balance: 600_000,
    parent_id: A.rent,
    is_system: false,
  },
]

function accountOf(s: AccountSeed, withBalances: boolean): AccountBalance {
  const debitNormal = s.type === 'asset' || s.type === 'expense'
  const abs = Math.abs(s.balance)
  const normalSide = s.balance >= 0
  const debit = debitNormal === normalSide ? abs : 0
  const credit = debitNormal === normalSide ? 0 : abs
  const children = SEEDS.filter((c) => c.parent_id === s.id)
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    name_ta: s.name_ta,
    type: s.type,
    subtype: s.subtype,
    parent_id: s.parent_id ?? null,
    is_system: s.is_system ?? true,
    is_active: true,
    store_id: null,
    money_kind: s.money_kind ?? null,
    details: {
      bank_name: s.money_kind === 'bank' ? 'Indian Bank' : null,
      account_last4: s.money_kind === 'bank' ? '4321' : null,
      ifsc: s.money_kind === 'bank' ? 'IDIB000M001' : null,
      branch: null,
      account_holder: null,
    },
    created_at: NOW,
    updated_at: NOW,
    debit_paise: withBalances ? debit : null,
    credit_paise: withBalances ? credit : null,
    balance_paise: withBalances ? s.balance : null,
    rollup_balance_paise: withBalances
      ? s.balance + children.reduce((n, c) => n + c.balance, 0)
      : null,
    depth: s.parent_id ? 1 : 0,
    has_entries: s.balance !== 0,
  }
}

/** All fixture accounts (balances included unless `balances: false`). */
export function accounts(options: { balances?: boolean } = {}): AccountBalance[] {
  return SEEDS.map((s) => accountOf(s, options.balances ?? true)).sort((a, b) =>
    a.code.localeCompare(b.code),
  )
}

export function account(id: string, options: { balances?: boolean } = {}): AccountBalance {
  const found = accounts(options).find((a) => a.id === id)
  if (!found) throw new Error(`no fixture account ${id}`)
  return found
}

/** GET /accounts payload, filtered like the server (type, money, q). */
export function chart(
  query: { type?: string[]; money?: string | null; balances?: boolean; as_of?: string } = {},
): ChartOfAccounts {
  const balances = query.balances ?? true
  const rows = accounts({ balances }).filter(
    (a) =>
      (!query.type?.length || query.type.includes(a.type)) &&
      (!query.money || a.money_kind === query.money),
  )
  const types: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense']
  return {
    as_of: query.as_of ?? TODAY,
    store_id: null,
    accounts: rows,
    totals: types.map((type) => ({
      type,
      balance_paise: balances
        ? rows.filter((a) => a.type === type).reduce((n, a) => n + (a.balance_paise ?? 0), 0)
        : null,
    })),
  }
}

export function accountDetail(id: string, patch: Partial<AccountDetail> = {}): AccountDetail {
  const a = account(id)
  const custom = !a.is_system
  return {
    ...a,
    parent: a.parent_id ? { id: A.rent, code: '5300', name: 'Rent' } : null,
    store_name: null,
    children_count: SEEDS.filter((s) => s.parent_id === id).length,
    line_count: a.has_entries ? 4 : 0,
    last_entry_date: a.has_entries ? TODAY : null,
    editable_fields: custom
      ? ['code', 'name', 'name_ta', 'parent_id', 'store_id', 'details', 'is_active']
      : ['name', 'name_ta', 'details'],
    can_delete: custom && !a.has_entries,
    can_deactivate: custom,
    ...patch,
  }
}

// ---------------------------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------------------------

export const EXPENSE_ID = iid(2001)
export const SUPPLIER_ID = iid(2901)

export function expense(patch: Partial<Expense> = {}): Expense {
  return {
    id: EXPENSE_ID,
    store_id: STORE_ID,
    store_name: 'Main store',
    number: 'EXPS1/2627/00012',
    fy: '2026-27',
    expense_date: TODAY,
    expense_account_id: A.electricity,
    expense_account_code: '5310',
    expense_account_name: 'Electricity',
    expense_account_name_ta: 'மின்கட்டணம்',
    supplier_id: null,
    supplier_name: null,
    description: 'EB bill — Sept/Oct',
    taxable_paise: 384_000,
    gst_rate_bp: 0,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    tax_paise: 0,
    itc_eligible: false,
    is_interstate: false,
    total_paise: 384_000,
    payment_method: 'upi',
    paid_from_account_id: A.bank,
    paid_from_account_name: 'Bank account',
    reference: 'EB-2291',
    attachment_file_id: null,
    status: 'posted',
    shift_id: null,
    cancelled_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancel_reason: null,
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  }
}

export function expenseDetail(patch: Partial<ExpenseDetail> = {}): ExpenseDetail {
  const base = expense(patch)
  return {
    ...base,
    journal_entry_id: iid(3101),
    reversal_entry_id: null,
    paid_paise: base.total_paise,
    due_paise: 0,
    payments: [],
    can_cancel: base.status === 'posted',
    ...patch,
  }
}

export function expenseRows(): Expense[] {
  return [
    expense(),
    expense({
      id: iid(2002),
      number: 'EXPS1/2627/00011',
      expense_account_id: A.repairs,
      expense_account_code: '5340',
      expense_account_name: 'Repairs & maintenance',
      expense_account_name_ta: 'பழுது பார்த்தல் & பராமரிப்பு',
      description: 'Freezer repair',
      taxable_paise: 250_000,
      gst_rate_bp: 1800,
      cgst_paise: 22_500,
      sgst_paise: 22_500,
      tax_paise: 45_000,
      itc_eligible: true,
      total_paise: 295_000,
      payment_method: 'cash',
      paid_from_account_id: A.cash,
      paid_from_account_name: 'Cash in hand',
    }),
    expense({
      id: iid(2003),
      number: 'EXPS1/2627/00010',
      expense_account_id: A.misc,
      expense_account_code: '5390',
      expense_account_name: 'Miscellaneous expenses',
      expense_account_name_ta: 'இதர செலவுகள்',
      description: 'Pooja items',
      taxable_paise: 25_000,
      total_paise: 25_000,
      payment_method: 'cash',
      paid_from_account_id: A.cash,
      paid_from_account_name: 'Cash in hand',
      status: 'cancelled',
      cancelled_at: NOW,
      cancelled_by: USER_ID,
      cancelled_by_name: 'Murugan K',
      cancel_reason: 'Entered twice',
    }),
  ]
}

export function expenseList(
  options: { total?: number; offset?: number } = {},
): ExpenseListResponse {
  const rows = expenseRows()
  return {
    data: rows,
    page: page(options.total ?? rows.length, 50, options.offset ?? 0),
    summary: {
      count: 2,
      taxable_paise: 634_000,
      tax_paise: 45_000,
      itc_paise: 45_000,
      total_paise: 679_000,
      by_category: [
        {
          expense_account_id: A.electricity,
          code: '5310',
          name: 'Electricity',
          name_ta: 'மின்கட்டணம்',
          count: 1,
          total_paise: 384_000,
        },
        {
          expense_account_id: A.repairs,
          code: '5340',
          name: 'Repairs & maintenance',
          name_ta: 'பழுது பார்த்தல் & பராமரிப்பு',
          count: 1,
          total_paise: 295_000,
        },
      ],
      by_method: [
        { payment_method: 'upi', count: 1, total_paise: 384_000 },
        { payment_method: 'cash', count: 1, total_paise: 295_000 },
      ],
    },
  }
}

export function supplier(patch: Partial<SupplierListItem> = {}): SupplierListItem {
  return {
    id: SUPPLIER_ID,
    code: 'SUP-001',
    name: 'Sri Balaji Agencies',
    contact_person: 'Balaji',
    phone: '+919840012345',
    gstin: '33AABCS1234F1Z5',
    state_code: '33',
    drug_license_no: null,
    payment_terms_days: 15,
    balance_paise: 0,
    overdue_paise: 0,
    upi_vpa: null,
    is_active: true,
    last_bill_date: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  }
}

// ---------------------------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------------------------

export const SHIFT_OPEN_ID = iid(4001)
export const SHIFT_CLOSED_ID = iid(4002)

export function summary(patch: Partial<ShiftSummary> = {}): ShiftSummary {
  return {
    version: 1,
    report: 'X',
    generated_at: NOW,
    from: '2026-10-20T03:30:00.000Z',
    to: NOW,
    bills: {
      count: 42,
      gross_paise: 1_865_000,
      discount_paise: 15_000,
      taxable_paise: 1_700_000,
      tax_paise: 150_000,
      round_off_paise: 0,
      total_paise: 1_850_000,
      avg_bill_paise: 44_048,
      item_lines: 137,
      credit_paise: 120_000,
    },
    payments_in: [
      { method: 'cash', count: 30, amount_paise: 1_130_000 },
      { method: 'upi', count: 12, amount_paise: 600_000 },
    ],
    payments_out: [{ method: 'cash', count: 1, amount_paise: 20_000 }],
    dues_collected_paise: 50_000,
    returns: { count: 1, total_paise: 20_000 },
    cancelled_bills: {
      count: 1,
      total_paise: 9_000,
      items: [
        {
          invoice_id: iid(4901),
          number: 'S1-A/2627/00087',
          total_paise: 9_000,
          reason: 'Wrong item',
          cancelled_by_name: 'Murugan K',
        },
      ],
    },
    discounts: { item_paise: 10_000, bill_paise: 5_000, total_paise: 15_000 },
    top_items: [
      {
        product_id: iid(4801),
        name: 'Ponni Rice 25 kg',
        name_ta: 'பொன்னி அரிசி 25 கி',
        unit: 'BAG',
        pack_size: 1,
        qty_milli: 6_000,
        total_paise: 828_000,
      },
    ],
    expenses: { count: 1, cash_paise: 12_000 },
    cash: {
      opening_cash_paise: 250_000,
      cash_receipts_paise: 1_130_000,
      cash_payments_paise: 20_000,
      pay_ins_paise: 50_000,
      pay_outs_paise: 100_000,
      cash_expenses_paise: 12_000,
      expected_cash_paise: 1_298_000,
      counted_cash_paise: null,
      difference_paise: null,
    },
    ...patch,
  }
}

export function cashEntry(patch: Partial<ShiftCashEntry> = {}): ShiftCashEntry {
  return {
    id: iid(4101),
    shift_id: SHIFT_OPEN_ID,
    kind: 'pay_out',
    amount_paise: 100_000,
    account_id: A.bank,
    account_code: '1200',
    account_name: 'Bank account',
    reason: 'Deposited in bank',
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    created_at: NOW,
    ...patch,
  }
}

export function shift(patch: Partial<Shift> = {}): Shift {
  return {
    id: SHIFT_OPEN_ID,
    store_id: STORE_ID,
    store_name: 'Main store',
    register_id: REGISTER_ID,
    register_code: 'A',
    register_name: 'Counter A',
    status: 'open',
    opened_by: USER_ID,
    opened_by_name: 'Murugan K',
    opened_at: '2026-10-20T03:30:00.000Z',
    opening_cash_paise: 250_000,
    closed_by: null,
    closed_by_name: null,
    closed_at: null,
    expected_cash_paise: null,
    counted_cash_paise: null,
    difference_paise: null,
    difference_status: null,
    bills_count: null,
    sales_total_paise: null,
    notes: null,
    created_at: '2026-10-20T03:30:00.000Z',
    updated_at: NOW,
    ...patch,
  }
}

export function closedShift(patch: Partial<Shift> = {}): Shift {
  return shift({
    id: SHIFT_CLOSED_ID,
    status: 'closed',
    opened_at: '2026-10-19T03:30:00.000Z',
    closed_by: USER_ID,
    closed_by_name: 'Murugan K',
    closed_at: '2026-10-19T15:30:00.000Z',
    expected_cash_paise: 1_298_000,
    counted_cash_paise: 1_296_000,
    difference_paise: -2_000,
    difference_status: 'short',
    bills_count: 42,
    sales_total_paise: 1_850_000,
    notes: '₹20 short — change error',
    ...patch,
  })
}

export function shiftDetail(patch: Partial<ShiftDetail> = {}): ShiftDetail {
  return {
    ...shift(),
    denominations: { '2000': 0, '500': 3, '200': 2, '100': 5, '50': 2, '20': 0, '10': 0, coins: 0 },
    summary: summary(),
    cash_entries: [cashEntry()],
    can_close: true,
    can_add_cash_entry: true,
    ...patch,
  }
}

export function closedShiftDetail(patch: Partial<ShiftDetail> = {}): ShiftDetail {
  const s = summary({ report: 'Z' })
  return {
    ...closedShift(),
    denominations: {
      '2000': 0,
      '500': 20,
      '200': 10,
      '100': 15,
      '50': 10,
      '20': 5,
      '10': 6,
      coins: 0,
    },
    summary: {
      ...s,
      cash: { ...s.cash, counted_cash_paise: 1_296_000, difference_paise: -2_000 },
    },
    cash_entries: [cashEntry({ shift_id: SHIFT_CLOSED_ID })],
    can_close: false,
    can_add_cash_entry: false,
    ...patch,
  }
}

export function shiftList(): ShiftListResponse {
  return {
    data: [shift(), closedShift()],
    page: page(2),
    summary: { count: 2, open_count: 1, short_paise: -2_000, excess_paise: 0 },
  }
}

export function users(): UserDirectoryEntry[] {
  return [
    {
      id: USER_ID,
      full_name: 'Murugan K',
      role_code: 'owner',
      role_name: 'Owner',
      role_name_ta: 'உரிமையாளர்',
      status: 'active',
      store_ids: null,
    },
    {
      id: iid(9002),
      full_name: 'Selvi R',
      role_code: 'cashier',
      role_name: 'Cashier',
      role_name_ta: 'காசாளர்',
      status: 'active',
      store_ids: [STORE_ID],
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------------------------

export const JV_ID = iid(5001)

function line(
  n: number,
  accountId: string,
  side: { debit?: number; credit?: number },
  patch: Partial<JournalLine> = {},
): JournalLine {
  const a = account(accountId, { balances: false })
  return {
    id: iid(5500 + n),
    account_id: a.id,
    account_code: a.code,
    account_name: a.name,
    account_name_ta: a.name_ta,
    account_type: a.type,
    account_subtype: a.subtype,
    debit_paise: side.debit ?? 0,
    credit_paise: side.credit ?? 0,
    party_type: null,
    party_id: null,
    party_name: null,
    store_id: STORE_ID,
    memo: null,
    ...patch,
  }
}

export function journalEntry(patch: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: JV_ID,
    entry_date: TODAY,
    number: 'JVS1/2627/00002',
    source_type: 'manual',
    source_id: iid(5101),
    source_number: 'JVS1/2627/00002',
    source_path: `/accounting/journal?id=${JV_ID}`,
    narration: 'Cash withdrawn from bank for change',
    store_id: STORE_ID,
    store_name: 'Main store',
    total_paise: 500_000,
    line_count: 2,
    debit_accounts: ['Cash in hand'],
    credit_accounts: ['Bank account'],
    reverses_entry_id: null,
    reversed_by_entry_id: null,
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    created_at: NOW,
    ...patch,
  }
}

export function journalDetail(patch: Partial<JournalEntryDetail> = {}): JournalEntryDetail {
  const e = journalEntry(patch)
  return {
    ...e,
    lines: [line(1, A.cash, { debit: 500_000 }), line(2, A.bank, { credit: 500_000 })],
    source: { type: e.source_type, id: e.source_id, number: e.source_number, path: e.source_path },
    reverses: null,
    reversed_by: null,
    can_reverse: e.source_type === 'manual' && !e.reversed_by_entry_id,
    ...patch,
  }
}

export function expenseJournalDetail(): JournalEntryDetail {
  return journalDetail({
    id: iid(5002),
    number: null,
    source_type: 'expense',
    source_id: EXPENSE_ID,
    source_number: 'EXPS1/2627/00012',
    source_path: `/accounting/expenses?id=${EXPENSE_ID}`,
    narration: 'Expense EXPS1/2627/00012 — Electricity',
    total_paise: 384_000,
    debit_accounts: ['Electricity'],
    credit_accounts: ['Bank account'],
    lines: [
      line(3, A.electricity, { debit: 384_000 }),
      line(4, A.bank, { credit: 384_000 }, { memo: 'EB-2291' }),
    ],
    source: {
      type: 'expense',
      id: EXPENSE_ID,
      number: 'EXPS1/2627/00012',
      path: `/accounting/expenses?id=${EXPENSE_ID}`,
    },
    can_reverse: false,
  })
}

export function journalList(): JournalListResponse {
  const rows = [
    journalEntry(),
    journalEntry({
      id: iid(5002),
      number: null,
      source_type: 'expense',
      source_id: EXPENSE_ID,
      source_number: 'EXPS1/2627/00012',
      source_path: `/accounting/expenses?id=${EXPENSE_ID}`,
      narration: 'Expense EXPS1/2627/00012 — Electricity',
      total_paise: 384_000,
      debit_accounts: ['Electricity'],
      credit_accounts: ['Bank account'],
    }),
  ]
  return { data: rows, page: page(rows.length), summary: { count: 2, total_paise: 884_000 } }
}

// ---------------------------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------------------------

export function dayBook(date = TODAY): DayBookResponse {
  const entries = [journalDetail({ entry_date: date }), expenseJournalDetail()]
  return {
    data: entries,
    page: page(entries.length, 100),
    day: {
      date,
      store_id: null,
      entry_count: 2,
      total_debit_paise: 884_000,
      total_credit_paise: 884_000,
      by_source_type: [
        { source_type: 'manual', count: 1, total_paise: 500_000 },
        { source_type: 'expense', count: 1, total_paise: 384_000 },
      ],
    },
  }
}

export function ledger(
  accountId: string = A.cash,
  range: { from: string; to: string } = { from: '2026-10-01', to: TODAY },
): AccountLedgerResponse {
  const a = account(accountId, { balances: false })
  return {
    data: [
      {
        entry_id: JV_ID,
        line_id: iid(5501),
        date: '2026-10-19',
        source_type: 'manual',
        source_id: iid(5101),
        source_number: 'JVS1/2627/00002',
        source_path: `/accounting/journal?id=${JV_ID}`,
        narration: 'Cash withdrawn from bank for change',
        memo: null,
        counter_accounts: ['Bank account'],
        party_type: null,
        party_id: null,
        party_name: null,
        debit_paise: 500_000,
        credit_paise: 0,
        balance_paise: 1_500_000,
      },
      {
        entry_id: iid(5003),
        line_id: iid(5505),
        date: TODAY,
        source_type: 'expense',
        source_id: iid(2002),
        source_number: 'EXPS1/2627/00011',
        source_path: `/accounting/expenses?id=${iid(2002)}`,
        narration: 'Expense EXPS1/2627/00011 — Repairs',
        memo: null,
        counter_accounts: ['Repairs & maintenance', 'Input CGST'],
        party_type: null,
        party_id: null,
        party_name: null,
        debit_paise: 0,
        credit_paise: 250_000,
        balance_paise: 1_250_000,
      },
    ],
    page: page(2, 200),
    ledger: {
      account: {
        id: a.id,
        code: a.code,
        name: a.name,
        name_ta: a.name_ta,
        type: a.type,
        subtype: a.subtype,
      },
      party: null,
      store_id: null,
      from: range.from,
      to: range.to,
      opening_balance_paise: 1_000_000,
      total_debit_paise: 500_000,
      total_credit_paise: 250_000,
      closing_balance_paise: 1_250_000,
      page_opening_balance_paise: 1_000_000,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

function stmtLine(accountId: string, amount: number, compare: number | null = null) {
  const a = account(accountId, { balances: false })
  return {
    account_id: a.id,
    code: a.code,
    name: a.name,
    name_ta: a.name_ta,
    subtype: a.subtype,
    parent_id: a.parent_id,
    amount_paise: amount,
    compare_paise: compare,
  }
}

export function profitLoss(
  query: { from?: string; to?: string; compare_from?: string; compare_to?: string } = {},
): ProfitLoss {
  const comparing = Boolean(query.compare_from && query.compare_to)
  const c = (n: number) => (comparing ? n : null)
  return {
    from: query.from ?? '2026-04-01',
    to: query.to ?? TODAY,
    store_id: null,
    compare:
      comparing && query.compare_from && query.compare_to
        ? { from: query.compare_from, to: query.compare_to }
        : null,
    income: {
      lines: [stmtLine(A.sales, 9_800_000, c(8_000_000))],
      total_paise: 9_800_000,
      compare_total_paise: c(8_000_000),
    },
    cogs: {
      lines: [stmtLine(A.cogs, 7_200_000, c(6_000_000))],
      total_paise: 7_200_000,
      compare_total_paise: c(6_000_000),
    },
    expenses: {
      lines: [
        stmtLine(A.rent, 1_500_000, c(1_500_000)),
        stmtLine(A.electricity, 384_000, c(300_000)),
      ],
      total_paise: 1_884_000,
      compare_total_paise: c(1_800_000),
    },
    net_sales_paise: 9_800_000,
    net_sales_compare_paise: c(8_000_000),
    gross_profit_paise: 2_600_000,
    gross_profit_compare_paise: c(2_000_000),
    net_profit_paise: 716_000,
    net_profit_compare_paise: c(200_000),
    gross_margin_bp: 2653,
    net_margin_bp: 731,
  }
}

export function balanceSheet(asOf = TODAY): BalanceSheet {
  return {
    as_of: asOf,
    fy: '2026-27',
    fy_start: '2026-04-01',
    assets: {
      lines: [stmtLine(A.cash, 1_250_000), stmtLine(A.bank, 6_966_000)],
      total_paise: 8_216_000,
    },
    liabilities: { lines: [stmtLine(A.payable, 1_500_000)], total_paise: 1_500_000 },
    equity: { lines: [stmtLine(A.capital, 6_000_000)], total_paise: 6_000_000 },
    current_period_profit_paise: 716_000,
    retained_earnings_paise: 0,
    total_equity_paise: 6_716_000,
    total_assets_paise: 8_216_000,
    total_liabilities_equity_paise: 8_216_000,
    difference_paise: 0,
    balanced: true,
  }
}

export function trialBalance(asOf = TODAY): TrialBalance {
  const row = (id: string, debit: number, credit: number) => {
    const a = account(id, { balances: false })
    return {
      account_id: a.id,
      code: a.code,
      name: a.name,
      name_ta: a.name_ta,
      type: a.type,
      subtype: a.subtype,
      parent_id: a.parent_id,
      debit_paise: debit,
      credit_paise: credit,
    }
  }
  return {
    as_of: asOf,
    rows: [
      row(A.cash, 1_250_000, 0),
      row(A.bank, 8_400_000, 0),
      row(A.capital, 0, 5_000_000),
      row(A.sales, 0, 9_800_000),
      row(A.cogs, 5_150_000, 0),
    ],
    total_debit_paise: 14_800_000,
    total_credit_paise: 14_800_000,
    difference_paise: 0,
    balanced: true,
  }
}
