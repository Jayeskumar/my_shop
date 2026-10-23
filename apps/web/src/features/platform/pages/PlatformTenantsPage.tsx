/**
 * Platform tenants list (/platform/tenants, cloud mode, platformAdmin):
 *  - Search by business name, owner name or phone
 *  - Table of cloud businesses with plan, status, usage and link to detail
 */
import { licensingRoutes } from '@kadai/shared/api/licensing'
import { Building2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  SearchInput,
  Skeleton,
} from '@/components/ui'
import { formatDate, formatNumber, formatPhone } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'

const STATUS_TONE = {
  active: 'success',
  suspended: 'danger',
  closed: 'neutral',
} as const

export default function PlatformTenantsPage() {
  const { t } = useTranslation('platform')
  const [q, setQ] = useState('')
  const list = useRouteQuery(licensingRoutes.listTenants, {
    query: { limit: 100, offset: 0, ...(q ? { q } : {}) },
  })
  const tenants = list.data?.data ?? []

  return (
    <div className="grid gap-6 pb-8">
      <PageHeader
        title={t('tenants.title')}
        description={t('tenants.description')}
      />

      <SearchInput
        value={q}
        onChange={setQ}
        placeholder={t('tenants.search_placeholder')}
        aria-label={t('tenants.search_placeholder')}
        wrapperClassName="w-full sm:max-w-md"
      />

      {list.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : tenants.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 />}
            title={t('tenants.empty_title')}
            description={t('tenants.empty_desc')}
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-3 text-start">{t('tenants.col_business')}</th>
                    <th className="px-4 py-3 text-start">{t('tenants.col_owner')}</th>
                    <th className="px-4 py-3 text-start">{t('tenants.col_type')}</th>
                    <th className="px-4 py-3 text-start">{t('tenants.col_plan')}</th>
                    <th className="px-4 py-3 text-start">{t('tenants.col_status')}</th>
                    <th className="px-4 py-3 text-end">{t('tenants.col_usage')}</th>
                    <th className="px-4 py-3 text-end">{t('tenants.col_bills')}</th>
                    <th className="px-4 py-3 text-end">{t('tenants.col_created')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tenants.map((row) => (
                    <tr key={row.id} className="hover:bg-surface-2/50">
                      <td className="px-4 py-3">
                        <Link
                          to={`/platform/tenants/${row.id}`}
                          className="font-semibold text-primary hover:underline"
                        >
                          {localizedName(row.name, row.name_ta)}
                        </Link>
                        {row.district ? (
                          <div className="text-xs text-muted-foreground">{row.district}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div>{row.owner_name ?? '—'}</div>
                        {row.owner_phone ? (
                          <div className="text-xs text-muted-foreground">
                            {formatPhone(row.owner_phone)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs">{row.business_type.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3">
                        <Badge tone="info" size="sm" className="font-mono uppercase">
                          {row.plan_code}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={STATUS_TONE[row.status]} size="sm">
                          {t(`tenants.status.${row.status}`)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-end text-xs tabular-nums">
                        {row.usage.stores} / {row.usage.users} / {formatNumber(row.usage.products)}
                      </td>
                      <td className="px-4 py-3 text-end font-medium tabular-nums">
                        {formatNumber(row.usage.invoices_this_month)}
                      </td>
                      <td className="px-4 py-3 text-end text-xs text-muted-foreground tabular-nums">
                        {formatDate(row.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
