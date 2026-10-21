/**
 * Purchase bill entry (new bill or a saved draft) — the key screen of the module.
 *
 * Header: supplier (with what the shop owes them and their last bills), supplier invoice no /
 * date, received date, due date (invoice date + supplier terms unless entered), interstate
 * (automatic from supplier vs store state, with override), reverse charge / ITC options. Then
 * the keyboard line grid, other charges / round-off / totals with the GST split, the supplier
 * invoice photo, notes and the warnings.
 *
 * Save draft (Ctrl+S) creates / updates the draft; Post (F10) saves first, then shows the
 * confirmation summary (stock in, payable, price updates) and posts the GRN. F3 jumps to the
 * product search. Unsaved changes are guarded.
 */
import { type PurchaseBillDetail, purchasesRoutes } from '@kadai/shared/api/purchases'
import type { SupplierListItem } from '@kadai/shared/api/parties'
import { DuplicateSupplierInvoiceDetailsSchema } from '@kadai/shared/api/purchases'
import { todayIn } from '@kadai/shared/fy'
import { getState } from '@kadai/shared/gst'
import { newId } from '@kadai/shared/ids'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ClipboardList, Eye, Info, Save, Send, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import { BalanceBadge, StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Checkbox,
  DatePicker,
  EmptyState,
  FormField,
  Input,
  Kbd,
  Money,
  PageHeader,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { isApiError } from '@/lib/api'
import { useCan, useFeature, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { getLanguage, localizedName } from '@/lib/i18n'
import { routeQueryKey } from '@/lib/query'
import { useBreakpoint } from '@/lib/use-media-query'
import { useCreateBill, useDeleteBill, usePostBill, useSupplier, useUpdateBill } from '../api'
import {
  type BillContext,
  type BillDraft,
  type BillErrors,
  type BillHeaderDraft,
  type BillLineDraft,
  type LineField,
  type SupplierLite,
  computeBill,
  draftFromBill,
  effectiveDueDate,
  effectiveInterstate,
  emptyHeader,
  hasErrors,
  isInterstateAuto,
  lineExpiry,
  lineFromProduct,
  lineWarnings,
  mapServerIssue,
  plannedPriceChanges,
  productFromListItem,
  savedRoundOff,
  toCreateBody,
  toUpdateBody,
  validateBill,
} from '../lib/bill-form'
import { errorReason, notifyPurchasesError, validationIssuesOf, validationText } from '../lib/errors'
import { PURCHASES_HOTKEY_SCOPE } from '../lib/labels'
import { useUnsavedGuard } from '../lib/use-unsaved-guard'
import { isSevereWarning, warningText } from '../lib/warnings'
import { AttachmentField } from './AttachmentField'
import { BillLineGrid, type GridColumn, cellId, firstCellOf } from './BillLineGrid'
import { BillTotalsPanel } from './BillTotalsPanel'
import { PostBillDialog, type PostSummary } from './PostBillDialog'
import { ProductAdder, focusAdder } from './ProductAdder'
import { SupplierQuickView } from './SupplierQuickView'

const ADDER_ID = 'bill-add-product'

/** Navigation state: open the post confirmation right after the first save of a new bill. */
interface EditorLocationState {
  openPost?: boolean
}

const FIELD_COLUMN: Record<LineField, GridColumn> = {
  qty: 'qty',
  free: 'free',
  unit_cost: 'unit_cost',
  discount: 'discount',
  batch_no: 'batch_no',
  expiry: 'expiry',
  mrp: 'mrp',
  sale_price: 'sale_price',
}

const PATCH_FIELDS: Partial<Record<keyof BillLineDraft, LineField>> = {
  qty_milli: 'qty',
  free_qty_milli: 'free',
  unit_cost_paise: 'unit_cost',
  discount_bp: 'discount',
  batch_no: 'batch_no',
  expiry_text: 'expiry',
  mrp_paise: 'mrp',
  sale_price_paise: 'sale_price',
}

const HEADER_IDS = {
  supplier: 'bill-supplier',
  store: 'bill-store',
  supplier_invoice_no: 'bill-invoice-no',
  supplier_invoice_date: 'bill-invoice-date',
  received_date: 'bill-received-date',
  due_date: 'bill-due-date',
  round_off: 'bill-round-off',
  lines: ADDER_ID,
} as const

function supplierLite(s: SupplierListItem): SupplierLite & { last_bill_date: string | null; overdue_paise: number } {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    gstin: s.gstin,
    state_code: s.state_code,
    payment_terms_days: s.payment_terms_days,
    balance_paise: s.balance_paise,
    last_bill_date: s.last_bill_date,
    overdue_paise: s.overdue_paise,
  }
}

export interface BillEditorProps {
  /** A saved draft (absent for a new bill). */
  bill?: PurchaseBillDetail
  /** New bill: preselect this supplier (?supplier_id=). */
  initialSupplierId?: string | null
}

export function BillEditor({ bill, initialSupplierId }: BillEditorProps) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const wide = useBreakpoint('lg')
  const batchesFeature = useFeature('batches_expiry')
  const canPay = useCan('payments.pay')
  const tz = me?.tenant.timezone
  const today = todayIn(tz)
  const itcAllowed = (me?.tenant.gst_scheme ?? 'regular') === 'regular'
  const stores = me?.stores ?? []
  const storeState = (id: string | null): string | null =>
    stores.find((s) => s.id === id)?.state_code ?? null

  const [saved, setSaved] = useState<PurchaseBillDetail | undefined>(bill)
  const [draft, setDraft] = useState<BillDraft>(() => {
    if (bill) {
      const d = draftFromBill(bill, { store_state_code: storeState(bill.store_id) })
      const ctx0: BillContext = {
        store_state_code: storeState(bill.store_id),
        itc_allowed: itcAllowed,
        today,
        expiry_warning_days: me?.settings.inventory.expiry_warning_days ?? 90,
      }
      return { ...d, header: { ...d.header, round_off_manual: savedRoundOff(bill, d, ctx0) } }
    }
    const current = stores.find((s) => s.is_active) ?? null
    return {
      header: emptyHeader({ store_id: current?.id ?? null, today, itc_allowed: itcAllowed }),
      lines: [],
    }
  })
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<BillErrors>({ header: {}, lines: {} })
  const [duplicate, setDuplicate] = useState<{ id: string; number: string | null } | null>(null)
  const [clientRef] = useState(() => newId())
  const [postOpen, setPostOpen] = useState(false)
  const [quickView, setQuickView] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [supplierExtra, setSupplierExtra] = useState<{ last_bill_date: string | null; overdue_paise: number } | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const requestFocus = useCallback((id: string) => {
    pendingFocus.current = id
    setFocusTick((n) => n + 1)
  }, [])

  const create = useCreateBill()
  const update = useUpdateBill()
  const post = usePostBill()
  const remove = useDeleteBill()
  const saving = create.isPending || update.isPending
  const { allowLeave } = useUnsavedGuard(dirty && !saving && !post.isPending)

  const ctx = useMemo<BillContext>(
    () => ({
      store_state_code: storeState(draft.header.store_id),
      itc_allowed: itcAllowed,
      today,
      expiry_warning_days: me?.settings.inventory.expiry_warning_days ?? 90,
    }),
    // storeState reads `stores` (from /me)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.header.store_id, stores, itcAllowed, today, me?.settings.inventory.expiry_warning_days],
  )
  const calc = useMemo(() => computeBill(draft, ctx), [draft, ctx])
  const showBatch = batchesFeature || draft.lines.some((l) => l.product.track_batches)
  const { header } = draft

  // ?supplier_id= preselects a supplier on a new bill.
  const initialSupplier = useSupplier(!bill && !header.supplier ? initialSupplierId : null)
  useEffect(() => {
    const s = initialSupplier.data?.data
    if (!s || draft.header.supplier) return
    setDraft((d) => ({ ...d, header: { ...d.header, supplier: supplierLite(s) } }))
    setSupplierExtra({ last_bill_date: s.last_bill_date, overdue_paise: s.overdue_paise })
  }, [initialSupplier.data, draft.header.supplier])

  // Open the post confirmation when arriving from "Post" on a new bill.
  useEffect(() => {
    const state = location.state as EditorLocationState | null
    if (state?.openPost && bill?.status === 'draft') {
      setPostOpen(true)
      navigate(location.pathname, { replace: true, state: null })
    }
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus requests (new rows, first error) run after the picker popover returned focus.
  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    pendingFocus.current = null
    const timer = window.setTimeout(() => {
      const el = document.getElementById(id)
      el?.focus()
      if (el instanceof HTMLInputElement) el.select()
      el?.scrollIntoView?.({ block: 'nearest' })
    }, 40)
    return () => window.clearTimeout(timer)
  }, [focusTick])

  const setHeader = useCallback((patch: Partial<BillHeaderDraft>) => {
    setDraft((d) => ({ ...d, header: { ...d.header, ...patch } }))
    setDirty(true)
    setErrors((e) => {
      const next = { ...e.header }
      for (const k of Object.keys(patch)) {
        if (k === 'supplier') delete next.supplier
        if (k === 'store_id') delete next.store
        if (k === 'supplier_invoice_no') delete next.supplier_invoice_no
        if (k === 'supplier_invoice_date') delete next.supplier_invoice_date
        if (k === 'received_date') delete next.received_date
        if (k === 'due_date' || k === 'due_date_manual') delete next.due_date
        if (k === 'round_off_manual') delete next.round_off
      }
      return { ...e, header: next }
    })
    if ('supplier' in patch || 'supplier_invoice_no' in patch) setDuplicate(null)
  }, [])

  const changeLine = useCallback((key: string, patch: Partial<BillLineDraft>) => {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))
    setDirty(true)
    setErrors((e) => {
      const lineErrors = e.lines[key]
      if (!lineErrors) return e
      const next = { ...lineErrors }
      for (const k of Object.keys(patch) as (keyof BillLineDraft)[]) {
        const field = PATCH_FIELDS[k]
        if (field) delete next[field]
      }
      return { ...e, lines: { ...e.lines, [key]: next } }
    })
  }, [])

  const removeLine = useCallback((key: string) => {
    setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== key) }))
    setDirty(true)
  }, [])

  const addProduct = (product: Parameters<typeof productFromListItem>[0]): void => {
    const existing = draft.lines.find((l) => l.product.id === product.id)
    if (existing && !product.track_batches) {
      notify.info(t('lines.already_added', { name: localizedName(product.name, product.name_ta) }))
      requestFocus(cellId(existing.key, 'qty'))
      return
    }
    const line = lineFromProduct(productFromListItem(product))
    setDraft((d) => ({ ...d, lines: [...d.lines, line] }))
    setDirty(true)
    setErrors((e) => {
      const next = { ...e.header }
      delete next.lines
      return { ...e, header: next }
    })
    requestFocus(firstCellOf(line, batchesFeature || product.track_batches))
  }

  const focusFirstError = (errs: BillErrors): void => {
    const headerOrder = Object.keys(HEADER_IDS) as (keyof typeof HEADER_IDS)[]
    const firstHeader = headerOrder.find((k) => errs.header[k])
    if (firstHeader) {
      if (firstHeader === 'round_off' || firstHeader === 'due_date') setMoreOpen(true)
      requestFocus(HEADER_IDS[firstHeader])
      return
    }
    for (const l of draft.lines) {
      const e = errs.lines[l.key]
      if (!e) continue
      const field = (Object.keys(FIELD_COLUMN) as LineField[]).find((f) => e[f])
      if (field) {
        requestFocus(cellId(l.key, FIELD_COLUMN[field]))
        return
      }
    }
  }

  const storeBill = (next: PurchaseBillDetail): void => {
    queryClient.setQueryData(routeQueryKey(purchasesRoutes.getBill, { params: { id: next.id } }), {
      data: next,
    })
  }

  const handleSaveError = (error: unknown): void => {
    if (isApiError(error) && error.code === 'DUPLICATE') {
      const details = DuplicateSupplierInvoiceDetailsSchema.safeParse(error.details)
      if (details.success) {
        setDuplicate({ id: details.data.existing_bill_id, number: details.data.existing_number })
        setErrors((e) => ({
          ...e,
          header: { ...e.header, supplier_invoice_no: 'duplicate_supplier_invoice' },
        }))
        requestFocus(HEADER_IDS.supplier_invoice_no)
        notify.error(t('errors.duplicate_supplier_invoice'))
        return
      }
    }
    if (isApiError(error) && error.code === 'STALE_WRITE') {
      notify.error(t('editor.stale'), {
        action: { label: t('editor.reload'), onClick: () => window.location.reload() },
      })
      return
    }
    const issues = validationIssuesOf(error)
    if (issues.length) {
      const next: BillErrors = { header: {}, lines: {} }
      let mapped = false
      for (const issue of issues) {
        const target = mapServerIssue(issue.path, draft)
        if (!target) continue
        mapped = true
        if (target.line) {
          next.lines[target.line] = { ...next.lines[target.line], [target.field]: issue.text }
        } else {
          next.header[target.field as keyof BillErrors['header']] = issue.text
        }
      }
      if (mapped) {
        setErrors(next)
        focusFirstError(next)
      }
    }
    notifyPurchasesError(error)
  }

  /** Validates and saves (create or update); resolves with the saved bill or null. */
  const save = async (purpose: 'save' | 'post'): Promise<PurchaseBillDetail | null> => {
    const errs = validateBill(draft, ctx, purpose)
    setErrors(errs)
    if (hasErrors(errs)) {
      focusFirstError(errs)
      notify.error(t('editor.fix_errors'))
      return null
    }
    try {
      if (saved) {
        if (!dirty) return saved
        const res = await update.mutateAsync({
          params: { id: saved.id },
          body: toUpdateBody(draft, ctx, saved),
        })
        setSaved(res.data)
        storeBill(res.data)
        setDirty(false)
        return res.data
      }
      const res = await create.mutateAsync({
        body: toCreateBody(draft, ctx, clientRef),
        idempotencyKey: clientRef,
      })
      storeBill(res.data)
      setDirty(false)
      allowLeave()
      navigate(`/purchases/bills/${res.data.id}`, {
        replace: true,
        state: purpose === 'post' ? ({ openPost: true } satisfies EditorLocationState) : null,
      })
      return res.data
    } catch (error) {
      handleSaveError(error)
      return null
    }
  }

  const saveDraft = async (): Promise<void> => {
    const res = await save('save')
    if (res) notify.success(t('editor.saved'), { description: t('editor.saved_hint') })
  }

  const startPost = async (): Promise<void> => {
    const res = await save('post')
    // A new bill navigates to its page, which opens the confirmation itself.
    if (res && saved) setPostOpen(true)
  }

  const confirmPost = (opts: { update_prices: boolean; allow_past_expiry: boolean }): void => {
    if (!saved) return
    post.mutate(
      {
        params: { id: saved.id },
        body: { if_updated_at: saved.updated_at, ...opts },
      },
      {
        onSuccess: (res) => {
          setPostOpen(false)
          setDirty(false)
          allowLeave()
          storeBill(res.data.bill)
          notify.success(t('post.done', { number: res.data.bill.number ?? '' }), {
            description: t('post.done_detail', {
              stock: res.data.stock_lines,
              prices: res.data.price_updates.length,
            }),
            ...(canPay && res.data.bill.due_paise > 0
              ? {
                  action: {
                    label: t('bill.pay_now'),
                    onClick: () =>
                      navigate(`/purchases/bills/${res.data.bill.id}`, { state: { pay: true } }),
                  },
                }
              : {}),
          })
        },
        onError: (error) => {
          if (errorReason(error) === 'supplier_invoice_no_required') {
            setPostOpen(false)
            setErrors((e) => ({
              ...e,
              header: { ...e.header, supplier_invoice_no: 'supplier_invoice_no_required' },
            }))
          }
          if (isApiError(error) && error.code === 'STALE_WRITE') {
            handleSaveError(error)
            return
          }
          notifyPurchasesError(error)
        },
      },
    )
  }

  const deleteDraft = async (): Promise<void> => {
    if (!saved) return
    const ok = await confirm({
      title: t('editor.delete_title'),
      description: t('editor.delete_description'),
      confirmLabel: t('editor.delete_confirm'),
      tone: 'danger',
    })
    if (!ok) return
    remove.mutate(
      { params: { id: saved.id } },
      {
        onSuccess: () => {
          setDirty(false)
          allowLeave()
          notify.success(t('editor.deleted'))
          navigate('/purchases/bills', { replace: true })
        },
        onError: notifyPurchasesError,
      },
    )
  }

  useHotkeyScope(PURCHASES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'ctrl+s': () => void saveDraft(),
      'F10, ctrl+enter': () => void startPost(),
      F3: () => document.getElementById(ADDER_ID)?.focus(),
    },
    { scope: PURCHASES_HOTKEY_SCOPE, allowInInputs: true, enabled: !saving && !post.isPending },
  )

  // ---- derived display values ----
  const autoInterstate = isInterstateAuto(header.supplier?.state_code ?? null, ctx.store_state_code)
  const interstate = effectiveInterstate(header, ctx)
  const dueDate = effectiveDueDate(header)
  const supplierState = header.supplier?.state_code ? getState(header.supplier.state_code) : undefined
  const stateName = supplierState ? (getLanguage() === 'ta' ? supplierState.name_ta : supplierState.name_en) : null
  const allWarnings = draft.lines.flatMap((l, i) =>
    lineWarnings(l, i, calc, ctx).map((w) => ({ w, line: l, n: i + 1 })),
  )
  const postSummary: PostSummary | null =
    calc.doc && header.supplier
      ? {
          supplier_name: header.supplier.name,
          line_count: draft.lines.length,
          stock_lines: draft.lines.length,
          batch_lines: draft.lines.filter((l) => l.product.track_batches).length,
          payable_paise: header.reverse_charge ? calc.doc.total_paise - calc.doc.tax_paise : calc.doc.total_paise,
          due_date: dueDate,
          price_changes: plannedPriceChanges(draft, calc),
          has_expired: draft.lines.some((l) => {
            const e = lineExpiry(l)
            return e !== null && e < today
          }),
          warning_count: allWarnings.length,
        }
      : null
  const isNew = !saved
  const fromOrder = header.purchase_order

  return (
    <div className="pb-28">
      <PageHeader
        title={isNew ? t('editor.new_title') : t('editor.draft_title')}
        backTo="/purchases/bills"
        meta={
          !isNew ? (
            <Badge tone="neutral" dot>
              {t('status.bill.draft')}
            </Badge>
          ) : null
        }
        description={isNew ? t('editor.new_description') : t('editor.draft_description')}
        actions={
          !isNew ? (
            <Button
              variant="ghost"
              leftIcon={<Trash2 />}
              className="text-danger"
              loading={remove.isPending}
              onClick={() => void deleteDraft()}
            >
              {t('editor.delete')}
            </Button>
          ) : null
        }
      />

      {fromOrder ? (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-info/40 bg-info-soft/40 p-3 text-sm">
          <ClipboardList className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
          <div>
            <div className="font-medium">
              {t('editor.from_order', { number: fromOrder.number })}{' '}
              <Link className="text-primary underline-offset-4 hover:underline" to={`/purchases/orders/${fromOrder.id}`}>
                {t('editor.open_order')}
              </Link>
            </div>
            <div className="text-muted-foreground">{t('editor.from_order_hint')}</div>
          </div>
        </div>
      ) : null}

      {/* ---- header ---- */}
      <section
        aria-label={t('editor.details')}
        className="mb-4 grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-card md:grid-cols-2 xl:grid-cols-4"
      >
        <div className="grid gap-1.5 md:col-span-2">
          <FormField
            label={t('editor.supplier')}
            required
            error={validationText(errors.header.supplier)}
            id={HEADER_IDS.supplier}
          >
            <SupplierPicker
              id={HEADER_IDS.supplier}
              size="lg"
              value={header.supplier}
              disabled={saving || Boolean(fromOrder)}
              onChange={(s) => {
                setHeader({
                  supplier: s ? supplierLite(s) : null,
                  interstate_manual: null,
                })
                setSupplierExtra(s ? { last_bill_date: s.last_bill_date, overdue_paise: s.overdue_paise } : null)
              }}
            />
          </FormField>
          {header.supplier ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <BalanceBadge
                kind="supplier"
                balancePaise={header.supplier.balance_paise}
                overduePaise={supplierExtra?.overdue_paise ?? 0}
              />
              {supplierExtra?.last_bill_date ? (
                <span className="text-muted-foreground">
                  {t('editor.last_bill', { date: formatDate(supplierExtra.last_bill_date) })}
                </span>
              ) : null}
              {header.supplier.payment_terms_days !== null ? (
                <span className="text-muted-foreground">
                  {t('supplier.terms_days', { count: header.supplier.payment_terms_days })}
                </span>
              ) : null}
              <Button variant="link" size="sm" leftIcon={<Eye />} onClick={() => setQuickView(true)}>
                {t('editor.supplier_details')}
              </Button>
            </div>
          ) : null}
        </div>

        <FormField
          label={t('editor.invoice_no')}
          required
          id={HEADER_IDS.supplier_invoice_no}
          error={
            errors.header.supplier_invoice_no === 'duplicate_supplier_invoice'
              ? t('errors.duplicate_supplier_invoice')
              : validationText(errors.header.supplier_invoice_no)
          }
          hint={t('editor.invoice_no_hint')}
        >
          <Input
            size="lg"
            value={header.supplier_invoice_no}
            maxLength={40}
            autoComplete="off"
            disabled={saving}
            onChange={(e) => setHeader({ supplier_invoice_no: e.target.value })}
          />
        </FormField>
        {duplicate ? (
          <div className="-mt-2 text-sm md:col-start-3 xl:col-start-3">
            <Link className="font-medium text-primary underline-offset-4 hover:underline" to={`/purchases/bills/${duplicate.id}`}>
              {t('editor.open_existing', { number: duplicate.number ?? t('bills.draft_number') })}
            </Link>
          </div>
        ) : null}

        <FormField
          label={t('editor.invoice_date')}
          required
          id={HEADER_IDS.supplier_invoice_date}
          error={validationText(errors.header.supplier_invoice_date)}
        >
          <DatePicker
            size="lg"
            value={header.supplier_invoice_date}
            max={today}
            disabled={saving}
            onChange={(v) => setHeader({ supplier_invoice_date: v })}
          />
        </FormField>

        <FormField
          label={t('editor.received_date')}
          id={HEADER_IDS.received_date}
          error={validationText(errors.header.received_date)}
        >
          <DatePicker
            value={header.received_date}
            max={today}
            disabled={saving}
            onChange={(v) => setHeader({ received_date: v })}
          />
        </FormField>

        <FormField
          label={t('editor.due_date')}
          id={HEADER_IDS.due_date}
          error={validationText(errors.header.due_date)}
          hint={
            header.due_date_manual ? (
              <button
                type="button"
                className="text-primary underline-offset-4 hover:underline"
                onClick={() => setHeader({ due_date_manual: false, due_date: null })}
              >
                {t('editor.due_auto_reset')}
              </button>
            ) : header.supplier?.payment_terms_days != null ? (
              t('editor.due_auto', { count: header.supplier.payment_terms_days })
            ) : (
              t('editor.due_none')
            )
          }
        >
          <DatePicker
            value={dueDate}
            min={header.supplier_invoice_date ?? undefined}
            disabled={saving}
            onChange={(v) => setHeader({ due_date: v, due_date_manual: true })}
          />
        </FormField>

        {stores.filter((s) => s.is_active).length > 1 ? (
          <FormField label={t('editor.store')} id={HEADER_IDS.store} error={validationText(errors.header.store)}>
            <StorePicker
              id={HEADER_IDS.store}
              value={header.store_id}
              clearable={false}
              disabled={saving || !isNew}
              onChange={(id) => setHeader({ store_id: id, interstate_manual: null })}
            />
          </FormField>
        ) : null}

        <div className="grid content-start gap-1.5">
          <Switch
            checked={interstate}
            disabled={saving}
            label={t('editor.interstate')}
            description={
              header.interstate_manual === null
                ? stateName
                  ? t(autoInterstate ? 'editor.interstate_auto_yes' : 'editor.interstate_auto_no', {
                      state: stateName,
                    })
                  : t('editor.interstate_auto')
                : t('editor.interstate_manual')
            }
            onCheckedChange={(on) => setHeader({ interstate_manual: on === autoInterstate ? null : on })}
          />
        </div>

        <div className="md:col-span-2 xl:col-span-4">
          <button
            type="button"
            aria-expanded={moreOpen}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => setMoreOpen((o) => !o)}
          >
            {moreOpen ? t('editor.less_options') : t('editor.more_options')}
          </button>
          {moreOpen ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Checkbox
                checked={header.reverse_charge}
                disabled={saving}
                onCheckedChange={(v) => setHeader({ reverse_charge: v === true })}
                label={t('editor.reverse_charge')}
                description={t('editor.reverse_charge_hint')}
              />
              {ctx.itc_allowed ? (
                <Checkbox
                  checked={header.itc_eligible}
                  disabled={saving}
                  onCheckedChange={(v) => setHeader({ itc_eligible: v === true })}
                  label={t('editor.itc')}
                  description={t('editor.itc_hint')}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t('editor.itc_not_allowed')}</p>
              )}
            </div>
          ) : null}
        </div>
      </section>

      {/* ---- lines ---- */}
      <section aria-labelledby="bill-lines-title" className="mb-4 grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="bill-lines-title" className="text-base font-semibold">
            {t('lines.title')}{' '}
            {draft.lines.length > 0 ? (
              <span className="text-sm font-normal text-muted-foreground">({draft.lines.length})</span>
            ) : null}
          </h2>
          <p className="hidden text-xs text-muted-foreground lg:block">
            {t('lines.keyboard_hint')}
          </p>
        </div>
        <BillLineGrid
          lines={draft.lines}
          calc={calc}
          ctx={ctx}
          errors={errors.lines}
          showBatch={showBatch}
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
              title={t('lines.empty_title')}
              description={t('lines.empty_description')}
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
            storeId={header.store_id}
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

      {/* ---- bottom: notes / attachment / warnings | totals ---- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="grid content-start gap-4">
          {allWarnings.length > 0 ? (
            <section
              aria-labelledby="bill-warnings-title"
              className="rounded-xl border border-warning/40 bg-warning-soft/30 p-4"
            >
              <h2 id="bill-warnings-title" className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="size-4 text-warning" aria-hidden />
                {t('editor.warnings_title', { count: allWarnings.length })}
              </h2>
              <ul className="grid gap-1 text-sm">
                {allWarnings.map(({ w, line, n }) => (
                  <li key={`${line.key}-${w.code}`} className={isSevereWarning(w) ? 'text-danger' : undefined}>
                    <span className="font-medium">
                      {n}. {localizedName(line.product.name, line.product.name_ta)}:
                    </span>{' '}
                    {warningText(w)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-card sm:grid-cols-2">
            <FormField label={t('editor.attachment')} hint={t('editor.attachment_hint')}>
              <AttachmentField
                fileId={header.attachment_file_id}
                readOnly={saving}
                onChange={(id) => setHeader({ attachment_file_id: id })}
              />
            </FormField>
            <FormField label={t('editor.notes')} optional>
              <Textarea
                rows={3}
                maxLength={1000}
                value={header.notes}
                disabled={saving}
                placeholder={t('editor.notes_placeholder')}
                onChange={(e) => setHeader({ notes: e.target.value })}
              />
            </FormField>
          </section>
        </div>
        <BillTotalsPanel
          header={header}
          calc={calc}
          lineCount={draft.lines.length}
          disabled={saving}
          roundOffError={validationText(errors.header.round_off)}
          onChange={setHeader}
        />
      </div>

      {/* ---- sticky action bar ---- */}
      <div className="no-print sticky bottom-16 z-30 -mx-4 mt-6 border-t border-border bg-surface/95 px-4 py-3 shadow-raised backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t('totals.payable')}</div>
            <Money paise={calc.doc?.total_paise ?? 0} className="text-xl font-bold" />
            {dirty ? (
              <span className="ms-2 text-xs text-warning">{t('editor.unsaved')}</span>
            ) : null}
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <Button variant="outline" leftIcon={<Save />} loading={saving && !postOpen} onClick={() => void saveDraft()}>
              {t('editor.save_draft')}
              <Kbd combo="ctrl+s" className="ms-1 hidden lg:inline-flex" />
            </Button>
            <Button
              variant="success"
              leftIcon={<Send />}
              disabled={saving}
              onClick={() => void startPost()}
            >
              {t('editor.post')}
              <Kbd
                combo="F10"
                className="ms-1 hidden border-success-foreground/30 bg-success-foreground/15 text-success-foreground lg:inline-flex"
              />
            </Button>
          </div>
        </div>
        {hasErrors(errors) ? (
          <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-danger">
            <Info className="size-4" aria-hidden />
            {t('editor.fix_errors')}
          </p>
        ) : null}
      </div>

      <PostBillDialog
        open={postOpen}
        onOpenChange={setPostOpen}
        summary={postSummary}
        posting={post.isPending}
        onConfirm={confirmPost}
      />
      <SupplierQuickView
        supplierId={header.supplier?.id ?? null}
        fallback={header.supplier ?? undefined}
        open={quickView}
        onOpenChange={setQuickView}
      />
    </div>
  )
}
