/**
 * Routes of the settings feature — Business profile, stores, counters & devices, users, roles,
 * invoice & printing, POS & stock, pharmacy, loyalty & credit, number series and the audit log.
 * Every screen renders inside SettingsLayout (left sub-nav / phone strip); /settings itself is
 * the section overview (the phone entry point). Child paths are relative to /settings.
 * Settings screens of other modules (/settings/payments, /notifications, /billing, /api-keys,
 * /system) live in their own features and are linked from the sub-nav.
 */
import { page, type FeatureRoutes } from '@/app/route-types'

const parent = { title: 'nav:titles.settings', to: '/settings' } as const

export const routes: FeatureRoutes = {
  app: [
    {
      // /settings itself renders the section overview (SettingsLayout without a child route).
      path: 'settings',
      handle: { title: 'nav:titles.settings' },
      lazy: page(() => import('./components/SettingsLayout')),
      children: [
        {
          path: 'business',
          handle: { title: 'nav:titles.settings_business', permission: 'settings.manage', parent },
          lazy: page(() => import('./pages/BusinessPage')),
        },
        {
          path: 'stores',
          handle: { title: 'nav:titles.settings_stores', permission: 'settings.manage', parent },
          lazy: page(() => import('./pages/StoresPage')),
        },
        {
          path: 'registers',
          handle: { title: 'nav:titles.settings_registers', permission: 'settings.manage', parent },
          lazy: page(() => import('./pages/RegistersPage')),
        },
        {
          path: 'users',
          handle: { title: 'nav:titles.settings_users', permission: 'users.manage', parent },
          lazy: page(() => import('./pages/UsersPage')),
        },
        {
          path: 'roles',
          handle: { title: 'nav:titles.settings_roles', permission: 'users.manage', parent },
          lazy: page(() => import('./pages/RolesPage')),
        },
        {
          path: 'invoice',
          handle: { title: 'nav:titles.settings_invoice', permission: 'settings.manage', parent },
          lazy: page(() => import('./pages/InvoiceSettingsPage')),
        },
        {
          path: 'pos',
          handle: { title: 'settings:pages.pos', permission: 'settings.manage', parent },
          lazy: page(() => import('./pages/PosSettingsPage')),
        },
        {
          path: 'pharmacy',
          handle: {
            title: 'settings:pages.pharmacy',
            permission: 'settings.manage',
            businessTypes: ['pharmacy'],
            parent,
          },
          lazy: page(() => import('./pages/PharmacySettingsPage')),
        },
        {
          path: 'loyalty',
          handle: { title: 'settings:pages.loyalty', permission: 'settings.manage', parent },
          lazy: page(() => import('./pages/LoyaltySettingsPage')),
        },
        {
          path: 'number-series',
          handle: { title: 'settings:pages.number_series', permission: 'settings.manage', parent },
          lazy: page(() => import('./pages/NumberSeriesPage')),
        },
        {
          path: 'audit-log',
          handle: {
            title: 'nav:titles.settings_audit_log',
            permission: 'audit.read',
            feature: 'audit_log',
            parent,
          },
          lazy: page(() => import('./pages/AuditLogPage')),
        },
      ],
    },
  ],
}
