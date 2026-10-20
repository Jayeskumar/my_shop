/**
 * Dedicated background worker entry point (`node dist/worker.js`; cloud runs M worker pods).
 * On-prem usually runs the worker inside the API process instead (KADAI_EMBEDDED_WORKER).
 */
import closeWithGrace from 'close-with-grace'
import { ConfigError, loadConfig } from './config'
import { createLogger } from './core/logger'
import { createDeps, destroyDeps, installRuntime } from './core/runtime'
import { JOB_DEFINITIONS } from './jobs/registry'
import { startWorker } from './jobs/worker-runtime'
import { VERSION } from './version'

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config, VERSION)
  const deps = createDeps(config, {
    logger,
    applicationName: 'kadai-worker',
    jobDefinitions: JOB_DEFINITIONS,
    jobRole: 'worker',
  })
  installRuntime(deps)
  await deps.events.start()
  const worker = await startWorker(deps, JOB_DEFINITIONS)
  closeWithGrace({ delay: 30_000, logger }, async ({ signal, err }) => {
    if (err) logger.error({ err }, 'worker shutting down after fatal error')
    else logger.info({ signal }, 'worker shutting down')
    await worker.stop()
    await destroyDeps(deps)
  })
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err)
  process.exit(1)
})
