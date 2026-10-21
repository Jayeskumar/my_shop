/**
 * UPI & payment setup (/settings/payments, permission payments.configure):
 *
 *  1. The two ways to take UPI, explained in plain words — the shop's own UPI ID (free, the
 *     cashier confirms) or Razorpay (automatic confirmation, Razorpay charges a fee; plan
 *     feature upi_dynamic).
 *  2. The shop's payment accounts: test (₹1 QR for a UPI ID, credential check for Razorpay),
 *     default per store, edit, standee QR poster, deactivate / reactivate.
 */
import { Check, Lock, QrCode as QrIcon, Smartphone, Wallet, Zap } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { PaymentProviderAccount, ProviderTestResult } from '@kadai/shared/api/payments'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  notify,
  useConfirm,
} from '@/components/ui'
import { useCan, useDeployment, useFeature, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
  useDeactivateProvider,
  useProviders,
  useTestProvider,
  useUpdateProvider,
} from '../api'
import { bilingualName } from '../lib/labels'
import { ProviderCard, type ProviderTestState } from './ProviderCard'
import { RazorpayDialog } from './RazorpayDialog'
import { StandeeDialog } from './StandeeDialog'
import { TestQrDialog } from './TestQrDialog'
import { UpiVpaDialog } from './UpiVpaDialog'
import { notifyPaymentError } from '../lib/errors'

type Editor =
  | { kind: 'upi_vpa'; account: PaymentProviderAccount | null }
  | { kind: 'razorpay'; account: PaymentProviderAccount | null }

