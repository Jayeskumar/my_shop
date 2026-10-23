/**
 * GET /system/info — version, git commit, deployment mode, Node runtime, PostgreSQL version & size,
 * migration status, worker heartbeat and storage driver (plus on-prem summary when mode = 'onprem').
 */
import { sql } from 'kysely'
import { DEFAULT_TIMEZONE } from '@kadai/shared'
import type { SystemInfo, platformRoutes } from '@kadai/shared/api/platform'
import type { RouteImpls } from '../../core/http'
import { defaultMigrationsDir, readMigrationFiles } from '../../db/migrator'
import { WORKER_HEARTBEAT_MAX_AGE_MS } from '../../plugins/health'
import { VERSION } from '../../version'
import type { PlatformRuntime } from './runtime'
import { iso } from './util'

type Routes = typeof platformRoutes

const PROCESS_STARTED_AT = new Date(Date.now() - Math.floor(process.uptime() * 1000))

function parseHeartbeatDate(value: unknown): Date | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const raw = v.at ?? v.updated_at ?? v.timestamp
  if (typeof raw !== 'string') return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms) : null
}

export function systemInfoHandlers(
  rt: PlatformRuntime,
): Pick<RouteImpls<Routes>, 'systemInfo'> {
  const { deps } = rt
  return {
    systemInfo: {
      handler: async (req) => {
        const now = rt.now()
        // systemDb: schema_migrations, pg_database_size and system_settings are system-level tables.
        const [dbStats, appliedRows, diskMigrations, heartbeatRow, tenantRow, ent] =
          await Promise.all([
            sql<{ version: string; size_bytes: string }>`
              SELECT current_setting('server_version') AS version,
                     pg_database_size(current_database())::bigint AS size_bytes
            `.execute(deps.db.systemDb),
            deps.db.systemDb
              .selectFrom('schema_migrations')
              .select(['name', 'applied_at'])
              .orderBy('name', 'desc')
              .execute(),
            readMigrationFiles(defaultMigrationsDir()).catch(() => []),
            deps.db.systemDb
              .selectFrom('system_settings')
              .select(['value', 'updated_at'])
              .where('key', '=', rt.heartbeatKey)
              .executeTakeFirst(),
            deps.db.systemDb
              .selectFrom('tenants')
              .select('timezone')
              .where('id', '=', req.ctx.tenantId)
              .executeTakeFirst(),
            deps.entitlements.get(req.ctx.tenantId),
          ])

        const stat = dbStats.rows[0]
        const latestMig = appliedRows[0] ?? null
        const appliedSet = new Set(appliedRows.map((r) => r.name))
        const pendingCount = diskMigrations.filter((m) => !appliedSet.has(m.name)).length

        const hbDate = heartbeatRow
          ? (parseHeartbeatDate(heartbeatRow.value) ?? heartbeatRow.updated_at)
          : null
        const hbAgeMs = hbDate ? Math.max(0, now.getTime() - hbDate.getTime()) : null
        const hbAgeSec = hbAgeMs !== null ? Math.floor(hbAgeMs / 1000) : null
        const workerHealthy =
          deps.config.embeddedWorker ||
          (hbAgeMs !== null && hbAgeMs <= WORKER_HEARTBEAT_MAX_AGE_MS)

        const info: SystemInfo = {
          version: VERSION,
          git_commit: rt.settings.gitCommit,
          mode: deps.config.mode,
          node_version: process.version,
          platform: process.platform,
          arch: process.arch,
          started_at: iso(PROCESS_STARTED_AT),
          uptime_seconds: Math.max(
            0,
            Math.floor((now.getTime() - PROCESS_STARTED_AT.getTime()) / 1000),
          ),
          server_time: iso(now),
          timezone: tenantRow?.timezone ?? DEFAULT_TIMEZONE,
          db: {
            server_version: stat?.version ?? '16',
            size_bytes: Math.max(0, Number(stat?.size_bytes ?? 0)),
            migrations_applied: appliedRows.length,
            last_migration: latestMig ? latestMig.name : null,
            last_migration_at: latestMig ? iso(latestMig.applied_at) : null,
            pending_migrations: pendingCount,
          },
          worker: {
            embedded: deps.config.embeddedWorker,
            heartbeat_at: hbDate ? iso(hbDate) : null,
            heartbeat_age_seconds: hbAgeSec,
            healthy: workerHealthy,
          },
          storage: {
            driver: deps.config.s3?.bucket ? 's3' : 'local',
          },
          entitlements: {
            plan_code: ent.plan_code,
            source: ent.source,
          },
          onprem: null,
        }
        return { data: info }
      },
    },
  }
}
