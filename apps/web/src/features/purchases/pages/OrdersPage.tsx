/**
 * Purchase orders (/purchases/orders) with two tabs (?tab=reorder):
 *  - Orders: status chips (all, drafts, open, received, closed / cancelled), search by number or
 *    supplier, supplier / store / order-date filters, receipt progress per order.
 *  - Reorder: suggestions grouped by supplier → draft purchase orders in one go.
 */
import type { PurchaseOrderListRow } from '@kadai/shared/api/purchases'
import { ClipboardList, Plus, ShieldCheck, Sparkles } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Kbd,
  Money,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useOrders } from '../api'
import { ListFilters } from '../components/ListFilters'
import { ReorderPanel } from '../components/ReorderPanel'
import { SupplierTrustPanel } from '../components/SupplierTrustPanel'
import { OrderStatusBadge } from '../components/StatusBadges'
import { PURCHASES_HOTKEY_SCOPE } from '../lib/labels'
import { ORDER_FILTERS, type OrderFilter, orderFilterQuery } from '../lib/list-filters'
import { LIST_PAGE_SIZES, useListState } from '../lib/url-state'

const FILTERS = ORDER_FILTERS
const SORTS = ['order_date', 'number', 'total_paise', 'expected_date', 'created_at'] as const
type Tab = 'orders' | 'reorder' | 'trust'

