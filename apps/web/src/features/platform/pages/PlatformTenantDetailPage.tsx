/**
 * Platform tenant detail (/platform/tenants/:id, cloud mode, platformAdmin):
 *  - Business profile, owner, GSTIN, usage vs limits
 *  - Suspend / Resume business and Change Plan dialogs
 *  - Platform audit trail for this tenant
 */
import { licensingRoutes } from '@kadai/shared/api/licensing'
import { AlertTriangle, Ban, CheckCircle2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  notify,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber, formatPhone } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

export default function PlatformTenantDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation(['platform', 'common'])
  const detailQuery = useRouteQuery(
    licensingRoutes.getTenant,
    { params: { id } },
    { enabled: Boolean(id) },
  )
  const plansQuery = useRouteQuery(licensingRoutes.listPlans, {})

  const [suspendOpen, setSuspendOpen] = useState(false)
  const [suspendReason, setSuspendReason] = useState('')
  const [planOpen, setPlanOpen] = useState(false)
  const [planCode, setPlanCode] = useState('growth')
  const [planReason, setPlanReason] = useState('')

  const suspendMutation = useRouteMutation(licensingRoutes.suspendTenant, {
    invalidates: [licensingRoutes.getTenant, licensingRoutes.listTenants],
  })
  const resumeMutation = useRouteMutation(licensingRoutes.resumeTenant, {
    invalidates: [licensingRoutes.getTenant, licensingRoutes.listTenants],
  })
  const changePlanMutation = useRouteMutation(licensingRoutes.changeTenantPlan, {
    invalidates: [licensingRoutes.getTenant, licensingRoutes.listTenants],
  })

  const tenant = detailQuery.data?.data
  const cloudPlans = (plansQuery.data?.data ?? []).filter((p) => p.channel === 'cloud')

  const handleSuspend = async () => {
    if (suspendReason.trim().length < 3) return
    try {
      await suspendMutation.mutateAsync({
        params: { id },
        body: { reason: suspendReason.trim() },
      })
      setSuspendOpen(false)
      setSuspendReason('')
      notify.success(t('tenant_detail.suspend_dialog.toast'))
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  const handleResume = async () => {
    try {
      await resumeMutation.mutateAsync({ params: { id }, body: {} })
      notify.success(t('tenant_detail.resume_toast'))
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  const handleChangePlan = async () => {
    if (planReason.trim().length < 3) return
    try {
      await changePlanMutation.mutateAsync({
        params: { id },
        body: {
          plan_code: planCode,
          reason: planReason.trim(),
        },
      })
      setPlanOpen(false)
      setPlanReason('')
      notify.success(t('tenant_detail.plan_dialog.toast'))
    } catch (err) {
      notify.error(describeError(err).title)
    }
  }

  if (detailQuery.isPending) {
    return (
      <div className="grid gap-4 pb-8" aria-busy="true">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    )
  }

  if (!tenant) {
    return (
      <EmptyState
        title={t('tenant_detail.load_error')}
        description={describeError(detailQuery.error).title}
        action={
          <Button variant="outline" onClick={() => void detailQuery.refetch()}>
            {t('common:actions.retry')}
          </Button>
        }
      />
    )
  }

  const name = localizedName(tenant.name, tenant.name_ta)

  return (
    <div className="grid gap-6 pb-8">
      <PageHeader
        title={name}
        backTo="/platform/tenants"
        meta={
          <div className="flex items-center gap-2">
            <Badge tone="info" className="font-mono uppercase">
              {tenant.plan_code}
            </Badge>
            <Badge tone={tenant.status === 'active' ? 'success' : 'danger'}>
              {t(`tenants.status.${tenant.status}`)}
            </Badge>
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              leftIcon={<Sparkles />}
              onClick={() => {
                setPlanCode(tenant.plan_code)
                setPlanOpen(true)
              }}
            >
              {t('tenant_detail.change_plan')}
            </Button>
            {tenant.status === 'suspended' ? (
              <Button
                leftIcon={<CheckCircle2 />}
                loading={resumeMutation.isPending}
                onClick={() => void handleResume()}
              >
                {t('tenant_detail.resume')}
              </Button>
            ) : (
              <Button
                variant="outline"
                leftIcon={<Ban className="text-danger" />}
                onClick={() => setSuspendOpen(true)}
              >
                {t('tenant_detail.suspend')}
              </Button>
            )}
          </div>
        }
      />

      {tenant.status === 'suspended' && tenant.suspended_reason ? (
        <div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span>{t('tenant_detail.suspended_banner', { reason: tenant.suspended_reason })}</span>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('tenant_detail.profile_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.owner')}</dt>
                <dd className="font-medium">
                  {tenant.owner_name ?? '—'}{' '}
                  {tenant.owner_phone ? `(${formatPhone(tenant.owner_phone)})` : ''}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.gstin')}</dt>
                <dd className="font-mono">{tenant.gstin ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.scheme')}</dt>
                <dd>{tenant.gst_scheme}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.state')}</dt>
                <dd>{tenant.state_code}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.created')}</dt>
                <dd>{formatDate(tenant.created_at)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('tenant_detail.usage_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.stores')}</dt>
                <dd className="font-semibold tabular-nums">
                  {tenant.usage.stores} / {tenant.entitlements.limits.stores ?? '∞'}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.users')}</dt>
                <dd className="font-semibold tabular-nums">
                  {tenant.usage.users} / {tenant.entitlements.limits.users ?? '∞'}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.registers')}</dt>
                <dd className="font-semibold tabular-nums">
                  {tenant.usage.registers} / {tenant.entitlements.limits.registers ?? '∞'}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.products')}</dt>
                <dd className="font-semibold tabular-nums">
                  {formatNumber(tenant.usage.products)} /{' '}
                  {tenant.entitlements.limits.products === null
                    ? '∞'
                    : formatNumber(tenant.entitlements.limits.products)}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t('tenant_detail.bills_month')}</dt>
                <dd className="font-semibold tabular-nums">
                  {formatNumber(tenant.usage.invoices_this_month)} /{' '}
                  {tenant.entitlements.limits.invoices_per_month === null
                    ? '∞'
                    : formatNumber(tenant.entitlements.limits.invoices_per_month)}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('tenant_detail.audit_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {tenant.audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('overview.no_audit')}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {tenant.audit.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                  <div>
                    <Badge tone="neutral" size="sm" className="font-mono">
                      {a.action}
                    </Badge>{' '}
                    {a.actor_name ? (
                      <span className="text-xs text-muted-foreground">by {a.actor_name}</span>
                    ) : null}
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatDateTime(a.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Suspend dialog */}
      <Dialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={t('tenant_detail.suspend_dialog.title', { name })}
        description={t('tenant_detail.suspend_dialog.desc')}
        footer={
          <>
            <Button variant="outline" onClick={() => setSuspendOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              loading={suspendMutation.isPending}
              disabled={suspendReason.trim().length < 3}
              onClick={() => void handleSuspend()}
            >
              {t('tenant_detail.suspend_dialog.confirm')}
            </Button>
          </>
        }
      >
        <div className="grid gap-1.5">
          <label htmlFor="suspend-reason" className="text-sm font-medium">
            {t('tenant_detail.suspend_dialog.reason_label')}
          </label>
          <Input
            id="suspend-reason"
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
            placeholder={t('tenant_detail.suspend_dialog.reason_placeholder')}
            autoFocus
          />
        </div>
      </Dialog>

      {/* Change plan dialog */}
      <Dialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        title={t('tenant_detail.plan_dialog.title', { name })}
        footer={
          <>
            <Button variant="outline" onClick={() => setPlanOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              loading={changePlanMutation.isPending}
              disabled={planReason.trim().length < 3}
              onClick={() => void handleChangePlan()}
            >
              {t('tenant_detail.plan_dialog.confirm')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="plan-select" className="text-sm font-medium">
              {t('tenant_detail.plan_dialog.plan_label')}
            </label>
            <Select
              id="plan-select"
              value={planCode}
              onValueChange={setPlanCode}
              options={
                cloudPlans.length > 0
                  ? cloudPlans.map((p) => ({ value: p.code, label: `${p.name} (${p.code})` }))
                  : [
                      { value: 'free', label: 'Free (free)' },
                      { value: 'growth', label: 'Growth (growth)' },
                      { value: 'pro', label: 'Pro (pro)' },
                      { value: 'enterprise', label: 'Enterprise (enterprise)' },
                    ]
              }
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="plan-reason" className="text-sm font-medium">
              {t('tenant_detail.plan_dialog.reason_label')}
            </label>
            <Input
              id="plan-reason"
              value={planReason}
              onChange={(e) => setPlanReason(e.target.value)}
              placeholder={t('tenant_detail.plan_dialog.reason_placeholder')}
            />
          </div>
        </div>
      </Dialog>
    </div>
  )
}
