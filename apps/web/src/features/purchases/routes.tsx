/**
 * Routes of the purchases feature — Purchase orders (with reorder suggestions), StockSense (demand forecast and ranked reorder plan), purchase bills
 * (GRN) and purchase returns (debit notes). Paths and handles are the contract (nav, guards,
 * links from other modules such as inventory's purchaseReturnPrefillPath / reorderPrefillPath).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'purchases/orders',
      handle: {
        title: 'nav:titles.purchase_orders',
        permission: 'purchases.read',
        feature: 'purchases',
      },
      lazy: page(() => import('./pages/OrdersPage')),
    },
    {
      path: 'purchases/orders/new',
      handle: {
        title: 'nav:titles.purchase_order_new',
        permission: 'purchases.write',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_orders', to: '/purchases/orders' },
      },
      lazy: page(() => import('./pages/OrderNewPage')),
    },
    {
      path: 'purchases/orders/:id',
      handle: {
        title: 'nav:titles.purchase_order',
        permission: 'purchases.read',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_orders', to: '/purchases/orders' },
      },
      lazy: page(() => import('./pages/OrderPage')),
    },
    {
      path: 'purchases/stocksense',
      handle: {
        title: 'nav:titles.stocksense',
        permission: 'purchases.read',
        feature: 'purchases',
      },
      lazy: page(() => import('./pages/StockSensePage')),
    },
    {
      path: 'purchases/bills',
      handle: {
        title: 'nav:titles.purchase_bills',
        permission: 'purchases.read',
        feature: 'purchases',
      },
      lazy: page(() => import('./pages/BillsPage')),
    },
    {
      path: 'purchases/bills/new',
      handle: {
        title: 'nav:titles.purchase_bill_new',
        permission: 'purchases.write',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_bills', to: '/purchases/bills' },
      },
      lazy: page(() => import('./pages/BillNewPage')),
    },
    {
      path: 'purchases/bills/:id',
      handle: {
        title: 'nav:titles.purchase_bill',
        permission: 'purchases.read',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_bills', to: '/purchases/bills' },
      },
      lazy: page(() => import('./pages/BillPage')),
    },
    {
      path: 'purchases/returns',
      handle: {
        title: 'nav:titles.purchase_returns',
        permission: 'purchases.read',
        feature: 'purchases',
      },
      lazy: page(() => import('./pages/ReturnsPage')),
    },
    {
      path: 'purchases/returns/new',
      handle: {
        title: 'nav:titles.purchase_return_new',
        permission: 'purchases.write',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_returns', to: '/purchases/returns' },
      },
      lazy: page(() => import('./pages/ReturnNewPage')),
    },
    {
      path: 'purchases/returns/:id',
      handle: {
        title: 'nav:titles.purchase_return',
        permission: 'purchases.read',
        feature: 'purchases',
        parent: { title: 'nav:titles.purchase_returns', to: '/purchases/returns' },
      },
      lazy: page(() => import('./pages/ReturnPage')),
    },
  ],
}
