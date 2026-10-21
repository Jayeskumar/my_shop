/**
 * "Send due reminder" — POST /customers/:id/remind (notifications contract; customers.write).
 * For the parties pages (customer list / khata) and anywhere a due is shown:
 *
 *   <SendReminderDialog open={open} onOpenChange={setOpen} customer={customer} summary={summary} />
 *
 * Without `customer` the dialog starts with a customer search (customers with a due).
 * Channels: WhatsApp or SMS through the shop's sending service (plan feature `notifications`;
 * WhatsApp also needs the customer's consent), or "My WhatsApp" (wa_me: works on every plan —
 * the server returns the text and a wa.me link that opens WhatsApp on this device). The preview
 * renders the due_reminder template in the chosen language (Tamil / English) with the shared
 * renderNotification; after sending, the server's own text replaces it. A UPI payment link can
 * be added (payments module, created by the server). One Idempotency-Key per customer and
 * dialog session makes a double tap safe.
 */
import {
  CheckCircle2,
  Copy,
  MessageCircle,
  MessageSquareText,
  Send,
  Smartphone,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type CustomerRemindResult,
  type RemindChannel,
  renderNotification,
  smsSegments,
} from '@kadai/shared/api/notifications'
import type { CustomerListItem, CustomerSummary } from '@kadai/shared/api/parties'
import type { Locale } from '@kadai/shared/enums'
import { addDays, diffDays, todayIn } from '@kadai/shared/fy'
import { newId } from '@kadai/shared/ids'
import { isValidIndianMobile } from '@kadai/shared/phone'
import { CustomerPicker } from '@/components/pickers'
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
import { useCan, useFeature, useMe } from '@/lib/auth'
import { copyToClipboard } from '@/lib/clipboard'
import { formatDateTime, formatMoney, formatPhone } from '@/lib/format'
import { useCustomerSummary, useRemindCustomer } from '../api'
import { errorReason, reasonText } from '../lib/messages'
import { shopNameFor } from '../lib/templates'
import { MessageBubble } from './MessageBubble'

/** The customer fields the dialog needs (a CustomerListItem or Customer fits). */
export type ReminderCustomer = Pick<
  CustomerListItem,
  'id' | 'name' | 'name_ta' | 'phone' | 'balance_paise' | 'whatsapp_opt_in'
>

export type ReminderSummary = Pick<
  CustomerSummary,
  'oldest_due_date' | 'credit_days' | 'overdue_paise' | 'overdue_invoice_count'
>

export interface SendReminderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The customer to remind; omit to pick one in the dialog. */
  customer?: ReminderCustomer | null
  /** Khata summary when the page already has it (else it is fetched for the preview). */
  summary?: ReminderSummary | null
  /** Called after the reminder was queued / prepared. */
  onSent?: (result: CustomerRemindResult) => void
}

export function SendReminderDialog(props: SendReminderDialogProps) {
  if (!props.open) return null
  return <ReminderBody {...props} />
}

function displayName(c: Pick<ReminderCustomer, 'name' | 'name_ta'>, language: string): string {
  return language !== 'en' && c.name_ta ? c.name_ta : c.name
}

function ReminderBody({
  onOpenChange,
  customer: given,
  summary: givenSummary,
  onSent,
}: SendReminderDialogProps) {
  const { t } = useTranslation(['notifications', 'common'])
  const [picked, setPicked] = useState<ReminderCustomer | null>(null)
  const customer = given ?? picked
  const close = (): void => onOpenChange(false)

  return customer ? (
    <ReminderForm
      key={customer.id}
      customer={customer}
      summary={givenSummary ?? null}
      onClose={close}
      onSent={onSent}
      onChangeCustomer={given ? undefined : () => setPicked(null)}
    />
  ) : (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('reminder.title_pick')}
      size="md"
      footer={
        <Button variant="outline" onClick={close}>
          {t('common:actions.cancel')}
        </Button>
      }
    >
      <FormField label={t('reminder.customer')}>
        <CustomerPicker
          value={null}
          onChange={(c) => setPicked(c)}
          filters={{ has_due: true }}
          placeholder={t('reminder.customer_placeholder')}
          aria-label={t('reminder.customer')}
        />
      </FormField>
    </Dialog>
  )
}

