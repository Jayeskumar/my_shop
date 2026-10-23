/**
 * Routes of the dashboard feature — Home dashboard.
 * Paths and handles are the contract (nav, guards, links from other modules).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      index: true,
      handle: { title: 'nav:titles.dashboard' },
      lazy: page(() => import('./pages/HomePage')),
    },
  ],
}
