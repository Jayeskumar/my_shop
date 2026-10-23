/**
 * A party balance read the shopkeeper's way: customers — "₹1,250.00 due" in red or
 * "₹300.00 advance" in green; suppliers — "₹4,000.00 to pay" / "₹500.00 advance". Zero shows
 * "Settled".
 */
import { useTranslation } from 'react-i18next'
import type { PartyType } from '@kadai/shared/enums'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { balanceSide } from '../lib/labels'

export function BalanceAmount({
  partyType,
  balancePaise,
  size = 'md',
  showLabel = true,
  className,
}: {
  partyType: PartyType
  balancePaise: number
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Show the "due / advance" word after the amount (default true). */
  showLabel?: boolean
  className?: string
}) {
  const { t } = useTranslation('parties')
  const side = balanceSide(balancePaise)
  const label =
    side === 'settled'
      ? t('balance.settled')
      : side === 'due'
        ? t(partyType === 'customer' ? 'balance.due' : 'balance.to_pay')
        : t('balance.advance')
  if (side === 'settled') {
    return (
      <span className={cn('text-muted-foreground', sizeClass(size), className)}>
        {showLabel ? label : formatMoney(0)}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-baseline justify-end gap-x-1 tabular-nums',
        side === 'due' ? 'text-danger' : 'text-success',
        sizeClass(size),
        className,
      )}
    >
      <span className="whitespace-nowrap font-semibold">{formatMoney(Math.abs(balancePaise))}</span>
      {showLabel ? (
        <span
          className={cn(
            'whitespace-nowrap font-medium',
            size === 'xl' || size === 'lg' ? 'text-sm' : 'text-xs',
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  )
}

function sizeClass(size: 'sm' | 'md' | 'lg' | 'xl'): string {
  switch (size) {
    case 'sm':
      return 'text-xs'
    case 'md':
      return 'text-sm'
    case 'lg':
      return 'text-lg'
    case 'xl':
      return 'text-3xl font-bold tracking-tight'
  }
}
