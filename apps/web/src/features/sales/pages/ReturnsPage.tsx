/**
 * Sales returns / credit notes (/sales/returns): period (this month by default), search by note
 * number, bill number, customer name or mobile, filters (store, status, reason, refund mode),
 * totals of the filtered range and CSV export. "New return" starts from a bill.
 */
import { RotateCcw, SearchX, Undo2 } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import {
  type CreditNoteListQuery,
  type CreditNoteListRow,
  salesRoutes,
} from '@kadai/shared/api/sales'
import {
  CreditNoteReasonSchema,
  CreditNoteSettlementSchema,
  type CreditNoteReason,
  type CreditNoteSettlement,
} from '@kadai/shared/enums'
import { StorePicker } from '@/components/pickers'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FormField,
  Money,
  PageHeader,
  SearchInput,
  Select,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan, useMe } from '@/lib/auth'
import { formatDate } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useCreditNotes } from '../api'
import { ExportButton } from '../components/ExportButton'
import { ActiveFilterChips, type ActiveFilter, FilterDrawer } from '../components/FilterDrawer'
import { PeriodFilter } from '../components/PeriodFilter'
import { CreditNoteStatusBadge } from '../components/StatusBadges'
import { SummaryTiles } from '../components/SummaryTiles'
import { reasonLabel, settlementLabel } from '../lib/labels'
import { periodPatch, periodRange } from '../lib/period'
import { LIST_PAGE_SIZES, oneOf, pageOf, useSearchState } from '../lib/search-state'
import { useTenantCalendar } from '../lib/use-tenant-calendar'

const STATUSES = ['', 'completed', 'cancelled'] as const
const REASONS = ['', ...CreditNoteReasonSchema.options] as const
const SETTLEMENTS = ['', ...CreditNoteSettlementSchema.options] as const
const SORTS = ['note_date', 'number', 'total_paise', 'created_at']
const SCOPE = 'sales-returns'

const DEFAULTS = {
  q: '',
  period: 'this_month',
  from: '',
  to: '',
  store: '',
  status: '',
  reason: '',
  settlement: '',
  sort: '-note_date',
} as const

