/**
 * Detail drawer of one outbox message (?id= on /notifications): the text as sent, the status
 * with the reason when it was not sent, recipient, provider reference, attempts, timeline, the
 * details used and the linked document; failed / not-sent messages can be retried here.
 */
import { ExternalLink, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  type Notification,
  isTemplateCode,
  NOTIFICATION_TEMPLATES,
} from '@kadai/shared/api/notifications'
import { Button, CopyButton, Drawer, EmptyState, Skeleton, SkeletonText } from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useNotification } from '../api'
import {
  errorInfo,
  placeholderLabel,
  providerLabel,
  recipientText,
  refLabel,
  templateLabel,
} from '../lib/labels'
import { ChannelIcon } from './ChannelIcon'
import { MessageBubble } from './MessageBubble'
import { StatusChip } from './StatusChip'

export function NotificationDetailDrawer({
  id,
  fallback,
  onOpenChange,
  onRetry,
  retrying,
  canRetry,
  autoRefresh,
}: {
  id: string | null
  /** The list row, shown while the detail loads. */
  fallback?: Notification | null
  onOpenChange: (open: boolean) => void
  onRetry: (n: Notification) => void
  retrying: boolean
  canRetry: boolean
  autoRefresh: boolean
}) {
  const { t, i18n } = useTranslation(['notifications', 'common'])
  const query = useNotification(id, autoRefresh)
  const n = query.data?.data ?? (fallback && fallback.id === id ? fallback : null)
  const info = n ? errorInfo(n.error, i18n.language) : null
  const sensitive = n
    ? isTemplateCode(n.template_code) && NOTIFICATION_TEMPLATES[n.template_code].sensitive
    : false

  return (
    <Drawer
      open={id !== null}
      onOpenChange={onOpenChange}
      title={t('detail.title')}
      description={n ? templateLabel(n.template_code, i18n.language) : undefined}
      className="w-[min(32rem,100vw)]"
      footer={
        n ? (
          <>
            {n.rendered_body ? (
              <CopyButtonWithText value={n.rendered_body} label={t('detail.copy_message')} />
            ) : null}
            {n.can_retry && canRetry ? (
              <Button
                leftIcon={<RotateCcw />}
                onClick={() => onRetry(n)}
                loading={retrying}
                size="lg"
              >
                {t('outbox.retry')}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {!n && query.isPending ? (
        <div className="grid gap-4" aria-busy="true">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-28 w-full" />
          <SkeletonText lines={5} />
        </div>
      ) : !n ? (
        <EmptyState
          compact
          title={t('detail.load_error')}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <ChannelIcon channel={n.channel} showLabel size="md" />
            <StatusChip status={n.status} error={n.error} />
          </div>

          {info ? (
            <section
              aria-labelledby="why-title"
              className={
                n.status === 'failed'
                  ? 'rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground'
                  : 'rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground'
              }
            >
              <h3 id="why-title" className="font-semibold">
                {t('detail.why_title')}
              </h3>
              <p className="mt-0.5">{info.reason}</p>
              {info.detail ? (
                <p className="mt-1 break-words text-xs opacity-80">
                  {t('detail.service_detail')}: {info.detail}
                </p>
              ) : null}
            </section>
          ) : null}

          <section aria-label={t('detail.message')} className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('detail.message')}
            </h3>
            {n.rendered_body ? (
              <MessageBubble
                channel={n.channel}
                body={n.rendered_body}
                locale={n.locale}
                testId="detail-body"
              />
            ) : (
              <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-muted-foreground">
                {sensitive ? t('detail.hidden') : t('detail.not_rendered')}
              </p>
            )}
          </section>

          <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
            <Row label={t('detail.recipient')}>
              <span className="font-medium">{n.recipient_name ?? t('outbox.no_name')}</span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="tabular-nums">{recipientText(n.recipient)}</span>
                <CopyButton value={n.recipient} size="sm" />
              </span>
            </Row>
            <Row label={t('detail.template')}>{templateLabel(n.template_code, i18n.language)}</Row>
            <Row label={t('detail.language')}>{t(`language.${n.locale}`)}</Row>
            {n.provider ? (
              <Row label={t('detail.provider')}>
                {providerLabel(n.provider, i18n.language)}
                {n.provider_message_id ? (
                  <span className="break-all font-mono text-xs text-muted-foreground">
                    {t('detail.provider_ref')}: {n.provider_message_id}
                  </span>
                ) : null}
              </Row>
            ) : null}
            <Row label={t('detail.attempts')}>
              <span className="tabular-nums">{n.attempts}</span>
            </Row>
            <Row label={t('detail.created_by')}>{n.created_by_name ?? t('detail.automatic')}</Row>
            {n.ref_type ? (
              <Row label={t('detail.source')}>
                {n.ref_path ? (
                  <Link
                    to={n.ref_path}
                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    {refLabel(n.ref_type)}
                    <ExternalLink className="size-3.5" aria-hidden />
                  </Link>
                ) : (
                  refLabel(n.ref_type)
                )}
              </Row>
            ) : null}
          </dl>

          <section aria-labelledby="timeline-title" className="grid gap-2">
            <h3
              id="timeline-title"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('detail.timeline')}
            </h3>
            <ol className="grid gap-2 border-s-2 border-border ps-4 text-sm">
              <TimelineItem label={t('detail.created')} at={n.created_at} />
              {n.scheduled_at !== n.created_at ? (
                <TimelineItem label={t('detail.scheduled')} at={n.scheduled_at} />
              ) : null}
              {n.sent_at ? <TimelineItem label={t('detail.sent')} at={n.sent_at} /> : null}
              {n.updated_at !== n.created_at ? (
                <TimelineItem label={t('detail.updated')} at={n.updated_at} />
              ) : null}
            </ol>
          </section>

          {Object.keys(n.params).length > 0 ? (
            <details className="group rounded-lg border border-border">
              <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium">
                {t('detail.details_used')}
              </summary>
              <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 border-t border-border px-3 py-2.5 text-xs">
                {Object.entries(n.params).map(([key, value]) => (
                  <ParamRow key={key} name={key} value={value} />
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      )}
    </Drawer>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-0.5">{children}</dd>
    </>
  )
}

function ParamRow({ name, value }: { name: string; value: string | number | boolean | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{placeholderLabel(name)}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words">
        {value === null || value === '' ? '—' : String(value)}
      </dd>
    </>
  )
}

function TimelineItem({ label, at }: { label: string; at: string }) {
  return (
    <li className="relative">
      <span
        className="absolute -start-[1.4rem] top-1.5 size-2.5 rounded-full border-2 border-surface bg-primary"
        aria-hidden
      />
      <span className="font-medium">{label}</span>{' '}
      <time dateTime={at} className="text-muted-foreground tabular-nums">
        {formatDateTime(at)}
      </time>
    </li>
  )
}

function CopyButtonWithText({ value, label }: { value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <CopyButton value={value} label={label} size="md" variant="outline" />
      <span className="sm:hidden">{label}</span>
    </span>
  )
}
