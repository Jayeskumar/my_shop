/**
 * Expenses (/accounting/expenses): what the shop spent in a period — totals (spent, GST, input
 * credit), where the money went by category (tap a bar to filter), and the voucher list with
 * filters (dates, store, category, payment method, status, search) kept in the URL. "Add
 * expense" (Alt+N) opens the quick-add dialog; a row (or a book's source link, `?id=`) opens the
 * detail drawer with cancel.
 */
import { Plus, ReceiptIndianRupee } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExpensePaymentMethod, ExpenseStatus } from '@kadai/shared'
import { type Expense, type ExpenseListQuery, accountingRoutes } from '@kadai/shared/api/accounting'
import { ExpensePaymentMethodSchema } from '@kadai/shared/enums'
import { AccountPicker, StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  Kbd,
  PageHeader,
  SearchInput,
  Select,
  Stat,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useExpenses } from '../api'
import { CategoryTotalsChart } from '../components/CategoryTotalsChart'
import { ExpenseDetailDrawer } from '../components/ExpenseDetailDrawer'
import { ExpenseFormDialog } from '../components/ExpenseFormDialog'
import { ExportMenu } from '../components/ExportMenu'
import { FilterPanel } from '../components/FilterPanel'
import { ACCOUNTING_HOTKEY_SCOPE, accountName, expenseMethodLabel } from '../lib/labels'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'

const SORTS = ['expense_date', 'created_at', 'total_paise', 'number'] as const
const PAGE_SIZES = [20, 50, 100, 200] as const
const STATUSES = ['all', 'posted', 'cancelled'] as const
const METHODS = ['all', ...ExpensePaymentMethodSchema.options] as const

