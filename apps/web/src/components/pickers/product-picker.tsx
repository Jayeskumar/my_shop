/**
 * Product search for back-office forms (purchase bills, adjustments, transfers, labels, orders).
 * Debounced GET /products?q= ; Enter on a scanned / typed code does the exact lookup
 * GET /products/lookup (barcode → SKU → scale barcode) first; variant parents open their variants
 * (GET /products?parent_id=) instead of being picked. Shows the name in the UI language (the
 * other language below), SKU / barcode, price and — when known — stock in the store.
 * The POS uses the offline catalogue instead (lib/offline).
 */
import type { ProductListQuery } from '@kadai/shared/api/catalog'
import {
  type ProductListItem,
  type ProductLookupResult,
  catalogRoutes,
} from '@kadai/shared/api/catalog'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Combobox, Money, Qty } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { useCurrentStore } from '@/lib/auth'
import { PickerRow } from './picker-row'
import {
  PICKER_PAGE_SIZE,
  type PickerBaseProps,
  type PickerRef,
  bilingualNames,
  isCodeLike,
  joinParts,
  nullOn404,
} from './shared'

export type ProductPickerValue = PickerRef<ProductListItem>

/** How the product was picked: `lookup` is set for an exact code match (scan). */
export interface ProductPick {
  lookup?: ProductLookupResult
}

export interface ProductPickerProps extends PickerBaseProps {
  value: ProductPickerValue | null | undefined
  onChange: (product: ProductListItem | null, pick?: ProductPick) => void
  /** Store for stock and store prices: default the current store; null = none. */
  storeId?: string | null
  /** Extra list filters (category incl. descendants, brand, kind, batch-tracked, low stock). */
  filters?: Pick<
    ProductListQuery,
    'category_id' | 'brand_id' | 'kind' | 'track_batches' | 'low_stock'
  >
  /** Also offer inactive products (default false). */
  includeInactive?: boolean
  /** Pick a variant parent itself instead of opening its variants (default false). */
  allowVariantParent?: boolean
  /** Enter on a code-like query → exact lookup (default true). */
  lookupOnEnter?: boolean
  /** "Add “query”" row (e.g. open the quick product form). */
  onCreate?: (query: string) => void
}

type Row = { type: 'product'; product: ProductPickerValue } | { type: 'back' }

const BACK = '__back__'

function variantLabel(attributes: Record<string, string> | undefined): string | null {
  const values = Object.values(attributes ?? {})
  return values.length ? values.join(' / ') : null
}

