/** Provider status helpers of the settings page (status cards, "send a test"). */
import {
  ADHOC_TEMPLATE_CODES,
  NOTIFICATION_TEMPLATES,
  type NotificationProviderStatus,
  type NotificationTemplateCode,
} from '@kadai/shared/api/notifications'
import type { NotificationChannel } from '@kadai/shared/enums'

export type ProviderState = 'live' | 'log' | 'off'

export function providerState(p: NotificationProviderStatus): ProviderState {
  if (p.live) return 'live'
  return p.configured ? 'log' : 'off'
}

/** The template used by "Send a test" on a channel (an ad-hoc one the channel supports). */
export function testTemplateFor(
  channel: NotificationChannel,
): NotificationTemplateCode | undefined {
  return (
    ADHOC_TEMPLATE_CODES.find(
      (c) => c === 'welcome' && NOTIFICATION_TEMPLATES[c].channels.includes(channel),
    ) ?? ADHOC_TEMPLATE_CODES.find((c) => NOTIFICATION_TEMPLATES[c].channels.includes(channel))
  )
}
