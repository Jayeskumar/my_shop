/**
 * Routes of the accounting feature — Expenses, shifts & cash, day book, ledgers, journal and financial statements.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'accounting/expenses',
      handle: { title: 'nav:titles.expenses', permission: ['expenses.write', 'accounting.read'] },
      Component: ModulePlaceholder,
    },
    {
      path: 'accounting/shifts',
      handle: {
        title: 'nav:titles.shifts',
        permission: ['shifts.operate', 'shifts.manage'],
        feature: 'shifts',
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'accounting/shifts/:id',
      handle: {
        title: 'nav:titles.shift',
        permission: ['shifts.operate', 'shifts.manage'],
        feature: 'shifts',
        parent: { title: 'nav:titles.shifts', to: '/accounting/shifts' },
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'accounting/day-book',
      handle: {
        title: 'nav:titles.day_book',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      Component: ModulePlaceholder,
    },
    {
      path: 'accounting/ledgers',
      handle: { title: 'nav:titles.ledgers', permission: 'accounting.read', feature: 'accounting' },
      Component: ModulePlaceholder,
    },
    {
      path: 'accounting/journal',
      handle: { title: 'nav:titles.journal', permission: 'accounting.read', feature: 'accounting' },
      Component: ModulePlaceholder,
    },
    {
      path: 'accounting/statements',
      handle: {
        title: 'nav:titles.statements',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      Component: ModulePlaceholder,
    },
  ],
}
