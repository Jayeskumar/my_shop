/**
 * Cancel a manual receipt / payment voucher (POST /payments/:id/cancel {reason}): the ledger
 * entry is reversed and the documents it settled become due again. A reason is required
 * (audit trail); the contract's zReason checks it.
 */
import { useRef } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type PaymentCancel,
  PaymentCancelSchema,
  type PaymentDetail,
} from '@kadai/shared/api/payments'
import { newId } from '@kadai/shared/ids'
import { Button, Dialog, notify } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { formatMoney } from '@/lib/format'
import { useCancelPayment } from '../api'
import { applyContractErrors, contractResolver } from '../lib/forms'
import { PaymentsField } from './PaymentsField'
import { notifyPaymentError } from '../lib/errors'

interface Values {
  reason: string
}

export function CancelPaymentDialog({
  payment,
  onOpenChange,
  onCancelled,
}: {
  payment: PaymentDetail | null
  onOpenChange: (open: boolean) => void
  onCancelled?: (payment: PaymentDetail) => void
}) {
  if (!payment) return null
  return <CancelBody payment={payment} onOpenChange={onOpenChange} onCancelled={onCancelled} />
}

function CancelBody({
  payment,
  onOpenChange,
  onCancelled,
}: {
  payment: PaymentDetail
  onOpenChange: (open: boolean) => void
  onCancelled?: (payment: PaymentDetail) => void
}) {
  const { t } = useTranslation(['payments', 'common'])
  const formId = useRef(`cancel-${newId()}`).current
  const cancel = useCancelPayment()
  const form = useForm<Values>({
    defaultValues: { reason: '' },
    resolver: contractResolver<Values>(PaymentCancelSchema, (v): PaymentCancel => ({
      reason: v.reason,
    })),
  })
  const onSubmit = form.handleSubmit((values) => {
    cancel.mutate(
      { params: { id: payment.id }, body: { reason: values.reason.trim() } },
      {
        onSuccess: (res) => {
          notify.success(t('cancel.done_toast', { number: res.data.number ?? '' }))
          onCancelled?.(res.data)
          onOpenChange(false)
        },
        onError: (error) => {
          if (!applyContractErrors(error, form.setError, ['reason'])) notifyPaymentError(error)
        },
      },
    )
  })
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!cancel.isPending) onOpenChange(o)
      }}
      size="sm"
      title={t(payment.direction === 'in' ? 'cancel.title_receipt' : 'cancel.title_voucher', {
        number: payment.number ?? '',
      })}
      description={t('cancel.hint', { amount: formatMoney(payment.amount_paise) })}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>
            {t('cancel.keep')}
          </Button>
          <Button variant="danger" type="submit" form={formId} loading={cancel.isPending}>
            {t('cancel.confirm')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} onSubmit={onSubmit} noValidate>
          <PaymentsField name="reason" label={t('cancel.reason')} required>
            <Textarea
              autoFocus
              rows={3}
              maxLength={500}
              placeholder={t('cancel.reason_placeholder')}
              {...form.register('reason')}
            />
          </PaymentsField>
        </form>
      </FormProvider>
    </Dialog>
  )
}
