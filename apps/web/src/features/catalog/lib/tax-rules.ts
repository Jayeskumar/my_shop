/** Price-slab GST rule editor model: drafts → contract body, validation keys, example prices. */
import { type TaxSlabRuleCreate, TaxSlabRuleCreateSchema } from '@kadai/shared/api/catalog'
import type { GstRateBp } from '@kadai/shared/gst'
import type { TaxSlab } from '@kadai/shared/pricing'

export interface SlabDraft {
  max: number | null
  rate: number | null
}

export interface RuleDraft {
  name: string
  description: string
  is_active: boolean
  slabs: SlabDraft[]
}

const SHARED_MESSAGES: Record<string, string> = {
  'slabs must be in ascending order': 'slab_ascending',
  'only the last slab may be open-ended': 'slab_open_end',
}

export function ruleBody(d: RuleDraft): TaxSlabRuleCreate {
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    is_active: d.is_active,
    slabs: d.slabs.map((s, i) => ({
      max_unit_value_paise: i === d.slabs.length - 1 ? null : (s.max ?? 0),
      gst_rate_bp: (s.rate ?? 0) as GstRateBp,
    })),
  }
}

/** Validation of a rule draft → { path: message key } (first issue per path). */
export function ruleIssues(d: RuleDraft): Record<string, string> {
  const out: Record<string, string> = {}
  d.slabs.forEach((s, i) => {
    if (s.rate === null) out[`slabs.${i}.gst_rate_bp`] = 'slab_rate_required'
    if (i < d.slabs.length - 1 && s.max === null)
      out[`slabs.${i}.max_unit_value_paise`] = 'slab_max_required'
  })
  const parsed = TaxSlabRuleCreateSchema.safeParse(ruleBody(d))
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.') || 'slabs'
      out[path] ??= SHARED_MESSAGES[issue.message] ?? issue.message
    }
  return out
}

/** Example prices around each slab limit for the calculator. */
export function examplePrices(slabs: readonly SlabDraft[]): number[] {
  const out = new Set<number>()
  for (const s of slabs.slice(0, -1)) {
    if (s.max === null || s.max <= 0) continue
    out.add(Math.max(100, s.max - 10_000 - (s.max % 10_000)))
    out.add(s.max + 30_000)
  }
  return [...out].sort((a, b) => a - b).slice(0, 6)
}

export function toSlabs(d: RuleDraft): TaxSlab[] {
  return ruleBody(d).slabs as TaxSlab[]
}
