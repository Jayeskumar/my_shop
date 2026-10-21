/**
 * Template catalogue: the code-defined defaults (NOTIFICATION_TEMPLATES, ta & en per channel)
 * merged with the tenant's overrides (notification_templates), plus the provider status cards and
 * settings.notifications for the same settings page.
 *
 * PUT validates an override with templateBodyIssues() (syntax, placeholders known to the
 * template, required placeholders, length, e-mail subject) and the provider rules: an SMS text is
 * only delivered when registered with DLT, so an SMS override needs its DLT / MSG91 template id;
 * a WhatsApp override needs the name of its own approved Meta template (the body parameters
 * follow the override's placeholder order). DELETE drops the override (back to the default).
 * Changes are audited.
 */
import { type Locale, type NotificationChannel, type ValidationIssue } from '@kadai/shared'
import {
  DLT_NOTE,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_CODES,
  type NotificationTemplateCatalog,
  type NotificationTemplateCode,
  type NotificationTemplateEntry,
  type NotificationTemplateListQuerySchema,
  type NotificationTemplateUpsertSchema,
  PROVIDER_TEMPLATE_ID_RE,
  WHATSAPP_TEMPLATE_NAME_RE,
  templateBodyIssues,
  templatePlaceholderKeys,
} from '@kadai/shared/api/notifications'
import type { z } from 'zod'
import type { Config } from '../../config'
import { audit, diffChanges } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { AppError, validationError } from '../../core/errors'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import type { Tx } from '../../db/tenant'
import { iso } from './common'
import { installNotificationProviders, providerStatuses } from './providers'

type ListQuery = z.output<typeof NotificationTemplateListQuerySchema>
type Upsert = z.output<typeof NotificationTemplateUpsertSchema>

const LOCALES: readonly Locale[] = ['ta', 'en']

export interface OverrideRow {
  code: string
  channel: string
  locale: string
  subject: string | null
  body: string
  provider_template_id: string | null
  is_active: boolean
  updated_at: Date
}

function defaultProviderTemplateId(
  config: Pick<Config, 'sms'>,
  code: NotificationTemplateCode,
  channel: NotificationChannel,
): string | null {
  if (channel === 'sms') return config.sms.msg91.templateIds[code] ?? null
  if (channel === 'whatsapp') return NOTIFICATION_TEMPLATES[code].whatsapp_template
  return null
}

/** One catalogue entry (null when the template has no text for the channel). */
export function templateEntry(
  config: Pick<Config, 'sms'>,
  code: NotificationTemplateCode,
  channel: NotificationChannel,
  locale: Locale,
  override: OverrideRow | null,
): NotificationTemplateEntry | null {
  const def = NOTIFICATION_TEMPLATES[code]
  if (!def.channels.includes(channel)) return null
  const text = def.defaults[locale][channel] ?? def.defaults.en[channel]
  if (!text) return null
  const active = Boolean(override?.is_active)
  return {
    code,
    channel,
    locale,
    label: def.label,
    description: def.description,
    audience: def.audience,
    subject: active && override ? override.subject : (text.subject ?? null),
    body: active && override ? override.body : text.body,
    provider_template_id: override?.provider_template_id ?? null,
    is_active: override ? override.is_active : true,
    is_override: override !== null,
    override_updated_at: override ? iso(override.updated_at) : null,
    default_subject: text.subject ?? null,
    default_body: text.body,
    default_provider_template_id: defaultProviderTemplateId(config, code, channel),
    placeholders: templatePlaceholderKeys(code).map((key) => ({
      key,
      required: def.required.includes(key),
    })),
    sample: def.sample[locale],
    max_length: NOTIFICATION_BODY_MAX[channel],
  }
}

