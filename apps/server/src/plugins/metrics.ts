/**
 * Prometheus endpoint & HTTP histograms (ARCHITECTURE.md §7.8). `GET /metrics` requires
 * `Authorization: Bearer <METRICS_TOKEN>` when METRICS_TOKEN is set.
 */
import type { FastifyInstance } from 'fastify'
import { timingSafeEqualStr } from '../core/crypto'
import { unauthenticated } from '../core/errors'
import type { KadaiDeps } from '../core/runtime'

export function registerMetrics(app: FastifyInstance, deps: KadaiDeps): void {
  const { metrics, config } = deps

  app.addHook('onResponse', async (req, reply) => {
    metrics.httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'unmatched', status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    )
  })

  app.get('/metrics', { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    if (config.metricsToken) {
      const token = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? ''
      if (!timingSafeEqualStr(token, config.metricsToken)) throw unauthenticated('Metrics token required')
    }
    const body = await metrics.registry.metrics()
    return reply.type(metrics.registry.contentType).header('cache-control', 'no-store').send(body)
  })
}
