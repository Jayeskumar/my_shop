/**
 * Reusable stock indicators (exported from '@/features/inventory'):
 *  - StockStatusBadge: ok / low / out / negative as a coloured badge;
 *  - StockBadge: the quantity itself in a badge coloured by its status ("12 pcs", "2 strips +
 *    3 tabs"), for product pages, pickers and POS hints;
 *  - ExpiryBadge: expired / expiring in N days / good, colour coded;
 *  - QtyChange: a signed movement quantity with +/− and colour.
 */
import {
  EXPIRY_STATUS_LABELS,
  type ExpiryStatus,
  STOCK_STATUS_LABELS,
  type StockStatus,
  stockStatus,
} from '@kadai/shared/api/inventory'
import { AlertTriangle, CalendarClock, CalendarX2, PackageX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Qty } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { EXPIRY_STATUS_TONE, STOCK_STATUS_TONE, packUnitFor, pickLabel } from '../lib/labels'

export function StockStatusBadge({
  status,
  size = 'sm',
  className,
}: {
  status: StockStatus
  size?: 'sm' | 'md'
  className?: string
}) {
  const { i18n } = useTranslation()
  return (
    <Badge
      tone={STOCK_STATUS_TONE[status]}
      size={size}
      dot={status !== 'negative'}
      icon={status === 'negative' ? <AlertTriangle aria-hidden /> : undefined}
      className={className}
    >
      {pickLabel(STOCK_STATUS_LABELS[status], i18n.language)}
    </Badge>
  )
}

export interface StockBadgeProps {
  /** Stock in milli base units (may be negative). */
  qtyMilli: number
  unit: string
  /** Pack size: quantities of a pack or more show as packs + loose (pharmacy strips). */
  packSize?: number
  reorderLevelMilli?: number | null
  /** Status from the API (computed from qty and reorder level when omitted). */
  status?: StockStatus
  size?: 'sm' | 'md'
  className?: string
}

/** The stock quantity in a badge coloured by its status. */
export function StockBadge({
  qtyMilli,
  unit,
  packSize = 1,
  reorderLevelMilli = null,
  status,
  size = 'sm',
  className,
}: StockBadgeProps) {
  const { t, i18n } = useTranslation('inventory')
  const s = status ?? stockStatus(qtyMilli, reorderLevelMilli)
  return (
    <Badge
      tone={STOCK_STATUS_TONE[s]}
      size={size}
      className={className}
      icon={s === 'out' ? <PackageX aria-hidden /> : undefined}
      title={pickLabel(STOCK_STATUS_LABELS[s], i18n.language)}
      aria-label={t('stock.badge_label', {
        status: pickLabel(STOCK_STATUS_LABELS[s], i18n.language),
      })}
    >
      <Qty milli={qtyMilli} unit={unit} packSize={packSize} packUnit={packUnitFor(unit)} />
    </Badge>
  )
}

export interface ExpiryBadgeProps {
  expiryDate: string | null
  status: ExpiryStatus
  daysToExpiry: number | null
  /** Also show the date (dd-MM-yyyy). */
  showDate?: boolean
  size?: 'sm' | 'md'
  className?: string
}

/** Expiry status with the days left (or since expiry), colour coded. */
export function ExpiryBadge({
  expiryDate,
  status,
  daysToExpiry,
  showDate = false,
  size = 'sm',
  className,
}: ExpiryBadgeProps) {
  const { t, i18n } = useTranslation('inventory')
  let text: string
  if (status === 'none' || daysToExpiry === null)
    text = pickLabel(EXPIRY_STATUS_LABELS.none, i18n.language)
  else if (status === 'expired') text = t('expiry.expired_ago', { count: Math.abs(daysToExpiry) })
  else if (daysToExpiry === 0) text = t('expiry.today')
  else text = t('expiry.in_days', { count: daysToExpiry })
  const Icon = status === 'expired' ? CalendarX2 : CalendarClock
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      {showDate && expiryDate ? (
        <span className="tabular-nums">{formatDate(expiryDate)}</span>
      ) : null}
      <Badge
        tone={EXPIRY_STATUS_TONE[status]}
        size={size}
        icon={status === 'none' ? undefined : <Icon aria-hidden />}
      >
        {text}
      </Badge>
    </span>
  )
}

/** Signed quantity of a movement: "+10 pcs" in green, "−2 pcs" in red. */
export function QtyChange({
  milli,
  unit,
  packSize,
  className,
}: {
  milli: number
  unit: string
  packSize?: number
  className?: string
}) {
  const sign = milli > 0 ? '+' : milli < 0 ? '−' : ''
  return (
    <span
      className={cn(
        'whitespace-nowrap font-medium tabular-nums',
        milli > 0 && 'text-success',
        milli < 0 && 'text-danger',
        className,
      )}
    >
      {sign}
      <Qty milli={Math.abs(milli)} unit={unit} packSize={packSize} packUnit={packUnitFor(unit)} />
    </span>
  )
}
