// CONTRACT CHANGELOG (reports backend; one line per change, newest last)
// - REPORTS_ERROR_REASONS: + 'all_stores_required' (403) — GST returns / GSTR-1 export cover
//   every store of the registration, so a store-restricted member is refused instead of being
//   shown partial filing figures.
// - REPORTS_ERROR_REASON_STATUS: added (reason → HTTP status) for the web's error messages.
// - (reports frontend) REPORTS labels of `max_margin_bp` / `min_discount_bp` say "(%)" instead
//   of "(bp)": the viewer takes these number filters as percentages (12.5 → 1250); the query
//   value is still basis points (no schema change).
// - (reports backend) GST_WARNING_CODES comment: 'invalid_customer_gstin' also covers a
//   registered customer billed without the GSTIN (details { gstin: null, customer_gstin }).
//   Comment only, no schema change.

/**
 * Contract for the reports module — docs/API.md "reports & GST": owner dashboard, sales / stock /
 * party reports, GST returns (GSTR-1 with the GST offline-tool JSON, GSTR-3B, HSN summary,
 * registers; composition CMP-08 summary) and the pharmacy Schedule H1 register.
 *
 * Every report is read-only and SQL-aggregated. Common rules:
 *  - Only completed documents count (cancelled / draft / held excluded); credit notes reduce
 *    sales (by note date), debit notes reduce purchases.
 *  - `store_id` (a store id, or 'all' / omitted = every store the member can access — respect
 *    ctx.storeIds); date ranges are inclusive business dates, at most REPORT_MAX_RANGE_DAYS for
 *    detailed reports (400 range_too_long).
 *  - `?format=csv` streams the same report (every row, no pagination) with the English column
 *    labels of the REPORTS catalogue as headers and a totals row — use reportCsv().
 *  - Tabular reports answer the report envelope `{ data: rows, page, totals, meta }`
 *    (reportResponse()); the generic web viewer renders them from the REPORTS catalogue.
 *
 * Metric definitions (all paise): sales = Σ invoice totals (incl. GST); returns = Σ credit-note
 * totals; net_sales = sales − returns (what the till saw); net_taxable = taxable − returns'
 * taxable; cost = COGS − restocked cost of returns; gross_profit = net_taxable − cost; margin_bp =
 * gross_profit ÷ net_taxable.
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope;
 * custom validation messages are snake_case keys (REPORTS_VALIDATION_KEYS).
 */
import { z } from 'zod'
import {
  type BusinessType,
  type PaymentMethod,
  SalesChannelSchema,
  ShiftStatusSchema,
  SalesInvoiceStatusSchema,
  SalesDocTypeSchema,
} from '../enums'
import type { Feature } from '../features'
import { addDays, addMonths, diffDays, isPeriod, periodRange, periodToFp } from '../fy'
import { getState } from '../gst'
import { mulDiv, roundDiv, sumSafe } from '../math'
import { paiseToRupeesString } from '../money'
import { formatPhoneDisplay } from '../phone'
import type { Permission } from '../permissions'
import { DrugScheduleSchema } from '../settings'
import { milliToDecimalString } from '../units'
import { journalSourcePath, marginBp } from './accounting'
import {
  PageSchema,
  dataOf,
  defineRoutes,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zId,
  zPaise,
  zPeriod,
  zSearchQuery,
  zSignedPaise,
  zTimestamp,
} from './common'
import { type BilingualLabel, type CsvValue, toCsv, zStoreScope } from './identity'
import {
  CREDIT_DUE_LABEL,
  PAYMENT_METHOD_LABELS,
  zListFormat,
  zQueryInt,
  zQueryList,
} from './payments'

export { marginBp }

// =============================================================================================
// Validation keys, limits & shared helpers
// =============================================================================================

/** Message keys of the custom rules in this contract (web: reports:validation.<key>). */
export const REPORTS_VALIDATION_KEYS = [
  'date_order',
  'range_too_long',
  'period_or_range_required',
  'section_csv_only',
] as const
export type ReportsValidationKey = (typeof REPORTS_VALIDATION_KEYS)[number]

/**
 * `details.reason` of 4xx errors: gst_not_registered (422: GSTR-1 export for a composition /
 * unregistered business or without a GSTIN), gstin_not_found (404: `gstin=` is not one of the
 * business's registrations), all_stores_required (403: GST returns of a registration need access
 * to all of its stores).
 */
export const REPORTS_ERROR_REASONS = [
  'gst_not_registered',
  'gstin_not_found',
  'all_stores_required',
] as const
export type ReportsErrorReason = (typeof REPORTS_ERROR_REASONS)[number]

/** HTTP status of each reason. */
export const REPORTS_ERROR_REASON_STATUS: Readonly<Record<ReportsErrorReason, 403 | 404 | 422>> = {
  gst_not_registered: 422,
  gstin_not_found: 404,
  all_stores_required: 403,
}

/** Longest from–to range of detailed reports (a leap year). */
export const REPORT_MAX_RANGE_DAYS = 366
/** Largest `limit` of report pages (print / export-like views). */
export const REPORT_PAGE_MAX = 5000
/** CSV exports stop after this many rows (meta note 'truncated'). */
export const REPORT_CSV_MAX_ROWS = 100_000

/** null when valid, else the validation key for the range. */
export function reportRangeIssue(
  from: string,
  to: string,
  maxDays: number = REPORT_MAX_RANGE_DAYS,
): 'date_order' | 'range_too_long' | null {
  if (from > to) return 'date_order'
  return diffDays(from, to) + 1 > maxDays ? 'range_too_long' : null
}

function refineRange(maxDays: number | null) {
  return (v: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx) => {
    if (!v.from || !v.to) return
    const issue = reportRangeIssue(v.from, v.to, maxDays ?? Number.MAX_SAFE_INTEGER)
    if (issue) ctx.addIssue({ code: 'custom', path: ['to'], message: issue })
  }
}

/** Signed change in basis points ((current − previous) ÷ |previous|), null when previous is 0. */
export function changeBp(current: number, previous: number): number | null {
  if (previous === 0) return null
  return mulDiv(current - previous, 10_000, Math.abs(previous))
}

/** part ÷ whole in bp (0 when whole ≤ 0). */
export function shareBp(part: number, whole: number): number {
  return whole > 0 ? mulDiv(part, 10_000, whole) : 0
}

/** Average bill value (0 without bills). */
export function avgBillPaise(salesPaise: number, bills: number): number {
  return bills > 0 ? roundDiv(salesPaise, bills) : 0
}

// ---- date presets ---------------------------------------------------------------------------

export const REPORT_DATE_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'this_month',
  'last_month',
  'last_30_days',
  'this_quarter',
  'last_quarter',
  'this_fy',
  'last_fy',
] as const
export type ReportDatePreset = (typeof REPORT_DATE_PRESETS)[number]

export const REPORT_DATE_PRESET_LABELS: Readonly<Record<ReportDatePreset, BilingualLabel>> = {
  today: { en: 'Today', ta: 'இன்று' },
  yesterday: { en: 'Yesterday', ta: 'நேற்று' },
  last_7_days: { en: 'Last 7 days', ta: 'கடந்த 7 நாட்கள்' },
  this_month: { en: 'This month', ta: 'இந்த மாதம்' },
  last_month: { en: 'Last month', ta: 'கடந்த மாதம்' },
  last_30_days: { en: 'Last 30 days', ta: 'கடந்த 30 நாட்கள்' },
  this_quarter: { en: 'This quarter', ta: 'இந்தக் காலாண்டு' },
  last_quarter: { en: 'Last quarter', ta: 'கடந்த காலாண்டு' },
  this_fy: { en: 'This financial year', ta: 'இந்த நிதியாண்டு' },
  last_fy: { en: 'Last financial year', ta: 'கடந்த நிதியாண்டு' },
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/**
 * from / to of a preset relative to `today` (tenant timezone). Quarters and financial years start
 * at `fyStartMonth` (April: Q1 = Apr–Jun). "this_*" presets end today.
 */
export function reportDatePresetRange(
  preset: ReportDatePreset,
  today: string,
  fyStartMonth = 4,
): { from: string; to: string } {
  const month = Number(today.slice(5, 7))
  const offset = (month - fyStartMonth + 12) % 12
  const fyStart = addMonths(monthStart(today), -offset)
  const quarterStart = addMonths(monthStart(today), -(offset % 3))
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: y, to: y }
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today }
    case 'this_month':
      return { from: monthStart(today), to: today }
    case 'last_month': {
      const from = addMonths(monthStart(today), -1)
      return { from, to: addDays(monthStart(today), -1) }
    }
    case 'this_quarter':
      return { from: quarterStart, to: today }
    case 'last_quarter':
      return { from: addMonths(quarterStart, -3), to: addDays(quarterStart, -1) }
    case 'this_fy':
      return { from: fyStart, to: today }
    case 'last_fy':
      return { from: addMonths(fyStart, -12), to: addDays(fyStart, -1) }
  }
}

// ---- ageing ----------------------------------------------------------------------------------

/** Age buckets of outstanding / stock ageing (days). */
export const AGEING_BUCKETS = ['0_30', '31_60', '61_90', '90_plus'] as const
export type AgeingBucket = (typeof AGEING_BUCKETS)[number]
export const AgeingBucketSchema = z.enum(AGEING_BUCKETS)

export const AGEING_BUCKET_LABELS: Readonly<Record<AgeingBucket | 'not_due', BilingualLabel>> = {
  not_due: { en: 'Not yet due', ta: 'இன்னும் தவணை வரவில்லை' },
  '0_30': { en: '0–30 days', ta: '0–30 நாட்கள்' },
  '31_60': { en: '31–60 days', ta: '31–60 நாட்கள்' },
  '61_90': { en: '61–90 days', ta: '61–90 நாட்கள்' },
  '90_plus': { en: 'Over 90 days', ta: '90 நாட்களுக்கு மேல்' },
}

/** Bucket of an age in days (≤ 30 → '0_30', … > 90 → '90_plus'; negative ages count as 0). */
export function ageingBucket(days: number): AgeingBucket {
  if (days <= 30) return '0_30'
  if (days <= 60) return '31_60'
  if (days <= 90) return '61_90'
  return '90_plus'
}

/** Bucket by days past a due date: ≤ 0 → 'not_due', else ageingBucket(days). */
export function overdueBucket(daysPastDue: number): AgeingBucket | 'not_due' {
  return daysPastDue <= 0 ? 'not_due' : ageingBucket(daysPastDue)
}

// =============================================================================================
// Report envelope
// =============================================================================================

export const REPORT_KEYS = [
  'sales-summary',
  'item-sales',
  'category-sales',
  'brand-sales',
  'profit',
  'discounts',
  'cancellations',
  'shifts',
  'stock-summary',
  'stock-ageing',
  'expiry',
  'dead-stock',
  'customer-outstanding',
  'supplier-outstanding',
  'hsn-summary',
  'sales-register',
  'purchase-register',
  'h1-register',
  'schedule-sales',
] as const
export const ReportKeySchema = z.enum(REPORT_KEYS)
export type ReportKey = z.infer<typeof ReportKeySchema>

/** Notes attached to a report (web: reports:notes.<key>). */
export const REPORT_NOTES = [
  'truncated',
  'cost_estimated',
  'store_filter_applied',
  'includes_opening_balances',
] as const

export const ReportMetaSchema = z.object({
  report: ReportKeySchema,
  from: zDateStr.nullable(),
  to: zDateStr.nullable(),
  as_of: zDateStr.nullable(),
  /** null = several / all accessible stores. */
  store_id: zId.nullable(),
  store_name: z.string().nullable(),
  group_by: z.string().nullable(),
  generated_at: zTimestamp,
  notes: z.array(z.enum(REPORT_NOTES)),
})
export type ReportMeta = z.output<typeof ReportMetaSchema>

/** Report envelope: rows (paginated), totals over the whole filtered set, meta. */
export function reportResponse<R extends z.ZodType, T extends z.ZodType>(row: R, totals: T) {
  return z.object({
    data: z.array(row),
    page: PageSchema,
    totals,
    meta: ReportMetaSchema,
  })
}

const zCount = z.int().min(0)
const zMargin = z.int().nullable()
const zSignedMilli = z.int()

const zReportStore = zStoreScope
  .optional()
  .describe("A store id; 'all' or omitted = every store the member can access")

const PageFields = {
  limit: zQueryInt(1, REPORT_PAGE_MAX).default(100),
  offset: zQueryInt(0, 10_000_000).default(0),
  format: zListFormat,
}

/** Required inclusive business-date range of detailed reports. */
const RangeFields = { from: zDateStr, to: zDateStr }

// =============================================================================================
// Dashboard
// =============================================================================================

export const DashboardQuerySchema = z.object({
  store_id: zReportStore,
  date: zDateStr.optional().describe('Default: today (tenant timezone)'),
})
export type DashboardQuery = z.input<typeof DashboardQuerySchema>

export const DashboardDaySchema = z.object({
  date: zDateStr,
  /** sales − returns, incl. GST. */
  net_sales_paise: zSignedPaise,
  sales_paise: zPaise,
  returns_paise: zPaise,
  bills: zCount,
  /** sales ÷ bills. */
  avg_bill_paise: zPaise,
  net_taxable_paise: zSignedPaise,
  gross_profit_paise: zSignedPaise,
  margin_bp: zMargin,
})
export type DashboardDay = z.output<typeof DashboardDaySchema>

export const DashboardTopItemSchema = z.object({
  product_id: zId.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zSignedMilli,
  net_sales_paise: zSignedPaise,
})
export type DashboardTopItem = z.output<typeof DashboardTopItemSchema>

/** Payment mix of the day's bills: tenders by method + the unpaid (credit) remainder. */
export const PAYMENT_MIX_KEYS = ['cash', 'upi', 'card', 'credit', 'other'] as const
export const PaymentMixKeySchema = z.enum(PAYMENT_MIX_KEYS)
export type PaymentMixKey = z.infer<typeof PaymentMixKeySchema>

export const PAYMENT_MIX_LABELS: Readonly<Record<PaymentMixKey, BilingualLabel>> = {
  cash: PAYMENT_METHOD_LABELS.cash,
  upi: PAYMENT_METHOD_LABELS.upi,
  card: PAYMENT_METHOD_LABELS.card,
  credit: CREDIT_DUE_LABEL,
  other: PAYMENT_METHOD_LABELS.other,
}

/** Payment method → mix slice (bank transfer, cheque, wallet, store credit → other). */
export function paymentMixKey(method: PaymentMethod): PaymentMixKey {
  return method === 'cash' || method === 'upi' || method === 'card' ? method : 'other'
}

/**
 * GET /reports/dashboard — the owner's home screen. Money is incl. GST except profit (ex-GST).
 * payment_mix sums to today.sales_paise (tenders applied to today's bills + what is still due).
 */
export const DashboardSchema = z.object({
  date: zDateStr,
  store_id: zId.nullable(),
  generated_at: zTimestamp,
  today: DashboardDaySchema,
  yesterday: DashboardDaySchema,
  /** changeBp(today, yesterday); margin_points_bp = today.margin − yesterday.margin. */
  change: z.object({
    net_sales_bp: z.int().nullable(),
    bills_bp: z.int().nullable(),
    avg_bill_bp: z.int().nullable(),
    gross_profit_bp: z.int().nullable(),
    margin_points_bp: z.int().nullable(),
  }),
  /** 30 days ending `date`, oldest first, every day present (zero-filled). */
  trend: z.array(
    z.object({
      date: zDateStr,
      net_sales_paise: zSignedPaise,
      gross_profit_paise: zSignedPaise,
      bills: zCount,
    }),
  ),
  payment_mix: z.array(
    z.object({
      key: PaymentMixKeySchema,
      amount_paise: zPaise,
      count: zCount,
      share_bp: z.int().min(0).max(10_000),
    }),
  ),
  top_items: z.object({
    today: z.array(DashboardTopItemSchema),
    last_7_days: z.array(DashboardTopItemSchema),
  }),
  receivables: z.object({
    total_paise: zSignedPaise,
    customers_with_due: zCount,
    overdue_paise: zPaise,
    top_debtors: z.array(
      z.object({
        customer_id: zId,
        name: z.string(),
        name_ta: z.string().nullable(),
        phone: z.string().nullable(),
        balance_paise: zSignedPaise,
        oldest_due_days: z.int().min(0).nullable(),
        whatsapp_opt_in: z.boolean(),
      }),
    ),
  }),
  payables: z.object({
    total_paise: zSignedPaise,
    suppliers_with_due: zCount,
    overdue_paise: zPaise,
    due_next_7_days_paise: zPaise,
  }),
  stock: z.object({
    low_stock: zCount,
    out_of_stock: zCount,
    expiring: zCount,
    expired: zCount,
    expiring_value_paise: zSignedPaise,
    expired_value_paise: zSignedPaise,
    expiry_warning_days: z.int().min(0),
  }),
  /** null without plan feature shifts. */
  shifts: z
    .object({
      open_count: zCount,
      open: z.array(
        z.object({
          shift_id: zId,
          register_id: zId,
          register_code: z.string(),
          opened_by_name: z.string().nullable(),
          opened_at: zTimestamp,
        }),
      ),
    })
    .nullable(),
  upi: z.object({
    /** Intents created / pending right now. */
    pending_intents: zCount,
    pending_paise: zPaise,
    /** Paid intents not yet applied to a bill or customer (reconciliation). */
    unapplied_count: zCount,
    unapplied_paise: zPaise,
  }),
})
export type Dashboard = z.output<typeof DashboardSchema>

export const DASHBOARD_TOP_ITEMS = 10
export const DASHBOARD_TOP_DEBTORS = 5
export const DASHBOARD_TREND_DAYS = 30

// =============================================================================================
// Sales reports
// =============================================================================================

/** Sales metrics shared by the sales rows (see the module doc for definitions). */
const SalesMetricFields = {
  bills: zCount,
  gross_paise: zPaise,
  discount_paise: zPaise,
  taxable_paise: zPaise,
  tax_paise: zPaise,
  sales_paise: zPaise,
  returns_count: zCount,
  returns_paise: zPaise,
  returns_taxable_paise: zPaise,
  net_sales_paise: zSignedPaise,
  net_taxable_paise: zSignedPaise,
  cost_paise: zSignedPaise,
  gross_profit_paise: zSignedPaise,
  margin_bp: zMargin,
}

