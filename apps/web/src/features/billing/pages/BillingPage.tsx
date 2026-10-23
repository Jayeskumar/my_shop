/**
 * Plan & billing (/settings/billing, cloud mode, permission billing.manage):
 *  - Current plan & subscription status, trial countdown, cancel at period end
 *  - Usage meters vs plan limits (stores, users, counters, products, monthly bills)
 *  - Plan comparison cards (Thodakkam, Valarchi, Peru) with monthly/yearly toggle, coupon quote
 *    and checkout via Razorpay
 *  - Billing history & GST invoices
 */
import type { BillingCycle } from '@kadai/shared'
import {
  type BillingPlan,
  CLOUD_PLAN_NAMES,
  PURCHASABLE_CLOUD_PLANS,
  platformRoutes,
} from '@kadai/shared/api/platform'
import { Check, ExternalLink, Sparkles, Tag } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Money,
  PageHeader,
  Skeleton,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { describeError } from '@/lib/errors'
import { formatDate, formatMoney, formatNumber } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

export default function BillingPage() {
  const { t } = useTranslation(['billing', 'common', 'nav'])
  const confirm = useConfirm()
  const overview = useRouteQuery(platformRoutes.billingSubscription, {})
  const plansQuery = useRouteQuery(platformRoutes.billingPlans, {})
  const invoicesQuery = useRouteQuery(platformRoutes.billingInvoices, {
    query: { limit: 25, offset: 0 },
  })

  const [cycle, setCycle] = useState<BillingCycle>('yearly')
  const [selectedPlan, setSelectedPlan] = useState<'growth' | 'pro'>('growth')
  const [coupon, setCoupon] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null)
  const [autoRenew, setAutoRenew] = useState(false)

  const quoteMutation = useRouteMutation(platformRoutes.billingQuote)
  const checkoutMutation = useRouteMutation(platformRoutes.billingCheckout, {
    invalidates: [platformRoutes.billingSubscription, platformRoutes.billingInvoices],
  })
  const cancelMutation = useRouteMutation(platformRoutes.billingCancel, {
    invalidates: [platformRoutes.billingSubscription],
  })

  const data = overview.data?.data
  const plans = plansQuery.data?.data.plans ?? []
  const invoices = invoicesQuery.data?.data ?? []

  const handleQuote = (planCode: 'growth' | 'pro', nextCycle: BillingCycle, code: string | null) => {
    quoteMutation.mutate({
      body: {
        plan_code: planCode,
        cycle: nextCycle,
        ...(code ? { coupon_code: code } : {}),
      },
    })
  }

  const handleCheckout = async (planCode: 'growth' | 'pro') => {
    try {
      const res = await checkoutMutation.mutateAsync({
        body: {
          plan_code: planCode,
          cycle,
          ...(appliedCoupon ? { coupon_code: appliedCoupon } : {}),
          auto_renew: cycle === 'monthly' ? autoRenew : false,
        },
      })
      if (res.data.short_url) {
        window.open(res.data.short_url, '_blank', 'noopener,noreferrer')
      }
      notify.success(t('plans.checkout_opened'))
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  const handleCancel = async () => {
    const ok = await confirm({
      title: t('current_plan.cancel_confirm_title'),
      description: t('current_plan.cancel_confirm_desc'),
      tone: 'danger',
      confirmLabel: t('current_plan.cancel'),
    })
    if (!ok) return
    try {
      await cancelMutation.mutateAsync({ body: {} })
      notify.success(t('current_plan.cancelled_toast'))
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  if (overview.isPending || plansQuery.isPending) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6 pb-8" aria-busy="true">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6 pb-8">
        <PageHeader
          title={t('title')}
          description={t('description')}
          backTo="/settings"
        />
        <EmptyState
          title={t('load_error')}
          description={describeError(overview.error).title}
          action={
            <Button variant="outline" onClick={() => void overview.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      </div>
    )
  }

  const sub = data.subscription
  const planDisplay = CLOUD_PLAN_NAMES[data.plan.code]
  const currentTitle = planDisplay
    ? localizedName(planDisplay.en, planDisplay.ta)
    : localizedName(data.plan.name, data.plan.name_ta)

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 pb-8">
      <PageHeader
        title={t('title')}
        description={t('description')}
        backTo="/settings"
      />

      {/* Active automatic offers */}
      {data.offers.length > 0 ? (
        <div className="grid gap-2">
          {data.offers.map((offer) => (
            <div
              key={offer.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent-soft-foreground"
            >
              <div className="flex items-center gap-2 font-medium">
                <Tag className="size-4 shrink-0" aria-hidden />
                <span>{localizedName(offer.name, offer.name_ta)}</span>
                {offer.description ? (
                  <span className="text-xs opacity-80">
                    — {localizedName(offer.description, offer.description_ta)}
                  </span>
                ) : null}
              </div>
              {offer.code ? (
                <Badge tone="accent" size="sm" className="font-mono">
                  {offer.code}
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Pending checkout */}
      {data.pending_checkout ? (
        <Card className="border-warning/40 bg-warning-soft/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <p className="font-semibold">{t('pending_checkout.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('pending_checkout.description', {
                  amount: formatMoney(data.pending_checkout.total_paise),
                  plan: data.pending_checkout.plan_code,
                })}
              </p>
            </div>
            <Button
              asChild
              size="sm"
              rightIcon={<ExternalLink className="size-4" />}
            >
              <a
                href={data.pending_checkout.short_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('pending_checkout.pay_now')}
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Current plan & subscription */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('current_plan.title')}
            </p>
            <CardTitle className="mt-1 flex flex-wrap items-center gap-2 text-xl">
              <span>{currentTitle}</span>
              {data.trial.active && data.trial.days_left !== null ? (
                <Badge tone="info">
                  {t('current_plan.trial_badge', { days: data.trial.days_left })}
                </Badge>
              ) : sub?.status === 'past_due' ? (
                <Badge tone="danger">{t('current_plan.past_due_badge')}</Badge>
              ) : sub?.cancel_at_period_end ? (
                <Badge tone="warning">
                  {t('current_plan.cancelling_badge', {
                    date: formatDate(sub.current_period_end),
                  })}
                </Badge>
              ) : sub ? (
                <Badge tone="success">{t('current_plan.active_badge')}</Badge>
              ) : (
                <Badge tone="neutral">{t('current_plan.free_badge')}</Badge>
              )}
            </CardTitle>
          </div>
          {data.can_cancel ? (
            <Button
              variant="outline"
              size="sm"
              loading={cancelMutation.isPending}
              onClick={() => void handleCancel()}
            >
              {t('current_plan.cancel')}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-4">
          {sub ? (
            <p className="text-sm text-muted-foreground">
              {sub.cancel_at_period_end
                ? t('current_plan.ends_on', { date: formatDate(sub.current_period_end) })
                : t('current_plan.renews_on', { date: formatDate(sub.current_period_end) })}{' '}
              · {sub.auto_renew ? t('current_plan.auto_renew_on') : t('current_plan.prepaid')}
            </p>
          ) : null}

          {/* Usage meters */}
          <div className="grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.usage.map((u) => {
              const pct = u.used_bp !== null ? Math.min(100, Math.round(u.used_bp / 100)) : 0
              return (
                <div
                  key={u.metric}
                  className="grid gap-1.5 rounded-lg border border-border bg-surface-2/50 p-3"
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{t(`usage.metrics.${u.metric}`)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {u.limit === null
                        ? t('usage.unlimited', { used: formatNumber(u.used) })
                        : t('usage.of_limit', {
                            used: formatNumber(u.used),
                            limit: formatNumber(u.limit),
                          })}
                    </span>
                  </div>
                  {u.limit !== null ? (
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          u.state === 'at_limit'
                            ? 'bg-danger'
                            : u.state === 'warning'
                              ? 'bg-warning'
                              : 'bg-primary',
                        )}
                        style={{ width: `${String(pct)}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Plan selection & quote */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('plans.title')}</CardTitle>
          <div className="inline-flex rounded-lg bg-surface-2 p-1">
            <button
              type="button"
              onClick={() => {
                setCycle('monthly')
                handleQuote(selectedPlan, 'monthly', appliedCoupon)
              }}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                cycle === 'monthly' ? 'bg-surface shadow-card' : 'text-muted-foreground',
              )}
            >
              {t('plans.cycle_monthly')}
            </button>
            <button
              type="button"
              onClick={() => {
                setCycle('yearly')
                handleQuote(selectedPlan, 'yearly', appliedCoupon)
              }}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                cycle === 'yearly' ? 'bg-surface shadow-card' : 'text-muted-foreground',
              )}
            >
              {t('plans.cycle_yearly')}
            </button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-4 md:grid-cols-3">
            {plans.map((p: BillingPlan) => {
              const names = CLOUD_PLAN_NAMES[p.code]
              const title = names
                ? localizedName(names.en, names.ta)
                : localizedName(p.name, p.name_ta)
              const priceExcl =
                cycle === 'yearly' ? p.price_yearly_paise : p.price_monthly_paise
              const priceIncl =
                cycle === 'yearly'
                  ? p.price_yearly_incl_gst_paise
                  : p.price_monthly_incl_gst_paise
              const canBuy = (PURCHASABLE_CLOUD_PLANS as readonly string[]).includes(p.code)
              const isSelected = selectedPlan === p.code
              return (
                <div
                  key={p.code}
                  className={cn(
                    'flex flex-col justify-between gap-4 rounded-xl border p-4',
                    p.recommended
                      ? 'border-primary bg-primary-soft/20'
                      : 'border-border bg-surface',
                    isSelected && canBuy && 'ring-2 ring-primary',
                  )}
                >
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-semibold">{title}</h3>
                      {p.recommended ? (
                        <Badge tone="primary" size="sm">
                          <Sparkles className="me-1 size-3" />
                          {t('plans.recommended')}
                        </Badge>
                      ) : p.is_current ? (
                        <Badge tone="neutral" size="sm">
                          {t('plans.current')}
                        </Badge>
                      ) : null}
                    </div>
                    {p.description ? (
                      <p className="text-xs text-muted-foreground">{p.description}</p>
                    ) : null}
                    <div className="pt-2">
                      <span className="text-2xl font-bold tabular-nums">
                        {priceExcl === 0 ? t('plans.free_forever') : formatMoney(priceExcl, { decimals: 0 })}
                      </span>
                      {priceExcl > 0 ? (
                        <>
                          <span className="text-sm text-muted-foreground">
                            {cycle === 'yearly' ? t('plans.per_year') : t('plans.per_month')}
                          </span>
                          <p className="text-xs text-muted-foreground">
                            {t('plans.excl_gst', {
                              incl: formatMoney(priceIncl, { decimals: 0 }),
                            })}
                          </p>
                        </>
                      ) : null}
                      {cycle === 'yearly' && p.yearly_savings_paise > 0 ? (
                        <Badge tone="success" size="sm" className="mt-1">
                          {t('plans.save_yearly', {
                            amount: formatMoney(p.yearly_savings_paise, { decimals: 0 }),
                          })}
                        </Badge>
                      ) : null}
                    </div>
                    <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                      <li className="flex items-center gap-1.5">
                        <Check className="size-3.5 text-success" />
                        {t('usage.metrics.stores')}:{' '}
                        {p.limits.stores === null ? '∞' : p.limits.stores}
                      </li>
                      <li className="flex items-center gap-1.5">
                        <Check className="size-3.5 text-success" />
                        {t('usage.metrics.registers')}:{' '}
                        {p.limits.registers === null ? '∞' : p.limits.registers}
                      </li>
                      <li className="flex items-center gap-1.5">
                        <Check className="size-3.5 text-success" />
                        {t('usage.metrics.users')}:{' '}
                        {p.limits.users === null ? '∞' : p.limits.users}
                      </li>
                      <li className="flex items-center gap-1.5">
                        <Check className="size-3.5 text-success" />
                        {t('usage.metrics.products')}:{' '}
                        {p.limits.products === null ? '∞' : formatNumber(p.limits.products)}
                      </li>
                    </ul>
                  </div>
                  {canBuy ? (
                    <Button
                      variant={isSelected ? 'primary' : 'outline'}
                      onClick={() => {
                        const code = p.code as 'growth' | 'pro'
                        setSelectedPlan(code)
                        handleQuote(code, cycle, appliedCoupon)
                      }}
                    >
                      {t('plans.select', { plan: names?.short ?? p.name })}
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>

          {/* Coupon & Checkout bar */}
          <div className="grid gap-4 rounded-xl border border-border bg-surface-2/40 p-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1">
                  <label htmlFor="billing-coupon" className="text-xs font-medium">
                    {t('plans.coupon_label')}
                  </label>
                  <Input
                    id="billing-coupon"
                    value={coupon}
                    onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                    placeholder={t('plans.coupon_placeholder')}
                    className="w-48 font-mono uppercase"
                  />
                </div>
                <Button
                  variant="outline"
                  loading={quoteMutation.isPending}
                  onClick={() => {
                    const clean = coupon.trim() || null
                    setAppliedCoupon(clean)
                    handleQuote(selectedPlan, cycle, clean)
                  }}
                >
                  {t('plans.coupon_apply')}
                </Button>
              </div>
              {cycle === 'monthly' ? (
                <Switch
                  checked={autoRenew}
                  onCheckedChange={setAutoRenew}
                  label={t('plans.auto_renew')}
                />
              ) : null}
              {quoteMutation.data?.data ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {t('plans.subtotal')}:{' '}
                    <Money paise={quoteMutation.data.data.quote.subtotal_paise} />
                  </span>
                  {quoteMutation.data.data.quote.discount_paise > 0 ? (
                    <span className="font-medium text-success">
                      {t('plans.discount')}: −
                      <Money paise={quoteMutation.data.data.quote.discount_paise} />
                    </span>
                  ) : null}
                  <span>
                    {t('plans.gst')}: <Money paise={quoteMutation.data.data.quote.tax_paise} />
                  </span>
                  <span className="font-semibold text-foreground">
                    {t('plans.total')}: <Money paise={quoteMutation.data.data.quote.total_paise} />
                  </span>
                </div>
              ) : null}
            </div>
            <Button
              size="lg"
              loading={checkoutMutation.isPending}
              onClick={() => void handleCheckout(selectedPlan)}
            >
              {t('plans.checkout')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Billing invoices */}
      <Card>
        <CardHeader>
          <CardTitle>{t('invoices.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('invoices.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-start text-xs text-muted-foreground">
                    <th className="py-2 pe-3 text-start">{t('invoices.col_number')}</th>
                    <th className="py-2 px-3 text-start">{t('invoices.col_date')}</th>
                    <th className="py-2 px-3 text-start">{t('invoices.col_plan')}</th>
                    <th className="py-2 px-3 text-end">{t('invoices.col_taxable')}</th>
                    <th className="py-2 px-3 text-end">{t('invoices.col_gst')}</th>
                    <th className="py-2 px-3 text-end">{t('invoices.col_total')}</th>
                    <th className="py-2 ps-3 text-end">{t('invoices.col_status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td className="py-2.5 pe-3 font-mono font-medium">{inv.number ?? '—'}</td>
                      <td className="py-2.5 px-3">{formatDate(inv.date)}</td>
                      <td className="py-2.5 px-3">{inv.plan_code ?? '—'}</td>
                      <td className="py-2.5 px-3 text-end tabular-nums">
                        <Money paise={inv.taxable_paise} />
                      </td>
                      <td className="py-2.5 px-3 text-end tabular-nums">
                        <Money paise={inv.cgst_paise + inv.sgst_paise + inv.igst_paise} />
                      </td>
                      <td className="py-2.5 px-3 text-end font-semibold tabular-nums">
                        <Money paise={inv.total_paise} />
                      </td>
                      <td className="py-2.5 ps-3 text-end">
                        <Badge
                          size="sm"
                          tone={inv.status === 'paid' ? 'success' : 'neutral'}
                        >
                          {t(`invoices.status.${inv.status}`)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
