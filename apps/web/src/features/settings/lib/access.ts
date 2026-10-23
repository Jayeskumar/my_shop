/**
 * Who may change what on the settings screens (mirrors the server rules in docs/API.md
 * "identity"): business-wide writes (settings, business profile, roles, new stores) need
 * `settings.manage` / `users.manage` AND access to every store (store-scoped members get 403
 * reason all_stores_required), so the UI shows those screens read-only for them.
 */
import type { Permission } from '@kadai/shared/permissions'
import { useAuth, useCan } from '@/lib/auth'

/** The member's role covers every store (membership.store_ids === null). */
export function useAllStores(): boolean {
  return useAuth((s) => s.me?.membership.store_ids === null)
}

/** Edit rights for a business-wide settings screen. */
export function useBusinessWideEdit(permission: Permission = 'settings.manage'): {
  canEdit: boolean
  /** Has the permission but is limited to some stores. */
  storeScoped: boolean
} {
  const hasPermission = useCan(permission)
  const allStores = useAllStores()
  return { canEdit: hasPermission && allStores, storeScoped: hasPermission && !allStores }
}
