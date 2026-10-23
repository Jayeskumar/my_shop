/**
 * Helpers of the GST returns screen: default tax period, section maths over the GSTR-1 report and
 * the form layout of GSTR-3B (row keys → labels live in reports:gstr3b.*).
 */
import type {
  Gstr1Report,
  Gstr1Section,
  GstWarning,
  TaxHeads,
  TaxRow,
} from '@kadai/shared/api/reports'
import { addPeriods, periodOf } from '@kadai/shared/fy'
import { getState } from '@kadai/shared/gst'
import type { Language } from '@/lib/i18n'
import type { ReportCalendar } from './calendar'

/** The current month (YYYY-MM) in the tenant timezone. */
export function periodOfToday(cal: ReportCalendar): string {
  return periodOf(cal.today)
}

/**
 * Default period to file: last month (returns are filed for the previous month — GSTR-1 by the
 * 11th, GSTR-3B by the 20th).
 */
export function defaultGstPeriod(cal: ReportCalendar): string {
  return addPeriods(periodOfToday(cal), -1)
}

export const ZERO_TAX_ROW: TaxRow = {
  taxable_paise: 0,
  igst_paise: 0,
  cgst_paise: 0,
  sgst_paise: 0,
  cess_paise: 0,
}

export function taxOf(row: TaxHeads): number {
  return row.igst_paise + row.cgst_paise + row.sgst_paise + row.cess_paise
}

/** Section cards in the order of the GSTR-1 form (HSN B2B + B2C shown as one card). */
export const GSTR1_CARD_SECTIONS: readonly Gstr1Section[] = [
  'b2b',
  'b2cl',
  'b2cs',
  'cdnr',
  'cdnur',
  'nil',
  'hsn_b2b',
  'hsn_b2c',
  'doc_issue',
]

export function sectionSummary(report: Gstr1Report, section: Gstr1Section) {
  return report.summary.find((s) => s.section === section) ?? null
}

/** Warnings grouped for the panel: errors first, then by section. */
export function sortWarnings(warnings: readonly GstWarning[]): GstWarning[] {
  return [...warnings].sort((a, b) =>
    a.severity === b.severity
      ? (a.section ?? '').localeCompare(b.section ?? '')
      : a.severity === 'error'
        ? -1
        : 1,
  )
}

/** Sections that carry at least one warning (badge on the section card). */
export function warningCountBySection(warnings: readonly GstWarning[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const w of warnings) {
    if (!w.section) continue
    out.set(w.section, (out.get(w.section) ?? 0) + 1)
  }
  return out
}

/** Interpolation values of a warning text (reports:gst_warnings.<code>). */
export function warningParams(w: GstWarning): Record<string, string | number> {
  const out: Record<string, string | number> = { label: w.label ?? '' }
  for (const [k, v] of Object.entries(w.details)) {
    if (v === null) continue
    out[k] = k.endsWith('_bp') && typeof v === 'number' ? `${v / 100}%` : v
  }
  return out
}

/** Place of supply: '33' → "33 · Tamil Nadu" / "33 · தமிழ்நாடு". */
export function posLabel(code: string, lng: Language): string {
  const state = getState(code)
  if (!state) return code
  return `${code} · ${lng === 'ta' ? state.name_ta : state.name_en}`
}

/** Σ taxable and tax heads of rate items (invoice / note rows of the drill-down). */
export function sumItems(items: readonly TaxRow[]): TaxRow {
  return items.reduce(
    (acc, it) => ({
      taxable_paise: acc.taxable_paise + it.taxable_paise,
      igst_paise: acc.igst_paise + it.igst_paise,
      cgst_paise: acc.cgst_paise + it.cgst_paise,
      sgst_paise: acc.sgst_paise + it.sgst_paise,
      cess_paise: acc.cess_paise + it.cess_paise,
    }),
    ZERO_TAX_ROW,
  )
}

/** "5%, 18%" — the GST rates of a document. */
export function ratesText(items: readonly { rate_bp: number }[]): string {
  return [...new Set(items.map((i) => i.rate_bp))]
    .sort((a, b) => a - b)
    .map((bp) => `${bp / 100}%`)
    .join(', ')
}
