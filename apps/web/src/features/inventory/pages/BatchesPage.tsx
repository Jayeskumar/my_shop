/**
 * Batches & expiry (/inventory/batches): batches with stock by expiry window — Expired, within
 * 30 / 60 / 90 days, or all — with quantity, value at cost and MRP, colour-coded expiry.
 * Actions: write off (opens an expiry write-off draft prefilled with the batches), return to the
 * supplier (opens /purchases/returns/new?store_id=&supplier_id=&batch_ids=… — the purchases
 * module reads it with parseInventoryPrefill) and edit the batch's MRP / prices / dates.
 */
import {
  type BatchListQuery,
  type BatchRow,
  adjustmentPrefillPath,
  inventoryRoutes,
  purchaseReturnPrefillPath,
} from '@kadai/shared/api/inventory'
import { keepPreviousData } from '@tanstack/react-query'
import { CalendarCheck2, MoreVertical, PackageMinus, Pencil, Undo2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Button,
  DataTable,
  type DataTableColumn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Money,
  PageHeader,
  Qty,
  SearchInput,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { BatchEditDialog } from '../components/BatchEditDialog'
import { ProductName } from '../components/ProductName'
import { ExpiryBadge } from '../components/StockBadge'
import { useDefaultStoreId, useInventoryAccess } from '../lib/access'
import { packUnitFor } from '../lib/labels'
import { PAGE_SIZES, useUrlState } from '../lib/url-state'

const TABS = ['expired', 'd30', 'd60', 'd90', 'all'] as const
type BatchTab = (typeof TABS)[number]
const SORTS = ['expiry_date', 'product_name', 'qty', 'created_at'] as const

function tabQuery(tab: BatchTab): Partial<BatchListQuery> {
  switch (tab) {
    case 'expired':
      return { expired: true }
    case 'd30':
      return { expiring_within_days: 30 }
    case 'd60':
      return { expiring_within_days: 60 }
    case 'd90':
      return { expiring_within_days: 90 }
    case 'all':
      return {}
  }
}

/** Text colour of an expiry date: red expired, amber ≤ 30 days, yellow ≤ 90 days. */
function expiryClass(days: number | null): string | undefined {
  if (days === null) return undefined
  if (days < 0) return 'text-danger font-semibold'
  if (days <= 30) return 'text-warning font-semibold'
  if (days <= 90) return 'text-warning'
  return undefined
}

export default function BatchesPage() {
  const { t } = useTranslation(['inventory', 'common'])
  const navigate = useNavigate()
  const access = useInventoryAccess()
  const canSuppliers = useCan('suppliers.read')
  const defaultStore = useDefaultStoreId()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<BatchRow | null>(null)
  const [state, setState] = useUrlState({
    tab: 'd90',
    store: '',
    q: '',
    supplier: '',
    sort: 'expiry_date',
  })
  const tab: BatchTab = (TABS as readonly string[]).includes(state.tab)
    ? (state.tab as BatchTab)
    : 'd90'
  const sort = SORTS.includes(state.sort.replace(/^-/, '') as (typeof SORTS)[number])
    ? state.sort
    : 'expiry_date'
  const query: BatchListQuery = {
    limit: state.limit,
    offset: state.offset,
    sort,
    with_stock_only: true,
    ...tabQuery(tab),
    ...(state.store ? { store_id: state.store } : {}),
    ...(state.q ? { q: state.q } : {}),
    ...(state.supplier ? { supplier_id: state.supplier } : {}),
  }
  const list = useRouteQuery(
    inventoryRoutes.listBatches,
    { query },
    { placeholderData: keepPreviousData },
  )
  const alerts = useRouteQuery(
    inventoryRoutes.stockAlerts,
    { query: { ...(state.store ? { store_id: state.store } : {}), limit: 1 } },
    { meta: { errorToast: false } },
  )
  const counts = alerts.data?.data.counts
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const selectedRows = rows.filter((r) => selected.has(r.id))
  const actionStore = state.store || defaultStore || undefined

  const writeOffPath = (batches: readonly BatchRow[]): string =>
    adjustmentPrefillPath({
      kind: 'expiry_writeoff',
      ...(actionStore ? { store_id: actionStore } : {}),
      batch_ids: batches.map((b) => b.id),
      product_ids: [...new Set(batches.map((b) => b.product_id))],
    })

  const returnPath = (batches: readonly BatchRow[]): string => {
    const suppliers = new Set(batches.map((b) => b.supplier_id).filter(Boolean))
    const supplierId = suppliers.size === 1 ? [...suppliers][0]! : undefined
    return purchaseReturnPrefillPath({
      batch_ids: batches.map((b) => b.id),
      ...(actionStore ? { store_id: actionStore } : {}),
      ...(supplierId ? { supplier_id: supplierId } : {}),
    })
  }

  const columns = useMemo<DataTableColumn<BatchRow>[]>(
    () => [
      {
        id: 'product_name',
        header: t('batches.col_product'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <ProductName
            name={row.original.product_name}
            nameTa={row.original.product_name_ta}
            sku={row.original.sku}
          />
        ),
      },
      {
        id: 'batch',
        header: t('batches.col_batch'),
        enableSorting: false,
        meta: { mobile: 'subtitle', label: t('batches.col_batch') },
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <span className="font-medium tabular-nums">{row.original.batch_no}</span>
            {row.original.supplier_name ? (
              <span className="truncate text-xs text-muted-foreground">
                {row.original.supplier_name}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'expiry_date',
        header: t('batches.col_expiry'),
        enableSorting: true,
        meta: { label: t('batches.col_expiry') },
        cell: ({ row }) => (
          // Auto-sized grid track (not grid-cols-1 = minmax(0, 1fr)) so the table column is at
          // least as wide as the badge.
          <div className="grid justify-items-start gap-1">
            <span
              className={cn(
                'whitespace-nowrap tabular-nums',
                expiryClass(row.original.days_to_expiry),
              )}
            >
              {row.original.expiry_date ? formatDate(row.original.expiry_date) : '—'}
            </span>
            <ExpiryBadge
              expiryDate={row.original.expiry_date}
              status={row.original.expiry_status}
              daysToExpiry={row.original.days_to_expiry}
            />
          </div>
        ),
      },
      {
        id: 'qty',
        header: t('batches.col_qty'),
        enableSorting: true,
        meta: { align: 'right', label: t('batches.col_qty') },
        cell: ({ row }) => (
          <Qty
            milli={row.original.qty_milli}
            unit={row.original.unit}
            packSize={row.original.pack_size}
            packUnit={packUnitFor(row.original.unit)}
            colorize
            className="font-semibold"
          />
        ),
      },
      {
        id: 'value',
        header: t('batches.col_value'),
        enableSorting: false,
        meta: { align: 'right', label: t('batches.col_value') },
        cell: ({ row }) => <Money paise={row.original.value_cost_paise} />,
      },
      {
        id: 'mrp',
        header: t('batches.col_mrp'),
        enableSorting: false,
        meta: { align: 'right', label: t('batches.col_mrp') },
        cell: ({ row }) => <Money paise={row.original.mrp_paise} />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common:actions.more')}</span>,
        enableSorting: false,
        meta: { align: 'right', mobile: 'hidden', className: 'w-12' },
        cell: ({ row }) => (
          <RowActions
            batch={row.original}
            canEdit={access.editBatchPrices}
            writeOffTo={access.adjust ? writeOffPath([row.original]) : null}
            returnTo={access.purchases ? returnPath([row.original]) : null}
            onEdit={() => setEditing(row.original)}
          />
        ),
      },
    ],
    // writeOffPath / returnPath depend on the action store only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, access, actionStore],
  )

  const tabCount = (key: BatchTab): number | null => {
    if (!counts) return null
    if (key === 'expired') return counts.expired
    if (key === 'd90' && (alerts.data?.data.expiry_warning_days ?? 0) === 90) return counts.expiring
    return null
  }

  return (
    <div>
      <PageHeader title={t('batches.title')} description={t('batches.description')} />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setSelected(new Set())
          setState({ tab: v })
        }}
        className="gap-3 pb-3"
      >
        <TabsList aria-label={t('batches.tabs_label')}>
          {TABS.map((key) => {
            const count = tabCount(key)
            return (
              <TabsTrigger
                key={key}
                value={key}
                className={key === 'expired' ? 'data-[state=inactive]:text-danger' : undefined}
              >
                {t(`batches.tab_${key}`)}
                {count !== null && count > 0 ? (
                  <span className="rounded-full bg-surface-2 px-1.5 text-xs tabular-nums">
                    {count}
                  </span>
                ) : null}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 gap-2 pb-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,22rem)_14rem_16rem_auto]">
        <SearchInput
          value={state.q}
          onChange={(q) => setState({ q })}
          placeholder={t('batches.search_placeholder')}
        />
        <StorePicker
          aria-label={t('common:fields.store')}
          placeholder={t('common:misc.all_stores')}
          value={state.store || null}
          onChange={(id) => setState({ store: id ?? '' })}
        />
        {canSuppliers ? (
          <SupplierPicker
            aria-label={t('batches.supplier')}
            placeholder={t('batches.all_suppliers')}
            value={
              state.supplier
                ? rows.find((r) => r.supplier_id === state.supplier)?.supplier_name
                  ? {
                      id: state.supplier,
                      name: rows.find((r) => r.supplier_id === state.supplier)!.supplier_name!,
                    }
                  : { id: state.supplier, name: '…' }
                : null
            }
            onChange={(s) => setState({ supplier: s?.id ?? '' })}
          />
        ) : null}
        {state.q || state.store || state.supplier ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<X />}
            className="justify-self-start self-center"
            onClick={() => setState({ q: '', store: '', supplier: '' })}
          >
            {t('common:actions.clear_filters')}
          </Button>
        ) : null}
      </div>

      {selectedRows.length > 0 ? (
        <div
          role="region"
          aria-label={t('batches.selection_label')}
          className="sticky top-16 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary-soft px-3 py-2 text-sm shadow-card"
        >
          <span className="me-auto font-medium text-primary-soft-foreground">
            {t('batches.selected', { count: selectedRows.length })}{' '}
            <Money paise={selectedRows.reduce((s, b) => s + b.value_cost_paise, 0)} />
          </span>
          {access.adjust ? (
            <Button asChild size="sm" variant="danger" leftIcon={<PackageMinus />}>
              <Link to={writeOffPath(selectedRows)}>{t('batches.write_off')}</Link>
            </Button>
          ) : null}
          {access.purchases ? (
            <Button asChild size="sm" variant="outline" leftIcon={<Undo2 />}>
              <Link to={returnPath(selectedRows)}>{t('batches.return_supplier')}</Link>
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" leftIcon={<X />} onClick={() => setSelected(new Set())}>
            {t('common:actions.clear')}
          </Button>
        </div>
      ) : null}

      <DataTable
        label={t('batches.title')}
        columns={columns}
        data={rows}
        getRowId={(b) => b.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={sort}
        onSortChange={(s) => setState({ sort: s ?? 'expiry_date' })}
        onRowClick={access.editBatchPrices ? (b) => setEditing(b) : undefined}
        selection={
          access.adjust || access.purchases ? { selected, onChange: setSelected } : undefined
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
        empty={
          <EmptyState
            compact
            icon={<CalendarCheck2 />}
            title={t(`batches.none_${tab}`)}
            description={tab === 'all' ? t('batches.none_all_hint') : t('batches.none_hint')}
            action={
              tab !== 'all' ? (
                <Button variant="outline" size="sm" onClick={() => setState({ tab: 'all' })}>
                  {t('batches.show_all')}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => navigate('/inventory/stock')}>
                  {t('batches.go_stock')}
                </Button>
              )
            }
          />
        }
      />

      <BatchEditDialog batch={editing} onOpenChange={(open) => !open && setEditing(null)} />
    </div>
  )
}

function RowActions({
  batch,
  canEdit,
  writeOffTo,
  returnTo,
  onEdit,
}: {
  batch: BatchRow
  canEdit: boolean
  writeOffTo: string | null
  returnTo: string | null
  onEdit: () => void
}) {
  const { t } = useTranslation(['inventory', 'common'])
  const navigate = useNavigate()
  if (!canEdit && !writeOffTo && !returnTo) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          icon={<MoreVertical />}
          label={t('batches.actions_for', { batch: batch.batch_no })}
          variant="ghost"
          size="sm"
          onClick={(e) => e.stopPropagation()}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {canEdit ? (
          <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
            {t('batches.edit')}
          </DropdownMenuItem>
        ) : null}
        {writeOffTo ? (
          <DropdownMenuItem
            icon={<PackageMinus />}
            tone="danger"
            onSelect={() => navigate(writeOffTo)}
          >
            {t('batches.write_off')}
          </DropdownMenuItem>
        ) : null}
        {returnTo ? (
          <DropdownMenuItem icon={<Undo2 />} onSelect={() => navigate(returnTo)}>
            {t('batches.return_supplier')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
