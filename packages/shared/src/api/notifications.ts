// CONTRACT CHANGELOG (notifications backend; newest last — the web counterpart reads this)
// - NOTIFICATIONS_VALIDATION_KEYS: + 'whatsapp_template_required' (a WhatsApp override must name
//   its approved Meta template in provider_template_id), + 'provider_template_id_invalid'
//   (DLT / MSG91 flow id or WhatsApp template name with invalid characters).
// - NOTIFICATIONS_ERROR_REASONS: + 'amount_exceeds_due' (422, POST /customers/:id/remind with an
//   amount_paise above the customer's due).
// - New NOTIFICATION_ERROR_CODES / NOTIFICATION_ERROR_LABELS / notificationErrorCode(): the
//   machine codes the sender writes at the start of notifications.error ('<code>: <detail>')
//   for cancelled / failed messages, with bilingual labels for the outbox.
// - NotificationListResponseSchema.summary: documented as facet counts — by_status ignores the
//   `status` filter and by_channel ignores the `channel` filter (all other filters apply).
// - New PROVIDER_TEMPLATE_ID_RE / WHATSAPP_TEMPLATE_NAME_RE (format rules of provider_template_id).

/**
 * Contract for the notifications module — docs/API.md "notifications"; ARCHITECTURE.md §15.
 *
 *  - Outbox: business code calls core/notify.ts `enqueueNotification(tx, ctx, …)` inside its
 *    transaction (a rollback never sends); the `notifications.send` job renders and delivers via
 *    the channel's provider, with retries (NOTIFICATION_MAX_ATTEMPTS, exponential backoff) and a
 *    one-minute sweep for stuck rows.
 *  - Templates: code-defined defaults per code × channel × locale (NOTIFICATION_TEMPLATES, Tamil
 *    and English) overridable per tenant (notification_templates). `{{placeholder}}` syntax plus
 *    `{{#key}}…{{/key}}` / `{{^key}}…{{/key}}` sections (email only in the defaults: SMS (DLT) and
 *    WhatsApp texts must match their registered templates word for word).
 *  - Providers: the pluggable {@link NotificationProvider} interface and a registry
 *    ({@link createNotificationProviderRegistry}); the server keeps one per process
 *    (core/notify.ts getNotificationProviders()). The notifications module registers log / msg91 /
 *    whatsapp_cloud / email_webhook, the on-prem module `kadai_relay` (relayRequestFrom() →
 *    licensing RelayMessageRequest), and the vendor licensing module renders relayed requests with
 *    the default templates (buildOutboundMessage()) and delivers them with the same providers
 *    (core/notify.ts deliverMessage()).
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope;
 * custom validation messages are snake_case keys (NOTIFICATIONS_VALIDATION_KEYS).
 */
import { z } from 'zod'
import {
  type Locale,
  LocaleSchema,
  type NotificationChannel,
  NotificationChannelSchema,
  type NotificationStatus,
  NotificationStatusSchema,
} from '../enums'
import { isE164, maskPhone, normalizeIndianPhone } from '../phone'
import { NotificationSettingsSchema } from '../settings'
import {
  PageQuerySchema,
  dataOf,
  defineRoutes,
  listOf,
  sortQuery,
  zId,
  zOptionalPhone,
  zSearchQuery,
  zTimestamp,
} from './common'
import { type BilingualLabel, type RuleIssue, documentPath } from './identity'
import { ExpiryDigestParamsSchema, LowStockDigestParamsSchema } from './inventory'
import {
  DATE_ORDER_ISSUE,
  DATE_RANGE_FIELDS,
  PaymentIntentSchema,
  PaymentLinkTemplateParamsSchema,
  WebhookAckSchema,
  dateOrderOk,
  zAmountPaise,
  zNullableText,
  zQueryList,
} from './payments'
import { PoToSupplierTemplateParamsSchema } from './purchases'
import { InvoiceShareTemplateParamsSchema } from './sales'

// =============================================================================================
// Validation keys & labels
// =============================================================================================

/** Message keys of the custom rules in this contract (web: notifications:validation.<key>). */
export const NOTIFICATIONS_VALIDATION_KEYS = [
  'recipient_phone',
  'recipient_email',
  'template_channel',
  'template_not_adhoc',
  'template_syntax',
  'unknown_placeholder',
  'missing_required_placeholder',
  'body_too_long',
  'subject_required',
  'dlt_template_id_required',
  'whatsapp_template_required',
  'provider_template_id_invalid',
  'params_invalid',
  'date_order',
] as const
export type NotificationsValidationKey = (typeof NOTIFICATIONS_VALIDATION_KEYS)[number]

/** `details.reason` of the module's 4xx errors. */
export const NOTIFICATIONS_ERROR_REASONS = [
  'not_retryable', // 409: retry only failed / cancelled notifications
  'no_due', // 422: POST /customers/:id/remind without a due
  'no_phone', // 422: the customer has no mobile number
  'whatsapp_opt_out', // 422: the customer opted out of WhatsApp
  'channel_not_configured', // 422: no provider for the channel (use 'wa_me')
  'invalid_signature', // 401: webhook signature mismatch
  'amount_exceeds_due', // 422: remind amount_paise above the customer's due
] as const
export type NotificationsErrorReason = (typeof NOTIFICATIONS_ERROR_REASONS)[number]

export const NOTIFICATION_CHANNEL_LABELS: Readonly<Record<NotificationChannel, BilingualLabel>> = {
  sms: { en: 'SMS', ta: 'SMS' },
  whatsapp: { en: 'WhatsApp', ta: 'வாட்ஸ்அப்' },
  email: { en: 'Email', ta: 'மின்னஞ்சல்' },
}

export const NOTIFICATION_STATUS_LABELS: Readonly<Record<NotificationStatus, BilingualLabel>> = {
  queued: { en: 'Queued', ta: 'வரிசையில்' },
  sending: { en: 'Sending', ta: 'அனுப்பப்படுகிறது' },
  sent: { en: 'Sent', ta: 'அனுப்பப்பட்டது' },
  delivered: { en: 'Delivered', ta: 'சென்றடைந்தது' },
  read: { en: 'Read', ta: 'படிக்கப்பட்டது' },
  failed: { en: 'Failed', ta: 'தோல்வி' },
  cancelled: { en: 'Cancelled', ta: 'ரத்து செய்யப்பட்டது' },
}

/**
 * Machine codes the sender writes at the start of `notifications.error` (`<code>: <detail>`) when
 * a message is cancelled (not sent on purpose) or failed (provider / configuration problem).
 */
export const NOTIFICATION_ERROR_CODES = [
  // cancelled before sending
  'whatsapp_opt_out', // the customer opted out of WhatsApp
  'feature_not_in_plan', // the plan has no 'notifications' feature (SMS / WhatsApp)
  'disabled_in_settings', // settings.notifications switched this message off
  'channel_not_configured', // no live provider for the channel (production)
  // failed
  'template_unavailable', // the template has no text for the channel
  'no_provider', // no provider registered for the channel
  'not_configured', // the provider lacks credentials / a DLT template id
  'invalid_recipient', // the provider rejected the number / address
  'timeout', // provider call timed out (retried)
  'network', // network error (retried)
  'rate_limited', // provider throttling (retried)
  'provider_error', // other provider error
  'stuck', // the worker stopped while sending and the attempts ran out
] as const
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number]

export const NOTIFICATION_ERROR_LABELS: Readonly<Record<NotificationErrorCode, BilingualLabel>> = {
  whatsapp_opt_out: {
    en: 'Customer opted out of WhatsApp',
    ta: 'வாடிக்கையாளர் வாட்ஸ்அப் செய்திகளை விரும்பவில்லை',
  },
  feature_not_in_plan: {
    en: 'WhatsApp & SMS are not in your plan',
    ta: 'உங்கள் திட்டத்தில் வாட்ஸ்அப் & SMS இல்லை',
  },
  disabled_in_settings: {
    en: 'Turned off in notification settings',
    ta: 'செய்தி அமைப்புகளில் நிறுத்தப்பட்டுள்ளது',
  },
  channel_not_configured: {
    en: 'No SMS / WhatsApp service is set up',
    ta: 'SMS / வாட்ஸ்அப் சேவை இன்னும் அமைக்கப்படவில்லை',
  },
  template_unavailable: {
    en: 'No message text for this channel',
    ta: 'இந்த வழிக்குச் செய்தி உரை இல்லை',
  },
  no_provider: {
    en: 'No sending service for this channel',
    ta: 'இந்த வழிக்கு அனுப்பும் சேவை இல்லை',
  },
  not_configured: {
    en: 'Sending service is not fully set up',
    ta: 'அனுப்பும் சேவை முழுமையாக அமைக்கப்படவில்லை',
  },
  invalid_recipient: { en: 'Invalid number or address', ta: 'தவறான எண் / முகவரி' },
  timeout: { en: 'Service did not respond in time', ta: 'சேவை நேரத்தில் பதிலளிக்கவில்லை' },
  network: { en: 'Network problem', ta: 'இணைய இணைப்புச் சிக்கல்' },
  rate_limited: { en: 'Too many messages, will retry', ta: 'அதிக செய்திகள்; மீண்டும் முயலும்' },
  provider_error: { en: 'Sending service error', ta: 'அனுப்பும் சேவையில் பிழை' },
  stuck: { en: 'Sending was interrupted', ta: 'அனுப்புவது இடையில் நின்றுவிட்டது' },
}

/** The NotificationErrorCode at the start of a stored `error` ('code: detail'), else null. */
export function notificationErrorCode(
  error: string | null | undefined,
): NotificationErrorCode | null {
  if (!error) return null
  const code = /^([a-z_]+)(?::|$)/.exec(error.trim())?.[1]
  return code && (NOTIFICATION_ERROR_CODES as readonly string[]).includes(code)
    ? (code as NotificationErrorCode)
    : null
}

/** Shown next to the SMS template editor and in settings. */
export const DLT_NOTE: BilingualLabel = {
  en: 'Indian telecom rules (TRAI DLT) allow only pre-registered SMS texts. A changed SMS text is delivered only after you register it with your SMS provider and enter its DLT template id here. Messages sent through Kadai relay use the standard texts.',
  ta: 'இந்திய தொலைத்தொடர்பு விதிகளின்படி (TRAI DLT) முன்பதிவு செய்த SMS உரைகள் மட்டுமே அனுப்பப்படும். மாற்றிய SMS உரையை உங்கள் SMS சேவை நிறுவனத்தில் பதிவு செய்து, அதன் DLT டெம்ப்ளேட் எண்ணை இங்கே உள்ளிட்ட பிறகே அது அனுப்பப்படும். Kadai வழியாக அனுப்பும் செய்திகளுக்கு நிலையான உரைகளே பயன்படும்.',
}

// =============================================================================================
// Templates
// =============================================================================================

export const NOTIFICATION_TEMPLATE_CODES = [
  'invoice_share',
  'payment_receipt',
  'due_reminder',
  'payment_link',
  'daily_summary',
  'low_stock_digest',
  'expiry_digest',
  'po_to_supplier',
  'otp',
  'welcome',
] as const
export const NotificationTemplateCodeSchema = z.enum(NOTIFICATION_TEMPLATE_CODES)
export type NotificationTemplateCode = z.infer<typeof NotificationTemplateCodeSchema>

/** A placeholder value: strings are pre-formatted ('₹1,250.00', '20-10-2026'); null renders ''. */
export const NotificationParamValueSchema = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
])
export const NotificationParamsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), NotificationParamValueSchema)
  .refine((r) => Object.keys(r).length <= 40, { message: 'params_invalid' })
export type NotificationParams = z.output<typeof NotificationParamsSchema>

