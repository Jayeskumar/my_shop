/**
 * A titled block of the notification settings page (same look as the other settings screens):
 * icon, title, one-line description, optional header actions, then the content.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function SettingsSection({
  id,
  icon,
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  id: string
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn('min-w-0 rounded-xl border border-border bg-surface shadow-card', className)}
    >
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        {icon ? (
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="font-semibold leading-snug">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className={cn('flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-5', bodyClassName)}>
        {children}
      </div>
    </section>
  )
}
