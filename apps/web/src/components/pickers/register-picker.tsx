/** Counter (register) picker from the /me payload, optionally limited to one store. */
import type { MeRegister } from '@kadai/shared/api/auth'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { PickerRow } from './picker-row'
import { type PickerBaseProps, bilingualNames, keywordsOf } from './shared'

export interface RegisterPickerProps extends PickerBaseProps {
  /** Register id. */
  value: string | null | undefined
  onChange: (registerId: string | null, register: MeRegister | null) => void
  /** Only this store's counters (the store is shown otherwise). */
  storeId?: string | null
  includeInactive?: boolean
}

export function RegisterPicker({
  value,
  onChange,
  storeId,
  includeInactive = false,
  placeholder,
  ...base
}: RegisterPickerProps) {
  const { t } = useTranslation('common')
  const me = useMe()
  const options = useMemo(
    () =>
      (me?.registers ?? []).filter(
        (r) => (includeInactive || r.is_active) && (!storeId || r.store_id === storeId),
      ),
    [me, includeInactive, storeId],
  )
  const selected = useMemo(() => me?.registers.find((r) => r.id === value) ?? null, [me, value])
  const storeName = (r: MeRegister): string | null => {
    const store = me?.stores.find((s) => s.id === r.store_id)
    return store ? `${store.code} · ${bilingualNames(store.name, store.name_ta).primary}` : null
  }
  return (
    <Combobox<MeRegister>
      {...base}
      value={selected}
      onChange={(r) => onChange(r?.id ?? null, r)}
      options={options}
      getOptionValue={(r) => r.id}
      getOptionLabel={(r) => keywordsOf(r.code, r.name, storeId ? null : storeName(r))}
      renderValue={(r) => `${r.code} · ${r.name}`}
      renderOption={(r) => (
        <PickerRow title={`${r.code} · ${r.name}`} subtitle={storeId ? null : storeName(r)} />
      )}
      placeholder={placeholder ?? t('pickers.register.placeholder')}
    />
  )
}