// ---- sales summary ----------------------------------------------------------------------------

export const SalesSummaryGroupBySchema = z.enum([
  'day',
  'month',
  'hour',
  'store',
  'register',
  'user',
  'payment_method',
])
export type SalesSummaryGroupBy = z.infer<typeof SalesSummaryGroupBySchema>

export const SalesSummaryQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    group_by: SalesSummaryGroupBySchema.default('day'),
    register_id: zId.optional(),
    user_id: zId.optional().describe('Billed by (invoices.created_by)'),
    channel: SalesChannelSchema.optional(),
    sort: sortQuery(['group', 'net_sales_paise', 'bills', 'gross_profit_paise'] as const).prefault(
      'group',
    ),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type SalesSummaryQuery = z.input<typeof SalesSummaryQuerySchema>

/**
 * One group. Keys: day 'YYYY-MM-DD', month 'YYYY-MM', hour '00'…'23' (zero-filled over the range),
 * store / register / user id, payment method code. Sales metrics are 0 for payment_method rows;
 * the payment fields (payments in / refunds out recorded in the group) are filled for every
 * grouping.
 */
export const SalesSummaryRowSchema = z.object({
  group_key: z.string(),
  group_label: z.string(),
  group_label_ta: z.string().nullable(),
  ...SalesMetricFields,
  round_off_paise: zSignedPaise,
  avg_bill_paise: zPaise,
  payments_count: zCount,
  collected_paise: zPaise,
  refunded_paise: zPaise,
  net_collected_paise: zSignedPaise,
})
export type SalesSummaryRow = z.output<typeof SalesSummaryRowSchema>

export const SalesSummaryTotalsSchema = SalesSummaryRowSchema.omit({
  group_key: true,
  group_label: true,
  group_label_ta: true,
})
export type SalesSummaryTotals = z.output<typeof SalesSummaryTotalsSchema>

export const SalesSummaryResponseSchema = reportResponse(
  SalesSummaryRowSchema,
  SalesSummaryTotalsSchema,
)
export type SalesSummaryResponse = z.output<typeof SalesSummaryResponseSchema>

// ---- item sales -------------------------------------------------------------------------------

export const ItemSalesQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    category_id: zId.optional().describe('Includes sub-categories'),
    brand_id: zId.optional(),
    product_id: zId.optional(),
    user_id: zId.optional(),
    q: zSearchQuery.optional().describe('Product name / SKU'),
    sort: sortQuery([
      'net_sales_paise',
      'net_qty_milli',
      'gross_profit_paise',
      'margin_bp',
      'name',
    ] as const).prefault('-net_sales_paise'),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type ItemSalesQuery = z.input<typeof ItemSalesQuerySchema>

/** One product (ad-hoc invoice lines are one row with product_id null). */
export const ItemSalesRowSchema = z.object({
  product_id: zId.nullable(),
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_id: zId.nullable(),
  category_name: z.string().nullable(),
  brand_id: zId.nullable(),
  brand_name: z.string().nullable(),
  hsn_code: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zSignedMilli,
  free_qty_milli: zSignedMilli,
  returned_qty_milli: zSignedMilli,
  net_qty_milli: zSignedMilli,
  ...SalesMetricFields,
})
export type ItemSalesRow = z.output<typeof ItemSalesRowSchema>

export const ItemSalesTotalsSchema = z.object({ products: zCount, ...SalesMetricFields })
export const ItemSalesResponseSchema = reportResponse(ItemSalesRowSchema, ItemSalesTotalsSchema)
export type ItemSalesResponse = z.output<typeof ItemSalesResponseSchema>

// ---- category / brand sales ---------------------------------------------------------------------

const GroupSalesFields = {
  products: zCount,
  ...SalesMetricFields,
  /** net_sales share of the total. */
  share_bp: z.int(),
}

export const CategorySalesQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    level: z
      .enum(['leaf', 'top'])
      .default('leaf')
      .describe('leaf: each category; top: rolled up to top-level categories'),
    category_id: zId.optional().describe('Only this sub-tree'),
    sort: sortQuery([
      'net_sales_paise',
      'gross_profit_paise',
      'margin_bp',
      'name',
    ] as const).prefault('-net_sales_paise'),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type CategorySalesQuery = z.input<typeof CategorySalesQuerySchema>

export const CategorySalesRowSchema = z.object({
  /** null = uncategorised products / ad-hoc lines. */
  category_id: zId.nullable(),
  category_name: z.string(),
  category_name_ta: z.string().nullable(),
  /** 'Grocery / Rice'. */
  path: z.string(),
  ...GroupSalesFields,
})
export type CategorySalesRow = z.output<typeof CategorySalesRowSchema>

export const GroupSalesTotalsSchema = z.object({ ...SalesMetricFields, products: zCount })
export const CategorySalesResponseSchema = reportResponse(
  CategorySalesRowSchema,
  GroupSalesTotalsSchema,
)
export type CategorySalesResponse = z.output<typeof CategorySalesResponseSchema>

export const BrandSalesQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    category_id: zId.optional(),
    sort: sortQuery([
      'net_sales_paise',
      'gross_profit_paise',
      'margin_bp',
      'name',
    ] as const).prefault('-net_sales_paise'),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type BrandSalesQuery = z.input<typeof BrandSalesQuerySchema>

export const BrandSalesRowSchema = z.object({
  /** null = products without a brand. */
  brand_id: zId.nullable(),
  brand_name: z.string(),
  ...GroupSalesFields,
})
export type BrandSalesRow = z.output<typeof BrandSalesRowSchema>

export const BrandSalesResponseSchema = reportResponse(BrandSalesRowSchema, GroupSalesTotalsSchema)
export type BrandSalesResponse = z.output<typeof BrandSalesResponseSchema>

// ---- profit -----------------------------------------------------------------------------------

export const ProfitGroupBySchema = z.enum(['item', 'category', 'brand'])
export type ProfitGroupBy = z.infer<typeof ProfitGroupBySchema>

export const ProfitQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    group_by: ProfitGroupBySchema.default('item'),
    category_id: zId.optional(),
    max_margin_bp: zQueryInt(-1_000_000, 10_000)
      .optional()
      .describe('Only rows with margin ≤ this (find low / negative margins)'),
    sort: sortQuery([
      'gross_profit_paise',
      'margin_bp',
      'net_taxable_paise',
      'name',
    ] as const).prefault('-gross_profit_paise'),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type ProfitQuery = z.input<typeof ProfitQuerySchema>

export const ProfitRowSchema = z.object({
  /** product / category / brand id (null = ad-hoc lines / uncategorised / no brand). */
  key_id: zId.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_name: z.string().nullable(),
  /** item grouping only. */
  unit: z.string().nullable(),
  pack_size: z.int().min(1).nullable(),
  net_qty_milli: zSignedMilli.nullable(),
  net_taxable_paise: zSignedPaise,
  cost_paise: zSignedPaise,
  gross_profit_paise: zSignedPaise,
  margin_bp: zMargin,
  /** Share of the total gross profit. */
  profit_share_bp: z.int(),
})
export type ProfitRow = z.output<typeof ProfitRowSchema>

export const ProfitTotalsSchema = z.object({
  net_taxable_paise: zSignedPaise,
  cost_paise: zSignedPaise,
  gross_profit_paise: zSignedPaise,
  margin_bp: zMargin,
})
export const ProfitResponseSchema = reportResponse(ProfitRowSchema, ProfitTotalsSchema)
export type ProfitResponse = z.output<typeof ProfitResponseSchema>

// ---- discounts --------------------------------------------------------------------------------

export const DiscountsGroupBySchema = z.enum(['bill', 'item', 'promotion', 'user'])
export type DiscountsGroupBy = z.infer<typeof DiscountsGroupBySchema>

export const DiscountsQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    group_by: DiscountsGroupBySchema.default('bill'),
    user_id: zId.optional(),
    min_discount_bp: zQueryInt(0, 10_000)
      .optional()
      .describe('Bills / items discounted at least this much'),
    sort: sortQuery(['discount_paise', 'discount_bp', 'date', 'label'] as const).prefault(
      '-discount_paise',
    ),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type DiscountsQuery = z.input<typeof DiscountsQuerySchema>

export const DiscountsRowSchema = z.object({
  group_key: z.string(),
  /** Bill number / product / promotion / user name. */
  label: z.string(),
  label_ta: z.string().nullable(),
  ref_type: z.enum(['sales_invoice', 'product', 'promotion', 'user']),
  ref_id: zId.nullable(),
  /** bill grouping. */
  date: zDateStr.nullable(),
  customer_name: z.string().nullable(),
  user_name: z.string().nullable(),
  bills: zCount,
  /** item grouping. */
  qty_milli: zSignedMilli.nullable(),
  unit: z.string().nullable(),
  gross_paise: zPaise,
  item_discount_paise: zPaise,
  bill_discount_paise: zPaise,
  /** Part of the discount on lines with a promotion. */
  promotion_discount_paise: zPaise,
  discount_paise: zPaise,
  /** discount ÷ gross. */
  discount_bp: z.int().min(0),
})
export type DiscountsRow = z.output<typeof DiscountsRowSchema>

export const DiscountsTotalsSchema = z.object({
  bills: zCount,
  gross_paise: zPaise,
  item_discount_paise: zPaise,
  bill_discount_paise: zPaise,
  promotion_discount_paise: zPaise,
  discount_paise: zPaise,
  discount_bp: z.int().min(0),
})
export const DiscountsResponseSchema = reportResponse(DiscountsRowSchema, DiscountsTotalsSchema)
export type DiscountsResponse = z.output<typeof DiscountsResponseSchema>

// ---- cancellations ----------------------------------------------------------------------------

export const CancellationKindSchema = z.enum(['invoice', 'credit_note'])
export type CancellationKind = z.infer<typeof CancellationKindSchema>

export const CancellationsQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    kind: CancellationKindSchema.optional(),
    user_id: zId.optional().describe('Cancelled by'),
    sort: sortQuery(['cancelled_at', 'total_paise', 'number'] as const).prefault('-cancelled_at'),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type CancellationsQuery = z.input<typeof CancellationsQuerySchema>

/** Dates filter the cancellation date (tenant timezone). */
export const CancellationRowSchema = z.object({
  kind: CancellationKindSchema,
  document_id: zId,
  number: z.string().nullable(),
  document_date: zDateStr,
  created_by_name: z.string().nullable(),
  cancelled_at: zTimestamp,
  cancelled_by: zId.nullable(),
  cancelled_by_name: z.string().nullable(),
  reason: z.string().nullable(),
  customer_name: z.string().nullable(),
  store_name: z.string(),
  register_code: z.string().nullable(),
  total_paise: zPaise,
  /** Money given back when the bill was cancelled. */
  refunded_paise: zPaise,
  /** Minutes between billing and cancellation (late cancellations are suspicious). */
  minutes_after: z.int().min(0),
})
export type CancellationRow = z.output<typeof CancellationRowSchema>

export const CancellationsTotalsSchema = z.object({
  count: zCount,
  total_paise: zPaise,
  refunded_paise: zPaise,
})
export const CancellationsResponseSchema = reportResponse(
  CancellationRowSchema,
  CancellationsTotalsSchema,
)
export type CancellationsResponse = z.output<typeof CancellationsResponseSchema>

// ---- shifts summary ---------------------------------------------------------------------------

export const ShiftsReportQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    register_id: zId.optional(),
    user_id: zId.optional().describe('Opened by'),
    sort: sortQuery(['opened_at', 'difference_paise', 'sales_paise'] as const).prefault(
      '-opened_at',
    ),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type ShiftsReportQuery = z.input<typeof ShiftsReportQuerySchema>

export const ShiftsReportRowSchema = z.object({
  shift_id: zId,
  store_name: z.string(),
  register_code: z.string(),
  status: ShiftStatusSchema,
  opened_by_name: z.string().nullable(),
  opened_at: zTimestamp,
  closed_by_name: z.string().nullable(),
  closed_at: zTimestamp.nullable(),
  bills: zCount,
  sales_paise: zPaise,
  cash_paise: zPaise,
  upi_paise: zPaise,
  card_paise: zPaise,
  other_paise: zPaise,
  opening_cash_paise: zPaise,
  expected_cash_paise: zSignedPaise.nullable(),
  counted_cash_paise: zPaise.nullable(),
  difference_paise: zSignedPaise.nullable(),
})
export type ShiftsReportRow = z.output<typeof ShiftsReportRowSchema>

export const ShiftsReportTotalsSchema = z.object({
  shifts: zCount,
  bills: zCount,
  sales_paise: zPaise,
  cash_paise: zPaise,
  upi_paise: zPaise,
  card_paise: zPaise,
  other_paise: zPaise,
  /** Σ differences of closed shifts. */
  difference_paise: zSignedPaise,
})
export const ShiftsReportResponseSchema = reportResponse(
  ShiftsReportRowSchema,
  ShiftsReportTotalsSchema,
)
export type ShiftsReportResponse = z.output<typeof ShiftsReportResponseSchema>

// =============================================================================================
// Stock reports (as of now)
// =============================================================================================

export const StockSummaryQuerySchema = z.object({
  store_id: zReportStore,
  group_by: z.enum(['category', 'product']).default('category'),
  category_id: zId.optional(),
  brand_id: zId.optional(),
  include_zero: zBooleanQuery.default(false),
  q: zSearchQuery.optional(),
  sort: sortQuery(['value_cost_paise', 'value_mrp_paise', 'name', 'qty_milli'] as const).prefault(
    '-value_cost_paise',
  ),
  ...PageFields,
})
export type StockSummaryQuery = z.input<typeof StockSummaryQuerySchema>

/** Valuation at moving-average cost, at MRP and at the selling price. */
export const StockSummaryRowSchema = z.object({
  /** category id (null = uncategorised) or product id. */
  key_id: zId.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_name: z.string().nullable(),
  products: zCount,
  /** product grouping only. */
  sku: z.string().nullable(),
  unit: z.string().nullable(),
  pack_size: z.int().min(1).nullable(),
  qty_milli: zSignedMilli.nullable(),
  avg_cost_paise: zPaise.nullable(),
  value_cost_paise: zSignedPaise,
  value_mrp_paise: zSignedPaise,
  value_sale_paise: zSignedPaise,
  /** Products with stock below zero in the group. */
  negative_count: zCount,
})
export type StockSummaryRow = z.output<typeof StockSummaryRowSchema>

export const StockSummaryTotalsSchema = z.object({
  products: zCount,
  value_cost_paise: zSignedPaise,
  value_mrp_paise: zSignedPaise,
  value_sale_paise: zSignedPaise,
  negative_count: zCount,
})
export const StockSummaryResponseSchema = reportResponse(
  StockSummaryRowSchema,
  StockSummaryTotalsSchema,
)
export type StockSummaryResponse = z.output<typeof StockSummaryResponseSchema>

export const StockAgeingQuerySchema = z.object({
  store_id: zReportStore,
  group: z.enum(['product', 'batch']).default('product'),
  category_id: zId.optional(),
  bucket: AgeingBucketSchema.optional(),
  sort: sortQuery(['age_days', 'value_cost_paise', 'name'] as const).prefault('-age_days'),
  ...PageFields,
})
export type StockAgeingQuery = z.input<typeof StockAgeingQuerySchema>

/** Age = days since the last inbound movement (purchase / opening / transfer in) of the stock. */
export const StockAgeingRowSchema = z.object({
  product_id: zId,
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_name: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zSignedMilli,
  value_cost_paise: zSignedPaise,
  last_inbound_date: zDateStr.nullable(),
  age_days: z.int().min(0).nullable(),
  /** null when there is no inbound movement at all. */
  bucket: AgeingBucketSchema.nullable(),
})
export type StockAgeingRow = z.output<typeof StockAgeingRowSchema>

export const StockAgeingTotalsSchema = z.object({
  rows: zCount,
  value_cost_paise: zSignedPaise,
  bucket_0_30_paise: zSignedPaise,
  bucket_31_60_paise: zSignedPaise,
  bucket_61_90_paise: zSignedPaise,
  bucket_90_plus_paise: zSignedPaise,
})
export const StockAgeingResponseSchema = reportResponse(
  StockAgeingRowSchema,
  StockAgeingTotalsSchema,
)
export type StockAgeingResponse = z.output<typeof StockAgeingResponseSchema>

export const ExpiryQuerySchema = z.object({
  store_id: zReportStore,
  days: zQueryInt(0, 730)
    .optional()
    .describe('Expiring within N days (default settings.inventory.expiry_warning_days)'),
  include_expired: zBooleanQuery.default(true),
  category_id: zId.optional(),
  supplier_id: zId.optional().describe('Last supplier of the batch (expiry returns)'),
  sort: sortQuery(['expiry_date', 'value_cost_paise', 'name'] as const).prefault('expiry_date'),
  ...PageFields,
})
export type ExpiryQuery = z.input<typeof ExpiryQuerySchema>

/** Batches with stock that are expired or expire within `days`. */
export const ExpiryRowSchema = z.object({
  batch_id: zId,
  batch_no: z.string(),
  product_id: zId,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_name: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  store_id: zId,
  store_name: z.string(),
  expiry_date: zDateStr,
  /** Negative = expired that many days ago. */
  days_to_expiry: z.int(),
  status: z.enum(['expired', 'expiring']),
  qty_milli: zSignedMilli,
  value_cost_paise: zSignedPaise,
  value_mrp_paise: zSignedPaise,
  supplier_id: zId.nullable(),
  supplier_name: z.string().nullable(),
})
export type ExpiryRow = z.output<typeof ExpiryRowSchema>

export const ExpiryTotalsSchema = z.object({
  expired_count: zCount,
  expired_value_cost_paise: zSignedPaise,
  expiring_count: zCount,
  expiring_value_cost_paise: zSignedPaise,
  value_cost_paise: zSignedPaise,
  value_mrp_paise: zSignedPaise,
})
export const ExpiryResponseSchema = reportResponse(ExpiryRowSchema, ExpiryTotalsSchema)
export type ExpiryResponse = z.output<typeof ExpiryResponseSchema>

