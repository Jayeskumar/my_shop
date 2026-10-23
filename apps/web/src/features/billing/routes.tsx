/**
 * Routes of the billing feature — SaaS plan & subscription billing (cloud).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'settings/billing',
      handle: {
        title: 'nav:titles.settings_billing',
        permission: 'billing.manage',
        mode: 'cloud',
        parent: { title: 'nav:titles.settings', to: '/settings' },
      },
      lazy: page(() => import('./pages/BillingPage')),
    },
  ],
}
