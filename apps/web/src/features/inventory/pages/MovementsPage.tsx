/**
 * Stock movements (/inventory/movements): the stock ledger — every sale, purchase, return,
 * adjustment, write-off and transfer with its signed quantity, the balance after it, the value
 * at cost and a link to the source document. Filters: store, product, movement types (several),
 * date range; CSV export of the filtered ledger. State is kept in the URL, so the stock panel's
 * "All movements" link opens the product's ledger directly.
 */
import { catalogRoutes } from '@kadai/shared/api/catalog'
import {
  MOVEMENT_TYPE_LABELS,
  type MovementListQuery,
  type MovementRow,
  inventoryRoutes,
} from '@kadai/shared/api/inventory'
import { type StockMovementType, StockMovementTypeSchema } from '@kadai/shared/enums'
import { keepPreviousData } from '@tanstack/react-query'
import { Download, History, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProductPicker, StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  Money,
  PageHeader,
  Qty,
  notify,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { formatDate, formatTime } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { FilterChips } from '../components/FilterChips'
import { DocumentLink, ProductName } from '../components/ProductName'
import { QtyChange } from '../components/StockBadge'
import { useToday } from '../lib/access'
import { movementTone, packUnitFor, pickLabel, reasonLabel } from '../lib/labels'
import { PAGE_SIZES, splitList, useUrlState } from '../lib/url-state'

const TYPES = StockMovementTypeSchema.options

export default function MovementsPage() {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const today = useToday()
  const canCatalog = useCan('catalog.read')
  const [exporting, setExporting] = useState(false)
  const [state, setState] = useUrlState({
    store: '',
    product: '',
    type: '',
    from: '',
    to: '',
    sort: '-created_at',
  })
  const types = splitList(state.type).filter((v): v is StockMovementType =>
    (TYPES as readonly string[]).includes(v),
  )
  const query: MovementListQuery = {
    limit: state.limit,
    offset: state.offset,
    sort: state.sort === 'created_at' ? 'created_at' : '-created_at',
    ...(state.store ? { store_id: state.store } : {}),
    ...(state.product ? { product_id: state.product } : {}),
    ...(types.length ? { type: types } : {}),
    ...(state.from ? { from: state.from } : {}),
    ...(state.to ? { to: state.to } : {}),
  }
  const list = useRouteQuery(
    inventoryRoutes.listMovements,
    { query },
    { placeholderData: keepPreviousData },
  )
  const productQuery = useRouteQuery(
    catalogRoutes.listProducts,
    { query: { ids: state.product ? [state.product] : [], limit: 1 } },
    { enabled: Boolean(state.product) && canCatalog, meta: { errorToast: false } },
  )
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const pickedProduct = productQuery.data?.data[0]
  const productValue = state.product
    ? (pickedProduct ?? {
        id: state.product,
        name: rows.find((r) => r.product_id === state.product)?.product_name ?? '…',
      })
    : null
  const filtered = Boolean(state.store || state.product || types.length || state.from || state.to)

  const exportCsv = async (): Promise<void> => {
    setExporting(true)
    try {
      const { limit: _l, offset: _o, ...rest } = query
      await downloadRoute(inventoryRoutes.listMovements, {
        query: { ...rest, format: 'csv' },
        filename: `stock-movements-${today}.csv`,
      })
      notify.success(t('movements.exported'))
    } catch (error) {
      notify.error(error)
    } finally {
      setExporting(false)
    }
  }

  const columns = useMemo<DataTableColumn<MovementRow>[]>(
    () => [
      {
        id: 'created_at',
        header: t('movements.col_date'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('movements.col_date') },
        cell: ({ row }) => (
          <div className="grid gap-0.5 whitespace-nowrap">
            <span className="tabular-nums">{formatDate(row.original.created_at)}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTime(row.original.created_at)} · {row.original.store_code}
            </span>
          </div>
        ),
      },
      {
        id: 'product',
        header: t('movements.col_product'),
        enableSorting: false,
        meta: { mobile: 'title', className: 'max-w-[16rem]' },
        cell: ({ row }) => (
          <ProductName
            name={row.original.product_name}
            nameTa={row.original.product_name_ta}
            sku={row.original.sku}
            extra={[row.original.batch_no ? `${t('lines.batch')} ${row.original.batch_no}` : null]}
          />
        ),
      },
      {
        id: 'type',
        header: t('movements.col_type'),
        enableSorting: false,
        meta: { label: t('movements.col_type') },
        cell: ({ row }) => (
          <Badge tone={movementTone(row.original.movement_type)} size="sm">
            {pickLabel(MOVEMENT_TYPE_LABELS[row.original.movement_type], i18n.language)}
          </Badge>
        ),
      },
      {
        id: 'qty',
        header: t('movements.col_qty'),
        enableSorting: false,
        meta: { align: 'right', label: t('movements.col_qty') },
        cell: ({ row }) => (
          <QtyChange
            milli={row.original.qty_milli}
            unit={row.original.unit}
            packSize={row.original.pack_size}
          />
        ),
      },
      {
        id: 'balance',
        header: t('movements.col_balance'),
        enableSorting: false,
        meta: { align: 'right', label: t('movements.col_balance') },
        cell: ({ row }) => (
          <Qty
            milli={row.original.balance_after_milli}
            unit={row.original.unit}
            packSize={row.original.pack_size}
            packUnit={packUnitFor(row.original.unit)}
            colorize
          />
        ),
      },
      {
        id: 'value',
        header: t('movements.col_value'),
        enableSorting: false,
        meta: { align: 'right', label: t('movements.col_value') },
        cell: ({ row }) => <Money paise={row.original.value_paise} colorize />,
      },
      {
        id: 'document',
        header: t('movements.col_document'),
        enableSorting: false,
        meta: { label: t('movements.col_document') },
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <DocumentLink
              refType={row.original.ref_type}
              refId={row.original.ref_id}
              number={row.original.ref_number}
            />
            {row.original.reason ? (
              <span className="text-xs text-muted-foreground">
                {reasonLabel(row.original.reason, i18n.language)}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'user',
        header: t('movements.col_user'),
        enableSorting: false,
        meta: {
          label: t('movements.col_user'),
          mobile: 'hidden',
          className: 'hidden 2xl:table-cell',
          headerClassName: 'hidden 2xl:table-cell',
        },
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-muted-foreground">
            {row.original.user_name ?? '—'}
          </span>
        ),
      },
    ],
    [t, i18n.language],
  )

  return (
    <div>
      <PageHeader
        title={t('movements.title')}
        description={t('movements.description')}
        actions={
          <Button
            variant="outline"
            leftIcon={<Download />}
            loading={exporting}
            onClick={() => void exportCsv()}
          >
            {t('common:actions.export_csv')}
          </Button>
        }
      />
      <div className="flex flex-col gap-3 pb-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,22rem)_14rem_auto]">
          <ProductPicker
            aria-label={t('movements.product_filter')}
            placeholder={t('movements.all_products')}
            value={productValue}
            storeId={null}
            onChange={(p) => setState({ product: p?.id ?? '' })}
          />
          <StorePicker
            aria-label={t('common:fields.store')}
            placeholder={t('common:misc.all_stores')}
            value={state.store || null}
            onChange={(id) => setState({ store: id ?? '' })}
          />
          <DateRangePicker
            value={state.from && state.to ? { from: state.from, to: state.to } : null}
            onChange={(r) => setState({ from: r.from, to: r.to })}
            presets={['today', 'yesterday', 'last_7_days', 'this_month', 'last_month', 'this_fy']}
            max={today}
            className="sm:w-auto"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FilterChips
            multiple
            chips={TYPES.map((type) => ({
              key: type,
              label: pickLabel(MOVEMENT_TYPE_LABELS[type], i18n.language),
            }))}
            value={types}
            onChange={(next) => setState({ type: next.join(',') })}
            label={t('movements.types_label')}
            className="min-w-0 flex-1 lg:flex-wrap lg:overflow-visible"
          />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X />}
              onClick={() => setState({ store: '', product: '', type: '', from: '', to: '' })}
            >
              {t('common:actions.clear_filters')}
            </Button>
          ) : null}
        </div>
      </div>
      <DataTable
        label={t('movements.title')}
        columns={columns}
        data={rows}
        getRowId={(m) => m.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={query.sort === 'created_at' ? 'created_at' : '-created_at'}
        onSortChange={(s) => setState({ sort: s ?? '-created_at' })}
        density="compact"
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
            icon={<History />}
            title={filtered ? t('movements.none_filtered') : t('movements.none_title')}
            description={t('movements.none_hint')}
          />
        }
      />
    </div>
  )
}
