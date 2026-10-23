/**
 * Background jobs of the payments module (collected by src/jobs/registry.ts; ARCHITECTURE.md §14):
 *
 *  - payments.poll-intents    every 15 s (+ self-rescheduled a few seconds ahead while polls are
 *                             due sooner): status polling of pending dynamic-QR / link intents
 *                             with backoff 3 s → 5 s → 10 s → 30 s (works on-prem without a
 *                             public webhook URL).
 *  - payments.expire-intents  every minute: expires open intents past expires_at (after a last
 *                             status check) and closes their QR / link at the provider; retries
 *                             failed closes.
 *  - payments.process-webhook on webhook (data {webhook_event_id}): retries a stored event whose
 *                             inline processing failed; every minute without data it sweeps the
 *                             unprocessed events.
 */
import { z } from 'zod'
import { type KadaiJob, defineJob } from '../../jobs/types'
import { POLL_JOB } from './intents'
import { expireDueIntents, pollDueIntents } from './polling'
import { PROCESS_WEBHOOK_JOB, processWebhookEvent, sweepWebhookEvents } from './webhooks'

const ProcessWebhookData = z.object({ webhook_event_id: z.uuid().optional() })

export const jobs: readonly KadaiJob[] = [
  defineJob({
    name: POLL_JOB,
    intervalSeconds: 15,
    options: { retryLimit: 0, expireInSeconds: 5 * 60 },
    async handler(_job, deps) {
      const counts = await pollDueIntents(deps)
      if (counts.paid || counts.error) deps.logger.info({ counts }, 'payments: intents polled')
    },
  }),
  defineJob({
    name: 'payments.expire-intents',
    cron: '* * * * *',
    tz: 'Asia/Kolkata',
    options: { retryLimit: 0, expireInSeconds: 5 * 60 },
    async handler(_job, deps) {
      const out = await expireDueIntents(deps)
      if (out.expired || out.paid || out.close_failed) {
        deps.logger.info(out, 'payments: intents expired')
      }
    },
  }),
  defineJob<{ webhook_event_id?: string }>({
    name: PROCESS_WEBHOOK_JOB,
    cron: '* * * * *',
    tz: 'Asia/Kolkata',
    options: { retryLimit: 5, retryDelay: 10, retryBackoff: true },
    async handler(job, deps) {
      const data = ProcessWebhookData.parse(job.data ?? {})
      if (!data.webhook_event_id) {
        const swept = await sweepWebhookEvents(deps)
        if (swept.processed || swept.failed) {
          deps.logger.info(swept, 'payments: webhook events swept')
        }
        return
      }
      const outcome = await processWebhookEvent(deps, data.webhook_event_id)
      // Throwing lets pg-boss retry with backoff; the sweep picks up what is left after that.
      if (outcome.status === 'failed') throw outcome.error
    },
  }),
]
