/**
 * Contract-shaped fixtures of the notifications screens (checked against the shared response
 * schemas in fixtures.test.ts). The template catalogue is built from the real default
 * templates, the way the server's templateEntry() builds it, so previews and editor checks run
 * on the texts the shop actually sees. Free of '@/' imports so throwaway browser scripts can
 * reuse them.
 */
import type { SettingsResponse } from '@kadai/shared/api/identity'
import {
  DLT_NOTE,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_CODES,
  type CustomerRemindResult,
  type Notification,
  type NotificationListResponse,
  type NotificationProviderStatus,
  type NotificationTemplateCatalog,
  type NotificationTemplateEntry,
  type NotificationTemplateCode,
  notificationRefPath,
  templatePlaceholderKeys,
} from '@kadai/shared/api/notifications'
import type { CustomerListItem, CustomerSummary } from '@kadai/shared/api/parties'
import type { Locale, NotificationChannel, NotificationStatus } from '@kadai/shared/enums'
import { DEFAULT_SETTINGS, type TenantSettings } from '@kadai/shared/settings'

export const NOW = '2026-10-21T09:30:00.000Z'

/** Deterministic UUID v7-shaped ids. */
export function nid(n: number): string {
  return `0192f0b0-0000-7000-8000-${String(n).padStart(12, '0')}`
}

export const CUSTOMER_ID = nid(900)
export const INVOICE_ID = nid(901)

export function notification(overrides: Partial<Notification> = {}): Notification {
  const base: Notification = {
    id: nid(1),
    channel: 'whatsapp',
    template_code: 'invoice_share',
    locale: 'ta',
    recipient: '+919876543210',
    recipient_name: 'லட்சுமி',
    params: {
      shop_name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
      customer_name: 'லட்சுமி',
      number: 'S1-A/2627/00042',
      amount: '₹1,250.00',
      link: 'https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
    },
    rendered_body:
      'வணக்கம் லட்சுமி, ஸ்ரீ முருகன் ஸ்டோர்ஸ் கடையில் வாங்கியதற்கு நன்றி! உங்கள் பில் S1-A/2627/00042, தொகை ₹1,250.00: https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
    status: 'delivered',
    provider: 'whatsapp_cloud',
    provider_message_id: 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS',
    error: null,
    attempts: 1,
    ref_type: 'sales_invoice',
    ref_id: INVOICE_ID,
    ref_path: notificationRefPath('sales_invoice', INVOICE_ID),
    scheduled_at: '2026-10-21T09:12:00.000Z',
    sent_at: '2026-10-21T09:12:03.000Z',
    created_by: '0192f0a0-0000-7000-8000-000000000001',
    created_by_name: 'Murugan',
    created_at: '2026-10-21T09:12:00.000Z',
    updated_at: '2026-10-21T09:12:09.000Z',
    can_retry: false,
  }
  return { ...base, ...overrides }
}

