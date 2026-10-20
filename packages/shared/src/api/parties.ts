/**
 * Contract for the parties module — docs/API.md "parties": customers & khata (credit book),
 * suppliers, prescribing doctors and loyalty points.
 *
 * Balances: customers.balance_paise is the receivable (+ = the customer owes the shop),
 * suppliers.balance_paise the payable (+ = the shop owes the supplier). Both are changed ONLY by
 * core ledger posting; opening balances are journals (source 'opening'). Statements are built
 * from journal_lines of the party on the receivable / payable account (buildLedgerStatement).
 * Loyalty maths (earn / redeem) lives here and is used by core/loyalty.ts and the POS.
 */
import { z } from 'zod'
import {
  CustomerTypeSchema,
  JournalSourceTypeSchema,
  LoyaltyKindSchema,
  PartyTypeSchema,
  PaymentIntentStatusSchema,
  PriceTierSchema,
  type PartyType,
} from '../enums'
import { addDays, addPeriods, compareDates, periodOf } from '../fy'
import { isValidVpa, normalizeVpa } from '../upi'
import { panFromGstin } from '../gst'
import type { TenantSettings } from '../settings'
import {
  AddressSchema,
  PageQuerySchema,
  dataOf,
  defineRoutes,
  listOf,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zE164,
  zId,
  zPaise,
  zPeriod,
  zPhone,
  zSearchQuery,
  zSignedPaise,
  zStateCode,
  zTimestamp,
} from './common'
import {
  DeleteResultSchema,
  ExportFormatSchema,
  type ImportColumnDef,
  ImportJobSchema,
  ImportRequestBaseSchema,
  toCsv,
  zIfUpdatedAt,
  zNullableEmail,
  zNullableGstin,
  zNullablePan,
  zNullablePhone,
  zNullableText,
  zQueryIds,
  zTags,
} from './identity'

// =============================================================================================
// Validation keys (custom rules)
// =============================================================================================

export const PARTIES_VALIDATION_KEYS = [
  'phone',
  'alt_phone',
  'gstin',
  'gstin_state',
  'pan',
  'pan_gstin_mismatch',
  'email',
  'ifsc',
  'bank_account_number',
  'vpa',
  'date_order',
  'loyalty_points_zero',
  'loyalty_disabled',
  'loyalty_below_minimum',
  'loyalty_insufficient',
  'loyalty_exceeds_bill',
  'empty_patch',
] as const
export type PartiesValidationKey = (typeof PARTIES_VALIDATION_KEYS)[number]

const notEmpty = (v: Record<string, unknown>) =>
  Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at')

/** Signed opening balance bound (± ₹1,000 crore). */
const zOpeningBalance = z.int().min(-1e13).max(1e13)

const zAltPhone = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || /^[0-9+\-\s()]{6,20}$/.test(v), { message: 'alt_phone' })
  .transform((v) => (v === '' ? null : v))

/** State from the GSTIN when not given; null/undefined preserved otherwise. */
export function deriveStateCode<T extends { gstin?: string | null; state_code?: string | null }>(
  v: T,
): T {
  if (v.gstin && (v.state_code === undefined || v.state_code === null))
    return { ...v, state_code: v.gstin.slice(0, 2) }
  return v
}

function refineTaxIds(
  v: { gstin?: string | null; state_code?: string | null; pan?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (v.gstin && v.state_code && v.gstin.slice(0, 2) !== v.state_code)
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'gstin_state' })
  if (v.gstin && v.pan && panFromGstin(v.gstin) !== v.pan)
    ctx.addIssue({ code: 'custom', path: ['pan'], message: 'pan_gstin_mismatch' })
}

// =============================================================================================
// Customers
// =============================================================================================

