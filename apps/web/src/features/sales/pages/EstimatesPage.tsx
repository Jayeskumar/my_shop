/**
 * Estimates / quotations (/sales/estimates): sales_invoices with doc_type estimate (valid until =
 * due_date). Quick views: open (valid), expired, converted, all; search by number / customer;
 * period filter. Rows open the estimate (print, share, convert into a bill). New estimates are
 * made at the billing counter ("Estimate" key).
 */
import { FileText, ScanLine, SearchX } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import {
  type InvoiceListQuery,
  type SalesInvoiceListRow,
  salesRoutes,
} from '@kadai/shared/api/sales'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Money,
  PageHeader,
  SearchInput,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan, useFeature } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useInvoices } from '../api'
import { ExportButton } from '../components/ExportButton'
import { PeriodFilter } from '../components/PeriodFilter'
import { EstimateStateBadge } from '../components/StatusBadges'
import { estimateState } from '../lib/labels'
import { periodPatch, periodRange } from '../lib/period'
import { LIST_PAGE_SIZES, oneOf, pageOf, useSearchState } from '../lib/search-state'
import { useTenantCalendar } from '../lib/use-tenant-calendar'

const VIEWS = ['open', 'converted', 'cancelled', 'all'] as const
type View = (typeof VIEWS)[number]
const SORTS = ['invoice_at', 'invoice_date', 'number', 'total_paise', 'created_at']
const SCOPE = 'sales-estimates'

const DEFAULTS = {
  q: '',
  view: 'open',
  period: 'all',
  from: '',
  to: '',
  sort: '-invoice_at',
} as const

function viewStatus(view: View): InvoiceListQuery['status'] {
  switch (view) {
    case 'open':
      return ['completed']
    case 'converted':
      return ['converted']
    case 'cancelled':
      return ['cancelled']
    case 'all':
      return ['completed', 'converted', 'cancelled']
  }
}

export default function EstimatesPage() {
  const { t } = useTranslation(['sales', 'common'])
  const navigate = useNavigate()
  const { today, ctx } = useTenantCalendar()
  const posAllowed = useCan('pos.use')
  const posInPlan = useFeature('pos')
  const canPos = posAllowed && posInPlan
  const searchRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useSearchState(DEFAULTS)
  const page = pageOf(state)
  const view = oneOf(state.view, VIEWS, 'open')
  const range = periodRange(state, ctx)
  const sort = SORTS.includes(state.sort.replace(/^-/, '')) ? state.sort : DEFAULTS.sort

  const filterQuery: InvoiceListQuery = {
    doc_type: ['estimate'],
    status: viewStatus(view),
    ...(state.q ? { q: state.q } : {}),
    ...(range ? { from: range.from, to: range.to } : {}),
    sort,
  }
  const list = useInvoices({ ...filterQuery, limit: page.limit, offset: page.offset })

  useHotkeyScope(SCOPE)
  useHotkeys({ '/': () => searchRef.current?.focus() }, { scope: SCOPE })

  const columns = useMemo<DataTableColumn<SalesInvoiceListRow>[]>(
    () => [
      {
        id: 'number',
        accessorKey: 'number',
        header: t('estimates.col_number'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <Link
            to={`/sales/invoices/${row.original.id}`}
            className="font-medium hover:text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.number ?? '—'}
          </Link>
        ),
      },
      {
        id: 'invoice_date',
        accessorKey: 'invoice_date',
        header: t('estimates.col_date'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('estimates.col_date') },
        cell: ({ row }) => formatDate(row.original.invoice_date),
      },
      {
        id: 'valid_until',
        header: t('estimates.col_valid_until'),
        enableSorting: false,
        meta: { label: t('estimates.col_valid_until') },
        cell: ({ row }) => {
          const until = row.original.due_date
          if (!until) return <span className="text-muted-foreground">—</span>
          const expired = row.original.status === 'completed' && until < today
          return (
            <span className={cn(expired && 'text-muted-foreground line-through')}>
              {formatDate(until)}
            </span>
          )
        },
      },
      {
        id: 'customer',
        header: t('estimates.col_customer'),
        enableSorting: false,
        meta: { label: t('estimates.col_customer') },
        cell: ({ row }) =>
          row.original.customer_name ?? (
            <span className="text-muted-foreground">{t('common:misc.walk_in')}</span>
          ),
      },
      {
        id: 'items',
        accessorKey: 'item_count',
        header: t('invoices.col_items'),
        enableSorting: false,
        meta: { align: 'right', label: t('invoices.col_items') },
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('estimates.col_total'),
        enableSorting: true,
        meta: { align: 'right', label: t('estimates.col_total') },
        cell: ({ row }) => <Money paise={row.original.total_paise} className="font-medium" />,
      },
      {
        id: 'state',
        header: t('estimates.col_status'),
        enableSorting: false,
        meta: { label: t('estimates.col_status') },
        cell: ({ row }) => <EstimateStateBadge state={estimateState(row.original, today)} />,
      },
    ],
    [t, today],
  )

  const nothing = !list.isLoading && !list.error && list.data?.page.total === 0
  const firstRun = nothing && !state.q && view === 'open' && !range

  return (
    <div>
      <PageHeader
        title={t('estimates.title')}
        description={t('estimates.description')}
        actions={
          <>
            <ExportButton
              download={() =>
                downloadRoute(salesRoutes.listInvoices, {
                  query: { ...filterQuery, format: 'csv' },
                  filename: 'estimates.csv',
                })
              }
            />
            {canPos ? (
              <Button asChild leftIcon={<ScanLine />}>
                <Link to="/pos">{t('estimates.new')}</Link>
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
            placeholder={t('estimates.search_placeholder')}
            wrapperClassName="sm:max-w-sm sm:flex-1"
          />
          <PeriodFilter value={range} onChange={(r) => setState(periodPatch(r, ctx))} />
        </div>
        <div role="tablist" aria-label={t('estimates.views')} className="flex flex-wrap gap-2">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setState({ view: v })}
              className={cn(
                'h-9 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                view === v
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-surface hover:border-primary hover:text-primary',
              )}
            >
              {t(`estimates.view_${v}`)}
            </button>
          ))}
        </div>
      </div>

      <DataTable
        label={t('estimates.title')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(r) => r.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => navigate(`/sales/invoices/${r.id}`)}
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
        renderCard={(r) => (
          <div className="grid min-w-0 gap-1.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-semibold">{r.number}</div>
                <div className="text-xs text-muted-foreground">
                  {formatDate(r.invoice_date)}
                  {r.due_date
                    ? ` · ${t('estimates.valid_until', { date: formatDate(r.due_date) })}`
                    : ''}
                </div>
              </div>
              <Money paise={r.total_paise} className="text-base font-semibold" />
            </div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {r.customer_name ?? t('common:misc.walk_in')}
              </span>
              <EstimateStateBadge state={estimateState(r, today)} />
            </div>
          </div>
        )}
        empty={
          firstRun ? (
            <EmptyState
              icon={<FileText />}
              title={t('estimates.empty_title')}
              description={t('estimates.empty_description')}
              action={
                canPos ? (
                  <Button asChild leftIcon={<ScanLine />}>
                    <Link to="/pos">{t('estimates.new')}</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              compact
              icon={<SearchX />}
              title={t('estimates.none_title')}
              description={t('invoices.none_hint')}
              action={
                view !== 'all' || range ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setState({ view: 'all', ...periodPatch(null, ctx) })}
                  >
                    {t('estimates.show_all')}
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
