/**
 * Contract for the platform module — docs/API.md "platform, billing & system": cloud SaaS
 * billing for tenants (plans, subscription & usage, quotes with offers & coupons, checkout via
 * Razorpay payment links / subscriptions, cancellation, GST invoices), the Razorpay platform
 * webhook, in-app announcements for cloud tenants, API keys and system info (both modes).
 *
 *  - Prices: every quote / checkout is priced with `priceOrder()` from
 *    `@kadai/shared/api/licensing` (buyer channel 'cloud'; place of supply = tenant state vs
 *    KADAI_VENDOR_STATE_CODE). Cloud plan "products" are `cloudPlanProductCode(plan, cycle)`:
 *    the yearly ones are price-book rows (cloud_growth_yearly …); monthly ones are synthesized
 *    from plans.price_monthly_paise with the same code scheme (offers may target either).
 *  - Offers, announcements and vendor orders live in the vendor tables (migration 0010): the
 *    platform module reads/writes them through the system pool with a justification comment.
 *  - Banners: GET /announcements returns `selectBanners()` output (licensing contract) — the same
 *    BannerSchema the on-prem vendor state carries, so one banner strip renders both.
 *  - Webhook /webhooks/platform/razorpay (RAZORPAY_PLATFORM_WEBHOOK_SECRET; dedup in
 *    payment_webhook_events provider 'razorpay_platform'): payment_link.paid for a 'cloud_plan'
 *    order is fulfilled here; any other order kind is handed to the licensing job
 *    LICENSING_JOBS.fulfilOrder; subscription.* events drive RAZORPAY_SUBSCRIPTION_EVENT_STATUS.
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope;
 * custom validation messages are snake_case keys (PLATFORM_VALIDATION_KEYS).
 */
import { z } from 'zod'
import {
  PageQuerySchema,
  dataOf,
  defineRoutes,
  listOf,
  sortQuery,
  zDateStr,
  zId,
  zSearchQuery,
  zTimestamp,
} from './common'
import { type BilingualLabel, zNullableText } from './identity'
import {
  BannerSchema,
  OfferPublicSchema,
  PriceQuoteSchema,
  VENDOR_GST_RATE_BP,
  VendorInvoicePrintSchema,
  zOptionalCouponCode,
  zPlanCode,
} from './licensing'
import { OnPremSystemInfoSchema } from './onprem'
import {
  type BillingCycle,
  BillingCycleSchema,
  DeploymentModeSchema,
  FileStorageSchema,
  type SubscriptionStatus,
  SubscriptionStatusSchema,
} from '../enums'
import {
  EntitlementSourceSchema,
  EntitlementsSchema,
  FeatureSchema,
  type LimitMetric,
  LIMIT_METRICS,
  PlanLimitsSchema,
} from '../features'
import { mulDiv } from '../math'
import { type Permission, PermissionSchema, expandPermissions } from '../permissions'

// =============================================================================================
// Constants & helpers
// =============================================================================================

/** Cloud plans a tenant can buy online (free is the fallback, enterprise is sold by quote). */
export const PURCHASABLE_CLOUD_PLANS = ['growth', 'pro'] as const
/** Highlighted on the plan cards. */
export const RECOMMENDED_CLOUD_PLAN = 'growth'
/** Signup trial (PRODUCT.md): 14 days of Valarchi, then Free (data kept). */
export const TRIAL_DAYS = 14
/** A past_due subscription is downgraded after this many days (job). */
export const PAST_DUE_GRACE_DAYS = 7
/** Prepaid plans: renewal reminders this many days before current_period_end. */
export const RENEWAL_REMINDER_DAYS = [7, 1] as const
/** Razorpay Subscriptions: total_count for monthly auto-renew (10 years). */
export const RAZORPAY_SUBSCRIPTION_TOTAL_COUNT = 120
/** payment_webhook_events.provider of the platform webhook. */
export const PLATFORM_WEBHOOK_PROVIDER = 'razorpay_platform'
/** Usage meters turn amber at this share of the limit. */
export const USAGE_WARNING_BP = 8000

export const PLATFORM_JOBS = {
  /** Hourly (cloud): trial end → free, past_due > 7 days → downgrade, prepaid renewal reminders. */
  subscriptionRenewals: 'platform.subscription-renewals',
} as const