export default function OrdersPage() {
  const { t } = useTranslation(['purchases', 'common'])
  const navigate = useNavigate()
  const canWrite = useCan('purchases.write')
  const searchRef = useRef<HTMLInputElement>(null)
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: Tab = tabParam === 'reorder' || tabParam === 'trust' ? tabParam : 'orders'
  const [state, setState] = useListState<OrderFilter>({
    filter: 'all',
    filters: FILTERS,
    sort: '-order_date',
    sorts: SORTS,
  })
  const list = useOrders(
    {
      limit: state.limit,
      offset: state.offset,
      sort: state.sort,
      ...(state.q ? { q: state.q } : {}),
      ...(state.supplier_id ? { supplier_id: state.supplier_id } : {}),
      ...(state.store_id ? { store_id: state.store_id } : {}),
      ...(state.from && state.to ? { from: state.from, to: state.to } : {}),
      ...orderFilterQuery(state.filter),
    },
    tab === 'orders',
  )
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const filtered =
    state.filter !== 'all' || Boolean(state.q || state.supplier_id || state.from || state.store_id)

  const setTab = (next: Tab): void =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next === 'orders') p.delete('tab')
        else p.set('tab', next)
        return p
      },
      { replace: true },
    )

  useHotkeyScope(PURCHASES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) navigate('/purchases/orders/new')
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: PURCHASES_HOTKEY_SCOPE },
  )

  const columns = useMemo<DataTableColumn<PurchaseOrderListRow>[]>(
    () => [
      {
        id: 'number',
        accessorKey: 'number',
        header: t('orders.col_number'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <span className="font-medium tabular-nums">{row.original.number}</span>
            <OrderStatusBadge status={row.original.status} />
          </div>
        ),
      },
      {
        id: 'supplier',
        header: t('bills.col_supplier'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.supplier_name}</div>
            <div className="text-xs text-muted-foreground">
              {t('orders.lines_count', { count: row.original.line_count })}
            </div>
          </div>
        ),
      },
      {
        id: 'order_date',
        accessorKey: 'order_date',
        header: t('orders.order_date'),
        enableSorting: true,
        meta: { label: t('orders.order_date') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.order_date)}</span>
        ),
      },
      {
        id: 'expected_date',
        accessorKey: 'expected_date',
        header: t('orders.expected_date'),
        enableSorting: true,
        meta: { label: t('orders.expected_date') },
        cell: ({ row }) =>
          row.original.expected_date ? (
            <span className="tabular-nums">{formatDate(row.original.expected_date)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'received',
        header: t('orders.received_progress'),
        meta: { label: t('orders.received_progress') },
        cell: ({ row }) => <Progress bp={row.original.received_bp} />,
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('totals.total'),
        enableSorting: true,
        meta: { align: 'right', mobile: 'value', label: t('totals.total') },
        cell: ({ row }) => <Money paise={row.original.total_paise} className="font-medium" />,
      },
    ],
    [t],
  )

  const chips = FILTERS.map((key) => ({ key, label: t(`orders.filter_${key}`) }))
  const firstRun = !filtered && !list.isLoading && !list.error && page?.total === 0

  return (
    <div>
      <PageHeader
        title={t('orders.title')}
        description={t('orders.description')}
        actions={
          canWrite ? (
            <Button leftIcon={<Plus />} onClick={() => navigate('/purchases/orders/new')}>
              {t('orders.new')}
              <Kbd
                combo="alt+n"
                className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
              />
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v === 'reorder' || v === 'trust' ? v : 'orders')}
      >
        <TabsList aria-label={t('orders.tabs_label')}>
          <TabsTrigger value="orders">
            <ClipboardList />
            {t('orders.tab_orders')}
          </TabsTrigger>
          <TabsTrigger value="reorder">
            <Sparkles />
            {t('orders.tab_reorder')}
          </TabsTrigger>
          <TabsTrigger value="trust">
            <ShieldCheck />
            {t('orders.tab_trust')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="orders">
          <ListFilters
            state={state}
            onChange={setState}
            defaultFilter="all"
            chips={chips}
            searchRef={searchRef}
            searchPlaceholder={t('orders.search_placeholder')}
            dateLabel={t('orders.order_date')}
          />
          {firstRun ? (
            <div className="rounded-xl border border-dashed border-border bg-surface">
              <EmptyState
                icon={<ClipboardList />}
                title={t('orders.empty_title')}
                description={t('orders.empty_description')}
                action={
                  canWrite ? (
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button
                        variant="outline"
                        leftIcon={<Sparkles />}
                        onClick={() => setTab('reorder')}
                      >
                        {t('orders.from_reorder')}
                      </Button>
                      <Button leftIcon={<Plus />} onClick={() => navigate('/purchases/orders/new')}>
                        {t('orders.new')}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <DataTable
              label={t('orders.title')}
              columns={columns}
              data={rows}
              getRowId={(o) => o.id}
              loading={list.isFetching}
              error={list.error}
              onRetry={() => void list.refetch()}
              onRowClick={(o) => navigate(`/purchases/orders/${o.id}`)}
              sort={state.sort}
              onSortChange={(sort) => setState({ sort: sort ?? '-order_date' })}
              pagination={
                page
                  ? {
                      ...page,
                      pageSizeOptions: LIST_PAGE_SIZES,
                      onChange: ({ offset, limit }) => setState({ offset, limit }),
                    }
                  : undefined
              }
              renderCard={(o) => (
                <div className="grid min-w-0 gap-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{o.supplier_name}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {o.number} · {formatDate(o.order_date)}
                      </div>
                    </div>
                    <Money paise={o.total_paise} className="shrink-0 font-semibold" />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <OrderStatusBadge status={o.status} />
                    <Progress bp={o.received_bp} className="w-32" />
                  </div>
                </div>
              )}
              empty={
                <EmptyState
                  compact
                  icon={<ClipboardList />}
                  title={t(`orders.none_${state.filter}`)}
                  description={t('bills.none_hint')}
                />
              }
            />
          )}
        </TabsContent>
        <TabsContent value="reorder">
          <ReorderPanel />
        </TabsContent>
        <TabsContent value="trust">
          <SupplierTrustPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Progress({ bp, className }: { bp: number; className?: string }) {
  const { t } = useTranslation('purchases')
  const pct = Math.min(100, Math.round(bp / 100))
  return (
    <div className={cn('flex min-w-24 items-center gap-2', className)}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t('orders.received_progress')}
      >
        <div
          className={cn('h-full rounded-full', pct >= 100 ? 'bg-success' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 text-end text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  )
}
