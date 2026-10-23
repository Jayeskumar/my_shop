/**
 * Reorder suggestions (tab of /purchases/orders): products at / below their reorder level in the
 * store, grouped by the supplier they were last bought from, with stock, average daily sales,
 * days of cover, what is already on order and the suggested quantity. Tick items, adjust the
 * quantities and create one draft purchase order per supplier in one go; products never bought
 * before get a supplier chosen here. "Open in editor" moves a group into the full PO form.
 */
import type { ReorderItem, ReorderSuggestions } from '@kadai/shared/api/purchases'
import { planStockSense } from '@kadai/shared/api/purchases'
import { type BudgetLine, type BudgetPlan, planWithinBudget } from '@kadai/shared/budget'
import { reorderPrefillPath } from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import { mulDiv } from '@kadai/shared/math'
import { milliToDecimalString } from '@kadai/shared/units'
import { CheckCircle2, ClipboardPlus, PackageSearch, SquarePen, Upload, Wallet } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Money,
  MoneyInput,
  NumberInput,
  Qty,
  SearchInput,
  Skeleton,
  Switch,
  notify,
} from '@/components/ui'
import { useCan, useCurrentStore, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useCreateOrder, useImportSalesHistory, useReorderSuggestions } from '../api'
import { fromPackMilli, toPackMilli } from '../lib/bill-form'
import { notifyPurchasesError } from '../lib/errors'
import { packUnitFor } from '../lib/labels'
import { reorderOrderBody } from '../lib/order-form'

type Group = ReorderSuggestions['groups'][number]

interface Pick {
  selected: boolean
  qty_milli: number | null
  /** True once the owner types a quantity; otherwise it follows the recommendation. */
  edited: boolean
  /** What-if on-hand. Null uses the server's usable stock. Not written to stock. */
  on_hand_milli: number | null
}

const BUDGET_PRESETS_PAISE = [500_000, 1_000_000, 2_000_000] as const

const budgetTone = {
  full: 'success',
  must_have: 'info',
  partial: 'warning',
  left_out: 'danger',
} as const

const priorityTone = {
  urgent: 'danger',
  high: 'warning',
  normal: 'info',
  low: 'neutral',
} as const

/** Group key: supplier id, or '' for never-purchased products. */
const groupKey = (g: Group): string => g.supplier?.id ?? ''

