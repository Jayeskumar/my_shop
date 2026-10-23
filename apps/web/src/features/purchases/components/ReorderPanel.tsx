/**
 * Reorder suggestions (tab of /purchases/orders): products at / below their reorder level in the
 * store, grouped by the supplier they were last bought from, with stock, average daily sales,
 * days of cover, what is already on order and the suggested quantity. Tick items, adjust the
 * quantities and create one draft purchase order per supplier in one go; products never bought
 * before get a supplier chosen here. "Open in editor" moves a group into the full PO form.
 * A callout links to StockSense (/purchases/stocksense) for forecast-based planning.
 */
import type { ReorderItem, ReorderSuggestions } from '@kadai/shared/api/purchases'
import { reorderPrefillPath } from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'
import { mulDiv } from '@kadai/shared/math'
import { BrainCircuit, CheckCircle2, ClipboardPlus, PackageSearch, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
  NumberInput,
  Qty,
  SearchInput,
  Skeleton,
  notify,
} from '@/components/ui'
import { useCan, useCurrentStore, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useCreateOrder, useReorderSuggestions } from '../api'
import { fromPackMilli, toPackMilli } from '../lib/bill-form'
import { notifyPurchasesError } from '../lib/errors'
import { packUnitFor } from '../lib/labels'
import { reorderOrderBody } from '../lib/order-form'

type Group = ReorderSuggestions['groups'][number]

interface Pick {
  selected: boolean
  qty_milli: number | null
}

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
  const create = useCreateOrder()
  const multiStore = (me?.stores ?? []).filter((s) => s.is_active).length > 1

  const query = useReorderSuggestions(
    storeId
      ? {
          store_id: storeId,
          ...(supplierFilter ? { supplier_id: supplierFilter.id } : {}),
          ...(q ? { q } : {}),
        }
      : null,
  )
  const groups = useMemo(() => query.data?.data.groups ?? [], [query.data])

  // New suggestions: every item with a suggested quantity starts ticked at that quantity.
  useEffect(() => {
    setPicks((prev) => {
      const next: Record<string, Pick> = {}
      for (const g of groups) {
        for (const item of g.items) {
          next[item.product_id] = prev[item.product_id] ?? {
            selected: item.suggested_qty_milli > 0,
            qty_milli: item.suggested_qty_milli > 0 ? item.suggested_qty_milli : null,
          }
        }
      }
      return next
    })
  }, [groups])

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
      [productId]: { ...(p[productId] ?? { selected: false, qty_milli: null }), ...patch },
    }))

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary-soft/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <BrainCircuit className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('stocksense.callout_title')}</p>
            <p className="text-xs text-muted-foreground">{t('stocksense.callout_desc')}</p>
          </div>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => navigate('/purchases/stocksense')}>
          {t('stocksense.callout_action')}
        </Button>
      </div>
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
                    pick={picks[item.product_id] ?? { selected: false, qty_milli: null }}
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

function ReorderRow({
  item,
  pick,
  disabled,
  onChange,
}: {
  item: ReorderItem
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
  const low = item.current_stock_milli <= 0
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
        <div className="font-medium [overflow-wrap:anywhere]">{name}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className={low ? 'font-semibold text-danger' : undefined}>
            {t('reorder.stock')} {qty(item.current_stock_milli)}
          </span>
          <span>
            {t('reorder.level')} {qty(item.reorder_level_milli)}
          </span>
          <span>
            {t('reorder.daily_sales')} {qty(item.avg_daily_sales_milli)}
          </span>
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
            onChange={(v) => onChange({ qty_milli: packed ? fromPackMilli(v, item.pack_size) : v })}
          />
          <span className="text-end text-[11px] text-muted-foreground">
            {t('reorder.suggested')} {qty(item.suggested_qty_milli)}
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