/** payment_receipt — a receipt recorded for a customer. */
export const PaymentReceiptParamsSchema = z.object({
  shop_name: z.string(),
  customer_name: z.string(),
  amount: z.string().describe("Formatted amount, e.g. '₹1,250.00'"),
  number: z.string().describe('Receipt number (RC…) or bill number'),
  date: z.string().describe('dd-MM-yyyy'),
  method: z.string().describe('Localized payment method label'),
  balance: z.string().nullable().describe('Formatted remaining due (null when nothing is due)'),
})

/** due_reminder — khata reminder (job notifications.due-reminders or POST /customers/:id/remind). */
export const DueReminderParamsSchema = z.object({
  shop_name: z.string(),
  customer_name: z.string(),
  due: z.string().describe("Formatted due, e.g. '₹2,450.00'"),
  days: z.union([z.string(), z.int()]).describe('Age in days of the oldest unpaid bill'),
  link: z
    .string()
    .describe("Pay link (provider link or PUBLIC_BASE_URL/pay/<code>), else 'UPI: <shop VPA>'"),
  shop_phone: z.string().nullable(),
})

/** daily_summary — to the owners' phones at 21:30 IST. */
export const DailySummaryParamsSchema = z.object({
  shop_name: z.string(),
  date: z.string().describe('dd-MM-yyyy'),
  net_sales: z.string(),
  bills: z.union([z.string(), z.int()]),
  cash: z.string(),
  upi: z.string(),
  card: z.string(),
  credit: z.string().describe('Sold on credit today'),
  dues_collected: z.string(),
  top_item: z.string().describe("Best-selling item, '-' when nothing sold"),
  low_stock_count: z.union([z.string(), z.int()]),
  link: z.string().nullable().describe('Dashboard / Kadai Connect link when reachable'),
})

export const OtpParamsSchema = z.object({
  otp: z.string().regex(/^\d{4,8}$/),
  minutes: z.union([z.string(), z.int()]),
})

/** welcome — first message to a new customer (also confirms the number for bills). */
export const WelcomeParamsSchema = z.object({
  shop_name: z.string(),
  customer_name: z.string(),
  link: z.string().nullable(),
})

/** Who a template is for (opt-in rules, recipients of system jobs). */
export type NotificationAudience = 'customer' | 'supplier' | 'owner' | 'user'

export interface TemplateText {
  subject?: string
  body: string
}

export interface NotificationTemplateDef {
  code: NotificationTemplateCode
  audience: NotificationAudience
  label: BilingualLabel
  description: BilingualLabel
  channels: readonly NotificationChannel[]
  /** Params the callers pass (validated by enqueueNotification). */
  params: z.ZodObject
  /** Placeholders that every body of this template must contain. */
  required: readonly string[]
  /** Usable from POST /notifications/send (system templates are not). */
  adhoc: boolean
  /** Params / bodies are redacted in API responses (OTP codes). */
  sensitive: boolean
  /** Env var holding the DLT template id of the default SMS text (MSG91 Flow). */
  sms_dlt_env: string | null
  /** Approved WhatsApp template name (language ta / en; body params in placeholder order). */
  whatsapp_template: string | null
  defaults: Readonly<Record<Locale, Readonly<Partial<Record<NotificationChannel, TemplateText>>>>>
  /** Sample params for previews, per locale. */
  sample: Readonly<Record<Locale, NotificationParams>>
}

const SAMPLE_LINK = 'https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v'
const SAMPLE_PAY = 'https://kadai.app/pay/KD7Q2M9X4B1Z'

