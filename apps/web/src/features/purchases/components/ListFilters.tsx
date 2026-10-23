/**
 * Filter row of the purchases lists: search, quick filter chips, supplier, store (multi-store
 * shops only) and a date range — all kept in the URL (useListState). "Clear filters" appears
 * once anything is set.
 */
import { type ReactNode, type Ref, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ALL_STORES, StorePicker, SupplierPicker } from '@/components/pickers'
import { Button, DateRangePicker, SearchInput } from '@/components/ui'
import { useCan, useMe } from '@/lib/auth'
import { SlidersHorizontal, X } from 'lucide-react'
import { useBreakpoint } from '@/lib/use-media-query'
import { useSupplier } from '../api'
import type { ListState } from '../lib/url-state'
import { type FilterChip, FilterChips } from './FilterChips'

export interface ListFiltersProps<F extends string> {
  state: ListState<F>
  onChange: (patch: Partial<ListState<F>>) => void
  defaultFilter: F
  chips: readonly FilterChip<F>[]
  searchPlaceholder: string
  searchRef?: Ref<HTMLInputElement>
  /** Label of the date range (what the dates filter on). */
  dateLabel: string
  extra?: ReactNode
}

export function ListFilters<F extends string>({
  state,
  onChange,
  defaultFilter,
  chips,
  searchPlaceholder,
  searchRef,
  dateLabel,
  extra,
}: ListFiltersProps<F>) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const canSuppliers = useCan('suppliers.read')
  const supplier = useSupplier(state.supplier_id || null, canSuppliers)
  const multiStore = (me?.stores ?? []).filter((s) => s.is_active).length > 1
  const anySet =
    Boolean(state.q || state.from || state.supplier_id || state.store_id) ||
    state.filter !== defaultFilter
  const extraCount = [state.from, state.supplier_id, state.store_id].filter(Boolean).length
  // Phones: supplier / store / dates fold behind a "Filters" button (open when one is set).
  const wide = useBreakpoint('md')
  const [expanded, setExpanded] = useState(false)
  const showExtra = wide || expanded || extraCount > 0

  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="flex min-w-0 items-center gap-2 lg:max-w-sm lg:flex-1">
          <SearchInput
            ref={searchRef}
            value={state.q}
            onChange={(q) => onChange({ q })}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            wrapperClassName="min-w-0 flex-1"
          />
          {wide ? null : (
            <Button
              variant="outline"
              leftIcon={<SlidersHorizontal />}
              aria-expanded={showExtra}
              onClick={() => setExpanded((e) => !e)}
            >
              {extraCount > 0 ? t('filters.more_count', { count: extraCount }) : t('filters.more')}
            </Button>
          )}
        </div>
        <div
          className={
            showExtra
              ? 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center'
              : 'hidden'
          }
        >
          {canSuppliers ? (
            <SupplierPicker
              className="lg:w-64"
              aria-label={t('filters.supplier')}
              placeholder={t('filters.any_supplier')}
              showBalance={false}
              includeInactive
              value={
                state.supplier_id
                  ? {
                      id: state.supplier_id,
                      name: supplier.data?.data.name ?? t('common:misc.loading'),
                    }
                  : null
              }
              onChange={(s) => onChange({ supplier_id: s?.id ?? '' })}
            />
          ) : null}
          {multiStore ? (
            <StorePicker
              className="lg:w-52"
              aria-label={t('filters.store')}
              allowAll
              value={state.store_id || ALL_STORES}
              clearable={false}
              onChange={(id) => onChange({ store_id: !id || id === ALL_STORES ? '' : id })}
            />
          ) : null}
          <div className="flex min-w-0 items-center gap-2">
            <span className="sr-only">{dateLabel}</span>
            <DateRangePicker
              className="w-full lg:w-auto"
              value={state.from && state.to ? { from: state.from, to: state.to } : null}
              onChange={(r) => onChange({ from: r.from, to: r.to })}
            />
          </div>
          {extra}
          {anySet ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X />}
              onClick={() =>
                onChange({
                  q: '',
                  from: '',
                  to: '',
                  supplier_id: '',
                  store_id: '',
                  filter: defaultFilter,
                })
              }
            >
              {t('common:actions.clear_filters')}
            </Button>
          ) : null}
        </div>
      </div>
      <FilterChips
        chips={chips}
        value={state.filter}
        onChange={(filter) => onChange({ filter })}
        label={t('filters.quick')}
      />
    </div>
  )
}
