/**
 * Contract for the payments module — docs/API.md "payments & UPI"; ARCHITECTURE.md §8.4 (core
 * recordPayment / cancelPayment), §11 (providers, intents, webhooks, dues collection).
 *
 *  - Payment provider accounts (shop UPI ID, Razorpay, dev mock): secrets are write-only — the API
 *    returns `key_id_masked`, `has_credentials` and `has_webhook_secret`, never the values.
 *  - Payment intents: one UPI QR / link per collection, `created → pending → paid | failed |
 *    expired | cancelled`; live status over SSE (`/stream`) with a long-poll fallback (`?wait=`).
 *    A paid intent is consumed exactly once by a payment (POS tender, apply, link receipt).
 *  - Receipts (in) & payment vouchers (out) with allocations to documents.
 *  - Public pay page for dues links, provider webhooks.
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope
 * (dataOf / listOf); money in integer paise. Validation messages of custom rules are snake_case
 * keys (PAYMENTS_VALIDATION_KEYS), translated by the web (errors:validation.<key>, else
 * payments:validation.<key>).
 *
 * The query/body helpers at the top (zQueryList, zQueryInt, zIfUpdatedAt, zNullableText) are
 * also used by the sales and purchases contracts.
 */
import { z } from 'zod'
import {
  AllocationTargetTypeSchema,
  type AllocationTargetType,
  NotificationChannelSchema,
  PartyTypeSchema,
  PaymentConfirmationSchema,
  PaymentDirectionSchema,
  type PaymentDirection,
  PaymentIntentKindSchema,
  PaymentIntentPurposeSchema,
  PaymentIntentStatusSchema,
  type PaymentIntentStatus,
  PaymentMethodSchema,
  type PaymentMethod,
  PaymentProviderCodeSchema,
  type PaymentProviderCode,
  PaymentStatusSchema,
  ProviderModeSchema,
} from '../enums'
import { isValidVpa, normalizeVpa, UPI_REFERENCE_RE } from '../upi'
import {
  PageQuerySchema,
  dataOf,
  defineRoutes,
  listOf,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zId,
  zIdempotencyKey,
  zOptionalPhone,
  zPaise,
  zSearchQuery,
  zTimestamp,
} from './common'

// =============================================================================================
// Query / body helpers (shared by the payments, sales and purchases contracts)
// =============================================================================================

/**
 * One or more values of a query parameter: `?status=a&status=b` (repeated keys — what the web
 * client sends for arrays) or a single `?status=a`. Always parses to an array.
 */
export function zQueryList<T extends z.ZodType>(item: T) {
  return z
    .union([item, z.array(item).min(1).max(50)])
    .transform((v): z.output<T>[] => (Array.isArray(v) ? v : [v]) as z.output<T>[])
}

/** Integer query parameter coerced from the query string. */
export function zQueryInt(min: number, max: number) {
  return z.coerce.number().int().min(min).max(max)
}

/** Optimistic concurrency for PATCH bodies (ARCHITECTURE.md §7.3) → 409 STALE_WRITE. */
export const zIfUpdatedAt = zTimestamp
  .optional()
  .describe('updated_at the client last saw; when it differs from the stored row → 409 STALE_WRITE')

/** Optional clearable text: missing → undefined (unchanged), null / '' → null, else trimmed. */
export function zNullableText(max: number) {
  return z
    .union([z.null(), z.string().trim().max(max)])
    .optional()
    .transform((v) => (v === '' ? null : v))
}

/** Positive amount in paise (> 0). */
export const zAmountPaise = z.int().min(1)

/** Non-negative quantity in milli units (returned / free / pending quantities; may be 0). */
export const zMilli0 = z.int().min(0)

/** Cancellation / reversal reason (required, audited). */
export const zReason = z.string().trim().min(3, 'reason_required').max(500)

/** `?format=csv` on list endpoints: the same filters, streamed as CSV (no pagination). */
export const zListFormat = z.enum(['json', 'csv']).default('json')

/** Business date range filter fields (inclusive, tenant timezone). */
export const DATE_RANGE_FIELDS = { from: zDateStr.optional(), to: zDateStr.optional() }

/** Refinement: from ≤ to. */
export function dateOrderOk(v: { from?: string | undefined; to?: string | undefined }): boolean {
  return !v.from || !v.to || v.from <= v.to
}
export const DATE_ORDER_ISSUE = { message: 'date_order', path: ['to'] }

// =============================================================================================
// Validation keys & labels
// =============================================================================================

/** Message keys of the custom rules in this contract (web: payments:validation.<key>). */
export const PAYMENTS_VALIDATION_KEYS = [
  'vpa_invalid',
  'payee_name_required',
  'mcc_invalid',
  'razorpay_key_id_invalid',
  'razorpay_key_mode_mismatch',
  'utr_invalid',
  'ref_pair_required',
  'ref_required_for_purpose',
  'customer_required_for_purpose',
  'allocations_exceed_amount',
  'allocations_and_auto_allocate',
  'allocation_target_not_allowed',
  'store_credit_needs_customer',
  'party_pair_required',
  'reason_required',
  'date_order',
  'empty_patch',
] as const
export type PaymentsValidationKey = (typeof PAYMENTS_VALIDATION_KEYS)[number]

type Bilingual = { readonly en: string; readonly ta: string }

/** Printed / displayed labels of payment methods (receipts, invoices, reports). */
export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, Bilingual>> = {
  cash: { en: 'Cash', ta: 'ரொக்கம்' },
  upi: { en: 'UPI', ta: 'UPI' },
  card: { en: 'Card', ta: 'கார்டு' },
  bank_transfer: { en: 'Bank transfer', ta: 'வங்கிப் பரிமாற்றம்' },
  cheque: { en: 'Cheque', ta: 'காசோலை' },
  wallet: { en: 'Wallet', ta: 'வாலட்' },
  store_credit: { en: 'Store credit', ta: 'கடை வரவு' },
  other: { en: 'Other', ta: 'மற்றவை' },
}

/** Label of the unpaid remainder of a bill (khata / credit sale). */
export const CREDIT_DUE_LABEL: Bilingual = { en: 'Credit (khata)', ta: 'கடன் (கணக்கு)' }

