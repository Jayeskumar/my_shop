/**
 * Permission catalogue — the single source of permission codes (ARCHITECTURE.md §7.5) — and the
 * system role presets seeded for every tenant.
 */
import { z } from 'zod'

export interface PermissionDef {
  group: PermissionGroup
  label_en: string
  label_ta: string
}

export const PERMISSION_GROUPS = {
  pos: { label_en: 'Billing counter', label_ta: 'பில்லிங் கவுண்டர்' },
  sales: { label_en: 'Sales', label_ta: 'விற்பனை' },
  catalog: { label_en: 'Products', label_ta: 'பொருட்கள்' },
  inventory: { label_en: 'Stock', label_ta: 'சரக்கு இருப்பு' },
  customers: { label_en: 'Customers', label_ta: 'வாடிக்கையாளர்கள்' },
  suppliers: { label_en: 'Suppliers', label_ta: 'சப்ளையர்கள்' },
  purchases: { label_en: 'Purchases', label_ta: 'கொள்முதல்' },
  payments: { label_en: 'Payments', label_ta: 'பணம் செலுத்துதல்' },
  accounting: { label_en: 'Accounts', label_ta: 'கணக்குகள்' },
  shifts: { label_en: 'Shifts & cash', label_ta: 'ஷிஃப்ட் & ரொக்கம்' },
  reports: { label_en: 'Reports', label_ta: 'அறிக்கைகள்' },
  notifications: { label_en: 'Messages', label_ta: 'செய்திகள்' },
  settings: { label_en: 'Settings', label_ta: 'அமைப்புகள்' },
  users: { label_en: 'Users & roles', label_ta: 'பயனர்கள் & பொறுப்புகள்' },
  audit: { label_en: 'Audit log', label_ta: 'தணிக்கைப் பதிவு' },
  billing: { label_en: 'Subscription', label_ta: 'சந்தா' },
  data: { label_en: 'Data', label_ta: 'தரவு' },
} as const
export type PermissionGroup = keyof typeof PERMISSION_GROUPS

const p = (group: PermissionGroup, label_en: string, label_ta: string): PermissionDef => ({ group, label_en, label_ta })

