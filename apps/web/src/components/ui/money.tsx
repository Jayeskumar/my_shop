import { formatINR, formatINRCompact } from '@kadai/shared/money'
import { cn } from '@/lib/cn'
import { getLanguage } from '@/lib/i18n'

export interface MoneyProps {
  /** Integer paise. */
  paise: number | null | undefined
  /** 2 (default), 0 (whole rupees) or 'auto' (hide .00). */
  decimals?: 2 | 0 | 'auto'
  /** ₹1.23 L style for KPI tiles. */
  compact?: boolean
  /** Negative amounts in red, positive in green (ledgers / balances). */
  colorize?: boolean
  /** Show "Dr"/"Cr" suffix style is module-specific; this only controls the sign. */
  signDisplay?: 'auto' | 'always'
  className?: string
  /** Text for null/undefined (default '—'). */
  empty?: string
}

/** Formatted rupee amount (Indian grouping, tabular digits). */
export function Money({
  paise,
  decimals = 2,
  compact,
  colorize,
  signDisplay = 'auto',
  className,
  empty = '—',
}: MoneyProps) {
  if (paise === null || paise === undefined) {
    return <span className={cn('text-muted-foreground', className)}>{empty}</span>
  }
  const text = compact ? formatINRCompact(paise, getLanguage()) : formatINR(paise, { decimals })
  const signed = signDisplay === 'always' && paise > 0 ? `+${text}` : text
  return (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        colorize && paise < 0 && 'text-danger',
        colorize && paise > 0 && 'text-success',
        className,
      )}
    >
      {signed}
    </span>
  )
}
