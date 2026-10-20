/**
 * Contract for the accounting module — docs/API.md "accounting"; ARCHITECTURE.md §8.3 (ledger
 * posting), §10 (posting rules).
 *
 *  - Chart of accounts: system accounts (DEFAULT_CHART, addressed by `subtype`) + custom accounts
 *    (expense heads, extra bank / cash accounts). Balances are always derived from journal_lines
 *    (core/ledger.ts is the only writer); this module never stores balances.
 *  - Journal entries: read every posted entry with its lines and source document; manual journal
 *    vouchers (JV series, balanced, audited) and their one-time reversal.
 *  - Expenses: GST-aware expense vouchers (EXP series) posting Dr expense (+ input tax with ITC) /
 *    Cr cash / bank / payable(supplier); cancellation = reversal.
 *  - Register shifts (feature `shifts`): open with a float, pay-ins / pay-outs, X report while open,
 *    close with a denomination count → Z report; the difference posts to cash short / excess.
 *  - Books (day book, cash book, account ledger) and statements (trial balance, profit & loss,
 *    balance sheet), all CSV-exportable with `?format=csv`.
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope
 * (dataOf / listOf); money in integer paise (signed where a balance can be negative). Account
 * balances are "natural": positive = the account's normal side (assets & expenses: debit;
 * liabilities, equity & income: credit). Custom validation messages are snake_case keys
 * (ACCOUNTING_VALIDATION_KEYS), translated by the web (errors:validation.<key>, else
 * accounting:validation.<key>).
 */
import { z } from 'zod'
import {
  SYSTEM_ACCOUNT_SUBTYPES,
  type SystemAccountSubtype,
  naturalBalance,
  normalBalanceOf,
} from '../accounting'
import {
  AccountTypeSchema,
  type AccountType,
  ExpensePaymentMethodSchema,
  type ExpensePaymentMethod,
  ExpenseStatusSchema,
  type ExpenseStatus,
  JournalSourceTypeSchema,
  type JournalSourceType,
  PartyTypeSchema,
  PaymentMethodSchema,
  ShiftCashEntryKindSchema,
  type ShiftCashEntryKind,
  ShiftStatusSchema,
  type ShiftStatus,
} from '../enums'
import { addDays, addMonths, diffDays } from '../fy'
import { splitGst } from '../gst'
import { roundDiv, sumSafe } from '../math'
import {
  PageQuerySchema,
  dataOf,
  defineRoutes,
  listOf,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zGstRateBp,
  zId,
  zIdempotencyKey,
  zPaise,
  zSearchQuery,
  zSignedPaise,
  zTimestamp,
} from './common'
import { type BilingualLabel, DOCUMENT_ROUTES, DeleteResultSchema } from './identity'
import { LEDGER_SOURCE_LABELS } from './parties'
import {
  DATE_ORDER_ISSUE,
  DATE_RANGE_FIELDS,
  dateOrderOk,
  zAmountPaise,
  zIfUpdatedAt,
  zListFormat,
  zNullableText,
  zQueryInt,
  zQueryList,
  zReason,
} from './payments'

// =============================================================================================
// Validation keys & labels
// =============================================================================================

/** Message keys of the custom rules in this contract (web: accounting:validation.<key>). */
export const ACCOUNTING_VALIDATION_KEYS = [
  'account_code_format',
  'account_code_type',
  'bank_last4',
  'ifsc',
  'journal_min_lines',
  'journal_line_side',
  'journal_unbalanced',
  'journal_party_pair',
  'narration_required',
  'expense_amount_required',
  'expense_amount_both',
  'itc_requires_gst',
  'supplier_required_for_credit',
  'paid_from_not_allowed_for_credit',
  'denominations_total_mismatch',
  'cash_entry_counter_both',
  'party_pair_required',
  'compare_range_incomplete',
  'reason_required',
  'date_order',
  'empty_patch',
] as const
export type AccountingValidationKey = (typeof ACCOUNTING_VALIDATION_KEYS)[number]

/**
 * `details.reason` values of the module's 409 / 422 / 403 errors (the web shows
 * accounting:errors.<reason>).
 */
export const ACCOUNTING_ERROR_REASONS = [
  'system_account_locked', // 422: system accounts accept only name / name_ta / details
  'account_parent_type', // 422: parent must be an active account of the same type
  'account_has_balance', // 409: a balance-sheet account with a non-zero balance cannot be deactivated
  'account_inactive', // 422: posting to / choosing an inactive account
  'expense_account_required', // 422: expense_account_id is not an expense-type account
  'expense_accounts_only', // 403: expenses.write (without accounting.write) creates expense heads only
  'money_account_required', // 422: paid_from_account_id / cash-book account must be a cash or bank account
  'party_required', // 422: receivable / payable lines need a party
  'party_not_allowed', // 422: supplier on receivable, customer on payable
  'not_manual', // 409: only manual journals can be reversed here (documents are cancelled)
  'already_reversed', // 409
  'itc_not_allowed', // 422: composition / unregistered tenants cannot claim ITC
  'expense_cancelled', // 409
  'expense_has_payments', // 409: a credit expense with supplier payments allocated
  'shift_already_open', // 409 (details.shift_id)
  'shift_closed', // 409
  'not_own_shift', // 403: closing / cash entries on another member's shift need shifts.manage
  'all_stores_required', // 403: trial balance / balance sheet need access to every store
] as const
export type AccountingErrorReason = (typeof ACCOUNTING_ERROR_REASONS)[number]

export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, BilingualLabel>> = {
  asset: { en: 'Assets', ta: 'சொத்துகள்' },
  liability: { en: 'Liabilities', ta: 'பொறுப்புகள் (கடன்கள்)' },
  equity: { en: 'Capital', ta: 'மூலதனம்' },
  income: { en: 'Income', ta: 'வருமானம்' },
  expense: { en: 'Expenses', ta: 'செலவுகள்' },
}

export const EXPENSE_PAYMENT_METHOD_LABELS: Readonly<Record<ExpensePaymentMethod, BilingualLabel>> =
  {
    cash: { en: 'Cash', ta: 'ரொக்கம்' },
    upi: { en: 'UPI', ta: 'UPI' },
    card: { en: 'Card', ta: 'கார்டு' },
    bank_transfer: { en: 'Bank transfer', ta: 'வங்கிப் பரிமாற்றம்' },
    cheque: { en: 'Cheque', ta: 'காசோலை' },
    credit: { en: 'On credit (pay later)', ta: 'கடனுக்கு (பின்னர் செலுத்த)' },
  }

export const EXPENSE_STATUS_LABELS: Readonly<Record<ExpenseStatus, BilingualLabel>> = {
  posted: { en: 'Recorded', ta: 'பதிவானது' },
  cancelled: { en: 'Cancelled', ta: 'ரத்து செய்யப்பட்டது' },
}

export const SHIFT_STATUS_LABELS: Readonly<Record<ShiftStatus, BilingualLabel>> = {
  open: { en: 'Open', ta: 'திறந்துள்ளது' },
  closed: { en: 'Closed', ta: 'மூடப்பட்டது' },
}

export const SHIFT_CASH_ENTRY_KIND_LABELS: Readonly<Record<ShiftCashEntryKind, BilingualLabel>> = {
  pay_in: { en: 'Cash in', ta: 'ரொக்கம் உள்ளே' },
  pay_out: { en: 'Cash out', ta: 'ரொக்கம் வெளியே' },
}

/** Row type labels of journals / books (same as the party ledger statements). */
export const JOURNAL_SOURCE_LABELS: Readonly<Record<JournalSourceType, BilingualLabel>> =
  LEDGER_SOURCE_LABELS

/** Page / statement titles (Tamil names as used by Tamil Nadu accountants). */
export const ACCOUNTING_TITLES = {
  chart_of_accounts: { en: 'Chart of accounts', ta: 'கணக்குகளின் பட்டியல்' },
  journal: { en: 'Journal entries', ta: 'பேரேட்டுப் பதிவுகள்' },
  expenses: { en: 'Expenses', ta: 'செலவுகள்' },
  shifts: { en: 'Shifts & cash', ta: 'ஷிஃப்ட் & ரொக்கம்' },
  day_book: { en: 'Day book', ta: 'நாள் குறிப்பேடு' },
  cash_book: { en: 'Cash book', ta: 'ரொக்கப் புத்தகம்' },
  ledger: { en: 'Ledger', ta: 'பேரேடு' },
  trial_balance: { en: 'Trial balance', ta: 'சோதனை இருப்பு' },
  profit_loss: { en: 'Profit & loss', ta: 'இலாப நஷ்ட கணக்கு' },
  balance_sheet: { en: 'Balance sheet', ta: 'இருப்புநிலைக் குறிப்பு' },
  x_report: { en: 'X report (shift so far)', ta: 'X அறிக்கை (இதுவரை)' },
  z_report: { en: 'Z report (shift closing)', ta: 'Z அறிக்கை (ஷிஃப்ட் முடிவு)' },
} as const satisfies Record<string, BilingualLabel>

/** Line labels of the statements. */
export const STATEMENT_LINE_LABELS = {
  income: { en: 'Income', ta: 'வருமானம்' },
  net_sales: { en: 'Net sales', ta: 'நிகர விற்பனை' },
  cogs: { en: 'Cost of goods sold', ta: 'விற்ற சரக்கின் அடக்க விலை' },
  gross_profit: { en: 'Gross profit', ta: 'மொத்த இலாபம்' },
  expenses: { en: 'Expenses', ta: 'செலவுகள்' },
  net_profit: { en: 'Net profit', ta: 'நிகர இலாபம்' },
  net_loss: { en: 'Net loss', ta: 'நிகர நஷ்டம்' },
  assets: { en: 'Assets', ta: 'சொத்துகள்' },
  liabilities: { en: 'Liabilities', ta: 'பொறுப்புகள்' },
  equity: { en: 'Capital', ta: 'மூலதனம்' },
  current_period_profit: { en: 'Profit for the year so far', ta: 'இந்த ஆண்டின் இலாபம் (இதுவரை)' },
  retained_earnings: { en: 'Profit of earlier years', ta: 'முந்தைய ஆண்டுகளின் இலாபம்' },
  total_liabilities_equity: {
    en: 'Total liabilities & capital',
    ta: 'மொத்தப் பொறுப்புகள் & மூலதனம்',
  },
  debit: { en: 'Debit', ta: 'பற்று' },
  credit: { en: 'Credit', ta: 'வரவு' },
  opening_balance: { en: 'Opening balance', ta: 'தொடக்க இருப்பு' },
  closing_balance: { en: 'Closing balance', ta: 'இறுதி இருப்பு' },
} as const satisfies Record<string, BilingualLabel>

