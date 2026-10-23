/**
 * Report table of the generic viewer: columns from the REPORTS catalogue, a sticky header and
 * first column inside its own scroll box (wide landscape reports stay readable), a totals row from
 * the response's `totals`, server sorting on the columns that declare a `sort` key, links to the
 * documents, and stacked cards with a totals card on phones.
 */
import type { Page } from '@kadai/shared/api/common'
import type { ReportColumnDef } from '@kadai/shared/api/reports'
import { ArrowDown, ArrowUp, ArrowUpDown, CloudOff, FileSearch } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  EmptyState,
  Pagination,
  RetryButton,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { describeError } from '@/lib/errors'
import { useBreakpoint } from '@/lib/use-media-query'
import { cellText, renderCell, type ReportRow, totalValue } from '../lib/cells'
import { pick, useLang } from '../lib/labels'

export interface ReportTableProps {
  label: string
  columns: readonly ReportColumnDef[]
  rows: readonly ReportRow[]
  rowKey: (row: ReportRow, index: number) => string
  totals: ReportRow | null
  showTotals: boolean
  page: Page | null
  onPageChange: (next: { offset: number; limit: number }) => void
  sort: string
  onSortChange: (sort: string) => void
  loading: boolean
  fetching: boolean
  error: unknown
  onRetry: () => void
  empty: ReactNode
}

const PAGE_SIZES = [50, 100, 200, 500] as const
const MOBILE_FIELDS = 6

const alignClass = (c: ReportColumnDef): string | undefined =>
  c.align === 'right' ? 'text-end' : c.align === 'center' ? 'text-center' : undefined

function SortButton({
  column,
  sort,
  onSortChange,
  children,
}: {
  column: ReportColumnDef
  sort: string
  onSortChange: (s: string) => void
  children: ReactNode
}) {
  const key = column.sort!
  const dir = sort === key ? 'asc' : sort === `-${key}` ? 'desc' : null
  // Money / counts usually make sense largest-first; names and dates ascending.
  const firstDesc = column.format !== 'text' && column.format !== 'date'
  const next = dir === null ? (firstDesc ? `-${key}` : key) : dir === 'asc' ? `-${key}` : key
  return (
    <button
      type="button"
      onClick={() => onSortChange(next)}
      className={cn(
        'inline-flex items-center gap-1 uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        column.align === 'right' && 'flex-row-reverse',
      )}
    >
      {children}
      {dir === 'asc' ? (
        <ArrowUp className="size-3.5" />
      ) : dir === 'desc' ? (
        <ArrowDown className="size-3.5" />
      ) : (
        <ArrowUpDown className="size-3.5 opacity-40" />
      )}
    </button>
  )
}

