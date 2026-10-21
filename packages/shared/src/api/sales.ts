// CONTRACT CHANGELOG (sales backend; newest last)
// - AuditSnippetSchema.id: zId → z.int() (audit_logs.id is a bigint identity, not a uuid).
// - CreditNoteDetailSchema: + loyalty_points_restored (redeemed points given back by the return;
//   loyalty_points_reversed = earned points taken back). Defaults to 0.
// - SalesInvoiceLineSchema / SalesInvoiceDetailSchema: unit_cost_paise, cost_paise are 0 for users
//   without reports.read (documented on the fields; shape unchanged).
// - SalesLineMetaSchema: + batch_auto (FEFO-picked batch, re-picked when a held bill completes),
//   manual_discount_paise (flat manual discount as entered), promotion_ids, item (ad-hoc item as
//   entered), price_includes_tax — all optional.
// - SalesPrintModelSchema.tax_breakup[].cgst_rate_bp / sgst_rate_bp: z.int() → z.number() (half of
//   an odd rate such as 25 bp = 12.5 bp).
// - EstimateConvertSchema: + rx (optional; default = the estimate's stored rx) — scheduled drugs
//   of a pharmacy estimate can be billed on conversion (review).
// - SyncInvoiceSchema: + held_invoice_id (optional) — a recalled held bill completed offline; the
//   held bill is removed at sync in the same transaction so it cannot be billed twice (review).

/**
 * Contract for the sales module — docs/API.md "sales & POS"; ARCHITECTURE.md §9 (pricing),
 * §10 (posting rules), §12 (POS & offline).
 *
 *  - Pricing: `priceCart()` below is THE cart pricing function of both the POS (live, offline)
 *    and the server (POST /pos/quote, invoice create/complete, held completion, offline sync). The
 *    server resolves catalogue data (prices, batches FEFO, stock, rx, credit) and is
 *    authoritative; problems are reported as typed `issues` (quote) or thrown as the mapped error
 *    (create) — see SALES_ISSUE_CODES / salesIssueErrorCode().
 *  - Invoices (tax invoice / bill of supply by the tenant's GST scheme), held bills & drafts
 *    (status held/draft: no number, stock or journal), estimates (doc_type estimate), cancellation,
 *    dues collection, credit notes (returns), offline sync, print & public invoice models.
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope;
 * paise / milli / bp integers. Custom validation messages are snake_case keys
 * (SALES_VALIDATION_KEYS), translated by the web (errors:validation.<key>, else
 * sales:validation.<key>).
 */
import { z } from 'zod'
import {
  CreditNoteReasonSchema,
  type CreditNoteReason,
  CreditNoteSettlementSchema,
  type CreditNoteSettlement,
  CreditNoteStatusSchema,
  CustomerTypeSchema,
  type GstScheme,
  GstSchemeSchema,
  LocaleSchema,
  BusinessTypeSchema,
  NumberSeriesDocTypeSchema,
  type NumberSeriesDocType,
  PaymentDirectionSchema,
  PaymentMethodSchema,
  type PaymentMethod,
  PaymentStatusSchema,
  PriceTierSchema,
  type PriceTier,
  ProductKindSchema,
  SalesChannelSchema,
  SalesDocTypeSchema,
  type SalesDocType,
  SalesInvoiceStatusSchema,
  SalesPaymentStatusSchema,
  ShiftStatusSchema,
} from '../enums'
import type { ErrorCode } from '../errors'
import { FeatureSchema } from '../features'
import type { Permission } from '../permissions'
import { mulDiv, sumSafe } from '../math'
import {
  type DocumentResult,
  type RoundOffMode,
  type TaxAmounts,
  type TaxMode,
  type TaxSlab,
  TaxSlabsSchema,
  computeDocument,
  lineNetBeforeBillDiscount,
} from '../pricing'
import {
  type AppliedPromotion,
  type LineDiscount,
  type PromotionContext,
  type PromotionLike,
  PromotionSchema,
  applyPromotions,
} from '../promotions'
import {
  DrugScheduleSchema,
  type DrugSchedule,
  type LoyaltySettingsSchema,
  PrintFormatSchema,
  RegisterSettingsSchema,
  TenantSettingsSchema,
} from '../settings'
import { isUnitCode } from '../units'
import { ShiftSchema } from './accounting'
import { loyaltyRedeemIssue, loyaltyValuePaise } from './parties'
import {
  AddressSchema,
  type BilingualLabel,
  dataOf,
  defineRoutes,
  listOf,
  PageQuerySchema,
  sortQuery,
  zBooleanQuery,
  zBp,
  zDateStr,
  zGstRateBp,
  zHsn,
  zId,
  zIdempotencyKey,
  zOptionalGstin,
  zOptionalPhone,
  zPaise,
  zQtyMilli,
  zSearchQuery,
  zStateCode,
  zTimestamp,
} from './common'
import {
  DATE_ORDER_ISSUE,
  DATE_RANGE_FIELDS,
  PaymentOriginSchema,
  PaymentProviderPublicSchema,
  dateOrderOk,
  zAmountPaise,
  zIfUpdatedAt,
  zListFormat,
  zMilli0,
  zNullableText,
  zQueryList,
  zReason,
} from './payments'

// =============================================================================================
// Validation keys & labels
// =============================================================================================

/** Message keys of the custom rules in this contract (web: sales:validation.<key>). */
export const SALES_VALIDATION_KEYS = [
  'line_item_xor_product',
  'ad_hoc_price_required',
  'unit_invalid',
  'tendered_cash_only',
  'intent_upi_only',
  'client_ref_required_for_pos',
  'duplicate_line_key',
  'held_draft_no_tenders',
  'credit_note_line_ref_required',
  'credit_note_free_form_price_required',
  'credit_note_store_required',
  'credit_note_mixed_lines',
  'duplicate_invoice_line',
  'estimate_valid_until_past',
  'sync_empty',
  'reason_required',
  'date_order',
  'empty_patch',
] as const
export type SalesValidationKey = (typeof SALES_VALIDATION_KEYS)[number]

type Bilingual = Readonly<BilingualLabel>

/** Printed document titles (GST rules 46 / 49 / 53). */
export const SALES_DOC_TITLES: Readonly<Record<SalesDocType | 'credit_note', Bilingual>> = {
  tax_invoice: { en: 'Tax Invoice', ta: 'வரி விலைப்பட்டியல்' },
  bill_of_supply: { en: 'Bill of Supply', ta: 'விநியோக ரசீது' },
  estimate: { en: 'Estimate', ta: 'மதிப்பீடு' },
  credit_note: { en: 'Credit Note', ta: 'கிரெடிட் நோட்' },
}

/** Declaration printed on bills of supply of composition dealers (ARCHITECTURE.md §9.2). */
export const COMPOSITION_DECLARATION: Bilingual = {
  en: 'Composition taxable person, not eligible to collect tax on supplies',
  ta: 'கலவை வரி செலுத்துபவர், விநியோகங்களுக்கு வரி வசூலிக்கத் தகுதியற்றவர்',
}

export const AUTHORISED_SIGNATORY: Bilingual = {
  en: 'Authorised Signatory',
  ta: 'அங்கீகரிக்கப்பட்ட கையொப்பம்',
}

/** "You saved ₹x" line (receipts, customer display). */
export const SAVINGS_LABEL: Bilingual = { en: 'You saved', ta: 'நீங்கள் சேமித்தது' }

export const CREDIT_NOTE_REASON_LABELS: Readonly<Record<CreditNoteReason, Bilingual>> = {
  return: { en: 'Goods returned', ta: 'பொருள் திருப்பம்' },
  damaged: { en: 'Damaged', ta: 'சேதம்' },
  expired: { en: 'Expired', ta: 'காலாவதி' },
  price_adjustment: { en: 'Price adjustment', ta: 'விலைத் திருத்தம்' },
  other: { en: 'Other', ta: 'மற்றவை' },
}

export const CREDIT_NOTE_SETTLEMENT_LABELS: Readonly<Record<CreditNoteSettlement, Bilingual>> = {
  cash: { en: 'Cash refund', ta: 'ரொக்கமாகத் திருப்பித் தருதல்' },
  upi: { en: 'UPI refund', ta: 'UPI மூலம் திருப்பித் தருதல்' },
  bank_transfer: { en: 'Bank refund', ta: 'வங்கி மூலம் திருப்பித் தருதல்' },
  adjust_due: { en: 'Adjusted against due', ta: 'நிலுவையில் கழிக்கப்பட்டது' },
  store_credit: { en: 'Store credit', ta: 'கடை வரவு' },
}

/** GST copy labels for A4 tax invoices (rule 48), in print order. */
export const INVOICE_COPY_LABELS: readonly Bilingual[] = [
  { en: 'Original for Recipient', ta: 'பெறுநருக்கான அசல்' },
  { en: 'Duplicate for Transporter', ta: 'போக்குவரத்தாளருக்கான நகல்' },
  { en: 'Triplicate for Supplier', ta: 'விநியோகஸ்தருக்கான மூன்றாம் நகல்' },
]

/** Notification template used by POST /sales/invoices/:id/share. */
export const INVOICE_SHARE_TEMPLATE = 'invoice_share'
export const InvoiceShareTemplateParamsSchema = z.object({
  shop_name: z.string(),
  customer_name: z.string(),
  number: z.string(),
  amount: z.string().describe("Formatted total, e.g. '₹1,250.00'"),
  due: z.string().nullable().describe('Formatted due amount when unpaid'),
  link: z.string().describe('PUBLIC_BASE_URL/i/<share_token>'),
})

/** Web path of the public invoice page (prefix PUBLIC_BASE_URL). */
export function publicInvoicePath(shareToken: string): string {
  return `/i/${shareToken}`
}

// =============================================================================================
// Pure helpers shared by the POS and the server
// =============================================================================================

/** Public invoice share tokens: 22 URL-safe characters (132 random bits). */
export const SHARE_TOKEN_LENGTH = 22
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/
const SHARE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Random share token (crypto.getRandomValues; works in Node 22 and browsers). */
export function generateShareToken(): string {
  const crypto = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Web Crypto (crypto.getRandomValues) is not available')
  }
  const bytes = new Uint8Array(SHARE_TOKEN_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += SHARE_ALPHABET[b & 63]
  return out
}

/** Document type, tax mode and number series of sales for a tenant GST scheme (§9.2). */
export function salesDocumentModeFor(scheme: GstScheme): {
  doc_type: Extract<SalesDocType, 'tax_invoice' | 'bill_of_supply'>
  tax_mode: TaxMode
  series: NumberSeriesDocType
} {
  if (scheme === 'regular')
    return { doc_type: 'tax_invoice', tax_mode: 'regular', series: 'sales_invoice' }
  return { doc_type: 'bill_of_supply', tax_mode: scheme, series: 'bill_of_supply' }
}

/** Number series of a sales document type. */
export function seriesDocTypeFor(docType: SalesDocType | 'credit_note'): NumberSeriesDocType {
  switch (docType) {
    case 'tax_invoice':
      return 'sales_invoice'
    case 'bill_of_supply':
      return 'bill_of_supply'
    case 'estimate':
      return 'estimate'
    case 'credit_note':
      return 'credit_note'
  }
}

/** prefix + zero-padded sequence — identical to the server's numbering (offline POS numbers). */
export function formatSeriesNumber(prefix: string, seq: number, padding: number): string {
  return `${prefix}${String(seq).padStart(padding, '0')}`
}

/** Where a line's unit price came from (stored in sales_invoice_lines.meta.price_source). */
export const PriceSourceSchema = z.enum([
  'store_price',
  'price_tier',
  'batch',
  'product',
  'manual',
  'ad_hoc',
])
export type PriceSource = z.infer<typeof PriceSourceSchema>

export interface PriceCandidates {
  product: {
    sale_price_paise: number
    mrp_paise: number | null
    wholesale_price_paise: number | null
  }
  /** store_product_prices row of the selling store (feature store_pricing). */
  store_price?: { sale_price_paise: number; mrp_paise: number | null } | null
  /** Selected batch (batch-tracked products). */
  batch?: { sale_price_paise: number | null; mrp_paise: number | null } | null
  /** Customer price tier (walk-in = retail). */
  price_tier?: PriceTier
}

/**
 * Default selling price per pack and MRP of a product line:
 * price = store override > wholesale tier (wholesale customer, product has a wholesale price) >
 * batch sale price > product sale price; MRP = batch MRP > store MRP > product MRP.
 */
