/**
 * Routes of the parties feature — Customers & khata, suppliers and (pharmacy) doctors.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'parties/customers',
      handle: { title: 'nav:titles.customers', permission: 'customers.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'parties/customers/:id',
      handle: {
        title: 'nav:titles.customer',
        permission: 'customers.read',
        parent: { title: 'nav:titles.customers', to: '/parties/customers' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'parties/suppliers',
      handle: { title: 'nav:titles.suppliers', permission: 'suppliers.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'parties/suppliers/:id',
      handle: {
        title: 'nav:titles.supplier',
        permission: 'suppliers.read',
        parent: { title: 'nav:titles.suppliers', to: '/parties/suppliers' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'parties/doctors',
      handle: {
        title: 'nav:titles.doctors',
        permission: 'customers.read',
        businessTypes: ['pharmacy'],
      },
      Component: ModulePlaceholder,
    },
  ],
}
