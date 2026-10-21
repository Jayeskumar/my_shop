/**
 * Editor of one message text (code × channel × language): subject (email), body with tap-to-
 * insert placeholder chips (required ones marked), the provider template id the channel needs
 * (SMS: DLT template id; WhatsApp: the Meta-approved template name), "use this text" switch,
 * and a live preview rendered by the shared renderNotification with sample details — exactly as
 * the sender delivers it — plus SMS parts and the text to register with DLT / Meta. The same
 * checks as the server run before saving; "Back to standard" removes the override (confirmed).
 */
import { RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type NotificationProviderStatus,
  type NotificationTemplateEntry,
  dltTemplateText,
  isTemplateCode,
  renderNotification,
  smsSegments,
  whatsappTemplateText,
} from '@kadai/shared/api/notifications'
import type { BilingualLabel } from '@kadai/shared/api/identity'
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  FormField,
  Input,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/format'
import { useResetTemplate, useUpsertTemplate } from '../api'
import { MessageBubble } from '../components/MessageBubble'
import { bilingual, channelLabel, placeholderLabel } from '../lib/labels'
import { fieldErrorsOf, notifyNotificationError, validationText } from '../lib/messages'
import {
  type OverrideField,
  type OverrideIssue,
  type ShopNames,
  insertPlaceholder,
  overrideIssues,
  sampleParams,
} from '../lib/templates'

export function TemplateEditorDialog({
  entry,
  provider,
  shop,
  dltNote,
  onClose,
}: {
  entry: NotificationTemplateEntry | null
  provider: NotificationProviderStatus | undefined
  shop: ShopNames | null
  dltNote: BilingualLabel
  onClose: () => void
}) {
  if (!entry || !isTemplateCode(entry.code)) return null
  return (
    <EditorBody
      key={`${entry.code}|${entry.channel}|${entry.locale}`}
      entry={entry}
      provider={provider}
      shop={shop}
      dltNote={dltNote}
      onClose={onClose}
    />
  )
}

interface Draft {
  subject: string
  body: string
  provider_template_id: string
  is_active: boolean
}

function draftOf(entry: NotificationTemplateEntry): Draft {
  return {
    subject: entry.subject ?? '',
    body: entry.body,
    provider_template_id: entry.provider_template_id ?? '',
    is_active: entry.is_active,
  }
}

