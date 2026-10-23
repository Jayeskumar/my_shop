/**
 * Sidebar navigation (ARCHITECTURE.md §3.1 registry). Items are filtered per user by the same
 * access rules as routes (permission any-of, plan feature, deployment mode, business type,
 * platform admin) and hidden when not allowed; empty groups disappear.
 * Module agents: add items here for new top-level screens (keep `to` equal to the route path).
 */
import {
  ArrowLeftRight,
  BadgePercent,
  Barcode,
  BarChart3,
  BookOpen,
  Boxes,
  BrainCircuit,
  Building2,
  CalendarClock,
  ClipboardList,
  Cog,
  CreditCard,
  FileClock,
  FileInput,
  FileSpreadsheet,
  FileText,
  FolderTree,
  Gauge,
  History,
  Home,
  KeyRound,
  Landmark,
  Layers,
  ListOrdered,
  MessageSquare,
  MonitorSmartphone,
  Package,
  PackageCheck,
  PackageMinus,
  Percent,
  Printer,
  QrCode,
  Receipt,
  ReceiptText,
  ScrollText,
  Server,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Stethoscope,
  Store,
  Tags,
  Truck,
  Undo2,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { AuthState } from '@/lib/auth'
import type { TranslationKey } from '@/lib/i18n-resources'
import { checkAccess, type AccessRule } from '@/lib/permissions'

export interface NavItem extends AccessRule {
  id: string
  label: TranslationKey
  to: string
  icon: LucideIcon
  /** Active only on the exact path (default: also on sub-paths). */
  end?: boolean
  /** Keyboard shortcut shown next to the label. */
  hotkey?: string
}

export interface NavGroup {
  id: string
  label: TranslationKey
  icon: LucideIcon
  items: NavItem[]
}

export const NAV: readonly NavGroup[] = [
  {
    id: 'home',
    label: 'nav:groups.home',
    icon: Home,
    items: [{ id: 'dashboard', label: 'nav:items.dashboard', to: '/', icon: Gauge, end: true }],
  },
  {
    id: 'billing',
    label: 'nav:groups.billing',
    icon: ShoppingCart,
    items: [
      {
        id: 'pos',
        label: 'nav:items.pos',
        to: '/pos',
        icon: ShoppingCart,
        permission: 'pos.use',
        feature: 'pos',
        hotkey: 'F2',
      },
      {
        id: 'sales_invoices',
        label: 'nav:items.sales_invoices',
        to: '/sales/invoices',
        icon: ReceiptText,
        permission: 'sales.read',
      },
      {
        id: 'sales_returns',
        label: 'nav:items.sales_returns',
        to: '/sales/returns',
        icon: Undo2,
        permission: 'sales.return',
      },
      {
        id: 'sales_estimates',
        label: 'nav:items.sales_estimates',
        to: '/sales/estimates',
        icon: FileText,
        permission: 'sales.read',
      },
    ],
  },
  {
    id: 'catalog',
    label: 'nav:groups.catalog',
    icon: Package,
    items: [
      {
        id: 'products',
        label: 'nav:items.products',
        to: '/catalog/products',
        icon: Package,
        permission: 'catalog.read',
      },
      {
        id: 'categories',
        label: 'nav:items.categories',
        to: '/catalog/categories',
        icon: FolderTree,
        permission: 'catalog.read',
      },
      {
        id: 'brands',
        label: 'nav:items.brands',
        to: '/catalog/brands',
        icon: Tags,
        permission: 'catalog.read',
      },
      {
        id: 'promotions',
        label: 'nav:items.promotions',
        to: '/catalog/promotions',
        icon: BadgePercent,
        permission: 'catalog.read',
        feature: 'promotions',
      },
      {
        id: 'tax_rules',
        label: 'nav:items.tax_rules',
        to: '/catalog/tax-rules',
        icon: Percent,
        permission: 'catalog.read',
      },
      {
        id: 'labels',
        label: 'nav:items.labels',
        to: '/catalog/labels',
        icon: Barcode,
        permission: 'catalog.read',
        feature: 'barcode_labels',
      },
      {
        id: 'catalog_import',
        label: 'nav:items.catalog_import',
        to: '/catalog/import',
        icon: FileInput,
        permission: 'catalog.write',
      },
    ],
  },
  {
    id: 'inventory',
    label: 'nav:groups.inventory',
    icon: Boxes,
    items: [
      {
        id: 'stock',
        label: 'nav:items.stock',
        to: '/inventory/stock',
        icon: Boxes,
        permission: 'inventory.read',
      },
      {
        id: 'movements',
        label: 'nav:items.movements',
        to: '/inventory/movements',
        icon: History,
        permission: 'inventory.read',
      },
      {
        id: 'adjustments',
        label: 'nav:items.adjustments',
        to: '/inventory/adjustments',
        icon: PackageMinus,
        permission: 'inventory.adjust',
      },
      {
        id: 'transfers',
        label: 'nav:items.transfers',
        to: '/inventory/transfers',
        icon: ArrowLeftRight,
        permission: 'inventory.transfer',
        feature: 'stock_transfers',
      },
      {
        id: 'batches',
        label: 'nav:items.batches',
        to: '/inventory/batches',
        icon: CalendarClock,
        permission: 'inventory.read',
        feature: 'batches_expiry',
      },
    ],
  },
  {
    id: 'purchases',
    label: 'nav:groups.purchases',
    icon: ShoppingBag,
    items: [
      {
        id: 'purchase_orders',
        label: 'nav:items.purchase_orders',
        to: '/purchases/orders',
        icon: ClipboardList,
        permission: 'purchases.read',
        feature: 'purchases',
      },
      {
        id: 'stocksense',
        label: 'nav:items.stocksense',
        to: '/purchases/stocksense',
        icon: BrainCircuit,
        permission: 'purchases.read',
        feature: 'purchases',
      },
      {
        id: 'purchase_bills',
        label: 'nav:items.purchase_bills',
        to: '/purchases/bills',
        icon: PackageCheck,
        permission: 'purchases.read',
        feature: 'purchases',
      },
      {
        id: 'purchase_returns',
        label: 'nav:items.purchase_returns',
        to: '/purchases/returns',
        icon: Undo2,
        permission: 'purchases.read',
        feature: 'purchases',
      },
      {
        id: 'suppliers',
        label: 'nav:items.suppliers',
        to: '/parties/suppliers',
        icon: Truck,
        permission: 'suppliers.read',
      },
    ],
  },
  {
    id: 'customers',
    label: 'nav:groups.customers',
    icon: Users,
    items: [
      {
        id: 'customers',
        label: 'nav:items.customers',
        to: '/parties/customers',
        icon: Users,
        permission: 'customers.read',
      },
      {
        id: 'doctors',
        label: 'nav:items.doctors',
        to: '/parties/doctors',
        icon: Stethoscope,
        permission: 'customers.read',
        businessTypes: ['pharmacy'],
      },
    ],
  },
  {
    id: 'payments',
    label: 'nav:groups.payments',
    icon: Wallet,
    items: [
      {
        id: 'payments',
        label: 'nav:items.payments',
        to: '/payments',
        icon: Receipt,
        permission: 'payments.read',
        end: true,
      },
      {
        id: 'upi',
        label: 'nav:items.upi',
        to: '/payments/upi',
        icon: QrCode,
        permission: 'payments.read',
      },
    ],
  },
  {
    id: 'accounts',
    label: 'nav:groups.accounts',
    icon: Landmark,
    items: [
      {
        id: 'expenses',
        label: 'nav:items.expenses',
        to: '/accounting/expenses',
        icon: Wallet,
        permission: ['expenses.write', 'accounting.read'],
      },
      {
        id: 'shifts',
        label: 'nav:items.shifts',
        to: '/accounting/shifts',
        icon: FileClock,
        permission: ['shifts.operate', 'shifts.manage'],
        feature: 'shifts',
      },
      {
        id: 'day_book',
        label: 'nav:items.day_book',
        to: '/accounting/day-book',
        icon: BookOpen,
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        id: 'ledgers',
        label: 'nav:items.ledgers',
        to: '/accounting/ledgers',
        icon: Layers,
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        id: 'journal',
        label: 'nav:items.journal',
        to: '/accounting/journal',
        icon: ListOrdered,
        permission: 'accounting.read',
        feature: 'accounting',
      },
      {
        id: 'statements',
        label: 'nav:items.statements',
        to: '/accounting/statements',
        icon: FileSpreadsheet,
        permission: 'accounting.read',
        feature: 'accounting',
      },
    ],
  },
  {
    id: 'reports',
    label: 'nav:groups.reports',
    icon: BarChart3,
    items: [
      {
        id: 'reports',
        label: 'nav:items.reports',
        to: '/reports',
        icon: BarChart3,
        permission: 'reports.read',
        end: true,
      },
      {
        id: 'gst_returns',
        label: 'nav:items.gst_returns',
        to: '/reports/gst',
        icon: ScrollText,
        permission: 'reports.gst',
        feature: 'gst_reports',
      },
    ],
  },
  {
    id: 'settings',
    label: 'nav:groups.settings',
    icon: Cog,
    items: [
      {
        id: 'settings_business',
        label: 'nav:items.settings_business',
        to: '/settings/business',
        icon: Building2,
        permission: 'settings.manage',
      },
      {
        id: 'settings_stores',
        label: 'nav:items.settings_stores',
        to: '/settings/stores',
        icon: Store,
        permission: 'settings.manage',
      },
      {
        id: 'settings_registers',
        label: 'nav:items.settings_registers',
        to: '/settings/registers',
        icon: MonitorSmartphone,
        permission: 'settings.manage',
      },
      {
        id: 'settings_users',
        label: 'nav:items.settings_users',
        to: '/settings/users',
        icon: UserCog,
        permission: 'users.manage',
      },
      {
        id: 'settings_roles',
        label: 'nav:items.settings_roles',
        to: '/settings/roles',
        icon: ShieldCheck,
        permission: 'users.manage',
      },
      {
        id: 'settings_invoice',
        label: 'nav:items.settings_invoice',
        to: '/settings/invoice',
        icon: Printer,
        permission: 'settings.manage',
      },
      {
        id: 'settings_payments',
        label: 'nav:items.settings_payments',
        to: '/settings/payments',
        icon: CreditCard,
        permission: 'payments.configure',
      },
      {
        id: 'settings_notifications',
        label: 'nav:items.settings_notifications',
        to: '/settings/notifications',
        icon: MessageSquare,
        permission: 'settings.manage',
        feature: 'notifications',
      },
      {
        id: 'notifications',
        label: 'nav:items.notifications',
        to: '/notifications',
        icon: MessageSquare,
        permission: 'settings.manage',
      },
      {
        id: 'settings_billing',
        label: 'nav:items.settings_billing',
        to: '/settings/billing',
        icon: Sparkles,
        permission: 'billing.manage',
        mode: 'cloud',
      },
      {
        id: 'settings_api_keys',
        label: 'nav:items.settings_api_keys',
        to: '/settings/api-keys',
        icon: KeyRound,
        permission: 'settings.manage',
        feature: 'api_access',
      },
      {
        id: 'settings_system',
        label: 'nav:items.settings_system',
        to: '/settings/system',
        icon: Server,
        permission: 'settings.manage',
      },
      {
        id: 'settings_audit_log',
        label: 'nav:items.settings_audit_log',
        to: '/settings/audit-log',
        icon: History,
        permission: 'audit.read',
        feature: 'audit_log',
      },
    ],
  },
  {
    id: 'platform',
    label: 'nav:groups.platform',
    icon: ShieldCheck,
    items: [
      {
        id: 'platform',
        label: 'nav:items.platform',
        to: '/platform',
        icon: Gauge,
        platformAdmin: true,
        mode: 'cloud',
        end: true,
      },
      {
        id: 'platform_tenants',
        label: 'nav:items.platform_tenants',
        to: '/platform/tenants',
        icon: Building2,
        platformAdmin: true,
        mode: 'cloud',
      },
      {
        id: 'platform_plans',
        label: 'nav:items.platform_plans',
        to: '/platform/plans',
        icon: Sparkles,
        platformAdmin: true,
        mode: 'cloud',
      },
    ],
  },
]

/** Groups and items the current user may see (no business = platform items only). */
export function visibleNav(state: AuthState, groups: readonly NavGroup[] = NAV): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (!state.me && !item.platformAdmin) return false
        return checkAccess(item, state) === 'allowed'
      }),
    }))
    .filter((group) => group.items.length > 0)
}
