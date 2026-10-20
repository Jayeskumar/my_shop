/**
 * Contract for the licensing module — the VENDOR control plane (ARCHITECTURE.md §21; docs/API.md
 * "licensing & vendor console"): platform staff & partners (resellers), licensees (customers),
 * price book, licences & activations, orders & GST invoices, offers & coupons, partner
 * commissions, releases, announcements, cloud-tenant admin, metrics, and the PUBLIC licensing
 * API that on-prem shop servers call (activation, signed check-ins, releases, renewal checkout,
 * licence refresh / deactivation, Kadai Connect, encrypted cloud backup storage, messaging relay).
 *
 * Pure helpers shared by both sides (and by the platform & onprem contracts) live here:
 *  - licence keys `KD-XXXX-XXXX-XXXX-XXXX` (Crockford base32, Luhn mod 32 check character)
 *  - installation-signed requests: canonical string, headers, clock skew
 *  - offline activation request format, licence file names / codes
 *  - semver, release eligibility (released_at ≤ updates_until), upgrade planning, artifact
 *    signature message
 *  - AMC & validity status, term extension, licence add-on features & limits
 *  - offer & announcement audience matching, banner selection (cloud GET /announcements and
 *    on-prem check-ins use the same selector)
 *  - priceOrder(): THE price of everything we sell (vendor console, cloud billing, on-prem
 *    renewals) — offers / coupons / partner discount / GST split
 *  - vendor GST invoice numbers, partner commissions, order & commission status machines
 *
 * Data: migration 0010 tables. They have no tenant_id and are revoked from the runtime role, so
 * every handler uses the SYSTEM pool (document it in each handler). Vendor console routes are
 * `/api/v1/platform/*`, cloud mode with KADAI_VENDOR_CONSOLE=true (404 otherwise), tenant-less
 * user tokens allowed, guarded by platform-staff capabilities (`VendorRouteDef.vendor`) instead
 * of tenant permissions; partner users only ever see their own partner's rows. Public routes are
 * `/public/v1/licensing/*` and `/public/v1/connect/*` (`LicensingPublicRouteDef.licensing`
 * declares how each one authenticates and its rate limit). No shop data is ever required.
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope;
 * paise / bp integers; business dates 'YYYY-MM-DD' (IST); custom validation messages are
 * snake_case keys (LICENSING_VALIDATION_KEYS).
 */
import { z } from 'zod'
import { OtpCodeSchema, OtpRequestResponseSchema } from './auth'
import {
  AddressSchema,
  PageQuerySchema,
  type RouteDef,
  dataOf,
  listOf,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zE164,
  zId,
  zPaise,
  zPhone,
  zSearchQuery,
  zStateCode,
  zTimestamp,
} from './common'
import {
  type BilingualLabel,
  zIfUpdatedAt,
  zNullableEmail,
  zNullableGstin,
  zNullablePhone,
  zNullableText,
  zQueryInt,
  zTags,
} from './identity'
import {
  ActivationMethodSchema,
  type ActivationStatus,
  ActivationStatusSchema,
  type AnnouncementSeverity,
  AnnouncementSeveritySchema,
  BackupKindSchema,
  BillingCycleSchema,
  type BusinessType,
  BusinessTypeSchema,
  CloudBackupStatusSchema,
  type CommissionStatus,
  CommissionStatusSchema,
  type DeploymentChannel,
  DeploymentChannelSchema,
  type LicenseEventKind,
  LicenseEventKindSchema,
  type LicenseProductKind,
  LicenseProductKindSchema,
  type LicenseType,
  LicenseTypeSchema,
  LocaleSchema,
  NotificationChannelSchema,
  NotificationStatusSchema,
  type OfferKind,
  OfferKindSchema,
  type PartnerTier,
  PartnerStatusSchema,
  PartnerTierSchema,
  PlatformInvoiceStatusSchema,
  type PlatformStaffRole,
  PlatformStaffRoleSchema,
  ReleaseChannelSchema,
  SubscriptionStatusSchema,
  TenantStatusSchema,
  type VendorLicenseStatus,
  VendorLicenseStatusSchema,
  type VendorOrderKind,
  VendorOrderKindSchema,
  type VendorOrderStatus,
  VendorOrderStatusSchema,
  VendorPaymentProviderSchema,
} from '../enums'
import type { ErrorCode } from '../errors'
import {
  type Feature,
  FeatureSchema,
  LIMIT_METRICS,
  type PlanLimits,
  PlanLimitsSchema,
  isFeature,
} from '../features'
import { DEFAULT_TIMEZONE, addDays, addMonths, diffDays, fyOf, fyShort, toDateStr } from '../fy'
import { getState, isValidGstRate, splitGst } from '../gst'
import { allocateProRata, assertNonNegativeInt, mulDiv, sumSafe } from '../math'
import { applyBp } from '../money'
import { amountInWords } from '../words'

// =============================================================================================
// Constants
// =============================================================================================

/** Format tag of signed licence documents (core/license.ts LICENSE_FORMAT). */
export const LICENSE_DOCUMENT_FORMAT = 'kadai-license-v1'

/** license_products.code / plans.code patterns (SQL CHECKs). */
export const PRODUCT_CODE_RE = /^[a-z][a-z0-9_]{1,39}$/
export const PLAN_CODE_RE = /^[a-z][a-z0-9_]{1,31}$/
/** releases.version (SQL CHECK): MAJOR.MINOR.PATCH with an optional -prerelease. */
export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/

/** SAC of software licensing services (license_products.hsn_sac default). */
export const SAC_SOFTWARE = '997331'
/** GST on everything we sell (license_products.gst_rate_bp default). */
export const VENDOR_GST_RATE_BP = 1800
/** Vendor's GST state when KADAI_VENDOR_STATE_CODE is not set (Tamil Nadu). */
export const DEFAULT_VENDOR_STATE_CODE = '33'

/** AMC / subscription "ending soon" window (status cards, reminders, banners). */
export const AMC_ENDING_SOON_DAYS = 30
/** licenses.grace_days default: a lapsed subscription keeps its edition this long. */
export const DEFAULT_GRACE_DAYS = 15
/** Suggested check-in interval written into licences (`check_in_days`; never enforced). */
export const DEFAULT_CHECK_IN_DAYS = 7
/** On-prem check-in schedule when online (job onprem.check-in). */
export const CHECK_IN_INTERVAL_SECONDS = 6 * 60 * 60
/** Self-service / staff transfers (activation deactivations) allowed per licence per 365 days. */
export const LICENSE_TRANSFERS_PER_YEAR = 3
/** No check-in for this many days → flagged for support (job licensing.stale-installations). */
export const STALE_INSTALLATION_DAYS = 45
/** `max_stores` written into payloads whose store limit is unlimited (the field is required). */
export const LICENSE_UNLIMITED_STORES = 10_000

/** Accepted clock skew of installation-signed requests (± seconds). */
export const SIGNED_REQUEST_MAX_SKEW_SECONDS = 600
/** Offline activation requests older than this are refused (request_expired). */
export const OFFLINE_REQUEST_MAX_AGE_DAYS = 30

/** Cloud backup quota per `addon_cloud_backup` unit, and the retention of stored backups. */
export const CLOUD_BACKUP_QUOTA_BYTES_PER_ADDON = 10 * 1024 ** 3
export const CLOUD_BACKUP_RETENTION_DAYS = 30
/** Presigned URL lifetime for backup upload / download. */
export const CLOUD_BACKUP_URL_TTL_SECONDS = 3600

/** Kadai Connect: header carrying the owner's connect token on /public/v1/connect/*. */
export const CONNECT_TOKEN_HEADER = 'x-kadai-connect-token'
/** Serialized connect snapshot size limit (bytes of JSON) accepted in a check-in. */
export const CONNECT_SNAPSHOT_MAX_BYTES = 64 * 1024
/** A shop's snapshot older than this is shown as stale on /connect. */
export const CONNECT_SNAPSHOT_STALE_MINUTES = 12 * 60

/**
 * Messages included per licence per calendar month (IST) through the messaging relay, by
 * edition plan code. Others (and editions without the 'notifications' feature) get 0.
 */
export const RELAY_MONTHLY_QUOTA: Readonly<Record<string, number>> = {
  onprem_starter: 0,
  onprem_standard: 1000,
  onprem_pro: 3000,
  onprem_enterprise: 10_000,
}

/** Default partner discount (off list price for partner-placed orders) by tier (PRODUCT.md). */
export const PARTNER_TIER_DEFAULT_DISCOUNT_BP: Readonly<Record<PartnerTier, number>> = {
  silver: 2000,
  gold: 2500,
  platinum: 3000,
}

/** Jobs of the licensing module (names are part of the contract: the platform webhook enqueues). */
export const LICENSING_JOBS = {
  /** Mark a vendor order paid and fulfil it (licence issue/extend, invoice no., commission). */
  fulfilOrder: 'licensing.fulfil-order',
  /** Daily 10:00 IST: AMC/subscription ending in 30/15/7/1 days and lapsed 7/30 days. */
  renewalReminders: 'licensing.renewal-reminders',
  /** No check-in for STALE_INSTALLATION_DAYS → flag for support. */
  staleInstallations: 'licensing.stale-installations',
  /** Delete cloud backups past expires_at (object + row status 'deleted'). */
  backupRetention: 'licensing.backup-retention',
} as const

/**
 * Data of `licensing.fulfil-order`. Enqueued by the platform module's Razorpay webhook
 * (`/webhooks/platform/razorpay`, payment_link.paid) for every vendor order whose kind is not
 * 'cloud_plan', and by POST /platform/orders/:id/mark-paid. Idempotent per order.
 */
export interface FulfilOrderJobData {
  order_id: string
  /** Razorpay payment id / UTR / partner settlement reference. */
  payment_ref: string
  provider: 'razorpay' | 'manual' | 'partner_credit'
  paid_amount_paise: number
  paid_at: string
  /** Webhook event id (deduplication / audit); null for manual payments. */
  event_id: string | null
}

/**
 * Keys of the `notes` object on Razorpay payment links / subscriptions we create; the platform
 * webhook dispatches on them.
 */
export const RAZORPAY_NOTE_KEYS = {
  order_id: 'kadai_order_id',
  order_kind: 'kadai_order_kind',
  tenant_id: 'kadai_tenant_id',
  license_id: 'kadai_license_id',
  plan_code: 'kadai_plan_code',
  cycle: 'kadai_cycle',
} as const

// =============================================================================================
// Validation keys, error reasons & labels
// =============================================================================================

/** Message keys of custom rules in this contract (web: platform:validation.<key>). */
export const LICENSING_VALIDATION_KEYS = [
  'license_key',
  'product_code',
  'plan_code',
  'semver',
  'sha256',
  'public_key',
  'signature',
  'gstin_state',
  'partner_code',
  'partner_required',
  'partner_not_allowed',
  'plan_required',
  'plan_not_allowed',
  'term_required',
  'term_not_allowed',
  'valid_until_required',
  'valid_until_not_allowed',
  'date_order',
  'percent_max',
  'free_months_max',
  'partner_offer_needs_code',
  'banner_title_required',
  'empty_patch',
  'duplicate_item',
  'customer_or_tenant',
  'license_required',
  'recipient',
  'request_format',
  'license_document',
  'ifsc',
  'staff_identifier',
  'gst_rate',
  'coupon_code',
  'url',
  'reason_required',
] as const
export type LicensingValidationKey = (typeof LICENSING_VALIDATION_KEYS)[number]

/**
 * `details.reason` of errors from the licensing API (public and console) with the error code it
 * travels with. The on-prem server relays vendor errors unchanged, so the shop UI can show the
 * localized text for the reason. `vendor_unreachable` is produced by the shop server itself.
 */
export const LICENSING_ERROR_REASONS = {
  key_format: {
    code: 'VALIDATION_ERROR',
    en: 'This is not a valid licence key. Please check for typing mistakes.',
    ta: 'இது சரியான உரிம விசை அல்ல. தட்டச்சுப் பிழைகளைச் சரிபார்க்கவும்.',
  },
  key_unknown: {
    code: 'LICENSE_INVALID',
    en: 'We could not find this licence key.',
    ta: 'இந்த உரிம விசை கிடைக்கவில்லை.',
  },
  license_suspended: {
    code: 'LICENSE_INVALID',
    en: 'This licence is suspended. Please contact Kadai support.',
    ta: 'இந்த உரிமம் இடைநிறுத்தப்பட்டுள்ளது. கடை ஆதரவைத் தொடர்பு கொள்ளவும்.',
  },
  license_revoked: {
    code: 'LICENSE_INVALID',
    en: 'This licence has been cancelled.',
    ta: 'இந்த உரிமம் ரத்து செய்யப்பட்டுள்ளது.',
  },
  license_expired: {
    code: 'LICENSE_INVALID',
    en: 'This licence has expired. Renew it to continue.',
    ta: 'இந்த உரிமம் காலாவதியானது. தொடர புதுப்பிக்கவும்.',
  },
  max_activations: {
    code: 'CONFLICT',
    en: 'This licence is already in use on another computer. Deactivate it there first.',
    ta: 'இந்த உரிமம் ஏற்கனவே வேறு கணினியில் பயன்பாட்டில் உள்ளது. முதலில் அங்கே செயலிழக்கச் செய்யவும்.',
  },
  clone_suspected: {
    code: 'CONFLICT',
    en: 'This installation looks copied from another computer. Please contact support.',
    ta: 'இந்த நிறுவல் வேறு கணினியிலிருந்து நகலெடுக்கப்பட்டது போல் உள்ளது. ஆதரவைத் தொடர்பு கொள்ளவும்.',
  },
  transfer_limit: {
    code: 'CONFLICT',
    en: 'The licence was moved too many times this year. Please contact support.',
    ta: 'இந்த ஆண்டு உரிமம் பலமுறை மாற்றப்பட்டுவிட்டது. ஆதரவைத் தொடர்பு கொள்ளவும்.',
  },
  activation_inactive: {
    code: 'LICENSE_INVALID',
    en: 'This computer is no longer activated for the licence.',
    ta: 'இந்தக் கணினி இனி இந்த உரிமத்திற்குச் செயல்படுத்தப்படவில்லை.',
  },
  installation_mismatch: {
    code: 'CONFLICT',
    en: 'The licence belongs to another installation.',
    ta: 'இந்த உரிமம் வேறு நிறுவலுக்குச் சொந்தமானது.',
  },
  request_invalid: {
    code: 'VALIDATION_ERROR',
    en: 'The activation request file is damaged or incomplete.',
    ta: 'செயல்படுத்தல் கோரிக்கைக் கோப்பு சேதமடைந்துள்ளது அல்லது முழுமையில்லை.',
  },
  request_expired: {
    code: 'VALIDATION_ERROR',
    en: 'The activation request is too old. Create a new one on the shop computer.',
    ta: 'செயல்படுத்தல் கோரிக்கை மிகப் பழையது. கடைக் கணினியில் புதியதை உருவாக்கவும்.',
  },
  signature_invalid: {
    code: 'UNAUTHENTICATED',
    en: 'The request signature is invalid.',
    ta: 'கோரிக்கையின் கையொப்பம் செல்லாது.',
  },
  timestamp_skew: {
    code: 'UNAUTHENTICATED',
    en: "The computer's date and time are wrong. Correct the clock and try again.",
    ta: 'கணினியின் தேதி மற்றும் நேரம் தவறாக உள்ளது. கடிகாரத்தைச் சரிசெய்து மீண்டும் முயற்சிக்கவும்.',
  },
  replayed: {
    code: 'UNAUTHENTICATED',
    en: 'This request was already received.',
    ta: 'இந்தக் கோரிக்கை ஏற்கனவே பெறப்பட்டது.',
  },
  installation_unknown: {
    code: 'UNAUTHENTICATED',
    en: 'This installation is not activated.',
    ta: 'இந்த நிறுவல் செயல்படுத்தப்படவில்லை.',
  },
  feature_not_licensed: {
    code: 'FEATURE_NOT_IN_PLAN',
    en: 'This add-on is not part of your licence.',
    ta: 'இந்தக் கூடுதல் வசதி உங்கள் உரிமத்தில் இல்லை.',
  },
  quota_exceeded: {
    code: 'PLAN_LIMIT_REACHED',
    en: 'You have used up this month’s allowance.',
    ta: 'இந்த மாதத்திற்கான அளவைப் பயன்படுத்திவிட்டீர்கள்.',
  },
  template_not_allowed: {
    code: 'VALIDATION_ERROR',
    en: 'This message template cannot be sent through Kadai.',
    ta: 'இந்தச் செய்தி வார்ப்புருவை கடை வழியாக அனுப்ப முடியாது.',
  },
  product_not_renewable: {
    code: 'UNPROCESSABLE',
    en: 'This item cannot be bought for this licence.',
    ta: 'இந்த உரிமத்திற்கு இதை வாங்க முடியாது.',
  },
  checkout_unavailable: {
    code: 'PROVIDER_ERROR',
    en: 'Online payment is not available right now. Please try again later.',
    ta: 'இப்போது ஆன்லைன் கட்டணம் கிடைக்கவில்லை. பின்னர் முயற்சிக்கவும்.',
  },
  vendor_unreachable: {
    code: 'PROVIDER_ERROR',
    en: 'Could not reach Kadai. Check the internet connection, or activate offline.',
    ta: 'கடை சேவையகத்தை அடைய முடியவில்லை. இணைய இணைப்பைச் சரிபார்க்கவும் அல்லது இணையமின்றி செயல்படுத்தவும்.',
  },
} as const satisfies Record<string, { code: ErrorCode } & BilingualLabel>
export type LicensingErrorReason = keyof typeof LICENSING_ERROR_REASONS
export const LICENSING_ERROR_REASON_LIST = Object.keys(LICENSING_ERROR_REASONS) as [
  LicensingErrorReason,
  ...LicensingErrorReason[],
]
export const LicensingErrorReasonSchema = z.enum(LICENSING_ERROR_REASON_LIST)

export const LICENSE_TYPE_LABELS: Readonly<Record<LicenseType, BilingualLabel>> = {
  perpetual: { en: 'Perpetual (one-time)', ta: 'நிரந்தர உரிமம் (ஒருமுறை)' },
  subscription: { en: 'Yearly subscription', ta: 'ஆண்டு சந்தா' },
  trial: { en: 'Trial', ta: 'சோதனை' },
  nfr: { en: 'Not for resale (partner / demo)', ta: 'விற்பனைக்கல்ல (கூட்டாளர் / டெமோ)' },
}

export const VENDOR_LICENSE_STATUS_LABELS: Readonly<Record<VendorLicenseStatus, BilingualLabel>> = {
  active: { en: 'Active', ta: 'செயலில்' },
  suspended: { en: 'Suspended', ta: 'இடைநிறுத்தப்பட்டது' },
  revoked: { en: 'Revoked', ta: 'ரத்து செய்யப்பட்டது' },
}

export const ACTIVATION_STATUS_LABELS: Readonly<Record<ActivationStatus, BilingualLabel>> = {
  active: { en: 'Active', ta: 'செயலில்' },
  deactivated: { en: 'Deactivated', ta: 'செயலிழக்கப்பட்டது' },
  blocked: { en: 'Blocked', ta: 'தடுக்கப்பட்டது' },
}

export const LICENSE_PRODUCT_KIND_LABELS: Readonly<Record<LicenseProductKind, BilingualLabel>> = {
  edition: { en: 'Edition', ta: 'பதிப்பு' },
  subscription: { en: 'Yearly licence', ta: 'ஆண்டு உரிமம்' },
  amc: { en: 'Updates & support (AMC)', ta: 'புதுப்பிப்புகள் & ஆதரவு (AMC)' },
  addon: { en: 'Add-on', ta: 'கூடுதல் வசதி' },
  cloud_plan: { en: 'Cloud plan', ta: 'கிளவுட் திட்டம்' },
  service: { en: 'Service', ta: 'சேவை' },
}

export const OFFER_KIND_LABELS: Readonly<Record<OfferKind, BilingualLabel>> = {
  percent: { en: 'Percent off', ta: 'சதவீத தள்ளுபடி' },
  flat: { en: 'Flat amount off', ta: 'நிலையான தொகை தள்ளுபடி' },
  free_months: { en: 'Free months', ta: 'இலவச மாதங்கள்' },
  price_override: { en: 'Special price', ta: 'சிறப்பு விலை' },
}

export const VENDOR_ORDER_STATUS_LABELS: Readonly<Record<VendorOrderStatus, BilingualLabel>> = {
  draft: { en: 'Draft', ta: 'வரைவு' },
  pending_payment: { en: 'Awaiting payment', ta: 'பணம் நிலுவையில்' },
  paid: { en: 'Paid', ta: 'பணம் பெறப்பட்டது' },
  fulfilled: { en: 'Fulfilled', ta: 'நிறைவேற்றப்பட்டது' },
  cancelled: { en: 'Cancelled', ta: 'ரத்து செய்யப்பட்டது' },
  refunded: { en: 'Refunded', ta: 'பணம் திருப்பியளிக்கப்பட்டது' },
}

export const VENDOR_ORDER_KIND_LABELS: Readonly<Record<VendorOrderKind, BilingualLabel>> = {
  new_license: { en: 'New licence', ta: 'புதிய உரிமம்' },
  renewal: { en: 'Renewal', ta: 'புதுப்பித்தல்' },
  upgrade: { en: 'Upgrade', ta: 'மேம்படுத்தல்' },
  addon: { en: 'Add-on', ta: 'கூடுதல் வசதி' },
  cloud_plan: { en: 'Cloud plan', ta: 'கிளவுட் திட்டம்' },
  service: { en: 'Service', ta: 'சேவை' },
}

export const STAFF_ROLE_LABELS: Readonly<Record<PlatformStaffRole, BilingualLabel>> = {
  owner: { en: 'Owner', ta: 'உரிமையாளர்' },
  admin: { en: 'Admin', ta: 'நிர்வாகி' },
  sales: { en: 'Sales', ta: 'விற்பனை' },
  support: { en: 'Support', ta: 'ஆதரவு' },
  finance: { en: 'Finance', ta: 'நிதி' },
  partner: { en: 'Partner', ta: 'கூட்டாளர்' },
}

export const PARTNER_TIER_LABELS: Readonly<Record<PartnerTier, BilingualLabel>> = {
  silver: { en: 'Silver', ta: 'வெள்ளி' },
  gold: { en: 'Gold', ta: 'தங்கம்' },
  platinum: { en: 'Platinum', ta: 'பிளாட்டினம்' },
}

export const COMMISSION_STATUS_LABELS: Readonly<Record<CommissionStatus, BilingualLabel>> = {
  accrued: { en: 'Accrued', ta: 'சேர்ந்தது' },
  approved: { en: 'Approved', ta: 'அங்கீகரிக்கப்பட்டது' },
  paid: { en: 'Paid', ta: 'செலுத்தப்பட்டது' },
  void: { en: 'Void', ta: 'செல்லாது' },
}

export const ANNOUNCEMENT_SEVERITY_LABELS: Readonly<Record<AnnouncementSeverity, BilingualLabel>> =
  {
    info: { en: 'Information', ta: 'தகவல்' },
    offer: { en: 'Offer', ta: 'சலுகை' },
    warning: { en: 'Warning', ta: 'எச்சரிக்கை' },
    critical: { en: 'Important', ta: 'முக்கியம்' },
  }

export const LICENSE_EVENT_LABELS: Readonly<Record<LicenseEventKind, BilingualLabel>> = {
  issued: { en: 'Licence issued', ta: 'உரிமம் வழங்கப்பட்டது' },
  activated: { en: 'Activated', ta: 'செயல்படுத்தப்பட்டது' },
  offline_activated: { en: 'Activated offline', ta: 'இணையமின்றி செயல்படுத்தப்பட்டது' },
  check_in: { en: 'Check-in', ta: 'சரிபார்ப்பு' },
  deactivated: { en: 'Deactivated', ta: 'செயலிழக்கப்பட்டது' },
  transferred: { en: 'Moved to a new computer', ta: 'புதிய கணினிக்கு மாற்றப்பட்டது' },
  renewed: { en: 'Renewed', ta: 'புதுப்பிக்கப்பட்டது' },
  upgraded: { en: 'Edition upgraded', ta: 'பதிப்பு மேம்படுத்தப்பட்டது' },
  addon_added: { en: 'Add-on added', ta: 'கூடுதல் வசதி சேர்க்கப்பட்டது' },
  suspended: { en: 'Suspended', ta: 'இடைநிறுத்தப்பட்டது' },
  resumed: { en: 'Resumed', ta: 'மீண்டும் தொடங்கப்பட்டது' },
  revoked: { en: 'Revoked', ta: 'ரத்து செய்யப்பட்டது' },
  clone_suspected: { en: 'Copied installation suspected', ta: 'நகல் நிறுவல் சந்தேகம்' },
  license_downloaded: { en: 'Licence file downloaded', ta: 'உரிமக் கோப்பு பதிவிறக்கப்பட்டது' },
  update_installed: { en: 'Update installed', ta: 'புதுப்பிப்பு நிறுவப்பட்டது' },
}

