/**
 * Routes of the pos feature — Billing counter (POS) and the customer-facing display.
 * Paths and handles are the contract (nav, guards, links from other modules).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  fullscreen: [
    {
      path: 'pos',
      handle: { title: 'nav:titles.pos', permission: 'pos.use', feature: 'pos' },
      lazy: page(() => import('./pages/PosPage')),
    },
  ],
  public: [
    {
      path: 'pos/display',
      handle: { title: 'nav:titles.pos_display' },
      lazy: page(() => import('./pages/CustomerDisplayPage')),
    },
  ],
}
