/**
 * Sales invoices (/sales/invoices): period presets (today by default), search by bill number /
 * customer name / mobile, filters (store, counter, status, payment, document type, customer,
 * offline bills), totals of the whole filtered range, CSV export with the same filters. State is
 * kept in the URL; rows open the invoice; below md the table becomes cards.
 */
import { CloudOff, ReceiptIndianRupee, ScanLine, SearchX } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import {
  type InvoiceListQuery,
  type SalesInvoiceListRow,
  salesRoutes,
} from '@kadai/shared/api/sales'
import type { SalesInvoiceStatus, SalesPaymentStatus } from '@kadai/shared/enums'
import { CustomerPicker, RegisterPicker, StorePicker } from '@/components/pickers'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  FormField,
  Money,
  PageHeader,
  SearchInput,
  Select,
  Switch,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan, useFeature, useMe } from '@/lib/auth'
import { formatDate, formatPhone, formatTime } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useInvoices } from '../api'
import { ExportButton } from '../components/ExportButton'
import { ActiveFilterChips, type ActiveFilter, FilterDrawer } from '../components/FilterDrawer'
import { PeriodFilter } from '../components/PeriodFilter'
import {
  DocTypeBadge,
  InvoiceStatusBadge,
  OfflineBadge,
  PaymentStatusBadge,
} from '../components/StatusBadges'
import { SummaryTiles } from '../components/SummaryTiles'
import { docTypeLabel } from '../lib/labels'
import { periodPatch, periodRange } from '../lib/period'
import { LIST_PAGE_SIZES, oneOf, pageOf, useSearchState } from '../lib/search-state'
import { useTenantCalendar } from '../lib/use-tenant-calendar'

const STATUS_FILTERS = ['', 'completed', 'cancelled', 'held_draft'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]
const PAY_FILTERS = ['', 'due', 'unpaid', 'partial', 'paid', 'refunded'] as const
type PayFilter = (typeof PAY_FILTERS)[number]
const DOC_FILTERS = ['', 'tax_invoice', 'bill_of_supply'] as const
const SORTS = ['invoice_at', 'invoice_date', 'number', 'total_paise', 'due_paise', 'created_at']

const DEFAULTS = {
  q: '',
  period: 'today',
  from: '',
  to: '',
  store: '',
  register: '',
  status: '',
  pay: '',
  doc: '',
  customer: '',
  customer_name: '',
  offline: '',
  sort: '-invoice_at',
} as const

export const HOTKEY_SCOPE = 'sales-list'

function statusQuery(filter: StatusFilter): SalesInvoiceStatus[] | undefined {
  switch (filter) {
    case 'completed':
      return ['completed']
    case 'cancelled':
      return ['cancelled']
    case 'held_draft':
      return ['held', 'draft']
    case '':
      return undefined
  }
}

function payQuery(filter: PayFilter): Pick<InvoiceListQuery, 'payment_status' | 'has_due'> {
  if (filter === '') return {}
  if (filter === 'due') return { has_due: true }
  return { payment_status: [filter satisfies SalesPaymentStatus] }
}