// =============================================================================================
// Cash short / excess system account (cross-module: shared accounting.ts + migration 07xx)
// =============================================================================================

/**
 * Posting subtype for shift-close differences. The accounting module adds it to
 * SYSTEM_ACCOUNT_SUBTYPES / DEFAULT_CHART (shared accounting.ts, seeded by onboarding) and
 * backfills existing tenants with a 07xx migration; until then core systemAccountId() cannot
 * resolve it. Shortage: Dr cash_short_excess / Cr cash; excess: Dr cash / Cr cash_short_excess.
 */
export const CASH_SHORT_EXCESS_SUBTYPE = 'cash_short_excess' as const

/** The chart row to add (expense type: a shortage is a loss, an excess reduces it). */
export const CASH_SHORT_EXCESS_ACCOUNT = {
  code: '5250',
  type: 'expense',
  subtype: CASH_SHORT_EXCESS_SUBTYPE,
  name: 'Cash short / excess',
  name_ta: 'ரொக்கக் குறைவு / மிகுதி',
  is_system: true,
} as const

// =============================================================================================
// Accounts (chart of accounts)
// =============================================================================================

/**
 * System posting subtype of an account (null for plain accounts). Includes every subtype of
 * shared SYSTEM_ACCOUNT_SUBTYPES (and cash_short_excess, which the accounting module adds there).
 */
export const AccountSubtypeSchema = z.union([
  z.enum(SYSTEM_ACCOUNT_SUBTYPES),
  z.literal(CASH_SHORT_EXCESS_SUBTYPE),
])
export type AccountSubtype = z.infer<typeof AccountSubtypeSchema>

/** First code digit by account type (DEFAULT_CHART follows it; custom codes must too). */
export const ACCOUNT_CODE_PREFIX: Readonly<Record<AccountType, string>> = {
  asset: '1',
  liability: '2',
  equity: '3',
  income: '4',
  expense: '5',
}

export const ACCOUNT_CODE_RE = /^[0-9]{3,6}$/

export function accountCodeMatchesType(code: string, type: AccountType): boolean {
  return ACCOUNT_CODE_RE.test(code) && code.startsWith(ACCOUNT_CODE_PREFIX[type])
}

/**
 * Accounts that hold money: 'cash' (cash in hand, petty cash, a second drawer) or 'bank' (bank
 * accounts). Derived: the account's own subtype or the nearest ancestor's (cash / bank); custom
 * asset accounts with bank details count as bank. These are offered as "paid from" for expenses,
 * as cash-book accounts and as bank-deposit counters of shift pay-outs.
 */
export const MoneyAccountKindSchema = z.enum(['cash', 'bank'])
export type MoneyAccountKind = z.infer<typeof MoneyAccountKindSchema>

/** Money kind from an account's subtype and its ancestors' subtypes (nearest first). */
export function moneyKindOf(input: {
  type: AccountType
  subtype: string | null
  ancestor_subtypes?: readonly (string | null)[]
  has_bank_details?: boolean
}): MoneyAccountKind | null {
  if (input.type !== 'asset') return null
  for (const st of [input.subtype, ...(input.ancestor_subtypes ?? [])]) {
    if (st === 'cash') return 'cash'
    if (st === 'bank') return 'bank'
  }
  return input.has_bank_details ? 'bank' : null
}

/** IFSC: 4 letters, '0', 6 alphanumerics (e.g. 'SBIN0001234'). */
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

/** Bank details kept in accounts.details (last 4 digits only — never the full account number). */
export const BankDetailsSchema = z.object({
  bank_name: z.string().nullable().default(null),
  account_last4: z.string().nullable().default(null),
  ifsc: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  account_holder: z.string().nullable().default(null),
})
export type BankDetails = z.output<typeof BankDetailsSchema>

/** Bank details input (create / PATCH: missing = unchanged, null / '' = cleared). */
export const BankDetailsInputSchema = z.object({
  bank_name: zNullableText(100),
  account_last4: z
    .union([z.null(), z.string().trim()])
    .optional()
    .refine((v) => v == null || v === '' || /^[0-9]{4}$/.test(v), { message: 'bank_last4' })
    .transform((v) => (v === '' ? null : v)),
  ifsc: z
    .union([z.null(), z.string().trim().toUpperCase()])
    .optional()
    .refine((v) => v == null || v === '' || IFSC_RE.test(v), { message: 'ifsc' })
    .transform((v) => (v === '' ? null : v)),
  branch: zNullableText(100),
  account_holder: zNullableText(120),
})
export type BankDetailsInput = z.input<typeof BankDetailsInputSchema>

export const AccountSchema = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  type: AccountTypeSchema,
  subtype: AccountSubtypeSchema.nullable(),
  parent_id: zId.nullable(),
  is_system: z.boolean(),
  is_active: z.boolean(),
  /** Store-specific cash / bank account (null = shared by every store). */
  store_id: zId.nullable(),
  money_kind: MoneyAccountKindSchema.nullable(),
  details: BankDetailsSchema,
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Account = z.output<typeof AccountSchema>

/** Account with its balance as of a date (GET /accounts). */
export const AccountBalanceSchema = AccountSchema.extend({
  /** Σ debits / credits of the account's lines up to as_of (null without accounting.read). */
  debit_paise: zPaise.nullable(),
  credit_paise: zPaise.nullable(),
  /** Natural balance: + = the account's normal side (normalBalanceOf(type)). */
  balance_paise: zSignedPaise.nullable(),
  /** Own balance + every descendant's (tree totals). */
  rollup_balance_paise: zSignedPaise.nullable(),
  /** Depth in the tree (0 = top level). */
  depth: z.int().min(0),
  /** The account has journal lines (custom accounts without lines can be deleted). */
  has_entries: z.boolean(),
})
export type AccountBalance = z.output<typeof AccountBalanceSchema>

export const ChartOfAccountsQuerySchema = z.object({
  as_of: zDateStr.optional().describe('Balances up to this business date (default: today)'),
  store_id: zId.optional().describe('Only journal lines of this store (journal_lines.store_id)'),
  type: zQueryList(AccountTypeSchema).optional(),
  money: MoneyAccountKindSchema.optional().describe('Only cash / bank accounts (pickers)'),
  q: zSearchQuery.optional().describe('Code, name or Tamil name'),
  include_inactive: zBooleanQuery.default(false),
  balances: zBooleanQuery
    .default(true)
    .describe('false skips the balance query (pickers); balances also need accounting.read'),
})
export type ChartOfAccountsQuery = z.input<typeof ChartOfAccountsQuerySchema>

/** GET /accounts — the whole chart (not paginated), ordered by code. */
export const ChartOfAccountsSchema = z.object({
  as_of: zDateStr,
  store_id: zId.nullable(),
  accounts: z.array(AccountBalanceSchema),
  /** Natural balance per type (null when balances were not computed). */
  totals: z.array(z.object({ type: AccountTypeSchema, balance_paise: zSignedPaise.nullable() })),
})
export type ChartOfAccounts = z.output<typeof ChartOfAccountsSchema>

/** Fields a PATCH may change: system accounts only name / name_ta / details. */
export const SYSTEM_ACCOUNT_EDITABLE_FIELDS = ['name', 'name_ta', 'details'] as const
export const CUSTOM_ACCOUNT_EDITABLE_FIELDS = [
  'code',
  'name',
  'name_ta',
  'parent_id',
  'store_id',
  'details',
  'is_active',
] as const
export type AccountEditableField = (typeof CUSTOM_ACCOUNT_EDITABLE_FIELDS)[number]

export const AccountDetailSchema = AccountBalanceSchema.extend({
  parent: z.object({ id: zId, code: z.string(), name: z.string() }).nullable(),
  store_name: z.string().nullable(),
  children_count: z.int().min(0),
  line_count: z.int().min(0),
  last_entry_date: zDateStr.nullable(),
  editable_fields: z.array(z.enum(CUSTOM_ACCOUNT_EDITABLE_FIELDS)),
  /** DELETE removes it (custom, no journal lines). */
  can_delete: z.boolean(),
  /** is_active false allowed (custom; balance-sheet accounts only with a zero balance). */
  can_deactivate: z.boolean(),
})
export type AccountDetail = z.output<typeof AccountDetailSchema>

const zAccountCode = z.string().trim().regex(ACCOUNT_CODE_RE, 'account_code_format')
const zAccountName = z.string().trim().min(1).max(120)

/** POST /accounts — custom account (expense head, extra bank / cash account, …). */
export const AccountCreateSchema = z
  .object({
    code: zAccountCode
      .optional()
      .describe('Default: suggestAccountCode() — next free code of the type / parent'),
    name: zAccountName,
    name_ta: zNullableText(120),
    type: AccountTypeSchema,
    parent_id: zId.nullable().optional().describe('Active account of the same type'),
    store_id: zId.nullable().optional(),
    details: BankDetailsInputSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.code !== undefined && !accountCodeMatchesType(v.code, v.type)) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: 'account_code_type' })
    }
  })
export type AccountCreate = z.input<typeof AccountCreateSchema>

/**
 * PATCH /accounts/:id. System accounts: name / name_ta / details only (else 422
 * system_account_locked). A new code must keep the type prefix (server-checked against the type).
 * Deactivating a balance-sheet account needs a zero balance (409 account_has_balance); income /
 * expense heads can always be deactivated (hidden from pickers, history kept).
 */
