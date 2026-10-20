import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import type { Tone } from './variants'

const colors: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  primary: 'bg-primary',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

export interface StatusDotProps {
  tone?: Tone
  /** Animated ring (live status: syncing, waiting for UPI). */
  pulse?: boolean
  label?: ReactNode
  className?: string
}

export function StatusDot({ tone = 'neutral', pulse, label, className }: StatusDotProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)}>
      <span className="relative inline-flex size-2.5">
        {pulse ? (
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', colors[tone])} />
        ) : null}
        <span className={cn('relative inline-flex size-2.5 rounded-full', colors[tone])} />
      </span>
      {label}
    </span>
  )
}
