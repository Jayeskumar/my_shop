/**
 * Database handles (ARCHITECTURE.md §6.1):
 *   appDb    — runtime role (kadai_app), RLS enforced: every tenant request and job (via withTenant)
 *   systemDb — owner role (kadai_owner), bypasses RLS: migrations, login lookups across tenants,
 *              signup/onboarding, webhook routing, job fan-out, platform admin. Restricted to
 *              core/ and explicitly justified flows.
 */
import { Kysely, PostgresDialect } from 'kysely'
import type pg from 'pg'
import type { Config } from '../config'
import { createPool } from './pool'
import type { DB } from './schema.generated'

export type { DB } from './schema.generated'
export type Db = Kysely<DB>

export interface Databases {
  appDb: Kysely<DB>
  systemDb: Kysely<DB>
  appPool: pg.Pool
  systemPool: pg.Pool
  /** Closes both pools (idempotent). */
  destroy(): Promise<void>
}

export interface CreateDatabasesOptions {
  /** application_name prefix ('kadai-api', 'kadai-worker', …). */
  applicationName?: string
  onPoolError?: (err: Error, pool: 'app' | 'system') => void
}

export function createDatabases(config: Config, opts: CreateDatabasesOptions = {}): Databases {
  const name = opts.applicationName ?? 'kadai'
  const common = {
    statementTimeoutMs: config.database.statementTimeoutMs,
    idleInTransactionTimeoutMs: config.database.idleInTransactionTimeoutMs,
  }
  const appPool = createPool({
    ...common,
    connectionString: config.database.url,
    max: config.database.poolMax,
    applicationName: `${name}-app`,
    onError: (err) => opts.onPoolError?.(err, 'app'),
  })
  const systemPool = createPool({
    ...common,
    connectionString: config.database.systemUrl,
    max: config.database.systemPoolMax,
    applicationName: `${name}-system`,
    onError: (err) => opts.onPoolError?.(err, 'system'),
  })
  const appDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: appPool }) })
  const systemDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: systemPool }) })

  let destroyed: Promise<void> | null = null
  return {
    appDb,
    systemDb,
    appPool,
    systemPool,
    destroy() {
      // Kysely.destroy() ends the underlying pool.
      destroyed ??= Promise.all([appDb.destroy(), systemDb.destroy()]).then(() => undefined)
      return destroyed
    },
  }
}
