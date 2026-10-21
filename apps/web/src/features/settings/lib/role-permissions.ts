/** Permission-set helpers for the role editor. */
import type { PermissionCatalog } from '@kadai/shared/api/identity'
import type { Permission } from '@kadai/shared/permissions'

/** Permissions implied (transitively) by the selected ones, mapped to the first one implying them. */
export function impliedBy(
  catalog: PermissionCatalog,
  selected: ReadonlySet<Permission>,
): Map<Permission, Permission> {
  const implies = new Map<Permission, readonly Permission[]>()
  for (const g of catalog.groups) for (const p of g.permissions) implies.set(p.code, p.implies)
  const out = new Map<Permission, Permission>()
  for (const root of selected) {
    const stack = [...(implies.get(root) ?? [])]
    while (stack.length) {
      const p = stack.pop()!
      if (p === root || out.has(p)) continue
      out.set(p, root)
      stack.push(...(implies.get(p) ?? []))
    }
  }
  return out
}

/**
 * The code the server derives from a role name when none is given (mirrors slugRoleCode in the
 * identity module): 'Senior pharmacist' → 'senior_pharmacist'; Tamil-only names → 'custom_role'.
 */
export function roleCodeFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/g, '')
    .slice(0, 32)
  return slug.length >= 2 ? slug : 'custom_role'
}
