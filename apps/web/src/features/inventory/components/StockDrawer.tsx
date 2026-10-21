/**
 * Side panel of one product on the stock page: stock per store and batch, the last movements
 * and quick actions (adjust, transfer, reorder, all movements). The actions open prefilled
 * forms through the contract's prefill path builders.
 */
import {
  type MovementRow,
  MOVEMENT_TYPE_LABELS,
  adjustmentPrefillPath,
  inventoryRoutes,
  reorderPrefillPath,
  transferPrefillPath,
} from '@kadai/shared/api/inventory'
import { ArrowLeftRight, History, ShoppingBag, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, Drawer, EmptyState, Money, Qty, Skeleton } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { useInventoryAccess } from '../lib/access'
import { movementTone, packUnitFor, pickLabel, productNames } from '../lib/labels'
import { DocumentLink } from './ProductName'
import { QtyChange, StockStatusBadge } from './StockBadge'
import { StockByBatch } from './StockByBatch'

export interface StockDrawerProps {
  productId: string | null
  /** A single store, or undefined for every accessible store. */
  storeId?: string
  onOpenChange: (open: boolean) => void
}

export function StockDrawer({ productId, storeId, onOpenChange }: StockDrawerProps) {
  const { t, i18n } = useTranslation(['inventory', 'common'])
  const access = useInventoryAccess()
  const query = useRouteQuery(
    inventoryRoutes.productStock,
    { params: { productId: productId ?? '' }, query: storeId ? { store_id: storeId } : {} },
    { enabled: Boolean(productId) },
  )
  const stock = query.data?.data
  const names = stock
    ? productNames(stock.product.name, stock.product.name_ta, i18n.language)
    : null
  const productIds = productId ? [productId] : []
  const singleStatus = stock && stock.stores.length === 1 ? stock.stores[0]!.status : null

  return (
    <Drawer
      open={Boolean(productId)}
      onOpenChange={onOpenChange}
      title={names?.primary ?? t('stock.drawer_title')}
      description={
        stock
          ? [names?.secondary, stock.product.sku].filter(Boolean).join(' · ') || undefined
          : undefined
      }
      className="w-[min(32rem,100vw)]"
      footer={
        productId ? (
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:justify-end">
            {access.adjust ? (
              <Button asChild variant="outline" leftIcon={<SlidersHorizontal />}>
                <Link
                  to={adjustmentPrefillPath({
                    kind: 'adjustment',
                    product_ids: productIds,
                    ...(storeId ? { store_id: storeId } : {}),
                  })}
                >
                  {t('stock.action_adjust')}
                </Link>
              </Button>
            ) : null}
            {access.transfer ? (
              <Button asChild variant="outline" leftIcon={<ArrowLeftRight />}>
                <Link
                  to={transferPrefillPath({
                    product_ids: productIds,
                    ...(storeId ? { from_store_id: storeId } : {}),
                  })}
                >
                  {t('stock.action_transfer')}
                </Link>
              </Button>
            ) : null}
            {access.purchases ? (
              <Button asChild leftIcon={<ShoppingBag />}>
                <Link
                  to={reorderPrefillPath({
                    product_ids: productIds,
                    ...(storeId ? { store_id: storeId } : {}),
                  })}
                >
                  {t('stock.action_reorder')}
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {!stock ? (
        query.error ? (
          <EmptyState compact title={t('common:empty.no_results')} />
        ) : (
          <div className="grid grid-cols-1 gap-3" aria-busy>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 gap-6">
          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-surface-2 p-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">{t('stock.col_qty')}</dt>
              <dd className="flex flex-wrap items-center gap-2 text-lg font-bold">
                <QtyAbs
                  milli={stock.total_qty_milli}
                  unit={stock.product.unit}
                  packSize={stock.product.pack_size}
                />
                {singleStatus ? <StockStatusBadge status={singleStatus} /> : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('stock.col_value_cost')}</dt>
              <dd className="text-lg font-bold">
                <Money paise={stock.total_value_cost_paise} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('stock.col_reorder')}</dt>
              <dd>
                {stock.product.reorder_level_milli !== null ? (
                  <QtyAbs
                    milli={stock.product.reorder_level_milli}
                    unit={stock.product.unit}
                    packSize={stock.product.pack_size}
                  />
                ) : (
                  <span className="text-muted-foreground">{t('stock.no_reorder')}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('stock.mrp')}</dt>
              <dd>
                <Money paise={stock.product.mrp_paise} />
              </dd>
            </div>
          </dl>

          <section className="grid grid-cols-1 gap-2">
            <h3 className="text-sm font-semibold">
              {stock.product.track_batches ? t('stock.by_batch') : t('stock.by_store')}
            </h3>
            <StockByBatch productId={stock.product.id} data={stock} />
          </section>

          <section className="grid grid-cols-1 gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{t('stock.recent_movements')}</h3>
              <Button asChild variant="link" size="sm" leftIcon={<History />}>
                <Link
                  to={`/inventory/movements?product=${stock.product.id}${storeId ? `&store=${storeId}` : ''}`}
                >
                  {t('stock.all_movements')}
                </Link>
              </Button>
            </div>
            {stock.recent_movements.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('stock.no_movements')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {stock.recent_movements.map((m) => (
                  <MovementItem key={m.id} movement={m} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  )
}

function QtyAbs({ milli, unit, packSize }: { milli: number; unit: string; packSize: number }) {
  return <Qty milli={milli} unit={unit} packSize={packSize} packUnit={packUnitFor(unit)} colorize />
}

function MovementItem({ movement: m }: { movement: MovementRow }) {
  const { i18n } = useTranslation()
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
      <div className="grid min-w-0 grid-cols-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={movementTone(m.movement_type)} size="sm">
            {pickLabel(MOVEMENT_TYPE_LABELS[m.movement_type], i18n.language)}
          </Badge>
          <DocumentLink refType={m.ref_type} refId={m.ref_id} number={m.ref_number} />
        </div>
        <span className="text-xs text-muted-foreground">
          {[formatDateTime(m.created_at), m.store_code, m.batch_no].filter(Boolean).join(' · ')}
        </span>
      </div>
      <QtyChange milli={m.qty_milli} unit={m.unit} packSize={m.pack_size} className="shrink-0" />
    </li>
  )
}
