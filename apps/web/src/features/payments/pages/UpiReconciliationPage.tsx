/**
 * UPI & reconciliation (/payments/upi, payments.read): the day's UPI QRs / links live
 * (refreshed every 10 s while the tab is visible) with status chips, provider, amount, payer
 * UPI ID, UTR and what each payment was applied to.
 *
 * Tabs: Waiting (created / pending) · Paid, not applied (money received that no bill or
 * customer took — all days, the reconciliation queue) · Paid · Failed / expired / cancelled.
 * Actions (payments.collect): confirm a shop-UPI-ID payment by hand (optional UTR), cancel a
 * waiting QR, apply an unapplied payment to an invoice or a customer. Daily totals per provider.
 */
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HandCoins,
  RefreshCw,
  Smartphone,
  XCircle,
  Zap,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { documentPath } from '@kadai/shared/api/identity'
import type { PaymentIntent, PaymentIntentListQuery } from '@kadai/shared/api/payments'
import type { PaymentIntentStatus } from '@kadai/shared/enums'
import { todayIn } from '@kadai/shared/fy'
import { ALL_STORES, StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  DatePicker,
  EmptyState,
  FilterBar,
  PageHeader,
  Stat,
  Tabs,
  TabsList,
  TabsTrigger,
  notify,
  useConfirm,
} from '@/components/ui'
import { useCan, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney, formatTime } from '@/lib/format'
import { useCancelIntent, useIntents } from '../api'
import { ApplyIntentDialog } from '../components/ApplyIntentDialog'
import { ConfirmIntentDialog } from '../components/ConfirmIntentDialog'
import { IntentStatusBadge } from '../components/StatusBadges'
import { intParam, useSearchState } from '../lib/use-search-state'
import { notifyPaymentError } from '../lib/errors'

const TABS = ['pending', 'unapplied', 'paid', 'closed'] as const
type Tab = (typeof TABS)[number]

const TAB_STATUSES: Readonly<Record<Tab, PaymentIntentStatus[]>> = {
  pending: ['created', 'pending'],
  unapplied: ['paid'],
  paid: ['paid'],
  closed: ['failed', 'expired', 'cancelled'],
}

const DEFAULTS = {
  tab: 'pending',
  date: '',
  store: '',
  q: '',
  offset: '0',
  limit: '50',
} as const

const LIVE_MS = 10_000