/** Tamil-first display names of the cloud plans (plans.name_ta is the stored source). */
export const CLOUD_PLAN_NAMES: Readonly<Record<string, BilingualLabel & { short: string }>> = {
  free: { short: 'Thodakkam', en: 'Thodakkam (Free)', ta: 'தொடக்கம்' },
  growth: { short: 'Valarchi', en: 'Valarchi (Growth)', ta: 'வளர்ச்சி' },
  pro: { short: 'Peru', en: 'Peru (Pro)', ta: 'பெரு' },
  enterprise: { short: 'Enterprise', en: 'Enterprise', ta: 'நிறுவனம்' },
}

/** Price-book code of a cloud plan purchase: 'cloud_growth_yearly' / 'cloud_growth_monthly'. */
export function cloudPlanProductCode(planCode: string, cycle: BillingCycle): string {
  return `cloud_${planCode}_${cycle}`
}

/** Env var holding the Razorpay plan id for monthly auto-renew: RAZORPAY_PLAN_GROWTH_MONTHLY. */
export function razorpayPlanEnvVar(planCode: string, cycle: BillingCycle): string {
  return `RAZORPAY_PLAN_${planCode.toUpperCase()}_${cycle.toUpperCase()}`
}

/** Yearly savings vs paying monthly for 12 months (≥ 0). */
export function yearlySavings(
  monthlyPaise: number,
  yearlyPaise: number,
): { savings_paise: number; savings_bp: number } {
  const twelve = monthlyPaise * 12
  if (twelve <= 0 || yearlyPaise >= twelve) return { savings_paise: 0, savings_bp: 0 }
  const savings = twelve - yearlyPaise
  return { savings_paise: savings, savings_bp: mulDiv(savings, 10_000, twelve) }
}

/** Whole days left until `endsAt` (rounded up, ≥ 0); null when there is no end. */
export function daysLeft(endsAt: string | Date | null, now: string | Date): number | null {
  if (endsAt === null) return null
  const end = endsAt instanceof Date ? endsAt.getTime() : Date.parse(endsAt)
  const t = now instanceof Date ? now.getTime() : Date.parse(now)
  return Math.max(0, Math.ceil((end - t) / 86_400_000))
}

/**
 * Razorpay platform webhook events handled by the platform module, and the subscription status
 * each subscription.* event moves the tenant's subscription to.
 */
export const PLATFORM_RAZORPAY_EVENTS = [
  'payment_link.paid',
  'payment_link.expired',
  'payment_link.cancelled',
  'subscription.activated',
  'subscription.charged',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.completed',
] as const
export type PlatformRazorpayEvent = (typeof PLATFORM_RAZORPAY_EVENTS)[number]

export const RAZORPAY_SUBSCRIPTION_EVENT_STATUS: Readonly<
  Record<Extract<PlatformRazorpayEvent, `subscription.${string}`>, SubscriptionStatus>
> = {
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.pending': 'past_due',
  'subscription.halted': 'past_due',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'expired',
}

export const PLATFORM_VALIDATION_KEYS = [
  'plan_not_purchasable',
  'auto_renew_monthly_only',
  'permissions_empty',
  'permission_not_held',
  'store_ids_empty',
  'expires_in_past',
  'empty_patch',
] as const
export type PlatformValidationKey = (typeof PLATFORM_VALIDATION_KEYS)[number]

// =============================================================================================
// Plans, subscription & usage
// =============================================================================================

export const BillingPlanSchema = z.object({
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  description: z.string().nullable(),
  features: z.array(FeatureSchema),
  limits: PlanLimitsSchema,
  /** Prices excl. GST. */
  price_monthly_paise: z.int().min(0),
  price_yearly_paise: z.int().min(0),
  gst_rate_bp: z.int().min(0),
  price_monthly_incl_gst_paise: z.int().min(0),
  price_yearly_incl_gst_paise: z.int().min(0),
  yearly_savings_paise: z.int().min(0),
  yearly_savings_bp: z.int().min(0).max(10_000),
  /** Can be bought online (PURCHASABLE_CLOUD_PLANS). */
  purchasable: z.boolean(),
  is_current: z.boolean(),
  recommended: z.boolean(),
  sort_order: z.int(),
  product_codes: z.object({ monthly: z.string(), yearly: z.string() }),
})
export type BillingPlan = z.output<typeof BillingPlanSchema>