export function resolveUnitPrice(c: PriceCandidates): {
  unit_price_paise: number
  mrp_paise: number | null
  source: Exclude<PriceSource, 'manual' | 'ad_hoc'>
} {
  const mrp = c.batch?.mrp_paise ?? c.store_price?.mrp_paise ?? c.product.mrp_paise ?? null
  if (c.store_price)
    return {
      unit_price_paise: c.store_price.sale_price_paise,
      mrp_paise: mrp,
      source: 'store_price',
    }
  if (c.price_tier === 'wholesale' && c.product.wholesale_price_paise != null) {
    return {
      unit_price_paise: c.product.wholesale_price_paise,
      mrp_paise: mrp,
      source: 'price_tier',
    }
  }
  if (c.batch?.sale_price_paise != null) {
    return { unit_price_paise: c.batch.sale_price_paise, mrp_paise: mrp, source: 'batch' }
  }
  return { unit_price_paise: c.product.sale_price_paise, mrp_paise: mrp, source: 'product' }
}

/**
 * Quantity rules of a product: whole base units unless `decimal_qty` (weighed / measured goods),
 * and whole packs unless `allow_loose` (loose tablets). Returns the issue code or null.
 */
export function qtyIssue(
  product: { decimal_qty: boolean; allow_loose: boolean; pack_size: number },
  qtyMilli: number,
): 'decimal_qty_not_allowed' | 'loose_not_allowed' | null {
  if (!product.decimal_qty && qtyMilli % 1000 !== 0) return 'decimal_qty_not_allowed'
  if (
    product.pack_size > 1 &&
    !product.allow_loose &&
    qtyMilli % (product.pack_size * 1000) !== 0
  ) {
    return 'loose_not_allowed'
  }
  return null
}

/** Drug schedule of a product from its attributes (pharmacy; default OTC). */
export function drugScheduleOf(
  attributes: Record<string, unknown> | null | undefined,
): DrugSchedule {
  const parsed = DrugScheduleSchema.safeParse(attributes?.['schedule'])
  return parsed.success ? parsed.data : 'OTC'
}

/** Whether selling the product needs prescription details (settings.pharmacy.require_rx_for_schedules). */
export function lineRequiresRx(
  attributes: Record<string, unknown> | null | undefined,
  requireRxForSchedules: readonly DrugSchedule[],
): boolean {
  if (attributes?.['requires_prescription'] === true) return true
  return requireRxForSchedules.includes(drugScheduleOf(attributes))
}

/**
 * Expiry state of a batch on a business date: 'expired' when expiry_date < today (a batch is
 * sellable on its expiry date), 'near_expiry' within `warningDays`, else 'ok'; null = no expiry.
 */
export function batchExpiryStatus(
  expiryDate: string | null | undefined,
  today: string,
  warningDays: number,
): 'expired' | 'near_expiry' | 'ok' | null {
  if (!expiryDate) return null
  if (expiryDate < today) return 'expired'
  const t = Date.parse(`${today}T00:00:00Z`)
  const e = Date.parse(`${expiryDate}T00:00:00Z`)
  return (e - t) / 86_400_000 <= warningDays ? 'near_expiry' : 'ok'
}

/**
 * Cashier discount limit of a line (bp of gross): min(settings.pos.max_discount_bp_without_override,
 * product.max_discount_bp). Manual discounts above it need `sales.discount_override`
 * (promotions and loyalty are sanctioned and never count).
 */
export function discountLimitBp(
  settingsLimitBp: number,
  productMaxDiscountBp: number | null | undefined,
): number {
  return Math.min(settingsLimitBp, productMaxDiscountBp ?? 10_000)
}

/** Manual discount of an amount as basis points (rounded): (gross 1000, discount 125) → 1250. */
export function discountBpOf(amountPaise: number, discountPaise: number): number {
  if (amountPaise <= 0) return discountPaise > 0 ? 10_000 : 0
  return mulDiv(discountPaise, 10_000, amountPaise)
}

/** Split part key of a FEFO-split line: part 1 keeps the cart key, then `<key>#2`, `<key>#3`… */
export function splitLineKey(key: string, part: number): string {
  return part <= 1 ? key : `${key}#${part}`
}

/** Key of a cart line: its `key`, else `line-<n>` (1-based position). */
export function cartLineKey(line: { key?: string | undefined }, index: number): string {
  return line.key ?? `line-${index + 1}`
}

const CASH_NOTE_RE = /\[tendered=(\d+);change=(\d+)\]/

/**
 * notes of a cash tender payment that handed back change — human readable plus a machine part
 * the invoice detail / reprint reads back (parseCashTenderNotes).
 */
export function cashTenderNotes(tenderedPaise: number, changePaise: number): string {
  const rupees = (p: number): string => (p / 100).toFixed(2)
  return `Cash tendered Rs ${rupees(tenderedPaise)}, change Rs ${rupees(changePaise)} [tendered=${tenderedPaise};change=${changePaise}]`
}

export function parseCashTenderNotes(
  notes: string | null | undefined,
): { tendered_paise: number; change_paise: number } | null {
  const m = notes ? CASH_NOTE_RE.exec(notes) : null
  return m ? { tendered_paise: Number(m[1]), change_paise: Number(m[2]) } : null
}

/** Payment notes for display (without the machine part of cashTenderNotes). */
export function displayPaymentNotes(notes: string | null | undefined): string | null {
  const text = notes?.replace(CASH_NOTE_RE, '').trim()
  return text ? text : null
}

/** Default validity of an estimate (valid_until = estimate date + this many days). */
export const ESTIMATE_VALIDITY_DAYS = 7

// ---- loyalty -----------------------------------------------------------------------------------

type LoyaltySettings = z.output<typeof LoyaltySettingsSchema>

/** Redemption problems (the parties contract's loyaltyRedeemIssue keys). */
export type LoyaltyIssue = 'loyalty_disabled' | 'loyalty_insufficient' | 'loyalty_below_minimum'

/**
 * Points → paise redemption of a cart. The request is validated with the parties contract's
 * loyaltyRedeemIssue (the same rules core/loyalty redeemPoints enforces), then capped so the
 * value never exceeds `cap_paise` (the bill after other discounts) — whole points only, so the
 * posted redemption can never be 'loyalty_exceeds_bill'; when the cap leaves fewer points than
 * settings.loyalty.min_redeem_points nothing is redeemed ('loyalty_below_minimum'). Redemption is a flat bill discount
 * (part of bill_discount_paise, reported as loyalty_redeem_paise / loyalty_points_redeemed).
 * Points earned on the bill: loyaltyPointsForAmount(total_paise) from the parties contract.
 */
export function loyaltyRedemption(input: {
  requested_points: number
  available_points: number
  cap_paise: number
  settings: LoyaltySettings
}): { points: number; paise: number; issue: LoyaltyIssue | null } {
  const { requested_points: req, settings } = input
  if (req <= 0) return { points: 0, paise: 0, issue: null }
  const issue = loyaltyRedeemIssue({
    points: req,
    balance_points: input.available_points,
    settings,
  })
  if (
    issue === 'loyalty_disabled' ||
    issue === 'loyalty_insufficient' ||
    issue === 'loyalty_below_minimum'
  ) {
    return { points: 0, paise: 0, issue }
  }
  if (issue !== null || settings.point_value_paise <= 0) return { points: 0, paise: 0, issue: null }
  const points = Math.min(
    req,
    Math.floor(Math.max(0, input.cap_paise) / settings.point_value_paise),
  )
  // A bill too small for the minimum redemption redeems nothing (core/loyalty would refuse it).
  if (points < settings.min_redeem_points) {
    return { points: 0, paise: 0, issue: 'loyalty_below_minimum' }
  }
  return { points, paise: loyaltyValuePaise(points, settings), issue: null }
}

// ---- cart pricing --------------------------------------------------------------------------------

export interface CartPricingLine {
  /** Unique per cart (split parts: splitLineKey). */
  key: string
  /** null = ad-hoc item (never promoted). */
  product_id: string | null
  category_id?: string | null
  brand_id?: string | null
  /** Per pack, as charged (resolved price or the override). */
  unit_price_paise: number
  qty_milli: number
  pack_size?: number
  price_includes_tax: boolean
  gst_rate_bp: number
  cess_rate_bp?: number
  tax_slabs?: readonly TaxSlab[] | null
  mrp_paise?: number | null
  /** Manual line discount (percentage of gross). */
  discount_bp?: number
  /** Manual line discount (flat paise). */
  discount_paise?: number
}

export interface CartPricingInput {
  lines: readonly CartPricingLine[]
  tax_mode: TaxMode
  is_interstate: boolean
  round_off: RoundOffMode
  /** Manual bill discount. */
  bill_discount_bp?: number
  bill_discount_paise?: number
  /** Active promotions (only when the plan has feature 'promotions'). */
  promotions?: readonly PromotionLike[]
  /** Store and instant the promotions are evaluated for (required with promotions). */
  promotion_context?: PromotionContext
  loyalty?: {
    redeem_points: number
    available_points: number
    settings: LoyaltySettings
  } | null
}

export interface CartPricingResult extends DocumentResult {
  /** Promotion discount per line key (part of each line's item discount). */
  line_promotions: Record<string, LineDiscount>
  applied_promotions: AppliedPromotion[]
  /** Split of bill_discount_paise: manual + promotions + loyalty. */
  manual_bill_discount_paise: number
  promotion_bill_discount_paise: number
  loyalty_redeem_paise: number
  loyalty_points_redeemed: number
  loyalty_issue: LoyaltyIssue | null
  /** Manual item discount of each line in bp of its gross (discount-override check). */
  manual_discount_bp: Record<string, number>
  /** Manual bill discount in bp of Σ line net (discount-override check). */
  manual_bill_discount_bp: number
}

/**
 * Prices a cart exactly like the server: promotions (applyPromotions on undiscounted line
 * amounts; line promotion discounts are added to the manual flat discount), then the bill
 * discount = manual (bp + flat, on Σ net after item discounts) + bill promotions + loyalty
 * redemption (each capped by what is left), then computeDocument (tax, round-off).
 * @throws RangeError on invalid amounts (see pricing.ts).
 */
export function priceCart(input: CartPricingInput): CartPricingResult {
  const promoLines = input.lines.filter((l) => l.product_id !== null)
  const promo =
    input.promotions && input.promotions.length > 0 && promoLines.length > 0
      ? applyPromotions(
          promoLines.map((l) => ({
            key: l.key,
            product_id: l.product_id!,
            category_id: l.category_id ?? null,
            brand_id: l.brand_id ?? null,
            unit_price_paise: l.unit_price_paise,
            qty_milli: l.qty_milli,
            pack_size: l.pack_size ?? 1,
          })),
          input.promotions,
          input.promotion_context ?? { store_id: '', now: new Date() },
        )
      : null

  const lineInputs = input.lines.map((l) => ({
    key: l.key,
    unit_price_paise: l.unit_price_paise,
    qty_milli: l.qty_milli,
    pack_size: l.pack_size ?? 1,
    price_includes_tax: l.price_includes_tax,
    gst_rate_bp: l.gst_rate_bp,
    cess_rate_bp: l.cess_rate_bp ?? 0,
    discount_bp: l.discount_bp ?? 0,
    discount_paise: sumSafe([
      l.discount_paise ?? 0,
      promo?.line_discounts[l.key]?.discount_paise ?? 0,
    ]),
    mrp_paise: l.mrp_paise ?? null,
    tax_slabs: l.tax_slabs ?? null,
  }))

  const manualDiscountBp: Record<string, number> = {}
  for (const l of input.lines) {
    const gross = mulDiv(l.unit_price_paise, l.qty_milli, (l.pack_size ?? 1) * 1000)
    const manual = Math.min(
      gross,
      sumSafe([l.discount_paise ?? 0, mulDiv(gross, l.discount_bp ?? 0, 10_000)]),
    )
    manualDiscountBp[l.key] = discountBpOf(gross, manual)
  }

  const netTotal = sumSafe(lineInputs.map(lineNetBeforeBillDiscount))
  const manualBill = Math.min(
    netTotal,
    sumSafe([
      input.bill_discount_paise ?? 0,
      mulDiv(netTotal, input.bill_discount_bp ?? 0, 10_000),
    ]),
  )
  const promoBill = Math.min(netTotal - manualBill, promo?.bill_discount_paise ?? 0)
  const loyalty = input.loyalty
    ? loyaltyRedemption({
        requested_points: input.loyalty.redeem_points,
        available_points: input.loyalty.available_points,
        cap_paise: netTotal - manualBill - promoBill,
        settings: input.loyalty.settings,
      })
    : { points: 0, paise: 0, issue: null }

  const doc = computeDocument({
    lines: lineInputs,
    is_interstate: input.is_interstate,
    tax_mode: input.tax_mode,
    bill_discount_paise: manualBill + promoBill + loyalty.paise,
    round_off: input.round_off,
  })

  const linePromotions: Record<string, LineDiscount> = {}
  for (const l of input.lines) {
    linePromotions[l.key] = promo?.line_discounts[l.key] ?? { discount_paise: 0, promotion_ids: [] }
  }
  return {
    ...doc,
    line_promotions: linePromotions,
    applied_promotions: promo?.applied ?? [],
    manual_bill_discount_paise: manualBill,
    promotion_bill_discount_paise: promoBill,
    loyalty_redeem_paise: loyalty.paise,
    loyalty_points_redeemed: loyalty.points,
    loyalty_issue: loyalty.issue,
    manual_discount_bp: manualDiscountBp,
    manual_bill_discount_bp: discountBpOf(netTotal, manualBill),
  }
}