// =============================================================================================
// Field schemas
// =============================================================================================

export const zProductCode = z.string().trim().regex(PRODUCT_CODE_RE, 'product_code')
export const zPlanCode = z.string().trim().regex(PLAN_CODE_RE, 'plan_code')
export const zSemver = z.string().trim().regex(SEMVER_RE, 'semver')
/** Lower-case hex SHA-256. */
export const zSha256Hex = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, 'sha256')
/** Base64 (standard alphabet, padded) text such as an Ed25519 signature or SPKI key. */
const zBase64 = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'signature')
/** Ed25519 public key as base64 SPKI DER (44 bytes → 60 characters). */
export const zEd25519PublicKey = zBase64(40, 120).describe(
  'Ed25519 public key, base64 of the SPKI DER encoding',
)
/** Ed25519 signature, base64 (64 bytes → 88 characters). */
export const zEd25519Signature = zBase64(80, 100)
/** installation_id (UUID written on first boot, core/license.ts getInstallationId). */
export const zInstallationId = z.string().trim().min(8).max(100)
/** Coupon code input (offers.code CHECK, case-insensitive; stored upper-case). */
export const zCouponCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,32}$/, 'coupon_code')
/** Optional coupon code: '' / null / missing → null. */
export const zOptionalCouponCode = z
  .union([z.null(), z.literal(''), zCouponCode])
  .optional()
  .transform((v) => (v ? v : null))

/** Vendor-side business date or ISO instant used by the pure helpers. */
type Instant = string | Date

function instantMs(v: Instant): number {
  const ms = v instanceof Date ? v.getTime() : Date.parse(v)
  if (!Number.isFinite(ms)) throw new RangeError(`invalid instant: ${String(v)}`)
  return ms
}

// =============================================================================================
// Licence keys — KD-XXXX-XXXX-XXXX-XXXX
// =============================================================================================

/** Crockford base32 symbols (no I, L, O, U). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CROCKFORD_ALIASES: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' }
/** Random symbols in a key (+1 check symbol = 16 → 75 bits of entropy). */
export const LICENSE_KEY_RANDOM_LENGTH = 15
export const LICENSE_KEY_RE = /^KD(-[0-9A-HJKMNP-TV-Z]{4}){4}$/

function crockfordValue(ch: string): number {
  const v = CROCKFORD_ALPHABET.indexOf(ch)
  if (v < 0) throw new RangeError(`invalid Crockford base32 symbol "${ch}"`)
  return v
}

/**
 * Luhn mod 32 check symbol over Crockford base32 symbols: detects every single-symbol error and
 * most adjacent transpositions.
 */
export function crockfordCheckChar(body: string): string {
  const n = CROCKFORD_ALPHABET.length
  let factor = 2
  let sum = 0
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * crockfordValue(body[i]!)
    factor = factor === 2 ? 1 : 2
    addend = Math.floor(addend / n) + (addend % n)
    sum += addend
  }
  return CROCKFORD_ALPHABET[(n - (sum % n)) % n]!
}

function luhnMod32Valid(symbols: string): boolean {
  const n = CROCKFORD_ALPHABET.length
  let factor = 1
  let sum = 0
  for (let i = symbols.length - 1; i >= 0; i--) {
    const v = CROCKFORD_ALPHABET.indexOf(symbols[i]!)
    if (v < 0) return false
    let addend = factor * v
    factor = factor === 2 ? 1 : 2
    addend = Math.floor(addend / n) + (addend % n)
    sum += addend
  }
  return sum % n === 0
}

function groupKey(symbols: string): string {
  return `KD-${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8, 12)}-${symbols.slice(12, 16)}`
}

function cleanKeySymbols(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[OIL]/g, (c) => CROCKFORD_ALIASES[c] ?? c)
}

type RandomBytes = (length: number) => Uint8Array

function defaultRandomBytes(length: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto
  if (!c || typeof c.getRandomValues !== 'function')
    throw new Error('Web Crypto (crypto.getRandomValues) is not available')
  return c.getRandomValues(new Uint8Array(length))
}

/**
 * New licence key 'KD-XXXX-XXXX-XXXX-XXXX' (15 random symbols + check symbol). Shown once; only
 * sha256(key) and licenseKeyPrefix(key) are stored. key_prefix is UNIQUE with 20 bits, so the
 * server generates again on a unique violation of licenses.key_prefix.
 */
export function generateLicenseKey(randomBytes: RandomBytes = defaultRandomBytes): string {
  const bytes = randomBytes(LICENSE_KEY_RANDOM_LENGTH)
  if (bytes.length < LICENSE_KEY_RANDOM_LENGTH) throw new RangeError('not enough random bytes')
  let body = ''
  // 256 is a multiple of 32, so `& 31` is unbiased.
  for (let i = 0; i < LICENSE_KEY_RANDOM_LENGTH; i++) body += CROCKFORD_ALPHABET[bytes[i]! & 31]
  return groupKey(body + crockfordCheckChar(body))
}

/**
 * Normalizes typed / pasted input ('kd 7q2m-…', lower case, O/I/L typed for 0/1, missing
 * dashes) to the canonical 'KD-XXXX-XXXX-XXXX-XXXX', or null when it is not a valid key
 * (wrong length or check symbol). sha256 of the canonical form is licenses.key_hash.
 */
export function parseLicenseKey(input: string): string | null {
  if (typeof input !== 'string') return null
  let symbols = cleanKeySymbols(input)
  if (symbols.length === 18 && symbols.startsWith('KD')) symbols = symbols.slice(2)
  if (symbols.length !== 16 || !luhnMod32Valid(symbols)) return null
  return groupKey(symbols)
}

/** True for a canonical, checksum-valid key. */
export function isLicenseKey(value: unknown): value is string {
  return typeof value === 'string' && LICENSE_KEY_RE.test(value) && parseLicenseKey(value) === value
}

/** 'KD-7Q2M' — licenses.key_prefix, shown in lists. */
export function licenseKeyPrefix(key: string): string {
  const canonical = parseLicenseKey(key)
  if (!canonical) throw new RangeError('invalid licence key')
  return canonical.slice(0, 7)
}

/** 'KD-7Q2M-••••-••••-••••' for display after the one-time reveal. */
export function maskLicenseKey(prefix: string): string {
  return `${prefix}-••••-••••-••••`
}

/**
 * Auto-format while typing (the shop's activation field): upper-cases, maps O/I/L, drops other
 * characters, groups by 4 and prefixes 'KD-'. A leading 'KD' is treated as the prefix when the
 * input starts with 'KD-'/'KD ' or has more than 16 symbols.
 */
export function formatLicenseKeyInput(raw: string): string {
  let symbols = cleanKeySymbols(raw)
  if (/^\s*kd[\s-]/i.test(raw) || (symbols.length > 16 && symbols.startsWith('KD')))
    symbols = symbols.slice(2)
  symbols = symbols.slice(0, 16)
  if (!symbols) return ''
  const groups = symbols.match(/.{1,4}/g) ?? []
  return `KD-${groups.join('-')}`
}

/** Licence key input: any accepted spelling → canonical key; invalid → 'license_key'. */
export const zLicenseKey = z
  .string()
  .trim()
  .max(64)
  .refine((v) => parseLicenseKey(v) !== null, { message: 'license_key' })
  .transform((v) => parseLicenseKey(v) ?? v)

// =============================================================================================
// Installation-signed requests (shop server → vendor)
// =============================================================================================

export const INSTALLATION_HEADER = 'x-kadai-installation'
export const TIMESTAMP_HEADER = 'x-kadai-timestamp'
export const SIGNATURE_HEADER = 'x-kadai-signature'
/** sha256 of an empty body (GET requests). */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export interface SignedRequestParts {
  /** HTTP method, any case (upper-cased in the payload). */
  method: string
  /**
   * Request path exactly as sent, starting with '/public/v1/…' and including the query string
   * (e.g. '/public/v1/licensing/releases?channel=stable&from_version=1.2.0').
   */
  path: string
  /** Unix time in whole seconds (X-Kadai-Timestamp). */
  timestamp: number | string
  /** Lower-case hex sha256 of the exact raw body bytes (EMPTY_BODY_SHA256 for no body). */
  body_sha256: string
}

/**
 * The string an installation signs with its Ed25519 private key (and the vendor verifies with
 * license_activations.installation_public_key):
 *
 *   `${METHOD}\n${path}\n${timestamp}\n${sha256(body)}`
 *
 * The signature is sent base64 in X-Kadai-Signature, the installation id in X-Kadai-Installation
 * and the timestamp in X-Kadai-Timestamp. The vendor rejects |now − timestamp| >
 * SIGNED_REQUEST_MAX_SKEW_SECONDS (timestamp_skew, details.server_time) and any signature it saw
 * within that window (replayed). Clients re-sign each retry with a fresh timestamp.
 */
export function installationSignaturePayload(parts: SignedRequestParts): string {
  const method = parts.method.toUpperCase()
  if (!/^[A-Z]+$/.test(method)) throw new RangeError('invalid method')
  if (!parts.path.startsWith('/') || /[\r\n]/.test(parts.path)) throw new RangeError('invalid path')
  const ts = String(parts.timestamp)
  if (!/^\d{1,12}$/.test(ts)) throw new RangeError('timestamp must be unix seconds')
  const hash = parts.body_sha256.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new RangeError('body_sha256 must be hex sha256')
  return `${method}\n${parts.path}\n${ts}\n${hash}`
}

/** Unix seconds of an instant (X-Kadai-Timestamp). */
export function unixSeconds(at: Instant = new Date()): number {
  return Math.floor(instantMs(at) / 1000)
}

/** Headers of a signed request. */
export function signedRequestHeaders(input: {
  installation_id: string
  timestamp: number
  signature: string
}): Record<string, string> {
  return {
    [INSTALLATION_HEADER]: input.installation_id,
    [TIMESTAMP_HEADER]: String(input.timestamp),
    [SIGNATURE_HEADER]: input.signature,
  }
}

export interface ParsedSignedHeaders {
  installation_id: string
  timestamp: number
  signature: string
}

/** Reads the three signature headers (lower-case keys, as Node/Fastify expose them). */
export function parseSignedRequestHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): ParsedSignedHeaders | null {
  const one = (name: string): string | null => {
    const v = headers[name]
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' && s.trim() ? s.trim() : null
  }
  const installation_id = one(INSTALLATION_HEADER)
  const ts = one(TIMESTAMP_HEADER)
  const signature = one(SIGNATURE_HEADER)
  if (!installation_id || !ts || !signature || !/^\d{1,12}$/.test(ts)) return null
  if (!zInstallationId.safeParse(installation_id).success) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 200) return null
  return { installation_id, timestamp: Number(ts), signature }
}

/** Seconds between the request timestamp and now (positive = request from the future). */
export function timestampSkewSeconds(timestamp: number, now: Instant = new Date()): number {
  return timestamp - unixSeconds(now)
}

export function isTimestampFresh(
  timestamp: number,
  now: Instant = new Date(),
  maxSkewSeconds = SIGNED_REQUEST_MAX_SKEW_SECONDS,
): boolean {
  return Math.abs(timestampSkewSeconds(timestamp, now)) <= maxSkewSeconds
}

// =============================================================================================
// Installation identity, offline activation & licence documents
// =============================================================================================

export const ACTIVATION_REQUEST_FORMAT = 'kadai-activation-request-v1'
/** Copy/paste form of an activation request: prefix + base64url(UTF-8 JSON of the envelope). */
export const ACTIVATION_REQUEST_CODE_PREFIX = 'KDREQ1.'
/** Copy/paste form of a signed licence: prefix + base64url(UTF-8 JSON of the document). */
export const LICENSE_CODE_PREFIX = 'KDLIC1.'
export const ACTIVATION_REQUEST_FILE_EXTENSION = '.kadai-request'
export const LICENSE_FILE_EXTENSION = '.kadai-license'

/** What an installation tells the vendor about itself (never shop data). */
export const InstallationIdentitySchema = z.object({
  installation_id: zInstallationId,
  installation_public_key: zEd25519PublicKey,
  fingerprint_hash: zSha256Hex.describe(
    'sha256 of the machine id (/etc/machine-id, Windows MachineGuid, or hostname+MAC) + the ' +
      'Postgres system_identifier',
  ),
  machine_name: z.string().trim().min(1).max(120),
  os: z.string().trim().min(1).max(120).describe("e.g. 'windows 10.0.19045 x64'"),
  app_version: zSemver,
  business_name: z.string().trim().min(1).max(200),
})
export type InstallationIdentity = z.output<typeof InstallationIdentitySchema>

/**
 * Offline activation request built by the shop server (GET /system/license/activation-request):
 * the identity plus a nonce, signed with the installation private key over
 * canonicalJson(request) (core/crypto). It contains no secret (the licence key is entered on the
 * vendor side), so it can be WhatsApped safely.
 */
export const OfflineActivationRequestPayloadSchema = InstallationIdentitySchema.extend({
  created_at: z.iso.datetime({ offset: true }),
  nonce: z.string().trim().min(16).max(64),
})
export type OfflineActivationRequestPayload = z.output<typeof OfflineActivationRequestPayloadSchema>

export const OfflineActivationRequestSchema = z.object({
  format: z.literal(ACTIVATION_REQUEST_FORMAT),
  request: OfflineActivationRequestPayloadSchema,
  signature: zEd25519Signature,
})
export type OfflineActivationRequest = z.output<typeof OfflineActivationRequestSchema>

/** A request as uploaded: the JSON envelope, or its 'KDREQ1.' copy/paste code. */
export const ActivationRequestInputSchema = z.union([
  OfflineActivationRequestSchema,
  z
    .string()
    .trim()
    .max(8000)
    .refine((v) => v.startsWith(ACTIVATION_REQUEST_CODE_PREFIX) || v.startsWith('{'), {
      message: 'request_format',
    })
    .describe("'KDREQ1.<base64url JSON>' code or the JSON text of a .kadai-request file"),
])
export type ActivationRequestInput = z.input<typeof ActivationRequestInputSchema>

/** Signed licence document (core/license.ts SignedLicenseSchema). */
export const SignedLicenseDocumentSchema = z.object({
  format: z.literal(LICENSE_DOCUMENT_FORMAT),
  kid: z.string().min(1).max(64),
  license: z.record(z.string(), z.unknown()),
  signature: z.string().min(1).max(200),
})
export type SignedLicenseDocument = z.output<typeof SignedLicenseDocumentSchema>

/** A licence as uploaded to a shop server: the document, its JSON text or a 'KDLIC1.' code. */
export const LicenseFileInputSchema = z.union([
  SignedLicenseDocumentSchema,
  z
    .string()
    .trim()
    .max(20_000)
    .refine((v) => v.startsWith(LICENSE_CODE_PREFIX) || v.startsWith('{'), {
      message: 'license_document',
    }),
])
export type LicenseFileInput = z.input<typeof LicenseFileInputSchema>

/** 'kadai-activation-0192ab34.kadai-request' */
export function activationRequestFilename(installationId: string): string {
  const short = installationId.replace(/[^0-9A-Za-z]/g, '').slice(0, 8) || 'install'
  return `kadai-activation-${short}${ACTIVATION_REQUEST_FILE_EXTENSION}`
}

/** 'kadai-license-KD-7Q2M.kadai-license' */
export function licenseFilename(keyPrefixOrId: string): string {
  const safe = keyPrefixOrId.replace(/[^0-9A-Za-z-]/g, '').slice(0, 40) || 'license'
  return `kadai-license-${safe}${LICENSE_FILE_EXTENSION}`
}

// =============================================================================================
// Licence add-ons, effective features & limits
// =============================================================================================

/** Per-unit limit increments of an add-on (license_products.limits, e.g. {"registers": 1}). */
export const AddonLimitIncrementsSchema = z.object({
  stores: z.int().min(0).max(10_000).optional(),
  users: z.int().min(0).max(10_000).optional(),
  registers: z.int().min(0).max(10_000).optional(),
  products: z.int().min(0).max(10_000_000).optional(),
  invoices_per_month: z.int().min(0).max(10_000_000).optional(),
})
export type AddonLimitIncrements = z.output<typeof AddonLimitIncrementsSchema>

/**
 * One add-on of a licence (licenses.addons jsonb AND the signed payload's `addons`). The
 * features / per-unit limits are snapshotted from the price book when added, so price-book edits
 * never change existing licences. Limit add-ons (counters, branches) are perpetual; feature
 * add-ons (connect, cloud_backup) carry valid_until and lapse on their own.
 */
export const LicenseAddonSchema = z.object({
  product_code: zProductCode,
  qty: z.int().min(1).max(1000),
  features: z.array(FeatureSchema).max(10).default([]),
  limits: AddonLimitIncrementsSchema.default({}),
  /** Last day (inclusive) of a term add-on; null = perpetual. */
  valid_until: zDateStr.nullable().default(null),
})
export type LicenseAddon = z.output<typeof LicenseAddonSchema>
export type LicenseAddonInput = z.input<typeof LicenseAddonSchema>

type AddonLike = Pick<LicenseAddon, 'qty' | 'valid_until'> & {
  features?: readonly string[]
  limits?: AddonLimitIncrements
}

export function isAddonActive(addon: Pick<LicenseAddon, 'valid_until'>, today: string): boolean {
  return addon.valid_until == null || addon.valid_until >= today
}

/**
 * Effective features of a licence: the base list (payload `features`, else the edition's plan
 * features) plus the features of add-ons active on `today`. Unknown codes are dropped. Used by
 * core/entitlements (shop) and the vendor console (customer 360).
 */
export function licenseEffectiveFeatures(
  base: readonly string[],
  addons: readonly AddonLike[] = [],
  today: string,
): Feature[] {
  const out = new Set<Feature>()
  for (const f of base) if (isFeature(f)) out.add(f)
  for (const a of addons)
    if (isAddonActive(a, today)) for (const f of a.features ?? []) if (isFeature(f)) out.add(f)
  return [...out].sort()
}

/**
 * Effective limits: edition limits, replaced by staff overrides (licenses.limits — absolute
 * values, null = unlimited), then increased by active add-ons (qty × per-unit increment; an
 * unlimited metric stays unlimited). The vendor signs the result into the payload's `limits`
 * and `max_stores` (licenseMaxStores), so older shop versions get the same numbers.
 */
export function licenseEffectiveLimits(
  base: PlanLimits,
  overrides: Partial<PlanLimits> = {},
  addons: readonly AddonLike[] = [],
  today?: string,
): PlanLimits {
  const out: PlanLimits = { ...base }
  for (const m of LIMIT_METRICS) {
    const v = overrides[m]
    if (v !== undefined) out[m] = v
  }
  for (const a of addons) {
    if (today !== undefined && !isAddonActive(a, today)) continue
    for (const m of LIMIT_METRICS) {
      const inc = a.limits?.[m]
      const cur = out[m]
      if (inc && cur !== null) out[m] = cur + inc * a.qty
    }
  }
  return out
}

/** Payload `max_stores` (required ≥ 1 by every shop version): unlimited → 10 000. */
export function licenseMaxStores(limits: Pick<PlanLimits, 'stores'>): number {
  return limits.stores === null ? LICENSE_UNLIMITED_STORES : Math.max(1, limits.stores)
}

// =============================================================================================
// Terms, AMC & validity status
// =============================================================================================

/** Last day (inclusive) of a term of `months` starting on `start`: 2026-10-20 + 12 → 2027-10-19. */
export function termEndDate(start: string, months: number): string {
  return addDays(addMonths(start, months), -1)
}

/**
 * New end date when renewing for `months`: continues from the current end when it is still
 * running (end ≥ today), otherwise starts today — "extend from max(today, current end)".
 */
export function extendTermEnd(currentEnd: string | null, today: string, months: number): string {
  if (currentEnd !== null && currentEnd >= today) return addMonths(currentEnd, months)
  return termEndDate(today, months)
}

export const AmcStateSchema = z.enum(['active', 'ending_soon', 'expired'])
export type AmcState = z.infer<typeof AmcStateSchema>

/** Updates & support (AMC) status from licenses.updates_until. */
export const AmcStatusSchema = z.object({
  status: AmcStateSchema,
  /** updates_until; null = updates without end (enterprise / NFR). */
  until: zDateStr.nullable(),
  /** Days until `until` (0 on the last day, negative once expired); null when unbounded. */
  days_left: z.int().nullable(),
})
export type AmcStatus = z.output<typeof AmcStatusSchema>

export const AMC_STATE_LABELS: Readonly<Record<AmcState, BilingualLabel>> = {
  active: { en: 'Updates & support active', ta: 'புதுப்பிப்புகள் & ஆதரவு செயலில்' },
  ending_soon: { en: 'AMC ending soon', ta: 'AMC விரைவில் முடிகிறது' },
  expired: { en: 'AMC expired', ta: 'AMC காலாவதியானது' },
}

export function amcStatus(
  updatesUntil: string | null,
  today: string,
  soonDays: number = AMC_ENDING_SOON_DAYS,
): AmcStatus {
  if (updatesUntil === null) return { status: 'active', until: null, days_left: null }
  const days = diffDays(today, updatesUntil)
  const status: AmcState = days < 0 ? 'expired' : days <= soonDays ? 'ending_soon' : 'active'
  return { status, until: updatesUntil, days_left: days }
}

export const LicenseTermStateSchema = z.enum([
  'perpetual',
  'active',
  'ending_soon',
  'grace',
  'expired',
])
export type LicenseTermState = z.infer<typeof LicenseTermStateSchema>

/** Validity of the licence itself (valid_until + grace_days). */
export const LicenseTermStatusSchema = z.object({
  status: LicenseTermStateSchema,
  until: zDateStr.nullable(),
  days_left: z.int().nullable(),
  /** Last day of the grace period (valid_until + grace_days); null for perpetual. */
  grace_ends_on: zDateStr.nullable(),
})
export type LicenseTermStatus = z.output<typeof LicenseTermStatusSchema>

/**
 * perpetual (valid_until null) · active · ending_soon (≤ soonDays) · grace (after valid_until,
 * within grace_days: edition still unlocked) · expired (Free plan limits on the shop, data kept).
 */
export function licenseTermStatus(
  license: { valid_until: string | null; grace_days?: number | null },
  today: string,
  soonDays: number = AMC_ENDING_SOON_DAYS,
): LicenseTermStatus {
  if (license.valid_until === null)
    return { status: 'perpetual', until: null, days_left: null, grace_ends_on: null }
  const grace = Math.max(0, license.grace_days ?? 0)
  const graceEnds = addDays(license.valid_until, grace)
  const days = diffDays(today, license.valid_until)
  let status: LicenseTermState
  if (days >= 0) status = days <= soonDays ? 'ending_soon' : 'active'
  else status = today <= graceEnds ? 'grace' : 'expired'
  return { status, until: license.valid_until, days_left: days, grace_ends_on: graceEnds }
}

// =============================================================================================
// Semver & releases
// =============================================================================================

export const RELEASE_PLATFORMS = ['windows-x64', 'linux-x64', 'docker'] as const
export const ReleasePlatformSchema = z.enum(RELEASE_PLATFORMS)
export type ReleasePlatform = z.infer<typeof ReleasePlatformSchema>

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_RE.test(value)
}

function parseSemver(v: string): { core: [number, number, number]; pre: string[] } {
  if (!isSemver(v)) throw new RangeError(`invalid version "${v}"`)
  const [main, pre] = v.split(/-(.*)/s) as [string, string | undefined]
  const [a, b, c] = main.split('.').map(Number) as [number, number, number]
  return { core: [a, b, c], pre: pre ? pre.split('.') : [] }
}

/** Semver 2.0 precedence: -1 when a < b, 0 when equal, 1 when a > b (1.2.0-beta.2 < 1.2.0). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a)
  const y = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    const d = x.core[i]! - y.core[i]!
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0
    return x.pre.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      const d = Number(p) - Number(q)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (pn !== qn) {
      return pn ? -1 : 1
    } else if (p !== q) {
      return p < q ? -1 : 1
    }
  }
  return 0
}

/**
 * Message signed (Ed25519, KADAI_RELEASE_SIGNING_KEY) for each release artifact and verified by
 * the host updater with the embedded release public key: `${sha256}|${version}|${platform}`.
 */
export function releaseSignatureMessage(
  sha256: string,
  version: string,
  platform: ReleasePlatform,
): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new RangeError('sha256 must be lower-case hex')
  if (!isSemver(version)) throw new RangeError('invalid version')
  return `${sha256}|${version}|${platform}`
}

/**
 * A release may be installed when it was published on or before the AMC end date
 * (updates_until, IST business date; null = unlimited updates). Daily use is never gated.
 */
export function isReleaseEligible(
  release: { released_at: Instant },
  updatesUntil: string | null,
): boolean {
  if (updatesUntil === null) return true
  const released =
    release.released_at instanceof Date ? release.released_at : new Date(release.released_at)
  return toDateStr(released, DEFAULT_TIMEZONE) <= updatesUntil
}

export interface ReleaseLike {
  version: string
  channel: 'stable' | 'beta'
  released_at: Instant
  min_upgrade_from?: string | null
  is_active?: boolean
  artifacts?: readonly { platform: string }[]
}