/** UPI merchant category codes offered in the payment setup (preset by business type). */
export const UPI_MCC_OPTIONS: ReadonlyArray<{ code: string } & Bilingual> = [
  { code: '5411', en: 'Grocery / supermarket', ta: 'மளிகை / பல்பொருள் அங்காடி' },
  { code: '5912', en: 'Pharmacy', ta: 'மருந்தகம்' },
  { code: '5651', en: 'Clothing', ta: 'ஆடைகள்' },
  { code: '5661', en: 'Footwear', ta: 'காலணிகள்' },
  { code: '5732', en: 'Electronics', ta: 'மின்னணுப் பொருட்கள்' },
  { code: '5251', en: 'Hardware', ta: 'வன்பொருள்' },
  { code: '5462', en: 'Bakery & sweets', ta: 'பேக்கரி & இனிப்புகள்' },
  { code: '5943', en: 'Stationery', ta: 'எழுதுபொருட்கள்' },
  { code: '5399', en: 'General merchandise', ta: 'பொதுப் பொருட்கள்' },
]

// =============================================================================================
// Providers
// =============================================================================================

export interface ProviderCapabilities {
  /** Single-use, fixed-amount QR with automatic confirmation. */
  dynamic_qr: boolean
  /** Hosted payment links (dues collection). */
  links: boolean
  webhooks: boolean
  /** Status can be fetched by the poll-intents job (works on-prem without a public URL). */
  polling: boolean
  /** Refunds through the provider API (otherwise refunds are done manually in the PSP app). */
  refunds: boolean
  /** Cashier confirms receipt (soundbox / phone), optional UTR — `confirmation='manual'`. */
  manual_confirm: boolean
  /** Adapter exists in this release (cashfree / phonepe / paytm follow the same interface). */
  implemented: boolean
}

const NONE: ProviderCapabilities = {
  dynamic_qr: false,
  links: false,
  webhooks: false,
  polling: false,
  refunds: false,
  manual_confirm: false,
  implemented: false,
}

/** Capabilities per provider (ARCHITECTURE.md §11.1). */
export const PROVIDER_CAPABILITIES: Readonly<Record<PaymentProviderCode, ProviderCapabilities>> = {
  upi_vpa: { ...NONE, manual_confirm: true, implemented: true },
  razorpay: {
    ...NONE,
    dynamic_qr: true,
    links: true,
    webhooks: true,
    polling: true,
    implemented: true,
  },
  mock: { ...NONE, dynamic_qr: true, links: true, polling: true, implemented: true },
  cashfree: NONE,
  phonepe: NONE,
  paytm: NONE,
}

export const ProviderCapabilitiesSchema = z.object({
  dynamic_qr: z.boolean(),
  links: z.boolean(),
  webhooks: z.boolean(),
  polling: z.boolean(),
  refunds: z.boolean(),
  manual_confirm: z.boolean(),
  implemented: z.boolean(),
})

/** Providers that need plan feature `upi_dynamic` (create, and intents through them). */
export const DYNAMIC_PROVIDER_CODES = ['razorpay', 'cashfree', 'phonepe', 'paytm', 'mock'] as const
export function isDynamicProvider(code: PaymentProviderCode): boolean {
  return (DYNAMIC_PROVIDER_CODES as readonly string[]).includes(code)
}

/** Razorpay webhook events to enable on the dashboard (shown in the setup screen). */
export const RAZORPAY_WEBHOOK_EVENTS = [
  'qr_code.credited',
  'payment_link.paid',
  'payment.failed',
] as const

/** Webhook path for a provider account (prefix with PUBLIC_BASE_URL): fixed by ingress rules. */
export function paymentWebhookPath(provider: PaymentProviderCode, accountId: string): string {
  return `/webhooks/payments/${provider}/${accountId}`
}

/** 'rzp_live_AbCdEfGh1234' → 'rzp_live_••••1234' (the only form a key id is ever returned in). */
export function maskKeyId(keyId: string): string {
  const m = /^(rzp_(?:test|live)_)(.*)$/.exec(keyId)
  const prefix = m?.[1] ?? ''
  const rest = m?.[2] ?? keyId
  return `${prefix}••••${rest.slice(-4)}`
}

const RAZORPAY_KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/

const zVpa = z
  .string()
  .trim()
  .refine(isValidVpa, { message: 'vpa_invalid' })
  .transform(normalizeVpa)
  .describe("Shop UPI ID (VPA), e.g. 'murugan.stores@okaxis' (stored lower-case)")

/** UPI payee name (`pn`) shown in the customer's UPI app. */
const zPayeeName = z.string().trim().min(1, 'payee_name_required').max(50)

const zMcc = z
  .string()
  .trim()
  .regex(/^\d{4}$/, 'mcc_invalid')
  .describe('UPI merchant category code (5411 grocery, 5912 pharmacy, …), see UPI_MCC_OPTIONS')

const RazorpayCredentialsSchema = z.object({
  key_id: z.string().trim().regex(RAZORPAY_KEY_ID_RE, 'razorpay_key_id_invalid'),
  key_secret: z.string().trim().min(8).max(128),
})

