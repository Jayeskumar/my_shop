import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { formatCombo } from '@/lib/hotkeys'

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** A combo like 'F2' or 'mod+k' rendered for the current OS; or pass children. */
  combo?: string
}

export function Kbd({ combo, className, children, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1.5 font-sans text-[11px] font-semibold leading-none text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]',
        className,
      )}
      {...props}
    >
      {combo ? formatCombo(combo) : children}
    </kbd>
  )
}
