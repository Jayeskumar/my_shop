/**
 * Background jobs of the reports module (collected by src/jobs/registry.ts). See src/jobs/types.ts.
 *
 * None: every report is a read-only SQL aggregate computed on request inside the caller's tenant
 * transaction (no pre-computed snapshots to refresh). Scheduled digests that use report figures
 * (daily summary, low stock / expiry) belong to the notifications and inventory modules.
 */
import type { KadaiJob } from '../../jobs/types'

export const jobs: readonly KadaiJob[] = []
