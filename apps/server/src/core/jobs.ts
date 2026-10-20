/**
 * Background jobs on pg-boss 10 (ARCHITECTURE.md §14), schema `pgboss`, owner role
 * (DATABASE_SYSTEM_URL).
 *
 * * Modules declare `export const jobs: JobDefinition[]` in modules/<m>/jobs.ts; jobs/registry.ts
 *   collects them. pg-boss 10 requires a queue per job name: the producer (API) and the worker
 *   both create every registered queue (idempotent) before sending/working.
 * * enqueue(name, data, options) can be called from request handlers. With `options.tx` the job
 *   row is inserted in the caller's transaction (it exists only if the business change commits);
 *   for that the runtime role is granted INSERT on pgboss.job when the queue starts.
 * * Schedules: `cron` (5-field, minute resolution, `tz` default Asia/Kolkata) or `intervalSeconds`
 *   for sub-minute periodic jobs (each worker sends a singleton job per interval; pg-boss dedupes
 *   across worker processes).
 */
import { CompiledQuery } from 'kysely'
import type { Kysely } from 'kysely'
import PgBoss from 'pg-boss'
import type { Config } from '../config'
import type { DB } from '../db/schema.generated'
import type { Tx } from '../db/tenant'

export const PGBOSS_SCHEMA = 'pgboss'

export interface JobLogger {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
  debug(obj: object, msg: string): void
}

export interface JobRun<T> {
  id: string
  name: string
  data: T
  /** 0 on the first attempt. */
  retryCount: number
}

export interface JobQueueOptions {
  retryLimit?: number
  /** Seconds. */
  retryDelay?: number
  retryBackoff?: boolean
  expireInSeconds?: number
  retentionMinutes?: number
  policy?: 'standard' | 'short' | 'singleton' | 'stately'
  deadLetter?: string
}

export interface JobWorkOptions {
  /** Concurrent workers for this queue in one process (default 1). */
  localConcurrency?: number
  pollingIntervalSeconds?: number
}

/**
 * A background job. `D` is the worker dependency bag (KadaiDeps); handlers receive
 * `{ tenant_id, … }` payloads and do tenant work inside `withTenant(deps.db.appDb,
 * systemContext(job.data.tenant_id), …)`. Cron jobs fan out over tenants with `systemDb`.
 */
export interface JobDefinition<T = Record<string, unknown>, D = unknown> {
  /** 'module.job-name', e.g. 'payments.poll-intents'. */
  name: string
  handler: (job: JobRun<T>, deps: D) => Promise<void>
  /** 5-field cron. */
  cron?: string
  tz?: 'Asia/Kolkata' | 'UTC'
  /** Payload for cron / interval runs. */
  data?: T
  /** Periodic run every N seconds (5..3600) — for schedules finer than cron's minute. */
  intervalSeconds?: number
  options?: JobQueueOptions
  work?: JobWorkOptions
}

/** Any job definition, regardless of payload type (for registries). */
// The payload type is erased in registries; handlers re-validate their own data.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDefinition<D = unknown> = JobDefinition<any, D>

export interface SendOptions {
  /** Insert the job in this transaction (only enqueued if it commits). */
  tx?: Tx
  /** Delay: seconds, or an absolute time. */
  startAfter?: number | Date
  singletonKey?: string
  singletonSeconds?: number
  priority?: number
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  expireInSeconds?: number
}

export function createBoss(config: Pick<Config, 'database'>, role: 'producer' | 'worker', applicationName = 'kadai'): PgBoss {
  return new PgBoss({
    connectionString: config.database.systemUrl,
    schema: PGBOSS_SCHEMA,
    application_name: `${applicationName}-pgboss`,
    max: role === 'worker' ? 6 : 3,
    // Only workers run maintenance and cron; API processes just produce jobs.
    supervise: role === 'worker',
    schedule: role === 'worker',
    migrate: true,
  })
}