export const CustomerListItemSchema = z.object({
  id: zId,
  code: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  phone: zE164.nullable(),
  gstin: z.string().nullable(),
  state_code: z.string().nullable(),
  customer_type: CustomerTypeSchema,
  price_tier: PriceTierSchema,
  /** Receivable: + = owes the shop (due), − = credit balance / advance. */
  balance_paise: zSignedPaise,
  credit_limit_paise: zPaise.nullable(),
  /** null = settings.credit.default_credit_days. */
  credit_days: z.int().min(0).nullable(),
  /** Σ due of invoices older than the effective credit days. */
  overdue_paise: zPaise,
  loyalty_points: z.int().min(0),
  tags: z.array(z.string()),
  whatsapp_opt_in: z.boolean(),
  is_active: z.boolean(),
  /** invoice_at of the latest completed invoice ("last visit"). */
  last_invoice_at: zTimestamp.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type CustomerListItem = z.output<typeof CustomerListItemSchema>

export const CustomerSchema = CustomerListItemSchema.extend({
  alt_phone: z.string().nullable(),
  email: z.string().nullable(),
  address: AddressSchema,
  opening_balance_paise: zSignedPaise,
  date_of_birth: zDateStr.nullable(),
  anniversary: zDateStr.nullable(),
  notes: z.string().nullable(),
  created_by: zId.nullable(),
})
export type Customer = z.output<typeof CustomerSchema>

export const CustomerListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Name / Tamil name, phone digits, GSTIN or code'),
  has_due: zBooleanQuery.optional().describe('balance_paise > 0'),
  overdue: zBooleanQuery.optional().describe('overdue_paise > 0'),
  credit: zBooleanQuery.optional().describe('balance_paise < 0 (credit balance / advance)'),
  tag: z.string().trim().toLowerCase().min(1).max(30).optional(),
  customer_type: CustomerTypeSchema.optional(),
  is_active: zBooleanQuery.optional(),
  ids: zQueryIds.optional(),
  sort: sortQuery(['name', 'balance_paise', 'last_invoice_at', 'created_at'] as const).prefault(
    'name',
  ),
})
export type CustomerListQuery = z.input<typeof CustomerListQuerySchema>

/** POST /customers. Duplicate phone → 409 DUPLICATE with details.existing_id. */
export const CustomerCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    name_ta: zNullableText(200),
    code: zNullableText(20),
    phone: zNullablePhone,
    alt_phone: zAltPhone,
    email: zNullableEmail,
    gstin: zNullableGstin,
    /** Derived from the GSTIN when omitted. */
    state_code: zStateCode.nullable().optional(),
    address: AddressSchema.prefault({}),
    customer_type: CustomerTypeSchema.default('retail'),
    /** Default: wholesale for wholesale customers, else retail. */
    price_tier: PriceTierSchema.optional(),
    credit_limit_paise: zPaise.nullable().default(null).describe('null = no limit'),
    credit_days: z.int().min(0).max(365).nullable().default(null),
    opening_balance_paise: zOpeningBalance
      .default(0)
      .describe('Old khata balance: + = customer owes the shop, − = advance held'),
    date_of_birth: zDateStr.nullable().default(null),
    anniversary: zDateStr.nullable().default(null),
    notes: zNullableText(1000),
    tags: zTags.default([]),
    whatsapp_opt_in: z.boolean().default(true),
  })
  .superRefine(refineTaxIds)
  .transform((v) => {
    const out = deriveStateCode(v)
    return {
      ...out,
      price_tier: out.price_tier ?? (out.customer_type === 'wholesale' ? 'wholesale' : 'retail'),
    }
  })
export type CustomerCreate = z.input<typeof CustomerCreateSchema>
export type CustomerCreateParsed = z.output<typeof CustomerCreateSchema>

/**
 * PATCH /customers/:id. A changed opening_balance_paise posts the delta as an adjusting journal
 * (audited); balance_paise is never written directly.
 */
export const CustomerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    name_ta: zNullableText(200),
    code: zNullableText(20),
    phone: zNullablePhone,
    alt_phone: zAltPhone,
    email: zNullableEmail,
    gstin: zNullableGstin,
    state_code: zStateCode.nullable().optional(),
    address: AddressSchema.optional(),
    customer_type: CustomerTypeSchema.optional(),
    price_tier: PriceTierSchema.optional(),
    credit_limit_paise: zPaise.nullable().optional(),
    credit_days: z.int().min(0).max(365).nullable().optional(),
    opening_balance_paise: zOpeningBalance.optional(),
    date_of_birth: zDateStr.nullable().optional(),
    anniversary: zDateStr.nullable().optional(),
    notes: zNullableText(1000),
    tags: zTags.optional(),
    whatsapp_opt_in: z.boolean().optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine(refineTaxIds)
  .refine(notEmpty, { message: 'empty_patch' })
  .transform(deriveStateCode)
export type CustomerUpdate = z.input<typeof CustomerUpdateSchema>

/** GET /customers/lookup?phone= — exact (normalised) match; 404 when none. */
export const CustomerLookupQuerySchema = z.object({ phone: zPhone })
export type CustomerLookupQuery = z.input<typeof CustomerLookupQuerySchema>

// ---- credit & dues helpers ------------------------------------------------------------------

