/**
 * DataTable on TanStack Table v8 for server-driven lists.
 *
 *   const columns: DataTableColumn<Product>[] = [
 *     { accessorKey: 'name', header: t('catalog:product.name'), enableSorting: true, meta: { mobile: 'title' } },
 *     { accessorKey: 'sale_price_paise', header: t('catalog:product.price'),
 *       cell: (c) => <Money paise={c.getValue<number>()} />, meta: { align: 'right' } },
 *   ]
 *   <DataTable columns={columns} data={q.data?.data ?? []} loading={q.isFetching}
 *     error={q.error} onRetry={q.refetch} getRowId={(p) => p.id}
 *     pagination={{ ...q.data?.page, onChange }} sort={sort} onSortChange={setSort}
 *     onRowClick={(p) => navigate(p.id)} />
 *
 *  - Sorting and pagination are manual (the server sorts/pages): `sort` uses the API format
 *    ('name', '-created_at').
 *  - Below the md breakpoint rows render as stacked cards: column `meta.mobile` = 'title' |
 *    'subtitle' | 'value' (default) | 'hidden', or pass `renderCard`.
 */
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, CloudOff, SearchX } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useBreakpoint } from '@/lib/use-media-query'
import { Button } from './button'
import { Checkbox } from './checkbox'
import { EmptyState } from './empty-state'
import { Pagination } from './pagination'
import { Skeleton } from './skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table'
import { describeError } from '@/lib/errors'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- generic names fixed by TanStack
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: 'left' | 'right' | 'center'
    /** Extra classes for body cells / header cell. */
    className?: string
    headerClassName?: string
    /** Mobile card role (default 'value'). */
    mobile?: 'title' | 'subtitle' | 'value' | 'hidden'
    /** Label used in mobile cards when `header` is not a string. */
    label?: string
  }
}

// TanStack column value types differ per column (string, number, …); `any` here is the
// library's own recommended column array type and does not leak into row data.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataTableColumn<T> = ColumnDef<T, any>

export interface DataTablePagination {
  offset: number
  limit: number
  total: number
  onChange: (next: { offset: number; limit: number }) => void
  pageSizeOptions?: readonly number[]
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  data: readonly T[]
  getRowId: (row: T) => string
  /** First load shows skeleton rows; refetches dim the rows. */
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  /** Custom empty state (default: "No results"). */
  empty?: ReactNode
  onRowClick?: (row: T) => void
  pagination?: DataTablePagination
  /** API sort string: 'name' / '-created_at' / null. */
  sort?: string | null
  onSortChange?: (sort: string | null) => void
  /** Checkbox selection (bulk actions). */
  selection?: { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void }
  renderCard?: (row: T) => ReactNode
  density?: 'comfortable' | 'compact'
  /** Accessible table name. */
  label?: string
  className?: string
  skeletonRows?: number
}

function toSorting(sort: string | null | undefined): SortingState {
  if (!sort) return []
  return sort.startsWith('-') ? [{ id: sort.slice(1), desc: true }] : [{ id: sort, desc: false }]
}

function fromSorting(state: SortingState): string | null {
  const first = state[0]
  if (!first) return null
  return first.desc ? `-${first.id}` : first.id
}

const alignClass = (align: 'left' | 'right' | 'center' | undefined): string | undefined =>
  align === 'right' ? 'text-end' : align === 'center' ? 'text-center' : undefined