/** A realistic outbox page: delivered, read, failed (retryable), cancelled, queued, an OTP. */
export function outboxRows(): Notification[] {
  return [
    notification(),
    notification({
      id: nid(2),
      channel: 'sms',
      template_code: 'due_reminder',
      locale: 'ta',
      recipient: '+919843012345',
      recipient_name: 'கண்ணன்',
      params: { shop_name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்', customer_name: 'கண்ணன்', due: '₹2,450.00' },
      rendered_body:
        'ஸ்ரீ முருகன் ஸ்டோர்ஸ்: அன்புள்ள கண்ணன், உங்கள் நிலுவை ₹2,450.00 செலுத்த வேண்டியுள்ளது. செலுத்த: https://kadai.app/pay/KD7Q2M9X4B1Z. ஏற்கனவே செலுத்தியிருந்தால் பொருட்படுத்த வேண்டாம்.',
      status: 'failed',
      provider: 'msg91',
      provider_message_id: null,
      error: 'invalid_recipient: MSG91 rejected the number (NDNC)',
      attempts: 1,
      ref_type: 'customer',
      ref_id: nid(902),
      ref_path: notificationRefPath('customer', nid(902)),
      sent_at: null,
      can_retry: true,
      created_by: null,
      created_by_name: null,
      created_at: '2026-10-21T04:30:00.000Z',
      scheduled_at: '2026-10-21T04:30:00.000Z',
      updated_at: '2026-10-21T04:30:05.000Z',
    }),
    notification({
      id: nid(3),
      channel: 'whatsapp',
      template_code: 'payment_receipt',
      locale: 'en',
      recipient: '+919500011122',
      recipient_name: 'Priya',
      rendered_body:
        'Hello Priya, Sri Murugan Stores received your payment of ₹2,000.00 on 20-10-2026 (UPI). Receipt no: RCS1/2627/00017. Thank you!',
      status: 'read',
      created_at: '2026-10-20T13:40:00.000Z',
      scheduled_at: '2026-10-20T13:40:00.000Z',
      sent_at: '2026-10-20T13:40:02.000Z',
      updated_at: '2026-10-20T13:52:00.000Z',
    }),
    notification({
      id: nid(4),
      channel: 'whatsapp',
      template_code: 'invoice_share',
      recipient: '+919790012345',
      recipient_name: 'Selvi',
      rendered_body: null,
      status: 'cancelled',
      provider: null,
      provider_message_id: null,
      error: 'whatsapp_opt_out: customer 0192 opted out',
      attempts: 0,
      sent_at: null,
      can_retry: true,
      created_at: '2026-10-20T11:05:00.000Z',
      scheduled_at: '2026-10-20T11:05:00.000Z',
      updated_at: '2026-10-20T11:05:01.000Z',
    }),
    notification({
      id: nid(5),
      channel: 'email',
      template_code: 'daily_summary',
      locale: 'en',
      recipient: 'owner@murugan.in',
      recipient_name: 'Murugan',
      rendered_body: null,
      status: 'queued',
      provider: null,
      provider_message_id: null,
      attempts: 0,
      sent_at: null,
      ref_type: 'tenant',
      ref_id: nid(903),
      ref_path: null,
      created_by: null,
      created_by_name: null,
      created_at: '2026-10-20T16:00:00.000Z',
      scheduled_at: '2026-10-20T16:00:00.000Z',
      updated_at: '2026-10-20T16:00:00.000Z',
    }),
    notification({
      id: nid(6),
      channel: 'sms',
      template_code: 'otp',
      locale: 'ta',
      recipient: '+919876500001',
      recipient_name: null,
      params: {},
      rendered_body: null,
      status: 'sent',
      provider: 'log',
      provider_message_id: 'log-6',
      ref_type: null,
      ref_id: null,
      ref_path: null,
      created_by: null,
      created_by_name: null,
      created_at: '2026-10-20T08:00:00.000Z',
      scheduled_at: '2026-10-20T08:00:00.000Z',
      sent_at: '2026-10-20T08:00:01.000Z',
      updated_at: '2026-10-20T08:00:01.000Z',
    }),
  ]
}

export function outboxList(
  rows: Notification[] = outboxRows(),
  page: { limit?: number; offset?: number; total?: number } = {},
): NotificationListResponse {
  const statuses: NotificationStatus[] = [
    'queued',
    'sending',
    'sent',
    'delivered',
    'read',
    'failed',
    'cancelled',
  ]
  const channels: NotificationChannel[] = ['whatsapp', 'sms', 'email']
  return {
    data: rows,
    page: { limit: page.limit ?? 50, offset: page.offset ?? 0, total: page.total ?? rows.length },
    summary: {
      by_status: statuses
        .map((status) => ({ status, count: rows.filter((r) => r.status === status).length }))
        .filter((s) => s.count > 0),
      by_channel: channels
        .map((channel) => ({ channel, count: rows.filter((r) => r.channel === channel).length }))
        .filter((c) => c.count > 0),
    },
  }
}

// ---- template catalogue ------------------------------------------------------------------------

const LOCALES: readonly Locale[] = ['ta', 'en']

export interface OverrideFixture {
  code: NotificationTemplateCode
  channel: NotificationChannel
  locale: Locale
  subject?: string | null
  body: string
  provider_template_id?: string | null
  is_active?: boolean
}

export function templateEntry(
  code: NotificationTemplateCode,
  channel: NotificationChannel,
  locale: Locale,
  override?: OverrideFixture,
): NotificationTemplateEntry | null {
  const def = NOTIFICATION_TEMPLATES[code]
  if (!def.channels.includes(channel)) return null
  const text = def.defaults[locale][channel] ?? def.defaults.en[channel]
  if (!text) return null
  const active = override ? (override.is_active ?? true) : false
  return {
    code,
    channel,
    locale,
    label: def.label,
    description: def.description,
    audience: def.audience,
    subject: active && override ? (override.subject ?? null) : (text.subject ?? null),
    body: active && override ? override.body : text.body,
    provider_template_id: override?.provider_template_id ?? null,
    is_active: override ? (override.is_active ?? true) : true,
    is_override: Boolean(override),
    override_updated_at: override ? '2026-10-18T06:00:00.000Z' : null,
    default_subject: text.subject ?? null,
    default_body: text.body,
    // The SMS DLT ids come from the server's MSG91_TEMPLATE_<CODE> env; one is set here.
    default_provider_template_id:
      channel === 'sms'
        ? code === 'due_reminder'
          ? '1107170000000000001'
          : null
        : channel === 'whatsapp'
          ? def.whatsapp_template
          : null,
    placeholders: templatePlaceholderKeys(code).map((key) => ({
      key,
      required: def.required.includes(key),
    })),
    sample: def.sample[locale],
    max_length: NOTIFICATION_BODY_MAX[channel],
  }
}

export function providers(
  overrides: Partial<Record<NotificationChannel, Partial<NotificationProviderStatus>>> = {},
): NotificationProviderStatus[] {
  return [
    {
      channel: 'whatsapp',
      provider: 'whatsapp_cloud',
      configured: true,
      live: true,
      display: '+91 98765 43210',
      webhook_path: '/webhooks/notifications/whatsapp_cloud',
      ...overrides.whatsapp,
    },
    {
      channel: 'sms',
      provider: 'log',
      configured: true,
      live: false,
      display: null,
      webhook_path: null,
      ...overrides.sms,
    },
    {
      channel: 'email',
      provider: 'log',
      configured: false,
      live: false,
      display: null,
      webhook_path: null,
      ...overrides.email,
    },
  ]
}

export function catalog(
  options: {
    overrides?: OverrideFixture[]
    settings?: Partial<TenantSettings['notifications']>
    providers?: NotificationProviderStatus[]
  } = {},
): NotificationTemplateCatalog {
  const templates: NotificationTemplateEntry[] = []
  for (const code of NOTIFICATION_TEMPLATE_CODES)
    for (const channel of NOTIFICATION_TEMPLATES[code].channels)
      for (const locale of LOCALES) {
        const o = options.overrides?.find(
          (x) => x.code === code && x.channel === channel && x.locale === locale,
        )
        const e = templateEntry(code, channel, locale, o)
        if (e) templates.push(e)
      }
  return {
    templates,
    providers: options.providers ?? providers(),
    settings: { ...DEFAULT_SETTINGS.notifications, ...options.settings },
    dlt_note: DLT_NOTE,
  }
}

export function settingsResponse(
  notifications: Partial<TenantSettings['notifications']> = {},
  tenant: SettingsResponse['tenant'],
): SettingsResponse {
  return {
    tenant,
    settings: {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications, ...notifications },
    },
  }
}

