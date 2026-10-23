/**
 * Status tones and small display helpers shared by the purchases screens. Status / reason texts
 * themselves live in purchases.json (purchases:status.*, purchases:reasons.*).
 */
import type {
  DebitNoteStatus,
  PurchaseBillStatus,
  PurchaseOrderStatus,
  PurchasePaymentStatus,
} from '@kadai/shared'
import { getUnit } from '@kadai/shared/units'
import type { Tone } from '@/components/ui'
import { getLanguage } from '@/lib/i18n'

/** Hotkey scope of the purchases pages (dialogs push their own scope). */
export const PURCHASES_HOTKEY_SCOPE = 'purchases'

export function orderStatusTone(status: PurchaseOrderStatus): Tone {
  switch (status) {
    case 'draft':
      return 'neutral'
    case 'sent':
      return 'info'
    case 'partially_received':
      return 'warning'
    case 'received':
      return 'success'
    case 'closed':
      return 'neutral'
    case 'cancelled':
      return 'danger'
  }
}

export function billStatusTone(status: PurchaseBillStatus): Tone {
  switch (status) {
    case 'draft':
      return 'neutral'
    case 'posted':
      return 'success'
    case 'cancelled':
      return 'danger'
  }
}

export function paymentStatusTone(status: PurchasePaymentStatus, overdue = false): Tone {
  if (overdue && status !== 'paid') return 'danger'
  switch (status) {
    case 'unpaid':
      return 'warning'
    case 'partial':
      return 'info'
    case 'paid':
      return 'success'
  }
}

export function debitNoteStatusTone(status: DebitNoteStatus): Tone {
  return status === 'cancelled' ? 'danger' : 'success'
}

/** A bilingual label map entry in the UI language. */
export function bilingual(label: { en: string; ta: string }): string {
  return getLanguage() === 'ta' ? label.ta : label.en
}

/** Pharmacy strips & similar: the pack word used next to a pack size (TAB/CAP → strip). */
export function packUnitFor(unit: string): string {
  return unit === 'TAB' || unit === 'CAP' ? 'STRIP' : 'PACK'
}

/** Unit symbol in the UI language (plural form in English: "tabs", "strips"). */
export function unitLabel(code: string): string {
  const def = getUnit(code)
  if (!def) return code
  return getLanguage() === 'ta' ? def.symbol_ta : def.symbol_en_plural
}
