/**
 * Day book (/accounting/day-book): every journal entry of one business day — bills, returns,
 * purchases, payments, expenses, shift cash, journal vouchers — each with its lines and a link to
 * the source document, plus the day's totals by type. Step a day back / forward (← / → keys),
 * filter by type and store, print or download CSV. An entry opens in the journal drawer.
 */
import { BookOpen, ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { JournalSourceType } from '@kadai/shared'
import {
  type DayBookQuery,
  type JournalEntryDetail,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { addDays, compareDates } from '@kadai/shared/fy'
import { StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  DatePicker,
  EmptyState,
  ErrorFallback,
  IconButton,
  PageHeader,
  Pagination,
  Skeleton,
  Stat,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney, formatTime } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useDayBook } from '../api'
import { ExportMenu } from '../components/ExportMenu'
import { JournalEntryDrawer } from '../components/JournalEntryDrawer'
import { SourceLink } from '../components/SourceLink'
import { ACCOUNTING_HOTKEY_SCOPE, accountLabel, sourceTone, sourceTypeLabel } from '../lib/labels'
import { type PrintRow, printTable } from '../lib/print'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'

const PAGE_SIZE = 100

export default function DayBookPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const url = useUrlState()
  const date = url.date('date', tenant.today)
  const storeId = url.id('store')
  const type = url.get('type') as JournalSourceType | null
  const offset = url.int('offset', 0)
  const openId = url.id('id')

  const query: DayBookQuery = {
    date,
    limit: PAGE_SIZE,
    offset,
    ...(storeId ? { store_id: storeId } : {}),
    ...(type ? { source_type: [type] } : {}),
  }
  const book = useDayBook(query)
  const entries = book.data?.data ?? []
  const day = book.data?.day
  const isToday = date === tenant.today

  const goto = (next: string) => {
    if (compareDates(next, tenant.today) > 0) return
    url.set({ date: next === tenant.today ? null : next })
  }

  useHotkeyScope(ACCOUNTING_HOTKEY_SCOPE)
  useHotkeys(
    { arrowleft: () => goto(addDays(date, -1)), arrowright: () => goto(addDays(date, 1)) },
    { scope: ACCOUNTING_HOTKEY_SCOPE },
  )

  const csv = () =>
    downloadRoute(accountingRoutes.dayBook, {
      query: { ...query, format: 'csv', limit: undefined, offset: undefined },
      filename: `day-book-${date}.csv`,
    })
  const print = () => {
    const rows: PrintRow[] = []
    for (const e of entries) {
      rows.push({
        kind: 'section',
        cells: [
          `${sourceTypeLabel(e.source_type)} ${e.source.number ?? e.number ?? ''}`.trim(),
          e.narration ?? '',
          '',
          '',
        ],
      })
      for (const l of e.lines) {
        rows.push({
          cells: [
            accountLabel({
              code: l.account_code,
              name: l.account_name,
              name_ta: l.account_name_ta,
            }),
            [l.party_name, l.memo].filter(Boolean).join(' · '),
            l.debit_paise ? formatMoney(l.debit_paise) : '',
            l.credit_paise ? formatMoney(l.credit_paise) : '',
          ],
        })
      }
    }
    if (day) {
      rows.push({
        kind: 'total',
        cells: [
          t('day_book.total'),
          '',
          formatMoney(day.total_debit_paise),
          formatMoney(day.total_credit_paise),
        ],
      })
    }
    return printTable({
      title: t('day_book.title'),
      subtitle: formatDate(date),
      columns: [
        { label: t('journal.fields.account') },
        { label: t('journal.fields.particulars') },
        { label: t('journal.fields.debit'), align: 'right' },
        { label: t('journal.fields.credit'), align: 'right' },
      ],
      rows,
    })
  }

  return (
    <div>
      <PageHeader
        title={t('day_book.title')}
        description={t('day_book.description')}
        actions={<ExportMenu onPrint={print} onCsv={csv} disabled={!entries.length} />}
      />

      <div className="flex flex-col gap-2 pb-4 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center gap-1">
          <IconButton
            icon={<ChevronLeft />}
            label={t('day_book.previous_day')}
            variant="outline"
            onClick={() => goto(addDays(date, -1))}
          />
          <DatePicker
            value={date}
            onChange={(d) => d && goto(d)}
            max={tenant.today}
            aria-label={t('common:fields.date')}
            className="w-40"
          />
          <IconButton
            icon={<ChevronRight />}
            label={t('day_book.next_day')}
            variant="outline"
            disabled={isToday}
            onClick={() => goto(addDays(date, 1))}
          />
          {!isToday ? (
            <Button variant="ghost" size="sm" onClick={() => goto(tenant.today)}>
              {t('common:dates.today')}
            </Button>
          ) : null}
        </div>
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
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat
          label={t('day_book.entries')}
          value={String(day?.entry_count ?? 0)}
          loading={book.isLoading}
        />
        <Stat
          label={t('day_book.total_debit')}
          value={formatMoney(day?.total_debit_paise ?? 0)}
          loading={book.isLoading}
        />
        <Stat
          label={t('day_book.total_credit')}
          value={formatMoney(day?.total_credit_paise ?? 0)}
          loading={book.isLoading}
          className="col-span-2 lg:col-span-1"
        />
      </div>

      {day && day.by_source_type.length > 0 ? (
        <div
          role="group"
          aria-label={t('day_book.by_type')}
          className="scrollbar-thin -mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1"
        >
          <TypeChip
            active={!type}
            onClick={() => url.set({ type: null })}
            label={t('day_book.all_types')}
            count={day.entry_count}
          />
          {day.by_source_type.map((s) => (
            <TypeChip
              key={s.source_type}
              active={type === s.source_type}
              onClick={() => url.set({ type: type === s.source_type ? null : s.source_type })}
              label={sourceTypeLabel(s.source_type)}
              count={s.count}
              amount={s.total_paise}
            />
          ))}
        </div>
      ) : null}

      {book.error ? (
        <ErrorFallback error={book.error} reset={() => void book.refetch()} />
      ) : book.isLoading ? (
        <div className="flex flex-col gap-3" aria-busy>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<BookOpen />}
            title={t('day_book.empty_title', { date: formatDate(date) })}
            description={t('day_book.empty_description')}
          />
        </div>
      ) : (
        <div className={cn('flex flex-col gap-3', book.isFetching && 'opacity-70')}>
          {entries.map((e) => (
            <DayBookEntry
              key={e.id}
              entry={e}
              onOpen={() => url.set({ id: e.id }, { push: true })}
            />
          ))}
          {book.data && book.data.page.total > PAGE_SIZE ? (
            <Pagination
              {...book.data.page}
              hidePageSize
              onChange={(next) => url.set({ offset: next.offset || null })}
            />
          ) : null}
        </div>
      )}

      <JournalEntryDrawer
        entryId={openId}
        onClose={() => url.set({ id: null })}
        onOpenEntry={(id) => url.set({ id }, { push: true })}
      />
    </div>
  )
}

