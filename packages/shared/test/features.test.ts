import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAN_FEATURES,
  DEFAULT_PLAN_LIMITS,
  EntitlementsSchema,
  FEATURES,
  FEATURE_LABELS,
  LIMIT_LABELS,
  LIMIT_METRICS,
  ADDON_FEATURES,
  PLAN_CODES,
  featureLabels,
  hasFeature,
  isFeature,
  isWithinLimit,
} from '../src/features'
import { readMigrations } from './helpers/sql'

function sqlPlans(): Map<string, { features: string[]; limits: Record<string, number | null> }> {
  const sql = readMigrations()
  // Only the INSERT INTO plans statements (0001 cloud plans, 0010 on-prem editions).
  const insert = [...sql.matchAll(/INSERT INTO plans \([\s\S]*?\);[ \t]*\n/g)]
    .map((m) => m[0])
    .join('\n')
  const out = new Map<string, { features: string[]; limits: Record<string, number | null> }>()
  for (const m of insert.matchAll(/\('([a-z_]+)',[\s\S]*?'(\{[^']*\})',\s*ARRAY\[([^\]]*)\]/g)) {
    out.set(m[1]!, {
      limits: JSON.parse(m[2]!) as Record<string, number | null>,
      features: [...m[3]!.matchAll(/'([a-z_]+)'/g)].map((f) => f[1]!),
    })
  }
  return out
}

describe('features', () => {
  const plans = sqlPlans()
  it('parses every seeded plan (cloud + on-prem editions)', () => {
    expect([...plans.keys()]).toEqual([...PLAN_CODES])
  })
  it('FEATURES is exactly the plan feature codes plus the add-on features', () => {
    const used = new Set([...plans.values()].flatMap((p) => p.features))
    for (const addon of ADDON_FEATURES) {
      expect(used.has(addon), `${addon} must stay an add-on`).toBe(false)
      used.add(addon)
    }
    expect([...FEATURES].sort()).toEqual([...used].sort())
  })
  it.each(PLAN_CODES)('plan %s features and limits match the migration', (code) => {
    expect([...DEFAULT_PLAN_FEATURES[code]].sort()).toEqual([...plans.get(code)!.features].sort())
    expect(DEFAULT_PLAN_LIMITS[code]).toEqual(plans.get(code)!.limits)
  })
  it('has bilingual labels for every feature and limit', () => {
    for (const f of FEATURES) {
      expect(FEATURE_LABELS[f].en.length).toBeGreaterThan(0)
      expect(FEATURE_LABELS[f].ta).toMatch(/[஀-௿]/)
    }
    for (const l of LIMIT_METRICS) expect(LIMIT_LABELS[l].ta).toMatch(/[஀-௿]/)
    expect(featureLabels).toBe(FEATURE_LABELS)
  })
  it('helpers', () => {
    expect(isFeature('upi_dynamic')).toBe(true)
    expect(isFeature('teleport')).toBe(false)
    const ent = EntitlementsSchema.parse({
      plan_code: 'free',
      features: DEFAULT_PLAN_FEATURES.free,
      limits: DEFAULT_PLAN_LIMITS.free,
      source: 'plan',
    })
    expect(hasFeature(ent, 'pos')).toBe(true)
    expect(hasFeature(ent, 'purchases')).toBe(false)
    expect(isWithinLimit(ent.limits, 'invoices_per_month', 299)).toBe(true)
    expect(isWithinLimit(ent.limits, 'invoices_per_month', 300)).toBe(false)
    expect(isWithinLimit(DEFAULT_PLAN_LIMITS.growth, 'products', 1_000_000)).toBe(true)
    expect(EntitlementsSchema.safeParse({ ...ent, features: ['nope'] }).success).toBe(false)
  })
})
