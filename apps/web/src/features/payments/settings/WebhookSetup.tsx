/**
 * Razorpay webhook instructions: the URL to paste (with copy), the events to tick and what to do
 * on Kadai Server without a public address (status polling makes the webhook optional).
 */
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PaymentProviderAccount } from '@kadai/shared/api/payments'
import { CopyButton } from '@/components/ui'
import { cn } from '@/lib/cn'

export function WebhookSetup({
  account,
  className,
  compact = false,
}: {
  account: Pick<PaymentProviderAccount, 'webhook_url' | 'webhook_events' | 'has_webhook_secret'>
  className?: string
  /** Card view: URL + events only, no step list. */
  compact?: boolean
}) {
  const { t } = useTranslation('payments')
  const events = account.webhook_events
  if (!account.webhook_url) {
    return (
      <p
        className={cn(
          'flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-sm text-info-soft-foreground',
          className,
        )}
      >
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t('settings.razorpay.no_public_url')}</span>
      </p>
    )
  }
  return (
    <div className={cn('grid gap-3 text-sm', className)}>
      {!compact ? <p className="font-medium">{t('settings.razorpay.webhook_title')}</p> : null}
      {!compact ? (
        <ol className="grid list-decimal gap-1 ps-5 text-muted-foreground">
          <li>{t('settings.razorpay.webhook_step_open')}</li>
          <li>{t('settings.razorpay.webhook_step_url')}</li>
          <li>{t('settings.razorpay.webhook_step_secret')}</li>
          <li>{t('settings.razorpay.webhook_step_events')}</li>
        </ol>
      ) : null}
      <div className="grid gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t('fields.webhook_url')}
        </span>
        <div className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-surface-2 ps-3">
          <code className="min-w-0 flex-1 truncate py-2 text-xs" title={account.webhook_url}>
            {account.webhook_url}
          </code>
          <CopyButton value={account.webhook_url} label={t('settings.razorpay.copy_url')} />
        </div>
      </div>
      {events.length ? (
        <div className="grid gap-1">
          <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            {t('fields.webhook_events')}
            <CopyButton
              value={events.join(', ')}
              label={t('settings.razorpay.copy_events')}
              size="sm"
            />
          </span>
          <ul className="flex flex-wrap gap-1.5">
            {events.map((e) => (
              <li key={e}>
                <code className="rounded bg-surface-2 px-2 py-1 text-xs">{e}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!account.has_webhook_secret ? (
        <p className="text-xs text-warning-soft-foreground">
          {t('settings.razorpay.no_webhook_secret')}
        </p>
      ) : null}
    </div>
  )
}
