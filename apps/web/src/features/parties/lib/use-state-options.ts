/** GST state options for selects: Tamil Nadu first, then the other active states. */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ACTIVE_STATE_CODES, getState, TAMIL_NADU_STATE_CODE } from '@kadai/shared/gst'
import { langOf } from './labels'

export function useStateOptions(): { value: string; label: string }[] {
  const { i18n } = useTranslation()
  const lang = langOf(i18n.language)
  return useMemo(() => {
    const codes = [
      TAMIL_NADU_STATE_CODE,
      ...ACTIVE_STATE_CODES.filter((c) => c !== TAMIL_NADU_STATE_CODE),
    ]
    return codes.flatMap((code) => {
      const st = getState(code)
      if (!st) return []
      return [{ value: code, label: lang === 'ta' ? `${st.name_ta} · ${st.name_en}` : st.name_en }]
    })
  }, [lang])
}
