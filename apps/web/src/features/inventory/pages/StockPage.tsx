/**
 * Stock (/inventory/stock): stock levels of a store (or all stores) with value at cost and at
 * MRP, status badges and totals over the whole filtered list. Search also takes a scanned
 * barcode; quick chips filter low / out of stock; the category filter includes sub-categories.
 * Rows open a side panel with the stock per batch and the last movements; selected rows can be
 * reordered, adjusted or transferred together. Opening stock and CSV export live here too.
 * State (store, search, filters, sort, page) is kept in the URL.
 */
import {
  STOCK_STATUS_LABELS,
  type StockListQuery,
  type StockRow,
  adjustmentPrefillPath,
  batchExpiryTabFor,
  batchesPagePath,
  expiryStatus,
  inventoryRoutes,
  reorderPrefillPath,
  transferPrefillPath,
} from '@kadai/shared/api/inventory'
import { keepPreviousData } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  Boxes,
  CalendarClock,
  Download,
  PackagePlus,
  ShoppingBag,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { ALL_STORES, CategoryPicker, StorePicker } from '@/components/pickers'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Kbd,
  Money,
  PageHeader,
  Qty,
  SearchInput,
  Select,
  Skeleton,
  notify,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useRouteQuery } from '@/lib/query'
import { FilterChips } from '../components/FilterChips'
import { OpeningStockDialog } from '../components/OpeningStockDialog'
import { ProductName } from '../components/ProductName'
import { ExpiryBadge, StockStatusBadge } from '../components/StockBadge'
import { StockDrawer } from '../components/StockDrawer'
import { useDefaultStoreId, useInventoryAccess, useToday } from '../lib/access'
import { notifyInventoryError } from '../lib/errors'
import { INVENTORY_HOTKEY_SCOPE, packUnitFor, pickLabel } from '../lib/labels'
import { PAGE_SIZES, useUrlState } from '../lib/url-state'

const FILTERS = ['all', 'low', 'out', 'in'] as const
type StockFilter = (typeof FILTERS)[number]
const SORTS = ['name', 'qty', 'value', 'sku', 'last_movement_at', 'expiry'] as const

function filterQuery(filter: string): Partial<StockListQuery> {
  if (filter === 'low') return { low_stock: true }
  if (filter === 'out') return { out_of_stock: true }
  if (filter === 'in') return { in_stock: true }
  return {}
}

function rowId(r: StockRow): string {
  return `${r.product_id}:${r.batch_id ?? '-'}`
}

