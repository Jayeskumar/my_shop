/**
 * Receipts & payments (/payments, payments.read): every receipt (money in) and payment voucher
 * (money out) — counter tenders, dues collected, supplier payments — with direction / method /
 * party / status / date filters in the URL, totals over the whole filtered range (list
 * summary), CSV export, "Receive payment" (Alt+R) and "Pay supplier" (Alt+P), and a detail
 * drawer (?id=, the link target of journal sources) with print and cancel.
 */
import {
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  HandCoins,
  QrCode,
  Scale,
  Send,
  Wallet,
} from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  type Payment,
  type PaymentListQuery,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import type { PaymentMethod, PaymentStatus } from '@kadai/shared/enums'
import { PaymentMethodSchema } from '@kadai/shared/enums'
import { CustomerPicker, SupplierPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  FilterBar,
  Kbd,
  PageHeader,
  Select,
  Stat,
  Tabs,
  TabsList,
  TabsTrigger,
  notify,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { presetRange } from '@/lib/date-presets'
import { formatDate, formatMoney, formatTime } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { usePayments } from '../api'
import { PaymentDetailDrawer } from '../components/PaymentDetailDrawer'
import { PaymentEntryDialog } from '../components/PaymentEntryDialog'
import { PaymentMethodIcon } from '../components/PaymentMethodIcon'
import { PaymentStatusBadge } from '../components/StatusBadges'
import { methodLabel, PAYMENTS_HOTKEY_SCOPE, signedAmount } from '../lib/labels'
import { intParam, useSearchState } from '../lib/use-search-state'

const DEFAULTS = {
  dir: 'all',
  method: '',
  status: 'all',
  party_id: '',
  party_name: '',
  from: '',
  to: '',
  q: '',
  sort: '-paid_at',
  offset: '0',
  limit: '50',
  id: '',
  new: '',
} as const

type Direction = 'all' | 'in' | 'out'
const STATUS_FILTERS = ['all', 'completed', 'cancelled'] as const

export default function PaymentsPage() {
  const { t, i18n } = useTranslation(['payments', 'common', 'nav'])
  const me = useMe()
  const canCollect = useCan('payments.collect')
  const canPay = useCan('payments.pay')
  const canExport = useCan('data.export')
  const searchRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useSearchState(DEFAULTS)
  const dir: Direction = state.dir === 'in' || state.dir === 'out' ? state.dir : 'all'
  const method = PaymentMethodSchema.safeParse(state.method).success
    ? (state.method as PaymentMethod)
    : null
  const status = (STATUS_FILTERS as readonly string[]).includes(state.status)
    ? (state.status as (typeof STATUS_FILTERS)[number])
    : 'all'
  const range = useMemo(
    () =>
      state.from && state.to
        ? { from: state.from, to: state.to }
        : presetRange('this_month', { timezone: me?.tenant.timezone }),
    [state.from, state.to, me?.tenant.timezone],
  )
  const offset = intParam(state.offset, 0)
  const limit = intParam(state.limit, 50) || 50
  const partyType = dir === 'out' ? 'supplier' : 'customer'

  const query: PaymentListQuery = {
    limit,
    offset,
    sort: state.sort,
    from: range.from,
    to: range.to,
    ...(dir !== 'all' ? { direction: dir } : {}),
    ...(method ? { method: [method] } : {}),
    ...(status !== 'all' ? { status: [status as PaymentStatus] } : {}),
    ...(state.party_id ? { party_type: partyType, party_id: state.party_id } : {}),
    ...(state.q ? { q: state.q } : {}),
  }
  const list = usePayments(query)
  const rows = list.data?.data ?? []
  const summary = list.data?.summary
  const page = list.data?.page
  const filtered =
    dir !== 'all' ||
    Boolean(method) ||
    status !== 'all' ||
    Boolean(state.party_id) ||
    Boolean(state.q) ||
    Boolean(state.from)

  const entry: 'in' | 'out' | null =
    state.new === 'receive' && canCollect ? 'in' : state.new === 'pay' && canPay ? 'out' : null

  useHotkeyScope(PAYMENTS_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+r': () => {
        if (canCollect) setState({ new: 'receive' })
      },
      'alt+p': () => {
        if (canPay) setState({ new: 'pay' })
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: PAYMENTS_HOTKEY_SCOPE },
  )

  const exportCsv = async (): Promise<void> => {
    try {
      const { limit: _l, offset: _o, ...rest } = query
      await downloadRoute(paymentsRoutes.listPayments, {
        query: { ...rest, format: 'csv' },
        filename: `payments-${range.from}-${range.to}.csv`,
      })
    } catch (error) {
      notify.error(error)
    }
  }

  const columns = useMemo<DataTableColumn<Payment>[]>(
    () => [
      {
        id: 'paid_at',
        accessorKey: 'paid_at',
        header: t('fields.date'),
        enableSorting: true,
        cell: ({ row }) => (
          <div className="whitespace-nowrap">
            <div>{formatDate(row.original.payment_date)}</div>
            <div className="text-xs text-muted-foreground">{formatTime(row.original.paid_at)}</div>
          </div>
        ),
      },
      {
        id: 'number',
        accessorKey: 'number',
        header: t('fields.number'),
        enableSorting: true,
        cell: ({ row }) =>
          row.original.number ? (
            <span className="font-mono text-[13px]">{row.original.number}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t(`origin.${row.original.origin}`)}
            </span>
          ),
      },
      {
        id: 'party',
        header: t('fields.party'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">
              {row.original.party_name ?? t('common:misc.walk_in')}
            </div>
            <div className="text-xs text-muted-foreground">
              {t(row.original.direction === 'in' ? 'direction.in' : 'direction.out')}
            </div>
          </div>
        ),
      },
      {
        id: 'method',
        header: t('fields.method'),
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <PaymentMethodIcon method={row.original.method} />
            <div className="min-w-0">
              <div>{methodLabel(row.original.method, i18n.language)}</div>
              {row.original.reference ? (
                <div className="max-w-40 truncate font-mono text-xs text-muted-foreground">
                  {row.original.reference}
                </div>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: 'amount_paise',
        accessorKey: 'amount_paise',
        header: t('fields.amount'),
        enableSorting: true,
        meta: { align: 'right' },
        cell: ({ row }) => <SignedAmount payment={row.original} />,
      },
      {
        id: 'status',
        header: t('fields.status'),
        cell: ({ row }) => <PaymentStatusBadge status={row.original.status} size="sm" />,
      },
    ],
    [t, i18n.language],
  )

  const directionTabs = (
    <Tabs
      value={dir}
      onValueChange={(v) => setState({ dir: v, party_id: '', party_name: '' })}
      variant="pills"
    >
      <TabsList aria-label={t('fields.direction')}>
        <TabsTrigger value="all">{t('list.tab_all')}</TabsTrigger>
        <TabsTrigger value="in">{t('list.tab_in')}</TabsTrigger>
        <TabsTrigger value="out">{t('list.tab_out')}</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  const partyValue = state.party_id ? { id: state.party_id, name: state.party_name } : null

  return (
    <div className="grid gap-5">
      <PageHeader
        title={t('nav:titles.payments')}
        description={t('list.hint')}
        actions={
          <>
            <Button asChild variant="ghost" leftIcon={<QrCode />}>
              <Link to="/payments/upi">{t('nav:titles.upi')}</Link>
            </Button>
            {canPay ? (
              <Button
                variant="outline"
                leftIcon={<Send />}
                onClick={() => setState({ new: 'pay' })}
                title="Alt+P"
              >
                {t('list.pay_supplier')}
              </Button>
            ) : null}
            {canCollect ? (
              <Button leftIcon={<HandCoins />} onClick={() => setState({ new: 'receive' })} title="Alt+R">
                {t('list.receive')}
                <Kbd combo="alt+r" className="ms-1 hidden lg:inline-flex" />
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('list.stat_in')}
          value={formatMoney(summary?.in_paise ?? 0)}
          icon={<ArrowDownLeft />}
          loading={list.isPending}
          onClick={() => setState({ dir: 'in', party_id: '', party_name: '' })}
        />
        <Stat
          label={t('list.stat_out')}
          value={formatMoney(summary?.out_paise ?? 0)}
          icon={<ArrowUpRight />}
          tone="danger"
          loading={list.isPending}
          onClick={() => setState({ dir: 'out', party_id: '', party_name: '' })}
        />
        <Stat
          label={t('list.stat_net')}
          value={formatMoney(summary?.net_paise ?? 0)}
          icon={<Scale />}
          tone="accent"
          loading={list.isPending}
        />
        <Stat
          label={t('list.stat_count')}
          value={String(summary?.count ?? 0)}
          icon={<Wallet />}
          loading={list.isPending}
        />
      </div>

      {summary && summary.by_method.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t('list.by_method')}>
          {summary.by_method.map((m) => (
            <li key={`${m.direction}-${m.method}`}>
              <button
                type="button"
                onClick={() => setState({ method: m.method, dir: m.direction })}
                className={cn(
                  'inline-flex min-h-9 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-sm hover:bg-surface-2',
                  method === m.method && dir === m.direction && 'border-primary bg-primary-soft',
                )}
              >
                <PaymentMethodIcon method={m.method} />
                <span>{methodLabel(m.method, i18n.language)}</span>
                <span
                  className={cn(
                    'font-medium tabular-nums',
                    m.direction === 'in' ? 'text-success' : 'text-danger',
                  )}
                >
                  {m.direction === 'in' ? '+' : '−'}
                  {formatMoney(m.amount_paise)}
                </span>
                <Badge size="sm">{m.count}</Badge>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <Card className="p-3 sm:p-4">
        <FilterBar
          search={{
            value: state.q,
            onChange: (q) => setState({ q }),
            placeholder: t('list.search_placeholder'),
          }}
          filters={
            <>
              {directionTabs}
              <DateRangePicker
                value={range}
                onChange={(r) => setState({ from: r.from, to: r.to })}
              />
              <Select
                value={method ?? 'all'}
                onValueChange={(v) => setState({ method: v === 'all' ? '' : v })}
                aria-label={t('fields.method')}
                className="sm:w-40"
                options={[
                  { value: 'all', label: t('list.all_methods') },
                  ...PaymentMethodSchema.options.map((m) => ({
                    value: m,
                    label: methodLabel(m, i18n.language),
                  })),
                ]}
              />
              <Select
                value={status}
                onValueChange={(v) => setState({ status: v })}
                aria-label={t('fields.status')}
                className="sm:w-40"
                options={STATUS_FILTERS.map((s) => ({
                  value: s,
                  label: s === 'all' ? t('list.all_statuses') : t(`payment_status.${s}`),
                }))}
              />
              <div className="sm:w-64">
                {partyType === 'supplier' ? (
                  <SupplierPicker
                    value={partyValue}
                    onChange={(s) =>
                      setState({ party_id: s?.id ?? '', party_name: s?.name ?? '' })
                    }
                    placeholder={t('list.any_supplier')}
                    showBalance={false}
                    aria-label={t('fields.supplier')}
                  />
                ) : (
                  <CustomerPicker
                    value={partyValue}
                    onChange={(c) =>
                      setState({ party_id: c?.id ?? '', party_name: c?.name ?? '' })
                    }
                    placeholder={t('list.any_customer')}
                    showBalance={false}
                    aria-label={t('fields.customer')}
                  />
                )}
              </div>
            </>
          }
          onReset={
            filtered
              ? () =>
                  setState({
                    dir: 'all',
                    method: '',
                    status: 'all',
                    party_id: '',
                    party_name: '',
                    from: '',
                    to: '',
                    q: '',
                  })
              : undefined
          }
          actions={
            canExport ? (
              <Button variant="outline" leftIcon={<Download />} onClick={() => void exportCsv()}>
                {t('common:actions.export_csv')}
              </Button>
            ) : null
          }
        />

        <DataTable
          label={t('nav:titles.payments')}
          columns={columns}
          data={rows}
          getRowId={(p) => p.id}
          loading={list.isFetching && !list.isPending ? false : list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={state.sort}
          onSortChange={(sort) => setState({ sort: sort ?? DEFAULTS.sort })}
          onRowClick={(p) => setState({ id: p.id })}
          pagination={
            page
              ? {
                  offset: page.offset,
                  limit: page.limit,
                  total: page.total,
                  onChange: (next) =>
                    setState({ offset: String(next.offset), limit: String(next.limit) }),
                }
              : undefined
          }
          renderCard={(p) => <PaymentCard payment={p} />}
          empty={
            filtered ? (
              <EmptyState
                compact
                title={t('list.empty_filtered')}
                description={t('common:empty.no_results_hint')}
              />
            ) : (
              <EmptyState
                icon={<Wallet />}
                title={t('list.empty_title')}
                description={t('list.empty_hint')}
                action={
                  canCollect ? (
                    <Button leftIcon={<HandCoins />} onClick={() => setState({ new: 'receive' })}>
                      {t('list.receive')}
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        />
      </Card>

      <PaymentEntryDialog
        open={entry !== null}
        direction={entry ?? 'in'}
        onOpenChange={(o) => !o && setState({ new: '' })}
        onDone={(payment) => setState({ new: '', id: payment.id })}
      />
      <PaymentDetailDrawer
        paymentId={state.id || null}
        onOpenChange={(o) => !o && setState({ id: '' })}
      />
    </div>
  )
}

function SignedAmount({ payment }: { payment: Payment }) {
  const cancelled = payment.status === 'cancelled'
  return (
    <div className="text-end">
      <div
        className={cn(
          'font-semibold tabular-nums',
          cancelled
            ? 'text-muted-foreground line-through'
            : payment.direction === 'in'
              ? 'text-success'
              : 'text-danger',
        )}
      >
        {payment.direction === 'in' ? '+' : '−'}
        {formatMoney(Math.abs(signedAmount(payment.direction, payment.amount_paise)))}
      </div>
      {payment.unallocated_paise > 0 && !cancelled ? (
        <AdvanceNote paise={payment.unallocated_paise} />
      ) : null}
    </div>
  )
}

function AdvanceNote({ paise }: { paise: number }) {
  const { t } = useTranslation('payments')
  return (
    <div className="text-xs text-muted-foreground">
      {t('list.advance_part', { amount: formatMoney(paise) })}
    </div>
  )
}

function PaymentCard({ payment }: { payment: Payment }) {
  const { t, i18n } = useTranslation(['payments', 'common'])
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {payment.party_name ?? t('common:misc.walk_in')}
        </div>
        <div className="text-xs text-muted-foreground">
          {[payment.number ?? t(`origin.${payment.origin}`), formatDate(payment.payment_date)].join(
            ' · ',
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1">
            <PaymentMethodIcon method={payment.method} className="size-3.5" />
            {methodLabel(payment.method, i18n.language)}
          </span>
          {payment.status !== 'completed' ? (
            <PaymentStatusBadge status={payment.status} size="sm" />
          ) : null}
        </div>
      </div>
      <SignedAmount payment={payment} />
    </div>
  )
}
