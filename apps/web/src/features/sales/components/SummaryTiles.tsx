/** Totals of a list's whole filtered range (the list response `summary`), as compact tiles. */
import type { ReactNode } from 'react'
import { Money, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'

export interface SummaryTile {
  key: string
  label: ReactNode
  /** Paise, or a plain count when `count` is set. */
  value: number
  count?: boolean
  tone?: 'default' | 'success' | 'danger' | 'muted'
}

export function SummaryTiles({
  tiles,
  loading,
  label,
}: {
  tiles: readonly SummaryTile[]
  loading?: boolean
  label: string
}) {
  return (
    <section aria-label={label} className="mb-4 grid grid-cols-3 gap-2 lg:grid-cols-6 lg:gap-3">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="min-w-0 rounded-lg border border-border bg-surface px-2.5 py-2 shadow-card sm:px-3 sm:py-2.5"
        >
          <div className="truncate text-[11px] text-muted-foreground sm:text-xs">{tile.label}</div>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-20" />
          ) : (
            <div
              className={cn(
                'mt-0.5 truncate text-sm font-semibold tabular-nums sm:text-lg',
                tile.tone === 'success' && 'text-success',
                tile.tone === 'danger' && tile.value > 0 && 'text-danger',
                tile.tone === 'muted' && 'text-muted-foreground',
              )}
            >
              {tile.count ? (
                new Intl.NumberFormat('en-IN').format(tile.value)
              ) : (
                <Money paise={tile.value} decimals="auto" />
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