export const DeadStockQuerySchema = z.object({
  store_id: zReportStore,
  days: zQueryInt(1, 730).default(90).describe('No sale in the last N days'),
  category_id: zId.optional(),
  min_value_paise: zQueryInt(0, Number.MAX_SAFE_INTEGER).optional(),
  sort: sortQuery(['value_cost_paise', 'days_since_last_sale', 'name'] as const).prefault(
    '-value_cost_paise',
  ),
  ...PageFields,
})
export type DeadStockQuery = z.input<typeof DeadStockQuerySchema>

/** Products with stock > 0 and no completed sale in the last `days` days. */
export const DeadStockRowSchema = z.object({
  product_id: zId,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  category_name: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zSignedMilli,
  value_cost_paise: zSignedPaise,
  /** null = never sold. */
  last_sold_date: zDateStr.nullable(),
  days_since_last_sale: z.int().min(0).nullable(),
  last_inbound_date: zDateStr.nullable(),
})
export type DeadStockRow = z.output<typeof DeadStockRowSchema>

export const DeadStockTotalsSchema = z.object({ products: zCount, value_cost_paise: zSignedPaise })
export const DeadStockResponseSchema = reportResponse(DeadStockRowSchema, DeadStockTotalsSchema)
export type DeadStockResponse = z.output<typeof DeadStockResponseSchema>

// =============================================================================================
// Party outstanding (ageing)
// =============================================================================================

/** Ageing amounts (paise ≥ 0). Customers: by invoice date (not_due is 0); suppliers: by due date. */
const AgeingFields = {
  not_due_paise: zPaise,
  bucket_0_30_paise: zPaise,
  bucket_31_60_paise: zPaise,
  bucket_61_90_paise: zPaise,
  bucket_90_plus_paise: zPaise,
}

const OutstandingFields = {
  /** Ledger balance (customers: + owes the shop; suppliers: + the shop owes). */
  balance_paise: zSignedPaise,
  /** Σ open documents (+ unsettled opening balance). = Σ ageing buckets. */
  due_paise: zPaise,
  ...AgeingFields,
  /** Advances / unapplied payments and unsettled returns that offset the dues. */
  unallocated_credit_paise: zPaise,
  /** balance − (due − unallocated credit): manual journals on the party (normally 0). */
  unreconciled_paise: zSignedPaise,
  open_documents: zCount,
  oldest_due_date: zDateStr.nullable(),
  oldest_due_days: z.int().nullable(),
  last_payment_date: zDateStr.nullable(),
}

const OutstandingTotalsSchema = z.object({
  parties: zCount,
  balance_paise: zSignedPaise,
  due_paise: zPaise,
  ...AgeingFields,
  unallocated_credit_paise: zPaise,
  overdue_paise: zPaise,
})

const OutstandingQueryFields = {
  store_id: zReportStore.describe('Only documents of this store (balances stay tenant-wide)'),
  min_due_paise: zQueryInt(0, Number.MAX_SAFE_INTEGER).optional(),
  overdue_only: zBooleanQuery.default(false),
  bucket: AgeingBucketSchema.optional().describe('Parties with an amount in this bucket or older'),
  q: zSearchQuery.optional().describe('Name, phone or GSTIN'),
  ...PageFields,
}

export const CustomerOutstandingQuerySchema = z.object({
  ...OutstandingQueryFields,
  sort: sortQuery([
    'due_paise',
    'oldest_due_days',
    'name',
    'bucket_90_plus_paise',
  ] as const).prefault('-due_paise'),
})
export type CustomerOutstandingQuery = z.input<typeof CustomerOutstandingQuerySchema>

/**
 * Customers with dues, aged by invoice date (opening balances by the opening entry date). Overdue
 * = older than the customer's credit days (settings.credit.default_credit_days).
 */
export const CustomerOutstandingRowSchema = z.object({
  customer_id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  phone: z.string().nullable(),
  credit_limit_paise: zPaise.nullable(),
  credit_days: z.int().min(0),
  overdue_paise: zPaise,
  whatsapp_opt_in: z.boolean(),
  ...OutstandingFields,
})
export type CustomerOutstandingRow = z.output<typeof CustomerOutstandingRowSchema>

export const CustomerOutstandingResponseSchema = reportResponse(
  CustomerOutstandingRowSchema,
  OutstandingTotalsSchema,
)
export type CustomerOutstandingResponse = z.output<typeof CustomerOutstandingResponseSchema>

export const SupplierOutstandingQuerySchema = z.object({
  ...OutstandingQueryFields,
  sort: sortQuery(['due_paise', 'oldest_due_days', 'name', 'not_due_paise'] as const).prefault(
    '-due_paise',
  ),
})
export type SupplierOutstandingQuery = z.input<typeof SupplierOutstandingQuerySchema>

/** Suppliers the shop owes, aged by purchase-bill due date (no due date = bill date). */
export const SupplierOutstandingRowSchema = z.object({
  supplier_id: zId,
  name: z.string(),
  phone: z.string().nullable(),
  gstin: z.string().nullable(),
  overdue_paise: zPaise,
  /** Due within the next 7 days. */
  due_next_7_days_paise: zPaise,
  ...OutstandingFields,
})
export type SupplierOutstandingRow = z.output<typeof SupplierOutstandingRowSchema>

export const SupplierOutstandingResponseSchema = reportResponse(
  SupplierOutstandingRowSchema,
  OutstandingTotalsSchema,
)
export type SupplierOutstandingResponse = z.output<typeof SupplierOutstandingResponseSchema>

// =============================================================================================
// GST returns
// =============================================================================================

/** B2CL: inter-state B2C invoices with value above ₹1,00,000 (strictly greater). */
export const B2CL_INVOICE_THRESHOLD_PAISE = 10_000_000

/**
 * `version` written into the GSTR-1 offline-tool JSON (export). The layout follows the offline
 * tool with the Table-12 HSN split (`hsn.hsn_b2b` / `hsn.hsn_b2c`); update this constant (and the
 * builder) when GSTN publishes a new tool version.
 */
export const GSTR1_PORTAL_SCHEMA_VERSION = 'GST3.2.1'

/** Composition traders pay 1 % (0.5 % CGST + 0.5 % SGST) of their taxable turnover (CMP-08). */
export const COMPOSITION_TRADER_RATE_BP = 100

/** GSTR-1 Table 13 document types used by Kadai. */
export const GST_DOC_TYPES = {
  1: 'Invoices for outward supply',
  5: 'Credit Note',
  12: 'Delivery Challan in cases other than by way of supply (excluding at S no. 9 to 11)',
} as const
export type GstDocNum = keyof typeof GST_DOC_TYPES

/** Rate for the portal: 1800 bp → 18, 25 → 0.25. */
export function gstRateFromBp(bp: number): number {
  return bp / 100
}

/** Rupees with 2 decimals as a JSON number (portal amounts). */
export function rupeesFromPaise(paise: number): number {
  return Number(paiseToRupeesString(paise))
}

/** 'YYYY-MM-DD' → 'dd-mm-yyyy' (portal date format). */
export function gstPortalDate(date: string): string {
  return `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`
}

/** Splits a document number into its series prefix and sequence: 'S1-A/2627/00042' → { 'S1-A/2627/', 42 }. */
export function splitDocumentNumber(number: string): { prefix: string; seq: number | null } {
  const m = /^(.*?)(\d+)$/.exec(number)
  if (!m) return { prefix: number, seq: null }
  return { prefix: m[1]!, seq: Number(m[2]) }
}

export const GstPeriodQuerySchema = z.object({
  period: zPeriod.describe('Tax period YYYY-MM'),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .optional()
    .describe('Registration to report (multi-state shops); default the business GSTIN'),
})
export type GstPeriodQuery = z.input<typeof GstPeriodQuerySchema>

const TaxHeadsFields = {
  igst_paise: zSignedPaise,
  cgst_paise: zSignedPaise,
  sgst_paise: zSignedPaise,
  cess_paise: zSignedPaise,
}
export const TaxHeadsSchema = z.object(TaxHeadsFields)
export type TaxHeads = z.output<typeof TaxHeadsSchema>

export const TaxRowSchema = z.object({ taxable_paise: zSignedPaise, ...TaxHeadsFields })
export type TaxRow = z.output<typeof TaxRowSchema>

/** One rate of a document (lines grouped by GST rate). */
export const GstRateItemSchema = z.object({ rate_bp: z.int().min(0), ...TaxRowSchema.shape })
export type GstRateItem = z.output<typeof GstRateItemSchema>

export const Gstr1InvoiceSchema = z.object({
  invoice_id: zId,
  number: z.string(),
  date: zDateStr,
  /** Invoice total (incl. tax, after round off). */
  value_paise: zPaise,
  place_of_supply: z.string(),
  reverse_charge: z.boolean(),
  invoice_type: z.literal('R'),
  customer_name: z.string().nullable(),
  items: z.array(GstRateItemSchema),
})
export type Gstr1Invoice = z.output<typeof Gstr1InvoiceSchema>

export const Gstr1NoteSchema = z.object({
  credit_note_id: zId,
  number: z.string(),
  date: zDateStr,
  note_type: z.literal('C'),
  value_paise: zPaise,
  place_of_supply: z.string(),
  reverse_charge: z.boolean(),
  original_invoice_number: z.string().nullable(),
  original_invoice_date: zDateStr.nullable(),
  customer_name: z.string().nullable(),
  items: z.array(GstRateItemSchema),
})
export type Gstr1Note = z.output<typeof Gstr1NoteSchema>

export const HsnRowSchema = z.object({
  /** null = lines without HSN (also listed in warnings). */
  hsn_code: z.string().nullable(),
  description: z.string().nullable(),
  /** GST unit quantity code (shared units uqcFor()). */
  uqc: z.string(),
  /** Net quantity in base units (sales − returns), milli. */
  qty_milli: zSignedMilli,
  rate_bp: z.int().min(0),
  taxable_paise: zSignedPaise,
  ...TaxHeadsFields,
  /** taxable + taxes. */
  total_value_paise: zSignedPaise,
})
export type HsnRow = z.output<typeof HsnRowSchema>

const NilRowSchema = z.object({
  nil_rated_paise: zSignedPaise,
  exempt_paise: zSignedPaise,
  non_gst_paise: zSignedPaise,
})

export const GSTR1_SECTIONS = [
  'b2b',
  'b2cl',
  'b2cs',
  'cdnr',
  'cdnur',
  'nil',
  'hsn_b2b',
  'hsn_b2c',
  'doc_issue',
] as const
export const Gstr1SectionSchema = z.enum(GSTR1_SECTIONS)
export type Gstr1Section = z.infer<typeof Gstr1SectionSchema>

export const GSTR1_SECTION_LABELS: Readonly<Record<Gstr1Section, BilingualLabel>> = {
  b2b: { en: 'B2B invoices (4A)', ta: 'B2B பில்கள் (4A)' },
  b2cl: { en: 'B2C large inter-state (5)', ta: 'பெரிய B2C மாநிலம் தாண்டிய (5)' },
  b2cs: { en: 'B2C others (7)', ta: 'இதர B2C (7)' },
  cdnr: { en: 'Credit notes — registered (9B)', ta: 'கிரெடிட் நோட் — பதிவுபெற்றவர் (9B)' },
  cdnur: { en: 'Credit notes — unregistered (9B)', ta: 'கிரெடிட் நோட் — பதிவில்லாதவர் (9B)' },
  nil: { en: 'Nil / exempt supplies (8)', ta: 'வரியில்லா / விலக்கு விநியோகம் (8)' },
  hsn_b2b: { en: 'HSN summary — B2B (12)', ta: 'HSN சுருக்கம் — B2B (12)' },
  hsn_b2c: { en: 'HSN summary — B2C (12)', ta: 'HSN சுருக்கம் — B2C (12)' },
  doc_issue: { en: 'Documents issued (13)', ta: 'வழங்கிய ஆவணங்கள் (13)' },
}

export const GST_WARNING_CODES = [
  // B2B invoice / note whose GSTIN fails validation, or a registered customer (GSTIN on file)
  // billed without one (details.gstin null, details.customer_gstin) → reported as B2C
  'invalid_customer_gstin',
  'missing_hsn',
  'invalid_hsn',
  'hsn_too_short', // fewer digits than required for the turnover (min 4)
  'missing_place_of_supply',
  'invalid_place_of_supply',
  'invalid_gst_rate', // rate not in GST_RATES_BP
  'credit_note_without_invoice',
  'business_gstin_missing',
  'missing_purchase_gstin', // ITC claimed on a bill / expense without a supplier GSTIN (3B)
] as const
export const GstWarningCodeSchema = z.enum(GST_WARNING_CODES)
export type GstWarningCode = z.infer<typeof GstWarningCodeSchema>

/** A data problem to fix before filing (web: reports:gst_warnings.<code>, link via `path`). */
export const GstWarningSchema = z.object({
  code: GstWarningCodeSchema,
  severity: z.enum(['error', 'warning']),
  section: z.string().nullable(),
  ref_type: z.enum([
    'sales_invoice',
    'credit_note',
    'purchase_bill',
    'expense',
    'product',
    'customer',
    'tenant',
  ]),
  ref_id: zId.nullable(),
  /** Invoice / note number, product or customer name. */
  label: z.string().nullable(),
  /** Web page to fix it (product / customer / document / settings). */
  path: z.string().nullable(),
  /** e.g. { gstin, hsn_code, rate_bp }. */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
})
export type GstWarning = z.output<typeof GstWarningSchema>

export const GstinOptionSchema = z.object({
  gstin: z.string(),
  state_code: z.string(),
  store_ids: z.array(zId),
  store_names: z.array(z.string()),
})
export type GstinOption = z.output<typeof GstinOptionSchema>

const GstHeaderFields = {
  period: zPeriod,
  /** MMYYYY. */
  fp: z.string(),
  gstin: z.string(),
  legal_name: z.string().nullable(),
  trade_name: z.string(),
  /** Registrations of the business (pick one when there are several). */
  gstins: z.array(GstinOptionSchema),
  /** Stores whose documents are covered (store GSTIN, else the business GSTIN). */
  store_ids: z.array(zId),
  generated_at: zTimestamp,
}

export const Gstr1SectionSummarySchema = z.object({
  section: Gstr1SectionSchema,
  /** Documents (or rows for b2cs / nil / hsn). */
  count: zCount,
  value_paise: zSignedPaise,
  ...TaxRowSchema.shape,
})

export const DocIssueSeriesSchema = z.object({
  prefix: z.string(),
  from: z.string(),
  to: z.string(),
  /** Documents numbered in the period (incl. cancelled). */
  total: zCount,
  cancelled: zCount,
  net_issued: zCount,
})

/**
 * GSTR-1 for a period (paise; the export converts to rupees). Bucketing (ARCHITECTURE.md §9.2):
 * B2B = valid customer GSTIN; B2CL = inter-state, no GSTIN, value > B2CL_INVOICE_THRESHOLD_PAISE;
 * B2CS = the rest, aggregated by supply type + place of supply + rate, net of their credit notes;
 * CDNR = credit notes of B2B customers; CDNUR = credit notes against B2CL invoices. 0 % lines go to
 * NIL (as exempt) and are excluded from B2B / B2CL / B2CS items. HSN is split B2B / B2C.
 */
export const Gstr1ReportSchema = z.object({
  kind: z.literal('gstr1'),
  ...GstHeaderFields,
  summary: z.array(Gstr1SectionSummarySchema),
  b2b: z.array(
    z.object({
      ctin: z.string(),
      receiver_name: z.string().nullable(),
      invoices: z.array(Gstr1InvoiceSchema),
    }),
  ),
  b2cl: z.array(z.object({ place_of_supply: z.string(), invoices: z.array(Gstr1InvoiceSchema) })),
  b2cs: z.array(
    z.object({
      supply_type: z.enum(['INTRA', 'INTER']),
      place_of_supply: z.string(),
      rate_bp: z.int().min(0),
      type: z.literal('OE'),
      ...TaxRowSchema.shape,
    }),
  ),
  cdnr: z.array(
    z.object({
      ctin: z.string(),
      receiver_name: z.string().nullable(),
      notes: z.array(Gstr1NoteSchema),
    }),
  ),
  cdnur: z.array(Gstr1NoteSchema.extend({ type: z.literal('B2CL') })),
  nil: z.object({
    inter_b2b: NilRowSchema,
    intra_b2b: NilRowSchema,
    inter_b2c: NilRowSchema,
    intra_b2c: NilRowSchema,
  }),
  hsn: z.object({ b2b: z.array(HsnRowSchema), b2c: z.array(HsnRowSchema) }),
  doc_issue: z.array(
    z.object({
      doc_num: z.union([z.literal(1), z.literal(5), z.literal(12)]),
      doc_type: z.string(),
      series: z.array(DocIssueSeriesSchema),
    }),
  ),
  warnings: z.array(GstWarningSchema),
})
export type Gstr1Report = z.output<typeof Gstr1ReportSchema>

/** Composition tenants: CMP-08 / GSTR-4 style quarterly turnover instead of GSTR-1 / 3B. */
export const CompositionSummarySchema = z.object({
  kind: z.literal('composition'),
  ...GstHeaderFields,
  fy: z.string(),
  rate_bp: z.int().min(0),
  /** Quarter containing `period`. */
  quarter: z.enum(['Q1', 'Q2', 'Q3', 'Q4']),
  quarters: z.array(
    z.object({
      quarter: z.enum(['Q1', 'Q2', 'Q3', 'Q4']),
      from: zDateStr,
      to: zDateStr,
      bills: zCount,
      /** All outward supplies net of returns (incl. exempt). */
      outward_turnover_paise: zSignedPaise,
      /** Excluding nil / exempt supplies: the tax base. */
      taxable_turnover_paise: zSignedPaise,
      cgst_paise: zSignedPaise,
      sgst_paise: zSignedPaise,
      /** Purchases attracting reverse charge and the tax on them (paid in cash). */
      inward_rcm_taxable_paise: zSignedPaise,
      inward_rcm_tax_paise: zSignedPaise,
    }),
  ),
  warnings: z.array(GstWarningSchema),
})
export type CompositionSummary = z.output<typeof CompositionSummarySchema>

/** Unregistered businesses file no GST return. */
export const GstUnregisteredSchema = z.object({ kind: z.literal('unregistered'), period: zPeriod })

