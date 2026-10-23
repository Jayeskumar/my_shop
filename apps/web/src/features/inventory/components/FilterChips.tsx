/**
 * Quick filter chips (All / Low stock / Out of stock …): large tap targets, keyboard reachable,
 * the active chips are announced as pressed. Single choice by default; `multiple` toggles each
 * chip independently (movement types).
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface FilterChip<K extends string> {
  key: K
  label: ReactNode
  /** Small count shown inside the chip. */
  badge?: ReactNode
  tone?: 'default' | 'danger' | 'success' | 'warning'
}

interface BaseProps<K extends string> {
  chips: readonly FilterChip<K>[]
  label: string
  className?: string
}

type SingleProps<K extends string> = BaseProps<K> & {
  multiple?: false
  value: K
  onChange: (key: K) => void
}

type MultiProps<K extends string> = BaseProps<K> & {
  multiple: true
  value: readonly K[]
  onChange: (keys: K[]) => void
}

export function FilterChips<K extends string>(props: SingleProps<K> | MultiProps<K>) {
  const { chips, label, className } = props
  const isActive = (key: K): boolean =>
    props.multiple ? props.value.includes(key) : props.value === key
  const toggle = (key: K): void => {
    if (props.multiple) {
      const next = props.value.includes(key)
        ? props.value.filter((k) => k !== key)
        : [...props.value, key]
      props.onChange(next)
    } else {
      props.onChange(key)
    }
  }
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1', className)}
    >
      {chips.map((chip) => {
        const active = isActive(chip.key)
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(chip.key)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              active
                ? 'border-primary bg-primary text-primary-foreground shadow-card'
                : 'border-border bg-surface text-foreground hover:bg-surface-2',
              !active && chip.tone === 'danger' && 'text-danger',
              !active && chip.tone === 'success' && 'text-success',
              !active && chip.tone === 'warning' && 'text-warning',
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