/** GET /billing/plans */
export const BillingPlansResponseSchema = z.object({
  plans: z.array(BillingPlanSchema),
  current_plan_code: z.string(),
  gst_rate_bp: z.int().default(VENDOR_GST_RATE_BP),
})
export type BillingPlansResponse = z.output<typeof BillingPlansResponseSchema>

export const SubscriptionViewSchema = z.object({
  id: zId,
  plan_code: z.string(),
  plan_name: z.string(),
  plan_name_ta: z.string().nullable(),
  status: SubscriptionStatusSchema,
  billing_cycle: BillingCycleSchema,
  current_period_start: zTimestamp,
  current_period_end: zTimestamp,
  trial_ends_at: zTimestamp.nullable(),
  cancel_at_period_end: z.boolean(),
  provider: z.enum(['razorpay', 'manual']).nullable(),
  /** Razorpay subscription (monthly auto-renew); otherwise prepaid. */
  auto_renew: z.boolean(),
  days_left: z.int().min(0).nullable(),
})
export type SubscriptionView = z.output<typeof SubscriptionViewSchema>

export const UsageMeterSchema = z.object({
  metric: z.enum(LIMIT_METRICS),
  used: z.int().min(0),
  /** null = unlimited. */
  limit: z.int().min(0).nullable(),
  /** used ÷ limit in bp (capped at 10000); null when unlimited. */
  used_bp: z.int().min(0).max(10_000).nullable(),
  state: z.enum(['ok', 'warning', 'at_limit']),
})
export type UsageMeter = z.output<typeof UsageMeterSchema>

/** Usage meter for a limit (warning from USAGE_WARNING_BP; at_limit when used ≥ limit). */
export function usageMeter(metric: LimitMetric, used: number, limit: number | null): UsageMeter {
  if (limit === null) return { metric, used, limit, used_bp: null, state: 'ok' }
  const bp = limit === 0 ? 10_000 : Math.min(10_000, mulDiv(used, 10_000, limit))
  const state = used >= limit ? 'at_limit' : bp >= USAGE_WARNING_BP ? 'warning' : 'ok'
  return { metric, used, limit, used_bp: bp, state }
}

export const PendingCheckoutSchema = z.object({
  order_id: zId,
  short_url: z.string(),
  total_paise: z.int().min(0),
  plan_code: z.string(),
  cycle: BillingCycleSchema,
  expires_at: zTimestamp.nullable(),
})

/** GET /billing/subscription — the Plan & billing page. */
export const BillingOverviewSchema = z.object({
  plan: BillingPlanSchema,
  subscription: SubscriptionViewSchema.nullable(),
  entitlements: EntitlementsSchema,
  /** One meter per limit metric (invoices_per_month = bills this month). */
  usage: z.array(UsageMeterSchema),
  trial: z.object({
    active: z.boolean(),
    ends_at: zTimestamp.nullable(),
    days_left: z.int().min(0).nullable(),
  }),
  /** Active vendor offers for this tenant (automatic campaigns matching its audience). */
  offers: z.array(OfferPublicSchema),
  /** An unpaid payment link from an earlier checkout. */
  pending_checkout: PendingCheckoutSchema.nullable(),
  can_cancel: z.boolean(),
  /** Billing state (place of supply) and ours — intra-state CGST+SGST vs IGST. */
  tenant_state_code: z.string(),
  vendor_state_code: z.string(),
})
export type BillingOverview = z.output<typeof BillingOverviewSchema>

const zPurchasablePlan = zPlanCode.refine(
  (v) => (PURCHASABLE_CLOUD_PLANS as readonly string[]).includes(v),
  { message: 'plan_not_purchasable' },
)

/** POST /billing/quote — live price for the plan cards / coupon field. */
export const BillingQuoteRequestSchema = z.object({
  plan_code: zPurchasablePlan,
  cycle: BillingCycleSchema,
  coupon_code: zOptionalCouponCode,
})
export type BillingQuoteRequest = z.input<typeof BillingQuoteRequestSchema>