export const Gstr1ResponseSchema = z.discriminatedUnion('kind', [
  Gstr1ReportSchema,
  CompositionSummarySchema,
  GstUnregisteredSchema,
])
export type Gstr1Response = z.output<typeof Gstr1ResponseSchema>

/** Quarter (Q1 = Apr–Jun) of a period for FY-April businesses. */
export function gstQuarterOf(period: string): 'Q1' | 'Q2' | 'Q3' | 'Q4' {
  const m = Number(period.slice(5, 7))
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4'
}

/** CGST / SGST of a composition taxable turnover (half each, CGST takes the odd paisa). */
export function compositionTax(
  taxableTurnoverPaise: number,
  rateBp: number = COMPOSITION_TRADER_RATE_BP,
): { cgst_paise: number; sgst_paise: number } {
  const tax = roundDiv(taxableTurnoverPaise * rateBp, 10_000)
  const sgst = Math.floor(tax / 2)
  return { cgst_paise: tax - sgst, sgst_paise: sgst }
}

// ---- GSTR-1 offline-tool JSON (export) -------------------------------------------------------------

const PortalItemSchema = z.object({
  num: z.int().min(1),
  itm_det: z.object({
    txval: z.number(),
    rt: z.number(),
    iamt: z.number().optional(),
    camt: z.number().optional(),
    samt: z.number().optional(),
    csamt: z.number(),
  }),
})
const PortalHsnSchema = z.object({
  num: z.int().min(1),
  hsn_sc: z.string(),
  desc: z.string().optional(),
  uqc: z.string(),
  qty: z.number(),
  rt: z.number(),
  txval: z.number(),
  iamt: z.number(),
  camt: z.number(),
  samt: z.number(),
  csamt: z.number(),
})

/** The JSON imported by the GST offline tool / portal (amounts in rupees, dates dd-mm-yyyy). */
export const Gstr1PortalJsonSchema = z.object({
  gstin: z.string(),
  fp: z.string().regex(/^\d{6}$/),
  version: z.string(),
  hash: z.literal('hash'),
  b2b: z
    .array(
      z.object({
        ctin: z.string(),
        inv: z.array(
          z.object({
            inum: z.string(),
            idt: z.string(),
            val: z.number(),
            pos: z.string(),
            rchrg: z.enum(['Y', 'N']),
            inv_typ: z.literal('R'),
            itms: z.array(PortalItemSchema),
          }),
        ),
      }),
    )
    .optional(),
  b2cl: z
    .array(
      z.object({
        pos: z.string(),
        inv: z.array(
          z.object({
            inum: z.string(),
            idt: z.string(),
            val: z.number(),
            itms: z.array(PortalItemSchema),
          }),
        ),
      }),
    )
    .optional(),
  b2cs: z
    .array(
      z.object({
        sply_ty: z.enum(['INTRA', 'INTER']),
        pos: z.string(),
        typ: z.literal('OE'),
        txval: z.number(),
        rt: z.number(),
        iamt: z.number().optional(),
        camt: z.number().optional(),
        samt: z.number().optional(),
        csamt: z.number(),
      }),
    )
    .optional(),
  cdnr: z
    .array(
      z.object({
        ctin: z.string(),
        nt: z.array(
          z.object({
            ntty: z.literal('C'),
            nt_num: z.string(),
            nt_dt: z.string(),
            val: z.number(),
            pos: z.string(),
            rchrg: z.enum(['Y', 'N']),
            inv_typ: z.literal('R'),
            itms: z.array(PortalItemSchema),
          }),
        ),
      }),
    )
    .optional(),
  cdnur: z
    .array(
      z.object({
        typ: z.literal('B2CL'),
        ntty: z.literal('C'),
        nt_num: z.string(),
        nt_dt: z.string(),
        val: z.number(),
        pos: z.string(),
        itms: z.array(PortalItemSchema),
      }),
    )
    .optional(),
  nil: z
    .object({
      inv: z.array(
        z.object({
          sply_ty: z.enum(['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C']),
          expt_amt: z.number(),
          nil_amt: z.number(),
          ngsup_amt: z.number(),
        }),
      ),
    })
    .optional(),
  hsn: z
    .object({
      hsn_b2b: z.array(PortalHsnSchema).optional(),
      hsn_b2c: z.array(PortalHsnSchema).optional(),
    })
    .optional(),
  doc_issue: z
    .object({
      doc_det: z.array(
        z.object({
          doc_num: z.int(),
          doc_typ: z.string(),
          docs: z.array(
            z.object({
              num: z.int().min(1),
              from: z.string(),
              to: z.string(),
              totnum: z.int(),
              cancel: z.int(),
              net_issue: z.int(),
            }),
          ),
        }),
      ),
    })
    .optional(),
})
export type Gstr1PortalJson = z.output<typeof Gstr1PortalJsonSchema>

function portalItems(items: readonly GstRateItem[], interstate: boolean) {
  return items.map((it, i) => ({
    num: i + 1,
    itm_det: {
      txval: rupeesFromPaise(it.taxable_paise),
      rt: gstRateFromBp(it.rate_bp),
      ...(interstate
        ? { iamt: rupeesFromPaise(it.igst_paise) }
        : { camt: rupeesFromPaise(it.cgst_paise), samt: rupeesFromPaise(it.sgst_paise) }),
      csamt: rupeesFromPaise(it.cess_paise),
    },
  }))
}

const isInterItems = (items: readonly GstRateItem[]) => items.some((it) => it.igst_paise !== 0)

function portalHsn(rows: readonly HsnRow[]) {
  return rows
    .filter((r) => r.hsn_code)
    .map((r, i) => ({
      num: i + 1,
      hsn_sc: r.hsn_code!,
      ...(r.description ? { desc: r.description.slice(0, 30) } : {}),
      uqc: r.uqc,
      qty: Number(milliToDecimalString(r.qty_milli)),
      rt: gstRateFromBp(r.rate_bp),
      txval: rupeesFromPaise(r.taxable_paise),
      iamt: rupeesFromPaise(r.igst_paise),
      camt: rupeesFromPaise(r.cgst_paise),
      samt: rupeesFromPaise(r.sgst_paise),
      csamt: rupeesFromPaise(r.cess_paise),
    }))
}

/**
 * Converts a GSTR-1 report into the offline-tool JSON (GET /reports/tax/gstr1/export?format=json).
 * Empty sections are omitted; lines without HSN are left out of the HSN tables (they are warnings).
 */
export function buildGstr1PortalJson(report: Gstr1Report): Gstr1PortalJson {
  const out: Gstr1PortalJson = {
    gstin: report.gstin,
    fp: report.fp,
    version: GSTR1_PORTAL_SCHEMA_VERSION,
    hash: 'hash',
  }
  if (report.b2b.length)
    out.b2b = report.b2b.map((p) => ({
      ctin: p.ctin,
      inv: p.invoices.map((inv) => ({
        inum: inv.number,
        idt: gstPortalDate(inv.date),
        val: rupeesFromPaise(inv.value_paise),
        pos: inv.place_of_supply,
        rchrg: inv.reverse_charge ? ('Y' as const) : ('N' as const),
        inv_typ: 'R' as const,
        itms: portalItems(inv.items, isInterItems(inv.items)),
      })),
    }))
  if (report.b2cl.length)
    out.b2cl = report.b2cl.map((p) => ({
      pos: p.place_of_supply,
      inv: p.invoices.map((inv) => ({
        inum: inv.number,
        idt: gstPortalDate(inv.date),
        val: rupeesFromPaise(inv.value_paise),
        itms: portalItems(inv.items, true),
      })),
    }))
  if (report.b2cs.length)
    out.b2cs = report.b2cs.map((r) => ({
      sply_ty: r.supply_type,
      pos: r.place_of_supply,
      typ: 'OE' as const,
      txval: rupeesFromPaise(r.taxable_paise),
      rt: gstRateFromBp(r.rate_bp),
      ...(r.supply_type === 'INTER'
        ? { iamt: rupeesFromPaise(r.igst_paise) }
        : { camt: rupeesFromPaise(r.cgst_paise), samt: rupeesFromPaise(r.sgst_paise) }),
      csamt: rupeesFromPaise(r.cess_paise),
    }))
  if (report.cdnr.length)
    out.cdnr = report.cdnr.map((p) => ({
      ctin: p.ctin,
      nt: p.notes.map((n) => ({
        ntty: 'C' as const,
        nt_num: n.number,
        nt_dt: gstPortalDate(n.date),
        val: rupeesFromPaise(n.value_paise),
        pos: n.place_of_supply,
        rchrg: n.reverse_charge ? ('Y' as const) : ('N' as const),
        inv_typ: 'R' as const,
        itms: portalItems(n.items, isInterItems(n.items)),
      })),
    }))
  if (report.cdnur.length)
    out.cdnur = report.cdnur.map((n) => ({
      typ: 'B2CL' as const,
      ntty: 'C' as const,
      nt_num: n.number,
      nt_dt: gstPortalDate(n.date),
      val: rupeesFromPaise(n.value_paise),
      pos: n.place_of_supply,
      itms: portalItems(n.items, true),
    }))
  const nilRows = (
    [
      ['INTRB2B', report.nil.inter_b2b],
      ['INTRAB2B', report.nil.intra_b2b],
      ['INTRB2C', report.nil.inter_b2c],
      ['INTRAB2C', report.nil.intra_b2c],
    ] as const
  )
    .filter(([, r]) => r.nil_rated_paise || r.exempt_paise || r.non_gst_paise)
    .map(([sply_ty, r]) => ({
      sply_ty,
      expt_amt: rupeesFromPaise(r.exempt_paise),
      nil_amt: rupeesFromPaise(r.nil_rated_paise),
      ngsup_amt: rupeesFromPaise(r.non_gst_paise),
    }))
  if (nilRows.length) out.nil = { inv: nilRows }
  const hsnB2b = portalHsn(report.hsn.b2b)
  const hsnB2c = portalHsn(report.hsn.b2c)
  if (hsnB2b.length || hsnB2c.length)
    out.hsn = {
      ...(hsnB2b.length ? { hsn_b2b: hsnB2b } : {}),
      ...(hsnB2c.length ? { hsn_b2c: hsnB2c } : {}),
    }
  const docs = report.doc_issue.filter((d) => d.series.length)
  if (docs.length)
    out.doc_issue = {
      doc_det: docs.map((d) => ({
        doc_num: d.doc_num,
        doc_typ: d.doc_type,
        docs: d.series.map((s, i) => ({
          num: i + 1,
          from: s.from,
          to: s.to,
          totnum: s.total,
          cancel: s.cancelled,
          net_issue: s.net_issued,
        })),
      })),
    }
  return out
}

// ---- GSTR-1 CSV (offline-tool Excel column names) -------------------------------------------------

function posLabel(code: string): string {
  const st = getState(code)
  return st ? `${code}-${st.name_en}` : code
}

const money = (p: number) => paiseToRupeesString(p)
const rate = (bp: number) => String(gstRateFromBp(bp))

/** Header + rows of one GSTR-1 section in the offline tool's CSV layout. */
export function gstr1SectionRows(report: Gstr1Report, section: Gstr1Section): CsvValue[][] {
  switch (section) {
    case 'b2b':
      return [
        [
          'GSTIN/UIN of Recipient',
          'Receiver Name',
          'Invoice Number',
          'Invoice date',
          'Invoice Value',
          'Place Of Supply',
          'Reverse Charge',
          'Invoice Type',
          'Rate',
          'Taxable Value',
          'Integrated Tax',
          'Central Tax',
          'State/UT Tax',
          'Cess Amount',
        ],
        ...report.b2b.flatMap((p) =>
          p.invoices.flatMap((inv) =>
            inv.items.map((it) => [
              p.ctin,
              p.receiver_name,
              inv.number,
              gstPortalDate(inv.date),
              money(inv.value_paise),
              posLabel(inv.place_of_supply),
              inv.reverse_charge ? 'Y' : 'N',
              'Regular B2B',
              rate(it.rate_bp),
              money(it.taxable_paise),
              money(it.igst_paise),
              money(it.cgst_paise),
              money(it.sgst_paise),
              money(it.cess_paise),
            ]),
          ),
        ),
      ]
    case 'b2cl':
      return [
        [
          'Invoice Number',
          'Invoice date',
          'Invoice Value',
          'Place Of Supply',
          'Rate',
          'Taxable Value',
          'Integrated Tax',
          'Cess Amount',
        ],
        ...report.b2cl.flatMap((p) =>
          p.invoices.flatMap((inv) =>
            inv.items.map((it) => [
              inv.number,
              gstPortalDate(inv.date),
              money(inv.value_paise),
              posLabel(p.place_of_supply),
              rate(it.rate_bp),
              money(it.taxable_paise),
              money(it.igst_paise),
              money(it.cess_paise),
            ]),
          ),
        ),
      ]
    case 'b2cs':
      return [
        [
          'Type',
          'Supply Type',
          'Place Of Supply',
          'Rate',
          'Taxable Value',
          'Integrated Tax',
          'Central Tax',
          'State/UT Tax',
          'Cess Amount',
        ],
        ...report.b2cs.map((r) => [
          r.type,
          r.supply_type === 'INTER' ? 'Inter State' : 'Intra State',
          posLabel(r.place_of_supply),
          rate(r.rate_bp),
          money(r.taxable_paise),
          money(r.igst_paise),
          money(r.cgst_paise),
          money(r.sgst_paise),
          money(r.cess_paise),
        ]),
      ]
    case 'cdnr':
      return [
        [
          'GSTIN/UIN of Recipient',
          'Receiver Name',
          'Note Number',
          'Note Date',
          'Note Type',
          'Place Of Supply',
          'Reverse Charge',
          'Note Value',
          'Rate',
          'Taxable Value',
          'Integrated Tax',
          'Central Tax',
          'State/UT Tax',
          'Cess Amount',
        ],
        ...report.cdnr.flatMap((p) =>
          p.notes.flatMap((n) =>
            n.items.map((it) => [
              p.ctin,
              p.receiver_name,
              n.number,
              gstPortalDate(n.date),
              'C',
              posLabel(n.place_of_supply),
              n.reverse_charge ? 'Y' : 'N',
              money(n.value_paise),
              rate(it.rate_bp),
              money(it.taxable_paise),
              money(it.igst_paise),
              money(it.cgst_paise),
              money(it.sgst_paise),
              money(it.cess_paise),
            ]),
          ),
        ),
      ]
    case 'cdnur':
      return [
        [
          'UR Type',
          'Note Number',
          'Note Date',
          'Note Type',
          'Place Of Supply',
          'Note Value',
          'Rate',
          'Taxable Value',
          'Integrated Tax',
          'Cess Amount',
        ],
        ...report.cdnur.flatMap((n) =>
          n.items.map((it) => [
            n.type,
            n.number,
            gstPortalDate(n.date),
            'C',
            posLabel(n.place_of_supply),
            money(n.value_paise),
            rate(it.rate_bp),
            money(it.taxable_paise),
            money(it.igst_paise),
            money(it.cess_paise),
          ]),
        ),
      ]
    case 'nil':
      return [
        [
          'Description',
          'Nil Rated Supplies',
          'Exempted (other than nil rated/non GST supply)',
          'Non-GST Supplies',
        ],
        ...(
          [
            ['Inter-State supplies to registered persons', report.nil.inter_b2b],
            ['Intra-State supplies to registered persons', report.nil.intra_b2b],
            ['Inter-State supplies to unregistered persons', report.nil.inter_b2c],
            ['Intra-State supplies to unregistered persons', report.nil.intra_b2c],
          ] as const
        ).map(([label, r]) => [
          label,
          money(r.nil_rated_paise),
          money(r.exempt_paise),
          money(r.non_gst_paise),
        ]),
      ]
    case 'hsn_b2b':
    case 'hsn_b2c':
      return [
        [
          'HSN',
          'Description',
          'UQC',
          'Total Quantity',
          'Total Value',
          'Rate',
          'Taxable Value',
          'Integrated Tax Amount',
          'Central Tax Amount',
          'State/UT Tax Amount',
          'Cess Amount',
        ],
        ...(section === 'hsn_b2b' ? report.hsn.b2b : report.hsn.b2c).map((r) => [
          r.hsn_code,
          r.description,
          r.uqc,
          milliToDecimalString(r.qty_milli),
          money(r.total_value_paise),
          rate(r.rate_bp),
          money(r.taxable_paise),
          money(r.igst_paise),
          money(r.cgst_paise),
          money(r.sgst_paise),
          money(r.cess_paise),
        ]),
      ]
    case 'doc_issue':
      return [
        ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
        ...report.doc_issue.flatMap((d) =>
          d.series.map((s) => [d.doc_type, s.from, s.to, s.total, s.cancelled]),
        ),
      ]
  }
}

/**
 * GSTR-1 CSV: one section (`?section=`) or every section one after another, each preceded by a
 * '# <section>' line and separated by a blank line.
 */
export function gstr1Csv(report: Gstr1Report, section?: Gstr1Section): string {
  if (section) return toCsv(gstr1SectionRows(report, section))
  const rows: CsvValue[][] = []
  for (const s of GSTR1_SECTIONS) {
    if (rows.length) rows.push([])
    rows.push([`# ${s}`], ...gstr1SectionRows(report, s))
  }
  return toCsv(rows)
}

export const Gstr1ExportQuerySchema = GstPeriodQuerySchema.extend({
  format: z.enum(['json', 'csv']).default('json'),
  section: Gstr1SectionSchema.optional().describe('csv only: one section instead of all'),
}).refine((v) => !v.section || v.format === 'csv', {
  message: 'section_csv_only',
  path: ['section'],
})
export type Gstr1ExportQuery = z.input<typeof Gstr1ExportQuerySchema>

/** Download file name: 'GSTR1_33ABCDE1234F1Z5_102026.json'. */
export function gstr1ExportFilename(
  gstin: string,
  period: string,
  format: 'json' | 'csv',
  section?: string,
): string {
  return `GSTR1_${gstin}_${periodToFp(period)}${section ? `_${section}` : ''}.${format}`
}

// ---- GSTR-3B ---------------------------------------------------------------------------------------

const zTaxHeadKey = z.enum(['igst', 'cgst', 'sgst', 'cess'])
export type TaxHead = z.infer<typeof zTaxHeadKey>
export const TAX_HEADS: readonly TaxHead[] = ['igst', 'cgst', 'sgst', 'cess']

