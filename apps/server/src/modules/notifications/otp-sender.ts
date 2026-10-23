/**
 * Provider-backed OTP sender (core/otp.ts OtpSender), wired by server.ts in place of the default
 * core sender. The code is rendered with the `otp` template (ta / en, DLT text) and delivered by
 * the SMS provider of the notifications registry — MSG91 with the DLT OTP template
 * (MSG91_OTP_TEMPLATE_ID, flow variables `otp` and `minutes`), or another live SMS provider a
 * module registered (on-prem `kadai_relay`). Without a live SMS provider (SMS_PROVIDER=log) it
 * keeps the development behaviour: the code is logged outside production, never in production.
 *
 * OTPs do not go through the outbox (no row stores the code) and are not retried: a failure is
 * a 502 PROVIDER_ERROR for the request, and OtpService deletes the unsent code.
 */
import { randomUUID } from 'node:crypto'
import { maskPhone } from '@kadai/shared'
import { buildOutboundMessage } from '@kadai/shared/api/notifications'
import type { Config } from '../../config'
import { providerError } from '../../core/errors'
import { deliverMessage } from '../../core/notify'
import { type OtpLogger, type OtpSender, createLogOtpSender } from '../../core/otp'
import { type NotificationsConfig, installNotificationProviders, isLiveProvider } from './providers'

export function createNotificationOtpSender(
  config: NotificationsConfig & Pick<Config, 'isProduction'>,
  logger: OtpLogger,
): OtpSender {
  const logSender = createLogOtpSender(logger, { revealCode: !config.isProduction })
  return {
    name: 'notifications',
    async send(m) {
      const registry = installNotificationProviders(config, logger)
      const provider = registry.forChannel('sms')
      if (!provider || !isLiveProvider(provider)) return logSender.send(m)
      const message = buildOutboundMessage({
        notification_id: null,
        tenant_id: null,
        code: 'otp',
        channel: 'sms',
        locale: m.locale,
        to: m.phone,
        params: { otp: m.code, minutes: Math.max(1, Math.round(m.expiresInSeconds / 60)) },
        idempotency_key: `otp:${randomUUID()}`,
      })
      if (!message) throw providerError(provider.code, 'The OTP template has no SMS text')
      const out = await deliverMessage(message, {
        provider: provider.code,
        timeout_ms: config.notifications.providerTimeoutMs,
      })
      if (!out.ok) {
        logger.warn(
          {
            provider: out.provider,
            code: out.error.code,
            kind: out.error.kind,
            phone: maskPhone(m.phone),
            purpose: m.purpose,
          },
          'OTP SMS could not be sent',
        )
        throw providerError(
          out.provider ?? provider.code,
          'The OTP SMS could not be sent',
          out.error,
        )
      }
    },
  }
}