export default function InvoicesPage() {
  const { t, i18n } = useTranslation(['sales', 'common'])
  const navigate = useNavigate()
  const me = useMe()
  const { ctx } = useTenantCalendar()
  const searchRef = useRef<HTMLInputElement>(null)
  const posAllowed = useCan('pos.use')
  const posInPlan = useFeature('pos')
  const canPos = posAllowed && posInPlan
  const [state, setState] = useSearchState(DEFAULTS)
  const page = pageOf(state)
  const range = periodRange(state, ctx)
  const status = oneOf(state.status, STATUS_FILTERS, '')
  const pay = oneOf(state.pay, PAY_FILTERS, '')
  const doc = oneOf(state.doc, DOC_FILTERS, '')
  const sort = SORTS.includes(state.sort.replace(/^-/, '')) ? state.sort : DEFAULTS.sort
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1

  const filterQuery: InvoiceListQuery = {
    ...(state.q ? { q: state.q } : {}),
    ...(range ? { from: range.from, to: range.to } : {}),
    ...(state.store ? { store_id: state.store } : {}),
    ...(state.register ? { register_id: state.register } : {}),
    ...(statusQuery(status) ? { status: statusQuery(status) } : {}),
    ...payQuery(pay),
    ...(doc ? { doc_type: [doc] } : {}),
    ...(state.customer ? { customer_id: state.customer } : {}),
    ...(state.offline === '1' ? { offline: true } : {}),
    sort,
  }
  const list = useInvoices({ ...filterQuery, limit: page.limit, offset: page.offset })
  const rows = list.data?.data ?? []
  const summary = list.data?.summary

  useHotkeyScope(HOTKEY_SCOPE)
  useHotkeys({ '/': () => searchRef.current?.focus() }, { scope: HOTKEY_SCOPE })

  const active: ActiveFilter[] = []
  if (state.store) {
    const store = me?.stores.find((s) => s.id === state.store)
    active.push({
      key: 'store',
      label: t('filters.chip_store', { name: store ? `${store.code} · ${store.name}` : '…' }),
      onRemove: () => setState({ store: '', register: '' }),
    })
  }
  if (state.register) {
    const reg = me?.registers.find((r) => r.id === state.register)
    active.push({
      key: 'register',
      label: t('filters.chip_register', { name: reg ? reg.name : '…' }),
      onRemove: () => setState({ register: '' }),
    })
  }
  if (status) {
    active.push({
      key: 'status',
      label: t(`filters.status_${status}`),
      onRemove: () => setState({ status: '' }),
    })
  }
  if (pay) {
    active.push({
      key: 'pay',
      label: t(`filters.pay_${pay}`),
      onRemove: () => setState({ pay: '' }),
    })
  }
  if (doc) {
    active.push({
      key: 'doc',
      label: docTypeLabel(doc, i18n.language),
      onRemove: () => setState({ doc: '' }),
    })
  }
  if (state.customer) {
    active.push({
      key: 'customer',
      label: t('filters.chip_customer', { name: state.customer_name || '…' }),
      onRemove: () => setState({ customer: '', customer_name: '' }),
    })
  }
  if (state.offline === '1') {
    active.push({
      key: 'offline',
      label: t('filters.offline_only'),
      onRemove: () => setState({ offline: '' }),
    })
  }

  const resetFilters = (): void =>
    setState({
      store: '',
      register: '',
      status: '',
      pay: '',
      doc: '',
      customer: '',
      customer_name: '',
      offline: '',
    })

  const columns = useMemo<DataTableColumn<SalesInvoiceListRow>[]>(
    () => [
      {
        id: 'number',
        accessorKey: 'number',
        header: t('invoices.col_number'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => <NumberCell row={row.original} />,
      },
      {
        id: 'invoice_at',
        accessorKey: 'invoice_at',
        header: t('invoices.col_date'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('invoices.col_date') },
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm">
            {formatDate(row.original.invoice_date)}
            <span className="ms-1.5 text-muted-foreground">
              {formatTime(row.original.invoice_at, me?.tenant.timezone)}
            </span>
          </span>
        ),
      },
      {
        id: 'customer',
        header: t('invoices.col_customer'),
        enableSorting: false,
        meta: { label: t('invoices.col_customer') },
        cell: ({ row }) => <CustomerCell row={row.original} />,
      },
      {
        id: 'items',
        accessorKey: 'item_count',
        header: t('invoices.col_items'),
        enableSorting: false,
        meta: { align: 'right', label: t('invoices.col_items') },
        cell: ({ row }) => <span className="tabular-nums">{row.original.item_count}</span>,
      },
      {
        id: 'total_paise',
        accessorKey: 'total_paise',
        header: t('invoices.col_total'),
        enableSorting: true,
        meta: { align: 'right', label: t('invoices.col_total') },
        cell: ({ row }) => (
          <Money
            paise={row.original.total_paise}
            className={
              row.original.status === 'cancelled' ? 'line-through opacity-60' : 'font-medium'
            }
          />
        ),
      },
      {
        id: 'due_paise',
        accessorKey: 'due_paise',
        header: t('invoices.col_paid_due'),
        enableSorting: true,
        meta: { align: 'right', label: t('invoices.col_paid_due') },
        cell: ({ row }) => <PaidDueCell row={row.original} />,
      },
      {
        id: 'payment_status',
        header: t('invoices.col_payment'),
        enableSorting: false,
        meta: { label: t('invoices.col_payment') },
        cell: ({ row }) =>
          row.original.status === 'completed' ? (
            <PaymentStatusBadge status={row.original.payment_status} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: t('invoices.col_status'),
        enableSorting: false,
        meta: { label: t('invoices.col_status') },
        cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} />,
      },
    ],
    [t, me?.tenant.timezone],
  )

  const defaultView =
    !state.q && active.length === 0 && state.period === DEFAULTS.period && page.offset === 0
  const nothing = !list.isLoading && !list.error && list.data?.page.total === 0

  return (
    <div>
      <PageHeader
        title={t('invoices.title')}
        description={t('invoices.description')}
        actions={
          <>
            <ExportButton
              download={() =>
                downloadRoute(salesRoutes.listInvoices, {
                  query: { ...filterQuery, format: 'csv' },
                  filename: 'bills.csv',
                })
              }
            />
          </>
        }
      />

      <div className="flex flex-col gap-3 pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <SearchInput
            ref={searchRef}
            value={state.q}
            onChange={(q) => setState({ q })}
            placeholder={t('invoices.search_placeholder')}
            wrapperClassName="sm:max-w-sm sm:flex-1"
          />
          <div className="flex flex-wrap items-center gap-2">
            <PeriodFilter value={range} onChange={(r) => setState(periodPatch(r, ctx))} />
            <FilterDrawer activeCount={active.length} onReset={resetFilters}>
              {multiStore ? (
                <FormField label={t('filters.store')}>
                  <StorePicker
                    value={state.store || null}
                    onChange={(id) => setState({ store: id ?? '', register: '' })}
                  />
                </FormField>
              ) : null}
              <FormField label={t('filters.register')}>
                <RegisterPicker
                  value={state.register || null}
                  storeId={state.store || null}
                  onChange={(id) => setState({ register: id ?? '' })}
                />
              </FormField>
              <FormField label={t('filters.status')}>
                <Select
                  value={status}
                  onValueChange={(v) => setState({ status: v })}
                  options={STATUS_FILTERS.map((s) => ({
                    value: s,
                    label: s ? t(`filters.status_${s}`) : t('filters.status_all'),
                  }))}
                />
              </FormField>
              <FormField label={t('filters.payment')}>
                <Select
                  value={pay}
                  onValueChange={(v) => setState({ pay: v })}
                  options={PAY_FILTERS.map((p) => ({
                    value: p,
                    label: p ? t(`filters.pay_${p}`) : t('filters.pay_all'),
                  }))}
                />
              </FormField>
              <FormField label={t('filters.doc_type')}>
                <Select
                  value={doc}
                  onValueChange={(v) => setState({ doc: v })}
                  options={DOC_FILTERS.map((d) => ({
                    value: d,
                    label: d ? docTypeLabel(d, i18n.language) : t('filters.doc_all'),
                  }))}
                />
              </FormField>
              <FormField label={t('filters.customer')}>
                <CustomerPicker
                  value={state.customer ? { id: state.customer, name: state.customer_name } : null}
                  onChange={(c) =>
                    setState({ customer: c?.id ?? '', customer_name: c?.name ?? '' })
                  }
                />
              </FormField>
              <Switch
                checked={state.offline === '1'}
                onCheckedChange={(on) => setState({ offline: on ? '1' : '' })}
                label={t('filters.offline_only')}
                description={t('filters.offline_hint')}
              />
            </FilterDrawer>
          </div>
        </div>
        <ActiveFilterChips filters={active} />
      </div>

      <SummaryTiles
        label={t('invoices.summary_label')}
        loading={list.isLoading}
        tiles={[
          { key: 'count', label: t('summary.bills'), value: summary?.count ?? 0, count: true },
          { key: 'total', label: t('summary.sales'), value: summary?.total_paise ?? 0 },
          {
            key: 'paid',
            label: t('summary.collected'),
            value: summary?.paid_paise ?? 0,
            tone: 'success',
          },
          { key: 'due', label: t('summary.due'), value: summary?.due_paise ?? 0, tone: 'danger' },
          {
            key: 'returned',
            label: t('summary.returns'),
            value: summary?.returned_paise ?? 0,
            tone: 'muted',
          },
          { key: 'tax', label: t('summary.gst'), value: summary?.tax_paise ?? 0, tone: 'muted' },
        ]}
      />

      <DataTable
        label={t('invoices.title')}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(r) => navigate(`/sales/invoices/${r.id}`)}
        sort={sort}
        onSortChange={(s) => setState({ sort: s ?? DEFAULTS.sort })}
        pagination={
          list.data
            ? {
                ...list.data.page,
                pageSizeOptions: LIST_PAGE_SIZES,
                onChange: ({ offset, limit }) =>
                  setState({ offset: String(offset), limit: String(limit) }),
              }
            : undefined
        }
        renderCard={(r) => <InvoiceCard row={r} />}
        empty={
          nothing && defaultView ? (
            <EmptyState
              icon={<ReceiptIndianRupee />}
              title={t('invoices.empty_today_title')}
              description={t('invoices.empty_today_description')}
              action={
                <>
                  {canPos ? (
                    <Button asChild leftIcon={<ScanLine />}>
                      <Link to="/pos">{t('invoices.open_pos')}</Link>
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => setState({ period: 'this_month' })}>
                    {t('invoices.show_this_month')}
                  </Button>
                </>
              }
            />
          ) : (
            <EmptyState
              compact
              icon={state.offline === '1' ? <CloudOff /> : <SearchX />}
              title={t('invoices.none_title')}
              description={t('invoices.none_hint')}
              action={
                <>
                  {range ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setState(periodPatch(null, ctx))}
                    >
                      {t('filters.search_all_dates')}
                    </Button>
                  ) : null}
                  {active.length > 0 ? (
                    <Button variant="ghost" size="sm" onClick={resetFilters}>
                      {t('common:actions.clear_filters')}
                    </Button>
                  ) : null}
                </>
              }
            />
          )
        }
      />
    </div>
  )
}

