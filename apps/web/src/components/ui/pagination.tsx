/**
 * Offset pagination matching the API list envelope `page: { limit, offset, total }`.
 *   <Pagination offset={page.offset} limit={page.limit} total={page.total}
 *               onChange={({ offset, limit }) => setParams({ offset, limit })} />
 */
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { IconButton } from './icon-button'
import { Select } from './select'

export interface PaginationProps {
  offset: number
  limit: number
  total: number
  onChange: (next: { offset: number; limit: number }) => void
  pageSizeOptions?: readonly number[]
  className?: string
  /** Hide the page-size selector. */
  hidePageSize?: boolean
}

export function Pagination({
  offset,
  limit,
  total,
  onChange,
  pageSizeOptions = [20, 50, 100, 200],
  className,
  hidePageSize,
}: PaginationProps) {
  const { t } = useTranslation()
  const safeLimit = Math.max(1, limit)
  const pages = Math.max(1, Math.ceil(total / safeLimit))
  const page = Math.min(pages, Math.floor(offset / safeLimit) + 1)
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(total, offset + safeLimit)
  const go = (p: number): void =>
    onChange({ offset: (Math.min(Math.max(1, p), pages) - 1) * safeLimit, limit: safeLimit })

  return (
    <nav
      aria-label={t('pagination.label')}
      className={cn(
        'flex flex-col-reverse items-center justify-between gap-3 py-3 sm:flex-row',
        className,
      )}
    >
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums" aria-live="polite">
          {t('pagination.range', {
            from: formatNumber(from),
            to: formatNumber(to),
            total: formatNumber(total),
          })}
        </span>
        {!hidePageSize ? (
          <span className="hidden items-center gap-2 sm:flex">
            <span>{t('pagination.rows_per_page')}</span>
            <Select
              size="sm"
              className="w-20"
              aria-label={t('pagination.rows_per_page')}
              value={String(safeLimit)}
              onValueChange={(v) => onChange({ offset: 0, limit: Number(v) })}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          variant="outline"
          label={t('pagination.first')}
          icon={<ChevronsLeft className="rtl:rotate-180" />}
          disabled={page <= 1}
          onClick={() => go(1)}
        />
        <IconButton
          size="sm"
          variant="outline"
          label={t('pagination.previous')}
          icon={<ChevronLeft className="rtl:rotate-180" />}
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        />
        <span className="min-w-24 px-2 text-center text-sm tabular-nums">
          {t('pagination.page_of', { page: formatNumber(page), pages: formatNumber(pages) })}
        </span>
        <IconButton
          size="sm"
          variant="outline"
          label={t('pagination.next')}
          icon={<ChevronRight className="rtl:rotate-180" />}
          disabled={page >= pages}
          onClick={() => go(page + 1)}
        />
        <IconButton
          size="sm"
          variant="outline"
          label={t('pagination.last')}
          icon={<ChevronsRight className="rtl:rotate-180" />}
          disabled={page >= pages}
          onClick={() => go(pages)}
        />
      </div>
    </nav>
  )
}
