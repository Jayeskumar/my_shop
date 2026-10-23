/**
 * Stock adjustments (/inventory/adjustments): adjustments, stock takes, damage and expiry
 * write-offs (and the opening stock entries) with status, value impact and who did them.
 * Filters: kind, status, store, date range, number / notes search. New adjustment or stock
 * take from the header; drafts open in the editor, posted ones show their movements.
 */
import {
  ADJUSTMENT_KIND_LABELS,
  type AdjustmentListQuery,
  type StockAdjustment,
  inventoryRoutes,
} from '@kadai/shared/api/inventory'
import { AdjustmentKindSchema, AdjustmentStatusSchema } from '@kadai/shared/enums'
import { keepPreviousData } from '@tanstack/react-query'
import { ClipboardCheck, Plus, SlidersHorizontal, X } from 'lucide-react'
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
  Kbd,
  Money,
  PageHeader,
  SearchInput,
  Select,
  statusTone,
} from '@/components/ui'
import { formatDate } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useRouteQuery } from '@/lib/query'
import { FilterChips } from '../components/FilterChips'
import { useToday } from '../lib/access'
import { ADJUSTMENT_KIND_TONE, INVENTORY_HOTKEY_SCOPE, pickLabel } from '../lib/labels'
import { PAGE_SIZES, useUrlState } from '../lib/url-state'

const KINDS = ['all', ...AdjustmentKindSchema.options] as const
type KindFilter = (typeof KINDS)[number]
const STATUSES = ['all', ...AdjustmentStatusSchema.options] as const