export default function ReturnsPage() {
  const { t, i18n } = useTranslation(['sales', 'common'])
  const navigate = useNavigate()
  const me = useMe()
  const { ctx } = useTenantCalendar()
  const canReturn = useCan('sales.return')
  const searchRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useSearchState(DEFAULTS)
  const page = pageOf(state)
  const range = periodRange(state, ctx)
  const status = oneOf(state.status, STATUSES, '')
  const reason = oneOf<'' | CreditNoteReason>(state.reason, REASONS, '')
  const settlement = oneOf<'' | CreditNoteSettlement>(state.settlement, SETTLEMENTS, '')
  const sort = SORTS.includes(state.sort.replace(/^-/, '')) ? state.sort : DEFAULTS.sort
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1

  const filterQuery: CreditNoteListQuery = {
    ...(state.q ? { q: state.q } : {}),
    ...(range ? { from: range.from, to: range.to } : {}),
    ...(state.store ? { store_id: state.store } : {}),
    ...(status ? { status: [status] } : {}),
    ...(reason ? { reason: [reason] } : {}),
    ...(settlement ? { settlement: [settlement] } : {}),
    sort,
  }
  const list = useCreditNotes({ ...filterQuery, limit: page.limit, offset: page.offset })

  useHotkeyScope(SCOPE)
  useHotkeys(
    {
      '/': () => searchRef.current?.focus(),
      'alt+n': () => {
        if (canReturn) navigate('/sales/returns/new')
      },
    },
    { scope: SCOPE },
  )

  const active: ActiveFilter[] = []
  if (state.store) {
    const store = me?.stores.find((s) => s.id === state.store)
    active.push({
      key: 'store',
      label: t('filters.chip_store', { name: store ? `${store.code} · ${store.name}` : '…' }),
      onRemove: () => setState({ store: '' }),
    })
  }
  if (status) {
    active.push({
      key: 'status',
      label: t(`credit_note_status.${status}`),
      onRemove: () => setState({ status: '' }),
    })
  }
  if (reason) {
    active.push({
      key: 'reason',
      label: reasonLabel(reason, i18n.language),
      onRemove: () => setState({ reason: '' }),
    })
  }
  if (settlement) {
    active.push({
      key: 'settlement',
      label: settlementLabel(settlement, i18n.language),
      onRemove: () => setState({ settlement: '' }),
    })
  }
  const reset = (): void => setState({ store: '', status: '', reason: '', settlement: '' })

  const columns = useMemo<DataTableColumn<CreditNoteListRow>[]>(
    () => [
      {
        id: 'number',
        accessorKey: 'number',
        header: t('returns.col_number'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <Link
            to={`/sales/returns/${row.original.id}`}
            className="font-medium hover:text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.number}
          </Link>
        ),
      },
      {
        id: 'note_date',
        accessorKey: 'note_date',
        header: t('returns.col_date'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('returns.col_date') },
        cell: ({ row }) => formatDate(row.original.note_date),
      },
      {
        id: 'invoice',
        header: t('returns.col_invoice'),
        enableSorting: false,
        meta: { label: t('returns.col_invoice') },
        cell: ({ row }) =>
          row.original.invoice_id ? (
            <Link
              to={`/sales/invoices/${row.original.invoice_id}`}
              className="text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.invoice_number ?? t('returns.open_bill')}
            </Link>
          ) : (
            <span className="text-muted-foreground">{t('returns.no_bill')}</span>
          ),
      },
      {
        id: 'customer',
        header: t('returns.col_customer'),
        enableSorting: false,
        meta: { label: t('returns.col_customer') },
        cell: ({ row }) =>
          row.original.customer_name ?? (
            <span className="text-muted-foreground">{t('common:misc.walk_in')}</span>
          ),
      },
      {
        id: 'reason',
        header: t('returns.col_reason'),
        enableSorting: false,
        meta: { label: t('returns.col_reason') },
        cell: ({ row }) => (
          <div className="text-sm">
            <div>{reasonLabel(row.original.reason, i18n.language)}</div>
            <div className="text-xs text-muted-foreground">
              {settlementLabel(row.original.settlement, i18n.language)}
            </div>
          </div>
        ),
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('returns.col_total'),
        enableSorting: true,
        meta: { align: 'right', label: t('returns.col_total') },
        cell: ({ row }) => (
          <Money
            paise={row.original.total_paise}
            className={
              row.original.status === 'cancelled' ? 'line-through opacity-60' : 'font-medium'
            }
          />
        ),
      },
      {
        id: 'status',
        header: t('returns.col_status'),
        enableSorting: false,
        meta: { label: t('returns.col_status') },
        cell: ({ row }) => <CreditNoteStatusBadge status={row.original.status} />,
      },
    ],
    [t, i18n.language],
  )

  const nothing = !list.isLoading && !list.error && list.data?.page.total === 0
  const defaultView = !state.q && active.length === 0 && state.period === DEFAULTS.period

  return (
    <div>
      <PageHeader
        title={t('returns.title')}
        description={t('returns.description')}
        actions={
          <>
            <ExportButton
              download={() =>
                downloadRoute(salesRoutes.listCreditNotes, {
                  query: { ...filterQuery, format: 'csv' },
                  filename: 'credit-notes.csv',
                })
              }
            />
            {canReturn ? (
              <Button asChild leftIcon={<RotateCcw />}>
                <Link to="/sales/returns/new">{t('returns.new')}</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <div className="flex flex-col gap-3 pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <SearchInput
            ref={searchRef}
            value={state.q}
            onChange={(q) => setState({ q })}
            placeholder={t('returns.search_placeholder')}
            wrapperClassName="sm:max-w-sm sm:flex-1"
          />
          <div className="flex flex-wrap items-center gap-2">
            <PeriodFilter value={range} onChange={(r) => setState(periodPatch(r, ctx))} />
            <FilterDrawer activeCount={active.length} onReset={reset}>
              {multiStore ? (
                <FormField label={t('filters.store')}>
                  <StorePicker
                    value={state.store || null}
                    onChange={(id) => setState({ store: id ?? '' })}
                  />
                </FormField>
              ) : null}
              <FormField label={t('filters.status')}>
                <Select
                  value={status}
                  onValueChange={(v) => setState({ status: v })}
                  options={STATUSES.map((s) => ({
                    value: s,
                    label: s ? t(`credit_note_status.${s}`) : t('filters.status_all'),
                  }))}
                />
              </FormField>
              <FormField label={t('filters.reason')}>
                <Select
                  value={reason}
                  onValueChange={(v) => setState({ reason: v })}
                  options={REASONS.map((r) => ({
                    value: r,
                    label: r ? reasonLabel(r, i18n.language) : t('filters.reason_all'),
                  }))}
                />
              </FormField>
              <FormField label={t('filters.settlement')}>
                <Select
                  value={settlement}
                  onValueChange={(v) => setState({ settlement: v })}
                  options={SETTLEMENTS.map((s) => ({
                    value: s,
                    label: s ? settlementLabel(s, i18n.language) : t('filters.settlement_all'),
                  }))}
                />
              </FormField>
            </FilterDrawer>
          </div>
        </div>
        <ActiveFilterChips filters={active} />
      </div>

      <SummaryTiles
        label={t('returns.summary_label')}
        loading={list.isLoading}
        tiles={[
          {
            key: 'count',
            label: t('summary.credit_notes'),
            value: list.data?.summary.count ?? 0,
            count: true,
          },
          {
            key: 'total',
            label: t('summary.returned_value'),
            value: list.data?.summary.total_paise ?? 0,
          },
        ]}
      />

      <DataTable
        label={t('returns.title')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(r) => r.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => navigate(`/sales/returns/${r.id}`)}
        sort={sort}
        onSortChange={(s) => setState({ sort: s ?? DEFAULTS.sort })}
        pagination={
          list.data
            ? {
                ...list.data.page,
                pageSizeOptions: LIST_PAGE_SIZES,
                onChange: ({ offset, limit }) =>
                  setState({ offset: String(offset), limit: String(limit) }),
              }
            : undefined
        }
        renderCard={(r) => <ReturnCard row={r} />}
        empty={
          nothing && defaultView ? (
            <EmptyState
              icon={<Undo2 />}
              title={t('returns.empty_title')}
              description={t('returns.empty_description')}
              action={
                canReturn ? (
                  <Button asChild leftIcon={<RotateCcw />}>
                    <Link to="/sales/returns/new">{t('returns.new')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              compact
              icon={<SearchX />}
              title={t('returns.none_title')}
              description={t('invoices.none_hint')}
              action={
                <>
                  {range ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setState(periodPatch(null, ctx))}
                    >
                      {t('filters.search_all_dates')}
                    </Button>
                  ) : null}
                  {active.length > 0 ? (
                    <Button variant="ghost" size="sm" onClick={reset}>
                      {t('common:actions.clear_filters')}
                    </Button>
                  ) : null}
                </>
              }
            />
          )
        }
      />
    </div>
  )
}

function ReturnCard({ row }: { row: CreditNoteListRow }) {
  const { t, i18n } = useTranslation(['sales', 'common'])
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{row.number}</div>
          <div className="text-xs text-muted-foreground">
            {formatDate(row.note_date)}
            {row.invoice_number ? ` · ${t('returns.against', { number: row.invoice_number })}` : ''}
          </div>
        </div>
        <Money
          paise={row.total_paise}
          className={
            row.status === 'cancelled' ? 'line-through opacity-60' : 'text-base font-semibold'
          }
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{row.customer_name ?? t('common:misc.walk_in')}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {settlementLabel(row.settlement, i18n.language)}
          </span>
          {row.status === 'cancelled' ? <CreditNoteStatusBadge status={row.status} /> : null}
        </div>
      </div>
    </div>
  )
}
