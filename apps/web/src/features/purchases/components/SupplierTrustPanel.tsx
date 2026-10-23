/**
 * Supplier Trust Score (tab of /purchases/orders, ?tab=trust): what each supplier really does,
 * learned from the shop's purchase orders and the bills that received them — real delivery time
 * vs promised, on-time rate, share of the order delivered, rate changes — with what to do about
 * it. StockSense plans with the learned lead time (purchases reorder suggestions).
 */
import type { SupplierTrustRow } from '@kadai/shared/api/purchases'
import { AlertTriangle, BadgeCheck, CalendarClock, PackageMinus, ShieldCheck, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Card, EmptyState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { useSupplierTrust } from '../api'

const levelTone = { good: 'success', watch: 'warning', poor: 'danger', learning: 'neutral' } as const
const scoreColor = {
  good: 'text-success',
  watch: 'text-warning',
  poor: 'text-danger',
  learning: 'text-muted-foreground',
} as const

const pct = (bp: number | null): string => (bp === null ? '—' : `${String(Math.round(bp / 100))}%`)

export function SupplierTrustPanel() {
  const { t } = useTranslation('purchases')
  const query = useSupplierTrust()
  const data = query.data?.data

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="size-5 text-primary" aria-hidden />
          {t('trust.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('trust.intro', { days: data?.window_days ?? 180 })}
        </p>
      </div>
      {query.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : !data || data.suppliers.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title={t('trust.empty')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.suppliers.map((s) => (
            <SupplierCard key={s.supplier_id} row={s} minOrders={data.min_orders} />
          ))}
        </div>
      )}
    </div>
  )
}

function SupplierCard({ row, minOrders }: { row: SupplierTrustRow; minOrders: number }) {
  const { t } = useTranslation('purchases')
  const learning = row.level === 'learning'
  return (
    <Card className="grid gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{row.name}</h3>
          <p className="text-xs text-muted-foreground">
            {row.last_delivery_date
              ? t('trust.orders_measured', {
                  count: row.orders_measured,
                  date: formatDate(row.last_delivery_date),
                })
              : t('trust.no_deliveries')}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn('text-3xl font-bold tabular-nums leading-none', scoreColor[row.level])}>
            {row.trust ?? '—'}
          </span>
          <Badge size="sm" tone={levelTone[row.level]}>
            {t(`trust.level_${row.level}`)}
          </Badge>
        </div>
      </div>

      {learning ? (
        <p className="text-sm text-muted-foreground">
          {t('trust.learning', { count: Math.max(1, minOrders - row.orders_measured) })}
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Metric
            icon={<CalendarClock />}
            label={t('trust.delivers_in')}
            value={t('trust.days', { count: row.avg_lead_days ?? 0 })}
            hint={
              row.avg_promised_days !== null
                ? t('trust.promised', { count: row.avg_promised_days })
                : null
            }
          />
          <Metric icon={<BadgeCheck />} label={t('trust.on_time')} value={pct(row.on_time_bp)} />
          <Metric icon={<PackageMinus />} label={t('trust.fill_rate')} value={pct(row.fill_rate_bp)} />
          <Metric
            icon={<TrendingUp />}
            label={t('trust.price_change')}
            value={
              row.price_change_bp === null
                ? '—'
                : `${row.price_change_bp > 0 ? '+' : ''}${(row.price_change_bp / 100).toFixed(1)}%`
            }
          />
        </dl>
      )}

      {row.learned_lead_days !== null ? (
        <p className="rounded-lg bg-primary/5 px-3 py-2 text-sm">
          {t('trust.stocksense_uses', {
            count: row.learned_lead_days,
            sd: (row.sd_lead_days ?? 0).toFixed(1),
          })}
        </p>
      ) : null}

      {row.alerts.length > 0 ? (
        <ul className="grid gap-1.5">
          {row.alerts.map((a) => (
            <li
              key={a.code}
              className={cn(
                'flex items-start gap-2 text-sm',
                a.code === 'reliable' ? 'text-success' : 'text-warning',
              )}
            >
              {a.code === 'reliable' ? (
                <BadgeCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}
              <span className="text-foreground">
                {a.code === 'order_earlier'
                  ? t('trust.alert_order_earlier', { count: a.days })
                  : a.code === 'short_supply'
                    ? t('trust.alert_short_supply', { pct: a.fill_pct })
                    : a.code === 'price_up'
                      ? t('trust.alert_price_up', { pct: a.pct })
                      : t('trust.alert_reliable')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

function Metric({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode
  label: string
  value: string
  hint?: string | null
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="font-semibold tabular-nums">
          {value}
          {hint ? <span className="ms-1 text-xs font-normal text-muted-foreground">{hint}</span> : null}
        </dd>
      </div>
    </div>
  )
}
