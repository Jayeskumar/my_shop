/** Brand search (product form, filters): debounced GET /brands?q=. */
import { type Brand, catalogRoutes } from '@kadai/shared/api/catalog'
import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { PickerRow } from './picker-row'
import { PICKER_PAGE_SIZE, type PickerBaseProps, type PickerRef } from './shared'

export type BrandPickerValue = PickerRef<Brand>

export interface BrandPickerProps extends PickerBaseProps {
  value: BrandPickerValue | null | undefined
  onChange: (brand: Brand | null) => void
  /** "Add “query”" row (create the brand inline). */
  onCreate?: (name: string) => void
  includeInactive?: boolean
}

export function BrandPicker({
  value,
  onChange,
  onCreate,
  includeInactive = false,
  placeholder,
  ...base
}: BrandPickerProps) {
  const { t } = useTranslation('common')
  const loadOptions = async (q: string, signal: AbortSignal): Promise<Brand[]> => {
    const res = await callRoute(catalogRoutes.listBrands, {
      query: {
        limit: PICKER_PAGE_SIZE,
        ...(q ? { q } : {}),
        ...(includeInactive ? {} : { is_active: true }),
      },
      signal,
    })
    return res.data
  }
  return (
    <Combobox<BrandPickerValue>
      {...base}
      value={value ?? null}
      onChange={(b) => onChange(b as Brand | null)}
      loadOptions={loadOptions}
      getOptionValue={(b) => b.id}
      getOptionLabel={(b) => b.name}
      renderOption={(b) => <PickerRow title={b.name} />}
      placeholder={placeholder ?? t('pickers.brand.placeholder')}
      searchPlaceholder={t('pickers.brand.search_placeholder')}
      onCreate={onCreate}
    />
  )
}
