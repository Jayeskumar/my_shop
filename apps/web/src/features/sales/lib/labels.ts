/**
 * Display helpers of the sales screens: bilingual contract labels in the UI language, document
 * titles, status tones and the "number or held bill" heading of a document.
 */
import type { BilingualLabel } from '@kadai/shared/api/common'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import {
  CREDIT_NOTE_REASON_LABELS,
  CREDIT_NOTE_SETTLEMENT_LABELS,
  SALES_DOC_TITLES,
} from '@kadai/shared/api/sales'
import type {
  CreditNoteReason,
  CreditNoteSettlement,
  PaymentMethod,
  SalesDocType,
  SalesInvoiceStatus,
  SalesPaymentStatus,
} from '@kadai/shared/enums'
import { getState } from '@kadai/shared/gst'
import type { Tone } from '@/components/ui'
import { formatPackQty, formatQty } from '@/lib/format'
import type { Language } from '@/lib/i18n'

export function langOf(language: string | undefined): Language {
  return language === 'en' ? 'en' : 'ta'
}

/** `{ en, ta }` label in the given UI language. */
export function pickLabel(label: BilingualLabel, language: string | undefined): string {
  return label[langOf(language)]
}

/** Name in the UI language plus the other-language name as a secondary line (when different). */
export function bilingual(
  name: string,
  nameTa: string | null | undefined,
  language: string | undefined,
): { primary: string; secondary: string | null } {
  if (!nameTa || nameTa === name) return { primary: name, secondary: null }
  return langOf(language) === 'ta'
    ? { primary: nameTa, secondary: name }
    : { primary: name, secondary: nameTa }
}

export function docTypeLabel(docType: SalesDocType | 'credit_note', language: string): string {
  return pickLabel(SALES_DOC_TITLES[docType], language)
}

export function methodLabel(method: PaymentMethod, language: string): string {
  return pickLabel(PAYMENT_METHOD_LABELS[method], language)
}

export function reasonLabel(reason: CreditNoteReason, language: string): string {
  return pickLabel(CREDIT_NOTE_REASON_LABELS[reason], language)
}

export function settlementLabel(settlement: CreditNoteSettlement, language: string): string {
  return pickLabel(CREDIT_NOTE_SETTLEMENT_LABELS[settlement], language)
}

/** State name in the UI language ('33' → 'தமிழ்நாடு' / 'Tamil Nadu'). */
export function stateName(code: string | null | undefined, language: string): string {
  if (!code) return ''
  const st = getState(code)
  if (!st) return code
  return langOf(language) === 'ta' ? st.name_ta : st.name_en
}

export function invoiceStatusTone(status: SalesInvoiceStatus): Tone {
  switch (status) {
    case 'completed':
      return 'success'
    case 'cancelled':
      return 'danger'
    case 'held':
      return 'warning'
    case 'converted':
      return 'info'
    case 'draft':
      return 'neutral'
  }
}

export function paymentStatusTone(status: SalesPaymentStatus): Tone {
  switch (status) {
    case 'paid':
      return 'success'
    case 'partial':
      return 'warning'
    case 'unpaid':
      return 'danger'
    case 'refunded':
      return 'info'
  }
}

/** Estimate state for display: open (valid), expired (past valid-until), converted, cancelled. */
export type EstimateState = 'open' | 'expired' | 'converted' | 'cancelled'

export function estimateState(
  row: { status: SalesInvoiceStatus; due_date: string | null },
  today: string,
): EstimateState {
  if (row.status === 'converted') return 'converted'
  if (row.status === 'cancelled') return 'cancelled'
  if (row.due_date && row.due_date < today) return 'expired'
  return 'open'
}

export function estimateStateTone(state: EstimateState): Tone {
  switch (state) {
    case 'open':
      return 'primary'
    case 'expired':
      return 'neutral'
    case 'converted':
      return 'success'
    case 'cancelled':
      return 'danger'
  }
}

/** Address lines joined for display. */
export function addressText(
  address:
    | {
        line1?: string | undefined
        line2?: string | undefined
        city?: string | undefined
        district?: string | undefined
        state_code?: string | undefined
        pincode?: string | undefined
      }
    | null
    | undefined,
  language: string,
): string {
  if (!address) return ''
  return [
    address.line1,
    address.line2,
    address.city,
    address.district && address.district !== address.city ? address.district : undefined,
    address.state_code ? stateName(address.state_code, language) : undefined,
    address.pincode,
  ]
    .filter((p): p is string => Boolean(p))
    .join(', ')
}

/** Quantity for display: packs + loose for pack products ('2 strips + 3 tabs'), else '1.5 kg'. */
export function qtyText(milli: number, unit: string, packSize: number, language: string): string {
  return packSize > 1
    ? formatPackQty(milli, packSize, unit, 'PACK', langOf(language))
    : formatQty(milli, unit, langOf(language))
}