function EditorBody({
  entry,
  provider,
  shop,
  dltNote,
  onClose,
}: {
  entry: NotificationTemplateEntry
  provider: NotificationProviderStatus | undefined
  shop: ShopNames | null
  dltNote: BilingualLabel
  onClose: () => void
}) {
  const { t, i18n } = useTranslation(['notifications', 'common'])
  const confirm = useConfirm()
  const upsert = useUpsertTemplate()
  const reset = useResetTemplate()
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const initial = useMemo(() => draftOf(entry), [entry])
  const [draft, setDraft] = useState<Draft>(initial)
  const [attempted, setAttempted] = useState(false)
  const [serverErrors, setServerErrors] = useState<Partial<Record<OverrideField, string>>>({})
  const code = entry.code
  const channel = entry.channel
  const isEmail = channel === 'email'
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const busy = upsert.isPending || reset.isPending

  const issues = overrideIssues({
    code,
    channel,
    body: draft.body,
    subject: isEmail ? draft.subject : null,
    provider_template_id: draft.provider_template_id || null,
  })
  const issuesAt = (path: OverrideField): OverrideIssue[] => issues.filter((i) => i.path === path)
  const unknown = issuesAt('body').filter((i) => i.code === 'unknown_placeholder')
  const missing = issuesAt('body').filter((i) => i.code === 'missing_required_placeholder')
  const bodyMessage = (): string | null => {
    if (serverErrors.body) return serverErrors.body
    if (unknown.length)
      return t('editor.unknown', { list: unknown.map((i) => `{{${i.placeholder}}}`).join(', ') })
    if (missing.length)
      return t('editor.missing', {
        list: missing.map((i) => placeholderLabel(i.placeholder ?? '')).join(', '),
      })
    const other = issuesAt('body')[0]
    if (!other) return null
    if (other.code === 'template_syntax')
      return t('editor.syntax', { example: '{{customer_name}}' })
    if (other.code === 'body_too_long') return t('editor.too_long', { max: entry.max_length })
    return validationText(other.code) ?? other.code
  }
  const fieldMessage = (path: OverrideField): string | null => {
    if (serverErrors[path]) return serverErrors[path] ?? null
    const first = issuesAt(path)[0]
    return first ? (validationText(first.code) ?? first.code) : null
  }
  // Text problems show while typing; a missing id / subject only after the first save attempt.
  const bodyError = bodyMessage()
  const subjectError = attempted || serverErrors.subject ? fieldMessage('subject') : null
  const idError =
    attempted || serverErrors.provider_template_id || draft.provider_template_id
      ? fieldMessage('provider_template_id')
      : null

  const params = useMemo(
    () => sampleParams(code, entry.locale, entry.sample, shop),
    [code, entry.locale, entry.sample, shop],
  )
  const preview = renderNotification({
    code,
    channel,
    locale: entry.locale,
    params,
    override: {
      subject: isEmail ? draft.subject || null : null,
      body: draft.body,
      provider_template_id: draft.provider_template_id || null,
      is_active: true,
    },
  })
  const length = Array.from(draft.body).length
  const sms = channel === 'sms' && preview ? smsSegments(preview.body) : null

  const change = (patch: Partial<Draft>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setServerErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch)) delete next[k as OverrideField]
      return next
    })
  }

  const insert = (key: string): void => {
    const el = bodyRef.current
    const start = el?.selectionStart ?? draft.body.length
    const end = el?.selectionEnd ?? start
    const next = insertPlaceholder(draft.body, key, start, end)
    change({ body: next.text })
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  const close = async (): Promise<void> => {
    if (busy) return
    if (dirty) {
      const ok = await confirm({
        title: t('editor.discard_title'),
        description: t('editor.discard_description'),
        tone: 'danger',
        confirmLabel: t('common:actions.continue'),
      })
      if (!ok) return
    }
    onClose()
  }

  const save = (): void => {
    setAttempted(true)
    if (issues.length || !dirty) return
    upsert.mutate(
      {
        params: { code, channel, locale: entry.locale },
        body: {
          subject: isEmail ? draft.subject.trim() || null : null,
          body: draft.body,
          provider_template_id: draft.provider_template_id.trim() || null,
          is_active: draft.is_active,
        },
      },
      {
        onSuccess: () => {
          notify.success(t('editor.saved'))
          onClose()
        },
        onError: (error) => {
          const fields = fieldErrorsOf(error)
          if (Object.keys(fields).length) {
            setServerErrors(fields as Partial<Record<OverrideField, string>>)
            const details = isApiError(error) ? error.details : undefined
            const unknownList = details?.unknown_placeholders
            if (Array.isArray(unknownList) && unknownList.length)
              setServerErrors((e) => ({
                ...e,
                body: t('editor.unknown', {
                  list: unknownList.map((p) => `{{${String(p)}}}`).join(', '),
                }),
              }))
          } else notifyNotificationError(error)
        },
      },
    )
  }

  const askReset = async (): Promise<void> => {
    const ok = await confirm({
      title: t('editor.reset_title'),
      description: t('editor.reset_description'),
      confirmLabel: t('editor.reset'),
      tone: 'danger',
    })
    if (!ok) return
    reset.mutate(
      { params: { code, channel, locale: entry.locale } },
      {
        onSuccess: () => {
          notify.success(t('editor.reset_done'))
          onClose()
        },
        onError: notifyNotificationError,
      },
    )
  }

  const idLabel =
    channel === 'sms'
      ? t('editor.provider_id_sms')
      : channel === 'whatsapp'
        ? t('editor.provider_id_whatsapp')
        : t('editor.provider_id_email')
  const idHint =
    channel === 'sms'
      ? t('editor.provider_id_sms_hint')
      : channel === 'whatsapp'
        ? t('editor.provider_id_whatsapp_hint')
        : t('editor.provider_id_email_hint')
  const usedKeys = new Set(
    Array.from(draft.body.matchAll(/\{\{\s*[#^/]?\s*([a-z][a-z0-9_]*)\s*\}\}/g), (m) => m[1]),
  )
  const registerText =
    channel === 'sms'
      ? dltTemplateText(draft.body)
      : channel === 'whatsapp'
        ? whatsappTemplateText(draft.body)
        : null
  const relay = provider?.provider === 'kadai_relay'

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) void close()
      }}
      dismissible={!dirty}
      size="xl"
      title={bilingual(entry.label, i18n.language)}
      description={t('editor.subtitle', {
        channel: channelLabel(channel, i18n.language),
        language: t(`language.${entry.locale}`),
      })}
      footer={
        <>
          {entry.is_override ? (
            <Button
              variant="ghost"
              leftIcon={<RotateCcw />}
              onClick={() => void askReset()}
              loading={reset.isPending}
              disabled={upsert.isPending}
              className="sm:me-auto"
            >
              {t('editor.reset')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => void close()} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            leftIcon={<Save />}
            onClick={save}
            loading={upsert.isPending}
            disabled={!dirty || reset.isPending || (attempted && issues.length > 0)}
            size="lg"
          >
            {t('editor.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="grid min-w-0 content-start gap-4">
          {entry.is_override && entry.override_updated_at ? (
            <p className="text-xs text-muted-foreground">
              {t('editor.changed_on', { date: formatDate(entry.override_updated_at) })}
            </p>
          ) : null}
          {isEmail ? (
            <FormField label={t('editor.subject')} error={subjectError} required>
              <Input
                value={draft.subject}
                onChange={(e) => change({ subject: e.target.value })}
                lang={entry.locale}
                maxLength={200}
              />
            </FormField>
          ) : null}
          <FormField
            label={t('editor.body')}
            error={bodyError}
            hint={t('editor.body_hint')}
            required
            labelAction={
              <span
                className={cn(
                  'text-xs tabular-nums',
                  length > entry.max_length ? 'text-danger' : 'text-muted-foreground',
                )}
              >
                {t('editor.length', { length, max: entry.max_length })}
              </span>
            }
          >
            <Textarea
              ref={bodyRef}
              value={draft.body}
              onChange={(e) => change({ body: e.target.value })}
              rows={isEmail ? 10 : 7}
              lang={entry.locale}
              spellCheck={false}
              className="font-[inherit] leading-relaxed"
            />
          </FormField>
          <div className="grid gap-2">
            <p className="text-sm font-medium">{t('editor.placeholders')}</p>
            <ul className="flex flex-wrap gap-2">
              {entry.placeholders.map((p) => {
                const used = usedKeys.has(p.key)
                return (
                  <li key={p.key}>
                    <button
                      type="button"
                      onClick={() => insert(p.key)}
                      className={cn(
                        'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        used
                          ? 'border-primary/40 bg-primary-soft text-primary-soft-foreground'
                          : 'border-input bg-surface hover:border-primary/60',
                        p.required && !used && 'border-danger/50',
                      )}
                      title={`{{${p.key}}}`}
                    >
                      <span>{placeholderLabel(p.key)}</span>
                      {p.required ? (
                        <span className="text-danger" aria-label={t('editor.required')}>
                          *
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <FormField
            label={idLabel}
            hint={
              <>
                {idHint}
                {entry.default_provider_template_id ? (
                  <span className="mt-0.5 block font-mono">
                    {t('editor.standard_id', { id: entry.default_provider_template_id })}
                  </span>
                ) : null}
              </>
            }
            error={idError}
            required={channel !== 'email'}
            optional={channel === 'email'}
          >
            <Input
              value={draft.provider_template_id}
              onChange={(e) => change({ provider_template_id: e.target.value })}
              className="font-mono"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </FormField>
          <Switch
            checked={draft.is_active}
            onCheckedChange={(v) => change({ is_active: v })}
            label={t('editor.active')}
            description={t('editor.active_hint')}
          />
          {draft.body !== entry.default_body ||
          (isEmail && draft.subject !== (entry.default_subject ?? '')) ? (
            <Button
              variant="link"
              size="sm"
              className="justify-self-start"
              onClick={() =>
                change({ body: entry.default_body, subject: entry.default_subject ?? '' })
              }
            >
              {t('editor.use_standard')}
            </Button>
          ) : null}
        </div>

        <aside className="grid min-w-0 content-start gap-3" aria-label={t('editor.preview')}>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">{t('editor.preview')}</h3>
            <span className="text-xs text-muted-foreground">{t('editor.preview_hint')}</span>
          </div>
          {preview ? (
            <MessageBubble
              channel={channel}
              body={preview.body}
              subject={preview.subject}
              locale={entry.locale}
              testId="template-preview"
              footer={
                sms ? (
                  <span className="grid gap-0.5">
                    <span className="tabular-nums">
                      {t('editor.sms_parts', { length: sms.length, count: sms.segments })}
                    </span>
                    {sms.encoding === 'unicode' && sms.segments > 1 ? (
                      <span>{t('editor.sms_unicode')}</span>
                    ) : null}
                  </span>
                ) : null
              }
            />
          ) : null}
          {channel === 'sms' ? (
            <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-warning-soft-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{bilingual(dltNote, i18n.language)}</span>
            </p>
          ) : null}
          {relay ? (
            <p className="rounded-lg bg-info-soft px-3 py-2.5 text-xs text-info-soft-foreground">
              {t('settings.relay_hint')}
            </p>
          ) : null}
          {registerText ? (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold">
                  {channel === 'sms' ? t('editor.register_dlt') : t('editor.register_meta')}
                </p>
                <CopyButton value={registerText} />
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2.5 font-mono text-xs leading-relaxed">
                {registerText}
              </pre>
            </div>
          ) : null}
          {draft.is_active ? null : (
            <Badge tone="warning" className="justify-self-start">
              {t('settings.template_paused')}
            </Badge>
          )}
        </aside>
      </div>
    </Dialog>
  )
}
