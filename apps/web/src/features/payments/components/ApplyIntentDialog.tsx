/**
 * Apply a paid but unapplied UPI payment (abandoned cart, customer paid twice, dues paid by
 * scanning the standee) — POST /payments/intents/:id/apply:
 *  - to one due invoice (the part above its due becomes the invoice customer's advance), or
 *  - to a customer (a receipt allocated FIFO to their oldest dues; the rest stays as advance).
 */
import { FileText, UserRound } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaymentIntent, PaymentIntentApply } from '@kadai/shared/api/payments'
import { todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { CustomerPicker } from '@/components/pickers'
import {
  Button,
  DatePicker,
  Dialog,
  FormField,
  Input,
  RadioGroup,
  Skeleton,
  notify,
} from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney } from '@/lib/format'
import { useApplyIntent, useDueInvoices } from '../api'
import { useValidationKeyText } from '../lib/validation-text'
import { notifyPaymentError } from '../lib/errors'

type Target = 'sales_invoice' | 'customer'

export function ApplyIntentDialog({
  intent,
  onOpenChange,
  onApplied,
}: {
  intent: PaymentIntent | null
  onOpenChange: (open: boolean) => void
  onApplied?: (result: { paymentId: string; number: string | null }) => void
}) {
  if (!intent) return null
  return <ApplyBody intent={intent} onOpenChange={onOpenChange} onApplied={onApplied} />
}

function ApplyBody({
  intent,
  onOpenChange,
  onApplied,
}: {
  intent: PaymentIntent
  onOpenChange: (open: boolean) => void
  onApplied?: (result: { paymentId: string; number: string | null }) => void
}) {
  const { t } = useTranslation(['payments', 'common'])
  const me = useMe()
  const keyText = useValidationKeyText()
  const idempotencyKey = useRef(newId()).current
  const apply = useApplyIntent()
  const received = intent.paid_amount_paise ?? intent.amount_paise
  const [target, setTarget] = useState<Target>(
    intent.ref_type === 'sales_invoice' ? 'sales_invoice' : 'customer',
  )
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(
    intent.customer_id ? { id: intent.customer_id, name: intent.customer_name ?? '' } : null,
  )
  const [invoiceId, setInvoiceId] = useState<string | null>(
    intent.ref_type === 'sales_invoice' ? intent.ref_id : null,
  )
  const [invoiceSearch, setInvoiceSearch] = useState('')
  const [date, setDate] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const invoices = useDueInvoices(
    {
      ...(customer ? { customer_id: customer.id } : {}),
      ...(invoiceSearch.trim() ? { q: invoiceSearch.trim() } : {}),
      store_id: intent.store_id,
    },
    target === 'sales_invoice',
  )
  const invoiceRows = invoices.data?.data ?? []
  const chosenInvoice = invoiceRows.find((i) => i.id === invoiceId) ?? null

  const targetId = target === 'customer' ? (customer?.id ?? null) : invoiceId
  const submit = (): void => {
    if (!targetId) {
      setError(target === 'customer' ? 'choose_customer' : 'choose_invoice')
      return
    }
    setError(null)
    const body: PaymentIntentApply = {
      target_type: target,
      target_id: targetId,
      ...(date ? { payment_date: date } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    }
    apply.mutate(
      { params: { id: intent.id }, body, idempotencyKey },
      {
        onSuccess: (res) => {
          notify.success(
            t('upi.applied_toast', {
              amount: formatMoney(received),
              number: res.data.payment.number ?? '',
            }),
          )
          onApplied?.({ paymentId: res.data.payment.id, number: res.data.payment.number })
          onOpenChange(false)
        },
        onError: (e) => {
          if (isApiError(e) && (e.status === 422 || e.status === 409)) {
            const reason = typeof e.details?.reason === 'string' ? e.details.reason : null
            setError(reason ?? e.code)
            return
          }
          notifyPaymentError(e)
        },
      },
    )
  }

  const errorText = error
    ? (keyText(error) ??
      (error === 'choose_customer'
        ? t('upi.choose_customer')
        : error === 'choose_invoice'
          ? t('upi.choose_invoice')
          : t('upi.apply_failed')))
    : null

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!apply.isPending) onOpenChange(o)
      }}
      size="md"
      title={t('upi.apply_title', { amount: formatMoney(received) })}
      description={t('upi.apply_hint', {
        payer: intent.payer_name ?? intent.payer_vpa ?? t('upi.unknown_payer'),
      })}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={apply.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={submit} loading={apply.isPending}>
            {t('upi.apply_submit')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <RadioGroup
          value={target}
          onValueChange={(v) => {
            setTarget(v)
            setError(null)
          }}
          variant="cards"
          orientation="horizontal"
          aria-label={t('upi.apply_to')}
          options={[
            {
              value: 'customer',
              label: t('upi.to_customer'),
              description: t('upi.to_customer_hint'),
              icon: <UserRound />,
            },
            {
              value: 'sales_invoice',
              label: t('upi.to_invoice'),
              description: t('upi.to_invoice_hint'),
              icon: <FileText />,
            },
          ]}
        />

        <FormField label={t('fields.customer')} optional={target === 'sales_invoice'}>
          <CustomerPicker
            value={customer}
            onChange={(c) => {
              setCustomer(c ? { id: c.id, name: c.name } : null)
              setInvoiceId(null)
              setError(null)
            }}
          />
        </FormField>

        {target === 'sales_invoice' ? (
          <div className="grid gap-2">
            <Input
              value={invoiceSearch}
              onChange={(e) => setInvoiceSearch(e.target.value)}
              placeholder={t('upi.invoice_search')}
              aria-label={t('upi.invoice_search')}
            />
            {invoices.isPending ? (
              <div className="grid gap-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : invoiceRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('upi.no_due_invoices')}</p>
            ) : (
              <ul
                className="grid max-h-60 gap-1 overflow-y-auto"
                role="radiogroup"
                aria-label={t('upi.to_invoice')}
              >
                {invoiceRows.map((inv) => (
                  <li key={inv.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={invoiceId === inv.id}
                      onClick={() => {
                        setInvoiceId(inv.id)
                        setError(null)
                      }}
                      className={cn(
                        'flex min-h-12 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-start text-sm',
                        invoiceId === inv.id
                          ? 'border-primary bg-primary-soft'
                          : 'border-border hover:bg-surface-2',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{inv.number ?? '—'}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[formatDate(inv.invoice_date), inv.customer_name ?? t('common:misc.walk_in')].join(
                            ' · ',
                          )}
                        </span>
                      </span>
                      <span className="text-end tabular-nums">
                        <span className="block">{formatMoney(inv.due_paise)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t('allocation.due')}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {chosenInvoice && chosenInvoice.due_paise < received ? (
              <p className="rounded-md bg-info-soft px-3 py-2 text-sm text-info-soft-foreground">
                {chosenInvoice.customer_id
                  ? t('upi.excess_to_advance', {
                      amount: formatMoney(received - chosenInvoice.due_paise),
                    })
                  : t('upi.walk_in_excess')}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('fields.date')} optional hint={t('upi.date_hint')}>
            <DatePicker value={date} onChange={setDate} max={todayIn(me?.tenant.timezone)} />
          </FormField>
          <FormField label={t('fields.notes')} optional>
            <Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>

        {errorText ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {errorText}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