// ---- tenders & credit ------------------------------------------------------------------------

export interface TenderLike {
  method: PaymentMethod
  amount_paise: number
}

export interface TenderAllocationLine {
  /** Index in the request's tenders array. */
  index: number
  method: PaymentMethod
  amount_paise: number
  /** Recorded as the payment amount. */
  applied_paise: number
  /** Cash only: handed back. */
  change_paise: number
}

/**
 * Applies tenders to a bill total: every non-cash tender first (in request order), each must fit
 * the remaining amount (else 'tender_exceeds_due'); then cash tenders, where `amount_paise` is
 * the cash handed over: applied = min(amount, remaining), the rest is change. A cash tender that
 * applies nothing is 'cash_tender_not_needed'. What stays unpaid is the due (credit / khata).
 */
export function allocateTenders(
  totalPaise: number,
  tenders: readonly TenderLike[],
): {
  lines: TenderAllocationLine[]
  paid_paise: number
  change_paise: number
  due_paise: number
  issue: { code: 'tender_exceeds_due' | 'cash_tender_not_needed'; index: number } | null
} {
  let remaining = totalPaise
  let issue: { code: 'tender_exceeds_due' | 'cash_tender_not_needed'; index: number } | null = null
  const lines: TenderAllocationLine[] = tenders.map((t, index) => ({
    index,
    method: t.method,
    amount_paise: t.amount_paise,
    applied_paise: 0,
    change_paise: 0,
  }))
  for (const line of lines) {
    if (line.method === 'cash') continue
    if (line.amount_paise > remaining) {
      issue ??= { code: 'tender_exceeds_due', index: line.index }
      line.applied_paise = Math.max(0, remaining)
    } else {
      line.applied_paise = line.amount_paise
    }
    remaining -= line.applied_paise
  }
  for (const line of lines) {
    if (line.method !== 'cash') continue
    line.applied_paise = Math.min(line.amount_paise, Math.max(0, remaining))
    line.change_paise = line.amount_paise - line.applied_paise
    if (line.applied_paise === 0) issue ??= { code: 'cash_tender_not_needed', index: line.index }
    remaining -= line.applied_paise
  }
  const paid = sumSafe(lines.map((l) => l.applied_paise))
  return {
    lines,
    paid_paise: paid,
    change_paise: sumSafe(lines.map((l) => l.change_paise)),
    due_paise: totalPaise - paid,
    issue,
  }
}

/**
 * Credit (khata) check of a sale leaving `due_paise` unpaid: new balance = balance + due;
 * over the limit when a limit is set and exceeded (limit 0 = no credit). Blocked when
 * settings.credit.block_over_limit, unless the explicit override (sales.credit + flag, audited).
 */
export function creditCheck(input: {
  due_paise: number
  balance_paise: number
  credit_limit_paise: number | null
  block_over_limit: boolean
  override?: boolean
}): {
  new_balance_paise: number
  available_credit_paise: number | null
  over_limit: boolean
  blocked: boolean
} {
  const newBalance = input.balance_paise + input.due_paise
  const limit = input.credit_limit_paise
  const over = input.due_paise > 0 && limit !== null && newBalance > limit
  return {
    new_balance_paise: newBalance,
    available_credit_paise: limit === null ? null : Math.max(0, limit - input.balance_paise),
    over_limit: over,
    blocked: over && input.block_over_limit && !input.override,
  }
}

// ---- returns -------------------------------------------------------------------------------------

/** Quantity of an invoice line that can still be returned (charged + free − returned). */
export function returnableQtyMilli(line: {
  qty_milli: number
  free_qty_milli?: number
  returned_qty_milli: number
}): number {
  return Math.max(0, line.qty_milli + (line.free_qty_milli ?? 0) - line.returned_qty_milli)
}

/**
 * Amounts of a partial return of an original document line (credit / debit notes). A partial
 * return gets round(x × qty / total) per tax head, capped by what is still uncredited; the final
 * return of a line (returned + qty = total) takes the exact remainder, so live notes always sum
 * to the original line — also after a note in between was cancelled.
 *
 * `total_qty_milli` = charged + free quantity of the original line; `returned_qty_milli` and
 * `credited` are the quantity / amounts of the LIVE (not cancelled) notes so far.
 * @throws RangeError when more than the remaining quantity is returned.
 */
export function prorateReturnLine(
  original: TaxAmounts,
  opts: {
    qty_milli: number
    total_qty_milli: number
    returned_qty_milli: number
    credited: TaxAmounts
  },
): TaxAmounts & { total_paise: number } {
  const { qty_milli: qty, total_qty_milli: total, returned_qty_milli: returned } = opts
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new RangeError('qty_milli must be > 0')
  if (!Number.isSafeInteger(total) || total <= 0)
    throw new RangeError('total_qty_milli must be > 0')
  if (returned < 0 || returned + qty > total) {
    throw new RangeError('cannot return more than the remaining quantity')
  }
  const final = returned + qty === total
  const head = (k: keyof TaxAmounts): number => {
    const left = Math.max(0, original[k] - opts.credited[k])
    return final ? left : Math.min(left, mulDiv(original[k], qty, total))
  }
  const r = {
    taxable_paise: head('taxable_paise'),
    cgst_paise: head('cgst_paise'),
    sgst_paise: head('sgst_paise'),
    igst_paise: head('igst_paise'),
    cess_paise: head('cess_paise'),
  }
  return {
    ...r,
    total_paise: sumSafe([r.taxable_paise, r.cgst_paise, r.sgst_paise, r.igst_paise, r.cess_paise]),
  }
}

/** Default restock toggle per return reason: damaged / expired goods are not put back on sale. */
export function defaultRestock(reason: CreditNoteReason): boolean {
  return reason !== 'damaged' && reason !== 'expired'
}

/**
 * Settlements a credit note may use. Refunds (cash / upi / bank_transfer) are limited to what the
 * customer actually paid and was not refunded yet (`refundable_paise`; null = free-form return);
 * adjust_due needs an invoice with a due (an excess over the due becomes the customer's advance,
 * so walk-in excess is not allowed); store credit needs a customer.
 */
export function creditNoteSettlementOptions(input: {
  has_invoice: boolean
  has_customer: boolean
  invoice_due_paise: number
  refundable_paise: number | null
  total_paise: number
}): CreditNoteSettlement[] {
  const out: CreditNoteSettlement[] = []
  const refundOk = input.refundable_paise === null || input.total_paise <= input.refundable_paise
  if (refundOk) out.push('cash', 'upi', 'bank_transfer')
  if (
    input.has_invoice &&
    input.invoice_due_paise > 0 &&
    (input.total_paise <= input.invoice_due_paise || input.has_customer)
  ) {
    out.push('adjust_due')
  }
  if (input.has_customer) out.push('store_credit')
  return out
}

// =============================================================================================
// Issues (quote warnings / errors)
// =============================================================================================

/**
 * Problems found while pricing / validating a cart. The quote returns them all (`issues`);
 * creating / completing an invoice throws the first blocking one as salesIssueErrorCode(code)
 * with `details: { reason: <code>, line_key, ...params, issues: [all blocking issues] }`.
 */
export const SALES_BLOCKING_ISSUE_CODES = [
  'empty_cart',
  'product_not_found',
  'product_inactive',
  'not_sellable',
  'decimal_qty_not_allowed',
  'loose_not_allowed',
  'batch_not_found',
  'expired_batch',
  'insufficient_stock',
  'serial_numbers_required',
  'rx_required',
  'price_override_required',
  'below_min_price',
  'discount_override_required',
  'credit_permission_required',
  'customer_required_for_credit',
  'credit_not_in_plan',
  'credit_limit_exceeded',
  'tender_exceeds_due',
  'cash_tender_not_needed',
  'payment_intent_invalid',
  'store_credit_insufficient',
  'loyalty_disabled',
  'loyalty_insufficient',
  'loyalty_below_minimum',
  'backdate_not_allowed',
  'shift_required',
] as const

export const SALES_WARNING_CODES = [
  'near_expiry',
  'low_stock',
  'negative_stock',
  'price_above_mrp',
  'price_below_cost',
  'fefo_split',
  'over_credit_limit',
  'offline_negative_stock',
] as const

export const SalesIssueCodeSchema = z.enum([...SALES_BLOCKING_ISSUE_CODES, ...SALES_WARNING_CODES])
export type SalesIssueCode = z.infer<typeof SalesIssueCodeSchema>
export type SalesBlockingIssueCode = (typeof SALES_BLOCKING_ISSUE_CODES)[number]

export function isBlockingSalesIssue(code: SalesIssueCode): code is SalesBlockingIssueCode {
  return (SALES_BLOCKING_ISSUE_CODES as readonly string[]).includes(code)
}

/** HTTP error code thrown for a blocking issue on create / complete. */
export function salesIssueErrorCode(code: SalesBlockingIssueCode): ErrorCode {
  switch (code) {
    case 'rx_required':
      return 'RX_REQUIRED'
    case 'expired_batch':
      return 'EXPIRED_BATCH'
    case 'insufficient_stock':
      return 'INSUFFICIENT_STOCK'
    case 'credit_limit_exceeded':
      return 'CREDIT_LIMIT_EXCEEDED'
    case 'price_override_required':
    case 'below_min_price':
    case 'discount_override_required':
    case 'credit_permission_required':
    case 'backdate_not_allowed':
      return 'FORBIDDEN'
    case 'credit_not_in_plan':
      return 'FEATURE_NOT_IN_PLAN'
    case 'product_not_found':
    case 'batch_not_found':
      return 'NOT_FOUND'
    default:
      return 'UNPROCESSABLE'
  }
}

/** Permission that waives a blocking issue (manager override via PIN switch). */
export const SALES_OVERRIDE_PERMISSION: Partial<Record<SalesBlockingIssueCode, Permission>> = {
  price_override_required: 'sales.price_override',
  below_min_price: 'sales.price_override',
  discount_override_required: 'sales.discount_override',
  credit_permission_required: 'sales.credit',
  backdate_not_allowed: 'sales.cancel',
}

/** Back-office invoices dated other than today need this permission (manager level). */
export const SALES_BACKDATE_PERMISSION = 'sales.cancel' as const

const IssueParamValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const SalesIssueSchema = z.object({
  code: SalesIssueCodeSchema,
  severity: z.enum(['error', 'warning']),
  /** Cart line key the issue is about (null = whole bill). */
  line_key: z.string().nullable(),
  /** e.g. {expiry_date}, {available_qty_milli}, {limit_bp}, {credit_limit_paise}, {source_key, parts}. */
  params: z.record(z.string(), IssueParamValue),
})
export type SalesIssue = z.output<typeof SalesIssueSchema>

// =============================================================================================
// Request building blocks
// =============================================================================================

/** Prescription details (pharmacy; stored in sales_invoices.rx). */
export const RxSchema = z.object({
  doctor_id: zId.nullable().optional(),
  doctor_name: z.string().trim().min(1).max(120),
  doctor_reg_no: z.string().trim().max(60).nullable().optional(),
  patient_name: z.string().trim().min(1).max(120),
  patient_age: z.int().min(0).max(130).nullable().optional(),
  patient_gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  patient_address: z.string().trim().max(300).nullable().optional(),
  rx_date: zDateStr.nullable().optional(),
  prescription_file_id: zId.nullable().optional(),
})
export type Rx = z.output<typeof RxSchema>
export type RxInput = z.input<typeof RxSchema>

