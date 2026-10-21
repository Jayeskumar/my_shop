/**
 * Customer search (billing, receipts, credit notes, reminders): debounced GET /customers?q=
 * (name / Tamil name / phone digits / GSTIN / code); Enter on a mobile number does the exact
 * GET /customers/lookup?phone= first. Shows the khata state (due / overdue / advance). The
 * "Add" row passes the typed name — or the normalised mobile number — to `onCreate`, so the
 * caller can open its quick-add form prefilled.
 */
import {
  type CustomerListItem,
  type CustomerListQuery,
  partiesRoutes,
} from '@kadai/shared/api/parties'
import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { formatPhone } from '@/lib/format'
import { BalanceBadge, PickerRow } from './picker-row'
import {
  PICKER_PAGE_SIZE,
  type PickerBaseProps,
  type PickerRef,
  bilingualNames,
  joinParts,
  nullOn404,
  phoneQuery,
} from './shared'

export type CustomerPickerValue = PickerRef<CustomerListItem>

/** What the user typed when choosing "Add": a name, or a mobile number (E.164). */
export interface CustomerDraft {
  name?: string
  phone?: string
}

export interface CustomerPickerProps extends PickerBaseProps {
  value: CustomerPickerValue | null | undefined
  onChange: (customer: CustomerListItem | null) => void
  /** Inline create slot: called with the typed name or phone ("Add …" row / unknown phone). */
  onCreate?: (draft: CustomerDraft) => void
  /** Show due / advance chips (default true). */
  showBalance?: boolean
  includeInactive?: boolean
  filters?: Pick<CustomerListQuery, 'customer_type' | 'tag' | 'has_due' | 'overdue'>
}

export function CustomerPicker({
  value,
  onChange,
  onCreate,
  showBalance = true,
  includeInactive = false,
  filters,
  placeholder,
  ...base
}: CustomerPickerProps) {
  const { t } = useTranslation('common')

  const loadOptions = async (q: string, signal: AbortSignal): Promise<CustomerListItem[]> => {
    const res = await callRoute(partiesRoutes.listCustomers, {
      query: {
        limit: PICKER_PAGE_SIZE,
        ...(q ? { q } : { sort: '-last_invoice_at' }),
        ...(includeInactive ? {} : { is_active: true }),
        ...filters,
      },
      signal,
    })
    return res.data
  }

  const resolveQuery = async (q: string, signal: AbortSignal) => {
    const phone = phoneQuery(q)
    if (!phone) return null
    const hit = await nullOn404(
      callRoute(partiesRoutes.lookupCustomer, { query: { phone }, signal }),
    )
    return hit?.data ?? null
  }

  return (
    <Combobox<CustomerPickerValue>
      {...base}
      value={value ?? null}
      onChange={(c) => onChange(c as CustomerListItem | null)}
      loadOptions={loadOptions}
      resolveQuery={resolveQuery}
      shouldResolveQuery={(q) => phoneQuery(q) !== null}
      notFoundText={(q) => t('pickers.customer.not_found', { phone: formatPhone(phoneQuery(q)) })}
      getOptionValue={(c) => c.id}
      getOptionLabel={(c) => bilingualNames(c.name, c.name_ta).primary}
      renderOption={(c) => (
        <CustomerOption customer={c as CustomerListItem} showBalance={showBalance} />
      )}
      placeholder={placeholder ?? t('pickers.customer.placeholder')}
      searchPlaceholder={t('pickers.customer.search_placeholder')}
      {...(onCreate
        ? {
            onCreate: (q: string) => {
              const phone = phoneQuery(q)
              onCreate(phone ? { phone } : { name: q })
            },
            createLabel: (q: string) => {
              const phone = phoneQuery(q)
              return phone
                ? t('pickers.customer.create_with_phone', { phone: formatPhone(phone) })
                : t('misc.add_new', { query: q })
            },
          }
        : {})}
    />
  )
}

function CustomerOption({
  customer,
  showBalance,
}: {
  customer: CustomerListItem
  showBalance: boolean
}) {
  const names = bilingualNames(customer.name, customer.name_ta)
  return (
    <PickerRow
      title={names.primary}
      subtitle={joinParts(
        customer.phone ? formatPhone(customer.phone) : null,
        names.secondary,
        customer.code,
        customer.gstin,
      )}
      aside={
        showBalance ? (
          <BalanceBadge
            kind="customer"
            balancePaise={customer.balance_paise}
            overduePaise={customer.overdue_paise}
          />
        ) : null
      }
    />
  )
}
