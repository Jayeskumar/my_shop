/**
 * node-postgres pools and type parsing (ARCHITECTURE.md §5, §6.1).
 *
 * Type parsers are process-global in `pg` and installed once on import:
 *   int8 (20)        → JS number, throwing when the value is not a safe integer (money in paise
 *                      and milli quantities always fit: < 2^53)
 *   date (1082)      → 'YYYY-MM-DD' string (business dates are timezone-less)
 *   timestamptz      → Date (pg default)
 *   numeric (1700)   → string (pg default; not used for money)
 */
import pg from 'pg'

const INT8_OID = 20
const INT8_ARRAY_OID = 1016
const DATE_OID = 1082
const DATE_ARRAY_OID = 1182

export function parseInt8(value: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`int8 value ${value} is outside the safe integer range`)
  }
  return n
}

/** Parses a Postgres array literal of scalars without quoting/nesting (int8[] / date[]). */
function parseSimpleArray<T>(value: string, item: (s: string) => T): Array<T | null> {
  const inner = value.slice(1, -1)
  if (inner === '') return []
  return inner.split(',').map((s) => (s === 'NULL' ? null : item(s.replace(/^"|"$/g, ''))))
}

pg.types.setTypeParser(INT8_OID, parseInt8)
pg.types.setTypeParser(INT8_ARRAY_OID, (v: string) => parseSimpleArray(v, parseInt8))
pg.types.setTypeParser(DATE_OID, (v: string) => v)
pg.types.setTypeParser(DATE_ARRAY_OID, (v: string) => parseSimpleArray(v, (s) => s))

export interface PoolOptions {
  connectionString: string
  max: number
  applicationName: string
  /** Server-side statement_timeout for every session of the pool (ms). */
  statementTimeoutMs: number
  idleInTransactionTimeoutMs: number
  /** Called for errors on idle clients (network drop, server restart). */
  onError?: (err: Error) => void
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    application_name: opts.applicationName,
    // Session defaults sent in the startup packet: no extra round trip per connection.
    options: [
      `-c statement_timeout=${opts.statementTimeoutMs}`,
      `-c idle_in_transaction_session_timeout=${opts.idleInTransactionTimeoutMs}`,
      // India has one time zone; SQL date arithmetic (rare: business dates come from the app)
      // then matches the tenant's business day.
      '-c TimeZone=Asia/Kolkata',
    ].join(' '),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  })
  pool.on('error', (err) => opts.onError?.(err))
  return pool
}

/** Pool gauges for metrics. */
export function poolStats(pool: pg.Pool): { total: number; idle: number; waiting: number } {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
}