/** Billing-party snapshot override (named walk-in, B2B walk-in with GSTIN, delivery address). */
export const CustomerSnapshotInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: zOptionalPhone,
  gstin: zOptionalGstin,
  address: AddressSchema.optional(),
  state_code: zStateCode.optional(),
})
export type CustomerSnapshotInput = z.input<typeof CustomerSnapshotInputSchema>

/** Ad-hoc (non-catalogue) item of a cart line. */
export const AdHocItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  name_ta: z.string().trim().max(200).optional(),
  hsn_code: zHsn.optional(),
  gst_rate_bp: zGstRateBp,
  cess_rate_bp: z.int().min(0).max(30_000).default(0),
  unit: z.string().trim().refine(isUnitCode, { message: 'unit_invalid' }).default('PCS'),
  /** Default settings.invoice.default_price_includes_tax. */
  price_includes_tax: z.boolean().optional(),
})

/** One cart line (POS, back office, held bill, estimate, offline sync). */
export const CartLineInputSchema = z
  .object({
    /** Client line key (echoed in quote lines / issues); default cartLineKey(): 'line-<n>'. */
    key: z.string().trim().min(1).max(64).optional(),
    product_id: zId.optional(),
    item: AdHocItemSchema.optional(),
    qty_milli: zQtyMilli,
    unit_price_paise: zPaise
      .optional()
      .describe(
        'Per pack. Omitted = resolved price (resolveUnitPrice). A different price is an override (sales.price_override unless settings.pos.allow_price_edit; never below min_sale_price without it)',
      ),
    discount_bp: zBp.optional(),
    discount_paise: zPaise.optional(),
    batch_id: zId
      .optional()
      .describe(
        'Batch-tracked products: omitted = FEFO auto-pick, splitting the line across batches when needed',
      ),
    serial_numbers: z.array(z.string().trim().min(1).max(60)).max(1000).optional(),
    /** Raw scanned code (barcode / scale barcode) for audit (meta.scanned_code). */
    scanned_code: z.string().trim().max(64).optional(),
    /** Line note (alteration, size remark), printed under the item. */
    note: z.string().trim().max(200).optional(),
  })
  .refine((l) => (l.product_id === undefined) !== (l.item === undefined), {
    message: 'line_item_xor_product',
    path: ['product_id'],
  })
  .refine((l) => l.item === undefined || l.unit_price_paise !== undefined, {
    message: 'ad_hoc_price_required',
    path: ['unit_price_paise'],
  })
export type CartLineInput = z.input<typeof CartLineInputSchema>
export type CartLine = z.output<typeof CartLineInputSchema>

/** A payment of a bill (POS tender, dues collection). See allocateTenders for the maths. */
export const TenderInputSchema = z
  .object({
    method: PaymentMethodSchema,
    amount_paise: zAmountPaise.describe(
      'Cash: the cash handed over (change = amount − applied). Others: the amount paid (≤ remaining)',
    ),
    /** UPI: a paid payment intent (dynamic QR / confirmed VPA QR), consumed exactly once. */
    payment_intent_id: zId.optional(),
    /** UPI without intent (static QR): which UPI ID received it (settlement account). */
    provider_account_id: zId.optional(),
    /** UTR / card approval code / cheque no. */
    reference: z.string().trim().max(100).optional(),
  })
  .refine((t) => t.payment_intent_id === undefined || t.method === 'upi', {
    message: 'intent_upi_only',
    path: ['payment_intent_id'],
  })
export type TenderInput = z.input<typeof TenderInputSchema>
export type Tender = z.output<typeof TenderInputSchema>

const zLines = z
  .array(CartLineInputSchema)
  .min(1)
  .max(500)
  .refine(
    (lines) => {
      const keys = lines.flatMap((l) => (l.key ? [l.key] : []))
      return new Set(keys).size === keys.length
    },
    { message: 'duplicate_line_key' },
  )

/** Fields shared by quote, create, held/draft update, estimates and offline sync. */
const CartFields = {
  store_id: zId,
  register_id: zId.optional(),
  /** null / absent = walk-in. */
  customer_id: zId.nullable().optional(),
  customer: CustomerSnapshotInputSchema.optional(),
  /** Default: the store's state (over-the-counter supply). */
  place_of_supply: zStateCode.optional(),
  lines: zLines,
  bill_discount_bp: zBp.optional(),
  bill_discount_paise: zPaise.optional(),
  loyalty_redeem_points: z.int().min(0).optional(),
  rx: RxSchema.optional(),
  salesperson_id: zId.optional(),
  notes: z.string().trim().max(1000).optional(),
}

/** POST /pos/quote — server-priced cart (no writes). */
export const QuoteRequestSchema = z.object({
  ...CartFields,
  tenders: z.array(TenderInputSchema).max(10).optional(),
  credit_limit_override: z.boolean().optional(),
  invoice_date: zDateStr.optional(),
})
export type QuoteRequest = z.input<typeof QuoteRequestSchema>

/**
 * POST /sales/invoices. `status` completed (default) numbers, posts stock / journal / tenders;
 * held / draft only store the priced lines. POS saves send `client_ref` (idempotent: the same
 * client_ref returns the same invoice; also the Idempotency-Key). Unpaid remainder = credit (needs
 * a customer, `sales.credit`, feature khata and the credit limit — `credit_limit_override` with
 * sales.credit is audited). `invoice_date` other than today: back office + SALES_BACKDATE_PERMISSION.
 */
export const InvoiceCreateSchema = z
  .object({
    ...CartFields,
    client_ref: zIdempotencyKey.optional(),
    status: SalesInvoiceStatusSchema.extract(['completed', 'held', 'draft']).default('completed'),
    channel: SalesChannelSchema.default('pos'),
    tenders: z.array(TenderInputSchema).max(10).default([]),
    credit_limit_override: z.boolean().default(false),
    invoice_date: zDateStr.optional(),
  })
  .refine((v) => v.channel !== 'pos' || v.client_ref !== undefined, {
    message: 'client_ref_required_for_pos',
    path: ['client_ref'],
  })
  .refine((v) => v.status === 'completed' || v.tenders.length === 0, {
    message: 'held_draft_no_tenders',
    path: ['tenders'],
  })
export type InvoiceCreate = z.input<typeof InvoiceCreateSchema>
export type InvoiceCreateParsed = z.output<typeof InvoiceCreateSchema>

/** PATCH /sales/invoices/:id — held / draft only; `lines` replaces every line. */
export const InvoiceUpdateSchema = z
  .object({
    customer_id: zId.nullable().optional(),
    customer: CustomerSnapshotInputSchema.nullable().optional(),
    place_of_supply: zStateCode.optional(),
    lines: zLines.optional(),
    bill_discount_bp: zBp.optional(),
    bill_discount_paise: zPaise.optional(),
    loyalty_redeem_points: z.int().min(0).optional(),
    rx: RxSchema.nullable().optional(),
    salesperson_id: zId.nullable().optional(),
    notes: zNullableText(1000),
    status: SalesInvoiceStatusSchema.extract(['held', 'draft']).optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at'), {
    message: 'empty_patch',
  })
export type InvoiceUpdate = z.input<typeof InvoiceUpdateSchema>

/**
 * POST /sales/invoices/:id/complete — held / draft → completed. The cart is re-priced at current
 * prices (lines whose meta.price_source is 'manual' keep their price, re-checked); `register_id`
 * is the completing counter (its series and open shift are used).
 */
export const InvoiceCompleteSchema = z.object({
  tenders: z.array(TenderInputSchema).max(10).default([]),
  register_id: zId.optional(),
  client_ref: zIdempotencyKey.optional(),
  credit_limit_override: z.boolean().default(false),
  /** Optional final edits applied before completing (same rules as PATCH). */
  changes: InvoiceUpdateSchema.optional(),
})
export type InvoiceComplete = z.input<typeof InvoiceCompleteSchema>

/** POST /sales/invoices/:id/cancel (sales.cancel; not when credit notes exist → 409). */
export const InvoiceCancelSchema = z.object({ reason: zReason })
export type InvoiceCancel = z.input<typeof InvoiceCancelSchema>

/** POST /sales/invoices/:id/payments — collect (part of) the due. */
export const CollectPaymentSchema = z.object({
  tenders: z.array(TenderInputSchema).min(1).max(10),
  payment_date: zDateStr.optional(),
  register_id: zId.optional(),
  notes: z.string().trim().max(500).optional(),
  client_ref: zIdempotencyKey.optional(),
})
export type CollectPayment = z.input<typeof CollectPaymentSchema>

/** POST /sales/invoices/:id/share */
export const InvoiceShareSchema = z.object({
  channel: z.enum(['whatsapp', 'sms']),
  /** Default: the invoice's customer phone. */
  phone: zOptionalPhone,
  locale: LocaleSchema.optional(),
})
export type InvoiceShare = z.input<typeof InvoiceShareSchema>

/** POST /sales/estimates — doc_type estimate, number 'estimate', no stock / journal. */
export const EstimateCreateSchema = z.object({
  ...CartFields,
  /** Default: today + ESTIMATE_VALIDITY_DAYS. Stored in sales_invoices.due_date. */
  valid_until: zDateStr.optional(),
  client_ref: zIdempotencyKey.optional(),
})
export type EstimateCreate = z.input<typeof EstimateCreateSchema>

/**
 * POST /sales/estimates/:id/convert → a new invoice (draft by default; completed needs tenders
 * or credit) re-priced at current prices unless keep_prices; the estimate becomes 'converted'
 * with converted_to_id.
 */
export const EstimateConvertSchema = z.object({
  status: SalesInvoiceStatusSchema.extract(['completed', 'draft']).default('draft'),
  keep_prices: z.boolean().default(false),
  tenders: z.array(TenderInputSchema).max(10).default([]),
  register_id: zId.optional(),
  channel: SalesChannelSchema.default('backoffice'),
  invoice_date: zDateStr.optional(),
  credit_limit_override: z.boolean().default(false),
  client_ref: zIdempotencyKey.optional(),
  /** Prescription for scheduled drugs (default: the one stored with the estimate). */
  rx: RxSchema.nullable().optional(),
})
export type EstimateConvert = z.input<typeof EstimateConvertSchema>

/** A credit note line: against an invoice line (by id, or by line_no) or free-form. */
export const CreditNoteLineInputSchema = z
  .object({
    invoice_line_id: zId.optional(),
    /** Alternative to invoice_line_id (offline returns of offline invoices). */
    invoice_line_no: z.int().min(1).optional(),
    /** Free-form returns (no invoice; permission sales.return + sales.cancel). */
    product_id: zId.optional(),
    batch_id: zId.optional(),
    /** Free-form: price per pack (inclusive / exclusive like the product). */
    unit_price_paise: zPaise.optional(),
    qty_milli: zQtyMilli,
    /** Default: defaultRestock(reason). Expired / damaged goods are usually not restocked. */
    restock: z.boolean().optional(),
  })
  .refine(
    (l) =>
      [
        l.invoice_line_id !== undefined,
        l.invoice_line_no !== undefined,
        l.product_id !== undefined,
      ].filter(Boolean).length === 1,
    { message: 'credit_note_line_ref_required', path: ['invoice_line_id'] },
  )
  .refine((l) => l.product_id === undefined || l.unit_price_paise !== undefined, {
    message: 'credit_note_free_form_price_required',
    path: ['unit_price_paise'],
  })

/**
 * POST /sales/credit-notes — a return. Amounts are pro-rata from the original invoice lines
 * (prorateReturnLine); settlement: cash / upi / bank_transfer → refund payment (out),
 * adjust_due → reduces the invoice due, store_credit → customer advance.
 */
