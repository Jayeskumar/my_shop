/**
 * StockSense charts (recharts): days-of-stock distribution, top profit at risk, and the
 * per-item history + forecast + projected stock chart of the details drawer.
 */
import type { StockSenseItem, StockSenseProduct, StockSenseReport } from '@kadai/shared/api/purchases'
import { formatINRCompact } from '@kadai/shared/money'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatMoney, formatNumber } from '@/lib/format'
import { getLanguage, localizedName } from '@/lib/i18n'
import { qtyText } from '../lib/stocksense'

const C = {
  danger: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  success: 'var(--color-success)',
  primary: 'var(--color-primary)',
  accent: 'var(--color-accent)',
  muted: 'var(--color-muted-foreground)',
  border: 'var(--color-border)',
}

const BUCKET_COLOR: Record<string, string> = {
  '0': C.danger,
  '1-3': C.danger,
  '4-7': C.warning,
  '8-30': C.success,
  '31-90': C.info,
  '90+': C.muted,
  no_sales: C.muted,
}

const BUCKETS = ['0', '1-3', '4-7', '8-30', '31-90', '90+', 'no_sales'] as const

const tooltipStyle = {
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  fontSize: 12,
}

const axisTick = { fontSize: 11, fill: C.muted }

const short = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export function CoverChart({ buckets }: { buckets: StockSenseReport['summary']['cover_buckets'] }) {
  const { t } = useTranslation('purchases')
  const counts = new Map(buckets.map((b) => [b.bucket, b.count]))
  const data = BUCKETS.map((key) => ({
    key,
    label: t(`stocksense.charts.bucket.${key}`),
    count: counts.get(key) ?? 0,
  }))
  return (
    <div className="h-56 w-full" role="img" aria-label={t('stocksense.charts.cover_title')}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={axisTick} interval={0} tickFormatter={(v: string) => short(v, 10)} />
          <YAxis allowDecimals={false} tick={axisTick} width={40} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: 'var(--color-surface-2)' }}
            formatter={(v: number) => [formatNumber(v), t('stocksense.charts.items')]}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data.map((d) => (
              <Cell key={d.key} fill={BUCKET_COLOR[d.key]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function ProfitRiskChart({ items }: { items: readonly StockSenseItem[] }) {
  const { t } = useTranslation('purchases')
  const data = items
    .filter((i) => i.priority === 'urgent' || i.priority === 'high')
    .map((i) => ({
      name: short(localizedName(i.name, i.name_ta), 18),
      lost: i.lost_profit_paise,
      perDay: Math.max(0, i.profit_per_day_paise ?? 0),
    }))
    .sort((a, b) => b.lost - a.lost || b.perDay - a.perDay)
    .slice(0, 8)
  if (data.length === 0 || data.every((d) => d.lost === 0 && d.perDay === 0)) {
    return (
      <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        {t('stocksense.charts.none')}
      </p>
    )
  }
  return (
    <div className="h-56 w-full" role="img" aria-label={t('stocksense.charts.profit_title')}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal={false} stroke={C.border} strokeDasharray="3 3" />
          <XAxis
            type="number"
            tick={axisTick}
            tickFormatter={(v: number) => formatINRCompact(v, getLanguage())}
          />
          <YAxis type="category" dataKey="name" tick={axisTick} width={110} />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: 'var(--color-surface-2)' }}
            formatter={(v: number, key: string) => [
              formatMoney(v),
              key === 'lost' ? t('stocksense.charts.lost') : t('stocksense.charts.per_day'),
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(key: string) =>
              key === 'lost' ? t('stocksense.charts.lost') : t('stocksense.charts.per_day')
            }
          />
          <Bar dataKey="lost" fill={C.danger} radius={[0, 4, 4, 0]} />
          <Bar dataKey="perDay" fill={C.primary} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** History bars (recorded + imported stacked), forecast bars and the projected stock line. */
export function ProductForecastChart({ detail }: { detail: StockSenseProduct }) {
  const { t } = useTranslation('purchases')
  const item = detail.item
  const toUnits = (milli: number): number => milli / 1000
  const data = [
    ...detail.history.map((h) => ({
      date: h.date.slice(5),
      // sold = recorded when the shop billed that day, else the imported quantity.
      recorded: h.recorded_milli > 0 ? toUnits(h.recorded_milli) : 0,
      imported: h.recorded_milli > 0 ? 0 : toUnits(h.imported_milli),
      forecast: null as number | null,
      stock: null as number | null,
    })),
    ...detail.forecast.map((f) => ({
      date: f.date.slice(5),
      recorded: 0,
      imported: 0,
      forecast: toUnits(f.demand_milli),
      stock: toUnits(f.projected_stock_milli),
    })),
  ]
  const label = (key: string): string =>
    key === 'recorded'
      ? t('stocksense.drawer.recorded')
      : key === 'imported'
        ? t('stocksense.drawer.imported')
        : key === 'forecast'
          ? t('stocksense.drawer.forecast')
          : t('stocksense.drawer.projected')
  return (
    <div className="h-60 w-full" role="img" aria-label={t('stocksense.drawer.chart_title')}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -12 }}>
          <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={axisTick} minTickGap={16} />
          <YAxis yAxisId="qty" tick={axisTick} width={44} />
          <YAxis yAxisId="stock" orientation="right" tick={axisTick} width={44} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v, key) => [
              typeof v === 'number' ? qtyText(Math.round(v * 1000), item) : '—',
              label(String(key)),
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} formatter={(key: string) => label(key)} />
          <Bar yAxisId="qty" dataKey="recorded" stackId="h" fill={C.primary} />
          <Bar yAxisId="qty" dataKey="imported" stackId="h" fill={C.accent} />
          <Bar yAxisId="qty" dataKey="forecast" fill={C.warning} opacity={0.8} />
          <Line
            yAxisId="stock"
            dataKey="stock"
            stroke={C.danger}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
