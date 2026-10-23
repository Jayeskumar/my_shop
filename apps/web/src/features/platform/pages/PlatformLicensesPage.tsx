/**
 * Platform on-prem licences (/platform/licenses, cloud mode, platformAdmin):
 *  - List of issued on-prem licences with key prefix, customer, edition, AMC status and activations
 */
import { licensingRoutes } from '@kadai/shared/api/licensing'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  SearchInput,
  Skeleton,
} from '@/components/ui'
import { formatDate, formatPhone } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'

export default function PlatformLicensesPage() {
  const { t } = useTranslation('platform')
  const [q, setQ] = useState('')
  const listQuery = useRouteQuery(licensingRoutes.listLicenses, {
    query: { limit: 100, offset: 0, ...(q ? { q } : {}) },
  })
  const rows = listQuery.data?.data ?? []

  return (
    <div className="grid gap-6 pb-8">
      <PageHeader
        title={t('licenses.title')}
        description={t('licenses.description')}
      />

      <SearchInput
        value={q}
        onChange={setQ}
        placeholder={t('licenses.search_placeholder')}
        aria-label={t('licenses.search_placeholder')}
        wrapperClassName="w-full sm:max-w-md"
      />

      {listQuery.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KeyRound />}
            title={t('licenses.empty_title')}
            description={t('licenses.empty_desc')}
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-3 text-start">{t('licenses.col_key')}</th>
                    <th className="px-4 py-3 text-start">{t('licenses.col_business')}</th>
                    <th className="px-4 py-3 text-start">{t('licenses.col_edition')}</th>
                    <th className="px-4 py-3 text-start">{t('licenses.col_type')}</th>
                    <th className="px-4 py-3 text-center">{t('licenses.col_seats')}</th>
                    <th className="px-4 py-3 text-start">{t('licenses.col_amc')}</th>
                    <th className="px-4 py-3 text-start">{t('licenses.col_status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-3 font-mono font-medium">{l.key_prefix}-••••</td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{l.business_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.customer_name} · {formatPhone(l.customer_phone)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {localizedName(l.product_name, l.product_name_ta)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{l.license_type}</td>
                      <td className="px-4 py-3 text-center tabular-nums">
                        {l.active_activations} / {l.max_activations}
                      </td>
                      <td className="px-4 py-3 text-xs tabular-nums">
                        {l.updates_until ? formatDate(l.updates_until) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          size="sm"
                          tone={l.status === 'active' ? 'success' : 'danger'}
                        >
                          {l.status}
                        </Badge>
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
