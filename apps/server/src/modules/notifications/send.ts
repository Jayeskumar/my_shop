/**
 * Sending side of the outbox (ARCHITECTURE.md §15): job `notifications.send` and the one-minute
 * sweep. The enqueue side is core/notify.ts enqueueNotification().
 *
 * One delivery attempt:
 *   1. tenant tx — claim the row atomically (queued → sending, attempts + 1; a duplicate job or a
 *      second worker finds nothing to claim), then decide whether it may be sent at all:
 *        plan feature 'notifications' (SMS / WhatsApp), settings.notifications switches of the
 *        owner digests, the customer's WhatsApp opt-in, a provider for the channel (production:
 *        a live one) → otherwise status 'cancelled' with the reason;
 *      render with the tenant override or the default (buildOutboundMessage: WhatsApp template
 *      params sanitised, bodies length-limited; SMS = the DLT text) and store the rendered body;
 *   2. no transaction — call the provider (timeout NOTIFICATION_PROVIDER_TIMEOUT_MS);
 *   3. tenant tx — record the outcome, guarded by (status 'sending', same attempt):
 *        ok → sent / delivered, provider message id, usage_counters 'sms' / 'whatsapp' / 'email'
 *             (live providers only);
 *        retryable error and attempts < NOTIFICATION_MAX_ATTEMPTS → back to 'queued' with
 *             scheduled_at = now + notificationRetryDelaySeconds(attempts) (or the provider's
 *             Retry-After when longer), and a delayed send job after commit;
 *        otherwise → 'failed'.
 *
 * The error column holds `<NotificationErrorCode>: <detail>`.
 */
import { LocaleSchema, type NotificationChannel, NotificationChannelSchema } from '@kadai/shared'
import {
  NOTIFICATION_ERROR_CODES,
  NOTIFICATION_JOBS,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_STUCK_AFTER_SECONDS,
  NOTIFICATION_TEMPLATES,
  NOTIFICATION_USAGE_METRIC,
  type NotificationErrorCode,
  type NotificationProvider,
  type NotificationProviderError,
  type NotificationSendJob,
  type NotificationTemplateCode,
  type OutboundMessage,
  type TemplateOverride,
  buildOutboundMessage,
  isTemplateCode,
  notificationRetryDelaySeconds,
  requiresWhatsAppOptIn,
  sendWithProvider,
} from '@kadai/shared/api/notifications'
import { sql } from 'kysely'
import { type RequestContext, systemContext } from '../../core/context'
import { incrementUsage } from '../../core/entitlements'
import { enqueue } from '../../core/jobs'
import { kickSendJob } from '../../core/notify'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import { type Tx, afterCommit, withTenant } from '../../db/tenant'
import { paramsOf } from './outbox'
import { installNotificationProviders, isLiveProvider } from './providers'

type SendDeps = Pick<KadaiDeps, 'db' | 'config' | 'logger' | 'entitlements'>

export type SendOutcome =
  | { kind: 'skipped' }
  | { kind: 'cancelled'; reason: NotificationErrorCode }
  | { kind: 'sent'; status: 'sent' | 'delivered'; provider: string }
  | { kind: 'retry'; attempts: number; next_at: Date; error: string }
  | { kind: 'failed'; error: string }

/** `<code>: <detail>` for the error column (≤ 1000 characters). */
export function errorText(code: NotificationErrorCode, detail?: string | null): string {
  return (detail ? `${code}: ${detail}` : code).slice(0, 1000)
}

/** Maps a provider error code onto NOTIFICATION_ERROR_CODES ('unknown' → provider_error). */
export function errorCodeOf(err: NotificationProviderError): NotificationErrorCode {
  return (NOTIFICATION_ERROR_CODES as readonly string[]).includes(err.code)
    ? (err.code as NotificationErrorCode)
    : 'provider_error'
}

/** Templates switched off by a settings.notifications toggle (owner digests). */
function disabledBySettings(
  code: NotificationTemplateCode,
  s: { daily_summary_to_owner: boolean; low_stock_digest: boolean },
): boolean {
  if (code === 'daily_summary') return !s.daily_summary_to_owner
  if (code === 'low_stock_digest' || code === 'expiry_digest') return !s.low_stock_digest
  return false
}