export const CreditNoteCreateSchema = z
  .object({
    client_ref: zIdempotencyKey,
    invoice_id: zId.optional(),
    /** Offline returns of an invoice that was itself created offline. */
    invoice_client_ref: zIdempotencyKey.optional(),
    /** Default: the invoice's store; required for free-form returns. */
    store_id: zId.optional(),
    register_id: zId.optional(),
    /** Free-form returns: the customer (optional). */
    customer_id: zId.optional(),
    note_date: zDateStr.optional(),
    lines: z.array(CreditNoteLineInputSchema).min(1).max(500),
    reason: CreditNoteReasonSchema,
    settlement: CreditNoteSettlementSchema,
    /** UTR / reference of the refund. */
    refund_reference: z.string().trim().max(100).optional(),
    /** UPI refund from this UPI account (settlement account). */
    provider_account_id: zId.optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    const hasInvoice = v.invoice_id !== undefined || v.invoice_client_ref !== undefined
    const freeForm = v.lines.filter((l) => l.product_id !== undefined).length
    if (freeForm > 0 && freeForm < v.lines.length) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'credit_note_mixed_lines' })
    }
    if (freeForm === 0 && !hasInvoice) {
      ctx.addIssue({
        code: 'custom',
        path: ['invoice_id'],
        message: 'credit_note_line_ref_required',
      })
    }
    if (freeForm > 0 && v.store_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['store_id'], message: 'credit_note_store_required' })
    }
    const refs = v.lines.flatMap((l) =>
      l.invoice_line_id ? [l.invoice_line_id] : l.invoice_line_no ? [`#${l.invoice_line_no}`] : [],
    )
    if (new Set(refs).size !== refs.length) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'duplicate_invoice_line' })
    }
  })
export type CreditNoteCreate = z.input<typeof CreditNoteCreateSchema>

export const CreditNoteCancelSchema = z.object({ reason: zReason })

// =============================================================================================
// Quote / pricing result
// =============================================================================================

export const TaxBreakupRowSchema = z.object({
  gst_rate_bp: z.int().min(0),
  taxable_paise: z.int(),
  cgst_paise: z.int(),
  sgst_paise: z.int(),
  igst_paise: z.int(),
  cess_paise: z.int(),
})
export type TaxBreakupRowOut = z.output<typeof TaxBreakupRowSchema>

/** Line amounts (stored lines and priced lines). */
const LineAmountFields = {
  gross_paise: zPaise,
  /** Item + allocated bill discount (the invoice line's discount_paise column). */
  discount_paise: zPaise,
  taxable_paise: zPaise,
  /** Effective rate charged (0 for composition / unregistered). */
  gst_rate_bp: z.int().min(0),
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  cess_rate_bp: z.int().min(0),
  cess_paise: zPaise,
  total_paise: zPaise,
}

export const PricedLineSchema = z.object({
  /** Unique key; FEFO split parts: splitLineKey(source_key, n). */
  key: z.string(),
  /** Cart line key this line came from. */
  source_key: z.string(),
  line_no: z.int().min(1),
  product_id: zId.nullable(),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  hsn_code: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zQtyMilli,
  mrp_paise: zPaise.nullable(),
  /** Charged price per pack. */
  unit_price_paise: zPaise,
  /** Price before any override (resolveUnitPrice). */
  resolved_price_paise: zPaise,
  price_source: PriceSourceSchema,
  price_includes_tax: z.boolean(),
  /** Manual discount as entered. */
  manual_discount_bp: zBp,
  manual_discount_paise: zPaise,
  item_discount_paise: zPaise,
  promotion_discount_paise: zPaise,
  promotion_ids: z.array(zId),
  bill_discount_paise: zPaise,
  ...LineAmountFields,
  mrp_savings_paise: zPaise,
  tax_slab_rule_id: zId.nullable(),
  schedule: DrugScheduleSchema.nullable(),
  requires_rx: z.boolean(),
  serial_numbers: z.array(z.string()),
  /** Stock of the product (batch) at the store before this sale; null = not tracked. */
  available_qty_milli: z.int().nullable(),
  unit_cost_paise: zPaise.nullable().describe('Current average cost (only with reports.read)'),
})
export type PricedLine = z.output<typeof PricedLineSchema>

export const TenderAllocationSchema = z.object({
  index: z.int().min(0),
  method: PaymentMethodSchema,
  amount_paise: zAmountPaise,
  applied_paise: zPaise,
  change_paise: zPaise,
})

export const QuoteCustomerSchema = z.object({
  id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  phone: z.string().nullable(),
  gstin: z.string().nullable(),
  state_code: z.string().nullable(),
  price_tier: PriceTierSchema,
  balance_paise: z.int(),
  credit_limit_paise: zPaise.nullable(),
  loyalty_points: z.int().min(0),
})

export const AppliedPromotionSchema = z.object({
  promotion_id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  level: z.enum(['item', 'bill']),
  discount_paise: zPaise,
})

/** Totals of a priced document (quote and stored invoices). */
const DocumentTotalFields = {
  gross_paise: zPaise,
  item_discount_paise: zPaise,
  /** Manual + promotion + loyalty bill discount. */
  bill_discount_paise: zPaise,
  taxable_paise: zPaise,
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  cess_paise: zPaise,
  tax_paise: zPaise,
  round_off_paise: z.int().min(-99).max(99),
  total_paise: zPaise,
}

export const QuoteResultSchema = z.object({
  doc_type: SalesDocTypeSchema,
  tax_mode: GstSchemeSchema.describe('Tax mode of the document (= the GST scheme)'),
  place_of_supply: z.string(),
  is_interstate: z.boolean(),
  /** True when every line's price includes tax. */
  price_includes_tax: z.boolean(),
  lines: z.array(PricedLineSchema),
  ...DocumentTotalFields,
  manual_bill_discount_paise: zPaise,
  promotion_bill_discount_paise: zPaise,
  loyalty_redeem_paise: zPaise,
  loyalty_points_redeemed: z.int().min(0),
  mrp_savings_paise: zPaise,
  tax_breakup: z.array(TaxBreakupRowSchema),
  applied_promotions: z.array(AppliedPromotionSchema),
  customer: QuoteCustomerSchema.nullable(),
  /** When tenders were sent: allocateTenders result. */
  tenders: z
    .object({
      lines: z.array(TenderAllocationSchema),
      paid_paise: zPaise,
      change_paise: zPaise,
      due_paise: zPaise,
    })
    .nullable(),
  /** When tenders were sent and a due remains: the khata check (creditCheck) for the customer. */
  credit: z
    .object({
      due_paise: zPaise,
      balance_paise: z.int(),
      new_balance_paise: z.int(),
      credit_limit_paise: zPaise.nullable(),
      over_limit: z.boolean(),
      blocked: z.boolean(),
    })
    .nullable(),
  loyalty: z
    .object({
      points_available: z.int().min(0),
      points_redeemed: z.int().min(0),
      redeem_paise: zPaise,
      points_to_earn: z.int().min(0),
    })
    .nullable(),
  issues: z.array(SalesIssueSchema),
  /** No blocking issue for the current user (create would succeed). */
  can_complete: z.boolean(),
  /** What the cart needs: prompt for rx / manager override before saving. */
  requires: z.object({
    rx: z.boolean(),
    price_override: z.boolean(),
    discount_override: z.boolean(),
    credit: z.boolean(),
  }),
})
export type QuoteResult = z.output<typeof QuoteResultSchema>

// =============================================================================================
// Invoices
// =============================================================================================

/** sales_invoice_lines.meta (known keys; others kept). */
export const SalesLineMetaSchema = z.looseObject({
  price_source: PriceSourceSchema.optional(),
  resolved_price_paise: zPaise.optional(),
  schedule: DrugScheduleSchema.optional(),
  /** Variant attributes snapshot, e.g. {size: 'M', color: 'Red'}. */
  variant: z.record(z.string(), z.string()).optional(),
  scanned_code: z.string().optional(),
  note: z.string().optional(),
  /** FEFO split: the cart key of the original line. */
  source_key: z.string().optional(),
  /** Offline sync posted this line into negative stock. */
  offline_negative_stock: z.boolean().optional(),
  /** The batch was FEFO auto-picked (a held bill re-picks it when completed). */
  batch_auto: z.boolean().optional(),
  /** Flat manual line discount as entered (discount_paise is item + bill discount). */
  manual_discount_paise: zPaise.optional(),
  /** Promotions that discounted the line (promotion_id is the first). */
  promotion_ids: z.array(zId).optional(),
  /** Whether the line price includes GST (print / re-pricing). */
  price_includes_tax: z.boolean().optional(),
  /** Ad-hoc lines: the item as entered (re-pricing a held bill). */
  item: AdHocItemSchema.optional(),
})

export const SalesInvoiceLineSchema = z.object({
  id: zId,
  line_no: z.int().min(1),
  product_id: zId.nullable(),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  hsn_code: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zQtyMilli,
  free_qty_milli: zMilli0,
  mrp_paise: zPaise.nullable(),
  unit_price_paise: zPaise,
  discount_bp: zBp,
  ...LineAmountFields,
  /** Cost per pack at sale (0 without reports.read). */
  unit_cost_paise: zPaise,
  /** COGS of the line (0 without reports.read). */
  cost_paise: zPaise,
  promotion_id: zId.nullable(),
  promotion_name: z.string().nullable(),
  returned_qty_milli: zMilli0,
  returnable_qty_milli: zMilli0,
  serial_numbers: z.array(z.string()),
  meta: SalesLineMetaSchema,
})
export type SalesInvoiceLine = z.output<typeof SalesInvoiceLineSchema>

const StoreRef = z.object({ id: zId, code: z.string(), name: z.string() })
const RegisterRef = z.object({ id: zId, code: z.string(), name: z.string() })