function NumberCell({ row }: { row: SalesInvoiceListRow }) {
  const { t } = useTranslation('sales')
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Link
        to={`/sales/invoices/${row.id}`}
        className="truncate font-medium text-foreground hover:text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {row.number ?? t(`invoice_status.${row.status}`)}
      </Link>
      <div className="flex flex-wrap items-center gap-1">
        {row.doc_type === 'bill_of_supply' ? <DocTypeBadge docType={row.doc_type} /> : null}
        {row.offline ? <OfflineBadge /> : null}
        {row.register_code ? (
          <span className="text-xs text-muted-foreground">
            {t('invoices.counter', { code: `${row.store_code}-${row.register_code}` })}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function CustomerCell({ row }: { row: SalesInvoiceListRow }) {
  const { t } = useTranslation(['sales', 'common'])
  if (!row.customer_name) {
    return <span className="text-muted-foreground">{t('common:misc.walk_in')}</span>
  }
  return (
    <div className="min-w-0">
      <div className="truncate">{row.customer_name}</div>
      {row.customer_phone ? (
        <div className="truncate text-xs text-muted-foreground tabular-nums">
          {formatPhone(row.customer_phone)}
        </div>
      ) : null}
    </div>
  )
}

function PaidDueCell({ row }: { row: SalesInvoiceListRow }) {
  const { t } = useTranslation('sales')
  if (row.status !== 'completed') return <span className="text-muted-foreground">—</span>
  if (row.due_paise > 0) {
    return (
      <div className="flex flex-col items-end whitespace-nowrap">
        <span className="font-medium text-danger">
          {t('invoices.due_prefix')} <Money paise={row.due_paise} />
        </span>
        {row.paid_paise > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t('invoices.paid_prefix')} <Money paise={row.paid_paise} />
          </span>
        ) : null}
      </div>
    )
  }
  return <Money paise={row.paid_paise} className="text-success" />
}

function InvoiceCard({ row }: { row: SalesInvoiceListRow }) {
  const { t } = useTranslation(['sales', 'common'])
  const me = useMe()
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">
            {row.number ?? t(`sales:invoice_status.${row.status}`)}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatDate(row.invoice_date)} · {formatTime(row.invoice_at, me?.tenant.timezone)}
          </div>
        </div>
        <div className="text-end">
          <Money
            paise={row.total_paise}
            className={
              row.status === 'cancelled' ? 'line-through opacity-60' : 'text-base font-semibold'
            }
          />
          <div className="text-xs text-muted-foreground">
            {t('sales:invoices.items_count', { count: row.item_count })}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm">
          {row.customer_name ?? t('common:misc.walk_in')}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {row.offline ? <OfflineBadge /> : null}
          {row.status === 'completed' ? (
            row.due_paise > 0 ? (
              <span className="text-sm font-medium text-danger">
                {t('sales:invoices.due_prefix')} <Money paise={row.due_paise} />
              </span>
            ) : (
              <PaymentStatusBadge status={row.payment_status} />
            )
          ) : (
            <InvoiceStatusBadge status={row.status} />
          )}
        </div>
      </div>
    </div>
  )
}
