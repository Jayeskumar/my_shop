/**
 * System & server page (/settings/system, permission settings.manage):
 *  - Server & runtime health (version, git commit, deployment mode, Node, OS, uptime, timezone)
 *  - Database & migrations (PostgreSQL version, DB size, applied/pending migrations)
 *  - Background worker & storage (embedded/dedicated, heartbeat status, local/S3 storage)
 *  - Plan & licence entitlements summary and quick links
 */
import { platformRoutes } from '@kadai/shared/api/platform'
import {
  Activity,
  Cpu,
  Database,
  History,
  KeyRound,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
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
  PageHeader,
  Skeleton,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import { formatDateTime, formatNumber } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m ${seconds % 60}s`
}

export default function SystemPage() {
  const { t } = useTranslation(['system', 'common'])
  const infoQuery = useRouteQuery(platformRoutes.systemInfo, {})
  const info = infoQuery.data?.data

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 pb-8">
      <PageHeader
        title={t('system.title')}
        description={t('system.description')}
        backTo="/settings"
        actions={
          <Button
            variant="outline"
            leftIcon={<RefreshCw className={infoQuery.isFetching ? 'animate-spin' : undefined} />}
            onClick={() => void infoQuery.refetch()}
          >
            {t('system.refresh')}
          </Button>
        }
      />

      {infoQuery.isPending ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
          <Skeleton className="h-52 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
        </div>
      ) : !info ? (
        <EmptyState
          title={t('system.load_error')}
          description={describeError(infoQuery.error).title}
          action={
            <Button variant="outline" onClick={() => void infoQuery.refetch()}>
              {t('common:actions.retry')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Runtime */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Cpu className="size-4 text-primary" aria-hidden />
                  {t('system.runtime.title')}
                </CardTitle>
                <Badge tone="primary">
                  {info.mode === 'onprem'
                    ? t('system.runtime.mode_onprem')
                    : t('system.runtime.mode_cloud')}
                </Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.runtime.version')}</dt>
                    <dd className="font-mono font-semibold">
                      v{info.version}
                      {info.git_commit ? ` (${info.git_commit.slice(0, 7)})` : ''}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.runtime.node')}</dt>
                    <dd className="font-mono">{info.node_version}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.runtime.os')}</dt>
                    <dd className="font-mono">
                      {info.platform} / {info.arch}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.runtime.uptime')}</dt>
                    <dd className="tabular-nums">{formatUptime(info.uptime_seconds)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.runtime.timezone')}</dt>
                    <dd className="font-mono">{info.timezone}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.runtime.server_time')}</dt>
                    <dd className="tabular-nums">{formatDateTime(info.server_time)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            {/* Database */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Database className="size-4 text-primary" aria-hidden />
                  {t('system.database.title')}
                </CardTitle>
                <Badge tone={info.db.pending_migrations === 0 ? 'success' : 'warning'}>
                  {info.db.pending_migrations === 0
                    ? t('system.database.up_to_date')
                    : `${info.db.pending_migrations} pending`}
                </Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.database.postgres')}</dt>
                    <dd className="font-mono">{info.db.server_version}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.database.size')}</dt>
                    <dd className="font-semibold tabular-nums">
                      {formatBytes(info.db.size_bytes)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.database.applied')}</dt>
                    <dd className="tabular-nums">{formatNumber(info.db.migrations_applied)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.database.last_migration')}</dt>
                    <dd className="truncate font-mono text-xs">{info.db.last_migration ?? '—'}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            {/* Worker & storage */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="size-4 text-primary" aria-hidden />
                  {t('system.worker.title')}
                </CardTitle>
                <Badge tone={info.worker.healthy ? 'success' : 'warning'}>
                  {info.worker.healthy ? t('system.worker.healthy') : t('system.worker.unhealthy')}
                </Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.worker.mode')}</dt>
                    <dd>
                      {info.worker.embedded
                        ? t('system.worker.embedded')
                        : t('system.worker.dedicated')}
                    </dd>
                  </div>
                  {info.worker.heartbeat_at ? (
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">{t('system.worker.last_heartbeat')}</dt>
                      <dd className="tabular-nums">{formatDateTime(info.worker.heartbeat_at)}</dd>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.worker.storage_driver')}</dt>
                    <dd>
                      {info.storage.driver === 's3'
                        ? t('system.worker.storage_s3')
                        : t('system.worker.storage_local')}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            {/* Entitlements */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="size-4 text-primary" aria-hidden />
                  {t('system.entitlements.title')}
                </CardTitle>
                <Badge tone="info" className="uppercase">
                  {info.entitlements.plan_code}
                </Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.entitlements.plan')}</dt>
                    <dd className="font-semibold uppercase">{info.entitlements.plan_code}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted-foreground">{t('system.entitlements.source')}</dt>
                    <dd className="font-mono">{info.entitlements.source}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('system.links.title')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild variant="outline" leftIcon={<MonitorSmartphone />}>
                <Link to="/settings/registers">{t('system.links.registers')}</Link>
              </Button>
              <Button asChild variant="outline" leftIcon={<KeyRound />}>
                <Link to="/settings/api-keys">{t('system.links.api_keys')}</Link>
              </Button>
              {info.mode === 'cloud' ? (
                <Button asChild variant="outline" leftIcon={<Sparkles />}>
                  <Link to="/settings/billing">{t('system.links.billing')}</Link>
                </Button>
              ) : null}
              <Button asChild variant="outline" leftIcon={<History />}>
                <Link to="/settings/audit-log">{t('system.links.audit_log')}</Link>
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
