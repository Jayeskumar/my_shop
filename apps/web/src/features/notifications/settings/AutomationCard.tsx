/**
 * "Automatic messages": the settings.notifications toggles (NOTIFICATION_SETTING_TOGGLES —
 * WhatsApp / SMS bill sharing, due reminders with day chips 7/15/30/45/60, the owner's daily
 * summary, the low-stock digest) saved through PATCH /settings (identity contract) with only
 * the changed fields. Each toggle names the messages it uses and warns when none of its
 * channels has a live sending service. Business-wide: store-scoped members see it read-only.
 */
import { BellRing, CalendarClock, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsPatch } from '@kadai/shared/api/identity'
import {
  DUE_REMINDER_MIN_GAP_DAYS,
  NOTIFICATION_SETTING_TOGGLES,
  type NotificationProviderStatus,
} from '@kadai/shared/api/notifications'
import type { NotificationChannel } from '@kadai/shared/enums'
import { DEFAULT_SETTINGS } from '@kadai/shared/settings'
import { Switch, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useUpdateNotificationSettings } from '../api'
import { bilingual, channelLabel, templateLabel } from '../lib/labels'
import { fieldErrorsOf, notifyNotificationError } from '../lib/messages'
import { type NotificationSettings, notificationsPatch } from '../lib/settings'
import { SaveBar, UnsavedChangesGuard } from './SaveBar'
import { SettingsSection } from './SettingsSection'

type ToggleKey = keyof NotificationSettings

/** Channels each automatic message can go out on (for the "not set up" warning). */
const TOGGLE_CHANNELS: Readonly<Record<ToggleKey, readonly NotificationChannel[]>> = {
  whatsapp_invoice: ['whatsapp'],
  sms_invoice: ['sms'],
  due_reminder_days: ['whatsapp', 'sms'],
  daily_summary_to_owner: ['whatsapp', 'sms', 'email'],
  low_stock_digest: ['whatsapp', 'email'],
}

interface FormState {
  whatsapp_invoice: boolean
  sms_invoice: boolean
  due_on: boolean
  due_days: number[]
  daily_summary_to_owner: boolean
  low_stock_digest: boolean
}

function toForm(s: NotificationSettings): FormState {
  return {
    whatsapp_invoice: s.whatsapp_invoice,
    sms_invoice: s.sms_invoice,
    due_on: s.due_reminder_days.length > 0,
    due_days: [...s.due_reminder_days].sort((a, b) => a - b),
    daily_summary_to_owner: s.daily_summary_to_owner,
    low_stock_digest: s.low_stock_digest,
  }
}

function toSettings(f: FormState): NotificationSettings {
  return {
    whatsapp_invoice: f.whatsapp_invoice,
    sms_invoice: f.sms_invoice,
    due_reminder_days: f.due_on ? [...f.due_days].sort((a, b) => a - b) : [],
    daily_summary_to_owner: f.daily_summary_to_owner,
    low_stock_digest: f.low_stock_digest,
  }
}

