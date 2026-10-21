/**
 * "Message texts": the template catalogue as message × channel × language. One tab per channel
 * (WhatsApp / SMS / email); each message shows who it goes to and, per language, whether the
 * standard text or the shop's own text is used. A language button opens the editor. The SMS tab
 * carries the TRAI DLT note (server text in the UI language), the WhatsApp tab the Meta rule.
 */
import { ChevronRight, FileText, Info, ShieldCheck } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  NOTIFICATION_TEMPLATES,
  type NotificationProviderStatus,
  type NotificationTemplateCatalog,
  type NotificationTemplateEntry,
  isTemplateCode,
} from '@kadai/shared/api/notifications'
import { type Locale, type NotificationChannel } from '@kadai/shared/enums'
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useMe } from '@/lib/auth'
import { ChannelIcon } from '../components/ChannelIcon'
import { bilingual, channelLabel } from '../lib/labels'
import { SettingsSection } from './SettingsSection'
import { TemplateEditorDialog } from './TemplateEditorDialog'

const CHANNELS: readonly NotificationChannel[] = ['whatsapp', 'sms', 'email']
const LOCALES: readonly Locale[] = ['ta', 'en']

interface TemplateRow {
  code: string
  first: NotificationTemplateEntry
  byLocale: Partial<Record<Locale, NotificationTemplateEntry>>
}

function rowsFor(templates: readonly NotificationTemplateEntry[], channel: NotificationChannel) {
  const rows = new Map<string, TemplateRow>()
  for (const e of templates) {
    if (e.channel !== channel) continue
    const row = rows.get(e.code) ?? { code: e.code, first: e, byLocale: {} }
    row.byLocale[e.locale] = e
    rows.set(e.code, row)
  }
  return [...rows.values()]
}

export function TemplatesCard({ catalog }: { catalog: NotificationTemplateCatalog }) {
  const { t, i18n } = useTranslation('notifications')
  const me = useMe()
  const [channel, setChannel] = useState<NotificationChannel>('whatsapp')
  const [editing, setEditing] = useState<{
    code: string
    channel: NotificationChannel
    locale: Locale
  } | null>(null)
  const entry = editing
    ? (catalog.templates.find(
        (e) =>
          e.code === editing.code && e.channel === editing.channel && e.locale === editing.locale,
      ) ?? null)
    : null
  const provider = (c: NotificationChannel): NotificationProviderStatus | undefined =>
    catalog.providers.find((p) => p.channel === c)
  const counts = useMemo(
    () =>
      Object.fromEntries(
        CHANNELS.map((c) => [
          c,
          catalog.templates.filter((e) => e.channel === c && e.is_override).length,
        ]),
      ) as Record<NotificationChannel, number>,
    [catalog.templates],
  )

  return (
    <SettingsSection
      id="templates"
      icon={<FileText />}
      title={t('settings.templates_title')}
      description={t('settings.templates_hint')}
    >
      <Tabs
        value={channel}
        onValueChange={(v) => setChannel(v as NotificationChannel)}
        className="min-w-0"
      >
        <TabsList aria-label={t('outbox.channel_filter')}>
          {CHANNELS.map((c) => (
            <TabsTrigger key={c} value={c} className="gap-2">
              <ChannelIcon channel={c} size="sm" />
              {channelLabel(c, i18n.language)}
              {counts[c] > 0 ? (
                <Badge size="sm" tone="primary">
                  {counts[c]}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {CHANNELS.map((c) => {
          const rows = rowsFor(catalog.templates, c)
          const relay = provider(c)?.provider === 'kadai_relay'
          return (
            <TabsContent key={c} value={c} className="grid gap-3">
              {c === 'sms' ? (
                <Note icon={<ShieldCheck />} tone="warning">
                  {bilingual(catalog.dlt_note, i18n.language)}
                </Note>
              ) : null}
              {c === 'whatsapp' && !relay ? (
                <Note icon={<Info />}>{t('editor.whatsapp_note')}</Note>
              ) : null}
              {relay ? <Note icon={<Info />}>{t('settings.relay_hint')}</Note> : null}
              {rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t('settings.no_templates')}
                </p>
              ) : (
                <ul className="grid divide-y divide-border rounded-lg border border-border">
                  {rows.map((row) => (
                    <li
                      key={row.code}
                      className="grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:px-4"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {bilingual(row.first.label, i18n.language)}
                          </span>
                          <Badge size="sm">{t(`audience.${row.first.audience}`)}</Badge>
                          {isTemplateCode(row.code) && !NOTIFICATION_TEMPLATES[row.code].adhoc ? (
                            <Badge size="sm" tone="info">
                              {t('settings.automatic_badge')}
                            </Badge>
                          ) : null}
                          {isTemplateCode(row.code) &&
                          NOTIFICATION_TEMPLATES[row.code].sensitive ? (
                            <Badge size="sm" tone="warning">
                              {t('settings.sensitive_badge')}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {bilingual(row.first.description, i18n.language)}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:flex">
                        {LOCALES.map((locale) => {
                          const e = row.byLocale[locale]
                          if (!e) return null
                          const state = e.is_override
                            ? e.is_active
                              ? 'custom'
                              : 'paused'
                            : 'standard'
                          return (
                            <button
                              key={locale}
                              type="button"
                              onClick={() => setEditing({ code: e.code, channel: c, locale })}
                              aria-label={t('settings.edit_template', {
                                template: bilingual(e.label, i18n.language),
                                language: t(`language.${locale}`),
                              })}
                              className={cn(
                                'flex min-h-12 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-start transition-colors sm:min-w-36',
                                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                                state === 'standard'
                                  ? 'border-input bg-surface hover:border-primary/60'
                                  : 'border-primary/40 bg-primary-soft/40 hover:border-primary',
                              )}
                              data-state={state}
                            >
                              <span className="grid leading-tight">
                                <span className="text-sm font-medium" lang={locale}>
                                  {t(`language.${locale}`)}
                                </span>
                                <span
                                  className={cn(
                                    'text-xs',
                                    state === 'standard' ? 'text-muted-foreground' : 'text-primary',
                                  )}
                                >
                                  {t(
                                    state === 'custom'
                                      ? 'settings.template_custom'
                                      : state === 'paused'
                                        ? 'settings.template_paused'
                                        : 'settings.template_standard',
                                  )}
                                </span>
                              </span>
                              <ChevronRight
                                className="size-4 shrink-0 text-muted-foreground rtl:rotate-180"
                                aria-hidden
                              />
                            </button>
                          )
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          )
        })}
      </Tabs>
      <TemplateEditorDialog
        entry={entry}
        provider={entry ? provider(entry.channel) : undefined}
        shop={me?.tenant ?? null}
        dltNote={catalog.dlt_note}
        onClose={() => setEditing(null)}
      />
    </SettingsSection>
  )
}

function Note({
  icon,
  tone = 'info',
  children,
}: {
  icon: ReactNode
  tone?: 'info' | 'warning'
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm leading-relaxed',
        tone === 'warning'
          ? 'bg-warning-soft text-warning-soft-foreground'
          : 'bg-info-soft text-info-soft-foreground',
      )}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4" aria-hidden>
        {icon}
      </span>
      <span>{children}</span>
    </p>
  )
}
