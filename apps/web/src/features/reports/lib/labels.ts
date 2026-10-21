/**
 * Bilingual labels of the reports contract (`{ en, ta }` column / filter / section labels) and the
 * UI-language hook the report screens re-render with.
 */
import type { BilingualLabel } from '@kadai/shared/api/common'
import type { ReportKey } from '@kadai/shared/api/reports'
import { useTranslation } from 'react-i18next'
import { getLanguage, isLanguage, localizedName, type Language } from '@/lib/i18n'

/** The label in the UI language (English when a Tamil text is missing). */
export function pick(
  label: BilingualLabel | null | undefined,
  lng: Language = getLanguage(),
): string {
  if (!label) return ''
  return lng === 'ta' ? label.ta || label.en : label.en
}

/** Current UI language; components using it re-render when the language changes. */
export function useLang(): Language {
  const { i18n } = useTranslation()
  const lng = i18n.resolvedLanguage ?? i18n.language
  return isLanguage(lng) ? lng : 'ta'
}

/** Master-data name in the UI language (Tamil name in the Tamil UI when there is one). */
export function nameOf(name: string, nameTa: string | null | undefined): string {
  return localizedName(name, nameTa)
}

type Snake<S extends string> = S extends `${infer A}-${infer B}` ? `${A}_${Snake<B>}` : S

/** 'sales-summary' → 'sales_summary' (the i18n key of `reports:titles.*` / `reports:descriptions.*`). */
export function snakeKey<K extends ReportKey>(key: K): Snake<K> {
  return key.replaceAll('-', '_') as Snake<K>
}
