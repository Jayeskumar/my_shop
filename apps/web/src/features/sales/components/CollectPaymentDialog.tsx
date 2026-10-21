/**
 * "Collect payment" for the due of an invoice (POST /sales/invoices/:id/payments,
 * payments.collect). One or more tenders (split payment): cash (the money handed over — change
 * is worked out), UPI (shop QR with "received", or an auto-confirm QR on plans with
 * upi_dynamic), card, bank transfer, cheque, or the customer's advance (store credit). The
 * preview uses the shared allocateTenders — exactly what the server applies: non-cash first and
 * each must fit, then cash with change; whatever stays unpaid remains on the customer's khata.
 * The request carries a client_ref kept for the dialog session, so a double tap or a retry
 * after a timeout never records the money twice.
 */
import {
  Banknote,
  CircleEllipsis,
  CreditCard,
  Landmark,
  Plus,
  Smartphone,
  Trash2,
  Wallet,
} from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CollectPaymentSchema,
  type CollectPayment,
  type SalesInvoiceDetail,
  allocateTenders,
} from '@kadai/shared/api/sales'
import type { PaymentMethod } from '@kadai/shared/enums'
import { newId } from '@kadai/shared/ids'
import {
  Button,
  DatePicker,
  Dialog,
  FormField,
  IconButton,
  Input,
  Money,
  MoneyInput,
  RadioGroup,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useCurrentRegister, useFeature, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useCollectPayment } from '../api'
import { contractIssues, errorReason, issueAt, useValidationText } from '../lib/forms'
import { useTenantCalendar } from '../lib/use-tenant-calendar'
import { type UpiPaid, UpiCollect } from './UpiCollect'

type CollectMethod = Extract<
  PaymentMethod,
  'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque' | 'store_credit'
>

const METHOD_ICON: Record<CollectMethod, ReactNode> = {
  cash: <Banknote />,
  upi: <Smartphone />,
  card: <CreditCard />,
  bank_transfer: <Landmark />,
  cheque: <CircleEllipsis />,
  store_credit: <Wallet />,
}

interface TenderRow {
  key: string
  method: CollectMethod
  amount: number | null
  reference: string
  /** UPI: confirmed receipt (QR paid / "received"). */
  upi: UpiPaid | null
}

const MAX_TENDERS = 4

const amountOf = (r: TenderRow): number => r.upi?.amount_paise ?? r.amount ?? 0

export interface CollectPaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: SalesInvoiceDetail
  onDone?: () => void
}

/** Mounted only while open: each opening is a new payment with its own client_ref. */
export function CollectPaymentDialog(props: CollectPaymentDialogProps) {
  return props.open ? <CollectBody {...props} /> : null
}

