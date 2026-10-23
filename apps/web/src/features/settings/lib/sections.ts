/**
 * The settings sub-navigation: every settings screen, including the ones other modules own
 * (UPI & payments, notifications, plan & billing, API keys, system), with the same access rules
 * as their routes. Shown as the left sub-nav (desktop), the scrolling strip (phones) and the
 * cards of /settings.
 */
import {
  Building2,
  CreditCard,
  Gift,
  History,
  KeyRound,
  ListOrdered,
  MessageSquare,
  MonitorSmartphone,
  Pill,
  Printer,
  ScanBarcode,
  Server,
  ShieldCheck,
  Sparkles,
  Store,
  UserCog,
  type LucideIcon,
} from 'lucide-react'
import type { TranslationKey } from '@/lib/i18n-resources'
import { checkAccess, type AccessRule } from '@/lib/permissions'
import type { AuthState } from '@/lib/auth'

export type SettingsGroupId = 'business' | 'billing' | 'system'

export interface SettingsSection extends AccessRule {
  id: string
  to: string
  group: SettingsGroupId
  label: TranslationKey
  description: TranslationKey
  icon: LucideIcon
}

export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: TranslationKey }[] = [
  { id: 'business', label: 'settings:nav.group_business' },
  { id: 'billing', label: 'settings:nav.group_billing' },
  { id: 'system', label: 'settings:nav.group_system' },
]

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'business',
    to: '/settings/business',
    group: 'business',
    label: 'settings:nav.business',
    description: 'settings:nav.business_hint',
    icon: Building2,
    permission: 'settings.manage',
  },
  {
    id: 'stores',
    to: '/settings/stores',
    group: 'business',
    label: 'settings:nav.stores',
    description: 'settings:nav.stores_hint',
    icon: Store,
    permission: 'settings.manage',
  },
  {
    id: 'registers',
    to: '/settings/registers',
    group: 'business',
    label: 'settings:nav.registers',
    description: 'settings:nav.registers_hint',
    icon: MonitorSmartphone,
    permission: 'settings.manage',
  },
  {
    id: 'users',
    to: '/settings/users',
    group: 'business',
    label: 'settings:nav.users',
    description: 'settings:nav.users_hint',
    icon: UserCog,
    permission: 'users.manage',
  },
  {
    id: 'roles',
    to: '/settings/roles',
    group: 'business',
    label: 'settings:nav.roles',
    description: 'settings:nav.roles_hint',
    icon: ShieldCheck,
    permission: 'users.manage',
  },
  {
    id: 'invoice',
    to: '/settings/invoice',
    group: 'billing',
    label: 'settings:nav.invoice',
    description: 'settings:nav.invoice_hint',
    icon: Printer,
    permission: 'settings.manage',
  },
  {
    id: 'pos',
    to: '/settings/pos',
    group: 'billing',
    label: 'settings:nav.pos',
    description: 'settings:nav.pos_hint',
    icon: ScanBarcode,
    permission: 'settings.manage',
  },
  {
    id: 'pharmacy',
    to: '/settings/pharmacy',
    group: 'billing',
    label: 'settings:nav.pharmacy',
    description: 'settings:nav.pharmacy_hint',
    icon: Pill,
    permission: 'settings.manage',
    businessTypes: ['pharmacy'],
  },
  {
    id: 'loyalty',
    to: '/settings/loyalty',
    group: 'billing',
    label: 'settings:nav.loyalty',
    description: 'settings:nav.loyalty_hint',
    icon: Gift,
    permission: 'settings.manage',
  },
  {
    id: 'number_series',
    to: '/settings/number-series',
    group: 'billing',
    label: 'settings:nav.number_series',
    description: 'settings:nav.number_series_hint',
    icon: ListOrdered,
    permission: 'settings.manage',
  },
  {
    id: 'payments',
    to: '/settings/payments',
    group: 'billing',
    label: 'settings:nav.payments',
    description: 'settings:nav.payments_hint',
    icon: CreditCard,
    permission: 'payments.configure',
  },
  {
    id: 'notifications',
    to: '/settings/notifications',
    group: 'billing',
    label: 'settings:nav.notifications',
    description: 'settings:nav.notifications_hint',
    icon: MessageSquare,
    permission: 'settings.manage',
    feature: 'notifications',
  },
  {
    id: 'billing',
    to: '/settings/billing',
    group: 'system',
    label: 'settings:nav.billing',
    description: 'settings:nav.billing_hint',
    icon: Sparkles,
    permission: 'billing.manage',
    mode: 'cloud',
  },
  {
    id: 'api_keys',
    to: '/settings/api-keys',
    group: 'system',
    label: 'settings:nav.api_keys',
    description: 'settings:nav.api_keys_hint',
    icon: KeyRound,
    permission: 'settings.manage',
    feature: 'api_access',
  },
  {
    id: 'system',
    to: '/settings/system',
    group: 'system',
    label: 'settings:nav.system',
    description: 'settings:nav.system_hint',
    icon: Server,
    permission: 'settings.manage',
  },
  {
    id: 'audit_log',
    to: '/settings/audit-log',
    group: 'system',
    label: 'settings:nav.audit_log',
    description: 'settings:nav.audit_log_hint',
    icon: History,
    permission: 'audit.read',
    feature: 'audit_log',
  },
]

export interface VisibleSection extends SettingsSection {
  /** Allowed by role but not in the plan: shown with an upgrade mark (the route explains). */
  locked: boolean
}

/**
 * Sections the member may open. Plan-locked sections stay visible (marked) so the shop learns
 * what an upgrade brings; permission, deployment-mode and business-type mismatches are hidden.
 */
export function visibleSections(state: AuthState): VisibleSection[] {
  return SETTINGS_SECTIONS.flatMap<VisibleSection>((section) => {
    const access = checkAccess(section, state)
    if (access === 'allowed') return [{ ...section, locked: false }]
    if (access === 'feature') return [{ ...section, locked: true }]
    return []
  })
}