function ReminderForm({
  customer,
  summary: givenSummary,
  onClose,
  onSent,
  onChangeCustomer,
}: {
  customer: ReminderCustomer
  summary: ReminderSummary | null
  onClose: () => void
  onSent?: (result: CustomerRemindResult) => void
  onChangeCustomer?: () => void
}) {
  const { t, i18n } = useTranslation(['notifications', 'common', 'errors'])
  const me = useMe()
  const hasFeature = useFeature('notifications')
  const canSend = useCan('customers.write')
  const fetched = useCustomerSummary(customer.id, !givenSummary)
  const summary: ReminderSummary | null = givenSummary ?? fetched.data?.data ?? null
  const name = displayName(customer, i18n.language)
  const canWhatsApp = hasFeature && customer.whatsapp_opt_in
  const [channel, setChannel] = useState<RemindChannel>(canWhatsApp ? 'whatsapp' : 'wa_me')
  const [locale, setLocale] = useState<Locale>(me?.tenant.default_locale ?? 'ta')
  const [withLink, setWithLink] = useState(true)
  const due = Math.max(0, customer.balance_paise)
  const [amount, setAmount] = useState<number | null>(due || null)
  const [phone, setPhone] = useState(customer.phone ? formatPhone(customer.phone) : '')
  const [result, setResult] = useState<CustomerRemindResult | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [idempotencyKey] = useState(newId)
  const remind = useRemindCustomer()
  useEffect(() => setFailure(null), [channel, phone, amount, withLink, locale])

  const today = todayIn(me?.tenant.timezone)
  // {{days}} = age of the oldest unpaid bill: the summary gives its due date (bill date + credit
  // days), so step back over the credit days to the bill date.
  const days = summary?.oldest_due_date
    ? Math.max(0, diffDays(addDays(summary.oldest_due_date, -summary.credit_days), today))
    : null

  const previewChannel = channel === 'sms' ? 'sms' : 'whatsapp'
  const preview = useMemo(() => {
    if (result) return result.message
    return (
      renderNotification({
        code: 'due_reminder',
        channel: previewChannel,
        locale,
        params: {
          shop_name: shopNameFor(me?.tenant, locale) ?? '',
          customer_name: locale === 'ta' && customer.name_ta ? customer.name_ta : customer.name,
          due: formatMoney(amount ?? due),
          days: days ?? '…',
          // Placeholders in the message's language, not the screen's.
          link: t(withLink ? 'reminder.link_placeholder' : 'reminder.upi_placeholder', {
            lng: locale,
          }),
          shop_phone: me?.tenant.phone ? formatPhone(me.tenant.phone) : null,
        },
      })?.body ?? ''
    )
  }, [result, previewChannel, locale, me, customer, amount, due, days, withLink, t])
  const sms = channel === 'sms' ? smsSegments(preview) : null

  const phoneDigits = phone.replace(/\D/g, '')
  const phoneValid = phoneDigits === '' ? Boolean(customer.phone) : isValidIndianMobile(phone)
  const amountError =
    amount !== null && amount <= 0
      ? t('reminder.amount_invalid')
      : amount !== null && amount > due
        ? t('reminder.amount_too_much', { amount: formatMoney(due) })
        : null
  const reason = errorReason(failure)

  const send = (): void => {
    if (!phoneValid || amountError || due <= 0 || !canSend) return
    const override =
      phoneDigits && (!customer.phone || phone !== formatPhone(customer.phone)) ? phone : undefined
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
          onSent?.(res.data)
          if (res.data.channel !== 'wa_me') notify.success(t('reminder.queued_toast', { name }))
        },
        onError: (error) => {
          setFailure(error)
          if (!errorReason(error)) notify.error(error)
        },
      },
    )
  }

  const channelOptions = [
    {
      value: 'whatsapp' as const,
      label: t('reminder.channel_whatsapp'),
      description: !hasFeature
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
      description: hasFeature ? t('reminder.channel_sms_hint') : t('reminder.needs_plan'),
      icon: <MessageSquareText />,
      disabled: !hasFeature,
    },
    {
      value: 'wa_me' as const,
      label: t('reminder.channel_wa_me'),
      description: t('reminder.channel_wa_me_hint'),
      icon: <Smartphone />,
    },
  ]

  const copy = async (): Promise<void> => {
    if (await copyToClipboard(preview)) notify.success(t('reminder.copied'))
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !remind.isPending) onClose()
      }}
      title={t('reminder.title', { name })}
      description={t('reminder.description', { amount: formatMoney(due) })}
      size="lg"
      footer={
        result ? (
          <>
            {result.wa_me_url ? (
              <>
                <Button variant="outline" leftIcon={<Copy />} onClick={() => void copy()}>
                  {t('reminder.copy_message')}
                </Button>
                <Button asChild variant="success" size="lg">
                  <a href={result.wa_me_url} target="_blank" rel="noopener noreferrer">
                    <MessageCircle aria-hidden />
                    {t('reminder.open_whatsapp')}
                  </a>
                </Button>
              </>
            ) : null}
            <Button variant={result.wa_me_url ? 'ghost' : 'primary'} onClick={onClose}>
              {t('common:actions.done')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={remind.isPending}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={send}
              loading={remind.isPending}
              disabled={!phoneValid || Boolean(amountError) || due <= 0 || !canSend}
              leftIcon={<Send />}
              size="lg"
            >
              {channel === 'wa_me' ? t('reminder.prepare') : t('reminder.send')}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-5 pb-1 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="grid min-w-0 content-start gap-4">
          {result ? (
            <div className="flex items-start gap-2 rounded-lg bg-success-soft p-3 text-sm text-success-soft-foreground">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {result.channel === 'wa_me' ? t('reminder.ready_wa_me') : t('reminder.queued')}
                {result.link ? ` ${t('reminder.link_created')}` : ''}
              </span>
            </div>
          ) : due <= 0 ? (
            <p className="rounded-lg bg-surface-2 p-3 text-sm">{t('reminder.no_due')}</p>
          ) : (
            <>
              {onChangeCustomer ? (
                <Button
                  variant="link"
                  size="sm"
                  className="justify-self-start"
                  onClick={onChangeCustomer}
                >
                  {t('reminder.customer')}: {name}
                </Button>
              ) : null}
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
                      { value: 'ta', label: t('language.ta') },
                      { value: 'en', label: t('language.en') },
                    ]}
                    aria-label={t('reminder.language')}
                  />
                </FormField>
                <FormField label={t('reminder.amount')} error={amountError}>
                  <MoneyInput value={amount} onChange={setAmount} />
                </FormField>
                <FormField
                  label={t('reminder.send_to')}
                  hint={customer.phone ? undefined : t('reminder.no_phone')}
                  error={!phoneValid ? t('errors:validation.phone') : undefined}
                >
                  <Input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
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
              {failure && reason ? (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger-soft-foreground sm:flex-row sm:items-center sm:justify-between"
                >
                  <span>{reasonText(failure)}</span>
                  {reason === 'channel_not_configured' || reason === 'whatsapp_opt_out' ? (
                    <Button size="sm" variant="outline" onClick={() => setChannel('wa_me')}>
                      {t('reminder.use_wa_me')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          {summary && summary.overdue_invoice_count > 0 && !result ? (
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
        <figure className="grid min-w-0 content-start gap-2">
          <figcaption className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('reminder.preview')} · {t(`language.${locale}`)}
          </figcaption>
          <MessageBubble
            channel={previewChannel}
            body={preview}
            locale={result?.notification?.locale ?? locale}
            testId="reminder-preview"
            footer={sms ? t('reminder.sms_parts', { count: sms.segments }) : null}
          />
        </figure>
      </div>
    </Dialog>
  )
}
