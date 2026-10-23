/**
 * Background jobs of the catalog module (collected by src/jobs/registry.ts):
 *
 *  - catalog.import — applies a product CSV import above IMPORT_INLINE_MAX_ROWS rows (enqueued by
 *    POST /products/import inside its transaction). Data `{tenant_id, import_id, user_id}`; the
 *    handler is idempotent per import (only pending / processing imports run) and records
 *    progress (imports.processed_rows) chunk by chunk.
 */
import { defineJob, type KadaiJob } from '../../jobs/types'
import { IMPORT_JOB, type ImportJobData, runProductImportJob } from './imports'

export const jobs: readonly KadaiJob[] = [
  defineJob<ImportJobData>({
    name: IMPORT_JOB,
    options: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60 },
    work: { localConcurrency: 1 },
    async handler(job, deps) {
      await runProductImportJob(deps, job.data)
    },
  }),
]
