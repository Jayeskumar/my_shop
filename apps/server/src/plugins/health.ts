/**
 * Health checks (ARCHITECTURE.md §7.8):
 *   GET /health/live   process is up (liveness probe)
 *   GET /health/ready  database reachable (both pools), migrations current (no pending file, no
 *                      checksum mismatch), worker heartbeat fresh when a worker is expected
 *                      (embedded worker or KADAI_HEALTH_REQUIRE_WORKER); 503 otherwise or while
 *                      shutting down.
 */
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { type MigrationFile, defaultMigrationsDir, readMigrationFiles } from '../db/migrator'
import type { KadaiDeps } from '../core/runtime'

export const WORKER_HEARTBEAT_KEY = 'worker_heartbeat'
/** Heartbeats are written every 30 s; older than this = worker down. */
export const WORKER_HEARTBEAT_MAX_AGE_MS = 90_000

type CheckStatus = 'ok' | 'error' | 'skipped'

export interface HealthOptions {
  migrationsDir?: string
  /** system_settings key of the worker heartbeat (tests use their own). */
  heartbeatKey?: string
  /** Expect a worker heartbeat (default: embedded worker or config.healthRequireWorker). */
  requireWorker?: boolean
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function registerHealth(app: FastifyInstance, deps: KadaiDeps, opts: HealthOptions = {}): void {
  const started = Date.now()
  const requireWorker = opts.requireWorker ?? (deps.config.embeddedWorker || deps.config.healthRequireWorker)
  let shuttingDown = false
  let files: Promise<MigrationFile[]> | null = null
  const migrationFiles = () => (files ??= readMigrationFiles(opts.migrationsDir ?? defaultMigrationsDir()).catch((err: unknown) => {
    files = null
    throw err
  }))

  app.addHook('preClose', async () => {
    shuttingDown = true
  })

  const common = { config: { public: true }, schema: { hide: true } } as const

  app.get('/health/live', common, async () => ({
    status: 'ok',
    version: deps.version,
    mode: deps.config.mode,
    uptime_s: Math.round((Date.now() - started) / 1000),
  }))

  app.get('/health/ready', common, async (_req, reply) => {
    const checks: Record<string, { status: CheckStatus } & Record<string, unknown>> = {}

    const t0 = Date.now()
    try {
      await withTimeout(
        Promise.all([sql`select 1`.execute(deps.db.appDb), sql`select 1`.execute(deps.db.systemDb)]),
        3000,
        'database ping',
      )
      checks.database = { status: 'ok', latency_ms: Date.now() - t0 }
    } catch (err) {
      checks.database = { status: 'error', error: err instanceof Error ? err.message : String(err) }
    }

    if (checks.database.status === 'ok') {
      try {
        const [onDisk, applied] = await Promise.all([
          migrationFiles(),
          deps.db.systemDb.selectFrom('schema_migrations').select(['name', 'checksum']).execute(),
        ])
        const appliedMap = new Map(applied.map((a) => [a.name, a.checksum]))
        const pending = onDisk.filter((f) => !appliedMap.has(f.name)).map((f) => f.name)
        const modified = onDisk.filter((f) => appliedMap.has(f.name) && appliedMap.get(f.name) !== f.checksum).map((f) => f.name)
        checks.migrations = {
          status: pending.length || modified.length ? 'error' : 'ok',
          applied: applied.length,
          ...(pending.length ? { pending } : {}),
          ...(modified.length ? { modified } : {}),
        }
      } catch (err) {
        checks.migrations = { status: 'error', error: err instanceof Error ? err.message : String(err) }
      }

      if (requireWorker) {
        try {
          // Age computed by the database clock (updated_at is set by the updated_at trigger), so
          // clock skew between API and worker hosts does not matter.
          const row = await deps.db.systemDb
            .selectFrom('system_settings')
            .select(['value', 'updated_at', sql<number>`extract(epoch from (now() - updated_at)) * 1000`.as('age_ms')])
            .where('key', '=', opts.heartbeatKey ?? WORKER_HEARTBEAT_KEY)
            .executeTakeFirst()
          const at = row?.updated_at ?? null
          const age = row ? Number(row.age_ms) : null
          checks.worker = {
            status: age !== null && age <= WORKER_HEARTBEAT_MAX_AGE_MS ? 'ok' : 'error',
            last_heartbeat: at ? at.toISOString() : null,
            ...(row?.value && typeof row.value === 'object' ? { info: row.value } : {}),
          }
        } catch (err) {
          checks.worker = { status: 'error', error: err instanceof Error ? err.message : String(err) }
        }
      } else {
        checks.worker = { status: 'skipped' }
      }
    }

    if (shuttingDown) checks.shutdown = { status: 'error', reason: 'shutting down' }
    const ok = Object.values(checks).every((c) => c.status !== 'error')
    return reply
      .code(ok ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({ status: ok ? 'ok' : 'error', version: deps.version, mode: deps.config.mode, checks })
  })
}
