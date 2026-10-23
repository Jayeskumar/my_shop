/**
 * Routes of the parties feature — Customers & khata, suppliers and (pharmacy) doctors.
 * Paths and handles are the contract (nav, guards, links from other modules).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'parties/customers',
      handle: { title: 'nav:titles.customers', permission: 'customers.read' },
      lazy: page(() => import('./pages/CustomersPage')),
    },
    {
      path: 'parties/customers/:id',
      handle: {
        title: 'nav:titles.customer',
        permission: 'customers.read',
        parent: { title: 'nav:titles.customers', to: '/parties/customers' },
      },
      lazy: page(() => import('./pages/CustomerDetailPage')),
    },
    {
      path: 'parties/suppliers',
      handle: { title: 'nav:titles.suppliers', permission: 'suppliers.read' },
      lazy: page(() => import('./pages/SuppliersPage')),
    },
    {
      path: 'parties/suppliers/:id',
      handle: {
        title: 'nav:titles.supplier',
        permission: 'suppliers.read',
        parent: { title: 'nav:titles.suppliers', to: '/parties/suppliers' },
      },
      lazy: page(() => import('./pages/SupplierDetailPage')),
    },
    {
      path: 'parties/doctors',
      handle: {
        title: 'nav:titles.doctors',
        permission: 'customers.read',
        businessTypes: ['pharmacy'],
      },
      lazy: page(() => import('./pages/DoctorsPage')),
    },
  ],
}
