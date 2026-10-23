/**
 * Purchase returns (/purchases/returns): debit notes with reason and settlement. Quick filters
 * (all, active, expiry returns, refunds, cancelled), search by number / bill / supplier invoice /
 * supplier, supplier / store / date filters; totals cover the whole filtered range.
 */
import type { DebitNoteListRow } from '@kadai/shared/api/purchases'
import { Plus, Undo2 } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Kbd,
  Money,
  PageHeader,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useDebitNotes } from '../api'
import { ListFilters } from '../components/ListFilters'
import { DebitNoteStatusBadge } from '../components/StatusBadges'
import { PURCHASES_HOTKEY_SCOPE } from '../lib/labels'
import { RETURN_FILTERS, type ReturnFilter, returnFilterQuery } from '../lib/list-filters'
import { LIST_PAGE_SIZES, useListState } from '../lib/url-state'

const FILTERS = RETURN_FILTERS
const SORTS = ['note_date', 'number', 'total_paise', 'created_at'] as const

export default function ReturnsPage() {
  const { t } = useTranslation(['purchases', 'common'])
  const navigate = useNavigate()
  const canWrite = useCan('purchases.write')
  const searchRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useListState<ReturnFilter>({
    filter: 'all',
    filters: FILTERS,
    sort: '-note_date',
    sorts: SORTS,
  })
  const list = useDebitNotes({
    limit: state.limit,
    offset: state.offset,
    sort: state.sort,
    ...(state.q ? { q: state.q } : {}),
    ...(state.supplier_id ? { supplier_id: state.supplier_id } : {}),
    ...(state.store_id ? { store_id: state.store_id } : {}),
    ...(state.from && state.to ? { from: state.from, to: state.to } : {}),
    ...returnFilterQuery(state.filter),
  })
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const summary = list.data?.summary
  const filtered =
    state.filter !== 'all' || Boolean(state.q || state.supplier_id || state.from || state.store_id)

  useHotkeyScope(PURCHASES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) navigate('/purchases/returns/new')
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: PURCHASES_HOTKEY_SCOPE },
  )

  const columns = useMemo<DataTableColumn<DebitNoteListRow>[]>(
    () => [
      {
        id: 'number',
        accessorKey: 'number',
        header: t('returns.col_number'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <span className="font-medium tabular-nums">{row.original.number}</span>
            <DebitNoteStatusBadge status={row.original.status} />
          </div>
        ),
      },
      {
        id: 'supplier',
        header: t('bills.col_supplier'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.supplier_name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.bill_number
                ? t('returns.against', {
                    number: row.original.bill_number,
                    no: row.original.supplier_invoice_no ?? '—',
                  })
                : t('returns.without_bill')}
            </div>
          </div>
        ),
      },
      {
        id: 'note_date',
        accessorKey: 'note_date',
        header: t('returns.note_date'),
        enableSorting: true,
        meta: { label: t('returns.note_date') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.note_date)}</span>
        ),
      },
      {
        id: 'reason',
        header: t('returns.reason'),
        meta: { label: t('returns.reason') },
        cell: ({ row }) => (
          <div className="text-sm">
            <div>{t(`reasons.${row.original.reason}`)}</div>
            <div className="text-xs text-muted-foreground">
              {t(`settlement.${row.original.settlement}`)}
            </div>
          </div>
        ),
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('totals.total'),
        enableSorting: true,
        meta: { align: 'right', mobile: 'value', label: t('totals.total') },
        cell: ({ row }) => (
          <Money
            paise={row.original.total_paise}
            className={
              row.original.status === 'cancelled'
                ? 'text-muted-foreground line-through'
                : 'font-medium'
            }
          />
        ),
      },
    ],
    [t],
  )

  const chips = FILTERS.map((key) => ({ key, label: t(`returns.filter_${key}`) }))
  const firstRun = !filtered && !list.isLoading && !list.error && page?.total === 0

  return (
    <div>
      <PageHeader
        title={t('returns.title')}
        description={
          summary && summary.count > 0
            ? t('returns.summary', {
                count: summary.count,
                amount: formatMoney(summary.total_paise),
              })
            : t('returns.description')
        }
        actions={
          canWrite ? (
            <Button leftIcon={<Plus />} onClick={() => navigate('/purchases/returns/new')}>
              {t('returns.new')}
              <Kbd
                combo="alt+n"
                className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
              />
            </Button>
          ) : null
        }
      />
      <ListFilters
        state={state}
        onChange={setState}
        defaultFilter="all"
        chips={chips}
        searchRef={searchRef}
        searchPlaceholder={t('returns.search_placeholder')}
        dateLabel={t('returns.note_date')}
      />
      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<Undo2 />}
            title={t('returns.empty_title')}
            description={t('returns.empty_description')}
            action={
              canWrite ? (
                <Button leftIcon={<Plus />} onClick={() => navigate('/purchases/returns/new')}>
                  {t('returns.new')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <DataTable
          label={t('returns.title')}
          columns={columns}
          data={rows}
          getRowId={(n) => n.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(n) => navigate(`/purchases/returns/${n.id}`)}
          sort={state.sort}
          onSortChange={(sort) => setState({ sort: sort ?? '-note_date' })}
          pagination={
            page
              ? {
                  ...page,
                  pageSizeOptions: LIST_PAGE_SIZES,
                  onChange: ({ offset, limit }) => setState({ offset, limit }),
                }
              : undefined
          }
          renderCard={(n) => (
            <div className="grid min-w-0 gap-1.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{n.supplier_name}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {n.number} · {formatDate(n.note_date)}
                  </div>
                </div>
                <Money paise={n.total_paise} className="shrink-0 font-semibold" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t(`reasons.${n.reason}`)} · {t(`settlement.${n.settlement}`)}
                </span>
                <DebitNoteStatusBadge status={n.status} />
              </div>
            </div>
          )}
          empty={
            <EmptyState
              compact
              icon={<Undo2 />}
              title={t(`returns.none_${state.filter}`)}
              description={t('bills.none_hint')}
            />
          }
        />
      )}
    </div>
  )
}
