/**
 * Provider webhooks — POST /webhooks/payments/:provider/:accountId (public, rate limited,
 * signature-verified over the raw body).
 *
 *  1. The account is looked up on the SYSTEM pool: the request names only the account, so its
 *     tenant is unknown until then (webhook routing is a system flow, ARCHITECTURE.md §6.1).
 *  2. The webhook secret is decrypted and the signature checked (constant time). Invalid or
 *     missing → 401, and the attempt is still logged in payment_webhook_events with
 *     signature_valid = false (under a unique synthetic id, so a forged event can never
 *     pre-empt the real one).
 *  3. De-duplication: payment_webhook_events is unique on (provider, event_id) — the provider
 *     event id (X-Razorpay-Event-Id, else the payload id, else sha256 of the body). A duplicate
 *     answers 200 {ok, duplicate: true} without processing.
 *  4. Processing runs inside withTenant for the account's tenant (systemContext) and goes
 *     through markIntentPaid. It is attempted inline (the POS sees the payment at once); a
 *     failure is stored on the event row and retried by the payments.process-webhook job.
 *
 * payment_webhook_events is system-only (the runtime role cannot read raw payloads); every
 * access here and in processWebhookEvent uses the system pool for that table only.
 */
import { type PaymentProviderCode, newId } from '@kadai/shared'
import type { paymentsRoutes } from '@kadai/shared/api/payments'
import { systemContext } from '../../core/context'
import { sha256Hex } from '../../core/crypto'
import { AppError, notFound } from '../../core/errors'
import type { RouteRequestFor } from '../../core/http'
import type { KadaiDeps } from '../../core/runtime'
import { jsonb } from '../../db/json'
import { type Tx, withSystemTx, withTenant } from '../../db/tenant'
import { decryptWebhookSecret } from './accounts'
import { type Ctx, enqueueSafely } from './common'
import { markIntentPaid, noteIntentFailure } from './mark-paid'
import { type NormalizedEvent, errorText, getProvider } from './providers'

export const PROCESS_WEBHOOK_JOB = 'payments.process-webhook'
/** Failed events are retried this many times by the sweep. */
export const WEBHOOK_MAX_ATTEMPTS = 10

type WebhookDeps = Pick<KadaiDeps, 'config' | 'crypto' | 'db' | 'logger' | 'metrics'>

function storablePayload(body: unknown, raw: Buffer): unknown {
  if (body !== null && typeof body === 'object') return body
  return { raw: raw.toString('utf8').slice(0, 64_000) }
}

/** POST /webhooks/payments/:provider/:accountId */
export async function receiveWebhook(
  deps: WebhookDeps,
  req: RouteRequestFor<typeof paymentsRoutes.webhook>,
): Promise<{ data: { ok: true; duplicate?: boolean } }> {
  const { provider, accountId } = req.params
  const system = deps.db.systemDb
  const acct = await system
    .selectFrom('payment_provider_accounts')
    .select(['id', 'tenant_id', 'provider', 'webhook_secret_encrypted'])
    .where('id', '=', accountId)
    .executeTakeFirst()
  if (!acct || acct.provider !== provider) throw notFound('payment_provider_account', accountId)
  const adapter = (() => {
    try {
      return getProvider(provider as PaymentProviderCode, deps)
    } catch {
      return null
    }
  })()
  if (!adapter || !adapter.capabilities.webhooks)
    throw notFound('payment_provider_account', accountId)

  const raw =
    req.rawBody ??
    Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null))
  let secret: string | null = null
  if (acct.webhook_secret_encrypted) {
    try {
      secret = decryptWebhookSecret(deps, acct.tenant_id, acct.id, acct.webhook_secret_encrypted)
    } catch (err) {
      deps.logger.error(
        { err, account_id: acct.id },
        'payment webhook: cannot decrypt the webhook secret',
      )
    }
  }
  const valid = secret !== null && adapter.verifyWebhook(secret, raw, req.headers)
  const body: unknown = req.body
  const eventType = adapter.webhookEventType(body).slice(0, 100)
  if (!valid) {
    await system
      .insertInto('payment_webhook_events')
      .values({
        provider,
        provider_account_id: acct.id,
        tenant_id: acct.tenant_id,
        event_id: `invalid:${newId()}`,
        event_type: eventType,
        signature_valid: false,
        payload: jsonb(storablePayload(body, raw)),
      })
      .execute()
    deps.logger.warn(
      { account_id: acct.id, provider, event_type: eventType, has_secret: secret !== null },
      'payment webhook with an invalid signature rejected',
    )
    throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature', {
      reason: 'invalid_signature',
    })
  }
  const eventId = (adapter.webhookEventId(body, req.headers) ?? `sha256:${sha256Hex(raw)}`).slice(
    0,
    200,
  )
  const inserted = await system
    .insertInto('payment_webhook_events')
    .values({
      provider,
      provider_account_id: acct.id,
      tenant_id: acct.tenant_id,
      event_id: eventId,
      event_type: eventType,
      signature_valid: true,
      payload: jsonb(storablePayload(body, raw)),
    })
    .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
    .returning('id')
    .executeTakeFirst()
  if (!inserted) return { data: { ok: true, duplicate: true } }
  const outcome = await processWebhookEvent(deps, inserted.id)
  if (outcome.status === 'failed') {
    await enqueueSafely(
      deps.logger,
      PROCESS_WEBHOOK_JOB,
      { webhook_event_id: inserted.id },
      {
        startAfter: 10,
        singletonKey: inserted.id,
      },
    )
  }
  return { data: { ok: true } }
}

