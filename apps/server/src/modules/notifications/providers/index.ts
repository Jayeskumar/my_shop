/**
 * Notification providers of this module and their installation into the process-wide registry
 * (core/notify.ts getNotificationProviders()):
 *
 *   log            always (development fallback of every channel; never "live")
 *   msg91          SMS_PROVIDER=msg91            (pinned for 'sms')
 *   whatsapp_cloud WHATSAPP_PROVIDER=whatsapp_cloud (pinned for 'whatsapp')
 *   email_webhook  EMAIL_PROVIDER=email_webhook  (pinned for 'email'; 'smtp' is reserved)
 *
 * A channel whose env provider is `log` is left unpinned, so a provider registered by another
 * module (on-prem `kadai_relay`) is picked automatically by registry.forChannel().
 * installNotificationProviders() is idempotent per registry and never removes providers other
 * modules registered. Both the API (module plugin) and the worker (job handlers) call it.
 */
import {
  NOTIFICATION_CHANNELS_ORDER,
  type NotificationProviderRegistry,
  type NotificationProvider,
  type NotificationProviderStatus,
} from './types'
import type { Config } from '../../../config'
import { getNotificationProviders } from '../../../core/notify'
import { createEmailWebhookProvider } from './email-webhook'
import type { FetchLike } from './http'
import { type LogProviderLogger, createLogProvider } from './log'
import { createMsg91Provider } from './msg91'
import { createWhatsAppCloudProvider } from './whatsapp-cloud'

export type NotificationsConfig = Pick<
  Config,
  'sms' | 'whatsapp' | 'email' | 'notifications' | 'isProduction'
>

export interface BuildProvidersOptions {
  /** Injected fetch (tests); default global fetch. */
  fetchImpl?: FetchLike
}

/** The providers this module offers for the configuration (log + the selected ones). */
export function buildNotificationProviders(
  config: NotificationsConfig,
  logger: LogProviderLogger,
  opts: BuildProvidersOptions = {},
): NotificationProvider[] {
  const timeoutMs = config.notifications.providerTimeoutMs
  const fetchOpt = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}
  const providers: NotificationProvider[] = [
    createLogProvider(logger, { revealBody: !config.isProduction }),
  ]
  if (config.sms.provider === 'msg91')
    providers.push(
      createMsg91Provider({
        authKey: config.sms.msg91.authKey,
        senderId: config.sms.msg91.senderId,
        baseUrl: config.sms.msg91.baseUrl,
        templateIds: config.sms.msg91.templateIds,
        timeoutMs,
        ...fetchOpt,
      }),
    )
  if (config.whatsapp.provider === 'whatsapp_cloud')
    providers.push(
      createWhatsAppCloudProvider({
        phoneNumberId: config.whatsapp.phoneNumberId,
        accessToken: config.whatsapp.accessToken,
        apiVersion: config.whatsapp.apiVersion,
        baseUrl: config.whatsapp.baseUrl,
        timeoutMs,
        ...fetchOpt,
      }),
    )
  if (config.email.provider === 'email_webhook')
    providers.push(
      createEmailWebhookProvider({
        url: config.email.webhookUrl,
        secret: config.email.webhookSecret,
        from: config.email.from,
        timeoutMs,
        ...fetchOpt,
      }),
    )
  return providers
}

const installed = new WeakSet<NotificationProviderRegistry>()

/**
 * Registers this module's providers in the process registry (once per registry) and pins the
 * env-selected provider of each channel. Returns the registry.
 */
export function installNotificationProviders(
  config: NotificationsConfig,
  logger: LogProviderLogger,
  opts: BuildProvidersOptions = {},
): NotificationProviderRegistry {
  const registry = getNotificationProviders()
  if (installed.has(registry)) return registry
  for (const p of buildNotificationProviders(config, logger, opts))
    registry.register(p, { replace: true })
  if (config.sms.provider === 'msg91') registry.select('sms', 'msg91')
  if (config.whatsapp.provider === 'whatsapp_cloud') registry.select('whatsapp', 'whatsapp_cloud')
  if (config.email.provider === 'email_webhook') registry.select('email', 'email_webhook')
  installed.add(registry)
  return registry
}

/**
 * Marks a registry as installed without registering anything (tests that inject fake providers
 * with setNotificationProviders(), so job handlers do not add the env providers to it).
 */
export function adoptNotificationProviders(registry: NotificationProviderRegistry): void {
  installed.add(registry)
}

/** True when the provider really delivers messages (not the log fallback, credentials set). */
export function isLiveProvider(p: NotificationProvider | undefined): boolean {
  return p !== undefined && p.code !== 'log' && p.configured
}

/** Status card of every channel (GET /notification-templates `providers`). */
export function providerStatuses(
  registry: NotificationProviderRegistry,
): NotificationProviderStatus[] {
  return NOTIFICATION_CHANNELS_ORDER.map((channel) => {
    const p = registry.forChannel(channel)
    if (!p)
      return {
        channel,
        provider: 'log',
        configured: false,
        live: false,
        display: null,
        webhook_path: null,
      }
    const s = p.status?.(channel) ?? {
      configured: p.configured,
      live: isLiveProvider(p),
      display: null,
      webhook_path: null,
    }
    return { channel, provider: p.code, ...s, live: s.live && isLiveProvider(p) }
  })
}
