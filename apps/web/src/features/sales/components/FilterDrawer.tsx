/**
 * Secondary list filters in a sheet ("Filters" button with the number of active filters; right
 * sheet on desktop, bottom sheet on phones; changes apply at once) and the row of active-filter
 * chips under the toolbar, each removable with one tap.
 */
import { SlidersHorizontal, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Drawer } from '@/components/ui'
import { useBreakpoint } from '@/lib/use-media-query'

export function FilterDrawer({
  activeCount,
  onReset,
  children,
}: {
  activeCount: number
  onReset: () => void
  children: ReactNode
}) {
  const { t } = useTranslation(['sales', 'common'])
  const desktop = useBreakpoint('md')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        leftIcon={<SlidersHorizontal />}
        onClick={() => setOpen(true)}
        aria-label={
          activeCount > 0
            ? t('filters.button_count', { count: activeCount })
            : t('common:actions.filters')
        }
      >
        <span>{t('common:actions.filters')}</span>
        {activeCount > 0 ? (
          <Badge tone="primary" appearance="solid" size="sm" aria-hidden>
            {activeCount}
          </Badge>
        ) : null}
      </Button>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        side={desktop ? 'right' : 'bottom'}
        title={t('filters.title')}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="ghost" onClick={onReset} disabled={activeCount === 0}>
              {t('common:actions.clear_filters')}
            </Button>
            <Button onClick={() => setOpen(false)}>{t('filters.show_results')}</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">{children}</div>
      </Drawer>
    </>
  )
}

export interface ActiveFilter {
  key: string
  label: ReactNode
  onRemove: () => void
}

export function ActiveFilterChips({ filters }: { filters: readonly ActiveFilter[] }) {
  const { t } = useTranslation('sales')
  if (filters.length === 0) return null
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label={t('filters.active')}>
      {filters.map((f) => (
        <li key={f.key}>
          <button
            type="button"
            onClick={f.onRemove}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-2 ps-3 pe-2 text-sm hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="max-w-[16rem] truncate">{f.label}</span>
            <X className="size-3.5" aria-hidden />
            <span className="sr-only">{t('filters.remove')}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