/** Credit days that apply to a customer (own value, else the settings default). */
export function effectiveCreditDays(
  credit_days: number | null | undefined,
  settings: Pick<TenantSettings, 'credit'>,
): number {
  return credit_days ?? settings.credit.default_credit_days
}

/** Due date of an invoice: invoice date + credit days. */
export function invoiceDueDate(invoice_date: string, credit_days: number): string {
  return addDays(invoice_date, credit_days)
}

/** An unpaid invoice is overdue when today is after its due date. */
export function isInvoiceOverdue(
  invoice_date: string,
  credit_days: number,
  today: string,
): boolean {
  return compareDates(today, invoiceDueDate(invoice_date, credit_days)) > 0
}

/**
 * Credit check for a sale on credit: `additional_paise` more on top of the current balance.
 * No limit (null) always allows. `exceeded_by_paise` > 0 → CREDIT_LIMIT_EXCEEDED when
 * settings.credit.block_over_limit.
 */
export function creditCheck(input: {
  balance_paise: number
  credit_limit_paise: number | null
  additional_paise: number
}): { allowed: boolean; available_paise: number | null; exceeded_by_paise: number } {
  if (input.credit_limit_paise === null)
    return { allowed: true, available_paise: null, exceeded_by_paise: 0 }
  const available = input.credit_limit_paise - input.balance_paise
  const exceeded = Math.max(0, input.additional_paise - Math.max(0, available))
  return { allowed: exceeded === 0, available_paise: available, exceeded_by_paise: exceeded }
}

// =============================================================================================
// Ledger statements (khata) — customers and suppliers
// =============================================================================================

export const PartyLedgerQuerySchema = z
  .object({
    from: zDateStr.optional().describe('Default: the first entry (opening balance = 0)'),
    to: zDateStr.optional().describe('Default: today'),
    format: ExportFormatSchema.default('json').describe(
      'csv → text/csv download of the same statement',
    ),
  })
  .refine((r) => !r.from || !r.to || r.from <= r.to, { message: 'date_order', path: ['to'] })
export type PartyLedgerQuery = z.input<typeof PartyLedgerQuerySchema>

/** Most statement rows returned; beyond it `truncated` is true (narrow the range). */
export const LEDGER_MAX_ROWS = 5000

export const PartyLedgerRowSchema = z.object({
  entry_id: zId,
  date: zDateStr,
  source_type: JournalSourceTypeSchema,
  source_id: zId.nullable(),
  /** Number of the source document (invoice, credit note, receipt / voucher, bill, debit note). */
  document_number: z.string().nullable(),
  /** Narration / memo / payment reference. */
  description: z.string().nullable(),
  debit_paise: zPaise,
  credit_paise: zPaise,
  /** Running balance after this row, in the party's sign convention. */
  balance_paise: zSignedPaise,
})
export type PartyLedgerRow = z.output<typeof PartyLedgerRowSchema>

