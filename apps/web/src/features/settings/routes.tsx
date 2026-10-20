/**
 * Routes of the settings feature — Business profile, stores, counters & devices, users, roles, invoice settings, audit log.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'settings/business',
      handle: { title: 'nav:titles.settings_business', permission: 'settings.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/stores',
      handle: { title: 'nav:titles.settings_stores', permission: 'settings.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/registers',
      handle: { title: 'nav:titles.settings_registers', permission: 'settings.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/users',
      handle: { title: 'nav:titles.settings_users', permission: 'users.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/roles',
      handle: { title: 'nav:titles.settings_roles', permission: 'users.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/invoice',
      handle: { title: 'nav:titles.settings_invoice', permission: 'settings.manage' },
      Component: ModulePlaceholder,
    },
    {
      path: 'settings/audit-log',
      handle: { title: 'nav:titles.settings_audit_log', permission: 'audit.read', feature: 'audit_log' },
      Component: ModulePlaceholder,
    },
  ],
}
