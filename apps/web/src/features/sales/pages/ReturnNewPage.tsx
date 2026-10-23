/**
 * New sales return (/sales/returns/new?invoice_id=). Step 1 finds the bill — type or scan the
 * bill number, pick the customer to see their bills, or tap a recent bill. Step 2 lists the
 * returnable lines (sold − already returned) with quantity inputs capped at what can still be
 * returned and restock toggles (off by default for damaged / expired goods), the reason, and the
 * settlement (cash / UPI / bank refund up to what was paid, adjust against the bill's due, or
 * store credit) with a plain explanation of each. The credit-note totals are computed live with
 * the same pro-rata maths as the server. Submitting sends a client_ref kept for this screen, so a
 * retry never creates two credit notes; the credit note opens ready to print.
 */
import { CheckCheck, Receipt, RotateCcw, Search, Undo2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  CreditNoteCreateSchema,
  type CreditNoteCreate,
  type ReturnableLine,
  type ReturnableResponse,
  type SalesInvoiceListRow,
  defaultRestock,
} from '@kadai/shared/api/sales'
import {
  CreditNoteReasonSchema,
  type CreditNoteReason,
  type CreditNoteSettlement,
} from '@kadai/shared/enums'
import { isUuid, newId } from '@kadai/shared/ids'
import { CustomerPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  EmptyState,
  FormField,
  Input,
  Money,
  PageHeader,
  QtyInput,
  RadioGroup,
  Skeleton,
  Switch,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { isApiError } from '@/lib/api'
import { useCurrentRegister, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { errorText } from '@/lib/errors'
import { formatDate, formatMoney } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useCreateCreditNote, useInvoices, useReturnable } from '../api'
import { PaymentStatusBadge } from '../components/StatusBadges'
import { contractIssues, errorReason, serverIssue, useValidationText } from '../lib/forms'
import { bilingual, qtyText, reasonLabel, settlementLabel } from '../lib/labels'
import { periodRange } from '../lib/period'
import {
  defaultSettlement,
  previewReturn,
  returnLineAmounts,
  settlementOptionsFor,
} from '../lib/returns'
import { useTenantCalendar } from '../lib/use-tenant-calendar'

const SCOPE = 'sales-return-new'

export default function ReturnNewPage() {
  const { t } = useTranslation(['sales', 'common'])
  const [params, setParams] = useSearchParams()
  const raw = params.get('invoice_id')
  const invoiceId = raw && isUuid(raw) ? raw : null
  const choose = (id: string | null): void =>
    setParams(id ? { invoice_id: id } : {}, { replace: false })

  return (
    <div className="pb-8">
      <PageHeader
        backTo="/sales/returns"
        breadcrumbs={[
          { label: t('returns.title'), to: '/sales/returns' },
          { label: t('return_new.title') },
        ]}
        title={t('return_new.title')}
        description={
          invoiceId ? t('return_new.description_lines') : t('return_new.description_find')
        }
      />
      {invoiceId ? (
        <ReturnForm key={invoiceId} invoiceId={invoiceId} onChangeBill={() => choose(null)} />
      ) : (
        <InvoiceFinder onPick={(id) => choose(id)} />
      )}
    </div>
  )
}

// ---- step 1: find the bill -----------------------------------------------------------------------

function InvoiceFinder({ onPick }: { onPick: (id: string) => void }) {
  const { t } = useTranslation(['sales', 'common'])
  const { ctx } = useTenantCalendar()
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null)
  const [pickExact, setPickExact] = useState(false)
  const recent = periodRange({ period: 'last_30_days', from: '', to: '' }, ctx)
  const searching = q !== '' || customer !== null
  const list = useInvoices({
    status: ['completed'],
    limit: 20,
    sort: '-invoice_at',
    ...(q ? { q } : {}),
    ...(customer ? { customer_id: customer.id } : {}),
    ...(!searching && recent ? { from: recent.from, to: recent.to } : {}),
  })
  const rows = list.data?.data ?? []

  // A scanned / typed number that matches exactly one bill opens it straight away.
  const settledRows =
    !list.isFetching && !list.isPlaceholderData && list.data ? list.data.data : null
  useEffect(() => {
    if (!pickExact || !settledRows) return
    setPickExact(false)
    const exact = settledRows.filter((r) => r.number?.toUpperCase() === q.toUpperCase())
    const only =
      exact.length === 1 ? exact[0] : settledRows.length === 1 ? settledRows[0] : undefined
    if (only) onPick(only.id)
  }, [pickExact, settledRows, q, onPick])

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <form
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-card"
        onSubmit={(e) => {
          e.preventDefault()
          setPickExact(text.trim() !== '')
          setQ(text.trim())
        }}
      >
        <FormField label={t('return_new.find_label')} hint={t('return_new.find_hint')}>
          <div className="flex gap-2">
            <Input
              autoFocus
              size="lg"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (e.target.value === '') setQ('')
              }}
              placeholder={t('return_new.find_placeholder')}
              startAdornment={<Search />}
              enterKeyHint="search"
            />
            <Button type="submit" size="lg">
              {t('return_new.find')}
            </Button>
          </div>
        </FormField>
        <FormField label={t('return_new.or_customer')}>
          <CustomerPicker
            value={customer}
            onChange={(c) => setCustomer(c ? { id: c.id, name: c.name } : null)}
            size="lg"
          />
        </FormField>
      </form>

      <section aria-label={searching ? t('return_new.results') : t('return_new.recent')}>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          {searching ? t('return_new.results') : t('return_new.recent')}
        </h2>
        {list.isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface">
            <EmptyState
              compact
              icon={<Receipt />}
              title={searching ? t('return_new.no_match') : t('return_new.no_recent')}
              description={t('return_new.no_match_hint')}
            />
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={r.id}>
                <BillButton row={r} onPick={onPick} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function BillButton({ row, onPick }: { row: SalesInvoiceListRow; onPick: (id: string) => void }) {
  const { t } = useTranslation(['sales', 'common'])
  return (
    <button
      type="button"
      onClick={() => onPick(row.id)}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-start shadow-card transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="min-w-0">
        <div className="font-semibold">{row.number}</div>
        <div className="truncate text-sm text-muted-foreground">
          {formatDate(row.invoice_date)} · {row.customer_name ?? t('common:misc.walk_in')} ·{' '}
          {t('invoices.items_count', { count: row.item_count })}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Money paise={row.total_paise} className="font-semibold" />
        {row.returned_paise > 0 ? (
          <Badge tone="info" size="sm">
            {t('return_new.already_returned', { amount: formatMoney(row.returned_paise) })}
          </Badge>
        ) : (
          <PaymentStatusBadge status={row.payment_status} />
        )}
      </div>
    </button>
  )
}

// ---- step 2: lines, reason, settlement -----------------------------------------------------------

function ReturnForm({ invoiceId, onChangeBill }: { invoiceId: string; onChangeBill: () => void }) {
  const { t } = useTranslation(['sales', 'common'])
  const returnable = useReturnable(invoiceId)
  if (returnable.isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-96 w-full lg:col-span-2" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (returnable.error || !returnable.data) {
    const notFound = isApiError(returnable.error) && returnable.error.status === 404
    return (
      <EmptyState
        icon={<Receipt />}
        title={notFound ? t('invoice.not_found') : t('return_new.load_failed')}
        description={notFound ? t('invoice.not_found_hint') : errorText(returnable.error)}
        action={
          <Button variant="outline" onClick={onChangeBill}>
            {t('return_new.pick_other')}
          </Button>
        }
      />
    )
  }
  const data = returnable.data.data
  if (data.invoice.status !== 'completed') {
    return (
      <EmptyState
        icon={<Receipt />}
        title={t('return_new.not_returnable')}
        description={t('return_new.not_returnable_hint', {
          status: t(`invoice_status.${data.invoice.status}`),
        })}
        action={
          <Button variant="outline" onClick={onChangeBill}>
            {t('return_new.pick_other')}
          </Button>
        }
      />
    )
  }
  return <ReturnFormBody data={data} onChangeBill={onChangeBill} />
}

function ReturnFormBody({
  data,
  onChangeBill,
}: {
  data: ReturnableResponse
  onChangeBill: () => void
}) {
  const { t, i18n } = useTranslation(['sales', 'common'])
  const vt = useValidationText()
  const navigate = useNavigate()
  const me = useMe()
  const { today } = useTenantCalendar()
  const register = useCurrentRegister()
  const create = useCreateCreditNote()
  const clientRef = useRef(newId()).current
  const [reason, setReason] = useState<CreditNoteReason>('return')
  const [qty, setQty] = useState<Record<string, number | null>>({})
  const [restockTouched, setRestockTouched] = useState<Record<string, boolean>>({})
  const [chosen, setChosen] = useState<CreditNoteSettlement | null>(null)
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const roundOff = me?.settings.invoice.round_off ?? 'nearest_rupee'
  const inv = data.invoice

  const restockOf = (line: ReturnableLine): boolean => {
    if (!line.track_inventory) return false
    const touched = restockTouched[line.invoice_line_id]
    if (touched !== undefined) return touched
    const expired = line.expiry_date !== null && line.expiry_date < today
    return defaultRestock(reason) && !expired
  }

  const preview = useMemo(() => previewReturn(data, qty, roundOff), [data, qty, roundOff])
  const options = settlementOptionsFor(data, preview.total_paise)
  const settlement = chosen && options.includes(chosen) ? chosen : defaultSettlement(options)
  const anyReturnable = data.lines.some((l) => l.returnable_qty_milli > 0)

  const setLineQty = (line: ReturnableLine, value: number | null): void => {
    setQty((prev) => ({ ...prev, [line.invoice_line_id]: value }))
    setLineErrors((prev) => {
      const { [line.invoice_line_id]: _removed, ...rest } = prev
      return rest
    })
    setFormError(null)
  }

  const returnAll = (): void => {
    const next: Record<string, number | null> = {}
    for (const l of data.lines)
      if (l.returnable_qty_milli > 0) next[l.invoice_line_id] = l.returnable_qty_milli
    setQty(next)
    setLineErrors({})
  }

  const toBody = (): CreditNoteCreate => ({
    client_ref: clientRef,
    invoice_id: inv.id,
    ...(register && register.store_id === inv.store_id ? { register_id: register.id } : {}),
    lines: preview.lines.map((l) => {
      const line = data.lines.find((x) => x.invoice_line_id === l.invoice_line_id)
      return {
        invoice_line_id: l.invoice_line_id,
        qty_milli: l.qty_milli,
        ...(line ? { restock: restockOf(line) } : {}),
      }
    }),
    reason,
    settlement: settlement ?? 'cash',
    ...((settlement === 'upi' || settlement === 'bank_transfer') && reference.trim()
      ? { refund_reference: reference.trim() }
      : {}),
    ...(notes.trim() ? { notes: notes.trim() } : {}),
  })

  const submit = (): void => {
    const errors: Record<string, string> = {}
    for (const l of data.lines) {
      const v = qty[l.invoice_line_id] ?? 0
      if (v > l.returnable_qty_milli) {
        errors[l.invoice_line_id] = t('return_new.qty_too_much', {
          qty: qtyText(l.returnable_qty_milli, l.unit, l.pack_size, i18n.language),
        })
      } else if (v < 0) {
        errors[l.invoice_line_id] = t('return_new.qty_invalid')
      }
    }
    setLineErrors(errors)
    if (Object.keys(errors).length > 0) return
    if (preview.lines.length === 0) {
      setFormError(t('return_new.pick_lines'))
      return
    }
    if (!settlement) {
      setFormError(t('return_new.no_settlement'))
      return
    }
    const body = toBody()
    const issues = contractIssues(CreditNoteCreateSchema, body)
    const first = Object.values(issues)[0]
    if (first) {
      setFormError(vt(first) ?? first)
      return
    }
    setFormError(null)
    create.mutate(
      { body, idempotencyKey: clientRef },
      {
        onSuccess: (res) => {
          notify.success(
            t('return_new.done', {
              number: res.data.number,
              amount: formatMoney(res.data.total_paise),
            }),
          )
          navigate(`/sales/returns/${res.data.id}`, { replace: true, state: { created: true } })
        },
        onError: (e) => {
          const lineIssue = data.lines.findIndex((_, i) => serverIssue(e, `lines.${i}`))
          if (lineIssue >= 0) {
            const sent = body.lines[lineIssue]
            const msg = serverIssue(e, `lines.${lineIssue}`)
            if (sent?.invoice_line_id && msg) {
              setLineErrors({ [sent.invoice_line_id]: vt(msg) ?? msg })
              return
            }
          }
          const reasonKey = errorReason(e)
          setFormError((reasonKey ? vt(reasonKey) : undefined) ?? errorText(e))
        },
      },
    )
  }

  useHotkeyScope(SCOPE)
  useHotkeys(
    { 'ctrl+enter, F12': submit },
    { scope: SCOPE, allowInInputs: true, preventDefault: true },
  )

  const settlementHelp = (s: CreditNoteSettlement): string => {
    const amount = formatMoney(preview.total_paise)
    switch (s) {
      case 'cash':
        return t('settlement_help.cash', { amount })
      case 'upi':
        return t('settlement_help.upi', { amount })
      case 'bank_transfer':
        return t('settlement_help.bank_transfer', { amount })
      case 'adjust_due':
        return preview.total_paise > inv.due_paise
          ? t('settlement_help.adjust_due_excess', {
              due: formatMoney(inv.due_paise),
              excess: formatMoney(preview.total_paise - inv.due_paise),
            })
          : t('settlement_help.adjust_due', { amount, due: formatMoney(inv.due_paise) })
      case 'store_credit':
        return t('settlement_help.store_credit', { amount })
    }
  }

  const refundCapped = preview.total_paise > data.refundable_paise && !options.includes('cash')

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
        {/* the bill */}
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-card">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t('return_new.bill')}</div>
            <Link
              to={`/sales/invoices/${inv.id}`}
              className="text-lg font-semibold hover:text-primary hover:underline"
            >
              {inv.number}
            </Link>
            <div className="text-sm text-muted-foreground">
              {formatDate(inv.invoice_date)} · {inv.customer_name ?? t('common:misc.walk_in')}
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <Fact label={t('totals.total')} paise={inv.total_paise} />
            <Fact label={t('totals.paid')} paise={inv.paid_paise} />
            {inv.due_paise > 0 ? (
              <Fact label={t('totals.due')} paise={inv.due_paise} danger />
            ) : null}
            {inv.returned_paise > 0 ? (
              <Fact label={t('totals.returned')} paise={inv.returned_paise} />
            ) : null}
          </dl>
          <Button variant="link" size="sm" onClick={onChangeBill}>
            {t('return_new.change_bill')}
          </Button>
        </section>

        {/* reason */}
        <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
          <h2 className="mb-3 font-semibold">{t('return_new.reason')}</h2>
          <RadioGroup<CreditNoteReason>
            aria-label={t('return_new.reason')}
            variant="cards"
            className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
            value={reason}
            onValueChange={(r) => {
              setReason(r)
              setRestockTouched({})
            }}
            options={CreditNoteReasonSchema.options.map((r) => ({
              value: r,
              label: reasonLabel(r, i18n.language),
            }))}
          />
          {!defaultRestock(reason) ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('return_new.no_restock_hint')}</p>
          ) : null}
        </section>

        {/* lines */}
        <section className="rounded-xl border border-border bg-surface shadow-card">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="font-semibold">{t('return_new.items')}</h2>
            {anyReturnable ? (
              <Button variant="outline" size="sm" leftIcon={<CheckCheck />} onClick={returnAll}>
                {t('return_new.return_all')}
              </Button>
            ) : null}
          </div>
          {!anyReturnable ? (
            <EmptyState
              compact
              icon={<Undo2 />}
              title={t('return_new.all_returned')}
              description={t('return_new.all_returned_hint')}
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.lines.map((line) => (
                <ReturnLineRow
                  key={line.invoice_line_id}
                  line={line}
                  value={qty[line.invoice_line_id] ?? null}
                  onChange={(v) => setLineQty(line, v)}
                  restock={restockOf(line)}
                  onRestock={(on) =>
                    setRestockTouched((prev) => ({ ...prev, [line.invoice_line_id]: on }))
                  }
                  error={lineErrors[line.invoice_line_id] ?? null}
                  today={today}
                />
              ))}
            </ul>
          )}
        </section>

        {/* settlement */}
        <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
          <h2 className="mb-1 font-semibold">{t('return_new.settlement')}</h2>
          <p className="mb-3 text-sm text-muted-foreground">{t('return_new.settlement_hint')}</p>
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('return_new.no_settlement')}</p>
          ) : (
            <RadioGroup<CreditNoteSettlement>
              aria-label={t('return_new.settlement')}
              variant="cards"
              className="sm:grid-cols-2"
              value={settlement}
              onValueChange={setChosen}
              options={options.map((s) => ({
                value: s,
                label: settlementLabel(s, i18n.language),
                description: settlementHelp(s),
              }))}
            />
          )}
          {refundCapped ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('return_new.refund_capped', { amount: formatMoney(data.refundable_paise) })}
            </p>
          ) : null}
          {inv.customer_id === null ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('return_new.walk_in_hint')}</p>
          ) : null}
          {settlement === 'upi' || settlement === 'bank_transfer' ? (
            <FormField
              className="mt-3"
              label={settlement === 'upi' ? t('return_new.refund_utr') : t('return_new.refund_ref')}
              optional
            >
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={100}
              />
            </FormField>
          ) : null}
          <FormField className="mt-3" label={t('return_new.notes')} optional>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={2}
            />
          </FormField>
        </section>
      </div>

      {/* live credit note */}
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <section
          className="rounded-xl border border-border bg-surface p-4 shadow-card"
          aria-label={t('return_new.credit_note')}
        >
          <h2 className="mb-2 flex items-center gap-2 font-semibold">
            <RotateCcw className="size-4 text-muted-foreground" aria-hidden />
            {t('return_new.credit_note')}
          </h2>
          <dl className="text-sm" aria-live="polite">
            <PreviewRow
              label={t('return_new.items_count', { count: preview.item_count })}
              value={null}
            />
            <PreviewRow label={t('totals.taxable')} value={preview.taxable_paise} />
            {preview.cgst_paise > 0 ? (
              <PreviewRow label="CGST" value={preview.cgst_paise} muted />
            ) : null}
            {preview.sgst_paise > 0 ? (
              <PreviewRow label="SGST" value={preview.sgst_paise} muted />
            ) : null}
            {preview.igst_paise > 0 ? (
              <PreviewRow label="IGST" value={preview.igst_paise} muted />
            ) : null}
            {preview.cess_paise > 0 ? (
              <PreviewRow label={t('totals.cess')} value={preview.cess_paise} muted />
            ) : null}
            {preview.round_off_paise !== 0 ? (
              <PreviewRow
                label={t('totals.round_off')}
                value={preview.round_off_paise}
                muted
                signed
              />
            ) : null}
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
              <dt className="font-semibold">{t('return_new.credit_total')}</dt>
              <dd>
                <Money paise={preview.total_paise} className="text-2xl font-bold" />
              </dd>
            </div>
          </dl>
          {settlement ? (
            <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
              {settlementHelp(settlement)}
            </p>
          ) : null}
          {formError ? (
            <p
              role="alert"
              className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
            >
              {formError}
            </p>
          ) : null}
          <Button
            className="mt-4"
            size="lg"
            fullWidth
            leftIcon={<RotateCcw />}
            onClick={submit}
            loading={create.isPending}
            disabled={preview.lines.length === 0}
          >
            {preview.lines.length === 0
              ? t('return_new.pick_lines_short')
              : t('return_new.submit', { amount: formatMoney(preview.total_paise) })}
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {t('return_new.shortcut')}
          </p>
        </section>
      </aside>
    </div>
  )
}

