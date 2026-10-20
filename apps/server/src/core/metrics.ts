/**
 * Prometheus metrics (ARCHITECTURE.md §7.8). One registry per process runtime (not prom-client's
 * global default), so tests can build several apps. Modules increment the business counters
 * through `deps.metrics` (e.g. `deps.metrics.invoicesCreated.inc({ channel: 'pos' })`).
 */
import type pg from 'pg'
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export interface KadaiMetrics {
  registry: Registry
  httpDuration: Histogram<'method' | 'route' | 'status_code'>
  jobsProcessed: Counter<'name' | 'status'>
  jobDuration: Histogram<'name'>
  invoicesCreated: Counter<'channel'>
  paymentIntents: Counter<'provider' | 'status'>
  /** Registers pool gauges (total/idle/waiting connections per pool). */
  observePools(pools: Record<string, pg.Pool>): void
}

export function createMetrics(opts: {
  version: string
  mode: string
  defaultMetrics?: boolean
}): KadaiMetrics {
  const registry = new Registry()
  registry.setDefaultLabels({ app: 'kadai' })
  if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: registry, prefix: 'kadai_' })

  new Gauge({
    name: 'kadai_build_info',
    help: 'Build information',
    labelNames: ['version', 'mode'],
    registers: [registry],
  }).set({ version: opts.version, mode: opts.mode }, 1)

  const httpDuration = new Histogram({
    name: 'kadai_http_request_duration_seconds',
    help: 'HTTP request duration by route',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  })
  const jobsProcessed = new Counter({
    name: 'kadai_jobs_processed_total',
    help: 'Background jobs processed',
    labelNames: ['name', 'status'] as const,
    registers: [registry],
  })
  const jobDuration = new Histogram({
    name: 'kadai_job_duration_seconds',
    help: 'Background job duration',
    labelNames: ['name'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
    registers: [registry],
  })
  const invoicesCreated = new Counter({
    name: 'kadai_invoices_created_total',
    help: 'Sales invoices completed',
    labelNames: ['channel'] as const,
    registers: [registry],
  })
  const paymentIntents = new Counter({
    name: 'kadai_payment_intents_total',
    help: 'Payment intent outcomes',
    labelNames: ['provider', 'status'] as const,
    registers: [registry],
  })

  const pools: Record<string, pg.Pool> = {}
  new Gauge({
    name: 'kadai_db_pool_connections',
    help: 'Database pool connections',
    labelNames: ['pool', 'state'] as const,
    registers: [registry],
    collect() {
      for (const [name, pool] of Object.entries(pools)) {
        this.set({ pool: name, state: 'total' }, pool.totalCount)
        this.set({ pool: name, state: 'idle' }, pool.idleCount)
        this.set({ pool: name, state: 'waiting' }, pool.waitingCount)
      }
    },
  })

  return {
    registry,
    httpDuration,
    jobsProcessed,
    jobDuration,
    invoicesCreated,
    paymentIntents,
    observePools(p) {
      Object.assign(pools, p)
    },
  }
}
