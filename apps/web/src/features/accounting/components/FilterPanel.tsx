/**
 * Filter row of the accounting lists: the main controls (period, search) always show; the other
 * filters sit inline from the sm breakpoint and fold behind a "Filters (n)" button on phones, so
 * the list starts near the top of a 390 px screen. "Clear filters" appears while any is set.
 */
import { SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useBreakpoint } from '@/lib/use-media-query'

export function FilterPanel({
  primary,
  children,
  activeCount = 0,
  onReset,
  className,
}: {
  /** Always visible (date range, search). */
  primary: ReactNode
  /** Secondary filters (store, category, status…). */
  children?: ReactNode
  /** Secondary filters currently set (badge on the phone toggle). */
  activeCount?: number
  onReset?: () => void
  className?: string
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const wide = useBreakpoint('sm')
  const [open, setOpen] = useState(false)
  const showSecondary = wide || open
  return (
    <div
      className={cn('flex flex-col gap-2 pb-4 sm:flex-row sm:flex-wrap sm:items-center', className)}
    >
      {primary}
      {children && !wide ? (
        <Button
          variant="outline"
          leftIcon={<SlidersHorizontal />}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="justify-start"
        >
          {t('filters.more')}
          {activeCount > 0 ? (
            <Badge tone="primary" size="sm" className="ms-auto">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      ) : null}
      {children && showSecondary ? children : null}
      {onReset && activeCount > 0 ? (
        <Button variant="ghost" size="sm" onClick={onReset} className="self-start sm:self-auto">
          {t('common:actions.clear_filters')}
        </Button>
      ) : null}
    </div>
  )
}
