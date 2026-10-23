/**
 * Home dashboard (/): a Tamil greeting with the shop's name and the date, store selector and day
 * navigation, quick actions, today's KPIs against yesterday, the 30-day sales & profit chart,
 * payment mix, best sellers, dues with one-tap reminders and the alerts that need attention.
 * Refreshes every minute while showing today. Members without reports.read get the greeting and
 * their quick actions only.
 */
import { reportsRoutes } from '@kadai/shared/api/reports'
import { addDays } from '@kadai/shared/fy'
import { keepPreviousData } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, CloudOff, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { StorePicker } from '@/components/pickers'
import { Button, EmptyState, IconButton, RetryButton } from '@/components/ui'
import { useCan, useFeature, useMe } from '@/lib/auth'
import { describeError } from '@/lib/errors'
import { formatDate, formatTime } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'
import { useReportCalendar } from '@/features/reports/lib/calendar'
import { nameOf, useLang } from '@/features/reports/lib/labels'
import { longDate } from '@/features/reports/lib/periods'
import { AlertCards } from '../components/AlertCards'
import { DuesCard } from '../components/DuesCard'
import { KpiTiles } from '../components/KpiTiles'
import { PaymentMixCard } from '../components/PaymentMixCard'
import { QuickActions } from '../components/QuickActions'
import { SalesTrendChart } from '../components/SalesTrendChart'
import { StockSenseCard } from '../components/StockSenseCard'
import { TopItemsCard } from '../components/TopItemsCard'
import { dayPart, firstName, initialDashboardStore, rememberDashboardStore } from '../lib/dashboard'

const REFRESH_MS = 60_000

export default function DashboardPage() {
  const { t } = useTranslation('dashboard')
  const lng = useLang()
  const me = useMe()
  const cal = useReportCalendar()
  const canReports = useCan('reports.read')
  const canPurchases = useCan('purchases.read')
  const hasPurchases = useFeature('purchases')
  const basicReports = useFeature('reports_basic')
  const [store, setStore] = useState<string | null>(() => initialDashboardStore(me))
  const [date, setDate] = useState(cal.today)
  const isToday = date === cal.today
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1
  const effectiveStoreId =
    store && store !== 'all' ? store : (me?.stores.find((s) => s.is_active)?.id ?? null)

  const dashboard = useRouteQuery(
    reportsRoutes.dashboard,
    {
      query: {
        ...(store && store !== 'all' ? { store_id: store } : {}),
        ...(isToday ? {} : { date }),
      },
    },
    {
      enabled: canReports,
      placeholderData: keepPreviousData,
      refetchInterval: isToday ? REFRESH_MS : false,
      refetchIntervalInBackground: false,
    },
  )
  const data = dashboard.data?.data ?? null

  const shopName = me ? nameOf(me.tenant.name, me.tenant.name_ta) : ''
  const greeting = me
    ? t(`greeting.${dayPart(new Date(), cal.timezone)}`, { name: firstName(me.user.full_name) })
    : ''

  return (
    <div className="grid min-w-0 grid-cols-1 gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{greeting}</p>
          <h1 className="truncate text-2xl font-bold tracking-tight sm:text-3xl">{shopName}</h1>
          <p className="text-sm text-muted-foreground">{longDate(date, lng)}</p>
        </div>
        {canReports ? (
          <div className="flex flex-wrap items-center gap-2">
            {multiStore ? (
              <StorePicker
                aria-label={t('store')}
                allowAll
                clearable={false}
                value={store}
                onChange={(id) => {
                  setStore(id)
                  rememberDashboardStore(id)
                }}
                className="w-full sm:w-56"
              />
            ) : null}
            <div className="flex items-center gap-1" role="group" aria-label={t('day.label')}>
              <IconButton
                icon={<ChevronLeft className="rtl:rotate-180" />}
                label={t('day.previous')}
                variant="outline"
                onClick={() => setDate((d) => addDays(d, -1))}
              />
              <Button
                variant={isToday ? 'secondary' : 'outline'}
                onClick={() => setDate(cal.today)}
                disabled={isToday}
                className="min-w-28 tabular-nums"
              >
                {isToday ? t('day.today') : formatDate(date)}
              </Button>
              <IconButton
                icon={<ChevronRight className="rtl:rotate-180" />}
                label={t('day.next')}
                variant="outline"
                disabled={isToday}
                onClick={() => setDate((d) => (d < cal.today ? addDays(d, 1) : d))}
              />
              <IconButton
                icon={<RefreshCw className={dashboard.isFetching ? 'animate-spin' : undefined} />}
                label={
                  data
                    ? t('refresh_updated', { time: formatTime(data.generated_at) })
                    : t('refresh')
                }
                variant="ghost"
                onClick={() => void dashboard.refetch()}
              />
            </div>
          </div>
        ) : null}
      </header>

      <QuickActions />

      {!canReports ? (
        <p className="rounded-xl border border-dashed border-border bg-surface p-4 text-sm text-muted-foreground">
          {t('no_reports_access')}
        </p>
      ) : dashboard.error && !data ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={<CloudOff />}
            title={describeError(dashboard.error).title}
            description={t('load_failed')}
            action={<RetryButton onRetry={() => void dashboard.refetch()} />}
          />
        </div>
      ) : (
        <>
          <KpiTiles data={data} isToday={isToday} />
          <div className="grid min-w-0 gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <SalesTrendChart
                trend={data?.trend ?? null}
                selectedDate={date}
                canOpenReport={basicReports}
              />
            </div>
            <PaymentMixCard
              mix={data?.payment_mix ?? null}
              totalPaise={data?.today.sales_paise ?? 0}
              isToday={isToday}
            />
          </div>
          <div className="grid grid-cols-1 gap-3">
            <h2 className="text-base font-semibold">{t('alerts.title')}</h2>
            <AlertCards data={data} />
          </div>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <DuesCard receivables={data?.receivables ?? null} />
            <TopItemsCard
              items={data?.top_items ?? null}
              isToday={isToday}
              date={date}
              canOpenReport={basicReports}
            />
          </div>
          {canPurchases && hasPurchases ? (
            <StockSenseCard storeId={effectiveStoreId} />
          ) : null}
        </>
      )}
    </div>
  )
}
