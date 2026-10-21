/**
 * Display helpers for payments data: bilingual contract labels in the UI language, status
 * tones, party names and the signed-amount reading of a payment direction.
 */
import type { BilingualLabel } from '@kadai/shared/api/common'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import type {
  PaymentDirection,
  PaymentIntentStatus,
  PaymentMethod,
  PaymentStatus,
} from '@kadai/shared/enums'
import type { Tone } from '@/components/ui'
import type { Language } from '@/lib/i18n'

/** Hotkey scope of the payments pages (page shortcuts; dialogs push their own scope). */
export const PAYMENTS_HOTKEY_SCOPE = 'payments'

export function langOf(language: string | undefined): Language {
  return language === 'en' ? 'en' : 'ta'
}

/** `{ en, ta }` label in the given UI language. */
export function pickLabel(label: BilingualLabel, language: string | undefined): string {
  return label[langOf(language)]
}

/** Payment method label (the contract's printed labels) in the UI language. */
export function methodLabel(method: PaymentMethod, language: string | undefined): string {
  return pickLabel(PAYMENT_METHOD_LABELS[method], language)
}

/** Name in the UI language plus the other-language name (when different). */
export function bilingualName(
  name: string,
  nameTa: string | null | undefined,
  language: string | undefined,
): { primary: string; secondary: string | null } {
  if (!nameTa || nameTa === name) return { primary: name, secondary: null }
  return langOf(language) === 'ta'
    ? { primary: nameTa, secondary: name }
    : { primary: name, secondary: nameTa }
}

export function intentStatusTone(status: PaymentIntentStatus): Tone {
  switch (status) {
    case 'paid':
      return 'success'
    case 'pending':
      return 'warning'
    case 'created':
      return 'info'
    case 'failed':
      return 'danger'
    case 'expired':
    case 'cancelled':
      return 'neutral'
  }
}

export function paymentStatusTone(status: PaymentStatus): Tone {
  switch (status) {
    case 'completed':
      return 'success'
    case 'pending':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'neutral'
  }
}

/** Receipts are money in (+), vouchers money out (−). */
export function signedAmount(direction: PaymentDirection, amountPaise: number): number {
  return direction === 'in' ? amountPaise : -amountPaise
}