export default function StockPage() {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const navigate = useNavigate()
  const access = useInventoryAccess()
  const canCatalog = useCan('catalog.read')
  const today = useToday()
  const me = useMe()
  const defaultStore = useDefaultStoreId()
  const searchRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [state, setState] = useUrlState({
    store: defaultStore ?? '',
    q: '',
    filter: 'all',
    category: '',
    sort: 'name',
    group: 'product',
    product: '',
    opening: '',
  })
  const storeScope = state.store || defaultStore || ALL_STORES
  const singleStore = storeScope === ALL_STORES ? undefined : storeScope
  const group = state.group === 'batch' && access.batches ? 'batch' : 'product'
  const sort = SORTS.includes(state.sort.replace(/^-/, '') as (typeof SORTS)[number])
    ? state.sort
    : 'name'
  const filter: StockFilter = (FILTERS as readonly string[]).includes(state.filter)
    ? (state.filter as StockFilter)
    : 'all'

  const query: StockListQuery = {
    store_id: storeScope,
    limit: state.limit,
    offset: state.offset,
    sort,
    group,
    ...(state.q ? { q: state.q } : {}),
    ...(state.category ? { category_id: state.category } : {}),
    ...filterQuery(filter),
  }
  const list = useRouteQuery(
    inventoryRoutes.listStock,
    { query },
    { placeholderData: keepPreviousData },
  )
  const alerts = useRouteQuery(
    inventoryRoutes.stockAlerts,
    { query: { store_id: storeScope, limit: 1 } },
    { meta: { errorToast: false } },
  )
  const rows = list.data?.data ?? []
  const totals = list.data?.totals
  const page = list.data?.page
  const counts = alerts.data?.data.counts
  const filtered = filter !== 'all' || Boolean(state.q) || Boolean(state.category)
  const firstRun = !filtered && !list.isLoading && !list.error && page?.total === 0

  useHotkeyScope(INVENTORY_HOTKEY_SCOPE)
  useHotkeys(
    {
      '/': () => searchRef.current?.focus(),
      'alt+o': () => {
        if (access.adjust) setState({ opening: '1' })
      },
    },
    { scope: INVENTORY_HOTKEY_SCOPE },
  )

  const selectedProducts = useMemo(
    () => [...new Set([...selected].map((id) => id.split(':')[0]!))],
    [selected],
  )

  const exportCsv = async (): Promise<void> => {
    setExporting(true)
    try {
      const { limit: _l, offset: _o, ...rest } = query
      await downloadRoute(inventoryRoutes.listStock, {
        query: { ...rest, format: 'csv' },
        filename: `stock-${today}.csv`,
      })
      notify.success(t('stock.exported'))
    } catch (error) {
      // export_too_large (422) and other inventory reasons get their own text.
      notifyInventoryError(error)
    } finally {
      setExporting(false)
    }
  }

  const warningDays = me?.settings.inventory.expiry_warning_days ?? 90
  const batchExpiry = useCallback(
    (date: string | null) => {
      const e = expiryStatus(date, today, warningDays)
      return { status: e.status, daysToExpiry: e.days_to_expiry }
    },
    [today, warningDays],
  )

  const columns = useMemo<DataTableColumn<StockRow>[]>(() => {
    const cols: DataTableColumn<StockRow>[] = [
      {
        id: 'name',
        header: t('stock.col_product'),
        enableSorting: true,
        meta: { mobile: 'title', className: 'max-w-[18rem]' },
        cell: ({ row }) => (
          <ProductName
            name={row.original.name}
            nameTa={row.original.name_ta}
            sku={row.original.sku}
            extra={[row.original.category_name]}
          />
        ),
      },
    ]
    if (group === 'batch')
      cols.push({
        id: 'expiry',
        header: t('stock.col_batch'),
        enableSorting: true,
        meta: { label: t('stock.col_batch') },
        cell: ({ row }) =>
          row.original.batch_no ? (
            <div className="grid gap-0.5">
              <span className="font-medium">{row.original.batch_no}</span>
              {row.original.expiry_date ? (
                <ExpiryBadge
                  expiryDate={row.original.expiry_date}
                  {...batchExpiry(row.original.expiry_date)}
                  showDate
                />
              ) : null}
            </div>
          ) : (
            <span className="text-muted-foreground">{t('by_batch.no_batch')}</span>
          ),
      })
    cols.push(
      {
        id: 'qty',
        header: t('stock.col_qty'),
        enableSorting: true,
        meta: { align: 'right', label: t('stock.col_qty') },
        cell: ({ row }) => (
          <div className="grid justify-items-end gap-0.5">
            <Qty
              milli={row.original.qty_milli}
              unit={row.original.unit}
              packSize={row.original.pack_size}
              packUnit={packUnitFor(row.original.unit)}
              colorize
              className="font-semibold"
            />
            {row.original.pack_size > 1 ? (
              <span className="text-xs text-muted-foreground">
                {t('common:units.pack_of', { count: row.original.pack_size })}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        // Cost and MRP value share one column (two lines) so the table fits at 1366 px in Tamil.
        id: 'value',
        header: t('stock.col_value'),
        enableSorting: true,
        meta: { align: 'right', label: t('stock.col_value') },
        cell: ({ row }) => (
          <div className="grid justify-items-end gap-0.5">
            <Money
              paise={row.original.value_cost_paise}
              colorize={row.original.value_cost_paise < 0}
              className="font-medium"
            />
            {row.original.value_mrp_paise !== null ? (
              <span className="text-xs text-muted-foreground">
                {t('stock.mrp')} <Money paise={row.original.value_mrp_paise} />
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'reorder',
        header: t('stock.col_reorder'),
        enableSorting: false,
        meta: { align: 'right', label: t('stock.col_reorder') },
        cell: ({ row }) =>
          row.original.reorder_level_milli !== null ? (
            <Qty
              milli={row.original.reorder_level_milli}
              unit={row.original.unit}
              packSize={row.original.pack_size}
              packUnit={packUnitFor(row.original.unit)}
              className="text-muted-foreground"
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: t('stock.col_status'),
        enableSorting: false,
        meta: { label: t('stock.col_status') },
        cell: ({ row }) => <StockStatusBadge status={row.original.status} />,
      },
    )
    return cols
  }, [t, group, batchExpiry])

  const chips = FILTERS.map((key) => ({
    key,
    label: t(`stock.filter_${key}`),
    badge:
      key === 'low' && counts
        ? counts.low_stock
        : key === 'out' && counts
          ? counts.out_of_stock + counts.negative
          : undefined,
    tone: key === 'low' ? ('warning' as const) : key === 'out' ? ('danger' as const) : undefined,
  }))

  return (
    <div>
      <PageHeader
        title={t('stock.title')}
        description={t('stock.description')}
        actions={
          <>
            <Button
              variant="outline"
              leftIcon={<Download />}
              loading={exporting}
              onClick={() => void exportCsv()}
              aria-label={t('common:actions.export_csv')}
            >
              <span className="hidden sm:inline">{t('common:actions.export_csv')}</span>
            </Button>
            {access.adjust ? (
              <>
                <Button asChild variant="outline" leftIcon={<SlidersHorizontal />}>
                  <Link to="/inventory/adjustments/new">{t('stock.new_adjustment')}</Link>
                </Button>
                <Button leftIcon={<PackagePlus />} onClick={() => setState({ opening: '1' })}>
                  {t('stock.opening_stock')}
                  <Kbd
                    aria-hidden
                    combo="alt+o"
                    className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
                  />
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <TotalsBar
        loading={!totals}
        items={totals?.item_count ?? 0}
        valueCost={totals?.value_cost_paise ?? 0}
        valueMrp={totals?.value_mrp_paise ?? 0}
        low={counts?.low_stock ?? totals?.low_stock_count ?? 0}
        out={
          (counts?.out_of_stock ?? totals?.out_of_stock_count ?? 0) +
          (counts?.negative ?? totals?.negative_count ?? 0)
        }
        onLow={() => setState({ filter: 'low' })}
        onOut={() => setState({ filter: 'out' })}
      />

      {access.batches && counts && counts.expired + counts.expiring > 0 ? (
        <Link
          to={batchesPagePath({
            ...(singleStore ? { store_id: singleStore } : {}),
            tab:
              counts.expired > 0
                ? 'expired'
                : batchExpiryTabFor(alerts.data?.data.expiry_warning_days ?? warningDays),
          })}
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground hover:border-warning"
        >
          <CalendarClock className="size-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 basis-48">
            {counts.expired > 0 ? t('stock.expired_alert', { count: counts.expired }) + ' ' : ''}
            {counts.expiring > 0
              ? t('stock.expiring_alert', {
                  count: counts.expiring,
                  days: alerts.data?.data.expiry_warning_days ?? 90,
                })
              : ''}
          </span>
          <span className="shrink-0 font-semibold underline-offset-4 hover:underline">
            {t('stock.view_batches')}
          </span>
        </Link>
      ) : null}

      <div className="flex flex-col gap-3 pb-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,22rem)_14rem_14rem_auto]">
          <SearchInput
            ref={searchRef}
            value={state.q}
            onChange={(q) => setState({ q })}
            placeholder={t('stock.search_placeholder')}
          />
          <StorePicker
            aria-label={t('common:fields.store')}
            value={storeScope}
            onChange={(id) => setState({ store: id ?? '' })}
            allowAll
            clearable={false}
          />
          {canCatalog ? (
            <CategoryPicker
              aria-label={t('stock.category')}
              placeholder={t('stock.all_categories')}
              value={state.category || null}
              onChange={(id) => setState({ category: id ?? '' })}
            />
          ) : null}
          {access.batches ? (
            <Select
              aria-label={t('stock.group_label')}
              value={group}
              onValueChange={(v) => setState({ group: v, sort: 'name' })}
              options={[
                { value: 'product', label: t('stock.group_product') },
                { value: 'batch', label: t('stock.group_batch') },
              ]}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FilterChips
            chips={chips}
            value={filter}
            onChange={(f) => setState({ filter: f })}
            label={t('stock.filters_label')}
          />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X />}
              onClick={() => setState({ q: '', filter: 'all', category: '' })}
            >
              {t('common:actions.clear_filters')}
            </Button>
          ) : null}
        </div>
      </div>

      {selected.size > 0 ? (
        <div
          role="region"
          aria-label={t('stock.selection_label')}
          className="sticky top-16 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary-soft px-3 py-2 text-sm shadow-card"
        >
          <span className="me-auto font-medium text-primary-soft-foreground">
            {t('stock.selected', { count: selectedProducts.length })}
          </span>
          {access.purchases ? (
            <Button asChild size="sm" leftIcon={<ShoppingBag />}>
              <Link
                to={reorderPrefillPath({
                  product_ids: selectedProducts,
                  ...(singleStore ? { store_id: singleStore } : {}),
                })}
              >
                {t('stock.action_reorder')}
              </Link>
            </Button>
          ) : null}
          {access.adjust ? (
            <Button asChild size="sm" variant="outline" leftIcon={<SlidersHorizontal />}>
              <Link
                to={adjustmentPrefillPath({
                  kind: 'adjustment',
                  product_ids: selectedProducts,
                  ...(singleStore ? { store_id: singleStore } : {}),
                })}
              >
                {t('stock.action_adjust')}
              </Link>
            </Button>
          ) : null}
          {access.transfer ? (
            <Button asChild size="sm" variant="outline" leftIcon={<ArrowLeftRight />}>
              <Link
                to={transferPrefillPath({
                  product_ids: selectedProducts,
                  ...(singleStore ? { from_store_id: singleStore } : {}),
                })}
              >
                {t('stock.action_transfer')}
              </Link>
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" leftIcon={<X />} onClick={() => setSelected(new Set())}>
            {t('common:actions.clear')}
          </Button>
        </div>
      ) : null}

      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<Boxes />}
            title={t('stock.empty_title')}
            description={t('stock.empty_description')}
            action={
              <>
                {access.adjust ? (
                  <Button leftIcon={<PackagePlus />} onClick={() => setState({ opening: '1' })}>
                    {t('stock.empty_opening')}
                  </Button>
                ) : null}
                {canCatalog ? (
                  <Button variant="outline" onClick={() => navigate('/catalog/products/new')}>
                    {t('stock.empty_add_products')}
                  </Button>
                ) : null}
              </>
            }
          />
        </div>
      ) : (
        <DataTable
          label={t('stock.title')}
          columns={columns}
          data={rows}
          getRowId={rowId}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(r) => setState({ product: r.product_id })}
          sort={sort}
          onSortChange={(s) => setState({ sort: s ?? 'name' })}
          selection={
            access.adjust || access.purchases || access.transfer
              ? { selected, onChange: setSelected }
              : undefined
          }
          pagination={
            page
              ? {
                  ...page,
                  pageSizeOptions: PAGE_SIZES,
                  onChange: ({ offset, limit }) => setState({ offset, limit }),
                }
              : undefined
          }
          renderCard={(r) => <StockCard row={r} language={i18n.language} />}
          empty={
            <EmptyState
              compact
              icon={<Boxes />}
              title={t('stock.none_title')}
              description={t('stock.none_hint')}
            />
          }
        />
      )}

      <StockDrawer
        productId={state.product || null}
        storeId={singleStore}
        onOpenChange={(open) => {
          if (!open) setState({ product: '' })
        }}
      />
      {access.adjust ? (
        <OpeningStockDialog
          open={state.opening === '1'}
          onOpenChange={(open) => setState({ opening: open ? '1' : '' })}
          defaultStoreId={singleStore ?? defaultStore}
        />
      ) : null}
    </div>
  )
}

function TotalsBar({
  loading,
  items,
  valueCost,
  valueMrp,
  low,
  out,
  onLow,
  onOut,
}: {
  loading: boolean
  items: number
  valueCost: number
  valueMrp: number
  low: number
  out: number
  onLow: () => void
  onOut: () => void
}) {
  const { t } = useTranslation('inventory')
  const tile = 'rounded-xl border border-border bg-surface px-4 py-3 shadow-card'
  const value = (node: ReactNode) =>
    loading ? (
      <Skeleton className="mt-1 h-6 w-24" />
    ) : (
      <div className="mt-0.5 text-lg font-bold tabular-nums sm:text-xl">{node}</div>
    )
  return (
    <section
      aria-label={t('stock.totals_label')}
      className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-5"
    >
      <div className={tile}>
        <div className="text-xs font-medium text-muted-foreground">{t('stock.total_items')}</div>
        {value(items.toLocaleString('en-IN'))}
      </div>
      <div className={tile}>
        <div className="text-xs font-medium text-muted-foreground">
          {t('stock.total_value_cost')}
        </div>
        {value(<Money paise={valueCost} />)}
      </div>
      <div className={tile}>
        <div className="text-xs font-medium text-muted-foreground">
          {t('stock.total_value_mrp')}
        </div>
        {value(<Money paise={valueMrp} />)}
      </div>
      <button type="button" onClick={onLow} className={cn(tile, 'text-start hover:border-warning')}>
        <div className="text-xs font-medium text-muted-foreground">{t('stock.total_low')}</div>
        {value(<span className={low > 0 ? 'text-warning' : undefined}>{low}</span>)}
      </button>
      <button
        type="button"
        onClick={onOut}
        className={cn(tile, 'col-span-2 text-start hover:border-danger lg:col-span-1')}
      >
        <div className="text-xs font-medium text-muted-foreground">{t('stock.total_out')}</div>
        {value(<span className={out > 0 ? 'text-danger' : undefined}>{out}</span>)}
      </button>
    </section>
  )
}

function StockCard({ row: r, language }: { row: StockRow; language: string }) {
  const { t } = useTranslation('inventory')
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <ProductName
        name={r.name}
        nameTa={r.name_ta}
        sku={r.sku}
        extra={[r.batch_no ? `${t('lines.batch')} ${r.batch_no}` : null]}
        wrap
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Qty
          milli={r.qty_milli}
          unit={r.unit}
          packSize={r.pack_size}
          packUnit={packUnitFor(r.unit)}
          colorize
          className="text-base font-bold"
        />
        <StockStatusBadge status={r.status} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t('stock.col_value_cost')}:{' '}
          <Money paise={r.value_cost_paise} className="text-foreground" />
          {r.value_mrp_paise !== null ? (
            <>
              {' · '}
              {t('stock.mrp')} <Money paise={r.value_mrp_paise} />
            </>
          ) : null}
        </span>
        {r.reorder_level_milli !== null ? (
          <span title={pickLabel(STOCK_STATUS_LABELS[r.status], language)}>
            {t('stock.col_reorder')}:{' '}
            <Qty
              milli={r.reorder_level_milli}
              unit={r.unit}
              packSize={r.pack_size}
              packUnit={packUnitFor(r.unit)}
            />
          </span>
        ) : null}
      </div>
    </div>
  )
}
