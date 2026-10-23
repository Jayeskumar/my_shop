/**
 * Routes of the inventory feature — Stock levels, movements, adjustments, transfers, batches & expiry.
 * Paths and handles are the contract (nav, guards, links from other modules).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'inventory/stock',
      handle: { title: 'nav:titles.stock', permission: 'inventory.read' },
      lazy: page(() => import('./pages/StockPage')),
    },
    {
      path: 'inventory/movements',
      handle: { title: 'nav:titles.movements', permission: 'inventory.read' },
      lazy: page(() => import('./pages/MovementsPage')),
    },
    {
      path: 'inventory/adjustments',
      handle: { title: 'nav:titles.adjustments', permission: 'inventory.adjust' },
      lazy: page(() => import('./pages/AdjustmentsPage')),
    },
    {
      path: 'inventory/adjustments/new',
      handle: {
        title: 'nav:titles.adjustment_new',
        permission: 'inventory.adjust',
        parent: { title: 'nav:titles.adjustments', to: '/inventory/adjustments' },
      },
      lazy: page(() => import('./pages/AdjustmentNewPage')),
    },
    {
      path: 'inventory/adjustments/:id',
      handle: {
        title: 'nav:titles.adjustment',
        permission: 'inventory.adjust',
        parent: { title: 'nav:titles.adjustments', to: '/inventory/adjustments' },
      },
      lazy: page(() => import('./pages/AdjustmentPage')),
    },
    {
      path: 'inventory/transfers',
      handle: {
        title: 'nav:titles.transfers',
        permission: 'inventory.transfer',
        feature: 'stock_transfers',
      },
      lazy: page(() => import('./pages/TransfersPage')),
    },
    {
      path: 'inventory/transfers/new',
      handle: {
        title: 'nav:titles.transfer_new',
        permission: 'inventory.transfer',
        feature: 'stock_transfers',
        parent: { title: 'nav:titles.transfers', to: '/inventory/transfers' },
      },
      lazy: page(() => import('./pages/TransferNewPage')),
    },
    {
      path: 'inventory/transfers/:id',
      handle: {
        title: 'nav:titles.transfer',
        permission: 'inventory.transfer',
        feature: 'stock_transfers',
        parent: { title: 'nav:titles.transfers', to: '/inventory/transfers' },
      },
      lazy: page(() => import('./pages/TransferPage')),
    },
    {
      path: 'inventory/batches',
      handle: {
        title: 'nav:titles.batches',
        permission: 'inventory.read',
        feature: 'batches_expiry',
      },
      lazy: page(() => import('./pages/BatchesPage')),
    },
  ],
}
