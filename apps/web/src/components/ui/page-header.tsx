import { ArrowLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'

export interface Crumb {
  label: ReactNode
  to?: string
}

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  breadcrumbs?: Crumb[]
  /** Buttons on the right (wrap below the title on phones). */
  actions?: ReactNode
  /** Shows a back arrow linking here (detail pages). */
  backTo?: string
  /** Badges / status next to the title. */
  meta?: ReactNode
  className?: string
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <nav aria-label={t('a11y.breadcrumbs')} className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground sm:text-sm">
        {items.map((c, i) => {
          const last = i === items.length - 1
          return (
            <li key={i} className="flex min-w-0 items-center gap-1">
              {c.to && !last ? (
                <Link to={c.to} className="truncate hover:text-foreground hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span className={cn('truncate', last && 'text-foreground')} aria-current={last ? 'page' : undefined}>
                  {c.label}
                </span>
              )}
              {!last ? <ChevronRight className="size-3.5 shrink-0 rtl:rotate-180" aria-hidden /> : null}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export function PageHeader({ title, description, breadcrumbs, actions, backTo, meta, className }: PageHeaderProps) {
  const { t } = useTranslation()
  return (
    <header className={cn('flex flex-col gap-3 pb-5 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} /> : null}
        <div className="flex min-w-0 items-center gap-2">
          {backTo ? (
            <Link
              to={backTo}
              aria-label={t('actions.back')}
              className="-ms-2 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <ArrowLeft className="size-5 rtl:rotate-180" />
            </Link>
          ) : null}
          <h1 className="truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">{title}</h1>
          {meta ? <div className="flex shrink-0 items-center gap-2">{meta}</div> : null}
        </div>
        {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
    </header>
  )
}
