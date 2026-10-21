/**
 * Display helpers of the notifications screens. Channel, status, template, provider and error
 * names come from the contract's bilingual label maps (one source for the server's CSV / print
 * output and the web); everything else is in the notifications i18n namespace.
 */
import {
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_ERROR_LABELS,
  NOTIFICATION_PROVIDER_LABELS,
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_TEMPLATES,
  type NotificationErrorCode,
  type NotificationProviderCode,
  isTemplateCode,
  notificationErrorCode,
} from '@kadai/shared/api/notifications'
import type { BilingualLabel } from '@kadai/shared/api/identity'
import type { Locale, NotificationChannel, NotificationStatus } from '@kadai/shared/enums'
import type { Tone } from '@/components/ui'
import { formatPhone } from '@/lib/format'
import { i18n, translate } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n-resources'

/** The UI language as a contract Locale ('ta' unless English is chosen). */
export function uiLocale(language: string): Locale {
  return language === 'en' ? 'en' : 'ta'
}

export function bilingual(label: BilingualLabel, language: string): string {
  return label[uiLocale(language)]
}

export function channelLabel(channel: NotificationChannel, language: string): string {
  return bilingual(NOTIFICATION_CHANNEL_LABELS[channel], language)
}

export function statusLabel(status: NotificationStatus, language: string): string {
  return bilingual(NOTIFICATION_STATUS_LABELS[status], language)
}

/** Template name; codes unknown to this version (retired templates) are shown as-is. */
export function templateLabel(code: string, language: string): string {
  return isTemplateCode(code) ? bilingual(NOTIFICATION_TEMPLATES[code].label, language) : code
}

export function providerLabel(provider: string, language: string): string {
  return provider in NOTIFICATION_PROVIDER_LABELS
    ? bilingual(NOTIFICATION_PROVIDER_LABELS[provider as NotificationProviderCode], language)
    : provider
}

export const STATUS_TONE: Readonly<Record<NotificationStatus, Tone>> = {
  queued: 'neutral',
  sending: 'info',
  sent: 'primary',
  delivered: 'success',
  read: 'success',
  failed: 'danger',
  cancelled: 'warning',
}

/** Status tabs of the outbox; 'pending' covers queued + sending. */
export const STATUS_TABS = [
  'all',
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
] as const
export type StatusTab = (typeof STATUS_TABS)[number]

export function statusesOfTab(tab: StatusTab): NotificationStatus[] | null {
  if (tab === 'all') return null
  if (tab === 'pending') return ['queued', 'sending']
  return [tab]
}

export function isStatusTab(value: string): value is StatusTab {
  return (STATUS_TABS as readonly string[]).includes(value)
}

export interface ErrorInfo {
  code: NotificationErrorCode | null
  /** Plain-language reason (the code's label), or the raw text for unknown errors. */
  reason: string
  /** Provider / system detail after 'code: ', when there is one. */
  detail: string | null
}

/** Splits a stored `error` ('<code>: <detail>') into a friendly reason and the raw detail. */
export function errorInfo(error: string | null | undefined, language: string): ErrorInfo | null {
  if (!error?.trim()) return null
  const code = notificationErrorCode(error)
  if (!code) return { code: null, reason: error.trim(), detail: null }
  const rest = error.trim().slice(code.length).replace(/^:\s*/, '').trim()
  return {
    code,
    reason: bilingual(NOTIFICATION_ERROR_LABELS[code], language),
    detail: rest || null,
  }
}

export function isEmailRecipient(recipient: string): boolean {
  return recipient.includes('@')
}

/** E.164 phone → '98765 43210' (other countries keep their code); emails unchanged. */
export function recipientText(recipient: string): string {
  if (isEmailRecipient(recipient)) return recipient
  return formatPhone(recipient, !recipient.startsWith('+91'))
}

/** Name of a linked document type ('sales_invoice' → 'Bill'), the raw type when unknown. */
export function refLabel(refType: string | null): string | null {
  if (!refType) return null
  const key = `notifications:refs.${refType}`
  return i18n.exists(key) ? translate(key as TranslationKey) : refType
}

/** Shopkeeper name of a template placeholder ('customer_name' → 'Customer name'). */
export function placeholderLabel(key: string): string {
  const k = `notifications:placeholders.${key}`
  return i18n.exists(k) ? translate(k as TranslationKey) : key
}
