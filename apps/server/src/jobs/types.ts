/**
 * Job declaration types for modules (ARCHITECTURE.md §14):
 *
 *   // modules/payments/jobs.ts
 *   export const jobs: readonly KadaiJob[] = [
 *     defineJob<{ tenant_id: string; intent_id: string }>({
 *       name: 'payments.poll-intent',
 *       options: { retryLimit: 5, retryDelay: 3, retryBackoff: true },
 *       async handler(job, deps) {
 *         await withTenant(deps.db.appDb, systemContext(job.data.tenant_id), (tx) => …)
 *       },
 *     }),
 *     defineJob({ name: 'payments.expire-intents', cron: '* * * * *', handler: … }),
 *     defineJob({ name: 'payments.poll-intents', intervalSeconds: 15, handler: … }),
 *   ]
 */
import type { AnyJobDefinition, JobDefinition } from '../core/jobs'
import type { KadaiDeps } from '../core/runtime'

export type { JobRun, JobDefinition } from '../core/jobs'

/** A registered job (payload type erased; handlers validate their own `job.data`). */
export type KadaiJob = AnyJobDefinition<KadaiDeps>

export function defineJob<T = Record<string, unknown>>(def: JobDefinition<T, KadaiDeps>): KadaiJob {
  return def as KadaiJob
}