export const AccountUpdateSchema = z
  .object({
    code: zAccountCode.optional(),
    name: zAccountName.optional(),
    name_ta: zNullableText(120),
    parent_id: zId.nullable().optional(),
    store_id: zId.nullable().optional(),
    details: BankDetailsInputSchema.optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at'), {
    message: 'empty_patch',
  })
export type AccountUpdate = z.input<typeof AccountUpdateSchema>

/**
 * Suggested code for a new account: under a 4-digit parent the next free parent+1 … parent+9
 * (1200 → 1201), else the next free multiple of 10 after the highest code of the type's range
 * (expense: 5400 → 5410), else any free code of the range. null when the range is full.
 */
export function suggestAccountCode(
  type: AccountType,
  existingCodes: Iterable<string>,
  parentCode?: string | null,
): string | null {
  const used = new Set(existingCodes)
  const prefix = ACCOUNT_CODE_PREFIX[type]
  const free = (n: number) => !used.has(String(n))
  if (parentCode && /^[0-9]{4}$/.test(parentCode) && parentCode.startsWith(prefix)) {
    const base = Number(parentCode)
    for (let n = base + 1; n < base + 10; n++) if (free(n)) return String(n)
  }
  const min = Number(prefix) * 1000
  const max = min + 999
  const inRange = [...used]
    .filter((c) => /^[0-9]{4}$/.test(c) && c.startsWith(prefix))
    .map(Number)
  const highest = inRange.length ? Math.max(...inRange) : min
  for (let n = Math.floor(highest / 10) * 10 + 10; n <= max; n += 10) if (free(n)) return String(n)
  for (let n = min + 1; n <= max; n++) if (free(n)) return String(n)
  return null
}

/** Tree node built by {@link buildAccountTree}. */
export type AccountTreeNode<T> = T & { depth: number; rollup_balance_paise: number; children: AccountTreeNode<T>[] }

/**
 * Builds the chart tree (parents before children, siblings by code) with roll-up balances
 * (own + descendants). Rows whose parent is missing become roots.
 */
export function buildAccountTree<
  T extends { id: string; parent_id: string | null; code: string; balance_paise: number | null },
>(rows: readonly T[]): AccountTreeNode<T>[] {
  const ids = new Set(rows.map((r) => r.id))
  const byParent = new Map<string | null, T[]>()
  for (const r of rows) {
    const key = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null
    byParent.set(key, [...(byParent.get(key) ?? []), r])
  }
  const seen = new Set<string>()
  const build = (parent: string | null, depth: number): AccountTreeNode<T>[] =>
    (byParent.get(parent) ?? [])
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code))
      .filter((r) => !seen.has(r.id))
      .map((r) => {
        seen.add(r.id)
        const children = build(r.id, depth + 1)
        const rollup = (r.balance_paise ?? 0) + sumSafe(children.map((c) => c.rollup_balance_paise))
        return { ...r, depth, rollup_balance_paise: rollup, children }
      })
  return build(null, 0)
}

/** Dr / Cr presentation of a natural balance: { amount_paise ≥ 0, side }. */
export function balanceSide(
  type: AccountType,
  naturalBalancePaise: number,
): { amount_paise: number; side: 'Dr' | 'Cr' } {
  const normal = normalBalanceOf(type) === 'debit' ? 'Dr' : 'Cr'
  const other = normal === 'Dr' ? 'Cr' : 'Dr'
  return {
    amount_paise: Math.abs(naturalBalancePaise),
    side: naturalBalancePaise >= 0 ? normal : other,
  }
}

// =============================================================================================
// Journal entries
// =============================================================================================

/**
 * Web routes of journal source documents (identity's DOCUMENT_ROUTES plus the accounting / payments
 * pages; detail pages that are drawers take `?id=`).
 */
export const JOURNAL_SOURCE_ROUTES: Readonly<Record<string, string>> = {
  ...DOCUMENT_ROUTES,
  expense: '/accounting/expenses?id=:id',
  manual: '/accounting/journal?id=:id',
  payment: '/payments?id=:id',
}

/** Web path of a journal entry's source (shift, invoice, expense, manual JV …) or null. */
export function journalSourcePath(
  sourceType: string | null | undefined,
  sourceId: string | null | undefined,
): string | null {
  if (!sourceType || !sourceId) return null
  const template = JOURNAL_SOURCE_ROUTES[sourceType]
  return template ? template.replace(':id', encodeURIComponent(sourceId)) : null
}

export const JournalSourceRefSchema = z.object({
  type: JournalSourceTypeSchema,
  id: zId.nullable(),
  /** Number of the source document (invoice, credit note, receipt, bill, EXP…, JV…). */
  number: z.string().nullable(),
  /** journalSourcePath(type, id). */
  path: z.string().nullable(),
})
export type JournalSourceRef = z.output<typeof JournalSourceRefSchema>

export const JournalLineSchema = z.object({
  id: zId,
  account_id: zId,
  account_code: z.string(),
  account_name: z.string(),
  account_name_ta: z.string().nullable(),
  account_type: AccountTypeSchema,
  account_subtype: AccountSubtypeSchema.nullable(),
  debit_paise: zPaise,
  credit_paise: zPaise,
  party_type: PartyTypeSchema.nullable(),
  party_id: zId.nullable(),
  party_name: z.string().nullable(),
  store_id: zId.nullable(),
  memo: z.string().nullable(),
})
export type JournalLine = z.output<typeof JournalLineSchema>

export const JournalEntrySchema = z.object({
  id: zId,
  entry_date: zDateStr,
  /** JV number (manual journals only). */
  number: z.string().nullable(),
  source_type: JournalSourceTypeSchema,
  source_id: zId.nullable(),
  source_number: z.string().nullable(),
  source_path: z.string().nullable(),
  narration: z.string().nullable(),
  store_id: zId.nullable(),
  store_name: z.string().nullable(),
  /** Σ debits (= Σ credits). */
  total_paise: zPaise,
  line_count: z.int().min(0),
  /** Names of the debited / credited accounts (at most 3 each) for list display. */
  debit_accounts: z.array(z.string()),
  credit_accounts: z.array(z.string()),
  /** This entry reverses that one. */
  reverses_entry_id: zId.nullable(),
  /** The entry that reversed this one. */
  reversed_by_entry_id: zId.nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
})
export type JournalEntry = z.output<typeof JournalEntrySchema>

const EntryRefSchema = z.object({ id: zId, number: z.string().nullable(), entry_date: zDateStr })

export const JournalEntryDetailSchema = JournalEntrySchema.extend({
  lines: z.array(JournalLineSchema),
  source: JournalSourceRefSchema,
  reverses: EntryRefSchema.nullable(),
  reversed_by: EntryRefSchema.nullable(),
  /** Manual, not reversed, not itself a reversal, and the member has accounting.write. */
  can_reverse: z.boolean(),
})
export type JournalEntryDetail = z.output<typeof JournalEntryDetailSchema>

export const JournalListQuerySchema = PageQuerySchema.extend({
  ...DATE_RANGE_FIELDS,
  source_type: zQueryList(JournalSourceTypeSchema).optional(),
  source_id: zId.optional(),
  account_id: zId.optional().describe('Entries with a line on this account'),
  party_type: PartyTypeSchema.optional(),
  party_id: zId.optional(),
  store_id: zId.optional(),
  reversals: zBooleanQuery
    .optional()
    .describe('true: only reversal entries; false: hide reversals and reversed entries'),
  q: zSearchQuery.optional().describe('JV number, source document number or narration'),
  sort: sortQuery(['entry_date', 'created_at', 'number', 'total_paise'] as const).prefault(
    '-entry_date',
  ),
  format: zListFormat,
})
  .refine(dateOrderOk, DATE_ORDER_ISSUE)
  .refine((v) => (v.party_type === undefined) === (v.party_id === undefined), {
    message: 'party_pair_required',
    path: ['party_id'],
  })
export type JournalListQuery = z.input<typeof JournalListQuerySchema>

export const JournalListResponseSchema = listOf(JournalEntrySchema).extend({
  summary: z.object({ count: z.int().min(0), total_paise: zPaise }),
})
export type JournalListResponse = z.output<typeof JournalListResponseSchema>

/** One line of a manual journal: exactly one side > 0; party only on receivable / payable. */
export const ManualJournalLineSchema = z
  .object({
    account_id: zId,
    debit_paise: zPaise.default(0),
    credit_paise: zPaise.default(0),
    party_type: PartyTypeSchema.optional(),
    party_id: zId.optional(),
    memo: zNullableText(200),
    /** Store dimension of the line (default: the entry's store). */
    store_id: zId.nullable().optional(),
  })
  .refine((l) => (l.debit_paise > 0) !== (l.credit_paise > 0), {
    message: 'journal_line_side',
    path: ['debit_paise'],
  })
  .refine((l) => (l.party_type === undefined) === (l.party_id === undefined), {
    message: 'journal_party_pair',
    path: ['party_id'],
  })
export type ManualJournalLine = z.input<typeof ManualJournalLineSchema>

/** Totals of journal lines for the live balance indicator and validation. */
export function journalTotals(lines: ReadonlyArray<{ debit_paise?: number; credit_paise?: number }>): {
  debit_paise: number
  credit_paise: number
  /** debit − credit (0 when balanced). */
  difference_paise: number
  balanced: boolean
} {
  const debit = sumSafe(lines.map((l) => l.debit_paise ?? 0))
  const credit = sumSafe(lines.map((l) => l.credit_paise ?? 0))
  return {
    debit_paise: debit,
    credit_paise: credit,
    difference_paise: debit - credit,
    balanced: debit === credit && debit > 0,
  }
}

export const MANUAL_JOURNAL_MAX_LINES = 100

/**
 * POST /journal-entries — manual journal voucher (JV number from the 'journal' series, audited
 * 'journal.create'). Server rules: accounts active; receivable / payable lines need a party of the
 * matching type (422 party_required / party_not_allowed); store access.
 */
export const ManualJournalCreateSchema = z
  .object({
    entry_date: zDateStr,
    store_id: zId.nullable().optional().describe('Numbering store (default: the first store)'),
    narration: z.string().trim().min(3, 'narration_required').max(500),
    lines: z
      .array(ManualJournalLineSchema)
      .min(2, 'journal_min_lines')
      .max(MANUAL_JOURNAL_MAX_LINES),
    client_ref: zIdempotencyKey.optional(),
  })
  .superRefine((v, ctx) => {
    if (!journalTotals(v.lines).balanced) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'journal_unbalanced' })
    }
  })