export const BillingQuoteSchema = z.object({
  plan_code: z.string(),
  cycle: BillingCycleSchema,
  /** priceOrder() result (coupon status inside). */
  quote: PriceQuoteSchema,
  /** Period the payment covers (after free months). */
  period_start: zDateStr,
  period_end: zDateStr,
  /** Monthly auto-renew: first charge date (later than today when free_months apply). */
  first_charge_on: zDateStr.nullable(),
  auto_renew_available: z.boolean(),
})
export type BillingQuote = z.output<typeof BillingQuoteSchema>

/**
 * POST /billing/checkout — prepaid (yearly, or monthly without auto-renew): vendor_orders row
 * (kind cloud_plan) + Razorpay payment link; monthly auto_renew: Razorpay subscription (free
 * months → start_at in the future; percent offers → discounted first-cycle order).
 */
export const CheckoutRequestSchema = z
  .object({
    plan_code: zPurchasablePlan,
    cycle: BillingCycleSchema,
    coupon_code: zOptionalCouponCode,
    auto_renew: z.boolean().default(false),
  })
  .refine((v) => !v.auto_renew || v.cycle === 'monthly', {
    message: 'auto_renew_monthly_only',
    path: ['auto_renew'],
  })
export type CheckoutRequest = z.input<typeof CheckoutRequestSchema>

export const CheckoutResponseSchema = z.object({
  mode: z.enum(['payment_link', 'subscription']),
  /** Open in a new tab; then poll GET /billing/subscription. */
  short_url: z.string(),
  order_id: zId.nullable(),
  provider_subscription_id: z.string().nullable(),
  total_paise: z.int().min(0),
  first_charge_on: zDateStr.nullable(),
  expires_at: zTimestamp.nullable(),
})
export type CheckoutResponse = z.output<typeof CheckoutResponseSchema>

export const CancelReasonSchema = z.enum([
  'too_expensive',
  'missing_features',
  'moving_to_onprem',
  'closing_business',
  'other',
])

/** POST /billing/cancel — cancel at period end (the plan stays until then; then Free). */
export const CancelSubscriptionSchema = z.object({
  reason: CancelReasonSchema.optional(),
  feedback: zNullableText(1000),
})
export type CancelSubscription = z.input<typeof CancelSubscriptionSchema>

/** GET /billing/invoices row: paid vendor_orders of the tenant + legacy platform_invoices. */
export const BillingInvoiceSchema = z.object({
  id: zId,
  source: z.enum(['order', 'platform_invoice']),
  number: z.string().nullable(),
  date: zDateStr,
  plan_code: z.string().nullable(),
  billing_cycle: BillingCycleSchema.nullable(),
  period_start: zDateStr.nullable(),
  period_end: zDateStr.nullable(),
  taxable_paise: z.int().min(0),
  cgst_paise: z.int().min(0),
  sgst_paise: z.int().min(0),
  igst_paise: z.int().min(0),
  total_paise: z.int().min(0),
  status: z.enum(['paid', 'issued', 'refunded', 'void']),
  paid_at: zTimestamp.nullable(),
})
export type BillingInvoice = z.output<typeof BillingInvoiceSchema>

export const BillingInvoiceListQuerySchema = PageQuerySchema.extend({
  from: zDateStr.optional(),
  to: zDateStr.optional(),
  sort: sortQuery(['date', 'total_paise'] as const).prefault('-date'),
})
export type BillingInvoiceListQuery = z.input<typeof BillingInvoiceListQuerySchema>

/** Webhook acknowledgement. */
export const WebhookAckSchema = z.object({ ok: z.literal(true) })

// =============================================================================================
// System info (both modes)
// =============================================================================================

export const SystemInfoSchema = z.object({
  version: z.string(),
  git_commit: z.string().nullable(),
  mode: DeploymentModeSchema,
  node_version: z.string(),
  platform: z.string().describe("process.platform, e.g. 'win32', 'linux'"),
  arch: z.string(),
  started_at: zTimestamp,
  uptime_seconds: z.int().min(0),
  server_time: zTimestamp,
  timezone: z.string(),
  db: z.object({
    server_version: z.string(),
    size_bytes: z.int().min(0),
    migrations_applied: z.int().min(0),
    last_migration: z.string().nullable(),
    last_migration_at: zTimestamp.nullable(),
    pending_migrations: z.int().min(0),
  }),
  worker: z.object({
    embedded: z.boolean(),
    heartbeat_at: zTimestamp.nullable(),
    heartbeat_age_seconds: z.int().min(0).nullable(),
    healthy: z.boolean(),
  }),
  storage: z.object({ driver: FileStorageSchema }),
  entitlements: z.object({
    plan_code: z.string(),
    source: EntitlementSourceSchema,
  }),
  /** Filled by the onprem module (extension hook); null in cloud. */
  onprem: OnPremSystemInfoSchema.nullable(),
})
export type SystemInfo = z.output<typeof SystemInfoSchema>

