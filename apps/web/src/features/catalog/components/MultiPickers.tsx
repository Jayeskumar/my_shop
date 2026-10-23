/**
 * Multi-select chips over the shared pickers (promotion targeting, combo items, label lists):
 * the value is a list of ids; names are resolved from the catalogue (products by `ids`,
 * categories from the cached flat tree, brands from the brand list).
 */
import { type Brand, type Category, catalogRoutes } from '@kadai/shared/api/catalog'
import { X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrandPicker, CategoryPicker, ProductPicker } from '@/components/pickers'
import { Skeleton } from '@/components/ui'
import { localizedName } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'
import { useProductNames } from '../lib/use-product-names'

function Chip({
  label,
  onRemove,
  removeLabel,
}: {
  label: ReactNode
  onRemove?: () => void
  removeLabel: string
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 py-1 pe-1 ps-3 text-sm">
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          className="rounded-full p-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </span>
  )
}

export interface IdListPickerProps {
  value: readonly string[]
  onChange: (ids: string[]) => void
  id?: string
  disabled?: boolean
  placeholder?: string
}

export function ProductMultiPicker({
  value,
  onChange,
  id,
  disabled,
  placeholder,
}: IdListPickerProps) {
  const { t } = useTranslation('catalog')
  const { names, loading } = useProductNames(value)
  const [extra, setExtra] = useState<Map<string, string>>(new Map())
  return (
    <div className="grid grid-cols-1 gap-2">
      <ProductPicker
        id={id}
        disabled={disabled}
        value={null}
        placeholder={placeholder ?? t('pickers.add_product')}
        onChange={(p) => {
          if (!p || value.includes(p.id)) return
          setExtra((m) => new Map(m).set(p.id, localizedName(p.name, p.name_ta)))
          onChange([...value, p.id])
        }}
      />
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((pid) => {
            const name = names.get(pid) ?? extra.get(pid)
            return (
              <Chip
                key={pid}
                label={name ?? (loading ? <Skeleton className="h-3 w-20" /> : t('pickers.unknown'))}
                removeLabel={t('chips.remove', { value: name ?? '' })}
                onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== pid))}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function CategoryMultiPicker({
  value,
  onChange,
  id,
  disabled,
  placeholder,
}: IdListPickerProps) {
  const { t } = useTranslation('catalog')
  const flat = useRouteQuery(
    catalogRoutes.listCategories,
    { query: { flat: true, is_active: true } },
    { staleTime: 5 * 60_000 },
  )
  const byId = useMemo(
    () => new Map(((flat.data?.data ?? []) as Category[]).map((c) => [c.id, c])),
    [flat.data],
  )
  return (
    <div className="grid grid-cols-1 gap-2">
      <CategoryPicker
        id={id}
        disabled={disabled}
        value={null}
        placeholder={placeholder ?? t('pickers.add_category')}
        onChange={(cid) => {
          if (cid && !value.includes(cid)) onChange([...value, cid])
        }}
      />
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((cid) => {
            const c = byId.get(cid)
            const name = c ? localizedName(c.name, c.name_ta) : t('pickers.unknown')
            return (
              <Chip
                key={cid}
                label={name}
                removeLabel={t('chips.remove', { value: name })}
                onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== cid))}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function BrandMultiPicker({
  value,
  onChange,
  id,
  disabled,
  placeholder,
}: IdListPickerProps) {
  const { t } = useTranslation('catalog')
  const brands = useRouteQuery(
    catalogRoutes.listBrands,
    { query: { limit: 200 } },
    { enabled: value.length > 0, staleTime: 5 * 60_000 },
  )
  const [extra, setExtra] = useState<Map<string, string>>(new Map())
  const byId = useMemo(
    () => new Map(((brands.data?.data ?? []) as Brand[]).map((b) => [b.id, b.name])),
    [brands.data],
  )
  return (
    <div className="grid grid-cols-1 gap-2">
      <BrandPicker
        id={id}
        disabled={disabled}
        value={null}
        placeholder={placeholder ?? t('pickers.add_brand')}
        onChange={(b) => {
          if (!b || value.includes(b.id)) return
          setExtra((m) => new Map(m).set(b.id, b.name))
          onChange([...value, b.id])
        }}
      />
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((bid) => {
            const name = byId.get(bid) ?? extra.get(bid) ?? t('pickers.unknown')
            return (
              <Chip
                key={bid}
                label={name}
                removeLabel={t('chips.remove', { value: name })}
                onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== bid))}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