/**
 * True when the notification goes to a customer who opted out of WhatsApp: the customer of the
 * source document (ref customer / sales invoice) or the customer with that mobile number.
 */
async function customerOptedOut(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  row: { ref_type: string | null; ref_id: string | null; recipient: string },
): Promise<boolean> {
  let customerId: string | null = null
  if (row.ref_id && row.ref_type === 'customer') customerId = row.ref_id
  else if (row.ref_id && row.ref_type === 'sales_invoice') {
    const inv = await tx
      .selectFrom('sales_invoices')
      .select('customer_id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', row.ref_id)
      .executeTakeFirst()
    customerId = inv?.customer_id ?? null
  }
  const q = tx
    .selectFrom('customers')
    .select('whatsapp_opt_in')
    .where('tenant_id', '=', ctx.tenantId)
  const rows = await (
    customerId
      ? q.where((eb) => eb.or([eb('id', '=', customerId), eb('phone', '=', row.recipient)]))
      : q.where('phone', '=', row.recipient)
  ).execute()
  return rows.some((r) => !r.whatsapp_opt_in)
}

/** URL-button suffix: the {{link}} param below PUBLIC_BASE_URL for templates configured with one. */
function buttonUrlParam(
  deps: SendDeps,
  code: NotificationTemplateCode,
  params: Readonly<Record<string, unknown>>,
): string | null {
  if (!deps.config.whatsapp.urlButtonTemplates.includes(code)) return null
  const link = params.link
  const base = `${deps.config.publicBaseUrl}/`
  return typeof link === 'string' && link.startsWith(base) && link.length > base.length
    ? link.slice(base.length)
    : null
}

interface Prepared {
  ctx: RequestContext
  id: string
  attempts: number
  channel: NotificationChannel
  provider: NotificationProvider
  message: OutboundMessage
}

