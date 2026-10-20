/**
 * Typed tenant settings (`tenants.settings` JSON) with a default for every field.
 *
 *  - resolveSettings(stored)       → full settings; throws ZodError on invalid values (writes).
 *  - readSettings(stored)          → full settings; invalid/unknown values fall back to defaults
 *                                     field by field (reads of old/hand-edited JSON never fail).
 *  - mergeSettings(current, patch) → PATCH semantics: deep merge (arrays replace), then validate.
 *  - settingsPresetFor(type)       → vertical defaults applied by onboarding.
 */
import { z } from 'zod'
import type { BusinessType } from './enums'
import { GST_RATES_BP } from './gst'
import { ScaleBarcodeConfigSchema } from './scale'

export const PrintFormatSchema = z.enum(['thermal_80', 'thermal_58', 'a4'])
export type PrintFormat = z.infer<typeof PrintFormatSchema>

export const InvoiceSettingsSchema = z.object({
  /** Round the payable to the nearest rupee (|round off| ≤ 50 paise). */
  round_off: z.enum(['nearest_rupee', 'none']).default('nearest_rupee'),
  /** New products / ad-hoc items: prices include GST (typical MRP retail). */
  default_price_includes_tax: z.boolean().default(true),
  print_format: PrintFormatSchema.default('thermal_80'),
  /** Print Tamil and English (item names, labels, amount in words). */
  bilingual: z.boolean().default(true),
  show_hsn: z.boolean().default(true),
  show_mrp_savings: z.boolean().default(true),
  /** Print a UPI QR for the bill amount / balance due. */
  upi_qr_on_invoice: z.boolean().default(true),
  footer_text: z.string().trim().max(500).default('Thank you! Visit again.'),
  footer_text_ta: z.string().trim().max(500).default('நன்றி! மீண்டும் வருக.'),
  terms: z.string().trim().max(2000).default(''),
  copies: z.int().min(1).max(5).default(1),
})

export const InventorySettingsSchema = z.object({
  /** Small shops bill first and fix stock later; pharmacies usually disable this. */
  allow_negative_stock: z.boolean().default(true),
  /** First-expiry-first-out batch picking. */
  fefo: z.boolean().default(true),
  expiry_warning_days: z.int().min(0).max(730).default(90),
  block_expired_sale: z.boolean().default(true),
  low_stock_alerts: z.boolean().default(true),
})

export const PosSettingsSchema = z.object({
  scale_barcode: ScaleBarcodeConfigSchema.prefault({}),
  allow_price_edit: z.boolean().default(false),
  /** Cashier discount limit; above it needs sales.discount_override. */
  max_discount_bp_without_override: z.int().min(0).max(10_000).default(1000),
  require_customer_for_credit: z.boolean().default(true),
  default_payment_method: z.enum(['cash', 'upi', 'card']).default('cash'),
  sound: z.boolean().default(true),
  /** Product ids pinned as quick keys on the billing screen. */
  quick_keys: z.array(z.uuid()).max(60).default([]),
  /**
   * With plan feature `shifts`: a register must have an open shift before it can bill
   * (POS prompts to open one; the server answers 422 reason shift_required).
   */
  require_open_shift: z.boolean().default(false),
})

export const DrugScheduleSchema = z.enum(['OTC', 'G', 'H', 'H1', 'X'])
export type DrugSchedule = z.infer<typeof DrugScheduleSchema>

export const PharmacySettingsSchema = z.object({
  require_rx_for_schedules: z.array(DrugScheduleSchema).default(['H', 'H1', 'X']),
  h1_register: z.boolean().default(true),
})

export const LoyaltySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  points_per_100_rupees: z.int().min(0).max(10_000).default(1),
  point_value_paise: z.int().min(0).max(100_000).default(100),
  min_redeem_points: z.int().min(0).default(100),
  /** null = points never expire. */
  expiry_days: z.int().min(1).max(3650).nullable().default(null),
})

export const CreditSettingsSchema = z.object({
  default_credit_days: z.int().min(0).max(365).default(30),
  block_over_limit: z.boolean().default(true),
})

export const NotificationSettingsSchema = z.object({
  whatsapp_invoice: z.boolean().default(true),
  sms_invoice: z.boolean().default(false),
  /** Days overdue at which due reminders are sent. */
  due_reminder_days: z.array(z.int().min(1).max(365)).max(10).default([7, 15, 30]),
  daily_summary_to_owner: z.boolean().default(true),
  low_stock_digest: z.boolean().default(true),
})

export const PaymentSettingsSchema = z.object({
  intent_expiry_seconds: z.int().min(60).max(3600).default(600),
  /** Complete the POS bill automatically when the UPI payment is confirmed. */
  upi_auto_complete: z.boolean().default(true),
})