export const PERMISSIONS = {
  'pos.use': p('pos', 'Use the billing counter (POS)', 'பில்லிங் கவுண்டரைப் பயன்படுத்துதல்'),
  'sales.create': p('sales', 'Create bills', 'பில் போடுதல்'),
  'sales.read': p('sales', 'View bills', 'பில்களைப் பார்த்தல்'),
  'sales.cancel': p('sales', 'Cancel bills', 'பில்லை ரத்து செய்தல்'),
  'sales.return': p('sales', 'Accept returns (credit notes)', 'திருப்பி வாங்குதல் (கிரெடிட் நோட்)'),
  'sales.discount_override': p('sales', 'Give discounts above the limit', 'வரம்புக்கு மேல் தள்ளுபடி தருதல்'),
  'sales.price_override': p('sales', 'Change selling price on a bill', 'பில்லில் விற்பனை விலையை மாற்றுதல்'),
  'sales.credit': p('sales', 'Sell on credit (khata)', 'கடனுக்கு விற்றல் (கணக்கு)'),
  'catalog.read': p('catalog', 'View products', 'பொருட்களைப் பார்த்தல்'),
  'catalog.write': p('catalog', 'Add and edit products, prices and offers', 'பொருட்கள், விலைகள், சலுகைகளைச் சேர்த்தல் / மாற்றுதல்'),
  'inventory.read': p('inventory', 'View stock', 'சரக்கு இருப்பைப் பார்த்தல்'),
  'inventory.adjust': p('inventory', 'Adjust stock and batches', 'சரக்கு இருப்பைச் சரிசெய்தல்'),
  'inventory.transfer': p('inventory', 'Transfer stock between stores', 'கிளைகளுக்கு இடையே சரக்கு மாற்றுதல்'),
  'customers.read': p('customers', 'View customers and dues', 'வாடிக்கையாளர்கள் & நிலுவைகளைப் பார்த்தல்'),
  'customers.write': p('customers', 'Add and edit customers', 'வாடிக்கையாளர்களைச் சேர்த்தல் / மாற்றுதல்'),
  'suppliers.read': p('suppliers', 'View suppliers', 'சப்ளையர்களைப் பார்த்தல்'),
  'suppliers.write': p('suppliers', 'Add and edit suppliers', 'சப்ளையர்களைச் சேர்த்தல் / மாற்றுதல்'),
  'purchases.read': p('purchases', 'View purchases', 'கொள்முதல்களைப் பார்த்தல்'),
  'purchases.write': p('purchases', 'Enter purchase orders and bills', 'கொள்முதல் ஆர்டர் & பில் பதிவு செய்தல்'),
  'payments.read': p('payments', 'View payments and UPI reconciliation', 'பணப் பரிவர்த்தனைகள் & UPI சரிபார்ப்பைப் பார்த்தல்'),
  'payments.collect': p('payments', 'Collect payments (cash, UPI, card)', 'பணம் வசூலித்தல் (ரொக்கம், UPI, கார்டு)'),
  'payments.pay': p('payments', 'Pay suppliers and refunds', 'சப்ளையருக்கு பணம் / திருப்பித் தருதல்'),
  'payments.configure': p('payments', 'Configure UPI / payment providers', 'UPI / பேமெண்ட் அமைப்புகள்'),
  'accounting.read': p('accounting', 'View accounts and statements', 'கணக்குகள் & அறிக்கைகளைப் பார்த்தல்'),
  'accounting.write': p('accounting', 'Post journal entries', 'பேரேட்டுப் பதிவுகள் செய்தல்'),
  'expenses.write': p('accounting', 'Record expenses', 'செலவுகளைப் பதிவு செய்தல்'),
  'shifts.operate': p('shifts', 'Open and close own shift', 'சொந்த ஷிஃப்டைத் திறத்தல் / மூடுதல்'),
  'shifts.manage': p('shifts', 'Manage all shifts and cash', 'அனைத்து ஷிஃப்டுகள் & ரொக்கத்தை நிர்வகித்தல்'),
  'reports.read': p('reports', 'View business reports', 'வணிக அறிக்கைகளைப் பார்த்தல்'),
  'reports.gst': p('reports', 'View and export GST returns', 'GST ரிட்டர்ன்களைப் பார்த்தல் / ஏற்றுமதி'),
  'notifications.send': p('notifications', 'Send SMS / WhatsApp messages', 'SMS / வாட்ஸ்அப் செய்தி அனுப்புதல்'),
  'settings.manage': p('settings', 'Manage shop settings, stores and counters', 'கடை அமைப்புகள், கிளைகள், கவுண்டர்களை நிர்வகித்தல்'),
  'users.manage': p('users', 'Manage users and roles', 'பயனர்கள் & பொறுப்புகளை நிர்வகித்தல்'),
  'audit.read': p('audit', 'View audit log', 'தணிக்கைப் பதிவைப் பார்த்தல்'),
  'billing.manage': p('billing', 'Manage subscription and billing', 'சந்தா & கட்டணங்களை நிர்வகித்தல்'),
  'data.export': p('data', 'Export data', 'தரவை ஏற்றுமதி செய்தல்'),
} as const satisfies Record<string, PermissionDef>

export type Permission = keyof typeof PERMISSIONS

export const PERMISSION_CODES = Object.keys(PERMISSIONS) as [Permission, ...Permission[]]

export const PermissionSchema = z.enum(PERMISSION_CODES)

export function isPermission(code: unknown): code is Permission {
  return typeof code === 'string' && Object.hasOwn(PERMISSIONS, code)
}

/**
 * Implied permissions: holding the key grants the listed permissions too (a writer can read).
 * Applied by {@link expandPermissions}.
 */
export const PERMISSION_IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  'sales.create': ['sales.read'],
  'sales.cancel': ['sales.read'],
  'sales.return': ['sales.read'],
  'catalog.write': ['catalog.read'],
  'inventory.adjust': ['inventory.read'],
  'inventory.transfer': ['inventory.read'],
  'customers.write': ['customers.read'],
  'suppliers.write': ['suppliers.read'],
  'purchases.write': ['purchases.read'],
  'payments.configure': ['payments.read'],
  'payments.pay': ['payments.read'],
  'accounting.write': ['accounting.read'],
  'shifts.manage': ['shifts.operate'],
  'reports.gst': ['reports.read'],
}

/**
 * Resolves stored role permission strings into the effective set:
 * '*' = every permission, 'group.*' = every permission of a group (e.g. 'sales.*'),
 * plus implied permissions. Unknown codes are ignored (forward/backward compatibility).
 */
export function expandPermissions(codes: Iterable<string>): Set<Permission> {
  const out = new Set<Permission>()
  const add = (perm: Permission): void => {
    if (out.has(perm)) return
    out.add(perm)
    for (const implied of PERMISSION_IMPLIES[perm] ?? []) add(implied)
  }
  for (const raw of codes) {
    const code = raw.trim()
    if (code === '*') {
      PERMISSION_CODES.forEach(add)
    } else if (code.endsWith('.*')) {
      const group = code.slice(0, -2)
      PERMISSION_CODES.filter((c) => c.startsWith(`${group}.`)).forEach(add)
    } else if (isPermission(code)) {
      add(code)
    }
  }
  return out
}