const shop = { en: 'Sri Murugan Stores', ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' }
const cust = { en: 'Lakshmi', ta: 'லட்சுமி' }

function tpl(def: NotificationTemplateDef): NotificationTemplateDef {
  return def
}

/** Default templates (code → definition). Natural, short Tamil; English for en-locale customers. */
export const NOTIFICATION_TEMPLATES: Readonly<
  Record<NotificationTemplateCode, NotificationTemplateDef>
> = {
  invoice_share: tpl({
    code: 'invoice_share',
    audience: 'customer',
    label: { en: 'Bill shared with customer', ta: 'வாடிக்கையாளருக்கு பில்' },
    description: {
      en: 'Sends the bill link after billing (or from the bill page)',
      ta: 'பில் போட்டவுடன் (அல்லது பில் பக்கத்திலிருந்து) பில் இணைப்பை அனுப்பும்',
    },
    channels: ['whatsapp', 'sms', 'email'],
    params: InvoiceShareTemplateParamsSchema,
    required: ['link'],
    adhoc: true,
    sensitive: false,
    sms_dlt_env: 'MSG91_TEMPLATE_INVOICE_SHARE',
    whatsapp_template: 'kadai_invoice_share',
    defaults: {
      en: {
        whatsapp: {
          body: 'Hello {{customer_name}}, thank you for shopping at {{shop_name}}! Your bill {{number}} for {{amount}}: {{link}}',
        },
        sms: { body: '{{shop_name}}: Thank you! Bill {{number}} for {{amount}}. View: {{link}}' },
        email: {
          subject: 'Bill {{number}} from {{shop_name}}',
          body: 'Hello {{customer_name}},\n\nThank you for shopping at {{shop_name}}. Your bill {{number}} for {{amount}} is ready: {{link}}{{#due}}\n\nBalance due: {{due}}{{/due}}\n\n— {{shop_name}}',
        },
      },
      ta: {
        whatsapp: {
          body: 'வணக்கம் {{customer_name}}, {{shop_name}} கடையில் வாங்கியதற்கு நன்றி! உங்கள் பில் {{number}}, தொகை {{amount}}: {{link}}',
        },
        sms: { body: '{{shop_name}}: நன்றி! பில் {{number}}, தொகை {{amount}}. பார்க்க: {{link}}' },
        email: {
          subject: '{{shop_name}} — உங்கள் பில் {{number}}',
          body: 'வணக்கம் {{customer_name}},\n\n{{shop_name}} கடையில் வாங்கியதற்கு நன்றி. உங்கள் பில் {{number}} (தொகை {{amount}}) இங்கே: {{link}}{{#due}}\n\nசெலுத்த வேண்டிய நிலுவை: {{due}}{{/due}}\n\n— {{shop_name}}',
        },
      },
    },
    sample: {
      en: {
        shop_name: shop.en,
        customer_name: cust.en,
        number: 'S1-A/2627/00042',
        amount: '₹1,250.00',
        due: '₹450.00',
        link: SAMPLE_LINK,
      },
      ta: {
        shop_name: shop.ta,
        customer_name: cust.ta,
        number: 'S1-A/2627/00042',
        amount: '₹1,250.00',
        due: '₹450.00',
        link: SAMPLE_LINK,
      },
    },
  }),
  payment_receipt: tpl({
    code: 'payment_receipt',
    audience: 'customer',
    label: { en: 'Payment receipt', ta: 'பணம் பெற்ற ரசீது' },
    description: {
      en: 'Confirms a payment received from a customer',
      ta: 'வாடிக்கையாளரிடமிருந்து பணம் பெற்றதை உறுதிப்படுத்தும்',
    },
    channels: ['whatsapp', 'sms', 'email'],
    params: PaymentReceiptParamsSchema,
    required: ['amount'],
    adhoc: true,
    sensitive: false,
    sms_dlt_env: 'MSG91_TEMPLATE_PAYMENT_RECEIPT',
    whatsapp_template: 'kadai_payment_receipt',
    defaults: {
      en: {
        whatsapp: {
          body: 'Hello {{customer_name}}, {{shop_name}} received your payment of {{amount}} on {{date}} ({{method}}). Receipt no: {{number}}. Thank you!',
        },
        sms: {
          body: '{{shop_name}}: Received {{amount}} on {{date}}. Receipt {{number}}. Thank you!',
        },
        email: {
          subject: 'Payment received — {{shop_name}}',
          body: 'Hello {{customer_name}},\n\n{{shop_name}} received your payment of {{amount}} on {{date}} ({{method}}). Receipt no: {{number}}.{{#balance}}\n\nRemaining balance: {{balance}}{{/balance}}\n\nThank you!',
        },
      },
      ta: {
        whatsapp: {
          body: 'வணக்கம் {{customer_name}}, நீங்கள் {{date}} அன்று செலுத்திய {{amount}} ({{method}}) {{shop_name}} கடையில் வரவு வைக்கப்பட்டது. ரசீது எண்: {{number}}. நன்றி!',
        },
        sms: {
          body: '{{shop_name}}: {{date}} அன்று {{amount}} பெற்றுக்கொண்டோம். ரசீது {{number}}. நன்றி!',
        },
        email: {
          subject: '{{shop_name}} — பணம் பெற்ற ரசீது',
          body: 'வணக்கம் {{customer_name}},\n\nநீங்கள் {{date}} அன்று செலுத்திய {{amount}} ({{method}}) {{shop_name}} கடையில் வரவு வைக்கப்பட்டது. ரசீது எண்: {{number}}.{{#balance}}\n\nமீதமுள்ள நிலுவை: {{balance}}{{/balance}}\n\nநன்றி!',
        },
      },
    },
    sample: {
      en: {
        shop_name: shop.en,
        customer_name: cust.en,
        amount: '₹2,000.00',
        number: 'RCS1/2627/00017',
        date: '20-10-2026',
        method: 'UPI',
        balance: '₹450.00',
      },
      ta: {
        shop_name: shop.ta,
        customer_name: cust.ta,
        amount: '₹2,000.00',
        number: 'RCS1/2627/00017',
        date: '20-10-2026',
        method: 'UPI',
        balance: '₹450.00',
      },
    },
  }),
  due_reminder: tpl({
    code: 'due_reminder',
    audience: 'customer',
    label: { en: 'Due reminder', ta: 'நிலுவை நினைவூட்டல்' },
    description: {
      en: 'Reminds a customer of their khata due with a pay link',
      ta: 'வாடிக்கையாளருக்கு கடன் நிலுவையை, பணம் செலுத்தும் இணைப்புடன் நினைவூட்டும்',
    },
    channels: ['whatsapp', 'sms'],
    params: DueReminderParamsSchema,
    required: ['due'],
    adhoc: true,
    sensitive: false,
    sms_dlt_env: 'MSG91_TEMPLATE_DUE_REMINDER',
    whatsapp_template: 'kadai_due_reminder',
    defaults: {
      en: {
        whatsapp: {
          body: 'Hello {{customer_name}}, a friendly reminder from {{shop_name}}: your balance of {{due}} is pending for {{days}} days. Pay easily here: {{link}}. Please ignore if already paid. Thank you!',
        },
        sms: {
          body: '{{shop_name}}: Dear {{customer_name}}, your due of {{due}} is pending. Pay: {{link}}. Ignore if already paid.',
        },
      },
      ta: {
        whatsapp: {
          body: 'வணக்கம் {{customer_name}}, {{shop_name}} கடையிலிருந்து ஒரு நினைவூட்டல்: உங்கள் நிலுவைத் தொகை {{due}} கடந்த {{days}} நாட்களாகச் செலுத்தப்படாமல் உள்ளது. எளிதாகச் செலுத்த: {{link}}. ஏற்கனவே செலுத்தியிருந்தால் இதைப் பொருட்படுத்த வேண்டாம். நன்றி!',
        },
        sms: {
          body: '{{shop_name}}: அன்புள்ள {{customer_name}}, உங்கள் நிலுவை {{due}} செலுத்த வேண்டியுள்ளது. செலுத்த: {{link}}. ஏற்கனவே செலுத்தியிருந்தால் பொருட்படுத்த வேண்டாம்.',
        },
      },
    },
    sample: {
      en: {
        shop_name: shop.en,
        customer_name: cust.en,
        due: '₹2,450.00',
        days: 15,
        link: SAMPLE_PAY,
        shop_phone: '98765 43210',
      },
      ta: {
        shop_name: shop.ta,
        customer_name: cust.ta,
        due: '₹2,450.00',
        days: 15,
        link: SAMPLE_PAY,
        shop_phone: '98765 43210',
      },
    },
  }),
  payment_link: tpl({
    code: 'payment_link',
    audience: 'customer',
    label: { en: 'Payment link', ta: 'பணம் செலுத்தும் இணைப்பு' },
    description: {
      en: 'UPI payment link for an amount (POST /payments/links)',
      ta: 'ஒரு தொகைக்கான UPI பணம் செலுத்தும் இணைப்பு',
    },
    channels: ['whatsapp', 'sms'],
    params: PaymentLinkTemplateParamsSchema,
    required: ['link'],
    adhoc: true,
    sensitive: false,
    sms_dlt_env: 'MSG91_TEMPLATE_PAYMENT_LINK',
    whatsapp_template: 'kadai_payment_link',
    defaults: {
      en: {
        whatsapp: {
          body: 'Hello {{customer_name}}, here is your payment link from {{shop_name}} for {{amount}}: {{link}}. Pay with any UPI app. Thank you!',
        },
        sms: { body: '{{shop_name}}: Pay {{amount}} using this link: {{link}}' },
      },
      ta: {
        whatsapp: {
          body: 'வணக்கம் {{customer_name}}, {{shop_name}} கடைக்கு {{amount}} செலுத்துவதற்கான இணைப்பு: {{link}}. எந்த UPI செயலியிலும் செலுத்தலாம். நன்றி!',
        },
        sms: { body: '{{shop_name}}: {{amount}} செலுத்த இந்த இணைப்பைப் பயன்படுத்தவும்: {{link}}' },
      },
    },
    sample: {
      en: { shop_name: shop.en, customer_name: cust.en, amount: '₹2,450.00', link: SAMPLE_PAY },
      ta: { shop_name: shop.ta, customer_name: cust.ta, amount: '₹2,450.00', link: SAMPLE_PAY },
    },
  }),
  daily_summary: tpl({
    code: 'daily_summary',
    audience: 'owner',
    label: { en: 'Daily summary to owner', ta: 'உரிமையாளருக்குத் தினசரிச் சுருக்கம்' },
    description: {
      en: "Today's sales, collections and alerts at 9:30 pm",
      ta: 'இரவு 9:30 மணிக்கு அன்றைய விற்பனை, வசூல், எச்சரிக்கைகள்',
    },
    channels: ['whatsapp', 'sms', 'email'],
    params: DailySummaryParamsSchema,
    required: ['net_sales'],
    adhoc: false,
    sensitive: false,
    sms_dlt_env: 'MSG91_TEMPLATE_DAILY_SUMMARY',
    whatsapp_template: 'kadai_daily_summary',
    defaults: {
      en: {
        whatsapp: {
          body: '{{shop_name}} — summary for {{date}}\nSales: {{net_sales}} ({{bills}} bills)\nCash: {{cash}} | UPI: {{upi}} | Card: {{card}}\nCredit given: {{credit}}\nDues collected: {{dues_collected}}\nTop item: {{top_item}}\nLow-stock items: {{low_stock_count}}',
        },
        sms: {
          body: '{{shop_name}} {{date}}: Sales {{net_sales}}, {{bills}} bills, cash {{cash}}, UPI {{upi}}, dues collected {{dues_collected}}.',
        },
        email: {
          subject: 'Daily summary {{date}} — {{shop_name}}',
          body: '{{shop_name}} — summary for {{date}}\n\nSales: {{net_sales}} ({{bills}} bills)\nCash: {{cash}} | UPI: {{upi}} | Card: {{card}}\nCredit given: {{credit}}\nDues collected: {{dues_collected}}\nTop item: {{top_item}}\nLow-stock items: {{low_stock_count}}{{#link}}\n\nOpen the dashboard: {{link}}{{/link}}',
        },
      },
      ta: {
        whatsapp: {
          body: '{{shop_name}} — {{date}} அன்றைய சுருக்கம்\nவிற்பனை: {{net_sales}} ({{bills}} பில்கள்)\nரொக்கம்: {{cash}} | UPI: {{upi}} | கார்டு: {{card}}\nகடனுக்கு விற்றது: {{credit}}\nவசூலான நிலுவை: {{dues_collected}}\nஅதிகம் விற்றது: {{top_item}}\nகுறைந்த இருப்புப் பொருட்கள்: {{low_stock_count}}',
        },
        sms: {
          body: '{{shop_name}} {{date}}: விற்பனை {{net_sales}}, {{bills}} பில்கள், ரொக்கம் {{cash}}, UPI {{upi}}, நிலுவை வசூல் {{dues_collected}}.',
        },
        email: {
          subject: '{{shop_name}} — {{date}} தினசரிச் சுருக்கம்',
          body: '{{shop_name}} — {{date}} அன்றைய சுருக்கம்\n\nவிற்பனை: {{net_sales}} ({{bills}} பில்கள்)\nரொக்கம்: {{cash}} | UPI: {{upi}} | கார்டு: {{card}}\nகடனுக்கு விற்றது: {{credit}}\nவசூலான நிலுவை: {{dues_collected}}\nஅதிகம் விற்றது: {{top_item}}\nகுறைந்த இருப்புப் பொருட்கள்: {{low_stock_count}}{{#link}}\n\nடாஷ்போர்டு: {{link}}{{/link}}',
        },
      },
    },
    sample: {
      en: {
        shop_name: shop.en,
        date: '20-10-2026',
        net_sales: '₹48,560.00',
        bills: 212,
        cash: '₹21,300.00',
        upi: '₹19,860.00',
        card: '₹4,100.00',
        credit: '₹3,300.00',
        dues_collected: '₹5,200.00',
        top_item: 'Ponni rice 25 kg',
        low_stock_count: 7,
        link: null,
      },
      ta: {
        shop_name: shop.ta,
        date: '20-10-2026',
        net_sales: '₹48,560.00',
        bills: 212,
        cash: '₹21,300.00',
        upi: '₹19,860.00',
        card: '₹4,100.00',
        credit: '₹3,300.00',
        dues_collected: '₹5,200.00',
        top_item: 'பொன்னி அரிசி 25 கிலோ',
        low_stock_count: 7,
        link: null,
      },
    },
  }),
  low_stock_digest: tpl({
    code: 'low_stock_digest',
    audience: 'owner',
    label: { en: 'Low stock alert', ta: 'குறைந்த இருப்பு எச்சரிக்கை' },
    description: {
      en: 'Morning list of items below their reorder level',
      ta: 'மறு ஆர்டர் அளவுக்குக் கீழ் உள்ள பொருட்களின் காலைப் பட்டியல்',
    },
    channels: ['whatsapp', 'email'],
    params: LowStockDigestParamsSchema,
    required: ['low_stock_count'],
    adhoc: false,
    sensitive: false,
    sms_dlt_env: null,
    whatsapp_template: 'kadai_low_stock',
    defaults: {
      en: {
        whatsapp: {
          body: '{{shop_name}} ({{store_name}}) — stock alert {{date}}: {{low_stock_count}} items are low and {{out_of_stock_count}} are out of stock. {{items_text}}. Details: {{link}}',
        },
        email: {
          subject: 'Low stock: {{low_stock_count}} items — {{store_name}}',
          body: '{{shop_name}} ({{store_name}}) — stock alert {{date}}\n\n{{low_stock_count}} items are low and {{out_of_stock_count}} are out of stock:\n{{items_text}}\n\nDetails: {{link}}',
        },
      },
      ta: {
        whatsapp: {
          body: '{{shop_name}} ({{store_name}}) — {{date}} இருப்பு எச்சரிக்கை: {{low_stock_count}} பொருட்கள் குறைவாக உள்ளன, {{out_of_stock_count}} பொருட்கள் இருப்பில் இல்லை. {{items_text}}. விவரம்: {{link}}',
        },
        email: {
          subject: 'குறைந்த இருப்பு: {{low_stock_count}} பொருட்கள் — {{store_name}}',
          body: '{{shop_name}} ({{store_name}}) — {{date}} இருப்பு எச்சரிக்கை\n\n{{low_stock_count}} பொருட்கள் குறைவாக உள்ளன, {{out_of_stock_count}} பொருட்கள் இருப்பில் இல்லை:\n{{items_text}}\n\nவிவரம்: {{link}}',
        },
      },
    },
    sample: {
      en: {
        shop_name: shop.en,
        store_name: 'Main',
        date: '20-10-2026',
        low_stock_count: 3,
        out_of_stock_count: 1,
        items_text: 'Ponni rice 25 kg — 2 bags\nSunflower oil 1 L — 4 pcs\nToor dal 1 kg — 0',
        link: 'https://kadai.app/inventory/stock?low_stock=true',
      },
      ta: {
        shop_name: shop.ta,
        store_name: 'முதன்மை',
        date: '20-10-2026',
        low_stock_count: 3,
        out_of_stock_count: 1,
        items_text:
          'பொன்னி அரிசி 25 கிலோ — 2 மூட்டை\nசூரியகாந்தி எண்ணெய் 1 லி — 4\nதுவரம் பருப்பு 1 கிலோ — 0',
        link: 'https://kadai.app/inventory/stock?low_stock=true',
      },
    },
  }),
  expiry_digest: tpl({
    code: 'expiry_digest',
    audience: 'owner',
    label: { en: 'Expiry alert', ta: 'காலாவதி எச்சரிக்கை' },
    description: {
      en: 'Batches that expired or expire soon, with their value',
      ta: 'காலாவதியான / விரைவில் காலாவதியாகும் பேட்சுகளும் அவற்றின் மதிப்பும்',
    },
    channels: ['whatsapp', 'email'],
    params: ExpiryDigestParamsSchema,
    required: ['expiring_count'],
    adhoc: false,
    sensitive: false,
    sms_dlt_env: null,
    whatsapp_template: 'kadai_expiry_alert',
    defaults: {
      en: {
        whatsapp: {
          body: '{{shop_name}} ({{store_name}}) — expiry alert {{date}}: {{expiring_count}} batches expire soon and {{expired_count}} have expired, worth {{value_text}}. {{items_text}}. Details: {{link}}',
        },
        email: {
          subject: 'Expiry alert: {{expiring_count}} batches — {{store_name}}',
          body: '{{shop_name}} ({{store_name}}) — expiry alert {{date}}\n\n{{expiring_count}} batches expire soon and {{expired_count}} have expired, worth {{value_text}}:\n{{items_text}}\n\nDetails: {{link}}',
        },
      },
      ta: {
        whatsapp: {
          body: '{{shop_name}} ({{store_name}}) — {{date}} காலாவதி எச்சரிக்கை: {{expiring_count}} பேட்சுகள் விரைவில் காலாவதியாகின்றன, {{expired_count}} காலாவதியாகிவிட்டன; மதிப்பு {{value_text}}. {{items_text}}. விவரம்: {{link}}',
        },
        email: {
          subject: 'காலாவதி எச்சரிக்கை: {{expiring_count}} பேட்சுகள் — {{store_name}}',
          body: '{{shop_name}} ({{store_name}}) — {{date}} காலாவதி எச்சரிக்கை\n\n{{expiring_count}} பேட்சுகள் விரைவில் காலாவதியாகின்றன, {{expired_count}} காலாவதியாகிவிட்டன; மதிப்பு {{value_text}}:\n{{items_text}}\n\nவிவரம்: {{link}}',
        },
      },
    },
    sample: {
      en: {
        shop_name: shop.en,
        store_name: 'Main',
        date: '20-10-2026',
        expiring_count: 4,
        expired_count: 1,
        value_text: '₹3,420.00',
        items_text: 'Paracetamol 500 (B2231) — 30-11-2026\nORS sachet (OR77) — 15-11-2026',
        link: 'https://kadai.app/reports/expiry',
      },
      ta: {
        shop_name: shop.ta,
        store_name: 'முதன்மை',
        date: '20-10-2026',
        expiring_count: 4,
        expired_count: 1,
        value_text: '₹3,420.00',
        items_text: 'பாராசிட்டமால் 500 (B2231) — 30-11-2026\nORS பாக்கெட் (OR77) — 15-11-2026',
        link: 'https://kadai.app/reports/expiry',
      },
    },
  }),
  po_to_supplier: tpl({
    code: 'po_to_supplier',
    audience: 'supplier',
    label: { en: 'Purchase order to supplier', ta: 'சப்ளையருக்குக் கொள்முதல் ஆர்டர்' },
    description: {
      en: 'Sends a purchase order with its items',
      ta: 'கொள்முதல் ஆர்டரைப் பொருட்களுடன் அனுப்பும்',
    },
    channels: ['whatsapp', 'sms', 'email'],
    params: PoToSupplierTemplateParamsSchema,
    required: ['number'],
    adhoc: true,
    sensitive: false,
    sms_dlt_env: 'MSG91_TEMPLATE_PO_TO_SUPPLIER',
    whatsapp_template: 'kadai_purchase_order',
    defaults: {
      en: {
        whatsapp: {
          body: 'Hello {{supplier_name}}, purchase order {{number}} dated {{date}} from {{shop_name}}: {{items}}. Please confirm the delivery date. Thank you.',
        },
        sms: { body: '{{shop_name}}: Purchase order {{number}} ({{date}}): {{items}}' },
        email: {
          subject: 'Purchase order {{number}} — {{shop_name}}',
          body: 'Hello {{supplier_name}},\n\nPlease supply the following against purchase order {{number}} dated {{date}}:\n{{items}}{{#total}}\n\nOrder value: {{total}}{{/total}}\n\nPlease confirm the delivery date.\n\n— {{shop_name}}',
        },
      },
      ta: {
        whatsapp: {
          body: 'வணக்கம் {{supplier_name}}, {{shop_name}} கடையின் கொள்முதல் ஆர்டர் {{number}} (தேதி {{date}}): {{items}}. டெலிவரி தேதியை உறுதிப்படுத்தவும். நன்றி.',
        },
        sms: { body: '{{shop_name}}: கொள்முதல் ஆர்டர் {{number}} ({{date}}): {{items}}' },
        email: {
          subject: '{{shop_name}} — கொள்முதல் ஆர்டர் {{number}}',
          body: 'வணக்கம் {{supplier_name}},\n\nகொள்முதல் ஆர்டர் {{number}} (தேதி {{date}}) படி கீழ்க்கண்ட பொருட்களை அனுப்பவும்:\n{{items}}{{#total}}\n\nஆர்டர் மதிப்பு: {{total}}{{/total}}\n\nடெலிவரி தேதியை உறுதிப்படுத்தவும்.\n\n— {{shop_name}}',
        },
      },
    },
    sample: {
      en: {
        shop_name: shop.en,
        supplier_name: 'Annai Traders',
        number: 'POS1/2627/00008',
        date: '20-10-2026',
        items: '1. Ponni rice 25 kg × 20 bags\n2. Toor dal 1 kg × 50 pcs',
        total: '₹38,500.00',
      },
      ta: {
        shop_name: shop.ta,
        supplier_name: 'அன்னை டிரேடர்ஸ்',
        number: 'POS1/2627/00008',
        date: '20-10-2026',
        items: '1. பொன்னி அரிசி 25 கிலோ × 20 மூட்டை\n2. துவரம் பருப்பு 1 கிலோ × 50',
        total: '₹38,500.00',
      },
    },
  }),
  otp: tpl({
    code: 'otp',
    audience: 'user',
    label: {
      en: 'Login / verification code (OTP)',
      ta: 'உள்நுழைவு / சரிபார்ப்புக் குறியீடு (OTP)',
    },
    description: {
      en: 'One-time password for login, signup and password reset',
      ta: 'உள்நுழைவு, பதிவு, கடவுச்சொல் மீட்புக்கான ஒருமுறைக் குறியீடு',
    },
    channels: ['sms'],
    params: OtpParamsSchema,
    required: ['otp'],
    adhoc: false,
    sensitive: true,
    sms_dlt_env: 'MSG91_OTP_TEMPLATE_ID',
    whatsapp_template: null,
    defaults: {
      en: {
        sms: {
          body: '{{otp}} is your Kadai verification code. It is valid for {{minutes}} minutes. Do not share it with anyone.',
        },
      },
      ta: {
        sms: {
          body: '{{otp}} என்பது உங்கள் Kadai சரிபார்ப்புக் குறியீடு. இது {{minutes}} நிமிடங்களுக்கு மட்டுமே செல்லும். யாரிடமும் பகிர வேண்டாம்.',
        },
      },
    },
    sample: { en: { otp: '482913', minutes: 5 }, ta: { otp: '482913', minutes: 5 } },
  }),
  welcome: tpl({
    code: 'welcome',
    audience: 'customer',
    label: { en: 'Welcome message', ta: 'வரவேற்புச் செய்தி' },
    description: {
      en: 'Greets a new customer and confirms their number for bills',
      ta: 'புதிய வாடிக்கையாளரை வரவேற்று, பில்கள் அனுப்பும் எண்ணை உறுதிப்படுத்தும்',
    },
    channels: ['whatsapp', 'sms', 'email'],
    params: WelcomeParamsSchema,
    required: ['shop_name'],
    adhoc: true,
    sensitive: false,
    sms_dlt_env: 'MSG91_TEMPLATE_WELCOME',
    whatsapp_template: 'kadai_welcome',
    defaults: {
      en: {
        whatsapp: {
          body: 'Welcome to {{shop_name}}, {{customer_name}}! Thank you for choosing us. Your bills and payment receipts will be sent to this number.',
        },
        sms: {
          body: 'Welcome to {{shop_name}}, {{customer_name}}! Your bills and receipts will be sent to this number.',
        },
        email: {
          subject: 'Welcome to {{shop_name}}',
          body: 'Hello {{customer_name}},\n\nWelcome to {{shop_name}}! Thank you for choosing us. Your bills and payment receipts will be sent to you here.{{#link}}\n\n{{link}}{{/link}}',
        },
      },
      ta: {
        whatsapp: {
          body: '{{shop_name}} கடைக்கு வரவேற்கிறோம், {{customer_name}}! எங்களைத் தேர்ந்தெடுத்ததற்கு நன்றி. உங்கள் பில்களும் பணம் பெற்ற ரசீதுகளும் இந்த எண்ணுக்கு அனுப்பப்படும்.',
        },
        sms: {
          body: '{{shop_name}} கடைக்கு வரவேற்கிறோம், {{customer_name}}! உங்கள் பில்களும் ரசீதுகளும் இந்த எண்ணுக்கு அனுப்பப்படும்.',
        },
        email: {
          subject: '{{shop_name}} கடைக்கு வரவேற்கிறோம்',
          body: 'வணக்கம் {{customer_name}},\n\n{{shop_name}} கடைக்கு வரவேற்கிறோம்! எங்களைத் தேர்ந்தெடுத்ததற்கு நன்றி. உங்கள் பில்களும் ரசீதுகளும் இனி இங்கே அனுப்பப்படும்.{{#link}}\n\n{{link}}{{/link}}',
        },
      },
    },
    sample: {
      en: { shop_name: shop.en, customer_name: cust.en, link: null },
      ta: { shop_name: shop.ta, customer_name: cust.ta, link: null },
    },
  }),
}

/** Templates that POST /notifications/send accepts. */
export const ADHOC_TEMPLATE_CODES = NOTIFICATION_TEMPLATE_CODES.filter(
  (c) => NOTIFICATION_TEMPLATES[c].adhoc,
)

export function isTemplateCode(code: unknown): code is NotificationTemplateCode {
  return (
    typeof code === 'string' && (NOTIFICATION_TEMPLATE_CODES as readonly string[]).includes(code)
  )
}

/** Placeholders a template's params schema defines (allowed in bodies), in schema order. */
export function templatePlaceholderKeys(code: NotificationTemplateCode): string[] {
  return Object.keys(NOTIFICATION_TEMPLATES[code].params.shape)
}

/** Longest rendered body per channel (WhatsApp template body limit 1024). */
export const NOTIFICATION_BODY_MAX: Readonly<Record<NotificationChannel, number>> = {
  sms: 1000,
  whatsapp: 1024,
  email: 20_000,
}
export const NOTIFICATION_SUBJECT_MAX = 200
/** MSG91 / DLT: each {#var#} holds at most 30 characters (longer values are split by the provider). */
export const SMS_DLT_VARIABLE_MAX = 30
/** WhatsApp template parameters: no newlines / tabs, ≤ 4 consecutive spaces, ≤ 1024 characters. */
export const WHATSAPP_PARAM_MAX = 1024

// ---- template syntax ---------------------------------------------------------------------------

type TemplateNode =
  | { kind: 'text'; text: string }
  | { kind: 'var'; key: string }
  | { kind: 'section'; key: string; inverted: boolean; children: TemplateNode[] }

export interface TemplateParseResult {
  nodes: TemplateNode[]
  /** Every key referenced (variables and sections), in order of first appearance. */
  placeholders: string[]
  /** Variable keys only, in order of first appearance (WhatsApp body parameter order). */
  variables: string[]
  errors: Array<{ code: 'template_syntax'; message: string }>
}

const TOKEN_RE = /\{\{\s*([#^/]?)\s*([a-z][a-z0-9_]*)\s*\}\}/g

/** Parses `{{key}}`, `{{#key}}…{{/key}}` (shown when set) and `{{^key}}…{{/key}}` (when empty). */
export function parseTemplate(body: string): TemplateParseResult {
  const root: TemplateNode[] = []
  const stack: Array<{ key: string; inverted: boolean; children: TemplateNode[] }> = []
  const placeholders: string[] = []
  const variables: string[] = []
  const errors: TemplateParseResult['errors'] = []
  const current = () => (stack.length ? stack[stack.length - 1]!.children : root)
  const pushText = (text: string) => {
    if (!text) return
    if (text.includes('{{') || text.includes('}}'))
      errors.push({
        code: 'template_syntax',
        message: `malformed placeholder near "${text.slice(0, 20)}"`,
      })
    current().push({ kind: 'text', text })
  }
  let last = 0
  for (const m of body.matchAll(TOKEN_RE)) {
    pushText(body.slice(last, m.index))
    last = m.index + m[0].length
    const sigil = m[1]!
    const key = m[2]!
    if (!placeholders.includes(key)) placeholders.push(key)
    if (sigil === '#' || sigil === '^') {
      const section = { key, inverted: sigil === '^', children: [] as TemplateNode[] }
      current().push({ kind: 'section', ...section })
      stack.push(section)
    } else if (sigil === '/') {
      const open = stack.pop()
      if (!open || open.key !== key)
        errors.push({ code: 'template_syntax', message: `unexpected {{/${key}}}` })
    } else {
      if (!variables.includes(key)) variables.push(key)
      current().push({ kind: 'var', key })
    }
  }
  pushText(body.slice(last))
  for (const open of stack)
    errors.push({ code: 'template_syntax', message: `unclosed {{#${open.key}}}` })
  return { nodes: root, placeholders, variables, errors }
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === false || v === 0
}

export interface RenderOptions {
  /** html: escape values (& < > " '); none (default) for SMS / WhatsApp / plain-text email. */
  escape?: 'none' | 'html'
  /** Per-value transform (e.g. sanitizeWhatsAppParam). */
  value?: (key: string, text: string) => string
  /** Truncate the result to this many characters (… appended). */
  maxLength?: number
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Renders a template body; missing / null variables render as '' and are reported in `missing`. */
export function renderTemplate(
  body: string,
  params: Readonly<Record<string, unknown>>,
  opts: RenderOptions = {},
): { text: string; missing: string[] } {
  const parsed = parseTemplate(body)
  const missing: string[] = []
  const valueText = (key: string): string => {
    const v = params[key]
    if (v === undefined || v === null) {
      if (!missing.includes(key)) missing.push(key)
      return ''
    }
    let text = typeof v === 'string' ? v : String(v)
    if (opts.value) text = opts.value(key, text)
    return opts.escape === 'html' ? text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!) : text
  }
  const walk = (nodes: readonly TemplateNode[]): string =>
    nodes
      .map((n) => {
        if (n.kind === 'text') return n.text
        if (n.kind === 'var') return valueText(n.key)
        const show = n.inverted ? isBlank(params[n.key]) : !isBlank(params[n.key])
        return show ? walk(n.children) : ''
      })
      .join('')
  let text = walk(parsed.nodes)
  if (opts.maxLength !== undefined) text = truncateText(text, opts.maxLength)
  return { text, missing }
}

/** Truncates to `max` code points (never splitting a surrogate pair), adding '…'. */
export function truncateText(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** WhatsApp template parameter: newlines / tabs → ' · ', ≤ 4 consecutive spaces, ≤ 1024 chars. */
export function sanitizeWhatsAppParam(text: string): string {
  const flat = text
    .replace(/\s*[\r\n\t]+\s*/g, ' · ')
    .replace(/ {5,}/g, '    ')
    .trim()
  return truncateText(flat || '-', WHATSAPP_PARAM_MAX)
}

/** SMS encoding & segments: GSM-7 (160 / 153 per part) or Unicode — Tamil — (70 / 67 per part). */
export function smsSegments(text: string): {
  encoding: 'gsm7' | 'unicode'
  length: number
  segments: number
} {
  // GSM 03.38 basic set (approximation without the extension table's double counting).
  const GSM =
    /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/
  const unicode = !GSM.test(text)
  const length = unicode ? Array.from(text).length : text.length
  const single = unicode ? 70 : 160
  const multi = unicode ? 67 : 153
  return {
    encoding: unicode ? 'unicode' : 'gsm7',
    length,
    segments: length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi),
  }
}

/** Text to register with DLT: every placeholder becomes {#var#} (sections are not allowed). */
export function dltTemplateText(body: string): string {
  return body.replace(TOKEN_RE, (_m, sigil: string) => (sigil ? '' : '{#var#}'))
}

/** Text to submit to Meta: placeholders become {{1}}, {{2}} … in order of first appearance. */
export function whatsappTemplateText(body: string): string {
  const order = parseTemplate(body).variables
  return body.replace(TOKEN_RE, (_m, sigil: string, key: string) =>
    sigil ? '' : `{{${order.indexOf(key) + 1}}}`,
  )
}

/**
 * Problems of a (tenant override) template text, as RuleIssues: syntax, placeholders unknown to
 * the template, required placeholders missing, length, email subject. SMS overrides also need a
 * DLT template id (checked by the route: dlt_template_id_required).
 */
export function templateBodyIssues(input: {
  code: NotificationTemplateCode
  channel: NotificationChannel
  body: string
  subject?: string | null
}): Array<RuleIssue & { placeholder?: string }> {
  const def = NOTIFICATION_TEMPLATES[input.code]
  const issues: Array<RuleIssue & { placeholder?: string }> = []
  if (!def.channels.includes(input.channel))
    issues.push({ path: 'channel', code: 'template_channel' })
  const allowed = new Set(templatePlaceholderKeys(input.code))
  const check = (text: string, path: 'body' | 'subject') => {
    const parsed = parseTemplate(text)
    if (parsed.errors.length) issues.push({ path, code: 'template_syntax' })
    for (const p of parsed.placeholders)
      if (!allowed.has(p)) issues.push({ path, code: 'unknown_placeholder', placeholder: p })
    return parsed
  }
  const body = check(input.body, 'body')
  for (const r of def.required)
    if (!body.placeholders.includes(r))
      issues.push({ path: 'body', code: 'missing_required_placeholder', placeholder: r })
  if (Array.from(input.body).length > NOTIFICATION_BODY_MAX[input.channel])
    issues.push({ path: 'body', code: 'body_too_long' })
  if (input.channel === 'email') {
    if (!input.subject?.trim()) issues.push({ path: 'subject', code: 'subject_required' })
    else check(input.subject, 'subject')
  }
  return issues
}

/** A stored tenant override (notification_templates row). */
export interface TemplateOverride {
  subject: string | null
  body: string
  provider_template_id: string | null
  is_active: boolean
}

/** Effective text of (code, channel, locale): the active override, else the default (null when the channel is unsupported). */
export function resolveTemplate(input: {
  code: NotificationTemplateCode
  channel: NotificationChannel
  locale: Locale
  override?: TemplateOverride | null
}): {
  subject: string | null
  body: string
  provider_template_id: string | null
  source: 'override' | 'default'
} | null {
  const def = NOTIFICATION_TEMPLATES[input.code]
  if (!def.channels.includes(input.channel)) return null
  const o = input.override
  if (o && o.is_active)
    return {
      subject: o.subject,
      body: o.body,
      provider_template_id: o.provider_template_id,
      source: 'override',
    }
  const text = def.defaults[input.locale][input.channel] ?? def.defaults.en[input.channel]
  if (!text) return null
  return {
    subject: text.subject ?? null,
    body: text.body,
    provider_template_id: null,
    source: 'default',
  }
}

/** Params as strings (null → ''), what providers and the relay receive. */
export function stringifyParams(params: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(params))
    out[k] = v === null || v === undefined ? '' : String(v)
  return out
}

export interface RenderedNotification {
  subject: string | null
  body: string
  provider_template_id: string | null
  source: 'override' | 'default'
  /** WhatsApp template call: approved name, language and positional body parameters. */
  whatsapp: { template_name: string; language: Locale; body_params: string[] } | null
  missing: string[]
}

/**
 * Renders a notification for its channel exactly as the sender delivers it (also the editor's
 * live preview): WhatsApp values are sanitized and returned as positional parameters, bodies are
 * limited to NOTIFICATION_BODY_MAX. A WhatsApp override must name its approved template in
 * provider_template_id; the default uses `whatsapp_template`.
 */
export function renderNotification(input: {
  code: NotificationTemplateCode
  channel: NotificationChannel
  locale: Locale
  params: Readonly<Record<string, unknown>>
  override?: TemplateOverride | null
}): RenderedNotification | null {
  const t = resolveTemplate(input)
  if (!t) return null
  const def = NOTIFICATION_TEMPLATES[input.code]
  const wa = input.channel === 'whatsapp'
  const opts: RenderOptions = {
    maxLength: NOTIFICATION_BODY_MAX[input.channel],
    ...(wa ? { value: (_k: string, v: string) => sanitizeWhatsAppParam(v) } : {}),
  }
  const body = renderTemplate(t.body, input.params, opts)
  const subject = t.subject
    ? renderTemplate(t.subject, input.params, { maxLength: NOTIFICATION_SUBJECT_MAX }).text
    : null
  const templateName = t.provider_template_id ?? def.whatsapp_template
  return {
    subject,
    body: body.text,
    provider_template_id: t.provider_template_id,
    source: t.source,
    whatsapp:
      wa && templateName
        ? {
            template_name: templateName,
            language: input.locale,
            body_params: parseTemplate(t.body).variables.map((k) => {
              const v = input.params[k]
              return sanitizeWhatsAppParam(v === null || v === undefined ? '' : String(v))
            }),
          }
        : null,
    missing: body.missing,
  }
}

// ---- recipients --------------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** E.164 phone (sms / whatsapp) or lower-cased email, null when invalid for the channel. */
export function normalizeRecipient(channel: NotificationChannel, to: string): string | null {
  const v = to.trim()
  if (channel === 'email') return EMAIL_RE.test(v) && v.length <= 254 ? v.toLowerCase() : null
  return normalizeIndianPhone(v) ?? (isE164(v) ? v : null)
}

/** '98XXX XX210' / 'la***@gmail.com' for logs and lists. */
export function maskRecipient(recipient: string): string {
  if (recipient.includes('@')) {
    const [user = '', domain = ''] = recipient.split('@')
    return `${user.slice(0, 2)}***@${domain}`
  }
  return maskPhone(recipient)
}

/** WhatsApp to customers requires their opt-in (customers.whatsapp_opt_in). */
export function requiresWhatsAppOptIn(
  code: NotificationTemplateCode,
  channel: NotificationChannel,
): boolean {
  return channel === 'whatsapp' && NOTIFICATION_TEMPLATES[code].audience === 'customer'
}

/** usage_counters metric per channel (per month). */
export const NOTIFICATION_USAGE_METRIC: Readonly<
  Record<NotificationChannel, 'sms' | 'whatsapp' | 'email'>
> = {
  sms: 'sms',
  whatsapp: 'whatsapp',
  email: 'email',
}

// =============================================================================================
// Outbox
// =============================================================================================

export const NotificationSchema = z.object({
  id: zId,
  channel: NotificationChannelSchema,
  /** A NotificationTemplateCode (string: older rows may hold retired codes). */
  template_code: z.string(),
  locale: LocaleSchema,
  recipient: z.string(),
  recipient_name: z.string().nullable(),
  /** Redacted ({}) for sensitive templates. */
  params: NotificationParamsSchema,
  /** Body as sent (null until rendered; redacted for sensitive templates). */
  rendered_body: z.string().nullable(),
  status: NotificationStatusSchema,
  provider: z.string().nullable(),
  provider_message_id: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.int().min(0),
  ref_type: z.string().nullable(),
  ref_id: zId.nullable(),
  /** documentPath(ref_type, ref_id). */
  ref_path: z.string().nullable(),
  scheduled_at: zTimestamp,
  sent_at: zTimestamp.nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
  /** failed / cancelled → POST /notifications/:id/retry. */
  can_retry: z.boolean(),
})
export type Notification = z.output<typeof NotificationSchema>

/** Web link of a notification's source document. */
export function notificationRefPath(refType: string | null, refId: string | null): string | null {
  return documentPath(refType, refId)
}

export const NotificationListQuerySchema = PageQuerySchema.extend({
  ...DATE_RANGE_FIELDS,
  status: zQueryList(NotificationStatusSchema).optional(),
  channel: zQueryList(NotificationChannelSchema).optional(),
  template_code: zQueryList(NotificationTemplateCodeSchema).optional(),
  q: zSearchQuery.optional().describe('Recipient phone digits / email / name'),
  ref_type: z.string().trim().max(40).optional(),
  ref_id: zId.optional(),
  sort: sortQuery(['created_at', 'scheduled_at', 'status'] as const).prefault('-created_at'),
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type NotificationListQuery = z.input<typeof NotificationListQuerySchema>

/**
 * `summary` holds facet counts over the filtered range: by_status applies every filter except
 * `status`, by_channel every filter except `channel` (so status / channel tabs show their counts).
 */
export const NotificationListResponseSchema = listOf(NotificationSchema).extend({
  summary: z.object({
    by_status: z.array(z.object({ status: NotificationStatusSchema, count: z.int().min(0) })),
    by_channel: z.array(z.object({ channel: NotificationChannelSchema, count: z.int().min(0) })),
  }),
})
export type NotificationListResponse = z.output<typeof NotificationListResponseSchema>

/** Outbox auto-refresh interval of the web list. */
export const OUTBOX_REFRESH_SECONDS = 15

/**
 * POST /notifications/send — template-based only (no free text: DLT). `to` is a mobile number
 * (sms / whatsapp; parsed to E.164) or an email (lower-cased); params are validated against the template's params schema
 * (400 params_invalid). Rate limited (ADHOC_SEND_RATE_LIMIT).
 */
export const NotificationSendSchema = z
  .object({
    channel: NotificationChannelSchema,
    template_code: NotificationTemplateCodeSchema,
    to: z.string().trim().min(3).max(254),
    recipient_name: zNullableText(120),
    locale: LocaleSchema.optional().describe('Default: the business locale'),
    params: NotificationParamsSchema,
    ref_type: z.string().trim().min(1).max(40).optional(),
    ref_id: zId.optional(),
    scheduled_at: zTimestamp.optional(),
  })
  .superRefine((v, ctx) => {
    if (!normalizeRecipient(v.channel, v.to))
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: v.channel === 'email' ? 'recipient_email' : 'recipient_phone',
      })
    const def = NOTIFICATION_TEMPLATES[v.template_code]
    if (!def.adhoc)
      ctx.addIssue({ code: 'custom', path: ['template_code'], message: 'template_not_adhoc' })
    if (!def.channels.includes(v.channel))
      ctx.addIssue({ code: 'custom', path: ['channel'], message: 'template_channel' })
  })
  .transform((v) => ({ ...v, to: normalizeRecipient(v.channel, v.to) ?? v.to }))
export type NotificationSend = z.input<typeof NotificationSendSchema>
export type NotificationSendParsed = z.output<typeof NotificationSendSchema>

export const ADHOC_SEND_RATE_LIMIT = { max: 30, window_seconds: 60 } as const

// =============================================================================================
// Template catalogue & overrides
// =============================================================================================

export const NotificationTemplateEntrySchema = z.object({
  code: NotificationTemplateCodeSchema,
  channel: NotificationChannelSchema,
  locale: LocaleSchema,
  label: z.object({ en: z.string(), ta: z.string() }),
  description: z.object({ en: z.string(), ta: z.string() }),
  audience: z.enum(['customer', 'supplier', 'owner', 'user']),
  /** Effective text (override when active, else default). */
  subject: z.string().nullable(),
  body: z.string(),
  provider_template_id: z.string().nullable(),
  is_active: z.boolean(),
  is_override: z.boolean(),
  override_updated_at: zTimestamp.nullable(),
  default_subject: z.string().nullable(),
  default_body: z.string(),
  /** DLT id configured for the default SMS (env), or the default WhatsApp template name. */
  default_provider_template_id: z.string().nullable(),
  placeholders: z.array(z.object({ key: z.string(), required: z.boolean() })),
  sample: NotificationParamsSchema,
  max_length: z.int().min(1),
})
export type NotificationTemplateEntry = z.output<typeof NotificationTemplateEntrySchema>

export const NOTIFICATION_PROVIDER_CODES = [
  'log',
  'msg91',
  'whatsapp_cloud',
  'email_webhook',
  // Reserved: an SMTP client needs a mail library, which is not bundled — use email_webhook.
  'smtp',
  'kadai_relay',
] as const
export const NotificationProviderCodeSchema = z.enum(NOTIFICATION_PROVIDER_CODES)
export type NotificationProviderCode = z.infer<typeof NotificationProviderCodeSchema>

export const NOTIFICATION_PROVIDER_CHANNELS: Readonly<
  Record<NotificationProviderCode, readonly NotificationChannel[]>
> = {
  log: ['sms', 'whatsapp', 'email'],
  msg91: ['sms'],
  whatsapp_cloud: ['whatsapp'],
  email_webhook: ['email'],
  smtp: ['email'],
  kadai_relay: ['sms', 'whatsapp'],
}

export const NOTIFICATION_PROVIDER_LABELS: Readonly<
  Record<NotificationProviderCode, BilingualLabel>
> = {
  log: { en: 'Not sending (log only)', ta: 'அனுப்பப்படவில்லை (பதிவு மட்டும்)' },
  msg91: { en: 'MSG91 SMS', ta: 'MSG91 SMS' },
  whatsapp_cloud: { en: 'WhatsApp Business (Meta)', ta: 'வாட்ஸ்அப் பிசினஸ் (Meta)' },
  email_webhook: { en: 'Email via webhook', ta: 'வெப்ஹூக் வழி மின்னஞ்சல்' },
  smtp: { en: 'SMTP email', ta: 'SMTP மின்னஞ்சல்' },
  kadai_relay: { en: 'Kadai messaging', ta: 'Kadai செய்தி சேவை' },
}

/** Status card of a channel (never secrets). */
export const NotificationProviderStatusSchema = z.object({
  channel: NotificationChannelSchema,
  provider: NotificationProviderCodeSchema,
  /** Credentials present (log is "configured" but does not deliver). */
  configured: z.boolean(),
  /** Messages really leave the system (false for log). */
  live: z.boolean(),
  /** Sender id / WhatsApp number / from address, for display. */
  display: z.string().nullable(),
  /** Delivery receipts URL to paste in the provider dashboard (prefix PUBLIC_BASE_URL). */
  webhook_path: z.string().nullable(),
})
export type NotificationProviderStatus = z.output<typeof NotificationProviderStatusSchema>

/** GET /notification-templates — templates × channels × locales plus provider status. */
export const NotificationTemplateCatalogSchema = z.object({
  templates: z.array(NotificationTemplateEntrySchema),
  providers: z.array(NotificationProviderStatusSchema),
  /** settings.notifications of the business (toggles on the same page; PATCH /settings). */
  settings: NotificationSettingsSchema,
  dlt_note: z.object({ en: z.string(), ta: z.string() }),
})
export type NotificationTemplateCatalog = z.output<typeof NotificationTemplateCatalogSchema>

export const NotificationTemplateListQuerySchema = z.object({
  code: NotificationTemplateCodeSchema.optional(),
  channel: NotificationChannelSchema.optional(),
  locale: LocaleSchema.optional(),
})
export type NotificationTemplateListQuery = z.input<typeof NotificationTemplateListQuerySchema>

export const NotificationTemplateParamsSchema = z.object({
  code: NotificationTemplateCodeSchema,
  channel: NotificationChannelSchema,
  locale: LocaleSchema,
})

/** provider_template_id: an MSG91 flow / DLT template id (SMS) or an email provider template. */
export const PROVIDER_TEMPLATE_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/
/** Approved WhatsApp (Meta) template names: lower-case letters, digits and underscores. */
export const WHATSAPP_TEMPLATE_NAME_RE = /^[a-z0-9_]{1,100}$/

/**
 * PUT /notification-templates/:code/:channel/:locale — upsert the tenant override (validated with
 * templateBodyIssues(); SMS also needs provider_template_id = its DLT template id; a WhatsApp
 * override names its approved template). Audited.
 */
export const NotificationTemplateUpsertSchema = z.object({
  subject: zNullableText(NOTIFICATION_SUBJECT_MAX),
  body: z.string().trim().min(1).max(NOTIFICATION_BODY_MAX.email),
  provider_template_id: zNullableText(100),
  is_active: z.boolean().default(true),
})
export type NotificationTemplateUpsert = z.input<typeof NotificationTemplateUpsertSchema>

/** Settings toggles shown on /settings/notifications (bound to settings.notifications). */
export const NOTIFICATION_SETTING_TOGGLES: ReadonlyArray<{
  key: keyof z.output<typeof NotificationSettingsSchema>
  kind: 'switch' | 'days'
  label: BilingualLabel
  description: BilingualLabel
  templates: readonly NotificationTemplateCode[]
  options?: readonly number[]
}> = [
  {
    key: 'whatsapp_invoice',
    kind: 'switch',
    label: { en: 'Share bills on WhatsApp', ta: 'பில்களை வாட்ஸ்அப்பில் அனுப்பு' },
    description: {
      en: 'After billing, when the customer has a mobile number',
      ta: 'பில் போட்டவுடன், வாடிக்கையாளர் எண் இருந்தால்',
    },
    templates: ['invoice_share'],
  },
  {
    key: 'sms_invoice',
    kind: 'switch',
    label: { en: 'Send bills by SMS', ta: 'பில்களை SMS-இல் அனுப்பு' },
    description: { en: 'Short SMS with the bill link', ta: 'பில் இணைப்புடன் சிறிய SMS' },
    templates: ['invoice_share'],
  },
  {
    key: 'due_reminder_days',
    kind: 'days',
    label: { en: 'Due reminders', ta: 'நிலுவை நினைவூட்டல்கள்' },
    description: {
      en: 'Remind customers when their oldest unpaid bill is this many days old (10 am)',
      ta: 'பழைய நிலுவை பில் இத்தனை நாட்கள் ஆனதும் நினைவூட்டு (காலை 10 மணி)',
    },
    templates: ['due_reminder'],
    options: [7, 15, 30, 45, 60],
  },
  {
    key: 'daily_summary_to_owner',
    kind: 'switch',
    label: { en: 'Daily summary to owner', ta: 'உரிமையாளருக்குத் தினசரிச் சுருக்கம்' },
    description: {
      en: "Today's sales and collections at 9:30 pm",
      ta: 'இரவு 9:30 மணிக்கு அன்றைய விற்பனையும் வசூலும்',
    },
    templates: ['daily_summary'],
  },
  {
    key: 'low_stock_digest',
    kind: 'switch',
    label: { en: 'Low stock alert', ta: 'குறைந்த இருப்பு எச்சரிக்கை' },
    description: {
      en: 'Morning list of items to reorder',
      ta: 'மறு ஆர்டர் செய்ய வேண்டிய பொருட்களின் காலைப் பட்டியல்',
    },
    templates: ['low_stock_digest', 'expiry_digest'],
  },
]

// =============================================================================================
// Customer due reminder (POST /customers/:id/remind)
// =============================================================================================

/** 'wa_me' = no provider: returns the text and a wa.me link for the cashier's own WhatsApp. */
export const RemindChannelSchema = z.enum(['whatsapp', 'sms', 'wa_me'])
export type RemindChannel = z.infer<typeof RemindChannelSchema>

/**
 * POST /customers/:id/remind (customers.write). Needs a due (422 no_due). With
 * include_payment_link a payment link intent is created through the payments module (provider
 * link or the Kadai pay page /pay/<reference_code>, kind 'link', purpose customer_due) and put in
 * {{link}}; then a due_reminder notification is queued (whatsapp / sms: plan feature notifications,
 * customer opt-in for WhatsApp) — 'wa_me' queues nothing and works on every plan.
 */
export const CustomerRemindSchema = z.object({
  channel: RemindChannelSchema.default('whatsapp'),
  locale: LocaleSchema.optional().describe('Default: the business locale'),
  include_payment_link: z.boolean().default(true),
  amount_paise: zAmountPaise.optional().describe("Default: the customer's due (balance_paise)"),
  store_id: zId
    .optional()
    .describe("Store of the link (default: the customer's latest bill store)"),
  phone: zOptionalPhone.describe("Recipient override (default: the customer's phone)"),
})
export type CustomerRemind = z.input<typeof CustomerRemindSchema>

export const CustomerRemindResultSchema = z.object({
  customer_id: zId,
  due_paise: zAmountPaise,
  amount_paise: zAmountPaise,
  channel: RemindChannelSchema,
  notification: NotificationSchema.nullable(),
  link: z
    .object({
      intent: PaymentIntentSchema,
      url: z.string(),
      kind: z.enum(['provider', 'pay_page']),
    })
    .nullable(),
  /** Rendered message (preview / manual sharing). */
  message: z.string(),
  /** https://wa.me/<number>?text=… */
  wa_me_url: z.string().nullable(),
  /** Previous due_reminder to this customer. */
  last_reminded_at: zTimestamp.nullable(),
})
export type CustomerRemindResult = z.output<typeof CustomerRemindResultSchema>

/** https://wa.me/<digits>?text=<message> (number without '+'). */
export function waMeUrl(phoneE164: string, text: string): string {
  return `https://wa.me/${phoneE164.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`
}

// =============================================================================================
// Sending: jobs, retries, provider interface & registry
// =============================================================================================

export const NOTIFICATION_JOBS = {
  /** { tenant_id, notification_id } — enqueued after commit by core/notify.ts. */
  send: 'notifications.send',
  /** Every minute: re-enqueues 'queued' rows due and 'sending' rows stuck > 5 min. */
  sweep: 'notifications.sweep',
  /** Daily 10:00 IST. */
  dueReminders: 'notifications.due-reminders',
  /** Daily 21:30 IST. */
  dailySummary: 'notifications.daily-summary',
} as const

export const NOTIFICATION_CRONS = {
  sweep: '* * * * *',
  dueReminders: '0 10 * * *',
  dailySummary: '30 21 * * *',
} as const

export const NotificationSendJobSchema = z.object({ tenant_id: zId, notification_id: zId })
export type NotificationSendJob = z.output<typeof NotificationSendJobSchema>

/** Delivery attempts before a notification is 'failed' for good. */
export const NOTIFICATION_MAX_ATTEMPTS = 5
/** 'sending' longer than this is considered stuck (worker crash) and retried by the sweep. */
export const NOTIFICATION_STUCK_AFTER_SECONDS = 300

/** Delay before the next attempt after `attempts` failures: 30 s × 4^(n−1), at most 1 h. */
export function notificationRetryDelaySeconds(attempts: number): number {
  const n = Math.max(1, Math.trunc(attempts))
  return Math.min(3600, 30 * 4 ** (n - 1))
}

/** Minimum days between two due reminders to the same customer. */
export const DUE_REMINDER_MIN_GAP_DAYS = 3

/**
 * Due-reminder job selection: a due, WhatsApp/SMS allowed (opt-in for WhatsApp), the oldest
 * unpaid bill exactly N days old for an N in settings.notifications.due_reminder_days, and no
 * reminder in the last DUE_REMINDER_MIN_GAP_DAYS days.
 */
export function shouldSendDueReminder(c: {
  due_paise: number
  oldest_due_days: number | null
  reminder_days: readonly number[]
  can_message: boolean
  days_since_last_reminder: number | null
}): boolean {
  if (c.due_paise <= 0 || !c.can_message || c.oldest_due_days === null) return false
  if (!c.reminder_days.includes(c.oldest_due_days)) return false
  return (
    c.days_since_last_reminder === null || c.days_since_last_reminder >= DUE_REMINDER_MIN_GAP_DAYS
  )
}

/** Status order for delivery receipts (they may arrive out of order). */
const STATUS_RANK: Readonly<Record<NotificationStatus, number>> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
  cancelled: 5,
}

/**
 * The status after a delivery receipt, or null when it must be ignored: statuses only move
 * forward (sent → delivered → read); 'failed' from the provider applies unless already delivered /
 * read; cancelled rows never change.
 */
export function nextNotificationStatus(
  current: NotificationStatus,
  incoming: 'sent' | 'delivered' | 'read' | 'failed',
): NotificationStatus | null {
  if (current === 'cancelled' || current === incoming) return null
  if (incoming === 'failed') return current === 'delivered' || current === 'read' ? null : 'failed'
  if (current === 'failed') return incoming === 'sent' ? null : incoming
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : null
}

/** What a provider delivers (rendered by renderNotification; also the relay payload). */
export const OutboundMessageSchema = z.object({
  /** Outbox id (null for direct sends such as OTPs and relayed messages). */
  notification_id: zId.nullable(),
  tenant_id: zId.nullable(),
  channel: NotificationChannelSchema,
  template_code: z.string(),
  locale: LocaleSchema,
  /** E.164 phone or email. */
  to: z.string(),
  recipient_name: z.string().nullable(),
  subject: z.string().nullable(),
  /** Rendered text (SMS: the DLT-approved text; WhatsApp: display copy of the template). */
  body: z.string(),
  /** Placeholder values as strings (MSG91 Flow variables, relay). */
  params: z.record(z.string(), z.string()),
  /** DLT template id (SMS) or approved template name (WhatsApp override). */
  provider_template_id: z.string().nullable(),
  whatsapp: z
    .object({
      template_name: z.string(),
      language: LocaleSchema,
      body_params: z.array(z.string()),
      /** Dynamic suffix of a URL button, when the approved template has one. */
      button_url_param: z.string().nullable().default(null),
    })
    .nullable(),
  /** Provider-side de-duplication key (`<notification id>:<attempt>`). */
  idempotency_key: z.string().min(1).max(200),
})
export type OutboundMessage = z.output<typeof OutboundMessageSchema>
export type OutboundMessageInput = z.input<typeof OutboundMessageSchema>

/**
 * Renders a notification into the provider message (the send job and the vendor relay use the
 * same function): null when the template has no text for the channel. `attempt` (1-based) makes
 * the provider idempotency key `<id>:<attempt>`.
 */
export function buildOutboundMessage(input: {
  notification_id: string | null
  tenant_id: string | null
  code: NotificationTemplateCode
  channel: NotificationChannel
  locale: Locale
  to: string
  recipient_name?: string | null
  params: Readonly<Record<string, unknown>>
  override?: TemplateOverride | null
  attempt?: number
  /** Used when there is no notification id (OTP, relay client_ref). */
  idempotency_key?: string
}): OutboundMessage | null {
  const r = renderNotification({
    code: input.code,
    channel: input.channel,
    locale: input.locale,
    params: input.params,
    override: input.override ?? null,
  })
  if (!r) return null
  const key =
    input.idempotency_key ??
    `${input.notification_id ?? 'direct'}:${Math.max(1, Math.trunc(input.attempt ?? 1))}`
  return {
    notification_id: input.notification_id,
    tenant_id: input.tenant_id,
    channel: input.channel,
    template_code: input.code,
    locale: input.locale,
    to: input.to,
    recipient_name: input.recipient_name ?? null,
    subject: r.subject,
    body: r.body,
    params: stringifyParams(input.params),
    provider_template_id: r.provider_template_id,
    whatsapp: r.whatsapp ? { ...r.whatsapp, button_url_param: null } : null,
    idempotency_key: key.slice(0, 200),
  }
}

/**
 * Body of the vendor relay request (licensing RelayMessageRequestSchema) for a message the
 * on-prem `kadai_relay` provider sends: template-based — the vendor renders its registered
 * default texts (shop overrides are not DLT-registered with Kadai). client_ref = the outbox id.
 */
export function relayRequestFrom(message: OutboundMessage): {
  channel: NotificationChannel
  template_code: string
  locale: Locale
  to: string
  recipient_name?: string
  params: Record<string, string>
  client_ref: string
} {
  return {
    channel: message.channel,
    template_code: message.template_code,
    locale: message.locale,
    to: message.to,
    ...(message.recipient_name ? { recipient_name: message.recipient_name.slice(0, 120) } : {}),
    params: Object.fromEntries(
      Object.entries(message.params).map(([k, v]) => [k, v.slice(0, 1000)]),
    ),
    client_ref: (message.notification_id ?? message.idempotency_key).slice(0, 100),
  }
}

export const ProviderSendResultSchema = z.object({
  provider_message_id: z.string().nullable(),
  /** Accepted by the provider ('sent'), or already final ('delivered', e.g. the log provider). */
  status: z.enum(['sent', 'delivered']),
})
export type ProviderSendResult = z.output<typeof ProviderSendResultSchema>

export const NotificationErrorKindSchema = z.enum(['retryable', 'permanent'])
export type NotificationErrorKind = z.infer<typeof NotificationErrorKindSchema>

/** Error thrown by providers: `kind` decides between retry with backoff and failing for good. */
export class NotificationProviderError extends Error {
  override readonly name = 'NotificationProviderError'
  readonly kind: NotificationErrorKind
  readonly provider: string
  /** Short machine code, e.g. 'http_429', 'timeout', 'invalid_number', 'not_configured'. */
  readonly code: string
  readonly http_status: number | null
  readonly retry_after_seconds: number | null
  constructor(input: {
    message: string
    kind: NotificationErrorKind
    provider: string
    code: string
    http_status?: number | null
    retry_after_seconds?: number | null
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.kind = input.kind
    this.provider = input.provider
    this.code = input.code
    this.http_status = input.http_status ?? null
    this.retry_after_seconds = input.retry_after_seconds ?? null
  }
}

export function isNotificationProviderError(err: unknown): err is NotificationProviderError {
  return err instanceof NotificationProviderError
}

/** HTTP status → retryable (408, 425, 429, 5xx) or permanent (other 4xx). */
export function classifyHttpStatus(status: number): NotificationErrorKind {
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? 'retryable'
    : 'permanent'
}

/**
 * Normalises anything a provider threw: provider errors pass through; timeouts / network errors
 * (AbortError, TimeoutError, fetch TypeError, ECONNRESET …) and unknown errors are retryable.
 */
export function toNotificationProviderError(
  err: unknown,
  provider: string,
): NotificationProviderError {
  if (err instanceof NotificationProviderError) return err
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null
  const name = typeof e?.name === 'string' ? e.name : ''
  const code = typeof e?.code === 'string' ? e.code : ''
  const message = typeof e?.message === 'string' ? e.message : String(err)
  if (name === 'AbortError' || name === 'TimeoutError')
    return new NotificationProviderError({
      message,
      kind: 'retryable',
      provider,
      code: 'timeout',
      cause: err,
    })
  if (
    name === 'TypeError' ||
    /^E(CONN|TIMEDOUT|AI_AGAIN|NOTFOUND|PIPE|HOSTUNREACH|NETUNREACH)/.test(code)
  )
    return new NotificationProviderError({
      message,
      kind: 'retryable',
      provider,
      code: 'network',
      cause: err,
    })
  return new NotificationProviderError({
    message,
    kind: 'retryable',
    provider,
    code: 'unknown',
    cause: err,
  })
}

export interface ProviderSendOptions {
  /** Abort the provider call after this many milliseconds (default 10 000). */
  timeout_ms?: number
}

export const PROVIDER_DEFAULT_TIMEOUT_MS = 10_000

/**
 * A delivery channel adapter (modules/notifications/providers/*, onprem's kadai_relay). `send`
 * resolves with the provider message id or throws (preferably a NotificationProviderError; other
 * errors are classified by classifyError ?? toNotificationProviderError).
 */
export interface NotificationProvider {
  readonly code: NotificationProviderCode
  readonly channels: readonly NotificationChannel[]
  /** Credentials present; unconfigured providers are skipped by forChannel(). */
  readonly configured: boolean
  /** Status card data (never secrets). */
  status?(channel: NotificationChannel): Omit<NotificationProviderStatus, 'channel' | 'provider'>
  send(message: OutboundMessage, opts?: ProviderSendOptions): Promise<ProviderSendResult>
  classifyError?(err: unknown): NotificationProviderError
}

export interface NotificationProviderRegistry {
  /** Adds a provider; a second provider with the same code throws unless `replace`. */
  register(provider: NotificationProvider, opts?: { replace?: boolean }): void
  unregister(code: NotificationProviderCode): boolean
  get(code: NotificationProviderCode): NotificationProvider | undefined
  list(): NotificationProvider[]
  /** Pins the provider of a channel (SMS_PROVIDER / WHATSAPP_PROVIDER / EMAIL_PROVIDER, relay); null = automatic. */
  select(channel: NotificationChannel, code: NotificationProviderCode | null): void
  selected(channel: NotificationChannel): NotificationProviderCode | null
  /**
   * The provider for a channel: the pinned one when registered, else the first registered
   * configured non-log provider of the channel, else 'log' when registered.
   */
  forChannel(channel: NotificationChannel): NotificationProvider | undefined
}

export function createNotificationProviderRegistry(
  initial: readonly NotificationProvider[] = [],
): NotificationProviderRegistry {
  const providers = new Map<NotificationProviderCode, NotificationProvider>()
  const pinned = new Map<NotificationChannel, NotificationProviderCode>()
  const registry: NotificationProviderRegistry = {
    register(provider, opts = {}) {
      if (providers.has(provider.code) && !opts.replace)
        throw new Error(`notification provider "${provider.code}" is already registered`)
      providers.set(provider.code, provider)
    },
    unregister(code) {
      return providers.delete(code)
    },
    get(code) {
      return providers.get(code)
    },
    list() {
      return [...providers.values()]
    },
    select(channel, code) {
      if (code === null) pinned.delete(channel)
      else pinned.set(channel, code)
    },
    selected(channel) {
      return pinned.get(channel) ?? null
    },
    forChannel(channel) {
      const pin = pinned.get(channel)
      const p = pin ? providers.get(pin) : undefined
      if (p && p.channels.includes(channel)) return p
      for (const candidate of providers.values())
        if (
          candidate.code !== 'log' &&
          candidate.configured &&
          candidate.channels.includes(channel)
        )
          return candidate
      const log = providers.get('log')
      return log && log.channels.includes(channel) ? log : undefined
    },
  }
  for (const p of initial) registry.register(p)
  return registry
}

/**
 * Calls a provider and normalises the outcome (never throws): ok with the result, or the
 * classified error. The send job maps retryable errors to a retry (NOTIFICATION_MAX_ATTEMPTS)
 * and permanent ones to status 'failed'.
 */
export async function sendWithProvider(
  provider: NotificationProvider,
  message: OutboundMessage,
  opts: ProviderSendOptions = {},
): Promise<
  | { ok: true; provider: NotificationProviderCode; result: ProviderSendResult }
  | { ok: false; provider: NotificationProviderCode; error: NotificationProviderError }
> {
  try {
    const result = await provider.send(message, opts)
    return { ok: true, provider: provider.code, result }
  } catch (err) {
    const error = provider.classifyError
      ? provider.classifyError(err)
      : toNotificationProviderError(err, provider.code)
    return { ok: false, provider: provider.code, error }
  }
}

// =============================================================================================
// Provider wire formats & webhooks
// =============================================================================================

/** Webhook paths (fixed by ingress rules); prefix PUBLIC_BASE_URL. */
export function notificationWebhookPath(provider: 'whatsapp_cloud' | 'msg91'): string {
  return `/webhooks/notifications/${provider}`
}

/** WhatsApp Cloud API language codes of our locales. */
export const WHATSAPP_LANGUAGE: Readonly<Record<Locale, string>> = { ta: 'ta', en: 'en' }

/**
 * Body of POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/messages for a template
 * message (bearer WHATSAPP_ACCESS_TOKEN).
 */
export function whatsappTemplateRequest(message: OutboundMessage): Record<string, unknown> {
  const wa = message.whatsapp
  if (!wa) throw new RangeError('message.whatsapp is required for WhatsApp')
  const components: Array<Record<string, unknown>> = [
    { type: 'body', parameters: wa.body_params.map((text) => ({ type: 'text', text })) },
  ]
  if (wa.button_url_param)
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: wa.button_url_param }],
    })
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: wa.template_name,
      language: { code: WHATSAPP_LANGUAGE[wa.language] },
      components,
    },
  }
}

