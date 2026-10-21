/**
 * Routes of the sales feature — Sales invoices, returns (credit notes), estimates and the public
 * invoice page. Paths and handles are the contract (nav, guards, links from other modules).
 * Estimates open in the invoice detail page (/sales/invoices/:id), which adapts to doc_type
 * estimate.
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'sales/invoices',
      handle: { title: 'nav:titles.sales_invoices', permission: 'sales.read' },
      lazy: page(() => import('./pages/InvoicesPage')),
    },
    {
      path: 'sales/invoices/:id',
      handle: {
        title: 'nav:titles.sales_invoice',
        permission: 'sales.read',
        parent: { title: 'nav:titles.sales_invoices', to: '/sales/invoices' },
      },
      lazy: page(() => import('./pages/InvoiceDetailPage')),
    },
    {
      path: 'sales/returns',
      handle: { title: 'nav:titles.sales_returns', permission: 'sales.return' },
      lazy: page(() => import('./pages/ReturnsPage')),
    },
    {
      path: 'sales/returns/new',
      handle: {
        title: 'nav:titles.sales_return_new',
        permission: 'sales.return',
        parent: { title: 'nav:titles.sales_returns', to: '/sales/returns' },
      },
      lazy: page(() => import('./pages/ReturnNewPage')),
    },
    {
      path: 'sales/returns/:id',
      handle: {
        title: 'nav:titles.sales_return',
        permission: 'sales.return',
        parent: { title: 'nav:titles.sales_returns', to: '/sales/returns' },
      },
      lazy: page(() => import('./pages/ReturnDetailPage')),
    },
    {
      path: 'sales/estimates',
      handle: { title: 'nav:titles.sales_estimates', permission: 'sales.read' },
      lazy: page(() => import('./pages/EstimatesPage')),
    },
  ],
  public: [
    {
      path: 'i/:token',
      handle: { title: 'nav:titles.public_invoice' },
      lazy: page(() => import('./pages/PublicInvoicePage')),
    },
  ],
}