export default function PaymentSettingsPage() {
  const { t, i18n } = useTranslation(['payments', 'common', 'nav'])
  const me = useMe()
  const deployment = useDeployment()
  const mode = me?.mode ?? deployment.mode
  const dynamicInPlan = useFeature('upi_dynamic')
  const canStandee = useCan('payments.collect')
  const confirm = useConfirm()
  const providers = useProviders({ limit: 200 })
  const update = useUpdateProvider()
  const deactivate = useDeactivateProvider()
  const test = useTestProvider()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [standeeFor, setStandeeFor] = useState<string | null | undefined>(undefined)
  const [testResults, setTestResults] = useState<Record<string, ProviderTestState>>({})
  const [testQr, setTestQr] = useState<{
    account: PaymentProviderAccount
    result: ProviderTestResult
  } | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  const accounts = useMemo(() => providers.data?.data ?? [], [providers.data])
  const active = accounts.filter((a) => a.is_active)
  const inactive = accounts.filter((a) => !a.is_active)
  const vpaAccounts = active.filter((a) => a.provider === 'upi_vpa')
  const hasDefault = active.some((a) => a.is_default)

  const storeLabel = (account: PaymentProviderAccount): string => {
    if (!account.store_id) return t('common:misc.all_stores')
    const store = me?.stores.find((s) => s.id === account.store_id)
    if (store) return bilingualName(store.name, store.name_ta, i18n.language).primary
    return account.store_name ?? t('common:misc.not_available')
  }

  const runTest = (account: PaymentProviderAccount): void => {
    test.mutate(
      { params: { id: account.id } },
      {
        onSuccess: (res) => {
          const result = res.data
          if (account.provider === 'upi_vpa' && result.test_upi_uri) {
            setTestQr({ account, result })
            return
          }
          setTestResults((r) => ({
            ...r,
            [account.id]: { ok: result.ok, message: result.ok ? null : result.message },
          }))
          if (result.ok) notify.success(t('settings.test_ok_razorpay'))
        },
        onError: notifyPaymentError,
      },
    )
  }

  const makeDefault = (account: PaymentProviderAccount): void => {
    update.mutate(
      {
        params: { id: account.id },
        body: { is_default: true, if_updated_at: account.updated_at },
      },
      {
        onSuccess: () =>
          notify.success(t('settings.default_toast', { name: account.display_name })),
        onError: (e) => notifyPaymentError(e),
      },
    )
  }

  const reactivate = (account: PaymentProviderAccount): void => {
    update.mutate(
      {
        params: { id: account.id },
        body: { is_active: true, if_updated_at: account.updated_at },
      },
      {
        onSuccess: () =>
          notify.success(t('settings.reactivated_toast', { name: account.display_name })),
        onError: (e) => notifyPaymentError(e),
      },
    )
  }

  const askDeactivate = async (account: PaymentProviderAccount): Promise<void> => {
    const ok = await confirm({
      title: t('settings.deactivate_title', { name: account.display_name }),
      description: account.is_default
        ? t('settings.deactivate_default_hint')
        : t('settings.deactivate_hint'),
      confirmLabel: t('settings.deactivate'),
      tone: 'danger',
    })
    if (!ok) return
    deactivate.mutate(
      { params: { id: account.id } },
      {
        onSuccess: () =>
          notify.success(t('settings.deactivated_toast', { name: account.display_name })),
        onError: notifyPaymentError,
      },
    )
  }

  const upgradeTo = mode === 'onprem' ? '/settings/system' : '/settings/billing'

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <PageHeader
        title={t('nav:titles.settings_payments')}
        description={t('settings.page_hint')}
        backTo="/settings"
        actions={
          vpaAccounts.length && canStandee ? (
            <Button
              variant="outline"
              leftIcon={<QrIcon />}
              onClick={() => setStandeeFor(vpaAccounts.find((a) => a.is_default)?.id ?? null)}
            >
              {t('standee.open')}
            </Button>
          ) : null
        }
      />

      <section aria-labelledby="pay-options" className="grid gap-3">
        <h2 id="pay-options" className="text-lg font-semibold">
          {t('settings.options_title')}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <OptionCard
            icon={<Smartphone className="size-5" />}
            tone="primary"
            title={t('settings.option_vpa_title')}
            tagline={t('settings.option_vpa_tagline')}
            badge={<Badge tone="success">{t('settings.free')}</Badge>}
            points={[
              t('settings.option_vpa_point_free'),
              t('settings.option_vpa_point_offline'),
              t('settings.option_vpa_point_manual'),
            ]}
            action={
              <Button
                size="lg"
                fullWidth
                onClick={() => setEditor({ kind: 'upi_vpa', account: null })}
              >
                {t('settings.add_vpa')}
              </Button>
            }
          />
          <OptionCard
            icon={<Zap className="size-5" />}
            tone="accent"
            title={t('settings.option_rzp_title')}
            tagline={t('settings.option_rzp_tagline')}
            badge={<Badge tone="warning">{t('settings.fees_apply')}</Badge>}
            points={[
              t('settings.option_rzp_point_auto'),
              t('settings.option_rzp_point_links'),
              t('settings.option_rzp_point_fee'),
              ...(mode === 'onprem' ? [t('settings.option_rzp_point_onprem')] : []),
            ]}
            action={
              dynamicInPlan ? (
                <Button
                  size="lg"
                  variant="accent"
                  fullWidth
                  onClick={() => setEditor({ kind: 'razorpay', account: null })}
                >
                  {t('settings.add_razorpay')}
                </Button>
              ) : (
                <div className="grid gap-2">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Lock className="size-4 shrink-0" aria-hidden />
                    {t('settings.rzp_upgrade_hint')}
                  </p>
                  <Button asChild size="lg" variant="outline" fullWidth>
                    <Link to={upgradeTo}>{t('settings.see_plans')}</Link>
                  </Button>
                </div>
              )
            }
          />
        </div>
      </section>

      <section aria-labelledby="pay-accounts" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="pay-accounts" className="text-lg font-semibold">
              {t('settings.accounts_title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('settings.accounts_hint')}</p>
          </div>
        </div>

        {providers.isPending ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        ) : providers.isError ? (
          <EmptyState
            title={t('settings.load_failed')}
            action={
              <Button variant="outline" onClick={() => void providers.refetch()}>
                {t('common:actions.retry')}
              </Button>
            }
          />
        ) : active.length === 0 ? (
          <EmptyState
            icon={<Wallet />}
            title={t('settings.empty_title')}
            description={t('settings.empty_hint')}
            action={
              <Button size="lg" onClick={() => setEditor({ kind: 'upi_vpa', account: null })}>
                {t('settings.add_vpa')}
              </Button>
            }
          />
        ) : (
          <>
            {!hasDefault ? (
              <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
                {t('settings.no_default_hint')}
              </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              {active.map((account) => (
                <ProviderCard
                  key={account.id}
                  account={account}
                  storeLabel={storeLabel(account)}
                  testState={testResults[account.id] ?? null}
                  testing={test.isPending && test.variables?.params.id === account.id}
                  busy={update.isPending}
                  canStandee={canStandee}
                  onTest={() => runTest(account)}
                  onMakeDefault={() => makeDefault(account)}
                  onEdit={() => setEditor({ kind: editorKind(account), account })}
                  onStandee={() => setStandeeFor(account.id)}
                  onDeactivate={() => void askDeactivate(account)}
                  onReactivate={() => reactivate(account)}
                />
              ))}
            </div>
          </>
        )}

        {inactive.length ? (
          <div className="grid gap-3">
            <Button
              variant="link"
              className="justify-self-start px-0"
              aria-expanded={showInactive}
              onClick={() => setShowInactive((v) => !v)}
            >
              {showInactive
                ? t('settings.hide_inactive')
                : t('settings.show_inactive', { count: inactive.length })}
            </Button>
            {showInactive ? (
              <div className="grid gap-4 md:grid-cols-2">
                {inactive.map((account) => (
                  <ProviderCard
                    key={account.id}
                    account={account}
                    storeLabel={storeLabel(account)}
                    testState={null}
                    testing={false}
                    busy={update.isPending}
                    canStandee={false}
                    onTest={() => runTest(account)}
                    onMakeDefault={() => makeDefault(account)}
                    onEdit={() => setEditor({ kind: editorKind(account), account })}
                    onStandee={() => setStandeeFor(account.id)}
                    onDeactivate={() => void askDeactivate(account)}
                    onReactivate={() => reactivate(account)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <UpiVpaDialog
        open={editor?.kind === 'upi_vpa'}
        onOpenChange={(o) => !o && setEditor(null)}
        account={editor?.kind === 'upi_vpa' ? editor.account : null}
        suggestDefault={!hasDefault}
        onSaved={(saved) => {
          // First UPI ID: offer the ₹1 self-test straight away.
          if (!editor?.account && saved.provider === 'upi_vpa') runTest(saved)
        }}
      />
      <RazorpayDialog
        open={editor?.kind === 'razorpay'}
        onOpenChange={(o) => !o && setEditor(null)}
        account={editor?.kind === 'razorpay' ? editor.account : null}
        suggestDefault={!hasDefault}
      />
      <StandeeDialog
        open={standeeFor !== undefined}
        onOpenChange={(o) => !o && setStandeeFor(undefined)}
        accounts={vpaAccounts}
        initialAccountId={standeeFor ?? null}
      />
      <TestQrDialog
        result={testQr?.result ?? null}
        account={testQr?.account ?? null}
        onOpenChange={(o) => !o && setTestQr(null)}
      />
    </div>
  )
}

function editorKind(account: PaymentProviderAccount): Editor['kind'] {
  return account.provider === 'upi_vpa' ? 'upi_vpa' : 'razorpay'
}

function OptionCard({
  icon,
  tone,
  title,
  tagline,
  badge,
  points,
  action,
}: {
  icon: ReactNode
  tone: 'primary' | 'accent'
  title: string
  tagline: string
  badge: ReactNode
  points: readonly string[]
  action: ReactNode
}) {
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-lg',
            tone === 'primary'
              ? 'bg-primary-soft text-primary'
              : 'bg-accent-soft text-accent-soft-foreground',
          )}
          aria-hidden
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{title}</h3>
            {badge}
          </div>
          <p className="text-sm font-medium text-foreground/80">{tagline}</p>
        </div>
      </div>
      <ul className="grid flex-1 gap-2 text-sm">
        {points.map((p) => (
          <li key={p} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      {action}
    </Card>
  )
}
