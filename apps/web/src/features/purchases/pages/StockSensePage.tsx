/**
 * StockSense (/purchases/stocksense) — small-shop reorder planner on the store's own sales,
 * stock, suppliers and purchase orders (GET /purchases/stocksense):
 *  - plan settings (default supplier lead time, order cycle, safety days, forecast window,
 *    weekday pattern), remembered per browser;
 *  - KPI tiles (order today / this week, order cost, profit at risk, cash in slow stock, stock
 *    expiring before it sells) and two charts (days of stock left, top profit at risk);
 *  - tabs: ranked reorder plan → draft purchase orders per supplier, slow stock, batches that
 *    will expire unsold (→ purchase return), all items;
 *  - past-sales CSV upload (POST /purchases/sales-history; feeds the forecast, never stock) and
 *    links to enter / count stock on hand;
 *  - item details drawer with history + forecast chart, the calculation and planning inputs.
 */
import type { StockSenseItem } from '@kadai/shared/api/purchases'
import { adjustmentPrefillPath, purchaseReturnPrefillPath } from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import {
  STOCKSENSE_PRIORITIES,
  STOCKSENSE_WINDOWS,
  type StockSensePriority,
} from '@kadai/shared/stocksense'
import {
  AlarmClock,
  BadgeIndianRupee,
  CalendarClock,
  ClipboardCheck,
  Download,
  Hourglass,
  Info,
  PackagePlus,
  RotateCcw,
  ShoppingCart,
  TrendingDown,
  Undo2,
  Upload,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FormField,
  Money,
  NumberInput,
  PageHeader,
  Qty,
  SearchInput,
  Select,
  Skeleton,
  Stat,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  notify,
} from '@/components/ui'
import { useCan, useCurrentStore, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatDateTime } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useImportSalesHistory, useStockSense } from '../api'
import { CoverChart, ProfitRiskChart } from '../components/StockSenseCharts'
import { StockSenseDrawer } from '../components/StockSenseDrawer'
import { ItemFacts, StockSensePlan } from '../components/StockSensePlan'
import { notifyPurchasesError } from '../lib/errors'
import { packUnitFor } from '../lib/labels'
import {
  DEFAULT_PLAN_SETTINGS,
  PRIORITY_TONE,
  type PlanSettings,
  downloadSalesTemplate,
  explainItem,
  loadPlanSettings,
  planQuery,
  savePlanSettings,
} from '../lib/stocksense'

type Tab = 'plan' | 'slow' | 'expiring' | 'all'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