/** pg-boss `db` adapter that runs its SQL inside a Kysely transaction. */
function txAdapter(tx: Tx): PgBoss.Db {
  return {
    async executeSql(text: string, values: unknown[]) {
      const res = await tx.executeQuery(CompiledQuery.raw(text, values))
      return { rows: res.rows as unknown[] as never[] }
    },
  }
}

export class JobQueue {
  private started: Promise<void> | null = null
  private readonly known: Set<string>

  constructor(
    readonly boss: PgBoss,
    /** Queues to create: every registered job (handlers are not needed to produce). */
    private readonly definitions: ReadonlyArray<Pick<AnyJobDefinition, 'name' | 'options'>>,
    private readonly opts: { systemDb: Kysely<DB>; appRole: string; logger?: JobLogger },
  ) {
    this.known = new Set(definitions.map((d) => d.name))
    boss.on('error', (err) => opts.logger?.error({ err }, 'pg-boss error'))
  }

  get names(): readonly string[] {
    return [...this.known]
  }

  /** Starts pg-boss (installs/migrates its schema) and creates every registered queue. Idempotent. */
  start(): Promise<void> {
    this.started ??= (async () => {
      await this.boss.start()
      for (const def of this.definitions) {
        await this.boss.createQueue(def.name, { name: def.name, ...queueOptions(def.options) })
      }
      await this.grantProducerAccess()
    })().catch((err: unknown) => {
      this.started = null
      throw err
    })
    return this.started
  }

  /** Lets the RLS runtime role insert jobs inside business transactions (enqueue with tx). */
  private async grantProducerAccess(): Promise<void> {
    const role = this.opts.appRole
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('invalid app role name')
    try {
      await this.opts.systemDb.executeQuery(CompiledQuery.raw(`GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO ${role}`))
      await this.opts.systemDb.executeQuery(CompiledQuery.raw(`GRANT SELECT ON ${PGBOSS_SCHEMA}.queue TO ${role}`))
      await this.opts.systemDb.executeQuery(CompiledQuery.raw(`GRANT INSERT ON ${PGBOSS_SCHEMA}.job TO ${role}`))
    } catch (err) {
      // Same role for both pools (development) or grant not permitted: transactional enqueue
      // then only works when the app role already has access.
      this.opts.logger?.warn({ err }, 'could not grant pg-boss producer access to the app role')
    }
  }

  /** Sends a job to a registered queue; returns the job id (null when deduplicated). */
  async enqueue(name: string, data: object = {}, options: SendOptions = {}): Promise<string | null> {
    if (!this.known.has(name)) throw new Error(`unknown job "${name}" (add it to a module's jobs.ts)`)
    await this.start()
    const { tx, startAfter, ...rest } = options
    const sendOptions: PgBoss.SendOptions = { ...rest }
    if (startAfter !== undefined) sendOptions.startAfter = startAfter
    if (tx) sendOptions.db = txAdapter(tx)
    return this.boss.send(name, data, sendOptions)
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.started.catch(() => undefined)
    this.started = null
    await this.boss.stop({ graceful: true, wait: true, timeout: 20_000 })
  }
}

export function queueOptions(o: JobQueueOptions = {}): Omit<PgBoss.Queue, 'name'> {
  return {
    policy: o.policy ?? 'standard',
    retryLimit: o.retryLimit ?? 3,
    retryDelay: o.retryDelay ?? 10,
    retryBackoff: o.retryBackoff ?? true,
    expireInSeconds: o.expireInSeconds ?? 15 * 60,
    retentionMinutes: o.retentionMinutes ?? 7 * 24 * 60,
    ...(o.deadLetter ? { deadLetter: o.deadLetter } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// Process-wide queue for module code (set by buildApp / the worker)
// ---------------------------------------------------------------------------------------------

let currentQueue: JobQueue | null = null

export function setJobQueue(queue: JobQueue | null): void {
  currentQueue = queue
}

/** Enqueues a registered job from anywhere (request handlers, services, other jobs). */
export function enqueue(name: string, data: object = {}, options: SendOptions = {}): Promise<string | null> {
  if (!currentQueue) throw new Error('job queue is not initialised (buildApp/startWorker sets it)')
  return currentQueue.enqueue(name, data, options)
}
