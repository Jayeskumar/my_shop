/**
 * Display helpers for party data: bilingual contract labels in the UI language, party names and
 * the "due / advance" reading of signed balances (customers: + = owes the shop; suppliers:
 * + = the shop owes them).
 */
import type { BilingualLabel } from '@kadai/shared/api/common'
import { getState } from '@kadai/shared/gst'
import type { Language } from '@/lib/i18n'

export function langOf(language: string | undefined): Language {
  return language === 'en' ? 'en' : 'ta'
}

/** `{ en, ta }` label in the given UI language. */
export function pickLabel(label: BilingualLabel, language: string | undefined): string {
  return label[langOf(language)]
}

/** Name in the UI language plus the other-language name as a secondary line (when different). */
export function partyNames(
  name: string,
  nameTa: string | null | undefined,
  language: string | undefined,
): { primary: string; secondary: string | null } {
  if (!nameTa || nameTa === name) return { primary: name, secondary: null }
  return langOf(language) === 'ta'
    ? { primary: nameTa, secondary: name }
    : { primary: name, secondary: nameTa }
}

export type BalanceSide = 'due' | 'advance' | 'settled'

/**
 * What a signed balance means for the shop: `due` = money to come in (customer) or go out
 * (supplier), `advance` = the opposite side, `settled` = zero.
 */
export function balanceSide(balancePaise: number): BalanceSide {
  if (balancePaise > 0) return 'due'
  if (balancePaise < 0) return 'advance'
  return 'settled'
}

/** State name in the UI language ('33' → 'தமிழ்நாடு' / 'Tamil Nadu'). */
export function stateName(code: string | null | undefined, language: string | undefined): string {
  if (!code) return ''
  const st = getState(code)
  if (!st) return code
  return langOf(language) === 'ta' ? st.name_ta : st.name_en
}

/** Address lines joined for display. */
export function formatAddress(
  address: {
    line1?: string | undefined
    line2?: string | undefined
    city?: string | undefined
    district?: string | undefined
    state_code?: string | undefined
    pincode?: string | undefined
  },
  language: string | undefined,
): string {
  const cityLine = [address.city, address.district].filter(Boolean).join(', ')
  const stateLine = [stateName(address.state_code, language), address.pincode]
    .filter(Boolean)
    .join(' – ')
  return [address.line1, address.line2, cityLine, stateLine].filter(Boolean).join(', ')
}

/** Hotkey scope of the parties pages (suspended while a dialog is open). */
export const PARTIES_HOTKEY_SCOPE = 'parties'
