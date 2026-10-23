/**
 * Single-choice quick filter chips (Active / Revoked / All …): large tap targets, keyboard
 * reachable, the active chip is announced as pressed.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface FilterChip<K extends string> {
  key: K
  label: ReactNode
  /** Small count shown inside the chip. */
  badge?: ReactNode
}

export function FilterChips<K extends string>({
  chips,
  value,
  onChange,
  label,
  className,
}: {
  chips: readonly FilterChip<K>[]
  value: K
  onChange: (key: K) => void
  label: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1', className)}
    >
      {chips.map((chip) => {
        const active = chip.key === value
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(chip.key)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              active
                ? 'border-primary bg-primary text-primary-foreground shadow-card'
                : 'border-border bg-surface text-foreground hover:bg-surface-2',
            )}
          >
            {chip.label}
            {chip.badge !== undefined ? (
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs tabular-nums',
                  active ? 'bg-primary-foreground/20' : 'bg-surface-2',
                )}
              >
                {chip.badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