// =============================================================================================
// API keys
// =============================================================================================

/** X-Api-Key: kd_<live|test>_<8-char prefix>_<secret> (core/tokens generateApiKey). */
export const API_KEY_HEADER = 'x-api-key'
export const API_KEY_RE = /^kd_(live|test)_[a-z0-9]{8}_[A-Za-z0-9_-]{32,64}$/

export const ApiKeyStateSchema = z.enum(['active', 'expired', 'revoked'])
export type ApiKeyState = z.infer<typeof ApiKeyStateSchema>

export function apiKeyState(
  key: { revoked_at: string | Date | null; expires_at: string | Date | null },
  now: string | Date,
): ApiKeyState {
  if (key.revoked_at !== null) return 'revoked'
  if (key.expires_at !== null) {
    const exp =
      key.expires_at instanceof Date ? key.expires_at.getTime() : Date.parse(key.expires_at)
    const t = now instanceof Date ? now.getTime() : Date.parse(now)
    if (exp <= t) return 'expired'
  }
  return 'active'
}

/**
 * Permissions of `requested` the creator does not hold (empty = allowed). `held` are the
 * creator's stored or effective permission codes (expanded with expandPermissions); an API key
 * can never exceed its creator.
 */
export function missingPermissions(
  requested: readonly Permission[],
  held: Iterable<string>,
): Permission[] {
  const have = expandPermissions(held)
  return [...new Set(requested)].filter((p) => !have.has(p))
}

export const ApiKeySchema = z.object({
  id: zId,
  name: z.string(),
  /** kd_live_ab12cd34 — shown in lists; the secret is never returned again. */
  key_prefix: z.string(),
  permissions: z.array(PermissionSchema),
  /** null = all stores. */
  store_ids: z.array(zId).nullable(),
  last_used_at: zTimestamp.nullable(),
  expires_at: zTimestamp.nullable(),
  revoked_at: zTimestamp.nullable(),
  state: ApiKeyStateSchema,
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type ApiKey = z.output<typeof ApiKeySchema>

export const ApiKeyListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Name or key prefix'),
  state: ApiKeyStateSchema.optional(),
  sort: sortQuery(['created_at', 'name', 'last_used_at'] as const).prefault('-created_at'),
})
export type ApiKeyListQuery = z.input<typeof ApiKeyListQuerySchema>

/**
 * POST /api-keys — permissions ⊆ the creator's (missingPermissions → 403 FORBIDDEN
 * {missing}); store_ids ⊆ the creator's stores; expires_at in the future.
 */
export const ApiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z
    .array(PermissionSchema)
    .min(1, 'permissions_empty')
    .max(100)
    .transform((p) => [...new Set(p)]),
  store_ids: z
    .array(zId)
    .max(500)
    .nullable()
    .default(null)
    .refine((v) => v === null || v.length > 0, { message: 'store_ids_empty' }),
  expires_at: zTimestamp.nullable().default(null),
})
export type ApiKeyCreate = z.input<typeof ApiKeyCreateSchema>

export const ApiKeyCreateResultSchema = z.object({
  api_key: ApiKeySchema,
  /** The full key — shown ONCE (only its sha256 is stored). */
  key: z.string(),
})
export type ApiKeyCreateResult = z.output<typeof ApiKeyCreateResultSchema>

export const ApiKeyRevokeSchema = z.object({ reason: zNullableText(200) })
export type ApiKeyRevoke = z.input<typeof ApiKeyRevokeSchema>

// =============================================================================================
// Route catalogue
// =============================================================================================

const IdParams = z.object({ id: zId })

