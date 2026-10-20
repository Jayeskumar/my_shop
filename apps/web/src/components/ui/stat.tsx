/**
 * KPI tile: label, big value, optional change vs. previous period and hint.
 *   <Stat label="Today's sales" value={<Money paise={total} />} change={{ bp: 1250 }} icon={<IndianRupee />} />
 */
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { formatChangeBp } from '@/lib/format'
import { Card } from './card'
import { Skeleton } from './skeleton'

export interface StatProps {
  label: ReactNode
  value: ReactNode
  /** Change in basis points (+12.5% = 1250); `goodWhen` decides the colour (default 'up'). */
  change?: { bp: number; goodWhen?: 'up' | 'down'; label?: ReactNode }
  hint?: ReactNode
  icon?: ReactNode
  loading?: boolean
  tone?: 'default' | 'primary' | 'accent' | 'danger'
  className?: string
  onClick?: () => void
}

export function Stat({
  label,
  value,
  change,
  hint,
  icon,
  loading,
  tone = 'default',
  className,
  onClick,
}: StatProps) {
  const up = (change?.bp ?? 0) > 0
  const down = (change?.bp ?? 0) < 0
  const good = change ? (change.goodWhen === 'down' ? down : up) : false
  const bad = change ? (change.goodWhen === 'down' ? up : down) : false
  const ChangeIcon = up ? ArrowUpRight : down ? ArrowDownRight : Minus
  return (
    <Card
      interactive={Boolean(onClick)}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn('flex flex-col gap-3 p-4 sm:p-5', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {icon ? (
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5',
              tone === 'accent'
                ? 'bg-accent-soft text-accent-soft-foreground'
                : tone === 'danger'
                  ? 'bg-danger-soft text-danger'
                  : 'bg-primary-soft text-primary-soft-foreground',
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-32" />
      ) : (
        <div className="text-2xl font-bold tracking-tight tabular-nums sm:text-[1.75rem]">
          {value}
        </div>
      )}
      {change || hint ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {change && !loading ? (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold',
                good && 'bg-success-soft text-success-soft-foreground',
                bad && 'bg-danger-soft text-danger-soft-foreground',
                !good && !bad && 'bg-surface-2 text-muted-foreground',
              )}
            >
              <ChangeIcon className="size-3.5" />
              {formatChangeBp(change.bp)}
            </span>
          ) : null}
          {change?.label ? <span className="text-muted-foreground">{change.label}</span> : null}
          {hint ? <span className="text-muted-foreground">{hint}</span> : null}
        </div>
      ) : null}
    </Card>
  )
}
