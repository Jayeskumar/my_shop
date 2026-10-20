/**
 * Routes of the purchases feature — Purchase orders, purchase bills (GRN) and purchase returns (debit notes).
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'purchases/orders',
      handle: {
        title: 'nav:titles.purchase_orders',
        permission: 'purchases.read',
        feature: 'purchases',
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/orders/new',
      handle: {
        title: 'nav:titles.purchase_order_new',
        permission: 'purchases.write',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_orders', to: '/purchases/orders' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/orders/:id',
      handle: {
        title: 'nav:titles.purchase_order',
        permission: 'purchases.read',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_orders', to: '/purchases/orders' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/bills',
      handle: {
        title: 'nav:titles.purchase_bills',
        permission: 'purchases.read',
        feature: 'purchases',
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/bills/new',
      handle: {
        title: 'nav:titles.purchase_bill_new',
        permission: 'purchases.write',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_bills', to: '/purchases/bills' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/bills/:id',
      handle: {
        title: 'nav:titles.purchase_bill',
        permission: 'purchases.read',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_bills', to: '/purchases/bills' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/returns',
      handle: {
        title: 'nav:titles.purchase_returns',
        permission: 'purchases.read',
        feature: 'purchases',
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/returns/new',
      handle: {
        title: 'nav:titles.purchase_return_new',
        permission: 'purchases.write',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_returns', to: '/purchases/returns' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'purchases/returns/:id',
      handle: {
        title: 'nav:titles.purchase_return',
        permission: 'purchases.read',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_returns', to: '/purchases/returns' },
      },
      Component: ModulePlaceholder,
    },
  ],
}
