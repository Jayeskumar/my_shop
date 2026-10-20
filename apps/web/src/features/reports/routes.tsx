/**
 * Routes of the reports feature — Business reports and GST returns.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'reports',
      handle: { title: 'nav:titles.reports', permission: 'reports.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'reports/gst',
      handle: {
        title: 'nav:titles.gst_returns',
        permission: 'reports.gst',
        feature: 'gst_reports',
        parent: { title: 'nav:titles.reports', to: '/reports' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'reports/:reportKey',
      handle: {
        title: 'nav:titles.report',
        permission: 'reports.read',
        parent: { title: 'nav:titles.reports', to: '/reports' },
      },
      Component: ModulePlaceholder,
    },
  ],
}