export interface UpgradePlan<R extends ReleaseLike> {
  /** Releases newer than the current version on the channel, newest first. */
  newer: R[]
  /** Eligible subset of `newer`, newest first. */
  eligible: R[]
  latest_eligible: R | null
  /** Newest release that needs an AMC renewal and is newer than latest_eligible (nudge). */
  newest_ineligible: R | null
  /** What to install next: the newest eligible release whose min_upgrade_from ≤ current. */
  next_step: R | null
}

/**
 * Upgrade planning for an installation: active releases on its channel (a beta install also
 * sees stable releases), with an artifact for `platform` when given, newer than
 * `currentVersion`; eligibility by AMC; stepping-stone releases via min_upgrade_from.
 */
export function planUpgrades<R extends ReleaseLike>(
  releases: readonly R[],
  opts: {
    current_version: string
    channel: 'stable' | 'beta'
    updates_until: string | null
    platform?: ReleasePlatform
  },
): UpgradePlan<R> {
  const newer = releases
    .filter(
      (r) =>
        r.is_active !== false &&
        (opts.channel === 'beta' || r.channel === 'stable') &&
        isSemver(r.version) &&
        compareSemver(r.version, opts.current_version) > 0 &&
        (!opts.platform || !r.artifacts || r.artifacts.some((a) => a.platform === opts.platform)),
    )
    .sort((a, b) => compareSemver(b.version, a.version))
  const eligible = newer.filter((r) => isReleaseEligible(r, opts.updates_until))
  const latest = eligible[0] ?? null
  const ineligible = newer.find(
    (r) =>
      !isReleaseEligible(r, opts.updates_until) &&
      (latest === null || compareSemver(r.version, latest.version) > 0),
  )
  const nextStep =
    eligible.find(
      (r) =>
        !r.min_upgrade_from ||
        !isSemver(r.min_upgrade_from) ||
        compareSemver(opts.current_version, r.min_upgrade_from) >= 0,
    ) ?? null
  return {
    newer,
    eligible,
    latest_eligible: latest,
    newest_ineligible: ineligible ?? null,
    next_step: nextStep,
  }
}

// =============================================================================================
// Audiences: offers & announcements, banners
// =============================================================================================

/** Buyer segments an offer can target (a customer may be in several). */
export const OfferSegmentSchema = z.enum(['new', 'existing', 'lapsed_amc'])
export type OfferSegment = z.infer<typeof OfferSegmentSchema>
export const OfferAudienceSegmentSchema = z.enum(['any', 'new', 'existing', 'lapsed_amc'])
export type OfferAudienceSegment = z.infer<typeof OfferAudienceSegmentSchema>

/**
 * Segments of a buyer: new = never paid us; existing = has a live licence / paid subscription;
 * lapsed_amc = has a licence whose AMC (updates_until) has passed.
 */
export function buyerSegments(input: {
  ever_paid: boolean
  has_active: boolean
  amc_lapsed: boolean
}): OfferSegment[] {
  const out: OfferSegment[] = []
  if (!input.ever_paid) out.push('new')
  if (input.has_active) out.push('existing')
  if (input.amc_lapsed) out.push('lapsed_amc')
  return out
}

/** offers.audience — empty lists mean "everyone". */
export const OfferAudienceSchema = z.object({
  business_types: z.array(BusinessTypeSchema).max(20).default([]),
  state_codes: z.array(zStateCode).max(40).default([]),
  /** District names (case-insensitive, e.g. 'Madurai'). */
  districts: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  segment: OfferAudienceSegmentSchema.default('any'),
  /** Minimum order value excl. GST after the partner discount. */
  min_order_paise: zPaise.nullable().default(null),
})
export type OfferAudience = z.output<typeof OfferAudienceSchema>

/** announcements.audience — empty lists mean "everyone". */
export const AnnouncementAudienceSchema = z.object({
  channels: z
    .array(z.enum(['cloud', 'onprem']))
    .max(2)
    .default([]),
  business_types: z.array(BusinessTypeSchema).max(20).default([]),
  /** Cloud plan codes and/or on-prem edition plan codes (onprem_standard …). */
  plan_codes: z.array(zPlanCode).max(20).default([]),
  state_codes: z.array(zStateCode).max(40).default([]),
  /** Inclusive version bounds (on-prem installs; targets without a version never match). */
  min_version: zSemver.nullable().default(null),
  max_version: zSemver.nullable().default(null),
  /** On-prem AMC state ('active' includes ending soon); cloud targets only match 'any'. */
  amc: z.enum(['any', 'active', 'expired']).default('any'),
})
export type AnnouncementAudience = z.output<typeof AnnouncementAudienceSchema>

/** Who is looking: a cloud tenant (platform GET /announcements) or an on-prem install (check-in). */
export interface AudienceTarget {
  channel: 'cloud' | 'onprem'
  business_type?: BusinessType | null
  state_code?: string | null
  district?: string | null
  plan_code?: string | null
  /** Running app version (both channels know theirs). */
  version?: string | null
  amc?: AmcState | null
  segments?: readonly OfferSegment[]
  /** Partner of the licensee (partner-exclusive offers). */
  partner_id?: string | null
}

/** is_active and starts_at ≤ now < ends_at (null bounds are open). */
export function isScheduleActive(
  item: { is_active?: boolean; starts_at?: Instant | null; ends_at?: Instant | null },
  now: Instant,
): boolean {
  if (item.is_active === false) return false
  const t = instantMs(now)
  if (item.starts_at != null && instantMs(item.starts_at) > t) return false
  if (item.ends_at != null && instantMs(item.ends_at) <= t) return false
  return true
}

/** Whether an announcement audience includes the target. */
export function announcementAudienceMatches(
  audience: z.input<typeof AnnouncementAudienceSchema> | null | undefined,
  target: AudienceTarget,
): boolean {
  const parsed = AnnouncementAudienceSchema.safeParse(audience ?? {})
  if (!parsed.success) return false
  const a = parsed.data
  const inList = <T>(list: readonly T[], v: T | null | undefined) =>
    list.length === 0 || (v != null && list.includes(v))
  if (!inList(a.channels, target.channel)) return false
  if (!inList(a.business_types, target.business_type)) return false
  if (!inList(a.plan_codes, target.plan_code)) return false
  if (!inList(a.state_codes, target.state_code)) return false
  if (a.min_version || a.max_version) {
    if (!target.version || !isSemver(target.version)) return false
    if (a.min_version && compareSemver(target.version, a.min_version) < 0) return false
    if (a.max_version && compareSemver(target.version, a.max_version) > 0) return false
  }
  if (a.amc !== 'any') {
    if (!target.amc) return false
    const active = target.amc !== 'expired'
    if ((a.amc === 'active') !== active) return false
  }
  return true
}

export const OFFER_REJECT_REASONS = [
  'unknown_code',
  'inactive',
  'not_started',
  'ended',
  'channel',
  'partner_only',
  'redemptions_exhausted',
  'customer_limit',
  'business_type',
  'state',
  'district',
  'segment',
  'min_order',
  'not_applicable',
  'better_offer_applied',
] as const
export const OfferRejectReasonSchema = z.enum(OFFER_REJECT_REASONS)
export type OfferRejectReason = z.infer<typeof OfferRejectReasonSchema>

export const OFFER_REJECT_REASON_LABELS: Readonly<Record<OfferRejectReason, BilingualLabel>> = {
  unknown_code: { en: 'This coupon code does not exist.', ta: 'இந்தக் கூப்பன் குறியீடு இல்லை.' },
  inactive: { en: 'This offer is not active.', ta: 'இந்தச் சலுகை செயலில் இல்லை.' },
  not_started: { en: 'This offer has not started yet.', ta: 'இந்தச் சலுகை இன்னும் தொடங்கவில்லை.' },
  ended: { en: 'This offer has ended.', ta: 'இந்தச் சலுகை முடிந்துவிட்டது.' },
  channel: {
    en: 'This offer is not valid for this product.',
    ta: 'இந்தப் பொருளுக்கு இந்தச் சலுகை பொருந்தாது.',
  },
  partner_only: {
    en: 'This code is only for orders through a partner.',
    ta: 'இந்தக் குறியீடு கூட்டாளர் வழி ஆர்டர்களுக்கு மட்டும்.',
  },
  redemptions_exhausted: {
    en: 'This offer has been fully used.',
    ta: 'இந்தச் சலுகை முழுமையாகப் பயன்படுத்தப்பட்டுவிட்டது.',
  },
  customer_limit: {
    en: 'You have already used this offer.',
    ta: 'இந்தச் சலுகையை ஏற்கனவே பயன்படுத்திவிட்டீர்கள்.',
  },
  business_type: {
    en: 'This offer is for other types of shops.',
    ta: 'இந்தச் சலுகை வேறு வகைக் கடைகளுக்கானது.',
  },
  state: {
    en: 'This offer is not valid in your state.',
    ta: 'உங்கள் மாநிலத்தில் இந்தச் சலுகை இல்லை.',
  },
  district: {
    en: 'This offer is not valid in your district.',
    ta: 'உங்கள் மாவட்டத்தில் இந்தச் சலுகை இல்லை.',
  },
  segment: {
    en: 'This offer is not valid for your account.',
    ta: 'உங்கள் கணக்கிற்கு இந்தச் சலுகை பொருந்தாது.',
  },
  min_order: {
    en: 'The order is below the minimum value for this offer.',
    ta: 'இந்தச் சலுகைக்கான குறைந்தபட்ச தொகையை விட ஆர்டர் குறைவு.',
  },
  not_applicable: {
    en: 'This offer does not apply to the selected items.',
    ta: 'தேர்ந்தெடுத்த பொருட்களுக்கு இந்தச் சலுகை பொருந்தாது.',
  },
  better_offer_applied: {
    en: 'A better offer is already applied.',
    ta: 'சிறந்த சலுகை ஏற்கனவே பயன்படுத்தப்பட்டுள்ளது.',
  },
}

/** What priceOrder / the selectors need from an offers row (OfferSchema output fits). */
export interface PricingOffer {
  id: string
  /** null = automatic campaign; a code = coupon (applies only when entered). */
  code: string | null
  name: string
  name_ta?: string | null
  kind: OfferKind
  /** bp (percent) | paise (flat) | months (free_months) | paise per unit (price_override). */
  value: number
  max_discount_paise?: number | null
  /** license_products codes; empty = every line. */
  applies_to?: readonly string[]
  channel?: DeploymentChannel
  audience?: z.input<typeof OfferAudienceSchema> | null
  starts_at?: Instant | null
  ends_at?: Instant | null
  max_redemptions?: number | null
  per_customer_limit?: number | null
  partner_id?: string | null
  stackable?: boolean
  is_active?: boolean
  /** Redemptions so far (all buyers) — from offer_redemptions. */
  redeemed_count?: number
  /** Redemptions by this buyer (customer or tenant). */
  customer_redeemed_count?: number
}

export interface OfferEligibilityContext {
  now: Instant
  buyer: Pick<
    AudienceTarget,
    'business_type' | 'state_code' | 'district' | 'segments' | 'partner_id'
  > & { channel: 'cloud' | 'onprem' }
  /** Order value excl. GST after the partner discount (min_order); omitted = not checked. */
  order_base_paise?: number
}

/** Why an offer cannot be used by this buyer now (null = eligible). Checks run in this order. */
export function offerIneligibility(
  offer: PricingOffer,
  ctx: OfferEligibilityContext,
): OfferRejectReason | null {
  if (offer.is_active === false) return 'inactive'
  const now = instantMs(ctx.now)
  if (offer.starts_at != null && instantMs(offer.starts_at) > now) return 'not_started'
  if (offer.ends_at != null && instantMs(offer.ends_at) <= now) return 'ended'
  const channel = offer.channel ?? 'both'
  if (channel !== 'both' && channel !== ctx.buyer.channel) return 'channel'
  if (offer.partner_id != null && offer.partner_id !== (ctx.buyer.partner_id ?? null))
    return 'partner_only'
  if (offer.max_redemptions != null && (offer.redeemed_count ?? 0) >= offer.max_redemptions)
    return 'redemptions_exhausted'
  if (
    offer.per_customer_limit != null &&
    (offer.customer_redeemed_count ?? 0) >= offer.per_customer_limit
  )
    return 'customer_limit'
  const parsed = OfferAudienceSchema.safeParse(offer.audience ?? {})
  // A malformed stored audience never matches (fail closed, never crash a check-in).
  if (!parsed.success) return 'not_applicable'
  const a = parsed.data
  const b = ctx.buyer
  if (a.business_types.length && (!b.business_type || !a.business_types.includes(b.business_type)))
    return 'business_type'
  if (a.state_codes.length && (!b.state_code || !a.state_codes.includes(b.state_code)))
    return 'state'
  if (a.districts.length) {
    const d = b.district?.trim().toLowerCase()
    if (!d || !a.districts.some((x) => x.toLowerCase() === d)) return 'district'
  }
  if (a.segment !== 'any' && !(b.segments ?? []).includes(a.segment)) return 'segment'
  if (
    a.min_order_paise !== null &&
    ctx.order_base_paise !== undefined &&
    ctx.order_base_paise < a.min_order_paise
  )
    return 'min_order'
  return null
}

/** In-app banner content stored in offers.banner. */
export const OfferBannerSchema = z.object({
  title_en: z.string().trim().min(1).max(120),
  title_ta: z.string().trim().max(160).nullable().default(null),
  body_en: z.string().trim().max(300).nullable().default(null),
  body_ta: z.string().trim().max(400).nullable().default(null),
  cta_en: z.string().trim().max(40).nullable().default(null),
  cta_ta: z.string().trim().max(60).nullable().default(null),
})
export type OfferBanner = z.output<typeof OfferBannerSchema>

export const BannerCtaActionSchema = z.enum(['url', 'billing', 'renewal'])
export type BannerCtaAction = z.infer<typeof BannerCtaActionSchema>

/**
 * One banner of the app-wide announcement strip — cloud: GET /announcements (platform);
 * on-prem: vendor state from the last check-in (onprem). Offer banners link to billing (cloud)
 * or the renewal screen (on-prem).
 */
export const BannerSchema = z.object({
  /** announcements.id or offers.id (dismiss with this id). */
  id: zId,
  source: z.enum(['announcement', 'offer']),
  severity: AnnouncementSeveritySchema,
  title_en: z.string(),
  title_ta: z.string().nullable(),
  body_en: z.string().nullable(),
  body_ta: z.string().nullable(),
  cta_label_en: z.string().nullable(),
  cta_label_ta: z.string().nullable(),
  cta_url: z.string().nullable(),
  cta_action: BannerCtaActionSchema.nullable(),
  offer_id: zId.nullable(),
  offer_code: z.string().nullable(),
  starts_at: zTimestamp.nullable(),
  ends_at: zTimestamp.nullable(),
  /** Critical banners cannot be dismissed. */
  dismissible: z.boolean(),
})
export type Banner = z.output<typeof BannerSchema>

export interface AnnouncementLike {
  id: string
  severity: AnnouncementSeverity
  title_en: string
  title_ta?: string | null
  body_en: string
  body_ta?: string | null
  cta_label_en?: string | null
  cta_label_ta?: string | null
  cta_url?: string | null
  offer_id?: string | null
  audience?: z.input<typeof AnnouncementAudienceSchema> | null
  starts_at?: Instant | null
  ends_at?: Instant | null
  is_active?: boolean
}

export type BannerOfferLike = PricingOffer & { banner?: z.input<typeof OfferBannerSchema> | null }

const SEVERITY_RANK: Readonly<Record<AnnouncementSeverity, number>> = {
  critical: 0,
  warning: 1,
  offer: 2,
  info: 3,
}

function isoOrNull(v: Instant | null | undefined): string | null {
  if (v == null) return null
  return v instanceof Date ? v.toISOString() : v
}

/**
 * THE banner selector (cloud GET /announcements and on-prem check-ins): active announcements
 * whose audience matches, plus banners of offers the target may use (coupon or automatic; never
 * partner-exclusive or exhausted ones), minus dismissed ids. An announcement linked to an offer
 * replaces that offer's own banner. Sorted critical → warning → offer → info, newest first.
 */
export function selectBanners(input: {
  announcements: readonly AnnouncementLike[]
  offers?: readonly BannerOfferLike[]
  target: AudienceTarget
  now: Instant
  dismissed_ids?: readonly string[]
}): Banner[] {
  const dismissed = new Set(input.dismissed_ids ?? [])
  const offerAction: BannerCtaAction = input.target.channel === 'cloud' ? 'billing' : 'renewal'
  const offersById = new Map((input.offers ?? []).map((o) => [o.id, o]))
  const out: Banner[] = []
  const linkedOffers = new Set<string>()
  for (const a of input.announcements) {
    if (dismissed.has(a.id) || !isScheduleActive(a, input.now)) continue
    if (!announcementAudienceMatches(a.audience, input.target)) continue
    const offer = a.offer_id ? offersById.get(a.offer_id) : undefined
    if (a.offer_id) linkedOffers.add(a.offer_id)
    out.push({
      id: a.id,
      source: 'announcement',
      severity: a.severity,
      title_en: a.title_en,
      title_ta: a.title_ta ?? null,
      body_en: a.body_en,
      body_ta: a.body_ta ?? null,
      cta_label_en: a.cta_label_en ?? null,
      cta_label_ta: a.cta_label_ta ?? null,
      cta_url: a.cta_url ?? null,
      cta_action: a.cta_url ? 'url' : a.offer_id ? offerAction : null,
      offer_id: a.offer_id ?? null,
      offer_code: offer?.code ?? null,
      starts_at: isoOrNull(a.starts_at),
      ends_at: isoOrNull(a.ends_at),
      dismissible: a.severity !== 'critical',
    })
  }
  for (const o of input.offers ?? []) {
    if (!o.banner || linkedOffers.has(o.id) || dismissed.has(o.id) || o.partner_id != null) continue
    const reason = offerIneligibility(
      { ...o, customer_redeemed_count: 0 },
      { now: input.now, buyer: { ...input.target, channel: input.target.channel } },
    )
    if (reason) continue
    const banner = OfferBannerSchema.safeParse(o.banner)
    if (!banner.success) continue
    const b = banner.data
    out.push({
      id: o.id,
      source: 'offer',
      severity: 'offer',
      title_en: b.title_en,
      title_ta: b.title_ta,
      body_en: b.body_en,
      body_ta: b.body_ta,
      cta_label_en: b.cta_en,
      cta_label_ta: b.cta_ta,
      cta_url: null,
      cta_action: offerAction,
      offer_id: o.id,
      offer_code: o.code,
      starts_at: isoOrNull(o.starts_at),
      ends_at: isoOrNull(o.ends_at),
      dismissible: true,
    })
  }
  return out.sort((x, y) => {
    const s = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]
    if (s !== 0) return s
    const tx = x.starts_at ? Date.parse(x.starts_at) : 0
    const ty = y.starts_at ? Date.parse(y.starts_at) : 0
    if (tx !== ty) return ty - tx
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  })
}

// =============================================================================================
// priceOrder — the vendor pricing helper
// =============================================================================================

/** One thing being bought, priced from the price book (or a cloud plan) by the caller. */
export interface PriceOrderLineInput {
  /** Stable line key (default: '1', '2', …). */
  key?: string
  product_code: string
  kind: LicenseProductKind
  name?: string
  name_ta?: string | null
  qty: number
  /** List price excl. GST of one unit for one term (license_products.price_paise / upgrade diff). */
  unit_price_paise: number
  gst_rate_bp: number
  /** Months bought per unit (subscription / AMC / term add-on / cloud plan); null = perpetual. */
  term_months: number | null
  /** Editions: months of AMC included (free months extend it). */
  included_amc_months?: number
  /** Editions: yearly AMC price (values free AMC months when comparing offers). */
  renewal_price_paise?: number | null
}

export interface PricingBuyer {
  channel: 'onprem' | 'cloud'
  /** Place of supply: the buyer's GST state (GSTIN state for registered buyers). */
  state_code: string
  business_type?: BusinessType | null
  district?: string | null
  segments?: readonly OfferSegment[]
  /** Set for partner-placed orders and for licensees of a partner (partner-exclusive codes). */
  partner_id?: string | null
}

export interface PriceOrderInput {
  lines: readonly PriceOrderLineInput[]
  /** Automatic campaigns to consider (rows with a code are ignored here: they need `coupon`). */
  offers?: readonly PricingOffer[]
  /** The offer matching the entered coupon code (null when the code is unknown). */
  coupon?: PricingOffer | null
  /** The code as entered — reported back in `coupon`. */
  coupon_code?: string | null
  buyer: PricingBuyer
  /** KADAI_VENDOR_STATE_CODE. */
  vendor_state_code: string
  /** Partner buy-price discount off list (partner-placed orders only), applied first. */
  partner_discount_bp?: number
  now: Instant
}

export const PricedOrderLineSchema = z.object({
  key: z.string(),
  product_code: z.string(),
  kind: LicenseProductKindSchema,
  name: z.string(),
  name_ta: z.string().nullable(),
  qty: z.int().min(1),
  unit_price_paise: zPaise,
  term_months: z.int().min(1).nullable(),
  /** Extra months granted by free_months offers (term extension or extra included AMC). */
  free_months: z.int().min(0),
  /** qty × unit_price. */
  gross_paise: zPaise,
  partner_discount_paise: zPaise,
  offer_discount_paise: zPaise,
  discount_paise: zPaise,
  taxable_paise: zPaise,
  gst_rate_bp: z.int().min(0),
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  tax_paise: zPaise,
  total_paise: zPaise,
  offer_ids: z.array(zId),
  sac: z.string(),
})
export type PricedOrderLine = z.output<typeof PricedOrderLineSchema>

export const AppliedOfferSchema = z.object({
  offer_id: zId,
  code: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  kind: OfferKindSchema,
  value: z.int().min(0),
  discount_paise: zPaise,
  free_months: z.int().min(0),
  line_keys: z.array(z.string()),
})
export type AppliedOffer = z.output<typeof AppliedOfferSchema>

export const CouponResultSchema = z.object({
  code: z.string(),
  status: z.enum(['applied', 'invalid', 'not_eligible', 'not_better']),
  reason: OfferRejectReasonSchema.nullable(),
})
export type CouponResult = z.output<typeof CouponResultSchema>

/** Result of priceOrder() — also the stored order totals (vendor_orders) and every quote. */
export const PriceQuoteSchema = z.object({
  lines: z.array(PricedOrderLineSchema),
  subtotal_paise: zPaise,
  partner_discount_paise: zPaise,
  offer_discount_paise: zPaise,
  /** partner + offer discount (vendor_orders.discount_paise). */
  discount_paise: zPaise,
  taxable_paise: zPaise,
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  tax_paise: zPaise,
  /** taxable + cgst + sgst + igst (vendor_orders CHECK; no round-off). */
  total_paise: zPaise,
  place_of_supply: z.string(),
  is_interstate: z.boolean(),
  /** Largest free_months of any line (banner copy: "6 months AMC free"). */
  free_months: z.int().min(0),
  applied_offers: z.array(AppliedOfferSchema),
  offer_ids: z.array(zId),
  coupon: CouponResultSchema.nullable(),
})
export type PriceQuote = z.output<typeof PriceQuoteSchema>

const KIND_ORDER: Readonly<Record<OfferKind, number>> = {
  price_override: 0,
  percent: 1,
  flat: 2,
  free_months: 3,
}

interface WorkLine {
  key: string
  input: PriceOrderLineInput
  gross: number
  partner: number
  base: number
}

interface OfferEffect {
  discounts: number[]
  free: number[]
}

function hasTimeComponent(l: PriceOrderLineInput): boolean {
  return (l.term_months ?? 0) > 0 || (l.kind === 'edition' && (l.included_amc_months ?? 0) > 0)
}

function applyOfferToLines(
  offer: PricingOffer,
  lines: readonly WorkLine[],
  amounts: readonly number[],
): OfferEffect {
  const codes = offer.applies_to ?? []
  const idx = lines.flatMap((l, i) =>
    codes.length === 0 || codes.includes(l.input.product_code) ? [i] : [],
  )
  const discounts = amounts.map(() => 0)
  const free = amounts.map(() => 0)
  const cap = offer.max_discount_paise ?? null
  const capped = (t: number) => (cap === null ? t : Math.min(t, Math.max(0, cap)))
  const spread = (total: number, weights: number[]) => {
    const parts = allocateProRata(total, weights)
    idx.forEach((i, j) => (discounts[i] = parts[j] ?? 0))
  }
  const value = Math.max(0, offer.value)
  switch (offer.kind) {
    case 'percent': {
      const weights = idx.map((i) => amounts[i]!)
      spread(capped(mulDiv(sumSafe(weights), Math.min(value, 10_000), 10_000)), weights)
      break
    }
    case 'flat': {
      const weights = idx.map((i) => amounts[i]!)
      spread(capped(Math.min(value, sumSafe(weights))), weights)
      break
    }
    case 'price_override': {
      const weights = idx.map((i) => {
        const target = value * lines[i]!.input.qty
        if (!Number.isSafeInteger(target)) throw new RangeError('price_override overflow')
        return Math.max(0, amounts[i]! - target)
      })
      spread(capped(sumSafe(weights)), weights)
      break
    }
    case 'free_months': {
      for (const i of idx) if (hasTimeComponent(lines[i]!.input)) free[i] = value
      break
    }
  }
  return { discounts, free }
}

