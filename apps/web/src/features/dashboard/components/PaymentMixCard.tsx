/**
 * How the day's bills were paid — cash, UPI, card, still on credit (khata) and other — as a donut
 * with the total in the middle and a labelled list (amount + share), so colour is never the only
 * cue.
 */
import { PAYMENT_MIX_LABELS, type Dashboard } from '@kadai/shared/api/reports'
import { formatBp } from '@kadai/shared/money'
import { Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { Card, CardHeader, CardTitle, EmptyState, Money, Skeleton } from '@/components/ui'
import { formatMoney, formatNumber } from '@/lib/format'
import { ChartTooltipBox } from '@/features/reports/components/ChartTooltipBox'
import { pick, useLang } from '@/features/reports/lib/labels'
import { PAYMENT_MIX_COLORS } from '../lib/dashboard'

type Slice = Dashboard['payment_mix'][number]

export function PaymentMixCard({
  mix,
  totalPaise,
  isToday,
}: {
  mix: Dashboard['payment_mix'] | null
  totalPaise: number
  isToday: boolean
}) {
  const { t } = useTranslation('dashboard')
  const lng = useLang()
  const slices = (mix ?? []).filter((s) => s.amount_paise > 0)

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader className="pb-2">
        <CardTitle>{t(isToday ? 'mix.title_today' : 'mix.title_day')}</CardTitle>
      </CardHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-center lg:flex-col lg:items-stretch">
        {!mix ? (
          <Skeleton className="mx-auto size-40 rounded-full" />
        ) : slices.length === 0 ? (
          <EmptyState
            compact
            icon={<Wallet />}
            title={t('mix.empty_title')}
            description={t('mix.empty_hint')}
            className="w-full"
          />
        ) : (
          <>
            <div className="relative mx-auto size-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices}
                    dataKey="amount_paise"
                    nameKey="key"
                    innerRadius="62%"
                    outerRadius="100%"
                    paddingAngle={slices.length > 1 ? 2 : 0}
                    stroke="var(--surface)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    {slices.map((s) => (
                      <Cell key={s.key} fill={PAYMENT_MIX_COLORS[s.key]} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      const s = payload?.[0]?.payload as Slice | undefined
                      if (!active || !s) return null
                      return (
                        <ChartTooltipBox
                          title={pick(PAYMENT_MIX_LABELS[s.key], lng)}
                          lines={[
                            {
                              key: 'a',
                              label: t('mix.amount'),
                              color: PAYMENT_MIX_COLORS[s.key],
                              value: formatMoney(s.amount_paise),
                            },
                            { key: 'c', label: t('mix.count'), value: formatNumber(s.count) },
                            { key: 's', label: t('mix.share'), value: formatBp(s.share_bp) },
                          ]}
                        />
                      )
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[11px] text-muted-foreground">{t('mix.total')}</span>
                <span className="text-sm font-bold tabular-nums">
                  {formatMoney(totalPaise, { decimals: 0 })}
                </span>
              </div>
            </div>
            <ul
              className="grid min-w-0 flex-1 grid-cols-1 gap-2 lg:flex-none"
              aria-label={t('mix.list_label')}
            >
              {(mix ?? []).map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: PAYMENT_MIX_COLORS[s.key] }}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {pick(PAYMENT_MIX_LABELS[s.key], lng)}
                  </span>
                  <Money paise={s.amount_paise} decimals={0} className="font-semibold" />
                  <span className="w-12 text-end text-xs tabular-nums text-muted-foreground">
                    {formatBp(s.share_bp)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  )
}
