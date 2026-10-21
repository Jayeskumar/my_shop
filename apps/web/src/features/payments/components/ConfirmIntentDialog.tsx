/**
 * Manual confirmation of a shop-UPI-ID payment (POST /payments/intents/:id/confirm, upi_vpa
 * only, audited): the cashier saw the money arrive (soundbox, bank SMS, the customer's success
 * screen) and may note the UTR, the payer's UPI ID and a different amount received.
 */
import { useRef } from 'react'
import { Controller, FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type PaymentIntent,
  type PaymentIntentConfirm,
  PaymentIntentConfirmSchema,
} from '@kadai/shared/api/payments'
import { newId } from '@kadai/shared/ids'
import { Button, Dialog, Input, MoneyInput, notify } from '@/components/ui'
import { formatDateTime, formatMoney } from '@/lib/format'
import { useConfirmIntent } from '../api'
import { applyContractErrors, contractResolver, textOrUndefined } from '../lib/forms'
import { PaymentsField } from './PaymentsField'
import { notifyPaymentError } from '../lib/errors'

interface Values {
  utr: string
  payer_vpa: string
  paid_amount_paise: number | null
  note: string
}

const FIELDS = ['utr', 'payer_vpa', 'paid_amount_paise', 'note'] as const

export function ConfirmIntentDialog({
  intent,
  onOpenChange,
  onConfirmed,
}: {
  intent: PaymentIntent | null
  onOpenChange: (open: boolean) => void
  onConfirmed?: (intent: PaymentIntent) => void
}) {
  if (!intent) return null
  return <ConfirmBody intent={intent} onOpenChange={onOpenChange} onConfirmed={onConfirmed} />
}

function toBody(v: Values, intent: PaymentIntent): PaymentIntentConfirm {
  const utr = textOrUndefined(v.utr)
  const vpa = textOrUndefined(v.payer_vpa)
  const note = textOrUndefined(v.note)
  return {
    ...(utr ? { utr } : {}),
    ...(vpa ? { payer_vpa: vpa } : {}),
    ...(v.paid_amount_paise !== null && v.paid_amount_paise !== intent.amount_paise
      ? { paid_amount_paise: v.paid_amount_paise }
      : {}),
    ...(note ? { note } : {}),
  }
}

function ConfirmBody({
  intent,
  onOpenChange,
  onConfirmed,
}: {
  intent: PaymentIntent
  onOpenChange: (open: boolean) => void
  onConfirmed?: (intent: PaymentIntent) => void
}) {
  const { t } = useTranslation(['payments', 'common'])
  const formId = useRef(`confirm-${newId()}`).current
  const confirm = useConfirmIntent()
  const form = useForm<Values>({
    defaultValues: { utr: '', payer_vpa: '', paid_amount_paise: intent.amount_paise, note: '' },
    resolver: contractResolver<Values>(PaymentIntentConfirmSchema, (v) => toBody(v, intent)),
  })
  const onSubmit = form.handleSubmit((values) => {
    confirm.mutate(
      { params: { id: intent.id }, body: toBody(values, intent) },
      {
        onSuccess: (res) => {
          notify.success(t('qr.confirmed_toast', { amount: formatMoney(res.data.amount_paise) }))
          onConfirmed?.(res.data)
          onOpenChange(false)
        },
        onError: (error) => {
          if (!applyContractErrors(error, form.setError, FIELDS)) notifyPaymentError(error)
        },
      },
    )
  })
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!confirm.isPending) onOpenChange(o)
      }}
      size="sm"
      title={t('upi.confirm_title', { amount: formatMoney(intent.amount_paise) })}
      description={t('upi.confirm_hint', {
        code: intent.reference_code,
        time: formatDateTime(intent.created_at),
      })}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirm.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button variant="success" type="submit" form={formId} loading={confirm.isPending}>
            {t('qr.mark_received')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} onSubmit={onSubmit} noValidate className="grid gap-4">
          <PaymentsField name="utr" label={t('fields.utr')} optional hint={t('upi.utr_hint')}>
            <Input
              autoFocus
              inputMode="numeric"
              autoComplete="off"
              maxLength={35}
              {...form.register('utr', { setValueAs: (v: string) => v.replace(/\s+/g, '') })}
            />
          </PaymentsField>
          <PaymentsField name="payer_vpa" label={t('fields.payer_vpa')} optional>
            <Input
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              {...form.register('payer_vpa')}
            />
          </PaymentsField>
          <PaymentsField
            name="paid_amount_paise"
            label={t('upi.amount_received')}
            hint={t('upi.amount_received_hint')}
          >
            <Controller
              control={form.control}
              name="paid_amount_paise"
              render={({ field }) => (
                <MoneyInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
              )}
            />
          </PaymentsField>
          <PaymentsField name="note" label={t('fields.notes')} optional>
            <Input maxLength={200} {...form.register('note')} />
          </PaymentsField>
        </form>
      </FormProvider>
    </Dialog>
  )
}
