/**
 * Template-editor logic shared by the settings screens and their tests: sample details for the
 * live preview (with the shop's own name), the same override checks the server runs on PUT
 * (templateBodyIssues() plus the provider-template rules), and placeholder insertion at the
 * cursor.
 */
import {
  NOTIFICATION_TEMPLATES,
  type NotificationParams,
  type NotificationTemplateCode,
  PROVIDER_TEMPLATE_ID_RE,
  WHATSAPP_TEMPLATE_NAME_RE,
  templateBodyIssues,
} from '@kadai/shared/api/notifications'
import type { Locale, NotificationChannel } from '@kadai/shared/enums'

export interface ShopNames {
  name: string
  name_ta: string | null
}

/** The shop's name in a message language (Tamil name for Tamil messages when there is one). */
export function shopNameFor(shop: ShopNames | null | undefined, locale: Locale): string | null {
  if (!shop) return null
  return locale === 'ta' && shop.name_ta ? shop.name_ta : shop.name
}

/** Sample params of a template for previews, with `shop_name` replaced by the real shop name. */
export function sampleParams(
  code: NotificationTemplateCode,
  locale: Locale,
  sample: NotificationParams | null | undefined,
  shop: ShopNames | null | undefined,
): NotificationParams {
  const base: NotificationParams = { ...(sample ?? NOTIFICATION_TEMPLATES[code].sample[locale]) }
  const name = shopNameFor(shop, locale)
  if (name && 'shop_name' in base) base.shop_name = name
  return base
}

export type OverrideField = 'body' | 'subject' | 'provider_template_id' | 'channel'

export interface OverrideIssue {
  path: OverrideField
  /** A NOTIFICATIONS_VALIDATION_KEYS key (or 'whatsapp_template_name' for a bad Meta name). */
  code: string
  placeholder?: string
}

/** What PUT /notification-templates/... would reject, checked before sending. */
export function overrideIssues(input: {
  code: NotificationTemplateCode
  channel: NotificationChannel
  body: string
  subject: string | null
  provider_template_id: string | null
}): OverrideIssue[] {
  const issues: OverrideIssue[] = templateBodyIssues({
    code: input.code,
    channel: input.channel,
    body: input.body,
    subject: input.channel === 'email' ? input.subject : null,
  }).map((i) => ({
    path: i.path as OverrideField,
    code: i.code,
    ...(i.placeholder ? { placeholder: i.placeholder } : {}),
  }))
  const id = input.provider_template_id?.trim() ?? ''
  const path = 'provider_template_id' as const
  if (input.channel === 'sms' && !id) issues.push({ path, code: 'dlt_template_id_required' })
  else if (input.channel === 'whatsapp' && !id)
    issues.push({ path, code: 'whatsapp_template_required' })
  else if (id && input.channel === 'whatsapp' && !WHATSAPP_TEMPLATE_NAME_RE.test(id))
    issues.push({ path, code: 'whatsapp_template_name' })
  else if (id && input.channel !== 'whatsapp' && !PROVIDER_TEMPLATE_ID_RE.test(id))
    issues.push({ path, code: 'provider_template_id_invalid' })
  return issues
}

/** Inserts `{{key}}` into `text` over the selection [start, end); returns the text and caret. */
export function insertPlaceholder(
  text: string,
  key: string,
  start: number,
  end: number = start,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const token = `{{${key}}}`
  const before = text.slice(0, from)
  const after = text.slice(to)
  // Keep words apart: add a space when the token would touch a letter, digit or another token.
  const lead = /(?:[\p{L}\p{M}\p{N}]|\}\})$/u.test(before) ? ' ' : ''
  const trail = /^(?:[\p{L}\p{M}\p{N}]|\{\{)/u.test(after) ? ' ' : ''
  const inserted = `${lead}${token}${trail}`
  return { text: before + inserted + after, caret: from + lead.length + token.length }
}
