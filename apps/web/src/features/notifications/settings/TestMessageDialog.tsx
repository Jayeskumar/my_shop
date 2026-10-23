/**
 * "Send a test" from a provider card: queues an ad-hoc template (the welcome message) with
 * sample details to the owner's own number / email through POST /notifications/send, so the
 * shop can check that the channel really delivers. The result is followed in the message log.
 */
import { CheckCircle2, Send } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  type Notification,
  type NotificationTemplateCode,
  normalizeRecipient,
  renderNotification,
} from '@kadai/shared/api/notifications'
import type { Locale, NotificationChannel } from '@kadai/shared/enums'
import { Button, Dialog, FormField, Input, RadioGroup, notify } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { formatPhone } from '@/lib/format'
import { useSendNotification } from '../api'
import { MessageBubble } from '../components/MessageBubble'
import { channelLabel, templateLabel, uiLocale } from '../lib/labels'
import { fieldErrorsOf, notifyNotificationError } from '../lib/messages'
import { sampleParams } from '../lib/templates'

export function TestMessageDialog({
  channel,
  template,
  onOpenChange,
}: {
  channel: NotificationChannel | null
  template: NotificationTemplateCode | null
  onOpenChange: (open: boolean) => void
}) {
  if (!channel || !template) return null
  return <TestBody channel={channel} template={template} onOpenChange={onOpenChange} />
}

function TestBody({
  channel,
  template,
  onOpenChange,
}: {
  channel: NotificationChannel
  template: NotificationTemplateCode
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation(['notifications', 'common'])
  const me = useMe()
  const send = useSendNotification()
  const email = channel === 'email'
  const [to, setTo] = useState(() =>
    email ? (me?.user.email ?? '') : me?.user.phone ? formatPhone(me.user.phone) : '',
  )
  const [locale, setLocale] = useState<Locale>(uiLocale(i18n.language))
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [sent, setSent] = useState<Notification | null>(null)
  useEffect(() => setServerError(null), [to])

  const params = useMemo(() => {
    const p = sampleParams(template, locale, null, me?.tenant ?? null)
    if ('customer_name' in p && me?.user.full_name) p.customer_name = me.user.full_name
    return p
  }, [template, locale, me])
  const preview = renderNotification({ code: template, channel, locale, params })
  const valid = normalizeRecipient(channel, to) !== null
  const toError =
    serverError ??
    (touched && !valid
      ? t(email ? 'validation.recipient_email' : 'validation.recipient_phone')
      : null)

  const submit = (): void => {
    setTouched(true)
    if (!valid) return
    send.mutate(
      {
        body: {
          channel,
          template_code: template,
          to,
          recipient_name: me?.user.full_name ?? null,
          locale,
          params,
        },
      },
      {
        onSuccess: (res) => {
          setSent(res.data)
          notify.success(t('test.queued'))
        },
        onError: (error) => {
          const fields = fieldErrorsOf(error)
          if (fields.to) setServerError(fields.to)
          else notifyNotificationError(error)
        },
      },
    )
  }

  const channelName = channelLabel(channel, i18n.language)
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!send.isPending) onOpenChange(o)
      }}
      title={t('test.title', { channel: channelName })}
      description={t('test.description', { template: templateLabel(template, i18n.language) })}
      size="lg"
      footer={
        sent ? (
          <>
            <Button asChild variant="outline">
              <Link to={`/notifications?id=${encodeURIComponent(sent.id)}`}>
                {t('test.open_log')}
              </Link>
            </Button>
            <Button onClick={() => onOpenChange(false)}>{t('common:actions.done')}</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>
              {t('common:actions.cancel')}
            </Button>
            <Button leftIcon={<Send />} onClick={submit} loading={send.isPending} size="lg">
              {t('test.send')}
            </Button>
          </>
        )
      }
    >
      <form
        className="grid gap-5 md:grid-cols-[1fr_minmax(0,18rem)]"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="grid content-start gap-4">
          {sent ? (
            <p className="flex items-start gap-2 rounded-lg bg-success-soft p-3 text-sm text-success-soft-foreground">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('test.queued')}
            </p>
          ) : (
            <>
              <FormField label={email ? t('test.to_email') : t('test.to')} error={toError} required>
                <Input
                  type={email ? 'email' : 'tel'}
                  inputMode={email ? 'email' : 'tel'}
                  autoComplete={email ? 'email' : 'tel'}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onBlur={() => setTouched(true)}
                  size="lg"
                />
              </FormField>
              <FormField label={t('test.language')}>
                <RadioGroup<Locale>
                  value={locale}
                  onValueChange={setLocale}
                  orientation="horizontal"
                  options={[
                    { value: 'ta', label: t('language.ta') },
                    { value: 'en', label: t('language.en') },
                  ]}
                  aria-label={t('test.language')}
                />
              </FormField>
            </>
          )}
        </div>
        {preview ? (
          <MessageBubble
            channel={channel}
            body={preview.body}
            subject={preview.subject}
            locale={locale}
            testId="test-preview"
          />
        ) : null}
      </form>
    </Dialog>
  )
}
