/**
 * Routes of the dashboard feature — Home dashboard.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      index: true,
      handle: { title: 'nav:titles.dashboard' },
      Component: ModulePlaceholder,
    },
  ],
}
