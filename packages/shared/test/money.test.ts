import { describe, expect, it } from 'vitest'
import {
  applyBp,
  formatBp,
  formatINR,
  formatINRCompact,
  paiseToRupeesString,
  parseRupees,
  roundToRupee,
  sumPaise,
  tryParseRupees,
} from '../src/money'

describe('parseRupees', () => {
  it.each<[string | number, number]>([
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.50', 150],
    ['.5', 50],
    ['12.', 1200],
    ['99', 9900],
    ['₹ 99', 9900],
    ['₹99.99', 9999],
    ['Rs. 1,234.50', 123450],
    ['rs 10', 1000],
    ['INR 10', 1000],
    ['1,23,456.50', 12345650],
    ['12,34,56,789', 123456789_00],
    ['123,456.50', 12345650],
    ['1,234', 123400],
    ['  500/-  ', 50000],
    ['₹ 2,500/-', 250000],
    ['+5', 500],
    [12.5, 1250],
    [19.99, 1999],
    [0, 0],
    [1e6, 100000000],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('parseRupees(%j) = %d', (input, expected) => {
    expect(parseRupees(input)).toBe(expected)
  })

  it.each<string | number>([
    '',
    '   ',
    '.',
    'abc',
    '1.234',
    '1,5',
    '12,34',
    '1,2345',
    ',100',
    '100,',
    '1.2.3',
    '1e5',
    '₹',
    '--5',
    '-₹-5',
    '5-',
    '1 000',
    '90071992547409.92',
    0.1 + 0.2,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1e21,
    12.345,
  ])('rejects %j', (input) => {
    expect(tryParseRupees(input)).toBeNull()
    expect(() => parseRupees(input)).toThrow(RangeError)
  })

  it('handles negative amounts only when allowed', () => {
    expect(tryParseRupees('-10')).toBeNull()
    expect(tryParseRupees(-10)).toBeNull()
    expect(parseRupees('-10.25', { allowNegative: true })).toBe(-1025)
    expect(parseRupees('-₹ 1,000', { allowNegative: true })).toBe(-100000)
    expect(parseRupees('₹ -1,000', { allowNegative: true })).toBe(-100000)
    expect(parseRupees('−5', { allowNegative: true })).toBe(-500) // unicode minus
    expect(Object.is(parseRupees('-0', { allowNegative: true }), 0)).toBe(true)
  })

  it('rejects non string/number input at runtime', () => {
    expect(tryParseRupees(null as unknown as string)).toBeNull()
  })
})

describe('paiseToRupeesString', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [50, '0.50'],
    [100, '1.00'],
    [123450, '1234.50'],
    [-5, '-0.05'],
    [-123450, '-1234.50'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91'],
  ])('%d → %s', (paise, expected) => {
    expect(paiseToRupeesString(paise)).toBe(expected)
  })
  it('round-trips with parseRupees', () => {
    for (const p of [0, 1, 99, 100, 101, 999999, 123456789]) {
      expect(parseRupees(paiseToRupeesString(p))).toBe(p)
    }
  })
  it('rejects fractional paise', () => {
    expect(() => paiseToRupeesString(1.5)).toThrow(RangeError)
  })
})

describe('formatINR', () => {
  it.each<[number, Parameters<typeof formatINR>[1], string]>([
    [12345650, undefined, '₹1,23,456.50'],
    [0, undefined, '₹0.00'],
    [5, undefined, '₹0.05'],
    [100, undefined, '₹1.00'],
    [99999, undefined, '₹999.99'],
    [100000, undefined, '₹1,000.00'],
    [10000000, undefined, '₹1,00,000.00'],
    [1000000000, undefined, '₹1,00,00,000.00'],
    [-123450, undefined, '-₹1,234.50'],
    [12345650, { symbol: false }, '1,23,456.50'],
    [50000, { decimals: 'auto' }, '₹500'],
    [50050, { decimals: 'auto' }, '₹500.50'],
    [50050, { decimals: 0 }, '₹501'],
    [50049, { decimals: 0 }, '₹500'],
    [-50050, { decimals: 0 }, '-₹501'],
    [-40, { decimals: 0 }, '₹0'],
    [Number.MAX_SAFE_INTEGER, undefined, '₹9,00,71,99,25,47,409.91'],
  ])('formatINR(%d, %j) = %s', (paise, opts, expected) => {
    expect(formatINR(paise, opts)).toBe(expected)
  })
})

describe('formatINRCompact', () => {
  it.each<[number, 'en' | 'ta', string]>([
    [5678000, 'en', '₹56,780'],
    [9999949, 'en', '₹99,999'],
    [10000000, 'en', '₹1 L'],
    [12345600, 'en', '₹1.23 L'],
    [15000000, 'en', '₹1.5 L'],
    [999999999, 'en', '₹1 Cr'],
    [1000000000, 'en', '₹1 Cr'],
    [45000000000, 'en', '₹45 Cr'],
    [12345600, 'ta', '₹1.23 லட்சம்'],
    [2500000000, 'ta', '₹2.5 கோடி'],
    [-12345600, 'en', '-₹1.23 L'],
  ])('formatINRCompact(%d, %s) = %s', (paise, locale, expected) => {
    expect(formatINRCompact(paise, locale)).toBe(expected)
  })
})

describe('roundToRupee', () => {
  it.each([
    [0, 0, 0],
    [1000, 1000, 0],
    [1049, 1000, -49],
    [1050, 1100, 50],
    [1051, 1100, 49],
    [1099, 1100, 1],
    [1001, 1000, -1],
    [49, 0, -49],
    [50, 100, 50],
    [-1050, -1100, -50],
    [-1049, -1000, 49],
  ])('roundToRupee(%d) → %d (%d)', (paise, rounded, roundOff) => {
    expect(roundToRupee(paise)).toEqual({ rounded_paise: rounded, round_off_paise: roundOff })
  })
  it('property: |round_off| ≤ 50 and the result is a whole rupee', () => {
    for (let p = -1000; p <= 100000; p += 7) {
      const { rounded_paise, round_off_paise } = roundToRupee(p)
      expect(Math.abs(round_off_paise)).toBeLessThanOrEqual(50)
      expect(Math.abs(rounded_paise % 100)).toBe(0)
      expect(rounded_paise - p).toBe(round_off_paise)
    }
  })
})

describe('sumPaise / applyBp / formatBp', () => {
  it('sumPaise is exact and guarded', () => {
    expect(sumPaise([100, 250, -50])).toBe(300)
    expect(() => sumPaise([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError)
  })
  it.each([
    [10000, 1800, 1800],
    [12345, 500, 617],
    [12350, 500, 618],
    [100, 25, 0],
    [1000, 25, 3],
    [99, 1, 0],
  ])('applyBp(%d, %d) = %d', (paise, bp, expected) => {
    expect(applyBp(paise, bp)).toBe(expected)
  })
  it.each([
    [1800, '18%'],
    [500, '5%'],
    [25, '0.25%'],
    [250, '2.5%'],
    [10, '0.1%'],
    [0, '0%'],
    [10000, '100%'],
    [-150, '-1.5%'],
  ])('formatBp(%d) = %s', (bp, expected) => {
    expect(formatBp(bp)).toBe(expected)
  })
})
