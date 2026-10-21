/**
 * Stock of one product per store and batch (GET /stock/products/:productId), reusable by other
 * modules (product page, purchase bill line, POS stock check):
 *
 *   <StockByBatch productId={id} storeId={store?.id} />
 *
 * Pass `data` to render an already loaded ProductStock (the stock drawer does).
 */
import { type BatchStock, type ProductStock, inventoryRoutes } from '@kadai/shared/api/inventory'
import { Boxes } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState, Money, Qty, RetryButton, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { describeError } from '@/lib/errors'
import { useRouteQuery } from '@/lib/query'
import { packUnitFor } from '../lib/labels'
import { ExpiryBadge, StockStatusBadge } from './StockBadge'

export interface StockByBatchProps {
  productId: string
  /** One store; undefined = every store the member can access. */
  storeId?: string
  /** Already loaded data (skips the request). */
  data?: ProductStock
  className?: string
}

export function StockByBatch({ productId, storeId, data, className }: StockByBatchProps) {
  const { t } = useTranslation('inventory')
  const query = useRouteQuery(
    inventoryRoutes.productStock,
    { params: { productId }, query: storeId ? { store_id: storeId } : {} },
    { enabled: !data },
  )
  const stock = data ?? query.data?.data
  if (!stock) {
    if (query.error)
      return (
        <EmptyState
          compact
          title={describeError(query.error).title}
          action={<RetryButton onRetry={() => void query.refetch()} />}
        />
      )
    return (
      <div className={cn('grid gap-2', className)} aria-busy>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }
  const { product } = stock
  if (stock.stores.length === 0)
    return (
      <EmptyState
        compact
        icon={<Boxes />}
        title={t('by_batch.none_title')}
        description={t('by_batch.none_hint')}
        className={className}
      />
    )
  const packUnit = packUnitFor(product.unit)
  return (
    <div className={cn('grid gap-4', className)}>
      {stock.stores.map((s) => (
        <section
          key={s.store_id}
          aria-label={`${s.store_code} · ${s.store_name}`}
          className="grid grid-cols-1 gap-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {s.store_code} · {s.store_name}
              </span>
              <StockStatusBadge status={s.status} />
            </div>
            <div className="flex items-baseline gap-3 text-sm">
              <Qty
                milli={s.qty_milli}
                unit={product.unit}
                packSize={product.pack_size}
                packUnit={packUnit}
                colorize
                className="font-semibold"
              />
              <Money paise={s.value_cost_paise} className="text-muted-foreground" />
            </div>
          </div>
          {product.track_batches ? (
            <BatchList
              batches={s.batches}
              unit={product.unit}
              packSize={product.pack_size}
              packUnit={packUnit}
            />
          ) : null}
        </section>
      ))}
      {stock.stores.length > 1 ? (
        <div className="flex items-baseline justify-between border-t border-border pt-3 text-sm">
          <span className="font-medium">{t('by_batch.all_stores')}</span>
          <span className="flex items-baseline gap-3">
            <Qty
              milli={stock.total_qty_milli}
              unit={product.unit}
              packSize={product.pack_size}
              packUnit={packUnit}
              colorize
              className="font-semibold"
            />
            <Money paise={stock.total_value_cost_paise} className="text-muted-foreground" />
          </span>
        </div>
      ) : null}
    </div>
  )
}

function BatchList({
  batches,
  unit,
  packSize,
  packUnit,
}: {
  batches: BatchStock[]
  unit: string
  packSize: number
  packUnit: string
}) {
  const { t } = useTranslation('inventory')
  if (batches.length === 0)
    return <p className="text-sm text-muted-foreground">{t('by_batch.no_batches')}</p>
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {batches.map((b) => (
        <li
          key={b.batch_id ?? 'none'}
          className={cn(
            'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm',
            b.expiry_status === 'expired' && 'bg-danger-soft/40',
          )}
        >
          <div className="grid min-w-0 grid-cols-1 gap-0.5">
            <span className="truncate font-medium">{b.batch_no ?? t('by_batch.no_batch')}</span>
            <ExpiryBadge
              expiryDate={b.expiry_date}
              status={b.expiry_status}
              daysToExpiry={b.days_to_expiry}
              showDate
              className="text-xs text-muted-foreground"
            />
          </div>
          <div className="grid justify-items-end gap-0.5">
            <Qty
              milli={b.qty_milli}
              unit={unit}
              packSize={packSize}
              packUnit={packUnit}
              colorize
              className="font-medium"
            />
            {b.mrp_paise !== null ? (
              <span className="text-xs text-muted-foreground">
                {t('by_batch.mrp')} <Money paise={b.mrp_paise} />
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