export function DataTable<T>({
  columns,
  data,
  getRowId,
  loading = false,
  error,
  onRetry,
  empty,
  onRowClick,
  pagination,
  sort,
  onSortChange,
  selection,
  renderCard,
  density = 'comfortable',
  label,
  className,
  skeletonRows,
}: DataTableProps<T>) {
  const { t } = useTranslation()
  const desktop = useBreakpoint('md')
  const sorting = useMemo(() => toSorting(sort), [sort])

  const rowSelection = useMemo<RowSelectionState>(() => {
    const out: RowSelectionState = {}
    selection?.selected.forEach((id) => {
      out[id] = true
    })
    return out
  }, [selection?.selected])

  const allColumns = useMemo<DataTableColumn<T>[]>(() => {
    if (!selection) return columns
    const select: DataTableColumn<T> = {
      id: '__select',
      enableSorting: false,
      meta: { mobile: 'hidden', className: 'w-10', headerClassName: 'w-10' },
      header: ({ table }) => (
        <Checkbox
          aria-label={t('actions.select')}
          checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? 'indeterminate' : false}
          onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={t('actions.select')}
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(v === true)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    }
    return [select, ...columns]
  }, [columns, selection, t])

  const table = useReactTable<T>({
    data: data as T[],
    columns: allColumns,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    enableSortingRemoval: true,
    enableMultiSort: false,
    state: { sorting, rowSelection },
    onSortingChange: (updater: Updater<SortingState>) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater
      onSortChange?.(fromSorting(next))
    },
    enableRowSelection: Boolean(selection),
    onRowSelectionChange: (updater: Updater<RowSelectionState>) => {
      if (!selection) return
      const next = typeof updater === 'function' ? updater(rowSelection) : updater
      selection.onChange(new Set(Object.keys(next).filter((k) => next[k])))
    },
  })

  const rows = table.getRowModel().rows
  const firstLoad = loading && data.length === 0
  const cellPad = density === 'compact' ? 'py-1.5' : 'py-2.5'
  const skeletonCount = skeletonRows ?? Math.min(pagination?.limit ?? 8, 8)

  const errorDisplay = error && !loading ? describeError(error) : null
  const errorPanel = errorDisplay ? (
    <EmptyState
      compact
      icon={<CloudOff />}
      title={errorDisplay.title}
      description={errorDisplay.description}
      action={onRetry ? <RetryButton onRetry={onRetry} /> : undefined}
    />
  ) : null

  const emptyPanel = !firstLoad && !error && data.length === 0 ? (
    empty ?? (
      <EmptyState compact icon={<SearchX />} title={t('empty.no_results')} description={t('empty.no_results_hint')} />
    )
  ) : null

  const content = desktop ? (
    <Table aria-label={label} aria-busy={loading || undefined}>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => {
              const meta = header.column.columnDef.meta
              const canSort = header.column.getCanSort() && Boolean(onSortChange)
              const dir = header.column.getIsSorted()
              const content = header.isPlaceholder
                ? null
                : flexRender(header.column.columnDef.header, header.getContext())
              return (
                <TableHead
                  key={header.id}
                  className={cn(alignClass(meta?.align), meta?.headerClassName)}
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                  style={header.column.columnDef.size ? { width: header.getSize() } : undefined}
                >
                  {canSort ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase hover:text-foreground',
                        meta?.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {content}
                      {dir === 'asc' ? (
                        <ArrowUp className="size-3.5" />
                      ) : dir === 'desc' ? (
                        <ArrowDown className="size-3.5" />
                      ) : (
                        <ArrowUpDown className="size-3.5 opacity-40" />
                      )}
                    </button>
                  ) : (
                    content
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody className={cn(loading && !firstLoad && 'opacity-60 transition-opacity')}>
        {firstLoad
          ? Array.from({ length: skeletonCount }, (_, i) => (
              <TableRow key={`sk-${i}`}>
                {table.getVisibleLeafColumns().map((col) => (
                  <TableCell key={col.id} className={cellPad}>
                    <Skeleton className="h-4 w-full max-w-40" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? 'selected' : undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter') onRowClick(row.original)
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                className={cn(onRowClick && 'cursor-pointer hover:bg-surface-2/70 focus-visible:bg-surface-2 focus-visible:outline-none')}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta
                  return (
                    <TableCell key={cell.id} className={cn(cellPad, alignClass(meta?.align), meta?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
      </TableBody>
    </Table>
  ) : (
    <ul aria-label={label} aria-busy={loading || undefined} className={cn('grid gap-2 p-2', loading && !firstLoad && 'opacity-60')}>
      {firstLoad
        ? Array.from({ length: Math.min(skeletonCount, 5) }, (_, i) => (
            <li key={`sk-${i}`} className="rounded-lg border border-border p-3">
              <Skeleton className="mb-2 h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </li>
          ))
        : rows.map((row) => {
            const cells = row.getVisibleCells()
            const body = renderCard ? (
              renderCard(row.original)
            ) : (
              <>
                {cells
                  .filter((c) => c.column.columnDef.meta?.mobile === 'title')
                  .map((c) => (
                    <div key={c.id} className="text-sm font-semibold text-foreground">
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </div>
                  ))}
                {cells
                  .filter((c) => c.column.columnDef.meta?.mobile === 'subtitle')
                  .map((c) => (
                    <div key={c.id} className="text-xs text-muted-foreground">
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </div>
                  ))}
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {cells
                    .filter((c) => {
                      const m = c.column.columnDef.meta?.mobile ?? 'value'
                      return m === 'value' && c.column.id !== '__select'
                    })
                    .map((c) => {
                      const header = c.column.columnDef.header
                      const labelText =
                        c.column.columnDef.meta?.label ?? (typeof header === 'string' ? header : c.column.id)
                      return (
                        <div key={c.id} className="min-w-0">
                          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{labelText}</dt>
                          <dd className="truncate text-sm">{flexRender(c.column.columnDef.cell, c.getContext())}</dd>
                        </div>
                      )
                    })}
                </dl>
              </>
            )
            return (
              <li key={row.id}>
                <div
                  role={onRowClick ? 'button' : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter') onRowClick(row.original)
                        }
                      : undefined
                  }
                  className={cn(
                    'flex gap-3 rounded-lg border border-border bg-surface p-3',
                    onRowClick && 'cursor-pointer active:bg-surface-2',
                    row.getIsSelected() && 'border-primary bg-primary-soft/40',
                  )}
                >
                  {selection ? (
                    <Checkbox
                      aria-label={t('actions.select')}
                      checked={row.getIsSelected()}
                      onCheckedChange={(v) => row.toggleSelected(v === true)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">{body}</div>
                </div>
              </li>
            )
          })}
    </ul>
  )

  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-surface shadow-card', className)}>
      {loading && !firstLoad ? <div className="h-0.5 w-full animate-shimmer bg-primary" aria-hidden /> : null}
      {errorPanel ?? (
        <>
          {data.length > 0 || firstLoad ? content : null}
          {emptyPanel}
        </>
      )}
      {pagination && !errorPanel && (pagination.total > 0 || pagination.offset > 0) ? (
        <div className="border-t border-border px-3">
          <Pagination
            offset={pagination.offset}
            limit={pagination.limit}
            total={pagination.total}
            onChange={pagination.onChange}
            pageSizeOptions={pagination.pageSizeOptions}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Small helper for "Retry" in custom empty/error states. */
export function RetryButton({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <Button variant="outline" size="sm" onClick={onRetry}>
      {t('actions.retry')}
    </Button>
  )
}
