/**
 * Chart of accounts seeded per tenant (ARCHITECTURE.md §8.3). Posting rules address system
 * accounts by `subtype` (`systemAccountId(tx, ctx, 'cash')`); codes and names are editable
 * labels. Tamil names are printed on Tamil reports and books.
 */
import type { AccountType } from './enums'

export const SYSTEM_ACCOUNT_SUBTYPES = [
  'cash',
  'bank',
  'upi_clearing',
  'card_clearing',
  'receivable',
  'inventory',
  'input_cgst',
  'input_sgst',
  'input_igst',
  'input_cess',
  'payable',
  'output_cgst',
  'output_sgst',
  'output_igst',
  'output_cess',
  'customer_advance',
  'capital',
  'drawings',
  'opening_balance',
  'sales',
  'sales_returns',
  'other_income',
  'round_off',
  'discount_received',
  'cogs',
  'inventory_adjustment',
  'inventory_writeoff',
  'bank_charges',
  'discount_allowed',
] as const
export type SystemAccountSubtype = (typeof SYSTEM_ACCOUNT_SUBTYPES)[number]

export function isSystemAccountSubtype(value: unknown): value is SystemAccountSubtype {
  return typeof value === 'string' && (SYSTEM_ACCOUNT_SUBTYPES as readonly string[]).includes(value)
}

export interface ChartAccount {
  code: string
  name: string
  name_ta: string
  type: AccountType
  /** Posting subtype; null for plain (e.g. expense head) accounts. */
  subtype: SystemAccountSubtype | null
  is_system: true
}

const a = (
  code: string,
  type: AccountType,
  subtype: SystemAccountSubtype | null,
  name: string,
  name_ta: string,
): ChartAccount => ({
  code,
  name,
  name_ta,
  type,
  subtype,
  is_system: true,
})

/** Expense heads seeded with every tenant (codes 5300–5390). 5360 doubles as the PSP-fee account. */
export const EXPENSE_ACCOUNT_PRESETS: readonly ChartAccount[] = [
  a('5300', 'expense', null, 'Rent', 'வாடகை'),
  a('5310', 'expense', null, 'Electricity', 'மின்கட்டணம்'),
  a('5320', 'expense', null, 'Salaries & wages', 'சம்பளம் & கூலி'),
  a('5330', 'expense', null, 'Transport & freight', 'போக்குவரத்து & சரக்குக் கட்டணம்'),
  a('5340', 'expense', null, 'Repairs & maintenance', 'பழுது பார்த்தல் & பராமரிப்பு'),
  a('5350', 'expense', null, 'Telephone & internet', 'தொலைபேசி & இணையம்'),
  a('5360', 'expense', 'bank_charges', 'Bank & PSP charges', 'வங்கி & பேமெண்ட் கட்டணங்கள்'),
  a('5370', 'expense', null, 'Packing materials', 'பேக்கிங் பொருட்கள்'),
  a('5390', 'expense', null, 'Miscellaneous expenses', 'இதர செலவுகள்'),
]

/** Additional expense heads offered in the UI when the shop creates a custom account. */
export const EXPENSE_ACCOUNT_SUGGESTIONS: ReadonlyArray<{ name: string; name_ta: string }> = [
  { name: 'Tea & refreshments', name_ta: 'டீ & சிற்றுண்டி' },
  { name: 'Advertising', name_ta: 'விளம்பரம்' },
  { name: 'Water', name_ta: 'தண்ணீர்' },
  { name: 'Generator / fuel', name_ta: 'ஜெனரேட்டர் / எரிபொருள்' },
  { name: 'Licences & fees', name_ta: 'உரிமங்கள் & கட்டணங்கள்' },
  { name: 'Software & subscriptions', name_ta: 'மென்பொருள் & சந்தாக்கள்' },
  { name: 'Commission', name_ta: 'தரகு' },
  { name: 'Shop maintenance', name_ta: 'கடை பராமரிப்பு' },
]

