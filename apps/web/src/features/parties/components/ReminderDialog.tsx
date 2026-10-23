/**
 * "Send reminder" — POST /customers/:id/remind (notifications contract). Channels: WhatsApp or
 * SMS through Kadai (plan feature `notifications`; WhatsApp also needs the customer's consent),
 * or "My WhatsApp" (wa_me: works on every plan, opens WhatsApp on this device with the text).
 * The preview renders the default due_reminder template in the chosen language with the shared
 * renderNotification; after sending, the server's rendered text replaces it.
 */
import { CheckCircle2, MessageCircle, MessageSquareText, Send, Smartphone } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type CustomerRemindResult,
  type RemindChannel,
  renderNotification,
} from '@kadai/shared/api/notifications'
import type { Customer, CustomerSummary } from '@kadai/shared/api/parties'
import type { Locale } from '@kadai/shared/enums'
import { addDays, diffDays, todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { isValidIndianMobile } from '@kadai/shared/phone'
import {
  Button,
  Dialog,
  FormField,
  Input,
  MoneyInput,
  RadioGroup,
  Switch,
  notify,
} from '@/components/ui'
import { useFeature, useMe } from '@/lib/auth'
import { formatDateTime, formatMoney, formatPhone } from '@/lib/format'
import { useRemindCustomer } from '../api'
import { partyNames } from '../lib/labels'

export function ReminderDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: Customer
  summary: CustomerSummary | undefined
}) {
  if (!props.open) return null
  return <ReminderBody {...props} />
}