/**
 * Body of POST https://control.msg91.com/api/v5/flow (header authkey: MSG91_AUTH_KEY): the DLT
 * template id plus the placeholder values as named variables (##shop_name## … in the MSG91 flow).
 */
export function msg91FlowRequest(
  message: OutboundMessage,
  templateId: string,
  senderId?: string | null,
): Record<string, unknown> {
  return {
    template_id: templateId,
    short_url: '0',
    ...(senderId ? { sender: senderId } : {}),
    recipients: [{ mobiles: message.to.replace(/^\+/, ''), ...message.params }],
  }
}

/** Payload POSTed to EMAIL_WEBHOOK_URL by the email_webhook provider (X-Kadai-Signature: sha256=<hmac of the raw body with EMAIL_WEBHOOK_SECRET>). */
export const EmailWebhookPayloadSchema = z.object({
  event: z.literal('notification.email'),
  id: z.string(),
  tenant_id: zId.nullable(),
  notification_id: zId.nullable(),
  template_code: z.string(),
  locale: LocaleSchema,
  from: z.string(),
  to: z.string(),
  to_name: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
})
export type EmailWebhookPayload = z.output<typeof EmailWebhookPayloadSchema>

export const NotificationWebhookParamsSchema = z.object({
  provider: z.enum(['whatsapp_cloud', 'msg91']),
})

