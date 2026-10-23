/**
 * MSG91 SMS through the Flow API (DLT): `POST <base>/api/v5/flow` with the `authkey` header and
 * `{ template_id, short_url: '0', sender?, recipients: [{ mobiles: '91XXXXXXXXXX', ...vars }] }`
 * (msg91FlowRequest). Indian telecom rules (TRAI DLT) only deliver pre-registered texts, so every
 * SMS names its MSG91 flow template, which is linked to the DLT template:
 *
 *   - a tenant override carries it in provider_template_id (required when saving the override);
 *   - the default texts use MSG91_TEMPLATE_<CODE> (e.g. MSG91_TEMPLATE_DUE_REMINDER; the OTP uses
 *     MSG91_OTP_TEMPLATE_ID) — register the text printed by dltTemplateText() with variables
 *     named like the placeholders (##shop_name##, ##due##, …).
 *
 * MSG91 answers 200 `{ type: 'success', message: '<request id>' }` (the request id keys the
 * delivery reports, POST /webhooks/notifications/msg91) or `{ type: 'error', message }` — also
 * sometimes with HTTP 200, so the body decides.
 */
import {
  type NotificationErrorCode,
  type NotificationProvider,
  NotificationProviderError,
  msg91FlowRequest,
  notificationWebhookPath,
} from '@kadai/shared/api/notifications'
import {
  type FetchLike,
  httpStatusError,
  notConfigured,
  objectOf,
  postJson,
  stringOf,
} from './http'

export interface Msg91ProviderOptions {
  authKey: string | null
  senderId: string | null
  /** e.g. https://control.msg91.com (tests point it at a fake server). */
  baseUrl: string
  /** Flow template ids of the default texts by template code. */
  templateIds: Readonly<Record<string, string>>
  timeoutMs: number
  fetchImpl?: FetchLike
}

const RETRYABLE_MESSAGE_RE = /timeout|timed out|try again|temporar|too many|rate limit|busy/i
const INVALID_NUMBER_RE = /mobile|number|recipient|ndnc|dnd/i

function classifyMsg91Message(message: string): {
  kind: 'retryable' | 'permanent'
  code: NotificationErrorCode
} {
  if (RETRYABLE_MESSAGE_RE.test(message))
    return {
      kind: 'retryable',
      code: /many|rate/i.test(message) ? 'rate_limited' : 'provider_error',
    }
  if (/auth|key|template|flow|sender|dlt/i.test(message))
    return { kind: 'permanent', code: 'not_configured' }
  if (INVALID_NUMBER_RE.test(message)) return { kind: 'permanent', code: 'invalid_recipient' }
  return { kind: 'permanent', code: 'provider_error' }
}

export function createMsg91Provider(opts: Msg91ProviderOptions): NotificationProvider {
  const configured = Boolean(opts.authKey)
  return {
    code: 'msg91',
    channels: ['sms'],
    configured,
    status: () => ({
      configured,
      live: configured,
      display: opts.senderId,
      webhook_path: notificationWebhookPath('msg91'),
    }),
    async send(message, sendOpts = {}) {
      if (!opts.authKey) throw notConfigured('msg91', 'MSG91_AUTH_KEY is not set')
      if (message.channel !== 'sms')
        throw new NotificationProviderError({
          message: `msg91 cannot send ${message.channel}`,
          kind: 'permanent',
          provider: 'msg91',
          code: 'no_provider',
        })
      const templateId = message.provider_template_id ?? opts.templateIds[message.template_code]
      if (!templateId)
        throw notConfigured(
          'msg91',
          `no DLT / MSG91 template id for "${message.template_code}" (set MSG91_TEMPLATE_${message.template_code.toUpperCase()})`,
        )
      const res = await postJson({
        provider: 'msg91',
        url: `${opts.baseUrl}/api/v5/flow`,
        headers: { authkey: opts.authKey },
        body: JSON.stringify(msg91FlowRequest(message, templateId, opts.senderId)),
        timeoutMs: sendOpts.timeout_ms ?? opts.timeoutMs,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      const body = objectOf(res.json)
      const detail = stringOf(body.message) ?? res.text
      if (!res.ok) {
        const c = classifyMsg91Message(detail)
        throw httpStatusError(
          'msg91',
          res,
          detail || 'request failed',
          res.status === 400 || res.status === 422 ? c.code : undefined,
        )
      }
      if (String(body.type ?? '').toLowerCase() === 'error') {
        const c = classifyMsg91Message(detail)
        throw new NotificationProviderError({
          message: `msg91: ${detail || 'error'}`.slice(0, 500),
          kind: c.kind,
          provider: 'msg91',
          code: c.code,
          http_status: res.status,
        })
      }
      const requestId =
        stringOf(body.request_id) ?? stringOf(body.requestId) ?? stringOf(body.message)
      return { provider_message_id: requestId, status: 'sent' }
    },
  }
}