export const CatalogSettingsSchema = z.object({
  default_unit: z.string().trim().min(1).max(10).default('PCS'),
  default_gst_rate_bp: z.literal(GST_RATES_BP).nullable().default(null),
  default_track_batches: z.boolean().default(false),
  /** Generate an internal EAN-13 ('20…') for products without a barcode. */
  auto_generate_barcode: z.boolean().default(false),
  /** Give products created without a SKU the next `sku_prefix` + 5-digit number (P00042). */
  auto_sku: z.boolean().default(false),
  sku_prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{0,8}$/)
    .default('P'),
  /** Default variant axes offered when creating a variant product. */
  variant_axes: z.array(z.string().trim().min(1).max(30)).max(4).default([]),
})

export const SETTINGS_SECTIONS = {
  invoice: InvoiceSettingsSchema,
  inventory: InventorySettingsSchema,
  pos: PosSettingsSchema,
  pharmacy: PharmacySettingsSchema,
  loyalty: LoyaltySettingsSchema,
  credit: CreditSettingsSchema,
  notifications: NotificationSettingsSchema,
  payments: PaymentSettingsSchema,
  catalog: CatalogSettingsSchema,
} as const
export type SettingsSection = keyof typeof SETTINGS_SECTIONS

export const TenantSettingsSchema = z.object({
  invoice: InvoiceSettingsSchema.prefault({}),
  inventory: InventorySettingsSchema.prefault({}),
  pos: PosSettingsSchema.prefault({}),
  pharmacy: PharmacySettingsSchema.prefault({}),
  loyalty: LoyaltySettingsSchema.prefault({}),
  credit: CreditSettingsSchema.prefault({}),
  notifications: NotificationSettingsSchema.prefault({}),
  payments: PaymentSettingsSchema.prefault({}),
  catalog: CatalogSettingsSchema.prefault({}),
})
export type TenantSettings = z.output<typeof TenantSettingsSchema>
export type TenantSettingsInput = z.input<typeof TenantSettingsSchema>

/** Recursive partial for patches; arrays are replaced as a whole. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T
export type TenantSettingsPatch = DeepPartial<TenantSettings>

/**
 * Recursively makes every object field optional WITHOUT defaults. (Zod 4 `.partial()` keeps
 * defaults, so a PATCH of one field would otherwise reset its siblings.) Object-level
 * refinements are dropped here; mergeSettings() validates the merged result in full.
 */
function patchSchemaOf(schema: z.ZodType): z.ZodType {
  let inner: z.ZodType = schema
  while (inner instanceof z.ZodDefault || inner instanceof z.ZodPrefault)
    inner = inner.unwrap() as z.ZodType
  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType>
    return z.object(
      Object.fromEntries(
        Object.entries(shape).map(([key, field]) => [key, patchSchemaOf(field).optional()]),
      ),
    )
  }
  return inner
}

/** PATCH /settings body: any subset of sections/fields; nothing is defaulted. */
export const TenantSettingsPatchSchema = patchSchemaOf(
  TenantSettingsSchema,
) as z.ZodType<TenantSettingsPatch>

export const DEFAULT_SETTINGS: TenantSettings = Object.freeze(TenantSettingsSchema.parse({}))

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep merge: plain objects merge recursively, arrays and scalars replace, undefined is skipped. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : value
  }
  return out as T
}

/** Full settings from stored/partial JSON, filling defaults. @throws ZodError on invalid values. */
export function resolveSettings(partial: unknown = {}): TenantSettings {
  return TenantSettingsSchema.parse(deepMerge(DEFAULT_SETTINGS, partial ?? {}))
}

/** Applies a PATCH to current settings and validates the result. @throws ZodError. */
export function mergeSettings(
  current: TenantSettings,
  patch: TenantSettingsPatch | unknown,
): TenantSettings {
  return TenantSettingsSchema.parse(deepMerge(current, patch ?? {}))
}

/**
 * Lenient read for settings stored in the database: each field is validated on its own and
 * replaced by its default when invalid; unknown keys are dropped. Never throws.
 */
export function readSettings(stored: unknown): TenantSettings {
  const source = isPlainObject(stored) ? stored : {}
  const out: Record<string, unknown> = {}
  for (const [section, schema] of Object.entries(SETTINGS_SECTIONS) as Array<
    [SettingsSection, (typeof SETTINGS_SECTIONS)[SettingsSection]]
  >) {
    const raw = source[section]
    const values: Record<string, unknown> = {
      ...(DEFAULT_SETTINGS[section] as Record<string, unknown>),
    }
    if (isPlainObject(raw)) {
      for (const [field, value] of Object.entries(raw)) {
        if (!(field in values)) continue
        const parsed = (schema as z.ZodObject).partial().safeParse({ [field]: value })
        if (parsed.success) values[field] = (parsed.data as Record<string, unknown>)[field]
      }
    }
    out[section] = values
  }
  return TenantSettingsSchema.parse(out)
}

