/**
 * "Payment link" — POST /payments/links (payments contract): a link for the customer's dues
 * (provider link, or the Kadai pay page with a UPI deep link). Optionally sent by WhatsApp / SMS;
 * the result shows the link, a QR to scan from the counter screen, copy and wa.me share.
 */
import QRCode from 'qrcode'
import { CheckCircle2, ExternalLink, Link2, MessageCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaymentLinkResult } from '@kadai/shared/api/payments'
import type { Customer } from '@kadai/shared/api/parties'
import { newId } from '@kadai/shared/ids'
import { StorePicker } from '@/components/pickers'
import {
  Button,
  CopyButton,
  Dialog,
  FormField,
  Input,
  MoneyInput,
  RadioGroup,
  Select,
  notify,
} from '@/components/ui'
import { useCurrentStore, useFeature, useMe } from '@/lib/auth'
import { formatDateTime, formatMoney } from '@/lib/format'
import { useCreatePaymentLink } from '../api'

type SendVia = 'none' | 'whatsapp' | 'sms'
const EXPIRY_HOURS = [24, 72, 168, 720] as const

export function PaymentLinkDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: Customer
}) {
  if (!props.open) return null
  return <LinkBody {...props} />
}

function LinkBody({
  onOpenChange,
  customer,
}: {
  onOpenChange: (open: boolean) => void
  customer: Customer
}) {
  const { t } = useTranslation(['parties', 'common'])
  const me = useMe()
  const currentStore = useCurrentStore()
  const notifications = useFeature('notifications')
  const due = Math.max(0, customer.balance_paise)
  const [amount, setAmount] = useState<number | null>(due || null)
  const [sendVia, setSendVia] = useState<SendVia>('none')
  const [hours, setHours] = useState<(typeof EXPIRY_HOURS)[number]>(72)
  const [note, setNote] = useState('')
  const [storeId, setStoreId] = useState<string | null>(
    currentStore?.id ?? me?.stores[0]?.id ?? null,
  )
  const [result, setResult] = useState<PaymentLinkResult | null>(null)
  const idempotencyKey = useRef(newId()).current
  const create = useCreatePaymentLink()
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1

  const submit = (): void => {
    if (!storeId) return
    create.mutate(
      {
        body: {
          customer_id: customer.id,
          store_id: storeId,
          ...(amount && amount !== due ? { amount_paise: amount } : {}),
          send_via: sendVia === 'none' ? null : sendVia,
          expires_in_hours: hours,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        idempotencyKey,
      },
      {
        onSuccess: (res) => {
          setResult(res.data)
          notify.success(res.data.notification_id ? t('link.sent_toast') : t('link.created_toast'))
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!create.isPending) onOpenChange(o)
      }}
      title={t('link.title')}
      description={t('link.description', { name: customer.name })}
      size="md"
      footer={
        result ? (
          <Button onClick={() => onOpenChange(false)}>{t('common:actions.done')}</Button>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={submit}
              loading={create.isPending}
              disabled={
                !storeId || (amount !== null && amount <= 0) || (amount === null && due <= 0)
              }
              leftIcon={<Link2 />}
            >
              {t('link.create')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <LinkResult result={result} />
      ) : (
        <div className="grid gap-4 pb-2 [&>*]:min-w-0">
          <FormField
            label={t('link.amount')}
            hint={t('link.amount_hint', { amount: formatMoney(due) })}
          >
            <MoneyInput value={amount} onChange={setAmount} size="lg" autoFocus />
          </FormField>
          {multiStore ? (
            <FormField label={t('payment.store')}>
              <StorePicker value={storeId} onChange={(id) => setStoreId(id)} clearable={false} />
            </FormField>
          ) : null}
          <FormField label={t('link.send_via')}>
            <RadioGroup<SendVia>
              value={sendVia}
              onValueChange={setSendVia}
              orientation="horizontal"
              options={[
                { value: 'none', label: t('link.send_none') },
                {
                  value: 'whatsapp',
                  label: t('link.send_whatsapp'),
                  disabled: !notifications || !customer.whatsapp_opt_in || !customer.phone,
                },
                {
                  value: 'sms',
                  label: t('link.send_sms'),
                  disabled: !notifications || !customer.phone,
                },
              ]}
              aria-label={t('link.send_via')}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <FormField label={t('link.expires')}>
              <Select
                value={String(hours)}
                onValueChange={(v) => setHours(Number(v) as (typeof EXPIRY_HOURS)[number])}
                options={EXPIRY_HOURS.map((h) => ({
                  value: String(h),
                  label: t(`link.expiry_${h}`),
                }))}
              />
            </FormField>
            <FormField label={t('link.note')} optional>
              <Input value={note} maxLength={50} onChange={(e) => setNote(e.target.value)} />
            </FormField>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function LinkResult({ result }: { result: PaymentLinkResult }) {
  const { t } = useTranslation('parties')
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(result.url, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      .then((src) => {
        if (alive) setQr(src)
      })
      .catch(() => setQr(null))
    return () => {
      alive = false
    }
  }, [result.url])

  return (
    <div className="grid gap-4 pb-2 [&>*]:min-w-0">
      <div className="flex items-start gap-2 rounded-lg bg-success-soft p-3 text-sm text-success-soft-foreground">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {t('link.ready', { amount: formatMoney(result.intent.amount_paise) })}
          {result.intent.expires_at
            ? ` ${t('link.valid_till', { when: formatDateTime(result.intent.expires_at) })}`
            : ''}
        </span>
      </div>
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        {qr ? (
          <img
            src={qr}
            alt={t('link.qr_alt')}
            className="size-44 shrink-0 rounded-lg border border-border bg-white p-1"
          />
        ) : null}
        <div className="grid w-full min-w-0 gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm" title={result.url}>
              {result.url}
            </span>
            <CopyButton value={result.url} />
          </div>
          <div className="flex flex-wrap gap-2">
            {result.wa_me_url ? (
              <Button asChild variant="success">
                <a href={result.wa_me_url} target="_blank" rel="noopener noreferrer">
                  <MessageCircle aria-hidden />
                  {t('link.share_whatsapp')}
                </a>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <a href={result.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
                {t('link.open')}
              </a>
            </Button>
          </div>
          <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-xs text-muted-foreground">
            {result.message}
          </p>
        </div>
      </div>
    </div>
  )
}
