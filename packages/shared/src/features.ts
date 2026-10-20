/**
 * Plan features & limits (ARCHITECTURE.md §7.6, §21). Feature codes are exactly those used by the
 * plans seeded in migrations 0001 (cloud plans) and 0010 (on-prem editions) plus the add-on
 * features sold separately (ADDON_FEATURES); entitlements come from the plan (cloud) or the
 * license (onprem).
 */
import { z } from 'zod'

export const FEATURES = [
  'pos',
  'catalog',
  'inventory',
  'customers',
  'suppliers',
  'upi_static',
  'reports_basic',
  'gst_invoice',
  'khata',
  'purchases',
  'gst_reports',
  'upi_dynamic',
  'promotions',
  'loyalty',
  'batches_expiry',
  'variants',
  'notifications',
  'shifts',
  'accounting',
  'offline_pos',
  'barcode_labels',
  'multi_store',
  'stock_transfers',
  'advanced_reports',
  'custom_roles',
  'audit_log',
  'api_access',
  'store_pricing',
  'priority_support',
  // add-ons (license_products in 0010), not part of any plan
  'connect',
  'cloud_backup',
] as const
export type Feature = (typeof FEATURES)[number]

/** Features sold only as add-ons (Kadai Connect remote dashboard, encrypted cloud backup). */
export const ADDON_FEATURES = ['connect', 'cloud_backup'] as const satisfies readonly Feature[]

export const FeatureSchema = z.enum(FEATURES)

export function isFeature(code: unknown): code is Feature {
  return typeof code === 'string' && (FEATURES as readonly string[]).includes(code)
}

export const FEATURE_LABELS: Readonly<Record<Feature, { en: string; ta: string }>> = {
  pos: { en: 'Billing counter (POS)', ta: 'பில்லிங் கவுண்டர் (POS)' },
  catalog: { en: 'Products & prices', ta: 'பொருட்கள் & விலைகள்' },
  inventory: { en: 'Stock management', ta: 'சரக்கு நிர்வாகம்' },
  customers: { en: 'Customers', ta: 'வாடிக்கையாளர்கள்' },
  suppliers: { en: 'Suppliers', ta: 'சப்ளையர்கள்' },
  upi_static: { en: 'UPI QR (shop UPI ID)', ta: 'UPI QR (கடை UPI ஐடி)' },
  reports_basic: { en: 'Basic reports', ta: 'அடிப்படை அறிக்கைகள்' },
  gst_invoice: { en: 'GST invoices', ta: 'GST பில்கள்' },
  khata: { en: 'Credit book (khata)', ta: 'கடன் கணக்கு' },
  purchases: { en: 'Purchases', ta: 'கொள்முதல்' },
  gst_reports: { en: 'GST returns (GSTR-1, 3B)', ta: 'GST ரிட்டர்ன்கள் (GSTR-1, 3B)' },
  upi_dynamic: {
    en: 'Dynamic UPI QR with auto-confirmation',
    ta: 'தானியங்கி உறுதிப்படுத்தலுடன் டைனமிக் UPI QR',
  },
  promotions: { en: 'Offers & schemes', ta: 'சலுகைகள் & திட்டங்கள்' },
  loyalty: { en: 'Loyalty points', ta: 'விசுவாசப் புள்ளிகள்' },
  batches_expiry: { en: 'Batches & expiry', ta: 'பேட்ச் & காலாவதி' },
  variants: { en: 'Size / colour variants', ta: 'அளவு / நிற வகைகள்' },
  notifications: { en: 'WhatsApp & SMS', ta: 'வாட்ஸ்அப் & SMS' },
  shifts: { en: 'Shifts & cash closing', ta: 'ஷிஃப்ட் & ரொக்க முடிப்பு' },
  accounting: { en: 'Accounting', ta: 'கணக்கியல்' },
  offline_pos: { en: 'Offline billing', ta: 'இணையமின்றி பில்லிங்' },
  barcode_labels: { en: 'Barcode labels', ta: 'பார்கோடு லேபிள்கள்' },
  multi_store: { en: 'Multiple stores', ta: 'பல கிளைகள்' },
  stock_transfers: { en: 'Stock transfers', ta: 'சரக்கு மாற்றம்' },
  advanced_reports: { en: 'Advanced reports', ta: 'மேம்பட்ட அறிக்கைகள்' },
  custom_roles: { en: 'Custom roles', ta: 'தனிப்பயன் பொறுப்புகள்' },
  audit_log: { en: 'Audit log', ta: 'தணிக்கைப் பதிவு' },
  api_access: { en: 'API access', ta: 'API அணுகல்' },
  store_pricing: { en: 'Branch-wise pricing', ta: 'கிளை வாரியான விலை' },
  priority_support: { en: 'Priority support', ta: 'முன்னுரிமை ஆதரவு' },
  connect: { en: 'Kadai Connect (remote owner dashboard)', ta: 'கடை கனெக்ட் (தொலைதூர டாஷ்போர்டு)' },
  cloud_backup: { en: 'Encrypted cloud backup', ta: 'மறைகுறியாக்கப்பட்ட கிளவுட் காப்புப்பிரதி' },
}

/** Alias of {@link FEATURE_LABELS}. */
export const featureLabels = FEATURE_LABELS

export const LIMIT_METRICS = [
  'stores',
  'users',
  'registers',
  'products',
  'invoices_per_month',
] as const
export type LimitMetric = (typeof LIMIT_METRICS)[number]