function freeMonthsValue(lines: readonly WorkLine[], free: readonly number[]): number {
  let total = 0
  lines.forEach((l, i) => {
    const months = free[i] ?? 0
    if (months <= 0) return
    const term = l.input.term_months ?? 0
    total +=
      term > 0
        ? mulDiv(l.base, months, term)
        : mulDiv((l.input.renewal_price_paise ?? 0) * l.input.qty, months, 12)
  })
  return total
}

interface PricedOption {
  offers: PricingOffer[]
  applied: AppliedOffer[]
  discounts: number[]
  free: number[]
  value: number
  includesCoupon: boolean
}

function evaluateOption(
  offers: readonly PricingOffer[],
  lines: readonly WorkLine[],
  couponId: string | null,
): PricedOption {
  const amounts = lines.map((l) => l.base)
  const discounts = lines.map(() => 0)
  const free = lines.map(() => 0)
  const applied: AppliedOffer[] = []
  const used: PricingOffer[] = []
  for (const o of offers) {
    const eff = applyOfferToLines(o, lines, amounts)
    const d = sumSafe(eff.discounts)
    const fm = Math.max(0, ...eff.free)
    if (d === 0 && fm === 0) continue
    eff.discounts.forEach((x, i) => {
      discounts[i]! += x
      amounts[i]! -= x
    })
    eff.free.forEach((x, i) => (free[i]! += x))
    used.push(o)
    applied.push({
      offer_id: o.id,
      code: o.code,
      name: o.name,
      name_ta: o.name_ta ?? null,
      kind: o.kind,
      value: o.value,
      discount_paise: d,
      free_months: fm,
      line_keys: lines.flatMap((l, i) =>
        (eff.discounts[i] ?? 0) > 0 || (eff.free[i] ?? 0) > 0 ? [l.key] : [],
      ),
    })
  }
  return {
    offers: used,
    applied,
    discounts,
    free,
    value: sumSafe(discounts) + freeMonthsValue(lines, free),
    includesCoupon: couponId !== null && used.some((o) => o.id === couponId),
  }
}

function betterOption(a: PricedOption, b: PricedOption): PricedOption {
  if (a.value !== b.value) return a.value > b.value ? a : b
  if (a.includesCoupon !== b.includesCoupon) return a.includesCoupon ? a : b
  if (a.offers.length !== b.offers.length) return a.offers.length < b.offers.length ? a : b
  const ka = a.offers.map((o) => o.id).join(',')
  const kb = b.offers.map((o) => o.id).join(',')
  return ka <= kb ? a : b
}

/**
 * Prices an order of anything we sell (editions, yearly licences, AMC, add-ons, services,
 * prepaid / monthly cloud plans):
 *
 * 1. gross = qty × unit_price per line; the partner discount (partner_discount_bp, partner-placed
 *    orders) comes off first, per line.
 * 2. Offers: eligible automatic campaigns (code null) plus the coupon (offerIneligibility:
 *    schedule, channel, partner-exclusive, redemption limits, audience, min order).
 *    - percent: value bp of the applicable lines (max_discount_paise caps the offer);
 *    - flat: value paise off the applicable lines (capped by their amount and max_discount);
 *    - price_override: unit price becomes `value` where that is lower (capped by max_discount);
 *    - free_months: `value` extra months on lines with a term (or an edition's included AMC).
 *    applies_to limits an offer to product codes (empty = all lines). Discounts are spread over
 *    lines pro-rata (allocateProRata), never exceeding a line.
 *    Non-stackable offers apply alone; all stackable offers apply together (price_override →
 *    percent → flat → free_months). The option giving the buyer the most value wins
 *    (discount + free months valued at the line's monthly price; ties: the one using the entered
 *    coupon, then fewer offers, then offer id) — independent of input order.
 * 3. GST per line on the taxable value at the product's rate: CGST + SGST (splitGst) when the
 *    buyer's state equals the vendor's, otherwise IGST. No round-off.
 *
 * @throws RangeError for invalid lines (non-integer qty/price, unknown GST rate, duplicate keys).
 */
export function priceOrder(input: PriceOrderInput): PriceQuote {
  const partnerBp = input.partner_discount_bp ?? 0
  if (!Number.isInteger(partnerBp) || partnerBp < 0 || partnerBp > 10_000)
    throw new RangeError('partner_discount_bp must be 0..10000')
  const keys = new Set<string>()
  const lines: WorkLine[] = input.lines.map((l, i) => {
    const key = l.key ?? String(i + 1)
    if (keys.has(key)) throw new RangeError(`duplicate line key "${key}"`)
    keys.add(key)
    if (!Number.isInteger(l.qty) || l.qty < 1)
      throw new RangeError('qty must be a positive integer')
    assertNonNegativeInt(l.unit_price_paise, 'unit_price_paise')
    if (!isValidGstRate(l.gst_rate_bp)) throw new RangeError(`invalid GST rate ${l.gst_rate_bp}`)
    if (l.term_months !== null && (!Number.isInteger(l.term_months) || l.term_months < 1))
      throw new RangeError('term_months must be a positive integer or null')
    const gross = l.qty * l.unit_price_paise
    if (!Number.isSafeInteger(gross)) throw new RangeError('line amount overflow')
    const partner = applyBp(gross, partnerBp)
    return { key, input: l, gross, partner, base: gross - partner }
  })
  const baseTotal = sumSafe(lines.map((l) => l.base))
  const ctx: OfferEligibilityContext = {
    now: input.now,
    buyer: input.buyer,
    order_base_paise: baseTotal,
  }

  const byId = (a: PricingOffer, b: PricingOffer) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const candidates: PricingOffer[] = []
  const seen = new Set<string>()
  for (const o of [...(input.offers ?? [])].sort(byId)) {
    if (o.code != null || seen.has(o.id)) continue
    seen.add(o.id)
    if (offerIneligibility(o, ctx) === null) candidates.push(o)
  }

  const enteredCode = input.coupon_code?.trim() ? input.coupon_code.trim().toUpperCase() : null
  let coupon: CouponResult | null = null
  let couponOffer: PricingOffer | null = null
  if (enteredCode !== null || input.coupon) {
    const code = enteredCode ?? input.coupon?.code?.toUpperCase() ?? ''
    if (!input.coupon) {
      coupon = { code, status: 'invalid', reason: 'unknown_code' }
    } else {
      const reason = offerIneligibility(input.coupon, ctx)
      if (reason) {
        coupon = { code, status: 'not_eligible', reason }
      } else {
        couponOffer = input.coupon
        coupon = { code, status: 'applied', reason: null }
        if (!seen.has(couponOffer.id)) candidates.push(couponOffer)
      }
    }
  }

  const couponId = couponOffer?.id ?? null
  const options: PricedOption[] = []
  const stackable = candidates
    .filter((o) => o.stackable === true)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byId(a, b))
  for (const o of candidates.filter((x) => x.stackable !== true).sort(byId))
    options.push(evaluateOption([o], lines, couponId))
  if (stackable.length) options.push(evaluateOption(stackable, lines, couponId))
  const viable = options.filter((o) => o.value > 0)
  const best = viable.length ? viable.reduce(betterOption) : null

  if (coupon && couponOffer) {
    if (!best || !best.includesCoupon) {
      const alone = evaluateOption([couponOffer], lines, couponId)
      coupon =
        alone.value === 0
          ? { ...coupon, status: 'not_eligible', reason: 'not_applicable' }
          : { ...coupon, status: 'not_better', reason: 'better_offer_applied' }
    }
  }

  const discounts = best?.discounts ?? lines.map(() => 0)
  const free = best?.free ?? lines.map(() => 0)
  const interstate = input.buyer.state_code !== input.vendor_state_code
  const priced: PricedOrderLine[] = lines.map((l, i) => {
    const offerDisc = discounts[i] ?? 0
    const taxable = l.base - offerDisc
    const tax = mulDiv(taxable, l.input.gst_rate_bp, 10_000)
    const split = interstate ? { cgst_paise: 0, sgst_paise: 0 } : splitGst(tax)
    const igst = interstate ? tax : 0
    return {
      key: l.key,
      product_code: l.input.product_code,
      kind: l.input.kind,
      name: l.input.name ?? l.input.product_code,
      name_ta: l.input.name_ta ?? null,
      qty: l.input.qty,
      unit_price_paise: l.input.unit_price_paise,
      term_months: l.input.term_months,
      free_months: free[i] ?? 0,
      gross_paise: l.gross,
      partner_discount_paise: l.partner,
      offer_discount_paise: offerDisc,
      discount_paise: l.partner + offerDisc,
      taxable_paise: taxable,
      gst_rate_bp: l.input.gst_rate_bp,
      cgst_paise: split.cgst_paise,
      sgst_paise: split.sgst_paise,
      igst_paise: igst,
      tax_paise: tax,
      total_paise: taxable + tax,
      offer_ids: (best?.applied ?? [])
        .filter((a) => a.line_keys.includes(l.key))
        .map((a) => a.offer_id),
      sac: SAC_SOFTWARE,
    }
  })
  const sum = (f: (l: PricedOrderLine) => number) => sumSafe(priced.map(f))
  const taxable = sum((l) => l.taxable_paise)
  const cgst = sum((l) => l.cgst_paise)
  const sgst = sum((l) => l.sgst_paise)
  const igst = sum((l) => l.igst_paise)
  const partnerTotal = sum((l) => l.partner_discount_paise)
  const offerTotal = sum((l) => l.offer_discount_paise)
  const applied = best?.applied ?? []
  return {
    lines: priced,
    subtotal_paise: sum((l) => l.gross_paise),
    partner_discount_paise: partnerTotal,
    offer_discount_paise: offerTotal,
    discount_paise: partnerTotal + offerTotal,
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    tax_paise: cgst + sgst + igst,
    total_paise: taxable + cgst + sgst + igst,
    place_of_supply: input.buyer.state_code,
    is_interstate: interstate,
    free_months: Math.max(0, ...priced.map((l) => l.free_months)),
    applied_offers: applied,
    offer_ids: applied.map((a) => a.offer_id),
    coupon,
  }
}

/** Price incl. GST of a list price (pricing pages): price + round(price × rate). */
export function priceWithGst(pricePaise: number, gstRateBp: number = VENDOR_GST_RATE_BP): number {
  assertNonNegativeInt(pricePaise, 'pricePaise')
  return pricePaise + mulDiv(pricePaise, gstRateBp, 10_000)
}

// =============================================================================================
// GST invoice numbers, commissions, status machines
// =============================================================================================

/** Financial year label of an invoice date ('2026-27'). */
export function vendorInvoiceFy(invoiceDate: string): string {
  return fyOf(invoiceDate)
}

/**
 * system_settings key of the gapless vendor invoice counter for a financial year. Both the
 * platform (cloud plans) and licensing modules assign numbers through it: lock the row
 * (SELECT … FOR UPDATE; insert {value: 0} when missing), increment, store — inside the
 * transaction that marks the order paid.
 */
export function vendorInvoiceCounterKey(fy: string): string {
  return `vendor_invoice_seq:${fy}`
}

/** 'KD/2627/000123' (≤ 16 characters, GST rule). */
export function formatVendorInvoiceNumber(fy: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError('seq must be a positive integer')
  return `KD/${fyShort(fy)}/${String(seq).padStart(6, '0')}`
}
export const VENDOR_INVOICE_NUMBER_RE = /^KD\/\d{4}\/\d{6,8}$/

/**
 * Commission on a paid order: commission_bp of the taxable value for direct sales the partner
 * referred (the licensee's partner, order not placed by the partner). Partner-placed orders earn
 * through the partner price instead → 0.
 */
export function partnerCommissionPaise(input: {
  taxable_paise: number
  commission_bp: number
  partner_placed: boolean
}): number {
  if (input.partner_placed) return 0
  return applyBp(input.taxable_paise, input.commission_bp)
}

export const VENDOR_ORDER_TRANSITIONS: Readonly<
  Record<VendorOrderStatus, readonly VendorOrderStatus[]>
> = {
  draft: ['pending_payment', 'cancelled'],
  pending_payment: ['paid', 'cancelled', 'draft'],
  paid: ['fulfilled', 'refunded'],
  fulfilled: ['refunded'],
  cancelled: [],
  refunded: [],
}

export function canTransitionOrder(from: VendorOrderStatus, to: VendorOrderStatus): boolean {
  return VENDOR_ORDER_TRANSITIONS[from].includes(to)
}

/** Commission lifecycle; a refund voids accrued/approved (and claws back paid) commissions. */
export const COMMISSION_TRANSITIONS: Readonly<
  Record<CommissionStatus, readonly CommissionStatus[]>
> = {
  accrued: ['approved', 'void'],
  approved: ['paid', 'void'],
  paid: ['void'],
  void: [],
}

export function canTransitionCommission(from: CommissionStatus, to: CommissionStatus): boolean {
  return COMMISSION_TRANSITIONS[from].includes(to)
}

// =============================================================================================
// Platform staff: capabilities & roles
// =============================================================================================

export const VENDOR_CAPABILITIES = [
  'vendor.dashboard',
  'vendor.customers.read',
  'vendor.customers.write',
  'vendor.licenses.read',
  /** Issue / renew / upgrade / add add-ons (partners: for their own customers). */
  'vendor.licenses.issue',
  /** Suspend / resume / revoke / re-issue key. */
  'vendor.licenses.manage',
  /** Deactivate / transfer / block activations, offline activation, licence file download. */
  'vendor.activations.manage',
  'vendor.products.read',
  'vendor.products.write',
  'vendor.offers.read',
  'vendor.offers.write',
  'vendor.orders.read',
  'vendor.orders.write',
  /** Manual payments, refunds, cancellation, price overrides. */
  'vendor.orders.payments',
  'vendor.partners.read',
  'vendor.partners.write',
  'vendor.commissions.read',
  'vendor.commissions.manage',
  'vendor.releases.read',
  'vendor.releases.write',
  'vendor.announcements.read',
  'vendor.announcements.write',
  'vendor.tenants.read',
  'vendor.tenants.manage',
  'vendor.plans.write',
  'vendor.staff.manage',
  'vendor.audit.read',
] as const
export const VendorCapabilitySchema = z.enum(VENDOR_CAPABILITIES)
export type VendorCapability = z.infer<typeof VendorCapabilitySchema>

/**
 * Capabilities per staff role (owner/admin full; sales: customers, licences, orders, offers;
 * support: customers, activations, releases (read), announcements; finance: orders, invoices,
 * commissions; partner: own customers / licences / orders / commissions at partner pricing).
 * Only an owner may grant or change the owner and admin roles.
 */
export const STAFF_ROLE_CAPABILITIES: Readonly<
  Record<PlatformStaffRole, readonly VendorCapability[]>
> = {
  owner: VENDOR_CAPABILITIES,
  admin: VENDOR_CAPABILITIES,
  sales: [
    'vendor.dashboard',
    'vendor.customers.read',
    'vendor.customers.write',
    'vendor.licenses.read',
    'vendor.licenses.issue',
    'vendor.products.read',
    'vendor.offers.read',
    'vendor.offers.write',
    'vendor.orders.read',
    'vendor.orders.write',
    'vendor.partners.read',
    'vendor.releases.read',
    'vendor.announcements.read',
    'vendor.tenants.read',
  ],
  support: [
    'vendor.dashboard',
    'vendor.customers.read',
    'vendor.customers.write',
    'vendor.licenses.read',
    'vendor.activations.manage',
    'vendor.products.read',
    'vendor.orders.read',
    'vendor.releases.read',
    'vendor.announcements.read',
    'vendor.announcements.write',
    'vendor.tenants.read',
  ],
  finance: [
    'vendor.dashboard',
    'vendor.customers.read',
    'vendor.licenses.read',
    'vendor.products.read',
    'vendor.offers.read',
    'vendor.orders.read',
    'vendor.orders.payments',
    'vendor.partners.read',
    'vendor.commissions.read',
    'vendor.commissions.manage',
    'vendor.tenants.read',
  ],
  partner: [
    'vendor.customers.read',
    'vendor.customers.write',
    'vendor.licenses.read',
    'vendor.licenses.issue',
    'vendor.activations.manage',
    'vendor.products.read',
    'vendor.offers.read',
    'vendor.orders.read',
    'vendor.orders.write',
    'vendor.partners.read',
    'vendor.commissions.read',
    'vendor.releases.read',
  ],
}

export function vendorCapabilitiesFor(role: PlatformStaffRole): readonly VendorCapability[] {
  return STAFF_ROLE_CAPABILITIES[role]
}

export function vendorCan(role: PlatformStaffRole, capability: VendorCapability): boolean {
  return STAFF_ROLE_CAPABILITIES[role].includes(capability)
}

/** Roles only an owner may assign or modify. */
export const OWNER_MANAGED_ROLES: readonly PlatformStaffRole[] = ['owner', 'admin']

/**
 * A vendor-console route: RouteDef + the staff capability it needs. Register it with
 * `config: { auth: 'user' }` (tenant-less tokens), mode cloud, 404 unless KADAI_VENDOR_CONSOLE,
 * and the staff guard (platform_staff active + capability; partner users scoped to their
 * partner_id). Every mutation writes platform_audit_logs.
 */
export interface VendorRouteDef extends RouteDef {
  /** capability null = any active staff member (e.g. GET /platform/me). */
  vendor: { capability: VendorCapability | null }
}

export function defineVendorRoutes<const T extends Record<string, VendorRouteDef>>(routes: T): T {
  return routes
}

/** How a public licensing route authenticates. */
export const LicensingPublicAuthSchema = z.enum([
  /** Nothing beyond the rate limit (OTP request / verify). */
  'none',
  /** The licence key in the body (online & public offline activation). */
  'license_key',
  /** X-Kadai-Installation / Timestamp / Signature (installationSignaturePayload). */
  'installation',
  /** X-Kadai-Connect-Token from POST /connect/otp/verify. */
  'connect_token',
])
export type LicensingPublicAuth = z.infer<typeof LicensingPublicAuthSchema>

/** A public licensing route: RouteDef + authentication and rate limit (enforce both). */
export interface LicensingPublicRouteDef extends RouteDef {
  licensing: {
    authn: LicensingPublicAuth
    rate_limit: { max: number; window_seconds: number; per: 'ip' | 'installation' | 'phone' }
  }
}

export function defineLicensingPublicRoutes<
  const T extends Record<string, LicensingPublicRouteDef>,
>(routes: T): T {
  return routes
}

// =============================================================================================
// Shared small schemas
// =============================================================================================

const notEmpty = (v: Record<string, unknown>) =>
  Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at')

const zReason = z.string().trim().min(3, 'reason_required').max(500)

const CodeParams = z.object({ code: zProductCode })
const PlanCodeParams = z.object({ code: zPlanCode })

/** Name + id of a related row. */
const RefSchema = z.object({ id: zId, name: z.string() })

/** Vendor's public identity and support contacts (activation response, check-in, invoices). */
export const VendorPublicInfoSchema = z.object({
  name: z.string(),
  legal_name: z.string().nullable(),
  gstin: z.string().nullable(),
  state_code: z.string(),
  website: z.string(),
  support_phone: z.string().nullable(),
  support_whatsapp: z.string().nullable(),
  support_email: z.string().nullable(),
  support_hours_en: z.string().nullable(),
  support_hours_ta: z.string().nullable(),
  /** Public offline-activation page (kadai.app/activate). */
  activation_url: z.string(),
  /** Kadai Connect owner page (kadai.app/connect). */
  connect_url: z.string(),
})
export type VendorPublicInfo = z.output<typeof VendorPublicInfoSchema>

/** Counts an installation reports (license_activations.last_stats) — never shop data. */
export const InstallationStatsSchema = z.object({
  stores: z.int().min(0),
  registers: z.int().min(0),
  users: z.int().min(0),
  products: z.int().min(0),
  customers: z.int().min(0).optional(),
  invoices_30d: z.int().min(0),
  db_size_bytes: z.int().min(0).optional(),
})
export type InstallationStats = z.output<typeof InstallationStatsSchema>

const zIfscNullable = z
  .union([z.null(), z.string().trim().toUpperCase()])
  .optional()
  .refine((v) => v == null || v === '' || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), { message: 'ifsc' })
  .transform((v) => (v === '' ? null : v))

/** partners.payout_details — a UPI id or the last 4 digits + IFSC; never full account numbers. */
export const PartnerPayoutSchema = z.object({
  vpa: z.string().trim().max(100).nullable().default(null),
  account_name: z.string().trim().max(120).nullable().default(null),
  account_last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable()
    .default(null),
  ifsc: z.string().nullable().default(null),
})
export type PartnerPayout = z.output<typeof PartnerPayoutSchema>

const PartnerPayoutInputSchema = z.object({
  vpa: zNullableText(100),
  account_name: zNullableText(120),
  account_last4: z.union([z.null(), z.string().regex(/^\d{4}$/)]).optional(),
  ifsc: zIfscNullable,
})

// =============================================================================================
// Staff
// =============================================================================================

export const StaffMemberSchema = z.object({
  user_id: zId,
  full_name: z.string(),
  phone: zE164.nullable(),
  email: z.string().nullable(),
  role: PlatformStaffRoleSchema,
  partner_id: zId.nullable(),
  partner_name: z.string().nullable(),
  is_active: z.boolean(),
  last_login_at: zTimestamp.nullable(),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type StaffMember = z.output<typeof StaffMemberSchema>

/** GET /platform/me — the caller's staff role and capabilities (drives the console nav). */
export const VendorMeSchema = z.object({
  user_id: zId,
  full_name: z.string(),
  role: PlatformStaffRoleSchema,
  partner_id: zId.nullable(),
  partner_name: z.string().nullable(),
  capabilities: z.array(VendorCapabilitySchema),
  vendor_state_code: z.string(),
})
export type VendorMe = z.output<typeof VendorMeSchema>

export const StaffListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Name, phone digits or email'),
  role: PlatformStaffRoleSchema.optional(),
  partner_id: zId.optional(),
  is_active: zBooleanQuery.optional(),
  sort: sortQuery(['full_name', 'created_at', 'last_login_at'] as const).prefault('full_name'),
})
export type StaffListQuery = z.input<typeof StaffListQuerySchema>

/**
 * POST /platform/staff — an existing Kadai user (by phone) gets the role; otherwise a user is
 * created with a temporary password returned once. users.is_platform_admin is kept true for any
 * active staff member.
 */
export const StaffCreateSchema = z
  .object({
    phone: zPhone,
    full_name: z.string().trim().min(1).max(120),
    email: zNullableEmail,
    role: PlatformStaffRoleSchema,
    partner_id: zId.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.role === 'partner' && !v.partner_id)
      ctx.addIssue({ code: 'custom', path: ['partner_id'], message: 'partner_required' })
    if (v.role !== 'partner' && v.partner_id)
      ctx.addIssue({ code: 'custom', path: ['partner_id'], message: 'partner_not_allowed' })
  })
export type StaffCreate = z.input<typeof StaffCreateSchema>

export const StaffCreateResultSchema = z.object({
  staff: StaffMemberSchema,
  existing_user: z.boolean(),
  /** Shown ONCE for a newly created user; never retrievable later. */
  temporary_password: z.string().nullable(),
})
export type StaffCreateResult = z.output<typeof StaffCreateResultSchema>

/** PATCH /platform/staff/:userId — role (partner ↔ partner_id rule checked on the result). */
export const StaffUpdateSchema = z
  .object({
    role: PlatformStaffRoleSchema.optional(),
    partner_id: zId.nullable().optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type StaffUpdate = z.input<typeof StaffUpdateSchema>

const StaffParams = z.object({ userId: zId })

// =============================================================================================
// Partners & commissions
// =============================================================================================

export const PartnerSchema = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  contact_name: z.string().nullable(),
  phone: zE164.nullable(),
  email: z.string().nullable(),
  gstin: z.string().nullable(),
  state_code: z.string().nullable(),
  district: z.string().nullable(),
  address: AddressSchema,
  tier: PartnerTierSchema,
  discount_bp: z.int().min(0).max(10_000),
  commission_bp: z.int().min(0).max(10_000),
  payout_details: PartnerPayoutSchema,
  status: PartnerStatusSchema,
  notes: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Partner = z.output<typeof PartnerSchema>

export const PartnerRowSchema = PartnerSchema.extend({
  customers_count: z.int().min(0),
  active_licenses: z.int().min(0),
  renewals_due_30d: z.int().min(0),
  users_count: z.int().min(0),
})
export type PartnerRow = z.output<typeof PartnerRowSchema>

export const PartnerStatsSchema = z.object({
  customers: z.int().min(0),
  active_licenses: z.int().min(0),
  renewals_due_30d: z.int().min(0),
  /** Paid order taxable value of the last 12 months (partner-placed + referred). */
  revenue_12m_paise: zPaise,
  commission_accrued_paise: zPaise,
  commission_approved_paise: zPaise,
  commission_paid_paise: zPaise,
})

export const PartnerDetailSchema = PartnerSchema.extend({
  stats: PartnerStatsSchema,
  users: z.array(StaffMemberSchema),
})
export type PartnerDetail = z.output<typeof PartnerDetailSchema>

export const PartnerListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Code, name, phone digits or GSTIN'),
  tier: PartnerTierSchema.optional(),
  status: PartnerStatusSchema.optional(),
  state_code: zStateCode.optional(),
  district: z.string().trim().min(1).max(60).optional(),
  sort: sortQuery(['name', 'code', 'created_at'] as const).prefault('name'),
})
export type PartnerListQuery = z.input<typeof PartnerListQuerySchema>

