/**
 * Suppliers (/parties/suppliers): who the shop buys from and how much it owes each of them.
 * Quick filters (all, to pay, overdue, inactive), search by name / contact / mobile / GSTIN,
 * server sort and paging in the URL; rows open the supplier ledger page.
 */
import { Plus, Truck } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { SupplierListItem, SupplierListQuery } from '@kadai/shared/api/parties'
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Kbd,
  PageHeader,
  PhoneLink,
  SearchInput,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { PARTIES_HOTKEY_SCOPE } from '../lib/labels'
import { useSuppliers } from '../api'
import { BalanceAmount } from '../components/BalanceAmount'
import { FilterChips } from '../components/FilterChips'
import { SupplierFormDialog } from '../components/SupplierFormDialog'
import { LIST_PAGE_SIZES, useListState } from '../lib/use-list-state'

const FILTERS = ['all', 'due', 'overdue', 'inactive'] as const
type SupplierFilter = (typeof FILTERS)[number]
const SORTS = ['name', 'balance_paise', 'last_bill_date', 'created_at'] as const

function filterQuery(filter: SupplierFilter): Partial<SupplierListQuery> {
  switch (filter) {
    case 'due':
      return { has_due: true }
    case 'overdue':
      return { overdue: true }
    case 'inactive':
      return { is_active: false }
    case 'all':
      return {}
  }
}

export default function SuppliersPage() {
  const { t } = useTranslation(['parties', 'common'])
  const navigate = useNavigate()
  const canWrite = useCan('suppliers.write')
  const searchRef = useRef<HTMLInputElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [state, setState] = useListState<SupplierFilter>({
    filter: 'all',
    filters: FILTERS,
    sort: 'name',
    sorts: SORTS,
  })
  const list = useSuppliers({
    limit: state.limit,
    offset: state.offset,
    sort: state.sort,
    ...(state.q ? { q: state.q } : {}),
    is_active: true,
    ...filterQuery(state.filter),
  })
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const filtered = state.filter !== 'all' || Boolean(state.q)

  useHotkeyScope(PARTIES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) setAddOpen(true)
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: PARTIES_HOTKEY_SCOPE },
  )

  const columns = useMemo<DataTableColumn<SupplierListItem>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('fields.supplier_name'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={row.original.name} size="sm" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{row.original.name}</span>
                {!row.original.is_active ? (
                  <Badge size="sm">{t('common:status.inactive')}</Badge>
                ) : null}
              </div>
              {row.original.contact_person || row.original.gstin ? (
                <div className="truncate text-xs text-muted-foreground">
                  {[row.original.contact_person, row.original.gstin].filter(Boolean).join(' · ')}
                </div>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: 'phone',
        header: t('fields.phone'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => <PhoneLink phone={row.original.phone} whatsapp />,
      },
      {
        id: 'balance_paise',
        accessorKey: 'balance_paise',
        header: t('suppliers.col_payable'),
        enableSorting: true,
        meta: { align: 'right', label: t('suppliers.col_payable') },
        cell: ({ row }) => (
          <div className="flex flex-col items-end gap-0.5">
            <BalanceAmount partyType="supplier" balancePaise={row.original.balance_paise} />
            {row.original.overdue_paise > 0 ? (
              <Badge tone="danger" size="sm">
                {t('suppliers.overdue_amount', {
                  amount: formatMoney(row.original.overdue_paise, { decimals: 'auto' }),
                })}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: 'payment_terms_days',
        header: t('fields.payment_terms'),
        meta: { label: t('fields.payment_terms') },
        cell: ({ row }) =>
          row.original.payment_terms_days === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="text-sm">
              {t('profile.days', { count: row.original.payment_terms_days })}
            </span>
          ),
      },
      {
        id: 'last_bill_date',
        accessorKey: 'last_bill_date',
        header: t('suppliers.col_last_bill'),
        enableSorting: true,
        meta: { label: t('suppliers.col_last_bill') },
        cell: ({ row }) =>
          row.original.last_bill_date ? (
            <span className="tabular-nums">{formatDate(row.original.last_bill_date)}</span>
          ) : (
            <span className="text-muted-foreground">{t('suppliers.no_bills_yet')}</span>
          ),
      },
    ],
    [t],
  )

  const chips = FILTERS.map((key) => ({
    key,
    label: t(`suppliers.filter_${key}`),
    tone: key === 'overdue' ? ('danger' as const) : undefined,
  }))
  const firstRun = !filtered && !list.isLoading && !list.error && page?.total === 0

  return (
    <div>
      <PageHeader
        title={t('suppliers.title')}
        description={t('suppliers.description')}
        actions={
          canWrite ? (
            <Button leftIcon={<Plus />} onClick={() => setAddOpen(true)}>
              {t('suppliers.add')}
              <Kbd
                combo="alt+n"
                className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
              />
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 pb-4">
        <SearchInput
          ref={searchRef}
          value={state.q}
          onChange={(q) => setState({ q })}
          placeholder={t('suppliers.search_placeholder')}
          wrapperClassName="sm:max-w-sm"
        />
        <FilterChips
          chips={chips}
          value={state.filter}
          onChange={(filter) => setState({ filter })}
          label={t('customers.filters_label')}
        />
      </div>
      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<Truck />}
            title={t('suppliers.empty_title')}
            description={t('suppliers.empty_description')}
            action={
              canWrite ? (
                <Button leftIcon={<Plus />} onClick={() => setAddOpen(true)}>
                  {t('suppliers.add_first')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <DataTable
          label={t('suppliers.title')}
          columns={columns}
          data={rows}
          getRowId={(s) => s.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(s) => navigate(`/parties/suppliers/${s.id}`)}
          sort={state.sort}
          onSortChange={(sort) => setState({ sort: sort ?? 'name' })}
          pagination={
            page
              ? {
                  ...page,
                  pageSizeOptions: LIST_PAGE_SIZES,
                  onChange: ({ offset, limit }) => setState({ offset, limit }),
                }
              : undefined
          }
          renderCard={(s) => (
            <div className="grid min-w-0 gap-2">
              <div className="flex min-w-0 items-start gap-3">
                <Avatar name={s.name} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{s.name}</div>
                  {s.contact_person ? (
                    <div className="truncate text-xs text-muted-foreground">{s.contact_person}</div>
                  ) : null}
                </div>
                <div className="max-w-[45%] text-end">
                  <BalanceAmount partyType="supplier" balancePaise={s.balance_paise} />
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 ps-12 text-sm">
                <PhoneLink phone={s.phone} whatsapp />
                {s.overdue_paise > 0 ? (
                  <Badge tone="danger" size="sm">
                    {t('suppliers.overdue_amount', {
                      amount: formatMoney(s.overdue_paise, { decimals: 'auto' }),
                    })}
                  </Badge>
                ) : null}
              </div>
            </div>
          )}
          empty={
            <EmptyState
              compact
              icon={<Truck />}
              title={t(`suppliers.none_${state.filter}`)}
              description={t('customers.none_hint')}
            />
          }
        />
      )}
      <SupplierFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(s) => navigate(`/parties/suppliers/${s.id}`)}
      />
    </div>
  )
}
