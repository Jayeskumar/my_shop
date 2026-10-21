/**
 * Supplier search (purchase orders / bills, debit notes, supplier payments): debounced
 * GET /suppliers?q= (name, contact, phone digits, GSTIN, code) with the payable balance.
 */
import {
  type SupplierListItem,
  type SupplierListQuery,
  partiesRoutes,
} from '@kadai/shared/api/parties'
import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { formatPhone } from '@/lib/format'
import { BalanceBadge, PickerRow } from './picker-row'
import { PICKER_PAGE_SIZE, type PickerBaseProps, type PickerRef, joinParts } from './shared'

export type SupplierPickerValue = PickerRef<SupplierListItem>

export interface SupplierPickerProps extends PickerBaseProps {
  value: SupplierPickerValue | null | undefined
  onChange: (supplier: SupplierListItem | null) => void
  /** "Add “query”" row (quick supplier form). */
  onCreate?: (name: string) => void
  /** Show the payable / advance chip (default true). */
  showBalance?: boolean
  includeInactive?: boolean
  filters?: Pick<SupplierListQuery, 'has_due' | 'overdue'>
}

export function SupplierPicker({
  value,
  onChange,
  onCreate,
  showBalance = true,
  includeInactive = false,
  filters,
  placeholder,
  ...base
}: SupplierPickerProps) {
  const { t } = useTranslation('common')
  const loadOptions = async (q: string, signal: AbortSignal): Promise<SupplierListItem[]> => {
    const res = await callRoute(partiesRoutes.listSuppliers, {
      query: {
        limit: PICKER_PAGE_SIZE,
        ...(q ? { q } : { sort: '-last_bill_date' }),
        ...(includeInactive ? {} : { is_active: true }),
        ...filters,
      },
      signal,
    })
    return res.data
  }
  return (
    <Combobox<SupplierPickerValue>
      {...base}
      value={value ?? null}
      onChange={(s) => onChange(s as SupplierListItem | null)}
      loadOptions={loadOptions}
      getOptionValue={(s) => s.id}
      getOptionLabel={(s) => s.name}
      renderOption={(s) => {
        const supplier = s as SupplierListItem
        return (
          <PickerRow
            title={supplier.name}
            subtitle={joinParts(
              supplier.contact_person,
              supplier.phone ? formatPhone(supplier.phone) : null,
              supplier.gstin,
            )}
            aside={
              showBalance ? (
                <BalanceBadge
                  kind="supplier"
                  balancePaise={supplier.balance_paise}
                  overduePaise={supplier.overdue_paise}
                />
              ) : null
            }
          />
        )
      }}
      placeholder={placeholder ?? t('pickers.supplier.placeholder')}
      searchPlaceholder={t('pickers.supplier.search_placeholder')}
      onCreate={onCreate}
    />
  )
}
