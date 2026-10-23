/**
 * Share an invoice on WhatsApp / SMS (POST /sales/invoices/:id/share): the server makes the
 * public link /i/<token> and queues the `invoice_share` message when the plan has notifications.
 * For WhatsApp it also returns a wa.me link with the same text, which works on every plan — we
 * open it so the shopkeeper can send from their own WhatsApp. The link can also be copied.
 */
import { MessageSquareText, Send } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InvoiceShareSchema, type InvoiceShareResult } from '@kadai/shared/api/sales'
import { normalizeIndianPhone } from '@kadai/shared/phone'
import { Button, CopyButton, Dialog, FormField, Input, RadioGroup, notify } from '@/components/ui'
import { useFeature } from '@/lib/auth'
import { formatPhone } from '@/lib/format'
import { getLanguage, type Language } from '@/lib/i18n'
import { useShareInvoice } from '../api'
import { serverIssue, useValidationText } from '../lib/forms'

type Channel = 'whatsapp' | 'sms'

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceId: string
  customerPhone: string | null
  shareUrl: string | null
}

/** Mounted only while open, so every opening starts from a clean form. */
export function ShareDialog(props: ShareDialogProps) {
  return props.open ? <ShareDialogBody {...props} /> : null
}

function ShareDialogBody({
  open,
  onOpenChange,
  invoiceId,
  customerPhone,
  shareUrl,
}: ShareDialogProps) {
  const { t } = useTranslation(['sales', 'common'])
  const vt = useValidationText()
  const notifications = useFeature('notifications')
  const share = useShareInvoice()
  const [channel, setChannel] = useState<Channel>('whatsapp')
  const [phone, setPhone] = useState(customerPhone ? formatPhone(customerPhone) : '')
  const [locale, setLocale] = useState<Language>(getLanguage())
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [result, setResult] = useState<InvoiceShareResult | null>(null)
  const phoneRef = useRef<HTMLInputElement>(null)

  const submit = (): void => {
    const e164 = normalizeIndianPhone(phone)
    if (!e164) {
      setPhoneError(t('share.phone_invalid'))
      phoneRef.current?.focus()
      return
    }
    const body = { channel, phone: e164, locale }
    const parsed = InvoiceShareSchema.safeParse(body)
    if (!parsed.success) {
      setPhoneError(vt(parsed.error.issues[0]?.message) ?? t('share.phone_invalid'))
      return
    }
    setPhoneError(null)
    share.mutate(
      { params: { id: invoiceId }, body },
      {
        onSuccess: (res) => {
          setResult(res.data)
          if (res.data.wa_me_url) {
            window.open(res.data.wa_me_url, '_blank', 'noopener,noreferrer')
          }
          if (res.data.notification_id) {
            notify.success(
              t(channel === 'sms' ? 'share.sms_queued' : 'share.whatsapp_queued', {
                phone: formatPhone(e164),
              }),
            )
          }
        },
        onError: (error) => {
          const issue = serverIssue(error, 'phone')
          if (issue) setPhoneError(vt(issue) ?? t('share.phone_invalid'))
          else notify.error(error)
        },
      },
    )
  }

  const link = result?.url ?? shareUrl

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('share.title')}
      description={t('share.description')}
      footer={
        result ? (
          <Button onClick={() => onOpenChange(false)}>{t('common:actions.done')}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button leftIcon={<Send />} loading={share.isPending} onClick={submit}>
              {channel === 'whatsapp' ? t('share.send_whatsapp') : t('share.send_sms')}
            </Button>
          </>
        )
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <RadioGroup<Channel>
          aria-label={t('share.channel')}
          variant="cards"
          orientation="horizontal"
          value={channel}
          onValueChange={setChannel}
          options={[
            { value: 'whatsapp', label: t('share.whatsapp'), icon: <Send /> },
            {
              value: 'sms',
              label: t('share.sms'),
              icon: <MessageSquareText />,
              disabled: !notifications,
              description: notifications ? undefined : t('share.sms_needs_plan'),
            },
          ]}
        />
        <FormField label={t('share.phone')} error={phoneError} required>
          <Input
            ref={phoneRef}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="98765 43210"
            startAdornment={<span className="text-sm text-muted-foreground">+91</span>}
          />
        </FormField>
        <RadioGroup<Language>
          aria-label={t('share.language')}
          orientation="horizontal"
          value={locale}
          onValueChange={setLocale}
          options={[
            { value: 'ta', label: 'தமிழ்' },
            { value: 'en', label: 'English' },
          ]}
        />
        {result ? (
          <div className="rounded-md border border-success/40 bg-success-soft p-3 text-sm text-success-soft-foreground">
            <p className="font-medium">
              {result.wa_me_url ? t('share.whatsapp_opened') : t('share.sent')}
            </p>
            <p className="mt-1 whitespace-pre-line text-xs">{result.message}</p>
          </div>
        ) : null}
        {link ? (
          <div className="flex items-center gap-2 rounded-md bg-surface-2 p-2 text-sm">
            <span className="min-w-0 flex-1 truncate" title={link}>
              {link}
            </span>
            <CopyButton value={link} label={t('share.copy_link')} />
          </div>
        ) : null}
      </form>
    </Dialog>
  )
}
