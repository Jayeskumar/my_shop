/**
 * Category picker (product form, filters, "move to"): the flat tree GET /categories?flat=true
 * (cached), indented by depth, searched in both languages. `excludeId` hides a category and its
 * descendants (choosing a new parent); `maxDepth` limits pickable levels (a parent of a new
 * category must be at depth ≤ 2 — the tree has at most 3 levels).
 */
import { type Category, catalogRoutes, categoryDescendantIds } from '@kadai/shared/api/catalog'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui'
import { getLanguage } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'
import { PickerRow } from './picker-row'
import { PICKER_STALE_MS, type PickerBaseProps, bilingualNames, keywordsOf } from './shared'

export interface CategoryPickerProps extends PickerBaseProps {
  /** Category id. */
  value: string | null | undefined
  onChange: (categoryId: string | null, category: Category | null) => void
  /** Hide this category and its descendants. */
  excludeId?: string | null
  /** Only categories at this depth or above are pickable (1 = top level). */
  maxDepth?: number
  includeInactive?: boolean
}

export function CategoryPicker({
  value,
  onChange,
  excludeId,
  maxDepth,
  includeInactive = false,
  placeholder,
  ...base
}: CategoryPickerProps) {
  const { t } = useTranslation('common')
  const tree = useRouteQuery(
    catalogRoutes.listCategories,
    { query: { flat: true, ...(includeInactive ? {} : { is_active: true }) } },
    { staleTime: PICKER_STALE_MS },
  )
  const all = useMemo(() => (tree.data?.data ?? []) as Category[], [tree.data])
  const options = useMemo(() => {
    const hidden = new Set(excludeId ? categoryDescendantIds(all, excludeId) : [])
    if (excludeId) hidden.add(excludeId)
    return all.filter((c) => !hidden.has(c.id)).sort((a, b) => a.path.localeCompare(b.path))
  }, [all, excludeId])
  const selected = useMemo(() => all.find((c) => c.id === value) ?? null, [all, value])
  const lang = getLanguage()
  return (
    <Combobox<Category>
      {...base}
      disabled={base.disabled || tree.isPending}
      value={selected}
      onChange={(c) => onChange(c?.id ?? null, c)}
      options={options}
      isOptionDisabled={maxDepth ? (c) => c.depth > maxDepth : undefined}
      getOptionValue={(c) => c.id}
      getOptionLabel={(c) => keywordsOf(c.path, c.path_ta, c.name, c.name_ta)}
      renderValue={(c) => (lang === 'ta' ? c.path_ta : c.path)}
      renderOption={(c) => {
        const names = bilingualNames(c.name, c.name_ta)
        return <PickerRow indent={c.depth - 1} title={names.primary} subtitle={names.secondary} />
      }}
      placeholder={placeholder ?? t('pickers.category.placeholder')}
      searchPlaceholder={t('pickers.category.search_placeholder')}
    />
  )
}
