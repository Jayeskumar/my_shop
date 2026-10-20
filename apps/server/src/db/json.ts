/**
 * Writing json/jsonb columns. The generated types make json columns accept JSON *text* on
 * insert/update because node-postgres serialises JS arrays as Postgres array literals
 * ('{1,2}'), which silently corrupts or rejects jsonb values. Always write through jsonb().
 *
 *   await tx.insertInto('imports').values({ …, errors: jsonb([{ row: 2, message: '…' }]) })
 */

/** JSON-serialises a value for a json/jsonb column. Rejects values JSON cannot represent. */
export function jsonb(value: unknown): string {
  const text = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') {
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new RangeError('jsonb(): bigint outside the safe integer range')
      }
      return Number(v)
    }
    if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('jsonb(): non-finite number')
    return v
  })
  if (text === undefined) throw new TypeError('jsonb(): value is not JSON-serialisable')
  return text
}
