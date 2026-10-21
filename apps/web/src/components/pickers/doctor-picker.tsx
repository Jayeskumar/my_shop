/** Prescribing doctor (pharmacy Rx, H1 register): debounced GET /doctors?q=. */
import { type Doctor, partiesRoutes } from '@kadai/shared/api/parties'
import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { PickerRow } from './picker-row'
import { PICKER_PAGE_SIZE, type PickerBaseProps, type PickerRef, joinParts } from './shared'

export type DoctorPickerValue = PickerRef<Doctor>

export interface DoctorPickerProps extends PickerBaseProps {
  value: DoctorPickerValue | null | undefined
  onChange: (doctor: Doctor | null) => void
  /** "Add “query”" row (quick doctor form). */
  onCreate?: (name: string) => void
  includeInactive?: boolean
}

export function DoctorPicker({
  value,
  onChange,
  onCreate,
  includeInactive = false,
  placeholder,
  ...base
}: DoctorPickerProps) {
  const { t } = useTranslation('common')
  const loadOptions = async (q: string, signal: AbortSignal): Promise<Doctor[]> => {
    const res = await callRoute(partiesRoutes.listDoctors, {
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
    <Combobox<DoctorPickerValue>
      {...base}
      value={value ?? null}
      onChange={(d) => onChange(d as Doctor | null)}
      loadOptions={loadOptions}
      getOptionValue={(d) => d.id}
      getOptionLabel={(d) => d.name}
      renderOption={(d) => (
        <PickerRow
          title={d.name}
          subtitle={joinParts(
            d.registration_no ? t('pickers.doctor.reg_no', { no: d.registration_no }) : null,
            d.qualification,
            d.clinic_name,
          )}
        />
      )}
      placeholder={placeholder ?? t('pickers.doctor.placeholder')}
      searchPlaceholder={t('pickers.doctor.search_placeholder')}
      onCreate={onCreate}
    />
  )
}
