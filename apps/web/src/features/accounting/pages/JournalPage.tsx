/**
 * Journal (/accounting/journal): every posted entry — sales, purchases, payments, expenses, shift
 * cash, manual JVs — with filters (dates, type, store, reversals, search) in the URL, totals of
 * the filtered set, print / CSV, and "New journal entry" (accounting.write). A row (or a source
 * link `?id=`) opens the entry drawer, where manual entries can be reversed.
 */
import { BookOpenText, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JournalSourceType } from '@kadai/shared'
import {
  type JournalEntry,
  type JournalListQuery,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { JournalSourceTypeSchema } from '@kadai/shared/enums'
import { StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  Kbd,
  PageHeader,
  SearchInput,
  Select,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useJournalEntries } from '../api'
import { ExportMenu } from '../components/ExportMenu'
import { FilterPanel } from '../components/FilterPanel'
import { JournalEntryDrawer } from '../components/JournalEntryDrawer'
import { ManualJournalDialog } from '../components/ManualJournalDialog'
import { SourceLink } from '../components/SourceLink'
import { ACCOUNTING_HOTKEY_SCOPE, sourceTone, sourceTypeLabel } from '../lib/labels'
import { printTable } from '../lib/print'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'

const SORTS = ['entry_date', 'created_at', 'number', 'total_paise'] as const
const PAGE_SIZES = [20, 50, 100, 200] as const
const TYPES = ['all', ...JournalSourceTypeSchema.options] as const
const REVERSALS = ['all', 'hide', 'only'] as const

export default function JournalPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const canWrite = useCan('accounting.write')
  const url = useUrlState()
  const [newOpen, setNewOpen] = useState(false)

  const month = tenant.range('this_month')
  const from = url.date('from', month.from)
  const to = url.date('to', month.to)
  const type = url.oneOf('type', TYPES, 'all')
  const storeId = url.id('store')
  const reversals = url.oneOf('reversals', REVERSALS, 'all')
  const q = url.get('q') ?? ''
  const sortRaw = url.get('sort')
  const sort =
    sortRaw && (SORTS as readonly string[]).includes(sortRaw.replace(/^-/, ''))
      ? sortRaw
      : '-entry_date'
  const limitParam = url.int('limit', 50)
  const limit = (PAGE_SIZES as readonly number[]).includes(limitParam) ? limitParam : 50
  const offset = url.int('offset', 0)
  const openId = url.id('id')

  const query: JournalListQuery = {
    from,
    to,
    limit,
    offset,
    sort,
    ...(type !== 'all' ? { source_type: [type as JournalSourceType] } : {}),
    ...(storeId ? { store_id: storeId } : {}),
    ...(reversals === 'hide'
      ? { reversals: false }
      : reversals === 'only'
        ? { reversals: true }
        : {}),
    ...(q ? { q } : {}),
  }
  const list = useJournalEntries(query)
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const filtered = Boolean(type !== 'all' || storeId || reversals !== 'all' || q)

  useHotkeyScope(ACCOUNTING_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) setNewOpen(true)
      },
    },
    { scope: ACCOUNTING_HOTKEY_SCOPE },
  )

  const columns = useMemo<DataTableColumn<JournalEntry>[]>(
    () => [
      {
        id: 'entry_date',
        accessorKey: 'entry_date',
        header: t('common:fields.date'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('common:fields.date') },
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">
            {formatDate(row.original.entry_date)}
          </span>
        ),
      },
      {
        id: 'number',
        accessorKey: 'number',
        header: t('journal.fields.voucher'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => {
          const e = row.original
          return (
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={sourceTone(e.source_type)} size="sm">
                  {sourceTypeLabel(e.source_type)}
                </Badge>
                {e.reversed_by_entry_id ? (
                  <Badge tone="danger" size="sm" appearance="outline">
                    {t('journal.reversed')}
                  </Badge>
                ) : null}
                {e.reverses_entry_id ? (
                  <Badge tone="warning" size="sm" appearance="outline">
                    {t('journal.reversal')}
                  </Badge>
                ) : null}
              </div>
              {e.number ? (
                <span className="text-sm font-medium tabular-nums">{e.number}</span>
              ) : (
                <SourceLink
                  type={e.source_type}
                  number={e.source_number}
                  path={e.source_path}
                  showType={false}
                />
              )}
            </div>
          )
        },
      },
      {
        id: 'particulars',
        header: t('journal.fields.particulars'),
        meta: { label: t('journal.fields.particulars') },
        cell: ({ row }) => {
          const e = row.original
          return (
            <div className="min-w-0 max-w-md text-sm">
              <div className="truncate">
                <span className="text-muted-foreground">{t('journal.dr_short')}</span>{' '}
                {e.debit_accounts.join(', ')}
              </div>
              <div className="truncate">
                <span className="text-muted-foreground">{t('journal.cr_short')}</span>{' '}
                {e.credit_accounts.join(', ')}
              </div>
              {e.narration ? (
                <div className="truncate text-xs text-muted-foreground">{e.narration}</div>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('fields.amount'),
        enableSorting: true,
        meta: { align: 'right', mobile: 'value', label: t('fields.amount') },
        cell: ({ row }) => (
          <span className="font-semibold tabular-nums">
            {formatMoney(row.original.total_paise)}
          </span>
        ),
      },
    ],
    [t],
  )

  const csv = () =>
    downloadRoute(accountingRoutes.listJournalEntries, {
      query: { ...query, format: 'csv', limit: undefined, offset: undefined },
      filename: `journal-${from}-${to}.csv`,
    })
  const print = () =>
    printTable({
      title: t('journal.title'),
      subtitle: t('print.period', { from: formatDate(from), to: formatDate(to) }),
      facts: [
        [t('journal.summary.count'), String(list.data?.summary.count ?? 0)],
        [t('journal.summary.total'), formatMoney(list.data?.summary.total_paise ?? 0)],
      ],
      columns: [
        { label: t('common:fields.date') },
        { label: t('journal.fields.voucher') },
        { label: t('journal.fields.particulars') },
        { label: t('fields.amount'), align: 'right' },
      ],
      rows: rows.map((e) => ({
        cells: [
          formatDate(e.entry_date),
          [sourceTypeLabel(e.source_type), e.number ?? e.source_number].filter(Boolean).join(' · '),
          `${t('journal.dr_short')} ${e.debit_accounts.join(', ')} / ${t('journal.cr_short')} ${e.credit_accounts.join(', ')}${e.narration ? ` — ${e.narration}` : ''}`,
          formatMoney(e.total_paise),
        ],
      })),
    })

  return (
    <div>
      <PageHeader
        title={t('journal.title')}
        description={t('journal.description')}
        actions={
          <>
            <ExportMenu onPrint={print} onCsv={csv} disabled={!rows.length} />
            {canWrite ? (
              <Button leftIcon={<Plus />} onClick={() => setNewOpen(true)}>
                {t('journal.new')}
                <Kbd
                  combo="alt+n"
                  className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
                />
              </Button>
            ) : null}
          </>
        }
      />

      <FilterPanel
        className="pb-3"
        activeCount={[type !== 'all', storeId, reversals !== 'all'].filter(Boolean).length}
        onReset={() => url.set({ type: null, store: null, reversals: null })}
        primary={
          <>
            <DateRangePicker
              value={{ from, to }}
              onChange={(r) => url.set({ from: r.from, to: r.to })}
              max={tenant.today}
            />
            <SearchInput
              value={q}
              onChange={(value) => url.set({ q: value })}
              placeholder={t('journal.search_placeholder')}
              wrapperClassName="sm:order-last sm:max-w-xs sm:flex-1"
            />
          </>
        }
      >
        <Select
          aria-label={t('journal.fields.type')}
          value={type}
          onValueChange={(v) => url.set({ type: v === 'all' ? null : v })}
          options={TYPES.map((v) => ({
            value: v,
            label: v === 'all' ? t('journal.filters.all_types') : sourceTypeLabel(v),
          }))}
          className="sm:w-52"
        />
        {tenant.multiStore ? (
          <StorePicker
            value={storeId ?? 'all'}
            onChange={(id) => url.set({ store: id && id !== 'all' ? id : null })}
            allowAll
            clearable={false}
            className="sm:w-52"
            aria-label={t('common:fields.store')}
          />
        ) : null}
        <Select
          aria-label={t('journal.filters.reversals')}
          value={reversals}
          onValueChange={(v) => url.set({ reversals: v === 'all' ? null : v })}
          options={REVERSALS.map((v) => ({ value: v, label: t(`journal.filters.reversals_${v}`) }))}
          className="sm:w-48"
        />
      </FilterPanel>

      {list.data ? (
        <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
          {t('journal.summary.line', {
            count: list.data.summary.count,
            amount: formatMoney(list.data.summary.total_paise),
          })}
        </p>
      ) : null}

      <DataTable
        label={t('journal.title')}
        columns={columns}
        data={rows}
        getRowId={(e) => e.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(e) => url.set({ id: e.id }, { push: true })}
        sort={sort}
        onSortChange={(s) => url.set({ sort: s && s !== '-entry_date' ? s : null })}
        pagination={
          page
            ? {
                ...page,
                pageSizeOptions: PAGE_SIZES,
                onChange: (next) =>
                  url.set({
                    offset: next.offset || null,
                    limit: next.limit === 50 ? null : next.limit,
                  }),
              }
            : undefined
        }
        renderCard={(e) => (
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={sourceTone(e.source_type)} size="sm">
                  {sourceTypeLabel(e.source_type)}
                </Badge>
                <span className="line-clamp-1 break-all text-sm font-medium tabular-nums">
                  {e.number ?? e.source_number}
                </span>
              </div>
              <div className="mt-0.5 line-clamp-1 break-words text-xs text-muted-foreground">
                {formatDate(e.entry_date)} · {e.debit_accounts[0] ?? ''} →{' '}
                {e.credit_accounts[0] ?? ''}
              </div>
              {e.narration ? (
                <div className="line-clamp-1 break-words text-xs text-muted-foreground">
                  {e.narration}
                </div>
              ) : null}
            </div>
            <div className="shrink-0 text-end">
              <div className="font-semibold tabular-nums">{formatMoney(e.total_paise)}</div>
              {e.reversed_by_entry_id ? (
                <Badge tone="danger" size="sm" appearance="outline">
                  {t('journal.reversed')}
                </Badge>
              ) : null}
            </div>
          </div>
        )}
        empty={
          <EmptyState
            compact
            icon={<BookOpenText />}
            title={filtered ? t('journal.none_filtered') : t('journal.empty_title')}
            description={t('journal.empty_description')}
            action={
              canWrite && !filtered ? (
                <Button leftIcon={<Plus />} onClick={() => setNewOpen(true)}>
                  {t('journal.new')}
                </Button>
              ) : undefined
            }
          />
        }
      />

      <ManualJournalDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSaved={(entry) => url.set({ id: entry.id }, { push: true })}
      />
      <JournalEntryDrawer
        entryId={openId}
        onClose={() => url.set({ id: null })}
        onOpenEntry={(id) => url.set({ id }, { push: true })}
      />
    </div>
  )
}