export function ProductPicker({
  value,
  onChange,
  storeId,
  filters,
  includeInactive = false,
  allowVariantParent = false,
  lookupOnEnter = true,
  onCreate,
  placeholder,
  ...base
}: ProductPickerProps) {
  const { t } = useTranslation('common')
  const currentStore = useCurrentStore()
  const store = storeId === undefined ? currentStore?.id : (storeId ?? undefined)
  const [parent, setParent] = useState<ProductListItem | null>(null)
  const lookupRef = useRef<ProductLookupResult | null>(null)

  const baseQuery = useMemo<ProductListQuery>(
    () => ({
      limit: PICKER_PAGE_SIZE,
      ...(store ? { store_id: store } : {}),
      ...(includeInactive ? {} : { is_active: true }),
      ...filters,
    }),
    [store, includeInactive, filters],
  )

  const loadOptions = async (q: string, signal: AbortSignal): Promise<Row[]> => {
    const query: ProductListQuery = { ...baseQuery }
    if (q) query.q = q
    if (parent) query.parent_id = parent.id
    // Suggestions (no search yet): parents and plain products only; a search also finds variants.
    else if (!q) query.hide_variants = true
    const res = await callRoute(catalogRoutes.listProducts, { query, signal })
    const rows: Row[] = res.data.map((product) => ({ type: 'product', product }))
    return parent ? [{ type: 'back' }, ...rows] : rows
  }

  const resolveQuery = async (code: string, signal: AbortSignal): Promise<Row | null> => {
    const hit = await nullOn404(
      callRoute(catalogRoutes.lookupProduct, {
        query: { code, ...(store ? { store_id: store } : {}) },
        signal,
      }),
    )
    if (!hit) return null
    const list = await callRoute(catalogRoutes.listProducts, {
      query: { ids: [hit.data.product.id], limit: 1, ...(store ? { store_id: store } : {}) },
      signal,
    })
    const product = list.data[0]
    if (!product) return null
    lookupRef.current = hit.data
    return { type: 'product', product }
  }

  const selected: Row | null = value ? { type: 'product', product: value } : null

  return (
    <Combobox<Row>
      {...base}
      value={selected}
      onChange={(row) => {
        const product = row?.type === 'product' ? (row.product as ProductListItem) : null
        const lookup = lookupRef.current
        lookupRef.current = null
        setParent(null)
        onChange(product, lookup && lookup.product.id === product?.id ? { lookup } : undefined)
      }}
      onOpenChange={(open) => {
        if (!open) setParent(null)
      }}
      loadOptions={loadOptions}
      reloadKey={parent?.id ?? ''}
      onOptionSelect={(row) => {
        if (row.type === 'back') {
          setParent(null)
          return false
        }
        if (row.product.kind === 'variant_parent' && !allowVariantParent) {
          setParent(row.product as ProductListItem)
          return false
        }
        return true
      }}
      {...(lookupOnEnter
        ? {
            resolveQuery,
            shouldResolveQuery: isCodeLike,
            notFoundText: (code: string) => t('pickers.product.not_found', { code }),
          }
        : {})}
      header={
        parent ? (
          <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            {t('pickers.product.variants_of', {
              name: bilingualNames(parent.name, parent.name_ta).primary,
            })}
          </div>
        ) : null
      }
      getOptionValue={(row) => (row.type === 'back' ? BACK : row.product.id)}
      getOptionLabel={(row) =>
        row.type === 'back'
          ? t('pickers.product.back')
          : bilingualNames(row.product.name, row.product.name_ta).primary
      }
      renderValue={(row) => {
        if (row.type !== 'product') return null
        const names = bilingualNames(row.product.name, row.product.name_ta)
        const variant = variantLabel(row.product.variant_attributes)
        return variant && !names.primary.includes(variant)
          ? `${names.primary} (${variant})`
          : names.primary
      }}
      renderOption={(row) =>
        row.type === 'back' ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <ArrowLeft className="size-4" />
            {t('pickers.product.back')}
          </span>
        ) : (
          <ProductOption product={row.product as ProductListItem} />
        )
      }
      placeholder={placeholder ?? t('pickers.product.placeholder')}
      searchPlaceholder={t('pickers.product.search_placeholder')}
      onCreate={onCreate}
    />
  )
}

function ProductOption({ product }: { product: ProductListItem }) {
  const { t } = useTranslation('common')
  const names = bilingualNames(product.name, product.name_ta)
  const variant = variantLabel(product.variant_attributes)
  const isParent = product.kind === 'variant_parent'
  return (
    <PickerRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{names.primary}</span>
          {variant && !names.primary.includes(variant) ? (
            <Badge tone="neutral" size="sm">
              {variant}
            </Badge>
          ) : null}
          {!product.is_active ? (
            <Badge tone="neutral" appearance="outline" size="sm">
              {t('pickers.product.inactive')}
            </Badge>
          ) : null}
        </span>
      }
      subtitle={joinParts(names.secondary, product.sku, product.primary_barcode)}
      aside={
        isParent ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            {t('pickers.product.variants', { count: product.variant_count })}
            <ChevronRight className="size-4" />
          </span>
        ) : (
          <>
            <Money paise={product.sale_price_paise} className="font-medium" />
            {product.track_inventory && product.stock_qty_milli !== null ? (
              <span
                className={
                  product.stock_qty_milli <= 0
                    ? 'text-danger'
                    : product.low_stock
                      ? 'text-warning'
                      : 'text-muted-foreground'
                }
              >
                {t('pickers.product.stock')}{' '}
                <Qty milli={product.stock_qty_milli} unit={product.unit} />
              </span>
            ) : null}
          </>
        )
      }
    />
  )
}
