/**
 * Purchase-order editor (new order or a draft): supplier, store, order / expected dates, the
 * keyboard line grid (scan or search to add; quantity, rate, GST), notes and terms for the
 * supplier, and the estimated totals. Ctrl+S saves; "Save & send" saves and opens the send
 * dialog on the order page. A new order can come prefilled from reorder suggestions.
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import type { SupplierListItem } from '@kadai/shared/api/parties'
import { type PurchaseOrderDetail, purchasesRoutes } from '@kadai/shared/api/purchases'
import { addDays, todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { useQueryClient } from '@tanstack/react-query'
import { ClipboardList, Info, Save, Send, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { BalanceBadge, StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Button,
  DatePicker,
  EmptyState,
  FormField,
  Kbd,
  Money,
  PageHeader,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { isApiError } from '@/lib/api'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { localizedName } from '@/lib/i18n'
import { routeQueryKey } from '@/lib/query'
import { useBreakpoint } from '@/lib/use-media-query'
import { useCreateOrder, useUpdateOrder } from '../api'
import { notifyPurchasesError, validationIssuesOf, validationText } from '../lib/errors'
import { PURCHASES_HOTKEY_SCOPE } from '../lib/labels'
import {
  type OrderDraft,
  type OrderErrors,
  type OrderLineDraft,
  computeOrder,
  draftFromOrder,
  emptyOrder,
  hasOrderErrors,
  orderLineFromProduct,
  orderProductFromListItem,
  toOrderCreateBody,
  toOrderUpdateBody,
  validateOrder,
} from '../lib/order-form'
import { useUnsavedGuard } from '../lib/use-unsaved-guard'
import { orderCellId } from '../lib/grid'
import { OrderLineGrid } from './OrderLineGrid'
import { ProductAdder } from './ProductAdder'

const ADDER_ID = 'po-add-product'
const HEADER_IDS = {
  supplier: 'po-supplier',
  store: 'po-store',
  order_date: 'po-order-date',
  expected_date: 'po-expected-date',
  lines: ADDER_ID,
} as const

/** Navigation state of the order page: open the send dialog right after "Save & send". */
export interface OrderLocationState {
  send?: boolean
}

export interface OrderEditorProps {
  /** A saved draft (absent for a new order). */
  order?: PurchaseOrderDetail
  /** New order: prefilled draft (reorder suggestions / ?supplier_id=). */
  initial?: Partial<OrderDraft>
  /** Shown above the form for prefilled orders. */
  prefillNote?: string | null
  /** Saved draft: leave the editor (back to the order detail). */
  onDone?: (order: PurchaseOrderDetail) => void
}

