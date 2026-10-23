/** Statement maths for display (comparison columns and KPI deltas). */

/** Change in basis points (null when there is nothing to compare with). */
export function changeOf(amount: number, compare: number | null | undefined): number | null {
  if (compare == null || compare === 0) return null
  return Math.round(((amount - compare) * 10_000) / Math.abs(compare))
}
