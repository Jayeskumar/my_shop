/**
 * Credit limit utilisation: how much of the customer's limit the current due uses, with the
 * credit still available. Green below 75 %, amber up to 100 %, red over the limit.
 */
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'

export function CreditLimitBar({
  balancePaise,
  creditLimitPaise,
  className,
}: {
  balancePaise: number
  creditLimitPaise: number | null
  className?: string
}) {
  const { t } = useTranslation('parties')
  if (creditLimitPaise === null) {
    return <p className={cn('text-xs text-muted-foreground', className)}>{t('credit.no_limit')}</p>
  }
  const used = Math.max(0, balancePaise)
  const pct =
    creditLimitPaise > 0 ? Math.round((used * 100) / creditLimitPaise) : used > 0 ? 101 : 0
  const available = creditLimitPaise - used
  const tone = pct > 100 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-success'
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {t('credit.limit_of', { limit: formatMoney(creditLimitPaise, { decimals: 'auto' }) })}
        </span>
        <span className={cn('font-medium tabular-nums', available < 0 && 'text-danger')}>
          {available < 0
            ? t('credit.over_by', { amount: formatMoney(-available, { decimals: 'auto' }) })
            : t('credit.available', { amount: formatMoney(available, { decimals: 'auto' }) })}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label={t('credit.used_label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
        aria-valuetext={t('credit.used_pct', { pct })}
      >
        <div
          className={cn('h-full rounded-full transition-[width]', tone)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  )
}