export default function StockSensePage() {
  const { t } = useTranslation(['purchases', 'common'])
  const navigate = useNavigate()
  const me = useMe()
  const current = useCurrentStore()
  const canWrite = useCan('purchases.write')
  const canAdjust = useCan('inventory.adjust')
  const activeStores = (me?.stores ?? []).filter((s) => s.is_active)
  const [storeId, setStoreId] = useState<string | null>(current?.id ?? activeStores[0]?.id ?? null)
  const [settings, setSettingsState] = useState<PlanSettings>(loadPlanSettings)
  const [tab, setTab] = useState<Tab>('plan')
  const [q, setQ] = useState('')
  const [priority, setPriority] = useState<StockSensePriority | 'all'>('all')
  const [detail, setDetail] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const importHistory = useImportSalesHistory()

  const setSettings = (patch: Partial<PlanSettings>): void => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch }
      savePlanSettings(next)
      return next
    })
  }
  const debounced = useDebounced(settings, 400)
  const query = useMemo(
    () => (storeId ? planQuery(storeId, debounced) : null),
    [storeId, debounced],
  )
  const plan = useStockSense(query)
  const report = plan.data?.data
  const items = useMemo(() => report?.items ?? [], [report])

  const needle = q.trim().toLowerCase()
  const matches = (i: StockSenseItem): boolean =>
    !needle ||
    i.name.toLowerCase().includes(needle) ||
    (i.name_ta ?? '').toLowerCase().includes(needle) ||
    (i.sku ?? '').toLowerCase().includes(needle) ||
    (i.supplier?.name ?? '').toLowerCase().includes(needle)

  const planItems = useMemo(
    () => items.filter((i) => i.order_qty_milli > 0).sort((a, b) => a.rank - b.rank),
    [items],
  )
  const slowItems = useMemo(
    () =>
      items
        .filter((i) => i.excess_value_paise > 0)
        .sort((a, b) => b.excess_value_paise - a.excess_value_paise),
    [items],
  )
  const byId = useMemo(() => new Map(items.map((i) => [i.product_id, i])), [items])

  const onCsv = async (file: File | null): Promise<void> => {
    if (!file || !storeId) return
    try {
      const csv = await file.text()
      const res = await importHistory.mutateAsync({
        body: { store_id: storeId, csv },
        idempotencyKey: newId(),
      })
      notify.success(t('stocksense.imported', { count: res.data.imported_rows }))
      if (res.data.skipped_count > 0) {
        notify.warning(t('stocksense.import_skipped', { count: res.data.skipped_count }))
      }
    } catch (error) {
      notifyPurchasesError(error)
    }
  }

  const s = report?.summary
  const params = report?.params
  const windowOptions = STOCKSENSE_WINDOWS.map((d) => ({
    value: String(d),
    label: t('stocksense.settings.window_option', { count: d }),
  }))

  return (
    <div className="grid gap-4">
      <PageHeader
        title={t('stocksense.title')}
        description={t('stocksense.description')}
        actions={
          <div className="flex flex-wrap gap-2">
            {canWrite ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="text/csv,.csv"
                  className="sr-only"
                  aria-label={t('stocksense.upload')}
                  onChange={(e) => {
                    void onCsv(e.target.files?.[0] ?? null)
                    e.target.value = ''
                  }}
                />
                <Button
                  leftIcon={<Upload />}
                  loading={importHistory.isPending}
                  disabled={!storeId}
                  onClick={() => fileRef.current?.click()}
                >
                  {t('stocksense.upload')}
                </Button>
              </>
            ) : null}
            <Button
              variant="outline"
              leftIcon={<Download />}
              onClick={() =>
                downloadSalesTemplate(report?.today ?? new Date().toISOString().slice(0, 10))
              }
            >
              {t('stocksense.template')}
            </Button>
            {canAdjust ? (
              <>
                <Button
                  variant="outline"
                  leftIcon={<PackagePlus />}
                  onClick={() => navigate('/inventory/stock?opening=1')}
                >
                  {t('stocksense.stock_on_hand')}
                </Button>
                <Button
                  variant="outline"
                  leftIcon={<ClipboardCheck />}
                  onClick={() =>
                    navigate(
                      adjustmentPrefillPath({ kind: 'stock_take', store_id: storeId ?? undefined }),
                    )
                  }
                >
                  {t('stocksense.stock_take')}
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <Card className="grid gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('stocksense.settings.title')}</h2>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RotateCcw />}
            onClick={() => setSettings(DEFAULT_PLAN_SETTINGS)}
          >
            {t('stocksense.settings.reset')}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {activeStores.length > 1 ? (
            <FormField label={t('stocksense.settings.store')} className="col-span-2 md:col-span-1">
              <StorePicker value={storeId} clearable={false} onChange={(id) => setStoreId(id)} />
            </FormField>
          ) : null}
          <FormField
            label={t('stocksense.settings.lead_time')}
            hint={t('stocksense.settings.lead_time_hint')}
          >
            <NumberInput
              value={settings.lead_time_days}
              min={1}
              max={180}
              onChange={(v) => {
                if (v != null && v >= 1 && v <= 180) setSettings({ lead_time_days: v })
              }}
            />
          </FormField>
          <FormField
            label={t('stocksense.settings.cycle')}
            hint={t('stocksense.settings.cycle_hint')}
          >
            <NumberInput
              value={settings.cycle_days}
              min={1}
              max={90}
              onChange={(v) => {
                if (v != null && v >= 1 && v <= 90) setSettings({ cycle_days: v })
              }}
            />
          </FormField>
          <FormField
            label={t('stocksense.settings.safety')}
            hint={t('stocksense.settings.safety_hint')}
          >
            <NumberInput
              value={settings.safety_days}
              min={0}
              max={60}
              onChange={(v) => {
                if (v != null && v >= 0 && v <= 60) setSettings({ safety_days: v })
              }}
            />
          </FormField>
          <FormField label={t('stocksense.settings.window')}>
            <Select
              value={String(settings.window_days)}
              options={windowOptions}
              onValueChange={(v) => {
                const n = Number(v)
                const w = STOCKSENSE_WINDOWS.find((d) => d === n)
                if (w) setSettings({ window_days: w })
              }}
            />
          </FormField>
          <div className="col-span-2 flex items-end pb-1 md:col-span-1">
            <Switch
              checked={settings.weekday_adjust}
              label={t('stocksense.settings.weekday')}
              description={t('stocksense.settings.weekday_hint')}
              onCheckedChange={(v) => setSettings({ weekday_adjust: v })}
            />
          </div>
        </div>
      </Card>

      {!storeId ? (
        <EmptyState title={t('stocksense.empty_title')} description={t('stocksense.empty_desc')} />
      ) : plan.isLoading ? (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : plan.error || !report || !s || !params ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            title={t('stocksense.error')}
            action={
              <Button variant="outline" onClick={() => void plan.refetch()}>
                {t('stocksense.retry')}
              </Button>
            }
          />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<ShoppingCart />}
            title={t('stocksense.empty_title')}
            description={t('stocksense.empty_desc')}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <Stat
              label={t('stocksense.kpi.urgent')}
              value={s.urgent}
              hint={t('stocksense.kpi.urgent_hint')}
              icon={<AlarmClock />}
              tone={s.urgent > 0 ? 'danger' : 'default'}
              onClick={() => setTab('plan')}
            />
            <Stat
              label={t('stocksense.kpi.high')}
              value={s.high}
              hint={t('stocksense.kpi.high_hint')}
              icon={<CalendarClock />}
              onClick={() => setTab('plan')}
            />
            <Stat
              label={t('stocksense.kpi.cost')}
              value={<Money paise={s.order_cost_paise} compact />}
              hint={t('stocksense.kpi.cost_hint', { count: s.order_lines })}
              icon={<ShoppingCart />}
              tone="primary"
              onClick={() => setTab('plan')}
            />
            <Stat
              label={t('stocksense.kpi.lost')}
              value={<Money paise={s.lost_profit_paise} compact />}
              hint={t('stocksense.kpi.lost_hint')}
              icon={<TrendingDown />}
              tone={s.lost_profit_paise > 0 ? 'danger' : 'default'}
              onClick={() => setTab('plan')}
            />
            <Stat
              label={t('stocksense.kpi.slow')}
              value={<Money paise={s.excess_value_paise} compact />}
              hint={t('stocksense.kpi.slow_hint', {
                count: s.slow_items,
                days: params.slow_cover_days,
              })}
              icon={<BadgeIndianRupee />}
              tone="accent"
              onClick={() => setTab('slow')}
            />
            <Stat
              label={t('stocksense.kpi.expiry')}
              value={<Money paise={s.expiry_risk_value_paise} compact />}
              hint={t('stocksense.kpi.expiry_hint', { count: s.expiry_items })}
              icon={<Hourglass />}
              tone={s.expiry_risk_value_paise > 0 ? 'danger' : 'default'}
              onClick={() => setTab('expiring')}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="grid gap-1 p-3">
              <h2 className="text-sm font-semibold">{t('stocksense.charts.cover_title')}</h2>
              <p className="text-xs text-muted-foreground">{t('stocksense.charts.cover_desc')}</p>
              <CoverChart buckets={s.cover_buckets} />
            </Card>
            <Card className="grid gap-1 p-3">
              <h2 className="text-sm font-semibold">{t('stocksense.charts.profit_title')}</h2>
              <p className="text-xs text-muted-foreground">{t('stocksense.charts.profit_desc')}</p>
              <ProfitRiskChart items={items} />
            </Card>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t('stocksense.generated', { time: formatDateTime(report.generated_at) })}
              {report.imported_days > 0
                ? ` · ${t('stocksense.imported_days', { count: report.imported_days })}`
                : ''}
            </span>
            {report.truncated ? (
              <span className="text-warning">{t('stocksense.truncated')}</span>
            ) : null}
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList aria-label={t('stocksense.tabs.label')}>
              <TabsTrigger value="plan">
                {t('stocksense.tabs.plan')}
                <Badge size="sm" tone={s.urgent > 0 ? 'danger' : 'neutral'} className="ms-1">
                  {planItems.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="slow">
                {t('stocksense.tabs.slow')}
                <Badge size="sm" tone="neutral" className="ms-1">
                  {slowItems.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="expiring">
                {t('stocksense.tabs.expiring')}
                <Badge
                  size="sm"
                  tone={report.expiry_batches.length > 0 ? 'warning' : 'neutral'}
                  className="ms-1"
                >
                  {report.expiry_batches.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="all">{t('stocksense.tabs.all')}</TabsTrigger>
            </TabsList>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <SearchInput
                value={q}
                onChange={setQ}
                placeholder={t('stocksense.search')}
                aria-label={t('stocksense.search')}
                wrapperClassName="sm:max-w-xs sm:flex-1"
              />
              {tab === 'all' ? (
                <div
                  className="flex flex-wrap gap-1"
                  role="group"
                  aria-label={t('stocksense.priority_all')}
                >
                  {(['all', ...STOCKSENSE_PRIORITIES] as const).map((p) => (
                    <Button
                      key={p}
                      size="sm"
                      variant={priority === p ? 'primary' : 'outline'}
                      onClick={() => setPriority(p)}
                    >
                      {p === 'all' ? t('stocksense.priority_all') : t(`stocksense.priority.${p}`)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>

            <TabsContent value="plan" className="mt-3">
              <StockSensePlan
                storeId={storeId}
                items={planItems.filter(matches)}
                cycleDays={params.cycle_days}
                safetyDays={params.safety_days}
                onDetails={setDetail}
              />
            </TabsContent>

            <TabsContent value="slow" className="mt-3">
              <SlowList
                items={slowItems.filter(matches)}
                days={params.slow_cover_days}
                onDetails={setDetail}
              />
            </TabsContent>

            <TabsContent value="expiring" className="mt-3">
              <ExpiringList
                storeId={storeId}
                batches={report.expiry_batches.filter((b) => {
                  const item = byId.get(b.product_id)
                  return item ? matches(item) : !needle
                })}
                byId={byId}
                onDetails={setDetail}
              />
            </TabsContent>

            <TabsContent value="all" className="mt-3">
              <AllList
                items={items.filter(
                  (i) => matches(i) && (priority === 'all' || i.priority === priority),
                )}
                cycleDays={params.cycle_days}
                safetyDays={params.safety_days}
                onDetails={setDetail}
              />
            </TabsContent>
          </Tabs>

          <Assumptions params={params} from={report.history_from} to={report.history_to} />
        </>
      )}

      <StockSenseDrawer productId={detail} query={query} onClose={() => setDetail(null)} />
    </div>
  )
}

function SlowList({
  items,
  days,
  onDetails,
}: {
  items: readonly StockSenseItem[]
  days: number
  onDetails: (id: string) => void
}) {
  const { t } = useTranslation('purchases')
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState
          title={t('stocksense.slow.empty_title')}
          description={t('stocksense.slow.empty_desc', { days })}
          compact
        />
      </div>
    )
  }
  return (
    <Card className="overflow-hidden">
      <p className="border-b border-border bg-surface-2/50 p-3 text-xs text-muted-foreground">
        {t('stocksense.slow.hint')}
      </p>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const name = localizedName(item.name, item.name_ta)
          return (
            <li
              key={item.product_id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 p-3"
            >
              <div className="min-w-0">
                <button
                  type="button"
                  className="text-start font-medium hover:underline [overflow-wrap:anywhere]"
                  onClick={() => onDetails(item.product_id)}
                >
                  {name}
                </button>
                <ItemFacts item={item} />
                {!item.has_history ? (
                  <p className="text-xs text-warning">{t('stocksense.slow.no_sales')}</p>
                ) : null}
              </div>
              <div className="grid justify-items-end text-sm">
                <span className="text-xs text-muted-foreground">{t('stocksense.slow.excess')}</span>
                <Qty
                  milli={item.excess_milli}
                  unit={item.unit}
                  packSize={item.pack_size}
                  packUnit={packUnitFor(item.unit)}
                />
                <span className="text-xs text-muted-foreground">{t('stocksense.slow.value')}</span>
                <Money paise={item.excess_value_paise} className="font-semibold" />
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function ExpiringList({
  storeId,
  batches,
  byId,
  onDetails,
}: {
  storeId: string
  batches: readonly {
    product_id: string
    batch_id: string
    batch_no: string
    expiry_date: string
    days_left: number
    qty_milli: number
    at_risk_milli: number
    at_risk_value_paise: number
    supplier_id: string | null
  }[]
  byId: Map<string, StockSenseItem>
  onDetails: (id: string) => void
}) {
  const { t } = useTranslation('purchases')
  const canReturn = useCan('purchases.write')
  if (batches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState
          title={t('stocksense.expiring.empty_title')}
          description={t('stocksense.expiring.empty_desc')}
          compact
        />
      </div>
    )
  }
  return (
    <Card className="overflow-hidden">
      <p className="border-b border-border bg-surface-2/50 p-3 text-xs text-muted-foreground">
        {t('stocksense.expiring.hint')}
      </p>
      <ul className="divide-y divide-border">
        {batches.map((b) => {
          const item = byId.get(b.product_id)
          const unit = item?.unit ?? 'PCS'
          const pack = item?.pack_size ?? 1
          const qty = (milli: number) => (
            <Qty milli={milli} unit={unit} packSize={pack} packUnit={packUnitFor(unit)} />
          )
          return (
            <li
              key={b.batch_id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 p-3"
            >
              <div className="min-w-0">
                <button
                  type="button"
                  className="text-start font-medium hover:underline [overflow-wrap:anywhere]"
                  onClick={() => onDetails(b.product_id)}
                >
                  {item ? localizedName(item.name, item.name_ta) : b.product_id}
                </button>
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{t('stocksense.expiring.batch', { batch: b.batch_no })}</span>
                  <span>
                    {t('stocksense.expiring.expires', { date: formatDate(b.expiry_date) })}
                  </span>
                  <span
                    className={cn(b.days_left < 0 ? 'font-semibold text-danger' : 'text-warning')}
                  >
                    {b.days_left < 0
                      ? t('stocksense.expiring.expired')
                      : t('stocksense.expiring.days_left', { count: b.days_left })}
                  </span>
                  <span>
                    {t('stocksense.expiring.qty')} {qty(b.qty_milli)}
                  </span>
                </div>
              </div>
              <div className="grid justify-items-end gap-1 text-sm">
                <span className="text-xs text-muted-foreground">
                  {t('stocksense.expiring.at_risk')} {qty(b.at_risk_milli)}
                </span>
                <Money paise={b.at_risk_value_paise} className="font-semibold text-danger" />
                {canReturn && b.supplier_id ? (
                  <Button variant="outline" size="sm" leftIcon={<Undo2 />} asChild>
                    <Link
                      to={purchaseReturnPrefillPath({
                        batch_ids: [b.batch_id],
                        store_id: storeId,
                        supplier_id: b.supplier_id,
                      })}
                    >
                      {t('stocksense.expiring.return')}
                    </Link>
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function AllList({
  items,
  cycleDays,
  safetyDays,
  onDetails,
}: {
  items: readonly StockSenseItem[]
  cycleDays: number
  safetyDays: number
  onDetails: (id: string) => void
}) {
  const { t } = useTranslation('purchases')
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState title={t('stocksense.all.empty')} compact />
      </div>
    )
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li
            key={item.product_id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 p-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground tabular-nums">
                  #{item.rank}
                </span>
                <button
                  type="button"
                  className="text-start font-medium hover:underline [overflow-wrap:anywhere]"
                  onClick={() => onDetails(item.product_id)}
                >
                  {localizedName(item.name, item.name_ta)}
                </button>
                <Badge tone={PRIORITY_TONE[item.priority]} size="sm">
                  {t(`stocksense.priority.${item.priority}`)}
                </Badge>
              </div>
              <ItemFacts item={item} />
              <p className="mt-1 text-xs text-muted-foreground">
                {explainItem(item, cycleDays, safetyDays)}
              </p>
            </div>
            <div className="grid justify-items-end text-sm">
              <Qty
                milli={item.order_qty_milli}
                unit={item.unit}
                packSize={item.pack_size}
                packUnit={packUnitFor(item.unit)}
                className="font-semibold"
              />
              <Money paise={item.order_cost_paise} className="text-xs text-muted-foreground" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Assumptions({
  params,
  from,
  to,
}: {
  params: { lead_time_days: number; window_days: number; slow_cover_days: number }
  from: string
  to: string
}) {
  const { t } = useTranslation('purchases')
  return (
    <details className="rounded-xl border border-border bg-surface p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold">
        <Info className="size-4 text-muted-foreground" aria-hidden />
        {t('stocksense.assumptions.title')}
      </summary>
      <ul className="mt-2 grid list-disc gap-1 ps-5 text-muted-foreground">
        <li>{t('stocksense.assumptions.lead', { days: params.lead_time_days })}</li>
        <li>{t('stocksense.assumptions.forecast', { days: params.window_days })}</li>
        <li>{t('stocksense.assumptions.weekday')}</li>
        <li>{t('stocksense.assumptions.fallback')}</li>
        <li>{t('stocksense.assumptions.imported')}</li>
        <li>{t('stocksense.assumptions.orders')}</li>
        <li>{t('stocksense.assumptions.rounding')}</li>
        <li>{t('stocksense.assumptions.shelf')}</li>
        <li>{t('stocksense.assumptions.slow', { days: params.slow_cover_days })}</li>
        <li>
          {t('stocksense.assumptions.history', { from: formatDate(from), to: formatDate(to) })}
        </li>
      </ul>
    </details>
  )
}
