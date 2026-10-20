/**
 * Forward-only SQL migrator (ARCHITECTURE.md §6.4).
 *
 *   advisory lock → for each pending NNNN_name.sql (lexical order): BEGIN; <file>; INSERT INTO
 *   schema_migrations; COMMIT → kadai_ensure_conventions() → kadai_apply_grants(<app role>) → unlock
 *
 * * Checksums (sha256 of the file with CRLF normalised to LF) are recorded; editing an applied file
 *   is a hard error (the server refuses to start) — write a new migration instead.
 * * Pending files that sort before already-applied ones (parallel module development in separate
 *   number bands) are applied with a warning.
 * * Applied migrations whose file is missing (database newer than the code) produce a warning.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/
/** pg_advisory_lock key: 'kadai_migrations' as a stable 64-bit number. */
export const MIGRATION_LOCK_KEY = 7_315_826_101_404_123n

export interface MigrationFile {
  name: string
  checksum: string
  sql: string
}

export interface AppliedMigration {
  name: string
  checksum: string
  applied_at: Date
}

export type MigrationState = 'applied' | 'pending' | 'checksum_mismatch' | 'missing_file'

export interface MigrationStatusEntry {
  name: string
  state: MigrationState
  applied_at: Date | null
  /** Pending file that sorts before an applied one. */
  out_of_order: boolean
}

export interface MigrationLogger {
  info(msg: string): void
  warn(msg: string): void
}

export interface MigrateOptions {
  /** Owner-role connection string (DATABASE_SYSTEM_URL). */
  connectionString: string
  /** Runtime role granted by kadai_apply_grants(). */
  appRole: string
  migrationsDir?: string
  logger?: MigrationLogger
  /** Only report what would run. */
  dryRun?: boolean
}

export interface MigrateResult {
  applied: string[]
  outOfOrder: string[]
  missingFiles: string[]
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly migration?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'MigrationError'
  }
}

export class ChecksumMismatchError extends MigrationError {
  constructor(readonly files: readonly string[]) {
    super(
      `Applied migration file(s) were modified: ${files.join(', ')}. ` +
        'Migrations are immutable once applied; restore the original file and add a new migration.',
    )
    this.name = 'ChecksumMismatchError'
  }
}

const consoleLogger: MigrationLogger = {
  info: (m) => console.warn(`[migrate] ${m}`),
  warn: (m) => console.warn(`[migrate] WARNING: ${m}`),
}

/** apps/server/migrations, from src/db (dev, tests) or dist/ (bundle); KADAI_MIGRATIONS_DIR wins. */
export function defaultMigrationsDir(): string {
  if (process.env.KADAI_MIGRATIONS_DIR) return path.resolve(process.env.KADAI_MIGRATIONS_DIR)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../migrations'), path.resolve(here, '../migrations')]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!
}

export function checksumOf(sqlText: string): string {
  return createHash('sha256').update(sqlText.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir)
  const names = entries.filter((f) => f.endsWith('.sql')).sort()
  const bad = names.filter((n) => !MIGRATION_FILE_RE.test(n))
  if (bad.length) {
    throw new MigrationError(
      `Invalid migration file name(s): ${bad.join(', ')} (expected NNNN_snake_case.sql)`,
    )
  }
  const numbers = new Map<string, string>()
  const files: MigrationFile[] = []
  for (const name of names) {
    const num = name.slice(0, 4)
    const clash = numbers.get(num)
    if (clash) throw new MigrationError(`Duplicate migration number ${num}: ${clash} and ${name}`)
    numbers.set(num, name)
    const sqlText = await readFile(path.join(dir, name), 'utf8')
    files.push({ name, checksum: checksumOf(sqlText), sql: sqlText })
  }
  return files
}

async function ensureTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`)
}

async function readApplied(client: pg.Client): Promise<AppliedMigration[]> {
  const exists = await client.query<{ t: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS t`,
  )
  if (!exists.rows[0]?.t) return []
  const res = await client.query<AppliedMigration>(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  )
  return res.rows
}

function plan(files: MigrationFile[], applied: AppliedMigration[]) {
  const appliedByName = new Map(applied.map((a) => [a.name, a]))
  const fileNames = new Set(files.map((f) => f.name))
  const mismatched = files.filter((f) => {
    const a = appliedByName.get(f.name)
    return a !== undefined && a.checksum !== f.checksum
  })
  const pending = files.filter((f) => !appliedByName.has(f.name))
  const maxApplied = applied.reduce<string>((max, a) => (a.name > max ? a.name : max), '')
  const outOfOrder = pending.filter((f) => f.name < maxApplied).map((f) => f.name)
  const missingFiles = applied.filter((a) => !fileNames.has(a.name)).map((a) => a.name)
  return { pending, mismatched, outOfOrder, missingFiles, appliedByName }
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, application_name: 'kadai-migrator' })
  await client.connect()
  // Migrations may legitimately run long (index builds); the session default would cut them off.
  await client.query('SET statement_timeout = 0')
  return client
}

