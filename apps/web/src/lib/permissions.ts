/**
 * Permission / feature gating for UI elements. Route-level gating uses the route `handle`
 * (app/guards.tsx); use these for buttons, menu items and sections:
 *
 *   <Can permission="sales.cancel"><Button>Cancel bill</Button></Can>
 *   <Can feature="promotions" fallback={<UpgradeHint />}>…</Can>
 *   const canExport = usePermission('data.export')
 *
 * The server enforces the same checks; hiding is only about a clean UI.
 */
import type { ReactNode } from 'react'
import type { BusinessType, DeploymentMode } from '@kadai/shared/enums'
import type { Feature } from '@kadai/shared/features'
import { hasPermission, type Permission } from '@kadai/shared/permissions'
import { useAuth, type AuthState } from './auth'

export interface AccessRule {
  /** Any-of. */
  permission?: Permission | readonly Permission[]
  feature?: Feature
  mode?: DeploymentMode
  /** Only for these business types (e.g. doctors → pharmacy). */
  businessTypes?: readonly BusinessType[]
  /** Kadai platform administrators (cloud vendor staff). */
  platformAdmin?: boolean
}

export type AccessResult = 'allowed' | 'forbidden' | 'feature' | 'mode' | 'business_type'

/** Evaluates an access rule against the auth state; the first failing check wins. */
export function checkAccess(rule: AccessRule, s: AuthState): AccessResult {
  const mode = s.me?.mode ?? s.deployment.mode
  if (rule.mode && mode && rule.mode !== mode) return 'mode'
  if (rule.platformAdmin && !s.session?.user.is_platform_admin) return 'forbidden'
  if (rule.businessTypes && s.me && !rule.businessTypes.includes(s.me.tenant.business_type))
    return 'business_type'
  if (rule.permission && !hasPermission(s.permissions, rule.permission)) return 'forbidden'
  if (rule.feature && !s.features.has(rule.feature)) return 'feature'
  return 'allowed'
}

/** React hook form of {@link checkAccess}. */
export function useAccess(rule: AccessRule): AccessResult {
  const state = useAuth((s) => s)
  return checkAccess(rule, state)
}

export function usePermission(permission: Permission | readonly Permission[]): boolean {
  const permissions = useAuth((s) => s.permissions)
  return hasPermission(permissions, permission)
}

export interface CanProps extends AccessRule {
  children: ReactNode
  /** Rendered when access is denied (default: nothing). */
  fallback?: ReactNode
}

export function Can({ children, fallback = null, ...rule }: CanProps): ReactNode {
  const access = useAccess(rule)
  return access === 'allowed' ? children : fallback
}