/** Provider account as returned by the API (secrets are never returned). */
export const PaymentProviderAccountSchema = z.object({
  id: zId,
  /** null = available in every store. */
  store_id: zId.nullable(),
  store_name: z.string().nullable(),
  provider: PaymentProviderCodeSchema,
  display_name: z.string(),
  mode: ProviderModeSchema,
  vpa: z.string().nullable(),
  payee_name: z.string().nullable(),
  merchant_code: z.string().nullable(),
  key_id_masked: z.string().nullable().describe("e.g. 'rzp_live_••••1234'; never the full key"),
  has_credentials: z.boolean(),
  has_webhook_secret: z.boolean(),
  /** Absolute URL to configure at the provider (webhook-capable providers only). */
  webhook_url: z.string().nullable(),
  /** Events to enable at the provider (RAZORPAY_WEBHOOK_EVENTS for Razorpay). */
  webhook_events: z.array(z.string()),
  settlement_account_id: zId.nullable(),
  settlement_account_name: z.string().nullable(),
  is_default: z.boolean(),
  is_active: z.boolean(),
  last_verified_at: zTimestamp.nullable(),
  capabilities: ProviderCapabilitiesSchema,
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type PaymentProviderAccount = z.output<typeof PaymentProviderAccountSchema>

/** Public fields of a provider (POS bootstrap, invoice print QR): no secrets, no ledger ids. */
export const PaymentProviderPublicSchema = z.object({
  id: zId,
  store_id: zId.nullable(),
  provider: PaymentProviderCodeSchema,
  display_name: z.string(),
  mode: ProviderModeSchema,
  vpa: z.string().nullable(),
  payee_name: z.string().nullable(),
  merchant_code: z.string().nullable(),
  is_default: z.boolean(),
  capabilities: ProviderCapabilitiesSchema,
})
export type PaymentProviderPublic = z.output<typeof PaymentProviderPublicSchema>

const ProviderCommonFields = {
  display_name: z.string().trim().min(1).max(80),
  store_id: zId
    .nullable()
    .optional()
    .describe('Store the account serves; null/absent = all stores'),
  settlement_account_id: zId
    .nullable()
    .optional()
    .describe('Bank ledger account the money settles into (accounts of type asset)'),
  is_default: z
    .boolean()
    .optional()
    .describe('Make it the default of its store (the previous default is switched off)'),
}

/** POST /payment-providers — one shape per provider. */
export const PaymentProviderCreateSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('upi_vpa'),
    ...ProviderCommonFields,
    vpa: zVpa,
    payee_name: zPayeeName,
    merchant_code: zMcc.optional(),
  }),
  z
    .object({
      provider: z.literal('razorpay'),
      ...ProviderCommonFields,
      mode: ProviderModeSchema.default('live'),
      credentials: RazorpayCredentialsSchema,
      webhook_secret: z.string().trim().min(8).max(256).optional(),
      /** Name on the QR (defaults to the shop name, ≤ 50 characters). */
      payee_name: zPayeeName.optional(),
      merchant_code: zMcc.optional(),
    })
    .refine((v) => v.credentials.key_id.startsWith(`rzp_${v.mode}_`), {
      message: 'razorpay_key_mode_mismatch',
      path: ['credentials', 'key_id'],
    }),
  z.object({
    provider: z.literal('mock'),
    ...ProviderCommonFields,
    /** Auto-pay this many ms after an intent is created (0 = only via mock-pay). */
    auto_pay_delay_ms: z.int().min(0).max(600_000).optional(),
  }),
])
export type PaymentProviderCreate = z.input<typeof PaymentProviderCreateSchema>
export type PaymentProviderCreateParsed = z.output<typeof PaymentProviderCreateSchema>

/**
 * PATCH /payment-providers/:id — fields that do not apply to the account's provider are 422.
 * `credentials` replaces both key id and secret; `webhook_secret: null` removes it.
 */
export const PaymentProviderUpdateSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80).optional(),
    store_id: zId.nullable().optional(),
    mode: ProviderModeSchema.optional(),
    vpa: zVpa.optional(),
    payee_name: zPayeeName.nullable().optional(),
    merchant_code: zMcc.nullable().optional(),
    credentials: RazorpayCredentialsSchema.optional(),
    webhook_secret: z.string().trim().min(8).max(256).nullable().optional(),
    settlement_account_id: zId.nullable().optional(),
    is_default: z.boolean().optional(),
    is_active: z.boolean().optional(),
    auto_pay_delay_ms: z.int().min(0).max(600_000).optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at'), {
    message: 'empty_patch',
  })
export type PaymentProviderUpdate = z.input<typeof PaymentProviderUpdateSchema>

export const PaymentProviderListQuerySchema = PageQuerySchema.extend({
  store_id: zId.optional().describe('Accounts of this store plus the all-stores accounts'),
  provider: zQueryList(PaymentProviderCodeSchema).optional(),
  is_active: zBooleanQuery.optional(),
})
export type PaymentProviderListQuery = z.input<typeof PaymentProviderListQuerySchema>

/** POST /payment-providers/:id/test */
export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  provider: PaymentProviderCodeSchema,
  checked_at: zTimestamp,
  /** Provider error code when ok = false (e.g. 'BAD_REQUEST_ERROR'). */
  error_code: z.string().nullable(),
  message: z.string().nullable(),
  /** upi_vpa: a ₹1 `upi://pay` URI the owner scans with their own phone to verify the VPA. */
  test_upi_uri: z.string().nullable(),
})
export type ProviderTestResult = z.output<typeof ProviderTestResultSchema>

// =============================================================================================
// Payment intents
// =============================================================================================

/** What an intent's ref_type/ref_id point at. `pos_cart` ref_id = the POS cart's client_ref. */
export const PaymentIntentRefTypeSchema = z.enum(['pos_cart', 'sales_invoice', 'customer'])
export type PaymentIntentRefType = z.infer<typeof PaymentIntentRefTypeSchema>

/** Statuses after which nothing changes any more (SSE streams close). */
export const TERMINAL_INTENT_STATUSES = ['paid', 'failed', 'expired', 'cancelled'] as const
export function isTerminalIntentStatus(status: PaymentIntentStatus): boolean {
  return (TERMINAL_INTENT_STATUSES as readonly string[]).includes(status)
}

/** Polling backoff of the poll-intents job by poll_count: 3 s, 5 s, 10 s, then every 30 s. */
export const INTENT_POLL_BACKOFF_SECONDS = [3, 5, 10, 30] as const
export function intentPollDelaySeconds(pollCount: number): number {
  const i = Math.max(0, Math.min(Math.trunc(pollCount), INTENT_POLL_BACKOFF_SECONDS.length - 1))
  return INTENT_POLL_BACKOFF_SECONDS[i]!
}

/** SSE event name carrying a PaymentIntent JSON (GET /payments/intents/:id/stream). */
export const INTENT_STREAM_EVENT = 'intent'
/** Heartbeat comment interval of the SSE stream. */
export const INTENT_STREAM_HEARTBEAT_SECONDS = 15
/** Maximum `?wait=` of the long-poll fallback. */
export const INTENT_LONG_POLL_MAX_SECONDS = 25

