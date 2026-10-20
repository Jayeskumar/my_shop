/**
 * Routes of the payments feature — Receipts & payment vouchers, UPI intents & reconciliation, payment provider setup.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'payments',
      handle: { title: 'nav:titles.payments', permission: 'payments.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'payments/upi',
      handle: { title: 'nav:titles.upi', permission: 'payments.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/payments',
      handle: { title: 'nav:titles.settings_payments', permission: 'payments.configure' },
      Component: ModulePlaceholder,
    },
  ],
}
