/**
 * "Sending services": one card per channel (WhatsApp, SMS, email) from the catalogue's provider
 * status — sending / only recorded (log provider) / not set up — with the sender shown by the
 * provider, the delivery-receipts URL to paste in the provider dashboard (copy), how to get it
 * set up (cloud: Kadai does it; on-prem: Kadai messaging relay or the partner) and "Send a test".
 */
import { CheckCircle2, CircleDashed, CircleOff, Send, Server } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { NotificationProviderStatus } from '@kadai/shared/api/notifications'
import type { NotificationChannel } from '@kadai/shared/enums'
import { Badge, Button, CopyButton } from '@/components/ui'
import { useAuth, useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { ChannelIcon } from '../components/ChannelIcon'
import { channelLabel, providerLabel } from '../lib/labels'
import { type ProviderState, providerState, testTemplateFor } from '../lib/providers'
import { SettingsSection } from './SettingsSection'
import { TestMessageDialog } from './TestMessageDialog'

const ORDER: readonly NotificationChannel[] = ['whatsapp', 'sms', 'email']

export function ProviderCards({ providers }: { providers: readonly NotificationProviderStatus[] }) {
  const { t, i18n } = useTranslation('notifications')
  const mode = useAuth((s) => s.me?.mode ?? s.deployment.mode)
  const canSend = useCan('notifications.send')
  const [testChannel, setTestChannel] = useState<NotificationChannel | null>(null)
  const sorted = [...providers].sort((a, b) => ORDER.indexOf(a.channel) - ORDER.indexOf(b.channel))
  const anyNotLive = sorted.some((p) => !p.live)
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <SettingsSection
      id="providers"
      icon={<Server />}
      title={t('settings.providers_title')}
      description={t('settings.providers_hint')}
    >
      <ul className="grid gap-3 md:grid-cols-3">
        {sorted.map((p) => {
          const state = providerState(p)
          const testCode = testTemplateFor(p.channel)
          return (
            <li
              key={p.channel}
              className={cn(
                'flex min-w-0 flex-col gap-3 rounded-xl border p-4',
                state === 'live' ? 'border-success/30 bg-success-soft/30' : 'border-border',
              )}
              data-testid={`provider-${p.channel}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  <ChannelIcon channel={p.channel} size="lg" />
                  <div className="min-w-0">
                    <p className="font-semibold">{channelLabel(p.channel, i18n.language)}</p>
                    <p className="text-xs text-muted-foreground">
                      {providerLabel(p.provider, i18n.language)}
                    </p>
                  </div>
                </div>
                <StateBadge state={state} />
              </div>
              <p className="text-sm text-muted-foreground">
                {p.provider === 'kadai_relay' && state === 'live'
                  ? t('settings.relay_hint')
                  : t(`settings.provider_${state}_hint`)}
              </p>
              {p.display ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">{t('settings.sender')}: </span>
                  <span className="font-medium">{p.display}</span>
                </p>
              ) : null}
              {p.webhook_path ? (
                <div className="grid gap-1">
                  <p className="text-xs font-medium">{t('settings.webhook')}</p>
                  <div className="flex min-w-0 items-center gap-1 rounded-md bg-surface-2 py-1 ps-2.5 pe-1">
                    <code
                      className="min-w-0 flex-1 truncate text-xs"
                      title={origin + p.webhook_path}
                    >
                      {origin + p.webhook_path}
                    </code>
                    <CopyButton
                      value={origin + p.webhook_path}
                      label={t('settings.copy_webhook')}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t('settings.webhook_hint')}</p>
                </div>
              ) : null}
              {canSend && testCode && state !== 'off' ? (
                <Button
                  variant="outline"
                  leftIcon={<Send />}
                  className="mt-auto self-start"
                  onClick={() => setTestChannel(p.channel)}
                >
                  {t('settings.test_send')}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
      {anyNotLive ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground">
            {mode === 'onprem' ? t('settings.setup_onprem') : t('settings.setup_cloud')}
          </p>
          {mode === 'onprem' ? (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to="/settings/system">{t('settings.open_system')}</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      <TestMessageDialog
        channel={testChannel}
        template={testChannel ? (testTemplateFor(testChannel) ?? null) : null}
        onOpenChange={(open) => !open && setTestChannel(null)}
      />
    </SettingsSection>
  )
}

function StateBadge({ state }: { state: ProviderState }) {
  const { t } = useTranslation('notifications')
  if (state === 'live')
    return (
      <Badge tone="success" icon={<CheckCircle2 aria-hidden />}>
        {t('settings.provider_live')}
      </Badge>
    )
  if (state === 'log')
    return (
      <Badge tone="warning" icon={<CircleDashed aria-hidden />}>
        {t('settings.provider_log')}
      </Badge>
    )
  return (
    <Badge tone="neutral" icon={<CircleOff aria-hidden />}>
      {t('settings.provider_off')}
    </Badge>
  )
}