export const PaymentIntentSchema = z.object({
  id: zId,
  store_id: zId,
  register_id: zId.nullable(),
  provider_account_id: zId,
  provider: PaymentProviderCodeSchema,
  provider_display_name: z.string(),
  kind: PaymentIntentKindSchema,
  purpose: PaymentIntentPurposeSchema,
  ref_type: PaymentIntentRefTypeSchema.nullable(),
  ref_id: zId.nullable(),
  customer_id: zId.nullable(),
  customer_name: z.string().nullable(),
  /** 12-character code sent as UPI `tr` / provider receipt; also the public pay page code. */
  reference_code: z.string(),
  amount_paise: zAmountPaise,
  currency: z.literal('INR'),
  status: PaymentIntentStatusSchema,
  /** `upi://pay?…` to render as a QR (static VPA and dynamic providers that return one). */
  upi_uri: z.string().nullable(),
  /** Provider-hosted QR image (Razorpay `image_url`); render this when upi_uri is null. */
  image_url: z.string().nullable(),
  /** Payment link (kind 'link'): provider short URL or the Kadai pay page. */
  short_url: z.string().nullable(),
  provider_ref: z.string().nullable(),
  provider_payment_id: z.string().nullable(),
  payer_vpa: z.string().nullable(),
  payer_name: z.string().nullable(),
  utr: z.string().nullable(),
  /** Amount actually received; may differ from amount_paise (then amount_mismatch). */
  paid_amount_paise: z.int().nullable(),
  fee_paise: z.int().nullable(),
  amount_mismatch: z.boolean(),
  confirmation: PaymentConfirmationSchema.nullable(),
  confirmed_by: zId.nullable(),
  confirmed_by_name: z.string().nullable(),
  /** The payment that consumed this intent (null = paid but unapplied, see reconciliation). */
  payment_id: zId.nullable(),
  payment_number: z.string().nullable(),
  expires_at: zTimestamp.nullable(),
  /** Seconds until expires_at at response time (clock-skew-free countdown); null when none. */
  expires_in_seconds: z.int().min(0).nullable(),
  paid_at: zTimestamp.nullable(),
  failure_reason: z.string().nullable(),
  poll_count: z.int().min(0),
  last_polled_at: zTimestamp.nullable(),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type PaymentIntent = z.output<typeof PaymentIntentSchema>

/** POST /payments/intents */
export const PaymentIntentCreateSchema = z
  .object({
    amount_paise: zAmountPaise,
    purpose: PaymentIntentPurposeSchema,
    store_id: zId,
    register_id: zId.optional(),
    ref_type: PaymentIntentRefTypeSchema.optional(),
    ref_id: zId.optional().describe('pos_cart: the cart client_ref (UUID); else the document id'),
    customer_id: zId.optional(),
    provider_account_id: zId
      .optional()
      .describe("Default: the store's default active provider, else the all-stores default"),
    /** UPI transaction note (`tn`, ≤ 50 characters), e.g. the shop name + bill reference. */
    note: z.string().trim().max(50).optional(),
    /** Same key → the same intent (also taken from the Idempotency-Key header). */
    idempotency_key: zIdempotencyKey.optional(),
  })
  .refine((v) => (v.ref_type === undefined) === (v.ref_id === undefined), {
    message: 'ref_pair_required',
    path: ['ref_id'],
  })
  .refine((v) => v.purpose !== 'invoice_due' || v.ref_type === 'sales_invoice', {
    message: 'ref_required_for_purpose',
    path: ['ref_type'],
  })
  .refine((v) => v.purpose !== 'customer_due' || v.customer_id !== undefined, {
    message: 'customer_required_for_purpose',
    path: ['customer_id'],
  })
export type PaymentIntentCreate = z.input<typeof PaymentIntentCreateSchema>

/** GET /payments/intents/:id — `wait` turns it into a long poll (fallback for SSE). */
export const PaymentIntentGetQuerySchema = z.object({
  wait: zQueryInt(0, INTENT_LONG_POLL_MAX_SECONDS)
    .optional()
    .describe('Seconds to wait for a status different from since_status (0 = answer now)'),
  since_status: PaymentIntentStatusSchema.optional().describe(
    'Status the client already knows (default: the status at request time)',
  ),
})
export type PaymentIntentGetQuery = z.input<typeof PaymentIntentGetQuerySchema>

/** POST /payments/intents/:id/confirm — manual confirmation (upi_vpa only, audited). */
export const PaymentIntentConfirmSchema = z
  .object({
    utr: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{6,35}$/, 'utr_invalid')
      .optional()
      .describe('UTR / RRN from the payer app or bank SMS (usually 12 digits)'),
    payer_vpa: z.string().trim().refine(isValidVpa, { message: 'vpa_invalid' }).optional(),
    /** Amount received when it differs from the intent amount (recorded as a mismatch). */
    paid_amount_paise: zAmountPaise.optional(),
    note: z.string().trim().max(200).optional(),
  })
  .prefault({})
export type PaymentIntentConfirm = z.input<typeof PaymentIntentConfirmSchema>

/** POST /payments/intents/:id/cancel — closes the QR/link at the provider; paid → 409. */
export const PaymentIntentCancelSchema = z
  .object({ reason: z.string().trim().max(200).optional() })
  .prefault({})

/** POST /payments/intents/:id/mock-pay — dev/test only (KADAI_ENABLE_MOCK_PAYMENTS). */
export const PaymentIntentMockPaySchema = z
  .object({
    outcome: z.enum(['paid', 'failed']).default('paid'),
    /** Simulate an amount mismatch. */
    amount_paise: zAmountPaise.optional(),
    payer_vpa: z.string().trim().refine(isValidVpa, { message: 'vpa_invalid' }).optional(),
    utr: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{6,35}$/, 'utr_invalid')
      .optional(),
  })
  .prefault({})

/**
 * POST /payments/intents/:id/apply — consume a paid, unapplied intent (abandoned cart, extra
 * payment). `sales_invoice`: allocated to that invoice (the remainder above its due becomes the
 * invoice customer's advance; walk-in invoices need an exact or smaller due → 422);
 * `customer`: a receipt for the customer allocated FIFO to their oldest dues (allocateFifo),
 * the rest stays as advance.
 */
export const PaymentIntentApplySchema = z.object({
  target_type: z.enum(['sales_invoice', 'customer']),
  target_id: zId,
  payment_date: zDateStr.optional().describe('Default: the intent paid date (tenant timezone)'),
  notes: z.string().trim().max(500).optional(),
})
export type PaymentIntentApply = z.input<typeof PaymentIntentApplySchema>

