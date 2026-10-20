/**
 * Routes of the system feature — System info, licence & backups (on-prem) and API keys.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'settings/system',
      handle: { title: 'nav:titles.settings_system', permission: 'settings.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/api-keys',
      handle: {
        title: 'nav:titles.settings_api_keys',
        permission: 'settings.manage',
        feature: 'api_access',
      },
      Component: ModulePlaceholder,
    },
  ],
}
