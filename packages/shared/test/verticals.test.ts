import { describe, expect, it } from 'vitest'
import { BusinessTypeSchema } from '../src/enums'
import { isValidGstRate, isValidHsn } from '../src/gst'
import { TaxSlabsSchema } from '../src/pricing'
import { isUnitCode } from '../src/units'
import {
  BUSINESS_TYPES,
  VERTICAL_PRESETS,
  attributesSchemaFor,
  defaultMccFor,
  flattenCategoryPresets,
  getBusinessType,
  validateAttributes,
  type CategoryPreset,
} from '../src/verticals'

const TAMIL = /[஀-௿]/

describe('business types', () => {
  it('covers every SQL business type with Tamil names', () => {
    expect(BUSINESS_TYPES.map((b) => b.code)).toEqual([...BusinessTypeSchema.options])
    for (const b of BUSINESS_TYPES) {
      expect(b.name_ta).toMatch(TAMIL)
      expect(b.description_ta).toMatch(TAMIL)
      expect(b.upi_mcc).toMatch(/^\d{4}$/)
    }
    expect(getBusinessType('pharmacy').name_ta).toBe('மருந்தகம்')
    expect(defaultMccFor('pharmacy')).toBe('5912')
    expect(defaultMccFor('general_store')).toBe('5411')
  })
})

describe('attribute schemas', () => {
  it('pharmacy: schedule defaults to OTC and is validated', () => {
    const ok = validateAttributes('pharmacy', {
      generic_name: 'Paracetamol',
      composition: 'Paracetamol 650mg',
      schedule: 'H',
    })
    expect(ok.success && ok.data.schedule).toBe('H')
    const def = validateAttributes('pharmacy', {})
    expect(def.success && def.data.schedule).toBe('OTC')
    expect(validateAttributes('pharmacy', { schedule: 'Y' }).success).toBe(false)
    expect(validateAttributes('pharmacy', { storage: 'freezer' }).success).toBe(false)
  })
  it('apparel / footwear / electronics / grocery', () => {
    expect(
      validateAttributes('apparel', { fabric: 'Cotton', gender: 'women', occasion: 'Wedding' })
        .success,
    ).toBe(true)
    expect(validateAttributes('apparel', { gender: 'other' }).success).toBe(false)
    expect(validateAttributes('footwear', { closure: 'velcro', size_system: 'UK' }).success).toBe(
      true,
    )
    expect(
      validateAttributes('electronics', { warranty_months: 12, serial_tracked: true }).success,
    ).toBe(true)
    expect(validateAttributes('electronics', { warranty_months: -1 }).success).toBe(false)
    expect(
      validateAttributes('general_store', { veg: true, loose: true, shelf_life_days: 180 }).success,
    ).toBe(true)
    expect(validateAttributes('bakery_sweets', { veg: 'yes' }).success).toBe(false)
  })
  it('allows custom primitive attributes but not nested objects', () => {
    expect(
      validateAttributes('hardware', { finish: 'matt', thickness_mm: 2, rust_proof: true }).success,
    ).toBe(true)
    expect(validateAttributes('hardware', { nested: { a: 1 } }).success).toBe(false)
    expect(validateAttributes('other', undefined).success).toBe(true)
    expect(attributesSchemaFor('supermarket')).toBe(attributesSchemaFor('general_store'))
  })
})

function walk(
  categories: readonly CategoryPreset[],
  cb: (c: CategoryPreset, depth: number) => void,
  depth = 0,
): void {
  for (const c of categories) {
    cb(c, depth)
    if (c.children) walk(c.children, cb, depth + 1)
  }
}

