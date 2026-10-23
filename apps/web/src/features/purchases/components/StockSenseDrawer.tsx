/**
 * StockSense details of one item: history + forecast chart, weekday pattern, the order
 * quantity worked out step by step, batches with stock at risk of expiry, open purchase orders,
 * and the planning inputs the owner can change (product shelf life, supplier lead time).
 */
import type { StockSenseProductQuery } from '@kadai/shared/api/purchases'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Button,
  Drawer,
  FormField,
  Money,
  NumberInput,
  Qty,
  Skeleton,
  notify,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { getLanguage, localizedName } from '@/lib/i18n'
import { useStockSenseProduct, useUpdateStockSenseSettings } from '../api'
import { notifyPurchasesError } from '../lib/errors'
import { packUnitFor } from '../lib/labels'
import { PRIORITY_TONE, explainItem, qtyText } from '../lib/stocksense'
import { ProductForecastChart } from './StockSenseCharts'

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

export function StockSenseDrawer({
  productId,
  query,
  onClose,
}: {
  productId: string | null
  query: StockSenseProductQuery | null
  onClose: () => void
}) {
  const { t } = useTranslation(['purchases', 'common'])
  const canWrite = useCan('purchases.write')
  const detail = useStockSenseProduct(productId, query)
  const save = useUpdateStockSenseSettings()
  const data = detail.data?.data
  const item = data?.item
  const [shelf, setShelf] = useState<number | null>(null)
  const [lead, setLead] = useState<number | null>(null)

  useEffect(() => {
    setShelf(item?.shelf_life_days ?? null)
    setLead(item?.supplier?.lead_time_days ?? null)
  }, [item?.product_id, item?.shelf_life_days, item?.supplier?.lead_time_days])

  const dirty =
    item != null &&
    (shelf !== item.shelf_life_days ||
      (item.supplier != null && lead !== item.supplier.lead_time_days))

  const onSave = async (): Promise<void> => {
    if (!item) return
    try {
      await save.mutateAsync({
        body: {
          ...(shelf !== item.shelf_life_days
            ? { products: [{ product_id: item.product_id, shelf_life_days: shelf }] }
            : {}),
          ...(item.supplier && lead !== item.supplier.lead_time_days
            ? { suppliers: [{ supplier_id: item.supplier.id, lead_time_days: lead }] }
            : {}),
        },
      })
      notify.success(t('stocksense.drawer.saved'))
    } catch (error) {
      notifyPurchasesError(error)
    }
  }

  const qty = (milli: number) =>
    item ? (
      <Qty milli={milli} unit={item.unit} packSize={item.pack_size} packUnit={packUnitFor(item.unit)} />
    ) : null
  const params = data?.params
  const weekdayName = (d: number): string =>
    new Intl.DateTimeFormat(getLanguage() === 'ta' ? 'ta-IN' : 'en-IN', {
      weekday: 'short',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 0, 4 + d)))

  return (
    <Drawer
      open={productId != null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={item ? localizedName(item.name, item.name_ta) : t('stocksense.drawer.title')}
      description={item?.sku ?? undefined}
      className="sm:w-[min(40rem,100vw)]"
    >
      {!item || !params ? (
        <div className="grid gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-60 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PRIORITY_TONE[item.priority]}>{t(`stocksense.priority.${item.priority}`)}</Badge>
            <Badge tone="neutral">{t(`stocksense.trend.${item.trend}`)}</Badge>
            <span className="text-xs text-muted-foreground">
              {t(`stocksense.confidence.${item.confidence}`)} ·{' '}
              {t('stocksense.drawer.observed', { count: item.observed_days })}
            </span>
          </div>
          <p className="text-sm">{explainItem(item, params.cycle_days, params.safety_days)}</p>

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('stocksense.drawer.chart_title')}</h3>
            <ProductForecastChart detail={data} />
          </section>

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('stocksense.drawer.weekdays')}</h3>
            {item.weekday_adjusted ? (
              <ul className="grid grid-cols-7 gap-1 text-center text-xs">
                {WEEKDAYS.map((d) => {
                  const f = data.weekday_factors[d] ?? 1000
                  return (
                    <li key={d} className="rounded-md border border-border p-1">
                      <div className="text-muted-foreground">{weekdayName(d)}</div>
                      <div
                        className={
                          f >= 1150 ? 'font-semibold text-success' : f <= 850 ? 'text-warning' : ''
                        }
                      >
                        ×{(f / 1000).toFixed(2)}
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t('stocksense.drawer.weekday_off')}</p>
            )}
          </section>

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('stocksense.drawer.calc_title')}</h3>
            {item.has_history ? (
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">
                  {t('stocksense.drawer.calc_demand', {
                    days: item.lead_time_days + params.cycle_days,
                    lead: item.lead_time_days,
                    cycle: params.cycle_days,
                  })}
                </dt>
                <dd className="text-end">{qty(item.horizon_demand_milli)}</dd>
                <dt className="text-muted-foreground">
                  {t('stocksense.drawer.calc_safety', { safety: params.safety_days })}
                </dt>
                <dd className="text-end">+ {qty(item.safety_milli)}</dd>
                <dt className="text-muted-foreground">{t('stocksense.drawer.calc_stock')}</dt>
                <dd className="text-end">− {qty(item.durable_milli)}</dd>
                <dt className="text-muted-foreground">{t('stocksense.drawer.calc_incoming')}</dt>
                <dd className="text-end">− {qty(item.incoming_milli)}</dd>
                <dt className="border-t border-border pt-1 font-medium">
                  {t('stocksense.drawer.calc_rounded')}
                </dt>
                <dd className="border-t border-border pt-1 text-end font-medium">
                  {qty(item.uncapped_qty_milli)}
                </dd>
                {item.capped_by_shelf_life ? (
                  <>
                    <dt className="text-muted-foreground">
                      {t('stocksense.drawer.calc_capped')} ({item.shelf_life_days ?? 0})
                    </dt>
                    <dd className="text-end">{qty(item.order_qty_milli)}</dd>
                  </>
                ) : null}
                <dt className="font-semibold">{t('stocksense.drawer.calc_order')}</dt>
                <dd className="text-end font-semibold">
                  {qty(item.order_qty_milli)} · <Money paise={item.order_cost_paise} />
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                {item.reorder_level_milli != null
                  ? t('stocksense.drawer.calc_no_history', {
                      level: qtyText(item.reorder_level_milli, item),
                      qty: qtyText(item.reorder_qty_milli ?? 0, item),
                    })
                  : t('stocksense.drawer.calc_no_level')}
              </p>
            )}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {item.margin_bp != null ? (
                <span>{t('stocksense.drawer.margin', { pct: (item.margin_bp / 100).toFixed(1) })}</span>
              ) : null}
              {item.profit_per_day_paise != null ? (
                <span>
                  {t('stocksense.drawer.profit_day', {
                    amount: formatMoney(item.profit_per_day_paise),
                  })}
                </span>
              ) : null}
              {item.lost_profit_paise > 0 ? (
                <span className="font-medium text-danger">
                  {t('stocksense.drawer.lost', { amount: formatMoney(item.lost_profit_paise) })}
                </span>
              ) : null}
            </div>
          </section>

          <section className="grid gap-3 rounded-xl border border-border p-3">
            <h3 className="text-sm font-semibold">{t('stocksense.drawer.inputs')}</h3>
            <FormField
              label={t('stocksense.drawer.shelf_life')}
              hint={t('stocksense.drawer.shelf_life_hint')}
            >
              <NumberInput
                value={shelf}
                min={0}
                max={3650}
                disabled={!canWrite || save.isPending}
                onChange={setShelf}
              />
            </FormField>
            {item.supplier ? (
              <FormField
                label={t('stocksense.drawer.lead_time', { name: item.supplier.name })}
                hint={t('stocksense.drawer.lead_time_hint', { days: params.lead_time_days })}
              >
                <NumberInput
                  value={lead}
                  min={1}
                  max={180}
                  disabled={!canWrite || save.isPending}
                  onChange={setLead}
                />
              </FormField>
            ) : (
              <p className="text-xs text-muted-foreground">{t('stocksense.drawer.no_supplier')}</p>
            )}
            {canWrite ? (
              <Button
                className="justify-self-start"
                size="sm"
                disabled={!dirty}
                loading={save.isPending}
                onClick={() => void onSave()}
              >
                {t('stocksense.drawer.save')}
              </Button>
            ) : null}
          </section>

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('stocksense.drawer.batches')}</h3>
            {data.batches.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('stocksense.drawer.no_batches')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                {data.batches.map((b) => (
                  <li key={b.batch_id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                    <span className="min-w-0">
                      <span className="font-medium">{b.batch_no}</span>
                      {b.expiry_date ? (
                        <span className="ms-2 text-xs text-muted-foreground">
                          {t('stocksense.expiring.expires', { date: formatDate(b.expiry_date) })}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      {qty(b.qty_milli)}
                      {b.at_risk_milli > 0 ? (
                        <Badge tone="danger" size="sm">
                          {t('stocksense.expiring.at_risk')} {qtyText(b.at_risk_milli, item)}
                        </Badge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('stocksense.drawer.open_orders')}</h3>
            {data.open_orders.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('stocksense.drawer.no_orders')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                {data.open_orders.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                    <Link className="font-medium text-primary hover:underline" to={`/purchases/orders/${o.id}`}>
                      {o.number}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {o.expected_date
                        ? t('stocksense.drawer.expected', { date: formatDate(o.expected_date) })
                        : t('stocksense.drawer.no_date')}
                    </span>
                    {qty(o.pending_milli)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  )
}
