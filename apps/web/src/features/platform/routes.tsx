/**
 * Routes of the platform feature — Platform administration for Kadai staff (cloud only).
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  admin: [
    {
      path: 'platform',
      handle: { title: 'nav:titles.platform', mode: 'cloud', platformAdmin: true },
      Component: ModulePlaceholder,
    },
    {
      path: 'platform/tenants',
      handle: { title: 'nav:titles.platform_tenants', mode: 'cloud', platformAdmin: true },
      Component: ModulePlaceholder,
    },
    {
      path: 'platform/tenants/:id',
      handle: {
        title: 'nav:titles.platform_tenant',
        mode: 'cloud',
        platformAdmin: true,
        parent: { title: 'nav:titles.platform_tenants', to: '/platform/tenants' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'platform/plans',
      handle: { title: 'nav:titles.platform_plans', mode: 'cloud', platformAdmin: true },
      Component: ModulePlaceholder,
    },
  ],
}