export default function ExpensesPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const canWrite = useCan('expenses.write')
  const url = useUrlState()
  const searchRef = useRef<HTMLInputElement>(null)
  const [addOpen, setAddOpen] = useState(false)

  const month = tenant.range('this_month')
  const from = url.date('from', month.from)
  const to = url.date('to', month.to)
  const storeId = url.id('store')
  const categoryId = url.id('cat')
  const method = url.oneOf('method', METHODS, 'all')
  const status = url.oneOf('status', STATUSES, 'all')
  const q = url.get('q') ?? ''
  const sortRaw = url.get('sort')
  const sort =
    sortRaw && (SORTS as readonly string[]).includes(sortRaw.replace(/^-/, ''))
      ? sortRaw
      : '-expense_date'
  const limit = (PAGE_SIZES as readonly number[]).includes(url.int('limit', 50))
    ? url.int('limit', 50)
    : 50
  const offset = url.int('offset', 0)
  const openId = url.id('id')

  const query: ExpenseListQuery = {
    from,
    to,
    limit,
    offset,
    sort,
    ...(storeId ? { store_id: storeId } : {}),
    ...(categoryId ? { expense_account_id: [categoryId] } : {}),
    ...(method !== 'all' ? { payment_method: [method as ExpensePaymentMethod] } : {}),
    ...(status !== 'all' ? { status: status as ExpenseStatus } : {}),
    ...(q ? { q } : {}),
  }
  const list = useExpenses(query)
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const summary = list.data?.summary
  const filtered = Boolean(storeId || categoryId || method !== 'all' || status !== 'all' || q)
  const firstRun =
    !filtered && !list.isLoading && !list.error && page?.total === 0 && summary?.count === 0

  useHotkeyScope(ACCOUNTING_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) setAddOpen(true)
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: ACCOUNTING_HOTKEY_SCOPE },
  )

  const columns = useMemo<DataTableColumn<Expense>[]>(
    () => [
      {
        id: 'expense_date',
        accessorKey: 'expense_date',
        header: t('common:fields.date'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('common:fields.date') },
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums">
            {formatDate(row.original.expense_date)}
          </span>
        ),
      },
      {
        id: 'category',
        header: t('expenses.fields.category'),
        meta: { mobile: 'title' },
        cell: ({ row }) => {
          const e = row.original
          return (
            <div className="min-w-0">
              <div
                className={
                  e.status === 'cancelled'
                    ? 'truncate font-medium line-through opacity-60'
                    : 'truncate font-medium'
                }
              >
                {accountName({ name: e.expense_account_name, name_ta: e.expense_account_name_ta })}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {[e.number, e.supplier_name, e.description].filter(Boolean).join(' · ')}
              </div>
            </div>
          )
        },
      },
      {
        id: 'payment_method',
        header: t('expenses.fields.paid_via'),
        meta: { label: t('expenses.fields.paid_via') },
        cell: ({ row }) => (
          <Badge tone={row.original.payment_method === 'credit' ? 'warning' : 'neutral'} size="sm">
            {expenseMethodLabel(row.original.payment_method)}
          </Badge>
        ),
      },
      {
        id: 'tax',
        header: t('expenses.fields.gst'),
        meta: { align: 'right', label: t('expenses.fields.gst'), mobile: 'hidden' },
        cell: ({ row }) =>
          row.original.tax_paise > 0 ? (
            <span className="tabular-nums text-sm">
              {formatMoney(row.original.tax_paise)}
              {row.original.itc_eligible ? (
                <Badge tone="success" size="sm" className="ms-1.5">
                  ITC
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('fields.amount'),
        enableSorting: true,
        meta: { align: 'right', mobile: 'value', label: t('fields.amount') },
        cell: ({ row }) => (
          <div className="flex flex-col items-end gap-0.5">
            <span
              className={
                row.original.status === 'cancelled'
                  ? 'font-semibold tabular-nums line-through opacity-60'
                  : 'font-semibold tabular-nums'
              }
            >
              {formatMoney(row.original.total_paise)}
            </span>
            {row.original.status === 'cancelled' ? (
              <Badge tone="danger" size="sm">
                {t('expenses.status.cancelled')}
              </Badge>
            ) : null}
          </div>
        ),
      },
    ],
    [t],
  )

  const csv = () =>
    downloadRoute(accountingRoutes.listExpenses, {
      query: { ...query, format: 'csv', limit: undefined, offset: undefined },
      filename: `expenses-${from}-${to}.csv`,
    })

  return (
    <div>
      <PageHeader
        title={t('expenses.title')}
        description={t('expenses.description')}
        actions={
          <>
            <ExportMenu onCsv={csv} disabled={!page?.total} />
            {canWrite ? (
              <Button leftIcon={<Plus />} onClick={() => setAddOpen(true)}>
                {t('expenses.add')}
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
        activeCount={
          [storeId, categoryId, method !== 'all', status !== 'all'].filter(Boolean).length
        }
        onReset={() => url.set({ store: null, cat: null, method: null, status: null })}
        primary={
          <>
            <DateRangePicker
              value={{ from, to }}
              onChange={(r) => url.set({ from: r.from, to: r.to })}
              max={tenant.today}
            />
            <SearchInput
              ref={searchRef}
              value={q}
              onChange={(value) => url.set({ q: value })}
              placeholder={t('expenses.search_placeholder')}
              wrapperClassName="sm:order-last sm:max-w-xs sm:flex-1"
            />
          </>
        }
      >
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
        <AccountPicker
          value={categoryId}
          onChange={(id) => url.set({ cat: id })}
          types={['expense']}
          includeInactive
          placeholder={t('expenses.filters.all_categories')}
          aria-label={t('expenses.fields.category')}
          className="sm:w-56"
        />
        <Select
          aria-label={t('expenses.fields.paid_via')}
          value={method}
          onValueChange={(m) => url.set({ method: m === 'all' ? null : m })}
          options={METHODS.map((m) => ({
            value: m,
            label: m === 'all' ? t('expenses.filters.all_methods') : expenseMethodLabel(m),
          }))}
          className="sm:w-48"
        />
        <Select
          aria-label={t('common:fields.status')}
          value={status}
          onValueChange={(s) => url.set({ status: s === 'all' ? null : s })}
          options={STATUSES.map((s) => ({
            value: s,
            label: s === 'all' ? t('expenses.filters.all_status') : t(`expenses.status.${s}`),
          }))}
          className="sm:w-40"
        />
      </FilterPanel>

      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<ReceiptIndianRupee />}
            title={t('expenses.empty_title')}
            description={t('expenses.empty_description')}
            action={
              canWrite ? (
                <Button leftIcon={<Plus />} onClick={() => setAddOpen(true)}>
                  {t('expenses.add_first')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={t('expenses.stats.total')}
              value={formatMoney(summary?.total_paise ?? 0)}
              hint={t('expenses.stats.count', { count: summary?.count ?? 0 })}
              loading={list.isLoading}
              tone="primary"
            />
            <Stat
              label={t('expenses.stats.taxable')}
              value={formatMoney(summary?.taxable_paise ?? 0)}
              loading={list.isLoading}
            />
            <Stat
              label={t('expenses.stats.gst')}
              value={formatMoney(summary?.tax_paise ?? 0)}
              loading={list.isLoading}
            />
            {tenant.canClaimItc ? (
              <Stat
                label={t('expenses.stats.itc')}
                value={formatMoney(summary?.itc_paise ?? 0)}
                hint={t('expenses.stats.itc_hint')}
                loading={list.isLoading}
              />
            ) : (
              <Stat
                label={t('expenses.stats.credit')}
                value={formatMoney(
                  summary?.by_method.find((m) => m.payment_method === 'credit')?.total_paise ?? 0,
                )}
                loading={list.isLoading}
              />
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
            <div className="order-2 min-w-0 lg:order-1">
              <DataTable
                label={t('expenses.title')}
                columns={columns}
                data={rows}
                getRowId={(e) => e.id}
                loading={list.isFetching}
                error={list.error}
                onRetry={() => void list.refetch()}
                onRowClick={(e) => url.set({ id: e.id }, { push: true })}
                sort={sort}
                onSortChange={(s) => url.set({ sort: s && s !== '-expense_date' ? s : null })}
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
                      <div
                        className={
                          e.status === 'cancelled'
                            ? 'line-clamp-1 break-words font-semibold line-through opacity-60'
                            : 'line-clamp-1 break-words font-semibold'
                        }
                      >
                        {accountName({
                          name: e.expense_account_name,
                          name_ta: e.expense_account_name_ta,
                        })}
                      </div>
                      <div className="line-clamp-1 break-words text-xs text-muted-foreground">
                        {[
                          formatDate(e.expense_date),
                          expenseMethodLabel(e.payment_method),
                          e.supplier_name ?? e.description,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <div className="shrink-0 text-end">
                      <div
                        className={
                          e.status === 'cancelled'
                            ? 'font-semibold tabular-nums line-through opacity-60'
                            : 'font-semibold tabular-nums'
                        }
                      >
                        {formatMoney(e.total_paise)}
                      </div>
                      {e.status === 'cancelled' ? (
                        <Badge tone="danger" size="sm">
                          {t('expenses.status.cancelled')}
                        </Badge>
                      ) : e.payment_method === 'credit' ? (
                        <Badge tone="warning" size="sm">
                          {expenseMethodLabel('credit')}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                )}
                empty={
                  <EmptyState
                    compact
                    icon={<ReceiptIndianRupee />}
                    title={t('expenses.none_title')}
                    description={t('expenses.none_hint')}
                  />
                }
              />
            </div>
            <Card className="order-1 p-4 lg:order-2">
              <h2 className="mb-3 text-sm font-semibold">{t('expenses.chart_title')}</h2>
              <CategoryTotalsChart
                summary={summary}
                loading={list.isLoading}
                selectedId={categoryId}
                onSelect={(id) => url.set({ cat: id })}
              />
              {summary && summary.by_method.length > 0 ? (
                <div className="mt-4 border-t border-border pt-3">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('expenses.by_method')}
                  </h3>
                  <ul className="flex flex-col gap-1 text-sm">
                    {summary.by_method.map((m) => (
                      <li key={m.payment_method} className="flex justify-between gap-2">
                        <span>
                          {expenseMethodLabel(m.payment_method)}
                          <span className="ms-1 text-xs text-muted-foreground">({m.count})</span>
                        </span>
                        <span className="tabular-nums">
                          {formatMoney(m.total_paise, { decimals: 'auto' })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          </div>
        </>
      )}

      <ExpenseFormDialog open={addOpen} onOpenChange={setAddOpen} defaultAccountId={categoryId} />
      <ExpenseDetailDrawer expenseId={openId} onClose={() => url.set({ id: null })} />
    </div>
  )
}
