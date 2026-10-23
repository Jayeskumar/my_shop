/**
 * StockSense reorder plan: the ranked items with a recommended quantity, grouped by the supplier
 * they were last bought from. Ticked rows (urgent / this week / top-up by default) become one
 * draft purchase order per supplier; items never bought get a supplier chosen here or go to the
 * PO editor. Quantities can be changed (in packs for pack-priced items) before creating.
 */
import type { StockSenseItem } from '@kadai/shared/api/purchases'
import { reorderPrefillPath } from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import { mulDiv } from '@kadai/shared/math'
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ClipboardPlus,
  LineChart,
  Minus,
  PackageCheck,
  SquarePen,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { SupplierPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Money,
  NumberInput,
  Qty,
  notify,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useCreateOrder } from '../api'
import { fromPackMilli, toPackMilli } from '../lib/bill-form'
import { notifyPurchasesError } from '../lib/errors'
import { packUnitFor, unitLabel } from '../lib/labels'
import { reorderOrderBody } from '../lib/order-form'
import { PRIORITY_TONE, explainItem, qtyText } from '../lib/stocksense'

interface Pick {
  selected: boolean
  qty_milli: number | null
}

interface Group {
  key: string
  supplier: StockSenseItem['supplier']
  items: StockSenseItem[]
}