export const platformRoutes = defineRoutes({
  // ---- cloud billing -------------------------------------------------------------------------
  billingPlans: {
    method: 'GET',
    path: '/billing/plans',
    mode: 'cloud',
    permission: 'billing.manage',
    response: dataOf(BillingPlansResponseSchema),
    summary: 'Public plans with features, limits and prices excl. / incl. GST',
  },
  billingSubscription: {
    method: 'GET',
    path: '/billing/subscription',
    mode: 'cloud',
    permission: 'billing.manage',
    response: dataOf(BillingOverviewSchema),
    summary: 'Subscription, plan, entitlements, usage vs limits, trial and active offers',
  },
  billingQuote: {
    method: 'POST',
    path: '/billing/quote',
    mode: 'cloud',
    permission: 'billing.manage',
    body: BillingQuoteRequestSchema,
    response: dataOf(BillingQuoteSchema),
    summary: 'Price a plan purchase (offers, coupon, GST split)',
  },
  billingCheckout: {
    method: 'POST',
    path: '/billing/checkout',
    mode: 'cloud',
    permission: 'billing.manage',
    idempotent: true,
    body: CheckoutRequestSchema,
    response: dataOf(CheckoutResponseSchema),
    status: 201,
    summary: 'Razorpay payment link (prepaid) or subscription (monthly auto-renew)',
  },
  billingCancel: {
    method: 'POST',
    path: '/billing/cancel',
    mode: 'cloud',
    permission: 'billing.manage',
    body: CancelSubscriptionSchema.prefault({}),
    response: dataOf(SubscriptionViewSchema),
    summary: 'Cancel at period end',
  },
  billingInvoices: {
    method: 'GET',
    path: '/billing/invoices',
    mode: 'cloud',
    permission: 'billing.manage',
    query: BillingInvoiceListQuerySchema,
    response: listOf(BillingInvoiceSchema),
  },
  billingInvoicePrint: {
    method: 'GET',
    path: '/billing/invoices/:id/print',
    mode: 'cloud',
    permission: 'billing.manage',
    params: IdParams,
    response: dataOf(VendorInvoicePrintSchema),
    summary: 'GST tax invoice print model (bilingual)',
  },
  razorpayWebhook: {
    method: 'POST',
    path: '/platform/razorpay',
    scope: 'webhook',
    auth: 'public',
    mode: 'cloud',
    response: dataOf(WebhookAckSchema),
    summary: 'Razorpay platform webhook (signature-verified raw body, idempotent by event id)',
  },

  // ---- announcements (cloud tenants) ---------------------------------------------------------
  announcements: {
    method: 'GET',
    path: '/announcements',
    mode: 'cloud',
    response: dataOf(z.array(BannerSchema)),
    summary: 'Announcement & offer banners targeted at this tenant (any member)',
  },
  dismissAnnouncement: {
    method: 'POST',
    path: '/announcements/:id/dismiss',
    mode: 'cloud',
    params: IdParams,
    summary: 'Hide a banner for this tenant (critical banners cannot be dismissed → 409)',
  },

  // ---- system info ---------------------------------------------------------------------------
  systemInfo: {
    method: 'GET',
    path: '/system/info',
    permission: 'settings.manage',
    response: dataOf(SystemInfoSchema),
    summary: 'Version, mode, runtime, database, migrations, worker, storage (+ on-prem summary)',
  },

  // ---- API keys ------------------------------------------------------------------------------
  listApiKeys: {
    method: 'GET',
    path: '/api-keys',
    permission: 'settings.manage',
    feature: 'api_access',
    query: ApiKeyListQuerySchema,
    response: listOf(ApiKeySchema),
  },
  createApiKey: {
    method: 'POST',
    path: '/api-keys',
    permission: 'settings.manage',
    feature: 'api_access',
    body: ApiKeyCreateSchema,
    response: dataOf(ApiKeyCreateResultSchema),
    status: 201,
    summary: 'Create a key (permissions ⊆ yours); the full key is shown once',
  },
  revokeApiKey: {
    method: 'POST',
    path: '/api-keys/:id/revoke',
    permission: 'settings.manage',
    feature: 'api_access',
    params: IdParams,
    body: ApiKeyRevokeSchema.prefault({}),
    response: dataOf(ApiKeySchema),
  },
})