export function ReportTable({
  label,
  columns,
  rows,
  rowKey,
  totals,
  showTotals,
  page,
  onPageChange,
  sort,
  onSortChange,
  loading,
  fetching,
  error,
  onRetry,
  empty,
}: ReportTableProps) {
  const { t } = useTranslation(['reports', 'common'])
  const lng = useLang()
  const desktop = useBreakpoint('md')
  const firstLoad = loading && rows.length === 0
  const hasTotals = showTotals && totals !== null && columns.some((c) => c.total)

  if (error && !fetching && rows.length === 0) {
    const d = describeError(error)
    return (
      <div className="rounded-xl border border-border bg-surface shadow-card">
        <EmptyState
          icon={<CloudOff />}
          title={d.title}
          description={d.description}
          action={<RetryButton onRetry={onRetry} />}
        />
      </div>
    )
  }

  const pagination =
    page && page.total > 0 ? (
      <div className="border-t border-border px-3">
        <Pagination
          offset={page.offset}
          limit={page.limit}
          total={page.total}
          onChange={onPageChange}
          pageSizeOptions={PAGE_SIZES}
        />
      </div>
    ) : null

  if (!firstLoad && rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface shadow-card">
        {empty ?? <EmptyState icon={<FileSearch />} title={t('common:empty.no_data')} />}
      </div>
    )
  }

  if (!desktop) {
    const title = columns.filter((c) => c.mobile === 'title')
    const subtitle = columns.filter((c) => c.mobile === 'subtitle')
    // Cards stay short: the columns marked for phones first, then the rest, at most six.
    const values = [
      ...columns.filter((c) => c.mobile === 'value'),
      ...columns.filter((c) => c.mobile === undefined),
    ].slice(0, MOBILE_FIELDS)
    return (
      <div className="grid grid-cols-1 gap-2">
        {hasTotals && !firstLoad ? (
          <section
            aria-label={t('reports:viewer.totals')}
            className="rounded-xl border border-primary/30 bg-primary-soft/40 p-3"
          >
            <h3 className="mb-2 text-sm font-semibold">{t('reports:viewer.totals')}</h3>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {columns
                .filter((c) => totalValue(c, totals) !== undefined)
                .map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                      {pick(c.label, lng)}
                    </dt>
                    <dd className="truncate text-sm font-semibold">
                      {renderCell(
                        { ...c, link: undefined },
                        { ...totals, [c.key]: totalValue(c, totals) },
                        lng,
                      )}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ) : null}
        <ul
          aria-label={label}
          aria-busy={fetching || undefined}
          className={cn('grid gap-2', fetching && !firstLoad && 'opacity-60')}
        >
          {firstLoad
            ? Array.from({ length: 5 }, (_, i) => (
                <li key={i} className="rounded-xl border border-border bg-surface p-3">
                  <Skeleton className="mb-2 h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </li>
              ))
            : rows.map((row, i) => (
                <li
                  key={rowKey(row, i)}
                  className="rounded-xl border border-border bg-surface p-3 shadow-card"
                >
                  {title.map((c) => (
                    <div key={c.key} className="text-sm font-semibold text-foreground">
                      {renderCell(c, row, lng)}
                    </div>
                  ))}
                  {subtitle.map((c) => (
                    <div key={c.key} className="text-xs text-muted-foreground">
                      {cellText(c, row, lng) || '—'}
                    </div>
                  ))}
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {values.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                          {pick(c.label, lng)}
                        </dt>
                        <dd className="truncate text-sm">{renderCell(c, row, lng)}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
        </ul>
        {pagination ? (
          <div className="rounded-xl border border-border bg-surface">{pagination}</div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      {fetching && !firstLoad ? (
        <div className="h-0.5 w-full animate-shimmer bg-primary" aria-hidden />
      ) : null}
      <Table
        aria-label={label}
        aria-busy={fetching || undefined}
        wrapperClassName="max-h-[max(24rem,calc(100dvh-17rem))] overflow-auto"
        className="border-separate border-spacing-0"
      >
        <TableHeader className="[&_tr]:border-0">
          <TableRow className="border-0">
            {columns.map((c, i) => (
              <TableHead
                key={c.key}
                scope="col"
                aria-sort={
                  c.sort && sort === c.sort
                    ? 'ascending'
                    : c.sort && sort === `-${c.sort}`
                      ? 'descending'
                      : undefined
                }
                className={cn(
                  'sticky top-0 z-10 border-b border-border bg-surface-2',
                  i === 0 && 'start-0 z-20',
                  alignClass(c),
                )}
              >
                {c.sort ? (
                  <SortButton column={c} sort={sort} onSortChange={onSortChange}>
                    {pick(c.label, lng)}
                  </SortButton>
                ) : (
                  pick(c.label, lng)
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody className={cn(fetching && !firstLoad && 'opacity-60 transition-opacity')}>
          {firstLoad
            ? Array.from({ length: 8 }, (_, r) => (
                <TableRow key={`sk-${r}`}>
                  {columns.map((c) => (
                    <TableCell key={c.key} className="border-b border-border">
                      <Skeleton className="h-4 w-full max-w-32" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : rows.map((row, r) => (
                <TableRow key={rowKey(row, r)} className="border-0 hover:bg-surface-2/60">
                  {columns.map((c, i) => (
                    <TableCell
                      key={c.key}
                      className={cn(
                        'border-b border-border py-2',
                        i === 0 && 'sticky start-0 z-[1] bg-surface',
                        alignClass(c),
                        c.format === 'text' && 'max-w-72 truncate',
                      )}
                      title={c.format === 'text' ? cellText(c, row, lng) : undefined}
                    >
                      {renderCell(c, row, lng)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
        </TableBody>
        {hasTotals && !firstLoad ? (
          <TableFooter className="border-0">
            <TableRow className="border-0">
              {columns.map((c, i) => {
                const v = totalValue(c, totals)
                return (
                  <TableCell
                    key={c.key}
                    className={cn(
                      'sticky bottom-0 border-t-2 border-border bg-surface-2 py-2.5 font-semibold',
                      i === 0 && 'start-0 z-20',
                      alignClass(c),
                    )}
                  >
                    {v !== undefined
                      ? renderCell({ ...c, link: undefined }, { ...totals, [c.key]: v }, lng)
                      : i === 0
                        ? t('reports:viewer.total')
                        : null}
                  </TableCell>
                )
              })}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
      {pagination}
    </div>
  )
}
