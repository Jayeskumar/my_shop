/**
 * Small read-only table for fixed layouts (GST sections, GSTR-3B tables): header, rows, optional
 * totals row; stacked cards below md. Columns render their own cells.
 */
import type { ReactNode } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { useBreakpoint } from '@/lib/use-media-query'

export interface SimpleColumn<T> {
  key: string
  header: string
  align?: 'left' | 'right'
  cell: (row: T) => ReactNode
  /** Totals row cell. */
  total?: ReactNode
  /** Card role on phones (default 'value'). */
  mobile?: 'title' | 'subtitle' | 'value' | 'hidden'
  className?: string
  /** Header cell only (e.g. let a long heading wrap). */
  headClassName?: string
}

export interface SimpleTableProps<T> {
  label: string
  columns: readonly SimpleColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T, index: number) => string
  /** Label of the totals row (first column) — the row is shown when any column has `total`. */
  totalLabel?: string
  className?: string
  /** Highlight a row (current quarter …). */
  highlight?: (row: T) => boolean
  dense?: boolean
}

export function SimpleTable<T>({
  label,
  columns,
  rows,
  rowKey,
  totalLabel,
  className,
  highlight,
  dense,
}: SimpleTableProps<T>) {
  const desktop = useBreakpoint('md')
  const hasTotals = columns.some((c) => c.total !== undefined)

  if (!desktop) {
    const title = columns.filter((c) => c.mobile === 'title')
    const subtitle = columns.filter((c) => c.mobile === 'subtitle')
    const values = columns.filter((c) => (c.mobile ?? 'value') === 'value')
    return (
      <ul aria-label={label} className={cn('grid gap-2', className)}>
        {rows.map((row, i) => (
          <li
            key={rowKey(row, i)}
            className={cn(
              'rounded-xl border border-border bg-surface p-3 shadow-card',
              highlight?.(row) && 'border-primary/50 bg-primary-soft/30',
            )}
          >
            {title.map((c) => (
              <div key={c.key} className="text-sm font-semibold">
                {c.cell(row)}
              </div>
            ))}
            {subtitle.map((c) => (
              <div key={c.key} className="text-xs text-muted-foreground">
                {c.cell(row)}
              </div>
            ))}
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
              {values.map((c) => (
                <div key={c.key} className="min-w-0">
                  <dt className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                    {c.header}
                  </dt>
                  <dd className="truncate text-sm">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
        {hasTotals ? (
          <li className="rounded-xl border border-primary/30 bg-primary-soft/40 p-3">
            <div className="text-sm font-semibold">{totalLabel}</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
              {columns
                .filter((c) => c.total !== undefined)
                .map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                      {c.header}
                    </dt>
                    <dd className="truncate text-sm font-semibold">{c.total}</dd>
                  </div>
                ))}
            </dl>
          </li>
        ) : null}
      </ul>
    )
  }

  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-surface', className)}>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                scope="col"
                className={cn(c.align === 'right' && 'text-end', c.className, c.headClassName)}
              >
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow
              key={rowKey(row, i)}
              className={cn(highlight?.(row) && 'bg-primary-soft/30 font-medium')}
            >
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  className={cn(
                    dense ? 'py-1.5' : 'py-2',
                    c.align === 'right' && 'text-end tabular-nums',
                    c.className,
                  )}
                >
                  {c.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
        {hasTotals ? (
          <TableFooter>
            <TableRow>
              {columns.map((c, i) => (
                <TableCell
                  key={c.key}
                  className={cn('py-2.5', c.align === 'right' && 'text-end tabular-nums')}
                >
                  {c.total !== undefined ? c.total : i === 0 ? totalLabel : null}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
    </div>
  )
}
