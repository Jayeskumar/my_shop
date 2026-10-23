/**
 * Products list (GET /products): search that also takes a scanned barcode (Enter on a code →
 * GET /products/lookup → open the product), filters in the URL (category incl. sub-categories,
 * brand, kind, status, low stock), server sort & pagination, stock for the current store, bulk
 * select → bulk update / print labels, CSV export and import.
 */
import {
  type ProductListItem,
  type ProductListQuery,
  PRODUCT_KIND_LABELS,
  catalogRoutes,
} from '@kadai/shared/api/catalog'
import { ProductKindSchema, type ProductKind } from '@kadai/shared/enums'
import { keepPreviousData } from '@tanstack/react-query'
import {
  Barcode,
  Download,
  FileUp,
  Layers,
  PackagePlus,
  Pencil,
  ScanBarcode,
  SlidersHorizontal,
  Store,
  X,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { BrandPicker, CategoryPicker, isCodeLike } from '@/components/pickers'
import {
  Badge,
  Button,
  type DataTableColumn,
  DataTable,
  EmptyState,
  Money,
  PageHeader,
  Qty,
  SearchInput,
  Select,
  Switch,
  notify,
} from '@/components/ui'
import { callRoute, downloadRoute, isApiError } from '@/lib/api'
import { useCan, useCurrentStore, useFeature, useMe } from '@/lib/auth'
import { useHotkeys } from '@/lib/hotkeys'
import { cn } from '@/lib/cn'
import { localizedName } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'
import { BulkUpdateDialog } from '../components/BulkUpdateDialog'
import { LinkButton } from '../components/LinkButton'
import { ProductThumb } from '../components/ProductThumb'
import { bilingual, gstLabel, packUnitFor } from '../lib/format'

type StatusFilter = 'active' | 'inactive' | 'all'
const PAGE_SIZE = 50
const ALL = '__all'

function parseKind(v: string | null): ProductKind | undefined {
  const parsed = ProductKindSchema.safeParse(v)
  return parsed.success ? parsed.data : undefined
}

export default function ProductsPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const store = useCurrentStore()
  const businessType = useMe()?.tenant.business_type
  const canWrite = useCan('catalog.write')
  const hasLabels = useFeature('barcode_labels')
  const hasStorePricing = useFeature('store_pricing')
  const searchRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [notFoundCode, setNotFoundCode] = useState<string | null>(null)
  /** Phones: the filters fold away under a button (always shown from sm up). */
  const [filtersOpen, setFiltersOpen] = useState(false)

  const q = params.get('q') ?? ''
  const categoryId = params.get('category_id')
  const brandId = params.get('brand_id')
  const brandName = params.get('brand_name') ?? ''
  const kind = parseKind(params.get('kind'))
  const status = (params.get('status') as StatusFilter | null) ?? 'active'
  const lowStock = params.get('low_stock') === '1'
  const sort = params.get('sort') ?? 'name'
  const offset = Number(params.get('offset') ?? 0) || 0
  const limit = Number(params.get('limit') ?? PAGE_SIZE) || PAGE_SIZE

  const update = (patch: Record<string, string | null>, keepOffset = false): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k)
          else next.set(k, v)
        }
        if (!keepOffset) next.delete('offset')
        return next
      },
      { replace: true },
    )
  }

  const filters = useMemo<Omit<ProductListQuery, 'limit' | 'offset' | 'sort'>>(
    () => ({
      ...(q ? { q } : {}),
      ...(categoryId ? { category_id: categoryId } : {}),
      ...(brandId ? { brand_id: brandId } : {}),
      ...(kind ? { kind } : {}),
      ...(status === 'all' ? {} : { is_active: status === 'active' }),
      ...(lowStock ? { low_stock: true } : {}),
      ...(store ? { store_id: store.id } : {}),
      hide_variants: kind === 'variant' ? false : true,
    }),
    [q, categoryId, brandId, kind, status, lowStock, store],
  )

  const list = useRouteQuery(
    catalogRoutes.listProducts,
    { query: { ...filters, sort, limit, offset } },
    { placeholderData: keepPreviousData },
  )
  const rows = list.data?.data ?? []
  // List rows carry the English category name; Tamil names come from the cached category list.
  const categories = useRouteQuery(
    catalogRoutes.listCategories,
    { query: { flat: true } },
    { staleTime: 5 * 60_000 },
  )
  const categoryNamesTa = useMemo(
    () => new Map((categories.data?.data ?? []).map((c) => [c.id, c.name_ta])),
    [categories.data],
  )
  const page = list.data?.page
  const hasFilters = Boolean(q || categoryId || brandId || kind || status !== 'active' || lowStock)
  const filterCount = [categoryId, brandId, kind, status !== 'active', lowStock].filter(
    Boolean,
  ).length
  const firstRun = !hasFilters && page?.total === 0 && !list.isFetching

  useHotkeys({ '/': () => searchRef.current?.focus() })
  useHotkeys({ 'alt+n': () => canWrite && void navigate('/catalog/products/new') })

  const lookup = async (code: string): Promise<void> => {
    try {
      const hit = await callRoute(catalogRoutes.lookupProduct, {
        query: { code, ...(store ? { store_id: store.id } : {}) },
      })
      setNotFoundCode(null)
      void navigate(`/catalog/products/${hit.data.product.id}`)
    } catch (error) {
      if (isApiError(error) && error.status === 404) setNotFoundCode(code)
      else notify.error(error)
    }
  }

  const exportCsv = (): void => {
    void notify.promise(
      downloadRoute(catalogRoutes.exportProducts, {
        query: { ...filters, format: 'csv' },
        filename: 'kadai-products.csv',
      }),
      { loading: t('products.exporting'), success: t('products.exported') },
    )
  }

  const columns = useMemo<DataTableColumn<ProductListItem>[]>(
    () => [
      {
        id: 'name',
        header: t('products.col_product'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => {
          const p = row.original
          const primary = localizedName(p.name, p.name_ta)
          const secondary = primary === p.name ? p.name_ta : p.name
          return (
            <div className="flex min-w-0 items-center gap-3">
              <ProductThumb fileId={p.image_file_id} name={p.name} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{primary}</span>
                  {p.kind === 'variant_parent' ? (
                    <Badge tone="info" size="sm" icon={<Layers />}>
                      {t('products.variants_count', { count: p.variant_count })}
                    </Badge>
                  ) : null}
                  {p.kind === 'service' ? (
                    <Badge tone="neutral" size="sm">
                      {bilingual(PRODUCT_KIND_LABELS.service)}
                    </Badge>
                  ) : null}
                  {!p.is_active ? (
                    <Badge tone="neutral" size="sm" appearance="outline">
                      {t('common:status.inactive')}
                    </Badge>
                  ) : null}
                </div>
                {secondary ? (
                  <div className="truncate text-xs text-muted-foreground">{secondary}</div>
                ) : null}
              </div>
            </div>
          )
        },
      },
      {
        id: 'sku',
        header: t('products.col_code'),
        enableSorting: true,
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <div className="grid grid-cols-1 font-mono text-xs leading-relaxed">
            <span>{row.original.sku ?? '—'}</span>
            {row.original.primary_barcode ? (
              <span className="text-muted-foreground">{row.original.primary_barcode}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'category',
        header: t('products.col_category'),
        enableSorting: false,
        cell: ({ row }) => (
          <span
            className="line-clamp-2 text-sm text-muted-foreground"
            title={row.original.category_path ?? undefined}
          >
            {row.original.category_name
              ? localizedName(
                  row.original.category_name,
                  row.original.category_id ? categoryNamesTa.get(row.original.category_id) : null,
                )
              : '—'}
          </span>
        ),
      },
      {
        id: 'sale_price',
        header: t('products.col_price'),
        enableSorting: true,
        meta: { align: 'right' },
        cell: ({ row }) => {
          const p = row.original
          return (
            <div className="grid grid-cols-1 justify-items-end tabular-nums">
              <Money paise={p.sale_price_paise} className="font-semibold" />
              {p.mrp_paise !== null && p.mrp_paise > p.sale_price_paise ? (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {t('products.mrp_short')} <Money paise={p.mrp_paise} className="line-through" />
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'gst',
        header: t('products.col_gst'),
        enableSorting: false,
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.tax_slab_rule_id ? (
            <Badge tone="accent" size="sm">
              {t('tax.by_price')}
            </Badge>
          ) : (
            <span className="tabular-nums">{gstLabel(row.original.gst_rate_bp)}</span>
          ),
      },
      {
        id: 'stock',
        header: t('products.col_stock'),
        enableSorting: false,
        meta: { align: 'right' },
        cell: ({ row }) => {
          const p = row.original
          if (!p.track_inventory || p.stock_qty_milli === null)
            return <span className="text-muted-foreground">—</span>
          return (
            <span className="inline-flex flex-col items-end gap-0.5 whitespace-nowrap">
              <span
                className={
                  p.stock_qty_milli <= 0
                    ? 'font-semibold text-danger'
                    : p.low_stock
                      ? 'font-semibold text-warning-soft-foreground'
                      : ''
                }
              >
                <Qty
                  milli={p.stock_qty_milli}
                  unit={p.unit}
                  packSize={p.pack_size}
                  packUnit={packUnitFor(businessType, p.unit)}
                />
              </span>
              {p.low_stock ? (
                <Badge tone="warning" size="sm">
                  {t('products.low_stock')}
                </Badge>
              ) : null}
            </span>
          )
        },
      },
    ],
    [t, businessType, categoryNamesTa],
  )

  const selectedRows = rows.filter((r) => selected.has(r.id))

  return (
    <div>
      <PageHeader
        title={t('pages.products')}
        description={page ? t('products.count', { count: page.total }) : undefined}
        actions={
          <>
            {hasStorePricing && canWrite ? (
              <LinkButton to="/catalog/store-prices" icon={<Store />} variant="ghost" compact>
                {t('pages.store_prices')}
              </LinkButton>
            ) : null}
            <Button
              variant="outline"
              leftIcon={<Download />}
              onClick={exportCsv}
              aria-label={t('common:actions.export_csv')}
            >
              <span className="hidden sm:inline">{t('common:actions.export_csv')}</span>
            </Button>
            {canWrite ? (
              <>
                <LinkButton to="/catalog/import" icon={<FileUp />} variant="outline" compact>
                  {t('products.import')}
                </LinkButton>
                <LinkButton to="/catalog/products/new" icon={<PackagePlus />}>
                  {t('products.new')}
                </LinkButton>
              </>
            ) : null}
          </>
        }
      />

      <div className="flex flex-col gap-2 pb-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <SearchInput
              ref={searchRef}
              value={q}
              onChange={(v) => {
                setNotFoundCode(null)
                update({ q: v || null })
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const code = e.currentTarget.value.trim()
                if (isCodeLike(code)) void lookup(code)
              }}
              placeholder={t('products.search_placeholder')}
              wrapperClassName="min-w-0 flex-1 lg:max-w-xl"
              size="lg"
              autoComplete="off"
            />
            <Button
              variant={filterCount ? 'secondary' : 'outline'}
              size="lg"
              className="shrink-0 px-3 sm:hidden"
              leftIcon={<SlidersHorizontal />}
              aria-label={
                filterCount
                  ? `${t('common:actions.filters')} (${filterCount})`
                  : t('common:actions.filters')
              }
              aria-expanded={filtersOpen}
              aria-controls="catalog-product-filters"
              onClick={() => setFiltersOpen((o) => !o)}
            >
              {filterCount ? <span className="tabular-nums">{filterCount}</span> : null}
            </Button>
          </div>
          <div
            id="catalog-product-filters"
            className={cn(
              'grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center',
              !filtersOpen && 'max-sm:hidden',
            )}
          >
            <CategoryPicker
              value={categoryId}
              onChange={(id) => update({ category_id: id })}
              placeholder={t('products.filter_category')}
              aria-label={t('products.filter_category')}
              className="sm:w-56"
            />
            <BrandPicker
              value={brandId ? { id: brandId, name: brandName } : null}
              onChange={(b) => update({ brand_id: b?.id ?? null, brand_name: b?.name ?? null })}
              placeholder={t('products.filter_brand')}
              aria-label={t('products.filter_brand')}
              className="sm:w-48"
            />
            <Select
              value={kind ?? ALL}
              onValueChange={(v) => update({ kind: v === ALL ? null : v })}
              aria-label={t('products.filter_kind')}
              className="sm:w-52"
              options={[
                { value: ALL, label: t('products.all_kinds') },
                ...ProductKindSchema.options.map((k) => ({
                  value: k,
                  label: bilingual(PRODUCT_KIND_LABELS[k]),
                })),
              ]}
            />
            <Select<StatusFilter>
              value={status}
              onValueChange={(v) => update({ status: v === 'active' ? null : v })}
              aria-label={t('common:fields.status')}
              className="sm:w-44"
              options={[
                { value: 'active', label: t('products.status_active') },
                { value: 'inactive', label: t('products.status_inactive') },
                { value: 'all', label: t('products.status_all') },
              ]}
            />
            <div className="flex h-10 items-center rounded-md border border-border px-3">
              <Switch
                checked={lowStock}
                onCheckedChange={(v) => update({ low_stock: v ? '1' : null })}
                label={t('products.low_stock_only')}
                disabled={!store}
              />
            </div>
            {hasFilters ? (
              <Button
                variant="ghost"
                leftIcon={<X />}
                onClick={() => {
                  setNotFoundCode(null)
                  setParams(new URLSearchParams(), { replace: true })
                }}
              >
                {t('common:actions.clear_filters')}
              </Button>
            ) : null}
          </div>
        </div>
        {notFoundCode ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
            <ScanBarcode className="size-4" />
            <span>{t('products.code_not_found', { code: notFoundCode })}</span>
            {canWrite ? (
              <LinkButton
                to={`/catalog/products/new?barcode=${encodeURIComponent(notFoundCode)}`}
                variant="outline"
                size="sm"
                icon={<PackagePlus />}
              >
                {t('products.create_with_code')}
              </LinkButton>
            ) : null}
          </div>
        ) : null}
      </div>

      {selected.size > 0 ? (
        <div
          className="sticky top-16 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-sm text-primary-soft-foreground shadow-card"
          role="region"
          aria-label={t('products.selection')}
        >
          <span className="font-semibold">{t('products.selected', { count: selected.size })}</span>
          <div className="ms-auto flex flex-wrap gap-2">
            {canWrite ? (
              <Button size="sm" leftIcon={<Pencil />} onClick={() => setBulkOpen(true)}>
                {t('products.bulk_update')}
              </Button>
            ) : null}
            {hasLabels ? (
              <LinkButton
                to={`/catalog/labels?product_ids=${[...selected].join(',')}`}
                size="sm"
                variant="outline"
                icon={<Barcode />}
              >
                {t('products.print_labels')}
              </LinkButton>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('products.clear_selection')}
            </Button>
          </div>
        </div>
      ) : null}

      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<PackagePlus />}
            title={t('products.empty_title')}
            description={t('products.empty_description')}
            action={
              canWrite ? (
                <>
                  <LinkButton to="/catalog/products/new" icon={<PackagePlus />}>
                    {t('products.new')}
                  </LinkButton>
                  <LinkButton to="/catalog/import" variant="outline" icon={<FileUp />}>
                    {t('products.import_csv')}
                  </LinkButton>
                </>
              ) : undefined
            }
          >
            <p className="max-w-md text-xs text-muted-foreground">{t('products.empty_tip')}</p>
          </EmptyState>
        </div>
      ) : (
        <DataTable<ProductListItem>
          label={t('pages.products')}
          columns={columns}
          data={rows}
          getRowId={(p) => p.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(p) => void navigate(`/catalog/products/${p.id}`)}
          sort={sort}
          onSortChange={(s) => update({ sort: s && s !== 'name' ? s : null })}
          selection={canWrite || hasLabels ? { selected, onChange: setSelected } : undefined}
          pagination={
            page
              ? {
                  offset: page.offset,
                  limit: page.limit,
                  total: page.total,
                  onChange: (next) =>
                    update(
                      {
                        offset: next.offset ? String(next.offset) : null,
                        limit: next.limit === PAGE_SIZE ? null : String(next.limit),
                      },
                      true,
                    ),
                }
              : undefined
          }
          renderCard={(p) => <ProductCard product={p} />}
          empty={
            <EmptyState
              compact
              icon={<ScanBarcode />}
              title={t('products.no_match')}
              description={t('products.no_match_hint')}
            />
          }
        />
      )}

      {bulkOpen ? (
        <BulkUpdateDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          ids={[...selected]}
          rows={selectedRows}
          onDone={() => setSelected(new Set())}
        />
      ) : null}
    </div>
  )
}

function ProductCard({ product: p }: { product: ProductListItem }) {
  const { t } = useTranslation(['catalog', 'common'])
  const businessType = useMe()?.tenant.business_type
  const primary = localizedName(p.name, p.name_ta)
  return (
    <div
      className={cn(
        'grid items-start gap-3',
        p.image_file_id ? 'grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      {p.image_file_id ? <ProductThumb fileId={p.image_file_id} name={p.name} size="md" /> : null}
      <div className="min-w-0">
        <p className="line-clamp-2 break-words font-semibold leading-snug">{primary}</p>
        <p className="flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground">
          {p.sku || p.primary_barcode ? (
            <>
              {p.sku ? <span>{p.sku}</span> : null}
              {p.primary_barcode ? <span>{p.primary_barcode}</span> : null}
            </>
          ) : (
            '—'
          )}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          {p.kind === 'variant_parent' ? (
            <Badge tone="info" size="sm">
              {t('products.variants_count', { count: p.variant_count })}
            </Badge>
          ) : null}
          {!p.is_active ? (
            <Badge tone="neutral" size="sm" appearance="outline">
              {t('common:status.inactive')}
            </Badge>
          ) : null}
          <Badge tone="neutral" size="sm">
            {p.tax_slab_rule_id
              ? t('tax.by_price')
              : `${t('products.col_gst')} ${gstLabel(p.gst_rate_bp)}`}
          </Badge>
          {p.track_inventory && p.stock_qty_milli !== null ? (
            <Badge
              tone={p.stock_qty_milli <= 0 ? 'danger' : p.low_stock ? 'warning' : 'neutral'}
              size="sm"
            >
              <Qty
                milli={p.stock_qty_milli}
                unit={p.unit}
                packSize={p.pack_size}
                packUnit={packUnitFor(businessType, p.unit)}
              />
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 justify-items-end text-end">
        <Money paise={p.sale_price_paise} className="font-semibold" />
        {p.mrp_paise !== null && p.mrp_paise > p.sale_price_paise ? (
          <Money paise={p.mrp_paise} className="text-xs text-muted-foreground line-through" />
        ) : null}
      </div>
    </div>
  )
}
