/**
 * StockSense highlights on the Home dashboard: top items to reorder right now with their
 * forecast model, accuracy, priority badge, order quantity and estimated cost, plus a link to
 * the full StockSense planner (/purchases/stocksense).
 */
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Money,
  Skeleton,
} from '@/components/ui'
import { useReorderSuggestions } from '@/features/purchases/api'
import { formatQty } from '@/lib/format'
import { localizedName } from '@/lib/i18n'

const PRIORITY_TONE = {
  urgent: 'danger',
  high: 'warning',
  normal: 'info',
  low: 'neutral',
} as const

function rank(priority: keyof typeof PRIORITY_TONE): number {
  return { urgent: 3, high: 2, normal: 1, low: 0 }[priority]
}

export function StockSenseCard({ storeId }: { storeId: string | null }) {
  const { t } = useTranslation('dashboard')
  const reorder = useReorderSuggestions(
    storeId ? { store_id: storeId, lead_time_days: 7, model: 'smart' } : null,
  )

  const items = (reorder.data?.data.groups ?? [])
    .flatMap((g) => g.items.map((item) => ({ item, supplier: g.supplier?.name ?? null })))
    .filter(({ item }) => item.suggested_qty_milli > 0)
    .sort((a, b) => rank(b.item.priority) - rank(a.item.priority))

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-primary" aria-hidden />
          {t('stocksense_title')}
        </CardTitle>
        <Button asChild size="sm" variant="ghost">
          <Link to="/purchases/stocksense">{t('see_all')}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {reorder.isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stocksense_empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.slice(0, 5).map(({ item, supplier }) => (
              <li
                key={item.product_id}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">
                      {localizedName(item.name, item.name_ta)}
                    </span>
                    <Badge size="sm" tone={PRIORITY_TONE[item.priority]}>
                      {t(`priority_${item.priority}`)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {item.forecast_method && item.forecast_accuracy_bp != null
                      ? t('forecast_short', {
                          method: t(`method_${item.forecast_method}`),
                          accuracy: Math.round(item.forecast_accuracy_bp / 100),
                        })
                      : t('no_history')}
                    {supplier ? ` · ${supplier}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  <div className="font-semibold">
                    {t('order_qty', { qty: formatQty(item.suggested_qty_milli, item.unit) })}
                  </div>
                  <Money
                    paise={item.estimated_cost_paise}
                    className="text-xs text-muted-foreground"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