export function OrderEditor({ order, initial, prefillNote, onDone }: OrderEditorProps) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const wide = useBreakpoint('lg')
  const today = todayIn(me?.tenant.timezone)
  const stores = me?.stores ?? []
  const [draft, setDraft] = useState<OrderDraft>(() => {
    if (order) return draftFromOrder(order)
    const current = stores.find((s) => s.is_active) ?? null
    return { ...emptyOrder({ store_id: current?.id ?? null, today }), ...initial }
  })
  const [dirty, setDirty] = useState(Boolean(initial?.lines?.length))
  const [errors, setErrors] = useState<OrderErrors>({ header: {}, lines: {} })
  const [clientRef] = useState(() => newId())
  const [supplierExtra, setSupplierExtra] = useState<{ balance: number; overdue: number } | null>(
    null,
  )
  const pendingFocus = useRef<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const requestFocus = useCallback((id: string) => {
    pendingFocus.current = id
    setFocusTick((n) => n + 1)
  }, [])
  const create = useCreateOrder()
  const update = useUpdateOrder()
  const saving = create.isPending || update.isPending
  const { allowLeave } = useUnsavedGuard(dirty && !saving)

  // A prefilled draft (reorder) may arrive after the first render.
  const initialLines = initial?.lines
  const initialSupplier = initial?.supplier
  useEffect(() => {
    if (order || !initialLines?.length) return
    setDraft((d) =>
      d.lines.length
        ? d
        : { ...d, lines: initialLines, supplier: d.supplier ?? initialSupplier ?? null },
    )
    setDirty(true)
  }, [order, initialLines, initialSupplier])
  useEffect(() => {
    if (order || !initialSupplier) return
    setDraft((d) => (d.supplier ? d : { ...d, supplier: initialSupplier }))
  }, [order, initialSupplier])

  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    pendingFocus.current = null
    const timer = window.setTimeout(() => {
      const el = document.getElementById(id)
      el?.focus()
      if (el instanceof HTMLInputElement) el.select()
    }, 40)
    return () => window.clearTimeout(timer)
  }, [focusTick])

  const storeState = stores.find((s) => s.id === draft.store_id)?.state_code ?? null
  const totals = useMemo(() => computeOrder(draft, storeState), [draft, storeState])

  const patch = (p: Partial<OrderDraft>): void => {
    setDraft((d) => ({ ...d, ...p }))
    setDirty(true)
    setErrors((e) => {
      const header = { ...e.header }
      if ('supplier' in p) delete header.supplier
      if ('store_id' in p) delete header.store
      if ('order_date' in p) delete header.order_date
      if ('expected_date' in p || 'order_date' in p) delete header.expected_date
      return { ...e, header }
    })
  }

  const changeLine = useCallback((key: string, p: Partial<OrderLineDraft>) => {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) }))
    setDirty(true)
    setErrors((e) => {
      if (!e.lines[key]) return e
      const lines = { ...e.lines }
      delete lines[key]
      return { ...e, lines }
    })
  }, [])

  const removeLine = useCallback((key: string) => {
    setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== key) }))
    setDirty(true)
  }, [])

  const addProduct = (p: ProductListItem): void => {
    const existing = draft.lines.find((l) => l.product.id === p.id)
    if (existing) {
      notify.info(t('lines.already_added', { name: localizedName(p.name, p.name_ta) }))
      requestFocus(orderCellId(existing.key, 'qty'))
      return
    }
    const line = orderLineFromProduct(orderProductFromListItem(p))
    setDraft((d) => ({ ...d, lines: [...d.lines, line] }))
    setDirty(true)
    setErrors((e) => {
      const header = { ...e.header }
      delete header.lines
      return { ...e, header }
    })
    requestFocus(orderCellId(line.key, 'qty'))
  }

  const focusFirstError = (errs: OrderErrors): void => {
    const first = (Object.keys(HEADER_IDS) as (keyof typeof HEADER_IDS)[]).find(
      (k) => errs.header[k],
    )
    if (first) {
      requestFocus(HEADER_IDS[first])
      return
    }
    const line = draft.lines.find((l) => errs.lines[l.key])
    if (line) requestFocus(orderCellId(line.key, 'qty'))
  }

  const save = async (send: boolean): Promise<void> => {
    const errs = validateOrder(draft)
    setErrors(errs)
    if (hasOrderErrors(errs)) {
      focusFirstError(errs)
      notify.error(t('editor.fix_errors'))
      return
    }
    try {
      const res = order
        ? await update.mutateAsync({
            params: { id: order.id },
            body: toOrderUpdateBody(draft, order),
          })
        : await create.mutateAsync({
            body: toOrderCreateBody(draft, clientRef),
            idempotencyKey: clientRef,
          })
      queryClient.setQueryData(
        routeQueryKey(purchasesRoutes.getOrder, { params: { id: res.data.id } }),
        {
          data: res.data,
        },
      )
      setDirty(false)
      allowLeave()
      notify.success(order ? t('orders.saved') : t('orders.created', { number: res.data.number }))
      if (order && onDone && !send) {
        onDone(res.data)
        return
      }
      navigate(`/purchases/orders/${res.data.id}`, {
        replace: !order,
        state: send ? ({ send: true } satisfies OrderLocationState) : null,
      })
      if (order && onDone) onDone(res.data)
    } catch (error) {
      if (isApiError(error) && error.code === 'STALE_WRITE') {
        notify.error(t('editor.stale'), {
          action: { label: t('editor.reload'), onClick: () => window.location.reload() },
        })
        return
      }
      const issues = validationIssuesOf(error)
      const header: OrderErrors['header'] = {}
      for (const issue of issues) {
        const root = issue.path.split('.')[0]
        if (root === 'supplier_id') header.supplier = issue.text
        if (root === 'expected_date') header.expected_date = issue.text
        if (root === 'lines') header.lines = issue.text
      }
      if (Object.keys(header).length) setErrors({ header, lines: {} })
      notifyPurchasesError(error)
    }
  }

  useHotkeyScope(PURCHASES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'ctrl+s': () => void save(false),
      F3: () => document.getElementById(ADDER_ID)?.focus(),
    },
    { scope: PURCHASES_HOTKEY_SCOPE, allowInInputs: true, enabled: !saving },
  )

  const multiStore = stores.filter((s) => s.is_active).length > 1
  const headerError = (k: keyof OrderErrors['header']): string | undefined =>
    validationText(errors.header[k])

  return (
    <div className="pb-28">
      <PageHeader
        title={order ? t('orders.edit_title', { number: order.number }) : t('orders.new_title')}
        description={t('orders.editor_description')}
        backTo={order ? `/purchases/orders/${order.id}` : '/purchases/orders'}
      />

      {prefillNote ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-3 rounded-xl border border-info/40 bg-info-soft/40 p-3 text-sm"
        >
          <Sparkles className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
          <span>{prefillNote}</span>
        </div>
      ) : null}

      <section
        aria-label={t('editor.details')}
        className="mb-4 grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-card md:grid-cols-2 xl:grid-cols-4"
      >
        <div className="grid gap-1.5 md:col-span-2">
          <FormField
            label={t('editor.supplier')}
            required
            id={HEADER_IDS.supplier}
            error={headerError('supplier')}
          >
            <SupplierPicker
              id={HEADER_IDS.supplier}
              size="lg"
              value={draft.supplier}
              disabled={saving}
              onChange={(s: SupplierListItem | null) => {
                patch({
                  supplier: s
                    ? { id: s.id, name: s.name, phone: s.phone, state_code: s.state_code }
                    : null,
                })
                setSupplierExtra(s ? { balance: s.balance_paise, overdue: s.overdue_paise } : null)
              }}
            />
          </FormField>
          {supplierExtra ? (
            <BalanceBadge
              kind="supplier"
              balancePaise={supplierExtra.balance}
              overduePaise={supplierExtra.overdue}
            />
          ) : null}
        </div>
        <FormField
          label={t('orders.order_date')}
          required
          id={HEADER_IDS.order_date}
          error={headerError('order_date')}
        >
          <DatePicker
            value={draft.order_date}
            max={today}
            disabled={saving}
            onChange={(v) => patch({ order_date: v })}
          />
        </FormField>
        <FormField
          label={t('orders.expected_date')}
          optional
          id={HEADER_IDS.expected_date}
          error={headerError('expected_date')}
          hint={
            <span className="flex flex-wrap gap-2">
              {[1, 3, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => patch({ expected_date: addDays(draft.order_date ?? today, d) })}
                >
                  {t('orders.in_days', { count: d })}
                </button>
              ))}
            </span>
          }
        >
          <DatePicker
            value={draft.expected_date}
            min={draft.order_date ?? undefined}
            disabled={saving}
            onChange={(v) => patch({ expected_date: v })}
          />
        </FormField>
        {multiStore ? (
          <FormField label={t('editor.store')} id={HEADER_IDS.store} error={headerError('store')}>
            <StorePicker
              id={HEADER_IDS.store}
              value={draft.store_id}
              clearable={false}
              disabled={saving || Boolean(order)}
              onChange={(id) => patch({ store_id: id })}
            />
          </FormField>
        ) : null}
      </section>

      <section
        aria-labelledby="po-lines-title"
        className="mb-4 grid grid-cols-[minmax(0,1fr)] gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="po-lines-title" className="text-base font-semibold">
            {t('lines.title')}{' '}
            {draft.lines.length > 0 ? (
              <span className="text-sm font-normal text-muted-foreground">
                ({draft.lines.length})
              </span>
            ) : null}
          </h2>
          <p className="hidden text-xs text-muted-foreground lg:block">
            {t('orders.keyboard_hint')}
          </p>
        </div>
        <OrderLineGrid
          lines={draft.lines}
          totals={totals}
          errors={errors.lines}
          layout={wide ? 'table' : 'cards'}
          adderId={ADDER_ID}
          disabled={saving}
          onChange={changeLine}
          onRemove={removeLine}
        />
        {draft.lines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface">
            <EmptyState
              compact
              icon={<ClipboardList />}
              title={t('orders.lines_empty_title')}
              description={t('orders.lines_empty_description')}
            />
          </div>
        ) : null}
        <div
          className={cn(
            'rounded-xl border bg-surface p-3',
            errors.header.lines ? 'border-danger' : 'border-border',
          )}
        >
          <ProductAdder
            id={ADDER_ID}
            hotkey="F3"
            storeId={draft.store_id}
            disabled={saving}
            onPick={addProduct}
          />
          {errors.header.lines ? (
            <p role="alert" className="mt-1 text-sm font-medium text-danger">
              {t('lines.need_one')}
            </p>
          ) : null}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <section className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-card sm:grid-cols-2">
          <FormField label={t('orders.notes')} optional hint={t('orders.notes_hint')}>
            <Textarea
              rows={3}
              maxLength={1000}
              value={draft.notes}
              disabled={saving}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </FormField>
          <FormField label={t('orders.terms')} optional hint={t('orders.terms_hint')}>
            <Textarea
              rows={3}
              maxLength={2000}
              value={draft.terms}
              disabled={saving}
              placeholder={t('orders.terms_placeholder')}
              onChange={(e) => patch({ terms: e.target.value })}
            />
          </FormField>
        </section>
        <section
          aria-labelledby="po-totals"
          className="rounded-xl border border-border bg-surface p-4 shadow-card"
        >
          <h2 id="po-totals" className="mb-2 text-base font-semibold">
            {t('orders.estimate')}
          </h2>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('totals.taxable')}</dt>
            <dd className="text-end">
              <Money paise={totals.taxable_paise} />
            </dd>
            <dt className="text-muted-foreground">
              {totals.is_interstate ? t('totals.igst') : t('orders.gst_total')}
            </dt>
            <dd className="text-end">
              <Money paise={totals.tax_paise} />
            </dd>
            <dt className="border-t border-border pt-2 text-base font-bold">{t('totals.total')}</dt>
            <dd className="border-t border-border pt-2 text-end text-base font-bold">
              <Money paise={totals.total_paise} />
            </dd>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">{t('orders.estimate_hint')}</p>
        </section>
      </div>

      <div className="no-print sticky bottom-16 z-30 -mx-4 mt-6 border-t border-border bg-surface/95 px-4 py-3 shadow-raised backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t('orders.estimate')}</div>
            <Money paise={totals.total_paise} className="text-xl font-bold" />
            {dirty ? (
              <span className="ms-2 text-xs text-warning">{t('editor.unsaved')}</span>
            ) : null}
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            {order && onDone ? (
              <Button variant="ghost" disabled={saving} onClick={() => onDone(order)}>
                {t('common:actions.cancel')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              leftIcon={<Save />}
              loading={saving}
              onClick={() => void save(false)}
            >
              {t('orders.save')}
              <Kbd combo="ctrl+s" className="ms-1 hidden lg:inline-flex" />
            </Button>
            <Button leftIcon={<Send />} disabled={saving} onClick={() => void save(true)}>
              {t('orders.save_send')}
            </Button>
          </div>
        </div>
        {hasOrderErrors(errors) ? (
          <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-danger">
            <Info className="size-4" aria-hidden />
            {t('editor.fix_errors')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
