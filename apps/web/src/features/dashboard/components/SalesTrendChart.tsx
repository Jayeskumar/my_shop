/**
 * 30-day sales and profit: net sales as bars and gross profit as a line on one money axis
 * (₹45K · ₹1.2 L ticks), the chosen day highlighted, a hover tooltip with bills, and a link to
 * the full sales summary.
 */
import type { Dashboard } from '@kadai/shared/api/reports'
import { formatDateDisplay } from '@kadai/shared/fy'
import { useTranslation } from 'react-i18next'
import { ChartColumn } from 'lucide-react'
import { Link } from 'react-router'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button, Card, CardHeader, CardTitle, EmptyState, Skeleton } from '@/components/ui'
import { formatMoney, formatNumber } from '@/lib/format'
import { ChartLegend, ChartTooltipBox } from '@/features/reports/components/ChartTooltipBox'
import { axisMoney, valueDomain } from '@/features/reports/lib/chart'
import { useLang } from '@/features/reports/lib/labels'
import { shortDate, weekdayShort } from '@/features/reports/lib/periods'

const SALES = 'var(--primary)'
const PROFIT = 'var(--accent)'

type TrendPoint = Dashboard['trend'][number]

export function SalesTrendChart({
  trend,
  selectedDate,
  canOpenReport,
}: {
  trend: Dashboard['trend'] | null
  selectedDate: string
  canOpenReport: boolean
}) {
  const { t } = useTranslation('dashboard')
  const lng = useLang()
  const total = trend?.reduce((s, d) => s + d.net_sales_paise, 0) ?? 0
  const profit = trend?.reduce((s, d) => s + d.gross_profit_paise, 0) ?? 0
  const quiet = trend?.every((d) => d.net_sales_paise === 0 && d.gross_profit_paise === 0) ?? false

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 pb-2">
        <div className="min-w-0">
          <CardTitle>{t('trend.title')}</CardTitle>
          {trend ? (
            <p className="text-sm text-muted-foreground">
              {t('trend.summary', {
                sales: formatMoney(total, { decimals: 0 }),
                profit: formatMoney(profit, { decimals: 0 }),
              })}
            </p>
          ) : null}
        </div>
        {quiet ? null : (
          <ChartLegend
            items={[
              { key: 'sales', label: t('trend.net_sales'), color: SALES },
              { key: 'profit', label: t('trend.gross_profit'), color: PROFIT, kind: 'line' },
            ]}
          />
        )}
      </CardHeader>
      <div className="h-60 px-2 pb-2 sm:h-72">
        {!trend ? (
          <Skeleton className="mx-3 h-full" />
        ) : quiet ? (
          <EmptyState
            compact
            icon={<ChartColumn />}
            title={t('trend.empty_title')}
            description={t('trend.empty_hint')}
            className="h-full justify-center"
          />
        ) : (
          <div
            className="h-full"
            role="img"
            aria-label={t('trend.aria', { sales: formatMoney(total, { decimals: 0 }) })}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => shortDate(d, lng)}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={{ stroke: 'var(--border)' }}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={18}
                />
                <YAxis
                  tickFormatter={(v: number) => axisMoney(v, lng)}
                  domain={valueDomain('money')}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={lng === 'ta' ? 84 : 60}
                />
                <Tooltip
                  cursor={{ fill: 'var(--surface-2)' }}
                  content={({ active, payload }) => {
                    const p = payload?.[0]?.payload as TrendPoint | undefined
                    if (!active || !p) return null
                    return (
                      <ChartTooltipBox
                        title={`${weekdayShort(p.date, lng)}, ${formatDateDisplay(p.date)}`}
                        lines={[
                          {
                            key: 's',
                            label: t('trend.net_sales'),
                            color: SALES,
                            value: formatMoney(p.net_sales_paise),
                          },
                          {
                            key: 'p',
                            label: t('trend.gross_profit'),
                            color: PROFIT,
                            value: formatMoney(p.gross_profit_paise),
                          },
                          { key: 'b', label: t('trend.bills'), value: formatNumber(p.bills) },
                        ]}
                      />
                    )
                  }}
                />
                <Bar
                  dataKey="net_sales_paise"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={22}
                  isAnimationActive={false}
                >
                  {trend.map((d) => (
                    <Cell
                      key={d.date}
                      fill={SALES}
                      fillOpacity={d.date === selectedDate ? 1 : 0.55}
                    />
                  ))}
                </Bar>
                <Line
                  type="monotone"
                  dataKey="gross_profit_paise"
                  stroke={PROFIT}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {canOpenReport ? (
        <div className="border-t border-border px-5 py-2">
          <Button asChild variant="link" size="sm">
            <Link to="/reports/sales-summary?preset=last_30_days">{t('trend.open_report')}</Link>
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
