import { describe, expect, it } from 'vitest'
import {
  UNIT_CODES,
  UNITS,
  amountForQty,
  formatPacksAndLoose,
  formatQty,
  getUnit,
  isDecimalUnit,
  isUnitCode,
  milliToDecimalString,
  packsAndLoose,
  parseQty,
  tryParseQty,
  unitPriceFromPack,
  uqcFor,
} from '../src/units'

describe('UNITS catalogue', () => {
  it('contains every required unit with its GST UQC', () => {
    const expected: Record<string, string> = {
      PCS: 'NOS', KG: 'KGS', G: 'GMS', QTL: 'QTL', L: 'LTR', ML: 'MLT', M: 'MTR', CM: 'CMS',
      SQFT: 'SQF', BOX: 'BOX', PACK: 'PAC', DOZ: 'DOZ', PAIR: 'PRS', SET: 'SET', STRIP: 'OTH',
      TAB: 'TBS', CAP: 'OTH', BTL: 'BTL', CAN: 'CAN', BAG: 'BAG', ROLL: 'ROL', BUNDLE: 'BDL',
      PKT: 'PAC', NOS: 'NOS', TUBE: 'TUB', VIAL: 'OTH', SACHET: 'OTH',
    }
    expect(Object.fromEntries(UNITS.map((u) => [u.code, u.uqc]))).toEqual(expected)
    expect(new Set(UNIT_CODES).size).toBe(UNITS.length)
  })
  it('has Tamil names and labels for every unit', () => {
    for (const unit of UNITS) {
      expect(unit.name_ta).toMatch(/[஀-௿]/)
      expect(unit.symbol_ta.length).toBeGreaterThan(0)
      expect(unit.code).toMatch(/^[A-Z]+$/)
    }
  })
  it('flags measured units as decimal', () => {
    expect(UNITS.filter((u) => u.decimal_allowed).map((u) => u.code)).toEqual([
      'KG', 'G', 'QTL', 'L', 'ML', 'M', 'CM', 'SQFT',
    ])
    expect(isDecimalUnit('kg')).toBe(true)
    expect(isDecimalUnit('PCS')).toBe(false)
    expect(isDecimalUnit('UNKNOWN')).toBe(false)
  })
  it('lookups', () => {
    expect(getUnit('kg')?.name_en).toBe('Kilogram')
    expect(getUnit('XYZ')).toBeUndefined()
    expect(isUnitCode('Strip')).toBe(true)
    expect(uqcFor('TAB')).toBe('TBS')
    expect(uqcFor('XYZ')).toBe('OTH')
  })
})

describe('parseQty', () => {
  it.each<[string, string, number]>([
    ['1.5', 'KG', 1500],
    ['0.25', 'KG', 250],
    ['.5', 'L', 500],
    ['2', 'PCS', 2000],
    ['2.000', 'PCS', 2000],
    ['  3 ', 'TAB', 3000],
    ['0.001', 'KG', 1],
    ['1250', 'G', 1250000],
    ['12.75', 'M', 12750],
  ])('parseQty(%j, %s) = %d', (input, unit, expected) => {
    expect(parseQty(input, unit)).toBe(expected)
  })
  it.each<[string, string]>([
    ['0', 'KG'],
    ['0.000', 'KG'],
    ['-1', 'KG'],
    ['1.2345', 'KG'],
    ['1.5', 'PCS'],
    ['abc', 'KG'],
    ['', 'KG'],
    ['.', 'KG'],
    ['1,000', 'KG'],
    ['1e3', 'KG'],
    ['99999999999999', 'KG'],
  ])('rejects parseQty(%j, %s)', (input, unit) => {
    expect(tryParseQty(input, unit)).toBeNull()
    expect(() => parseQty(input, unit)).toThrow(RangeError)
  })
  it('honours the allowDecimal override', () => {
    expect(parseQty('1.5', 'PCS', { allowDecimal: true })).toBe(1500)
    expect(tryParseQty('1.5', 'KG', { allowDecimal: false })).toBeNull()
  })
})

