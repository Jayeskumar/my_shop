/**
 * Optional chart of a report (`chart` in the REPORTS catalogue): bars / line / area over the rows
 * on screen, one money (or count) axis with Indian compact ticks, a legend and a hover tooltip.
 * Time groupings (day / month / hour) are drawn in time order whatever the table sort is.
 */
import type { ReportChartDef } from '@kadai/shared/api/reports'
import { isDateStr } from '@kadai/shared/fy'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from '@/components/ui'
import { formatMoney, formatNumber } from '@/lib/format'
import { useBreakpoint } from '@/lib/use-media-query'
import type { ReportRow } from '../lib/cells'
import { axisMoney, axisText, SERIES_COLORS, valueDomain } from '../lib/chart'
import { pick, useLang } from '../lib/labels'
import { shortDate } from '../lib/periods'
import { ChartLegend, ChartTooltipBox } from './ChartTooltipBox'

const MAX_BARS = 20

export interface ReportChartProps {
  chart: ReportChartDef
  rows: readonly ReportRow[]
  /** Rows have a time key (group_key 'YYYY-MM-DD' / 'YYYY-MM' / 'HH') to order them by. */
  timeKey?: string | null
  title: string
}

export function ReportChart({ chart, rows, timeKey, title }: ReportChartProps) {
  const { t } = useTranslation('reports')
  const lng = useLang()
  const wide = useBreakpoint('md')

  const data = useMemo(() => {
    const list = [...rows]
    if (timeKey) {
      list.sort((a, b) => String(a[timeKey] ?? '').localeCompare(String(b[timeKey] ?? '')))
      return list
    }
    return list.slice(0, MAX_BARS)
  }, [rows, timeKey])

  // Day groupings plot by their ISO key (short "21 Oct" ticks) rather than the display label.
  const xKey = timeKey && data.some((r) => isDateStr(r[timeKey])) ? timeKey : chart.x
  const tick = (value: unknown): string => {
    const text = String(value ?? '')
    if (isDateStr(text)) return shortDate(text, lng)
    return axisText(text, wide ? 14 : 9)
  }
  const money = chart.series.every((s) => s.format === 'money')
  const yTick = (v: number): string => (money ? axisMoney(v, lng) : formatNumber(v))
  const valueText = (format: 'money' | 'int', v: unknown): string =>
    typeof v === 'number' ? (format === 'money' ? formatMoney(v) : formatNumber(v)) : '—'

  const legend = chart.series.map((s, i) => ({
    key: s.key,
    label: pick(s.label, lng),
    color: SERIES_COLORS[i % SERIES_COLORS.length]!,
    kind: chart.kind === 'line' ? ('line' as const) : ('bar' as const),
  }))

  const common = {
    data,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
  }
  // Recharts reads its children by type, so the shared parts are an array (not a Fragment).
  const axes = [
    <CartesianGrid key="grid" vertical={false} stroke="var(--border)" />,
    <XAxis
      key="x"
      dataKey={xKey}
      tickFormatter={tick}
      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
      axisLine={{ stroke: 'var(--border)' }}
      tickLine={false}
      interval="preserveStartEnd"
      minTickGap={12}
    />,
    <YAxis
      key="y"
      tickFormatter={yTick}
      domain={valueDomain(money ? 'money' : 'int')}
      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
      axisLine={false}
      tickLine={false}
      width={lng === 'ta' ? 86 : 64}
    />,
    <Tooltip
      key="tooltip"
      cursor={{ fill: 'var(--surface-2)', stroke: 'var(--border)' }}
      content={({ active, payload, label }) =>
        active && payload?.length ? (
          <ChartTooltipBox
            title={tick(label)}
            lines={chart.series.map((s, i) => ({
              key: s.key,
              label: pick(s.label, lng),
              color: SERIES_COLORS[i % SERIES_COLORS.length],
              value: valueText(s.format, (payload[0]?.payload as ReportRow | undefined)?.[s.key]),
            }))}
          />
        ) : null
      }
    />,
  ]

  return (
    <Card className="no-print mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {legend.length > 1 ? <ChartLegend items={legend} /> : null}
      </div>
      <div className="h-56 sm:h-64" role="img" aria-label={t('viewer.chart_label', { title })}>
        <ResponsiveContainer width="100%" height="100%">
          {chart.kind === 'line' ? (
            <LineChart {...common}>
              {axes}
              {chart.series.map((s, i) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          ) : chart.kind === 'area' ? (
            <AreaChart {...common}>
              {axes}
              {chart.series.map((s, i) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          ) : (
            <BarChart {...common} barGap={2}>
              {axes}
              {chart.series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </Card>
  )
}