/** Applies pending migrations. Throws ChecksumMismatchError before applying anything. */
export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.logger ?? consoleLogger
  const dir = opts.migrationsDir ?? defaultMigrationsDir()
  const files = await readMigrationFiles(dir)
  const client = await connect(opts.connectionString)
  try {
    const locked = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      MIGRATION_LOCK_KEY.toString(),
    ])
    if (!locked.rows[0]?.ok) {
      log.info('waiting for another migrator to finish…')
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()])
    }
    try {
      if (!opts.dryRun) await ensureTable(client)
      const applied = await readApplied(client)
      const p = plan(files, applied)
      if (p.mismatched.length) throw new ChecksumMismatchError(p.mismatched.map((f) => f.name))
      for (const name of p.missingFiles) {
        log.warn(
          `migration ${name} is applied but its file is missing (database is newer than this build?)`,
        )
      }
      for (const name of p.outOfOrder) {
        log.warn(`applying ${name} out of order (it sorts before an already-applied migration)`)
      }
      if (opts.dryRun) {
        return {
          applied: p.pending.map((f) => f.name),
          outOfOrder: p.outOfOrder,
          missingFiles: p.missingFiles,
        }
      }

      const done: string[] = []
      for (const file of p.pending) {
        const started = Date.now()
        await client.query('BEGIN')
        try {
          await client.query(file.sql)
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
            file.name,
            file.checksum,
          ])
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined)
          const msg = err instanceof Error ? err.message : String(err)
          throw new MigrationError(`migration ${file.name} failed: ${msg}`, file.name, {
            cause: err,
          })
        }
        done.push(file.name)
        log.info(`applied ${file.name} (${Date.now() - started} ms)`)
      }

      // Conventions (RLS policies, updated_at triggers) and grants are re-applied on every run so
      // that tables created by any migration — including out-of-order ones — are covered.
      const hasConventions = await client.query<{ ok: boolean }>(
        `SELECT to_regprocedure('kadai_ensure_conventions()') IS NOT NULL AS ok`,
      )
      if (hasConventions.rows[0]?.ok) {
        await client.query('BEGIN')
        try {
          await client.query('SELECT kadai_ensure_conventions()')
          await client.query('SELECT kadai_apply_grants($1)', [opts.appRole])
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw new MigrationError(
            `post-migration conventions/grants failed: ${err instanceof Error ? err.message : String(err)}`,
            undefined,
            { cause: err },
          )
        }
      }
      if (done.length === 0) log.info('database is up to date')
      return { applied: done, outOfOrder: p.outOfOrder, missingFiles: p.missingFiles }
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()])
        .catch(() => undefined)
    }
  } finally {
    await client.end()
  }
}

/** Read-only report of every migration's state (no lock, no writes). */
export async function migrationStatus(opts: {
  connectionString: string
  migrationsDir?: string
}): Promise<MigrationStatusEntry[]> {
  const files = await readMigrationFiles(opts.migrationsDir ?? defaultMigrationsDir())
  const client = await connect(opts.connectionString)
  try {
    const applied = await readApplied(client)
    const p = plan(files, applied)
    const mismatched = new Set(p.mismatched.map((f) => f.name))
    const outOfOrder = new Set(p.outOfOrder)
    const entries: MigrationStatusEntry[] = files.map((f) => {
      const a = p.appliedByName.get(f.name)
      return {
        name: f.name,
        state: a ? (mismatched.has(f.name) ? 'checksum_mismatch' : 'applied') : 'pending',
        applied_at: a?.applied_at ?? null,
        out_of_order: outOfOrder.has(f.name),
      }
    })
    for (const name of p.missingFiles) {
      entries.push({
        name,
        state: 'missing_file',
        applied_at: p.appliedByName.get(name)?.applied_at ?? null,
        out_of_order: false,
      })
    }
    return entries.sort((x, y) => x.name.localeCompare(y.name))
  } finally {
    await client.end()
  }
}

/** Formats a status report as an aligned text table (for the CLI). */
export function formatStatus(entries: readonly MigrationStatusEntry[]): string {
  const width = Math.max(10, ...entries.map((e) => e.name.length))
  const lines = entries.map((e) => {
    const when = e.applied_at ? e.applied_at.toISOString() : ''
    const flag = e.out_of_order ? ' (out of order)' : ''
    return `${e.name.padEnd(width)}  ${e.state.padEnd(17)}  ${when}${flag}`
  })
  return [`${'migration'.padEnd(width)}  ${'state'.padEnd(17)}  applied_at`, ...lines].join('\n')
}