export const PaymentIntentListQuerySchema = PageQuerySchema.extend({
  status: zQueryList(PaymentIntentStatusSchema).optional(),
  provider: zQueryList(PaymentProviderCodeSchema).optional(),
  provider_account_id: zId.optional(),
  purpose: zQueryList(PaymentIntentPurposeSchema).optional(),
  store_id: zId.optional(),
  register_id: zId.optional(),
  customer_id: zId.optional(),
  /** Paid but not consumed by any payment (payment_id null): the reconciliation queue. */
  unapplied: zBooleanQuery.optional(),
  ...DATE_RANGE_FIELDS,
  /** reference_code, UTR, payer VPA or provider reference. */
  q: zSearchQuery.optional(),
  sort: sortQuery(['created_at', 'paid_at', 'amount_paise', 'status']).optional(),
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type PaymentIntentListQuery = z.input<typeof PaymentIntentListQuerySchema>

export const PaymentIntentSummarySchema = z.object({
  by_status: z.array(
    z.object({ status: PaymentIntentStatusSchema, count: z.int(), amount_paise: zPaise }),
  ),
  paid_total_paise: zPaise,
  unapplied_count: z.int(),
  unapplied_total_paise: zPaise,
  /** Paid totals per provider account (daily totals on the reconciliation screen). */
  by_provider: z.array(
    z.object({
      provider_account_id: zId,
      provider: PaymentProviderCodeSchema,
      display_name: z.string(),
      paid_count: z.int(),
      paid_total_paise: zPaise,
    }),
  ),
})
/** Intent list + summary over the whole filtered set (not only the page). */
export const PaymentIntentListResponseSchema = listOf(PaymentIntentSchema).extend({
  summary: PaymentIntentSummarySchema,
})
export type PaymentIntentListResponse = z.output<typeof PaymentIntentListResponseSchema>

// =============================================================================================
// Payments (receipts & vouchers)
// =============================================================================================

/**
 * Where a payment came from, derived from its `client_ref` (see paymentClientRef):
 *  - sales_tender: recorded with a sales invoice (POS tenders) — cancelled with the invoice;
 *  - credit_note_settlement / debit_note_settlement: refund or store credit of a return —
 *    cancelled with the note;
 *  - manual: receipts, vouchers, dues collection, applied intents — POST /payments/:id/cancel.
 */
export const PaymentOriginSchema = z.enum([
  'sales_tender',
  'credit_note_settlement',
  'debit_note_settlement',
  'manual',
])
export type PaymentOrigin = z.infer<typeof PaymentOriginSchema>

const CLIENT_REF_PREFIX = {
  sales_tender: 'tender:',
  credit_note_settlement: 'cn:',
  debit_note_settlement: 'dn:',
} as const

/**
 * client_ref the posting modules MUST pass to recordPayment so the origin is known and retries
 * stay idempotent: tender → `tender:<invoice_id>:<tender index>`, credit/debit note settlement →
 * `cn:<id>` / `dn:<id>`.
 */
export const paymentClientRef = {
  salesTender: (invoiceId: string, index: number): string =>
    `${CLIENT_REF_PREFIX.sales_tender}${invoiceId}:${index}`,
  creditNoteSettlement: (creditNoteId: string): string =>
    `${CLIENT_REF_PREFIX.credit_note_settlement}${creditNoteId}`,
  debitNoteSettlement: (debitNoteId: string): string =>
    `${CLIENT_REF_PREFIX.debit_note_settlement}${debitNoteId}`,
}

export function paymentOriginOf(clientRef: string | null | undefined): PaymentOrigin {
  if (clientRef) {
    for (const [origin, prefix] of Object.entries(CLIENT_REF_PREFIX)) {
      if (clientRef.startsWith(prefix)) return origin as PaymentOrigin
    }
  }
  return 'manual'
}

/** Whether POST /payments/:id/cancel accepts the payment (others are cancelled with their document). */
export function isPaymentCancellable(p: { status: string; origin: PaymentOrigin }): boolean {
  return p.status === 'completed' && p.origin === 'manual'
}

/** Document types each direction may settle (core recordPayment ALLOWED_TARGETS). */
export const ALLOCATION_TARGETS_BY_DIRECTION: Readonly<
  Record<PaymentDirection, readonly AllocationTargetType[]>
> = {
  in: ['sales_invoice', 'debit_note', 'opening_balance'],
  out: ['purchase_bill', 'credit_note', 'expense', 'opening_balance'],
}

export const PaymentSchema = z.object({
  id: zId,
  store_id: zId,
  register_id: zId.nullable(),
  shift_id: zId.nullable(),
  /** Receipt (RC…) / voucher (PV…) number; null for POS tenders and settlement payments. */
  number: z.string().nullable(),
  fy: z.string().nullable(),
  direction: PaymentDirectionSchema,
  party_type: PartyTypeSchema.nullable(),
  party_id: zId.nullable(),
  party_name: z.string().nullable(),
  method: PaymentMethodSchema,
  amount_paise: zAmountPaise,
  allocated_paise: zPaise,
  /** Advance / on-account part. */
  unallocated_paise: zPaise,
  status: PaymentStatusSchema,
  payment_date: zDateStr,
  paid_at: zTimestamp,
  reference: z.string().nullable(),
  payment_intent_id: zId.nullable(),
  account_id: zId,
  account_name: z.string(),
  notes: z.string().nullable(),
  client_ref: z.string().nullable(),
  origin: PaymentOriginSchema,
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  cancelled_at: zTimestamp.nullable(),
  cancel_reason: z.string().nullable(),
})
export type Payment = z.output<typeof PaymentSchema>

export const PaymentAllocationDetailSchema = z.object({
  id: zId,
  target_type: AllocationTargetTypeSchema,
  /** Document id; for opening_balance the party id. */
  target_id: zId.nullable(),
  amount_paise: zAmountPaise,
  document_number: z.string().nullable(),
  document_date: zDateStr.nullable(),
  document_total_paise: zPaise.nullable(),
  /** Current due / open amount of the document. */
  document_due_paise: z.int().nullable(),
})
export type PaymentAllocationDetail = z.output<typeof PaymentAllocationDetailSchema>

export const PaymentDetailSchema = PaymentSchema.extend({
  allocations: z.array(PaymentAllocationDetailSchema),
  intent: z
    .object({
      id: zId,
      reference_code: z.string(),
      provider: PaymentProviderCodeSchema,
      payer_vpa: z.string().nullable(),
      utr: z.string().nullable(),
      paid_at: zTimestamp.nullable(),
    })
    .nullable(),
  journal_entry_id: zId.nullable(),
  cancelled_by_name: z.string().nullable(),
  updated_at: zTimestamp,
})
export type PaymentDetail = z.output<typeof PaymentDetailSchema>

export const PaymentAllocationInputSchema = z.object({
  target_type: AllocationTargetTypeSchema,
  /** Document id; opening_balance: the party id (or null = the payment's party). */
  target_id: zId.nullable(),
  amount_paise: zAmountPaise,
})
export type PaymentAllocationInput = z.input<typeof PaymentAllocationInputSchema>

/**
 * POST /payments — a receipt (direction in, `payments.collect`) or a payment voucher (out,
 * `payments.pay`), numbered RC… / PV…. A party is required. `auto_allocate: 'fifo'` settles the
 * party's open items oldest first (allocateFifo over GET /payments/open-items); the remainder is
 * kept as advance (unallocated_paise).
 */
export const PaymentCreateSchema = z
  .object({
    direction: PaymentDirectionSchema,
    store_id: zId,
    party_type: PartyTypeSchema,
    party_id: zId,
    method: PaymentMethodSchema,
    amount_paise: zAmountPaise,
    payment_date: zDateStr.optional().describe('Default: today (tenant timezone)'),
    reference: z.string().trim().max(100).optional().describe('UTR / cheque no / approval code'),
    account_id: zId.optional().describe('Cash/bank ledger account; default by method'),
    register_id: zId.optional(),
    shift_id: zId.optional().describe('Open shift the cash belongs to (cash drawer)'),
    allocations: z.array(PaymentAllocationInputSchema).max(200).optional(),
    auto_allocate: z.literal('fifo').optional(),
    notes: z.string().trim().max(1000).optional(),
    client_ref: zIdempotencyKey.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.allocations?.length && v.auto_allocate) {
      ctx.addIssue({
        code: 'custom',
        path: ['auto_allocate'],
        message: 'allocations_and_auto_allocate',
      })
    }
    const allowed = ALLOCATION_TARGETS_BY_DIRECTION[v.direction]
    let sum = 0
    v.allocations?.forEach((a, i) => {
      sum += a.amount_paise
      if (!allowed.includes(a.target_type)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allocations', i, 'target_type'],
          message: 'allocation_target_not_allowed',
        })
      }
    })
    if (sum > v.amount_paise) {
      ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'allocations_exceed_amount' })
    }
    if (v.method === 'store_credit' && v.party_type !== 'customer') {
      ctx.addIssue({ code: 'custom', path: ['method'], message: 'store_credit_needs_customer' })
    }
  })