function Fact({ label, paise, danger }: { label: ReactNode; paise: number; danger?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('font-semibold', danger && 'text-danger')}>
        <Money paise={paise} />
      </dd>
    </div>
  )
}

function PreviewRow({
  label,
  value,
  muted,
  signed,
}: {
  label: ReactNode
  value: number | null
  muted?: boolean
  signed?: boolean
}) {
  return (
    <div className={cn('flex justify-between py-0.5', muted && 'text-muted-foreground')}>
      <dt>{label}</dt>
      <dd className="tabular-nums">
        {value === null ? null : (
          <>
            {signed && value > 0 ? '+' : signed && value < 0 ? '−' : ''}
            <Money paise={signed ? Math.abs(value) : value} />
          </>
        )}
      </dd>
    </div>
  )
}

function ReturnLineRow({
  line,
  value,
  onChange,
  restock,
  onRestock,
  error,
  today,
}: {
  line: ReturnableLine
  value: number | null
  onChange: (v: number | null) => void
  restock: boolean
  onRestock: (on: boolean) => void
  error: string | null
  today: string
}) {
  const { t, i18n } = useTranslation('sales')
  const names = bilingual(line.name, line.name_ta, i18n.language)
  const max = line.returnable_qty_milli
  const done = max === 0
  const amounts = value && value > 0 && value <= max ? returnLineAmounts(line, value) : null
  const expired = line.expiry_date !== null && line.expiry_date < today
  const q = (milli: number): string => qtyText(milli, line.unit, line.pack_size, i18n.language)
  const inputId = `ret-${line.invoice_line_id}`
  return (
    <li
      className={cn(
        'flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start',
        done && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="font-medium">
          {names.primary}
        </label>
        {names.secondary ? (
          <div className="text-xs text-muted-foreground">{names.secondary}</div>
        ) : null}
        <div className="text-xs text-muted-foreground">
          {[
            line.batch_no ? t('lines.batch', { batch: line.batch_no }) : null,
            line.expiry_date ? t('lines.expiry', { date: formatDate(line.expiry_date) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          {expired ? (
            <Badge tone="danger" size="sm" className="ms-1.5">
              {t('return_new.expired')}
            </Badge>
          ) : null}
        </div>
        <div className="mt-1 text-sm">
          {t('return_new.sold', { qty: q(line.qty_milli) })}
          {line.returned_qty_milli > 0
            ? ` · ${t('return_new.returned_before', { qty: q(line.returned_qty_milli) })}`
            : ''}
          {' · '}
          <Money paise={line.total_paise} />
        </div>
      </div>
      {done ? (
        <Badge tone="info">{t('return_new.fully_returned')}</Badge>
      ) : (
        <div className="flex flex-col gap-2 sm:w-72">
          <FormField id={inputId} error={error}>
            <QtyInput
              value={value}
              onChange={onChange}
              unit={line.unit}
              min={0}
              max={max}
              size="lg"
            />
          </FormField>
          <div className="-mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('return_new.max', { qty: q(max) })}</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => onChange(max)}
              aria-label={t('return_new.all_of', { name: names.primary })}
            >
              {t('return_new.all')}
            </Button>
          </div>
          {line.track_inventory ? (
            <Switch
              checked={restock}
              onCheckedChange={onRestock}
              label={t('return_new.restock')}
              aria-label={t('return_new.restock_item', { name: names.primary })}
              description={restock ? t('return_new.restock_on') : t('return_new.restock_off')}
            />
          ) : null}
          {amounts ? (
            <div className="text-end text-sm">
              {t('return_new.line_credit')}{' '}
              <Money paise={amounts.total_paise} className="font-semibold" />
            </div>
          ) : null}
        </div>
      )}
    </li>
  )
}