// ---- customers & reminders ---------------------------------------------------------------------

export function customer(overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: CUSTOMER_ID,
    code: 'C0042',
    name: 'Lakshmi',
    name_ta: 'லட்சுமி',
    phone: '+919876543210',
    gstin: null,
    state_code: '33',
    customer_type: 'retail',
    price_tier: 'retail',
    balance_paise: 245_000,
    credit_limit_paise: 1_000_000,
    credit_days: null,
    overdue_paise: 120_000,
    loyalty_points: 120,
    tags: [],
    whatsapp_opt_in: true,
    is_active: true,
    last_invoice_at: '2026-10-05T07:00:00.000Z',
    created_at: '2026-01-10T05:00:00.000Z',
    updated_at: '2026-10-05T07:00:00.000Z',
    ...overrides,
  }
}

export function customerSummary(overrides: Partial<CustomerSummary> = {}): CustomerSummary {
  return {
    customer_id: CUSTOMER_ID,
    lifetime_sales_paise: 4_520_000,
    invoice_count: 38,
    returns_paise: 0,
    average_bill_paise: 118_947,
    first_invoice_at: '2026-01-12T06:00:00.000Z',
    last_invoice_at: '2026-10-05T07:00:00.000Z',
    monthly: [],
    top_items: [],
    balance_paise: 245_000,
    overdue_paise: 120_000,
    overdue_invoice_count: 2,
    oldest_due_date: '2026-10-06',
    credit_limit_paise: 1_000_000,
    credit_available_paise: 755_000,
    credit_days: 15,
    loyalty_points: 120,
    loyalty_value_paise: 12_000,
    open_payment_links: [],
    ...overrides,
  }
}

export function remindResult(overrides: Partial<CustomerRemindResult> = {}): CustomerRemindResult {
  return {
    customer_id: CUSTOMER_ID,
    due_paise: 245_000,
    amount_paise: 245_000,
    channel: 'whatsapp',
    notification: notification({
      id: nid(50),
      template_code: 'due_reminder',
      status: 'queued',
      ref_type: 'customer',
      ref_id: CUSTOMER_ID,
      ref_path: notificationRefPath('customer', CUSTOMER_ID),
      rendered_body: null,
      sent_at: null,
      provider: null,
      provider_message_id: null,
      attempts: 0,
    }),
    link: null,
    message:
      'வணக்கம் லட்சுமி, ஸ்ரீ முருகன் ஸ்டோர்ஸ் கடையிலிருந்து ஒரு நினைவூட்டல்: உங்கள் நிலுவைத் தொகை ₹2,450.00 கடந்த 30 நாட்களாகச் செலுத்தப்படாமல் உள்ளது. எளிதாகச் செலுத்த: UPI: murugan@okaxis. ஏற்கனவே செலுத்தியிருந்தால் இதைப் பொருட்படுத்த வேண்டாம். நன்றி!',
    wa_me_url: null,
    last_reminded_at: '2026-10-12T04:30:00.000Z',
    ...overrides,
  }
}
