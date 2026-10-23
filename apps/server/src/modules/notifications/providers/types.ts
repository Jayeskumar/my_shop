/** Provider-facing types re-exported from the contract, plus the module's channel order. */
import type { NotificationChannel } from '@kadai/shared'

export type {
  NotificationProvider,
  NotificationProviderRegistry,
  NotificationProviderStatus,
} from '@kadai/shared/api/notifications'

/** Display order of the channel status cards. */
export const NOTIFICATION_CHANNELS_ORDER: readonly NotificationChannel[] = [
  'whatsapp',
  'sms',
  'email',
]
