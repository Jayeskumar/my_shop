/**
 * Home dashboard: today's sales, stock value, supplier dues and what StockSense says to reorder,
 * with quick actions and the latest bills. Built only from existing module routes (sales,
 * inventory, purchases); each block is shown only with its read permission.
 */
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import {
  Boxes,
  IndianRupee,
  PackagePlus,
  ReceiptText,
  ShoppingCart,
  Sparkles,
  Truck,
} from 'lucide-react'
import type { ReactNode } from 'react'
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
  PageHeader,
  Skeleton,
  Stat,
} from '@/components/ui'
import { useDefaultStoreId, useToday } from '@/features/inventory/lib/access'
import { useBills, useReorderSuggestions } from '@/features/purchases/api'
import { useInvoices } from '@/features/sales/api'
import { useCan, useMe } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { useRouteQuery } from '@/lib/query'

const PRIORITY_TONE = {
  urgent: 'danger',
  high: 'warning',
  normal: 'info',
  low: 'neutral',
} as const

export default function HomePage() {
  const { t } = useTranslation('dashboard')
  const me = useMe()
  const today = useToday()
  const storeId = useDefaultStoreId()
  const canSales = useCan('sales.read')
  const canStock = useCan('inventory.read')
  const canBuy = useCan('purchases.read')

  const todaySales = useInvoices(
    { from: today, to: today, status: ['completed'], limit: 5 },
    { enabled: canSales },
  )
  const stock = useRouteQuery(
    inventoryRoutes.listStock,
    { query: { ...(storeId ? { store_id: storeId } : {}), limit: 1 } },
    { enabled: canStock, meta: { errorToast: false } },
  )
  const dues = useBills({ status: ['posted'], limit: 1 }, canBuy)
  const reorder = useReorderSuggestions(
    canBuy && storeId ? { store_id: storeId, lead_time_days: 7, model: 'smart' } : null,
  )

  const salesSummary = todaySales.data?.summary
  const stockTotals = stock.data?.totals
  const billSummary = dues.data?.summary
  const reorderItems = (reorder.data?.data.groups ?? [])
    .flatMap((g) => g.items.map((item) => ({ item, supplier: g.supplier?.name ?? null })))
    .filter(({ item }) => item.suggested_qty_milli > 0)
    .sort((a, b) => rank(b.item.priority) - rank(a.item.priority))
  const urgentCount = reorderItems.filter(({ item }) => item.priority === 'urgent' || item.priority === 'high').length

  return (
    <div className="grid gap-6">
      <PageHeader
        title={t('greeting', { name: me?.user.full_name?.split(' ')[0] ?? '' })}
        description={t('subtitle', { shop: me?.tenant.name ?? '' })}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {canSales ? (
          <Stat
            label={t('today_sales')}
            icon={<IndianRupee />}
            tone="primary"
            loading={todaySales.isLoading}
            value={<Money paise={salesSummary?.total_paise ?? 0} />}
            hint={t('bills_count', { count: salesSummary?.count ?? 0 })}
          />
        ) : null}
        {canStock ? (
          <Stat
            label={t('stock_value')}
            icon={<Boxes />}
            loading={stock.isLoading}
            value={<Money paise={stockTotals?.value_cost_paise ?? 0} />}
            hint={t('stock_hint', {
              items: stockTotals?.item_count ?? 0,
              low: (stockTotals?.low_stock_count ?? 0) + (stockTotals?.out_of_stock_count ?? 0),
            })}
          />
        ) : null}
        {canBuy ? (
          <Stat
            label={t('to_pay')}
            icon={<Truck />}
            loading={dues.isLoading}
            tone={(billSummary?.overdue_paise ?? 0) > 0 ? 'danger' : 'default'}
            value={<Money paise={billSummary?.due_paise ?? 0} />}
            hint={
              (billSummary?.overdue_paise ?? 0) > 0 ? (
                <>
                  {t('overdue')} <Money paise={billSummary?.overdue_paise ?? 0} />
                </>
              ) : (
                t('nothing_overdue')
              )
            }
          />
        ) : null}
        {canBuy ? (
          <Stat
            label={t('reorder_now')}
            icon={<Sparkles />}
            tone={urgentCount > 0 ? 'accent' : 'default'}
            loading={reorder.isLoading}
            value={String(reorderItems.length)}
            hint={t('reorder_hint', { count: urgentCount })}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <QuickAction to="/pos" icon={<ShoppingCart />} label={t('action_bill')} primary />
        <QuickAction to="/catalog/products/new" icon={<PackagePlus />} label={t('action_product')} />
        <QuickAction to="/purchases/bills/new" icon={<ReceiptText />} label={t('action_purchase')} />
        <QuickAction to="/purchases/orders?tab=reorder" icon={<Sparkles />} label={t('action_stocksense')} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {canBuy ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4 text-primary" aria-hidden />
                {t('stocksense_title')}
              </CardTitle>
              <Button asChild size="sm" variant="ghost">
                <Link to="/purchases/orders?tab=reorder">{t('see_all')}</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {reorder.isLoading ? (
                <Rows />
              ) : reorderItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('stocksense_empty')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {reorderItems.slice(0, 5).map(({ item, supplier }) => (
                    <li key={item.product_id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{item.name}</span>
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
                          {t('order_qty', { qty: Math.round(item.suggested_qty_milli / 1000) })}
                        </div>
                        <Money paise={item.estimated_cost_paise} className="text-xs text-muted-foreground" />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}

        {canSales ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ReceiptText className="size-4 text-primary" aria-hidden />
                {t('recent_title')}
              </CardTitle>
              <Button asChild size="sm" variant="ghost">
                <Link to="/sales/invoices">{t('see_all')}</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {todaySales.isLoading ? (
                <Rows />
              ) : (todaySales.data?.data.length ?? 0) === 0 ? (
                <div className="grid gap-3">
                  <p className="text-sm text-muted-foreground">{t('recent_empty')}</p>
                  <Button asChild size="sm" className="w-fit">
                    <Link to="/pos">{t('action_bill')}</Link>
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {todaySales.data!.data.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between gap-3 py-2">
                      <Link to={`/sales/invoices/${inv.id}`} className="min-w-0 hover:underline">
                        <div className="truncate font-medium">{inv.number ?? '—'}</div>
                        <p className="text-xs text-muted-foreground">
                          {inv.customer_name ?? t('walk_in')} · {formatDateTime(inv.invoice_at)}
                        </p>
                      </Link>
                      <Money paise={inv.total_paise} className="shrink-0 font-semibold" />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

function rank(priority: keyof typeof PRIORITY_TONE): number {
  return { urgent: 3, high: 2, normal: 1, low: 0 }[priority]
}

function QuickAction({
  to,
  icon,
  label,
  primary = false,
}: {
  to: string
  icon: ReactNode
  label: string
  primary?: boolean
}) {
  return (
    <Button asChild variant={primary ? 'primary' : 'outline'} leftIcon={icon}>
      <Link to={to}>{label}</Link>
    </Button>
  )
}

function Rows() {
  return (
    <div className="grid gap-2">
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
    </div>
  )
}
