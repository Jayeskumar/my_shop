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