export const SalesInvoiceListRowSchema = z.object({
  id: zId,
  doc_type: SalesDocTypeSchema,
  number: z.string().nullable(),
  fy: z.string().nullable(),
  invoice_date: zDateStr,
  invoice_at: zTimestamp,
  status: SalesInvoiceStatusSchema,
  channel: SalesChannelSchema,
  store_id: zId,
  store_code: z.string(),
  register_id: zId.nullable(),
  register_code: z.string().nullable(),
  customer_id: zId.nullable(),
  customer_name: z.string().nullable(),
  customer_phone: z.string().nullable(),
  item_count: z.int().min(0),
  total_paise: zPaise,
  paid_paise: zPaise,
  returned_paise: zPaise,
  due_paise: z.int(),
  payment_status: SalesPaymentStatusSchema,
  /** Estimates: valid until (sales_invoices.due_date); invoices: payment due date. */
  due_date: zDateStr.nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  /** Created offline and uploaded by POST /pos/sync. */
  offline: z.boolean(),
  client_ref: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type SalesInvoiceListRow = z.output<typeof SalesInvoiceListRowSchema>

export const InvoicePaymentSchema = z.object({
  payment_id: zId,
  number: z.string().nullable(),
  direction: PaymentDirectionSchema,
  method: PaymentMethodSchema,
  /** Amount of this payment allocated to the invoice. */
  amount_paise: zAmountPaise,
  payment_amount_paise: zAmountPaise,
  status: PaymentStatusSchema,
  payment_date: zDateStr,
  paid_at: zTimestamp,
  reference: z.string().nullable(),
  payment_intent_id: zId.nullable(),
  payer_vpa: z.string().nullable(),
  origin: PaymentOriginSchema,
  /** Cash tenders: change handed back (parseCashTenderNotes of the payment notes). */
  change_paise: zPaise.nullable(),
  created_by_name: z.string().nullable(),
})
export type InvoicePayment = z.output<typeof InvoicePaymentSchema>

export const CreditNoteRefSchema = z.object({
  id: zId,
  number: z.string(),
  note_date: zDateStr,
  status: CreditNoteStatusSchema,
  reason: CreditNoteReasonSchema,
  settlement: CreditNoteSettlementSchema,
  total_paise: zPaise,
})

export const AuditSnippetSchema = z.object({
  /** audit_logs.id (bigint identity). */
  id: z.int(),
  action: z.string(),
  summary: z.string().nullable(),
  user_name: z.string().nullable(),
  created_at: zTimestamp,
})

export const SalesInvoiceDetailSchema = SalesInvoiceListRowSchema.extend({
  store: StoreRef,
  register: RegisterRef.nullable(),
  shift_id: zId.nullable(),
  customer_gstin: z.string().nullable(),
  customer_address: AddressSchema.nullable(),
  customer_state_code: z.string().nullable(),
  place_of_supply: z.string(),
  is_interstate: z.boolean(),
  reverse_charge: z.boolean(),
  price_includes_tax: z.boolean(),
  ...DocumentTotalFields,
  /** COGS (cost of the lines sold; 0 without reports.read). */
  cost_paise: zPaise,
  loyalty_points_earned: z.int().min(0),
  loyalty_points_redeemed: z.int().min(0),
  loyalty_redeem_paise: zPaise,
  rx: RxSchema.nullable(),
  salesperson_id: zId.nullable(),
  salesperson_name: z.string().nullable(),
  notes: z.string().nullable(),
  /** PUBLIC_BASE_URL/i/<share_token> once shared. */
  share_url: z.string().nullable(),
  offline_created_at: zTimestamp.nullable(),
  converted_to_id: zId.nullable(),
  /** Invoice made from an estimate: that estimate. */
  source_estimate: z.object({ id: zId, number: z.string().nullable() }).nullable(),
  completed_at: zTimestamp.nullable(),
  cancelled_at: zTimestamp.nullable(),
  cancelled_by: zId.nullable(),
  cancelled_by_name: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  lines: z.array(SalesInvoiceLineSchema),
  tax_breakup: z.array(TaxBreakupRowSchema),
  mrp_savings_paise: zPaise,
  payments: z.array(InvoicePaymentSchema),
  credit_notes: z.array(CreditNoteRefSchema),
  journal_entry_id: zId.nullable(),
  shift: z
    .object({
      id: zId,
      status: ShiftStatusSchema,
      opened_at: zTimestamp,
      opened_by_name: z.string().nullable(),
    })
    .nullable(),
  /** The customer's current khata state (link to the ledger). */
  customer: z
    .object({
      id: zId,
      name: z.string(),
      phone: z.string().nullable(),
      balance_paise: z.int(),
      credit_limit_paise: zPaise.nullable(),
      loyalty_points: z.int().min(0),
    })
    .nullable(),
  /** Latest audit entries of the invoice (≤ 20). */
  audit: z.array(AuditSnippetSchema),
})
export type SalesInvoiceDetail = z.output<typeof SalesInvoiceDetailSchema>

/** Result of create / complete / convert: the invoice plus the tender outcome. */
export const InvoiceSaveResultSchema = z.object({
  invoice: SalesInvoiceDetailSchema,
  tenders: z.array(TenderAllocationSchema.extend({ payment_id: zId.nullable() })),
  change_paise: zPaise,
  warnings: z.array(SalesIssueSchema),
})
export type InvoiceSaveResult = z.output<typeof InvoiceSaveResultSchema>

export const InvoiceCancelResultSchema = z.object({
  invoice: SalesInvoiceDetailSchema,
  /** Payments cancelled with the invoice: hand the money back. */
  refunds: z.array(
    z.object({
      payment_id: zId,
      method: PaymentMethodSchema,
      amount_paise: zAmountPaise,
      /** UPI via a PSP without refund support: refund manually in the PSP / bank app. */
      psp_refund_required: z.boolean(),
      provider: z.string().nullable(),
      utr: z.string().nullable(),
    }),
  ),
})
export type InvoiceCancelResult = z.output<typeof InvoiceCancelResultSchema>

export const CollectPaymentResultSchema = z.object({
  invoice: SalesInvoiceDetailSchema,
  tenders: z.array(TenderAllocationSchema.extend({ payment_id: zId.nullable() })),
  change_paise: zPaise,
})

export const InvoiceShareResultSchema = z.object({
  url: z.string(),
  share_token: z.string().regex(SHARE_TOKEN_RE),
  notification_id: zId.nullable(),
  message: z.string(),
  wa_me_url: z.string().nullable(),
})
export type InvoiceShareResult = z.output<typeof InvoiceShareResultSchema>

export const HeldBillSchema = z.object({
  id: zId,
  status: SalesInvoiceStatusSchema.extract(['held', 'draft']),
  store_id: zId,
  register_id: zId.nullable(),
  register_code: z.string().nullable(),
  customer_id: zId.nullable(),
  customer_name: z.string().nullable(),
  item_count: z.int().min(0),
  total_paise: zPaise,
  notes: z.string().nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type HeldBill = z.output<typeof HeldBillSchema>

export const HeldBillsQuerySchema = z.object({
  store_id: zId,
  register_id: zId.optional(),
  status: zQueryList(SalesInvoiceStatusSchema.extract(['held', 'draft'])).optional(),
})

/** Default list excludes estimates and held / draft bills (pass doc_type / status). */
export const InvoiceListQuerySchema = PageQuerySchema.extend({
  /** Number, customer name or phone. */
  q: zSearchQuery.optional(),
  status: zQueryList(SalesInvoiceStatusSchema).optional(),
  doc_type: zQueryList(SalesDocTypeSchema).optional(),
  payment_status: zQueryList(SalesPaymentStatusSchema).optional(),
  channel: zQueryList(SalesChannelSchema).optional(),
  store_id: zId.optional(),
  register_id: zId.optional(),
  customer_id: zId.optional(),
  created_by: zId.optional(),
  shift_id: zId.optional(),
  has_due: zBooleanQuery.optional(),
  offline: zBooleanQuery.optional(),
  ...DATE_RANGE_FIELDS,
  sort: sortQuery([
    'invoice_date',
    'invoice_at',
    'number',
    'total_paise',
    'due_paise',
    'created_at',
  ]).prefault('-invoice_at'),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type InvoiceListQuery = z.input<typeof InvoiceListQuerySchema>

export const InvoiceListSummarySchema = z.object({
  count: z.int(),
  total_paise: zPaise,
  paid_paise: zPaise,
  due_paise: z.int(),
  returned_paise: zPaise,
  taxable_paise: zPaise,
  tax_paise: zPaise,
})
export const InvoiceListResponseSchema = listOf(SalesInvoiceListRowSchema).extend({
  summary: InvoiceListSummarySchema.describe('Over completed documents of the filtered range'),
})
export type InvoiceListResponse = z.output<typeof InvoiceListResponseSchema>

// ---- returnable -------------------------------------------------------------------------------

export const ReturnableLineSchema = z.object({
  invoice_line_id: zId,
  line_no: z.int().min(1),
  product_id: zId.nullable(),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  hsn_code: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  /** Sold (charged + free). */
  qty_milli: zQtyMilli,
  returned_qty_milli: zMilli0,
  returnable_qty_milli: zMilli0,
  unit_price_paise: zPaise,
  ...LineAmountFields,
  /** Amounts already credited by live credit notes (input of prorateReturnLine). */
  credited: z.object({
    taxable_paise: zPaise,
    cgst_paise: zPaise,
    sgst_paise: zPaise,
    igst_paise: zPaise,
    cess_paise: zPaise,
  }),
  unit_cost_paise: zPaise,
  track_inventory: z.boolean(),
})
export type ReturnableLine = z.output<typeof ReturnableLineSchema>

export const ReturnableResponseSchema = z.object({
  invoice: z.object({
    id: zId,
    number: z.string().nullable(),
    doc_type: SalesDocTypeSchema,
    invoice_date: zDateStr,
    status: SalesInvoiceStatusSchema,
    store_id: zId,
    customer_id: zId.nullable(),
    customer_name: z.string().nullable(),
    is_interstate: z.boolean(),
    total_paise: zPaise,
    paid_paise: zPaise,
    due_paise: z.int(),
    returned_paise: zPaise,
    payment_status: SalesPaymentStatusSchema,
  }),
  lines: z.array(ReturnableLineSchema),
  /** Paid and not yet refunded: the cap of refund settlements. */
  refundable_paise: zPaise,
})
export type ReturnableResponse = z.output<typeof ReturnableResponseSchema>

// ---- credit notes ------------------------------------------------------------------------------

export const CreditNoteListRowSchema = z.object({
  id: zId,
  number: z.string(),
  fy: z.string(),
  note_date: zDateStr,
  store_id: zId,
  register_id: zId.nullable(),
  invoice_id: zId.nullable(),
  invoice_number: z.string().nullable(),
  customer_id: zId.nullable(),
  customer_name: z.string().nullable(),
  customer_phone: z.string().nullable(),
  reason: CreditNoteReasonSchema,
  status: CreditNoteStatusSchema,
  settlement: CreditNoteSettlementSchema,
  total_paise: zPaise,
  settled_paise: zPaise,
  item_count: z.int().min(0),
  created_by_name: z.string().nullable(),
  client_ref: z.string().nullable(),
  created_at: zTimestamp,
})
export type CreditNoteListRow = z.output<typeof CreditNoteListRowSchema>

export const CreditNoteLineSchema = z.object({
  id: zId,
  line_no: z.int().min(1),
  invoice_line_id: zId.nullable(),
  product_id: zId.nullable(),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  hsn_code: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zQtyMilli,
  unit_price_paise: zPaise,
  taxable_paise: zPaise,
  gst_rate_bp: z.int().min(0),
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  cess_rate_bp: z.int().min(0),
  cess_paise: zPaise,
  total_paise: zPaise,
  unit_cost_paise: zPaise,
  cost_paise: zPaise,
  restock: z.boolean(),
})
export type CreditNoteLine = z.output<typeof CreditNoteLineSchema>

export const CreditNoteDetailSchema = CreditNoteListRowSchema.extend({
  customer_gstin: z.string().nullable(),
  customer_state_code: z.string().nullable(),
  place_of_supply: z.string(),
  is_interstate: z.boolean(),
  taxable_paise: zPaise,
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  cess_paise: zPaise,
  tax_paise: zPaise,
  round_off_paise: z.int().min(-99).max(99),
  cost_paise: zPaise,
  restock: z.boolean(),
  notes: z.string().nullable(),
  lines: z.array(CreditNoteLineSchema),
  tax_breakup: z.array(TaxBreakupRowSchema),
  invoice: z
    .object({ id: zId, number: z.string().nullable(), invoice_date: zDateStr, total_paise: zPaise })
    .nullable(),
  /** Refund / store-credit payments of the settlement. */
  payments: z.array(InvoicePaymentSchema),
  journal_entry_id: zId.nullable(),
  /** Earned points of the invoice taken back by this return. */
  loyalty_points_reversed: z.int().min(0),
  /** Redeemed points of the invoice given back by this return. */
  loyalty_points_restored: z.int().min(0).default(0),
  cancelled_at: zTimestamp.nullable(),
  cancelled_by: zId.nullable(),
  cancelled_by_name: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  updated_at: zTimestamp,
})
export type CreditNoteDetail = z.output<typeof CreditNoteDetailSchema>

export const CreditNoteListQuerySchema = PageQuerySchema.extend({
  /** Number, invoice number, customer name or phone. */
  q: zSearchQuery.optional(),
  status: zQueryList(CreditNoteStatusSchema).optional(),
  reason: zQueryList(CreditNoteReasonSchema).optional(),
  settlement: zQueryList(CreditNoteSettlementSchema).optional(),
  store_id: zId.optional(),
  customer_id: zId.optional(),
  invoice_id: zId.optional(),
  ...DATE_RANGE_FIELDS,
  sort: sortQuery(['note_date', 'number', 'total_paise', 'created_at']).prefault('-note_date'),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type CreditNoteListQuery = z.input<typeof CreditNoteListQuerySchema>

export const CreditNoteListResponseSchema = listOf(CreditNoteListRowSchema).extend({
  summary: z.object({ count: z.int(), total_paise: zPaise }),
})

// =============================================================================================
// Print model (invoice, estimate, credit note; thermal 58 / 80 mm and A4)
// =============================================================================================

const BilingualSchema = z.object({ en: z.string(), ta: z.string() })

/**
 * Everything needed to render a GST-compliant bilingual document without further calls. Contains
 * no internal ids, costs or user ids, so it is also the public invoice model.
 */
export const SalesPrintModelSchema = z.object({
  kind: z.enum(['invoice', 'credit_note']),
  doc_type: z.enum(['tax_invoice', 'bill_of_supply', 'estimate', 'credit_note']),
  format: PrintFormatSchema,
  locale: z.object({ primary: LocaleSchema, bilingual: z.boolean() }),
  title: BilingualSchema,
  /** A4 tax invoices: copy labels to print (INVOICE_COPY_LABELS), one page each. */
  copies: z.array(BilingualSchema),
  seller: z.object({
    name: z.string(),
    name_ta: z.string().nullable(),
    legal_name: z.string().nullable(),
    gstin: z.string().nullable(),
    pan: z.string().nullable(),
    state_code: z.string(),
    state_name: z.string(),
    address_lines: z.array(z.string()),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    logo_url: z.string().nullable(),
    drug_license_numbers: z.string().nullable(),
    fssai_number: z.string().nullable(),
    store_code: z.string(),
    store_name: z.string(),
    store_name_ta: z.string().nullable(),
  }),
  document: z.object({
    number: z.string().nullable(),
    date: zDateStr,
    /** 'HH:mm' in the tenant timezone. */
    time: z.string(),
    issued_at: zTimestamp,
    status: z.union([SalesInvoiceStatusSchema, CreditNoteStatusSchema]),
    cancelled: z.boolean(),
    place_of_supply: z.string(),
    place_of_supply_name: z.string(),
    is_interstate: z.boolean(),
    reverse_charge: z.boolean(),
    register_code: z.string().nullable(),
    cashier_name: z.string().nullable(),
    salesperson_name: z.string().nullable(),
    due_date: zDateStr.nullable(),
    /** Estimates. */
    valid_until: zDateStr.nullable(),
    /** Credit notes: the original invoice (rule 53). */
    original_invoice: z.object({ number: z.string().nullable(), date: zDateStr }).nullable(),
    reason: BilingualSchema.nullable(),
  }),
  /** null = walk-in (print "Cash / ரொக்கம்"). */
  buyer: z
    .object({
      name: z.string(),
      phone: z.string().nullable(),
      gstin: z.string().nullable(),
      address_lines: z.array(z.string()),
      state_code: z.string().nullable(),
      state_name: z.string().nullable(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      line_no: z.int().min(1),
      name: z.string(),
      name_ta: z.string().nullable(),
      /** e.g. 'M / Red'. */
      variant_text: z.string().nullable(),
      note: z.string().nullable(),
      hsn_code: z.string().nullable(),
      batch_no: z.string().nullable(),
      expiry_date: zDateStr.nullable(),
      schedule: DrugScheduleSchema.nullable(),
      serial_numbers: z.array(z.string()),
      qty_milli: zQtyMilli,
      unit: z.string(),
      /** GST unique quantity code (uqcFor). */
      uqc: z.string(),
      /** '1.5 kg', '2 strips + 3 tabs' / Tamil. */
      qty_display: BilingualSchema,
      pack_size: z.int().min(1),
      mrp_paise: zPaise.nullable(),
      /** Price per pack as charged. */
      rate_paise: zPaise,
      price_includes_tax: z.boolean(),
      discount_paise: zPaise,
      taxable_paise: zPaise,
      gst_rate_bp: z.int().min(0),
      cgst_paise: zPaise,
      sgst_paise: zPaise,
      igst_paise: zPaise,
      cess_rate_bp: z.int().min(0),
      cess_paise: zPaise,
      /** Line amount (incl. tax). */
      total_paise: zPaise,
    }),
  ),
  /** Tax summary by rate (thermal) … */
  tax_breakup: z.array(
    TaxBreakupRowSchema.extend({
      /** Half of gst_rate_bp intra-state; may be fractional (0.25% → 12.5 bp). */
      cgst_rate_bp: z.number().min(0),
      sgst_rate_bp: z.number().min(0),
      igst_rate_bp: z.int().min(0),
      tax_paise: zPaise,
    }),
  ),
  /** … and by HSN + rate (A4, GSTR-1 style). */
  hsn_summary: z.array(
    z.object({
      hsn_code: z.string().nullable(),
      gst_rate_bp: z.int().min(0),
      taxable_paise: zPaise,
      cgst_paise: zPaise,
      sgst_paise: zPaise,
      igst_paise: zPaise,
      cess_paise: zPaise,
      tax_paise: zPaise,
    }),
  ),
  /** 'SGST' or 'UTGST' (stateTaxLabel of the place of supply). */
  tax_labels: z.object({
    cgst: z.literal('CGST'),
    sgst: z.enum(['SGST', 'UTGST']),
    igst: z.literal('IGST'),
  }),
  totals: z.object({
    item_count: z.int().min(0),
    ...DocumentTotalFields,
    loyalty_redeem_paise: zPaise,
    discount_paise: zPaise,
    mrp_savings_paise: zPaise,
  }),
  amount_in_words: BilingualSchema,
  payments: z.array(
    z.object({
      method: PaymentMethodSchema,
      label: BilingualSchema,
      amount_paise: zAmountPaise,
      reference: z.string().nullable(),
    }),
  ),
  paid_paise: zPaise,
  change_paise: zPaise,
  due_paise: z.int(),
  returned_paise: zPaise,
  /** Customer's khata balance after this document (when a customer is attached). */
  customer_balance_paise: z.int().nullable(),
  /** Shown when settings.invoice.show_mrp_savings and > 0 ("நீங்கள் சேமித்தது ₹x"). */
  savings: z
    .object({ mrp_savings_paise: zPaise, discount_paise: zPaise, total_paise: zPaise })
    .nullable(),
  loyalty: z
    .object({
      points_earned: z.int().min(0),
      points_redeemed: z.int().min(0),
      redeem_paise: zPaise,
      balance_points: z.int().min(0).nullable(),
    })
    .nullable(),
  /** UPI QR for the due (settings.invoice.upi_qr_on_invoice and a UPI ID exists). */
  upi: z
    .object({
      uri: z.string(),
      amount_paise: zAmountPaise,
      vpa: z.string(),
      payee_name: z.string(),
    })
    .nullable(),
  /** Credit notes: how the value went back. */
  settlement: z
    .object({ method: CreditNoteSettlementSchema, label: BilingualSchema, amount_paise: zPaise })
    .nullable(),
  composition_declaration: BilingualSchema.nullable(),
  footer: z.object({ text_en: z.string(), text_ta: z.string(), terms: z.string() }),
  signatory: z.object({ label: BilingualSchema, for_name: z.string() }),
  rx: z
    .object({
      doctor_name: z.string(),
      doctor_reg_no: z.string().nullable(),
      patient_name: z.string(),
      patient_age: z.int().nullable(),
      patient_address: z.string().nullable(),
      rx_date: zDateStr.nullable(),
    })
    .nullable(),
  flags: z.object({
    show_hsn: z.boolean(),
    show_mrp: z.boolean(),
    show_mrp_savings: z.boolean(),
    bilingual: z.boolean(),
  }),
  /** Public invoice link (QR on receipts) once shared. */
  share_url: z.string().nullable(),
  generated_at: zTimestamp,
})
export type SalesPrintModel = z.output<typeof SalesPrintModelSchema>

export const PrintQuerySchema = z.object({
  /** Default: register setting, else settings.invoice.print_format. */
  format: PrintFormatSchema.optional(),
  locale: LocaleSchema.optional(),
})
export type PrintQuery = z.input<typeof PrintQuerySchema>

/** GET /public/v1/invoices/:shareToken */
export const PublicInvoiceSchema = z.object({
  document: SalesPrintModelSchema,
  /** Pay the due by UPI (null when nothing is due or the shop has no UPI ID). */
  pay: z
    .object({
      amount_paise: zAmountPaise,
      upi_uri: z.string(),
      vpa: z.string(),
      payee_name: z.string(),
      /** Provider-hosted link when a dynamic provider made one. */
      short_url: z.string().nullable(),
    })
    .nullable(),
})
export type PublicInvoice = z.output<typeof PublicInvoiceSchema>

export const ShareTokenParamsSchema = z.object({ shareToken: z.string().regex(SHARE_TOKEN_RE) })

// =============================================================================================
// POS bootstrap & offline sync
// =============================================================================================

/** Sellable product fields (= web CachedProduct without tenant_id / search_tokens). */
export const BootstrapProductSchema = z.object({
  id: zId,
  parent_id: zId.nullable(),
  kind: ProductKindSchema,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  aliases: z.array(z.string()),
  category_id: zId.nullable(),
  brand_id: zId.nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  allow_loose: z.boolean(),
  decimal_qty: z.boolean(),
  hsn_code: z.string().nullable(),
  gst_rate_bp: z.int().min(0),
  cess_rate_bp: z.int().min(0),
  tax_slab_rule_id: zId.nullable(),
  price_includes_tax: z.boolean(),
  /** Base prices; store overrides come in store_prices (resolveUnitPrice). */
  mrp_paise: zPaise.nullable(),
  sale_price_paise: zPaise,
  wholesale_price_paise: zPaise.nullable(),
  min_sale_price_paise: zPaise.nullable(),
  max_discount_bp: zBp.nullable(),
  track_inventory: z.boolean(),
  track_batches: z.boolean(),
  is_weighed: z.boolean(),
  scale_plu: z.string().nullable(),
  variant_attributes: z.record(z.string(), z.string()),
  /** variant_parent: axes of the size × colour matrix. */
  variant_axes: z.array(z.string()),
  attributes: z.record(z.string(), z.unknown()),
  /** Stock at the register's store (all batches); null when not tracked. */
  stock_qty_milli: z.int().nullable(),
  reorder_level_milli: z.int().nullable(),
  is_active: z.boolean(),
  updated_at: zTimestamp,
})
export type BootstrapProduct = z.output<typeof BootstrapProductSchema>

export const BootstrapBarcodeSchema = z.object({
  barcode: z.string(),
  product_id: zId,
  qty_milli: zQtyMilli,
})

export const BootstrapStorePriceSchema = z.object({
  store_id: zId,
  product_id: zId,
  sale_price_paise: zPaise,
  mrp_paise: zPaise.nullable(),
})

export const BootstrapBatchSchema = z.object({
  id: zId,
  product_id: zId,
  batch_no: z.string(),
  expiry_date: zDateStr.nullable(),
  mrp_paise: zPaise.nullable(),
  sale_price_paise: zPaise.nullable(),
  /** Stock of the batch at the register's store. */
  qty_milli: z.int(),
  updated_at: zTimestamp,
})

/** = web CachedPromotion { id, data, updated_at }. */
export const BootstrapPromotionSchema = z.object({
  id: zId,
  data: PromotionSchema,
  updated_at: zTimestamp,
})

export const BootstrapTaxSlabRuleSchema = z.object({
  id: zId,
  name: z.string(),
  slabs: TaxSlabsSchema,
  is_active: z.boolean(),
})

export const BootstrapCategorySchema = z.object({
  id: zId,
  parent_id: zId.nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  sort_order: z.int(),
  is_active: z.boolean(),
})

export const BootstrapCustomerSchema = z.object({
  id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  phone: z.string().nullable(),
  customer_type: CustomerTypeSchema,
  price_tier: PriceTierSchema,
  gstin: z.string().nullable(),
  state_code: z.string().nullable(),
  balance_paise: z.int(),
  credit_limit_paise: zPaise.nullable(),
  loyalty_points: z.int().min(0),
})

/** Number series state for offline numbering (peekSeries). */
export const SeriesStateSchema = z.object({
  doc_type: NumberSeriesDocTypeSchema,
  series_id: zId.nullable(),
  prefix: z.string(),
  next_number: z.int().min(1),
  padding: z.int().min(1),
  fy: z.string(),
  /** formatSeriesNumber(prefix, next_number, padding). */
  next: z.string(),
})
export type SeriesState = z.output<typeof SeriesStateSchema>

export const PosBootstrapQuerySchema = z.object({
  register_id: zId.optional().describe('Default: the trusted device register'),
  /** Without a register (phone billing): the store. */
  store_id: zId.optional(),
  /** Cursor of the previous response → delta mode (an unknown / too old cursor → full). */
  since: z.string().max(200).optional(),
})
export type PosBootstrapQuery = z.input<typeof PosBootstrapQuerySchema>

/**
 * GET /pos/bootstrap. Full mode: the whole sellable catalogue of the store. Delta mode (`since`):
 * rows changed after the cursor — products (the catalog module bumps products.updated_at when
 * barcodes or store prices change), their complete barcode lists (`barcode_product_ids`: replace
 * the cached barcodes of these products), store prices (`store_price_product_ids`: a listed
 * product without a store_prices row has no override), batches with current stock, promotions —
 * plus removed / deactivated ids. Customers, categories, settings, providers, series and shift are
 * always complete. Rows carry no tenant_id (the client adds it).
 */
export const PosBootstrapSchema = z.object({
  mode: z.enum(['full', 'delta']),
  /** Pass as `since` next time (opaque). */
  cursor: z.string(),
  server_time: zTimestamp,
  tenant: z.object({
    id: zId,
    name: z.string(),
    name_ta: z.string().nullable(),
    legal_name: z.string().nullable(),
    business_type: BusinessTypeSchema,
    gst_scheme: GstSchemeSchema,
    gstin: z.string().nullable(),
    state_code: z.string(),
    timezone: z.string(),
    fy_start_month: z.int().min(1).max(12),
    logo_url: z.string().nullable(),
  }),
  store: z.object({
    id: zId,
    code: z.string(),
    name: z.string(),
    name_ta: z.string().nullable(),
    state_code: z.string(),
    gstin: z.string().nullable(),
    address: AddressSchema,
    phone: z.string().nullable(),
    drug_license_numbers: z.string().nullable(),
    fssai_number: z.string().nullable(),
  }),
  register: z
    .object({ id: zId, code: z.string(), name: z.string(), settings: RegisterSettingsSchema })
    .nullable(),
  doc_type: SalesDocTypeSchema.extract(['tax_invoice', 'bill_of_supply']),
  tax_mode: GstSchemeSchema.describe('Tax mode of the document (= the GST scheme)'),
  settings: TenantSettingsSchema,
  features: z.array(FeatureSchema),
  /** The register's invoice series (offline numbering; per register, used by this device only). */
  series: SeriesStateSchema.nullable(),
  /** Open shift of the register (feature shifts). */
  open_shift: ShiftSchema.pick({
    id: true,
    opened_at: true,
    opened_by: true,
    opened_by_name: true,
    opening_cash_paise: true,
  }).nullable(),
  /** settings.pos.require_open_shift and feature shifts: bills need an open shift. */
  shift_required: z.boolean(),
  quick_keys: z.array(zId),
  categories: z.array(BootstrapCategorySchema),
  products: z.array(BootstrapProductSchema),
  barcodes: z.array(BootstrapBarcodeSchema),
  barcode_product_ids: z.array(zId),
  store_prices: z.array(BootstrapStorePriceSchema),
  store_price_product_ids: z.array(zId),
  /** FEFO order (expiry asc, then creation). */
  batches: z.array(BootstrapBatchSchema),
  promotions: z.array(BootstrapPromotionSchema),
  tax_slab_rules: z.array(BootstrapTaxSlabRuleSchema),
  /** Active providers of the store (public fields): static VPA works offline. */
  payment_providers: z.array(PaymentProviderPublicSchema),
  /** 200 most recent customers (offline lookup by phone / name). */
  customers: z.array(BootstrapCustomerSchema),
  removed_product_ids: z.array(zId),
  removed_barcodes: z.array(z.string()),
  removed_batch_ids: z.array(zId),
  removed_promotion_ids: z.array(zId),
})
export type PosBootstrap = z.output<typeof PosBootstrapSchema>

/** An invoice created offline (status completed), uploaded in creation order. */
export const SyncInvoiceSchema = z.object({
  ...CartFields,
  client_ref: zIdempotencyKey,
  /** Number printed offline from the register series (null when none was assigned). */
  offline_number: z.string().max(32).nullable(),
  offline_created_at: zTimestamp,
  /** Business date of the offline bill. */
  invoice_date: zDateStr,
  tenders: z.array(TenderInputSchema).max(10).default([]),
  credit_limit_override: z.boolean().default(false),
  /**
   * A held bill recalled and completed offline: it is removed at sync (same store, still held /
   * draft) in the bill's transaction, so it cannot be billed a second time.
   */
  held_invoice_id: zId.optional(),
})
export type SyncInvoice = z.input<typeof SyncInvoiceSchema>

/**
 * An offline return. Credit notes are numbered per store, so offline returns print a provisional
 * slip and get their number at sync.
 */
export const SyncCreditNoteSchema = CreditNoteCreateSchema.and(
  z.object({ offline_created_at: zTimestamp, note_date: zDateStr }),
)
export type SyncCreditNote = z.input<typeof SyncCreditNoteSchema>

/**
 * POST /pos/sync — invoices first, then credit notes, each in array order and its own
 * transaction (a failure does not block the rest). Offline numbers are kept when they are the
 * series' next number (acceptOfflineNumber) else renumbered (audited); stock may go negative
 * (flagged in line meta + audit); monthly invoice usage is counted without enforcement.
 */
export const PosSyncRequestSchema = z
  .object({
    register_id: zId,
    invoices: z.array(SyncInvoiceSchema).max(200).default([]),
    credit_notes: z.array(SyncCreditNoteSchema).max(200).default([]),
  })
  .refine((v) => v.invoices.length + v.credit_notes.length > 0, { message: 'sync_empty' })
export type PosSyncRequest = z.input<typeof PosSyncRequestSchema>

export const SyncItemResultSchema = z.object({
  kind: z.enum(['invoice', 'credit_note']),
  client_ref: z.string(),
  /** created | duplicate (already uploaded: same document returned) | renumbered | failed. */
  status: z.enum(['created', 'duplicate', 'renumbered', 'failed']),
  id: zId.nullable(),
  number: z.string().nullable(),
  offline_number: z.string().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
  warnings: z.array(SalesIssueSchema),
})
export type SyncItemResult = z.output<typeof SyncItemResultSchema>

export const PosSyncResultSchema = z.object({
  results: z.array(SyncItemResultSchema),
  created: z.int().min(0),
  duplicates: z.int().min(0),
  renumbered: z.int().min(0),
  failed: z.int().min(0),
  /** Register invoice series after the upload (realign local numbering). */
  series: SeriesStateSchema.nullable(),
})
export type PosSyncResult = z.output<typeof PosSyncResultSchema>

// =============================================================================================
// Route catalogue (docs/API.md "sales & POS")
// =============================================================================================

const IdParams = z.object({ id: zId })

export const salesRoutes = defineRoutes({
  // ---- POS ----
  posBootstrap: {
    method: 'GET',
    path: '/pos/bootstrap',
    permission: 'pos.use',
    feature: 'pos',
    query: PosBootstrapQuerySchema,
    response: dataOf(PosBootstrapSchema),
    summary:
      'Offline catalogue, settings, series state and providers for a register (delta with since)',
  },
  posQuote: {
    method: 'POST',
    path: '/pos/quote',
    permission: ['pos.use', 'sales.create'],
    body: QuoteRequestSchema,
    response: dataOf(QuoteResultSchema),
    summary: 'Server-priced cart: lines, taxes, promotions, issues (no writes)',
  },
  posSync: {
    method: 'POST',
    path: '/pos/sync',
    permission: 'pos.use',
    feature: 'pos',
    body: PosSyncRequestSchema,
    response: dataOf(PosSyncResultSchema),
    summary: 'Upload offline invoices / returns in order (per-item results)',
  },
  listHeld: {
    method: 'GET',
    path: '/sales/held',
    permission: ['pos.use', 'sales.create'],
    query: HeldBillsQuerySchema,
    response: dataOf(z.array(HeldBillSchema)),
    summary: 'Held bills (and drafts) of a store, newest first',
  },

  // ---- invoices ----
  createInvoice: {
    method: 'POST',
    path: '/sales/invoices',
    permission: 'sales.create',
    idempotent: true,
    body: InvoiceCreateSchema,
    response: dataOf(InvoiceSaveResultSchema),
    status: 201,
    summary: 'Create a bill (completed with tenders, or held / draft); idempotent by client_ref',
  },
  listInvoices: {
    method: 'GET',
    path: '/sales/invoices',
    permission: 'sales.read',
    query: InvoiceListQuerySchema,
    response: InvoiceListResponseSchema,
    summary: 'Invoices with filters and totals (?format=csv); doc_type=estimate lists estimates',
  },
  getInvoice: {
    method: 'GET',
    path: '/sales/invoices/:id',
    permission: 'sales.read',
    params: IdParams,
    response: dataOf(SalesInvoiceDetailSchema),
  },
  updateInvoice: {
    method: 'PATCH',
    path: '/sales/invoices/:id',
    permission: 'sales.create',
    params: IdParams,
    body: InvoiceUpdateSchema,
    response: dataOf(SalesInvoiceDetailSchema),
    summary: 'Edit a held bill / draft (re-priced)',
  },
  deleteInvoice: {
    method: 'DELETE',
    path: '/sales/invoices/:id',
    permission: 'sales.create',
    params: IdParams,
    summary: 'Delete a held bill / draft (completed invoices are cancelled instead → 409)',
  },
  completeInvoice: {
    method: 'POST',
    path: '/sales/invoices/:id/complete',
    permission: 'sales.create',
    idempotent: true,
    params: IdParams,
    body: InvoiceCompleteSchema,
    response: dataOf(InvoiceSaveResultSchema),
    summary: 'Complete a held bill / draft with tenders',
  },
  cancelInvoice: {
    method: 'POST',
    path: '/sales/invoices/:id/cancel',
    permission: 'sales.cancel',
    params: IdParams,
    body: InvoiceCancelSchema,
    response: dataOf(InvoiceCancelResultSchema),
    summary: 'Cancel: stock back, journal reversed, payments cancelled (twice → 409)',
  },
  collectPayment: {
    method: 'POST',
    path: '/sales/invoices/:id/payments',
    permission: 'payments.collect',
    idempotent: true,
    params: IdParams,
    body: CollectPaymentSchema,
    response: dataOf(CollectPaymentResultSchema),
    status: 201,
    summary: 'Collect (part of) the due of an invoice',
  },
  printInvoice: {
    method: 'GET',
    path: '/sales/invoices/:id/print',
    permission: 'sales.read',
    params: IdParams,
    query: PrintQuerySchema,
    response: dataOf(SalesPrintModelSchema),
    summary: 'Print model (thermal 58 / 80 mm, A4) of an invoice / estimate',
  },
  shareInvoice: {
    method: 'POST',
    path: '/sales/invoices/:id/share',
    permission: 'sales.read',
    params: IdParams,
    body: InvoiceShareSchema,
    response: dataOf(InvoiceShareResultSchema),
    summary: 'Public link + WhatsApp / SMS notification (template invoice_share)',
  },
  returnable: {
    method: 'GET',
    path: '/sales/invoices/:id/returnable',
    permission: 'sales.return',
    params: IdParams,
    response: dataOf(ReturnableResponseSchema),
    summary: 'Lines with sold / returned / returnable quantity and credited amounts',
  },

  // ---- estimates ----
  createEstimate: {
    method: 'POST',
    path: '/sales/estimates',
    permission: 'sales.create',
    idempotent: true,
    body: EstimateCreateSchema,
    response: dataOf(SalesInvoiceDetailSchema),
    status: 201,
    summary: 'Create an estimate (numbered EST…, no stock / journal)',
  },
  convertEstimate: {
    method: 'POST',
    path: '/sales/estimates/:id/convert',
    permission: 'sales.create',
    idempotent: true,
    params: IdParams,
    body: EstimateConvertSchema,
    response: dataOf(InvoiceSaveResultSchema),
    status: 201,
    summary: 'Convert an estimate into a draft / completed invoice',
  },

  // ---- credit notes ----
  listCreditNotes: {
    method: 'GET',
    path: '/sales/credit-notes',
    permission: ['sales.return', 'sales.read'],
    query: CreditNoteListQuerySchema,
    response: CreditNoteListResponseSchema,
    summary: 'Returns (credit notes) with filters (?format=csv)',
  },
  createCreditNote: {
    method: 'POST',
    path: '/sales/credit-notes',
    permission: 'sales.return',
    idempotent: true,
    body: CreditNoteCreateSchema,
    response: dataOf(CreditNoteDetailSchema),
    status: 201,
    summary: 'Accept a return: pro-rata amounts, restock, journal, settlement',
  },
  getCreditNote: {
    method: 'GET',
    path: '/sales/credit-notes/:id',
    permission: ['sales.return', 'sales.read'],
    params: IdParams,
    response: dataOf(CreditNoteDetailSchema),
  },
  cancelCreditNote: {
    method: 'POST',
    path: '/sales/credit-notes/:id/cancel',
    permission: 'sales.cancel',
    params: IdParams,
    body: CreditNoteCancelSchema,
    response: dataOf(CreditNoteDetailSchema),
    summary: 'Cancel a credit note (reverses stock, journal, settlement, loyalty)',
  },
  printCreditNote: {
    method: 'GET',
    path: '/sales/credit-notes/:id/print',
    permission: ['sales.return', 'sales.read'],
    params: IdParams,
    query: PrintQuerySchema,
    response: dataOf(SalesPrintModelSchema),
  },

  // ---- public ----
  publicInvoice: {
    method: 'GET',
    path: '/invoices/:shareToken',
    scope: 'public',
    auth: 'public',
    params: ShareTokenParamsSchema,
    response: dataOf(PublicInvoiceSchema),
    summary: 'Public invoice view (no internal ids / costs) + UPI pay link when due',
  },
})
