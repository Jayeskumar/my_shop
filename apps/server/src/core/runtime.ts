/**
 * Process runtime: every long-lived dependency of the API and the worker in one bag
 * (`app.kadai` in route handlers, the `deps` argument of job handlers).
 *
 * createDeps() builds it; installRuntime() wires the process-wide hooks used by module code
 * (entitlements helpers, enqueue(), tx hook logging); destroyDeps() closes everything.
 */
import type { Config } from '../config'
import { configWarnings } from '../config'
import { type Databases, createDatabases } from '../db'
import { setTxHookErrorHandler } from '../db/tenant'
import { VERSION } from '../version'
import { SecretBox } from './crypto'
import { EntitlementsService, setEntitlementsService } from './entitlements'
import { EventBus } from './events'
import { FileService, type FileStorage, createFileStorage } from './files'
import { type AnyJobDefinition, JobQueue, createBoss, setJobQueue } from './jobs'
import { type Logger, createLogger } from './logger'
import { type KadaiMetrics, createMetrics } from './metrics'
import { type OtpSender, OtpService, createOtpSender } from './otp'
import { RbacService } from './rbac'
import { SessionCache } from './session-cache'

export interface KadaiDeps {
  config: Config
  version: string
  logger: Logger
  db: Databases
  events: EventBus
  /** pg-boss producer (API) or worker queue; `deps.jobs.enqueue(name, data, opts)`. */
  jobs: JobQueue
  files: FileService
  crypto: SecretBox
  otp: OtpService
  otpSender: OtpSender
  rbac: RbacService
  sessions: SessionCache
  entitlements: EntitlementsService
  metrics: KadaiMetrics
}

export interface CreateDepsOptions {
  logger?: Logger
  /** 'kadai-api' / 'kadai-worker' (DB application_name). */
  applicationName?: string
  /** Every registered job (jobs/registry.ts) — queues are created for these. */
  jobDefinitions?: readonly AnyJobDefinition<KadaiDeps>[]
  /** 'worker' runs pg-boss maintenance and schedules. */
  jobRole?: 'producer' | 'worker'
  otpSender?: OtpSender
  fileStorage?: FileStorage
  /** Collect Node default metrics (off in tests to keep registries light). */
  defaultMetrics?: boolean
  /** system_settings key of the on-prem license (default 'license'). */
  licenseSettingsKey?: string
}

export function createDeps(config: Config, opts: CreateDepsOptions = {}): KadaiDeps {
  const logger = opts.logger ?? createLogger(config, VERSION)
  for (const w of configWarnings(config)) logger.warn(w)
  const db = createDatabases(config, {
    applicationName: opts.applicationName ?? 'kadai',
    onPoolError: (err, pool) => logger.error({ err, pool }, 'database pool error'),
  })
  const events = new EventBus({ pool: db.systemPool, logger })
  const jobs = new JobQueue(createBoss(config, opts.jobRole ?? 'producer', opts.applicationName), opts.jobDefinitions ?? [], {
    systemDb: db.systemDb,
    appRole: config.database.appRole,
    logger,
  })
  const otpSender = opts.otpSender ?? createOtpSender(config, logger)
  const metrics = createMetrics({ version: VERSION, mode: config.mode, defaultMetrics: opts.defaultMetrics })
  metrics.observePools({ app: db.appPool, system: db.systemPool })
  const deps: KadaiDeps = {
    config,
    version: VERSION,
    logger,
    db,
    events,
    jobs,
    files: new FileService(opts.fileStorage ?? createFileStorage(config)),
    crypto: new SecretBox(config.encryptionKeys),
    otp: new OtpService({ systemDb: db.systemDb, config, sender: otpSender }),
    otpSender,
    rbac: new RbacService(db.appDb),
    sessions: new SessionCache(db.systemDb),
    entitlements: new EntitlementsService({ config, systemDb: db.systemDb, licenseSettingsKey: opts.licenseSettingsKey }),
    metrics,
  }
  // Cross-process cache invalidation (NOTIFY kadai_cache).
  deps.rbac.listen(events)
  deps.sessions.listen(events)
  deps.entitlements.listen(events)
  return deps
}

/** Installs the process-wide hooks module code relies on (one runtime per process). */
export function installRuntime(deps: KadaiDeps): void {
  setEntitlementsService(deps.entitlements)
  setJobQueue(deps.jobs)
  setTxHookErrorHandler((err, phase) => deps.logger.error({ err }, `transaction ${phase} hook failed`))
}

/** Stops the event bus and job queue and closes both pools. */
export async function destroyDeps(deps: KadaiDeps): Promise<void> {
  await deps.events.stop().catch((err: unknown) => deps.logger.warn({ err }, 'event bus stop failed'))
  await deps.jobs.stop().catch((err: unknown) => deps.logger.warn({ err }, 'job queue stop failed'))
  await deps.db.destroy()
}