export default function AdjustmentsPage() {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const navigate = useNavigate()
  const today = useToday()
  const [state, setState] = useUrlState({
    kind: 'all',
    status: 'all',
    store: '',
    q: '',
    from: '',
    to: '',
    sort: '-adjustment_date',
  })
  const kind: KindFilter = (KINDS as readonly string[]).includes(state.kind)
    ? (state.kind as KindFilter)
    : 'all'
  const status = (STATUSES as readonly string[]).includes(state.status) ? state.status : 'all'
  const query: AdjustmentListQuery = {
    limit: state.limit,
    offset: state.offset,
    sort: /^-?(adjustment_date|created_at|number)$/.test(state.sort)
      ? state.sort
      : '-adjustment_date',
    ...(kind !== 'all' ? { kind } : {}),
    ...(status !== 'all' ? { status: status as StockAdjustment['status'] } : {}),
    ...(state.store ? { store_id: state.store } : {}),
    ...(state.q ? { q: state.q } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
  }
  const list = useRouteQuery(
    inventoryRoutes.listAdjustments,
    { query },
    { placeholderData: keepPreviousData },
  )
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const filtered =
    kind !== 'all' || status !== 'all' || Boolean(state.store || state.q || state.from || state.to)

  useHotkeyScope(INVENTORY_HOTKEY_SCOPE)
  useHotkeys(
    { 'alt+n': () => navigate('/inventory/adjustments/new') },
    { scope: INVENTORY_HOTKEY_SCOPE },
  )

  const columns = useMemo<DataTableColumn<StockAdjustment>[]>(
    () => [
      {
        id: 'number',
        header: t('adjustments.col_number'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <span className="font-medium tabular-nums">
              {row.original.number ?? t('adjustments.draft_number')}
            </span>
            <span className="text-xs text-muted-foreground">
              {row.original.store_code} · {row.original.store_name}
            </span>
          </div>
        ),
      },
      {
        id: 'adjustment_date',
        header: t('common:fields.date'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('common:fields.date') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.adjustment_date)}</span>
        ),
      },
      {
        id: 'kind',
        header: t('adjustments.col_kind'),
        enableSorting: false,
        meta: { label: t('adjustments.col_kind') },
        cell: ({ row }) => (
          <Badge tone={ADJUSTMENT_KIND_TONE[row.original.kind]} size="sm">
            {pickLabel(ADJUSTMENT_KIND_LABELS[row.original.kind], i18n.language)}
          </Badge>
        ),
      },
      {
        id: 'lines',
        header: t('adjustments.col_lines'),
        enableSorting: false,
        meta: { align: 'right', label: t('adjustments.col_lines') },
        cell: ({ row }) => <span className="tabular-nums">{row.original.line_count}</span>,
      },
      {
        id: 'value',
        header: t('adjustments.col_value'),
        enableSorting: false,
        meta: { align: 'right', label: t('adjustments.col_value') },
        cell: ({ row }) => <Money paise={row.original.total_value_paise} colorize />,
      },
      {
        id: 'status',
        header: t('common:fields.status'),
        enableSorting: false,
        meta: { label: t('common:fields.status') },
        cell: ({ row }) => (
          <Badge tone={statusTone(row.original.status)} size="sm" dot>
            {t(`common:status.${row.original.status}`)}
          </Badge>
        ),
      },
      {
        id: 'by',
        header: t('adjustments.col_by'),
        enableSorting: false,
        meta: { label: t('adjustments.col_by'), mobile: 'hidden' },
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.posted_by_name ?? row.original.created_by_name ?? '—'}
          </span>
        ),
      },
    ],
    [t, i18n.language],
  )

  return (
    <div>
      <PageHeader
        title={t('adjustments.title')}
        description={t('adjustments.description')}
        actions={
          <>
            <Button asChild variant="outline" leftIcon={<ClipboardCheck />}>
              <Link to="/inventory/adjustments/new?kind=stock_take">
                {t('adjustments.new_stock_take')}
              </Link>
            </Button>
            <Button asChild leftIcon={<Plus />}>
              <Link to="/inventory/adjustments/new">
                {t('adjustments.new')}
                <Kbd
                  aria-hidden
                  combo="alt+n"
                  className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
                />
              </Link>
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-3 pb-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,18rem)_14rem_12rem_auto]">
          <SearchInput
            value={state.q}
            onChange={(q) => setState({ q })}
            placeholder={t('adjustments.search_placeholder')}
          />
          <StorePicker
            aria-label={t('common:fields.store')}
            placeholder={t('common:misc.all_stores')}
            value={state.store || null}
            onChange={(id) => setState({ store: id ?? '' })}
          />
          <Select
            aria-label={t('common:fields.status')}
            value={status}
            onValueChange={(v) => setState({ status: v })}
            options={STATUSES.map((s) => ({
              value: s,
              label: s === 'all' ? t('adjustments.all_statuses') : t(`common:status.${s}`),
            }))}
          />
          <DateRangePicker
            value={state.from && state.to ? { from: state.from, to: state.to } : null}
            onChange={(r) => setState({ from: r.from, to: r.to })}
            max={today}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FilterChips
            chips={KINDS.map((k) => ({
              key: k,
              label:
                k === 'all'
                  ? t('adjustments.all_kinds')
                  : pickLabel(ADJUSTMENT_KIND_LABELS[k], i18n.language),
            }))}
            value={kind}
            onChange={(k) => setState({ kind: k })}
            label={t('adjustments.kinds_label')}
          />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X />}
              onClick={() =>
                setState({ kind: 'all', status: 'all', store: '', q: '', from: '', to: '' })
              }
            >
              {t('common:actions.clear_filters')}
            </Button>
          ) : null}
        </div>
      </div>

      <DataTable
        label={t('adjustments.title')}
        columns={columns}
        data={rows}
        getRowId={(a) => a.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(a) => navigate(`/inventory/adjustments/${a.id}`)}
        sort={query.sort as string}
        onSortChange={(s) => setState({ sort: s ?? '-adjustment_date' })}
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
              icon={<SlidersHorizontal />}
              title={t('adjustments.empty_title')}
              description={t('adjustments.empty_description')}
              action={
                <>
                  <Button asChild leftIcon={<ClipboardCheck />}>
                    <Link to="/inventory/adjustments/new?kind=stock_take">
                      {t('adjustments.start_stock_take')}
                    </Link>
                  </Button>
                  <Button asChild variant="outline" leftIcon={<Plus />}>
                    <Link to="/inventory/adjustments/new">{t('adjustments.new')}</Link>
                  </Button>
                </>
              }
            />
          )
        }
      />
    </div>
  )
}
