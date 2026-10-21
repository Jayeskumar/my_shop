/**
 * Permission matrix of a role, grouped by area (GET /permissions catalogue) with labels in the
 * UI language (the other language underneath), a tri-state "select all" per group, search, and
 * implications: a permission granted by another selected one (catalog.write → catalog.read) is
 * shown ticked and locked with the reason. Permissions the editor does not hold themselves can't
 * be granted (the server refuses them too) and are shown disabled.
 */
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionCatalog } from '@kadai/shared/api/identity'
import type { Permission } from '@kadai/shared/permissions'
import { Badge, Checkbox, Input } from '@/components/ui'
import { cn } from '@/lib/cn'
import { getLanguage } from '@/lib/i18n'
import { impliedBy } from '../lib/role-permissions'

type Entry = PermissionCatalog['groups'][number]['permissions'][number]

export function PermissionMatrix({
  catalog,
  selected,
  onChange,
  readOnly = false,
  grantable,
}: {
  catalog: PermissionCatalog
  selected: ReadonlySet<Permission>
  onChange?: (next: Set<Permission>) => void
  readOnly?: boolean
  /** Permissions the editor may grant (null = all). */
  grantable?: ReadonlySet<Permission> | null
}) {
  const { t } = useTranslation('settings')
  const [query, setQuery] = useState('')
  const ta = getLanguage() === 'ta'
  const implied = useMemo(() => impliedBy(catalog, selected), [catalog, selected])
  const labelOf = useMemo(() => {
    const m = new Map<Permission, Entry>()
    for (const g of catalog.groups) for (const p of g.permissions) m.set(p.code, p)
    return m
  }, [catalog])
  const q = query.trim().toLowerCase()
  const groups = catalog.groups
    .map((g) => ({
      ...g,
      permissions: q
        ? g.permissions.filter(
            (p) =>
              p.label_en.toLowerCase().includes(q) ||
              p.label_ta.includes(query.trim()) ||
              p.code.includes(q) ||
              g.label_en.toLowerCase().includes(q) ||
              g.label_ta.includes(query.trim()),
          )
        : g.permissions,
    }))
    .filter((g) => g.permissions.length > 0)

  const canGrant = (p: Permission): boolean => !grantable || grantable.has(p) || selected.has(p)
  const toggle = (p: Permission, on: boolean): void => {
    const next = new Set(selected)
    if (on) next.add(p)
    else next.delete(p)
    onChange?.(next)
  }
  const effectiveCount = new Set([...selected, ...implied.keys()]).size

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('roles.search_permissions')}
          aria-label={t('roles.search_permissions')}
          startAdornment={<Search className="size-4 text-muted-foreground" aria-hidden />}
          wrapperClassName="sm:max-w-xs"
        />
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {t('roles.permission_count', { count: effectiveCount })}
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map((g) => {
          const codes = g.permissions.map((p) => p.code)
          const toggleable = codes.filter((c) => !implied.has(c) && canGrant(c))
          const on = codes.filter((c) => selected.has(c) || implied.has(c)).length
          const allOn = toggleable.length > 0 && toggleable.every((c) => selected.has(c))
          const someOn = toggleable.some((c) => selected.has(c))
          return (
            <fieldset
              key={g.code}
              className="rounded-xl border border-border bg-surface"
              aria-label={ta ? g.label_ta : g.label_en}
            >
              <div className="flex items-center gap-3 border-b border-border px-3 py-2.5">
                {readOnly ? null : (
                  <Checkbox
                    aria-label={t('roles.select_all_in', { group: ta ? g.label_ta : g.label_en })}
                    checked={allOn ? true : someOn ? 'indeterminate' : false}
                    disabled={toggleable.length === 0}
                    onCheckedChange={(v) => {
                      const next = new Set(selected)
                      for (const c of toggleable) {
                        if (v === true) next.add(c)
                        else next.delete(c)
                      }
                      onChange?.(next)
                    }}
                  />
                )}
                <legend className="contents">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold leading-snug">
                      {ta ? g.label_ta : g.label_en}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {ta ? g.label_en : g.label_ta}
                    </span>
                  </span>
                </legend>
                <Badge size="sm" tone={on > 0 ? 'primary' : 'neutral'}>
                  {on}/{codes.length}
                </Badge>
              </div>
              <ul className="flex flex-col py-1">
                {g.permissions.map((p) => {
                  const via = implied.get(p.code)
                  const checked = selected.has(p.code) || via !== undefined
                  const blocked = !canGrant(p.code)
                  const disabled = readOnly || via !== undefined || blocked
                  const viaLabel = via ? labelOf.get(via) : undefined
                  return (
                    <li
                      key={p.code}
                      className={cn(
                        'flex items-start gap-3 px-3 py-2',
                        !readOnly && !disabled && 'hover:bg-surface-2/60',
                      )}
                    >
                      <Checkbox
                        id={`perm-${p.code}`}
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(v) => toggle(p.code, v === true)}
                        aria-describedby={`perm-${p.code}-desc`}
                      />
                      <div className="min-w-0 flex-1 text-sm leading-snug">
                        <label
                          htmlFor={`perm-${p.code}`}
                          className={cn(
                            'block',
                            checked ? 'font-medium' : undefined,
                            disabled ? 'cursor-default' : 'cursor-pointer',
                          )}
                        >
                          {ta ? p.label_ta : p.label_en}
                        </label>
                        <span
                          id={`perm-${p.code}-desc`}
                          className="block text-xs text-muted-foreground"
                        >
                          {viaLabel
                            ? t('roles.included_with', {
                                permission: ta ? viaLabel.label_ta : viaLabel.label_en,
                              })
                            : blocked && !readOnly
                              ? t('roles.not_grantable')
                              : ta
                                ? p.label_en
                                : p.label_ta}
                        </span>
                      </div>
                      <code className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
                        {p.code}
                      </code>
                    </li>
                  )
                })}
              </ul>
            </fieldset>
          )
        })}
      </div>
      {groups.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t('roles.no_permission_match')}
        </p>
      ) : null}
    </div>
  )
}