export type ManualJournalCreate = z.input<typeof ManualJournalCreateSchema>

/**
 * POST /journal-entries/:id/reverse — manual entries only (documents are reversed by cancelling
 * them: 409 not_manual), once (409 already_reversed). Returns the reversal entry.
 */
export const JournalReverseSchema = z.object({
  entry_date: zDateStr.optional().describe('Date of the reversal entry (default: today)'),
  reason: zReason,
})
export type JournalReverse = z.input<typeof JournalReverseSchema>

// =============================================================================================
// Expenses
// =============================================================================================

/** Default cash / bank account kind by payment method (null = on credit → payable). */
export function defaultPaidFromKind(method: ExpensePaymentMethod): MoneyAccountKind | null {
  if (method === 'credit') return null
  return method === 'cash' ? 'cash' : 'bank'
}

export interface ExpenseAmounts {
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  tax_paise: number
  total_paise: number
}

/**
 * GST of an expense from its taxable value (exclusive) or its bill total (inclusive, as most
 * small-shop bills are entered): gst = round(taxable × rate) / taxable = round(total ÷ (1 + rate));
 * intra-state gst splits CGST = gst − ⌊gst/2⌋, SGST = ⌊gst/2⌋ (same as pricing.ts).
 */
export function computeExpenseAmounts(input: {
  taxable_paise?: number | null
  total_paise?: number | null
  gst_rate_bp: number
  is_interstate: boolean
}): ExpenseAmounts {
  const rate = input.gst_rate_bp
  let taxable: number
  let gst: number
  if (input.taxable_paise != null) {
    taxable = input.taxable_paise
    gst = roundDiv(taxable * rate, 10_000)
  } else if (input.total_paise != null) {
    taxable = roundDiv(input.total_paise * 10_000, 10_000 + rate)
    gst = input.total_paise - taxable
  } else {
    throw new RangeError('taxable_paise or total_paise is required')
  }
  const split = input.is_interstate ? { cgst_paise: 0, sgst_paise: 0 } : splitGst(gst)
  return {
    taxable_paise: taxable,
    cgst_paise: split.cgst_paise,
    sgst_paise: split.sgst_paise,
    igst_paise: input.is_interstate ? gst : 0,
    tax_paise: gst,
    total_paise: taxable + gst,
  }
}

/** Abstract journal line of a posting plan (account by id or system subtype). */
export interface PlannedJournalLine {
  account: { id: string } | { subtype: SystemAccountSubtype | typeof CASH_SHORT_EXCESS_SUBTYPE }
  debit_paise: number
  credit_paise: number
  party?: { type: 'customer' | 'supplier'; id: string } | null
}

/**
 * Journal of an expense (ARCHITECTURE.md §10): Dr expense (taxable with ITC, else the whole total),
 * Dr input CGST / SGST / IGST (ITC only), Cr paid-from account — or Cr payable(supplier) on credit.
 */
export function expenseJournalLines(e: {
  expense_account_id: string
  amounts: ExpenseAmounts
  itc_eligible: boolean
  payment_method: ExpensePaymentMethod
  paid_from_account_id: string | null
  supplier_id: string | null
}): PlannedJournalLine[] {
  const a = e.amounts
  const lines: PlannedJournalLine[] = [
    {
      account: { id: e.expense_account_id },
      debit_paise: e.itc_eligible ? a.taxable_paise : a.total_paise,
      credit_paise: 0,
    },
  ]
  if (e.itc_eligible) {
    const taxes: Array<[SystemAccountSubtype, number]> = [
      ['input_cgst', a.cgst_paise],
      ['input_sgst', a.sgst_paise],
      ['input_igst', a.igst_paise],
    ]
    for (const [subtype, amount] of taxes)
      if (amount > 0) lines.push({ account: { subtype }, debit_paise: amount, credit_paise: 0 })
  }
  if (e.payment_method === 'credit') {
    if (!e.supplier_id) throw new RangeError('supplier_id is required for credit expenses')
    lines.push({
      account: { subtype: 'payable' },
      debit_paise: 0,
      credit_paise: a.total_paise,
      party: { type: 'supplier', id: e.supplier_id },
    })
  } else {
    if (!e.paid_from_account_id) throw new RangeError('paid_from_account_id is required')
    lines.push({ account: { id: e.paid_from_account_id }, debit_paise: 0, credit_paise: a.total_paise })
  }
  return lines.filter((l) => l.debit_paise > 0 || l.credit_paise > 0)
}

