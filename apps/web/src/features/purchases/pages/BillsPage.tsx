/**
 * Purchase bills (/purchases/bills): every supplier bill / GRN with what is still to pay.
 * Quick filters (all, drafts, to pay, overdue, paid, cancelled), search by GRN / supplier invoice
 * number / supplier, supplier / store / received-date filters, server sort and paging in the URL.
 * Overdue bills are flagged in red with their days overdue; the supplier name opens the supplier
 * quick view (what the shop owes, recent bills). Totals cover the whole filtered range.
 */
import type { PurchaseBillListQuery, PurchaseBillListRow } from '@kadai/shared/api/purchases'
import { purchasesRoutes } from '@kadai/shared/api/purchases'
import {
  AlertTriangle,
  Download,
  FileText,
  IndianRupee,
  Plus,
  ReceiptText,
  Wallet,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Kbd,
  Money,
  PageHeader,
  Stat,
  notify,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useBills } from '../api'
import { ListFilters } from '../components/ListFilters'
import { BillStatusBadge, PaymentStatusBadge } from '../components/StatusBadges'
import { SupplierQuickView } from '../components/SupplierQuickView'
import { PURCHASES_HOTKEY_SCOPE } from '../lib/labels'
import { BILL_FILTERS, type BillFilter, billFilterQuery } from '../lib/list-filters'
import { LIST_PAGE_SIZES, useListState } from '../lib/url-state'

const FILTERS = BILL_FILTERS
const SORTS = [
  'received_date',
  'supplier_invoice_date',
  'due_date',
  'number',
  'total_paise',
  'due_paise',
  'created_at',
] as const