export const Gstr3bPaymentRowSchema = z.object({
  head: zTaxHeadKey,
  /** Output tax other than reverse charge. */
  payable_paise: zSignedPaise,
  /** Paid through ITC, by credit head. */
  paid_itc: TaxHeadsSchema,
  /** Cash for the forward-charge liability left after ITC. */
  paid_cash_paise: zSignedPaise,
  /** Reverse-charge tax (always paid in cash). */
  rcm_payable_paise: zSignedPaise,
})

/**
 * GSTR-3B for a period: 3.1 outward supplies (a taxable, b zero-rated, c nil / exempt, d inward
 * reverse charge, e non-GST), 3.2 inter-state supplies to unregistered persons by place of supply,
 * 4 ITC (A(5) all other ITC = posted purchase bills by received date + ITC-eligible expenses, net
 * of debit notes; B(1) = tax on bills / expenses marked not ITC-eligible (blocked u/s 17(5)), which
 * A(5) also includes; C = A − B), 5 exempt / nil / non-GST inward supplies, 6.1 payment of tax
 * with ITC utilised per utiliseItc().
 */
export const Gstr3bReportSchema = z.object({
  kind: z.literal('gstr3b'),
  ...GstHeaderFields,
  outward: z.object({
    taxable: TaxRowSchema,
    zero_rated: TaxRowSchema,
    nil_exempt: TaxRowSchema,
    inward_rcm: TaxRowSchema,
    non_gst: TaxRowSchema,
  }),
  inter_state_unregistered: z.array(
    z.object({
      place_of_supply: z.string(),
      taxable_paise: zSignedPaise,
      igst_paise: zSignedPaise,
    }),
  ),
  itc: z.object({
    import_goods: TaxHeadsSchema,
    import_services: TaxHeadsSchema,
    inward_rcm: TaxHeadsSchema,
    isd: TaxHeadsSchema,
    all_other: TaxHeadsSchema,
    reversed_rules: TaxHeadsSchema,
    reversed_others: TaxHeadsSchema,
    net: TaxHeadsSchema,
    ineligible_16_4: TaxHeadsSchema,
    ineligible_pos: TaxHeadsSchema,
  }),
  exempt_inward: z.object({
    composition_exempt_nil: z.object({ inter_paise: zSignedPaise, intra_paise: zSignedPaise }),
    non_gst: z.object({ inter_paise: zSignedPaise, intra_paise: zSignedPaise }),
  }),
  payment: z.object({
    rows: z.array(Gstr3bPaymentRowSchema),
    /** ITC left after utilisation (carried forward). */
    itc_balance: TaxHeadsSchema,
    cash_total_paise: zSignedPaise,
  }),
  sources: z.object({
    sales_invoices: zCount,
    credit_notes: zCount,
    purchase_bills: zCount,
    debit_notes: zCount,
    expenses: zCount,
  }),
  warnings: z.array(GstWarningSchema),
})
export type Gstr3bReport = z.output<typeof Gstr3bReportSchema>

export const Gstr3bResponseSchema = z.discriminatedUnion('kind', [
  Gstr3bReportSchema,
  CompositionSummarySchema,
  GstUnregisteredSchema,
])
export type Gstr3bResponse = z.output<typeof Gstr3bResponseSchema>

type Heads = Record<TaxHead, number>

const headsOf = (t: TaxHeads): Heads => ({
  igst: t.igst_paise,
  cgst: t.cgst_paise,
  sgst: t.sgst_paise,
  cess: t.cess_paise,
})
const taxHeads = (h: Heads): TaxHeads => ({
  igst_paise: h.igst,
  cgst_paise: h.cgst,
  sgst_paise: h.sgst,
  cess_paise: h.cess,
})

/**
 * ITC utilisation (sections 49, 49A, 49B; rule 88A) minimising cash: IGST credit pays IGST, then
 * CGST / SGST (shortfalls first; IGST credit is always used up before CGST / SGST credit); CGST
 * credit pays CGST then IGST; SGST credit pays SGST then IGST; CGST and SGST never cross; cess only
 * cess. Negative inputs count as 0.
 */
export function utiliseItc(
  liability: TaxHeads,
  credit: TaxHeads,
): {
  /** used[credit head][liability head] in paise. */
  used: Record<TaxHead, Heads>
  cash: TaxHeads
  balance: TaxHeads
} {
  const L = headsOf(liability)
  const C = headsOf(credit)
  for (const h of TAX_HEADS) {
    L[h] = Math.max(0, L[h])
    C[h] = Math.max(0, C[h])
  }
  const zero = (): Heads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 })
  const used: Record<TaxHead, Heads> = { igst: zero(), cgst: zero(), sgst: zero(), cess: zero() }
  const use = (from: TaxHead, to: TaxHead, amount: number) => {
    const a = Math.max(0, Math.min(amount, C[from], L[to]))
    C[from] -= a
    L[to] -= a
    used[from][to] += a
  }
  use('igst', 'igst', L.igst)
  use('igst', 'cgst', Math.max(0, L.cgst - C.cgst))
  use('igst', 'sgst', Math.max(0, L.sgst - C.sgst))
  use('igst', 'cgst', L.cgst)
  use('igst', 'sgst', L.sgst)
  use('cgst', 'cgst', L.cgst)
  use('cgst', 'igst', L.igst)
  use('sgst', 'sgst', L.sgst)
  use('sgst', 'igst', L.igst)
  use('cess', 'cess', L.cess)
  return { used, cash: taxHeads(L), balance: taxHeads(C) }
}

/** 6.1 rows from the forward-charge liability, the reverse-charge tax and the net ITC. */
export function gstr3bPayment(
  liability: TaxHeads,
  rcm: TaxHeads,
  netItc: TaxHeads,
): z.output<typeof Gstr3bReportSchema>['payment'] {
  const u = utiliseItc(liability, netItc)
  const cash = headsOf(u.cash)
  const rc = headsOf(rcm)
  const pay = headsOf(liability)
  const rows = TAX_HEADS.map((head) => ({
    head,
    payable_paise: pay[head],
    paid_itc: taxHeads({
      igst: u.used.igst[head],
      cgst: u.used.cgst[head],
      sgst: u.used.sgst[head],
      cess: u.used.cess[head],
    }),
    paid_cash_paise: cash[head],
    rcm_payable_paise: rc[head],
  }))
  return {
    rows,
    itc_balance: u.balance,
    cash_total_paise: sumSafe(
      rows.map((r) => r.paid_cash_paise + Math.max(0, r.rcm_payable_paise)),
    ),
  }
}

// ---- HSN summary & registers (generic viewer) ------------------------------------------------------

const GstRangeFields = {
  from: zDateStr.optional(),
  to: zDateStr.optional(),
  period: zPeriod.optional().describe('Shortcut for the month (instead of from / to)'),
  gstin: z.string().trim().toUpperCase().optional(),
}

function refineGstRange(
  v: { from?: string | undefined; to?: string | undefined; period?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (!v.period && !(v.from && v.to))
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'period_or_range_required' })
  if (v.from && v.to) refineRange(REPORT_MAX_RANGE_DAYS)(v, ctx)
}

/** from / to of a GST range query (period wins). */
export function gstQueryRange(v: { from?: string; to?: string; period?: string }): {
  from: string
  to: string
} {
  if (v.period && isPeriod(v.period)) return periodRange(v.period)
  if (v.from && v.to) return { from: v.from, to: v.to }
  throw new RangeError('period or from / to is required')
}

export const HsnSummaryQuerySchema = z
  .object({
    ...GstRangeFields,
    store_id: zReportStore,
    supply: z.enum(['b2b', 'b2c']).optional().describe('Default: both (rows carry `supply`)'),
    sort: sortQuery(['hsn_code', 'taxable_paise', 'rate_bp'] as const).prefault('hsn_code'),
    ...PageFields,
  })
  .superRefine(refineGstRange)
export type HsnSummaryQuery = z.input<typeof HsnSummaryQuerySchema>

export const HsnSummaryRowSchema = HsnRowSchema.extend({ supply: z.enum(['b2b', 'b2c']) })
export type HsnSummaryRow = z.output<typeof HsnSummaryRowSchema>

export const GstTotalsSchema = z.object({
  documents: zCount,
  taxable_paise: zSignedPaise,
  ...TaxHeadsFields,
  total_paise: zSignedPaise,
})
export type GstTotals = z.output<typeof GstTotalsSchema>

export const HsnSummaryResponseSchema = reportResponse(HsnSummaryRowSchema, GstTotalsSchema)
export type HsnSummaryResponse = z.output<typeof HsnSummaryResponseSchema>

export const SalesRegisterQuerySchema = z
  .object({
    ...GstRangeFields,
    store_id: zReportStore,
    include_credit_notes: zBooleanQuery.default(true),
    include_cancelled: zBooleanQuery
      .default(false)
      .describe('List cancelled documents too (amounts excluded from totals)'),
    b2b_only: zBooleanQuery.default(false),
    q: zSearchQuery.optional().describe('Number, customer name or GSTIN'),
    sort: sortQuery(['date', 'number', 'total_paise'] as const).prefault('date'),
    ...PageFields,
  })
  .superRefine(refineGstRange)
export type SalesRegisterQuery = z.input<typeof SalesRegisterQuerySchema>

/** Invoice-wise register; credit-note rows carry negative amounts. */
export const SalesRegisterRowSchema = z.object({
  kind: z.enum(['invoice', 'credit_note']),
  document_id: zId,
  number: z.string(),
  date: zDateStr,
  doc_type: SalesDocTypeSchema.extract(['tax_invoice', 'bill_of_supply']).nullable(),
  status: SalesInvoiceStatusSchema.extract(['completed', 'cancelled']),
  customer_id: zId.nullable(),
  customer_name: z.string().nullable(),
  customer_gstin: z.string().nullable(),
  place_of_supply: z.string(),
  is_interstate: z.boolean(),
  original_invoice_number: z.string().nullable(),
  taxable_paise: zSignedPaise,
  ...TaxHeadsFields,
  round_off_paise: zSignedPaise,
  total_paise: zSignedPaise,
})
export type SalesRegisterRow = z.output<typeof SalesRegisterRowSchema>

export const SalesRegisterResponseSchema = reportResponse(SalesRegisterRowSchema, GstTotalsSchema)
export type SalesRegisterResponse = z.output<typeof SalesRegisterResponseSchema>

export const PurchaseRegisterQuerySchema = z
  .object({
    ...GstRangeFields,
    store_id: zReportStore,
    supplier_id: zId.optional(),
    include_debit_notes: zBooleanQuery.default(true),
    include_expenses: zBooleanQuery.default(true).describe('Expenses with GST (rent, repairs …)'),
    itc_only: zBooleanQuery.default(false),
    q: zSearchQuery.optional().describe('GRN / supplier invoice number, supplier name or GSTIN'),
    sort: sortQuery(['date', 'number', 'total_paise'] as const).prefault('date'),
    ...PageFields,
  })
  .superRefine(refineGstRange)
export type PurchaseRegisterQuery = z.input<typeof PurchaseRegisterQuerySchema>

/** Bill-wise inward register (posted bills by received date); debit notes negative. */
export const PurchaseRegisterRowSchema = z.object({
  kind: z.enum(['bill', 'debit_note', 'expense']),
  document_id: zId,
  /** GRN / DN / EXP number. */
  number: z.string().nullable(),
  supplier_invoice_no: z.string().nullable(),
  supplier_invoice_date: zDateStr.nullable(),
  date: zDateStr,
  supplier_id: zId.nullable(),
  supplier_name: z.string().nullable(),
  supplier_gstin: z.string().nullable(),
  is_interstate: z.boolean(),
  reverse_charge: z.boolean(),
  itc_eligible: z.boolean(),
  taxable_paise: zSignedPaise,
  ...TaxHeadsFields,
  other_charges_paise: zSignedPaise,
  total_paise: zSignedPaise,
  /** Tax claimable as ITC (0 when not eligible). */
  itc_paise: zSignedPaise,
})
export type PurchaseRegisterRow = z.output<typeof PurchaseRegisterRowSchema>

export const PurchaseRegisterTotalsSchema = GstTotalsSchema.extend({ itc_paise: zSignedPaise })
export const PurchaseRegisterResponseSchema = reportResponse(
  PurchaseRegisterRowSchema,
  PurchaseRegisterTotalsSchema,
)
export type PurchaseRegisterResponse = z.output<typeof PurchaseRegisterResponseSchema>

// =============================================================================================
// Pharmacy
// =============================================================================================

export const H1RegisterQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    schedule: zQueryList(DrugScheduleSchema)
      .optional()
      .describe("Default ['H1'] (Schedule H1 register)"),
    q: zSearchQuery.optional().describe('Patient, doctor, drug or invoice number'),
    sort: sortQuery(['date', 'drug_name', 'invoice_number'] as const).prefault('date'),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type H1RegisterQuery = z.input<typeof H1RegisterQuerySchema>

/** One dispensed line (Drugs and Cosmetics Rules, Schedule H1 register columns). */
export const H1RegisterRowSchema = z.object({
  date: zDateStr,
  invoice_id: zId,
  invoice_number: z.string(),
  invoice_at: zTimestamp,
  patient_name: z.string().nullable(),
  patient_age: z.string().nullable(),
  patient_address: z.string().nullable(),
  doctor_name: z.string().nullable(),
  doctor_reg_no: z.string().nullable(),
  product_id: zId.nullable(),
  drug_name: z.string(),
  generic_name: z.string().nullable(),
  schedule: DrugScheduleSchema,
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  qty_milli: zSignedMilli,
  unit: z.string(),
  pack_size: z.int().min(1),
  prescription_file_id: zId.nullable(),
  dispensed_by_name: z.string().nullable(),
})
export type H1RegisterRow = z.output<typeof H1RegisterRowSchema>

export const H1RegisterTotalsSchema = z.object({
  entries: zCount,
  invoices: zCount,
  /** Lines whose bill has no patient / doctor details (fix before inspection). */
  missing_rx: zCount,
})
export const H1RegisterResponseSchema = reportResponse(H1RegisterRowSchema, H1RegisterTotalsSchema)
export type H1RegisterResponse = z.output<typeof H1RegisterResponseSchema>

export const ScheduleSalesQuerySchema = z
  .object({
    ...RangeFields,
    store_id: zReportStore,
    group_by: z.enum(['schedule', 'product']).default('schedule'),
    schedule: zQueryList(DrugScheduleSchema).optional().describe("Default ['H', 'H1', 'X']"),
    sort: sortQuery(['net_sales_paise', 'bills', 'name'] as const).prefault('-net_sales_paise'),
    ...PageFields,
  })
  .superRefine(refineRange(REPORT_MAX_RANGE_DAYS))
export type ScheduleSalesQuery = z.input<typeof ScheduleSalesQuerySchema>

export const ScheduleSalesRowSchema = z.object({
  schedule: DrugScheduleSchema,
  /** product grouping. */
  product_id: zId.nullable(),
  name: z.string().nullable(),
  name_ta: z.string().nullable(),
  unit: z.string().nullable(),
  pack_size: z.int().min(1).nullable(),
  qty_milli: zSignedMilli.nullable(),
  bills: zCount,
  net_sales_paise: zSignedPaise,
  rx_captured: zCount,
  rx_missing: zCount,
})
export type ScheduleSalesRow = z.output<typeof ScheduleSalesRowSchema>

export const ScheduleSalesTotalsSchema = z.object({
  bills: zCount,
  net_sales_paise: zSignedPaise,
  rx_captured: zCount,
  rx_missing: zCount,
})
export const ScheduleSalesResponseSchema = reportResponse(
  ScheduleSalesRowSchema,
  ScheduleSalesTotalsSchema,
)
export type ScheduleSalesResponse = z.output<typeof ScheduleSalesResponseSchema>

// =============================================================================================
// Route catalogue (docs/API.md "reports & GST")
// =============================================================================================

