/**
 * Message log (/notifications, settings.manage): every SMS / WhatsApp / email the business sent
 * or tried to send, newest first. Status tabs and channel chips show the facet counts of the
 * list summary; channel, message type, date range and search filters live in the URL; the list
 * refreshes itself every OUTBOX_REFRESH_SECONDS (silently, no dimming) while the switch is on.
 * Failed / not-sent messages show their reason in a tooltip and can be retried (optimistic).
 * A row opens the detail drawer (?id=).
 */
import {
  AlertTriangle,
  CalendarX2,
  Inbox,
  MessageSquareDashed,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
} from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  NOTIFICATION_TEMPLATE_CODES,
  NOTIFICATION_TEMPLATES,
  type Notification,
  type NotificationListQuery,
  OUTBOX_REFRESH_SECONDS,
  isTemplateCode,
} from '@kadai/shared/api/notifications'
import { type NotificationChannel, NotificationChannelSchema } from '@kadai/shared/enums'
import {
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  FilterBar,
  IconButton,
  PageHeader,
  Select,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  notify,
} from '@/components/ui'
import { useAuth, useCan, useFeature } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDateTime, formatNumber, formatRelative, formatTime } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { storage } from '@/lib/storage'
import { useNotifications, useRetryNotification, useTemplateCatalog } from '../api'
import { ChannelIcon } from '../components/ChannelIcon'
import { NotificationDetailDrawer } from '../components/NotificationDetailDrawer'
import { StatusChip } from '../components/StatusChip'
import {
  STATUS_TABS,
  type StatusTab,
  channelLabel,
  isStatusTab,
  recipientText,
  statusesOfTab,
  templateLabel,
} from '../lib/labels'
import { notifyNotificationError } from '../lib/messages'
import { intParam, useSearchState } from '../lib/use-search-state'

const HOTKEY_SCOPE = 'notifications-outbox'
const AUTO_REFRESH_KEY = 'notifications.outbox.auto_refresh'

const DEFAULTS = {
  status: 'all',
  channel: '',
  template: '',
  q: '',
  from: '',
  to: '',
  sort: '-created_at',
  offset: '0',
  limit: '50',
  id: '',
} as const

const DATE_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
] as const

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

/** The auto-refresh switch is remembered per device (storage falls back to memory when blocked). */
function readAutoRefresh(): boolean {
  return storage.get(AUTO_REFRESH_KEY, true, isBoolean)
}

