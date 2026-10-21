/**
 * One payment provider account on the setup page: what it is (UPI ID / Razorpay key, store,
 * settlement account, last check), its webhook setup (Razorpay) and the actions the owner needs:
 * test, make default, edit, standee QR, deactivate / reactivate.
 */
import {
  CheckCircle2,
  CircleAlert,
  MoreVertical,
  Pencil,
  PlugZap,
  Power,
  QrCode as QrIcon,
  Smartphone,
  Star,
  Zap,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type PaymentProviderAccount, UPI_MCC_OPTIONS } from '@kadai/shared/api/payments'
import {
  Badge,
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDateTime } from '@/lib/format'
import { pickLabel } from '../lib/labels'
import { WebhookSetup } from './WebhookSetup'

export interface ProviderTestState {
  ok: boolean
  message: string | null
}

export function ProviderCard({
  account,
  storeLabel,
  testState,
  testing,
  busy,
  canStandee,
  onTest,
  onMakeDefault,
  onEdit,
  onStandee,
  onDeactivate,
  onReactivate,
}: {
  account: PaymentProviderAccount
  /** "All stores" or the store name. */
  storeLabel: string
  testState: ProviderTestState | null
  testing: boolean
  busy: boolean
  canStandee: boolean
  onTest: () => void
  onMakeDefault: () => void
  onEdit: () => void
  onStandee: () => void
  onDeactivate: () => void
  onReactivate: () => void
}) {
  const { t, i18n } = useTranslation(['payments', 'common'])
  const isVpa = account.provider === 'upi_vpa'
  const mcc = UPI_MCC_OPTIONS.find((o) => o.code === account.merchant_code)
  const Icon = isVpa ? Smartphone : Zap

  const facts: { label: string; value: string; mono?: boolean }[] = [
    ...(account.vpa ? [{ label: t('fields.vpa'), value: account.vpa, mono: true }] : []),
    ...(account.key_id_masked
      ? [{ label: t('fields.key_id'), value: account.key_id_masked, mono: true }]
      : []),
    ...(account.payee_name ? [{ label: t('fields.payee_name'), value: account.payee_name }] : []),
    ...(account.merchant_code
      ? [
          {
            label: t('fields.merchant_code'),
            value: mcc ? `${mcc.code} · ${pickLabel(mcc, i18n.language)}` : account.merchant_code,
          },
        ]
      : []),
    { label: t('fields.store'), value: storeLabel },
    ...(account.settlement_account_name
      ? [{ label: t('fields.settlement_account'), value: account.settlement_account_name }]
      : []),
    {
      label: t('fields.last_verified'),
      value: account.last_verified_at
        ? formatDateTime(account.last_verified_at)
        : t('settings.never_checked'),
    },
  ]

  return (
    <Card
      className={cn('grid gap-4 p-4 sm:p-5', !account.is_active && 'opacity-75')}
      data-testid={`provider-${account.id}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-lg',
            isVpa ? 'bg-primary-soft text-primary' : 'bg-accent-soft text-accent-soft-foreground',
          )}
          aria-hidden
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold">{account.display_name}</h3>
            {account.is_default && account.is_active ? (
              <Badge tone="primary" icon={<Star aria-hidden />}>
                {t('settings.default_badge')}
              </Badge>
            ) : null}
            {account.mode === 'test' ? <Badge tone="warning">{t('mode.test')}</Badge> : null}
            {!account.is_active ? <Badge>{t('common:status.inactive')}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">{t(`provider.${account.provider}`)}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              icon={<MoreVertical />}
              label={t('settings.more_actions', { name: account.display_name })}
              variant="ghost"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
              {t('common:actions.edit')}
            </DropdownMenuItem>
            {account.is_active ? (
              <DropdownMenuItem icon={<Power />} tone="danger" onSelect={onDeactivate}>
                {t('settings.deactivate')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem icon={<Power />} onSelect={onReactivate}>
                {t('settings.reactivate')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{f.label}</dt>
            <dd className={cn('truncate', f.mono && 'font-mono text-[13px]')} title={f.value}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      {account.provider === 'razorpay' && account.is_active ? (
        <WebhookSetup account={account} compact />
      ) : null}

      {testState ? (
        <p
          role="status"
          className={cn(
            'flex items-start gap-2 rounded-md px-3 py-2 text-sm',
            testState.ok
              ? 'bg-success-soft text-success-soft-foreground'
              : 'bg-danger-soft text-danger-soft-foreground',
          )}
        >
          {testState.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span>
            {testState.ok ? t('settings.test_ok_razorpay') : t('settings.test_failed')}
            {testState.message ? ` — ${testState.message}` : ''}
          </span>
        </p>
      ) : null}

      {account.is_active ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" leftIcon={<PlugZap />} onClick={onTest} loading={testing}>
            {isVpa ? t('settings.test_qr') : t('settings.test_connection')}
          </Button>
          {!account.is_default ? (
            <Button variant="outline" leftIcon={<Star />} onClick={onMakeDefault} disabled={busy}>
              {t('settings.set_default')}
            </Button>
          ) : null}
          {isVpa && canStandee ? (
            <Button variant="ghost" leftIcon={<QrIcon />} onClick={onStandee}>
              {t('standee.open')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div>
          <Button variant="outline" leftIcon={<Power />} onClick={onReactivate} disabled={busy}>
            {t('settings.reactivate')}
          </Button>
        </div>
      )}
    </Card>
  )
}
