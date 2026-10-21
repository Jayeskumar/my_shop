/**
 * WhatsApp Business through Meta's Cloud API: `POST <base>/<version>/<PHONE_NUMBER_ID>/messages`
 * with `Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>` and a template message
 * (whatsappTemplateRequest: approved template name, language ta / en, body parameters in
 * placeholder order, optional URL button suffix). Business-initiated messages must be approved
 * templates; the texts to submit to Meta are printed by whatsappTemplateText().
 *
 * Success: `{ messages: [{ id: 'wamid…' }] }` — the wamid keys the status callbacks
 * (POST /webhooks/notifications/whatsapp_cloud). Errors: `{ error: { message, code } }`; Meta's
 * throttling / transient codes are retried, the rest (bad number, template mismatch, expired
 * token) fail for good.
 */
import {
  type NotificationErrorCode,
  type NotificationProvider,
  NotificationProviderError,
  notificationWebhookPath,
  whatsappTemplateRequest,
} from '@kadai/shared/api/notifications'
import { type FetchLike, notConfigured, objectOf, postJson, stringOf } from './http'

export interface WhatsAppCloudProviderOptions {
  phoneNumberId: string | null
  accessToken: string | null
  apiVersion: string
  /** e.g. https://graph.facebook.com (tests point it at a fake server). */
  baseUrl: string
  timeoutMs: number
  fetchImpl?: FetchLike
}

/** Meta error codes worth retrying (throttling, temporary unavailability). */
const RETRYABLE_CODES = new Set([
  1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 131048, 131056, 133004,
])
/** The recipient cannot get the message (not on WhatsApp, not allowed, bad number). */
const RECIPIENT_CODES = new Set([131021, 131026, 131030, 131045])
/** Access token / app / phone number setup problems. */
const CONFIG_CODES = new Set([10, 100, 190, 200, 131031, 131042, 133010])

export function classifyWhatsAppError(
  httpStatus: number,
  metaCode: number | null,
): { kind: 'retryable' | 'permanent'; code: NotificationErrorCode } {
  if (metaCode !== null) {
    if (RETRYABLE_CODES.has(metaCode))
      return {
        kind: 'retryable',
        code: [4, 17, 32, 613, 80007, 130429, 131048, 131056].includes(metaCode)
          ? 'rate_limited'
          : 'provider_error',
      }
    if (RECIPIENT_CODES.has(metaCode)) return { kind: 'permanent', code: 'invalid_recipient' }
    if (CONFIG_CODES.has(metaCode)) return { kind: 'permanent', code: 'not_configured' }
  }
  if (httpStatus === 429) return { kind: 'retryable', code: 'rate_limited' }
  if (httpStatus >= 500 || httpStatus === 408) return { kind: 'retryable', code: 'provider_error' }
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'permanent', code: 'not_configured' }
  return { kind: 'permanent', code: 'provider_error' }
}

export function createWhatsAppCloudProvider(
  opts: WhatsAppCloudProviderOptions,
): NotificationProvider {
  const configured = Boolean(opts.phoneNumberId && opts.accessToken)
  return {
    code: 'whatsapp_cloud',
    channels: ['whatsapp'],
    configured,
    status: () => ({
      configured,
      live: configured,
      display: opts.phoneNumberId,
      webhook_path: notificationWebhookPath('whatsapp_cloud'),
    }),
    async send(message, sendOpts = {}) {
      if (!opts.phoneNumberId || !opts.accessToken)
        throw notConfigured(
          'whatsapp_cloud',
          'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required',
        )
      if (message.channel !== 'whatsapp' || !message.whatsapp)
        throw new NotificationProviderError({
          message: `whatsapp_cloud needs an approved template for "${message.template_code}"`,
          kind: 'permanent',
          provider: 'whatsapp_cloud',
          code: 'template_unavailable',
        })
      const res = await postJson({
        provider: 'whatsapp_cloud',
        url: `${opts.baseUrl}/${encodeURIComponent(opts.apiVersion)}/${encodeURIComponent(opts.phoneNumberId)}/messages`,
        headers: { authorization: `Bearer ${opts.accessToken}` },
        body: JSON.stringify(whatsappTemplateRequest(message)),
        timeoutMs: sendOpts.timeout_ms ?? opts.timeoutMs,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const body = objectOf(res.json)
      if (!res.ok) {
        const err = objectOf(body.error)
        const metaCode = typeof err.code === 'number' ? err.code : null
        const c = classifyWhatsAppError(res.status, metaCode)
        const detail = [metaCode, stringOf(err.message) ?? res.text].filter(Boolean).join(' ')
        throw new NotificationProviderError({
          message: `whatsapp_cloud HTTP ${res.status}: ${detail}`.slice(0, 500),
          kind: c.kind,
          provider: 'whatsapp_cloud',
          code: c.code,
          http_status: res.status,
          retry_after_seconds: res.retryAfterSeconds,
        })
      }
      const messages = Array.isArray(body.messages) ? body.messages : []
      const id = stringOf(objectOf(messages[0]).id)
      return { provider_message_id: id, status: 'sent' }
    },
  }
}
