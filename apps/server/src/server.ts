/**
 * HTTP entry point (`node dist/server.js`, `pnpm --filter @kadai/server dev`).
 *
 * loadConfig → optional migrations (KADAI_MIGRATE_ON_BOOT, default on-prem) → buildApp → listen →
 * embedded worker (KADAI_EMBEDDED_WORKER, default on-prem) → graceful shutdown on SIGINT/SIGTERM
 * (close-with-grace: stop accepting, drain requests, stop worker, close LISTEN/pg-boss/pools).
 */
import closeWithGrace from 'close-with-grace'
import { buildApp } from './app'
import { ConfigError, loadConfig } from './config'
import { createLogger } from './core/logger'
import { createDeps, destroyDeps } from './core/runtime'
import { migrate } from './db/migrator'
import { JOB_DEFINITIONS } from './jobs/registry'
import { type RunningWorker, startWorker } from './jobs/worker-runtime'
import { VERSION } from './version'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config, VERSION)

  if (config.migrateOnBoot) {
    await migrate({
      connectionString: config.database.systemUrl,
      appRole: config.database.appRole,
      logger: {
        info: (m) => logger.info(`[migrate] ${m}`),
        warn: (m) => logger.warn(`[migrate] ${m}`),
      },
    })
  }

  // One runtime for API + embedded worker (shared pools, one pg-boss instance).
  const deps = createDeps(config, {
    logger,
    applicationName: 'kadai-api',
    jobDefinitions: JOB_DEFINITIONS,
    jobRole: config.embeddedWorker ? 'worker' : 'producer',
  })
  const app = await buildApp(config, { deps })
  let worker: RunningWorker | null = null

  closeWithGrace({ delay: 25_000, logger }, async ({ signal, err }) => {
    if (err) logger.error({ err }, 'shutting down after fatal error')
    else logger.info({ signal }, 'shutting down')
    await worker?.stop()
    await app.close()
    await destroyDeps(deps)
  })

  await app.listen({ port: config.port, host: config.host })
  // mode and version are already on every log line (logger base fields).
  logger.info({ port: config.port, embedded_worker: config.embeddedWorker }, 'Kadai server started')
  if (config.embeddedWorker) worker = await startWorker(deps, JOB_DEFINITIONS)
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err)
  process.exit(1)
})