export function StockSensePlan({
  storeId,
  items,
  cycleDays,
  safetyDays,
  onDetails,
}: {
  storeId: string
  items: readonly StockSenseItem[]
  cycleDays: number
  safetyDays: number
  onDetails: (productId: string) => void
}) {
  const { t } = useTranslation(['purchases', 'common'])
  const navigate = useNavigate()
  const canWrite = useCan('purchases.write')
  const canSuppliers = useCan('suppliers.read')
  const create = useCreateOrder()
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [assigned, setAssigned] = useState<Record<string, { id: string; name: string } | null>>({})
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ id: string; number: string; supplier: string }[]>([])

  // New plan: keep the owner's edits, tick every recommended item.
  useEffect(() => {
    setPicks((prev) => {
      const next: Record<string, Pick> = {}
      for (const item of items) {
        next[item.product_id] = prev[item.product_id] ?? {
          selected: item.order_qty_milli > 0,
          qty_milli: item.order_qty_milli > 0 ? item.order_qty_milli : null,
        }
      }
      return next
    })
  }, [items])

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>()
    for (const item of items) {
      const key = item.supplier?.id ?? ''
      let g = map.get(key)
      if (!g) {
        g = { key, supplier: item.supplier, items: [] }
        map.set(key, g)
      }
      g.items.push(item)
    }
    // Groups in the order of their most important item; never-purchased last.
    return [...map.values()].sort((a, b) => {
      if (!a.supplier) return 1
      if (!b.supplier) return -1
      return (a.items[0]?.rank ?? 0) - (b.items[0]?.rank ?? 0)
    })
  }, [items])

  const chosen = (g: Group): { item: StockSenseItem; qty_milli: number }[] =>
    g.items.flatMap((item) => {
      const p = picks[item.product_id]
      return p?.selected && p.qty_milli != null && p.qty_milli > 0
        ? [{ item, qty_milli: p.qty_milli }]
        : []
    })
  const supplierOf = (g: Group): { id: string; name: string } | null =>
    g.supplier ? { id: g.supplier.id, name: g.supplier.name } : (assigned[g.key] ?? null)
  const ready = groups.filter((g) => supplierOf(g) && chosen(g).length > 0)
  const missingSupplier = groups
    .filter((g) => !supplierOf(g))
    .reduce((n, g) => n + chosen(g).length, 0)
  const selected = groups.flatMap(chosen)
  const selectedCost = selected.reduce(
    (s, { item, qty_milli }) => s + mulDiv(item.unit_cost_paise, qty_milli, item.pack_size * 1000),
    0,
  )

  const setPick = (productId: string, patch: Partial<Pick>): void =>
    setPicks((p) => ({
      ...p,
      [productId]: { ...(p[productId] ?? { selected: false, qty_milli: null }), ...patch },
    }))

  const createOrders = async (targets: readonly Group[]): Promise<void> => {
    setCreating(true)
    const done: { id: string; number: string; supplier: string }[] = []
    try {
      for (const g of targets) {
        const supplier = supplierOf(g)
        const lines = chosen(g)
        if (!supplier || lines.length === 0) continue
        const clientRef = newId()
        const res = await create.mutateAsync({
          body: reorderOrderBody({
            store_id: storeId,
            supplier_id: supplier.id,
            items: lines,
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
      notify.success(
        t('stocksense.plan.created_one', { number: done[0]!.number, name: done[0]!.supplier }),
      )
      navigate(`/purchases/orders/${done[0]!.id}`)
    } else {
      notify.success(t('stocksense.plan.created_many', { count: done.length }))
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState
          icon={<PackageCheck />}
          title={t('stocksense.plan.empty_title')}
          description={t('stocksense.plan.empty_desc')}
        />
      </div>
    )
  }

  return (
    <div className="grid gap-3 pb-20">
      {created.length > 1 ? (
        <div
          role="status"
          className="rounded-xl border border-success/40 bg-success-soft/40 p-3 text-sm"
        >
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {t('stocksense.plan.created_many', { count: created.length })}
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

      {groups.map((g) => {
        const supplier = supplierOf(g)
        const lines = chosen(g)
        const estimate = lines.reduce(
          (s, { item, qty_milli }) =>
            s + mulDiv(item.unit_cost_paise, qty_milli, item.pack_size * 1000),
          0,
        )
        return (
          <Card key={g.key || 'none'} className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-2/50 p-3">
              <div className="min-w-0">
                {g.supplier ? (
                  <h3 className="truncate text-base font-semibold">{g.supplier.name}</h3>
                ) : (
                  <div className="grid gap-1">
                    <h3 className="text-base font-semibold">{t('stocksense.plan.no_supplier')}</h3>
                    {canSuppliers ? (
                      <SupplierPicker
                        className="w-full sm:w-72"
                        aria-label={t('stocksense.plan.choose_supplier')}
                        placeholder={t('stocksense.plan.choose_supplier')}
                        showBalance={false}
                        value={assigned[g.key] ?? null}
                        onChange={(s) =>
                          setAssigned((a) => ({
                            ...a,
                            [g.key]: s ? { id: s.id, name: s.name } : null,
                          }))
                        }
                      />
                    ) : null}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('stocksense.plan.supplier_group', {
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
                    disabled={lines.length === 0}
                    onClick={() =>
                      navigate(
                        `${reorderPrefillPath({
                          store_id: storeId,
                          product_ids: lines.map((l) => l.item.product_id),
                        })}${supplier ? `&supplier_id=${supplier.id}` : ''}`,
                      )
                    }
                  >
                    {t('stocksense.plan.open_editor')}
                  </Button>
                  <Button
                    size="sm"
                    leftIcon={<ClipboardPlus />}
                    loading={creating}
                    disabled={!supplier || lines.length === 0}
                    onClick={() => void createOrders([g])}
                  >
                    {t('stocksense.plan.create', { count: 1 })}
                  </Button>
                </div>
              ) : null}
            </div>
            <ul className="divide-y divide-border">
              {g.items.map((item) => (
                <PlanRow
                  key={item.product_id}
                  item={item}
                  cycleDays={cycleDays}
                  safetyDays={safetyDays}
                  pick={picks[item.product_id] ?? { selected: false, qty_milli: null }}
                  disabled={!canWrite || creating}
                  onChange={(patch) => setPick(item.product_id, patch)}
                  onDetails={() => onDetails(item.product_id)}
                />
              ))}
            </ul>
          </Card>
        )
      })}

      {canWrite && selected.length > 0 ? (
        <div className="sticky bottom-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface p-3 shadow-overlay">
          <div className="grid text-sm">
            <span className="font-medium">
              {t('stocksense.plan.selected', {
                count: selected.length,
                amount: formatMoney(selectedCost, { decimals: 'auto' }),
              })}
            </span>
            {missingSupplier > 0 ? (
              <span className="text-xs text-warning">
                {t('stocksense.plan.need_supplier', { count: missingSupplier })}
              </span>
            ) : null}
          </div>
          <Button
            leftIcon={<ClipboardPlus />}
            loading={creating}
            disabled={ready.length === 0}
            onClick={() => void createOrders(ready)}
          >
            {t('stocksense.plan.create', { count: ready.length })}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function TrendIcon({ trend }: { trend: StockSenseItem['trend'] }) {
  const { t } = useTranslation('purchases')
  const Icon = trend === 'up' ? ArrowUpRight : trend === 'down' ? ArrowDownRight : Minus
  return (
    <Icon
      className={cn(
        'inline size-3.5',
        trend === 'up'
          ? 'text-success'
          : trend === 'down'
            ? 'text-warning'
            : 'text-muted-foreground',
      )}
      aria-label={t(`stocksense.trend.${trend}`)}
    />
  )
}

/** Key facts of an item (stock, demand, supplier lead time, cover). */
export function ItemFacts({ item }: { item: StockSenseItem }) {
  const { t } = useTranslation('purchases')
  const qty = (milli: number) => (
    <Qty
      milli={milli}
      unit={item.unit}
      packSize={item.pack_size}
      packUnit={packUnitFor(item.unit)}
    />
  )
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <span className={item.usable_milli <= 0 ? 'font-semibold text-danger' : undefined}>
        {t('stocksense.plan.stock')} {qty(item.usable_milli)}
      </span>
      <span title={t(`stocksense.confidence.${item.confidence}`)}>
        {t('stocksense.plan.demand')} {qty(item.daily_milli)} <TrendIcon trend={item.trend} />
        {item.confidence === 'low' || item.confidence === 'none' ? ' *' : ''}
      </span>
      <span>
        {item.supplier ? `${item.supplier.name} · ` : ''}
        {t('stocksense.plan.lead_days', { count: item.lead_time_days })}
        {!item.supplier?.lead_time_days ? ` (${t('stocksense.plan.lead_default')})` : ''}
      </span>
      {item.cover_days != null ? (
        <span className={cn(item.cover_days < item.lead_time_days && 'font-semibold text-danger')}>
          {t('stocksense.plan.cover_days', { count: item.cover_days })}
          {item.stockout_date
            ? ` · ${t('stocksense.plan.runs_out', { date: formatDate(item.stockout_date) })}`
            : ''}
        </span>
      ) : (
        <span>{t('stocksense.plan.cover_none')}</span>
      )}
      {item.incoming_milli > 0 ? (
        <span>{t('stocksense.plan.on_order', { qty: qtyText(item.incoming_milli, item) })}</span>
      ) : null}
    </div>
  )
}

function PlanRow({
  item,
  cycleDays,
  safetyDays,
  pick,
  disabled,
  onChange,
  onDetails,
}: {
  item: StockSenseItem
  cycleDays: number
  safetyDays: number
  pick: Pick
  disabled: boolean
  onChange: (patch: Partial<Pick>) => void
  onDetails: () => void
}) {
  const { t } = useTranslation('purchases')
  const name = localizedName(item.name, item.name_ta)
  const packed = item.pack_size > 1
  const qty = (milli: number) => (
    <Qty
      milli={milli}
      unit={item.unit}
      packSize={item.pack_size}
      packUnit={packUnitFor(item.unit)}
    />
  )
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
        aria-label={t('stocksense.plan.select_item', { name })}
        onCheckedChange={(v) => onChange({ selected: v === true })}
        className="mt-0.5 self-start sm:mt-0 sm:self-center"
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground tabular-nums">
            #{item.rank}
          </span>
          <button
            type="button"
            className="text-start font-medium hover:underline [overflow-wrap:anywhere]"
            onClick={onDetails}
            aria-label={t('stocksense.plan.details_for', { name })}
          >
            {name}
          </button>
          {item.sku ? <span className="text-xs text-muted-foreground">{item.sku}</span> : null}
          <Badge tone={PRIORITY_TONE[item.priority]} size="sm">
            {t(`stocksense.priority.${item.priority}`)}
          </Badge>
          {item.capped_by_shelf_life ? (
            <Badge tone="warning" size="sm">
              {t('stocksense.plan.capped')}
            </Badge>
          ) : null}
        </div>
        <ItemFacts item={item} />
        <p className="mt-1 text-xs">{explainItem(item, cycleDays, safetyDays)}</p>
      </div>
      <div className="col-start-2 flex items-center justify-end gap-2 sm:col-start-auto">
        <div className="grid gap-0.5">
          <NumberInput
            size="sm"
            className="w-32 text-end"
            decimals={3}
            scale={1000}
            suffix={unitLabel(packed ? packUnitFor(item.unit) : item.unit)}
            value={packed ? toPackMilli(pick.qty_milli, item.pack_size) : pick.qty_milli}
            disabled={disabled || !pick.selected}
            aria-label={t('stocksense.plan.qty_for', { name })}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(v) => onChange({ qty_milli: packed ? fromPackMilli(v, item.pack_size) : v })}
          />
          <span className="text-end text-[11px] text-muted-foreground">
            {t('stocksense.plan.order')} {qtyText(item.order_qty_milli, item)}
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
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          aria-label={t('stocksense.plan.details_for', { name })}
          onClick={onDetails}
        >
          <LineChart className="size-4" aria-hidden />
        </Button>
      </div>
    </li>
  )
}