async function finish(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  id: string,
  attempts: number,
  set: { status: 'cancelled' | 'failed'; error: string; provider?: string | null },
): Promise<void> {
  await tx
    .updateTable('notifications')
    .set({
      status: set.status,
      error: set.error,
      provider: set.provider ?? null,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .where('status', '=', 'sending')
    .where('attempts', '=', attempts)
    .execute()
}

/** Delivers one notification (see the module comment). Never throws for provider failures. */
export async function processNotification(
  deps: SendDeps,
  job: NotificationSendJob,
): Promise<SendOutcome> {
  const registry = installNotificationProviders(deps.config, deps.logger)
  const ctx = systemContext(job.tenant_id, {
    requestId: `job:notifications.send:${job.notification_id}`,
  })

  const prepared = await withTenant(
    deps.db.appDb,
    ctx,
    async (tx): Promise<Prepared | SendOutcome> => {
      const row = await tx
        .updateTable('notifications')
        .set({
          status: 'sending',
          attempts: sql<number>`attempts + 1`,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', job.tenant_id)
        .where('id', '=', job.notification_id)
        .where('status', '=', 'queued')
        .where('scheduled_at', '<=', sql<Date>`now() + interval '5 seconds'`)
        .returningAll()
        .executeTakeFirst()
      if (!row) return { kind: 'skipped' }
      const cancel = async (
        reason: NotificationErrorCode,
        detail?: string,
      ): Promise<SendOutcome> => {
        await finish(tx, ctx, row.id, row.attempts, {
          status: 'cancelled',
          error: errorText(reason, detail),
        })
        return { kind: 'cancelled', reason }
      }
      const fail = async (code: NotificationErrorCode, detail: string): Promise<SendOutcome> => {
        const error = errorText(code, detail)
        await finish(tx, ctx, row.id, row.attempts, { status: 'failed', error })
        return { kind: 'failed', error }
      }

      const channelParsed = NotificationChannelSchema.safeParse(row.channel)
      if (!channelParsed.success || !isTemplateCode(row.template_code))
        return fail(
          'template_unavailable',
          `unknown template ${row.template_code} / ${row.channel}`,
        )
      const channel = channelParsed.data
      const code = row.template_code
      const def = NOTIFICATION_TEMPLATES[code]
      if (!def.channels.includes(channel))
        return fail('template_unavailable', `${code} has no ${channel} text`)

      if (channel !== 'email') {
        const ent = await deps.entitlements.get(job.tenant_id)
        if (!ent.features.has('notifications'))
          return cancel('feature_not_in_plan', `plan ${ent.plan_code}`)
      }
      const settings = await getSettings(tx, ctx)
      if (disabledBySettings(code, settings.notifications)) return cancel('disabled_in_settings')
      if (requiresWhatsAppOptIn(code, channel) && (await customerOptedOut(tx, ctx, row)))
        return cancel('whatsapp_opt_out')

      const provider = registry.forChannel(channel)
      if (!provider) return fail('no_provider', `no provider for ${channel}`)
      if (deps.config.isProduction && !isLiveProvider(provider))
        return cancel('channel_not_configured', `${channel} provider: ${provider.code}`)

      const locale = LocaleSchema.safeParse(row.locale).data ?? 'ta'
      const o = await tx
        .selectFrom('notification_templates')
        .select(['subject', 'body', 'provider_template_id', 'is_active'])
        .where('tenant_id', '=', job.tenant_id)
        .where('code', '=', code)
        .where('channel', '=', channel)
        .where('locale', '=', locale)
        .executeTakeFirst()
      const override: TemplateOverride | null = o ?? null
      const params = paramsOf(row.params)
      const built = buildOutboundMessage({
        notification_id: row.id,
        tenant_id: job.tenant_id,
        code,
        channel,
        locale,
        to: row.recipient,
        recipient_name: row.recipient_name,
        params,
        override,
        attempt: row.attempts,
      })
      if (!built) return fail('template_unavailable', `${code} has no ${channel} text`)
      const button = channel === 'whatsapp' ? buttonUrlParam(deps, code, params) : null
      const message: OutboundMessage =
        button && built.whatsapp
          ? { ...built, whatsapp: { ...built.whatsapp, button_url_param: button } }
          : built
      await tx
        .updateTable('notifications')
        .set({
          rendered_body: def.sensitive ? null : message.body,
          provider: provider.code,
        })
        .where('tenant_id', '=', job.tenant_id)
        .where('id', '=', row.id)
        .execute()
      return { ctx, id: row.id, attempts: row.attempts, channel, provider, message }
    },
  )
  if ('kind' in prepared) return prepared

  const outcome = await sendWithProvider(prepared.provider, prepared.message, {
    timeout_ms: deps.config.notifications.providerTimeoutMs,
  })

  return withTenant(deps.db.appDb, prepared.ctx, async (tx): Promise<SendOutcome> => {
    const base = tx
      .updateTable('notifications')
      .where('tenant_id', '=', job.tenant_id)
      .where('id', '=', prepared.id)
      .where('status', '=', 'sending')
      .where('attempts', '=', prepared.attempts)
    if (outcome.ok) {
      const updated = await base
        .set({
          status: outcome.result.status,
          provider: outcome.provider,
          provider_message_id: outcome.result.provider_message_id,
          sent_at: new Date(),
          error: null,
          updated_at: new Date(),
        })
        .returning('id')
        .executeTakeFirst()
      if (updated && isLiveProvider(prepared.provider))
        await incrementUsage(tx, prepared.ctx, NOTIFICATION_USAGE_METRIC[prepared.channel], {
          enforce: false,
        })
      return { kind: 'sent', status: outcome.result.status, provider: outcome.provider }
    }
    const err = outcome.error
    const error = errorText(errorCodeOf(err), err.message)
    if (err.kind === 'retryable' && prepared.attempts < NOTIFICATION_MAX_ATTEMPTS) {
      const delay = Math.max(
        notificationRetryDelaySeconds(prepared.attempts),
        Math.min(3600, err.retry_after_seconds ?? 0),
      )
      const nextAt = new Date(Date.now() + delay * 1000)
      const updated = await base
        .set({ status: 'queued', scheduled_at: nextAt, error, updated_at: new Date() })
        .returning('id')
        .executeTakeFirst()
      if (updated)
        afterCommit(tx, () =>
          kickSendJob({ tenant_id: job.tenant_id, notification_id: prepared.id }, nextAt),
        )
      deps.logger.warn(
        {
          notification_id: prepared.id,
          attempts: prepared.attempts,
          provider: outcome.provider,
          error,
        },
        'notification delivery failed, will retry',
      )
      return { kind: 'retry', attempts: prepared.attempts, next_at: nextAt, error }
    }
    await base.set({ status: 'failed', error, updated_at: new Date() }).execute()
    deps.logger.warn(
      {
        notification_id: prepared.id,
        attempts: prepared.attempts,
        provider: outcome.provider,
        error,
      },
      'notification delivery failed',
    )
    return { kind: 'failed', error }
  })
}

/** A due 'queued' row is swept only when its own send job had a sweep interval to run. */
const SWEEP_GRACE_SECONDS = 60

export interface SweepResult {
  requeued_stuck: number
  failed_stuck: number
  kicked: number
}

/**
 * The one-minute sweep: rows stuck in 'sending' for NOTIFICATION_STUCK_AFTER_SECONDS (a worker
 * died mid-attempt) go back to 'queued' (or 'failed' once the attempts are used up), and every
 * due 'queued' row older than one sweep interval gets a send job (deduplicated per minute).
 *
 * Uses the SYSTEM database: the outbox queue is scanned across tenants (no tenant context exists
 * for a cron run; ARCHITECTURE.md §6.1). Only ids / statuses are touched here — the send job does
 * the tenant work under RLS. `tenantIds` limits the sweep (tests).
 */
export async function sweepNotifications(
  deps: Pick<KadaiDeps, 'db' | 'logger'>,
  opts: { tenantIds?: readonly string[]; limit?: number; now?: Date } = {},
): Promise<SweepResult> {
  const db = deps.db.systemDb
  const limit = opts.limit ?? 1000
  const scope = opts.tenantIds?.length ? opts.tenantIds : null
  const now = opts.now ?? new Date()
  const stuckBefore = new Date(now.getTime() - NOTIFICATION_STUCK_AFTER_SECONDS * 1000)
  const dueBefore = new Date(now.getTime() - SWEEP_GRACE_SECONDS * 1000)
  let stuckQ = db
    .updateTable('notifications')
    .set({
      status: sql<string>`case when attempts >= ${NOTIFICATION_MAX_ATTEMPTS} then 'failed' else 'queued' end`,
      error: sql<string>`case when attempts >= ${NOTIFICATION_MAX_ATTEMPTS} then 'stuck: the worker stopped while sending' else coalesce(error, 'stuck: retried after a worker stop') end`,
      scheduled_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where('status', '=', 'sending')
    .where('updated_at', '<', stuckBefore)
  if (scope) stuckQ = stuckQ.where('tenant_id', 'in', scope)
  const stuck = await stuckQ.returning(['id', 'tenant_id', 'status']).execute()

  let dueQ = db
    .selectFrom('notifications')
    .select(['id', 'tenant_id'])
    .where('status', '=', 'queued')
    .where('scheduled_at', '<=', dueBefore)
    .orderBy('scheduled_at')
    .limit(limit)
  if (scope) dueQ = dueQ.where('tenant_id', 'in', scope)
  const due = await dueQ.execute()

  const ids = new Map<string, string>()
  for (const r of stuck) if (r.status === 'queued') ids.set(r.id, r.tenant_id)
  for (const r of due) ids.set(r.id, r.tenant_id)
  let kicked = 0
  for (const [id, tenantId] of ids) {
    try {
      await enqueue(
        NOTIFICATION_JOBS.send,
        { tenant_id: tenantId, notification_id: id } satisfies NotificationSendJob,
        { singletonKey: id, singletonSeconds: 60 },
      )
      kicked++
    } catch (err) {
      deps.logger.error(
        { err, notification_id: id },
        'notifications sweep could not enqueue a send job',
      )
      break
    }
  }
  const failedStuck = stuck.filter((r) => r.status === 'failed').length
  if (stuck.length || kicked)
    deps.logger.info(
      { requeued_stuck: stuck.length - failedStuck, failed_stuck: failedStuck, kicked },
      'notifications sweep',
    )
  return { requeued_stuck: stuck.length - failedStuck, failed_stuck: failedStuck, kicked }
}
