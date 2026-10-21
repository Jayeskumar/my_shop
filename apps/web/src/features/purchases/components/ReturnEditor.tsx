/**
 * Purchase return / debit note editor.
 *
 *  - Against a bill: the bill's lines with what can still be returned (charged + free − already
 *    returned) and today's stock; type the quantity going back ("All" fills the rest). Amounts are
 *    pro-rata of the bill line, exactly as the server computes them.
 *  - Without a bill (expiry / damaged stock, prefilled from the batches page): supplier, then
 *    product + batch lines at the batch's landed cost.
 *
 * Reason, settlement (reduce what the shop owes the supplier, or a cash / bank refund) and notes;
 * saving asks for a confirmation (stock goes out, the supplier's balance changes) and creates the
 * numbered debit note.
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import type { DebitNoteDetail } from '@kadai/shared/api/purchases'
import { DebitNoteReasonSchema, type DebitNoteSettlement } from '@kadai/shared'
import { todayIn } from '@kadai/shared/fy'
import { GST_RATES_BP } from '@kadai/shared/gst'
import { newId } from '@kadai/shared/ids'
import { isDecimalUnit } from '@kadai/shared/units'
import { Info, Save, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { AccountPicker, BatchPicker, StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Button,
  DatePicker,
  FormField,
  IconButton,
  Input,
  Money,
  MoneyInput,
  NumberInput,
  PageHeader,
  Qty,
  RadioGroup,
  Select,
  fieldVariants,
  notify,
  useConfirm,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatBp, formatDate, formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useBreakpoint } from '@/lib/use-media-query'
import { useCreateDebitNote } from '../api'
import { fromPackMilli, toPackMilli } from '../lib/bill-form'
import { errorReason, notifyPurchasesError, validationText } from '../lib/errors'
import { packUnitFor, unitLabel } from '../lib/labels'
import {
  type BillReturnLineDraft,
  type FreeReturnLineDraft,
  QTY_ABOVE_RETURNABLE,
  type ReturnDraft,
  type ReturnErrors,
  type ReturnHeaderDraft,
  computeReturn,
  freeLineFromProduct,
  hasReturnErrors,
  returnInterstate,
  toDebitNoteBody,
  validateReturn,
} from '../lib/return-form'
import { ProductAdder } from './ProductAdder'
import { TaxBreakupTable, TotalRow } from './TaxBreakup'

const ADDER_ID = 'dn-add-product'
const SETTLEMENTS: readonly DebitNoteSettlement[] = ['adjust_due', 'refund_cash', 'refund_bank']

export interface ReturnEditorProps {
  initial: ReturnDraft
  /** Shown above the form (where the lines came from). */
  sourceNote?: ReactNode
}

