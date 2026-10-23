/**
 * Display helpers of the catalog screens (pure; data stays in paise / milli / bp).
 */
import type { BilingualLabel } from '@kadai/shared/api/common'
import type { BusinessType } from '@kadai/shared/enums'
import { GST_RATES_BP } from '@kadai/shared/gst'
import { formatBp } from '@kadai/shared/money'
import { getUnit } from '@kadai/shared/units'
import { formatMoney } from '@/lib/format'
import { getLanguage, type Language } from '@/lib/i18n'

/** GST rate Select options ('1800' → '18%'); values are bp as strings. */
export function gstRateOptions(): { value: string; label: string }[] {
  return GST_RATES_BP.map((bp) => ({ value: String(bp), label: formatBp(bp) }))
}

/** '18%' or '—'. */
export function gstLabel(bp: number | null | undefined): string {
  return bp === null || bp === undefined ? '—' : formatBp(bp)
}

/** Bilingual label in the UI language. */
export function bilingual(label: BilingualLabel, lng: Language = getLanguage()): string {
  return lng === 'ta' ? label.ta : label.en
}

/** Unit name in the UI language: 'Kilogram' / 'கிலோகிராம்' (the code when unknown). */
export function unitName(code: string, lng: Language = getLanguage()): string {
  const unit = getUnit(code)
  if (!unit) return code
  return lng === 'ta' ? unit.name_ta : unit.name_en
}

/** Pack word of stock quantities: strips for a pharmacy's tablets / capsules, else packs. */
export function packUnitFor(businessType: BusinessType | null | undefined, unit: string): string {
  return businessType === 'pharmacy' && (unit === 'TAB' || unit === 'CAP') ? 'STRIP' : 'PACK'
}

/** Unit name inside a sentence: lower case in English ('Sell loose tablets'), as is in Tamil. */
export function unitNameInline(code: string, lng: Language = getLanguage()): string {
  const name = unitName(code, lng)
  return lng === 'en' ? name.toLowerCase() : name
}

/** Unit word after a count: 'tab' / 'tabs', 'pc' / 'pcs' in English; the Tamil name in Tamil. */
export function unitCountWord(code: string, count: number, lng: Language = getLanguage()): string {
  const unit = getUnit(code)
  if (!unit) return code.toLowerCase()
  if (lng === 'ta') return unit.name_ta
  return count === 1 ? unit.symbol_en : unit.symbol_en_plural
}

/** Short unit symbol: 'kg' / 'கிலோ', singular. */
export function unitSymbol(code: string, lng: Language = getLanguage()): string {
  const unit = getUnit(code)
  if (!unit) return code.toLowerCase()
  return lng === 'ta' ? unit.symbol_ta : unit.symbol_en
}

/**
 * Human slab summary in rupees: "Up to ₹2,500 → 5% · Above → 18%". The words come from the
 * caller (translated), the numbers are formatted here.
 */
export function slabSummary(
  slabs: readonly { max_unit_value_paise: number | null; gst_rate_bp: number }[],
  words: { upTo: (amount: string) => string; above: (amount: string) => string },
): string {
  return slabs
    .map((s, i) => {
      if (s.max_unit_value_paise !== null)
        return `${words.upTo(formatMoney(s.max_unit_value_paise, { decimals: 'auto' }))} → ${formatBp(s.gst_rate_bp)}`
      const prev = slabs[i - 1]?.max_unit_value_paise
      return `${words.above(prev == null ? '₹0' : formatMoney(prev, { decimals: 'auto' }))} → ${formatBp(s.gst_rate_bp)}`
    })
    .join(' · ')
}

/** Case-insensitive "contains every word" match used by the client-side filters. */
export function matchesSearch(query: string, ...fields: Array<string | null | undefined>): boolean {
  const haystack = fields.filter(Boolean).join(' ').toLocaleLowerCase()
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => haystack.includes(w))
}
