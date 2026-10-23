/**
 * Routes of the reports feature — Business reports and GST returns.
 * Paths and handles are the contract (nav, guards, links from other modules).
 *
 *  - /reports              grouped report cards (ReportsIndexPage)
 *  - /reports/gst          GSTR-1 / GSTR-3B / HSN with the portal JSON download (GstReturnsPage)
 *  - /reports/:reportKey   generic viewer of the REPORTS catalogue (ReportViewerPage)
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'reports',
      handle: { title: 'nav:titles.reports', permission: 'reports.read' },
      lazy: page(() => import('./pages/ReportsIndexPage')),
    },
    {
      path: 'reports/gst',
      handle: {
        title: 'nav:titles.gst_returns',
        permission: 'reports.gst',
        feature: 'gst_reports',
        parent: { title: 'nav:titles.reports', to: '/reports' },
      },
      lazy: page(() => import('./pages/GstReturnsPage')),
    },
    {
      path: 'reports/:reportKey',
      handle: {
        title: 'nav:titles.report',
        permission: 'reports.read',
        parent: { title: 'nav:titles.reports', to: '/reports' },
      },
      lazy: page(() => import('./pages/ReportViewerPage')),
    },
  ],
}
