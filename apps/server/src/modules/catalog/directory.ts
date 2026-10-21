/**
 * Reference directories: GET /units (shared UNITS + the vertical's suggested units) and
 * GET /hsn/search (bundled curated HSN / SAC list with suggested GST rates — data/hsn.json; rates
 * must be verified against current notifications, see the file's _note).
 */
import { UNITS, VERTICAL_PRESETS, type BusinessType } from '@kadai/shared'
import { type HsnEntry, HsnEntrySchema, type UnitsResponse } from '@kadai/shared/api/catalog'
import { z } from 'zod'
import hsnData from './data/hsn.json' with { type: 'json' }
import { searchTokens } from './shared'

const HsnFileSchema = z.object({ _note: z.string(), entries: z.array(HsnEntrySchema) })

/** The curated HSN list, validated once at module load. */
export const HSN_ENTRIES: readonly HsnEntry[] = Object.freeze(HsnFileSchema.parse(hsnData).entries)

const SEARCH_TEXT: readonly string[] = HSN_ENTRIES.map((e) =>
  `${e.description} ${e.group ?? ''}`.toLowerCase(),
)

export function unitsFor(businessType: BusinessType): UnitsResponse {
  return {
    units: UNITS.map((u) => ({
      code: u.code,
      name_en: u.name_en,
      name_ta: u.name_ta,
      uqc: u.uqc,
      decimal_allowed: u.decimal_allowed,
      family: u.family,
      symbol_en: u.symbol_en,
      symbol_en_plural: u.symbol_en_plural,
      symbol_ta: u.symbol_ta,
    })),
    suggested: [...VERTICAL_PRESETS[businessType].suggested_units],
  }
}

/**
 * Code prefix search ('1006', '61') ranks the exact code, then shorter (more general) codes; word
 * search ('rice', 'cotton saree') needs every word, ranking word-start matches first.
 */
export function searchHsn(q: string, limit: number): HsnEntry[] {
  const query = q.trim().toLowerCase()
  if (/^\d+$/.test(query)) {
    return HSN_ENTRIES.map((e, i) => ({ e, i }))
      .filter(({ e }) => e.code.startsWith(query))
      .sort(
        (a, b) =>
          Number(b.e.code === query) - Number(a.e.code === query) ||
          a.e.code.length - b.e.code.length ||
          a.e.code.localeCompare(b.e.code) ||
          a.i - b.i,
      )
      .slice(0, limit)
      .map(({ e }) => e)
  }
  const tokens = searchTokens(query)
  if (tokens.length === 0) return []
  const scored: Array<{ e: HsnEntry; score: number; i: number }> = []
  HSN_ENTRIES.forEach((e, i) => {
    const text = SEARCH_TEXT[i]!
    if (!tokens.every((t) => text.includes(t))) return
    let score = 0
    for (const t of tokens) {
      if (text.startsWith(t)) score += 3
      else if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(t)}`, 'u').test(text)) score += 2
      else score += 1
    }
    scored.push({ e, score, i })
  })
  return scored
    .sort((a, b) => b.score - a.score || a.e.code.localeCompare(b.e.code) || a.i - b.i)
    .slice(0, limit)
    .map(({ e }) => e)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
