/**
 * Background jobs of the notifications module (collected by src/jobs/registry.ts):
 *
 *   notifications.send           { tenant_id, notification_id } — one delivery attempt (./send.ts);
 *                                enqueued after commit by core/notify.ts, by retries and the sweep
 *   notifications.sweep          every minute — stuck 'sending' rows and due 'queued' rows
 *   notifications.due-reminders  daily 10:00 IST — khata reminders (./reminders.ts)
 *   notifications.daily-summary  daily 21:30 IST — owners' summary (./daily-summary.ts)
 *
 * Retries of a delivery are the outbox's own (attempts + backoff on the row), so the send job's
 * pg-boss retries only cover infrastructure errors (database down) before the row is claimed.
 * The daily jobs accept an optional { tenant_id } to run for one business (manual runs).
 */
import { zId } from '@kadai/shared/api/common'
import {
  NOTIFICATION_CRONS,
  NOTIFICATION_JOBS,
  type NotificationSendJob,
  NotificationSendJobSchema,
} from '@kadai/shared/api/notifications'
import { z } from 'zod'
import { type KadaiJob, defineJob } from '../../jobs/types'
import { runDailySummary } from './daily-summary'
import { runDueReminders } from './reminders'
import { processNotification, sweepNotifications } from './send'

const TenantScopeSchema = z.object({ tenant_id: zId.optional() }).catch({})

/** `{ tenant_id }` of a manual run → the tenant filter of the fan-out (cron runs: all tenants). */
export function tenantScope(data: unknown): { tenantIds?: string[] } {
  const parsed = TenantScopeSchema.parse(data ?? {})
  return parsed.tenant_id ? { tenantIds: [parsed.tenant_id] } : {}
}

export const jobs: readonly KadaiJob[] = [
  defineJob<NotificationSendJob>({
    name: NOTIFICATION_JOBS.send,
    options: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
    work: { localConcurrency: 4 },
    async handler(job, deps) {
      await processNotification(deps, NotificationSendJobSchema.parse(job.data))
    },
  }),
  defineJob({
    name: NOTIFICATION_JOBS.sweep,
    cron: NOTIFICATION_CRONS.sweep,
    tz: 'Asia/Kolkata',
    options: { retryLimit: 0, expireInSeconds: 120 },
    async handler(_job, deps) {
      await sweepNotifications(deps)
    },
  }),
  defineJob<{ tenant_id?: string }>({
    name: NOTIFICATION_JOBS.dueReminders,
    cron: NOTIFICATION_CRONS.dueReminders,
    tz: 'Asia/Kolkata',
    options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 3600 },
    async handler(job, deps) {
      await runDueReminders(deps, tenantScope(job.data))
    },
  }),
  defineJob<{ tenant_id?: string }>({
    name: NOTIFICATION_JOBS.dailySummary,
    cron: NOTIFICATION_CRONS.dailySummary,
    tz: 'Asia/Kolkata',
    options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 3600 },
    async handler(job, deps) {
      await runDailySummary(deps, tenantScope(job.data))
    },
  }),
]
