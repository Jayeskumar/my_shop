/**
 * Routes of the notifications feature:
 *  - /notifications — the message log (SMS / WhatsApp / email outbox) with delivery status,
 *    filters in the URL, auto-refresh, retry and a detail drawer (?id=);
 *  - /settings/notifications — sending services, automatic messages (settings.notifications via
 *    PATCH /settings) and the message-text editor (linked from the settings sub-nav).
 * The customer due-reminder dialog for the parties pages is exported from ./components.
 * Paths and handles are the contract (nav, guards, links from other modules).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'notifications',
      handle: { title: 'nav:titles.notifications', permission: 'settings.manage' },
      lazy: page(() => import('./pages/OutboxPage')),
    },
    {
      path: 'settings/notifications',
      handle: {
        title: 'nav:titles.settings_notifications',
        permission: 'settings.manage',
        feature: 'notifications',
        parent: { title: 'nav:titles.settings', to: '/settings' },
      },
      lazy: page(() => import('./settings/NotificationSettingsPage')),
    },
  ],
}
