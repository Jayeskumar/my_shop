/**
 * Product name in the UI language (Tamil first when there is one) with the other language below,
 * plus the chips a cashier needs at a glance: variant, batch + expiry (coloured), schedule.
 */
import { useTranslation } from 'react-i18next'
import { batchExpiryStatus, drugScheduleOf } from '@kadai/shared/api/sales'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { productNames } from '../lib/names'
import type { PosBatch, PosProduct } from '../lib/types'

export function ExpiryBadge({
  batch,
  today,
  warningDays,
}: {
  batch: Pick<PosBatch, 'batch_no' | 'expiry_date'>
  today: string
  warningDays: number
}) {
  const { t } = useTranslation('pos')
  const status = batchExpiryStatus(batch.expiry_date, today, warningDays)
  const tone = status === 'expired' ? 'danger' : status === 'near_expiry' ? 'warning' : 'neutral'
  return (
    <Badge tone={tone} size="sm" appearance="soft">
      {t('cart.batch', { batch: batch.batch_no })}
      {batch.expiry_date ? ` · ${t('cart.expiry', { date: formatDate(batch.expiry_date) })}` : ''}
    </Badge>
  )
}

export function ProductLabel({
  product,
  batch,
  today,
  warningDays,
  note,
  className,
  onBatchClick,
}: {
  product: PosProduct
  batch?: PosBatch | null
  today: string
  warningDays: number
  note?: string | null
  className?: string
  onBatchClick?: () => void
}) {
  const { t } = useTranslation('pos')
  const names = productNames(product)
  const variant = Object.values(product.variant_attributes)
  const schedule =
    product.track_batches || product.attributes['schedule'] !== undefined
      ? drugScheduleOf(product.attributes)
      : null
  return (
    <div className={cn('min-w-0', className)}>
      <div className="truncate font-semibold leading-snug" title={product.name}>
        {names.primary}
      </div>
      {names.secondary ? (
        <div className="truncate text-xs text-muted-foreground">{names.secondary}</div>
      ) : null}
      {variant.length || batch || (schedule && schedule !== 'OTC') || note ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {variant.length ? (
            <Badge tone="info" size="sm">
              {variant.join(' / ')}
            </Badge>
          ) : null}
          {batch ? (
            onBatchClick ? (
              <button
                type="button"
                onClick={onBatchClick}
                className="rounded-full focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={t('cart.change_batch')}
              >
                <ExpiryBadge batch={batch} today={today} warningDays={warningDays} />
              </button>
            ) : (
              <ExpiryBadge batch={batch} today={today} warningDays={warningDays} />
            )
          ) : null}
          {schedule && schedule !== 'OTC' ? (
            <Badge tone="danger" appearance="outline" size="sm">
              {t('cart.schedule', { schedule })}
            </Badge>
          ) : null}
          {note ? (
            <Badge tone="neutral" size="sm" className="max-w-48 truncate">
              “{note}”
            </Badge>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
