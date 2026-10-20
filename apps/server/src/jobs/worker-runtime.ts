/**
 * Background worker (ARCHITECTURE.md §14). Used by src/worker.ts (dedicated worker process) and
 * by src/server.ts when KADAI_EMBEDDED_WORKER=true (on-prem: one process runs API + worker).
 *
 *   * creates every registered queue, registers handlers (with metrics and structured logs),
 *   * installs cron schedules (removing those of jobs that stopped being cron jobs),
 *   * runs `intervalSeconds` jobs via singleton sends (deduplicated across worker processes),
 *   * writes a heartbeat to system_settings.worker_heartbeat every 30 s (/health/ready).
 */
import os from 'node:os'
import { sql } from 'kysely'
import type PgBoss from 'pg-boss'
import { jsonb } from '../db/json'
import type { KadaiDeps } from '../core/runtime'
import { WORKER_HEARTBEAT_KEY } from '../plugins/health'
import type { KadaiJob } from './types'

export const HEARTBEAT_INTERVAL_MS = 30_000

export interface RunningWorker {
  stop(): Promise<void>
}

export interface WorkerOptions {
  /** system_settings key for the heartbeat (default worker_heartbeat; tests use their own). */
  heartbeatKey?: string
}

export async function writeHeartbeat(
  deps: KadaiDeps,
  jobs: number,
  key: string = WORKER_HEARTBEAT_KEY,
): Promise<void> {
  const value = jsonb({
    pid: process.pid,
    hostname: os.hostname(),
    version: deps.version,
    jobs,
    at: new Date().toISOString(),
  })
  await deps.db.systemDb
    .insertInto('system_settings')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: sql<Date>`now()` }))
    .execute()
}

export async function startWorker(
  deps: KadaiDeps,
  definitions: readonly KadaiJob[],
  opts: WorkerOptions = {},
): Promise<RunningWorker> {
  const { logger, metrics } = deps
  const log = logger.child({ component: 'worker' })
  await deps.jobs.start()
  const boss: PgBoss = deps.jobs.boss
  const workerIds: string[] = []
  const timers: NodeJS.Timeout[] = []

  for (const def of definitions) {
    const concurrency = Math.max(1, def.work?.localConcurrency ?? 1)
    for (let i = 0; i < concurrency; i++) {
      const id = await boss.work<Record<string, unknown>>(
        def.name,
        {
          batchSize: 1,
          includeMetadata: true,
          pollingIntervalSeconds: def.work?.pollingIntervalSeconds ?? 2,
        },
        async (jobs) => {
          for (const job of jobs) {
            const end = metrics.jobDuration.startTimer({ name: def.name })
            try {
              await def.handler(
                { id: job.id, name: job.name, data: job.data, retryCount: job.retryCount },
                deps,
              )
              metrics.jobsProcessed.inc({ name: def.name, status: 'completed' })
            } catch (err) {
              metrics.jobsProcessed.inc({ name: def.name, status: 'failed' })
              log.error({ err, job: def.name, job_id: job.id, retry: job.retryCount }, 'job failed')
              throw err
            } finally {
              end()
            }
          }
        },
      )
      workerIds.push(id)
    }
  }

  // Cron schedules: (re)install current ones. Only schedules of jobs this build knows are
  // removed (a job that is no longer cron); unknown names are left alone so that, during a
  // rolling deploy, an older worker never unschedules jobs added by a newer one.
  const known = new Map(definitions.map((d) => [d.name, d]))
  for (const s of await boss.getSchedules()) {
    const def = known.get(s.name)
    if (def && !def.cron) await boss.unschedule(s.name)
    else if (!def)
      log.warn({ job: s.name }, 'schedule for a job unknown to this build left in place')
  }
  for (const def of definitions) {
    if (def.cron)
      await boss.schedule(def.name, def.cron, def.data ?? {}, { tz: def.tz ?? 'Asia/Kolkata' })
  }

  // Sub-minute periodic jobs: every worker sends; the singleton window lets only one through.
  for (const def of definitions) {
    if (!def.intervalSeconds) continue
    const interval = def.intervalSeconds
    const tick = () => {
      boss
        .send(def.name, def.data ?? {}, { singletonKey: def.name, singletonSeconds: interval })
        .catch((err: unknown) => log.warn({ err, job: def.name }, 'interval send failed'))
    }
    tick()
    const t = setInterval(tick, interval * 1000)
    t.unref()
    timers.push(t)
  }

  const beat = () =>
    writeHeartbeat(deps, definitions.length, opts.heartbeatKey).catch((err: unknown) =>
      log.warn({ err }, 'heartbeat failed'),
    )
  await beat()
  const hb = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS)
  hb.unref()
  timers.push(hb)

  log.info({ jobs: definitions.map((d) => d.name) }, 'worker started')

  let stopped = false
  return {
    async stop() {
      if (stopped) return
      stopped = true
      timers.forEach(clearInterval)
      for (const def of definitions) await boss.offWork(def.name).catch(() => undefined)
      log.info('worker stopped')
    },
  }
}
