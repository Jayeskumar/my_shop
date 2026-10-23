/**
 * The four numbers an owner checks first — sales, bills, average bill and gross profit with
 * margin — each against the previous day (green up / red down).
 */
import type { Dashboard } from '@kadai/shared/api/reports'
import { formatBp } from '@kadai/shared/money'
import { IndianRupee, ReceiptText, ShoppingBasket, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Money, Stat } from '@/components/ui'
import { formatNumber } from '@/lib/format'
import { marginPoints } from '../lib/dashboard'

export interface KpiTilesProps {
  data: Dashboard | null
  isToday: boolean
}

export function KpiTiles({ data, isToday }: KpiTilesProps) {
  const { t } = useTranslation('dashboard')
  const loading = !data
  const day = data?.today
  const change = data?.change
  const vs = t(isToday ? 'kpi.vs_yesterday' : 'kpi.vs_previous_day')
  const changeOf = (bp: number | null | undefined, goodWhen: 'up' | 'down' = 'up') =>
    bp === null || bp === undefined ? undefined : { bp, goodWhen, label: vs }
  const noPrevious = (
    bp: number | null | undefined,
    value: number | undefined,
  ): string | undefined =>
    !loading && (bp === null || bp === undefined) && (value ?? 0) > 0
      ? t('kpi.no_previous')
      : undefined

  const margin = day?.margin_bp ?? null
  const points = change?.margin_points_bp ?? null
  return (
    <section aria-label={t('kpi.label')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label={t(isToday ? 'kpi.sales_today' : 'kpi.sales_day')}
        value={<Money paise={day?.net_sales_paise ?? 0} decimals={0} />}
        icon={<IndianRupee />}
        tone="primary"
        loading={loading}
        change={changeOf(change?.net_sales_bp)}
        hint={noPrevious(change?.net_sales_bp, day?.net_sales_paise)}
      />
      <Stat
        label={t('kpi.bills')}
        value={formatNumber(day?.bills ?? 0)}
        icon={<ReceiptText />}
        loading={loading}
        change={changeOf(change?.bills_bp)}
        hint={noPrevious(change?.bills_bp, day?.bills)}
      />
      <Stat
        label={t('kpi.avg_bill')}
        value={<Money paise={day?.avg_bill_paise ?? 0} decimals={0} />}
        icon={<ShoppingBasket />}
        loading={loading}
        change={changeOf(change?.avg_bill_bp)}
      />
      <Stat
        label={t('kpi.profit')}
        value={<Money paise={day?.gross_profit_paise ?? 0} decimals={0} />}
        icon={<TrendingUp />}
        tone="accent"
        loading={loading}
        change={changeOf(change?.gross_profit_bp)}
        hint={
          margin === null
            ? undefined
            : points === null
              ? t('kpi.margin', { margin: formatBp(margin) })
              : t('kpi.margin_change', { margin: formatBp(margin), points: marginPoints(points) })
        }
      />
    </section>
  )
}
