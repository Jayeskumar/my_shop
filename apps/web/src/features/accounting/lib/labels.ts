/**
 * Display helpers for accounting data: bilingual contract labels in the UI language, account and
 * party names, Dr / Cr sides and status tones.
 */
import type { AccountType, JournalSourceType } from '@kadai/shared'
import {
  ACCOUNT_TYPE_LABELS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  JOURNAL_SOURCE_LABELS,
  SHIFT_CASH_ENTRY_KIND_LABELS,
  SHIFT_DIFFERENCE_LABELS,
  type ShiftDifferenceStatus,
  balanceSide,
} from '@kadai/shared/api/accounting'
import type { BilingualLabel } from '@kadai/shared/api/identity'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import type { ExpensePaymentMethod, PaymentMethod, ShiftCashEntryKind } from '@kadai/shared'
import type { Tone } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { getLanguage, localizedName, translate } from '@/lib/i18n'

/** Hotkey scope of the accounting pages (alt+n = new, / = search). */
export const ACCOUNTING_HOTKEY_SCOPE = 'accounting'

/** A contract label ({en, ta}) in the UI language. */
export function bi(label: BilingualLabel): string {
  return label[getLanguage()]
}

export const accountTypeLabel = (type: AccountType): string => bi(ACCOUNT_TYPE_LABELS[type])
export const sourceTypeLabel = (type: JournalSourceType): string => bi(JOURNAL_SOURCE_LABELS[type])
export const expenseMethodLabel = (m: ExpensePaymentMethod): string =>
  bi(EXPENSE_PAYMENT_METHOD_LABELS[m])
export const paymentMethodLabel = (m: PaymentMethod): string => bi(PAYMENT_METHOD_LABELS[m])
export const cashEntryKindLabel = (k: ShiftCashEntryKind): string =>
  bi(SHIFT_CASH_ENTRY_KIND_LABELS[k])
export const differenceLabel = (s: ShiftDifferenceStatus): string => bi(SHIFT_DIFFERENCE_LABELS[s])

/** Account name in the UI language (Tamil name when the UI is Tamil and one exists). */
export function accountName(a: { name: string; name_ta: string | null }): string {
  return localizedName(a.name, a.name_ta)
}

/** "5300 · Rent" */
export function accountLabel(a: { code: string; name: string; name_ta: string | null }): string {
  return `${a.code} · ${accountName(a)}`
}

/** "₹1,200.00 Dr" for a natural balance of an account type. */
export function drCrText(type: AccountType, naturalPaise: number): string {
  const side = balanceSide(type, naturalPaise)
  return side.amount_paise === 0
    ? formatMoney(0)
    : `${formatMoney(side.amount_paise)} ${side.side === 'Dr' ? drLabel() : crLabel()}`
}

/** Dr / Cr markers ("Dr" / "Cr"; Tamil accountants write பற்று / வரவு). */
export function drLabel(): string {
  return translate('accounting:common.dr')
}
export function crLabel(): string {
  return translate('accounting:common.cr')
}

/** Badge tone of a shift difference. */
export function differenceTone(status: ShiftDifferenceStatus | null | undefined): Tone {
  if (status === 'short') return 'danger'
  if (status === 'excess') return 'warning'
  if (status === 'balanced') return 'success'
  return 'neutral'
}

/** Tone of a journal source type (list badges). */
export function sourceTone(type: JournalSourceType): Tone {
  switch (type) {
    case 'sales_invoice':
    case 'credit_note':
      return 'primary'
    case 'purchase_bill':
    case 'debit_note':
      return 'info'
    case 'payment':
      return 'success'
    case 'expense':
      return 'warning'
    case 'manual':
      return 'accent'
    default:
      return 'neutral'
  }
}