function ReminderBody({
  onOpenChange,
  customer,
  summary,
}: {
  onOpenChange: (open: boolean) => void
  customer: Customer
  summary: CustomerSummary | undefined
}) {
  const { t, i18n } = useTranslation(['parties', 'common', 'errors'])
  const me = useMe()
  const displayName = partyNames(customer.name, customer.name_ta, i18n.language).primary
  const notifications = useFeature('notifications')
  const canWhatsApp = notifications && customer.whatsapp_opt_in
  const [channel, setChannel] = useState<RemindChannel>(canWhatsApp ? 'whatsapp' : 'wa_me')
  const [locale, setLocale] = useState<Locale>(me?.tenant.default_locale ?? 'ta')
  const [withLink, setWithLink] = useState(true)
  const due = Math.max(0, customer.balance_paise)
  const [amount, setAmount] = useState<number | null>(due || null)
  const [phone, setPhone] = useState(customer.phone ? formatPhone(customer.phone) : '')
  const [result, setResult] = useState<CustomerRemindResult | null>(null)
  const idempotencyKey = useRef(newId()).current
  const remind = useRemindCustomer()

  const today = todayIn(me?.tenant.timezone)
  // {{days}} is the age of the oldest unpaid bill: the summary gives its due date (bill date +
  // credit days), so step back over the credit days to the bill date.
  const days = summary?.oldest_due_date
    ? Math.max(0, diffDays(addDays(summary.oldest_due_date, -summary.credit_days), today))
    : 0
  const tenant = me?.tenant
  const preview =
    result?.message ??
    renderNotification({
      code: 'due_reminder',
      channel: channel === 'sms' ? 'sms' : 'whatsapp',
      locale,
      params: {
        shop_name: tenant ? (locale === 'ta' && tenant.name_ta ? tenant.name_ta : tenant.name) : '',
        customer_name: locale === 'ta' && customer.name_ta ? customer.name_ta : customer.name,
        due: formatMoney(amount ?? due),
        days,
        link: withLink ? t('reminder.link_placeholder') : t('reminder.upi_placeholder'),
        shop_phone: tenant?.phone ? formatPhone(tenant.phone) : null,
      },
    })?.body ??
    ''

  const phoneDigits = phone.replace(/\D/g, '')
  const phoneValid = phoneDigits === '' ? Boolean(customer.phone) : isValidIndianMobile(phone)
  const amountInvalid = amount !== null && amount <= 0

  const send = (): void => {
    const override = phone && phone !== formatPhone(customer.phone) ? phone : undefined
    remind.mutate(
      {
        params: { id: customer.id },
        body: {
          channel,
          locale,
          include_payment_link: withLink,
          ...(amount && amount !== due ? { amount_paise: amount } : {}),
          ...(override ? { phone: override } : {}),
        },
        idempotencyKey,
      },
      {
        onSuccess: (res) => {
          setResult(res.data)
          if (res.data.channel !== 'wa_me') {
            notify.success(t('reminder.queued_toast', { name: displayName }))
          }
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  const channelOptions = [
    {
      value: 'whatsapp' as const,
      label: t('reminder.channel_whatsapp'),
      description: !notifications
        ? t('reminder.needs_plan')
        : !customer.whatsapp_opt_in
          ? t('reminder.no_consent')
          : t('reminder.channel_whatsapp_hint'),
      icon: <MessageCircle />,
      disabled: !canWhatsApp,
    },
    {
      value: 'sms' as const,
      label: t('reminder.channel_sms'),
      description: notifications ? t('reminder.channel_sms_hint') : t('reminder.needs_plan'),
      icon: <MessageSquareText />,
      disabled: !notifications,
    },
    {
      value: 'wa_me' as const,
      label: t('reminder.channel_wa_me'),
      description: t('reminder.channel_wa_me_hint'),
      icon: <Smartphone />,
    },
  ]

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!remind.isPending) onOpenChange(o)
      }}
      title={t('reminder.title', { name: displayName })}
      description={t('reminder.description', { amount: formatMoney(due) })}
      size="lg"
      footer={
        result ? (
          <>
            {result.wa_me_url ? (
              <Button asChild variant="success" size="lg">
                <a href={result.wa_me_url} target="_blank" rel="noopener noreferrer">
                  <MessageCircle aria-hidden />
                  {t('reminder.open_whatsapp')}
                </a>
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.done')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={remind.isPending}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={send}
              loading={remind.isPending}
              disabled={!phoneValid || amountInvalid || due <= 0}
              leftIcon={<Send />}
              size="lg"
            >
              {channel === 'wa_me' ? t('reminder.prepare') : t('reminder.send')}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-5 pb-2 md:grid-cols-[1fr_minmax(0,18rem)]">
        <div className="grid content-start gap-4">
          {result ? (
            <div className="flex items-start gap-2 rounded-lg bg-success-soft p-3 text-sm text-success-soft-foreground">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {result.channel === 'wa_me' ? t('reminder.ready_wa_me') : t('reminder.queued')}
                {result.link ? ` ${t('reminder.link_created')}` : ''}
              </span>
            </div>
          ) : (
            <>
              <RadioGroup
                value={channel}
                onValueChange={setChannel}
                options={channelOptions}
                variant="cards"
                aria-label={t('reminder.channel')}
              />
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <FormField label={t('reminder.language')} className="sm:col-span-2">
                  <RadioGroup<Locale>
                    value={locale}
                    onValueChange={setLocale}
                    orientation="horizontal"
                    options={[
                      { value: 'ta', label: 'தமிழ்' },
                      { value: 'en', label: 'English' },
                    ]}
                    aria-label={t('reminder.language')}
                  />
                </FormField>
                <FormField
                  label={t('reminder.amount')}
                  error={amountInvalid ? t('reminder.amount_invalid') : undefined}
                >
                  <MoneyInput value={amount} onChange={setAmount} />
                </FormField>
                <FormField
                  label={t('reminder.send_to')}
                  hint={customer.phone ? undefined : t('reminder.no_phone')}
                  error={!phoneValid ? t('errors:validation.phone') : undefined}
                  className="sm:col-span-2"
                >
                  <Input
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </FormField>
              </div>
              <Switch
                checked={withLink}
                onCheckedChange={setWithLink}
                label={t('reminder.include_link')}
                description={t('reminder.include_link_hint')}
              />
            </>
          )}
          {summary && summary.overdue_invoice_count > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('reminder.overdue_info', {
                count: summary.overdue_invoice_count,
                amount: formatMoney(summary.overdue_paise),
              })}
            </p>
          ) : null}
          {result?.last_reminded_at ? (
            <p className="text-xs text-muted-foreground">
              {t('reminder.last_reminded', { when: formatDateTime(result.last_reminded_at) })}
            </p>
          ) : null}
        </div>
        <figure className="grid content-start gap-2">
          <figcaption className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('reminder.preview')}
          </figcaption>
          <div className="rounded-xl bg-success-soft/60 p-3">
            <p
              lang={locale}
              className="whitespace-pre-wrap rounded-lg rounded-tl-none bg-surface p-3 text-sm leading-relaxed shadow-card"
              data-testid="reminder-preview"
            >
              {preview}
            </p>
          </div>
        </figure>
      </div>
    </Dialog>
  )
}
