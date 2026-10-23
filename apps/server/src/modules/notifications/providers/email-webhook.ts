/**
 * E-mail through an HTTP webhook (`email_webhook`). This build bundles no mail library, so SMTP
 * is not spoken directly; instead every e-mail is POSTed as JSON (EmailWebhookPayloadSchema) to
 * EMAIL_WEBHOOK_URL — a small relay of your choice (a mail provider's HTTP API behind a function,
 * n8n / Zapier, a Postfix sidecar) sends it:
 *
 *   POST $EMAIL_WEBHOOK_URL
 *   Content-Type: application/json
 *   Idempotency-Key: <notification id>:<attempt>
 *   X-Kadai-Event: notification.email
 *   X-Kadai-Signature: sha256=<hex HMAC-SHA256 of the raw body with EMAIL_WEBHOOK_SECRET>
 *   { "event": "notification.email", "id", "tenant_id", "notification_id", "template_code",
 *     "locale", "from", "to", "to_name", "subject", "text" }
 *
 * Any 2xx is success (`id` / `message_id` of a JSON answer becomes the provider message id);
 * 408 / 425 / 429 / 5xx are retried, other statuses fail the message.
 */
import { createHmac } from 'node:crypto'
import {
  type EmailWebhookPayload,
  type NotificationProvider,
  NotificationProviderError,
} from '@kadai/shared/api/notifications'
import {
  type FetchLike,
  httpStatusError,
  notConfigured,
  objectOf,
  postJson,
  stringOf,
} from './http'

export interface EmailWebhookProviderOptions {
  url: string | null
  secret: string | null
  from: string
  timeoutMs: number
  fetchImpl?: FetchLike
}

/** `sha256=<hex>` signature of a raw body (what receivers recompute). */
export function emailWebhookSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`
}

export function createEmailWebhookProvider(
  opts: EmailWebhookProviderOptions,
): NotificationProvider {
  const configured = Boolean(opts.url)
  return {
    code: 'email_webhook',
    channels: ['email'],
    configured,
    status: () => ({ configured, live: configured, display: opts.from, webhook_path: null }),
    async send(message, sendOpts = {}) {
      if (!opts.url) throw notConfigured('email_webhook', 'EMAIL_WEBHOOK_URL is not set')
      if (message.channel !== 'email')
        throw new NotificationProviderError({
          message: `email_webhook cannot send ${message.channel}`,
          kind: 'permanent',
          provider: 'email_webhook',
          code: 'no_provider',
        })
      const payload: EmailWebhookPayload = {
        event: 'notification.email',
        id: message.idempotency_key,
        tenant_id: message.tenant_id,
        notification_id: message.notification_id,
        template_code: message.template_code,
        locale: message.locale,
        from: opts.from,
        to: message.to,
        to_name: message.recipient_name,
        subject: message.subject ?? '',
        text: message.body,
      }
      const raw = JSON.stringify(payload)
      const res = await postJson({
        provider: 'email_webhook',
        url: opts.url,
        headers: {
          'idempotency-key': message.idempotency_key,
          'x-kadai-event': payload.event,
          ...(opts.secret ? { 'x-kadai-signature': emailWebhookSignature(opts.secret, raw) } : {}),
        },
        body: raw,
        timeoutMs: sendOpts.timeout_ms ?? opts.timeoutMs,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      if (!res.ok) throw httpStatusError('email_webhook', res, res.text || 'request failed')
      const body = objectOf(res.json)
      return {
        provider_message_id: stringOf(body.id) ?? stringOf(body.message_id) ?? payload.id,
        status: 'sent',
      }
    },
  }
}
