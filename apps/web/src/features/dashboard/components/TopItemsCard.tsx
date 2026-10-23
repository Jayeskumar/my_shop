/** Best sellers of the day / the last 7 days, with a bar proportional to the item's sales. */
import type { Dashboard, DashboardTopItem } from '@kadai/shared/api/reports'
import { addDays } from '@kadai/shared/fy'
import { PackageSearch } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  Money,
  Qty,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { nameOf } from '@/features/reports/lib/labels'

type Range = 'today' | 'last_7_days'

export function TopItemsCard({
  items,
  isToday,
  date,
  canOpenReport,
}: {
  items: Dashboard['top_items'] | null
  isToday: boolean
  /** The dashboard day (top items "today" = that day; "7 days" end on it). */
  date: string
  canOpenReport: boolean
}) {
  const { t } = useTranslation('dashboard')
  const [range, setRange] = useState<Range>('today')
  const list: DashboardTopItem[] = items ? items[range] : []
  const max = Math.max(1, ...list.map((i) => i.net_sales_paise))

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle>{t('top.title')}</CardTitle>
        <Tabs
          value={range}
          onValueChange={(v) => setRange(v === 'last_7_days' ? v : 'today')}
          variant="pills"
        >
          <TabsList aria-label={t('top.range')}>
            <TabsTrigger value="today">{t(isToday ? 'top.today' : 'top.that_day')}</TabsTrigger>
            <TabsTrigger value="last_7_days">{t('top.last_7_days')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <div className="flex-1 px-5 pb-4">
        {!items ? (
          <div className="grid gap-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            compact
            icon={<PackageSearch />}
            title={t('top.empty_title')}
            description={t('top.empty_hint')}
          />
        ) : (
          <ol className="grid grid-cols-1 gap-2.5">
            {list.map((item, i) => (
              <li
                key={item.product_id ?? `${item.name}-${i}`}
                className="flex min-w-0 flex-col gap-1"
              >
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="w-5 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {item.product_id ? (
                      <Link to={`/catalog/products/${item.product_id}`} className="hover:underline">
                        {nameOf(item.name, item.name_ta)}
                      </Link>
                    ) : (
                      nameOf(item.name, item.name_ta)
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <Qty milli={item.qty_milli} unit={item.unit} packSize={item.pack_size} />
                  </span>
                  <Money
                    paise={item.net_sales_paise}
                    decimals={0}
                    className="w-24 shrink-0 text-end font-semibold"
                  />
                </div>
                <div className="ms-7 h-1.5 rounded-full bg-surface-2" aria-hidden>
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{
                      width: `${Math.max(2, Math.round((item.net_sales_paise / max) * 100))}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {canOpenReport ? (
        <div className="border-t border-border px-5 py-2">
          <Button asChild variant="link" size="sm">
            <Link
              to={`/reports/item-sales?from=${range === 'today' ? date : addDays(date, -6)}&to=${date}`}
            >
              {t('top.open_report')}
            </Link>
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
