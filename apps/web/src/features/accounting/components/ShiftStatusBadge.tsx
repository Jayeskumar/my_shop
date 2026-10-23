/**
 * Shift state at a glance: "Open" while the drawer is in use; once closed the cash result —
 * Short ₹120 (red), Excess ₹40 (amber) or Tallied (green). Used in lists, the shift page and the
 * POS shift chip.
 */
import type { ShiftStatus } from '@kadai/shared'
import type { ShiftDifferenceStatus } from '@kadai/shared/api/accounting'
import { useTranslation } from 'react-i18next'
import { Badge, type BadgeProps } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { differenceLabel, differenceTone } from '../lib/labels'

export interface ShiftStatusBadgeProps {
  status: ShiftStatus
  /** Cash result of a closed shift (ignored while open). */
  differenceStatus?: ShiftDifferenceStatus | null
  /** counted − expected; shown with the short / excess label. */
  differencePaise?: number | null
  size?: BadgeProps['size']
  className?: string
}

export function ShiftStatusBadge({
  status,
  differenceStatus,
  differencePaise,
  size = 'md',
  className,
}: ShiftStatusBadgeProps) {
  const { t } = useTranslation('accounting')
  if (status === 'open') {
    return (
      <Badge tone="info" size={size} dot className={className}>
        {t('shifts.status_open')}
      </Badge>
    )
  }
  if (!differenceStatus) {
    return (
      <Badge tone="neutral" size={size} className={className}>
        {t('shifts.status_closed')}
      </Badge>
    )
  }
  const amount =
    differenceStatus !== 'balanced' && differencePaise
      ? ` ${formatMoney(Math.abs(differencePaise), { decimals: 'auto' })}`
      : ''
  return (
    <Badge tone={differenceTone(differenceStatus)} size={size} className={className}>
      {differenceLabel(differenceStatus)}
      {amount}
    </Badge>
  )
}