/** True when the holder has `needed`; with an array, any of them (route guards are any-of). */
export function hasPermission(perms: ReadonlySet<string> | Iterable<string>, needed: Permission | readonly Permission[]): boolean {
  const set = perms instanceof Set ? (perms as ReadonlySet<string>) : new Set(perms)
  const list: readonly Permission[] = typeof needed === 'string' ? [needed] : needed
  return list.some((perm) => set.has(perm))
}

export function hasAllPermissions(perms: ReadonlySet<string> | Iterable<string>, needed: readonly Permission[]): boolean {
  const set = perms instanceof Set ? (perms as ReadonlySet<string>) : new Set(perms)
  return needed.every((perm) => set.has(perm))
}

// ---------------------------------------------------------------------------------------------
// System roles
// ---------------------------------------------------------------------------------------------

export const SYSTEM_ROLE_CODES = ['owner', 'manager', 'cashier', 'accountant', 'inventory_clerk', 'pharmacist'] as const
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number]

export interface RolePreset {
  code: SystemRoleCode
  name_en: string
  name_ta: string
  description: string
  description_ta: string
  permissions: readonly Permission[]
}

const CASHIER: readonly Permission[] = [
  'pos.use',
  'sales.create',
  'sales.read',
  'sales.credit',
  'sales.return',
  'catalog.read',
  'inventory.read',
  'customers.read',
  'customers.write',
  'payments.collect',
  'shifts.operate',
]

export const ROLE_PRESETS: Readonly<Record<SystemRoleCode, RolePreset>> = {
  owner: {
    code: 'owner',
    name_en: 'Owner',
    name_ta: 'உரிமையாளர்',
    description: 'Full access to everything, including subscription and users',
    description_ta: 'சந்தா, பயனர்கள் உட்பட அனைத்திற்கும் முழு அனுமதி',
    permissions: PERMISSION_CODES,
  },
  manager: {
    code: 'manager',
    name_en: 'Manager',
    name_ta: 'மேலாளர்',
    description: 'Runs the shop day to day: everything except the subscription',
    description_ta: 'தினசரி கடை நிர்வாகம்: சந்தா தவிர அனைத்தும்',
    permissions: PERMISSION_CODES.filter((c) => c !== 'billing.manage'),
  },
  cashier: {
    code: 'cashier',
    name_en: 'Cashier',
    name_ta: 'காசாளர்',
    description: 'Billing counter: bills, returns, customer dues collection and own shift',
    description_ta: 'பில்லிங் கவுண்டர்: பில், திருப்பம், நிலுவை வசூல், சொந்த ஷிஃப்ட்',
    permissions: CASHIER,
  },
  accountant: {
    code: 'accountant',
    name_en: 'Accountant',
    name_ta: 'கணக்காளர்',
    description: 'Books, expenses, GST returns and reports; no billing',
    description_ta: 'கணக்குப் புத்தகங்கள், செலவுகள், GST ரிட்டர்ன்கள், அறிக்கைகள்',
    permissions: [
      'sales.read',
      'purchases.read',
      'payments.read',
      'accounting.read',
      'accounting.write',
      'expenses.write',
      'reports.read',
      'reports.gst',
      'customers.read',
      'suppliers.read',
      'data.export',
    ],
  },
  inventory_clerk: {
    code: 'inventory_clerk',
    name_en: 'Inventory clerk',
    name_ta: 'சரக்கு எழுத்தர்',
    description: 'Products, stock, purchases and suppliers',
    description_ta: 'பொருட்கள், சரக்கு இருப்பு, கொள்முதல், சப்ளையர்கள்',
    permissions: [
      'catalog.read',
      'catalog.write',
      'inventory.read',
      'inventory.adjust',
      'inventory.transfer',
      'purchases.read',
      'purchases.write',
      'suppliers.read',
      'suppliers.write',
    ],
  },
  pharmacist: {
    code: 'pharmacist',
    name_en: 'Pharmacist',
    name_ta: 'மருந்தாளர்',
    description: 'Cashier rights plus discounts, batch/expiry adjustments and reports (Schedule H1 register)',
    description_ta: 'காசாளர் அனுமதிகள் + தள்ளுபடி, பேட்ச்/காலாவதி சரிசெய்தல், அறிக்கைகள் (H1 பதிவேடு)',
    permissions: [...CASHIER, 'sales.discount_override', 'inventory.adjust', 'reports.read'],
  },
}