export const PartyLedgerSchema = z.object({
  party: z.object({
    type: PartyTypeSchema,
    id: zId,
    name: z.string(),
    name_ta: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  from: zDateStr.nullable(),
  to: zDateStr,
  /** Balance before `from` (customers: + owes; suppliers: + shop owes). */
  opening_balance_paise: zSignedPaise,
  total_debit_paise: zPaise,
  total_credit_paise: zPaise,
  closing_balance_paise: zSignedPaise,
  rows: z.array(PartyLedgerRowSchema),
  truncated: z.boolean(),
})
export type PartyLedger = z.output<typeof PartyLedgerSchema>

/** Signed effect of a line on the party balance: receivable debit − credit, payable credit − debit. */
export function partyBalanceEffect(
  party_type: PartyType,
  debit_paise: number,
  credit_paise: number,
): number {
  return party_type === 'customer' ? debit_paise - credit_paise : credit_paise - debit_paise
}

/**
 * Builds a statement from the opening balance and the entries in the window (in date / posting
 * order): running balances, totals and closing balance. Used by the server and for printing.
 */
export function buildLedgerStatement<T extends { debit_paise: number; credit_paise: number }>(
  party_type: PartyType,
  opening_balance_paise: number,
  entries: readonly T[],
): {
  rows: Array<T & { balance_paise: number }>
  total_debit_paise: number
  total_credit_paise: number
  closing_balance_paise: number
} {
  let balance = opening_balance_paise
  let debit = 0
  let credit = 0
  const rows = entries.map((e) => {
    debit += e.debit_paise
    credit += e.credit_paise
    balance += partyBalanceEffect(party_type, e.debit_paise, e.credit_paise)
    return { ...e, balance_paise: balance }
  })
  return {
    rows,
    total_debit_paise: debit,
    total_credit_paise: credit,
    closing_balance_paise: balance,
  }
}

// =============================================================================================
// Customer summary (khata page header & insights)
// =============================================================================================

export const CustomerSummarySchema = z.object({
  customer_id: zId,
  lifetime_sales_paise: zPaise,
  invoice_count: z.int().min(0),
  returns_paise: zPaise,
  average_bill_paise: zPaise,
  first_invoice_at: zTimestamp.nullable(),
  last_invoice_at: zTimestamp.nullable(),
  /** Last 12 months, oldest first, zero months included (monthlySeries). */
  monthly: z.array(
    z.object({ period: zPeriod, sales_paise: zPaise, invoice_count: z.int().min(0) }),
  ),
  top_items: z.array(
    z.object({
      product_id: zId.nullable(),
      name: z.string(),
      name_ta: z.string().nullable(),
      unit: z.string(),
      qty_milli: z.int(),
      amount_paise: zPaise,
      invoice_count: z.int().min(0),
    }),
  ),
  balance_paise: zSignedPaise,
  overdue_paise: zPaise,
  overdue_invoice_count: z.int().min(0),
  oldest_due_date: zDateStr.nullable(),
  credit_limit_paise: zPaise.nullable(),
  /** credit_limit − balance (null without a limit). */
  credit_available_paise: zSignedPaise.nullable(),
  /** Effective credit days. */
  credit_days: z.int().min(0),
  loyalty_points: z.int().min(0),
  loyalty_value_paise: zPaise,
  /** Unpaid payment links (payment_intents kind 'link') for this customer. */
  open_payment_links: z.array(
    z.object({
      id: zId,
      amount_paise: zPaise,
      status: PaymentIntentStatusSchema,
      short_url: z.string().nullable(),
      reference_code: z.string(),
      created_at: zTimestamp,
      expires_at: zTimestamp.nullable(),
    }),
  ),
})
export type CustomerSummary = z.output<typeof CustomerSummarySchema>

/** Zero-filled monthly series of `count` periods ending with `endPeriod` (oldest first). */
export function monthlySeries(
  rows: readonly { period: string; sales_paise: number; invoice_count: number }[],
  endPeriod: string,
  count = 12,
): Array<{ period: string; sales_paise: number; invoice_count: number }> {
  const byPeriod = new Map(rows.map((r) => [r.period, r]))
  return Array.from({ length: count }, (_, i) => {
    const period = addPeriods(endPeriod, i - (count - 1))
    const r = byPeriod.get(period)
    return { period, sales_paise: r?.sales_paise ?? 0, invoice_count: r?.invoice_count ?? 0 }
  })
}

/** Current period ('YYYY-MM') of a business date. */
export const periodOfDate = periodOf

// =============================================================================================
// Loyalty (feature loyalty; points maths from settings.loyalty)
// =============================================================================================

type LoyaltySettings = TenantSettings['loyalty']

/** Points earned on a bill amount: floor(amount × points_per_100_rupees / ₹100); 0 when disabled. */
export function loyaltyPointsForAmount(amount_paise: number, settings: LoyaltySettings): number {
  if (!settings.enabled || amount_paise <= 0 || settings.points_per_100_rupees <= 0) return 0
  return Math.floor((amount_paise * settings.points_per_100_rupees) / 10_000)
}

/** Rupee value of points (paise). */
export function loyaltyValuePaise(points: number, settings: LoyaltySettings): number {
  return Math.max(0, points) * settings.point_value_paise
}

/** Most points redeemable on a bill (0 when disabled, below the minimum or nothing to pay). */
export function maxRedeemablePoints(input: {
  balance_points: number
  bill_total_paise: number
  settings: LoyaltySettings
}): number {
  const s = input.settings
  if (!s.enabled || s.point_value_paise <= 0 || input.balance_points <= 0) return 0
  const byBill = Math.floor(Math.max(0, input.bill_total_paise) / s.point_value_paise)
  const max = Math.min(input.balance_points, byBill)
  return max >= s.min_redeem_points ? max : 0
}

/** Why a redemption is not allowed (validation key) or null. */
export function loyaltyRedeemIssue(input: {
  points: number
  balance_points: number
  settings: LoyaltySettings
  bill_total_paise?: number
}):
  | 'loyalty_disabled'
  | 'loyalty_points_zero'
  | 'loyalty_below_minimum'
  | 'loyalty_insufficient'
  | 'loyalty_exceeds_bill'
  | null {
  const s = input.settings
  if (!s.enabled) return 'loyalty_disabled'
  if (!Number.isSafeInteger(input.points) || input.points <= 0) return 'loyalty_points_zero'
  if (input.points < s.min_redeem_points) return 'loyalty_below_minimum'
  if (input.points > input.balance_points) return 'loyalty_insufficient'
  if (
    input.bill_total_paise !== undefined &&
    input.points * s.point_value_paise > input.bill_total_paise
  )
    return 'loyalty_exceeds_bill'
  return null
}

export const LoyaltyEntrySchema = z.object({
  id: zId,
  customer_id: zId,
  /** Signed: + earned / given back, − redeemed / reversed / expired. */
  points: z.int(),
  kind: LoyaltyKindSchema,
  ref_type: z.string().nullable(),
  ref_id: zId.nullable(),
  /** Number of the referenced document (invoice / credit note), when resolvable. */
  ref_number: z.string().nullable(),
  notes: z.string().nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  /** Points balance after this entry (window sum in posting order). */
  balance_after: z.int().min(0),
})
export type LoyaltyEntry = z.output<typeof LoyaltyEntrySchema>

export const LoyaltyListQuerySchema = PageQuerySchema.extend({
  kind: LoyaltyKindSchema.optional(),
})
export type LoyaltyListQuery = z.input<typeof LoyaltyListQuerySchema>

/** POST /customers/:id/loyalty/adjust — manual correction (audited); never below zero (422). */
export const LoyaltyAdjustSchema = z.object({
  points: z
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((p) => p !== 0, { message: 'loyalty_points_zero' }),
  notes: z.string().trim().min(1).max(200),
})
export type LoyaltyAdjust = z.input<typeof LoyaltyAdjustSchema>

export const LoyaltyAdjustResultSchema = z.object({
  customer_id: zId,
  /** New points balance. */
  loyalty_points: z.int().min(0),
  entry: LoyaltyEntrySchema,
})
export type LoyaltyAdjustResult = z.output<typeof LoyaltyAdjustResultSchema>

// =============================================================================================
// Customer import
// =============================================================================================

const ccol = (
  key: string,
  type: ImportColumnDef['type'],
  example: string,
  description_en: string,
  description_ta: string,
  required = false,
  enum_values?: readonly string[],
): ImportColumnDef => ({
  key,
  type,
  example,
  description_en,
  description_ta,
  required,
  ...(enum_values ? { enum_values } : {}),
})

/** Columns of the customer import template (header keys in order). */
export const CUSTOMER_IMPORT_COLUMNS: readonly ImportColumnDef[] = [
  ccol('name', 'text', 'Murugan', 'Customer name', 'வாடிக்கையாளர் பெயர்', true),
  ccol('name_ta', 'text', 'முருகன்', 'Name in Tamil', 'தமிழில் பெயர்'),
  ccol(
    'phone',
    'phone',
    '9876543210',
    'Mobile number; matches existing customers on upsert',
    'மொபைல் எண்',
  ),
  ccol('alt_phone', 'text', '', 'Other phone', 'மற்றொரு எண்'),
  ccol('email', 'text', '', 'Email', 'மின்னஞ்சல்'),
  ccol('gstin', 'text', '', 'GSTIN (business customers); state is taken from it', 'GSTIN'),
  ccol('customer_type', 'enum', 'retail', 'retail / wholesale / business', 'வகை', false, [
    'retail',
    'wholesale',
    'business',
  ]),
  ccol('address_line1', 'text', '12, Bazaar Street', 'Address line 1', 'முகவரி 1'),
  ccol('address_line2', 'text', '', 'Address line 2', 'முகவரி 2'),
  ccol('city', 'text', 'Madurai', 'City / town', 'நகரம்'),
  ccol('district', 'text', 'Madurai', 'District', 'மாவட்டம்'),
  ccol('state_code', 'text', '33', 'GST state code (33 = Tamil Nadu)', 'மாநிலக் குறியீடு'),
  ccol('pincode', 'text', '625001', 'PIN code', 'அஞ்சல் குறியீடு'),
  ccol(
    'opening_balance',
    'money',
    '1250.00',
    'Old khata due in rupees (negative = advance)',
    'பழைய நிலுவை (₹)',
  ),
  ccol(
    'credit_limit',
    'money',
    '5000',
    'Credit limit in rupees (empty = no limit)',
    'கடன் வரம்பு (₹)',
  ),
  ccol('credit_days', 'int', '30', 'Credit days', 'கடன் நாட்கள்'),
  ccol('tags', 'list', 'regular|street-3', 'Tags separated by |', 'குறிச்சொற்கள்'),
  ccol(
    'whatsapp_opt_in',
    'boolean',
    'yes',
    'Agrees to WhatsApp messages (yes/no)',
    'வாட்ஸ்அப் ஒப்புதல்',
  ),
  ccol('code', 'text', '', 'Your customer code', 'வாடிக்கையாளர் குறியீடு'),
]

/** Template CSV (header + example row) for GET /customers/import/template. */
export function customerImportTemplateCsv(): string {
  return toCsv([
    CUSTOMER_IMPORT_COLUMNS.map((c) => c.key),
    CUSTOMER_IMPORT_COLUMNS.map((c) => c.example),
  ])
}

/** POST /customers/import — inline, at most IMPORT_INLINE_MAX_ROWS rows (422 above). */
export const CustomerImportSchema = ImportRequestBaseSchema.extend({
  match_by: z.enum(['phone', 'code']).default('phone').describe('How rows find existing customers'),
})
export type CustomerImport = z.input<typeof CustomerImportSchema>

// =============================================================================================
// Suppliers
// =============================================================================================

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

/** Stored bank details: never a full account number (last 4 digits only). */
export const BankDetailsSchema = z.object({
  account_name: z.string().nullable().default(null),
  account_no_last4: z.string().nullable().default(null),
  ifsc: z.string().nullable().default(null),
  bank_name: z.string().nullable().default(null),
})
export type BankDetails = z.output<typeof BankDetailsSchema>

/**
 * Bank details input: a full `account_number` is accepted only to derive `account_no_last4`
 * (the parsed value never contains it). Omitted fields keep their stored value; null clears.
 */
export const BankDetailsInputSchema = z
  .strictObject({
    account_name: zNullableText(100),
    account_number: z
      .union([
        z.null(),
        z
          .string()
          .trim()
          .regex(/^\d{6,18}$/, 'bank_account_number'),
      ])
      .optional(),
    ifsc: z
      .union([z.null(), z.string().trim().toUpperCase()])
      .optional()
      .refine((v) => v == null || v === '' || IFSC_RE.test(v), { message: 'ifsc' })
      .transform((v) => (v === '' ? null : v)),
    bank_name: zNullableText(100),
  })
  .transform(({ account_number, ...rest }) => ({
    ...rest,
    ...(account_number === undefined
      ? {}
      : { account_no_last4: account_number === null ? null : account_number.slice(-4) }),
  }))
export type BankDetailsInput = z.input<typeof BankDetailsInputSchema>

/** Optional, clearable UPI VPA (normalised to lower case). */
const zNullableVpa = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || isValidVpa(normalizeVpa(v)), { message: 'vpa' })
  .transform((v) =>
    v == null || v === '' ? (v === undefined ? undefined : null) : normalizeVpa(v),
  )

export const SupplierListItemSchema = z.object({
  id: zId,
  code: z.string().nullable(),
  name: z.string(),
  contact_person: z.string().nullable(),
  phone: zE164.nullable(),
  gstin: z.string().nullable(),
  state_code: z.string().nullable(),
  drug_license_no: z.string().nullable(),
  payment_terms_days: z.int().min(0).nullable(),
  /** Payable: + = the shop owes the supplier, − = advance paid / debit balance. */
  balance_paise: zSignedPaise,
  /** Σ due of posted bills past their due date. */
  overdue_paise: zPaise,
  upi_vpa: z.string().nullable(),
  is_active: z.boolean(),
  /** received_date of the latest posted purchase bill. */
  last_bill_date: zDateStr.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type SupplierListItem = z.output<typeof SupplierListItemSchema>

export const SupplierSchema = SupplierListItemSchema.extend({
  email: z.string().nullable(),
  pan: z.string().nullable(),
  address: AddressSchema,
  opening_balance_paise: zSignedPaise,
  bank_details: BankDetailsSchema,
  notes: z.string().nullable(),
  created_by: zId.nullable(),
})
export type Supplier = z.output<typeof SupplierSchema>

export const SupplierListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Name, contact, phone digits, GSTIN or code'),
  has_due: zBooleanQuery.optional(),
  overdue: zBooleanQuery.optional(),
  is_active: zBooleanQuery.optional(),
  ids: zQueryIds.optional(),
  sort: sortQuery(['name', 'balance_paise', 'last_bill_date', 'created_at'] as const).prefault(
    'name',
  ),
})
export type SupplierListQuery = z.input<typeof SupplierListQuerySchema>

/** POST /suppliers — opening balance posts Cr payable(supplier) / Dr opening_balance. */
export const SupplierCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: zNullableText(20),
    contact_person: zNullableText(120),
    phone: zNullablePhone,
    email: zNullableEmail,
    gstin: zNullableGstin,
    pan: zNullablePan,
    state_code: zStateCode.nullable().optional(),
    address: AddressSchema.prefault({}),
    drug_license_no: zNullableText(100),
    payment_terms_days: z.int().min(0).max(365).nullable().default(null),
    opening_balance_paise: zOpeningBalance
      .default(0)
      .describe('+ = the shop owes the supplier, − = advance paid'),
    bank_details: BankDetailsInputSchema.optional(),
    upi_vpa: zNullableVpa,
    notes: zNullableText(1000),
  })
  .superRefine(refineTaxIds)
  .transform(deriveStateCode)
