/**
 * Routes of the platform feature — Platform administration for Kadai staff (cloud only).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  admin: [
    {
      path: 'platform',
      handle: { title: 'nav:titles.platform', mode: 'cloud', platformAdmin: true },
      lazy: page(() => import('./pages/PlatformOverviewPage')),
    },
    {
      path: 'platform/tenants',
      handle: { title: 'nav:titles.platform_tenants', mode: 'cloud', platformAdmin: true },
      lazy: page(() => import('./pages/PlatformTenantsPage')),
    },
    {
      path: 'platform/tenants/:id',
      handle: {
        title: 'nav:titles.platform_tenant',
        mode: 'cloud',
        platformAdmin: true,
        parent: { title: 'nav:titles.platform_tenants', to: '/platform/tenants' },
      },
      lazy: page(() => import('./pages/PlatformTenantDetailPage')),
    },
    {
      path: 'platform/plans',
      handle: { title: 'nav:titles.platform_plans', mode: 'cloud', platformAdmin: true },
      lazy: page(() => import('./pages/PlatformPlansPage')),
    },
    {
      path: 'platform/licenses',
      handle: { title: 'nav:titles.platform', mode: 'cloud', platformAdmin: true },
      lazy: page(() => import('./pages/PlatformLicensesPage')),
    },
  ],
}
