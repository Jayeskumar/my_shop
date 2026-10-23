/**
 * Background jobs of the parties module (collected by src/jobs/registry.ts). See src/jobs/types.ts.
 *
 *   parties.loyalty-expiry          daily 02:40 IST — fans out one tenant job per tenant with
 *                                   loyalty enabled and settings.loyalty.expiry_days set
 *   parties.loyalty-expiry-tenant   {tenant_id, date?} — expires that tenant's points (FIFO)
 */
import { isDateStr, isUuid } from '@kadai/shared'
import { enqueue } from '../../core/jobs'
import { defineJob, type KadaiJob } from '../../jobs/types'
import {
  LOYALTY_EXPIRY_JOB,
  LOYALTY_EXPIRY_TENANT_JOB,
  expireTenantLoyalty,
  loyaltyExpiryTenants,
} from './loyalty-expiry'

export interface LoyaltyExpiryTenantJob {
  tenant_id: string
  /** Business date to expire as of (default: today in the tenant timezone). */
  date?: string
}

export const jobs: readonly KadaiJob[] = [
  defineJob({
    name: LOYALTY_EXPIRY_JOB,
    cron: '40 2 * * *',
    tz: 'Asia/Kolkata',
    options: { retryLimit: 2, policy: 'singleton' },
    async handler(_job, deps) {
      const tenants = await loyaltyExpiryTenants(deps)
      for (const tenantId of tenants) {
        await enqueue(
          LOYALTY_EXPIRY_TENANT_JOB,
          { tenant_id: tenantId } satisfies LoyaltyExpiryTenantJob,
          { singletonKey: tenantId, singletonSeconds: 3600 },
        )
      }
      deps.logger.info({ tenants: tenants.length }, 'parties.loyalty-expiry fanned out')
    },
  }),
  defineJob<LoyaltyExpiryTenantJob>({
    name: LOYALTY_EXPIRY_TENANT_JOB,
    options: { retryLimit: 3, retryDelay: 60, retryBackoff: true },
    async handler(job, deps) {
      const { tenant_id: tenantId, date } = job.data
      if (!isUuid(tenantId)) throw new Error(`${LOYALTY_EXPIRY_TENANT_JOB}: invalid tenant_id`)
      if (date !== undefined && !isDateStr(date))
        throw new Error(`${LOYALTY_EXPIRY_TENANT_JOB}: invalid date`)
      const result = await expireTenantLoyalty(deps, tenantId, date ? { today: date } : {})
      deps.logger.info({ ...result }, 'parties.loyalty-expiry-tenant done')
    },
  }),
]
