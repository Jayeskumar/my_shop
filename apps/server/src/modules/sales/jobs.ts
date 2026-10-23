/**
 * Background jobs of the sales module (collected by src/jobs/registry.ts). See src/jobs/types.ts.
 *
 *  - sales.prune-pos-tombstones (daily 03:41 IST): deletes POS delta-sync tombstones older than the
 *    retention. Registers whose cursor is older than CURSOR_MAX_AGE_MS get a full bootstrap
 *    anyway, so tombstones are only needed for that long (plus a safety margin).
 */
import { type Kysely, sql } from 'kysely'
import type { DB } from '../../db/schema.generated'
import { type KadaiJob, defineJob } from '../../jobs/types'
import { CURSOR_MAX_AGE_MS } from './constants'

/** Tombstones are kept twice as long as a delta cursor is accepted. */
export const TOMBSTONE_RETENTION_DAYS = Math.ceil((2 * CURSOR_MAX_AGE_MS) / 86_400_000)
const BATCH = 5000
const MAX_BATCHES = 200

/**
 * Deletes expired tombstones in bounded batches. Runs on the system pool: the cleanup spans every
 * tenant (ARCHITECTURE.md §6.1 "job fan-out across tenants") and touches no business data.
 */
export async function prunePosTombstones(
  systemDb: Kysely<DB>,
  retentionDays = TOMBSTONE_RETENTION_DAYS,
): Promise<number> {
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await sql`DELETE FROM pos_tombstones WHERE id IN (
        SELECT id FROM pos_tombstones
         WHERE deleted_at < now() - make_interval(days => ${retentionDays})
         LIMIT ${BATCH})`.execute(systemDb)
    const n = Number(res.numAffectedRows ?? 0n)
    total += n
    if (n < BATCH) break
  }
  return total
}

export const jobs: readonly KadaiJob[] = [
  defineJob({
    name: 'sales.prune-pos-tombstones',
    cron: '41 3 * * *',
    tz: 'Asia/Kolkata',
    options: { retryLimit: 2, policy: 'singleton' },
    async handler(_job, deps) {
      const deleted = await prunePosTombstones(deps.db.systemDb)
      deps.logger.info({ deleted }, 'sales.prune-pos-tombstones done')
    },
  }),
]