export default function BillsPage() {
  const { t } = useTranslation(['purchases', 'common'])
  const navigate = useNavigate()
  const canWrite = useCan('purchases.write')
  const searchRef = useRef<HTMLInputElement>(null)
  const [quickView, setQuickView] = useState<{ id: string; name: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [state, setState] = useListState<BillFilter>({
    filter: 'all',
    filters: FILTERS,
    sort: '-received_date',
    sorts: SORTS,
  })
  const query: PurchaseBillListQuery = {
    limit: state.limit,
    offset: state.offset,
    sort: state.sort,
    ...(state.q ? { q: state.q } : {}),
    ...(state.supplier_id ? { supplier_id: state.supplier_id } : {}),
    ...(state.store_id ? { store_id: state.store_id } : {}),
    ...(state.from && state.to ? { from: state.from, to: state.to } : {}),
    ...billFilterQuery(state.filter),
  }
  const list = useBills(query)
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const summary = list.data?.summary
  const filtered =
    state.filter !== 'all' || Boolean(state.q || state.supplier_id || state.from || state.store_id)

  useHotkeyScope(PURCHASES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) navigate('/purchases/bills/new')
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: PURCHASES_HOTKEY_SCOPE },
  )

  const exportCsv = async (): Promise<void> => {
    setExporting(true)
    try {
      const { limit: _limit, offset: _offset, ...rest } = query
      await downloadRoute(purchasesRoutes.listBills, {
        query: { ...rest, format: 'csv' },
        filename: 'purchase-bills.csv',
      })
    } catch (error) {
      notify.error(error)
    } finally {
      setExporting(false)
    }
  }

  const openSupplier = (row: PurchaseBillListRow): void =>
    setQuickView({ id: row.supplier_id, name: row.supplier_name })

  const columns = useMemo<DataTableColumn<PurchaseBillListRow>[]>(
    () => [
      {
        id: 'number',
        accessorKey: 'number',
        header: t('bills.col_grn'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <span className="font-medium tabular-nums">
              {row.original.number ?? t('bills.draft_number')}
            </span>
            <BillStatusBadge status={row.original.status} />
          </div>
        ),
      },
      {
        id: 'supplier',
        header: t('bills.col_supplier'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <button
              type="button"
              className="max-w-full truncate text-start font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(e) => {
                e.stopPropagation()
                openSupplier(row.original)
              }}
            >
              {row.original.supplier_name}
            </button>
            <div className="truncate text-xs text-muted-foreground">
              {t('bills.invoice_ref', {
                no: row.original.supplier_invoice_no || '—',
                date: formatDate(row.original.supplier_invoice_date),
              })}
            </div>
          </div>
        ),
      },
      {
        id: 'received_date',
        accessorKey: 'received_date',
        header: t('bills.col_received'),
        enableSorting: true,
        meta: { label: t('bills.col_received') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.received_date)}</span>
        ),
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('bills.col_total'),
        enableSorting: true,
        meta: { align: 'right', label: t('bills.col_total') },
        cell: ({ row }) => <Money paise={row.original.total_paise} className="font-medium" />,
      },
      {
        id: 'due_paise',
        accessorKey: 'due_paise',
        header: t('bills.col_due'),
        enableSorting: true,
        meta: { align: 'right', mobile: 'value', label: t('bills.col_due') },
        cell: ({ row }) => <DueCell row={row.original} />,
      },
      {
        id: 'due_date',
        accessorKey: 'due_date',
        header: t('bills.col_due_date'),
        enableSorting: true,
        meta: { label: t('bills.col_due_date') },
        cell: ({ row }) =>
          row.original.due_date ? (
            <span
              className={
                row.original.overdue ? 'font-medium text-danger tabular-nums' : 'tabular-nums'
              }
            >
              {formatDate(row.original.due_date)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    [t],
  )

  const chips = FILTERS.map((key) => ({
    key,
    label: t(`bills.filter_${key}`),
    tone: key === 'overdue' ? ('danger' as const) : undefined,
  }))
  const firstRun = !filtered && !list.isLoading && !list.error && page?.total === 0

  return (
    <div>
      <PageHeader
        title={t('bills.title')}
        description={t('bills.description')}
        actions={
          <>
            <Button
              variant="outline"
              leftIcon={<Download />}
              loading={exporting}
              disabled={!page || page.total === 0}
              onClick={() => void exportCsv()}
            >
              {t('common:actions.export_csv')}
            </Button>
            {canWrite ? (
              <Button leftIcon={<Plus />} onClick={() => navigate('/purchases/bills/new')}>
                {t('bills.new')}
                <Kbd
                  combo="alt+n"
                  className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
                />
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('bills.stat_count')}
          value={summary?.count ?? 0}
          icon={<ReceiptText />}
          loading={list.isLoading}
        />
        <Stat
          label={t('bills.stat_total')}
          value={<Money paise={summary?.total_paise ?? 0} decimals="auto" />}
          icon={<IndianRupee />}
          loading={list.isLoading}
        />
        <Stat
          label={t('bills.stat_due')}
          value={<Money paise={summary?.due_paise ?? 0} decimals="auto" />}
          icon={<Wallet />}
          tone="accent"
          loading={list.isLoading}
          onClick={() => setState({ filter: 'to_pay' })}
        />
        <Stat
          label={t('bills.stat_overdue')}
          value={<Money paise={summary?.overdue_paise ?? 0} decimals="auto" />}
          icon={<AlertTriangle />}
          tone="danger"
          loading={list.isLoading}
          onClick={() => setState({ filter: 'overdue' })}
        />
      </div>

      <ListFilters
        state={state}
        onChange={setState}
        defaultFilter="all"
        chips={chips}
        searchRef={searchRef}
        searchPlaceholder={t('bills.search_placeholder')}
        dateLabel={t('bills.col_received')}
      />

      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<FileText />}
            title={t('bills.empty_title')}
            description={t('bills.empty_description')}
            action={
              canWrite ? (
                <Button leftIcon={<Plus />} onClick={() => navigate('/purchases/bills/new')}>
                  {t('bills.new_first')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <DataTable
          label={t('bills.title')}
          columns={columns}
          data={rows}
          getRowId={(b) => b.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(b) => navigate(`/purchases/bills/${b.id}`)}
          sort={state.sort}
          onSortChange={(sort) => setState({ sort: sort ?? '-received_date' })}
          pagination={
            page
              ? {
                  ...page,
                  pageSizeOptions: LIST_PAGE_SIZES,
                  onChange: ({ offset, limit }) => setState({ offset, limit }),
                }
              : undefined
          }
          renderCard={(b) => (
            <div className="grid min-w-0 gap-1">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 truncate font-semibold">{b.supplier_name}</div>
                <Money paise={b.total_paise} className="shrink-0 font-semibold" />
              </div>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 text-xs text-muted-foreground">
                  <div className="truncate">
                    {t('bills.invoice_ref', {
                      no: b.supplier_invoice_no || '—',
                      date: formatDate(b.supplier_invoice_date),
                    })}
                  </div>
                  <div className="truncate tabular-nums">
                    {b.number ?? t('bills.draft_number')} · {formatDate(b.received_date)}
                  </div>
                </div>
                <div className="shrink-0 text-sm">
                  <DueCell row={b} />
                </div>
              </div>
              <div>
                <BillStatusBadge status={b.status} />
              </div>
            </div>
          )}
          empty={
            <EmptyState
              compact
              icon={<FileText />}
              title={t(`bills.none_${state.filter}`)}
              description={t('bills.none_hint')}
            />
          }
        />
      )}

      <SupplierQuickView
        supplierId={quickView?.id ?? null}
        fallback={quickView ? { name: quickView.name } : undefined}
        open={quickView !== null}
        onOpenChange={(o) => !o && setQuickView(null)}
      />
    </div>
  )
}

/** Due amount with payment status; overdue bills show their days overdue in red. */
function DueCell({ row }: { row: PurchaseBillListRow }) {
  const { t } = useTranslation('purchases')
  if (row.status !== 'posted') return <span className="text-muted-foreground">—</span>
  if (row.due_paise <= 0) return <PaymentStatusBadge status="paid" />
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={row.overdue ? 'font-semibold text-danger' : 'font-medium'}>
        {formatMoney(row.due_paise)}
      </span>
      {row.overdue ? (
        <span className="text-xs font-medium text-danger">
          {t('bills.days_overdue', { count: row.days_overdue ?? 0 })}
        </span>
      ) : (
        <PaymentStatusBadge status={row.payment_status} />
      )}
    </div>
  )
}
