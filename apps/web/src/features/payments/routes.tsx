/**
 * Routes of the payments feature — receipts & payment vouchers (/payments, detail drawer via
 * ?id=), UPI intents & reconciliation (/payments/upi), payment provider setup
 * (/settings/payments, linked from the settings sub-nav) and the public pay page for dues links
 * (/pay/:code — no sign-in; the code is the intent reference_code).
 * Paths and handles are the contract (nav, guards, links from other modules).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'payments',
      handle: { title: 'nav:titles.payments', permission: 'payments.read' },
      lazy: page(() => import('./pages/PaymentsPage')),
    },
    {
      path: 'payments/upi',
      handle: {
        title: 'nav:titles.upi',
        permission: 'payments.read',
        parent: { title: 'nav:titles.payments', to: '/payments' },
      },
      lazy: page(() => import('./pages/UpiReconciliationPage')),
    },
    {
      path: 'settings/payments',
      handle: {
        title: 'nav:titles.settings_payments',
        permission: 'payments.configure',
        parent: { title: 'nav:titles.settings', to: '/settings' },
      },
      lazy: page(() => import('./settings/PaymentSettingsPage')),
    },
  ],
  public: [
    {
      path: 'pay/:code',
      handle: { title: 'payments:pay_page.title' },
      lazy: page(() => import('./pages/PublicPayPage')),
    },
  ],
}
