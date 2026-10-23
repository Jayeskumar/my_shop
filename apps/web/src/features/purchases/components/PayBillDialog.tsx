/**
 * "Pay now" for a posted purchase bill: a payment voucher (payments contract, POST /payments,
 * direction out, party supplier) allocated to this bill. Paying more than the due keeps the rest
 * as an advance with the supplier.
 */
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import type { PurchaseBillDetail } from '@kadai/shared/api/purchases'
import type { PaymentMethod } from '@kadai/shared'
import { todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  DatePicker,
  Dialog,
  FormField,
  Input,
  MoneyInput,
  RadioGroup,
  notify,
} from '@/components/ui'
import { useMe } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import { useCreateSupplierPayment } from '../api'
import { bilingual } from '../lib/labels'

const METHODS: readonly PaymentMethod[] = ['cash', 'upi', 'bank_transfer', 'cheque']

export interface PayBillDialogProps {
  bill: Pick<
    PurchaseBillDetail,
    'id' | 'store_id' | 'supplier_id' | 'supplier_name' | 'due_paise' | 'number'
  >
  open: boolean
  onOpenChange: (open: boolean) => void
  onPaid?: () => void
}

export function PayBillDialog({ bill, open, onOpenChange, onPaid }: PayBillDialogProps) {
  const { t } = useTranslation(['purchases', 'common'])
  const me = useMe()
  const today = todayIn(me?.tenant.timezone)
  const [amount, setAmount] = useState<number | null>(bill.due_paise)
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [date, setDate] = useState<string | null>(today)
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [clientRef, setClientRef] = useState(() => newId())
  const pay = useCreateSupplierPayment()

  useEffect(() => {
    if (!open) return
    setAmount(Math.max(0, bill.due_paise))
    setMethod('cash')
    setDate(today)
    setReference('')
    setNotes('')
    setError(null)
    setClientRef(newId())
  }, [open, bill.due_paise, today])

  const advance = amount !== null ? Math.max(0, amount - Math.max(0, bill.due_paise)) : 0
  const options = useMemo(
    () => METHODS.map((m) => ({ value: m, label: bilingual(PAYMENT_METHOD_LABELS[m]) })),
    [],
  )

  const submit = (): void => {
    if (amount === null || amount <= 0) {
      setError(t('pay.amount_required'))
      return
    }
    setError(null)
    const allocated = Math.min(amount, Math.max(0, bill.due_paise))
    pay.mutate(
      {
        body: {
          direction: 'out',
          store_id: bill.store_id,
          party_type: 'supplier',
          party_id: bill.supplier_id,
          method,
          amount_paise: amount,
          payment_date: date ?? today,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(allocated > 0
            ? {
                allocations: [
                  { target_type: 'purchase_bill', target_id: bill.id, amount_paise: allocated },
                ],
              }
            : {}),
          client_ref: clientRef,
        },
        idempotencyKey: clientRef,
      },
      {
        onSuccess: (res) => {
          notify.success(
            t('pay.done', {
              amount: formatMoney(res.data.amount_paise),
              name: bill.supplier_name,
            }),
            res.data.number
              ? { description: t('pay.voucher', { number: res.data.number }) }
              : undefined,
          )
          onOpenChange(false)
          onPaid?.()
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !pay.isPending && onOpenChange(o)}
      title={t('pay.title', { name: bill.supplier_name })}
      description={t('pay.description', {
        number: bill.number ?? '',
        due: formatMoney(Math.max(0, bill.due_paise)),
      })}
      dismissible={!pay.isPending}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pay.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="success" loading={pay.isPending} onClick={submit}>
            {t('pay.confirm', { amount: formatMoney(amount ?? 0) })}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <FormField label={t('pay.amount')} required error={error}>
          <MoneyInput value={amount} onChange={setAmount} size="lg" autoFocus />
        </FormField>
        {advance > 0 ? (
          <p role="status" className="-mt-2 text-sm text-info">
            {t('pay.advance_note', { amount: formatMoney(advance) })}
          </p>
        ) : null}
        <FormField label={t('pay.method')}>
          <RadioGroup
            value={method}
            onValueChange={setMethod}
            options={options}
            variant="cards"
            orientation="horizontal"
            aria-label={t('pay.method')}
            className="grid-cols-2"
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('pay.date')}>
            <DatePicker value={date} onChange={setDate} max={today} />
          </FormField>
          <FormField label={t('pay.reference')} optional hint={t('pay.reference_hint')}>
            <Input
              value={reference}
              maxLength={100}
              onChange={(e) => setReference(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label={t('pay.notes')} optional>
          <Input value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  )
}
