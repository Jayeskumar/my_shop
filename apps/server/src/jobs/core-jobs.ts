/**
 * Foundation jobs (ARCHITECTURE.md §14): `core.cleanup` hourly — expired idempotency keys, OTP
 * codes older than a day, refresh sessions revoked/expired more than 30 days ago. Deletes run in
 * bounded batches through the system pool so they never hold long locks.
 */
import { type Kysely, type RawBuilder, sql } from 'kysely'
import type { DB } from '../db/schema.generated'
import { defineJob } from './types'

const BATCH = 5000
const MAX_BATCHES = 200

async function deleteInBatches(
  db: Kysely<DB>,
  statement: (limit: number) => RawBuilder<unknown>,
): Promise<number> {
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await statement(BATCH).execute(db)
    const n = Number(res.numAffectedRows ?? 0n)
    total += n
    if (n < BATCH) break
  }
  return total
}

export interface CleanupResult {
  idempotency_keys: number
  otp_codes: number
  auth_sessions: number
}

/** The cleanup itself (exported for tests and the CLI). */
export async function runCleanup(systemDb: Kysely<DB>): Promise<CleanupResult> {
  const idempotency_keys = await deleteInBatches(
    systemDb,
    (limit) =>
      sql`DELETE FROM idempotency_keys WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at < now() LIMIT ${limit})`,
  )
  const otp_codes = await deleteInBatches(
    systemDb,
    (limit) =>
      sql`DELETE FROM otp_codes WHERE ctid IN (SELECT ctid FROM otp_codes WHERE created_at < now() - interval '1 day' LIMIT ${limit})`,
  )
  const auth_sessions = await deleteInBatches(
    systemDb,
    (limit) => sql`DELETE FROM auth_sessions WHERE ctid IN (
        SELECT ctid FROM auth_sessions
         WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
            OR expires_at < now() - interval '30 days'
         LIMIT ${limit})`,
  )
  return { idempotency_keys, otp_codes, auth_sessions }
}

export const coreJobs = [
  defineJob({
    name: 'core.cleanup',
    cron: '17 * * * *',
    tz: 'Asia/Kolkata',
    options: { retryLimit: 2, policy: 'singleton' },
    async handler(_job, deps) {
      const result = await runCleanup(deps.db.systemDb)
      deps.logger.info({ ...result }, 'core.cleanup done')
    },
  }),
] as const
