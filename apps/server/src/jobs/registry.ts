/**
 * Job registry (ARCHITECTURE.md §14): every module's `jobs` plus the foundation jobs. Pre-wired;
 * module owners only edit modules/<m>/jobs.ts. Job names must be unique ('module.job-name').
 */
import { jobs as accountingJobs } from '../modules/accounting/jobs'
import { jobs as authJobs } from '../modules/auth/jobs'
import { jobs as catalogJobs } from '../modules/catalog/jobs'
import { jobs as identityJobs } from '../modules/identity/jobs'
import { jobs as inventoryJobs } from '../modules/inventory/jobs'
import { jobs as notificationsJobs } from '../modules/notifications/jobs'
import { jobs as partiesJobs } from '../modules/parties/jobs'
import { jobs as paymentsJobs } from '../modules/payments/jobs'
import { jobs as platformJobs } from '../modules/platform/jobs'
import { jobs as purchasesJobs } from '../modules/purchases/jobs'
import { jobs as reportsJobs } from '../modules/reports/jobs'
import { jobs as salesJobs } from '../modules/sales/jobs'
import { coreJobs } from './core-jobs'
import type { KadaiJob } from './types'

const JOB_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9._-]*$/

export function buildRegistry(groups: ReadonlyArray<readonly KadaiJob[]>): readonly KadaiJob[] {
  const all = groups.flat()
  const seen = new Set<string>()
  for (const job of all) {
    if (!JOB_NAME_RE.test(job.name))
      throw new Error(`invalid job name "${job.name}" (expected module.job-name)`)
    if (seen.has(job.name)) throw new Error(`duplicate job name "${job.name}"`)
    if (
      job.intervalSeconds !== undefined &&
      (job.intervalSeconds < 5 || job.intervalSeconds > 3600)
    ) {
      throw new Error(`job "${job.name}": intervalSeconds must be 5..3600`)
    }
    if (job.cron && job.intervalSeconds)
      throw new Error(`job "${job.name}": use cron or intervalSeconds, not both`)
    seen.add(job.name)
  }
  return Object.freeze(all)
}

export const JOB_DEFINITIONS: readonly KadaiJob[] = buildRegistry([
  coreJobs,
  authJobs,
  identityJobs,
  catalogJobs,
  partiesJobs,
  inventoryJobs,
  salesJobs,
  paymentsJobs,
  purchasesJobs,
  accountingJobs,
  reportsJobs,
  notificationsJobs,
  platformJobs,
])