function CollectBody({ onOpenChange, invoice, onDone }: CollectPaymentDialogProps) {
  const { t } = useTranslation(['sales', 'common'])
  const vt = useValidationText()
  const me = useMe()
  const { today } = useTenantCalendar()
  const register = useCurrentRegister()
  const dynamicUpi = useFeature('upi_dynamic')
  const collect = useCollectPayment()
  const clientRef = useRef(newId()).current
  const due = Math.max(0, invoice.due_paise)
  const advance =
    invoice.customer && invoice.customer.balance_paise < 0 ? -invoice.customer.balance_paise : 0
  const defaultMethod: CollectMethod = me?.settings.pos.default_payment_method ?? 'cash'

  const [rows, setRows] = useState<TenderRow[]>([
    { key: newId(), method: defaultMethod, amount: due, reference: '', upi: null },
  ])
  const [date, setDate] = useState<string | null>(today)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const registerId = register && register.store_id === invoice.store_id ? register.id : null
  const methods: CollectMethod[] = ['cash', 'upi', 'card', 'bank_transfer', 'cheque']
  if (advance > 0) methods.push('store_credit')

  const allocation = useMemo(
    () =>
      allocateTenders(
        due,
        rows.map((r) => ({ method: r.method, amount_paise: amountOf(r) })),
      ),
    [due, rows],
  )

  const update = (key: string, patch: Partial<TenderRow>): void => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    setRowErrors((prev) => {
      const { [key]: _removed, ...rest } = prev
      return rest
    })
    setError(null)
  }

  const onUpiPaid = useCallback((key: string, paid: UpiPaid) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, upi: paid, amount: paid.amount_paise } : r)),
    )
    setRowErrors((prev) => {
      const { [key]: _removed, ...rest } = prev
      return rest
    })
  }, [])

  const addRow = (): void => {
    const remaining = Math.max(0, allocation.due_paise)
    const used = new Set(rows.map((r) => r.method))
    const method = methods.find((m) => !used.has(m)) ?? 'cash'
    setRows((prev) => [
      ...prev,
      { key: newId(), method, amount: remaining > 0 ? remaining : null, reference: '', upi: null },
    ])
  }

  const toBody = (): CollectPayment => ({
    tenders: rows.map((r) => ({
      method: r.method,
      amount_paise: amountOf(r),
      ...(r.upi?.payment_intent_id ? { payment_intent_id: r.upi.payment_intent_id } : {}),
      ...(r.upi?.provider_account_id ? { provider_account_id: r.upi.provider_account_id } : {}),
      ...((r.upi?.reference ?? r.reference.trim())
        ? { reference: r.upi?.reference ?? r.reference.trim() }
        : {}),
    })),
    ...(date && date !== today ? { payment_date: date } : {}),
    ...(registerId ? { register_id: registerId } : {}),
    ...(notes.trim() ? { notes: notes.trim() } : {}),
    client_ref: clientRef,
  })

  const submit = (): void => {
    const nextRowErrors: Record<string, string> = {}
    rows.forEach((r) => {
      if (amountOf(r) <= 0) nextRowErrors[r.key] = t('collect.amount_required')
      else if (r.method === 'upi' && !r.upi) nextRowErrors[r.key] = t('collect.upi_confirm_first')
      else if (r.method === 'store_credit' && amountOf(r) > advance)
        nextRowErrors[r.key] = t('collect.advance_exceeded', { amount: formatMoney(advance) })
    })
    if (allocation.issue) {
      const row = rows[allocation.issue.index]
      if (row && !nextRowErrors[row.key]) {
        nextRowErrors[row.key] =
          allocation.issue.code === 'tender_exceeds_due'
            ? t('collect.exceeds_due', { amount: formatMoney(due) })
            : t('collect.cash_not_needed')
      }
    }
    setRowErrors(nextRowErrors)
    if (Object.keys(nextRowErrors).length > 0) return
    const body = toBody()
    const issues = contractIssues(CollectPaymentSchema, body)
    const first = issueAt(issues, 'tenders') ?? Object.values(issues)[0]
    if (first) {
      setError(vt(first) ?? first)
      return
    }
    setError(null)
    collect.mutate(
      { params: { id: invoice.id }, body, idempotencyKey: clientRef },
      {
        onSuccess: (res) => {
          const received = res.data.tenders.reduce((s, x) => s + x.applied_paise, 0)
          notify.success(t('collect.done', { amount: formatMoney(received) }), {
            ...(res.data.change_paise > 0
              ? {
                  description: t('collect.give_change', {
                    amount: formatMoney(res.data.change_paise),
                  }),
                }
              : {}),
          })
          onDone?.()
          onOpenChange(false)
        },
        onError: (e) => {
          const reason = errorReason(e)
          const known = reason ? vt(reason) : undefined
          if (known) setError(known)
          else notify.error(e)
        },
      },
    )
  }

  const stillDue = Math.max(0, allocation.due_paise)

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="lg"
      dismissible={!collect.isPending}
      title={t('collect.title')}
      description={t('collect.description', {
        number: invoice.number ?? '',
        name: invoice.customer_name ?? t('common:misc.walk_in'),
      })}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={collect.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={submit}
            loading={collect.isPending}
            disabled={allocation.paid_paise <= 0}
          >
            {t('collect.submit', { amount: formatMoney(allocation.paid_paise) })}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="flex items-center justify-between rounded-lg bg-surface-2 px-4 py-3">
          <span className="text-sm text-muted-foreground">{t('collect.bill_due')}</span>
          <Money paise={due} className="text-2xl font-bold" />
        </div>

        {rows.map((row, index) => (
          <fieldset
            key={row.key}
            className="flex flex-col gap-3 rounded-lg border border-border p-3"
            aria-label={t('collect.tender_n', { n: index + 1 })}
          >
            <div className="flex items-start justify-between gap-2">
              <RadioGroup<CollectMethod>
                aria-label={t('collect.method')}
                variant="cards"
                className="flex-1 grid-cols-2 sm:grid-cols-3"
                value={row.method}
                onValueChange={(method) =>
                  update(row.key, {
                    method,
                    upi: null,
                    reference: '',
                    ...(method === 'store_credit'
                      ? { amount: Math.min(advance, row.amount ?? due) }
                      : {}),
                  })
                }
                options={methods.map((m) => ({
                  value: m,
                  label: t(`collect.method_${m}`),
                  icon: <span className="hidden sm:inline-flex">{METHOD_ICON[m]}</span>,
                  disabled: row.upi !== null,
                }))}
              />
              {rows.length > 1 ? (
                <IconButton
                  icon={<Trash2 />}
                  label={t('collect.remove_tender')}
                  variant="ghost"
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                />
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label={row.method === 'cash' ? t('collect.cash_given') : t('collect.amount')}
                error={rowErrors[row.key] ?? null}
                required
              >
                <MoneyInput
                  value={row.upi ? row.upi.amount_paise : row.amount}
                  onChange={(amount) => update(row.key, { amount })}
                  disabled={row.upi !== null}
                  size="lg"
                />
              </FormField>
              {row.method === 'card' ||
              row.method === 'bank_transfer' ||
              row.method === 'cheque' ? (
                <FormField label={t(`collect.reference_${row.method}`)} optional>
                  <Input
                    value={row.reference}
                    onChange={(e) => update(row.key, { reference: e.target.value })}
                    maxLength={100}
                    size="lg"
                  />
                </FormField>
              ) : null}
              {row.method === 'store_credit' ? (
                <p className="self-end pb-3 text-sm text-muted-foreground">
                  {t('collect.advance_available', { amount: formatMoney(advance) })}
                </p>
              ) : null}
              {row.method === 'cash' &&
              allocation.lines[index] &&
              allocation.lines[index].change_paise > 0 ? (
                <p className="self-end pb-3 text-base font-semibold text-warning-soft-foreground">
                  {t('collect.change', {
                    amount: formatMoney(allocation.lines[index].change_paise),
                  })}
                </p>
              ) : null}
            </div>
            {row.method === 'upi' && !row.upi ? (
              <UpiCollect
                amountPaise={row.amount ?? 0}
                storeId={invoice.store_id}
                registerId={registerId}
                invoice={{
                  id: invoice.id,
                  number: invoice.number,
                  customer_id: invoice.customer_id,
                }}
                dynamicAllowed={dynamicUpi}
                onPaid={(paid) => onUpiPaid(row.key, paid)}
              />
            ) : null}
            {row.upi ? (
              <p className="rounded-md bg-success-soft px-3 py-2 text-sm font-medium text-success-soft-foreground">
                {t('collect.upi_done', { amount: formatMoney(row.upi.amount_paise) })}
                {row.upi.reference ? ` · UTR ${row.upi.reference}` : ''}
              </p>
            ) : null}
          </fieldset>
        ))}

        {rows.length < MAX_TENDERS ? (
          <Button
            type="button"
            variant="outline"
            leftIcon={<Plus />}
            onClick={addRow}
            className="self-start"
          >
            {t('collect.split')}
          </Button>
        ) : null}

        <dl className="grid gap-1 rounded-lg border border-border p-3 text-sm">
          <div className="flex justify-between">
            <dt>{t('collect.receiving')}</dt>
            <dd className="font-semibold">
              <Money paise={allocation.paid_paise} />
            </dd>
          </div>
          {allocation.change_paise > 0 ? (
            <div className="flex justify-between text-warning-soft-foreground">
              <dt>{t('collect.change_to_give')}</dt>
              <dd className="font-semibold">
                <Money paise={allocation.change_paise} />
              </dd>
            </div>
          ) : null}
          <div className={cn('flex justify-between', stillDue > 0 && 'text-danger')}>
            <dt>
              {stillDue > 0
                ? invoice.customer_id
                  ? t('collect.still_due_khata')
                  : t('collect.still_due')
                : t('collect.fully_paid')}
            </dt>
            <dd className="font-semibold">
              <Money paise={stillDue} />
            </dd>
          </div>
        </dl>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t('collect.date')}>
            <DatePicker value={date} onChange={setDate} max={today} />
          </FormField>
          <FormField label={t('collect.notes')} optional>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={1}
            />
          </FormField>
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
          >
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