export type PaymentCreate = z.input<typeof PaymentCreateSchema>

export const PaymentCancelSchema = z.object({ reason: zReason })
export type PaymentCancel = z.input<typeof PaymentCancelSchema>

export const PaymentListQuerySchema = PageQuerySchema.extend({
  direction: PaymentDirectionSchema.optional(),
  party_type: PartyTypeSchema.optional(),
  party_id: zId.optional(),
  method: zQueryList(PaymentMethodSchema).optional(),
  status: zQueryList(PaymentStatusSchema).optional(),
  origin: zQueryList(PaymentOriginSchema).optional(),
  store_id: zId.optional(),
  register_id: zId.optional(),
  shift_id: zId.optional(),
  ...DATE_RANGE_FIELDS,
  /** Number, reference / UTR or party name. */
  q: zSearchQuery.optional(),
  sort: sortQuery(['payment_date', 'paid_at', 'amount_paise', 'number', 'created_at']).optional(),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type PaymentListQuery = z.input<typeof PaymentListQuerySchema>

export const PaymentListSummarySchema = z.object({
  /** Completed payments in the filter. */
  count: z.int(),
  in_paise: zPaise,
  out_paise: zPaise,
  /** in − out */
  net_paise: z.int(),
  by_method: z.array(
    z.object({
      method: PaymentMethodSchema,
      direction: PaymentDirectionSchema,
      count: z.int(),
      amount_paise: zPaise,
    }),
  ),
})
export const PaymentListResponseSchema = listOf(PaymentSchema).extend({
  summary: PaymentListSummarySchema,
})
export type PaymentListResponse = z.output<typeof PaymentListResponseSchema>

// ---- open items & FIFO allocation ------------------------------------------------------------

/** GET /payments/open-items — what a receipt / voucher for a party can settle, FIFO order. */
export const OpenItemsQuerySchema = z.object({
  party_type: PartyTypeSchema,
  party_id: zId,
  /** Default: in for customers (due invoices), out for suppliers (due bills). out for a customer
   *  lists unsettled credit notes; in for a supplier lists unsettled debit notes. */
  direction: PaymentDirectionSchema.optional(),
  store_id: zId.optional(),
})
export type OpenItemsQuery = z.input<typeof OpenItemsQuerySchema>

export const OpenItemSchema = z.object({
  target_type: AllocationTargetTypeSchema,
  /** Document id; opening_balance: the party id. */
  target_id: zId,
  number: z.string().nullable(),
  date: zDateStr.nullable(),
  due_date: zDateStr.nullable(),
  total_paise: zPaise,
  /** Open amount still to settle. */
  due_paise: zAmountPaise,
  days_overdue: z.int().nullable(),
  store_id: zId.nullable(),
})
export type OpenItem = z.output<typeof OpenItemSchema>

export const OpenItemsResponseSchema = z.object({
  party: z.object({
    type: PartyTypeSchema,
    id: zId,
    name: z.string(),
    /** customers: receivable (+ owes the shop); suppliers: payable (+ shop owes). */
    balance_paise: z.int(),
    /** Customers: store credit (customer_advance) they hold. */
    store_credit_paise: zPaise.nullable(),
  }),
  direction: PaymentDirectionSchema,
  /** Opening balance first, then documents by date, number (FIFO). */
  items: z.array(OpenItemSchema),
  total_due_paise: zPaise,
})
export type OpenItemsResponse = z.output<typeof OpenItemsResponseSchema>

export interface FifoItem {
  target_type: AllocationTargetType
  target_id: string
  due_paise: number
}

/**
 * FIFO allocation of `amount_paise` over open items in the given order (the server's
 * `auto_allocate: 'fifo'` and the web's auto-fill use this same function).
 */
export function allocateFifo(
  items: readonly FifoItem[],
  amountPaise: number,
): {
  allocations: { target_type: AllocationTargetType; target_id: string; amount_paise: number }[]
  unallocated_paise: number
} {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new RangeError('amount_paise must be a non-negative integer')
  }
  let left = amountPaise
  const allocations: {
    target_type: AllocationTargetType
    target_id: string
    amount_paise: number
  }[] = []
  for (const item of items) {
    if (left <= 0) break
    if (item.due_paise <= 0) continue
    const amount = Math.min(left, item.due_paise)
    allocations.push({
      target_type: item.target_type,
      target_id: item.target_id,
      amount_paise: amount,
    })
    left -= amount
  }
  return { allocations, unallocated_paise: left }
}

// ---- payment links & public pay page ----------------------------------------------------------

/**
 * POST /payments/links — collect a customer's dues. A dynamic provider (Razorpay) creates a
 * hosted payment link; otherwise a Kadai pay page `PUBLIC_BASE_URL/pay/<reference_code>` with a
 * UPI deep link to the shop VPA (`tr` = reference_code). When the link intent is paid a receipt is
 * recorded for the customer and allocated FIFO to the oldest dues.
 */
export const PaymentLinkCreateSchema = z.object({
  customer_id: zId,
  store_id: zId,
  amount_paise: zAmountPaise.optional().describe("Default: the customer's due (balance_paise)"),
  send_via: NotificationChannelSchema.exclude(['email']).nullable().optional(),
  /** Recipient override (default: the customer's phone). */
  phone: zOptionalPhone,
  provider_account_id: zId.optional(),
  expires_in_hours: z.int().min(1).max(720).default(72),
  note: z.string().trim().max(50).optional(),
})
export type PaymentLinkCreate = z.input<typeof PaymentLinkCreateSchema>

export const PaymentLinkResultSchema = z.object({
  intent: PaymentIntentSchema,
  url: z.string(),
  link_kind: z.enum(['provider', 'pay_page']),
  /** Queued notification (template payment_link) when send_via was given. */
  notification_id: zId.nullable(),
  /** Ready-made message text for manual sharing. */
  message: z.string(),
  /** https://wa.me/<number>?text=… for shops without a WhatsApp provider. */
  wa_me_url: z.string().nullable(),
})
export type PaymentLinkResult = z.output<typeof PaymentLinkResultSchema>

/** Parameters of the `payment_link` notification template. */
export const PaymentLinkTemplateParamsSchema = z.object({
  shop_name: z.string(),
  customer_name: z.string(),
  amount: z.string().describe("Formatted amount, e.g. '₹1,250.00'"),
  link: z.string(),
})
export const PAYMENT_LINK_TEMPLATE = 'payment_link'

/** reference_code of intents: 12 characters [0-9A-Z] (generateReferenceCode). */
export const ReferenceCodeParamsSchema = z.object({
  reference_code: z.string().regex(/^[0-9A-Z]{12}$/),
})

/** GET /public/v1/pay/:reference_code — no auth; no internal ids. */
export const PublicPayPageSchema = z.object({
  reference_code: z.string(),
  status: PaymentIntentStatusSchema,
  purpose: PaymentIntentPurposeSchema,
  amount_paise: zAmountPaise,
  currency: z.literal('INR'),
  shop: z.object({
    name: z.string(),
    name_ta: z.string().nullable(),
    city: z.string().nullable(),
    phone: z.string().nullable(),
    logo_url: z.string().nullable(),
  }),
  payee: z.object({ name: z.string(), vpa: z.string().nullable() }),
  /** First name only. */
  customer_first_name: z.string().nullable(),
  /** UPI deep link while the intent can still be paid (pending and not expired). */
  upi_uri: z.string().nullable(),
  /** Provider-hosted payment page (Razorpay link). */
  short_url: z.string().nullable(),
  expires_at: zTimestamp.nullable(),
  paid_at: zTimestamp.nullable(),
})
export type PublicPayPage = z.output<typeof PublicPayPageSchema>

/**
 * UPI `tr` from a document number: letters and digits only, at most 35 ('S1-A/2627/00042' →
 * 'S1A262700042'). Used for static-VPA QRs printed on invoices (no intent behind them).
 */
export function upiReferenceFromNumber(number: string): string | null {
  const ref = number.replace(/[^A-Za-z0-9]/g, '').slice(0, 35)
  return UPI_REFERENCE_RE.test(ref) ? ref : null
}

// ---- static / standee QR -----------------------------------------------------------------------

/** GET /payments/upi-qr — static QR payload (no amount = customer enters it: standee poster). */
export const UpiQrQuerySchema = z.object({
  provider_account_id: zId.optional().describe('Default: the default upi_vpa account of store_id'),
  store_id: zId.optional(),
  amount_paise: zQueryInt(1, 1_000_000_000).optional(),
  note: z.string().trim().max(50).optional(),
})
export type UpiQrQuery = z.input<typeof UpiQrQuerySchema>

export const UpiQrPayloadSchema = z.object({
  provider_account_id: zId,
  vpa: z.string(),
  payee_name: z.string(),
  merchant_code: z.string().nullable(),
  amount_paise: zAmountPaise.nullable(),
  note: z.string().nullable(),
  upi_uri: z.string(),
  shop: z.object({ name: z.string(), name_ta: z.string().nullable() }),
  store: z.object({ id: zId, name: z.string(), name_ta: z.string().nullable() }).nullable(),
})
export type UpiQrPayload = z.output<typeof UpiQrPayloadSchema>

// ---- webhooks -----------------------------------------------------------------------------------

export const PaymentWebhookParamsSchema = z.object({
  provider: PaymentProviderCodeSchema,
  account_id: zId,
})

/** 200 body of a webhook (also for duplicates); invalid signature → 401. */
export const WebhookAckSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean().optional(),
})

