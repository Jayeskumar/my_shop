/**
 * `log` provider (development / tests, and the fallback of every channel): nothing leaves the
 * system — the message is written to the logger (with its rendered body outside production;
 * never the body of sensitive templates such as OTPs in production) and reported as delivered.
 * The send job stores the rendered body on the outbox row, so the message can be read there.
 *
 * In production the send job does not hand messages to this provider: a channel without a live
 * provider is cancelled with `channel_not_configured` instead (see ../send.ts).
 */
import { newId } from '@kadai/shared'
import {
  NOTIFICATION_TEMPLATES,
  type NotificationProvider,
  isTemplateCode,
  maskRecipient,
} from '@kadai/shared/api/notifications'

export interface LogProviderLogger {
  info(obj: object, msg: string): void
}

export function createLogProvider(
  logger: LogProviderLogger,
  opts: { revealBody: boolean },
): NotificationProvider {
  return {
    code: 'log',
    channels: ['sms', 'whatsapp', 'email'],
    configured: true,
    status: () => ({ configured: true, live: false, display: null, webhook_path: null }),
    async send(message) {
      const sensitive =
        isTemplateCode(message.template_code) &&
        NOTIFICATION_TEMPLATES[message.template_code].sensitive
      logger.info(
        {
          channel: message.channel,
          to: maskRecipient(message.to),
          template_code: message.template_code,
          locale: message.locale,
          notification_id: message.notification_id,
          tenant_id: message.tenant_id,
          ...(opts.revealBody ? { subject: message.subject, body: message.body } : {}),
          ...(sensitive && !opts.revealBody ? { redacted: true } : {}),
        },
        'notification (log provider: not sent)',
      )
      return { provider_message_id: `log-${newId()}`, status: 'delivered' }
    },
  }
}