describe('vertical presets', () => {
  it.each(BusinessTypeSchema.options)('%s preset data is valid', (type) => {
    const preset = VERTICAL_PRESETS[type]
    expect(preset.categories.length).toBeGreaterThan(0)
    const slabKeys = new Set(preset.tax_slab_rules.map((r) => r.key))
    for (const rule of preset.tax_slab_rules) {
      expect(TaxSlabsSchema.safeParse(rule.slabs).success).toBe(true)
      expect(rule.name_ta).toMatch(TAMIL)
    }
    const names: string[] = []
    walk(preset.categories, (c, depth) => {
      names.push(c.name)
      expect(depth).toBeLessThanOrEqual(1)
      expect(c.name_ta).toMatch(TAMIL)
      if (c.hsn_code !== undefined) expect(isValidHsn(c.hsn_code)).toBe(true)
      if (c.gst_rate_bp !== undefined) expect(isValidGstRate(c.gst_rate_bp)).toBe(true)
      if (c.tax_slab_rule !== undefined) expect(slabKeys.has(c.tax_slab_rule)).toBe(true)
      if (c.default_unit !== undefined) expect(isUnitCode(c.default_unit)).toBe(true)
    })
    // names are unique within a vertical so parent_name resolves unambiguously
    expect(new Set(names).size).toBe(names.length)
    for (const u of preset.suggested_units) expect(isUnitCode(u)).toBe(true)
  })

  it('contains the expected Tamil Nadu categories', () => {
    const tamilNames = (type: keyof typeof VERTICAL_PRESETS) => {
      const out: string[] = []
      walk(VERTICAL_PRESETS[type].categories, (c) => out.push(c.name_ta))
      return out
    }
    expect(tamilNames('general_store')).toEqual(
      expect.arrayContaining([
        'அரிசி',
        'பருப்பு வகைகள்',
        'சமையல் எண்ணெய்',
        'மசாலா பொருட்கள்',
        'சர்க்கரை & வெல்லம்',
        'டீ & காபி',
        'பிஸ்கட் & தின்பண்டங்கள்',
        'சோப்பு & ஷாம்பு',
        'வீட்டு சுத்தம்',
        'பால் பொருட்கள்',
        'பூஜை பொருட்கள்',
      ]),
    )
    expect(tamilNames('apparel')).toEqual(
      expect.arrayContaining([
        'புடவைகள்',
        'வேட்டி & லுங்கி',
        'ஆண்கள் ஆடைகள்',
        'பெண்கள் ஆடைகள்',
        'குழந்தைகள் ஆடைகள்',
        'உள்ளாடைகள்',
        'துணி (மீட்டர்)',
      ]),
    )
    expect(tamilNames('pharmacy')).toEqual(
      expect.arrayContaining([
        'மருந்துகள்',
        'சர்ஜிகல் பொருட்கள்',
        'OTC & நலவாழ்வு',
        'குழந்தை பராமரிப்பு',
        'சித்தா & ஆயுர்வேதம்',
      ]),
    )
    expect(tamilNames('supermarket')).toEqual(
      expect.arrayContaining(['அரிசி', 'காய்கறிகள்', 'பழங்கள்', 'உறைந்த உணவுகள்', 'பேக்கரி']),
    )
  })

  it('apparel and footwear use the ₹2,500 price-slab rule', () => {
    for (const type of ['apparel', 'footwear'] as const) {
      const rule = VERTICAL_PRESETS[type].tax_slab_rules[0]!
      expect(rule.slabs).toEqual([
        { max_unit_value_paise: 250000, gst_rate_bp: 500 },
        { max_unit_value_paise: null, gst_rate_bp: 1800 },
      ])
    }
  })

  it('flattenCategoryPresets lists parents before children', () => {
    const flat = flattenCategoryPresets(VERTICAL_PRESETS.general_store.categories)
    const index = new Map(flat.map((c, i) => [c.name, i]))
    for (const c of flat) {
      expect(c).not.toHaveProperty('children')
      if (c.parent_name !== null) expect(index.get(c.parent_name)!).toBeLessThan(index.get(c.name)!)
    }
    expect(flat[0]).toMatchObject({ name: 'Rice', parent_name: null, sort_order: 10 })
    expect(flat[1]).toMatchObject({ name: 'Ponni rice', parent_name: 'Rice', sort_order: 10 })
  })
})