// =============================================================================================
// Route catalogue (docs/API.md "payments & UPI")
// =============================================================================================

const IdParams = z.object({ id: zId })

export const paymentsRoutes = defineRoutes({
  // ---- providers ----
  listProviders: {
    method: 'GET',
    path: '/payment-providers',
    permission: ['payments.configure', 'payments.read'],
    query: PaymentProviderListQuerySchema,
    response: listOf(PaymentProviderAccountSchema),
    summary: 'Payment provider accounts (UPI IDs, Razorpay) without secrets',
  },
  createProvider: {
    method: 'POST',
    path: '/payment-providers',
    permission: 'payments.configure',
    body: PaymentProviderCreateSchema,
    response: dataOf(PaymentProviderAccountSchema),
    status: 201,
    summary: 'Add a UPI ID / Razorpay account (dynamic providers need feature upi_dynamic)',
  },
  getProvider: {
    method: 'GET',
    path: '/payment-providers/:id',
    permission: ['payments.configure', 'payments.read'],
    params: IdParams,
    response: dataOf(PaymentProviderAccountSchema),
  },
  updateProvider: {
    method: 'PATCH',
    path: '/payment-providers/:id',
    permission: 'payments.configure',
    params: IdParams,
    body: PaymentProviderUpdateSchema,
    response: dataOf(PaymentProviderAccountSchema),
    summary: 'Update / rotate credentials / set default of a provider account (audited)',
  },
  deleteProvider: {
    method: 'DELETE',
    path: '/payment-providers/:id',
    permission: 'payments.configure',
    params: IdParams,
    summary: 'Deactivate a provider account (history is kept)',
  },
  testProvider: {
    method: 'POST',
    path: '/payment-providers/:id/test',
    permission: 'payments.configure',
    params: IdParams,
    response: dataOf(ProviderTestResultSchema),
    summary: 'Check credentials (Razorpay) or get a ₹1 test QR (UPI ID)',
  },

  // ---- intents ----
  createIntent: {
    method: 'POST',
    path: '/payments/intents',
    permission: 'payments.collect',
    idempotent: true,
    body: PaymentIntentCreateSchema,
    response: dataOf(PaymentIntentSchema),
    status: 201,
    summary: 'Create a UPI QR for an amount (provider failure → 502 PROVIDER_ERROR)',
  },
  listIntents: {
    method: 'GET',
    path: '/payments/intents',
    permission: 'payments.read',
    query: PaymentIntentListQuerySchema,
    response: PaymentIntentListResponseSchema,
    summary: 'UPI reconciliation: intents with status / provider / unapplied filters and totals',
  },
  getIntent: {
    method: 'GET',
    path: '/payments/intents/:id',
    permission: ['payments.collect', 'payments.read'],
    params: IdParams,
    query: PaymentIntentGetQuerySchema,
    response: dataOf(PaymentIntentSchema),
    summary: 'Intent status (with ?wait= a long poll until the status changes)',
  },
  streamIntent: {
    method: 'GET',
    path: '/payments/intents/:id/stream',
    permission: ['payments.collect', 'payments.read'],
    params: IdParams,
    stream: 'sse',
    summary: `SSE: event "${INTENT_STREAM_EVENT}" with the PaymentIntent now and on every change; closes on a terminal status`,
  },
  confirmIntent: {
    method: 'POST',
    path: '/payments/intents/:id/confirm',
    permission: 'payments.collect',
    params: IdParams,
    body: PaymentIntentConfirmSchema,
    response: dataOf(PaymentIntentSchema),
    summary: 'Manual confirmation of a UPI ID payment (optional UTR; audited)',
  },
  cancelIntent: {
    method: 'POST',
    path: '/payments/intents/:id/cancel',
    permission: 'payments.collect',
    params: IdParams,
    body: PaymentIntentCancelSchema,
    response: dataOf(PaymentIntentSchema),
    summary: 'Cancel a pending intent and close its QR / link (paid → 409)',
  },
  mockPayIntent: {
    method: 'POST',
    path: '/payments/intents/:id/mock-pay',
    permission: 'payments.collect',
    params: IdParams,
    body: PaymentIntentMockPaySchema,
    response: dataOf(PaymentIntentSchema),
    summary: 'Dev/test only (KADAI_ENABLE_MOCK_PAYMENTS): pay or fail a mock intent',
  },
  applyIntent: {
    method: 'POST',
    path: '/payments/intents/:id/apply',
    permission: 'payments.collect',
    idempotent: true,
    params: IdParams,
    body: PaymentIntentApplySchema,
    response: dataOf(z.object({ intent: PaymentIntentSchema, payment: PaymentDetailSchema })),
    status: 201,
    summary: 'Apply a paid, unapplied intent to an invoice or a customer (FIFO)',
  },

  // ---- links, QR ----
  createLink: {
    method: 'POST',
    path: '/payments/links',
    permission: 'payments.collect',
    idempotent: true,
    body: PaymentLinkCreateSchema,
    response: dataOf(PaymentLinkResultSchema),
    status: 201,
    summary: 'Payment link for customer dues (Razorpay link or the Kadai pay page)',
  },
  upiQr: {
    method: 'GET',
    path: '/payments/upi-qr',
    permission: 'payments.collect',
    query: UpiQrQuerySchema,
    response: dataOf(UpiQrPayloadSchema),
    summary: 'Static UPI QR payload (standee poster, amount optional)',
  },

  // ---- receipts & vouchers ----
  openItems: {
    method: 'GET',
    path: '/payments/open-items',
    permission: ['payments.collect', 'payments.pay', 'payments.read'],
    query: OpenItemsQuerySchema,
    response: dataOf(OpenItemsResponseSchema),
    summary: "A party's open documents in FIFO order (allocation table)",
  },
  listPayments: {
    method: 'GET',
    path: '/payments',
    permission: 'payments.read',
    query: PaymentListQuerySchema,
    response: PaymentListResponseSchema,
    summary: 'Receipts & payments with totals (?format=csv)',
  },
  createPayment: {
    method: 'POST',
    path: '/payments',
    permission: ['payments.collect', 'payments.pay'],
    idempotent: true,
    body: PaymentCreateSchema,
    response: dataOf(PaymentDetailSchema),
    status: 201,
    summary: 'Record a receipt (in, payments.collect) or payment voucher (out, payments.pay)',
  },
  getPayment: {
    method: 'GET',
    path: '/payments/:id',
    permission: ['payments.read', 'payments.collect'],
    params: IdParams,
    response: dataOf(PaymentDetailSchema),
  },
  cancelPayment: {
    method: 'POST',
    path: '/payments/:id/cancel',
    permission: ['payments.collect', 'payments.pay'],
    params: IdParams,
    body: PaymentCancelSchema,
    response: dataOf(PaymentDetailSchema),
    summary:
      'Cancel a manual receipt / voucher (POS tenders and return settlements → 409: cancel the document)',
  },

  // ---- public & webhooks ----
  publicPayPage: {
    method: 'GET',
    path: '/pay/:reference_code',
    scope: 'public',
    auth: 'public',
    params: ReferenceCodeParamsSchema,
    response: dataOf(PublicPayPageSchema),
    summary: 'Public pay page model for a dues link (shop, amount, UPI deep link, status)',
  },
  webhook: {
    method: 'POST',
    path: '/payments/:provider/:account_id',
    scope: 'webhook',
    auth: 'public',
    params: PaymentWebhookParamsSchema,
    response: dataOf(WebhookAckSchema),
    summary: 'Provider webhook (raw body, HMAC verified; invalid signature → 401; deduplicated)',
  },
})