function TypeChip({
  active,
  onClick,
  label,
  count,
  amount,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  amount?: number
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-surface hover:bg-surface-2',
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1.5 text-xs tabular-nums',
          active ? 'bg-primary-foreground/20' : 'bg-surface-2',
        )}
      >
        {count}
      </span>
      {amount !== undefined ? (
        <span
          className={cn(
            'text-xs tabular-nums',
            active ? 'text-primary-foreground/80' : 'text-muted-foreground',
          )}
        >
          {formatMoney(amount, { decimals: 'auto' })}
        </span>
      ) : null}
    </button>
  )
}

/** Party and line note, without repeating what the entry's narration already says. */
function lineNote(
  l: { party_name: string | null; memo: string | null },
  narration: string | null,
): string {
  const memo = l.memo && !(narration ?? '').includes(l.memo) ? l.memo : null
  return [l.party_name, memo].filter(Boolean).join(' · ')
}

function DayBookEntry({ entry, onOpen }: { entry: JournalEntryDetail; onOpen: () => void }) {
  const { t } = useTranslation(['accounting', 'common'])
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border bg-surface-2/50 px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTime(entry.created_at)}
            </span>
            <Badge tone={sourceTone(entry.source_type)} size="sm">
              {sourceTypeLabel(entry.source_type)}
            </Badge>
            <SourceLink
              type={entry.source.type}
              number={entry.source.number ?? entry.number}
              path={entry.source.path}
              showType={false}
            />
            {entry.reversed_by_entry_id ? (
              <Badge tone="danger" size="sm" appearance="outline">
                {t('journal.reversed')}
              </Badge>
            ) : null}
          </div>
          {entry.narration ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{entry.narration}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold tabular-nums">{formatMoney(entry.total_paise)}</span>
          <Button variant="ghost" size="sm" onClick={onOpen}>
            {t('common:actions.view')}
          </Button>
        </div>
      </div>
      <dl className="divide-y divide-border px-4">
        {entry.lines.map((l) => (
          <div key={l.id} className="flex items-baseline gap-3 py-1.5 text-sm">
            <dt className={cn('min-w-0 flex-1', l.credit_paise > 0 && 'ps-6')}>
              <span className="line-clamp-1 break-words">
                {l.credit_paise > 0 ? (
                  <span className="text-muted-foreground">{t('journal.to')} </span>
                ) : null}
                {accountLabel({
                  code: l.account_code,
                  name: l.account_name,
                  name_ta: l.account_name_ta,
                })}
              </span>
              {lineNote(l, entry.narration) ? (
                <span className="line-clamp-1 break-words text-xs text-muted-foreground">
                  {lineNote(l, entry.narration)}
                </span>
              ) : null}
            </dt>
            <dd className="shrink-0 text-end tabular-nums sm:hidden">
              {formatMoney(l.debit_paise || l.credit_paise)}
              <span className="ms-1 text-xs text-muted-foreground">
                {l.debit_paise > 0 ? t('common.dr') : t('common.cr')}
              </span>
            </dd>
            <dd className="hidden w-32 shrink-0 text-end tabular-nums sm:block">
              {l.debit_paise > 0 ? formatMoney(l.debit_paise) : ''}
            </dd>
            <dd className="hidden w-32 shrink-0 text-end tabular-nums sm:block">
              {l.credit_paise > 0 ? formatMoney(l.credit_paise) : ''}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