export const ExpenseSchema = z.object({
  id: zId,
  store_id: zId,
  store_name: z.string(),
  /** EXP… number ('expense' series). */
  number: z.string().nullable(),
  fy: z.string().nullable(),
  expense_date: zDateStr,
  expense_account_id: zId,
  expense_account_code: z.string(),
  expense_account_name: z.string(),
  expense_account_name_ta: z.string().nullable(),
  supplier_id: zId.nullable(),
  supplier_name: z.string().nullable(),
  description: z.string().nullable(),
  taxable_paise: zPaise,
  gst_rate_bp: z.int().min(0),
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  tax_paise: zPaise,
  itc_eligible: z.boolean(),
  /** igst_paise > 0. */
  is_interstate: z.boolean(),
  total_paise: zPaise,
  payment_method: ExpensePaymentMethodSchema,
  /** Cash / bank account paid from (null on credit). */
  paid_from_account_id: zId.nullable(),
  paid_from_account_name: z.string().nullable(),
  reference: z.string().nullable(),
  attachment_file_id: zId.nullable(),
  status: ExpenseStatusSchema,
  shift_id: zId.nullable(),
  cancelled_at: zTimestamp.nullable(),
  cancelled_by: zId.nullable(),
  cancelled_by_name: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Expense = z.output<typeof ExpenseSchema>

export const ExpenseDetailSchema = ExpenseSchema.extend({
  journal_entry_id: zId.nullable(),
  reversal_entry_id: zId.nullable(),
  /** Credit expenses: Σ completed supplier payments allocated (target 'expense'); else = total. */
  paid_paise: zPaise,
  due_paise: zPaise,
  payments: z.array(
    z.object({
      payment_id: zId,
      number: z.string().nullable(),
      payment_date: zDateStr,
      method: PaymentMethodSchema,
      amount_paise: zAmountPaise,
    }),
  ),
  can_cancel: z.boolean(),
})
export type ExpenseDetail = z.output<typeof ExpenseDetailSchema>

/**
 * POST /expenses (expenses.write). Give the bill amount either as `total_paise` (inclusive of GST,
 * the quick-add default) or as `taxable_paise` (exclusive); taxes come from
 * computeExpenseAmounts(). `is_interstate` defaults to supplier state ≠ store state (false without
 * a supplier). `paid_from_account_id` defaults by method (defaultPaidFromKind: the store's cash
 * account, else the system cash / bank account). Cash expenses paid from a counter attach to its
 * open shift (`register_id`, default the device's register). Number 'expense' series; journal per
 * expenseJournalLines(); audited.
 */
export const ExpenseCreateSchema = z
  .object({
    store_id: zId,
    expense_date: zDateStr,
    expense_account_id: zId.describe('An active expense-type account (category)'),
    description: zNullableText(500),
    taxable_paise: zAmountPaise.optional(),
    total_paise: zAmountPaise.optional(),
    gst_rate_bp: zGstRateBp.default(0),
    itc_eligible: z.boolean().default(false),
    is_interstate: z.boolean().optional(),
    payment_method: ExpensePaymentMethodSchema,
    paid_from_account_id: zId.nullable().optional(),
    supplier_id: zId.nullable().optional(),
    reference: zNullableText(100).describe('Bill / receipt number, UTR, cheque number'),
    attachment_file_id: zId.nullable().optional().describe('Bill photo (POST /files?purpose=attachment)'),
    register_id: zId.optional().describe('Counter whose drawer paid a cash expense'),
    client_ref: zIdempotencyKey.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.taxable_paise === undefined && v.total_paise === undefined)
      ctx.addIssue({ code: 'custom', path: ['total_paise'], message: 'expense_amount_required' })
    if (v.taxable_paise !== undefined && v.total_paise !== undefined)
      ctx.addIssue({ code: 'custom', path: ['taxable_paise'], message: 'expense_amount_both' })
    if (v.itc_eligible && v.gst_rate_bp === 0)
      ctx.addIssue({ code: 'custom', path: ['itc_eligible'], message: 'itc_requires_gst' })
    if (v.payment_method === 'credit') {
      if (!v.supplier_id)
        ctx.addIssue({
          code: 'custom',
          path: ['supplier_id'],
          message: 'supplier_required_for_credit',
        })
      if (v.paid_from_account_id)
        ctx.addIssue({
          code: 'custom',
          path: ['paid_from_account_id'],
          message: 'paid_from_not_allowed_for_credit',
        })
    }
  })
export type ExpenseCreate = z.input<typeof ExpenseCreateSchema>
export type ExpenseCreateParsed = z.output<typeof ExpenseCreateSchema>

export const ExpenseListQuerySchema = PageQuerySchema.extend({
  ...DATE_RANGE_FIELDS,
  store_id: zId.optional(),
  expense_account_id: zQueryList(zId).optional(),
  payment_method: zQueryList(ExpensePaymentMethodSchema).optional(),
  status: ExpenseStatusSchema.optional().describe('Default: both'),
  supplier_id: zId.optional(),
  shift_id: zId.optional(),
  itc_eligible: zBooleanQuery.optional(),
  q: zSearchQuery.optional().describe('Number, description or reference'),
  sort: sortQuery(['expense_date', 'created_at', 'total_paise', 'number'] as const).prefault(
    '-expense_date',
  ),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type ExpenseListQuery = z.input<typeof ExpenseListQuerySchema>

/** Totals of the posted expenses of the whole filtered set (not only the page). */
export const ExpenseListSummarySchema = z.object({
  count: z.int().min(0),
  taxable_paise: zPaise,
  tax_paise: zPaise,
  /** Input tax claimed (ITC-eligible expenses). */
  itc_paise: zPaise,
  total_paise: zPaise,
  by_category: z.array(
    z.object({
      expense_account_id: zId,
      code: z.string(),
      name: z.string(),
      name_ta: z.string().nullable(),
      count: z.int().min(0),
      total_paise: zPaise,
    }),
  ),
  by_method: z.array(
    z.object({ payment_method: ExpensePaymentMethodSchema, count: z.int().min(0), total_paise: zPaise }),
  ),
})
export type ExpenseListSummary = z.output<typeof ExpenseListSummarySchema>

export const ExpenseListResponseSchema = listOf(ExpenseSchema).extend({
  summary: ExpenseListSummarySchema,
})
export type ExpenseListResponse = z.output<typeof ExpenseListResponseSchema>

/** POST /expenses/:id/cancel — reversal journal on `date` (default today), audited. */
export const ExpenseCancelSchema = z.object({
  reason: zReason,
  date: zDateStr.optional(),
})
export type ExpenseCancel = z.input<typeof ExpenseCancelSchema>

/**
 * Quick-add category tiles (daily use). `code` = a preset expense head of DEFAULT_CHART; tiles
 * without a code match an existing custom expense account by `suggestion` name (else the UI offers
 * to create it with POST /accounts).
 */
export const EXPENSE_QUICK_TILES: ReadonlyArray<
  { key: string; code: string | null; suggestion: string | null; icon: string } & BilingualLabel
> = [
  { key: 'rent', code: '5300', suggestion: null, icon: 'home', en: 'Rent', ta: 'வாடகை' },
  { key: 'electricity', code: '5310', suggestion: null, icon: 'zap', en: 'Electricity', ta: 'மின்சாரம்' },
  { key: 'salaries', code: '5320', suggestion: null, icon: 'users', en: 'Salaries', ta: 'சம்பளம்' },
  { key: 'transport', code: '5330', suggestion: null, icon: 'truck', en: 'Transport', ta: 'போக்குவரத்து' },
  {
    key: 'tea',
    code: null,
    suggestion: 'Tea & refreshments',
    icon: 'coffee',
    en: 'Tea & snacks',
    ta: 'டீ & சிற்றுண்டி',
  },
  { key: 'repairs', code: '5340', suggestion: null, icon: 'wrench', en: 'Repairs', ta: 'பழுது பார்த்தல்' },
  {
    key: 'phone',
    code: '5350',
    suggestion: null,
    icon: 'phone',
    en: 'Phone & internet',
    ta: 'தொலைபேசி & இணையம்',
  },
  { key: 'packing', code: '5370', suggestion: null, icon: 'package', en: 'Packing', ta: 'பேக்கிங்' },
  { key: 'misc', code: '5390', suggestion: null, icon: 'ellipsis', en: 'Others', ta: 'இதர செலவுகள்' },
]

/** The active expense account a quick tile stands for (by preset code, else by name), or null. */
export function resolveExpenseTile<
  A extends { id: string; code: string; name: string; type: AccountType; is_active: boolean },
>(tile: { code: string | null; suggestion: string | null }, accounts: readonly A[]): A | null {
  const active = accounts.filter((a) => a.type === 'expense' && a.is_active)
  if (tile.code) return active.find((a) => a.code === tile.code) ?? null
  const name = tile.suggestion?.trim().toLowerCase()
  return name ? (active.find((a) => a.name.trim().toLowerCase() === name) ?? null) : null
}

// =============================================================================================
// Register shifts (feature shifts)
// =============================================================================================

/** Notes counted at open / close (rupees, descending); coins are counted as an amount. */
export const DENOMINATION_NOTES = [2000, 500, 200, 100, 50, 20, 10] as const
export type DenominationNote = (typeof DENOMINATION_NOTES)[number]

const zCount = z.int().min(0).max(1_000_000)

/** register_shifts.denominations: note counts + coins amount (paise). */
export const DenominationsSchema = z.object({
  '2000': zCount.default(0),
  '500': zCount.default(0),
  '200': zCount.default(0),
  '100': zCount.default(0),
  '50': zCount.default(0),
  '20': zCount.default(0),
  '10': zCount.default(0),
  coins: zPaise.default(0).describe('Coins (₹1 / ₹2 / ₹5 / ₹10 coins, ₹5 notes) as an amount in paise'),
})
export type Denominations = z.output<typeof DenominationsSchema>
export type DenominationsInput = z.input<typeof DenominationsSchema>

/** Σ notes × face value + coins, in paise. */
export function denominationsTotalPaise(d: DenominationsInput): number {
  let total = d.coins ?? 0
  for (const note of DENOMINATION_NOTES) total += (d[String(note) as `${DenominationNote}`] ?? 0) * note * 100
  return total
}

/** Cash movements of a shift's drawer (all paise ≥ 0). */
export interface ShiftCashMovements {
  opening_cash_paise: number
  /** Payments in with method cash on the shift (POS tenders net of change, dues collected). */
  cash_receipts_paise: number
  /** Payments out with method cash on the shift (refunds, supplier payments). */
  cash_payments_paise: number
  pay_ins_paise: number
  pay_outs_paise: number
  /** Posted cash expenses attached to the shift. */
  cash_expenses_paise: number
}

/**
 * Expected drawer cash = opening + cash receipts − cash payments + pay-ins − pay-outs − cash
 * expenses. Only completed payments and posted expenses count (cancelled ones are excluded by the
 * caller's query).
 */
export function expectedShiftCash(m: ShiftCashMovements): number {
  return (
    m.opening_cash_paise +
    m.cash_receipts_paise -
    m.cash_payments_paise +
    m.pay_ins_paise -
    m.pay_outs_paise -
    m.cash_expenses_paise
  )
}

export const ShiftDifferenceStatusSchema = z.enum(['short', 'excess', 'balanced'])
export type ShiftDifferenceStatus = z.infer<typeof ShiftDifferenceStatusSchema>

export const SHIFT_DIFFERENCE_LABELS: Readonly<Record<ShiftDifferenceStatus, BilingualLabel>> = {
  short: { en: 'Short', ta: 'குறைவு' },
  excess: { en: 'Excess', ta: 'மிகுதி' },
  balanced: { en: 'Tallied', ta: 'சரியாக உள்ளது' },
}

/** difference = counted − expected (− = short, + = excess). */
export function shiftDifference(
  expectedPaise: number,
  countedPaise: number,
): { difference_paise: number; status: ShiftDifferenceStatus } {
  const d = countedPaise - expectedPaise
  return { difference_paise: d, status: d < 0 ? 'short' : d > 0 ? 'excess' : 'balanced' }
}

/**
 * Journal lines of a close difference (source 'shift', source_id = shift id): short → Dr
 * cash_short_excess / Cr cash account; excess → Dr cash account / Cr cash_short_excess; none
 * when balanced.
 */
export function shiftDifferenceJournalLines(
  differencePaise: number,
  cashAccountId: string,
): PlannedJournalLine[] {
  if (differencePaise === 0) return []
  const amount = Math.abs(differencePaise)
  const se = { account: { subtype: CASH_SHORT_EXCESS_SUBTYPE } } as const
  const cash = { account: { id: cashAccountId } }
  return differencePaise < 0
    ? [
        { ...se, debit_paise: amount, credit_paise: 0 },
        { ...cash, debit_paise: 0, credit_paise: amount },
      ]
    : [
        { ...cash, debit_paise: amount, credit_paise: 0 },
        { ...se, debit_paise: 0, credit_paise: amount },
      ]
}

/**
 * Counter account of a pay-in / pay-out given by system subtype (or pass account_id): drawings
 * (owner takes cash), capital (owner adds float), bank (bank deposit / withdrawal), other_income.
 * Default: pay_out → drawings, pay_in → capital.
 */
export const CashEntryCounterSchema = z.enum(['drawings', 'capital', 'bank', 'other_income'])
export type CashEntryCounter = z.infer<typeof CashEntryCounterSchema>

export function defaultCashEntryCounter(kind: ShiftCashEntryKind): CashEntryCounter {
  return kind === 'pay_out' ? 'drawings' : 'capital'
}

/** Journal of a pay-in / pay-out: pay_in Dr cash / Cr counter; pay_out Dr counter / Cr cash. */
export function cashEntryJournalLines(
  kind: ShiftCashEntryKind,
  amountPaise: number,
  cashAccountId: string,
  counter: { id: string } | { subtype: CashEntryCounter },
): PlannedJournalLine[] {
  const cash = { account: { id: cashAccountId } }
  const other = { account: counter }
  return kind === 'pay_in'
    ? [
        { ...cash, debit_paise: amountPaise, credit_paise: 0 },
        { ...other, debit_paise: 0, credit_paise: amountPaise },
      ]
    : [
        { ...other, debit_paise: amountPaise, credit_paise: 0 },
        { ...cash, debit_paise: 0, credit_paise: amountPaise },
      ]
}

/** One-tap presets of the cash entry dialog (`needs_account`: pick an expense account). */
export const CASH_ENTRY_PRESETS: ReadonlyArray<
  {
    key: string
    kind: ShiftCashEntryKind
    counter: CashEntryCounter | null
    needs_account: 'expense' | null
  } & BilingualLabel
> = [
  { key: 'bank_deposit', kind: 'pay_out', counter: 'bank', needs_account: null, en: 'Deposited in bank', ta: 'வங்கியில் செலுத்தியது' },
  { key: 'owner_drawings', kind: 'pay_out', counter: 'drawings', needs_account: null, en: 'Taken by owner', ta: 'உரிமையாளர் எடுத்தது' },
  { key: 'petty_expense', kind: 'pay_out', counter: null, needs_account: 'expense', en: 'Small expense', ta: 'சிறு செலவு' },
  { key: 'float_in', kind: 'pay_in', counter: 'capital', needs_account: null, en: 'Change / float added', ta: 'சில்லறை சேர்த்தது' },
  { key: 'bank_withdrawal', kind: 'pay_in', counter: 'bank', needs_account: null, en: 'Cash from bank', ta: 'வங்கியிலிருந்து ரொக்கம்' },
  { key: 'other_income', kind: 'pay_in', counter: 'other_income', needs_account: null, en: 'Other income', ta: 'இதர வருமானம்' },
]

export const ShiftCashEntrySchema = z.object({
  id: zId,
  shift_id: zId,
  kind: ShiftCashEntryKindSchema,
  amount_paise: zAmountPaise,
  account_id: zId.nullable(),
  account_code: z.string().nullable(),
  account_name: z.string().nullable(),
  reason: z.string(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
})
export type ShiftCashEntry = z.output<typeof ShiftCashEntrySchema>

export const ShiftCashSchema = z.object({
  opening_cash_paise: zPaise,
  cash_receipts_paise: zPaise,
  cash_payments_paise: zPaise,
  pay_ins_paise: zPaise,
  pay_outs_paise: zPaise,
  cash_expenses_paise: zPaise,
  /** expectedShiftCash() of the movements above (may be negative after a mistake). */
  expected_cash_paise: zSignedPaise,
  counted_cash_paise: zPaise.nullable(),
  difference_paise: zSignedPaise.nullable(),
})
export type ShiftCash = z.output<typeof ShiftCashSchema>

const zMilliSigned = z.int()

/**
 * X report (computed live while open) / Z report (captured at close into
 * register_shifts.summary). Bills = completed invoices of the shift; cancelled ones are listed
 * separately; payments are those recorded on the shift.
 */
export const ShiftSummarySchema = z.object({
  version: z.literal(1),
  report: z.enum(['X', 'Z']),
  generated_at: zTimestamp,
  from: zTimestamp,
  to: zTimestamp,
  bills: z.object({
    count: z.int().min(0),
    gross_paise: zPaise,
    discount_paise: zPaise,
    taxable_paise: zPaise,
    tax_paise: zPaise,
    round_off_paise: zSignedPaise,
    total_paise: zPaise,
    avg_bill_paise: zPaise,
    item_lines: z.int().min(0),
    /** Unpaid part of the shift's bills (credit / khata). */
    credit_paise: zPaise,
  }),
  /** Payments in on the shift by method (tenders + dues collected). */
  payments_in: z.array(
    z.object({ method: PaymentMethodSchema, count: z.int().min(0), amount_paise: zPaise }),
  ),
  /** Payments out on the shift by method (refunds, supplier payments). */
  payments_out: z.array(
    z.object({ method: PaymentMethodSchema, count: z.int().min(0), amount_paise: zPaise }),
  ),
  /** Receipts on the shift against bills of earlier days / customer dues. */
  dues_collected_paise: zPaise,
  returns: z.object({ count: z.int().min(0), total_paise: zPaise }),
  cancelled_bills: z.object({
    count: z.int().min(0),
    total_paise: zPaise,
    items: z.array(
      z.object({
        invoice_id: zId,
        number: z.string().nullable(),
        total_paise: zPaise,
        reason: z.string().nullable(),
        cancelled_by_name: z.string().nullable(),
      }),
    ),
  }),
  discounts: z.object({ item_paise: zPaise, bill_paise: zPaise, total_paise: zPaise }),
  top_items: z.array(
    z.object({
      product_id: zId.nullable(),
      name: z.string(),
      name_ta: z.string().nullable(),
      unit: z.string(),
      pack_size: z.int().min(1),
      qty_milli: zMilliSigned,
      total_paise: zPaise,
    }),
  ),
  expenses: z.object({ count: z.int().min(0), cash_paise: zPaise }),
  cash: ShiftCashSchema,
})
export type ShiftSummary = z.output<typeof ShiftSummarySchema>

export const SHIFT_TOP_ITEMS = 10

export const ShiftSchema = z.object({
  id: zId,
  store_id: zId,
  store_name: z.string(),
  register_id: zId,
  register_code: z.string(),
  register_name: z.string(),
  status: ShiftStatusSchema,
  opened_by: zId,
  opened_by_name: z.string().nullable(),
  opened_at: zTimestamp,
  opening_cash_paise: zPaise,
  closed_by: zId.nullable(),
  closed_by_name: z.string().nullable(),
  closed_at: zTimestamp.nullable(),
  /** Stored at close (null while open; the live value is in the detail's summary.cash). */
  expected_cash_paise: zSignedPaise.nullable(),
  counted_cash_paise: zPaise.nullable(),
  difference_paise: zSignedPaise.nullable(),
  difference_status: ShiftDifferenceStatusSchema.nullable(),
  /** From the Z summary (null while open). */
  bills_count: z.int().min(0).nullable(),
  sales_total_paise: zPaise.nullable(),
  notes: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Shift = z.output<typeof ShiftSchema>

export const ShiftDetailSchema = ShiftSchema.extend({
  denominations: DenominationsSchema.nullable(),
  /** X report while open (live), Z report once closed (stored). */
  summary: ShiftSummarySchema,
  cash_entries: z.array(ShiftCashEntrySchema),
  /** Own shift or shifts.manage, and open. */
  can_close: z.boolean(),
  can_add_cash_entry: z.boolean(),
})
export type ShiftDetail = z.output<typeof ShiftDetailSchema>

/**
 * POST /shifts/open — one open shift per register (409 shift_already_open {shift_id}); register
 * store access. With denominations the opening cash must equal their total.
 */
export const ShiftOpenSchema = z
  .object({
    register_id: zId,
    opening_cash_paise: zPaise,
    denominations: DenominationsSchema.optional(),
    notes: zNullableText(500),
    client_ref: zIdempotencyKey.optional(),
  })
  .refine((v) => !v.denominations || denominationsTotalPaise(v.denominations) === v.opening_cash_paise, {
    message: 'denominations_total_mismatch',
    path: ['opening_cash_paise'],
  })
export type ShiftOpen = z.input<typeof ShiftOpenSchema>

export const ShiftCurrentQuerySchema = z.object({ register_id: zId })
export type ShiftCurrentQuery = z.input<typeof ShiftCurrentQuerySchema>

/**
 * POST /shifts/:id/cash-entries — open shift only (409 shift_closed); own shift or shifts.manage
 * (403 not_own_shift). Counter account: `account_id` (e.g. an expense head for a petty expense)
 * or `counter` (system subtype); neither → defaultCashEntryCounter(kind). Journal source 'shift'
 * with source_id = the shift id (cashEntryJournalLines).
 */
export const ShiftCashEntryCreateSchema = z
  .object({
    kind: ShiftCashEntryKindSchema,
    amount_paise: zAmountPaise,
    reason: z.string().trim().min(2, 'reason_required').max(200),
    account_id: zId.optional(),
    counter: CashEntryCounterSchema.optional(),
    client_ref: zIdempotencyKey.optional(),
  })
  .refine((v) => !(v.account_id && v.counter), {
    message: 'cash_entry_counter_both',
    path: ['counter'],
  })
export type ShiftCashEntryCreate = z.input<typeof ShiftCashEntryCreateSchema>

/**
 * POST /shifts/:id/close — own shift or shifts.manage. Expected cash per expectedShiftCash();
 * the difference posts per shiftDifferenceJournalLines(); the Z summary is stored. No reopen:
 * corrections are manual journals.
 */
export const ShiftCloseSchema = z
  .object({
    counted_cash_paise: zPaise,
    denominations: DenominationsSchema.optional(),
    notes: zNullableText(500),
  })
  .refine((v) => !v.denominations || denominationsTotalPaise(v.denominations) === v.counted_cash_paise, {
    message: 'denominations_total_mismatch',
    path: ['counted_cash_paise'],
  })
export type ShiftClose = z.input<typeof ShiftCloseSchema>

/**
 * GET /shifts — members with only shifts.operate see their own shifts; shifts.manage sees all
 * (within their stores). Dates filter the opening business date.
 */
export const ShiftListQuerySchema = PageQuerySchema.extend({
  ...DATE_RANGE_FIELDS,
  store_id: zId.optional(),
  register_id: zId.optional(),
  status: ShiftStatusSchema.optional(),
  user_id: zId.optional().describe('Opened by'),
  difference: ShiftDifferenceStatusSchema.optional(),
  sort: sortQuery(['opened_at', 'closed_at', 'difference_paise'] as const).prefault('-opened_at'),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type ShiftListQuery = z.input<typeof ShiftListQuerySchema>

export const ShiftListResponseSchema = listOf(ShiftSchema).extend({
  summary: z.object({
    count: z.int().min(0),
    open_count: z.int().min(0),
    /** Σ shortages (≤ 0) and Σ excesses (≥ 0) of closed shifts. */
    short_paise: zSignedPaise,
    excess_paise: zSignedPaise,
  }),
})
export type ShiftListResponse = z.output<typeof ShiftListResponseSchema>

// =============================================================================================
// Books: day book, cash book, ledger
// =============================================================================================

export const DayBookQuerySchema = z.object({
  date: zDateStr,
  store_id: zId.optional(),
  source_type: zQueryList(JournalSourceTypeSchema).optional(),
  limit: zQueryInt(1, 500).default(100),
  offset: zQueryInt(0, 10_000_000).default(0),
  format: zListFormat,
})
export type DayBookQuery = z.input<typeof DayBookQuerySchema>

/** GET /books/day-book — every entry of the day with its lines (paginated) + day totals. */
export const DayBookResponseSchema = listOf(JournalEntryDetailSchema).extend({
  day: z.object({
    date: zDateStr,
    store_id: zId.nullable(),
    entry_count: z.int().min(0),
    total_debit_paise: zPaise,
    total_credit_paise: zPaise,
    by_source_type: z.array(
      z.object({ source_type: JournalSourceTypeSchema, count: z.int().min(0), total_paise: zPaise }),
    ),
  }),
})
export type DayBookResponse = z.output<typeof DayBookResponseSchema>

/** Most ledger rows per page; CSV streams the whole range. */
export const LEDGER_PAGE_MAX = 1000

const LedgerQueryBase = {
  from: zDateStr.optional().describe("Default: the 1st of `to`'s month"),
  to: zDateStr.optional().describe('Default: today'),
  store_id: zId.optional(),
  party_type: PartyTypeSchema.optional(),
  party_id: zId.optional(),
  limit: zQueryInt(1, LEDGER_PAGE_MAX).default(200),
  offset: zQueryInt(0, 10_000_000).default(0),
  format: zListFormat,
}

/** GET /books/ledger/:accountId — party filter for receivable / payable accounts. */
export const LedgerQuerySchema = z
  .object(LedgerQueryBase)
  .refine(dateOrderOk, DATE_ORDER_ISSUE)
  .refine((v) => (v.party_type === undefined) === (v.party_id === undefined), {
    message: 'party_pair_required',
    path: ['party_id'],
  })
export type LedgerQuery = z.input<typeof LedgerQuerySchema>

/** GET /books/cash-book — `account_id` must be a cash / bank account (default: system cash). */
export const CashBookQuerySchema = z
  .object({ ...LedgerQueryBase, account_id: zId.optional() })
  .refine(dateOrderOk, DATE_ORDER_ISSUE)
  .refine((v) => (v.party_type === undefined) === (v.party_id === undefined), {
    message: 'party_pair_required',
    path: ['party_id'],
  })
export type CashBookQuery = z.input<typeof CashBookQuerySchema>

export const LedgerParamsSchema = z.object({ accountId: zId })

export const AccountLedgerRowSchema = z.object({
  entry_id: zId,
  line_id: zId,
  date: zDateStr,
  source_type: JournalSourceTypeSchema,
  source_id: zId.nullable(),
  source_number: z.string().nullable(),
  source_path: z.string().nullable(),
  narration: z.string().nullable(),
  memo: z.string().nullable(),
  /** "Particulars": names of the entry's accounts on the other side. */
  counter_accounts: z.array(z.string()),
  party_type: PartyTypeSchema.nullable(),
  party_id: zId.nullable(),
  party_name: z.string().nullable(),
  debit_paise: zPaise,
  credit_paise: zPaise,
  /** Running natural balance after this row (over the whole range, not just the page). */
  balance_paise: zSignedPaise,
})
export type AccountLedgerRow = z.output<typeof AccountLedgerRowSchema>

export const AccountLedgerMetaSchema = z.object({
  account: z.object({
    id: zId,
    code: z.string(),
    name: z.string(),
    name_ta: z.string().nullable(),
    type: AccountTypeSchema,
    subtype: AccountSubtypeSchema.nullable(),
  }),
  party: z.object({ type: PartyTypeSchema, id: zId, name: z.string() }).nullable(),
  store_id: zId.nullable(),
  from: zDateStr,
  to: zDateStr,
  /** Natural balance before `from`. */
  opening_balance_paise: zSignedPaise,
  total_debit_paise: zPaise,
  total_credit_paise: zPaise,
  closing_balance_paise: zSignedPaise,
  /** Balance before the first row of this page (printing a page continues from it). */
  page_opening_balance_paise: zSignedPaise,
})
export type AccountLedgerMeta = z.output<typeof AccountLedgerMetaSchema>

export const AccountLedgerResponseSchema = listOf(AccountLedgerRowSchema).extend({
  ledger: AccountLedgerMetaSchema,
})
export type AccountLedgerResponse = z.output<typeof AccountLedgerResponseSchema>

/**
 * Running natural balances (rows in date / posting order) — what the server's window function
 * computes; shared for printing and tests.
 */
export function runningBalances<T extends { debit_paise: number; credit_paise: number }>(
  type: AccountType,
  openingPaise: number,
  rows: readonly T[],
): { rows: Array<T & { balance_paise: number }>; closing_balance_paise: number } {
  let balance = openingPaise
  const out = rows.map((r) => {
    balance += naturalBalance(type, r.debit_paise, r.credit_paise)
    return { ...r, balance_paise: balance }
  })
  return { rows: out, closing_balance_paise: balance }
}

// =============================================================================================
// Statements
// =============================================================================================

export const TrialBalanceQuerySchema = z.object({
  as_of: zDateStr.optional().describe('Default: today'),
  include_zero: zBooleanQuery.default(false),
  format: zListFormat,
})
export type TrialBalanceQuery = z.input<typeof TrialBalanceQuerySchema>

export const TrialBalanceRowSchema = z.object({
  account_id: zId,
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  type: AccountTypeSchema,
  subtype: AccountSubtypeSchema.nullable(),
  parent_id: zId.nullable(),
  /** Net balance on its side (one of the two is 0). */
  debit_paise: zPaise,
  credit_paise: zPaise,
})
export type TrialBalanceRow = z.output<typeof TrialBalanceRowSchema>

/** GET /statements/trial-balance — tenant-wide (403 all_stores_required for store-scoped members). */
export const TrialBalanceSchema = z.object({
  as_of: zDateStr,
  rows: z.array(TrialBalanceRowSchema),
  total_debit_paise: zPaise,
  total_credit_paise: zPaise,
  difference_paise: zSignedPaise,
  balanced: z.boolean(),
})
export type TrialBalance = z.output<typeof TrialBalanceSchema>

/** Debit / credit columns of a trial balance row from Σ debits and Σ credits. */
export function trialBalanceSides(
  debitTotal: number,
  creditTotal: number,
): { debit_paise: number; credit_paise: number } {
  const net = debitTotal - creditTotal
  return net >= 0 ? { debit_paise: net, credit_paise: 0 } : { debit_paise: 0, credit_paise: -net }
}

export const ProfitLossQuerySchema = z
  .object({
    from: zDateStr.optional().describe("Default: start of `to`'s financial year"),
    to: zDateStr.optional().describe('Default: today'),
    store_id: zId.optional().describe('Only lines of this store (journal_lines.store_id)'),
    compare_from: zDateStr.optional(),
    compare_to: zDateStr.optional(),
    format: zListFormat,
  })
  .refine(dateOrderOk, DATE_ORDER_ISSUE)
  .refine((v) => (v.compare_from === undefined) === (v.compare_to === undefined), {
    message: 'compare_range_incomplete',
    path: ['compare_to'],
  })
  .refine((v) => !v.compare_from || !v.compare_to || v.compare_from <= v.compare_to, {
    message: 'date_order',
    path: ['compare_to'],
  })
export type ProfitLossQuery = z.input<typeof ProfitLossQuerySchema>

export const StatementLineSchema = z.object({
  account_id: zId,
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  subtype: AccountSubtypeSchema.nullable(),
  parent_id: zId.nullable(),
  /** Natural amount (income: credit − debit, e.g. sales returns negative; expense: debit − credit). */
  amount_paise: zSignedPaise,
  /** Same for the comparison period (null without one). */
  compare_paise: zSignedPaise.nullable(),
})
export type StatementLine = z.output<typeof StatementLineSchema>

export const StatementSectionSchema = z.object({
  lines: z.array(StatementLineSchema),
  total_paise: zSignedPaise,
  compare_total_paise: zSignedPaise.nullable(),
})
export type StatementSection = z.output<typeof StatementSectionSchema>

/**
 * GET /statements/profit-loss. income = every income account (sales − sales returns + other income
 * + round off + discount received); cogs = the cogs account and its descendants; expenses = every
 * other expense account; gross profit = income − cogs; net profit = income − cogs − expenses.
 * net_sales = sales + sales_returns (+ descendants), the base of the margins.
 */
export const ProfitLossSchema = z.object({
  from: zDateStr,
  to: zDateStr,
  store_id: zId.nullable(),
  compare: z.object({ from: zDateStr, to: zDateStr }).nullable(),
  income: StatementSectionSchema,
  cogs: StatementSectionSchema,
  expenses: StatementSectionSchema,
  net_sales_paise: zSignedPaise,
  net_sales_compare_paise: zSignedPaise.nullable(),
  gross_profit_paise: zSignedPaise,
  gross_profit_compare_paise: zSignedPaise.nullable(),
  net_profit_paise: zSignedPaise,
  net_profit_compare_paise: zSignedPaise.nullable(),
  /** gross / net profit ÷ net sales in bp (null when net sales ≤ 0). */
  gross_margin_bp: z.int().nullable(),
  net_margin_bp: z.int().nullable(),
})
export type ProfitLoss = z.output<typeof ProfitLossSchema>

/** profit ÷ sales in basis points (rounded), null when sales ≤ 0. */
export function marginBp(profitPaise: number, salesPaise: number): number | null {
  if (salesPaise <= 0) return null
  return roundDiv(profitPaise * 10_000, salesPaise)
}

/** P&L totals from the three section totals. */
export function profitLossTotals(t: { income: number; cogs: number; expenses: number }): {
  gross_profit_paise: number
  net_profit_paise: number
} {
  return { gross_profit_paise: t.income - t.cogs, net_profit_paise: t.income - t.cogs - t.expenses }
}

export const ComparisonModeSchema = z.enum(['previous_period', 'previous_year'])
export type ComparisonMode = z.infer<typeof ComparisonModeSchema>

/**
 * Comparison range for the P&L toggle: previous_period = the same number of days just before
 * `from`; previous_year = the same dates one year earlier (29 Feb → 28 Feb).
 */
export function comparisonRange(
  from: string,
  to: string,
  mode: ComparisonMode,
): { from: string; to: string } {
  if (mode === 'previous_year') return { from: addMonths(from, -12), to: addMonths(to, -12) }
  const days = diffDays(from, to) + 1
  return { from: addDays(from, -days), to: addDays(from, -1) }
}

export const BalanceSheetQuerySchema = z.object({
  as_of: zDateStr.optional().describe('Default: today'),
  format: zListFormat,
})
export type BalanceSheetQuery = z.input<typeof BalanceSheetQuerySchema>

export const BalanceSheetSectionSchema = z.object({
  lines: z.array(StatementLineSchema),
  total_paise: zSignedPaise,
})
export type BalanceSheetSection = z.output<typeof BalanceSheetSectionSchema>

/**
 * GET /statements/balance-sheet (tenant-wide). There are no closing entries: equity shows the
 * capital accounts plus current_period_profit (P&L from the start of as_of's FY to as_of — equals
 * the P&L net profit for that range) and retained_earnings (all P&L before the FY start).
 * Assets = liabilities + equity (incl. both) — `balanced` / `difference_paise` report the check.
 */
export const BalanceSheetSchema = z.object({
  as_of: zDateStr,
  fy: z.string(),
  fy_start: zDateStr,
  assets: BalanceSheetSectionSchema,
  liabilities: BalanceSheetSectionSchema,
  /** Capital, drawings (negative), opening balance equity and custom equity accounts. */
  equity: BalanceSheetSectionSchema,
  current_period_profit_paise: zSignedPaise,
  retained_earnings_paise: zSignedPaise,
  /** equity.total + current period profit + retained earnings. */
  total_equity_paise: zSignedPaise,
  total_assets_paise: zSignedPaise,
  total_liabilities_equity_paise: zSignedPaise,
  /** assets − (liabilities + equity); 0 when balanced. */
  difference_paise: zSignedPaise,
  balanced: z.boolean(),
})
export type BalanceSheet = z.output<typeof BalanceSheetSchema>

/** Totals and the A = L + E check from the section totals. */
export function balanceSheetTotals(t: {
  assets: number
  liabilities: number
  equity: number
  current_period_profit: number
  retained_earnings: number
}): {
  total_equity_paise: number
  total_liabilities_equity_paise: number
  difference_paise: number
  balanced: boolean
} {
  const equity = t.equity + t.current_period_profit + t.retained_earnings
  const le = t.liabilities + equity
  return {
    total_equity_paise: equity,
    total_liabilities_equity_paise: le,
    difference_paise: t.assets - le,
    balanced: t.assets === le,
  }
}

// =============================================================================================
// Route catalogue (docs/API.md "accounting")
// =============================================================================================

const IdParams = z.object({ id: zId })

export const accountingRoutes = defineRoutes({
  // ---- chart of accounts -----------------------------------------------------------------------
  listAccounts: {
    method: 'GET',
    path: '/accounts',
    permission: ['accounting.read', 'expenses.write', 'shifts.operate', 'payments.configure'],
    query: ChartOfAccountsQuerySchema,
    response: dataOf(ChartOfAccountsSchema),
    summary: 'Chart of accounts with balances as of a date (not paginated; buildAccountTree())',
  },
  createAccount: {
    method: 'POST',
    path: '/accounts',
    permission: ['accounting.write', 'expenses.write'],
    body: AccountCreateSchema,
    response: dataOf(AccountDetailSchema),
    status: 201,
    summary: 'Custom account (expenses.write alone: expense heads only); code unique per tenant',
  },
  getAccount: {
    method: 'GET',
    path: '/accounts/:id',
    permission: ['accounting.read', 'expenses.write'],
    params: IdParams,
    response: dataOf(AccountDetailSchema),
  },
  updateAccount: {
    method: 'PATCH',
    path: '/accounts/:id',
    permission: 'accounting.write',
    params: IdParams,
    body: AccountUpdateSchema,
    response: dataOf(AccountDetailSchema),
    summary: 'Rename (system accounts: name / name_ta / bank details only) or edit / deactivate',
  },
  deleteAccount: {
    method: 'DELETE',
    path: '/accounts/:id',
    permission: 'accounting.write',
    params: IdParams,
    response: dataOf(DeleteResultSchema),
    summary: 'Custom accounts: deleted without journal lines, else deactivated (409 when not allowed)',
  },

  // ---- journal ----------------------------------------------------------------------------------
  listJournalEntries: {
    method: 'GET',
    path: '/journal-entries',
    permission: 'accounting.read',
    feature: 'accounting',
    query: JournalListQuerySchema,
    response: JournalListResponseSchema,
    summary: 'Journal entries (date range, source, account, party, search); ?format=csv',
  },
  getJournalEntry: {
    method: 'GET',
    path: '/journal-entries/:id',
    permission: 'accounting.read',
    feature: 'accounting',
    params: IdParams,
    response: dataOf(JournalEntryDetailSchema),
  },
  createJournalEntry: {
    method: 'POST',
    path: '/journal-entries',
    permission: 'accounting.write',
    feature: 'accounting',
    idempotent: true,
    body: ManualJournalCreateSchema,
    response: dataOf(JournalEntryDetailSchema),
    status: 201,
    summary: 'Manual journal voucher (balanced, ≥ 2 lines, JV number, audited)',
  },
  reverseJournalEntry: {
    method: 'POST',
    path: '/journal-entries/:id/reverse',
    permission: 'accounting.write',
    feature: 'accounting',
    params: IdParams,
    body: JournalReverseSchema,
    response: dataOf(JournalEntryDetailSchema),
    status: 201,
    summary: 'Reverse a manual journal once (returns the reversal entry)',
  },

  // ---- expenses ---------------------------------------------------------------------------------
  listExpenses: {
    method: 'GET',
    path: '/expenses',
    permission: ['expenses.write', 'accounting.read'],
    query: ExpenseListQuerySchema,
    response: ExpenseListResponseSchema,
    summary: 'Expenses with totals by category and method; ?format=csv',
  },
  createExpense: {
    method: 'POST',
    path: '/expenses',
    permission: 'expenses.write',
    idempotent: true,
    body: ExpenseCreateSchema,
    response: dataOf(ExpenseDetailSchema),
    status: 201,
    summary: 'Record an expense (GST, ITC, cash / bank / credit; EXP number; journal)',
  },
  getExpense: {
    method: 'GET',
    path: '/expenses/:id',
    permission: ['expenses.write', 'accounting.read'],
    params: IdParams,
    response: dataOf(ExpenseDetailSchema),
  },
  cancelExpense: {
    method: 'POST',
    path: '/expenses/:id/cancel',
    permission: 'expenses.write',
    params: IdParams,
    body: ExpenseCancelSchema,
    response: dataOf(ExpenseDetailSchema),
    summary: 'Cancel (reversal journal, audited; 409 with supplier payments allocated)',
  },

  // ---- shifts -----------------------------------------------------------------------------------
  openShift: {
    method: 'POST',
    path: '/shifts/open',
    permission: 'shifts.operate',
    feature: 'shifts',
    idempotent: true,
    body: ShiftOpenSchema,
    response: dataOf(ShiftDetailSchema),
    status: 201,
    summary: 'Open a shift on a register with the opening cash (one open shift per register)',
  },
  currentShift: {
    method: 'GET',
    path: '/shifts/current',
    permission: ['shifts.operate', 'pos.use'],
    feature: 'shifts',
    query: ShiftCurrentQuerySchema,
    response: dataOf(ShiftDetailSchema.nullable()),
    summary: "The register's open shift with its live X report, or null",
  },
  listShifts: {
    method: 'GET',
    path: '/shifts',
    permission: 'shifts.operate',
    feature: 'shifts',
    query: ShiftListQuerySchema,
    response: ShiftListResponseSchema,
    summary: 'Shifts (own only without shifts.manage) with expected vs counted cash; ?format=csv',
  },
  getShift: {
    method: 'GET',
    path: '/shifts/:id',
    permission: 'shifts.operate',
    feature: 'shifts',
    params: IdParams,
    response: dataOf(ShiftDetailSchema),
    summary: 'Shift with its X report (open) or Z report (closed)',
  },
  addShiftCashEntry: {
    method: 'POST',
    path: '/shifts/:id/cash-entries',
    permission: 'shifts.operate',
    feature: 'shifts',
    idempotent: true,
    params: IdParams,
    body: ShiftCashEntryCreateSchema,
    response: dataOf(ShiftCashEntrySchema),
    status: 201,
    summary: 'Pay-in / pay-out of drawer cash (journal Dr/Cr cash vs the counter account)',
  },
  closeShift: {
    method: 'POST',
    path: '/shifts/:id/close',
    permission: 'shifts.operate',
    feature: 'shifts',
    params: IdParams,
    body: ShiftCloseSchema,
    response: dataOf(ShiftDetailSchema),
    summary: 'Close with the counted cash; posts the difference to cash short / excess; Z report',
  },

  // ---- books ------------------------------------------------------------------------------------
  dayBook: {
    method: 'GET',
    path: '/books/day-book',
    permission: 'accounting.read',
    feature: 'accounting',
    query: DayBookQuerySchema,
    response: DayBookResponseSchema,
    summary: 'All journal entries of a day with lines and source documents; ?format=csv',
  },
  cashBook: {
    method: 'GET',
    path: '/books/cash-book',
    permission: 'accounting.read',
    feature: 'accounting',
    query: CashBookQuerySchema,
    response: AccountLedgerResponseSchema,
    summary: 'Cash (or bank) book: opening, entries with running balance, closing; ?format=csv',
  },
  accountLedger: {
    method: 'GET',
    path: '/books/ledger/:accountId',
    permission: 'accounting.read',
    feature: 'accounting',
    params: LedgerParamsSchema,
    query: LedgerQuerySchema,
    response: AccountLedgerResponseSchema,
    summary: 'Ledger of any account (party filter for receivable / payable); ?format=csv',
  },

  // ---- statements -------------------------------------------------------------------------------
  trialBalance: {
    method: 'GET',
    path: '/statements/trial-balance',
    permission: 'accounting.read',
    feature: 'accounting',
    query: TrialBalanceQuerySchema,
    response: dataOf(TrialBalanceSchema),
    summary: 'Trial balance as of a date (debit / credit balances; totals equal); ?format=csv',
  },
  profitLoss: {
    method: 'GET',
    path: '/statements/profit-loss',
    permission: 'accounting.read',
    feature: 'accounting',
    query: ProfitLossQuerySchema,
    response: dataOf(ProfitLossSchema),
    summary: 'Profit & loss for a period (optional comparison period, store filter); ?format=csv',
  },
  balanceSheet: {
    method: 'GET',
    path: '/statements/balance-sheet',
    permission: 'accounting.read',
    feature: 'accounting',
    query: BalanceSheetQuerySchema,
    response: dataOf(BalanceSheetSchema),
    summary: 'Balance sheet as of a date incl. current-period profit (A = L + E check); ?format=csv',
  },
})
export type AccountingRoutes = typeof accountingRoutes
