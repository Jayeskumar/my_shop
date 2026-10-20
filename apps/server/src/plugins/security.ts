/**
 * HTTP security (ARCHITECTURE.md §7.1 step 2, §17): helmet headers with a CSP that works for the
 * React SPA, CORS allow-list, cookies, rate limits.
 *
 * Rate limits run at `preValidation`, i.e. after authentication, so the global limit (600/min) is
 * per user (or API key) and only anonymous traffic is keyed by IP — a supermarket's counters
 * behind one public IP do not starve each other. Routes tighten it with
 * `config: { rateLimit: RATE_LIMITS.login }` (core/http.ts). With REDIS_URL the counters are
 * shared by every API pod; if Redis is unavailable requests are let through (fail open).
 */
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Redis } from 'ioredis'
import type { Config } from '../config'
import { deriveKey } from '../core/crypto'
import { rateLimited } from '../core/errors'

export interface SecurityHandles {
  redis: Redis | null
}

const RATE_LIMITED_PREFIXES = ['/api/', '/public/', '/webhooks/']
const NO_STORE_PREFIXES = ['/api/', '/public/', '/webhooks/']

function rateLimitKey(req: FastifyRequest): string {
  const auth = req.auth
  if (auth?.kind === 'user') return `u:${auth.userId}`
  if (auth?.kind === 'api_key') return `k:${auth.apiKeyId}`
  return `ip:${req.ip}`
}

export async function registerSecurity(
  app: FastifyInstance,
  config: Config,
): Promise<SecurityHandles> {
  const https = config.publicBaseUrl.startsWith('https://')
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'script-src': ["'self'"],
        // Tailwind / Radix set inline style attributes.
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'worker-src': ["'self'", 'blob:'],
        'manifest-src': ["'self'"],
        'media-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        // On-prem LAN installs are plain http: upgrading would break them.
        ...(https ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    // The POS opens a customer-display window and prints via the browser.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: https ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })

  await app.register(cors, {
    // Empty allow-list = same-origin only (no CORS headers at all).
    origin: config.corsOrigins.length ? [...config.corsOrigins] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'x-request-id',
      'x-requested-with',
      'x-api-key',
      'x-locale',
    ],
    exposedHeaders: [
      'x-request-id',
      'idempotent-replayed',
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'content-disposition',
    ],
    maxAge: 600,
  })

  // API answers carry tenant data and tokens: never let browsers or shared proxies store them
  // (RFC 9111). Routes that want caching set their own Cache-Control. The PWA's runtime cache
  // (Cache API) is unaffected.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('cache-control') && NO_STORE_PREFIXES.some((p) => req.url.startsWith(p)))
      reply.header('cache-control', 'no-store')
    return payload
  })

  await app.register(cookie, {
    secret: deriveKey(config.auth.jwtSecret, 'cookie').toString('base64url'),
  })

  let redis: Redis | null = null
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    })
    redis.on('error', (err) => app.log.warn({ err }, 'redis error (rate limits fail open)'))
  }

  await app.register(rateLimit, {
    global: true,
    hook: 'preValidation',
    max: config.rateLimit.globalMax,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
    allowList: (req) => !RATE_LIMITED_PREFIXES.some((p) => req.url.startsWith(p)),
    ...(redis ? { redis, nameSpace: 'kadai-rl:', skipOnError: true } : {}),
    errorResponseBuilder: (_req, ctx) => rateLimited(Math.max(1, Math.ceil(ctx.ttl / 1000))),
  })

  return { redis }
}
