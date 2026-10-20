/**
 * Notifications — the enqueue side of the outbox (ARCHITECTURE.md §15) and the process-wide
 * provider registry. The sending side (job `notifications.send`, sweep, providers, webhooks) lives
 * in modules/notifications; contracts in @kadai/shared/api/notifications.
 *
 *   await req.tx(async (tx) => {
 *     const invoice = await completeInvoice(tx, req.ctx, …)
 *     await enqueueNotification(tx, req.ctx, {
 *       channel: 'whatsapp', template_code: 'invoice_share', to: invoice.customer_phone,
 *       recipient_name: invoice.customer_name, params: { shop_name, customer_name, number, amount, due, link },
 *       ref_type: 'sales_invoice', ref_id: invoice.id,
 *     })
 *   })
 *
 * * The row is written inside the caller's business transaction: a rollback never sends.
 * * After COMMIT the `notifications.send` job is enqueued (singleton per notification, delayed to
 *   `scheduled_at`); if that fails (worker queue down, job not registered yet) the row stays
 *   'queued' and the one-minute sweep (`notifications.sweep`) picks it up.
 * * Whether a message is finally delivered (tenant settings, customer WhatsApp opt-in, plan
 *   feature, provider) is decided by the send job, which may mark it 'cancelled' / 'failed'.
 * * Providers: modules register adapters in {@link getNotificationProviders} (notifications:
 *   log / msg91 / whatsapp_cloud / email_webhook; onprem: kadai_relay); {@link deliverMessage}
 *   sends one rendered message through the channel's provider (send job, vendor relay).
 */
import {
  type Locale,
  LocaleSchema,
  type NotificationChannel,
  NotificationChannelSchema,
  type ValidationIssue,
  isUuid,
  newId,
} from '@kadai/shared'
import {
  NOTIFICATION_JOBS,
  NOTIFICATION_TEMPLATES,
  NotificationParamsSchema,
  type NotificationParams,
  type NotificationProviderCode,
  NotificationProviderError,
  type NotificationProviderRegistry,
  type NotificationSendJob,
  type NotificationTemplateCode,
  type OutboundMessage,
  type ProviderSendResult,
  createNotificationProviderRegistry,
  isTemplateCode,
  normalizeRecipient,
  sendWithProvider,
} from '@kadai/shared/api/notifications'
import { jsonb } from '../db/json'
import { type Tx, afterCommit } from '../db/tenant'
import type { RequestContext } from './context'
import { invalidField, validationError } from './errors'
import { enqueue } from './jobs'

type Ctx = Pick<RequestContext, 'tenantId' | 'userId' | 'locale'>

export interface EnqueueNotificationInput {
  channel: NotificationChannel
  template_code: NotificationTemplateCode
  /** Mobile number (sms / whatsapp; any Indian format or E.164) or email. */
  to: string
  recipient_name?: string | null
  /** Default: ctx.locale. */
  locale?: Locale
  /** Placeholder values — validated against the template's params schema. */
  params: NotificationParams
  /** Source document (e.g. 'sales_invoice', 'customer') for links and de-duplication. */
  ref_type?: string | null
  ref_id?: string | null
  /** Deliver later (default now). */
  scheduled_at?: Date | string | null
}

export interface EnqueuedNotification {
  id: string
  channel: NotificationChannel
  template_code: NotificationTemplateCode
  locale: Locale
  /** Normalised recipient (E.164 / lower-case email). */
  recipient: string
  status: 'queued'
  scheduled_at: Date
}

function paramIssues(code: NotificationTemplateCode, params: unknown): ValidationIssue[] {
  const generic = NotificationParamsSchema.safeParse(params)
  const specific = NOTIFICATION_TEMPLATES[code].params.safeParse(params)
  return [
    ...(generic.success ? [] : generic.error.issues),
    ...(specific.success ? [] : specific.error.issues),
  ].map((i) => ({
    path: ['params', ...i.path.map(String)].join('.'),
    message: i.message,
    code: 'params_invalid',
  }))
}

function scheduledAt(value: Date | string | null | undefined): Date {
  if (value === null || value === undefined) return new Date()
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) throw invalidField('scheduled_at', 'Invalid scheduled_at')
  return d
}

/**
 * Writes a notification to the outbox in the caller's transaction and enqueues its delivery after
 * COMMIT. Throws 400 VALIDATION_ERROR for an unknown template, a channel the template does not
 * support, an invalid recipient or params that do not match the template.
 */