export const reportsRoutes = defineRoutes({
  dashboard: {
    method: 'GET',
    path: '/reports/dashboard',
    permission: 'reports.read',
    query: DashboardQuerySchema,
    response: dataOf(DashboardSchema),
    summary: 'Owner dashboard: today vs yesterday, 30-day trend, payment mix, dues, stock alerts',
  },
  salesSummary: {
    method: 'GET',
    path: '/reports/sales-summary',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: SalesSummaryQuerySchema,
    response: SalesSummaryResponseSchema,
    summary: 'Sales by day / month / hour / store / register / user / payment method',
  },
  itemSales: {
    method: 'GET',
    path: '/reports/item-sales',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: ItemSalesQuerySchema,
    response: ItemSalesResponseSchema,
    summary: 'Item-wise quantity, net sales, tax, cost, profit and returns',
  },
  categorySales: {
    method: 'GET',
    path: '/reports/category-sales',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: CategorySalesQuerySchema,
    response: CategorySalesResponseSchema,
  },
  brandSales: {
    method: 'GET',
    path: '/reports/brand-sales',
    permission: 'reports.read',
    feature: 'advanced_reports',
    query: BrandSalesQuerySchema,
    response: BrandSalesResponseSchema,
  },
  profit: {
    method: 'GET',
    path: '/reports/profit',
    permission: 'reports.read',
    feature: 'advanced_reports',
    query: ProfitQuerySchema,
    response: ProfitResponseSchema,
    summary: 'Gross profit and margin by item / category / brand',
  },
  discounts: {
    method: 'GET',
    path: '/reports/discounts',
    permission: 'reports.read',
    feature: 'advanced_reports',
    query: DiscountsQuerySchema,
    response: DiscountsResponseSchema,
    summary: 'Discounts given by bill / item / promotion / user',
  },
  cancellations: {
    method: 'GET',
    path: '/reports/cancellations',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: CancellationsQuerySchema,
    response: CancellationsResponseSchema,
    summary: 'Cancelled bills and returns: who, when, why',
  },
  shifts: {
    method: 'GET',
    path: '/reports/shifts',
    permission: 'reports.read',
    feature: 'shifts',
    query: ShiftsReportQuerySchema,
    response: ShiftsReportResponseSchema,
    summary: 'Shift-wise sales, tenders and cash differences',
  },
  stockSummary: {
    method: 'GET',
    path: '/reports/stock-summary',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: StockSummaryQuerySchema,
    response: StockSummaryResponseSchema,
    summary: 'Stock valuation at cost / MRP / selling price by category or product (now)',
  },
  stockAgeing: {
    method: 'GET',
    path: '/reports/stock-ageing',
    permission: 'reports.read',
    feature: 'advanced_reports',
    query: StockAgeingQuerySchema,
    response: StockAgeingResponseSchema,
  },
  expiry: {
    method: 'GET',
    path: '/reports/expiry',
    permission: 'reports.read',
    feature: 'batches_expiry',
    query: ExpiryQuerySchema,
    response: ExpiryResponseSchema,
    summary: 'Expired and expiring batches with stock value',
  },
  deadStock: {
    method: 'GET',
    path: '/reports/dead-stock',
    permission: 'reports.read',
    feature: 'advanced_reports',
    query: DeadStockQuerySchema,
    response: DeadStockResponseSchema,
    summary: 'Items in stock with no sale in N days',
  },
  customerOutstanding: {
    method: 'GET',
    path: '/reports/customer-outstanding',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: CustomerOutstandingQuerySchema,
    response: CustomerOutstandingResponseSchema,
    summary: 'Customer dues with ageing (0–30 / 31–60 / 61–90 / 90+ days)',
  },
  supplierOutstanding: {
    method: 'GET',
    path: '/reports/supplier-outstanding',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: SupplierOutstandingQuerySchema,
    response: SupplierOutstandingResponseSchema,
    summary: 'Supplier dues aged by bill due date',
  },
  gstr1: {
    method: 'GET',
    path: '/reports/tax/gstr1',
    permission: 'reports.gst',
    feature: 'gst_reports',
    query: GstPeriodQuerySchema,
    response: dataOf(Gstr1ResponseSchema),
    summary: 'GSTR-1 sections with warnings (composition: CMP-08 quarterly summary)',
  },
  gstr1Export: {
    method: 'GET',
    path: '/reports/tax/gstr1/export',
    permission: 'reports.gst',
    feature: 'gst_reports',
    query: Gstr1ExportQuerySchema,
    stream: 'file',
    summary: 'GSTR-1 offline-tool JSON (buildGstr1PortalJson) or CSV (gstr1Csv); audited export',
  },
  gstr3b: {
    method: 'GET',
    path: '/reports/tax/gstr3b',
    permission: 'reports.gst',
    feature: 'gst_reports',
    query: GstPeriodQuerySchema,
    response: dataOf(Gstr3bResponseSchema),
    summary: 'GSTR-3B summary (3.1, 3.2, 4, 5, 6.1)',
  },
  hsnSummary: {
    method: 'GET',
    path: '/reports/tax/hsn-summary',
    permission: 'reports.gst',
    feature: 'gst_reports',
    query: HsnSummaryQuerySchema,
    response: HsnSummaryResponseSchema,
  },
  salesRegister: {
    method: 'GET',
    path: '/reports/tax/sales-register',
    permission: 'reports.gst',
    feature: 'gst_reports',
    query: SalesRegisterQuerySchema,
    response: SalesRegisterResponseSchema,
  },
  purchaseRegister: {
    method: 'GET',
    path: '/reports/tax/purchase-register',
    permission: 'reports.gst',
    feature: 'gst_reports',
    query: PurchaseRegisterQuerySchema,
    response: PurchaseRegisterResponseSchema,
  },
  h1Register: {
    method: 'GET',
    path: '/reports/pharmacy/h1-register',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: H1RegisterQuerySchema,
    response: H1RegisterResponseSchema,
    summary: 'Schedule H1 register: date, bill, patient, doctor, drug, batch, expiry, quantity',
  },
  scheduleSales: {
    method: 'GET',
    path: '/reports/pharmacy/schedule-sales',
    permission: 'reports.read',
    feature: 'reports_basic',
    query: ScheduleSalesQuerySchema,
    response: ScheduleSalesResponseSchema,
    summary: 'Schedule H / H1 / X sales with prescription capture',
  },
})
export type ReportsRoutes = typeof reportsRoutes
export type ReportRouteKey = keyof ReportsRoutes

// =============================================================================================
// REPORTS catalogue — what the generic viewer (/reports/:reportKey) renders
// =============================================================================================

export const ReportGroupSchema = z.enum([
  'sales',
  'stock',
  'parties',
  'gst',
  'pharmacy',
  'controls',
])
export type ReportGroup = z.infer<typeof ReportGroupSchema>

export const REPORT_GROUPS: ReadonlyArray<{
  key: ReportGroup
  title: BilingualLabel
  description: BilingualLabel
  business_types?: readonly BusinessType[]
  /** Dedicated pages listed with the group's cards. */
  links?: ReadonlyArray<{
    key: string
    path: string
    title: BilingualLabel
    description: BilingualLabel
    permission: Permission
    feature: Feature
  }>
}> = [
  {
    key: 'sales',
    title: { en: 'Sales', ta: 'விற்பனை' },
    description: {
      en: 'What sold, when and how profitably',
      ta: 'எது, எப்போது, எவ்வளவு இலாபத்தில் விற்றது',
    },
  },
  {
    key: 'stock',
    title: { en: 'Stock', ta: 'சரக்கு இருப்பு' },
    description: {
      en: 'Stock value, ageing, expiry and dead stock',
      ta: 'இருப்பு மதிப்பு, பழமை, காலாவதி, விற்காத சரக்கு',
    },
  },
  {
    key: 'parties',
    title: { en: 'Customers & suppliers', ta: 'வாடிக்கையாளர்கள் & சப்ளையர்கள்' },
    description: {
      en: 'Dues to collect and to pay, with ageing',
      ta: 'வசூலிக்க வேண்டியதும் செலுத்த வேண்டியதும்',
    },
  },
  {
    key: 'gst',
    title: { en: 'GST', ta: 'GST' },
    description: {
      en: 'Returns, HSN summary and registers',
      ta: 'ரிட்டர்ன்கள், HSN சுருக்கம், பதிவேடுகள்',
    },
    links: [
      {
        key: 'gst-returns',
        path: '/reports/gst',
        title: { en: 'GST returns (GSTR-1, 3B)', ta: 'GST ரிட்டர்ன்கள் (GSTR-1, 3B)' },
        description: {
          en: 'Monthly returns with portal JSON download',
          ta: 'மாதாந்திர ரிட்டர்ன் & போர்டல் JSON',
        },
        permission: 'reports.gst',
        feature: 'gst_reports',
      },
    ],
  },
  {
    key: 'pharmacy',
    title: { en: 'Pharmacy', ta: 'மருந்தகம்' },
    description: {
      en: 'Schedule H1 register and scheduled drug sales',
      ta: 'அட்டவணை H1 பதிவேடு, அட்டவணை மருந்து விற்பனை',
    },
    business_types: ['pharmacy'],
  },
  {
    key: 'controls',
    title: { en: 'Shifts & controls', ta: 'ஷிஃப்ட் & கட்டுப்பாடுகள்' },
    description: {
      en: 'Cash differences, cancellations and discounts',
      ta: 'ரொக்க வித்தியாசம், ரத்துகள், தள்ளுபடிகள்',
    },
  },
]

/** How the viewer formats a value (CSV: money → '1234.50', qty → '1.5', percent → '12.50'). */
export const ReportColumnFormatSchema = z.enum([
  'text',
  'money',
  'qty',
  'int',
  'percent_bp',
  'date',
  'datetime',
  'days',
  'phone',
  'gstin',
  'boolean',
  'enum',
])
export type ReportColumnFormat = z.infer<typeof ReportColumnFormatSchema>

export interface ReportColumnDef {
  /** Row field. */
  key: string
  /** `en` is also the CSV header. */
  label: BilingualLabel
  format: ReportColumnFormat
  align?: 'left' | 'right' | 'center'
  /** Show totals[key] in the totals row. */
  total?: boolean
  /** qty: row fields with the unit code / pack size (formatQty / formatPackQty). */
  unit_field?: string
  pack_size_field?: string
  /** enum: labels of the values. */
  enum_labels?: Readonly<Record<string, BilingualLabel>>
  /**
   * Link the cell to a detail page (journalSourcePath type + the row field with the id); `type_by`
   * picks the type from another field (e.g. kind invoice → sales_invoice, credit_note → credit_note).
   */
  link?: {
    type: string
    id_field: string
    type_by?: { field: string; map: Readonly<Record<string, string>> }
  }
  /** Shown only for these group_by values. */
  group_by?: readonly string[]
  /** Mobile card role (DataTable meta.mobile). */
  mobile?: 'title' | 'subtitle' | 'value' | 'hidden'
  /** The `sort` key that orders by this column. */
  sort?: string
  hidden_by_default?: boolean
}

export type ReportFilterKind =
  | 'date_range'
  | 'date'
  | 'month'
  | 'store'
  | 'select'
  | 'multi_select'
  | 'number'
  | 'money'
  | 'text'
  | 'boolean'
  | 'category'
  | 'brand'
  | 'product'
  | 'supplier'
  | 'user'
  | 'register'

export interface ReportFilterDef {
  /** Query parameter ('date_range' sets from & to). */
  key: string
  kind: ReportFilterKind
  label: BilingualLabel
  required?: boolean
  default?: string | number | boolean | readonly string[]
  /** date_range: initial preset and the presets offered. */
  default_preset?: ReportDatePreset
  presets?: readonly ReportDatePreset[]
  options?: ReadonlyArray<{ value: string; label: BilingualLabel }>
  min?: number
  max?: number
}

export interface ReportChartDef {
  kind: 'line' | 'bar' | 'area'
  /** Row field of the x axis. */
  x: string
  series: ReadonlyArray<{ key: string; label: BilingualLabel; format: 'money' | 'int' }>
  /** Only for these group_by values. */
  group_by?: readonly string[]
}

export interface ReportDef {
  key: ReportKey
  route: ReportRouteKey
  group: ReportGroup
  /** i18n key (reports:titles.<snake key>); `title` is the source text of both locales. */
  title_key: string
  title: BilingualLabel
  description: BilingualLabel
  permission: Permission
  feature: Feature
  business_types?: readonly BusinessType[]
  filters: readonly ReportFilterDef[]
  columns: readonly ReportColumnDef[]
  /** Fields that identify a row (React keys). */
  row_key: readonly string[]
  default_sort: string
  /** Totals row from the response's totals. */
  totals: boolean
  chart?: ReportChartDef
  orientation: 'portrait' | 'landscape'
}

const L = (en: string, ta: string): BilingualLabel => ({ en, ta })

const ALL_PRESETS = REPORT_DATE_PRESETS

const F = {
  range: (default_preset: ReportDatePreset = 'this_month'): ReportFilterDef => ({
    key: 'date_range',
    kind: 'date_range',
    label: L('Period', 'காலம்'),
    required: true,
    default_preset,
    presets: ALL_PRESETS,
  }),
  store: { key: 'store_id', kind: 'store', label: L('Store', 'கிளை') } as ReportFilterDef,
  category: {
    key: 'category_id',
    kind: 'category',
    label: L('Category', 'வகை'),
  } as ReportFilterDef,
  brand: { key: 'brand_id', kind: 'brand', label: L('Brand', 'பிராண்ட்') } as ReportFilterDef,
  supplier: {
    key: 'supplier_id',
    kind: 'supplier',
    label: L('Supplier', 'சப்ளையர்'),
  } as ReportFilterDef,
  user: { key: 'user_id', kind: 'user', label: L('User', 'பயனர்') } as ReportFilterDef,
  register: {
    key: 'register_id',
    kind: 'register',
    label: L('Counter', 'கவுண்டர்'),
  } as ReportFilterDef,
  q: { key: 'q', kind: 'text', label: L('Search', 'தேடு') } as ReportFilterDef,
  days: (def: number, label: BilingualLabel): ReportFilterDef => ({
    key: 'days',
    kind: 'number',
    label,
    default: def,
    min: 1,
    max: 730,
  }),
  gstRange: (): ReportFilterDef => ({
    key: 'date_range',
    kind: 'date_range',
    label: L('Period', 'காலம்'),
    required: true,
    default_preset: 'last_month',
    presets: ['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_fy', 'last_fy'],
  }),
}

const C = {
  money: (
    key: string,
    en: string,
    ta: string,
    extra: Partial<ReportColumnDef> = {},
  ): ReportColumnDef => ({
    key,
    label: L(en, ta),
    format: 'money',
    align: 'right',
    total: true,
    ...extra,
  }),
  int: (
    key: string,
    en: string,
    ta: string,
    extra: Partial<ReportColumnDef> = {},
  ): ReportColumnDef => ({
    key,
    label: L(en, ta),
    format: 'int',
    align: 'right',
    total: true,
    ...extra,
  }),
  text: (
    key: string,
    en: string,
    ta: string,
    extra: Partial<ReportColumnDef> = {},
  ): ReportColumnDef => ({
    key,
    label: L(en, ta),
    format: 'text',
    ...extra,
  }),
  qty: (
    key: string,
    en: string,
    ta: string,
    extra: Partial<ReportColumnDef> = {},
  ): ReportColumnDef => ({
    key,
    label: L(en, ta),
    format: 'qty',
    align: 'right',
    unit_field: 'unit',
    pack_size_field: 'pack_size',
    ...extra,
  }),
  pct: (
    key: string,
    en: string,
    ta: string,
    extra: Partial<ReportColumnDef> = {},
  ): ReportColumnDef => ({
    key,
    label: L(en, ta),
    format: 'percent_bp',
    align: 'right',
    ...extra,
  }),
  date: (
    key: string,
    en: string,
    ta: string,
    extra: Partial<ReportColumnDef> = {},
  ): ReportColumnDef => ({
    key,
    label: L(en, ta),
    format: 'date',
    ...extra,
  }),
}

const SALES_METRIC_COLUMNS: readonly ReportColumnDef[] = [
  C.int('bills', 'Bills', 'பில்கள்'),
  C.money('sales_paise', 'Sales', 'விற்பனை'),
  C.money('returns_paise', 'Returns', 'திருப்பம்'),
  C.money('net_sales_paise', 'Net sales', 'நிகர விற்பனை', {
    mobile: 'value',
    sort: 'net_sales_paise',
  }),
  C.money('discount_paise', 'Discount', 'தள்ளுபடி', { hidden_by_default: true }),
  C.money('net_taxable_paise', 'Taxable value', 'வரிக்குட்பட்ட மதிப்பு', {
    hidden_by_default: true,
  }),
  C.money('tax_paise', 'GST', 'GST', { hidden_by_default: true }),
  C.money('cost_paise', 'Cost', 'அடக்க விலை'),
  C.money('gross_profit_paise', 'Gross profit', 'மொத்த இலாபம்', { sort: 'gross_profit_paise' }),
  C.pct('margin_bp', 'Margin %', 'இலாப %', { total: true }),
]

const OUTSTANDING_COLUMNS = (dueKey: 'customer' | 'supplier'): readonly ReportColumnDef[] => [
  C.money(
    'due_paise',
    dueKey === 'customer' ? 'Due' : 'Payable',
    dueKey === 'customer' ? 'நிலுவை' : 'செலுத்த வேண்டியது',
    { mobile: 'value', sort: 'due_paise' },
  ),
  ...(dueKey === 'supplier'
    ? [C.money('not_due_paise', 'Not yet due', 'இன்னும் தவணை வரவில்லை')]
    : []),
  C.money('bucket_0_30_paise', '0–30 days', '0–30 நாட்கள்'),
  C.money('bucket_31_60_paise', '31–60 days', '31–60 நாட்கள்'),
  C.money('bucket_61_90_paise', '61–90 days', '61–90 நாட்கள்'),
  C.money('bucket_90_plus_paise', 'Over 90 days', '90+ நாட்கள்'),
  C.money('unallocated_credit_paise', 'Advance / credit', 'முன்பணம் / வரவு'),
  C.money('balance_paise', 'Ledger balance', 'கணக்கு இருப்பு'),
  {
    key: 'oldest_due_days',
    label: L('Oldest due (days)', 'பழைய நிலுவை (நாட்கள்)'),
    format: 'days',
    align: 'right',
    sort: 'oldest_due_days',
  },
  C.date('last_payment_date', 'Last payment', 'கடைசி வரவு'),
]

const GST_AMOUNT_COLUMNS: readonly ReportColumnDef[] = [
  C.money('taxable_paise', 'Taxable value', 'வரிக்குட்பட்ட மதிப்பு'),
  C.money('igst_paise', 'IGST', 'IGST'),
  C.money('cgst_paise', 'CGST', 'CGST'),
  C.money('sgst_paise', 'SGST', 'SGST'),
  C.money('cess_paise', 'Cess', 'செஸ்'),
]

const GROUP_BY_LABELS: Readonly<Record<SalesSummaryGroupBy, BilingualLabel>> = {
  day: L('Day', 'நாள்'),
  month: L('Month', 'மாதம்'),
  hour: L('Hour of day', 'மணி நேரம்'),
  store: L('Store', 'கிளை'),
  register: L('Counter', 'கவுண்டர்'),
  user: L('Billed by', 'பில் போட்டவர்'),
  payment_method: L('Payment method', 'பணம் செலுத்திய முறை'),
}

const SALES_GROUPS = ['day', 'month', 'hour', 'store', 'register', 'user'] as const

function def(d: Omit<ReportDef, 'title_key'>): ReportDef {
  return { ...d, title_key: `reports:titles.${d.key.replaceAll('-', '_')}` }
}

