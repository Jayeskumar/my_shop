/**
 * Send a purchase order to the supplier (POST /purchase-orders/:id/send). The common way works on
 * every plan and on-prem without any setup: mark the order sent and share the message from this
 * phone / PC with WhatsApp (wa.me link). Shops with the notifications feature can let Kadai send
 * it by WhatsApp Business or SMS. "Only mark as sent" is for orders placed by phone.
 */
import type { PurchaseOrderDetail } from '@kadai/shared/api/purchases'
import { normalizeIndianPhone } from '@kadai/shared/phone'
import { CheckCircle2, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, CopyButton, Dialog, FormField, Input, RadioGroup, notify } from '@/components/ui'
import { useFeature } from '@/lib/auth'
import { formatPhone } from '@/lib/format'
import { useSendOrder } from '../api'
import { notifyPurchasesError } from '../lib/errors'

type Via = 'share' | 'whatsapp' | 'sms' | 'none'

export interface SendOrderDialogProps {
  order: Pick<PurchaseOrderDetail, 'id' | 'number' | 'supplier'>
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SendOrderDialog({ order, open, onOpenChange }: SendOrderDialogProps) {
  const { t } = useTranslation(['purchases', 'common'])
  const notifications = useFeature('notifications')
  const send = useSendOrder()
  const [via, setVia] = useState<Via>('share')
  const [phone, setPhone] = useState('')
  const [message, setMessage] = useState('')
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    message: string
    wa_me_url: string | null
    queued: boolean
  } | null>(null)

  useEffect(() => {
    if (!open) return
    setVia('share')
    setPhone(order.supplier.phone ? formatPhone(order.supplier.phone) : '')
    setMessage('')
    setPhoneError(null)
    setResult(null)
  }, [open, order.supplier.phone])

  const options = [
    { value: 'share' as const, label: t('send.via_share'), description: t('send.via_share_hint') },
    ...(notifications
      ? [
          {
            value: 'whatsapp' as const,
            label: t('send.via_whatsapp'),
            description: t('send.via_whatsapp_hint'),
          },
          { value: 'sms' as const, label: t('send.via_sms'), description: t('send.via_sms_hint') },
        ]
      : []),
    { value: 'none' as const, label: t('send.via_none'), description: t('send.via_none_hint') },
  ]

  const submit = (): void => {
    const trimmed = phone.trim()
    const normalized = trimmed ? normalizeIndianPhone(trimmed) : null
    if (trimmed && !normalized) {
      setPhoneError(t('send.phone_invalid'))
      return
    }
    if ((via === 'whatsapp' || via === 'sms') && !normalized) {
      setPhoneError(t('send.phone_required'))
      return
    }
    setPhoneError(null)
    send.mutate(
      {
        params: { id: order.id },
        body: {
          via: via === 'whatsapp' || via === 'sms' ? via : null,
          ...(normalized && normalized !== order.supplier.phone ? { phone: normalized } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
        },
      },
      {
        onSuccess: (res) => {
          if (via === 'none') {
            notify.success(t('send.marked_sent', { number: order.number }))
            onOpenChange(false)
            return
          }
          setResult({
            message: res.data.message,
            wa_me_url: res.data.wa_me_url,
            queued: res.data.notification_id !== null,
          })
        },
        onError: notifyPurchasesError,
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !send.isPending && onOpenChange(o)}
      title={t('send.title', { number: order.number })}
      description={t('send.description', { name: order.supplier.name })}
      dismissible={!send.isPending}
      footer={
        result ? (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.done')}
            </Button>
            {result.wa_me_url && !result.queued ? (
              <Button variant="success" leftIcon={<MessageCircle />} asChild>
                <a href={result.wa_me_url} target="_blank" rel="noreferrer">
                  {t('send.open_whatsapp')}
                </a>
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button variant="outline" disabled={send.isPending} onClick={() => onOpenChange(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button loading={send.isPending} onClick={submit}>
              {via === 'none' ? t('send.mark_sent') : t('send.confirm')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="grid gap-3">
          <p role="status" className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCircle2 className="size-5" aria-hidden />
            {result.queued ? t('send.queued') : t('send.ready_to_share')}
          </p>
          <div className="relative rounded-lg border border-border bg-surface-2/60 p-3">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm">
              {result.message}
            </pre>
            <CopyButton value={result.message} className="absolute end-2 top-2" />
          </div>
          {!result.wa_me_url && !result.queued ? (
            <p className="text-sm text-muted-foreground">{t('send.no_phone_copy')}</p>
          ) : null}
        </div>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <RadioGroup
            value={via}
            onValueChange={(v) => setVia(v)}
            options={options}
            variant="cards"
            aria-label={t('send.how')}
          />
          {via !== 'none' ? (
            <>
              <FormField
                label={t('send.phone')}
                hint={t('send.phone_hint')}
                error={phoneError}
                required={via === 'whatsapp' || via === 'sms'}
                optional={via === 'share'}
              >
                <Input
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  maxLength={16}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </FormField>
              <FormField
                label={t('send.extra_message')}
                optional
                hint={t('send.extra_message_hint')}
              >
                <Input
                  value={message}
                  maxLength={500}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </FormField>
            </>
          ) : null}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      )}
    </Dialog>
  )
}
