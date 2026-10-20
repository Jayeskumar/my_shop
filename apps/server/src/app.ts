/**
 * buildApp(config, options) — the configured Fastify instance used by server.ts and by tests
 * (`app.inject`). Registration order follows ARCHITECTURE.md §7.1:
 *
 *   zod validator/serializer → body parsers (raw body for /webhooks) → 1 request context →
 *   2 security (helmet, cors, cookie, rate limit) → 3 error handler → 4 auth → 5 metrics, health →
 *   6 swagger → multipart → 7 modules (/api/v1, /public/v1, /webhooks) → 8 static web app
 */
import multipart from '@fastify/multipart'
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify'
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import type { Config } from './config'
import { MAX_UPLOAD_BYTES } from './core/files'
import type { KadaiInstance } from './core/http'
import {
  type CreateDepsOptions,
  type KadaiDeps,
  createDeps,
  destroyDeps,
  installRuntime,
} from './core/runtime'
import { JOB_DEFINITIONS } from './jobs/registry'
import type { KadaiJob } from './jobs/types'
import { MODULES, type KadaiModule, registerModules } from './modules'
import { registerAuth } from './plugins/auth'
import { registerBodyParsers } from './plugins/body-parsers'
import { registerErrorHandler } from './plugins/error-handler'
import './plugins/fastify-types'
import { type HealthOptions, registerHealth } from './plugins/health'
import { registerMetrics } from './plugins/metrics'
import { genRequestId, registerRequestContext } from './plugins/request-context'
import { registerSecurity } from './plugins/security'
import { type SpaFallback, registerStaticWeb } from './plugins/static-web'
import { registerSwagger } from './plugins/swagger'

export interface BuildAppOptions {
  /** Use existing deps (embedded worker shares them; tests may inject). Not destroyed on close. */
  deps?: KadaiDeps
  /** Options for createDeps() when `deps` is not given (otp sender, file storage, …). */
  depsOptions?: CreateDepsOptions
  /** Business modules (default: all of MODULES). Tests add fixture modules here. */
  modules?: readonly KadaiModule[]
  /** Job definitions whose queues the producer creates (default: JOB_DEFINITIONS). */
  jobDefinitions?: readonly KadaiJob[]
  health?: HealthOptions
}

export type KadaiApp = KadaiInstance

function trustHops(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops
}

export async function buildApp(config: Config, options: BuildAppOptions = {}): Promise<KadaiApp> {
  const jobDefinitions = options.jobDefinitions ?? JOB_DEFINITIONS
  const ownsDeps = !options.deps
  const deps =
    options.deps ??
    createDeps(config, {
      applicationName: 'kadai-api',
      jobDefinitions,
      ...options.depsOptions,
    })
  installRuntime(deps)

  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    genReqId: genRequestId,
    requestIdHeader: false,
    // One access-log line per request is written by plugins/request-context.ts instead.
    logController: new LogController({
      requestIdLogLabel: 'request_id',
      disableRequestLogging: true,
    }),
    // A hop count is expressed as a function (Fastify's types omit the numeric form).
    trustProxy:
      typeof config.trustProxy === 'number' ? trustHops(config.trustProxy) : config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.decorate('kadai', deps)

  const root = app as unknown as FastifyInstance
  registerBodyParsers(root)
  registerRequestContext(root) // 1
  const security = await registerSecurity(root, config) // 2

  // 3 — the SPA fallback is resolved later (static plugin), but the handler is installed now.
  let spaFallback: SpaFallback | null = null
  registerErrorHandler(root, {
    exposeInternalErrors: !config.isProduction,
    notFoundFallback: async (req, reply) => (spaFallback ? spaFallback(req, reply) : false),
  })

  registerAuth(root, deps) // 4
  registerMetrics(root, deps) // 5
  registerHealth(root, deps, options.health)
  if (config.apiDocs) await registerSwagger(root, config, deps.version) // 6

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20, fieldSize: 64 * 1024, parts: 25 },
  })

  await registerModules(root, options.modules ?? MODULES) // 7

  if (config.serveWeb) spaFallback = await registerStaticWeb(root, config.webDistDir) // 8

  app.addHook('onReady', async () => {
    // LISTEN for cache invalidations / payment intent events; retries in the background.
    await deps.events.start()
  })
  app.addHook('onClose', async () => {
    await security.redis?.quit().catch(() => undefined)
    if (ownsDeps) await destroyDeps(deps)
  })

  return app
}
