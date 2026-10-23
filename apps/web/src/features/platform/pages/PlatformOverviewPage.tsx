/**
 * Platform overview (/platform, cloud mode, platformAdmin):
 *  - Cloud & on-prem KPIs (MRR, cloud tenants, active licences, AMC renewals due, active installs)
 *  - Cloud businesses by plan and vertical
 *  - On-prem AMC pipeline (30 / 60 / 90 days)
 *  - Recent platform audit log
 */
import { licensingRoutes } from '@kadai/shared/api/licensing'
import {
  Building2,
  CalendarClock,
  IndianRupee,
  KeyRound,
  MonitorCheck,
  Sparkles,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Money,
  PageHeader,
  Skeleton,
  Stat,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import { formatBp, formatDateTime, formatNumber } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'

export default function PlatformOverviewPage() {
  const { t } = useTranslation(['platform', 'common'])
  const metricsQuery = useRouteQuery(licensingRoutes.metrics, { query: { months: 12 } })
  const auditQuery = useRouteQuery(licensingRoutes.listAuditLogs, {
    query: { limit: 10, offset: 0 },
  })

  const m = metricsQuery.data?.data
  const audits = auditQuery.data?.data ?? []

  return (
    <div className="grid gap-6 pb-8">
      <PageHeader
        title={t('overview.title')}
        description={t('overview.description')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" leftIcon={<Building2 />}>
              <Link to="/platform/tenants">{t('tenants.title')}</Link>
            </Button>
            <Button asChild variant="outline" leftIcon={<Sparkles />}>
              <Link to="/platform/plans">{t('plans.title')}</Link>
            </Button>
            <Button asChild variant="outline" leftIcon={<KeyRound />}>
              <Link to="/platform/licenses">{t('licenses.title')}</Link>
            </Button>
          </div>
        }
      />

      {metricsQuery.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ) : !m ? (
        <EmptyState
          title={t('overview.load_error')}
          description={describeError(metricsQuery.error).title}
          action={
            <Button variant="outline" onClick={() => void metricsQuery.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label={t('overview.kpi_mrr')}
              icon={<IndianRupee />}
              tone="primary"
              value={<Money paise={m.kpis.mrr_paise} decimals={0} />}
              hint={t('overview.kpi_tenants_hint', {
                paying: m.cloud.paying_tenants,
                trials: m.cloud.trials_active,
              })}
            />
            <Stat
              label={t('overview.kpi_tenants')}
              icon={<Building2 />}
              value={formatNumber(m.cloud.tenants_total)}
              hint={t('overview.kpi_tenants_hint', {
                paying: m.cloud.paying_tenants,
                trials: m.cloud.trials_active,
              })}
            />
            <Stat
              label={t('overview.kpi_licenses')}
              icon={<KeyRound />}
              value={formatNumber(m.kpis.active_licenses)}
              hint={`${t('overview.kpi_amc_due')}: ${formatNumber(m.kpis.amc_due_30d)}`}
            />
            <Stat
              label={t('overview.kpi_installs')}
              icon={<MonitorCheck />}
              value={formatNumber(m.kpis.active_installs_7d)}
              hint={t('overview.kpi_renewal_rate', {
                rate: formatBp(m.kpis.renewal_rate_bp),
              })}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('overview.cloud_by_plan')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border text-sm">
                  {m.cloud.by_plan.map((row) => (
                    <li key={row.key} className="flex items-center justify-between py-2">
                      <span className="font-mono font-medium uppercase">{row.key}</span>
                      <Badge tone="neutral">{formatNumber(row.count)}</Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('overview.cloud_by_type')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border text-sm">
                  {m.cloud.by_business_type.map((row) => (
                    <li key={row.key} className="flex items-center justify-between py-2">
                      <span className="font-medium">{row.key.replace(/_/g, ' ')}</span>
                      <Badge tone="info">{formatNumber(row.count)}</Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarClock className="size-4 text-primary" aria-hidden />
                  {t('overview.onprem_summary')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">{t('overview.amc_30d')}</dt>
                    <dd className="font-semibold tabular-nums">
                      {m.onprem.renewals_due.d30.count} (
                      <Money paise={m.onprem.renewals_due.d30.value_paise} decimals={0} />)
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">{t('overview.amc_60d')}</dt>
                    <dd className="font-semibold tabular-nums">
                      {m.onprem.renewals_due.d60.count} (
                      <Money paise={m.onprem.renewals_due.d60.value_paise} decimals={0} />)
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">{t('overview.amc_90d')}</dt>
                    <dd className="font-semibold tabular-nums">
                      {m.onprem.renewals_due.d90.count} (
                      <Money paise={m.onprem.renewals_due.d90.value_paise} decimals={0} />)
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('overview.recent_audit')}</CardTitle>
            </CardHeader>
            <CardContent>
              {audits.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('overview.no_audit')}</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {audits.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral" size="sm" className="font-mono">
                          {a.action}
                        </Badge>
                        {a.tenant_name ? (
                          <span className="font-medium">{a.tenant_name}</span>
                        ) : null}
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
        </>
      )}
    </div>
  )
}
