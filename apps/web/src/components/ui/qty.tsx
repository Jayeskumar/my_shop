import { cn } from '@/lib/cn'
import { formatPackQty, formatQty } from '@/lib/format'

export interface QtyProps {
  /** Milli base units. */
  milli: number | null | undefined
  unit: string
  /** With pack_size > 1, also shows packs + loose (pharmacy strips: "2 strips + 3 tabs"). */
  packSize?: number
  packUnit?: string
  className?: string
  /** Negative quantities in red (stock shortages). */
  colorize?: boolean
}

export function Qty({ milli, unit, packSize, packUnit, className, colorize }: QtyProps) {
  if (milli === null || milli === undefined) return <span className="text-muted-foreground">—</span>
  const text =
    packSize && packSize > 1 && Math.abs(milli) >= packSize * 1000
      ? formatPackQty(milli, packSize, unit, packUnit)
      : formatQty(milli, unit)
  return (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        colorize && milli < 0 && 'text-danger',
        className,
      )}
    >
      {text}
    </span>
  )
}