/** Vertical defaults applied on top of the global defaults when a tenant is created. */
export function settingsPresetFor(businessType: BusinessType): TenantSettingsPatch {
  switch (businessType) {
    case 'pharmacy':
      return {
        inventory: {
          allow_negative_stock: false,
          fefo: true,
          block_expired_sale: true,
          expiry_warning_days: 90,
        },
        pharmacy: { require_rx_for_schedules: ['H', 'H1', 'X'], h1_register: true },
        catalog: { default_unit: 'TAB', default_track_batches: true, default_gst_rate_bp: 500 },
        invoice: { show_hsn: true, show_mrp_savings: true },
        pos: { allow_price_edit: false },
      }
    case 'supermarket':
      return {
        pos: { scale_barcode: { enabled: true }, max_discount_bp_without_override: 500 },
        loyalty: { enabled: true },
        catalog: { auto_generate_barcode: true },
        notifications: { low_stock_digest: true },
      }
    case 'general_store':
      return {
        pos: { scale_barcode: { enabled: false } },
        credit: { default_credit_days: 30, block_over_limit: false },
        notifications: { due_reminder_days: [7, 15, 30] },
      }
    case 'apparel':
      return {
        catalog: { variant_axes: ['size', 'color'], auto_generate_barcode: true },
        invoice: {
          print_format: 'thermal_80',
          show_hsn: true,
          terms: 'Exchange within 7 days with bill. No returns on discounted items.',
        },
        inventory: { allow_negative_stock: false },
      }
    case 'footwear':
      return {
        catalog: { variant_axes: ['size', 'color'], auto_generate_barcode: true },
        inventory: { allow_negative_stock: false },
      }
    case 'electronics':
      return {
        invoice: {
          print_format: 'a4',
          show_hsn: true,
          terms: 'Warranty as per manufacturer terms. Goods once sold will not be taken back.',
        },
        inventory: { allow_negative_stock: false },
        credit: { block_over_limit: true },
      }
    case 'hardware':
      return {
        invoice: { print_format: 'a4' },
        catalog: { default_unit: 'PCS' },
        credit: { default_credit_days: 45 },
      }
    case 'bakery_sweets':
      return {
        pos: { scale_barcode: { enabled: true } },
        inventory: { allow_negative_stock: true, expiry_warning_days: 3 },
        catalog: { default_unit: 'KG' },
      }
    case 'stationery':
      return { catalog: { auto_generate_barcode: true } }
    case 'other':
      return {}
  }
}

/** Initial settings for a new tenant of a business type. */
export function initialSettingsFor(businessType: BusinessType): TenantSettings {
  return resolveSettings(settingsPresetFor(businessType))
}

/**
 * Weighing scale on a register's serial port (Web Serial, ARCHITECTURE.md §21.8). Common Indian
 * scales stream ASCII weight frames continuously ('ST,GS,  1.250kg', '   1.250') or answer a
 * request command. `weight_pattern` overrides the built-in parser: a regular expression whose
 * first capture group is the number.
 */
export const RegisterScaleSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  baud_rate: z
    .union([
      z.literal(1200),
      z.literal(2400),
      z.literal(4800),
      z.literal(9600),
      z.literal(19200),
      z.literal(38400),
      z.literal(57600),
      z.literal(115200),
    ])
    .default(9600),
  data_bits: z.union([z.literal(7), z.literal(8)]).default(8),
  stop_bits: z.union([z.literal(1), z.literal(2)]).default(1),
  parity: z.enum(['none', 'even', 'odd']).default('none'),
  flow_control: z.enum(['none', 'hardware']).default('none'),
  /** continuous = the scale streams frames; on_request = send `request_command` first. */
  protocol: z.enum(['continuous', 'on_request']).default('continuous'),
  /** e.g. 'W' or 'P' (sent followed by CR). */
  request_command: z.string().max(16).nullable().default(null),
  weight_pattern: z
    .string()
    .max(200)
    .nullable()
    .default(null)
    .refine(
      (p) => {
        if (p === null) return true
        try {
          new RegExp(p)
          return true
        } catch {
          return false
        }
      },
      { message: 'weight_pattern_invalid' },
    ),
  /** Unit of the number when the frame carries none. */
  weight_unit: z.enum(['kg', 'g']).default('kg'),
  /** Ignore frames the scale marks unstable ('US'). */
  stable_only: z.boolean().default(true),
})
export type RegisterScaleSettings = z.output<typeof RegisterScaleSettingsSchema>

/** Per-register (counter) settings, `registers.settings`. */
export const RegisterSettingsSchema = z.object({
  /** null = use the tenant invoice print format. */
  print_format: PrintFormatSchema.nullable().default(null),
  auto_print: z.boolean().default(true),
  customer_display: z.boolean().default(false),
  cash_drawer: z.boolean().default(false),
  printer_name: z.string().trim().max(100).nullable().default(null),
  /**
   * The counter browser runs with --kiosk-printing (Kadai desktop shortcut): print receipts
   * silently, without the print dialog flow.
   */
  silent_print: z.boolean().default(false),
  scale: RegisterScaleSettingsSchema.prefault({}),
})
export type RegisterSettings = z.output<typeof RegisterSettingsSchema>