export type SupplierCreate = z.input<typeof SupplierCreateSchema>
export type SupplierCreateParsed = z.output<typeof SupplierCreateSchema>

export const SupplierUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    code: zNullableText(20),
    contact_person: zNullableText(120),
    phone: zNullablePhone,
    email: zNullableEmail,
    gstin: zNullableGstin,
    pan: zNullablePan,
    state_code: zStateCode.nullable().optional(),
    address: AddressSchema.optional(),
    drug_license_no: zNullableText(100),
    payment_terms_days: z.int().min(0).max(365).nullable().optional(),
    opening_balance_paise: zOpeningBalance.optional(),
    bank_details: BankDetailsInputSchema.optional(),
    upi_vpa: zNullableVpa,
    notes: zNullableText(1000),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine(refineTaxIds)
  .refine(notEmpty, { message: 'empty_patch' })
  .transform(deriveStateCode)
export type SupplierUpdate = z.input<typeof SupplierUpdateSchema>

// =============================================================================================
// Doctors (pharmacy)
// =============================================================================================

export const DoctorSchema = z.object({
  id: zId,
  name: z.string(),
  registration_no: z.string().nullable(),
  qualification: z.string().nullable(),
  phone: z.string().nullable(),
  clinic_name: z.string().nullable(),
  address: AddressSchema,
  is_active: z.boolean(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Doctor = z.output<typeof DoctorSchema>

export const DoctorListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Name, registration number or clinic'),
  is_active: zBooleanQuery.optional(),
  sort: sortQuery(['name', 'created_at'] as const).prefault('name'),
})
export type DoctorListQuery = z.input<typeof DoctorListQuerySchema>

export const DoctorCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  registration_no: zNullableText(40).describe('Medical council registration number'),
  qualification: zNullableText(100),
  phone: zNullablePhone,
  clinic_name: zNullableText(200),
  address: AddressSchema.prefault({}),
})
export type DoctorCreate = z.input<typeof DoctorCreateSchema>

