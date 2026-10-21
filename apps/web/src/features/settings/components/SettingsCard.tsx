/**
 * A titled block of a settings form ("Printing", "Weighing-scale barcodes" …). Children are the
 * fields; `aside` is a right-hand column on wide screens (e.g. the live receipt preview).
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function SettingsCard({
  title,
  description,
  icon,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      className={cn('rounded-xl border border-border bg-surface shadow-card', className)}
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        {icon ? (
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 id={id ? `${id}-title` : undefined} className="font-semibold leading-snug">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">{children}</div>
    </section>
  )
}

/** Read-only notice shown above forms the member cannot change. */
export function ReadOnlyNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="mb-4 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-sm text-info-soft-foreground"
    >
      {children}
    </div>
  )
}
