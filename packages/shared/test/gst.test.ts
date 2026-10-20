import { describe, expect, it } from 'vitest'
import {
  ACTIVE_STATE_CODES,
  GST_RATES_BP,
  INDIAN_STATES,
  STATE_CODES,
  getState,
  gstinCheckChar,
  isInterstate,
  isRegularGstin,
  isValidGstRate,
  isValidGstin,
  isValidHsn,
  isValidPan,
  isValidStateCode,
  makeGstin,
  normalizeGstin,
  panFromGstin,
  splitGst,
  stateCodeFromGstin,
  stateTaxLabel,
} from '../src/gst'
import { createRng } from './helpers/prng'

describe('GST rates', () => {
  it('lists the allowed rates in ascending order', () => {
    expect(GST_RATES_BP).toEqual([0, 10, 25, 100, 150, 300, 500, 600, 750, 1200, 1800, 2800, 4000])
  })
  it.each([
    [0, true], [500, true], [1800, true], [4000, true], [1200, true], [10, true],
    [1000, false], [-500, false], [500.5, false], ['500', false], [null, false],
  ])('isValidGstRate(%j) = %s', (bp, expected) => {
    expect(isValidGstRate(bp)).toBe(expected)
  })
})

describe('states', () => {
  it('has every GST state code from 01 to 38 plus 97 and 99, with Tamil names', () => {
    const expected = [
      ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
      '97',
      '99',
    ]
    expect(STATE_CODES).toEqual(expected)
    for (const st of INDIAN_STATES) {
      expect(st.name_ta).toMatch(/[஀-௿]/)
      expect(st.alpha).toMatch(/^[A-Z]{2}$/)
    }
    expect(new Set(INDIAN_STATES.map((s) => s.alpha)).size).toBe(INDIAN_STATES.length)
  })
  it('knows Tamil Nadu and Puducherry', () => {
    expect(getState('33')).toMatchObject({ name_en: 'Tamil Nadu', name_ta: 'தமிழ்நாடு', alpha: 'TN' })
    expect(getState('34')).toMatchObject({ name_en: 'Puducherry', name_ta: 'புதுச்சேரி', kind: 'union_territory' })
  })
  it('excludes legacy codes from active codes', () => {
    expect(ACTIVE_STATE_CODES).not.toContain('25')
    expect(ACTIVE_STATE_CODES).not.toContain('28')
    expect(ACTIVE_STATE_CODES).toContain('37')
    expect(isValidStateCode('28')).toBe(true)
    expect(isValidStateCode('39')).toBe(false)
    expect(isValidStateCode('3')).toBe(false)
  })
  it('labels UTGST for union territories without legislature', () => {
    expect(stateTaxLabel('33')).toBe('SGST')
    expect(stateTaxLabel('34')).toBe('SGST') // Puducherry has a legislature
    expect(stateTaxLabel('07')).toBe('SGST')
    expect(stateTaxLabel('04')).toBe('UTGST')
    expect(stateTaxLabel('38')).toBe('UTGST')
    expect(stateTaxLabel('35')).toBe('UTGST')
  })
})

describe('GSTIN', () => {
  it('validates known real GSTINs', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true)
    expect(isValidGstin('29AAGCB7383J1Z4')).toBe(true)
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V')
    expect(isRegularGstin('27AAPFU0939F1ZV')).toBe(true)
  })
  it.each([
    ['27AAPFU0939F1ZW', 'wrong check char'],
    ['27aapfu0939f1zv', 'lower case (normalise first)'],
    ['40AAPFU0939F1ZV', 'unknown state'],
    ['27AAPFU0939F0ZV', 'entity number 0'],
    ['27AAPFU0939F1Z', 'too short'],
    ['27AAPFU0939F1ZVX', 'too long'],
    ['27AAPFU 939F1ZV', 'space'],
    ['', 'empty'],
  ])('rejects %s (%s)', (gstin) => {
    expect(isValidGstin(gstin)).toBe(false)
    expect(stateCodeFromGstin(gstin)).toBeNull()
  })
  it('normalises input', () => {
    expect(isValidGstin(normalizeGstin('  27aapfu0939f1zv '))).toBe(true)
  })
  it('extracts state and PAN', () => {
    expect(stateCodeFromGstin('27AAPFU0939F1ZV')).toBe('27')
    expect(panFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F')
  })
  it('round-trips generated GSTINs and catches every single-character substitution', () => {
    const rng = createRng(33)
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const charset = '0123456789' + letters
    for (let i = 0; i < 300; i++) {
      const state = rng.pick(ACTIVE_STATE_CODES)
      const pan =
        Array.from({ length: 3 }, () => rng.pick([...letters])).join('') +
        rng.pick([...'ABCFGHLJPT']) +
        rng.pick([...letters]) +
        String(rng.int(0, 9999)).padStart(4, '0') +
        rng.pick([...letters])
      const gstin = makeGstin(state, pan, rng.pick([...'123456789ABC']))
      expect(isValidGstin(gstin)).toBe(true)
      expect(isRegularGstin(gstin)).toBe(true)
      expect(panFromGstin(gstin)).toBe(pan)
      expect(stateCodeFromGstin(gstin)).toBe(state)
      // Luhn mod 36 detects all single-character errors.
      const pos = rng.int(2, 13)
      const original = gstin.charAt(pos)
      const replacement = rng.pick([...charset].filter((c) => c !== original))
      const corrupted = gstin.slice(0, pos) + replacement + gstin.slice(pos + 1)
      expect(gstinCheckChar(corrupted.slice(0, 14))).not.toBe(gstin.charAt(14))
    }
  })
  it('gstinCheckChar validates its input', () => {
    expect(() => gstinCheckChar('27AAPFU0939F1')).toThrow(RangeError)
    expect(() => gstinCheckChar('27AAPFU0939F1-')).toThrow(RangeError)
  })
})

describe('PAN / HSN', () => {
  it.each([
    ['AAPFU0939F', true],
    ['ABCPE1234F', true],
    ['ABCDE1234F', false], // D is not a holder type
    ['ABCP1234F', false],
    ['abcpe1234f', false],
    ['ABCPE12345', false],
  ])('isValidPan(%s) = %s', (pan, expected) => {
    expect(isValidPan(pan)).toBe(expected)
  })
  it.each([
    ['1006', true], ['100630', true], ['10063010', true], ['998599', true],
    ['100', false], ['10063', false], ['1006301', false], ['100A', false], ['', false], [1006, false],
  ])('isValidHsn(%j) = %s', (hsn, expected) => {
    expect(isValidHsn(hsn)).toBe(expected)
  })
})

describe('inter-state and split', () => {
  it('isInterstate', () => {
    expect(isInterstate('33', '33')).toBe(false)
    expect(isInterstate('33', '34')).toBe(true)
  })
  it.each([
    [0, 0, 0], [1, 1, 0], [2, 1, 1], [3, 2, 1], [1801, 901, 900], [-3, -1, -2],
  ])('splitGst(%d) = cgst %d + sgst %d', (gst, cgst, sgst) => {
    expect(splitGst(gst)).toEqual({ cgst_paise: cgst, sgst_paise: sgst })
  })
})