export const DoctorUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    registration_no: zNullableText(40),
    qualification: zNullableText(100),
    phone: zNullablePhone,
    clinic_name: zNullableText(200),
    address: AddressSchema.optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type DoctorUpdate = z.input<typeof DoctorUpdateSchema>

// =============================================================================================
// Route catalogue (docs/API.md "parties")
// =============================================================================================

const IdParams = z.object({ id: zId })

export const partiesRoutes = defineRoutes({
  // ---- customers -----------------------------------------------------------------------------
  listCustomers: {
    method: 'GET',
    path: '/customers',
    permission: 'customers.read',
    query: CustomerListQuerySchema,
    response: listOf(CustomerListItemSchema),
  },
  createCustomer: {
    method: 'POST',
    path: '/customers',
    permission: 'customers.write',
    idempotent: true,
    body: CustomerCreateSchema,
    response: dataOf(CustomerSchema),
    status: 201,
    summary: 'Add a customer (opening balance posted as a journal; duplicate phone → 409)',
  },
  lookupCustomer: {
    method: 'GET',
    path: '/customers/lookup',
    permission: 'customers.read',
    query: CustomerLookupQuerySchema,
    response: dataOf(CustomerListItemSchema),
    summary: 'Exact phone lookup for the POS (404 when unknown)',
  },
  customerImportTemplate: {
    method: 'GET',
    path: '/customers/import/template',
    permission: 'customers.write',
    stream: 'csv',
  },
  importCustomers: {
    method: 'POST',
    path: '/customers/import',
    permission: 'customers.write',
    idempotent: true,
    body: CustomerImportSchema,
    response: dataOf(ImportJobSchema),
    status: 201,
    summary: 'Dry-run or import customers from a CSV (≤ 1000 rows)',
  },
  getCustomer: {
    method: 'GET',
    path: '/customers/:id',
    permission: 'customers.read',
    params: IdParams,
    response: dataOf(CustomerSchema),
  },
  updateCustomer: {
    method: 'PATCH',
    path: '/customers/:id',
    permission: 'customers.write',
    params: IdParams,
    body: CustomerUpdateSchema,
    response: dataOf(CustomerSchema),
  },
  deleteCustomer: {
    method: 'DELETE',
    path: '/customers/:id',
    permission: 'customers.write',
    params: IdParams,
    response: dataOf(DeleteResultSchema),
    summary: 'Delete a customer without documents, otherwise deactivate',
  },
  customerLedger: {
    method: 'GET',
    path: '/customers/:id/ledger',
    permission: 'customers.read',
    params: IdParams,
    query: PartyLedgerQuerySchema,
    response: dataOf(PartyLedgerSchema),
    summary: 'Khata statement with running balance (?format=csv streams CSV)',
  },
  customerSummary: {
    method: 'GET',
    path: '/customers/:id/summary',
    permission: 'customers.read',
    params: IdParams,
    response: dataOf(CustomerSummarySchema),
  },
  customerLoyalty: {
    method: 'GET',
    path: '/customers/:id/loyalty',
    permission: 'customers.read',
    feature: 'loyalty',
    params: IdParams,
    query: LoyaltyListQuerySchema,
    response: listOf(LoyaltyEntrySchema),
    summary: 'Loyalty points ledger, newest first',
  },
  adjustLoyalty: {
    method: 'POST',
    path: '/customers/:id/loyalty/adjust',
    permission: 'customers.write',
    feature: 'loyalty',
    params: IdParams,
    body: LoyaltyAdjustSchema,
    response: dataOf(LoyaltyAdjustResultSchema),
    summary: 'Manual points correction (audited; never below zero)',
  },

  // ---- suppliers -----------------------------------------------------------------------------
  listSuppliers: {
    method: 'GET',
    path: '/suppliers',
    permission: 'suppliers.read',
    query: SupplierListQuerySchema,
    response: listOf(SupplierListItemSchema),
  },
  createSupplier: {
    method: 'POST',
    path: '/suppliers',
    permission: 'suppliers.write',
    idempotent: true,
    body: SupplierCreateSchema,
    response: dataOf(SupplierSchema),
    status: 201,
  },
  getSupplier: {
    method: 'GET',
    path: '/suppliers/:id',
    permission: 'suppliers.read',
    params: IdParams,
    response: dataOf(SupplierSchema),
  },
  updateSupplier: {
    method: 'PATCH',
    path: '/suppliers/:id',
    permission: 'suppliers.write',
    params: IdParams,
    body: SupplierUpdateSchema,
    response: dataOf(SupplierSchema),
  },
  deleteSupplier: {
    method: 'DELETE',
    path: '/suppliers/:id',
    permission: 'suppliers.write',
    params: IdParams,
    response: dataOf(DeleteResultSchema),
    summary: 'Delete a supplier without documents, otherwise deactivate',
  },
  supplierLedger: {
    method: 'GET',
    path: '/suppliers/:id/ledger',
    permission: 'suppliers.read',
    params: IdParams,
    query: PartyLedgerQuerySchema,
    response: dataOf(PartyLedgerSchema),
    summary: 'Payable statement: bills, debit notes, payments out (?format=csv)',
  },

  // ---- doctors -------------------------------------------------------------------------------
  listDoctors: {
    method: 'GET',
    path: '/doctors',
    permission: 'customers.read',
    query: DoctorListQuerySchema,
    response: listOf(DoctorSchema),
  },
  createDoctor: {
    method: 'POST',
    path: '/doctors',
    permission: 'customers.write',
    body: DoctorCreateSchema,
    response: dataOf(DoctorSchema),
    status: 201,
  },
  getDoctor: {
    method: 'GET',
    path: '/doctors/:id',
    permission: 'customers.read',
    params: IdParams,
    response: dataOf(DoctorSchema),
  },
  updateDoctor: {
    method: 'PATCH',
    path: '/doctors/:id',
    permission: 'customers.write',
    params: IdParams,
    body: DoctorUpdateSchema,
    response: dataOf(DoctorSchema),
  },
  deleteDoctor: {
    method: 'DELETE',
    path: '/doctors/:id',
    permission: 'customers.write',
    params: IdParams,
    response: dataOf(DeleteResultSchema),
    summary: 'Delete a doctor never used on a prescription, otherwise deactivate',
  },
})
