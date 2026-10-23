/**
 * Stock transfers (/inventory/transfers): stock sent between the shop's stores. Quick view of
 * transfers coming into / going out of the member's store, status chips (draft, dispatched =
 * on the way, received, cancelled), store and date filters. Rows open the transfer.
 */
import {
  type StockTransfer,
  TRANSFER_STATUS_LABELS,
  type TransferListQuery,
  inventoryRoutes,
} from '@kadai/shared/api/inventory'
import { TransferStatusSchema } from '@kadai/shared/enums'
import { keepPreviousData } from '@tanstack/react-query'
import { ArrowRight, Plus, Truck, X } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  Money,
  PageHeader,
  SearchInput,
  Select,
  statusTone,
} from '@/components/ui'
import { formatDate } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { FilterChips } from '../components/FilterChips'
import { useDefaultStoreId, useInventoryAccess, useToday } from '../lib/access'
import { pickLabel } from '../lib/labels'
import { PAGE_SIZES, useUrlState } from '../lib/url-state'

const STATUSES = ['all', ...TransferStatusSchema.options] as const
type StatusFilter = (typeof STATUSES)[number]
const DIRECTIONS = ['all', 'in', 'out'] as const

export default function TransfersPage() {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const navigate = useNavigate()
  const today = useToday()
  const access = useInventoryAccess()
  const defaultStore = useDefaultStoreId()
  const [state, setState] = useUrlState({
    status: 'all',
    store: defaultStore ?? '',
    direction: 'all',
    q: '',
    from: '',
    to: '',
    sort: '-transfer_date',
  })
  const status: StatusFilter = (STATUSES as readonly string[]).includes(state.status)
    ? (state.status as StatusFilter)
    : 'all'
  const direction = (DIRECTIONS as readonly string[]).includes(state.direction)
    ? (state.direction as (typeof DIRECTIONS)[number])
    : 'all'
  const query: TransferListQuery = {
    limit: state.limit,
    offset: state.offset,
    sort: /^-?(transfer_date|created_at|number)$/.test(state.sort) ? state.sort : '-transfer_date',
    ...(status !== 'all' ? { status } : {}),
    ...(state.store ? { store_id: state.store } : {}),
    ...(state.store && direction !== 'all' ? { direction } : {}),
    ...(state.q ? { q: state.q } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
  }
  const list = useRouteQuery(
    inventoryRoutes.listTransfers,
    { query },
    { placeholderData: keepPreviousData },
  )
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const filtered =
    status !== 'all' || direction !== 'all' || Boolean(state.q || state.from || state.to)

  const columns = useMemo<DataTableColumn<StockTransfer>[]>(
    () => [
      {
        id: 'number',
        header: t('transfers.col_number'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">
            {row.original.number ?? t('transfers.draft_number')}
          </span>
        ),
      },
      {
        id: 'transfer_date',
        header: t('common:fields.date'),
        enableSorting: true,
        meta: { label: t('common:fields.date') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.transfer_date)}</span>
        ),
      },
      {
        id: 'route',
        header: t('transfers.col_route'),
        enableSorting: false,
        meta: { mobile: 'subtitle', label: t('transfers.col_route') },
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span className="font-medium">{row.original.from_store_code}</span>
            <ArrowRight
              className="size-3.5 text-muted-foreground"
              aria-label={t('transfers.to_store')}
            />
            <span className="font-medium">{row.original.to_store_code}</span>
            <span className="hidden truncate text-xs text-muted-foreground xl:inline">
              {row.original.to_store_name}
            </span>
          </span>
        ),
      },
      {
        id: 'lines',
        header: t('transfers.col_lines'),
        enableSorting: false,
        meta: { align: 'right', label: t('transfers.col_lines') },
        cell: ({ row }) => <span className="tabular-nums">{row.original.line_count}</span>,
      },
      {
        id: 'value',
        header: t('transfers.col_value'),
        enableSorting: false,
        meta: { align: 'right', label: t('transfers.col_value') },
        cell: ({ row }) => (
          <div className="grid justify-items-end">
            <Money paise={row.original.total_value_paise} />
            {row.original.shortfall_value_paise > 0 ? (
              <span className="text-xs text-danger">
                {t('transfers.short_amount')} <Money paise={row.original.shortfall_value_paise} />
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: t('common:fields.status'),
        enableSorting: false,
        meta: { label: t('common:fields.status') },
        cell: ({ row }) => (
          <Badge tone={statusTone(row.original.status)} size="sm" dot>
            {pickLabel(TRANSFER_STATUS_LABELS[row.original.status], i18n.language)}
          </Badge>
        ),
      },
    ],
    [t, i18n.language],
  )

  return (
    <div>
      <PageHeader
        title={t('transfers.title')}
        description={t('transfers.description')}
        actions={
          access.transfer ? (
            <Button asChild leftIcon={<Plus />}>
              <Link to="/inventory/transfers/new">{t('transfers.new')}</Link>
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 pb-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,18rem)_14rem_12rem_auto]">
          <SearchInput
            value={state.q}
            onChange={(q) => setState({ q })}
            placeholder={t('transfers.search_placeholder')}
          />
          <StorePicker
            aria-label={t('common:fields.store')}
            placeholder={t('common:misc.all_stores')}
            value={state.store || null}
            onChange={(id) => setState({ store: id ?? '' })}
          />
          <Select
            aria-label={t('transfers.direction_label')}
            value={direction}
            disabled={!state.store}
            onValueChange={(v) => setState({ direction: v })}
            options={DIRECTIONS.map((d) => ({ value: d, label: t(`transfers.direction_${d}`) }))}
          />
          <DateRangePicker
            value={state.from && state.to ? { from: state.from, to: state.to } : null}
            onChange={(r) => setState({ from: r.from, to: r.to })}
            max={today}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FilterChips
            chips={STATUSES.map((s) => ({
              key: s,
              label:
                s === 'all'
                  ? t('transfers.all_statuses')
                  : pickLabel(TRANSFER_STATUS_LABELS[s], i18n.language),
              tone: s === 'dispatched' ? ('warning' as const) : undefined,
            }))}
            value={status}
            onChange={(s) => setState({ status: s })}
            label={t('transfers.statuses_label')}
          />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X />}
              onClick={() => setState({ status: 'all', direction: 'all', q: '', from: '', to: '' })}
            >
              {t('common:actions.clear_filters')}
            </Button>
          ) : null}
        </div>
      </div>
      <DataTable
        label={t('transfers.title')}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => navigate(`/inventory/transfers/${r.id}`)}
        sort={query.sort as string}
        onSortChange={(s) => setState({ sort: s ?? '-transfer_date' })}
        pagination={
          page
            ? {
                ...page,
                pageSizeOptions: PAGE_SIZES,
                onChange: ({ offset, limit }) => setState({ offset, limit }),
              }
            : undefined
        }
        empty={
          filtered ? undefined : (
            <EmptyState
              icon={<Truck />}
              title={t('transfers.empty_title')}
              description={t('transfers.empty_description')}
              action={
                access.transfer ? (
                  <Button asChild leftIcon={<Plus />}>
                    <Link to="/inventory/transfers/new">{t('transfers.new')}</Link>
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
    </div>
  )
}