/** null = unlimited. */
export type PlanLimits = Record<LimitMetric, number | null>

export const PlanLimitsSchema = z.object({
  stores: z.int().min(0).nullable(),
  users: z.int().min(0).nullable(),
  registers: z.int().min(0).nullable(),
  products: z.int().min(0).nullable(),
  invoices_per_month: z.int().min(0).nullable(),
})

export const LIMIT_LABELS: Readonly<Record<LimitMetric, { en: string; ta: string }>> = {
  stores: { en: 'Stores', ta: 'கிளைகள்' },
  users: { en: 'Users', ta: 'பயனர்கள்' },
  registers: { en: 'Billing counters', ta: 'பில்லிங் கவுண்டர்கள்' },
  products: { en: 'Products', ta: 'பொருட்கள்' },
  invoices_per_month: { en: 'Bills per month', ta: 'மாதாந்திர பில்கள்' },
}

export const EntitlementSourceSchema = z.enum(['plan', 'license'])
export type EntitlementSource = z.infer<typeof EntitlementSourceSchema>

export const EntitlementsSchema = z.object({
  plan_code: z.string(),
  features: z.array(FeatureSchema),
  limits: PlanLimitsSchema,
  source: EntitlementSourceSchema,
  /** Subscription period end / license expiry (ISO timestamp), when bounded. */
  valid_until: z.string().nullable().optional(),
})
export type Entitlements = z.infer<typeof EntitlementsSchema>

export function hasFeature(
  entitlements: Pick<Entitlements, 'features'>,
  feature: Feature,
): boolean {
  return entitlements.features.includes(feature)
}

/** True when one more item may be created: `current` is the count before creating. */
export function isWithinLimit(limits: PlanLimits, metric: LimitMetric, current: number): boolean {
  const limit = limits[metric]
  return limit === null || current < limit
}

// Default plans, mirroring the seed in migration 0001 (the database stays the source of truth
// for prices; these drive the on-prem license default and the pricing page fallback).
export const CLOUD_PLAN_CODES = ['free', 'growth', 'pro', 'enterprise'] as const
/** Kadai Server editions (migration 0010); referenced by on-prem licenses' plan_code. */
export const ONPREM_PLAN_CODES = [
  'onprem_starter',
  'onprem_standard',
  'onprem_pro',
  'onprem_enterprise',
] as const
export const PLAN_CODES = [...CLOUD_PLAN_CODES, ...ONPREM_PLAN_CODES] as const
export type PlanCode = (typeof PLAN_CODES)[number]
export type CloudPlanCode = (typeof CLOUD_PLAN_CODES)[number]
export type OnPremPlanCode = (typeof ONPREM_PLAN_CODES)[number]

const FREE: readonly Feature[] = [
  'pos',
  'catalog',
  'inventory',
  'customers',
  'suppliers',
  'upi_static',
  'reports_basic',
  'gst_invoice',
  'khata',
]
const GROWTH: readonly Feature[] = [
  ...FREE,
  'purchases',
  'gst_reports',
  'upi_dynamic',
  'promotions',
  'loyalty',
  'batches_expiry',
  'variants',
  'notifications',
  'shifts',
  'accounting',
  'offline_pos',
  'barcode_labels',
]
const PRO: readonly Feature[] = [
  ...GROWTH,
  'multi_store',
  'stock_transfers',
  'advanced_reports',
  'custom_roles',
  'audit_log',
  'api_access',
  'store_pricing',
]

const ONPREM_STARTER: readonly Feature[] = [
  ...FREE,
  'purchases',
  'gst_reports',
  'batches_expiry',
  'variants',
  'barcode_labels',
  'shifts',
  'offline_pos',
]

export const DEFAULT_PLAN_FEATURES: Readonly<Record<PlanCode, readonly Feature[]>> = {
  free: FREE,
  growth: GROWTH,
  pro: PRO,
  enterprise: [...PRO, 'priority_support'],
  onprem_starter: ONPREM_STARTER,
  onprem_standard: GROWTH,
  onprem_pro: PRO,
  onprem_enterprise: [...PRO, 'priority_support'],
}

export const DEFAULT_PLAN_LIMITS: Readonly<Record<PlanCode, PlanLimits>> = {
  free: { stores: 1, users: 2, registers: 1, products: 1000, invoices_per_month: 300 },
  growth: { stores: 1, users: 5, registers: 3, products: null, invoices_per_month: null },
  pro: { stores: 5, users: 25, registers: 15, products: null, invoices_per_month: null },
  enterprise: {
    stores: null,
    users: null,
    registers: null,
    products: null,
    invoices_per_month: null,
  },
  onprem_starter: { stores: 1, users: 3, registers: 1, products: null, invoices_per_month: null },
  onprem_standard: { stores: 1, users: 10, registers: 3, products: null, invoices_per_month: null },
  onprem_pro: { stores: 3, users: 30, registers: 10, products: null, invoices_per_month: null },
  onprem_enterprise: {
    stores: null,
    users: null,
    registers: null,
    products: null,
    invoices_per_month: null,
  },
}

/** On-prem licenses without a plan_code (pre-0010 documents) get the Pro edition (PRODUCT.md). */
export const DEFAULT_LICENSE_PLAN: PlanCode = 'onprem_pro'