/** Every report of the generic viewer, in index order within each group. */
export const REPORTS: readonly ReportDef[] = [
  def({
    key: 'sales-summary',
    route: 'salesSummary',
    group: 'sales',
    title: L('Sales summary', 'விற்பனைச் சுருக்கம்'),
    description: L(
      'Sales, returns and profit by day, month, hour, counter or user',
      'நாள், மாதம், மணி, கவுண்டர், பயனர் வாரியாக விற்பனை',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    filters: [
      F.range(),
      F.store,
      {
        key: 'group_by',
        kind: 'select',
        label: L('Group by', 'வகைப்படுத்து'),
        default: 'day',
        options: SalesSummaryGroupBySchema.options.map((value) => ({
          value,
          label: GROUP_BY_LABELS[value],
        })),
      },
      F.register,
      F.user,
    ],
    columns: [
      {
        key: 'group_label',
        label: L('Group', 'பிரிவு'),
        format: 'text',
        mobile: 'title',
        sort: 'group',
      },
      ...SALES_METRIC_COLUMNS.map((c) => ({ ...c, group_by: SALES_GROUPS })),
      {
        ...C.money('avg_bill_paise', 'Average bill', 'சராசரி பில்'),
        total: true,
        group_by: SALES_GROUPS,
      },
      C.int('payments_count', 'Payments', 'வரவுகள்', { group_by: ['payment_method'] }),
      C.money('collected_paise', 'Collected', 'வசூல்', { group_by: ['payment_method'] }),
      C.money('refunded_paise', 'Refunded', 'திருப்பிக் கொடுத்தது', {
        group_by: ['payment_method'],
      }),
      C.money('net_collected_paise', 'Net collected', 'நிகர வசூல்', {
        group_by: ['payment_method'],
        mobile: 'value',
      }),
    ],
    row_key: ['group_key'],
    default_sort: 'group',
    totals: true,
    chart: {
      kind: 'bar',
      x: 'group_label',
      series: [
        { key: 'net_sales_paise', label: L('Net sales', 'நிகர விற்பனை'), format: 'money' },
        { key: 'gross_profit_paise', label: L('Gross profit', 'மொத்த இலாபம்'), format: 'money' },
      ],
      group_by: ['day', 'month', 'hour'],
    },
    orientation: 'landscape',
  }),
  def({
    key: 'item-sales',
    route: 'itemSales',
    group: 'sales',
    title: L('Item-wise sales', 'பொருள் வாரியான விற்பனை'),
    description: L(
      'Quantity, net sales, cost and profit of each item',
      'ஒவ்வொரு பொருளின் அளவு, விற்பனை, இலாபம்',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    filters: [F.range(), F.store, F.category, F.brand, F.q],
    columns: [
      C.text('name', 'Item', 'பொருள்', {
        mobile: 'title',
        sort: 'name',
        link: { type: 'product', id_field: 'product_id' },
      }),
      C.text('category_name', 'Category', 'வகை', { mobile: 'subtitle' }),
      C.text('hsn_code', 'HSN', 'HSN', { hidden_by_default: true }),
      C.qty('net_qty_milli', 'Net qty', 'நிகர அளவு', { sort: 'net_qty_milli' }),
      C.qty('returned_qty_milli', 'Returned qty', 'திருப்பிய அளவு', { hidden_by_default: true }),
      ...SALES_METRIC_COLUMNS,
    ],
    row_key: ['product_id', 'name'],
    default_sort: '-net_sales_paise',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'category-sales',
    route: 'categorySales',
    group: 'sales',
    title: L('Category-wise sales', 'வகை வாரியான விற்பனை'),
    description: L(
      'Which categories bring sales and profit',
      'எந்த வகைகள் விற்பனையும் இலாபமும் தருகின்றன',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    filters: [
      F.range(),
      F.store,
      {
        key: 'level',
        kind: 'select',
        label: L('Level', 'நிலை'),
        default: 'leaf',
        options: [
          { value: 'leaf', label: L('Each category', 'ஒவ்வொரு வகையும்') },
          { value: 'top', label: L('Main categories', 'முதன்மை வகைகள்') },
        ],
      },
    ],
    columns: [
      C.text('path', 'Category', 'வகை', { mobile: 'title', sort: 'name' }),
      C.int('products', 'Items', 'பொருட்கள்', { total: true }),
      ...SALES_METRIC_COLUMNS,
      C.pct('share_bp', 'Share %', 'பங்கு %'),
    ],
    row_key: ['category_id', 'path'],
    default_sort: '-net_sales_paise',
    totals: true,
    chart: {
      kind: 'bar',
      x: 'category_name',
      series: [{ key: 'net_sales_paise', label: L('Net sales', 'நிகர விற்பனை'), format: 'money' }],
    },
    orientation: 'landscape',
  }),
  def({
    key: 'brand-sales',
    route: 'brandSales',
    group: 'sales',
    title: L('Brand-wise sales', 'பிராண்ட் வாரியான விற்பனை'),
    description: L('Sales and margin of each brand', 'ஒவ்வொரு பிராண்டின் விற்பனை, இலாபம்'),
    permission: 'reports.read',
    feature: 'advanced_reports',
    filters: [F.range(), F.store, F.category],
    columns: [
      C.text('brand_name', 'Brand', 'பிராண்ட்', { mobile: 'title', sort: 'name' }),
      C.int('products', 'Items', 'பொருட்கள்', { total: true }),
      ...SALES_METRIC_COLUMNS,
      C.pct('share_bp', 'Share %', 'பங்கு %'),
    ],
    row_key: ['brand_id', 'brand_name'],
    default_sort: '-net_sales_paise',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'profit',
    route: 'profit',
    group: 'sales',
    title: L('Profit & margin', 'இலாபம் & இலாப விகிதம்'),
    description: L(
      'Gross profit by item, category or brand; find low margins',
      'பொருள் / வகை / பிராண்ட் வாரியான இலாபம்',
    ),
    permission: 'reports.read',
    feature: 'advanced_reports',
    filters: [
      F.range(),
      F.store,
      {
        key: 'group_by',
        kind: 'select',
        label: L('Group by', 'வகைப்படுத்து'),
        default: 'item',
        options: [
          { value: 'item', label: L('Item', 'பொருள்') },
          { value: 'category', label: L('Category', 'வகை') },
          { value: 'brand', label: L('Brand', 'பிராண்ட்') },
        ],
      },
      F.category,
      {
        key: 'max_margin_bp',
        kind: 'number',
        label: L('Margin at most (%)', 'அதிகபட்ச இலாப விகிதம் (%)'),
        min: -1_000_000,
        max: 10_000,
      },
    ],
    columns: [
      C.text('name', 'Name', 'பெயர்', { mobile: 'title', sort: 'name' }),
      C.text('category_name', 'Category', 'வகை', { group_by: ['item'], mobile: 'subtitle' }),
      C.qty('net_qty_milli', 'Net qty', 'நிகர அளவு', { group_by: ['item'] }),
      C.money('net_taxable_paise', 'Net sales (ex GST)', 'நிகர விற்பனை (GST இல்லாமல்)', {
        sort: 'net_taxable_paise',
      }),
      C.money('cost_paise', 'Cost', 'அடக்க விலை'),
      C.money('gross_profit_paise', 'Gross profit', 'மொத்த இலாபம்', {
        mobile: 'value',
        sort: 'gross_profit_paise',
      }),
      C.pct('margin_bp', 'Margin %', 'இலாப %', { total: true, sort: 'margin_bp' }),
      C.pct('profit_share_bp', 'Share of profit %', 'இலாபப் பங்கு %'),
    ],
    row_key: ['key_id', 'name'],
    default_sort: '-gross_profit_paise',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'stock-summary',
    route: 'stockSummary',
    group: 'stock',
    title: L('Stock valuation', 'இருப்பு மதிப்பு'),
    description: L(
      'Stock value at cost, MRP and selling price',
      'அடக்க விலை, MRP, விற்பனை விலையில் இருப்பு மதிப்பு',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    filters: [
      F.store,
      {
        key: 'group_by',
        kind: 'select',
        label: L('Group by', 'வகைப்படுத்து'),
        default: 'category',
        options: [
          { value: 'category', label: L('Category', 'வகை') },
          { value: 'product', label: L('Item', 'பொருள்') },
        ],
      },
      F.category,
      F.brand,
      {
        key: 'include_zero',
        kind: 'boolean',
        label: L('Include zero stock', 'பூஜ்ய இருப்பையும் காட்டு'),
        default: false,
      },
      F.q,
    ],
    columns: [
      C.text('name', 'Name', 'பெயர்', { mobile: 'title', sort: 'name' }),
      C.text('category_name', 'Category', 'வகை', { group_by: ['product'], mobile: 'subtitle' }),
      C.int('products', 'Items', 'பொருட்கள்', { group_by: ['category'] }),
      C.qty('qty_milli', 'Quantity', 'அளவு', { group_by: ['product'], sort: 'qty_milli' }),
      C.money('avg_cost_paise', 'Average cost', 'சராசரி அடக்க விலை', {
        group_by: ['product'],
        total: false,
      }),
      C.money('value_cost_paise', 'Value at cost', 'அடக்க விலை மதிப்பு', {
        mobile: 'value',
        sort: 'value_cost_paise',
      }),
      C.money('value_mrp_paise', 'Value at MRP', 'MRP மதிப்பு', { sort: 'value_mrp_paise' }),
      C.money('value_sale_paise', 'Value at selling price', 'விற்பனை விலை மதிப்பு'),
      C.int('negative_count', 'Negative stock', 'எதிர்மறை இருப்பு', { hidden_by_default: true }),
    ],
    row_key: ['key_id', 'name'],
    default_sort: '-value_cost_paise',
    totals: true,
    orientation: 'portrait',
  }),
  def({
    key: 'stock-ageing',
    route: 'stockAgeing',
    group: 'stock',
    title: L('Stock ageing', 'இருப்பின் பழமை'),
    description: L(
      'How long stock has been lying since it came in',
      'சரக்கு வந்து எத்தனை நாட்கள் ஆகிறது',
    ),
    permission: 'reports.read',
    feature: 'advanced_reports',
    filters: [
      F.store,
      {
        key: 'group',
        kind: 'select',
        label: L('Show', 'காட்டு'),
        default: 'product',
        options: [
          { value: 'product', label: L('Items', 'பொருட்கள்') },
          { value: 'batch', label: L('Batches', 'பேட்சுகள்') },
        ],
      },
      F.category,
      {
        key: 'bucket',
        kind: 'select',
        label: L('Age', 'பழமை'),
        options: AGEING_BUCKETS.map((value) => ({ value, label: AGEING_BUCKET_LABELS[value] })),
      },
    ],
    columns: [
      C.text('name', 'Item', 'பொருள்', {
        mobile: 'title',
        sort: 'name',
        link: { type: 'product', id_field: 'product_id' },
      }),
      C.text('batch_no', 'Batch', 'பேட்ச்', { group_by: ['batch'] }),
      C.qty('qty_milli', 'Quantity', 'அளவு'),
      C.money('value_cost_paise', 'Value at cost', 'அடக்க விலை மதிப்பு', {
        mobile: 'value',
        sort: 'value_cost_paise',
      }),
      C.date('last_inbound_date', 'Last received', 'கடைசியாக வந்தது'),
      {
        key: 'age_days',
        label: L('Age (days)', 'பழமை (நாட்கள்)'),
        format: 'days',
        align: 'right',
        sort: 'age_days',
      },
      {
        key: 'bucket',
        label: L('Bucket', 'பிரிவு'),
        format: 'enum',
        enum_labels: AGEING_BUCKET_LABELS,
      },
    ],
    row_key: ['product_id', 'batch_id'],
    default_sort: '-age_days',
    totals: true,
    orientation: 'portrait',
  }),
  def({
    key: 'expiry',
    route: 'expiry',
    group: 'stock',
    title: L('Expiry report', 'காலாவதி அறிக்கை'),
    description: L(
      'Expired and soon-expiring batches with value',
      'காலாவதியான / விரைவில் காலாவதியாகும் பேட்சுகள்',
    ),
    permission: 'reports.read',
    feature: 'batches_expiry',
    filters: [
      F.store,
      F.days(90, L('Expiring within (days)', 'காலாவதி (நாட்களுக்குள்)')),
      {
        key: 'include_expired',
        kind: 'boolean',
        label: L('Include expired', 'காலாவதியானவையும்'),
        default: true,
      },
      F.category,
      F.supplier,
    ],
    columns: [
      C.text('name', 'Item', 'பொருள்', {
        mobile: 'title',
        sort: 'name',
        link: { type: 'product', id_field: 'product_id' },
      }),
      C.text('batch_no', 'Batch', 'பேட்ச்', { mobile: 'subtitle' }),
      C.date('expiry_date', 'Expiry', 'காலாவதி', { sort: 'expiry_date' }),
      {
        key: 'days_to_expiry',
        label: L('Days left', 'மீதி நாட்கள்'),
        format: 'days',
        align: 'right',
      },
      {
        key: 'status',
        label: L('Status', 'நிலை'),
        format: 'enum',
        enum_labels: {
          expired: L('Expired', 'காலாவதியானது'),
          expiring: L('Expiring', 'காலாவதியாகிறது'),
        },
      },
      C.qty('qty_milli', 'Quantity', 'அளவு'),
      C.money('value_cost_paise', 'Value at cost', 'அடக்க விலை மதிப்பு', {
        mobile: 'value',
        sort: 'value_cost_paise',
      }),
      C.money('value_mrp_paise', 'Value at MRP', 'MRP மதிப்பு'),
      C.text('supplier_name', 'Supplier', 'சப்ளையர்'),
      C.text('store_name', 'Store', 'கிளை', { hidden_by_default: true }),
    ],
    row_key: ['batch_id'],
    default_sort: 'expiry_date',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'dead-stock',
    route: 'deadStock',
    group: 'stock',
    title: L('Dead stock', 'விற்காத சரக்கு'),
    description: L(
      'Items in stock that have not sold for a while',
      'நீண்ட நாட்களாக விற்காத இருப்புப் பொருட்கள்',
    ),
    permission: 'reports.read',
    feature: 'advanced_reports',
    filters: [F.store, F.days(90, L('No sale for (days)', 'விற்பனை இல்லாத நாட்கள்')), F.category],
    columns: [
      C.text('name', 'Item', 'பொருள்', {
        mobile: 'title',
        sort: 'name',
        link: { type: 'product', id_field: 'product_id' },
      }),
      C.text('category_name', 'Category', 'வகை', { mobile: 'subtitle' }),
      C.qty('qty_milli', 'Quantity', 'அளவு'),
      C.money('value_cost_paise', 'Value at cost', 'அடக்க விலை மதிப்பு', {
        mobile: 'value',
        sort: 'value_cost_paise',
      }),
      C.date('last_sold_date', 'Last sold', 'கடைசி விற்பனை'),
      {
        key: 'days_since_last_sale',
        label: L('Days unsold', 'விற்காத நாட்கள்'),
        format: 'days',
        align: 'right',
        sort: 'days_since_last_sale',
      },
      C.date('last_inbound_date', 'Last received', 'கடைசியாக வந்தது'),
    ],
    row_key: ['product_id'],
    default_sort: '-value_cost_paise',
    totals: true,
    orientation: 'portrait',
  }),
  def({
    key: 'customer-outstanding',
    route: 'customerOutstanding',
    group: 'parties',
    title: L('Customer dues (ageing)', 'வாடிக்கையாளர் நிலுவை (பழமை)'),
    description: L('Who owes how much and for how long', 'யார், எவ்வளவு, எத்தனை நாட்களாக நிலுவை'),
    permission: 'reports.read',
    feature: 'reports_basic',
    filters: [
      F.store,
      {
        key: 'overdue_only',
        kind: 'boolean',
        label: L('Overdue only', 'தவணை தாண்டியவை மட்டும்'),
        default: false,
      },
      {
        key: 'bucket',
        kind: 'select',
        label: L('Older than', 'இதை விடப் பழையது'),
        options: AGEING_BUCKETS.map((value) => ({ value, label: AGEING_BUCKET_LABELS[value] })),
      },
      F.q,
    ],
    columns: [
      C.text('name', 'Customer', 'வாடிக்கையாளர்', {
        mobile: 'title',
        sort: 'name',
        link: { type: 'customer', id_field: 'customer_id' },
      }),
      { key: 'phone', label: L('Phone', 'தொலைபேசி'), format: 'phone', mobile: 'subtitle' },
      ...OUTSTANDING_COLUMNS('customer'),
      C.money('overdue_paise', 'Overdue', 'தவணை தாண்டியது'),
    ],
    row_key: ['customer_id'],
    default_sort: '-due_paise',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'supplier-outstanding',
    route: 'supplierOutstanding',
    group: 'parties',
    title: L('Supplier dues (ageing)', 'சப்ளையர் நிலுவை (பழமை)'),
    description: L(
      'What the shop owes suppliers, by due date',
      'சப்ளையர்களுக்குச் செலுத்த வேண்டியது',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    filters: [
      F.store,
      {
        key: 'overdue_only',
        kind: 'boolean',
        label: L('Overdue only', 'தவணை தாண்டியவை மட்டும்'),
        default: false,
      },
      F.q,
    ],
    columns: [
      C.text('name', 'Supplier', 'சப்ளையர்', {
        mobile: 'title',
        sort: 'name',
        link: { type: 'supplier', id_field: 'supplier_id' },
      }),
      { key: 'gstin', label: L('GSTIN', 'GSTIN'), format: 'gstin', hidden_by_default: true },
      ...OUTSTANDING_COLUMNS('supplier'),
      C.money('overdue_paise', 'Overdue', 'தவணை தாண்டியது'),
      C.money('due_next_7_days_paise', 'Due in 7 days', '7 நாட்களில் தவணை', { total: false }),
    ],
    row_key: ['supplier_id'],
    default_sort: '-due_paise',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'hsn-summary',
    route: 'hsnSummary',
    group: 'gst',
    title: L('HSN summary', 'HSN சுருக்கம்'),
    description: L(
      'HSN-wise quantity, value and tax (GSTR-1 table 12)',
      'HSN வாரியான அளவு, மதிப்பு, வரி',
    ),
    permission: 'reports.gst',
    feature: 'gst_reports',
    filters: [
      F.gstRange(),
      F.store,
      {
        key: 'supply',
        kind: 'select',
        label: L('Supply', 'விநியோகம்'),
        options: [
          { value: 'b2b', label: L('B2B', 'B2B') },
          { value: 'b2c', label: L('B2C', 'B2C') },
        ],
      },
    ],
    columns: [
      C.text('hsn_code', 'HSN', 'HSN', { mobile: 'title', sort: 'hsn_code' }),
      C.text('description', 'Description', 'விவரம்', { mobile: 'subtitle' }),
      {
        key: 'supply',
        label: L('Supply', 'விநியோகம்'),
        format: 'enum',
        enum_labels: { b2b: L('B2B', 'B2B'), b2c: L('B2C', 'B2C') },
      },
      C.text('uqc', 'UQC', 'UQC'),
      { key: 'qty_milli', label: L('Quantity', 'அளவு'), format: 'qty', align: 'right' },
      C.pct('rate_bp', 'Rate %', 'வரி %', { sort: 'rate_bp' }),
      ...GST_AMOUNT_COLUMNS,
      C.money('total_value_paise', 'Total value', 'மொத்த மதிப்பு', {
        mobile: 'value',
        total: false,
      }),
    ],
    row_key: ['supply', 'hsn_code', 'uqc', 'rate_bp'],
    default_sort: 'hsn_code',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'sales-register',
    route: 'salesRegister',
    group: 'gst',
    title: L('Sales register', 'விற்பனைப் பதிவேடு'),
    description: L('Invoice-wise sales with tax split', 'பில் வாரியான விற்பனையும் வரியும்'),
    permission: 'reports.gst',
    feature: 'gst_reports',
    filters: [
      F.gstRange(),
      F.store,
      {
        key: 'include_credit_notes',
        kind: 'boolean',
        label: L('Include credit notes', 'கிரெடிட் நோட்டுகளும்'),
        default: true,
      },
      { key: 'b2b_only', kind: 'boolean', label: L('B2B only', 'B2B மட்டும்'), default: false },
      F.q,
    ],
    columns: [
      C.date('date', 'Date', 'தேதி', { sort: 'date' }),
      C.text('number', 'Number', 'எண்', {
        mobile: 'title',
        sort: 'number',
        link: {
          type: 'sales_invoice',
          id_field: 'document_id',
          type_by: { field: 'kind', map: { invoice: 'sales_invoice', credit_note: 'credit_note' } },
        },
      }),
      {
        key: 'kind',
        label: L('Type', 'வகை'),
        format: 'enum',
        enum_labels: {
          invoice: L('Invoice', 'பில்'),
          credit_note: L('Credit note', 'கிரெடிட் நோட்'),
        },
      },
      C.text('customer_name', 'Customer', 'வாடிக்கையாளர்', { mobile: 'subtitle' }),
      { key: 'customer_gstin', label: L('GSTIN', 'GSTIN'), format: 'gstin' },
      C.text('place_of_supply', 'Place of supply', 'விநியோக இடம்'),
      ...GST_AMOUNT_COLUMNS,
      C.money('round_off_paise', 'Round off', 'முழுமையாக்கல்', {
        total: false,
        hidden_by_default: true,
      }),
      C.money('total_paise', 'Total', 'மொத்தம்', { mobile: 'value', sort: 'total_paise' }),
    ],
    row_key: ['kind', 'document_id'],
    default_sort: 'date',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'purchase-register',
    route: 'purchaseRegister',
    group: 'gst',
    title: L('Purchase register', 'கொள்முதல் பதிவேடு'),
    description: L(
      'Bill-wise purchases and expenses with tax and ITC',
      'பில் வாரியான கொள்முதல், வரி, உள்ளீட்டு வரி',
    ),
    permission: 'reports.gst',
    feature: 'gst_reports',
    filters: [
      F.gstRange(),
      F.store,
      F.supplier,
      {
        key: 'include_expenses',
        kind: 'boolean',
        label: L('Include expenses', 'செலவுகளும்'),
        default: true,
      },
      {
        key: 'itc_only',
        kind: 'boolean',
        label: L('ITC only', 'உள்ளீட்டு வரி உள்ளவை மட்டும்'),
        default: false,
      },
      F.q,
    ],
    columns: [
      C.date('date', 'Date', 'தேதி', { sort: 'date' }),
      C.text('number', 'GRN / number', 'எண்', {
        sort: 'number',
        link: {
          type: 'purchase_bill',
          id_field: 'document_id',
          type_by: {
            field: 'kind',
            map: { bill: 'purchase_bill', debit_note: 'debit_note', expense: 'expense' },
          },
        },
      }),
      C.text('supplier_invoice_no', 'Supplier invoice', 'சப்ளையர் பில்', { mobile: 'title' }),
      C.text('supplier_name', 'Supplier', 'சப்ளையர்', { mobile: 'subtitle' }),
      { key: 'supplier_gstin', label: L('GSTIN', 'GSTIN'), format: 'gstin' },
      {
        key: 'kind',
        label: L('Type', 'வகை'),
        format: 'enum',
        enum_labels: {
          bill: L('Purchase bill', 'கொள்முதல் பில்'),
          debit_note: L('Debit note', 'டெபிட் நோட்'),
          expense: L('Expense', 'செலவு'),
        },
      },
      ...GST_AMOUNT_COLUMNS,
      C.money('total_paise', 'Total', 'மொத்தம்', { mobile: 'value', sort: 'total_paise' }),
      C.money('itc_paise', 'ITC', 'உள்ளீட்டு வரி'),
    ],
    row_key: ['kind', 'document_id'],
    default_sort: 'date',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'h1-register',
    route: 'h1Register',
    group: 'pharmacy',
    title: L('Schedule H1 register', 'அட்டவணை H1 பதிவேடு'),
    description: L(
      'Register of Schedule H1 drugs dispensed (Drugs & Cosmetics Rules)',
      'வழங்கிய அட்டவணை H1 மருந்துகளின் பதிவேடு',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    business_types: ['pharmacy'],
    filters: [
      F.range('this_month'),
      F.store,
      {
        key: 'schedule',
        kind: 'multi_select',
        label: L('Schedule', 'அட்டவணை'),
        default: ['H1'],
        options: (['H', 'H1', 'X'] as const).map((value) => ({ value, label: L(value, value) })),
      },
      F.q,
    ],
    columns: [
      C.date('date', 'Date', 'தேதி', { sort: 'date' }),
      C.text('invoice_number', 'Bill no', 'பில் எண்', {
        sort: 'invoice_number',
        link: { type: 'sales_invoice', id_field: 'invoice_id' },
      }),
      C.text('patient_name', 'Patient', 'நோயாளி', { mobile: 'subtitle' }),
      C.text('doctor_name', 'Doctor', 'மருத்துவர்'),
      C.text('doctor_reg_no', 'Doctor reg. no', 'மருத்துவர் பதிவு எண்'),
      C.text('drug_name', 'Drug', 'மருந்து', { mobile: 'title', sort: 'drug_name' }),
      C.text('batch_no', 'Batch', 'பேட்ச்'),
      C.date('expiry_date', 'Expiry', 'காலாவதி'),
      C.qty('qty_milli', 'Quantity', 'அளவு', { mobile: 'value' }),
    ],
    row_key: ['invoice_id', 'drug_name', 'batch_no'],
    default_sort: 'date',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'schedule-sales',
    route: 'scheduleSales',
    group: 'pharmacy',
    title: L('Scheduled drug sales', 'அட்டவணை மருந்து விற்பனை'),
    description: L(
      'Schedule H / H1 / X sales and prescription capture',
      'அட்டவணை H / H1 / X விற்பனை, மருந்துச் சீட்டு',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    business_types: ['pharmacy'],
    filters: [
      F.range(),
      F.store,
      {
        key: 'group_by',
        kind: 'select',
        label: L('Group by', 'வகைப்படுத்து'),
        default: 'schedule',
        options: [
          { value: 'schedule', label: L('Schedule', 'அட்டவணை') },
          { value: 'product', label: L('Drug', 'மருந்து') },
        ],
      },
    ],
    columns: [
      C.text('schedule', 'Schedule', 'அட்டவணை', { mobile: 'title' }),
      C.text('name', 'Drug', 'மருந்து', {
        group_by: ['product'],
        mobile: 'subtitle',
        sort: 'name',
      }),
      C.qty('qty_milli', 'Quantity', 'அளவு', { group_by: ['product'] }),
      C.int('bills', 'Bills', 'பில்கள்', { sort: 'bills' }),
      C.money('net_sales_paise', 'Net sales', 'நிகர விற்பனை', {
        mobile: 'value',
        sort: 'net_sales_paise',
      }),
      C.int('rx_captured', 'With prescription', 'மருந்துச் சீட்டுடன்'),
      C.int('rx_missing', 'Without prescription', 'மருந்துச் சீட்டு இல்லாமல்'),
    ],
    row_key: ['schedule', 'product_id'],
    default_sort: '-net_sales_paise',
    totals: true,
    orientation: 'portrait',
  }),
  def({
    key: 'shifts',
    route: 'shifts',
    group: 'controls',
    title: L('Shift summary', 'ஷிஃப்ட் சுருக்கம்'),
    description: L(
      'Sales, tenders and cash difference of every shift',
      'ஒவ்வொரு ஷிஃப்டின் விற்பனை, ரொக்க வித்தியாசம்',
    ),
    permission: 'reports.read',
    feature: 'shifts',
    filters: [F.range(), F.store, F.register, F.user],
    columns: [
      {
        key: 'opened_at',
        label: L('Opened', 'தொடக்கம்'),
        format: 'datetime',
        sort: 'opened_at',
        link: { type: 'shift', id_field: 'shift_id' },
      },
      C.text('register_code', 'Counter', 'கவுண்டர்', { mobile: 'title' }),
      C.text('opened_by_name', 'Cashier', 'காசாளர்', { mobile: 'subtitle' }),
      { key: 'closed_at', label: L('Closed', 'முடிவு'), format: 'datetime' },
      C.int('bills', 'Bills', 'பில்கள்'),
      C.money('sales_paise', 'Sales', 'விற்பனை', { sort: 'sales_paise' }),
      C.money('cash_paise', 'Cash', 'ரொக்கம்'),
      C.money('upi_paise', 'UPI', 'UPI'),
      C.money('card_paise', 'Card', 'கார்டு'),
      C.money('other_paise', 'Other', 'மற்றவை', { hidden_by_default: true }),
      C.money('expected_cash_paise', 'Expected cash', 'எதிர்பார்த்த ரொக்கம்', { total: false }),
      C.money('counted_cash_paise', 'Counted cash', 'எண்ணிய ரொக்கம்', { total: false }),
      C.money('difference_paise', 'Difference', 'வித்தியாசம்', {
        mobile: 'value',
        sort: 'difference_paise',
      }),
    ],
    row_key: ['shift_id'],
    default_sort: '-opened_at',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'cancellations',
    route: 'cancellations',
    group: 'controls',
    title: L('Cancellations', 'ரத்துகள்'),
    description: L(
      'Cancelled bills and returns: who, when and why',
      'ரத்தான பில்கள்: யார், எப்போது, ஏன்',
    ),
    permission: 'reports.read',
    feature: 'reports_basic',
    filters: [
      F.range(),
      F.store,
      {
        key: 'kind',
        kind: 'select',
        label: L('Document', 'ஆவணம்'),
        options: [
          { value: 'invoice', label: L('Bills', 'பில்கள்') },
          { value: 'credit_note', label: L('Returns', 'திருப்பங்கள்') },
        ],
      },
      F.user,
    ],
    columns: [
      {
        key: 'cancelled_at',
        label: L('Cancelled at', 'ரத்து நேரம்'),
        format: 'datetime',
        sort: 'cancelled_at',
      },
      C.text('number', 'Number', 'எண்', {
        mobile: 'title',
        sort: 'number',
        link: {
          type: 'sales_invoice',
          id_field: 'document_id',
          type_by: { field: 'kind', map: { invoice: 'sales_invoice', credit_note: 'credit_note' } },
        },
      }),
      {
        key: 'kind',
        label: L('Document', 'ஆவணம்'),
        format: 'enum',
        enum_labels: { invoice: L('Bill', 'பில்'), credit_note: L('Return', 'திருப்பம்') },
      },
      C.text('cancelled_by_name', 'Cancelled by', 'ரத்து செய்தவர்', { mobile: 'subtitle' }),
      C.text('created_by_name', 'Billed by', 'பில் போட்டவர்'),
      C.text('reason', 'Reason', 'காரணம்'),
      {
        key: 'minutes_after',
        label: L('Minutes after billing', 'பில்லுக்குப் பின் நிமிடங்கள்'),
        format: 'int',
        align: 'right',
      },
      C.money('total_paise', 'Amount', 'தொகை', { mobile: 'value', sort: 'total_paise' }),
      C.money('refunded_paise', 'Refunded', 'திருப்பிக் கொடுத்தது'),
    ],
    row_key: ['kind', 'document_id'],
    default_sort: '-cancelled_at',
    totals: true,
    orientation: 'landscape',
  }),
  def({
    key: 'discounts',
    route: 'discounts',
    group: 'controls',
    title: L('Discounts given', 'வழங்கிய தள்ளுபடிகள்'),
    description: L(
      'Discounts by bill, item, offer or cashier',
      'பில், பொருள், சலுகை, காசாளர் வாரியான தள்ளுபடி',
    ),
    permission: 'reports.read',
    feature: 'advanced_reports',
    filters: [
      F.range(),
      F.store,
      {
        key: 'group_by',
        kind: 'select',
        label: L('Group by', 'வகைப்படுத்து'),
        default: 'bill',
        options: [
          { value: 'bill', label: L('Bill', 'பில்') },
          { value: 'item', label: L('Item', 'பொருள்') },
          { value: 'promotion', label: L('Offer', 'சலுகை') },
          { value: 'user', label: L('Cashier', 'காசாளர்') },
        ],
      },
      F.user,
      {
        key: 'min_discount_bp',
        kind: 'number',
        label: L('Discount at least (%)', 'குறைந்தபட்ச தள்ளுபடி (%)'),
        min: 0,
        max: 10_000,
      },
    ],
    columns: [
      C.text('label', 'Name', 'பெயர்', { mobile: 'title', sort: 'label' }),
      C.date('date', 'Date', 'தேதி', { group_by: ['bill'], sort: 'date' }),
      C.text('customer_name', 'Customer', 'வாடிக்கையாளர்', { group_by: ['bill'] }),
      C.text('user_name', 'Cashier', 'காசாளர்', { group_by: ['bill'], mobile: 'subtitle' }),
      C.int('bills', 'Bills', 'பில்கள்', { group_by: ['item', 'promotion', 'user'] }),
      {
        key: 'qty_milli',
        label: L('Quantity', 'அளவு'),
        format: 'qty',
        align: 'right',
        unit_field: 'unit',
        group_by: ['item'],
      },
      C.money('gross_paise', 'Gross', 'மொத்தம்'),
      C.money('item_discount_paise', 'Item discount', 'பொருள் தள்ளுபடி'),
      C.money('bill_discount_paise', 'Bill discount', 'பில் தள்ளுபடி'),
      C.money('promotion_discount_paise', 'Offer discount', 'சலுகை தள்ளுபடி', {
        hidden_by_default: true,
      }),
      C.money('discount_paise', 'Total discount', 'மொத்த தள்ளுபடி', {
        mobile: 'value',
        sort: 'discount_paise',
      }),
      C.pct('discount_bp', 'Discount %', 'தள்ளுபடி %', { total: true, sort: 'discount_bp' }),
    ],
    row_key: ['group_key'],
    default_sort: '-discount_paise',
    totals: true,
    orientation: 'landscape',
  }),
]

export const REPORTS_BY_KEY: Readonly<Record<ReportKey, ReportDef>> = Object.fromEntries(
  REPORTS.map((r) => [r.key, r]),
) as Record<ReportKey, ReportDef>

export function getReportDef(key: string): ReportDef | undefined {
  return (REPORTS_BY_KEY as Record<string, ReportDef | undefined>)[key]
}

/** Columns of a report shown for a group_by value (all when the column has no group_by). */
export function reportColumns(defn: ReportDef, groupBy?: string | null): ReportColumnDef[] {
  return defn.columns.filter(
    (c) => !c.group_by || (groupBy != null && c.group_by.includes(groupBy)),
  )
}

/** Web path a linked cell opens, or null. */
export function reportCellPath(
  column: ReportColumnDef,
  row: Record<string, unknown>,
): string | null {
  const link = column.link
  if (!link) return null
  const id = row[link.id_field]
  if (typeof id !== 'string') return null
  const type = link.type_by ? link.type_by.map[String(row[link.type_by.field])] : link.type
  return journalSourcePath(type, id)
}

/**
 * Locale-neutral CSV text of one value (money '1234.50', qty '1.5', bp '12.50', ISO dates, phones
 * '98765 43210' so spreadsheets keep them as text).
 */
export function reportCsvValue(column: ReportColumnDef, value: unknown): CsvValue {
  if (value === null || value === undefined) return ''
  switch (column.format) {
    case 'money':
      return typeof value === 'number' ? paiseToRupeesString(value) : String(value)
    case 'qty':
      return typeof value === 'number' ? milliToDecimalString(value) : String(value)
    case 'percent_bp':
      return typeof value === 'number' ? (value / 100).toFixed(2) : String(value)
    case 'phone':
      return typeof value === 'string' ? formatPhoneDisplay(value) : String(value)
    case 'boolean':
      return value ? 'Yes' : 'No'
    case 'enum':
      return column.enum_labels?.[String(value)]?.en ?? String(value)
    default:
      return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
        ? value
        : JSON.stringify(value)
  }
}

/**
 * CSV of a report (?format=csv): English labels as headers, one line per row and a final 'Total'
 * line from `totals` (columns with `total`). UTF-8 BOM, CRLF (toCsv).
 */
export function reportCsv(
  defn: ReportDef,
  rows: readonly Record<string, unknown>[],
  totals?: Record<string, unknown> | null,
  opts: { group_by?: string | null } = {},
): string {
  const cols = reportColumns(defn, opts.group_by ?? null)
  const lines: CsvValue[][] = [cols.map((c) => c.label.en)]
  for (const row of rows) lines.push(cols.map((c) => reportCsvValue(c, row[c.key])))
  if (defn.totals && totals) {
    lines.push(
      cols.map((c, i) =>
        c.total && totals[c.key] !== undefined
          ? reportCsvValue(c, totals[c.key])
          : i === 0
            ? 'Total'
            : '',
      ),
    )
  }
  return toCsv(lines)
}

/** CSV download file name: 'item-sales_2026-10-01_2026-10-31.csv'. */
export function reportCsvFilename(
  key: ReportKey,
  from?: string | null,
  to?: string | null,
): string {
  return `${key}${from ? `_${from}` : ''}${to && to !== from ? `_${to}` : ''}.csv`
}