export function AutomationCard({
  settings,
  providers,
  canEdit,
  storeScoped,
}: {
  settings: NotificationSettings
  providers: readonly NotificationProviderStatus[]
  canEdit: boolean
  storeScoped: boolean
}) {
  const { t, i18n } = useTranslation(['notifications', 'common'])
  const update = useUpdateNotificationSettings()
  const [form, setForm] = useState<FormState>(() => toForm(settings))
  const saved = useRef<NotificationSettings>(settings)
  const [serverError, setServerError] = useState<string | null>(null)

  // Adopt fresh server settings unless the user is in the middle of editing.
  const settingsJson = JSON.stringify(settings)
  const dirtyRef = useRef(false)
  useEffect(() => {
    if (dirtyRef.current) return
    saved.current = settings
    setForm(toForm(settings))
    // settingsJson captures the value; settings itself is a new object per render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsJson])

  const current = toSettings(form)
  const patch = notificationsPatch(saved.current, current)
  const dirty = patch !== null
  dirtyRef.current = dirty
  const daysMissing = form.due_on && form.due_days.length === 0

  const live = useMemo(
    () => new Set(providers.filter((p) => p.live).map((p) => p.channel)),
    [providers],
  )

  const set = (next: Partial<FormState>): void => {
    setServerError(null)
    setForm((f) => ({ ...f, ...next }))
  }

  const save = (): void => {
    if (!patch || daysMissing || !canEdit) return
    update.mutate(
      { body: { notifications: patch } as SettingsPatch },
      {
        onSuccess: (res) => {
          saved.current = res.data.settings.notifications
          dirtyRef.current = false
          setForm(toForm(res.data.settings.notifications))
          notify.success(t('settings.saved'))
        },
        onError: (error) => {
          const fields = fieldErrorsOf(error)
          const first = Object.values(fields)[0]
          if (first) setServerError(first)
          else if (isApiError(error) && error.details?.reason === 'all_stores_required')
            setServerError(t('settings.store_scoped'))
          else notifyNotificationError(error)
        },
      },
    )
  }

  const options = useMemo(() => {
    const base =
      NOTIFICATION_SETTING_TOGGLES.find((x) => x.key === 'due_reminder_days')?.options ?? []
    return [...new Set([...base, ...form.due_days])].sort((a, b) => a - b)
  }, [form.due_days])

  const warning = (key: ToggleKey): string | null => {
    const channels = TOGGLE_CHANNELS[key]
    if (channels.some((c) => live.has(c))) return null
    return t('settings.channel_not_live', {
      channel: channels.map((c) => channelLabel(c, i18n.language)).join(' / '),
    })
  }

  return (
    <SettingsSection
      id="automation"
      icon={<BellRing />}
      title={t('settings.automation_title')}
      description={t('settings.automation_hint')}
    >
      {storeScoped ? (
        <p
          role="note"
          className="rounded-lg border border-info/30 bg-info-soft px-3 py-2.5 text-sm text-info-soft-foreground"
        >
          {t('settings.store_scoped')}
        </p>
      ) : null}
      <ul className="grid divide-y divide-border">
        {NOTIFICATION_SETTING_TOGGLES.map((toggle) => {
          const uses = t('settings.uses', {
            templates: toggle.templates.map((c) => templateLabel(c, i18n.language)).join(', '),
          })
          const isOn =
            toggle.key === 'due_reminder_days'
              ? form.due_on
              : Boolean(form[toggle.key as Exclude<ToggleKey, 'due_reminder_days'>])
          const warn = isOn ? warning(toggle.key) : null
          return (
            <li key={toggle.key} className="grid gap-3 py-4 first:pt-1 last:pb-1">
              <Switch
                size="lg"
                checked={isOn}
                disabled={!canEdit || update.isPending}
                onCheckedChange={(on) => {
                  if (toggle.key === 'due_reminder_days') {
                    set({
                      due_on: on,
                      due_days:
                        on && form.due_days.length === 0
                          ? [...DEFAULT_SETTINGS.notifications.due_reminder_days]
                          : form.due_days,
                    })
                  } else set({ [toggle.key]: on } as Partial<FormState>)
                }}
                label={bilingual(toggle.label, i18n.language)}
                description={
                  <>
                    {bilingual(toggle.description, i18n.language)}
                    <span className="mt-0.5 block text-[11px] opacity-80">{uses}</span>
                  </>
                }
              />
              {toggle.key === 'due_reminder_days' ? (
                form.due_on ? (
                  <div className="grid gap-2 rounded-lg bg-surface-2 px-3 py-3">
                    <p
                      id="due-days-label"
                      className="flex items-center gap-1.5 text-sm font-medium"
                    >
                      <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
                      {t('settings.due_days_label')}
                    </p>
                    <div
                      role="group"
                      aria-labelledby="due-days-label"
                      className="flex flex-wrap gap-2"
                    >
                      {options.map((d) => {
                        const pressed = form.due_days.includes(d)
                        return (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={pressed}
                            disabled={!canEdit || update.isPending}
                            onClick={() =>
                              set({
                                due_days: pressed
                                  ? form.due_days.filter((x) => x !== d)
                                  : [...form.due_days, d].sort((a, b) => a - b),
                              })
                            }
                            className={cn(
                              'inline-flex h-10 min-w-20 items-center justify-center rounded-full border px-4 text-sm font-medium tabular-nums transition-colors',
                              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60',
                              pressed
                                ? 'border-primary bg-primary text-primary-foreground shadow-card'
                                : 'border-input bg-surface text-foreground hover:border-primary/60',
                            )}
                          >
                            {t('settings.day_chip', { count: d })}
                          </button>
                        )
                      })}
                    </div>
                    {daysMissing ? (
                      <p className="text-xs text-danger" role="alert">
                        {t('settings.due_days_required')}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t('settings.due_days_note', { gap: DUE_REMINDER_MIN_GAP_DAYS })}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('settings.due_off_hint')}</p>
                )
              ) : null}
              {warn ? (
                <p className="flex items-start gap-1.5 text-xs text-warning-soft-foreground">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                  {warn}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
      {serverError ? (
        <p className="text-sm text-danger" role="alert">
          {serverError}
        </p>
      ) : null}
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        onSave={save}
        onDiscard={() => {
          setServerError(null)
          setForm(toForm(saved.current))
        }}
        disabled={daysMissing || !canEdit}
      />
      <UnsavedChangesGuard dirty={dirty} />
    </SettingsSection>
  )
}
