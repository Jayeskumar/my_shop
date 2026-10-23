/**
 * Routes of the accounting feature — expenses, shifts & cash, day book, ledgers, journal,
 * financial statements and the chart of accounts. Paths and handles are the contract (nav,
 * guards, links from other modules: journal source links, POS "close shift", khata ledgers).
 * Detail views that are drawers take `?id=` (JOURNAL_SOURCE_ROUTES).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'accounting/expenses',
      handle: { title: 'nav:titles.expenses', permission: ['expenses.write', 'accounting.read'] },
      lazy: page(() => import('./pages/ExpensesPage')),
    },
    {
      path: 'accounting/shifts',
      handle: {
        title: 'nav:titles.shifts',
        permission: ['shifts.operate', 'shifts.manage'],
        feature: 'shifts',
      },
      lazy: page(() => import('./pages/ShiftsPage')),
    },
    {
      path: 'accounting/shifts/:id',
      handle: {
        title: 'nav:titles.shift',
        permission: ['shifts.operate', 'shifts.manage'],
        feature: 'shifts',
        parent: { title: 'nav:titles.shifts', to: '/accounting/shifts' },
      },
      lazy: page(() => import('./pages/ShiftDetailPage')),
    },
    {
      path: 'accounting/day-book',
      handle: {
        title: 'nav:titles.day_book',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      lazy: page(() => import('./pages/DayBookPage')),
    },
    {
      path: 'accounting/ledgers',
      handle: { title: 'nav:titles.ledgers', permission: 'accounting.read', feature: 'accounting' },
      lazy: page(() => import('./pages/LedgersPage')),
    },
    {
      path: 'accounting/journal',
      handle: { title: 'nav:titles.journal', permission: 'accounting.read', feature: 'accounting' },
      lazy: page(() => import('./pages/JournalPage')),
    },
    {
      path: 'accounting/statements',
      handle: {
        title: 'nav:titles.statements',
        permission: 'accounting.read',
        feature: 'accounting',
      },
      lazy: page(() => import('./pages/StatementsPage')),
    },
    {
      path: 'accounting/accounts',
      handle: {
        title: 'accounting:accounts.title',
        permission: 'accounting.read',
        feature: 'accounting',
        parent: { title: 'nav:titles.ledgers', to: '/accounting/ledgers' },
      },
      lazy: page(() => import('./pages/ChartOfAccountsPage')),
    },
  ],
}
