/**
 * Store picker from the signed-in member's /me payload (no request): the stores the member may
 * use (store-scoped members see only theirs). `allowAll` adds "All stores" (value 'all') for
 * report and stock filters.
 */
import type { MeStore } from '@kadai/shared/api/auth'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Combobox } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { PickerRow } from './picker-row'
import { type PickerBaseProps, bilingualNames, keywordsOf } from './shared'

export const ALL_STORES = 'all'

export interface StorePickerProps extends PickerBaseProps {
  /** Store id, 'all' (with allowAll) or null. */
  value: string | null | undefined
  onChange: (storeId: string | null, store: MeStore | null) => void
  /** Offer "All stores" (value 'all'). */
  allowAll?: boolean
  includeInactive?: boolean
  /** Restrict to these stores (e.g. transfer destinations other than the source). */
  storeIds?: readonly string[]
  excludeIds?: readonly string[]
}

type Option = { kind: 'all' } | { kind: 'store'; store: MeStore }

export function StorePicker({
  value,
  onChange,
  allowAll = false,
  includeInactive = false,
  storeIds,
  excludeIds,
  placeholder,
  ...base
}: StorePickerProps) {
  const { t } = useTranslation('common')
  const me = useMe()
  const options = useMemo<Option[]>(() => {
    const stores = (me?.stores ?? []).filter(
      (s) =>
        (includeInactive || s.is_active) &&
        (!storeIds || storeIds.includes(s.id)) &&
        !excludeIds?.includes(s.id),
    )
    const rows: Option[] = stores.map((store) => ({ kind: 'store', store }))
    return allowAll && stores.length > 1 ? [{ kind: 'all' }, ...rows] : rows
  }, [me, includeInactive, storeIds, excludeIds, allowAll])
  const selected = useMemo<Option | null>(() => {
    if (value === ALL_STORES && allowAll) return { kind: 'all' }
    const store = me?.stores.find((s) => s.id === value)
    return store ? { kind: 'store', store } : null
  }, [me, value, allowAll])
  const label = (o: Option): string =>
    o.kind === 'all'
      ? t('pickers.store.all')
      : `${o.store.code} · ${bilingualNames(o.store.name, o.store.name_ta).primary}`
  return (
    <Combobox<Option>
      {...base}
      value={selected}
      onChange={(o) =>
        onChange(
          o ? (o.kind === 'all' ? ALL_STORES : o.store.id) : null,
          o?.kind === 'store' ? o.store : null,
        )
      }
      options={options}
      getOptionValue={(o) => (o.kind === 'all' ? ALL_STORES : o.store.id)}
      getOptionLabel={(o) =>
        o.kind === 'all'
          ? t('pickers.store.all')
          : keywordsOf(o.store.code, o.store.name, o.store.name_ta)
      }
      renderValue={label}
      renderOption={(o) => (
        <PickerRow
          title={label(o)}
          aside={
            o.kind === 'store' && !o.store.is_active ? (
              <Badge tone="neutral" size="sm">
                {t('pickers.store.inactive')}
              </Badge>
            ) : null
          }
        />
      )}
      placeholder={placeholder ?? t('pickers.store.placeholder')}
    />
  )
}