export function ReturnEditor({ initial, sourceNote }: ReturnEditorProps) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const wide = useBreakpoint('lg')
  const today = todayIn(me?.tenant.timezone)
  const [draft, setDraft] = useState<ReturnDraft>(initial)
  const [errors, setErrors] = useState<ReturnErrors>({ header: {}, lines: {} })
  const [clientRef] = useState(() => newId())
  const create = useCreateDebitNote()
  const stores = me?.stores ?? []
  const storeState = stores.find((s) => s.id === draft.header.store_id)?.state_code ?? null
  const interstate = returnInterstate(draft, draft.header.supplier?.state_code ?? null, storeState)
  const totals = useMemo(() => computeReturn(draft, interstate), [draft, interstate])
  const { header } = draft

  const setHeader = (patch: Partial<ReturnHeaderDraft>): void => {
    setDraft((d) => ({ ...d, header: { ...d.header, ...patch } }) as ReturnDraft)
    setErrors((e) => {
      const h = { ...e.header }
      if ('supplier' in patch) delete h.supplier
      if ('store_id' in patch) delete h.store
      if ('note_date' in patch) delete h.note_date
      if ('account_id' in patch || 'settlement' in patch) delete h.account
      return { ...e, header: h }
    })
  }

  const clearLineError = (key: string): void =>
    setErrors((e) => {
      if (!e.lines[key] && !e.header.lines) return e
      const lines = { ...e.lines }
      delete lines[key]
      const h = { ...e.header }
      delete h.lines
      return { header: h, lines }
    })

  const setBillQty = useCallback((billLineId: string, qty: number | null) => {
    setDraft((d) =>
      d.mode === 'bill'
        ? {
            ...d,
            lines: d.lines.map((l) =>
              l.line.bill_line_id === billLineId ? { ...l, qty_milli: qty } : l,
            ),
          }
        : d,
    )
    clearLineError(billLineId)
  }, [])

  const changeFree = useCallback((key: string, patch: Partial<FreeReturnLineDraft>) => {
    setDraft((d) =>
      d.mode === 'free'
        ? { ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }
        : d,
    )
    clearLineError(key)
  }, [])

  const removeFree = (key: string): void =>
    setDraft((d) => (d.mode === 'free' ? { ...d, lines: d.lines.filter((l) => l.key !== key) } : d))

  const addProduct = (p: ProductListItem): void => {
    if (draft.mode !== 'free') return
    if (!p.track_batches && draft.lines.some((l) => l.product.id === p.id)) {
      notify.info(t('lines.already_added', { name: localizedName(p.name, p.name_ta) }))
      return
    }
    const line = freeLineFromProduct({
      id: p.id,
      name: p.name,
      name_ta: p.name_ta,
      sku: p.sku,
      unit: p.unit,
      pack_size: p.pack_size,
      track_batches: p.track_batches,
      gst_rate_bp: p.gst_rate_bp,
      purchase_price_paise: p.purchase_price_paise,
      stock_qty_milli: p.stock_qty_milli,
    })
    setDraft((d) => (d.mode === 'free' ? { ...d, lines: [...d.lines, line] } : d))
    clearLineError(line.key)
  }

  const submit = async (): Promise<void> => {
    const errs = validateReturn(draft, today)
    setErrors(errs)
    if (hasReturnErrors(errs)) {
      notify.error(t('editor.fix_errors'))
      return
    }
    const ok = await confirm({
      title: t('returns.confirm_title', { amount: formatMoney(totals.total_paise) }),
      description: t(`returns.confirm_${header.settlement}`, {
        count: totals.line_count,
        name: header.supplier?.name ?? '',
        amount: formatMoney(totals.total_paise),
      }),
      confirmLabel: t('returns.confirm'),
    })
    if (!ok) return
    create.mutate(
      {
        body: toDebitNoteBody(draft, { client_ref: clientRef, interstate }),
        idempotencyKey: clientRef,
      },
      {
        onSuccess: (res: { data: DebitNoteDetail }) => {
          notify.success(t('returns.created', { number: res.data.number }), {
            description: t('returns.created_hint'),
          })
          navigate(`/purchases/returns/${res.data.id}`, { replace: true, state: { print: true } })
        },
        onError: (error) => {
          if (errorReason(error) === 'refund_account_invalid') {
            setErrors((e) => ({ ...e, header: { ...e.header, account: 'refund_account_invalid' } }))
          }
          notifyPurchasesError(error)
        },
      },
    )
  }

  const reasonOptions = DebitNoteReasonSchema.options.map((r) => ({
    value: r,
    label: t(`reasons.${r}`),
  }))
  const settlementOptions = SETTLEMENTS.map((s) => ({
    value: s,
    label: t(`settlement.${s}`),
    description: t(`settlement.${s}_hint`),
  }))
  const multiStore = stores.filter((s) => s.is_active).length > 1
  const saving = create.isPending

  return (
    <div className="pb-28">
      <PageHeader
        title={t('returns.new_title')}
        description={
          draft.mode === 'bill'
            ? t('returns.against_bill', {
                number: draft.bill.number ?? '',
                no: draft.bill.supplier_invoice_no,
                date: formatDate(draft.bill.received_date),
              })
            : t('returns.free_form_description')
        }
        backTo="/purchases/returns"
      />
      {sourceNote ? (
        <div
          role="status"
          className="mb-4 flex items-start gap-3 rounded-xl border border-info/40 bg-info-soft/40 p-3 text-sm"
        >
          <Info className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
          <div>{sourceNote}</div>
        </div>
      ) : null}

      <section
        aria-label={t('editor.details')}
        className="mb-4 grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-card md:grid-cols-2 xl:grid-cols-4"
      >
        <div className="md:col-span-2">
          {draft.mode === 'bill' ? (
            <div>
              <div className="text-sm font-medium">{t('editor.supplier')}</div>
              <div className="mt-1 text-base font-semibold">{draft.bill.supplier_name}</div>
              <div className="text-xs text-muted-foreground">
                {t('returns.bill_due', { amount: formatMoney(Math.max(0, draft.bill.due_paise)) })}
              </div>
            </div>
          ) : (
            <FormField
              label={t('editor.supplier')}
              required
              error={validationText(errors.header.supplier)}
            >
              <SupplierPicker
                size="lg"
                value={header.supplier}
                disabled={saving}
                onChange={(s) =>
                  setHeader({
                    supplier: s ? { id: s.id, name: s.name, state_code: s.state_code } : null,
                  })
                }
              />
            </FormField>
          )}
        </div>
        <FormField
          label={t('returns.note_date')}
          required
          error={validationText(errors.header.note_date)}
        >
          <DatePicker
            value={header.note_date}
            max={today}
            disabled={saving}
            onChange={(v) => setHeader({ note_date: v })}
          />
        </FormField>
        <FormField label={t('returns.reason')} required>
          <Select
            value={header.reason}
            options={reasonOptions}
            disabled={saving}
            onValueChange={(v) => setHeader({ reason: v })}
          />
        </FormField>
        {draft.mode === 'free' && multiStore ? (
          <FormField label={t('editor.store')} error={validationText(errors.header.store)}>
            <StorePicker
              value={header.store_id}
              clearable={false}
              disabled={saving || draft.lines.length > 0}
              onChange={(id) => setHeader({ store_id: id })}
            />
          </FormField>
        ) : null}
      </section>

      <section aria-labelledby="dn-lines" className="mb-4 grid grid-cols-[minmax(0,1fr)] gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="dn-lines" className="text-base font-semibold">
            {draft.mode === 'bill' ? t('returns.choose_lines') : t('lines.title')}
          </h2>
          {draft.mode === 'bill' ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() =>
                  setDraft((d) =>
                    d.mode === 'bill'
                      ? {
                          ...d,
                          lines: d.lines.map((l) => ({
                            ...l,
                            qty_milli:
                              l.line.returnable_qty_milli > 0 ? l.line.returnable_qty_milli : null,
                          })),
                        }
                      : d,
                  )
                }
              >
                {t('returns.return_all')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() =>
                  setDraft((d) =>
                    d.mode === 'bill'
                      ? { ...d, lines: d.lines.map((l) => ({ ...l, qty_milli: null })) }
                      : d,
                  )
                }
              >
                {t('common:actions.clear')}
              </Button>
            </div>
          ) : null}
        </div>
        {draft.mode === 'bill' ? (
          <ul
            className="grid grid-cols-[minmax(0,1fr)] gap-2"
            aria-label={t('returns.choose_lines')}
          >
            {draft.lines.map((l) => (
              <BillReturnRow
                key={l.line.bill_line_id}
                draft={l}
                amount={totals.byKey.get(l.line.bill_line_id)?.total_paise ?? null}
                error={errors.lines[l.line.bill_line_id]?.qty}
                disabled={saving}
                onQty={(v) => setBillQty(l.line.bill_line_id, v)}
              />
            ))}
          </ul>
        ) : (
          <>
            {draft.lines.length > 0 ? (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label={t('lines.title')}>
                {draft.lines.map((l) => (
                  <FreeReturnRow
                    key={l.key}
                    line={l}
                    storeId={header.store_id}
                    amount={totals.byKey.get(l.key)?.total_paise ?? null}
                    errors={errors.lines[l.key] ?? {}}
                    compact={!wide}
                    disabled={saving}
                    onChange={(patch) => changeFree(l.key, patch)}
                    onRemove={() => removeFree(l.key)}
                  />
                ))}
              </ul>
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
            </div>
          </>
        )}
        {errors.header.lines ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {draft.mode === 'bill' ? t('returns.need_qty') : t('lines.need_one')}
          </p>
        ) : null}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <section className="grid content-start gap-4 rounded-xl border border-border bg-surface p-4 shadow-card">
          <FormField label={t('returns.settlement')}>
            <RadioGroup
              value={header.settlement}
              onValueChange={(v) => setHeader({ settlement: v })}
              options={settlementOptions}
              variant="cards"
              aria-label={t('returns.settlement')}
            />
          </FormField>
          {header.settlement === 'refund_bank' ? (
            <FormField
              label={t('returns.refund_account')}
              optional
              hint={t('returns.refund_account_hint')}
              error={errors.header.account ? t('errors.refund_account_invalid') : undefined}
            >
              <AccountPicker
                money="bank"
                storeId={header.store_id}
                value={header.account_id}
                onChange={(id) => setHeader({ account_id: id })}
              />
            </FormField>
          ) : null}
          {header.settlement !== 'adjust_due' ? (
            <FormField
              label={t('returns.refund_reference')}
              optional
              hint={t('returns.refund_reference_hint')}
            >
              <Input
                value={header.refund_reference}
                maxLength={100}
                onChange={(e) => setHeader({ refund_reference: e.target.value })}
              />
            </FormField>
          ) : null}
          <FormField label={t('editor.notes')} optional>
            <Textarea
              rows={2}
              maxLength={1000}
              value={header.notes}
              placeholder={t('returns.notes_placeholder')}
              onChange={(e) => setHeader({ notes: e.target.value })}
            />
          </FormField>
        </section>
        <section
          aria-labelledby="dn-totals"
          className="rounded-xl border border-border bg-surface p-4 shadow-card"
        >
          <h2 id="dn-totals" className="mb-2 text-base font-semibold">
            {t('totals.title')}
          </h2>
          <div className="text-sm">
            <TotalRow label={t('totals.taxable')} paise={totals.taxable_paise} />
            {interstate ? (
              <TotalRow label={t('totals.igst')} paise={totals.igst_paise} />
            ) : (
              <>
                <TotalRow label={t('totals.cgst')} paise={totals.cgst_paise} />
                <TotalRow label={t('totals.sgst')} paise={totals.sgst_paise} />
              </>
            )}
            {totals.cess_paise > 0 ? (
              <TotalRow label={t('totals.cess')} paise={totals.cess_paise} />
            ) : null}
            <TotalRow label={t('returns.total')} paise={totals.total_paise} strong />
          </div>
          {totals.line_count > 1 ? (
            <TaxBreakupTable
              className="mt-3"
              interstate={interstate}
              rows={taxRows(draft, totals.byKey)}
            />
          ) : null}
        </section>
      </div>

      <div className="no-print sticky bottom-16 z-30 -mx-4 mt-6 border-t border-border bg-surface/95 px-4 py-3 shadow-raised backdrop-blur sm:-mx-6 sm:px-6 md:bottom-0 lg:-mx-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs text-muted-foreground">{t('returns.total')}</div>
            <Money paise={totals.total_paise} className="text-xl font-bold" />
          </div>
          <Button leftIcon={<Save />} loading={saving} onClick={() => void submit()}>
            {t('returns.save')}
          </Button>
        </div>
        {hasReturnErrors(errors) ? (
          <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-danger">
            <Info className="size-4" aria-hidden />
            {t('editor.fix_errors')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** GST split by rate of the lines being returned (preview). */
function taxRows(draft: ReturnDraft, byKey: ReturnType<typeof computeReturn>['byKey']) {
  const rates = new Map<
    number,
    {
      gst_rate_bp: number
      taxable_paise: number
      cgst_paise: number
      sgst_paise: number
      igst_paise: number
      cess_paise: number
    }
  >()
  const add = (rate: number, key: string): void => {
    const a = byKey.get(key)
    if (!a) return
    const r = rates.get(rate) ?? {
      gst_rate_bp: rate,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      cess_paise: 0,
    }
    r.taxable_paise += a.taxable_paise
    r.cgst_paise += a.cgst_paise
    r.sgst_paise += a.sgst_paise
    r.igst_paise += a.igst_paise
    r.cess_paise += a.cess_paise
    rates.set(rate, r)
  }
  if (draft.mode === 'bill')
    for (const l of draft.lines) add(l.line.gst_rate_bp, l.line.bill_line_id)
  else for (const l of draft.lines) add(l.gst_rate_bp, l.key)
  return [...rates.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp)
}

function qtyDecimals(unit: string, packSize: number): number {
  return packSize > 1 || isDecimalUnit(unit) ? 3 : 0
}

function BillReturnRow({
  draft,
  amount,
  error,
  disabled,
  onQty,
}: {
  draft: BillReturnLineDraft
  amount: number | null
  error: string | undefined
  disabled: boolean
  onQty: (qty: number | null) => void
}) {
  const { t } = useTranslation('purchases')
  const l = draft.line
  const name = localizedName(l.product.name, l.product.name_ta)
  const packed = l.pack_size > 1
  const packUnit = packUnitFor(l.unit)
  const q = (milli: number) => (
    <Qty milli={milli} unit={l.unit} packSize={l.pack_size} packUnit={packUnit} />
  )
  const none = l.returnable_qty_milli <= 0
  const errorText =
    error === QTY_ABOVE_RETURNABLE ? t('returns.qty_above_returnable') : validationText(error)
  return (
    <li
      className={cn(
        'grid gap-3 rounded-xl border bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center',
        error ? 'border-danger/60' : 'border-border',
        none && 'opacity-60',
        (draft.qty_milli ?? 0) > 0 && 'border-primary/50 bg-primary-soft/20',
      )}
    >
      <div className="min-w-0">
        <div className="font-medium [overflow-wrap:anywhere]">
          {l.line_no}. {name}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {l.batch_no ? (
            <span>
              {t('lines.batch')} <span className="font-mono">{l.batch_no}</span>
              {l.expiry_date ? ` · ${formatDate(l.expiry_date)}` : ''}
            </span>
          ) : null}
          <span>
            {t('returns.bought')} {q(l.qty_milli)}
            {l.free_qty_milli > 0 ? (
              <>
                {' '}
                + {q(l.free_qty_milli)} {t('lines.free')}
              </>
            ) : null}
          </span>
          {l.returned_qty_milli > 0 ? (
            <span>
              {t('returns.already_returned')} {q(l.returned_qty_milli)}
            </span>
          ) : null}
          {l.available_qty_milli !== null ? (
            <span>
              {t('lines.stock')} {q(l.available_qty_milli)}
            </span>
          ) : null}
          <span>
            {t('returns.cost_each', {
              amount: formatMoney(l.landed_unit_cost_paise),
              rate: formatBp(l.gst_rate_bp),
            })}
          </span>
        </div>
      </div>
      <div className="flex items-start justify-end gap-3">
        <div className="grid w-32 gap-0.5">
          <NumberInput
            size="md"
            className="text-end"
            decimals={qtyDecimals(l.unit, l.pack_size)}
            scale={1000}
            value={packed ? toPackMilli(draft.qty_milli, l.pack_size) : draft.qty_milli}
            disabled={disabled || none}
            aria-label={t('returns.qty_for', { name })}
            aria-invalid={error ? true : undefined}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(v) => onQty(packed ? fromPackMilli(v, l.pack_size) : v)}
          />
          <span className="text-end text-[11px] text-muted-foreground">
            {none ? (
              t('returns.nothing_left')
            ) : (
              <>
                {t('returns.max')} {q(l.returnable_qty_milli)}
              </>
            )}
          </span>
          {errorText ? (
            <span role="alert" className="text-end text-[11px] font-medium text-danger">
              {errorText}
            </span>
          ) : null}
        </div>
        <Money paise={amount} empty="—" className="w-24 pt-2 text-end font-semibold" />
      </div>
    </li>
  )
}

function FreeReturnRow({
  line,
  storeId,
  amount,
  errors,
  compact,
  disabled,
  onChange,
  onRemove,
}: {
  line: FreeReturnLineDraft
  storeId: string | null
  amount: number | null
  errors: ReturnErrors['lines'][string]
  compact: boolean
  disabled: boolean
  onChange: (patch: Partial<FreeReturnLineDraft>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation('purchases')
  const p = line.product
  const name = localizedName(p.name, p.name_ta)
  const packed = p.pack_size > 1
  const packUnit = packUnitFor(p.unit)
  const q = (milli: number) => (
    <Qty milli={milli} unit={p.unit} packSize={p.pack_size} packUnit={packUnit} />
  )
  const qtyError =
    errors.qty === QTY_ABOVE_RETURNABLE ? t('returns.qty_above_stock') : validationText(errors.qty)
  return (
    <li
      className={cn(
        'grid gap-3 rounded-xl border bg-surface p-3',
        compact
          ? 'grid-cols-1'
          : 'grid-cols-[minmax(0,1.6fr)_minmax(10rem,1fr)_7rem_7rem_6rem_7rem_auto] items-start',
        Object.keys(errors).length ? 'border-danger/60' : 'border-border',
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium [overflow-wrap:anywhere]">{name}</div>
          <div className="text-xs text-muted-foreground">
            {[
              p.sku,
              packed
                ? t('lines.pack_of', {
                    count: p.pack_size,
                    unit: unitLabel(p.unit),
                    pack: unitLabel(packUnit),
                  })
                : null,
              line.bill_number ? t('returns.from_grn', { number: line.bill_number }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {line.available_qty_milli !== null ? (
            <div className="text-xs text-muted-foreground">
              {t('lines.stock')} {q(line.available_qty_milli)}
            </div>
          ) : null}
        </div>
        {compact ? (
          <IconButton
            icon={<Trash2 />}
            label={t('returns.remove_line', { name })}
            variant="ghost"
            size="sm"
            className="-me-1 text-muted-foreground hover:text-danger"
            disabled={disabled}
            onClick={onRemove}
          />
        ) : null}
      </div>
      <Cell label={t('lines.batch_expiry')} compact={compact} error={validationText(errors.batch)}>
        {p.track_batches ? (
          <BatchPicker
            productId={p.id}
            storeId={storeId}
            allowExpired
            value={line.batch_id}
            disabled={disabled}
            aria-label={t('returns.batch_for', { name })}
            onChange={(id, batch) =>
              onChange({
                batch_id: id,
                batch_no: batch?.batch_no ?? null,
                expiry_date: batch?.expiry_date ?? null,
                available_qty_milli: batch ? batch.qty_milli : null,
                ...(batch?.purchase_price_paise
                  ? { unit_cost_paise: batch.purchase_price_paise }
                  : {}),
              })
            }
          />
        ) : (
          <span className="block pt-2 text-sm text-muted-foreground">{t('lines.no_batch')}</span>
        )}
      </Cell>
      <Cell
        label={packed ? t('lines.qty_in', { unit: unitLabel(packUnit) }) : t('lines.qty')}
        compact={compact}
        error={qtyError}
      >
        <NumberInput
          size="md"
          className="text-end"
          decimals={qtyDecimals(p.unit, p.pack_size)}
          scale={1000}
          value={packed ? toPackMilli(line.qty_milli, p.pack_size) : line.qty_milli}
          disabled={disabled}
          aria-label={t('returns.qty_for', { name })}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(v) => onChange({ qty_milli: packed ? fromPackMilli(v, p.pack_size) : v })}
        />
      </Cell>
      <Cell
        label={t('returns.cost_per_pack')}
        compact={compact}
        error={validationText(errors.unit_cost)}
      >
        <MoneyInput
          size="md"
          showSymbol={false}
          value={line.unit_cost_paise}
          disabled={disabled}
          aria-label={t('returns.cost_for', { name })}
          onChange={(v) => onChange({ unit_cost_paise: v })}
        />
      </Cell>
      <Cell label={t('lines.gst')} compact={compact}>
        <select
          value={line.gst_rate_bp}
          disabled={disabled}
          aria-label={t('lines.cell_label', { col: t('lines.gst'), n: name })}
          className={cn(fieldVariants({ size: 'md' }), 'pe-1 text-end tabular-nums')}
          onChange={(e) => onChange({ gst_rate_bp: Number(e.target.value) })}
        >
          {GST_RATES_BP.map((r) => (
            <option key={r} value={r}>
              {formatBp(r)}
            </option>
          ))}
        </select>
      </Cell>
      <Cell label={t('lines.amount')} compact={compact}>
        <Money paise={amount} empty="—" className="block pt-2 text-end font-semibold" />
      </Cell>
      {compact ? null : (
        <IconButton
          icon={<Trash2 />}
          label={t('returns.remove_line', { name })}
          variant="ghost"
          size="sm"
          className="mt-1 text-muted-foreground hover:text-danger"
          disabled={disabled}
          onClick={onRemove}
        />
      )}
    </li>
  )
}

function Cell({
  label,
  compact,
  error,
  children,
}: {
  label: string
  compact: boolean
  error?: string
  children: ReactNode
}) {
  return (
    // minmax(0, 1fr): a long batch label must truncate inside its column, not overlap the next.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
      <span className={cn('text-xs font-medium text-muted-foreground', !compact && 'sr-only')}>
        {label}
      </span>
      {children}
      {error ? (
        <span role="alert" className="text-[11px] font-medium text-danger">
          {error}
        </span>
      ) : null}
    </div>
  )
}
