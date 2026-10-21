/**
 * Bilingual labels of printed documents. Receipts print in the document's languages (the print
 * model's `locale`), not in the cashier's UI language, so every label is looked up in both
 * locale files (pos:print.*).
 */
import { formatDateDisplay, isDateStr } from '@kadai/shared/fy'
import { formatINR } from '@kadai/shared/money'
import { formatPhoneDisplay } from '@kadai/shared/phone'
import type { SalesPrintModel } from '@kadai/shared/api/sales'
import type { Resources } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'

export type PrintLabelKey = keyof Resources['pos']['print']

export interface Bi {
  en: string
  ta: string
}

/** A print label in both languages (with interpolation). */
export function label(key: PrintLabelKey, params?: Record<string, unknown>): Bi {
  const k = `pos:print.${key}` as const
  return {
    en: translate(k, { ...params, lng: 'en' }),
    ta: translate(k, { ...params, lng: 'ta' }),
  }
}

/** The text in the document's primary language, then the other one when bilingual. */
export function biText(model: Pick<SalesPrintModel, 'locale' | 'flags'>, text: Bi): string {
  const primary = model.locale.primary === 'ta' ? text.ta : text.en
  const secondary = model.locale.primary === 'ta' ? text.en : text.ta
  if (!model.flags.bilingual || !secondary || secondary === primary) return primary
  return `${primary} / ${secondary}`
}

/** Primary-language text only. */
export function primaryText(model: Pick<SalesPrintModel, 'locale'>, text: Bi): string {
  return model.locale.primary === 'ta' ? text.ta : text.en
}

/** Name lines of an item / shop: primary language first, the other below when bilingual. */
export function nameLines(
  model: Pick<SalesPrintModel, 'locale' | 'flags'>,
  name: string,
  nameTa: string | null,
): { primary: string; secondary: string | null } {
  if (!nameTa || nameTa === name) return { primary: name, secondary: null }
  const taFirst = model.locale.primary === 'ta'
  return {
    primary: taFirst ? nameTa : name,
    secondary: model.flags.bilingual ? (taFirst ? name : nameTa) : null,
  }
}

export const money = (paise: number): string => formatINR(paise)

/** Phones print the way shops write them: '+919876543210' → '98765 43210'. */
export const phoneText = (phone: string): string => formatPhoneDisplay(phone)
export const moneyPlain = (paise: number): string => formatINR(paise, { symbol: false })

export function date(value: string | null | undefined): string {
  if (!value) return ''
  return isDateStr(value) ? formatDateDisplay(value) : value
}

/** 1800 → '18%', 250 → '2.5%', 12.5 → '0.125%'. */
export function pct(bp: number): string {
  const v = bp / 100
  return `${Number.isInteger(v) ? v : Number(v.toFixed(3))}%`
}
