import { describe, expect, it } from 'vitest'
import { allocateProRata, clamp, mulDiv, roundDiv, roundDivBig, sumSafe, toSafeNumber } from '../src/math'
import { createRng } from './helpers/prng'

describe('roundDiv (half away from zero)', () => {
  it.each([
    [0, 1, 0],
    [10, 2, 5],
    [5, 2, 3],
    [-5, 2, -3],
    [4, 3, 1],
    [5, 3, 2],
    [-4, 3, -1],
    [-5, 3, -2],
    [1, 3, 0],
    [-1, 3, 0],
    [149, 100, 1],
    [150, 100, 2],
    [-150, 100, -2],
    [-149, 100, -1],
    [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER, 2, 4503599627370496],
    [Number.MAX_SAFE_INTEGER - 1, 2, 4503599627370495],
    [Number.MIN_SAFE_INTEGER, 2, -4503599627370496],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1],
    [4503599627370495, Number.MAX_SAFE_INTEGER, 0],
    [4503599627370496, Number.MAX_SAFE_INTEGER, 1],
  ])('roundDiv(%d, %d) = %d', (n, d, expected) => {
    expect(roundDiv(n, d)).toBe(expected)
  })

  it('never returns negative zero', () => {
    expect(Object.is(roundDiv(-1, 3), 0)).toBe(true)
    expect(Object.is(roundDiv(-0, 3), 0)).toBe(true)
  })

  it.each([
    [1.5, 2],
    [1, 0],
    [1, -2],
    [Number.MAX_SAFE_INTEGER + 1, 2],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ])('rejects roundDiv(%d, %d)', (n, d) => {
    expect(() => roundDiv(n, d)).toThrow(RangeError)
  })

  it('agrees with a BigInt reference on random inputs', () => {
    const rng = createRng(7)
    for (let i = 0; i < 20000; i++) {
      const n = rng.int(-1e15, 1e15)
      const d = rng.int(1, rng.bool() ? 1000 : 1e12)
      expect(roundDiv(n, d)).toBe(Number(roundDivBig(BigInt(n), BigInt(d))))
    }
  })
})

describe('roundDivBig', () => {
  it.each([
    [5n, 2n, 3n],
    [-5n, 2n, -3n],
    [7n, 3n, 2n],
    [-7n, 3n, -2n],
    [10n ** 30n + 5n, 10n, 10n ** 29n + 1n],
  ])('roundDivBig(%s, %s) = %s', (n, d, expected) => {
    expect(roundDivBig(n, d)).toBe(expected)
  })
  it('rejects non-positive denominators', () => {
    expect(() => roundDivBig(1n, 0n)).toThrow(RangeError)
  })
})

describe('mulDiv', () => {
  it('computes round(a*b/d) exactly beyond the safe range of a*b', () => {
    // ₹1,00,000.00 per kg × 1,00,000 kg = ₹10,000,000,000.00 → product 1e7 × 1e8 = 1e15 safe;
    // push further: 9e7 × 9e8 = 8.1e16 (unsafe) / 1e3
    expect(mulDiv(90_000_000, 900_000_000, 1000)).toBe(81_000_000_000_000)
    expect(mulDiv(3, 5, 2)).toBe(8)
    expect(mulDiv(-3, 5, 2)).toBe(-8)
    expect(mulDiv(Number.MAX_SAFE_INTEGER, 3, 3)).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('throws when the result is not safe', () => {
    expect(() => mulDiv(Number.MAX_SAFE_INTEGER, 3, 1)).toThrow(RangeError)
  })
  it('matches BigInt reference on random large inputs', () => {
    const rng = createRng(99)
    for (let i = 0; i < 5000; i++) {
      const a = rng.int(0, 1e10)
      const b = rng.int(0, 1e9)
      const d = rng.int(1, 1e6)
      const expected = roundDivBig(BigInt(a) * BigInt(b), BigInt(d))
      if (expected <= BigInt(Number.MAX_SAFE_INTEGER)) expect(mulDiv(a, b, d)).toBe(Number(expected))
    }
  })
})

describe('allocateProRata (largest remainder)', () => {
  it.each([
    { total: 100, weights: [1, 1, 1], expected: [34, 33, 33] },
    { total: 100, weights: [1, 2, 1], expected: [25, 50, 25] },
    { total: 10, weights: [3, 3, 3, 1], expected: [3, 3, 3, 1] },
    { total: 1, weights: [1, 1], expected: [1, 0] }, // tie → lower index
    { total: 2, weights: [1, 1, 1], expected: [1, 1, 0] },
    { total: 7, weights: [0, 5, 0, 5], expected: [0, 4, 0, 3] },
    { total: 5, weights: [0, 0, 0], expected: [2, 2, 1] }, // all zero → equal split
    { total: 0, weights: [3, 4], expected: [0, 0] },
    { total: -100, weights: [1, 1, 1], expected: [-34, -33, -33] },
    { total: 1000, weights: [10000], expected: [1000] },
    { total: 50, weights: [12345, 54321, 33334], expected: [6, 27, 17] },
  ])('allocateProRata($total, $weights) = $expected', ({ total, weights, expected }) => {
    expect(allocateProRata(total, weights)).toEqual(expected)
  })

  it('handles empty weights', () => {
    expect(allocateProRata(0, [])).toEqual([])
    expect(() => allocateProRata(1, [])).toThrow(RangeError)
  })

  it('rejects negative or fractional weights', () => {
    expect(() => allocateProRata(10, [1, -1])).toThrow(RangeError)
    expect(() => allocateProRata(10, [1.5, 1])).toThrow(RangeError)
  })

  it('property: parts sum to total, never exceed weights, are within 1 of the exact share', () => {
    const rng = createRng(2026)
    for (let iter = 0; iter < 5000; iter++) {
      const n = rng.int(1, 12)
      const weights = Array.from({ length: n }, () => (rng.bool(0.15) ? 0 : rng.int(1, 5_000_000)))
      const weightSum = weights.reduce((s, w) => s + w, 0)
      const total = rng.int(0, Math.max(weightSum, 1))
      const parts = allocateProRata(total, weights)
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total)
      parts.forEach((p, i) => {
        const w = weights[i]!
        expect(p).toBeGreaterThanOrEqual(0)
        if (weightSum > 0) {
          if (total <= weightSum) expect(p).toBeLessThanOrEqual(w)
          const exact = (total * w) / weightSum
          expect(Math.abs(p - exact)).toBeLessThan(1 + 1e-9)
          if (w === 0) expect(p).toBe(0)
        }
      })
    }
  })

  it('is exact for totals and weights near the safe limit', () => {
    const parts = allocateProRata(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, 1])
    expect(parts[0]! + parts[1]!).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('misc helpers', () => {
  it('sumSafe', () => {
    expect(sumSafe([1, 2, 3])).toBe(6)
    expect(sumSafe([])).toBe(0)
    expect(() => sumSafe([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError)
    expect(() => sumSafe([0.5])).toThrow(RangeError)
  })
  it('toSafeNumber', () => {
    expect(toSafeNumber(12n)).toBe(12)
    expect(() => toSafeNumber(2n ** 53n)).toThrow(RangeError)
  })
  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
  })
})