export default function OutboxPage() {
  const { t, i18n } = useTranslation(['notifications', 'common', 'nav'])
  const hasFeature = useFeature('notifications')
  const canManage = useCan('settings.manage')
  const mode = useAuth((s) => s.me?.mode ?? s.deployment.mode)
  const canBilling = useCan('billing.manage')
  const filtersRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useSearchState(DEFAULTS)
  const [autoRefresh, setAutoRefreshState] = useState(readAutoRefresh)
  const setAutoRefresh = (on: boolean): void => {
    setAutoRefreshState(on)
    storage.set(AUTO_REFRESH_KEY, on)
  }

  const tab: StatusTab = isStatusTab(state.status) ? state.status : 'all'
  const channel = NotificationChannelSchema.safeParse(state.channel).success
    ? (state.channel as NotificationChannel)
    : null
  const template = isTemplateCode(state.template) ? state.template : null
  const range = state.from && state.to ? { from: state.from, to: state.to } : null
  const offset = intParam(state.offset, 0)
  const limit = intParam(state.limit, 50) || 50
  const statuses = statusesOfTab(tab)

  const query: NotificationListQuery = {
    limit,
    offset,
    sort: state.sort,
    ...(statuses ? { status: statuses } : {}),
    ...(channel ? { channel: [channel] } : {}),
    ...(template ? { template_code: [template] } : {}),
    ...(range ? { from: range.from, to: range.to } : {}),
    ...(state.q ? { q: state.q } : {}),
  }
  const list = useNotifications(query, autoRefresh)
  const retry = useRetryNotification()
  const catalog = useTemplateCatalog(hasFeature && canManage)
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const summary = list.data?.summary
  const filtered = Boolean(channel || template || range || state.q || tab !== 'all')

  const statusCount = (s: StatusTab): number | null => {
    if (!summary) return null
    const wanted = statusesOfTab(s)
    return summary.by_status
      .filter((b) => wanted === null || wanted.includes(b.status))
      .reduce((sum, b) => sum + b.count, 0)
  }
  const channelCount = (c: NotificationChannel): number =>
    summary?.by_channel.find((b) => b.channel === c)?.count ?? 0
  const failedCount = summary?.by_status.find((b) => b.status === 'failed')?.count ?? 0

  // Channels that have messages here but no live sending service: those are only recorded.
  const notLive = (catalog.data?.data.providers ?? [])
    .filter((p) => !p.live && channelCount(p.channel) > 0)
    .map((p) => channelLabel(p.channel, i18n.language))

  useHotkeyScope(HOTKEY_SCOPE)
  useHotkeys(
    {
      '/': () =>
        filtersRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus(),
    },
    { scope: HOTKEY_SCOPE, preventDefault: true },
  )

  const doRetry = (n: Notification): void => {
    retry.mutate(
      { params: { id: n.id } },
      {
        onSuccess: () => notify.success(t('outbox.retried_toast')),
        onError: notifyNotificationError,
      },
    )
  }

  const columns = useMemo<DataTableColumn<Notification>[]>(
    () => [
      {
        id: 'channel',
        header: t('outbox.columns.channel'),
        meta: { className: 'w-14', headerClassName: 'w-14' },
        cell: ({ row }) => <ChannelIcon channel={row.original.channel} />,
      },
      {
        id: 'message',
        header: t('outbox.columns.message'),
        cell: ({ row }) => <MessageCell n={row.original} />,
      },
      {
        id: 'recipient',
        header: t('outbox.columns.recipient'),
        cell: ({ row }) => <RecipientCell n={row.original} />,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: t('outbox.columns.status'),
        enableSorting: true,
        cell: ({ row }) => <StatusCell n={row.original} />,
      },
      {
        id: 'created_at',
        accessorKey: 'created_at',
        header: t('outbox.columns.time'),
        enableSorting: true,
        cell: ({ row }) => <TimeCell n={row.original} />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('outbox.retry')}</span>,
        meta: { align: 'right', className: 'w-14' },
        cell: ({ row }) =>
          row.original.can_retry ? (
            <RetryButton
              n={row.original}
              onRetry={doRetry}
              busy={retry.isPending && retry.variables?.params.id === row.original.id}
              compact
            />
          ) : null,
      },
    ],
    // doRetry only closes over the stable mutation and t.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, i18n.language, retry.isPending, retry.variables],
  )

  const upgradeTo = mode === 'cloud' && canBilling ? '/settings/billing' : null
  const selected = rows.find((r) => r.id === state.id) ?? null

  return (
    <div className="grid min-w-0 gap-5">
      <PageHeader
        title={t('nav:titles.notifications')}
        description={t('outbox.description')}
        actions={
          <>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label={t('outbox.auto_refresh')}
                id="outbox-auto-refresh"
              />
              <label htmlFor="outbox-auto-refresh" className="grid cursor-pointer leading-tight">
                <span className="text-sm font-medium">{t('outbox.auto_refresh')}</span>
                <span className="text-xs text-muted-foreground tabular-nums" aria-live="off">
                  {list.dataUpdatedAt
                    ? t('outbox.updated_at', { time: formatTime(new Date(list.dataUpdatedAt)) })
                    : t('outbox.auto_refresh_hint', { seconds: OUTBOX_REFRESH_SECONDS })}
                </span>
              </label>
              <IconButton
                icon={<RefreshCw className={cn(list.isFetching && 'animate-spin')} />}
                label={t('outbox.refresh')}
                size="sm"
                onClick={() => void list.refetch()}
              />
            </div>
            {hasFeature && canManage ? (
              <Button asChild variant="outline" leftIcon={<Settings2 />}>
                <Link to="/settings/notifications">{t('outbox.settings_link')}</Link>
              </Button>
            ) : null}
          </>
        }
      />

      {!hasFeature ? (
        <Banner
          tone="info"
          icon={<Sparkles />}
          title={t('outbox.plan_title')}
          action={
            upgradeTo ? (
              <Button asChild size="sm" variant="accent">
                <Link to={upgradeTo}>{t('outbox.upgrade')}</Link>
              </Button>
            ) : null
          }
        >
          {t('outbox.plan_hint')}
        </Banner>
      ) : notLive.length > 0 ? (
        <Banner
          tone="warning"
          icon={<MessageSquareDashed />}
          title={t('outbox.not_live_title')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/notifications#providers">{t('outbox.empty_action')}</Link>
            </Button>
          }
        >
          {t('outbox.not_live', { channels: notLive.join(', ') })}
        </Banner>
      ) : null}

      {failedCount > 0 && tab !== 'failed' ? (
        <Banner
          tone="danger"
          icon={<AlertTriangle />}
          action={
            <Button size="sm" variant="outline" onClick={() => setState({ status: 'failed' })}>
              {t('outbox.show_failed')}
            </Button>
          }
        >
          {t('outbox.failed_banner', { count: failedCount })}
        </Banner>
      ) : null}

      <Card className="grid min-w-0 gap-3 p-3 sm:p-4">
        <Tabs
          value={tab}
          onValueChange={(v) => setState({ status: v })}
          variant="pills"
          className="min-w-0"
        >
          <TabsList aria-label={t('outbox.status_filter')} className="w-full sm:w-fit sm:flex-wrap">
            {STATUS_TABS.map((s) => {
              const count = statusCount(s)
              return (
                <TabsTrigger key={s} value={s} className="gap-1.5">
                  {t(`outbox.tabs.${s}`)}
                  {count !== null && count > 0 ? (
                    <span
                      className={cn(
                        'rounded-full px-1.5 text-[11px] tabular-nums',
                        s === 'failed'
                          ? 'bg-danger-soft text-danger-soft-foreground'
                          : 'bg-surface-3 text-muted-foreground',
                      )}
                    >
                      {formatNumber(count)}
                    </span>
                  ) : null}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>

        <div ref={filtersRef}>
          <FilterBar
            search={{
              value: state.q,
              onChange: (q) => setState({ q }),
              placeholder: t('outbox.search_placeholder'),
            }}
            filters={
              <>
                <Select
                  value={channel ?? 'all'}
                  onValueChange={(v) => setState({ channel: v === 'all' ? '' : v })}
                  aria-label={t('outbox.channel_filter')}
                  className="sm:w-52"
                  options={[
                    { value: 'all', label: t('outbox.all_channels') },
                    ...NotificationChannelSchema.options.map((c) => ({
                      value: c,
                      label: (
                        <span className="inline-flex items-center gap-2">
                          {channelLabel(c, i18n.language)}
                          {summary ? (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {formatNumber(channelCount(c))}
                            </span>
                          ) : null}
                        </span>
                      ),
                    })),
                  ]}
                />
                <Select
                  value={template ?? 'all'}
                  onValueChange={(v) => setState({ template: v === 'all' ? '' : v })}
                  aria-label={t('outbox.template_filter')}
                  className="sm:w-64"
                  options={[
                    { value: 'all', label: t('outbox.all_templates') },
                    ...NOTIFICATION_TEMPLATE_CODES.map((c) => ({
                      value: c,
                      label: templateLabel(c, i18n.language),
                    })),
                  ]}
                />
                <div className="flex items-center gap-1">
                  <DateRangePicker
                    value={range}
                    presets={DATE_PRESETS}
                    onChange={(r) => setState({ from: r.from, to: r.to })}
                    className="sm:w-60"
                  />
                  {range ? (
                    <IconButton
                      icon={<CalendarX2 />}
                      label={t('common:actions.clear')}
                      size="sm"
                      onClick={() => setState({ from: '', to: '' })}
                    />
                  ) : null}
                </div>
              </>
            }
            onReset={
              filtered
                ? () =>
                    setState({ status: 'all', channel: '', template: '', q: '', from: '', to: '' })
                : undefined
            }
            className="pb-1"
          />
        </div>

        <DataTable
          label={t('nav:titles.notifications')}
          columns={columns}
          data={rows}
          getRowId={(n) => n.id}
          loading={list.isPending || list.isPlaceholderData}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={state.sort}
          onSortChange={(sort) => setState({ sort: sort ?? DEFAULTS.sort })}
          onRowClick={(n) => setState({ id: n.id })}
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
          renderCard={(n) => (
            <OutboxCard
              n={n}
              onRetry={doRetry}
              busy={retry.isPending && retry.variables?.params.id === n.id}
            />
          )}
          empty={
            filtered ? (
              <EmptyState
                compact
                title={t('outbox.empty_filtered')}
                description={t('common:empty.no_results_hint')}
              />
            ) : (
              <EmptyState
                icon={<Inbox />}
                title={t('outbox.empty_title')}
                description={t('outbox.empty_hint')}
                action={
                  hasFeature && canManage ? (
                    <Button asChild leftIcon={<Settings2 />}>
                      <Link to="/settings/notifications">{t('outbox.empty_action')}</Link>
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        />
      </Card>

      <NotificationDetailDrawer
        id={state.id || null}
        fallback={selected}
        onOpenChange={(open) => !open && setState({ id: '' })}
        onRetry={doRetry}
        retrying={retry.isPending}
        canRetry={canManage}
        autoRefresh={autoRefresh}
      />
    </div>
  )
}

// ---- cells ---------------------------------------------------------------------------------------

function isSensitive(code: string): boolean {
  return isTemplateCode(code) && NOTIFICATION_TEMPLATES[code].sensitive
}

function MessageCell({ n }: { n: Notification }) {
  const { t, i18n } = useTranslation('notifications')
  const preview = n.rendered_body ?? (isSensitive(n.template_code) ? t('outbox.hidden_body') : null)
  return (
    <div className="min-w-0 max-w-[20rem]">
      <div className="truncate font-medium">{templateLabel(n.template_code, i18n.language)}</div>
      {preview ? (
        <div className="truncate text-xs text-muted-foreground" lang={n.locale}>
          {preview}
        </div>
      ) : null}
    </div>
  )
}

function RecipientCell({ n }: { n: Notification }) {
  const { t } = useTranslation('notifications')
  return (
    <div className="min-w-0">
      <div className="truncate">{n.recipient_name ?? t('outbox.no_name')}</div>
      <div className="truncate text-xs text-muted-foreground tabular-nums">
        {recipientText(n.recipient)}
      </div>
    </div>
  )
}

function StatusCell({ n }: { n: Notification }) {
  const { t } = useTranslation('notifications')
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusChip status={n.status} error={n.error} />
      {n.attempts > 1 ? (
        <span className="text-xs text-muted-foreground">
          {t('outbox.attempts', { count: n.attempts })}
        </span>
      ) : n.provider === 'log' ? (
        <span className="text-xs text-muted-foreground">{t('settings.provider_log')}</span>
      ) : null}
    </div>
  )
}

function TimeCell({ n, className = 'text-sm' }: { n: Notification; className?: string }) {
  const { t, i18n } = useTranslation('notifications')
  const future = n.status === 'queued' && new Date(n.scheduled_at).getTime() > Date.now() + 60_000
  const at = n.sent_at ?? n.created_at
  return (
    <Tooltip content={formatDateTime(at)}>
      <time dateTime={at} className={cn('whitespace-nowrap tabular-nums', className)}>
        {future
          ? t('outbox.scheduled_for', {
              time: formatRelative(n.scheduled_at, i18n.language === 'en' ? 'en' : 'ta'),
            })
          : formatRelative(at, i18n.language === 'en' ? 'en' : 'ta')}
      </time>
    </Tooltip>
  )
}

function RetryButton({
  n,
  onRetry,
  busy,
  className,
  compact = false,
}: {
  n: Notification
  onRetry: (n: Notification) => void
  busy: boolean
  className?: string
  /** Icon only (table rows); the label is the tooltip and the accessible name. */
  compact?: boolean
}) {
  const { t } = useTranslation('notifications')
  const label = t('outbox.retry_label', {
    recipient: n.recipient_name ?? recipientText(n.recipient),
  })
  if (compact)
    return (
      <IconButton
        icon={<RotateCcw />}
        label={label}
        variant="outline"
        size="md"
        loading={busy}
        onClick={(e) => {
          e.stopPropagation()
          onRetry(n)
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
    )
  return (
    <Button
      size="sm"
      variant="outline"
      leftIcon={<RotateCcw />}
      loading={busy}
      className={className}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onRetry(n)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {t('outbox.retry')}
    </Button>
  )
}

function OutboxCard({
  n,
  onRetry,
  busy,
}: {
  n: Notification
  onRetry: (n: Notification) => void
  busy: boolean
}) {
  const { i18n, t } = useTranslation('notifications')
  return (
    <div className="flex min-w-0 items-start gap-3">
      <ChannelIcon channel={n.channel} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 font-semibold leading-snug">
          {templateLabel(n.template_code, i18n.language)}
        </span>
        <div className="truncate text-sm">
          {n.recipient_name ?? t('outbox.no_name')}{' '}
          <span className="text-muted-foreground tabular-nums">· {recipientText(n.recipient)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-0.5">
          <StatusChip status={n.status} error={n.error} size="sm" />
          <TimeCell n={n} className="text-xs text-muted-foreground" />
          {n.can_retry ? (
            <RetryButton n={n} onRetry={onRetry} busy={busy} className="ms-auto h-10" />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Banner({
  tone,
  icon,
  title,
  action,
  children,
}: {
  tone: 'info' | 'warning' | 'danger'
  icon: ReactNode
  title?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center',
        tone === 'info' && 'border-info/30 bg-info-soft text-info-soft-foreground',
        tone === 'warning' && 'border-warning/30 bg-warning-soft text-warning-soft-foreground',
        tone === 'danger' && 'border-danger/30 bg-danger-soft text-danger-soft-foreground',
      )}
    >
      <span className="hidden shrink-0 sm:block [&_svg]:size-5" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {title ? <p className="font-semibold">{title}</p> : null}
        <p>{children}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