async function overrides(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  filter: Partial<{ code: string; channel: string; locale: string }> = {},
): Promise<OverrideRow[]> {
  let q = tx
    .selectFrom('notification_templates')
    .select([
      'code',
      'channel',
      'locale',
      'subject',
      'body',
      'provider_template_id',
      'is_active',
      'updated_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
  if (filter.code) q = q.where('code', '=', filter.code)
  if (filter.channel) q = q.where('channel', '=', filter.channel)
  if (filter.locale) q = q.where('locale', '=', filter.locale)
  return q.execute()
}

const key = (code: string, channel: string, locale: string) => `${code}|${channel}|${locale}`

/** GET /notification-templates */
export async function listTemplates(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  deps: Pick<KadaiDeps, 'config' | 'logger'>,
  q: ListQuery,
): Promise<NotificationTemplateCatalog> {
  const registry = installNotificationProviders(deps.config, deps.logger)
  const byKey = new Map(
    (await overrides(tx, ctx, q)).map((o) => [key(o.code, o.channel, o.locale), o] as const),
  )
  const templates: NotificationTemplateEntry[] = []
  for (const code of NOTIFICATION_TEMPLATE_CODES) {
    if (q.code && q.code !== code) continue
    for (const channel of NOTIFICATION_TEMPLATES[code].channels) {
      if (q.channel && q.channel !== channel) continue
      for (const locale of LOCALES) {
        if (q.locale && q.locale !== locale) continue
        const e = templateEntry(
          deps.config,
          code,
          channel,
          locale,
          byKey.get(key(code, channel, locale)) ?? null,
        )
        if (e) templates.push(e)
      }
    }
  }
  const settings = await getSettings(tx, ctx)
  return {
    templates,
    providers: providerStatuses(registry),
    settings: settings.notifications,
    dlt_note: DLT_NOTE,
  }
}

/** The provider-template rules of an override (beyond templateBodyIssues). */
function providerTemplateIssues(
  channel: NotificationChannel,
  id: string | null,
): ValidationIssue[] {
  const path = 'provider_template_id'
  if (channel === 'sms' && !id)
    return [{ path, message: 'dlt_template_id_required', code: 'dlt_template_id_required' }]
  if (channel === 'whatsapp' && !id)
    return [{ path, message: 'whatsapp_template_required', code: 'whatsapp_template_required' }]
  if (!id) return []
  const ok =
    channel === 'whatsapp' ? WHATSAPP_TEMPLATE_NAME_RE.test(id) : PROVIDER_TEMPLATE_ID_RE.test(id)
  return ok
    ? []
    : [{ path, message: 'provider_template_id_invalid', code: 'provider_template_id_invalid' }]
}

/** PUT /notification-templates/:code/:channel/:locale */
export async function upsertTemplate(
  tx: Tx,
  ctx: RequestContext,
  config: Pick<Config, 'sms'>,
  params: { code: NotificationTemplateCode; channel: NotificationChannel; locale: Locale },
  body: Upsert,
): Promise<NotificationTemplateEntry> {
  const subject = params.channel === 'email' ? (body.subject ?? null) : null
  const providerTemplateId = body.provider_template_id ?? null
  const bodyIssues = templateBodyIssues({
    code: params.code,
    channel: params.channel,
    body: body.body,
    subject,
  })
  const issues: ValidationIssue[] = bodyIssues.map((i) => ({
    path: i.path,
    message: i.code,
    code: i.code,
  }))
  issues.push(...providerTemplateIssues(params.channel, providerTemplateId))
  if (issues.length) {
    const placeholders = (code: string) =>
      bodyIssues.filter((i) => i.code === code && i.placeholder).map((i) => i.placeholder!)
    // details.issues as usual, plus which placeholders are unknown / missing (for the editor).
    throw new AppError('VALIDATION_ERROR', 'The template text is not valid', {
      issues,
      unknown_placeholders: placeholders('unknown_placeholder'),
      missing_placeholders: placeholders('missing_required_placeholder'),
    })
  }

  const [before] = await overrides(tx, ctx, params)
  const now = new Date()
  const row = await tx
    .insertInto('notification_templates')
    .values({
      tenant_id: ctx.tenantId,
      code: params.code,
      channel: params.channel,
      locale: params.locale,
      subject,
      body: body.body,
      provider_template_id: providerTemplateId,
      is_active: body.is_active,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'code', 'channel', 'locale']).doUpdateSet({
        subject,
        body: body.body,
        provider_template_id: providerTemplateId,
        is_active: body.is_active,
        updated_at: now,
      }),
    )
    .returning([
      'code',
      'channel',
      'locale',
      'subject',
      'body',
      'provider_template_id',
      'is_active',
      'updated_at',
    ])
    .executeTakeFirstOrThrow()
  const after = {
    subject: row.subject,
    body: row.body,
    provider_template_id: row.provider_template_id,
    is_active: row.is_active,
  }
  await audit(tx, ctx, {
    action: 'notification_template.upsert',
    entity_type: 'notification_template',
    summary: `Template ${params.code} / ${params.channel} / ${params.locale} saved`,
    changes: before
      ? diffChanges(
          {
            subject: before.subject,
            body: before.body,
            provider_template_id: before.provider_template_id,
            is_active: before.is_active,
          },
          after,
        )
      : { before: null, after },
  })
  const entry = templateEntry(config, params.code, params.channel, params.locale, row)
  if (!entry)
    throw validationError([
      { path: 'channel', message: 'template_channel', code: 'template_channel' },
    ])
  return entry
}

/** DELETE /notification-templates/:code/:channel/:locale — idempotent; returns the default entry. */
export async function deleteTemplate(
  tx: Tx,
  ctx: RequestContext,
  config: Pick<Config, 'sms'>,
  params: { code: NotificationTemplateCode; channel: NotificationChannel; locale: Locale },
): Promise<NotificationTemplateEntry> {
  const entry = templateEntry(config, params.code, params.channel, params.locale, null)
  if (!entry)
    throw validationError([
      { path: 'channel', message: 'template_channel', code: 'template_channel' },
    ])
  const deleted = await tx
    .deleteFrom('notification_templates')
    .where('tenant_id', '=', ctx.tenantId)
    .where('code', '=', params.code)
    .where('channel', '=', params.channel)
    .where('locale', '=', params.locale)
    .returning(['subject', 'body', 'provider_template_id', 'is_active'])
    .executeTakeFirst()
  if (deleted)
    await audit(tx, ctx, {
      action: 'notification_template.delete',
      entity_type: 'notification_template',
      summary: `Template ${params.code} / ${params.channel} / ${params.locale} back to default`,
      changes: { before: deleted, after: null },
    })
  return entry
}
