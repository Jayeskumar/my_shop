/**
 * Routes of the system feature — System info, licence & backups (on-prem) and API keys.
 */
import { page, type FeatureRoutes } from '@/app/route-types'

const parent = { title: 'nav:titles.settings', to: '/settings' } as const

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'settings/system',
      handle: { title: 'nav:titles.settings_system', permission: 'settings.manage', parent },
      lazy: page(() => import('./pages/SystemPage')),
    },
    {
      path: 'settings/api-keys',
      handle: {
        title: 'nav:titles.settings_api_keys',
        permission: 'settings.manage',
        feature: 'api_access',
        parent,
      },
      lazy: page(() => import('./pages/ApiKeysPage')),
    },
  ],
}