/** System chart of accounts (seeded by onboarding, in code order). */
export const DEFAULT_CHART: readonly ChartAccount[] = [
  a('1100', 'asset', 'cash', 'Cash in hand', 'கையிருப்பு ரொக்கம்'),
  a('1200', 'asset', 'bank', 'Bank account', 'வங்கிக் கணக்கு'),
  a('1210', 'asset', 'upi_clearing', 'UPI / PSP clearing', 'UPI / பேமெண்ட் நிலுவைக் கணக்கு'),
  a('1220', 'asset', 'card_clearing', 'Card clearing', 'கார்டு நிலுவைக் கணக்கு'),
  a(
    '1300',
    'asset',
    'receivable',
    'Accounts receivable (Sundry debtors)',
    'வர வேண்டிய தொகை (பற்று வாடிக்கையாளர்கள்)',
  ),
  a('1400', 'asset', 'inventory', 'Stock in hand', 'கையிருப்புச் சரக்கு'),
  a('1510', 'asset', 'input_cgst', 'Input CGST', 'உள்ளீட்டு CGST'),
  a('1520', 'asset', 'input_sgst', 'Input SGST', 'உள்ளீட்டு SGST'),
  a('1530', 'asset', 'input_igst', 'Input IGST', 'உள்ளீட்டு IGST'),
  a('1540', 'asset', 'input_cess', 'Input cess', 'உள்ளீட்டு செஸ்'),
  a(
    '2100',
    'liability',
    'payable',
    'Accounts payable (Sundry creditors)',
    'செலுத்த வேண்டிய தொகை (கடன் சப்ளையர்கள்)',
  ),
  a('2210', 'liability', 'output_cgst', 'Output CGST', 'வெளியீட்டு CGST'),
  a('2220', 'liability', 'output_sgst', 'Output SGST', 'வெளியீட்டு SGST'),
  a('2230', 'liability', 'output_igst', 'Output IGST', 'வெளியீட்டு IGST'),
  a('2240', 'liability', 'output_cess', 'Output cess', 'வெளியீட்டு செஸ்'),
  a(
    '2300',
    'liability',
    'customer_advance',
    'Store credit / advances',
    'வாடிக்கையாளர் முன்பணம் / கடை வரவு',
  ),
  a('3100', 'equity', 'capital', "Owner's capital", 'உரிமையாளர் முதலீடு'),
  a('3200', 'equity', 'drawings', "Owner's drawings", 'உரிமையாளர் எடுப்பு'),
  a('3900', 'equity', 'opening_balance', 'Opening balance equity', 'தொடக்க இருப்பு'),
  a('4100', 'income', 'sales', 'Sales', 'விற்பனை'),
  a('4200', 'income', 'sales_returns', 'Sales returns', 'விற்பனைத் திருப்பம்'),
  a('4300', 'income', 'other_income', 'Other income', 'இதர வருமானம்'),
  a('4400', 'income', 'round_off', 'Round off', 'முழுமையாக்கல் (ரவுண்ட் ஆஃப்)'),
  a('4500', 'income', 'discount_received', 'Discount received', 'பெற்ற தள்ளுபடி'),
  a('5100', 'expense', 'cogs', 'Cost of goods sold', 'விற்ற சரக்கின் அடக்க விலை'),
  a(
    '5200',
    'expense',
    'inventory_adjustment',
    'Stock adjustment / shrinkage',
    'சரக்கு சரிசெய்தல் / இழப்பு',
  ),
  a(
    '5210',
    'expense',
    'inventory_writeoff',
    'Expired / damaged stock written off',
    'காலாவதி / சேதமடைந்த சரக்கு தள்ளுபடி',
  ),
  ...EXPENSE_ACCOUNT_PRESETS,
  a('5400', 'expense', 'discount_allowed', 'Discount allowed', 'வழங்கிய தள்ளுபடி'),
]

/** Natural balance side: assets & expenses increase with debits; the rest with credits. */
export function normalBalanceOf(type: AccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit'
}

/** Signed balance in the account's natural direction (positive = normal balance). */
export function naturalBalance(type: AccountType, debitPaise: number, creditPaise: number): number {
  return normalBalanceOf(type) === 'debit' ? debitPaise - creditPaise : creditPaise - debitPaise
}