/** GET verification of the WhatsApp webhook (answer hub.challenge as text/plain; 403 on token mismatch). */
export const WhatsAppVerifyQuerySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
})

/** Lower-case hex digest of `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 of the raw body with WHATSAPP_APP_SECRET), or null. */
export function parseHubSignature(header: string | null | undefined): string | null {
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header?.trim() ?? '')
  return m ? m[1]!.toLowerCase() : null
}

/** One delivery receipt, provider-neutral. */
export interface DeliveryReceipt {
  provider_message_id: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  at: string | null
  error: string | null
}

const WhatsAppStatusesSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({
                  statuses: z
                    .array(
                      z.object({
                        id: z.string(),
                        status: z.string(),
                        timestamp: z.string().optional(),
                        errors: z
                          .array(
                            z.object({
                              code: z.number().optional(),
                              title: z.string().optional(),
                              message: z.string().optional(),
                            }),
                          )
                          .optional(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
})

/** Status callbacks of a WhatsApp Cloud API webhook body (messages, other fields are ignored). */
export function parseWhatsAppStatuses(body: unknown): DeliveryReceipt[] {
  const parsed = WhatsAppStatusesSchema.safeParse(body)
  if (!parsed.success) return []
  const out: DeliveryReceipt[] = []
  for (const entry of parsed.data.entry ?? [])
    for (const change of entry.changes ?? [])
      for (const s of change.value?.statuses ?? []) {
        if (
          s.status !== 'sent' &&
          s.status !== 'delivered' &&
          s.status !== 'read' &&
          s.status !== 'failed'
        )
          continue
        const err = s.errors?.[0]
        out.push({
          provider_message_id: s.id,
          status: s.status,
          at:
            s.timestamp && /^\d+$/.test(s.timestamp)
              ? new Date(Number(s.timestamp) * 1000).toISOString()
              : null,
          error: err ? [err.code, err.title ?? err.message].filter(Boolean).join(' ') : null,
        })
      }
  return out
}

/**
 * MSG91 delivery report (lenient: `{ requestId, report: [{ number, status, desc }] }` objects, an
 * array of them, or `{ data: [...] }`). desc/status DELIVERED → delivered; FAILED / REJECTED /
 * NDNC / BLOCKED / EXPIRED → failed; others → sent. Keyed by the Flow request id.
 */
export function parseMsg91Report(body: unknown): DeliveryReceipt[] {
  const items: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [body]
  const out: DeliveryReceipt[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = o.requestId ?? o.request_id
    if (typeof id !== 'string') continue
    const reports = Array.isArray(o.report) ? o.report : [o]
    for (const r of reports) {
      const rr = (r ?? {}) as Record<string, unknown>
      const text = `${String(rr.desc ?? '')} ${String(rr.status ?? '')}`.toUpperCase()
      const status = /DELIVERED/.test(text)
        ? 'delivered'
        : /FAIL|REJECT|NDNC|BLOCK|EXPIRED|INVALID/.test(text)
          ? 'failed'
          : 'sent'
      out.push({
        provider_message_id: id,
        status,
        at: typeof rr.date === 'string' ? rr.date : null,
        error: status === 'failed' ? String(rr.desc ?? rr.status ?? 'failed') : null,
      })
    }
  }
  return out
}

// =============================================================================================
// Route catalogue (docs/API.md "notifications")
// =============================================================================================

const IdParams = z.object({ id: zId })

export const notificationsRoutes = defineRoutes({
  listNotifications: {
    method: 'GET',
    path: '/notifications',
    permission: 'settings.manage',
    query: NotificationListQuerySchema,
    response: NotificationListResponseSchema,
    summary: 'Message outbox (SMS / WhatsApp / email) with status counts',
  },
  getNotification: {
    method: 'GET',
    path: '/notifications/:id',
    permission: 'settings.manage',
    params: IdParams,
    response: dataOf(NotificationSchema),
  },
  retryNotification: {
    method: 'POST',
    path: '/notifications/:id/retry',
    permission: 'settings.manage',
    params: IdParams,
    response: dataOf(NotificationSchema),
    summary: 'Queue a failed / cancelled message again (attempts reset; 409 not_retryable)',
  },
  sendNotification: {
    method: 'POST',
    path: '/notifications/send',
    permission: 'notifications.send',
    feature: 'notifications',
    idempotent: true,
    body: NotificationSendSchema,
    response: dataOf(NotificationSchema),
    status: 201,
    summary: 'Queue a template message (no free text over SMS: DLT); rate limited',
  },
  listTemplates: {
    method: 'GET',
    path: '/notification-templates',
    permission: 'settings.manage',
    query: NotificationTemplateListQuerySchema,
    response: dataOf(NotificationTemplateCatalogSchema),
    summary: 'Default templates merged with overrides, provider status and settings',
  },
  upsertTemplate: {
    method: 'PUT',
    path: '/notification-templates/:code/:channel/:locale',
    permission: 'settings.manage',
    feature: 'notifications',
    params: NotificationTemplateParamsSchema,
    body: NotificationTemplateUpsertSchema,
    response: dataOf(NotificationTemplateEntrySchema),
    summary: 'Save a tenant override (placeholder validation; SMS needs its DLT template id)',
  },
  deleteTemplate: {
    method: 'DELETE',
    path: '/notification-templates/:code/:channel/:locale',
    permission: 'settings.manage',
    params: NotificationTemplateParamsSchema,
    response: dataOf(NotificationTemplateEntrySchema),
    summary: 'Remove the override (back to the default text)',
  },
  remindCustomer: {
    method: 'POST',
    path: '/customers/:id/remind',
    permission: 'customers.write',
    idempotent: true,
    params: IdParams,
    body: CustomerRemindSchema.prefault({}),
    response: dataOf(CustomerRemindResultSchema),
    summary: 'Due reminder with a UPI payment link (WhatsApp / SMS, or a wa.me link)',
  },
  webhook: {
    method: 'POST',
    path: '/notifications/:provider',
    scope: 'webhook',
    auth: 'public',
    params: NotificationWebhookParamsSchema,
    response: dataOf(WebhookAckSchema),
    summary: 'Delivery receipts (WhatsApp: X-Hub-Signature-256 verified; MSG91 DLR)',
  },
  webhookVerify: {
    method: 'GET',
    path: '/notifications/:provider',
    scope: 'webhook',
    auth: 'public',
    params: NotificationWebhookParamsSchema,
    query: WhatsAppVerifyQuerySchema,
    summary: 'WhatsApp webhook verification: answers hub.challenge (text/plain)',
  },
})
export type NotificationsRoutes = typeof notificationsRoutes