describe('formatQty', () => {
  it.each<[number, string, 'en' | 'ta', string]>([
    [1500, 'KG', 'en', '1.5 kg'],
    [250, 'KG', 'en', '0.25 kg'],
    [2000, 'PCS', 'en', '2 pcs'],
    [1000, 'PCS', 'en', '1 pc'],
    [3000, 'TAB', 'en', '3 tabs'],
    [1000, 'STRIP', 'en', '1 strip'],
    [1234567000, 'PCS', 'en', '12,34,567 pcs'],
    [1500, 'KG', 'ta', '1.5 கிலோ'],
    [2000, 'PCS', 'ta', '2 எண்'],
    [2000, 'XYZ', 'en', '2 XYZ'],
    [-500, 'L', 'en', '-0.5 L'],
  ])('formatQty(%d, %s, %s) = %s', (milli, unit, locale, expected) => {
    expect(formatQty(milli, unit, locale)).toBe(expected)
  })
  it('milliToDecimalString', () => {
    expect(milliToDecimalString(1)).toBe('0.001')
    expect(milliToDecimalString(1010)).toBe('1.01')
    expect(milliToDecimalString(1000000, true)).toBe('1,000')
  })
})

describe('amountForQty (pack pricing)', () => {
  it.each([
    // [price per pack, qty_milli, pack size, expected]
    [5000, 1000, 1, 5000], // 1 pc at ₹50
    [5000, 2500, 1, 12500], // 2.5 kg at ₹50/kg
    [6000, 1250, 1, 7500], // 1.25 kg at ₹60
    [4999, 333, 1, 1665], // 0.333 kg at ₹49.99 = 16.6467 → 16.65
    [3500, 3000, 10, 1050], // 3 tablets from a ₹35 strip of 10
    [3500, 10000, 10, 3500], // full strip
    [3333, 1000, 10, 333], // 1 tablet from ₹33.33 strip → 3.333 → 3.33
    [3335, 1000, 10, 334], // 3.335 → 3.34 (half away from zero)
    [0, 1000, 1, 0],
    [10_000_000_000, 900_000_000, 1, 9_000_000_000_000_000], // BigInt path
  ])('amountForQty(%d, %d, %d) = %d', (price, qty, pack, expected) => {
    expect(amountForQty(price, qty, pack)).toBe(expected)
  })
  it('validates pack size and integers', () => {
    expect(() => amountForQty(100, 1000, 0)).toThrow(RangeError)
    expect(() => amountForQty(100.5, 1000, 1)).toThrow(RangeError)
    expect(() => amountForQty(100, 1000, 1.5)).toThrow(RangeError)
  })
  it('unitPriceFromPack', () => {
    expect(unitPriceFromPack(3500, 10)).toBe(350)
    expect(unitPriceFromPack(999, 1)).toBe(999)
  })
})

describe('packsAndLoose', () => {
  it.each([
    [23000, 10, 2, 3000],
    [20000, 10, 2, 0],
    [3000, 10, 0, 3000],
    [0, 10, 0, 0],
    [1500, 1, 1, 500],
    [-23000, 10, -2, -3000],
  ])('packsAndLoose(%d, %d) = {%d, %d}', (qty, pack, packs, loose) => {
    expect(packsAndLoose(qty, pack)).toEqual({ packs, loose_milli: loose })
  })
  it.each<[number, number, string, string, string]>([
    [23000, 10, 'TAB', 'STRIP', '2 strips + 3 tabs'],
    [20000, 10, 'TAB', 'STRIP', '2 strips'],
    [11000, 10, 'TAB', 'STRIP', '1 strip + 1 tab'],
    [3000, 10, 'TAB', 'STRIP', '3 tabs'],
    [5000, 1, 'PCS', 'PACK', '5 pcs'],
  ])('formatPacksAndLoose(%d, %d, %s, %s) = %s', (qty, pack, unit, packUnit, expected) => {
    expect(formatPacksAndLoose(qty, pack, unit, packUnit)).toBe(expected)
  })
  it('formats in Tamil', () => {
    expect(formatPacksAndLoose(23000, 10, 'TAB', 'STRIP', 'ta')).toBe('2 அட்டை + 3 மாத்திரை')
  })
})
