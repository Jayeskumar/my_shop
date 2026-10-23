/** GST states for selects and labels (Tamil Nadu and Puducherry first). */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ACTIVE_STATE_CODES, getState, type IndianState } from '@kadai/shared/gst'
import type { SelectOption } from '@/components/ui'
import { getLanguage } from '@/lib/i18n'

const FIRST_STATES = ['33', '34'] // Tamil Nadu, Puducherry

/** State options in the UI language, Tamil Nadu and Puducherry first. */
export function useStateOptions(): SelectOption[] {
  const { i18n } = useTranslation()
  return useMemo(() => {
    const ta = i18n.language === 'ta'
    const states = ACTIVE_STATE_CODES.map((code) => getState(code)).filter((s): s is IndianState =>
      Boolean(s),
    )
    const name = (s: IndianState) => (ta ? s.name_ta : s.name_en)
    const first = FIRST_STATES.map((c) => states.find((s) => s.code === c)).filter(
      (s): s is IndianState => Boolean(s),
    )
    const rest = states
      .filter((s) => !FIRST_STATES.includes(s.code))
      .sort((a, b) => name(a).localeCompare(name(b), ta ? 'ta' : 'en'))
    return [...first, ...rest].map((s) => ({ value: s.code, label: `${name(s)} (${s.code})` }))
  }, [i18n.language])
}

/** Localized state name for a GST state code. */
export function stateName(code: string | null | undefined): string {
  if (!code) return ''
  const s = getState(code)
  if (!s) return code
  return getLanguage() === 'ta' ? s.name_ta : s.name_en
}