export async function enqueueNotification(
  tx: Tx,
  ctx: Ctx,
  input: EnqueueNotificationInput,
): Promise<EnqueuedNotification> {
  if (!NotificationChannelSchema.safeParse(input.channel).success)
    throw invalidField('channel', 'Unknown channel')
  if (!isTemplateCode(input.template_code))
    throw invalidField('template_code', 'Unknown notification template')
  const def = NOTIFICATION_TEMPLATES[input.template_code]
  if (!def.channels.includes(input.channel)) throw invalidField('channel', 'template_channel')
  const recipient =
    typeof input.to === 'string' ? normalizeRecipient(input.channel, input.to) : null
  if (!recipient)
    throw invalidField('to', input.channel === 'email' ? 'recipient_email' : 'recipient_phone')
  const locale = input.locale ?? ctx.locale
  if (!LocaleSchema.safeParse(locale).success) throw invalidField('locale', 'Unknown locale')
  const issues = paramIssues(input.template_code, input.params)
  if (issues.length) throw validationError(issues, 'Notification params do not match the template')
  if (input.ref_id != null && !isUuid(input.ref_id)) throw invalidField('ref_id', 'Invalid ref_id')
  const when = scheduledAt(input.scheduled_at)

  const id = newId()
  await tx
    .insertInto('notifications')
    .values({
      id,
      tenant_id: ctx.tenantId,
      channel: input.channel,
      template_code: input.template_code,
      locale,
      recipient,
      recipient_name: input.recipient_name?.trim() || null,
      params: jsonb(input.params),
      status: 'queued',
      ref_type: input.ref_type ?? null,
      ref_id: input.ref_id ?? null,
      scheduled_at: when,
      created_by: ctx.userId,
    })
    .execute()

  const job: NotificationSendJob = { tenant_id: ctx.tenantId, notification_id: id }
  afterCommit(tx, () => kickSendJob(job, when))

  return {
    id,
    channel: input.channel,
    template_code: input.template_code,
    locale,
    recipient,
    status: 'queued',
    scheduled_at: when,
  }
}

/** Matches the errors of core/jobs enqueue() when the job cannot be sent right now. */
const QUEUE_UNAVAILABLE_RE = /unknown job|job queue is not initialised/

/**
 * Enqueues `notifications.send` for one notification (singleton per id; delayed to scheduledAt).
 * A missing queue / unregistered job is not an error — the sweep delivers the queued row.
 */
export async function kickSendJob(job: NotificationSendJob, scheduledAt?: Date): Promise<void> {
  try {
    const delay = scheduledAt && scheduledAt.getTime() > Date.now() + 1000 ? scheduledAt : undefined
    await enqueue(NOTIFICATION_JOBS.send, job, {
      singletonKey: job.notification_id,
      ...(delay ? { startAfter: delay } : {}),
    })
  } catch (err) {
    if (err instanceof Error && QUEUE_UNAVAILABLE_RE.test(err.message)) return
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// Provider registry (one per process; the notifications module fills it at boot)
// ---------------------------------------------------------------------------------------------

let registry: NotificationProviderRegistry = createNotificationProviderRegistry()

/** The process-wide notification provider registry. */
export function getNotificationProviders(): NotificationProviderRegistry {
  return registry
}

/** Replaces the registry (tests, re-configuration); returns the previous one. */
export function setNotificationProviders(
  next: NotificationProviderRegistry,
): NotificationProviderRegistry {
  const previous = registry
  registry = next
  return previous
}

export type DeliveryOutcome =
  | { ok: true; provider: NotificationProviderCode; result: ProviderSendResult }
  | { ok: false; provider: NotificationProviderCode | null; error: NotificationProviderError }

/**
 * Sends one rendered message through `opts.provider` or the channel's provider
 * (registry.forChannel). Never throws: failures come back classified (retryable / permanent);
 * no provider for the channel is a permanent 'no_provider' error.
 */
export async function deliverMessage(
  message: OutboundMessage,
  opts: { provider?: NotificationProviderCode; timeout_ms?: number } = {},
): Promise<DeliveryOutcome> {
  const provider = opts.provider
    ? registry.get(opts.provider)
    : registry.forChannel(message.channel)
  if (!provider || !provider.channels.includes(message.channel)) {
    return {
      ok: false,
      provider: provider?.code ?? null,
      error: new NotificationProviderError({
        message: `no notification provider for ${message.channel}`,
        kind: 'permanent',
        provider: opts.provider ?? 'none',
        code: 'no_provider',
      }),
    }
  }
  return sendWithProvider(
    provider,
    message,
    opts.timeout_ms === undefined ? {} : { timeout_ms: opts.timeout_ms },
  )
}