const PartnerFields = {
  name: z.string().trim().min(1).max(200),
  contact_name: zNullableText(120),
  phone: zNullablePhone,
  email: zNullableEmail,
  gstin: zNullableGstin,
  state_code: zStateCode.nullable().optional(),
  district: zNullableText(60),
  address: AddressSchema.optional(),
  tier: PartnerTierSchema.optional(),
  discount_bp: z.int().min(0).max(10_000).optional(),
  commission_bp: z.int().min(0).max(10_000).optional(),
  payout_details: PartnerPayoutInputSchema.optional(),
  notes: zNullableText(2000),
}

function refineGstinState(
  v: { gstin?: string | null | undefined; state_code?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.gstin && v.state_code && v.gstin.slice(0, 2) !== v.state_code)
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'gstin_state' })
}

/** POST /platform/partners (discount_bp defaults to the tier default). */
export const PartnerCreateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{3,12}$/, 'partner_code'),
    ...PartnerFields,
  })
  .superRefine(refineGstinState)
export type PartnerCreate = z.input<typeof PartnerCreateSchema>

export const PartnerUpdateSchema = z
  .object({
    ...PartnerFields,
    name: PartnerFields.name.optional(),
    status: PartnerStatusSchema.optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine(refineGstinState)
  .refine(notEmpty, { message: 'empty_patch' })
export type PartnerUpdate = z.input<typeof PartnerUpdateSchema>

export const CommissionSchema = z.object({
  id: zId,
  partner_id: zId,
  partner_name: z.string(),
  order_id: zId,
  order_number: z.string().nullable(),
  order_kind: VendorOrderKindSchema,
  customer_name: z.string().nullable(),
  order_taxable_paise: zPaise,
  amount_paise: zPaise,
  status: CommissionStatusSchema,
  paid_ref: z.string().nullable(),
  paid_at: zTimestamp.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Commission = z.output<typeof CommissionSchema>

export const CommissionListQuerySchema = PageQuerySchema.extend({
  partner_id: zId.optional(),
  status: CommissionStatusSchema.optional(),
  from: zDateStr.optional(),
  to: zDateStr.optional(),
  sort: sortQuery(['created_at', 'amount_paise'] as const).prefault('-created_at'),
})
export type CommissionListQuery = z.input<typeof CommissionListQuerySchema>

export const CommissionPaySchema = z.object({
  paid_ref: z.string().trim().min(3).max(100).describe('UTR / UPI reference of the payout'),
  paid_at: zTimestamp.optional(),
})
export type CommissionPay = z.input<typeof CommissionPaySchema>

// =============================================================================================
// Price book (license_products)
// =============================================================================================

export const LicenseProductSchema = z.object({
  code: z.string(),
  kind: LicenseProductKindSchema,
  channel: DeploymentChannelSchema,
  name: z.string(),
  name_ta: z.string().nullable(),
  description: z.string().nullable(),
  description_ta: z.string().nullable(),
  /** Entitlement set granted (editions, yearly licences, cloud plans). */
  plan_code: z.string().nullable(),
  price_paise: zPaise,
  price_incl_gst_paise: zPaise,
  term_months: z.int().min(1).nullable(),
  included_amc_months: z.int().min(0),
  renewal_price_paise: zPaise.nullable(),
  limits: AddonLimitIncrementsSchema,
  features: z.array(FeatureSchema),
  hsn_sac: z.string(),
  gst_rate_bp: z.int().min(0),
  is_active: z.boolean(),
  sort_order: z.int(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type LicenseProduct = z.output<typeof LicenseProductSchema>

export const LicenseProductListQuerySchema = PageQuerySchema.extend({
  kind: LicenseProductKindSchema.optional(),
  channel: DeploymentChannelSchema.optional(),
  is_active: zBooleanQuery.optional(),
  q: zSearchQuery.optional(),
  sort: sortQuery(['sort_order', 'code', 'price_paise'] as const).prefault('sort_order'),
})
export type LicenseProductListQuery = z.input<typeof LicenseProductListQuerySchema>

const ProductFields = {
  kind: LicenseProductKindSchema,
  channel: DeploymentChannelSchema,
  name: z.string().trim().min(1).max(200),
  name_ta: zNullableText(200),
  description: zNullableText(2000),
  description_ta: zNullableText(2000),
  plan_code: zPlanCode.nullable().optional(),
  price_paise: zPaise,
  term_months: z.int().min(1).max(120).nullable().optional(),
  included_amc_months: z.int().min(0).max(120).optional(),
  renewal_price_paise: zPaise.nullable().optional(),
  limits: AddonLimitIncrementsSchema.optional(),
  features: z.array(FeatureSchema).max(10).optional(),
  hsn_sac: z
    .string()
    .trim()
    .regex(/^\d{4}(\d{2}){0,2}$/)
    .optional(),
  gst_rate_bp: z
    .int()
    .refine((v) => isValidGstRate(v), { message: 'gst_rate' })
    .optional(),
  is_active: z.boolean().optional(),
  sort_order: z.int().min(0).max(100_000).optional(),
}

/** Kind rules: plan_code for edition / subscription / cloud_plan only; terms per kind. */
function refineProduct(
  v: {
    kind?: LicenseProductKind | undefined
    plan_code?: string | null | undefined
    term_months?: number | null | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (!v.kind) return
  const needsPlan = v.kind === 'edition' || v.kind === 'subscription' || v.kind === 'cloud_plan'
  if (needsPlan && v.plan_code === null)
    ctx.addIssue({ code: 'custom', path: ['plan_code'], message: 'plan_required' })
  if (!needsPlan && v.plan_code)
    ctx.addIssue({ code: 'custom', path: ['plan_code'], message: 'plan_not_allowed' })
  if (
    (v.kind === 'subscription' || v.kind === 'amc' || v.kind === 'cloud_plan') &&
    v.term_months === null
  )
    ctx.addIssue({ code: 'custom', path: ['term_months'], message: 'term_required' })
  if (v.kind === 'edition' && v.term_months)
    ctx.addIssue({ code: 'custom', path: ['term_months'], message: 'term_not_allowed' })
}

/** POST /platform/products */
export const LicenseProductCreateSchema = z
  .object({
    code: zProductCode,
    ...ProductFields,
    plan_code: zPlanCode.nullable().default(null),
    term_months: z.int().min(1).max(120).nullable().default(null),
  })
  .superRefine(refineProduct)
export type LicenseProductCreate = z.input<typeof LicenseProductCreateSchema>

/** PATCH /platform/products/:code (code and kind are immutable). */
export const LicenseProductUpdateSchema = z
  .object({
    ...ProductFields,
    kind: z.never().optional(),
    channel: DeploymentChannelSchema.optional(),
    name: ProductFields.name.optional(),
    price_paise: zPaise.optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type LicenseProductUpdate = z.input<typeof LicenseProductUpdateSchema>

// =============================================================================================
// Customers (licensees)
// =============================================================================================

export const VendorCustomerSchema = z.object({
  id: zId,
  name: z.string().describe('Contact person'),
  business_name: z.string(),
  business_name_ta: z.string().nullable(),
  business_type: BusinessTypeSchema,
  phone: zE164,
  email: z.string().nullable(),
  gstin: z.string().nullable(),
  state_code: z.string(),
  district: z.string().nullable(),
  address: AddressSchema,
  partner_id: zId.nullable(),
  partner_name: z.string().nullable(),
  /** Linked cloud tenant (a cloud shop that also bought on-prem). */
  tenant_id: zId.nullable(),
  referred_by_customer_id: zId.nullable(),
  referral_code: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type VendorCustomer = z.output<typeof VendorCustomerSchema>

export const VendorCustomerRowSchema = VendorCustomerSchema.extend({
  active_licenses: z.int().min(0),
  active_activations: z.int().min(0),
  /** Earliest AMC / validity end among active licences. */
  next_due_on: zDateStr.nullable(),
  amc: AmcStatusSchema.nullable(),
  last_check_in_at: zTimestamp.nullable(),
})
export type VendorCustomerRow = z.output<typeof VendorCustomerRowSchema>

export const VendorCustomerListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Phone digits, business / contact name or GSTIN'),
  partner_id: zId.optional(),
  business_type: BusinessTypeSchema.optional(),
  state_code: zStateCode.optional(),
  district: z.string().trim().min(1).max(60).optional(),
  tag: z.string().trim().min(1).max(30).optional(),
  amc: AmcStateSchema.optional().describe('Customers with an active licence in this AMC state'),
  has_license: zBooleanQuery.optional(),
  sort: sortQuery(['business_name', 'created_at', 'next_due_on'] as const).prefault(
    'business_name',
  ),
})
export type VendorCustomerListQuery = z.input<typeof VendorCustomerListQuerySchema>

const CustomerFields = {
  name: z.string().trim().min(1).max(120),
  business_name: z.string().trim().min(1).max(200),
  business_name_ta: zNullableText(200),
  business_type: BusinessTypeSchema,
  phone: zPhone,
  email: zNullableEmail,
  gstin: zNullableGstin,
  state_code: zStateCode,
  district: zNullableText(60),
  address: AddressSchema.optional(),
  partner_id: zId.nullable().optional(),
  tenant_id: zId.nullable().optional(),
  referred_by_customer_id: zId.nullable().optional(),
  tags: zTags.optional(),
  notes: zNullableText(2000),
}

/** POST /platform/customers (duplicate phone → 409 DUPLICATE {existing_id}). */
export const VendorCustomerCreateSchema = z
  .object({ ...CustomerFields, state_code: zStateCode.default('33') })
  .superRefine(refineGstinState)
export type VendorCustomerCreate = z.input<typeof VendorCustomerCreateSchema>

export const VendorCustomerUpdateSchema = z
  .object({
    name: CustomerFields.name.optional(),
    business_name: CustomerFields.business_name.optional(),
    business_name_ta: CustomerFields.business_name_ta,
    business_type: BusinessTypeSchema.optional(),
    phone: zPhone.optional(),
    email: CustomerFields.email,
    gstin: CustomerFields.gstin,
    state_code: zStateCode.optional(),
    district: CustomerFields.district,
    address: CustomerFields.address,
    partner_id: CustomerFields.partner_id,
    tenant_id: CustomerFields.tenant_id,
    tags: CustomerFields.tags,
    notes: CustomerFields.notes,
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine(refineGstinState)
  .refine(notEmpty, { message: 'empty_patch' })
export type VendorCustomerUpdate = z.input<typeof VendorCustomerUpdateSchema>

// =============================================================================================
// Licences, activations, events
// =============================================================================================

export const LicenseEventSchema = z.object({
  id: z.int(),
  license_id: zId.nullable(),
  activation_id: zId.nullable(),
  kind: LicenseEventKindSchema,
  details: z.record(z.string(), z.unknown()),
  actor_user_id: zId.nullable(),
  actor_name: z.string().nullable(),
  ip: z.string().nullable(),
  created_at: zTimestamp,
})
export type LicenseEvent = z.output<typeof LicenseEventSchema>

export const ActivationSchema = z.object({
  id: zId,
  license_id: zId,
  key_prefix: z.string(),
  customer_id: zId,
  business_name_customer: z.string().describe('vendor_customers.business_name'),
  installation_id: z.string(),
  /** First 12 hex characters only. */
  fingerprint_short: z.string(),
  machine_name: z.string().nullable(),
  os: z.string().nullable(),
  app_version: z.string().nullable().describe('Version at activation'),
  last_version: z.string().nullable(),
  business_name: z.string().nullable().describe('Business name the installation reported'),
  method: ActivationMethodSchema,
  status: ActivationStatusSchema,
  activated_at: zTimestamp,
  last_check_in_at: zTimestamp.nullable(),
  last_check_in_ip: z.string().nullable(),
  last_stats: InstallationStatsSchema.partial(),
  connect_enabled: z.boolean(),
  cloud_backup_enabled: z.boolean(),
  /** No check-in for STALE_INSTALLATION_DAYS (active activations only). */
  stale: z.boolean(),
  snapshot_generated_at: zTimestamp.nullable(),
  cloud_backup_used_bytes: z.int().min(0),
  deactivated_at: zTimestamp.nullable(),
  deactivation_reason: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Activation = z.output<typeof ActivationSchema>

export const ActivationListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Machine / business name, installation id or key prefix'),
  license_id: zId.optional(),
  customer_id: zId.optional(),
  partner_id: zId.optional(),
  status: ActivationStatusSchema.optional(),
  version: zSemver.optional(),
  stale: zBooleanQuery.optional(),
  connect_enabled: zBooleanQuery.optional(),
  cloud_backup_enabled: zBooleanQuery.optional(),
  sort: sortQuery(['last_check_in_at', 'activated_at', 'last_version'] as const).prefault(
    '-last_check_in_at',
  ),
})
export type ActivationListQuery = z.input<typeof ActivationListQuerySchema>

export const LicenseRowSchema = z.object({
  id: zId,
  key_prefix: z.string(),
  customer_id: zId,
  customer_name: z.string(),
  business_name: z.string(),
  customer_phone: zE164,
  partner_id: zId.nullable(),
  partner_name: z.string().nullable(),
  product_code: z.string().describe('Edition / licence product (payload `edition`)'),
  product_name: z.string(),
  product_name_ta: z.string().nullable(),
  license_type: LicenseTypeSchema,
  plan_code: z.string(),
  status: VendorLicenseStatusSchema,
  valid_from: zDateStr,
  valid_until: zDateStr.nullable(),
  updates_until: zDateStr.nullable(),
  support_until: zDateStr.nullable(),
  grace_days: z.int().min(0),
  max_activations: z.int().min(1),
  active_activations: z.int().min(0),
  amc: AmcStatusSchema,
  term: LicenseTermStatusSchema,
  addons: z.array(LicenseAddonSchema),
  last_check_in_at: zTimestamp.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type LicenseRow = z.output<typeof LicenseRowSchema>

export const LicenseDetailSchema = LicenseRowSchema.extend({
  /** licenses.features (null = edition features). */
  features_override: z.array(FeatureSchema).nullable(),
  /** licenses.limits — staff overrides of the edition limits (absolute; before add-ons). */
  limits_override: PlanLimitsSchema.partial(),
  /** licenseEffectiveFeatures / licenseEffectiveLimits today — what the signed licence grants. */
  effective_features: z.array(FeatureSchema),
  effective_limits: PlanLimitsSchema,
  suspended_reason: z.string().nullable(),
  notes: z.string().nullable(),
  issued_by: zId.nullable(),
  issued_by_name: z.string().nullable(),
  transfers_last_365d: z.int().min(0),
  transfers_left: z.int().min(0),
  activations: z.array(ActivationSchema),
  /** Latest 50 events (full history: GET /platform/licenses/:id/events). */
  events: z.array(LicenseEventSchema),
  orders: z.array(z.lazy(() => VendorOrderRowSchema)),
})
export type LicenseDetail = z.output<typeof LicenseDetailSchema>

export const LicenseListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Key prefix (KD-7Q2M), business name or phone digits'),
  customer_id: zId.optional(),
  partner_id: zId.optional(),
  status: VendorLicenseStatusSchema.optional(),
  product_code: zProductCode.optional(),
  license_type: LicenseTypeSchema.optional(),
  amc: AmcStateSchema.optional(),
  amc_due_within_days: zQueryInt(0, 366).optional().describe('updates_until within N days'),
  sort: sortQuery([
    'created_at',
    'updates_until',
    'valid_until',
    'business_name',
  ] as const).prefault('-created_at'),
})
export type LicenseListQuery = z.input<typeof LicenseListQuerySchema>

export const LicenseEventListQuerySchema = PageQuerySchema.extend({
  kind: LicenseEventKindSchema.optional(),
  activation_id: zId.optional(),
})
export type LicenseEventListQuery = z.input<typeof LicenseEventListQuerySchema>

const KeyDeliverySchema = z
  .array(NotificationChannelSchema)
  .max(3)
  .default(['whatsapp'])
  .describe("Send the key to the customer's phone / email (empty = staff copies it)")

/**
 * POST /platform/licenses — issue a licence (manually or from a paid order). Defaults: valid_from
 * today; perpetual editions: valid_until null and updates_until = termEndDate(valid_from,
 * included_amc_months); subscriptions / trials: valid_until required, updates & support = valid
 * until; support_until = updates_until; partner = the customer's partner.
 */
export const LicenseIssueSchema = z
  .object({
    customer_id: zId,
    product_code: zProductCode.describe('Edition or yearly-licence product'),
    license_type: LicenseTypeSchema,
    order_id: zId.nullable().default(null),
    valid_from: zDateStr.optional(),
    valid_until: zDateStr.nullable().optional(),
    updates_until: zDateStr.nullable().optional(),
    support_until: zDateStr.nullable().optional(),
    max_activations: z.int().min(1).max(100).default(1),
    grace_days: z.int().min(0).max(90).default(DEFAULT_GRACE_DAYS),
    check_in_days: z.int().min(1).max(365).default(DEFAULT_CHECK_IN_DAYS),
    addons: z
      .array(z.object({ product_code: zProductCode, qty: z.int().min(1).max(1000).default(1) }))
      .max(20)
      .default([]),
    features_override: z.array(FeatureSchema).nullable().default(null),
    limits_override: PlanLimitsSchema.partial().default({}),
    notes: zNullableText(2000),
    send_key_via: KeyDeliverySchema,
  })
  .superRefine((v, ctx) => {
    const bounded = v.license_type === 'subscription' || v.license_type === 'trial'
    if (bounded && !v.valid_until)
      ctx.addIssue({ code: 'custom', path: ['valid_until'], message: 'valid_until_required' })
    if (v.license_type === 'perpetual' && v.valid_until)
      ctx.addIssue({ code: 'custom', path: ['valid_until'], message: 'valid_until_not_allowed' })
    if (v.valid_from && v.valid_until && v.valid_until < v.valid_from)
      ctx.addIssue({ code: 'custom', path: ['valid_until'], message: 'date_order' })
    const codes = v.addons.map((a) => a.product_code)
    if (new Set(codes).size !== codes.length)
      ctx.addIssue({ code: 'custom', path: ['addons'], message: 'duplicate_item' })
  })
export type LicenseIssue = z.input<typeof LicenseIssueSchema>

/** Result of issuing / re-issuing a key: the full key is shown ONCE. */
export const LicenseKeyResultSchema = z.object({
  license: LicenseDetailSchema,
  license_key: z.string().describe('Full key KD-XXXX-XXXX-XXXX-XXXX — shown once, never stored'),
  delivered_via: z.array(NotificationChannelSchema),
  /** wa.me link with the key message, for staff to send manually. */
  whatsapp_url: z.string().nullable(),
})
export type LicenseKeyResult = z.output<typeof LicenseKeyResultSchema>

export const LicenseReasonSchema = z.object({ reason: zReason })
export type LicenseReason = z.input<typeof LicenseReasonSchema>

/**
 * POST /platform/licenses/:id/reissue-key — we never store keys, so "resend" issues a NEW key
 * (existing activations keep working; the old key can no longer activate a computer).
 */
export const LicenseReissueKeySchema = z.object({
  reason: zReason,
  send_key_via: KeyDeliverySchema,
})
export type LicenseReissueKey = z.input<typeof LicenseReissueKeySchema>

/** POST /platform/licenses/:id/upgrade — new edition; dates kept, limits recomputed. */
export const LicenseUpgradeSchema = z.object({
  product_code: zProductCode,
  order_id: zId.nullable().default(null),
  notes: zNullableText(500),
})
export type LicenseUpgrade = z.input<typeof LicenseUpgradeSchema>

/** POST /platform/licenses/:id/addons — add (or increase) an add-on; limits recomputed. */
export const LicenseAddonAddSchema = z.object({
  product_code: zProductCode,
  qty: z.int().min(1).max(1000).default(1),
  order_id: zId.nullable().default(null),
  /** Term add-ons: default termEndDate(today, product.term_months). */
  valid_until: zDateStr.nullable().optional(),
})
export type LicenseAddonAdd = z.input<typeof LicenseAddonAddSchema>

/**
 * POST /platform/licenses/:id/renew — extends from max(today, current end) (extendTermEnd):
 * amc → updates_until & support_until; subscription → valid_until (+ updates & support);
 * addon → that add-on's valid_until.
 */
export const LicenseRenewSchema = z
  .object({
    kind: z.enum(['amc', 'subscription', 'addon']),
    months: z.int().min(1).max(60).default(12),
    addon_product_code: zProductCode.optional(),
    order_id: zId.nullable().default(null),
    notes: zNullableText(500),
  })
  .refine((v) => v.kind !== 'addon' || !!v.addon_product_code, {
    message: 'product_code',
    path: ['addon_product_code'],
  })
export type LicenseRenew = z.input<typeof LicenseRenewSchema>

/** PATCH /platform/licenses/:id — administrative fields only (dates via renew / upgrade). */
export const LicenseUpdateSchema = z
  .object({
    max_activations: z.int().min(1).max(100).optional(),
    grace_days: z.int().min(0).max(90).optional(),
    features_override: z.array(FeatureSchema).nullable().optional(),
    limits_override: PlanLimitsSchema.partial().optional(),
    support_until: zDateStr.nullable().optional(),
    partner_id: zId.nullable().optional(),
    notes: zNullableText(2000),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type LicenseUpdate = z.input<typeof LicenseUpdateSchema>

/**
 * POST /platform/activations/:id/deactivate — frees the seat so the customer can activate a new
 * PC. Counts as a transfer (LICENSE_TRANSFERS_PER_YEAR) unless count_as_transfer is false;
 * owner/admin may override the yearly limit. Audited (license_events 'deactivated'/'transferred').
 */
export const ActivationDeactivateSchema = z.object({
  reason: zReason,
  count_as_transfer: z.boolean().default(true),
  override_limit: z.boolean().default(false),
})
export type ActivationDeactivate = z.input<typeof ActivationDeactivateSchema>

/** Staff offline activation: pick the licence by id or key, upload the shop's request. */
export const StaffOfflineActivateSchema = z
  .object({
    license_id: zId.optional(),
    license_key: zLicenseKey.optional(),
    request: ActivationRequestInputSchema,
  })
  .refine((v) => !!v.license_id !== !!v.license_key, {
    message: 'license_required',
    path: ['license_id'],
  })
export type StaffOfflineActivate = z.input<typeof StaffOfflineActivateSchema>

/** Short licence summary shown after activation. */
export const LicenseSummarySchema = z.object({
  license_id: zId,
  key_prefix: z.string(),
  business_name: z.string(),
  edition_code: z.string(),
  edition_name: z.string(),
  edition_name_ta: z.string().nullable(),
  license_type: LicenseTypeSchema,
  valid_until: zDateStr.nullable(),
  updates_until: zDateStr.nullable(),
})
export type LicenseSummary = z.output<typeof LicenseSummarySchema>

/** A signed licence ready to download / WhatsApp (offline activation, re-download). */
export const LicenseFileResultSchema = z.object({
  signed_license: SignedLicenseDocumentSchema,
  /** licenseFilename(key_prefix). */
  filename: z.string(),
  /** 'KDLIC1.' copy/paste form of the same document. */
  license_code: z.string(),
  summary: LicenseSummarySchema,
  activation_id: zId,
})
export type LicenseFileResult = z.output<typeof LicenseFileResultSchema>

// =============================================================================================
// Offers & coupons
// =============================================================================================

export const OfferStateSchema = z.enum(['active', 'scheduled', 'expired', 'inactive', 'exhausted'])
export type OfferState = z.infer<typeof OfferStateSchema>

/** Display state of an offer at `now`. */
export function offerState(
  offer: Pick<
    PricingOffer,
    'is_active' | 'starts_at' | 'ends_at' | 'max_redemptions' | 'redeemed_count'
  >,
  now: Instant,
): OfferState {
  if (offer.is_active === false) return 'inactive'
  const t = instantMs(now)
  if (offer.ends_at != null && instantMs(offer.ends_at) <= t) return 'expired'
  if (offer.starts_at != null && instantMs(offer.starts_at) > t) return 'scheduled'
  if (offer.max_redemptions != null && (offer.redeemed_count ?? 0) >= offer.max_redemptions)
    return 'exhausted'
  return 'active'
}

export const OfferSchema = z.object({
  id: zId,
  /** null = automatic campaign. */
  code: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  description: z.string().nullable(),
  description_ta: z.string().nullable(),
  kind: OfferKindSchema,
  value: z
    .int()
    .min(0)
    .describe('bp (percent) | paise (flat) | months | paise per unit (override)'),
  max_discount_paise: zPaise.nullable(),
  applies_to: z.array(z.string()),
  channel: DeploymentChannelSchema,
  audience: OfferAudienceSchema,
  starts_at: zTimestamp.nullable(),
  ends_at: zTimestamp.nullable(),
  max_redemptions: z.int().min(0).nullable(),
  per_customer_limit: z.int().min(0),
  partner_id: zId.nullable(),
  partner_name: z.string().nullable(),
  stackable: z.boolean(),
  banner: OfferBannerSchema.nullable(),
  is_active: z.boolean(),
  state: OfferStateSchema,
  redeemed_count: z.int().min(0),
  discount_given_paise: zPaise,
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Offer = z.output<typeof OfferSchema>

/** What a shop / tenant sees of an offer (check-in offers, cloud billing). */
export const OfferPublicSchema = z.object({
  id: zId,
  code: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  description: z.string().nullable(),
  description_ta: z.string().nullable(),
  kind: OfferKindSchema,
  value: z.int().min(0),
  max_discount_paise: zPaise.nullable(),
  applies_to: z.array(z.string()),
  ends_at: zTimestamp.nullable(),
  banner: OfferBannerSchema.nullable(),
  automatic: z.boolean(),
})
export type OfferPublic = z.output<typeof OfferPublicSchema>

export const OfferListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Code or name'),
  state: OfferStateSchema.optional(),
  kind: OfferKindSchema.optional(),
  channel: DeploymentChannelSchema.optional(),
  partner_id: zId.optional(),
  automatic: zBooleanQuery.optional().describe('true = campaigns without a code'),
  sort: sortQuery(['created_at', 'starts_at', 'ends_at', 'name'] as const).prefault('-created_at'),
})
export type OfferListQuery = z.input<typeof OfferListQuerySchema>

const OfferFields = {
  name: z.string().trim().min(1).max(200),
  name_ta: zNullableText(200),
  description: zNullableText(1000),
  description_ta: zNullableText(1000),
  kind: OfferKindSchema,
  value: z.int().min(0).max(100_000_000),
  max_discount_paise: zPaise.nullable().optional(),
  applies_to: z.array(zProductCode).max(50).optional(),
  channel: DeploymentChannelSchema.optional(),
  audience: OfferAudienceSchema.optional(),
  starts_at: zTimestamp.nullable().optional(),
  ends_at: zTimestamp.nullable().optional(),
  max_redemptions: z.int().min(1).nullable().optional(),
  per_customer_limit: z.int().min(1).max(1000).optional(),
  partner_id: zId.nullable().optional(),
  stackable: z.boolean().optional(),
  banner: OfferBannerSchema.nullable().optional(),
  is_active: z.boolean().optional(),
}

function refineOffer(
  v: {
    code?: string | null | undefined
    kind?: OfferKind | undefined
    value?: number | undefined
    starts_at?: string | null | undefined
    ends_at?: string | null | undefined
    partner_id?: string | null | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (v.kind === 'percent' && v.value !== undefined && v.value > 10_000)
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'percent_max' })
  if (v.kind === 'free_months' && v.value !== undefined && (v.value < 1 || v.value > 36))
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'free_months_max' })
  if (v.starts_at && v.ends_at && Date.parse(v.ends_at) <= Date.parse(v.starts_at))
    ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'date_order' })
  if (v.partner_id && v.code === null)
    ctx.addIssue({ code: 'custom', path: ['code'], message: 'partner_offer_needs_code' })
}

/** POST /platform/offers — `code: null` creates an automatic campaign. */
export const OfferCreateSchema = z
  .object({ code: zCouponCode.nullable().default(null), ...OfferFields })
  .superRefine(refineOffer)
export type OfferCreate = z.input<typeof OfferCreateSchema>

/** PATCH /platform/offers/:id — kind is immutable once redeemed (409). */
export const OfferUpdateSchema = z
  .object({
    ...OfferFields,
    code: zCouponCode.nullable().optional(),
    name: OfferFields.name.optional(),
    kind: OfferKindSchema.optional(),
    value: OfferFields.value.optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine(refineOffer)
  .refine(notEmpty, { message: 'empty_patch' })
export type OfferUpdate = z.input<typeof OfferUpdateSchema>

export const OfferRedemptionSchema = z.object({
  id: zId,
  offer_id: zId,
  order_id: zId,
  order_number: z.string().nullable(),
  customer_id: zId.nullable(),
  customer_name: z.string().nullable(),
  tenant_id: zId.nullable(),
  tenant_name: z.string().nullable(),
  discount_paise: zPaise,
  created_at: zTimestamp,
})
export type OfferRedemption = z.output<typeof OfferRedemptionSchema>

/** One line to buy (the server prices it from the price book / licence context). */
export const OrderItemSchema = z.object({
  product_code: zProductCode,
  qty: z.int().min(1).max(1000).default(1),
})
export type OrderItem = z.input<typeof OrderItemSchema>

const OrderItemsSchema = z
  .array(OrderItemSchema)
  .min(1)
  .max(20)
  .refine((items) => new Set(items.map((i) => i.product_code)).size === items.length, {
    message: 'duplicate_item',
  })

/** POST /platform/offers/validate — check a coupon for a buyer & items (console checkout). */
export const OfferValidateSchema = z
  .object({
    coupon_code: zCouponCode,
    items: OrderItemsSchema,
    customer_id: zId.optional(),
    tenant_id: zId.optional(),
    license_id: zId.optional(),
    partner_id: zId.optional(),
  })
  .refine((v) => !!v.customer_id || !!v.tenant_id, {
    message: 'customer_or_tenant',
    path: ['customer_id'],
  })
export type OfferValidate = z.input<typeof OfferValidateSchema>

export const OfferValidateResultSchema = z.object({
  valid: z.boolean(),
  offer: OfferPublicSchema.nullable(),
  reason: OfferRejectReasonSchema.nullable(),
  quote: PriceQuoteSchema,
})
export type OfferValidateResult = z.output<typeof OfferValidateResultSchema>

// =============================================================================================
// Orders, payments & GST invoices
// =============================================================================================

export const VendorOrderRowSchema = z.object({
  id: zId,
  /** GST invoice number, assigned on payment (KD/2627/000123). */
  number: z.string().nullable(),
  kind: VendorOrderKindSchema,
  status: VendorOrderStatusSchema,
  customer_id: zId.nullable(),
  customer_name: z.string().nullable(),
  business_name: z.string().nullable(),
  tenant_id: zId.nullable(),
  tenant_name: z.string().nullable(),
  license_id: zId.nullable(),
  key_prefix: z.string().nullable(),
  partner_id: zId.nullable(),
  partner_name: z.string().nullable(),
  subtotal_paise: zPaise,
  discount_paise: zPaise,
  taxable_paise: zPaise,
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  total_paise: zPaise,
  place_of_supply: z.string(),
  buyer_gstin: z.string().nullable(),
  coupon_code: z.string().nullable(),
  payment_provider: VendorPaymentProviderSchema.nullable(),
  payment_ref: z.string().nullable(),
  short_url: z.string().nullable(),
  paid_at: zTimestamp.nullable(),
  fulfilled_at: zTimestamp.nullable(),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type VendorOrderRow = z.output<typeof VendorOrderRowSchema>

/** vendor_orders.lines — the priced lines exactly as quoted (PricedOrderLine). */
export const VendorOrderLineSchema = PricedOrderLineSchema
export type VendorOrderLine = PricedOrderLine

export const VendorOrderDetailSchema = VendorOrderRowSchema.extend({
  lines: z.array(VendorOrderLineSchema),
  offer_ids: z.array(zId),
  redemptions: z.array(OfferRedemptionSchema),
  commission: CommissionSchema.nullable(),
  notes: z.string().nullable(),
  created_by_name: z.string().nullable(),
  /** Licence issued / extended by fulfilment. */
  fulfilment: z
    .object({
      license_id: zId.nullable(),
      events: z.array(LicenseEventSchema),
      error: z.string().nullable(),
    })
    .nullable(),
  /** True once numbered (paid / fulfilled / refunded): GET …/invoice works. */
  has_invoice: z.boolean(),
})
export type VendorOrderDetail = z.output<typeof VendorOrderDetailSchema>

export const VendorOrderListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Invoice number, business name, phone digits or UTR'),
  status: VendorOrderStatusSchema.optional(),
  kind: VendorOrderKindSchema.optional(),
  customer_id: zId.optional(),
  tenant_id: zId.optional(),
  license_id: zId.optional(),
  partner_id: zId.optional(),
  from: zDateStr.optional(),
  to: zDateStr.optional(),
  sort: sortQuery(['created_at', 'paid_at', 'total_paise'] as const).prefault('-created_at'),
})
export type VendorOrderListQuery = z.input<typeof VendorOrderListQuerySchema>

const OrderBuyerFields = {
  kind: VendorOrderKindSchema,
  customer_id: zId.optional(),
  tenant_id: zId.optional(),
  /** Required for renewal / upgrade / addon. */
  license_id: zId.optional(),
  /** Partner-placed order (partner users: always their own). Applies partner pricing. */
  partner_id: zId.nullable().optional(),
  items: OrderItemsSchema,
  coupon_code: zOptionalCouponCode,
  buyer_gstin: zNullableGstin,
  /** Default: the buyer GSTIN's state, else the customer's / tenant's state. */
  place_of_supply: zStateCode.optional(),
  /** Staff price override per product (needs vendor.orders.payments): unit price excl. GST. */
  price_overrides: z.record(zProductCode, zPaise).optional(),
}

function refineOrderBuyer(
  v: {
    kind: VendorOrderKind
    customer_id?: string | undefined
    tenant_id?: string | undefined
    license_id?: string | undefined
    buyer_gstin?: string | null | undefined
    place_of_supply?: string | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (!v.customer_id && !v.tenant_id)
    ctx.addIssue({ code: 'custom', path: ['customer_id'], message: 'customer_or_tenant' })
  if ((v.kind === 'renewal' || v.kind === 'upgrade' || v.kind === 'addon') && !v.license_id)
    ctx.addIssue({ code: 'custom', path: ['license_id'], message: 'license_required' })
  if (v.buyer_gstin && v.place_of_supply && v.buyer_gstin.slice(0, 2) !== v.place_of_supply)
    ctx.addIssue({ code: 'custom', path: ['place_of_supply'], message: 'gstin_state' })
}

/** POST /platform/orders/quote — price without saving (live GST breakup in the quote builder). */
export const VendorOrderQuoteSchema = z.object(OrderBuyerFields).superRefine(refineOrderBuyer)
export type VendorOrderQuote = z.input<typeof VendorOrderQuoteSchema>

/** POST /platform/orders — create a draft or a pending-payment order (priced by priceOrder). */
export const VendorOrderCreateSchema = z
  .object({
    ...OrderBuyerFields,
    status: z.enum(['draft', 'pending_payment']).default('pending_payment'),
    /** pending_payment + razorpay: create the payment link right away. */
    payment_link: z.boolean().default(false),
    notes: zNullableText(2000),
  })
  .superRefine(refineOrderBuyer)
export type VendorOrderCreate = z.input<typeof VendorOrderCreateSchema>

/** PATCH /platform/orders/:id — drafts only (re-priced). */
export const VendorOrderUpdateSchema = z
  .object({
    items: OrderItemsSchema.optional(),
    coupon_code: zOptionalCouponCode,
    buyer_gstin: zNullableGstin,
    place_of_supply: zStateCode.optional(),
    price_overrides: z.record(zProductCode, zPaise).optional(),
    notes: zNullableText(2000),
    status: z.literal('pending_payment').optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type VendorOrderUpdate = z.input<typeof VendorOrderUpdateSchema>

/** POST /platform/orders/:id/payment-link — Razorpay payment link for the order total. */
export const PaymentLinkCreateSchema = z.object({
  send_via: z.array(NotificationChannelSchema).max(3).default([]),
  expire_in_hours: z
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
})
export type PaymentLinkCreate = z.input<typeof PaymentLinkCreateSchema>

export const PaymentLinkSchema = z.object({
  order_id: zId,
  short_url: z.string(),
  payment_ref: z.string().describe('Razorpay payment link id'),
  amount_paise: zPaise,
  expires_at: zTimestamp.nullable(),
  sent_via: z.array(NotificationChannelSchema),
})
export type PaymentLink = z.output<typeof PaymentLinkSchema>

/** POST /platform/orders/:id/mark-paid — manual UPI/bank (UTR) or partner settlement. */
export const OrderMarkPaidSchema = z.object({
  provider: z.enum(['manual', 'partner_credit']),
  payment_ref: z.string().trim().min(4).max(100).describe('UTR / UPI reference / settlement ref'),
  paid_at: zTimestamp.optional(),
  /** Must equal the order total (partial payments are not supported). */
  amount_paise: zPaise,
})
export type OrderMarkPaid = z.input<typeof OrderMarkPaidSchema>

export const OrderRefundSchema = z.object({
  reason: zReason,
  refund_ref: z.string().trim().min(3).max(100).nullable().default(null),
  /** Revoke / roll back the licence change made by fulfilment. */
  revoke_license: z.boolean().default(false),
})
export type OrderRefund = z.input<typeof OrderRefundSchema>

export const InvoicePartySchema = z.object({
  name: z.string(),
  legal_name: z.string().nullable(),
  gstin: z.string().nullable(),
  address: AddressSchema,
  state_code: z.string(),
  state_name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
})

export const VendorInvoiceLineSchema = z.object({
  sl: z.int().min(1),
  description_en: z.string(),
  description_ta: z.string().nullable(),
  sac: z.string(),
  qty: z.int().min(1),
  unit_price_paise: zPaise,
  discount_paise: zPaise,
  taxable_paise: zPaise,
  gst_rate_bp: z.int().min(0),
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  total_paise: zPaise,
  /** Service period for term products. */
  period_from: zDateStr.nullable(),
  period_to: zDateStr.nullable(),
})

/**
 * Print model of OUR GST tax invoice (vendor orders and cloud plan invoices): bilingual, SAC
 * 997331, CGST+SGST or IGST by place of supply. Used by the vendor console and cloud billing.
 */
export const VendorInvoicePrintSchema = z.object({
  number: z.string(),
  date: zDateStr,
  order_id: zId.nullable(),
  kind: VendorOrderKindSchema.nullable(),
  seller: InvoicePartySchema,
  buyer: InvoicePartySchema,
  place_of_supply: z.string(),
  place_of_supply_name: z.string(),
  is_interstate: z.boolean(),
  reverse_charge: z.boolean(),
  lines: z.array(VendorInvoiceLineSchema),
  tax_breakup: z.array(
    z.object({
      gst_rate_bp: z.int().min(0),
      taxable_paise: zPaise,
      cgst_paise: zPaise,
      sgst_paise: zPaise,
      igst_paise: zPaise,
    }),
  ),
  subtotal_paise: zPaise,
  discount_paise: zPaise,
  taxable_paise: zPaise,
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  total_paise: zPaise,
  amount_in_words_en: z.string(),
  amount_in_words_ta: z.string(),
  payment: z
    .object({
      provider: VendorPaymentProviderSchema.nullable(),
      reference: z.string().nullable(),
      paid_at: zTimestamp.nullable(),
    })
    .nullable(),
  status: z.enum(['paid', 'issued', 'refunded', 'void']),
  notes: z.string().nullable(),
})
export type VendorInvoicePrint = z.output<typeof VendorInvoicePrintSchema>

/** Rate-wise tax breakup + amounts in words for an invoice print model. */
export function invoiceTotals(
  lines: readonly Pick<
    PricedOrderLine,
    'gst_rate_bp' | 'taxable_paise' | 'cgst_paise' | 'sgst_paise' | 'igst_paise' | 'total_paise'
  >[],
): {
  tax_breakup: VendorInvoicePrint['tax_breakup']
  total_paise: number
  amount_in_words_en: string
  amount_in_words_ta: string
} {
  const byRate = new Map<number, VendorInvoicePrint['tax_breakup'][number]>()
  for (const l of lines) {
    const row = byRate.get(l.gst_rate_bp) ?? {
      gst_rate_bp: l.gst_rate_bp,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
    }
    row.taxable_paise += l.taxable_paise
    row.cgst_paise += l.cgst_paise
    row.sgst_paise += l.sgst_paise
    row.igst_paise += l.igst_paise
    byRate.set(l.gst_rate_bp, row)
  }
  const total = sumSafe(lines.map((l) => l.total_paise))
  return {
    tax_breakup: [...byRate.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp),
    total_paise: total,
    amount_in_words_en: amountInWords(total, 'en'),
    amount_in_words_ta: amountInWords(total, 'ta'),
  }
}

/** State name for a place-of-supply code (invoice prints). */
export function placeOfSupplyName(stateCode: string): string {
  const st = getState(stateCode)
  return st ? `${st.code}-${st.name_en}` : stateCode
}

// =============================================================================================
// Releases
// =============================================================================================

export const ReleaseArtifactSchema = z.object({
  platform: ReleasePlatformSchema,
  /** https URL of the zip / tarball (Docker: the image reference, e.g. ghcr.io/kadai/server:1.4.0). */
  url: z.string().trim().min(1).max(500),
  sha256: zSha256Hex,
  size_bytes: z.int().min(0),
  /** base64 Ed25519 over releaseSignatureMessage(sha256, version, platform). */
  signature: zEd25519Signature,
})
export type ReleaseArtifact = z.output<typeof ReleaseArtifactSchema>

export const ReleaseSchema = z.object({
  id: zId,
  version: z.string(),
  channel: ReleaseChannelSchema,
  released_at: zTimestamp,
  notes_en: z.string(),
  notes_ta: z.string().nullable(),
  min_upgrade_from: z.string().nullable(),
  mandatory: z.boolean(),
  artifacts: z.array(ReleaseArtifactSchema),
  is_active: z.boolean(),
  /** Active activations whose last_version equals this version. */
  installs: z.int().min(0),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Release = z.output<typeof ReleaseSchema>

/** A release as offered to an installation (check-in, GET …/releases, the shop update center). */
export const ReleaseInfoSchema = z.object({
  version: z.string(),
  channel: ReleaseChannelSchema,
  released_at: zTimestamp,
  notes_en: z.string(),
  notes_ta: z.string().nullable(),
  min_upgrade_from: z.string().nullable(),
  mandatory: z.boolean(),
  /** isReleaseEligible for the licence's updates_until. */
  eligible: z.boolean(),
  artifacts: z.array(ReleaseArtifactSchema),
})
export type ReleaseInfo = z.output<typeof ReleaseInfoSchema>

export const ReleaseListQuerySchema = PageQuerySchema.extend({
  channel: ReleaseChannelSchema.optional(),
  is_active: zBooleanQuery.optional(),
  sort: sortQuery(['released_at', 'version'] as const).prefault('-released_at'),
})
export type ReleaseListQuery = z.input<typeof ReleaseListQuerySchema>

/** Artifact as entered by staff: the server signs it (KADAI_RELEASE_SIGNING_KEY). */
export const ReleaseArtifactInputSchema = ReleaseArtifactSchema.omit({ signature: true })

const ReleaseFields = {
  channel: ReleaseChannelSchema.default('stable'),
  released_at: zTimestamp.optional(),
  notes_en: z.string().trim().min(1).max(20_000),
  notes_ta: zNullableText(30_000),
  min_upgrade_from: zSemver.nullable().default(null),
  mandatory: z.boolean().default(false),
  artifacts: z
    .array(ReleaseArtifactInputSchema)
    .max(6)
    .default([])
    .refine((a) => new Set(a.map((x) => x.platform)).size === a.length, {
      message: 'duplicate_item',
    }),
  is_active: z.boolean().default(true),
}

/** POST /platform/releases */
export const ReleaseCreateSchema = z.object({ version: zSemver, ...ReleaseFields })
export type ReleaseCreate = z.input<typeof ReleaseCreateSchema>

/** PATCH /platform/releases/:id (version immutable; artifacts replace the list and are re-signed). */
export const ReleaseUpdateSchema = z
  .object({
    channel: ReleaseChannelSchema.optional(),
    released_at: zTimestamp.optional(),
    notes_en: ReleaseFields.notes_en.optional(),
    notes_ta: ReleaseFields.notes_ta,
    min_upgrade_from: zSemver.nullable().optional(),
    mandatory: z.boolean().optional(),
    artifacts: z.array(ReleaseArtifactInputSchema).max(6).optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type ReleaseUpdate = z.input<typeof ReleaseUpdateSchema>

// =============================================================================================
// Announcements
// =============================================================================================

export const AnnouncementSchema = z.object({
  id: zId,
  severity: AnnouncementSeveritySchema,
  title_en: z.string(),
  title_ta: z.string().nullable(),
  body_en: z.string(),
  body_ta: z.string().nullable(),
  cta_label_en: z.string().nullable(),
  cta_label_ta: z.string().nullable(),
  cta_url: z.string().nullable(),
  offer_id: zId.nullable(),
  offer_name: z.string().nullable(),
  audience: AnnouncementAudienceSchema,
  starts_at: zTimestamp,
  ends_at: zTimestamp.nullable(),
  is_active: z.boolean(),
  state: z.enum(['active', 'scheduled', 'expired', 'inactive']),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Announcement = z.output<typeof AnnouncementSchema>

export const AnnouncementListQuerySchema = PageQuerySchema.extend({
  state: z.enum(['active', 'scheduled', 'expired', 'inactive']).optional(),
  severity: AnnouncementSeveritySchema.optional(),
  channel: z.enum(['cloud', 'onprem']).optional(),
  sort: sortQuery(['starts_at', 'created_at'] as const).prefault('-starts_at'),
})
export type AnnouncementListQuery = z.input<typeof AnnouncementListQuerySchema>

const zCtaUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https:\/\//.test(v) || v.startsWith('/'), { message: 'url' })

const AnnouncementFields = {
  severity: AnnouncementSeveritySchema.default('info'),
  title_en: z.string().trim().min(1).max(160),
  title_ta: zNullableText(200),
  body_en: z.string().trim().min(1).max(2000),
  body_ta: zNullableText(3000),
  cta_label_en: zNullableText(40),
  cta_label_ta: zNullableText(60),
  cta_url: z
    .union([z.null(), zCtaUrl])
    .optional()
    .describe("https URL or an app path ('/settings/system')"),
  offer_id: zId.nullable().optional(),
  audience: AnnouncementAudienceSchema.prefault({}),
  starts_at: zTimestamp.optional(),
  ends_at: zTimestamp.nullable().optional(),
  is_active: z.boolean().default(true),
}

/** POST /platform/announcements */
export const AnnouncementCreateSchema = z
  .object(AnnouncementFields)
  .refine((v) => !v.starts_at || !v.ends_at || Date.parse(v.ends_at) > Date.parse(v.starts_at), {
    message: 'date_order',
    path: ['ends_at'],
  })
export type AnnouncementCreate = z.input<typeof AnnouncementCreateSchema>

export const AnnouncementUpdateSchema = z
  .object({
    severity: AnnouncementSeveritySchema.optional(),
    title_en: AnnouncementFields.title_en.optional(),
    title_ta: AnnouncementFields.title_ta,
    body_en: AnnouncementFields.body_en.optional(),
    body_ta: AnnouncementFields.body_ta,
    cta_label_en: AnnouncementFields.cta_label_en,
    cta_label_ta: AnnouncementFields.cta_label_ta,
    cta_url: AnnouncementFields.cta_url,
    offer_id: AnnouncementFields.offer_id,
    audience: AnnouncementAudienceSchema.optional(),
    starts_at: zTimestamp.optional(),
    ends_at: zTimestamp.nullable().optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type AnnouncementUpdate = z.input<typeof AnnouncementUpdateSchema>

// =============================================================================================
// Cloud tenant admin & plans (moved here from the old platform admin)
// =============================================================================================

export const TenantUsageSchema = z.object({
  stores: z.int().min(0),
  users: z.int().min(0),
  registers: z.int().min(0),
  products: z.int().min(0),
  invoices_this_month: z.int().min(0),
})
export type TenantUsage = z.output<typeof TenantUsageSchema>

export const TenantAdminRowSchema = z.object({
  id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  business_type: BusinessTypeSchema,
  state_code: z.string(),
  district: z.string().nullable(),
  plan_code: z.string(),
  status: TenantStatusSchema,
  suspended_reason: z.string().nullable(),
  owner_name: z.string().nullable(),
  owner_phone: z.string().nullable(),
  subscription_status: SubscriptionStatusSchema.nullable(),
  billing_cycle: BillingCycleSchema.nullable(),
  current_period_end: zTimestamp.nullable(),
  trial_ends_at: zTimestamp.nullable(),
  usage: TenantUsageSchema,
  last_invoice_at: zTimestamp.nullable(),
  created_at: zTimestamp,
})
export type TenantAdminRow = z.output<typeof TenantAdminRowSchema>

export const TenantSubscriptionAdminSchema = z.object({
  id: zId,
  plan_code: z.string(),
  status: SubscriptionStatusSchema,
  billing_cycle: BillingCycleSchema,
  current_period_start: zTimestamp,
  current_period_end: zTimestamp,
  trial_ends_at: zTimestamp.nullable(),
  cancel_at_period_end: z.boolean(),
  provider: z.enum(['razorpay', 'manual']).nullable(),
  provider_subscription_id: z.string().nullable(),
  limit_overrides: PlanLimitsSchema.partial(),
})

export const PlatformAuditLogSchema = z.object({
  id: z.int(),
  actor_user_id: zId.nullable(),
  actor_name: z.string().nullable(),
  tenant_id: zId.nullable(),
  tenant_name: z.string().nullable(),
  action: z.string(),
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  request_id: z.string().nullable(),
  created_at: zTimestamp,
})
export type PlatformAuditLog = z.output<typeof PlatformAuditLogSchema>

export const TenantAdminDetailSchema = TenantAdminRowSchema.extend({
  gstin: z.string().nullable(),
  gst_scheme: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  subscription: TenantSubscriptionAdminSchema.nullable(),
  entitlements: z.object({
    plan_code: z.string(),
    features: z.array(FeatureSchema),
    limits: PlanLimitsSchema,
  }),
  invoices: z.array(
    z.object({
      id: zId,
      source: z.enum(['order', 'platform_invoice']),
      number: z.string().nullable(),
      total_paise: zPaise,
      status: z.union([VendorOrderStatusSchema, PlatformInvoiceStatusSchema]),
      created_at: zTimestamp,
    }),
  ),
  vendor_customer: RefSchema.nullable(),
  audit: z.array(PlatformAuditLogSchema),
})
export type TenantAdminDetail = z.output<typeof TenantAdminDetailSchema>

export const TenantAdminListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Business name, owner phone digits or GSTIN'),
  plan_code: zPlanCode.optional(),
  status: TenantStatusSchema.optional(),
  subscription_status: SubscriptionStatusSchema.optional(),
  business_type: BusinessTypeSchema.optional(),
  state_code: zStateCode.optional(),
  created_from: zDateStr.optional(),
  created_to: zDateStr.optional(),
  sort: sortQuery(['created_at', 'name', 'invoices_this_month'] as const).prefault('-created_at'),
})
export type TenantAdminListQuery = z.input<typeof TenantAdminListQuerySchema>

export const TenantSuspendSchema = z.object({ reason: zReason })
export type TenantSuspend = z.input<typeof TenantSuspendSchema>
export const TenantResumeSchema = z.object({ reason: zNullableText(500) })
export type TenantResume = z.input<typeof TenantResumeSchema>

/** POST /platform/tenants/:id/plan — manual plan change (enterprise deals, goodwill extensions). */
export const TenantPlanChangeSchema = z.object({
  plan_code: zPlanCode,
  billing_cycle: BillingCycleSchema.optional(),
  limit_overrides: PlanLimitsSchema.partial().default({}),
  /** End of the manual period; null = open-ended (manual provider). */
  period_end: zTimestamp.nullable().optional(),
  reason: zReason,
})
export type TenantPlanChange = z.input<typeof TenantPlanChangeSchema>

export const PlanAdminSchema = z.object({
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  description: z.string().nullable(),
  price_monthly_paise: zPaise,
  price_yearly_paise: zPaise,
  limits: PlanLimitsSchema,
  features: z.array(FeatureSchema),
  is_public: z.boolean(),
  sort_order: z.int(),
  /** 'onprem' for onprem_* editions. */
  channel: z.enum(['cloud', 'onprem']),
  tenants_count: z.int().min(0),
  licenses_count: z.int().min(0),
  updated_at: zTimestamp,
})
export type PlanAdmin = z.output<typeof PlanAdminSchema>

/** PUT /platform/plans/:code — full replacement of the editable fields (audited). */
export const PlanUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  name_ta: zNullableText(100),
  description: zNullableText(500),
  price_monthly_paise: zPaise,
  price_yearly_paise: zPaise,
  limits: PlanLimitsSchema,
  features: z.array(FeatureSchema).max(64),
  is_public: z.boolean(),
  sort_order: z.int().min(0).max(10_000),
})
export type PlanUpdate = z.input<typeof PlanUpdateSchema>

export const PlatformAuditLogListQuerySchema = PageQuerySchema.extend({
  action: z.string().trim().min(1).max(100).optional().describe('Action prefix, e.g. license.'),
  actor_user_id: zId.optional(),
  tenant_id: zId.optional(),
  from: zDateStr.optional(),
  to: zDateStr.optional(),
})
export type PlatformAuditLogListQuery = z.input<typeof PlatformAuditLogListQuerySchema>

// =============================================================================================
// Metrics dashboard
// =============================================================================================

const CountBySchema = <K extends z.ZodType>(key: K) =>
  z.array(z.object({ key, count: z.int().min(0) }))

const DueBucketSchema = z.object({ count: z.int().min(0), value_paise: zPaise })

export const VendorMetricsQuerySchema = z.object({
  months: zQueryInt(1, 36).default(12).describe('Months of revenue history'),
})
export type VendorMetricsQuery = z.input<typeof VendorMetricsQuerySchema>

/** GET /platform/metrics */
export const VendorMetricsSchema = z.object({
  generated_at: zTimestamp,
  kpis: z.object({
    mrr_paise: zPaise,
    license_revenue_this_month_paise: zPaise,
    active_licenses: z.int().min(0),
    amc_due_30d: z.int().min(0),
    /** Renewed ÷ due in the last 90 days, bp. */
    renewal_rate_bp: z.int().min(0).max(10_000),
    active_installs_7d: z.int().min(0),
  }),
  cloud: z.object({
    tenants_total: z.int().min(0),
    paying_tenants: z.int().min(0),
    trials_active: z.int().min(0),
    by_plan: CountBySchema(z.string()),
    by_status: CountBySchema(z.string()),
    by_business_type: CountBySchema(z.string()),
    by_state: CountBySchema(z.string()),
    mrr_paise: zPaise,
    signups_90d: z.array(z.object({ date: zDateStr, count: z.int().min(0) })),
    invoices_per_day: z.array(z.object({ date: zDateStr, count: z.int().min(0) })),
  }),
  onprem: z.object({
    active_licenses: z.int().min(0),
    by_edition: CountBySchema(z.string()),
    by_type: CountBySchema(LicenseTypeSchema),
    activations_active: z.int().min(0),
    check_ins_7d: z.int().min(0),
    version_adoption: z.array(z.object({ version: z.string(), count: z.int().min(0) })),
    renewals_due: z.object({ d30: DueBucketSchema, d60: DueBucketSchema, d90: DueBucketSchema }),
    renewal_rate_bp: z.int().min(0).max(10_000),
    top_districts: z.array(
      z.object({
        state_code: z.string(),
        district: z.string(),
        customers: z.int().min(0),
        active_licenses: z.int().min(0),
      }),
    ),
  }),
  revenue_by_month: z.array(
    z.object({ period: z.string(), onprem_paise: zPaise, cloud_paise: zPaise }),
  ),
  partner_revenue: z.array(
    z.object({
      partner_id: zId,
      partner_name: z.string(),
      revenue_paise: zPaise,
      commission_paise: zPaise,
    }),
  ),
  recent_orders: z.array(VendorOrderRowSchema),
})
export type VendorMetrics = z.output<typeof VendorMetricsSchema>

// =============================================================================================
// Customer 360
// =============================================================================================

export const VendorCustomerDetailSchema = VendorCustomerSchema.extend({
  partner: RefSchema.nullable(),
  tenant: z
    .object({ id: zId, name: z.string(), plan_code: z.string(), status: TenantStatusSchema })
    .nullable(),
  licenses: z.array(LicenseRowSchema),
  activations: z.array(ActivationSchema),
  orders: z.array(VendorOrderRowSchema),
  /** license_events of all the customer's licences, newest first (≤ 100). */
  timeline: z.array(LicenseEventSchema),
  referrals: z.object({ referral_code: z.string().nullable(), referred_customers: z.int().min(0) }),
  summary: z.object({
    lifetime_value_paise: zPaise,
    amc: AmcStatusSchema.nullable(),
    last_check_in_at: zTimestamp.nullable(),
    versions: z.array(z.string()),
  }),
})
export type VendorCustomerDetail = z.output<typeof VendorCustomerDetailSchema>

// =============================================================================================
// Public licensing API (shop servers)
// =============================================================================================

/**
 * POST /public/v1/licensing/activate — online activation, signed with the NEW installation key
 * (X-Kadai-Installation = installation_id; verified with installation_public_key from the body:
 * proof of possession). Re-activation of the same installation is idempotent (reactivated: true);
 * a known installation_id with another fingerprint → 409 clone_suspected.
 */
export const ActivateRequestSchema = InstallationIdentitySchema.extend({
  license_key: zLicenseKey,
})
export type ActivateRequest = z.input<typeof ActivateRequestSchema>

export const ActivateResponseSchema = z.object({
  /** kadai-license-v1 bound to the installation. */
  signed_license: SignedLicenseDocumentSchema,
  license_id: zId,
  activation_id: zId,
  key_prefix: z.string(),
  reactivated: z.boolean(),
  check_in_days: z.int().min(1),
  vendor: VendorPublicInfoSchema,
})
export type ActivateResponse = z.output<typeof ActivateResponseSchema>

/** POST /public/v1/licensing/offline-activate — the public /activate page. */
export const PublicOfflineActivateSchema = z.object({
  license_key: zLicenseKey,
  request: ActivationRequestInputSchema,
})
export type PublicOfflineActivate = z.input<typeof PublicOfflineActivateSchema>

/** Connect dashboard snapshot an opted-in shop pushes with its check-in (aggregates only). */
export const ConnectSnapshotSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.iso.datetime({ offset: true }),
  business_date: zDateStr,
  sales: z.object({
    today_paise: z.int(),
    yesterday_paise: z.int(),
    bills_today: z.int().min(0),
    bills_yesterday: z.int().min(0),
    returns_today_paise: zPaise,
    avg_bill_paise: zPaise,
  }),
  /** Today's collections by method. */
  collections: z.object({
    cash_paise: zPaise,
    upi_paise: zPaise,
    card_paise: zPaise,
    other_paise: zPaise,
    /** Sold on credit today (khata). */
    credit_paise: zPaise,
  }),
  dues: z.object({
    receivable_paise: z.int(),
    customers_with_due: z.int().min(0),
    overdue_paise: zPaise,
    payable_paise: z.int().optional(),
  }),
  stock: z.object({
    low_stock: z.int().min(0),
    out_of_stock: z.int().min(0),
    expiring_30d: z.int().min(0),
    expired: z.int().min(0),
  }),
  trend_7d: z
    .array(z.object({ date: zDateStr, sales_paise: z.int(), bills: z.int().min(0) }))
    .max(31),
  top_items: z
    .array(z.object({ name: z.string().max(200), qty_milli: z.int(), amount_paise: z.int() }))
    .max(10)
    .default([]),
  stores: z
    .array(
      z.object({
        code: z.string().max(8),
        name: z.string().max(200),
        sales_today_paise: z.int(),
        bills_today: z.int().min(0),
      }),
    )
    .max(50)
    .default([]),
  open_shifts: z.int().min(0).default(0),
})
export type ConnectSnapshot = z.output<typeof ConnectSnapshotSchema>

export const UpdateReportSchema = z.object({
  current_version: zSemver,
  /** Last host-updater run. */
  last_action: z.enum(['update', 'restore']).nullable(),
  last_state: z.enum(['done', 'rolled_back', 'failed']).nullable(),
  last_version: zSemver.nullable(),
  last_finished_at: z.iso.datetime({ offset: true }).nullable(),
  error: z.string().max(1000).nullable(),
})
export type UpdateReport = z.output<typeof UpdateReportSchema>

/** POST /public/v1/licensing/check-in (installation-signed). */
export const CheckInRequestSchema = z.object({
  /** licence payload license_id (= licenses.id). */
  license_id: zId,
  app_version: zSemver,
  channel: ReleaseChannelSchema.default('stable'),
  platform: ReleasePlatformSchema,
  os: z.string().trim().max(120).optional(),
  machine_name: z.string().trim().max(120).optional(),
  /** issued_at of the licence the shop holds; a newer server-side state → refreshed licence. */
  license_issued_at: z.iso.datetime({ offset: true }).nullable(),
  stats: InstallationStatsSchema,
  /** Opt-in flags of the installation (license_activations.connect_enabled / cloud_backup_enabled). */
  connect_enabled: z.boolean().default(false),
  cloud_backup_enabled: z.boolean().default(false),
  /** Only when the licence has 'connect' AND the owner opted in; otherwise omitted. */
  connect_snapshot: ConnectSnapshotSchema.nullable().optional(),
  update_status: UpdateReportSchema.nullable().optional(),
})
export type CheckInRequest = z.input<typeof CheckInRequestSchema>

/** A priced offer for this licence (renewal / upgrade / add-on), ready for renewal-checkout. */
export const OfferQuoteSchema = z.object({
  purpose: z.enum(['renewal', 'upgrade', 'addon']),
  offer: OfferPublicSchema.nullable(),
  items: z.array(z.object({ product_code: z.string(), qty: z.int().min(1) })),
  quote: PriceQuoteSchema,
})
export type OfferQuote = z.output<typeof OfferQuoteSchema>

export const RenewalInfoSchema = z.object({
  kind: z.enum(['amc', 'subscription']),
  due_on: zDateStr,
  amc: AmcStatusSchema,
  term: LicenseTermStatusSchema,
  items: z.array(z.object({ product_code: z.string(), qty: z.int().min(1) })),
  /** Best price today, incl. automatic offers and GST. */
  quote: PriceQuoteSchema,
  /** Online checkout possible (Razorpay configured on our side). */
  checkout_available: z.boolean(),
  /** Hosted renewal page (WhatsApp reminders), when available. */
  checkout_url: z.string().nullable(),
})
export type RenewalInfo = z.output<typeof RenewalInfoSchema>

export const AddonEntitlementsSchema = z.object({
  connect: z.object({
    licensed: z.boolean(),
    valid_until: zDateStr.nullable(),
    /** The last snapshot was stored (licensed + opted in). */
    snapshot_accepted: z.boolean(),
  }),
  cloud_backup: z.object({
    licensed: z.boolean(),
    valid_until: zDateStr.nullable(),
    quota_bytes: z.int().min(0),
    used_bytes: z.int().min(0),
    retention_days: z.int().min(1),
  }),
  relay: z.object({
    licensed: z.boolean(),
    period: z.string().describe("Calendar month 'YYYY-MM' (IST)"),
    used: z.int().min(0),
    quota: z.int().min(0),
  }),
})
export type AddonEntitlements = z.output<typeof AddonEntitlementsSchema>

export const ReleasePlanSchema = z.object({
  current_version: z.string(),
  updates_until: zDateStr.nullable(),
  /** Newer releases on the channel/platform, newest first (eligible flag on each). */
  releases: z.array(ReleaseInfoSchema),
  latest_eligible: ReleaseInfoSchema.nullable(),
  newest_ineligible: ReleaseInfoSchema.nullable(),
  /** planUpgrades().next_step version. */
  next_step: z.string().nullable(),
})
export type ReleasePlan = z.output<typeof ReleasePlanSchema>

export const CheckInResponseSchema = z.object({
  server_time: zTimestamp,
  next_check_in_seconds: z.int().min(60),
  /** Present when the vendor-side licence changed after license_issued_at (renewal, upgrade …). */
  license: SignedLicenseDocumentSchema.nullable(),
  license_status: VendorLicenseStatusSchema,
  activation_status: ActivationStatusSchema,
  banners: z.array(BannerSchema),
  offers: z.array(OfferQuoteSchema),
  renewal: RenewalInfoSchema.nullable(),
  releases: ReleasePlanSchema,
  entitlements: AddonEntitlementsSchema,
  vendor: VendorPublicInfoSchema,
})
export type CheckInResponse = z.output<typeof CheckInResponseSchema>

/** GET /public/v1/licensing/releases (installation-signed). */
export const ReleasesQuerySchema = z.object({
  channel: ReleaseChannelSchema.default('stable'),
  from_version: zSemver,
  platform: ReleasePlatformSchema.optional(),
})
export type ReleasesQuery = z.input<typeof ReleasesQuerySchema>

/** POST /public/v1/licensing/renewal-quote and …/renewal-checkout (installation-signed). */
export const RenewalRequestSchema = z.object({
  items: OrderItemsSchema.describe(
    'e.g. [{product_code: "amc_renewal"}] or an upgrade edition; priced for this licence',
  ),
  coupon_code: zOptionalCouponCode,
})
export type RenewalRequest = z.input<typeof RenewalRequestSchema>

export const RenewalQuoteResponseSchema = z.object({
  order_kind: VendorOrderKindSchema,
  quote: PriceQuoteSchema,
})
export type RenewalQuoteResponse = z.output<typeof RenewalQuoteResponseSchema>

export const RenewalCheckoutResponseSchema = z.object({
  order_id: zId,
  order_kind: VendorOrderKindSchema,
  quote: PriceQuoteSchema,
  total_paise: zPaise,
  /** Razorpay payment link — open in the browser; the extended licence comes with the next check-in. */
  payment_url: z.string(),
  expires_at: zTimestamp.nullable(),
})
export type RenewalCheckoutResponse = z.output<typeof RenewalCheckoutResponseSchema>

/** POST /public/v1/licensing/license/refresh (installation-signed). */
export const LicenseRefreshRequestSchema = z.object({
  license_id: zId,
  license_issued_at: z.iso.datetime({ offset: true }).nullable().default(null),
})
export type LicenseRefreshRequest = z.input<typeof LicenseRefreshRequestSchema>

export const LicenseRefreshResponseSchema = z.object({
  changed: z.boolean(),
  /** Always a freshly signed licence for this installation. */
  signed_license: SignedLicenseDocumentSchema,
  license_status: VendorLicenseStatusSchema,
})
export type LicenseRefreshResponse = z.output<typeof LicenseRefreshResponseSchema>

/** POST /public/v1/licensing/deactivate (installation-signed): "move to a new computer". */
export const SelfDeactivateRequestSchema = z.object({
  license_id: zId,
  reason: zNullableText(500),
})
export type SelfDeactivateRequest = z.input<typeof SelfDeactivateRequestSchema>

export const SelfDeactivateResponseSchema = z.object({
  deactivated_at: zTimestamp,
  transfers_last_365d: z.int().min(0),
  transfers_left: z.int().min(0),
})
export type SelfDeactivateResponse = z.output<typeof SelfDeactivateResponseSchema>

// ---- Kadai Connect ---------------------------------------------------------------------------

/** POST /public/v1/connect/otp/request — answers the same whether or not the phone is a licensee. */
export const ConnectOtpRequestSchema = z.object({ phone: zPhone })
export type ConnectOtpRequest = z.input<typeof ConnectOtpRequestSchema>

export const ConnectOtpVerifySchema = z.object({ phone: zPhone, code: OtpCodeSchema })
export type ConnectOtpVerify = z.input<typeof ConnectOtpVerifySchema>

export const ConnectSessionSchema = z.object({
  /** Send as X-Kadai-Connect-Token; scoped to licences whose customer phone verified the OTP. */
  connect_token: z.string(),
  expires_in: z.int().min(60),
  owner: z.object({ name: z.string(), business_name: z.string() }).nullable(),
})
export type ConnectSession = z.output<typeof ConnectSessionSchema>

export const ConnectShopSchema = z.object({
  activation_id: zId,
  business_name: z.string(),
  machine_name: z.string().nullable(),
  edition_name: z.string(),
  edition_name_ta: z.string().nullable(),
  /** The licence has Connect and the installation opted in. */
  connect_active: z.boolean(),
  last_check_in_at: zTimestamp.nullable(),
  snapshot_generated_at: zTimestamp.nullable(),
})
export type ConnectShop = z.output<typeof ConnectShopSchema>

export const ConnectShopParams = z.object({ activationId: zId })

export const ConnectShopSnapshotSchema = z.object({
  activation_id: zId,
  business_name: z.string(),
  generated_at: zTimestamp,
  received_at: zTimestamp,
  /** Older than CONNECT_SNAPSHOT_STALE_MINUTES (shop offline / PC off). */
  stale: z.boolean(),
  snapshot: ConnectSnapshotSchema,
})
export type ConnectShopSnapshot = z.output<typeof ConnectShopSnapshotSchema>

// ---- Cloud backup storage --------------------------------------------------------------------

export const CloudBackupSchema = z.object({
  id: zId,
  size_bytes: z.int().min(0),
  sha256: z.string(),
  status: CloudBackupStatusSchema,
  created_at: zTimestamp,
  expires_at: zTimestamp.nullable(),
})
export type CloudBackup = z.output<typeof CloudBackupSchema>

export const CloudBackupQuotaSchema = z.object({
  quota_bytes: z.int().min(0),
  used_bytes: z.int().min(0),
  retention_days: z.int().min(1),
})
export type CloudBackupQuota = z.output<typeof CloudBackupQuotaSchema>

/**
 * POST /public/v1/licensing/backups/upload-url (installation-signed, feature cloud_backup):
 * `sha256` / `size_bytes` are of the ENCRYPTED blob (we never hold the key). Over quota → 402
 * quota_exceeded.
 */
export const CloudBackupUploadRequestSchema = z.object({
  size_bytes: z
    .int()
    .min(1)
    .max(CLOUD_BACKUP_QUOTA_BYTES_PER_ADDON * 10),
  sha256: zSha256Hex,
  kind: BackupKindSchema.default('scheduled'),
})
export type CloudBackupUploadRequest = z.input<typeof CloudBackupUploadRequestSchema>

export const PresignedUrlSchema = z.object({
  url: z.string(),
  method: z.enum(['PUT', 'GET']),
  /** Headers the client must send with the request (e.g. Content-Type, x-amz-checksum-sha256). */
  headers: z.record(z.string(), z.string()),
  expires_at: zTimestamp,
})
export type PresignedUrl = z.output<typeof PresignedUrlSchema>

export const CloudBackupUploadResponseSchema = z.object({
  backup: CloudBackupSchema,
  upload: PresignedUrlSchema,
  quota: CloudBackupQuotaSchema,
})
export type CloudBackupUploadResponse = z.output<typeof CloudBackupUploadResponseSchema>

export const CloudBackupListResponseSchema = z.object({
  backups: z.array(CloudBackupSchema),
  quota: CloudBackupQuotaSchema,
})
export type CloudBackupListResponse = z.output<typeof CloudBackupListResponseSchema>

export const CloudBackupDownloadResponseSchema = z.object({
  backup: CloudBackupSchema,
  download: PresignedUrlSchema,
})
export type CloudBackupDownloadResponse = z.output<typeof CloudBackupDownloadResponseSchema>

const BackupIdParams = z.object({ id: zId })

// ---- Messaging relay -------------------------------------------------------------------------

/**
 * POST /public/v1/licensing/relay/messages (installation-signed): send a shop's SMS / WhatsApp /
 * email through OUR providers (no DLT / WhatsApp Business setup at the shop). Idempotent by
 * client_ref (the shop's notifications.id). Metered per licence & month (RELAY_MONTHLY_QUOTA);
 * over quota → 402 quota_exceeded; unknown template → 400 template_not_allowed.
 */
export const RelayMessageRequestSchema = z
  .object({
    channel: NotificationChannelSchema,
    template_code: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,63}$/),
    locale: LocaleSchema,
    /** E.164 phone (sms / whatsapp) or email address (email). */
    to: z.string().trim().min(3).max(254),
    recipient_name: z.string().trim().max(120).optional(),
    params: z.record(z.string().max(64), z.union([z.string().max(1000), z.number()])).default({}),
    client_ref: z.string().trim().min(8).max(100),
  })
  .refine(
    (v) =>
      v.channel === 'email' ? z.email().safeParse(v.to).success : zE164.safeParse(v.to).success,
    { message: 'recipient', path: ['to'] },
  )
export type RelayMessageRequest = z.input<typeof RelayMessageRequestSchema>

export const RelayMessageSchema = z.object({
  id: zId,
  client_ref: z.string(),
  channel: NotificationChannelSchema,
  template_code: z.string(),
  status: NotificationStatusSchema,
  error: z.string().nullable(),
  created_at: zTimestamp,
  sent_at: zTimestamp.nullable(),
  updated_at: zTimestamp,
  quota: z.object({ period: z.string(), used: z.int().min(0), quota: z.int().min(0) }),
})
export type RelayMessage = z.output<typeof RelayMessageSchema>

const RelayMessageParams = z.object({ id: zId })

// =============================================================================================
// Route catalogues
// =============================================================================================

const IdParams = z.object({ id: zId })
const vendor = (capability: VendorCapability | null) => ({ capability }) as const

/** Vendor console (/api/v1/platform/*) — cloud, KADAI_VENDOR_CONSOLE=true, platform staff. */
export const licensingRoutes = defineVendorRoutes({
  // ---- staff ---------------------------------------------------------------------------------
  me: {
    method: 'GET',
    path: '/platform/me',
    mode: 'cloud',
    vendor: vendor(null),
    response: dataOf(VendorMeSchema),
    summary: "The caller's staff role and capabilities (any active staff member)",
  },
  listStaff: {
    method: 'GET',
    path: '/platform/staff',
    mode: 'cloud',
    vendor: vendor('vendor.staff.manage'),
    query: StaffListQuerySchema,
    response: listOf(StaffMemberSchema),
  },
  createStaff: {
    method: 'POST',
    path: '/platform/staff',
    mode: 'cloud',
    vendor: vendor('vendor.staff.manage'),
    body: StaffCreateSchema,
    response: dataOf(StaffCreateResultSchema),
    status: 201,
    summary: 'Give a user a staff role (creates the user with a one-time password when new)',
  },
  updateStaff: {
    method: 'PATCH',
    path: '/platform/staff/:userId',
    mode: 'cloud',
    vendor: vendor('vendor.staff.manage'),
    params: StaffParams,
    body: StaffUpdateSchema,
    response: dataOf(StaffMemberSchema),
    summary: 'Change role / partner / active (owner & admin roles: owners only)',
  },
  listAuditLogs: {
    method: 'GET',
    path: '/platform/audit-logs',
    mode: 'cloud',
    vendor: vendor('vendor.audit.read'),
    query: PlatformAuditLogListQuerySchema,
    response: listOf(PlatformAuditLogSchema),
  },

  // ---- dashboard -----------------------------------------------------------------------------
  metrics: {
    method: 'GET',
    path: '/platform/metrics',
    mode: 'cloud',
    vendor: vendor('vendor.dashboard'),
    query: VendorMetricsQuerySchema,
    response: dataOf(VendorMetricsSchema),
    summary: 'Cloud + on-prem KPIs, revenue, renewals pipeline, version adoption',
  },

  // ---- price book ----------------------------------------------------------------------------
  listProducts: {
    method: 'GET',
    path: '/platform/products',
    mode: 'cloud',
    vendor: vendor('vendor.products.read'),
    query: LicenseProductListQuerySchema,
    response: listOf(LicenseProductSchema),
  },
  createProduct: {
    method: 'POST',
    path: '/platform/products',
    mode: 'cloud',
    vendor: vendor('vendor.products.write'),
    body: LicenseProductCreateSchema,
    response: dataOf(LicenseProductSchema),
    status: 201,
  },
  updateProduct: {
    method: 'PATCH',
    path: '/platform/products/:code',
    mode: 'cloud',
    vendor: vendor('vendor.products.write'),
    params: CodeParams,
    body: LicenseProductUpdateSchema,
    response: dataOf(LicenseProductSchema),
  },

  // ---- customers -----------------------------------------------------------------------------
  listCustomers: {
    method: 'GET',
    path: '/platform/customers',
    mode: 'cloud',
    vendor: vendor('vendor.customers.read'),
    query: VendorCustomerListQuerySchema,
    response: listOf(VendorCustomerRowSchema),
  },
  createCustomer: {
    method: 'POST',
    path: '/platform/customers',
    mode: 'cloud',
    vendor: vendor('vendor.customers.write'),
    body: VendorCustomerCreateSchema,
    response: dataOf(VendorCustomerSchema),
    status: 201,
    summary: 'Create a licensee (duplicate phone → 409 DUPLICATE {existing_id})',
  },
  getCustomer: {
    method: 'GET',
    path: '/platform/customers/:id',
    mode: 'cloud',
    vendor: vendor('vendor.customers.read'),
    params: IdParams,
    response: dataOf(VendorCustomerDetailSchema),
    summary: 'Customer 360: licences, activations, orders, AMC, timeline',
  },
  updateCustomer: {
    method: 'PATCH',
    path: '/platform/customers/:id',
    mode: 'cloud',
    vendor: vendor('vendor.customers.write'),
    params: IdParams,
    body: VendorCustomerUpdateSchema,
    response: dataOf(VendorCustomerSchema),
  },

  // ---- licences ------------------------------------------------------------------------------
  listLicenses: {
    method: 'GET',
    path: '/platform/licenses',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.read'),
    query: LicenseListQuerySchema,
    response: listOf(LicenseRowSchema),
  },
  issueLicense: {
    method: 'POST',
    path: '/platform/licenses',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.issue'),
    idempotent: true,
    body: LicenseIssueSchema,
    response: dataOf(LicenseKeyResultSchema),
    status: 201,
    summary: 'Issue a licence; the key is returned ONCE and sent to the customer',
  },
  getLicense: {
    method: 'GET',
    path: '/platform/licenses/:id',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.read'),
    params: IdParams,
    response: dataOf(LicenseDetailSchema),
  },
  updateLicense: {
    method: 'PATCH',
    path: '/platform/licenses/:id',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.manage'),
    params: IdParams,
    body: LicenseUpdateSchema,
    response: dataOf(LicenseDetailSchema),
  },
  listLicenseEvents: {
    method: 'GET',
    path: '/platform/licenses/:id/events',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.read'),
    params: IdParams,
    query: LicenseEventListQuerySchema,
    response: listOf(LicenseEventSchema),
  },
  suspendLicense: {
    method: 'POST',
    path: '/platform/licenses/:id/suspend',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.manage'),
    params: IdParams,
    body: LicenseReasonSchema,
    response: dataOf(LicenseDetailSchema),
  },
  resumeLicense: {
    method: 'POST',
    path: '/platform/licenses/:id/resume',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.manage'),
    params: IdParams,
    body: LicenseReasonSchema,
    response: dataOf(LicenseDetailSchema),
  },
  revokeLicense: {
    method: 'POST',
    path: '/platform/licenses/:id/revoke',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.manage'),
    params: IdParams,
    body: LicenseReasonSchema,
    response: dataOf(LicenseDetailSchema),
    summary: 'Revoke (refund / fraud): shops drop the licence on their next check-in',
  },
  reissueLicenseKey: {
    method: 'POST',
    path: '/platform/licenses/:id/reissue-key',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.manage'),
    params: IdParams,
    body: LicenseReissueKeySchema,
    response: dataOf(LicenseKeyResultSchema),
    summary: 'New key (we never store keys); existing activations keep working',
  },
  upgradeLicense: {
    method: 'POST',
    path: '/platform/licenses/:id/upgrade',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.issue'),
    params: IdParams,
    body: LicenseUpgradeSchema,
    response: dataOf(LicenseDetailSchema),
  },
  addLicenseAddon: {
    method: 'POST',
    path: '/platform/licenses/:id/addons',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.issue'),
    params: IdParams,
    body: LicenseAddonAddSchema,
    response: dataOf(LicenseDetailSchema),
  },
  renewLicense: {
    method: 'POST',
    path: '/platform/licenses/:id/renew',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.issue'),
    params: IdParams,
    body: LicenseRenewSchema,
    response: dataOf(LicenseDetailSchema),
    summary: 'Extend AMC / subscription / add-on from max(today, current end)',
  },
  offlineActivate: {
    method: 'POST',
    path: '/platform/licenses/offline-activate',
    mode: 'cloud',
    vendor: vendor('vendor.activations.manage'),
    body: StaffOfflineActivateSchema,
    response: dataOf(LicenseFileResultSchema),
    summary: "Activate from a shop's request file → signed licence file",
  },

  // ---- activations ---------------------------------------------------------------------------
  listActivations: {
    method: 'GET',
    path: '/platform/activations',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.read'),
    query: ActivationListQuerySchema,
    response: listOf(ActivationSchema),
  },
  deactivateActivation: {
    method: 'POST',
    path: '/platform/activations/:id/deactivate',
    mode: 'cloud',
    vendor: vendor('vendor.activations.manage'),
    params: IdParams,
    body: ActivationDeactivateSchema,
    response: dataOf(ActivationSchema),
    summary: 'Transfer: free the seat so the customer can activate a new PC',
  },
  blockActivation: {
    method: 'POST',
    path: '/platform/activations/:id/block',
    mode: 'cloud',
    vendor: vendor('vendor.licenses.manage'),
    params: IdParams,
    body: LicenseReasonSchema,
    response: dataOf(ActivationSchema),
    summary: 'Block a cloned / abusive installation',
  },
  activationLicenseFile: {
    method: 'GET',
    path: '/platform/activations/:id/license-file',
    mode: 'cloud',
    vendor: vendor('vendor.activations.manage'),
    params: IdParams,
    response: dataOf(LicenseFileResultSchema),
    summary: 'Re-download the signed licence of an activation (event license_downloaded)',
  },

  // ---- offers --------------------------------------------------------------------------------
  listOffers: {
    method: 'GET',
    path: '/platform/offers',
    mode: 'cloud',
    vendor: vendor('vendor.offers.read'),
    query: OfferListQuerySchema,
    response: listOf(OfferSchema),
  },
  createOffer: {
    method: 'POST',
    path: '/platform/offers',
    mode: 'cloud',
    vendor: vendor('vendor.offers.write'),
    body: OfferCreateSchema,
    response: dataOf(OfferSchema),
    status: 201,
  },
  getOffer: {
    method: 'GET',
    path: '/platform/offers/:id',
    mode: 'cloud',
    vendor: vendor('vendor.offers.read'),
    params: IdParams,
    response: dataOf(OfferSchema),
  },
  updateOffer: {
    method: 'PATCH',
    path: '/platform/offers/:id',
    mode: 'cloud',
    vendor: vendor('vendor.offers.write'),
    params: IdParams,
    body: OfferUpdateSchema,
    response: dataOf(OfferSchema),
  },
  listOfferRedemptions: {
    method: 'GET',
    path: '/platform/offers/:id/redemptions',
    mode: 'cloud',
    vendor: vendor('vendor.offers.read'),
    params: IdParams,
    query: PageQuerySchema,
    response: listOf(OfferRedemptionSchema),
  },
  validateOffer: {
    method: 'POST',
    path: '/platform/offers/validate',
    mode: 'cloud',
    vendor: vendor('vendor.orders.read'),
    body: OfferValidateSchema,
    response: dataOf(OfferValidateResultSchema),
    summary: 'Check a coupon for a buyer and items, with the resulting quote',
  },

  // ---- orders --------------------------------------------------------------------------------
  quoteOrder: {
    method: 'POST',
    path: '/platform/orders/quote',
    mode: 'cloud',
    vendor: vendor('vendor.orders.read'),
    body: VendorOrderQuoteSchema,
    response: dataOf(PriceQuoteSchema),
    summary: 'Price items for a buyer (offers, coupon, partner price, GST) without saving',
  },
  listOrders: {
    method: 'GET',
    path: '/platform/orders',
    mode: 'cloud',
    vendor: vendor('vendor.orders.read'),
    query: VendorOrderListQuerySchema,
    response: listOf(VendorOrderRowSchema),
  },
  createOrder: {
    method: 'POST',
    path: '/platform/orders',
    mode: 'cloud',
    vendor: vendor('vendor.orders.write'),
    idempotent: true,
    body: VendorOrderCreateSchema,
    response: dataOf(VendorOrderDetailSchema),
    status: 201,
  },
  getOrder: {
    method: 'GET',
    path: '/platform/orders/:id',
    mode: 'cloud',
    vendor: vendor('vendor.orders.read'),
    params: IdParams,
    response: dataOf(VendorOrderDetailSchema),
  },
  updateOrder: {
    method: 'PATCH',
    path: '/platform/orders/:id',
    mode: 'cloud',
    vendor: vendor('vendor.orders.write'),
    params: IdParams,
    body: VendorOrderUpdateSchema,
    response: dataOf(VendorOrderDetailSchema),
    summary: 'Edit a draft (re-priced) or move it to pending_payment',
  },
  createPaymentLink: {
    method: 'POST',
    path: '/platform/orders/:id/payment-link',
    mode: 'cloud',
    vendor: vendor('vendor.orders.write'),
    params: IdParams,
    body: PaymentLinkCreateSchema.prefault({}),
    response: dataOf(PaymentLinkSchema),
    summary: 'Razorpay payment link (POST /v1/payment_links) for a pending order',
  },
  markOrderPaid: {
    method: 'POST',
    path: '/platform/orders/:id/mark-paid',
    mode: 'cloud',
    vendor: vendor('vendor.orders.payments'),
    params: IdParams,
    body: OrderMarkPaidSchema,
    response: dataOf(VendorOrderDetailSchema),
    summary: 'Manual (UTR) / partner settlement → paid, numbered and fulfilled',
  },
  fulfilOrder: {
    method: 'POST',
    path: '/platform/orders/:id/fulfil',
    mode: 'cloud',
    vendor: vendor('vendor.orders.payments'),
    params: IdParams,
    response: dataOf(VendorOrderDetailSchema),
    summary: 'Retry fulfilment of a paid order',
  },
  cancelOrder: {
    method: 'POST',
    path: '/platform/orders/:id/cancel',
    mode: 'cloud',
    vendor: vendor('vendor.orders.write'),
    params: IdParams,
    body: LicenseReasonSchema,
    response: dataOf(VendorOrderDetailSchema),
    summary: 'Cancel a draft / pending order (expires its payment link)',
  },
  refundOrder: {
    method: 'POST',
    path: '/platform/orders/:id/refund',
    mode: 'cloud',
    vendor: vendor('vendor.orders.payments'),
    params: IdParams,
    body: OrderRefundSchema,
    response: dataOf(VendorOrderDetailSchema),
    summary: 'Mark refunded (voids the commission; optionally revokes the licence change)',
  },
  orderInvoice: {
    method: 'GET',
    path: '/platform/orders/:id/invoice',
    mode: 'cloud',
    vendor: vendor('vendor.orders.read'),
    params: IdParams,
    response: dataOf(VendorInvoicePrintSchema),
    summary: 'GST tax invoice print model (bilingual)',
  },

  // ---- partners & commissions ----------------------------------------------------------------
  listPartners: {
    method: 'GET',
    path: '/platform/partners',
    mode: 'cloud',
    vendor: vendor('vendor.partners.read'),
    query: PartnerListQuerySchema,
    response: listOf(PartnerRowSchema),
  },
  createPartner: {
    method: 'POST',
    path: '/platform/partners',
    mode: 'cloud',
    vendor: vendor('vendor.partners.write'),
    body: PartnerCreateSchema,
    response: dataOf(PartnerSchema),
    status: 201,
  },
  getPartner: {
    method: 'GET',
    path: '/platform/partners/:id',
    mode: 'cloud',
    vendor: vendor('vendor.partners.read'),
    params: IdParams,
    response: dataOf(PartnerDetailSchema),
  },
  updatePartner: {
    method: 'PATCH',
    path: '/platform/partners/:id',
    mode: 'cloud',
    vendor: vendor('vendor.partners.write'),
    params: IdParams,
    body: PartnerUpdateSchema,
    response: dataOf(PartnerSchema),
  },
  listCommissions: {
    method: 'GET',
    path: '/platform/commissions',
    mode: 'cloud',
    vendor: vendor('vendor.commissions.read'),
    query: CommissionListQuerySchema,
    response: listOf(CommissionSchema),
  },
  approveCommission: {
    method: 'POST',
    path: '/platform/commissions/:id/approve',
    mode: 'cloud',
    vendor: vendor('vendor.commissions.manage'),
    params: IdParams,
    response: dataOf(CommissionSchema),
  },
  payCommission: {
    method: 'POST',
    path: '/platform/commissions/:id/pay',
    mode: 'cloud',
    vendor: vendor('vendor.commissions.manage'),
    params: IdParams,
    body: CommissionPaySchema,
    response: dataOf(CommissionSchema),
  },

  // ---- releases ------------------------------------------------------------------------------
  listReleases: {
    method: 'GET',
    path: '/platform/releases',
    mode: 'cloud',
    vendor: vendor('vendor.releases.read'),
    query: ReleaseListQuerySchema,
    response: listOf(ReleaseSchema),
  },
  createRelease: {
    method: 'POST',
    path: '/platform/releases',
    mode: 'cloud',
    vendor: vendor('vendor.releases.write'),
    body: ReleaseCreateSchema,
    response: dataOf(ReleaseSchema),
    status: 201,
    summary: 'Publish a release; artifact signatures are made server-side',
  },
  getRelease: {
    method: 'GET',
    path: '/platform/releases/:id',
    mode: 'cloud',
    vendor: vendor('vendor.releases.read'),
    params: IdParams,
    response: dataOf(ReleaseSchema),
  },
  updateRelease: {
    method: 'PATCH',
    path: '/platform/releases/:id',
    mode: 'cloud',
    vendor: vendor('vendor.releases.write'),
    params: IdParams,
    body: ReleaseUpdateSchema,
    response: dataOf(ReleaseSchema),
  },

  // ---- announcements -------------------------------------------------------------------------
  listAnnouncements: {
    method: 'GET',
    path: '/platform/announcements',
    mode: 'cloud',
    vendor: vendor('vendor.announcements.read'),
    query: AnnouncementListQuerySchema,
    response: listOf(AnnouncementSchema),
  },
  createAnnouncement: {
    method: 'POST',
    path: '/platform/announcements',
    mode: 'cloud',
    vendor: vendor('vendor.announcements.write'),
    body: AnnouncementCreateSchema,
    response: dataOf(AnnouncementSchema),
    status: 201,
  },
  getAnnouncement: {
    method: 'GET',
    path: '/platform/announcements/:id',
    mode: 'cloud',
    vendor: vendor('vendor.announcements.read'),
    params: IdParams,
    response: dataOf(AnnouncementSchema),
  },
  updateAnnouncement: {
    method: 'PATCH',
    path: '/platform/announcements/:id',
    mode: 'cloud',
    vendor: vendor('vendor.announcements.write'),
    params: IdParams,
    body: AnnouncementUpdateSchema,
    response: dataOf(AnnouncementSchema),
  },

  // ---- cloud tenants & plans -----------------------------------------------------------------
  listTenants: {
    method: 'GET',
    path: '/platform/tenants',
    mode: 'cloud',
    vendor: vendor('vendor.tenants.read'),
    query: TenantAdminListQuerySchema,
    response: listOf(TenantAdminRowSchema),
  },
  getTenant: {
    method: 'GET',
    path: '/platform/tenants/:id',
    mode: 'cloud',
    vendor: vendor('vendor.tenants.read'),
    params: IdParams,
    response: dataOf(TenantAdminDetailSchema),
  },
  suspendTenant: {
    method: 'POST',
    path: '/platform/tenants/:id/suspend',
    mode: 'cloud',
    vendor: vendor('vendor.tenants.manage'),
    params: IdParams,
    body: TenantSuspendSchema,
    response: dataOf(TenantAdminDetailSchema),
    summary: 'Suspend a tenant (403 TENANT_SUSPENDED except billing); notifyAccessChanged',
  },
  resumeTenant: {
    method: 'POST',
    path: '/platform/tenants/:id/resume',
    mode: 'cloud',
    vendor: vendor('vendor.tenants.manage'),
    params: IdParams,
    body: TenantResumeSchema.prefault({}),
    response: dataOf(TenantAdminDetailSchema),
  },
  changeTenantPlan: {
    method: 'POST',
    path: '/platform/tenants/:id/plan',
    mode: 'cloud',
    vendor: vendor('vendor.tenants.manage'),
    params: IdParams,
    body: TenantPlanChangeSchema,
    response: dataOf(TenantAdminDetailSchema),
    summary: 'Manual plan / limits / period end (manual subscription; entitlements invalidated)',
  },
  listPlans: {
    method: 'GET',
    path: '/platform/plans',
    mode: 'cloud',
    vendor: vendor('vendor.tenants.read'),
    response: dataOf(z.array(PlanAdminSchema)),
    summary: 'All plans incl. non-public and on-prem editions',
  },
  updatePlan: {
    method: 'PUT',
    path: '/platform/plans/:code',
    mode: 'cloud',
    vendor: vendor('vendor.plans.write'),
    params: PlanCodeParams,
    body: PlanUpdateSchema,
    response: dataOf(PlanAdminSchema),
    summary: 'Edit a plan (entitlements of every tenant on it are invalidated)',
  },
})

const RL = {
  activation: { max: 10, window_seconds: 60, per: 'ip' },
  installation: { max: 60, window_seconds: 60, per: 'installation' },
  otp: { max: 3, window_seconds: 600, per: 'phone' },
  connect: { max: 120, window_seconds: 60, per: 'ip' },
} as const

/** Public licensing API (/public/v1/*) for shop servers, the /activate page and /connect. */
export const licensingPublicRoutes = defineLicensingPublicRoutes({
  activate: {
    method: 'POST',
    path: '/licensing/activate',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'license_key', rate_limit: RL.activation },
    body: ActivateRequestSchema,
    response: dataOf(ActivateResponseSchema),
    summary: 'Online activation (also signed with the new installation key)',
  },
  offlineActivate: {
    method: 'POST',
    path: '/licensing/offline-activate',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'license_key', rate_limit: RL.activation },
    body: PublicOfflineActivateSchema,
    response: dataOf(LicenseFileResultSchema),
    summary: 'Public /activate page: licence key + request file → licence file',
  },
  checkIn: {
    method: 'POST',
    path: '/licensing/check-in',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    body: CheckInRequestSchema,
    response: dataOf(CheckInResponseSchema),
    summary: 'Signed check-in: counts in; licence refresh, banners, offers, releases out',
  },
  releases: {
    method: 'GET',
    path: '/licensing/releases',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    query: ReleasesQuerySchema,
    response: dataOf(ReleasePlanSchema),
    summary: 'Releases newer than from_version with eligibility and signed artifacts',
  },
  renewalQuote: {
    method: 'POST',
    path: '/licensing/renewal-quote',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    body: RenewalRequestSchema,
    response: dataOf(RenewalQuoteResponseSchema),
    summary: 'Live price (offers, coupon, GST) of a renewal / upgrade / add-on for this licence',
  },
  renewalCheckout: {
    method: 'POST',
    path: '/licensing/renewal-checkout',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    body: RenewalRequestSchema,
    response: dataOf(RenewalCheckoutResponseSchema),
    status: 201,
    summary: 'Vendor order + Razorpay payment link paid from inside the shop app',
  },
  refreshLicense: {
    method: 'POST',
    path: '/licensing/license/refresh',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    body: LicenseRefreshRequestSchema,
    response: dataOf(LicenseRefreshResponseSchema),
    summary: 'Freshly signed licence (after a renewal / upgrade)',
  },
  deactivate: {
    method: 'POST',
    path: '/licensing/deactivate',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    body: SelfDeactivateRequestSchema,
    response: dataOf(SelfDeactivateResponseSchema),
    summary: 'Self-service transfer: free this installation (limited per year)',
  },
  backupUploadUrl: {
    method: 'POST',
    path: '/licensing/backups/upload-url',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    body: CloudBackupUploadRequestSchema,
    response: dataOf(CloudBackupUploadResponseSchema),
    status: 201,
    summary: 'Presigned PUT for an encrypted backup (quota & retention per add-on)',
  },
  backupComplete: {
    method: 'POST',
    path: '/licensing/backups/:id/complete',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    params: BackupIdParams,
    response: dataOf(CloudBackupSchema),
    summary: 'Confirm the upload (object size checked) → stored',
  },
  listBackups: {
    method: 'GET',
    path: '/licensing/backups',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    response: dataOf(CloudBackupListResponseSchema),
  },
  backupDownloadUrl: {
    method: 'POST',
    path: '/licensing/backups/:id/download-url',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    params: BackupIdParams,
    response: dataOf(CloudBackupDownloadResponseSchema),
  },
  deleteBackup: {
    method: 'DELETE',
    path: '/licensing/backups/:id',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    params: BackupIdParams,
    summary: 'Delete a stored backup (frees quota)',
  },
  relaySend: {
    method: 'POST',
    path: '/licensing/relay/messages',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    body: RelayMessageRequestSchema,
    response: dataOf(RelayMessageSchema),
    status: 202,
    summary: "Send a shop's SMS / WhatsApp / email through Kadai's providers (metered)",
  },
  relayStatus: {
    method: 'GET',
    path: '/licensing/relay/messages/:id',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'installation', rate_limit: RL.installation },
    params: RelayMessageParams,
    response: dataOf(RelayMessageSchema),
  },
  connectOtpRequest: {
    method: 'POST',
    path: '/connect/otp/request',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'none', rate_limit: RL.otp },
    body: ConnectOtpRequestSchema,
    response: dataOf(OtpRequestResponseSchema),
  },
  connectOtpVerify: {
    method: 'POST',
    path: '/connect/otp/verify',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'none', rate_limit: { max: 10, window_seconds: 60, per: 'ip' } },
    body: ConnectOtpVerifySchema,
    response: dataOf(ConnectSessionSchema),
  },
  connectShops: {
    method: 'GET',
    path: '/connect/shops',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'connect_token', rate_limit: RL.connect },
    response: dataOf(z.array(ConnectShopSchema)),
    summary: "The verified owner's shops (activations of licences owned by that phone)",
  },
  connectSnapshot: {
    method: 'GET',
    path: '/connect/shops/:activationId/snapshot',
    scope: 'public',
    auth: 'public',
    mode: 'cloud',
    licensing: { authn: 'connect_token', rate_limit: RL.connect },
    params: ConnectShopParams,
    response: dataOf(ConnectShopSnapshotSchema),
    summary: "Latest dashboard snapshot of one of the owner's shops (404 for anyone else's)",
  },
})
