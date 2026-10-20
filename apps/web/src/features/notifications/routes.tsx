/**
 * Routes of the notifications feature — Message log (SMS / WhatsApp outbox) and notification settings/templates.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'notifications',
      handle: { title: 'nav:titles.notifications', permission: 'settings.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/notifications',
      handle: { title: 'nav:titles.settings_notifications', permission: 'settings.manage', feature: 'notifications' },
      Component: ModulePlaceholder,
    },
  ],
}
