import { Inbox } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Primary / secondary actions (Buttons). */
  action?: ReactNode
  /** Smaller variant for table bodies and cards. */
  compact?: boolean
  className?: string
  children?: ReactNode
}

export function EmptyState({ icon, title, description, action, compact, className, children }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-2xl bg-primary-soft text-primary-soft-foreground',
          compact ? 'size-11 [&_svg]:size-5' : 'size-16 [&_svg]:size-8',
        )}
        aria-hidden
      >
        {icon ?? <Inbox />}
      </span>
      <h3 className={cn('font-semibold text-foreground', compact ? 'text-sm' : 'text-lg')}>{title}</h3>
      {description ? (
        <p className={cn('max-w-md text-muted-foreground', compact ? 'text-xs' : 'text-sm leading-relaxed')}>
          {description}
        </p>
      ) : null}
      {children}
      {action ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  )
}
