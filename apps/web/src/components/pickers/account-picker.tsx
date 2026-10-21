/**
 * Ledger account picker (expenses "paid from", cash entries, manual journals, provider
 * settlement accounts): the chart from GET /accounts?balances=false (whole chart, cached),
 * filtered by type / subtype / cash-bank kind / store and searched locally by code and both names.
 */
import type { AccountType } from '@kadai/shared'
import {
  ACCOUNT_TYPE_LABELS,
  type AccountBalance,
  type AccountSubtype,
  type MoneyAccountKind,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Combobox } from '@/components/ui'
import { getLanguage } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'
import { PickerRow } from './picker-row'
import {
  PICKER_STALE_MS,
  type PickerBaseProps,
  bilingualNames,
  joinParts,
  keywordsOf,
} from './shared'

export interface AccountPickerProps extends PickerBaseProps {
  /** Account id. */
  value: string | null | undefined
  onChange: (accountId: string | null, account: AccountBalance | null) => void
  types?: readonly AccountType[]
  subtypes?: readonly AccountSubtype[]
  /** Only cash or bank accounts. */
  money?: MoneyAccountKind
  /** Store-specific accounts of other stores are hidden (shared accounts always show). */
  storeId?: string | null
  excludeIds?: readonly string[]
  includeInactive?: boolean
}

export function AccountPicker({
  value,
  onChange,
  types,
  subtypes,
  money,
  storeId,
  excludeIds,
  includeInactive = false,
  placeholder,
  ...base
}: AccountPickerProps) {
  const { t } = useTranslation('common')
  const chart = useRouteQuery(
    accountingRoutes.listAccounts,
    {
      query: {
        balances: false,
        ...(types?.length ? { type: [...types] } : {}),
        ...(money ? { money } : {}),
        ...(includeInactive ? { include_inactive: true } : {}),
      },
    },
    { staleTime: PICKER_STALE_MS },
  )
  const accounts = useMemo(() => {
    const all = chart.data?.data.accounts ?? []
    return all.filter(
      (a) =>
        (!subtypes?.length || (a.subtype !== null && subtypes.includes(a.subtype))) &&
        (!storeId || a.store_id === null || a.store_id === storeId) &&
        !excludeIds?.includes(a.id) &&
        (includeInactive || a.is_active),
    )
  }, [chart.data, subtypes, storeId, excludeIds, includeInactive])
  const selected = useMemo(
    () => (value ? (chart.data?.data.accounts.find((a) => a.id === value) ?? null) : null),
    [chart.data, value],
  )
  const lang = getLanguage()
  return (
    <Combobox<AccountBalance>
      {...base}
      disabled={base.disabled || chart.isPending}
      value={selected}
      onChange={(a) => onChange(a?.id ?? null, a)}
      options={accounts}
      getOptionValue={(a) => a.id}
      getOptionLabel={(a) => keywordsOf(a.code, a.name, a.name_ta)}
      renderValue={(a) => `${a.code} · ${bilingualNames(a.name, a.name_ta).primary}`}
      renderOption={(a) => {
        const names = bilingualNames(a.name, a.name_ta)
        return (
          <PickerRow
            indent={a.depth}
            title={`${a.code} · ${names.primary}`}
            subtitle={joinParts(
              ACCOUNT_TYPE_LABELS[a.type][lang],
              names.secondary,
              a.store_id ? t('pickers.account.store_only') : null,
            )}
          />
        )
      }}
      placeholder={placeholder ?? t('pickers.account.placeholder')}
      searchPlaceholder={t('pickers.account.search_placeholder')}
    />
  )
}
