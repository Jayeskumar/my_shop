/** Bilingual product names in the UI language (Tamil first when there is one). */
import { getUnit } from '@kadai/shared/units'
import { getLanguage } from '@/lib/i18n'
import type { PosProduct } from './types'

export function productNames(p: Pick<PosProduct, 'name' | 'name_ta'>): {
  primary: string
  secondary: string | null
} {
  if (!p.name_ta || p.name_ta === p.name) return { primary: p.name, secondary: null }
  return getLanguage() === 'ta'
    ? { primary: p.name_ta, secondary: p.name }
    : { primary: p.name, secondary: p.name_ta }
}

/** Short unit symbol in the UI language ("கிலோ" / "kg", "எண்" / "pcs"). */
export function unitSymbol(unit: string): string {
  const def = getUnit(unit)
  if (!def) return unit
  return getLanguage() === 'ta' ? def.symbol_ta : def.symbol_en_plural
}
