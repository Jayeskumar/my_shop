/**
 * Routes of the dashboard feature — Home dashboard (/). Open to every member: owners and managers
 * with reports.read see the business at a glance; others get their quick actions.
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      index: true,
      handle: { title: 'nav:titles.dashboard' },
      lazy: page(() => import('./pages/DashboardPage')),
    },
  ],
}
