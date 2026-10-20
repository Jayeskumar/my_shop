/**
 * Tenant-scoped and system transactions (ARCHITECTURE.md §6.2).
 *
 *   await withTenant(appDb, ctx, async (tx) => { … })
 *     BEGIN;
 *     SELECT set_config('app.tenant_id', <tenant>, true), set_config('app.user_id', <user>, true),
 *            set_config('statement_timeout', <ms>, true);
 *     … fn(tx) …
 *     COMMIT
 *
 * `set_config(…, true)` is transaction-local (like SET LOCAL), so a pooled connection can never
 * leak tenant context to the next borrower. RLS policies compare `tenant_id` with
 * `current_tenant_id()`; without context every tenant table returns zero rows.
 *
 * Services receive `(tx, ctx, input)` and never open their own transactions: one request = one
 * transaction, which keeps posting (stock + journal + payments) atomic.
 */
import { type Kysely, type Transaction, sql } from 'kysely'
import type { DB } from './schema.generated'

export type Tx = Transaction<DB>

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable'

export interface TxOptions {
  /** Per-transaction statement timeout (ms); defaults to the pool's session setting. */
  statementTimeoutMs?: number
  isolation?: IsolationLevel
}

/** What withTenant needs from a RequestContext (also satisfied by systemContext()). */
export interface TenantScope {
  tenantId: string
  userId: string | null
}

type Hook = () => void | Promise<void>
interface TxHooks {
  afterCommit: Hook[]
  afterRollback: Hook[]
}

const hooks = new WeakMap<Tx, TxHooks>()

let hookErrorHandler: (err: unknown, phase: 'afterCommit' | 'afterRollback') => void = (err, phase) => {
  console.error(`[kadai] ${phase} hook failed`, err)
}

/** Routes errors thrown by afterCommit/afterRollback hooks (the app sets its logger here). */
export function setTxHookErrorHandler(
  fn: (err: unknown, phase: 'afterCommit' | 'afterRollback') => void,
): void {
  hookErrorHandler = fn
}

/**
 * Runs `fn` once the transaction has COMMITTED (e.g. push an in-memory cache invalidation, start
 * work that must not see uncommitted data). Errors are logged, never thrown. Only works for
 * transactions opened by withTenant / withSystemTx.
 */
export function afterCommit(tx: Tx, fn: Hook): void {
  const h = hooks.get(tx)
  if (!h) throw new Error('afterCommit() requires a transaction opened by withTenant/withSystemTx')
  h.afterCommit.push(fn)
}

/** Runs `fn` after the transaction ROLLED BACK (e.g. delete an object uploaded to storage). */
export function afterRollback(tx: Tx, fn: Hook): void {
  const h = hooks.get(tx)
  if (!h) throw new Error('afterRollback() requires a transaction opened by withTenant/withSystemTx')
  h.afterRollback.push(fn)
}

async function runHooks(list: Hook[], phase: 'afterCommit' | 'afterRollback'): Promise<void> {
  for (const fn of list) {
    try {
      await fn()
    } catch (err) {
      hookErrorHandler(err, phase)
    }
  }
}

async function runTx<T>(
  db: Kysely<DB>,
  opts: TxOptions,
  setup: (tx: Tx) => Promise<void>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  let txHooks: TxHooks | undefined
  let builder = db.transaction()
  if (opts.isolation) builder = builder.setIsolationLevel(opts.isolation)
  try {
    const result = await builder.execute(async (tx) => {
      txHooks = { afterCommit: [], afterRollback: [] }
      hooks.set(tx, txHooks)
      await setup(tx)
      return fn(tx)
    })
    if (txHooks?.afterCommit.length) await runHooks(txHooks.afterCommit, 'afterCommit')
    return result
  } catch (err) {
    if (txHooks?.afterRollback.length) await runHooks(txHooks.afterRollback, 'afterRollback')
    throw err
  }
}

function assertUuid(value: string, name: string): void {
  // Guard against typos that would otherwise surface as a cast error inside RLS policies.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`)
  }
}

/** Opens one transaction scoped to `scope.tenantId` (RLS) on the given (app) database. */
export function withTenant<T>(
  db: Kysely<DB>,
  scope: TenantScope,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  assertUuid(scope.tenantId, 'tenantId')
  if (scope.userId !== null) assertUuid(scope.userId, 'userId')
  return runTx(
    db,
    opts,
    async (tx) => {
      await sql`select set_config('app.tenant_id', ${scope.tenantId}, true),
                       set_config('app.user_id', ${scope.userId ?? ''}, true)
                       ${opts.statementTimeoutMs ? sql`, set_config('statement_timeout', ${String(opts.statementTimeoutMs)}, true)` : sql``}`.execute(
        tx,
      )
    },
    fn,
  )
}

/**
 * Opens a transaction WITHOUT tenant context — for the system (owner) database: migrations-like
 * maintenance, cross-tenant lookups, onboarding. On the app database it sees no tenant rows.
 */
export function withSystemTx<T>(db: Kysely<DB>, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  return runTx(
    db,
    opts,
    async (tx) => {
      if (opts.statementTimeoutMs) {
        await sql`select set_config('statement_timeout', ${String(opts.statementTimeoutMs)}, true)`.execute(tx)
      }
    },
    fn,
  )
}