export type WebhookOutcome =
  | { status: 'processed'; notes: string[] }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown }

async function findIntent(
  tx: Tx,
  ctx: Ctx,
  accountId: string,
  e: NormalizedEvent,
): Promise<{ id: string } | undefined> {
  let q = tx
    .selectFrom('payment_intents')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('provider_account_id', '=', accountId)
  if (e.intent_id && /^[0-9a-f-]{36}$/i.test(e.intent_id)) {
    const byId = await q.where('id', '=', e.intent_id).executeTakeFirst()
    if (byId) return byId
  }
  if (e.provider_ref) {
    const byRef = await q.where('provider_ref', '=', e.provider_ref).executeTakeFirst()
    if (byRef) return byRef
  }
  if (e.reference_code) {
    q = q.where('reference_code', '=', e.reference_code)
    return q.executeTakeFirst()
  }
  return undefined
}

/** Applies normalised events of one webhook in the tenant transaction; returns notes. */
async function applyEvents(
  deps: WebhookDeps,
  tx: Tx,
  ctx: Ctx,
  accountId: string,
  events: readonly NormalizedEvent[],
): Promise<string[]> {
  const notes: string[] = []
  for (const e of events) {
    const intent = await findIntent(tx, ctx, accountId, e)
    if (!intent) {
      notes.push(
        `intent_not_found: ${e.provider_ref ?? e.intent_id ?? e.reference_code ?? 'unknown'}`,
      )
      continue
    }
    if (e.type === 'paid') {
      const r = await markIntentPaid(
        tx,
        ctx,
        {
          intent_id: intent.id,
          confirmation: 'webhook',
          payment: {
            provider_payment_id: e.provider_payment_id,
            amount_paise: e.amount_paise,
            payer_vpa: e.payer_vpa,
            payer_name: e.payer_name,
            utr: e.utr,
            fee_paise: e.fee_paise,
            paid_at: e.paid_at,
          },
        },
        { metrics: deps.metrics },
      )
      if (r.outcome !== 'paid') notes.push(`${r.outcome}: ${intent.id}`)
    } else {
      await noteIntentFailure(tx, ctx, intent.id, e.reason)
    }
  }
  return notes
}

/**
 * Processes one stored webhook event (inline after receipt, or from the retry job). The event
 * row is locked on the system pool (SKIP LOCKED) so two processors never handle it at once.
 */
export async function processWebhookEvent(
  deps: WebhookDeps,
  eventRowId: string,
): Promise<WebhookOutcome> {
  return withSystemTx(deps.db.systemDb, async (stx) => {
    const ev = await stx
      .selectFrom('payment_webhook_events')
      .selectAll()
      .where('id', '=', eventRowId)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst()
    if (!ev || ev.processed_at || !ev.signature_valid || !ev.tenant_id || !ev.provider_account_id) {
      return { status: 'skipped' } as const
    }
    const tenantId = ev.tenant_id
    const accountId = ev.provider_account_id
    try {
      const adapter = getProvider(ev.provider as PaymentProviderCode, deps)
      const events = adapter.parseWebhook(ev.payload)
      const ctx = systemContext(tenantId, { requestId: `webhook:${ev.id}` })
      const notes = await withTenant(deps.db.appDb, ctx, (tx) =>
        applyEvents(deps, tx, ctx, accountId, events),
      )
      await stx
        .updateTable('payment_webhook_events')
        .set({
          processed_at: new Date(),
          processing_error: notes.length ? notes.join('; ').slice(0, 1000) : null,
          attempts: ev.attempts + 1,
        })
        .where('id', '=', ev.id)
        .execute()
      return { status: 'processed', notes } as const
    } catch (err) {
      deps.logger.error({ err, webhook_event_id: ev.id }, 'payment webhook processing failed')
      await stx
        .updateTable('payment_webhook_events')
        .set({ attempts: ev.attempts + 1, processing_error: errorText(err, 1000) })
        .where('id', '=', ev.id)
        .execute()
      return { status: 'failed', error: err } as const
    }
  })
}

/** Retries stored events that were not processed (job sweep). */
export async function sweepWebhookEvents(
  deps: WebhookDeps,
  opts: { limit?: number; olderThanSeconds?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const rows = await deps.db.systemDb
    .selectFrom('payment_webhook_events')
    .select('id')
    .where('processed_at', 'is', null)
    .where('signature_valid', '=', true)
    .where('attempts', '<', WEBHOOK_MAX_ATTEMPTS)
    .where('received_at', '<', new Date(Date.now() - (opts.olderThanSeconds ?? 30) * 1000))
    .orderBy('received_at')
    .limit(opts.limit ?? 50)
    .execute()
  let processed = 0
  let failed = 0
  for (const r of rows) {
    const outcome = await processWebhookEvent(deps, r.id)
    if (outcome.status === 'processed') processed++
    else if (outcome.status === 'failed') failed++
  }
  return { processed, failed }
}
