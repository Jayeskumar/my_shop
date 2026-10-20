/**
 * Exact integer arithmetic for money (paise), quantities (milli units) and rates (basis points).
 *
 * All functions take and return JavaScript numbers that must be *safe integers*
 * (|n| ≤ 2^53 − 1). Intermediate products that could exceed the safe range are computed with
 * BigInt, so results are exact; a RangeError is thrown when an input or the final result is not
 * a safe integer. Rounding is always half away from zero (ARCHITECTURE.md §5).
 */

/** Throws a RangeError unless `value` is a safe integer. */
export function assertSafeInt(value: number, name = 'value'): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${String(value)}`)
  }
}

/** Throws a RangeError unless `value` is a non-negative safe integer. */
export function assertNonNegativeInt(value: number, name = 'value'): void {
  assertSafeInt(value, name)
  if (value < 0) throw new RangeError(`${name} must be >= 0, got ${value}`)
}

/**
 * numerator / denominator rounded half away from zero, exactly.
 * roundDiv(5, 2) = 3, roundDiv(-5, 2) = -3, roundDiv(4, 3) = 1.
 */
export function roundDiv(numerator: number, denominator: number): number {
  assertSafeInt(numerator, 'numerator')
  assertSafeInt(denominator, 'denominator')
  if (denominator <= 0) throw new RangeError(`denominator must be > 0, got ${denominator}`)
  // `%` and the exact division of (n - r) are exact for safe integers; doubling |r| only
  // changes the exponent of the float, so the comparison is exact as well.
  const r = numerator % denominator
  const q = (numerator - r) / denominator
  if (2 * Math.abs(r) >= denominator) return q + (numerator < 0 ? -1 : 1)
  return q + 0 // normalises -0
}

/** BigInt variant of {@link roundDiv} (half away from zero). */
export function roundDivBig(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError(`denominator must be > 0, got ${denominator}`)
  const r = numerator % denominator
  const q = numerator / denominator // truncates toward zero
  const absR = r < 0n ? -r : r
  if (2n * absR >= denominator) return q + (numerator < 0n ? -1n : 1n)
  return q
}

/**
 * round(a × b / d) exactly, half away from zero. Uses BigInt when a × b leaves the safe
 * integer range (e.g. ₹1 lakh × 10 lakh kg), and checks that the result is safe.
 */
export function mulDiv(a: number, b: number, d: number): number {
  assertSafeInt(a, 'a')
  assertSafeInt(b, 'b')
  assertSafeInt(d, 'd')
  if (d <= 0) throw new RangeError(`d must be > 0, got ${d}`)
  const p = a * b
  // If the true product is outside the safe range the float product is too (rounding is
  // monotonic), so this check never accepts an inexact product.
  if (Number.isSafeInteger(p)) return roundDiv(p, d)
  const result = roundDivBig(BigInt(a) * BigInt(b), BigInt(d))
  return toSafeNumber(result)
}

/** Converts a BigInt to a number, throwing when it is outside the safe integer range. */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`result ${value} exceeds the safe integer range`)
  }
  return Number(value) + 0
}

/** Sum of safe integers; throws when an element or the running total is not a safe integer. */
export function sumSafe(values: Iterable<number>): number {
  let total = 0
  for (const v of values) {
    assertSafeInt(v)
    total += v
    if (!Number.isSafeInteger(total)) throw new RangeError('sum exceeds the safe integer range')
  }
  return total
}

/**
 * Splits `total` into integers proportional to `weights` using the largest-remainder method.
 *
 * Guarantees: the parts sum exactly to `total`; each part has the sign of `total`; when
 * |total| ≤ Σ weights no part exceeds its weight (so an allocated bill discount never exceeds a
 * line's value). Remainder ties are broken by the lower index, so the result is deterministic.
 * Zero weights receive nothing unless every weight is zero, in which case the total is split
 * equally (earlier indexes receive the extra units).
 *
 * @throws RangeError for non-integer/negative weights, or a non-zero total with no weights.
 */
export function allocateProRata(total: number, weights: readonly number[]): number[] {
  assertSafeInt(total, 'total')
  weights.forEach((w, i) => assertNonNegativeInt(w, `weights[${i}]`))
  if (weights.length === 0) {
    if (total === 0) return []
    throw new RangeError('cannot allocate a non-zero total over zero weights')
  }
  if (total === 0) return weights.map(() => 0)

  const sign = total < 0 ? -1n : 1n
  const amount = BigInt(Math.abs(total))
  let effective = weights.map((w) => BigInt(w))
  let weightSum = effective.reduce((s, w) => s + w, 0n)
  if (weightSum === 0n) {
    effective = weights.map(() => 1n)
    weightSum = BigInt(weights.length)
  }

  const parts: bigint[] = []
  const remainders: Array<{ index: number; rem: bigint }> = []
  let allocated = 0n
  effective.forEach((w, index) => {
    const product = amount * w
    const floor = product / weightSum
    parts.push(floor)
    allocated += floor
    remainders.push({ index, rem: product % weightSum })
  })

  // Σ remainders = leftover × weightSum and each remainder < weightSum, so at least
  // `leftover` entries have a positive remainder: every extra unit goes to a weighted index.
  let leftover = amount - allocated
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1))
  for (const { index } of remainders) {
    if (leftover === 0n) break
    parts[index] = (parts[index] ?? 0n) + 1n
    leftover -= 1n
  }
  return parts.map((p) => toSafeNumber(p * sign))
}

/** Clamps `value` to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
