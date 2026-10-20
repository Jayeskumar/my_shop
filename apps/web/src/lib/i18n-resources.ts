/**
 * Translation key typing. The English files are the source of truth for key names; every
 * namespace file must be listed here (module agents: your file is already listed — just add keys
 * to both en/<ns>.json and ta/<ns>.json). The ta/en parity test (src/lib/i18n.test.ts) fails if
 * the two languages drift apart.
 */
import type accounting from '../locales/en/accounting.json'
import type auth from '../locales/en/auth.json'
import type billing from '../locales/en/billing.json'
import type catalog from '../locales/en/catalog.json'
import type common from '../locales/en/common.json'
import type dashboard from '../locales/en/dashboard.json'
import type errors from '../locales/en/errors.json'
import type inventory from '../locales/en/inventory.json'
import type nav from '../locales/en/nav.json'
import type notifications from '../locales/en/notifications.json'
import type parties from '../locales/en/parties.json'
import type payments from '../locales/en/payments.json'
import type platform from '../locales/en/platform.json'
import type pos from '../locales/en/pos.json'
import type purchases from '../locales/en/purchases.json'
import type reports from '../locales/en/reports.json'
import type sales from '../locales/en/sales.json'
import type settings from '../locales/en/settings.json'
import type system from '../locales/en/system.json'

export interface Resources {
  accounting: typeof accounting
  auth: typeof auth
  billing: typeof billing
  catalog: typeof catalog
  common: typeof common
  dashboard: typeof dashboard
  errors: typeof errors
  inventory: typeof inventory
  nav: typeof nav
  notifications: typeof notifications
  parties: typeof parties
  payments: typeof payments
  platform: typeof platform
  pos: typeof pos
  purchases: typeof purchases
  reports: typeof reports
  sales: typeof sales
  settings: typeof settings
  system: typeof system
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: Resources
    returnNull: false
  }
}