export function ReorderPanel() {
  const { t } = useTranslation(['purchases', 'common'])
  const navigate = useNavigate()
  const me = useMe()
  const current = useCurrentStore()
  const canWrite = useCan('purchases.write')
  const canSuppliers = useCan('suppliers.read')
  const [storeId, setStoreId] = useState<string | null>(
    current?.id ?? me?.stores.find((s) => s.is_active)?.id ?? null,
  )
  const [supplierFilter, setSupplierFilter] = useState<{ id: string; name: string } | null>(null)
  const [q, setQ] = useState('')
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [assigned, setAssigned] = useState<Record<string, { id: string; name: string } | null>>({})
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ id: string; number: string; supplier: string }[]>([])
  const [leadTime, setLeadTime] = useState(7)
  const [windowDays, setWindowDays] = useState<7 | 30>(7)
  const [smartModel, setSmartModel] = useState(true)
  const [weekdayAdjust, setWeekdayAdjust] = useState(true)
  const [shelfLife, setShelfLife] = useState<number | null>(null)
  /** Cash budget for today's order (paise); null = no budget, the full suggestions. */
  const [budget, setBudget] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const create = useCreateOrder()
  const importHistory = useImportSalesHistory()
  const multiStore = (me?.stores ?? []).filter((s) => s.is_active).length > 1

  const query = useReorderSuggestions(
    storeId
      ? {
          store_id: storeId,
          lead_time_days: leadTime,
          model: smartModel ? 'smart' : 'average',
          window_days: windowDays,
          weekday_adjust: weekdayAdjust,
          ...(shelfLife != null ? { shelf_life_days: shelfLife } : {}),
          ...(supplierFilter ? { supplier_id: supplierFilter.id } : {}),
          ...(q ? { q } : {}),
        }
      : null,
  )
  const groups = useMemo(() => query.data?.data.groups ?? [], [query.data])
  const forecast = query.data?.data.forecast ?? false

  // New suggestions: every item with a suggested quantity starts ticked at that quantity.
  useEffect(() => {
    setPicks((prev) => {
      const next: Record<string, Pick> = {}
      for (const g of groups) {
        for (const item of g.items) {
          const prevPick = prev[item.product_id]
          next[item.product_id] = {
            selected: prevPick?.selected ?? item.suggested_qty_milli > 0,
            edited: prevPick?.edited ?? false,
            on_hand_milli: prevPick?.on_hand_milli ?? null,
            qty_milli: prevPick?.edited
              ? (prevPick.qty_milli ?? null)
              : item.suggested_qty_milli > 0
                ? item.suggested_qty_milli
                : null,
          }
        }
      }
      return next
    })
  }, [groups])

  const budgetPlan = useMemo<BudgetPlan | null>(() => {
    if (budget === null || !forecast) return null
    return planWithinBudget(
      groups.flatMap((g) =>
        g.items.map((item) => ({
          product_id: item.product_id,
          name: item.name,
          priority: item.priority,
          stockout_urgency_days: item.stockout_urgency_days,
          margin_bp: item.margin_bp,
          suggested_qty_milli: item.suggested_qty_milli,
          forecast_demand_milli: item.forecast_demand_milli,
          durable_stock_milli: item.durable_stock_milli,
          open_po_qty_milli: item.open_po_qty_milli,
          pack_size: item.pack_size,
          unit_cost_paise: item.unit_cost_paise,
          gst_rate_bp: item.gst_rate_bp,
        })),
      ),
      budget,
    )
  }, [budget, forecast, groups])
  const budgetLines = useMemo(
    () => new Map((budgetPlan?.lines ?? []).map((l) => [l.product_id, l])),
    [budgetPlan],
  )
  const hadBudget = useRef(false)

  // A budget sets every pick to the budget plan; clearing it goes back to the suggestions.
  useEffect(() => {
    if (budgetPlan) {
      hadBudget.current = true
      setPicks((prev) => {
        const next = { ...prev }
        for (const line of budgetPlan.lines) {
          next[line.product_id] = {
            selected: line.qty_milli > 0,
            edited: false,
            on_hand_milli: null,
            qty_milli: line.qty_milli > 0 ? line.qty_milli : null,
          }
        }
        return next
      })
    } else if (hadBudget.current) {
      hadBudget.current = false
      setPicks(() => {
        const next: Record<string, Pick> = {}
        for (const g of groups) {
          for (const item of g.items) {
            next[item.product_id] = {
              selected: item.suggested_qty_milli > 0,
              edited: false,
              on_hand_milli: null,
              qty_milli: item.suggested_qty_milli > 0 ? item.suggested_qty_milli : null,
            }
          }
        }
        return next
      })
    }
  }, [budgetPlan, groups])

  const chosen = (g: Group): { item: ReorderItem; qty_milli: number }[] =>
    g.items.flatMap((item) => {
      const p = picks[item.product_id]
      return p?.selected && p.qty_milli !== null && p.qty_milli > 0
        ? [{ item, qty_milli: p.qty_milli }]
        : []
    })
  const supplierOf = (g: Group): { id: string; name: string } | null =>
    g.supplier ?? assigned[groupKey(g)] ?? null
  const ready = groups.filter((g) => supplierOf(g) && chosen(g).length > 0)

  const createOrders = async (targets: readonly Group[]): Promise<void> => {
    if (!storeId) return
    setCreating(true)
    const done: { id: string; number: string; supplier: string }[] = []
    try {
      for (const g of targets) {
        const supplier = supplierOf(g)
        const items = chosen(g)
        if (!supplier || items.length === 0) continue
        const clientRef = newId()
        const res = await create.mutateAsync({
          body: reorderOrderBody({
            store_id: storeId,
            supplier_id: supplier.id,
            items,
            client_ref: clientRef,
          }),
          idempotencyKey: clientRef,
        })
        done.push({ id: res.data.id, number: res.data.number, supplier: supplier.name })
      }
    } catch (error) {
      notifyPurchasesError(error)
    } finally {
      setCreating(false)
    }
    if (done.length === 0) return
    setCreated(done)
    if (done.length === 1) {
      notify.success(t('reorder.created_one', { number: done[0]!.number, name: done[0]!.supplier }))
      navigate(`/purchases/orders/${done[0]!.id}`)
    } else {
      notify.success(t('reorder.created_many', { count: done.length }))
    }
  }

  const setPick = (productId: string, patch: Partial<Pick>): void =>
    setPicks((p) => ({
      ...p,
      [productId]: {
        ...(p[productId] ?? {
          selected: false,
          qty_milli: null,
          edited: false,
          on_hand_milli: null,
        }),
        ...patch,
      },
    }))

  const onCsv = async (file: File | null): Promise<void> => {
    if (!file || !storeId) return
    try {
      const csv = await file.text()
      const res = await importHistory.mutateAsync({
        body: { store_id: storeId, csv },
        idempotencyKey: newId(),
      })
      notify.success(t('reorder.imported', { count: res.data.imported_rows }))
      if (res.data.skipped_count > 0) {
        notify.warning(t('reorder.import_skipped', { count: res.data.skipped_count }))
      }
    } catch (error) {
      notifyPurchasesError(error)
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">{t('reorder.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('reorder.intro')}</p>
      </div>
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-end">
        <NumberInput
          size="sm"
          className="w-24"
          decimals={0}
          min={1}
          max={365}
          value={leadTime}
          aria-label={t('reorder.lead_time')}
          onChange={(v) => {
            if (v != null && v >= 1) setLeadTime(v)
          }}
        />
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={smartModel ? 'primary' : 'outline'}
            onClick={() => setSmartModel(true)}
          >
            {t('reorder.model_smart')}
          </Button>
          <Button
            size="sm"
            variant={!smartModel && windowDays === 7 ? 'primary' : 'outline'}
            onClick={() => {
              setSmartModel(false)
              setWindowDays(7)
            }}
          >
            {t('reorder.window_7')}
          </Button>
          <Button
            size="sm"
            variant={!smartModel && windowDays === 30 ? 'primary' : 'outline'}
            onClick={() => {
              setSmartModel(false)
              setWindowDays(30)
            }}
          >
            {t('reorder.window_30')}
          </Button>
        </div>
        {smartModel ? null : (
          <Switch
            checked={weekdayAdjust}
            label={t('reorder.weekday')}
            onCheckedChange={setWeekdayAdjust}
          />
        )}
        <NumberInput
          size="sm"
          className="w-28"
          decimals={0}
          min={0}
          max={3650}
          value={shelfLife}
          aria-label={t('reorder.shelf_life')}
          placeholder={t('reorder.shelf_life')}
          onChange={setShelfLife}
        />
        {canWrite ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="text/csv,.csv"
              className="sr-only"
              aria-label={t('reorder.upload')}
              onChange={(e) => {
                void onCsv(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Upload />}
              loading={importHistory.isPending}
              disabled={!storeId}
              onClick={() => fileRef.current?.click()}
            >
              {t('reorder.upload')}
            </Button>
          </>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('reorder.assumptions_lead', { lead: leadTime })}{' '}
        {smartModel
          ? t('reorder.assumptions_smart')
          : t('reorder.assumptions_window', {
              days: windowDays,
              weekday: weekdayAdjust ? t('reorder.assumptions_weekday') : '',
            })}{' '}
        {shelfLife != null
          ? t('reorder.assumptions_shelf', { days: shelfLife })
          : t('reorder.assumptions_shelf_product')}{' '}
        {t('reorder.assumptions_fallback')} {t('reorder.assumptions_import')}{' '}
        {t('reorder.upload_hint')} {t('reorder.shelf_life_hint')} {t('reorder.on_hand_hint')}
      </p>
      {forecast ? (
        <BudgetCard budget={budget} plan={budgetPlan} onChange={setBudget} />
      ) : null}
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        {multiStore ? (
          <StorePicker
            className="lg:w-56"
            aria-label={t('filters.store')}
            value={storeId}
            clearable={false}
            onChange={(id) => setStoreId(id)}
          />
        ) : null}
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder={t('reorder.search_placeholder')}
          aria-label={t('reorder.search_placeholder')}
          wrapperClassName="lg:max-w-xs lg:flex-1"
        />
        {canSuppliers ? (
          <SupplierPicker
            className="lg:w-64"
            aria-label={t('filters.supplier')}
            placeholder={t('filters.any_supplier')}
            showBalance={false}
            value={supplierFilter}
            onChange={(s) => setSupplierFilter(s ? { id: s.id, name: s.name } : null)}
          />
        ) : null}
        {canWrite && ready.length > 1 ? (
          <Button
            className="lg:ms-auto"
            leftIcon={<ClipboardPlus />}
            loading={creating}
            onClick={() => void createOrders(ready)}
          >
            {t('reorder.create_all', { count: ready.length })}
          </Button>
        ) : null}
      </div>

      {created.length > 1 ? (
        <div
          role="status"
          className="rounded-xl border border-success/40 bg-success-soft/40 p-3 text-sm"
        >
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t('reorder.created_many', { count: created.length })}
          </div>
          <ul className="flex flex-wrap gap-2">
            {created.map((c) => (
              <li key={c.id}>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => navigate(`/purchases/orders/${c.id}`)}
                >
                  {c.number} · {c.supplier}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<PackageSearch />}
            title={q || supplierFilter ? t('reorder.none_filtered') : t('reorder.empty_title')}
            description={t('reorder.empty_description')}
          />
        </div>
      ) : (
        groups.map((g) => {
          const key = groupKey(g)
          const supplier = supplierOf(g)
          const items = chosen(g)
          const estimate = items.reduce(
            (s, { item, qty_milli }) =>
              s + mulDiv(item.unit_cost_paise, qty_milli, item.pack_size * 1000),
            0,
          )
          return (
            <Card key={key || 'none'} className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-2/50 p-3">
                <div className="min-w-0">
                  {g.supplier ? (
                    <h3 className="truncate text-base font-semibold">{g.supplier.name}</h3>
                  ) : (
                    <div className="grid gap-1">
                      <h3 className="text-base font-semibold">{t('reorder.no_supplier')}</h3>
                      {canSuppliers ? (
                        <SupplierPicker
                          className="w-full sm:w-72"
                          aria-label={t('reorder.choose_supplier')}
                          placeholder={t('reorder.choose_supplier')}
                          value={assigned[key] ?? null}
                          onChange={(s) =>
                            setAssigned((a) => ({
                              ...a,
                              [key]: s ? { id: s.id, name: s.name } : null,
                            }))
                          }
                        />
                      ) : null}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t('reorder.group_summary', {
                      count: g.items.length,
                      amount: formatMoney(estimate, { decimals: 'auto' }),
                    })}
                  </p>
                </div>
                {canWrite ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<SquarePen />}
                      disabled={items.length === 0}
                      onClick={() =>
                        navigate(
                          `${reorderPrefillPath({
                            store_id: storeId ?? undefined,
                            product_ids: items.map((i) => i.item.product_id),
                          })}${supplier ? `&supplier_id=${supplier.id}` : ''}`,
                        )
                      }
                    >
                      {t('reorder.open_editor')}
                    </Button>
                    <Button
                      size="sm"
                      leftIcon={<ClipboardPlus />}
                      loading={creating}
                      disabled={!supplier || items.length === 0}
                      onClick={() => void createOrders([g])}
                    >
                      {t('reorder.create_po', { count: items.length })}
                    </Button>
                  </div>
                ) : null}
              </div>
              <ul className="divide-y divide-border">
                {g.items.map((item) => (
                  <ReorderRow
                    key={item.product_id}
                    item={item}
                    forecast={forecast}
                    budgetLine={budgetLines.get(item.product_id) ?? null}
                    windowDays={smartModel ? (query.data?.data.window_days ?? windowDays) : windowDays}
                    pick={
                      picks[item.product_id] ?? {
                        selected: false,
                        qty_milli: null,
                        edited: false,
                        on_hand_milli: null,
                      }
                    }
                    disabled={!canWrite || creating}
                    onChange={(patch) => setPick(item.product_id, patch)}
                  />
                ))}
              </ul>
            </Card>
          )
        })
      )}
    </div>
  )
}

function viewedPlan(item: ReorderItem, onHand: number | null) {
  if (onHand == null || onHand === item.usable_stock_milli) return null
  return planStockSense({
    reorder_level_milli: item.reorder_level_milli,
    reorder_qty_milli: item.reorder_qty_milli,
    usable_stock_milli: onHand,
    durable_stock_milli: onHand,
    incoming_milli: item.open_po_qty_milli,
    daily_milli: item.avg_daily_sales_milli,
    demand_milli: item.forecast_demand_milli,
    safety_stock_milli: item.safety_stock_milli,
    lead_time_days: item.lead_time_days,
    shelf_life_days: item.shelf_life_days,
    pack_size: item.pack_size,
    has_history: item.has_sales_history,
    use_forecast: true,
  })
}

function BudgetCard({
  budget,
  plan,
  onChange,
}: {
  budget: number | null
  plan: BudgetPlan | null
  onChange: (paise: number | null) => void
}) {
  const { t } = useTranslation('purchases')
  const leftOut = plan?.lines.filter((l) => l.status === 'left_out').length ?? 0
  const covered = plan ? Math.floor(plan.must_have_covered_bp / 100) : 0
  return (
    <section
      aria-label={t('reorder.budget_title')}
      className="grid gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="flex items-center gap-2 font-semibold">
          <Wallet className="size-5 text-primary" aria-hidden />
          {t('reorder.budget_title')}
        </div>
        <MoneyInput
          size="sm"
          className="w-40"
          value={budget}
          aria-label={t('reorder.budget_title')}
          placeholder={t('reorder.budget_placeholder')}
          onChange={(v) => onChange(v === null || v <= 0 ? null : v)}
        />
        <div className="flex flex-wrap gap-1">
          {BUDGET_PRESETS_PAISE.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={budget === p ? 'primary' : 'outline'}
              onClick={() => onChange(p)}
            >
              {formatMoney(p)}
            </Button>
          ))}
          {budget !== null ? (
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              {t('reorder.budget_clear')}
            </Button>
          ) : null}
        </div>
      </div>
      {plan ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-lg font-semibold">
              {t('reorder.budget_spend', {
                spent: formatMoney(plan.spent_paise),
                budget: formatMoney(plan.budget_paise),
              })}
            </span>
            <span className="text-sm text-muted-foreground">
              {t('reorder.budget_left', { amount: formatMoney(plan.left_paise) })}
            </span>
            <span className="text-sm text-muted-foreground">
              {t('reorder.budget_full', { amount: formatMoney(plan.full_cash_paise) })}
            </span>
          </div>
          <div
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={covered}
            aria-label={t('reorder.budget_covers', { pct: covered })}
          >
            <div
              className={cn('h-full rounded-full', covered >= 100 ? 'bg-success' : 'bg-warning')}
              style={{ width: `${String(Math.min(100, covered))}%` }}
            />
          </div>
          <p className={cn('text-sm', covered >= 100 ? 'text-success' : 'font-medium text-warning')}>
            {t('reorder.budget_covers', { pct: covered })}
            {leftOut > 0 ? ` · ${t('reorder.budget_left_out', { count: leftOut })}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">{t('reorder.budget_note')}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('reorder.budget_hint')}</p>
      )}
    </section>
  )
}

function ReorderRow({
  item,
  forecast,
  budgetLine,
  windowDays,
  pick,
  disabled,
  onChange,
}: {
  item: ReorderItem
  forecast: boolean
  budgetLine: BudgetLine | null
  windowDays: number
  pick: Pick
  disabled: boolean
  onChange: (patch: Partial<Pick>) => void
}) {
  const { t } = useTranslation('purchases')
  const name = localizedName(item.name, item.name_ta)
  const packed = item.pack_size > 1
  const packUnit = packUnitFor(item.unit)
  const qty = (milli: number) => (
    <Qty milli={milli} unit={item.unit} packSize={item.pack_size} packUnit={packUnit} />
  )
  const plan = forecast ? viewedPlan(item, pick.on_hand_milli) : null
  const suggested = plan?.suggested_qty_milli ?? item.suggested_qty_milli
  const priority = plan?.priority ?? item.priority
  const urgency = plan?.stockout_urgency_days ?? item.stockout_urgency_days
  const reason = plan?.reason ?? item.reason
  const daily = milliToDecimalString(item.avg_daily_sales_milli)
  const low = (forecast ? item.usable_stock_milli : item.current_stock_milli) <= 0
  const showExplain = reason !== 'classic'
  return (
    <li
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center',
        !pick.selected && 'opacity-70',
      )}
    >
      <Checkbox
        checked={pick.selected}
        disabled={disabled}
        aria-label={t('reorder.select_item', { name })}
        onCheckedChange={(v) => onChange({ selected: v === true })}
        className="mt-0.5 self-start sm:mt-0 sm:self-center"
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-medium [overflow-wrap:anywhere]">{name}</div>
          <Badge tone={priorityTone[priority]} size="sm">
            {t(`reorder.priority_${priority}`)}
          </Badge>
          {budgetLine ? (
            <Badge tone={budgetTone[budgetLine.status]} size="sm">
              {t(`reorder.budget_status_${budgetLine.status}`)}
            </Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className={low ? 'font-semibold text-danger' : undefined}>
            {t('reorder.stock')}{' '}
            {qty(forecast ? item.usable_stock_milli : item.current_stock_milli)}
          </span>
          <span>
            {t('reorder.daily_sales')} {qty(item.avg_daily_sales_milli)}
          </span>
          <span>{t('reorder.delivery_days', { count: item.lead_time_days })}</span>
          {item.days_of_cover !== null ? (
            <span className={item.days_of_cover <= 3 ? 'font-semibold text-danger' : undefined}>
              {t('reorder.days_cover', { count: item.days_of_cover })}
            </span>
          ) : null}
          {item.last_cost_paise !== null ? (
            <span>{t('orders.last_cost', { amount: formatMoney(item.last_cost_paise) })}</span>
          ) : null}
          {item.last_bill_date ? (
            <span>{t('reorder.last_bought', { date: formatDate(item.last_bill_date) })}</span>
          ) : null}
        </div>
        {item.open_po_qty_milli > 0 ? (
          <Badge tone="info" size="sm" className="mt-1">
            {t('reorder.on_order')} {qty(item.open_po_qty_milli)}
          </Badge>
        ) : null}
        {urgency > 0 ? (
          <p className="mt-1 text-xs font-semibold text-danger">
            {t('reorder.urgency', { count: urgency })}
          </p>
        ) : null}
        {item.forecast_method ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs font-medium text-primary">
            <span>
              {item.forecast_accuracy_bp != null && item.forecast_holdout_days > 0
                ? t('reorder.forecast_line', {
                    method: t(`reorder.method_${item.forecast_method}`),
                    accuracy: Math.round(item.forecast_accuracy_bp / 100),
                    days: item.forecast_holdout_days,
                  })
                : t('reorder.forecast_line_untested', {
                    method: t(`reorder.method_${item.forecast_method}`),
                  })}
            </span>
            {item.safety_stock_milli > 0 ? (
              <span className="text-muted-foreground">
                · {t('reorder.safety_stock', { qty: '' })}{' '}
                {qty(Math.ceil(item.safety_stock_milli / 1000) * 1000)}
              </span>
            ) : null}
          </p>
        ) : null}
        {item.margin_bp != null ? (
          <p className="text-xs text-muted-foreground">
            {t('reorder.margin', { pct: (item.margin_bp / 100).toFixed(1) })}
          </p>
        ) : null}
        {showExplain ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t(`reorder.explain_${reason}`, {
              days: windowDays,
              urgency,
              lead: item.lead_time_days,
              daily,
              shelf: item.shelf_life_days ?? 0,
            })}
          </p>
        ) : null}
      </div>
      <div className="col-start-2 flex items-center justify-end gap-2 sm:col-start-auto">
        <div className="grid gap-0.5">
          <NumberInput
            size="sm"
            className="w-28 text-end"
            decimals={3}
            scale={1000}
            value={packed ? toPackMilli(pick.qty_milli, item.pack_size) : pick.qty_milli}
            disabled={disabled || !pick.selected}
            aria-label={t('reorder.qty_for', { name })}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(v) =>
              onChange({
                qty_milli: packed ? fromPackMilli(v, item.pack_size) : v,
                edited: true,
              })
            }
          />
          {forecast ? (
            <NumberInput
              size="sm"
              className="w-28 text-end"
              decimals={3}
              scale={1000}
              value={pick.on_hand_milli ?? item.usable_stock_milli}
              disabled={disabled}
              aria-label={t('reorder.on_hand', { name })}
              onChange={(v) => {
                const onHand = v ?? 0
                const next = viewedPlan(item, onHand)
                const qtyMilli =
                  next && next.suggested_qty_milli > 0 ? next.suggested_qty_milli : null
                onChange({
                  on_hand_milli: onHand,
                  edited: false,
                  qty_milli: qtyMilli,
                  selected: (qtyMilli ?? 0) > 0,
                })
              }}
            />
          ) : null}
          <span className="text-end text-[11px] text-muted-foreground">
            {t('reorder.suggested')} {qty(suggested)}
          </span>
        </div>
        <Money
          paise={
            pick.qty_milli
              ? mulDiv(item.unit_cost_paise, pick.qty_milli, item.pack_size * 1000)
              : null
          }
          empty="—"
          className="w-24 text-end font-medium"
        />
      </div>
    </li>
  )
}
