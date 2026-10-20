/**
 * Routes of the billing feature — SaaS plan & subscription billing (cloud).
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'settings/billing',
      handle: { title: 'nav:titles.settings_billing', permission: 'billing.manage', mode: 'cloud' },
      Component: ModulePlaceholder,
    },
  ],
}
