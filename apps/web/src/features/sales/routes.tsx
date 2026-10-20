/**
 * Routes of the sales feature — Sales invoices, returns (credit notes), estimates and the public invoice page.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'sales/invoices',
      handle: { title: 'nav:titles.sales_invoices', permission: 'sales.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'sales/invoices/:id',
      handle: { title: 'nav:titles.sales_invoice', permission: 'sales.read', parent: { title: 'nav:titles.sales_invoices', to: '/sales/invoices' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'sales/returns',
      handle: { title: 'nav:titles.sales_returns', permission: 'sales.return' },
      Component: ModulePlaceholder,
    },
    {
      path: 'sales/returns/new',
      handle: { title: 'nav:titles.sales_return_new', permission: 'sales.return', parent: { title: 'nav:titles.sales_returns', to: '/sales/returns' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'sales/returns/:id',
      handle: { title: 'nav:titles.sales_return', permission: 'sales.return', parent: { title: 'nav:titles.sales_returns', to: '/sales/returns' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'sales/estimates',
      handle: { title: 'nav:titles.sales_estimates', permission: 'sales.read' },
      Component: ModulePlaceholder,
    },
  ],
  public: [
    {
      path: 'i/:token',
      handle: { title: 'nav:titles.public_invoice' },
      Component: ModulePlaceholder,
    },
  ],
}