export default function UpiReconciliationPage() {
  const { t } = useTranslation(['payments', 'common', 'nav'])
  const me = useMe()
  const canCollect = useCan('payments.collect')
  const confirm = useConfirm()
  const [state, setState] = useSearchState(DEFAULTS)
  const today = todayIn(me?.tenant.timezone)
  const date = state.date || today
  const tab: Tab = (TABS as readonly string[]).includes(state.tab) ? (state.tab as Tab) : 'pending'
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1
  const storeId = state.store && state.store !== ALL_STORES ? state.store : null
  const offset = intParam(state.offset, 0)
  const limit = intParam(state.limit, 50) || 50
  const live = date === today

  const scope = { ...(storeId ? { store_id: storeId } : {}) }
  const day = { from: date, to: date }
  // The day's totals (by status, by provider) — every status, one row is enough.
  const daySummary = useIntents(
    { ...scope, ...day, limit: 1 },
    { refetchInterval: live ? LIVE_MS : false },
  )
  // The reconciliation queue spans every day.
  const queue = useIntents(
    { ...scope, status: ['paid'], unapplied: true, limit: 1 },
    { refetchInterval: live ? LIVE_MS : false },
  )
  const query: PaymentIntentListQuery = {
    ...scope,
    ...(tab === 'unapplied' ? { unapplied: true } : day),
    status: TAB_STATUSES[tab],
    ...(state.q ? { q: state.q } : {}),
    sort: tab === 'paid' || tab === 'unapplied' ? '-paid_at' : '-created_at',
    limit,
    offset,
  }
  const list = useIntents(query, { refetchInterval: live || tab === 'unapplied' ? LIVE_MS : false })
  const rows = list.data?.data ?? []
  const page = list.data?.page

  const summary = daySummary.data?.summary
  const countOf = (statuses: readonly PaymentIntentStatus[]): { count: number; amount: number } =>
    (summary?.by_status ?? [])
      .filter((s) => statuses.includes(s.status))
      .reduce((acc, s) => ({ count: acc.count + s.count, amount: acc.amount + s.amount_paise }), {
        count: 0,
        amount: 0,
      })
  const pendingStats = countOf(TAB_STATUSES.pending)
  const paidStats = countOf(['paid'])
  const closedStats = countOf(TAB_STATUSES.closed)
  const unappliedCount = queue.data?.summary.unapplied_count ?? queue.data?.page.total ?? 0
  const unappliedTotal = queue.data?.summary.unapplied_total_paise ?? 0

  const [confirming, setConfirming] = useState<PaymentIntent | null>(null)
  const [applying, setApplying] = useState<PaymentIntent | null>(null)
  const cancel = useCancelIntent()

  const askCancel = async (intent: PaymentIntent): Promise<void> => {
    const ok = await confirm({
      title: t('upi.cancel_title', { amount: formatMoney(intent.amount_paise) }),
      description: t('upi.cancel_hint'),
      confirmLabel: t('qr.cancel'),
      cancelLabel: t('upi.keep_waiting'),
      tone: 'danger',
    })
    if (!ok) return
    cancel.mutate(
      { params: { id: intent.id }, body: {} },
      { onSuccess: () => notify.success(t('upi.cancelled_toast')), onError: notifyPaymentError },
    )
  }

  const actionsFor = (intent: PaymentIntent) => {
    if (!canCollect) return null
    const waiting = intent.status === 'created' || intent.status === 'pending'
    const unapplied = intent.status === 'paid' && !intent.payment_id
    return (
      <div className="flex flex-wrap justify-end gap-1.5">
        {waiting && intent.provider === 'upi_vpa' ? (
          <Button size="sm" variant="success" onClick={() => setConfirming(intent)}>
            {t('upi.action_confirm')}
          </Button>
        ) : null}
        {waiting ? (
          <Button size="sm" variant="outline" onClick={() => void askCancel(intent)}>
            {t('qr.cancel')}
          </Button>
        ) : null}
        {unapplied ? (
          <Button size="sm" leftIcon={<HandCoins />} onClick={() => setApplying(intent)}>
            {t('upi.action_apply')}
          </Button>
        ) : null}
      </div>
    )
  }

  const columns = useMemo<DataTableColumn<PaymentIntent>[]>(
    () => [
      {
        id: 'time',
        header: t('fields.time'),
        cell: ({ row }) => (
          <div className="whitespace-nowrap">
            <div>{formatTime(row.original.paid_at ?? row.original.created_at)}</div>
            {tab === 'unapplied' ? (
              <div className="text-xs text-muted-foreground">
                {formatDate(row.original.paid_at ?? row.original.created_at)}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'amount',
        header: t('fields.amount'),
        meta: { align: 'right' },
        cell: ({ row }) => <IntentAmount intent={row.original} />,
      },
      {
        id: 'status',
        header: t('fields.status'),
        cell: ({ row }) => (
          <div className="grid gap-1">
            <IntentStatusBadge status={row.original.status} size="sm" />
            {row.original.confirmation ? (
              <span className="text-xs text-muted-foreground">
                {t(`confirmation.${row.original.confirmation}`)}
                {row.original.confirmed_by_name ? ` · ${row.original.confirmed_by_name}` : ''}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'provider',
        header: t('fields.provider'),
        cell: ({ row }) => <ProviderName intent={row.original} />,
      },
      {
        id: 'payer',
        header: t('fields.payer'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate">
              {row.original.payer_name ?? row.original.customer_name ?? '—'}
            </div>
            {row.original.payer_vpa ? (
              <div className="truncate font-mono text-xs text-muted-foreground">
                {row.original.payer_vpa}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'utr',
        header: t('fields.utr'),
        cell: ({ row }) => (
          <div className="font-mono text-xs">
            <div>{row.original.utr ?? '—'}</div>
            <div className="text-muted-foreground">{row.original.reference_code}</div>
          </div>
        ),
      },
      {
        id: 'linked',
        header: t('fields.linked'),
        cell: ({ row }) => <LinkedTo intent={row.original} />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('fields.actions')}</span>,
        meta: { align: 'right', label: t('fields.actions') },
        cell: ({ row }) => actionsFor(row.original),
      },
    ],
    // actionsFor closes over state setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, tab, canCollect],
  )

  const tabLabel = (key: Tab): string => {
    if (key === 'pending') return t('upi.tab_pending', { count: pendingStats.count })
    if (key === 'unapplied') return t('upi.tab_unapplied', { count: unappliedCount })
    if (key === 'paid') return t('upi.tab_paid', { count: paidStats.count })
    return t('upi.tab_closed', { count: closedStats.count })
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        title={t('nav:titles.upi')}
        description={t('upi.hint')}
        backTo="/payments"
        meta={
          live ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="relative flex size-2" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
              {t('upi.live', {
                time: list.dataUpdatedAt ? formatTime(new Date(list.dataUpdatedAt)) : '—',
              })}
            </span>
          ) : null
        }
        actions={
          <Button
            variant="outline"
            leftIcon={<RefreshCw />}
            onClick={() => {
              void list.refetch()
              void daySummary.refetch()
              void queue.refetch()
            }}
            loading={list.isFetching && !list.isPending}
          >
            {t('common:actions.refresh')}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('upi.stat_paid', { date: date === today ? t('upi.today') : formatDate(date) })}
          value={formatMoney(summary?.paid_total_paise ?? 0)}
          hint={t('upi.stat_count', { count: paidStats.count })}
          icon={<CheckCircle2 />}
          loading={daySummary.isPending}
          onClick={() => setState({ tab: 'paid' })}
        />
        <Stat
          label={t('upi.stat_pending')}
          value={formatMoney(pendingStats.amount)}
          hint={t('upi.stat_count', { count: pendingStats.count })}
          icon={<Clock />}
          tone="accent"
          loading={daySummary.isPending}
          onClick={() => setState({ tab: 'pending' })}
        />
        <Stat
          label={t('upi.stat_unapplied')}
          value={formatMoney(unappliedTotal)}
          hint={t('upi.stat_count', { count: unappliedCount })}
          icon={<AlertTriangle />}
          tone={unappliedCount > 0 ? 'danger' : 'default'}
          loading={queue.isPending}
          onClick={() => setState({ tab: 'unapplied' })}
        />
        <Stat
          label={t('upi.stat_closed')}
          value={String(closedStats.count)}
          hint={formatMoney(closedStats.amount)}
          icon={<XCircle />}
          loading={daySummary.isPending}
          onClick={() => setState({ tab: 'closed' })}
        />
      </div>

      {summary && summary.by_provider.length > 0 ? (
        <section aria-labelledby="by-provider" className="grid gap-2">
          <h2 id="by-provider" className="text-sm font-semibold text-muted-foreground">
            {t('upi.by_provider')}
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {summary.by_provider.map((p) => (
              <li key={p.provider_account_id}>
                <Card className="flex items-center gap-3 p-3">
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-lg',
                      p.provider === 'upi_vpa'
                        ? 'bg-primary-soft text-primary'
                        : 'bg-accent-soft text-accent-soft-foreground',
                    )}
                    aria-hidden
                  >
                    {p.provider === 'upi_vpa' ? (
                      <Smartphone className="size-4" />
                    ) : (
                      <Zap className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.display_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('upi.stat_count', { count: p.paid_count })}
                    </p>
                  </div>
                  <p className="font-semibold tabular-nums">{formatMoney(p.paid_total_paise)}</p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Card className="p-3 sm:p-4">
        <Tabs value={tab} onValueChange={(v) => setState({ tab: v })} variant="underline">
          <TabsList aria-label={t('upi.tabs_label')} className="mb-3 w-full overflow-x-auto">
            {TABS.map((key) => (
              <TabsTrigger key={key} value={key} className="whitespace-nowrap">
                {tabLabel(key)}
                {key === 'unapplied' && unappliedCount > 0 ? (
                  <span className="ms-1.5 inline-block size-2 rounded-full bg-danger" aria-hidden />
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <FilterBar
          search={{
            value: state.q,
            onChange: (q) => setState({ q }),
            placeholder: t('upi.search_placeholder'),
          }}
          filters={
            <>
              {tab !== 'unapplied' ? (
                <div className="sm:w-44">
                  <DatePicker
                    value={date}
                    onChange={(d) => setState({ date: d && d !== today ? d : '' })}
                    max={today}
                    aria-label={t('fields.date')}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('upi.unapplied_all_days')}</p>
              )}
              {multiStore ? (
                <div className="sm:w-56">
                  <StorePicker
                    allowAll
                    clearable={false}
                    value={state.store || ALL_STORES}
                    onChange={(id) => setState({ store: id && id !== ALL_STORES ? id : '' })}
                  />
                </div>
              ) : null}
            </>
          }
        />
        {tab === 'unapplied' && rows.length > 0 ? (
          <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
            {t('upi.unapplied_explain')}
          </p>
        ) : null}
        <DataTable
          label={t('nav:titles.upi')}
          columns={columns}
          data={rows}
          getRowId={(i) => i.id}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
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
          renderCard={(intent) => (
            <div className="grid gap-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <IntentStatusBadge status={intent.status} size="sm" />
                  <div className="mt-1 truncate text-sm">
                    {intent.payer_name ?? intent.customer_name ?? intent.payer_vpa ?? '—'}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[formatTime(intent.paid_at ?? intent.created_at), intent.provider_display_name]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {intent.utr ? (
                    <div className="font-mono text-xs text-muted-foreground">UTR {intent.utr}</div>
                  ) : null}
                </div>
                <IntentAmount intent={intent} />
              </div>
              <LinkedTo intent={intent} />
              {actionsFor(intent)}
            </div>
          )}
          empty={
            <EmptyState
              compact
              icon={tab === 'unapplied' ? <CheckCircle2 /> : <Smartphone />}
              title={t(`upi.empty.${tab}`)}
              description={t(`upi.empty.${tab}_hint`)}
            />
          }
        />
      </Card>

      <ConfirmIntentDialog intent={confirming} onOpenChange={(o) => !o && setConfirming(null)} />
      <ApplyIntentDialog intent={applying} onOpenChange={(o) => !o && setApplying(null)} />
    </div>
  )
}

function IntentAmount({ intent }: { intent: PaymentIntent }) {
  const { t } = useTranslation('payments')
  const received = intent.paid_amount_paise
  return (
    <div className="text-end">
      <div className="font-semibold tabular-nums">{formatMoney(received ?? intent.amount_paise)}</div>
      {intent.amount_mismatch && received !== null ? (
        <Badge tone="warning" size="sm">
          {t('upi.expected', { amount: formatMoney(intent.amount_paise) })}
        </Badge>
      ) : null}
    </div>
  )
}

function ProviderName({ intent }: { intent: PaymentIntent }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {intent.provider === 'upi_vpa' ? (
        <Smartphone className="size-4 text-primary" aria-hidden />
      ) : (
        <Zap className="size-4 text-accent" aria-hidden />
      )}
      <span className="truncate">{intent.provider_display_name}</span>
    </span>
  )
}

function LinkedTo({ intent }: { intent: PaymentIntent }) {
  const { t } = useTranslation('payments')
  if (intent.payment_id) {
    return (
      <Link to={`/payments?id=${intent.payment_id}`} className="text-sm text-primary hover:underline">
        {intent.payment_number ?? t('upi.view_receipt')}
      </Link>
    )
  }
  if (intent.status === 'paid') {
    return (
      <Badge tone="danger" size="sm" icon={<AlertTriangle aria-hidden />}>
        {t('upi.not_applied')}
      </Badge>
    )
  }
  const path = intent.ref_type === 'sales_invoice' ? documentPath('sales_invoice', intent.ref_id) : null
  const label =
    intent.ref_type === 'pos_cart'
      ? t('purpose.pos_sale')
      : intent.ref_type === 'customer'
        ? (intent.customer_name ?? t(`purpose.${intent.purpose}`))
        : t(`purpose.${intent.purpose}`)
  return path ? (
    <Link to={path} className="text-sm text-primary hover:underline">
      {label}
    </Link>
  ) : (
    <span className="text-sm text-muted-foreground">{label}</span>
  )
}
