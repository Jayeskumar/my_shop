/**
 * Delivery receipts: POST /webhooks/notifications/:provider and the WhatsApp GET verification.
 *
 *   whatsapp_cloud — Meta signs the raw body: `X-Hub-Signature-256: sha256=<HMAC-SHA256(body,
 *                    WHATSAPP_APP_SECRET)>`; an unsigned / mis-signed call (or no app secret
 *                    configured) → 401 {reason: 'invalid_signature'}. Status callbacks
 *                    (sent / delivered / read / failed) are parsed with parseWhatsAppStatuses().
 *   msg91          — delivery reports (parseMsg91Report) keyed by the Flow request id. MSG91 does
 *                    not sign them: when MSG91_WEBHOOK_TOKEN is set the URL must carry it
 *                    (`?token=` or `X-Kadai-Webhook-Token`), else 401.
 *
 * Statuses only move forward (nextNotificationStatus: receipts may arrive out of order).
 * Receipts carry no tenant, so the outbox row is found by (provider, provider_message_id) on the
 * SYSTEM database (ARCHITECTURE.md §6.1); only status / error / sent_at of that row change.
 */
import {
  type DeliveryReceipt,
  nextNotificationStatus,
  parseHubSignature,
  parseMsg91Report,
  parseWhatsAppStatuses,
} from '@kadai/shared/api/notifications'
import type { NotificationStatus } from '@kadai/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { sql } from 'kysely'
import { hmacSha256Hex, timingSafeEqualStr } from '../../core/crypto'
import { AppError, forbidden, notFound } from '../../core/errors'
import type { KadaiDeps } from '../../core/runtime'
import { errorText } from './send'

/** Receipts applied per webhook call at most (a WhatsApp batch is far smaller). */
const MAX_RECEIPTS = 500

function invalidSignature(): AppError {
  return new AppError('UNAUTHENTICATED', 'Invalid webhook signature', {
    reason: 'invalid_signature',
  })
}

function headerOf(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' && s.trim() ? s.trim() : null
}

/** Verifies Meta's X-Hub-Signature-256 over the raw body. */
export function verifyWhatsAppSignature(
  appSecret: string | null,
  rawBody: Buffer | undefined,
  header: string | null,
): boolean {
  if (!appSecret || !rawBody) return false
  const got = parseHubSignature(header)
  if (!got) return false
  return timingSafeEqualStr(got, hmacSha256Hex(appSecret, rawBody))
}

export interface ReceiptResult {
  received: number
  updated: number
}

/** Applies receipts to the outbox (see the module comment). */
export async function applyReceipts(
  deps: Pick<KadaiDeps, 'db' | 'logger'>,
  provider: 'whatsapp_cloud' | 'msg91',
  receipts: readonly DeliveryReceipt[],
): Promise<ReceiptResult> {
  let updated = 0
  for (const r of receipts.slice(0, MAX_RECEIPTS)) {
    const rows = await deps.db.systemDb
      .selectFrom('notifications')
      .select(['id', 'tenant_id', 'status'])
      .where('provider', '=', provider)
      .where('provider_message_id', '=', r.provider_message_id)
      .execute()
    for (const row of rows) {
      const next = nextNotificationStatus(row.status as NotificationStatus, r.status)
      if (!next) continue
      const at = r.at ? new Date(r.at) : null
      const res = await deps.db.systemDb
        .updateTable('notifications')
        .set({
          status: next,
          ...(next === 'failed'
            ? { error: errorText('provider_error', r.error ?? `${provider} reported failure`) }
            : {}),
          ...(next !== 'failed' && at && !Number.isNaN(at.getTime())
            ? { sent_at: sql<Date>`coalesce(sent_at, ${at})` }
            : {}),
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .where('tenant_id', '=', row.tenant_id)
        .where('status', '=', row.status)
        .executeTakeFirst()
      if (Number(res.numUpdatedRows) > 0) updated++
    }
  }
  return { received: receipts.length, updated }
}

/** MSG91 may post form fields with a JSON `data` string. */
function msg91Body(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const data = (body as Record<string, unknown>).data
    if (typeof data === 'string') {
      try {
        return { data: JSON.parse(data) as unknown }
      } catch {
        return body
      }
    }
  }
  return body
}

/** POST /webhooks/notifications/:provider */
export async function handleDeliveryWebhook(
  deps: Pick<KadaiDeps, 'db' | 'logger' | 'config'>,
  req: FastifyRequest,
  provider: 'whatsapp_cloud' | 'msg91',
): Promise<ReceiptResult> {
  if (provider === 'whatsapp_cloud') {
    if (
      !verifyWhatsAppSignature(
        deps.config.whatsapp.appSecret,
        req.rawBody,
        headerOf(req, 'x-hub-signature-256'),
      )
    ) {
      deps.logger.warn({ ip: req.ip, provider }, 'notification webhook: invalid signature')
      throw invalidSignature()
    }
    return applyReceipts(deps, provider, parseWhatsAppStatuses(req.body))
  }
  const expected = deps.config.sms.msg91.webhookToken
  if (expected) {
    const query = (req.query ?? {}) as Record<string, unknown>
    const token =
      (typeof query.token === 'string' ? query.token : null) ??
      headerOf(req, 'x-kadai-webhook-token')
    if (!token || !timingSafeEqualStr(token, expected)) {
      deps.logger.warn({ ip: req.ip, provider }, 'notification webhook: invalid token')
      throw invalidSignature()
    }
  }
  return applyReceipts(deps, provider, parseMsg91Report(msg91Body(req.body)))
}

/** GET /webhooks/notifications/:provider — Meta's subscription check (hub.challenge as text). */
export function verifyWebhookSubscription(
  deps: Pick<KadaiDeps, 'config'>,
  provider: 'whatsapp_cloud' | 'msg91',
  query: { 'hub.mode': string; 'hub.verify_token': string; 'hub.challenge': string },
  reply: FastifyReply,
): FastifyReply {
  if (provider !== 'whatsapp_cloud') throw notFound('webhook verification', provider)
  const expected = deps.config.whatsapp.webhookVerifyToken
  if (
    query['hub.mode'] !== 'subscribe' ||
    !expected ||
    !timingSafeEqualStr(query['hub.verify_token'], expected)
  )
    throw forbidden('Webhook verification failed', { reason: 'invalid_signature' })
  return reply
    .code(200)
    .type('text/plain; charset=utf-8')
    .send(query['hub.challenge'].slice(0, 200))
}
