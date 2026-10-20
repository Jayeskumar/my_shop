/**
 * Routes of the inventory feature — Stock levels, movements, adjustments, transfers, batches & expiry.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'inventory/stock',
      handle: { title: 'nav:titles.stock', permission: 'inventory.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/movements',
      handle: { title: 'nav:titles.movements', permission: 'inventory.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/adjustments',
      handle: { title: 'nav:titles.adjustments', permission: 'inventory.adjust' },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/adjustments/new',
      handle: { title: 'nav:titles.adjustment_new', permission: 'inventory.adjust', parent: { title: 'nav:titles.adjustments', to: '/inventory/adjustments' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/adjustments/:id',
      handle: { title: 'nav:titles.adjustment', permission: 'inventory.adjust', parent: { title: 'nav:titles.adjustments', to: '/inventory/adjustments' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/transfers',
      handle: { title: 'nav:titles.transfers', permission: 'inventory.transfer', feature: 'stock_transfers' },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/transfers/new',
      handle: { title: 'nav:titles.transfer_new', permission: 'inventory.transfer', feature: 'stock_transfers', parent: { title: 'nav:titles.transfers', to: '/inventory/transfers' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/transfers/:id',
      handle: { title: 'nav:titles.transfer', permission: 'inventory.transfer', feature: 'stock_transfers', parent: { title: 'nav:titles.transfers', to: '/inventory/transfers' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'inventory/batches',
      handle: { title: 'nav:titles.batches', permission: 'inventory.read', feature: 'batches_expiry' },
      Component: ModulePlaceholder,
    },
  ],
}
