// CONTRACT CHANGELOG (purchases backend; one line per change — web counterpart please read)
// - PURCHASES_VALIDATION_KEYS += 'future_date', 'batch_no_required', 'expiry_required' (bill lines of batch-tracked products; dates after today).
// - Added PURCHASES_ERROR_REASONS (details.reason of 4xx errors raised by the purchases routes; translate as purchases:errors.<reason>).
// - DebitNoteDetailSchema += adjusted_paise (part applied against the bill due for adjust_due; the rest is the supplier's advance). Default 0.
// - DebitNoteDetailSchema.cancel_reason now comes from the new debit_notes.cancel_reason column (migration 0600), not the audit log.
// - reverse_charge documented: the supplier is owed total − tax (the GST is the shop's own liability); due_paise starts there.
// - itc_eligible documented: forced false for composition / unregistered tenants (tax goes into cost).
// - PurchaseBillLineSchema.discount_paise documented: the flat discount as entered (round-trips with discount_bp); line discount total = gross − taxable.
// - PurchaseBillPostResultSchema.stock_lines documented: number of stock movements posted (one per stock-tracked line).
// - PO received quantities count the charged quantity of posted bill lines (free quantity is a bonus, not a receipt against the order).
// - (review) ReorderItemSchema += unit_cost_paise (last cost, else the product's purchase price): the basis of estimated_cost_paise and the PO line default; the web estimates with it.
// - (review) Debit notes against reverse-charge bills: the payable / bill due / refund move by total − tax and the output tax is reversed (mirror of the bill's journal).
// - (review) PurchaseOrderListRow.received_bp is weighted by the lines' taxable value (quantities of different units do not add up); by quantity when the order has no prices.
// - (review) PurchaseBillListResponse.summary total / paid leave cancelled bills out unless status=cancelled is filtered.
// - (review) DebitNoteDetailSchema += supplier_amount_paise (total, or total − tax against a reverse-charge bill): the amount adjusted / refunded; the web shows the advance from it.
// - (review) Posting with update_prices: false no longer sets the selling price of a NEW batch (its printed MRP is still recorded).
/**
 * Contract for the purchases module — docs/API.md "purchases"; ARCHITECTURE.md §9 (purchase
 * maths in pricing.ts), §10 (posting rules).
 *
 *  - Purchase orders (numbered on create, PO…): draft → sent → partially_received / received,
 *    or cancelled / closed. Receipts come from posted purchase bills.
 *  - Purchase bills (GRN + supplier invoice): drafts are freely edited; POST …/post numbers the
 *    GRN, creates / updates batches, posts stock at landed cost, the journal and optional price
 *    updates. Totals and landed costs are ALWAYS computed by purchaseBillTotals() below (shared
 *    by the bill-entry grid and the server).
 *  - Debit notes (purchase returns): from bill lines (pro-rata, prorateReturnLine) or free-form
 *    lines (product + batch, e.g. pharmacy expiry returns).
 *  - Reorder suggestions.
 * Supplier payments use POST /payments (direction 'out', party supplier, allocations
 * purchase_bill) from the payments contract.
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope.
 * Custom validation messages are snake_case keys (PURCHASES_VALIDATION_KEYS), translated by the
 * web (errors:validation.<key>, else purchases:validation.<key>).
 */
import { z } from 'zod'
import {
  DebitNoteReasonSchema,
  type DebitNoteReason,
  DebitNoteSettlementSchema,
  type DebitNoteSettlement,
  DebitNoteStatusSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  PurchaseBillStatusSchema,
  type PurchaseBillStatus,
  PurchaseOrderStatusSchema,
  type PurchaseOrderStatus,
  PurchasePaymentStatusSchema,
} from '../enums'
import { mulDiv, roundDiv } from '../math'
import {
  type PurchaseDocumentResult,
  type PurchaseLineBase,
  computePurchaseDocument,
} from '../pricing'
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
  zOptionalPhone,
  zPaise,
  zQtyMilli,
  zSearchQuery,
  zTimestamp,
} from './common'
import {
  DATE_ORDER_ISSUE,
  DATE_RANGE_FIELDS,
  PaymentOriginSchema,
  dateOrderOk,
  zAmountPaise,
  zIfUpdatedAt,
  zListFormat,
  zMilli0,
  zNullableText,
  zQueryList,
  zReason,
} from './payments'
import { zQueryIds } from './identity'
import { TaxBreakupRowSchema } from './sales'

// =============================================================================================
// Validation keys & labels
// =============================================================================================

export const PURCHASES_VALIDATION_KEYS = [
  'expiry_before_mfg',
  'duplicate_line_product',
  'supplier_invoice_no_required',
  'debit_note_line_ref_required',
  'debit_note_free_form_cost_required',
  'debit_note_mixed_lines',
  'debit_note_party_required',
  'duplicate_bill_line',
  'expiry_format',
  'reason_required',
  'date_order',
  'empty_patch',
  'future_date',
  'batch_no_required',
  'expiry_required',
] as const
export type PurchasesValidationKey = (typeof PURCHASES_VALIDATION_KEYS)[number]

/**
 * `details.reason` of the 4xx errors raised by the purchases routes (web:
 * purchases:errors.<reason>). Status in the comment.
 */
export const PURCHASES_ERROR_REASONS = [
  'duplicate_supplier_invoice', // 409 DUPLICATE (DuplicateSupplierInvoiceDetailsSchema)
  'order_not_draft', // 409: only draft purchase orders can be edited / deleted
  'order_not_sendable', // 409: only draft / sent orders can be sent
  'order_has_receipts', // 409: goods were received against the order → close it instead
  'order_not_cancellable', // 409: only draft / sent orders can be cancelled
  'order_not_closable', // 409: only sent / partially received orders can be closed
  'order_has_bills', // 409: bills reference the draft order (delete / cancel them first)
  'order_not_receivable', // 422: the order is cancelled / closed / received
  'order_mismatch', // 422: the order belongs to another supplier / store
  'order_line_mismatch', // 422: purchase_order_line_id is not a line of the bill's order / product
  'bill_not_draft', // 409: only draft bills can be edited / deleted / posted
  'bill_not_posted', // 409 / 422: cancelling or returning against a bill that is not posted
  'bill_has_payments', // 409: cancel the supplier payments allocated to the bill first
  'bill_has_debit_notes', // 409: cancel the debit notes against the bill first
  'supplier_invoice_no_required', // 422: a draft from a purchase order needs the invoice number to post
  'expired_batch', // 422 EXPIRED_BATCH: expiry before today (post with allow_past_expiry)
  'batch_expiry_mismatch', // 422: the batch exists with another expiry date
  'product_not_purchasable', // 422: services / variant templates / inactive products
  'supplier_inactive', // 422
  'store_inactive', // 422
  'returnable_exceeded', // 422: more than charged + free − returned
  'batch_mismatch', // 422: the batch belongs to another product / is required / not allowed
  'debit_note_cancelled', // 409: already cancelled
  'debit_note_has_payments', // 409: cancel the supplier receipts allocated to the note first
  'bill_mismatch', // 422: supplier_id / store_id differ from the debit note's bill
  'refund_account_invalid', // 422: refund_bank account must be an active asset (cash / bank) account
  'recipient_phone_required', // 422: sending a PO needs the supplier's (or a given) phone
] as const
export type PurchasesErrorReason = (typeof PURCHASES_ERROR_REASONS)[number]

type Bilingual = Readonly<BilingualLabel>

export const PURCHASE_DOC_TITLES = {
  purchase_order: { en: 'Purchase Order', ta: 'கொள்முதல் ஆணை' },
  purchase_bill: { en: 'Goods Receipt Note', ta: 'பொருள் பெறுதல் குறிப்பு' },
  debit_note: { en: 'Debit Note', ta: 'டெபிட் நோட்' },
} as const satisfies Record<string, Bilingual>

export const DEBIT_NOTE_REASON_LABELS: Readonly<Record<DebitNoteReason, Bilingual>> = {
  return: { en: 'Goods returned', ta: 'பொருள் திருப்பம்' },
  damaged: { en: 'Damaged', ta: 'சேதம்' },
  expired: { en: 'Expired', ta: 'காலாவதி' },
  short_supply: { en: 'Short supply', ta: 'குறைவான விநியோகம்' },
  price_difference: { en: 'Price difference', ta: 'விலை வேறுபாடு' },
  other: { en: 'Other', ta: 'மற்றவை' },
}

export const DEBIT_NOTE_SETTLEMENT_LABELS: Readonly<Record<DebitNoteSettlement, Bilingual>> = {
  adjust_due: { en: 'Adjust against supplier due', ta: 'சப்ளையர் நிலுவையில் கழித்தல்' },
  refund_cash: { en: 'Cash refund from supplier', ta: 'சப்ளையரிடமிருந்து ரொக்கம்' },
  refund_bank: { en: 'Bank refund from supplier', ta: 'சப்ளையரிடமிருந்து வங்கி மூலம்' },
}

/** Notification template for POST /purchase-orders/:id/send. */
export const PO_TO_SUPPLIER_TEMPLATE = 'po_to_supplier'
export const PoToSupplierTemplateParamsSchema = z.object({
  shop_name: z.string(),
  supplier_name: z.string(),
  number: z.string(),
  date: z.string(),
  /** formatPurchaseOrderText() body. */
  items: z.string(),
  total: z.string().nullable(),
})

// =============================================================================================
// Pure helpers shared by the bill-entry grid and the server
// =============================================================================================

export interface PurchaseBillLineCalcInput extends PurchaseLineBase {
  key?: string
}

/**
 * Totals of a purchase bill: computePurchaseDocument (other charges allocated pro-rata to taxable
 * value; landed cost per pack over charged + free quantity; non-ITC tax capitalised) with the
 * round-off either automatic (nearest rupee) or the supplier's exact `round_off_paise` override.
 */
export function purchaseBillTotals(input: {
  lines: readonly PurchaseBillLineCalcInput[]
  is_interstate: boolean
  other_charges_paise?: number
  itc_eligible?: boolean
  /** null / undefined = automatic nearest-rupee round-off. */
  round_off_paise?: number | null
}): PurchaseDocumentResult {
  const override = input.round_off_paise
  const doc = computePurchaseDocument({
    lines: input.lines,
    is_interstate: input.is_interstate,
    other_charges_paise: input.other_charges_paise ?? 0,
    itc_eligible: input.itc_eligible ?? true,
    round_off: override == null ? 'nearest_rupee' : 'none',
  })
  if (override == null) return doc
  if (!Number.isSafeInteger(override) || override < -99 || override > 99) {
    throw new RangeError('round_off_paise must be between -99 and 99')
  }
  return { ...doc, round_off_paise: override, total_paise: doc.total_paise + override }
}

/** 'MM/YY' or 'MM/YYYY' (quick expiry entry) → last day of that month, else null. */
export function expiryFromMonthYear(input: string): string | null {
  const m = /^\s*(0?[1-9]|1[0-2])\s*[/\-.]\s*(\d{2}|\d{4})\s*$/.exec(input)
  if (!m) return null
  const month = Number(m[1])
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2])
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/** Sale price per pack excluding tax (inclusive prices: tax backed out like the sales engine). */
export function salePriceExclTax(p: {
  sale_price_paise: number
  price_includes_tax: boolean
  gst_rate_bp: number
  cess_rate_bp?: number
}): number {
  if (!p.price_includes_tax) return p.sale_price_paise
  return mulDiv(p.sale_price_paise, 10_000, 10_000 + p.gst_rate_bp + (p.cess_rate_bp ?? 0))
}

/**
 * Margin of a selling price over the landed cost, in bp of the net (excl. tax) selling price:
 * (net − cost) / net. null when the net price is 0. Negative = selling below cost.
 */
export function marginBp(p: {
  sale_price_paise: number
  price_includes_tax: boolean
  gst_rate_bp: number
  cess_rate_bp?: number
  cost_paise: number
}): number | null {
  const net = salePriceExclTax(p)
  if (net <= 0) return null
  return roundDiv((net - p.cost_paise) * 10_000, net)
}

/** Reorder quantity: max(reorder_qty, 2 × reorder_level − stock), never below 0. */
export function suggestedReorderQtyMilli(input: {
  reorder_level_milli: number
  reorder_qty_milli: number | null
  stock_milli: number
}): number {
  return Math.max(
    0,
    input.reorder_qty_milli ?? 0,
    2 * input.reorder_level_milli - input.stock_milli,
  )
}

/** Average daily sales (milli) over a window (default 30 days), rounded. */
export function averageDailySalesMilli(soldMilli: number, days = 30): number {
  if (days <= 0) throw new RangeError('days must be > 0')
  return roundDiv(Math.max(0, soldMilli), days)
}

/** PO status implied by received quantities (from posted bills); keeps draft/sent when nothing was received. */
export function purchaseOrderStatusAfterReceipt(
  current: PurchaseOrderStatus,
  lines: readonly { qty_milli: number; received_qty_milli: number }[],
): PurchaseOrderStatus {
  if (current === 'cancelled' || current === 'closed') return current
  const any = lines.some((l) => l.received_qty_milli > 0)
  if (!any) return current === 'partially_received' || current === 'received' ? 'sent' : current
  return lines.every((l) => l.received_qty_milli >= l.qty_milli) ? 'received' : 'partially_received'
}

/** Actions the UI may offer for a purchase order. */
export function purchaseOrderActions(status: PurchaseOrderStatus): {
  edit: boolean
  delete: boolean
  send: boolean
  receive: boolean
  cancel: boolean
  close: boolean
} {
  return {
    edit: status === 'draft',
    delete: status === 'draft',
    send: status === 'draft' || status === 'sent',
    receive: status === 'draft' || status === 'sent' || status === 'partially_received',
    cancel: status === 'draft' || status === 'sent',
    close: status === 'sent' || status === 'partially_received',
  }
}

/** Actions the UI may offer for a purchase bill. */
export function purchaseBillActions(
  status: PurchaseBillStatus,
  opts: { due_paise: number; has_live_payments: boolean },
): {
  edit: boolean
  delete: boolean
  post: boolean
  cancel: boolean
  pay: boolean
  return: boolean
} {
  return {
    edit: status === 'draft',
    delete: status === 'draft',
    post: status === 'draft',
    cancel: status === 'posted' && !opts.has_live_payments,
    pay: status === 'posted' && opts.due_paise > 0,
    return: status === 'posted',
  }
}

export const PurchaseWarningCodeSchema = z.enum([
  'cost_above_last',
  'mrp_changed',
  'near_expiry',
  'expired',
  'sale_price_below_cost',
  'sale_price_above_mrp',
  'gst_rate_differs',
  'interstate_mismatch',
  'received_more_than_ordered',
])
export type PurchaseWarningCode = z.infer<typeof PurchaseWarningCodeSchema>

export const PurchaseWarningSchema = z.object({
  code: PurchaseWarningCodeSchema,
  /** null = whole bill. */
  line_no: z.int().min(1).nullable(),
  product_id: zId.nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export type PurchaseWarning = z.output<typeof PurchaseWarningSchema>

/**
 * Line warnings of the bill-entry grid (the server returns the same in `warnings`):
 * cost above the last purchase cost, MRP different from the product / batch MRP, near-expiry or
 * expired batch, new sale price below landed cost or above MRP, GST rate differing from the
 * product's.
 */
export function purchaseLineWarnings(
  line: {
    line_no: number
    product_id: string
    unit_cost_paise: number
    mrp_paise?: number | null
    expiry_date?: string | null
    gst_rate_bp: number
    landed_unit_cost_paise: number
    sale_price_paise?: number | null
  },
  product: {
    last_cost_paise: number | null
    mrp_paise: number | null
    gst_rate_bp: number
    price_includes_tax: boolean
    cess_rate_bp?: number
  },
  ctx: { today: string; expiry_warning_days: number },
): PurchaseWarning[] {
  const out: PurchaseWarning[] = []
  const w = (code: PurchaseWarningCode, params: PurchaseWarning['params'] = {}): void => {
    out.push({ code, line_no: line.line_no, product_id: line.product_id, params })
  }
  if (product.last_cost_paise != null && line.unit_cost_paise > product.last_cost_paise) {
    w('cost_above_last', { last_cost_paise: product.last_cost_paise })
  }
  if (line.mrp_paise != null && product.mrp_paise != null && line.mrp_paise !== product.mrp_paise) {
    w('mrp_changed', { previous_mrp_paise: product.mrp_paise })
  }
  if (line.expiry_date) {
    if (line.expiry_date < ctx.today) w('expired', { expiry_date: line.expiry_date })
    else {
      const days =
        (Date.parse(`${line.expiry_date}T00:00:00Z`) - Date.parse(`${ctx.today}T00:00:00Z`)) /
        86_400_000
      if (days <= ctx.expiry_warning_days) w('near_expiry', { expiry_date: line.expiry_date, days })
    }
  }
  if (line.sale_price_paise != null) {
    const margin = marginBp({
      sale_price_paise: line.sale_price_paise,
      price_includes_tax: product.price_includes_tax,
      gst_rate_bp: line.gst_rate_bp,
      cess_rate_bp: product.cess_rate_bp ?? 0,
      cost_paise: line.landed_unit_cost_paise,
    })
    if (margin !== null && margin < 0) w('sale_price_below_cost', { margin_bp: margin })
    const mrp = line.mrp_paise ?? product.mrp_paise
    if (mrp != null && line.sale_price_paise > mrp) w('sale_price_above_mrp', { mrp_paise: mrp })
  }
  if (line.gst_rate_bp !== product.gst_rate_bp)
    w('gst_rate_differs', { product_gst_rate_bp: product.gst_rate_bp })
  return out
}

/** WhatsApp / SMS text of a purchase order (`items` param of po_to_supplier). */
export function formatPurchaseOrderText(
  lines: readonly { name: string; qty_display: string }[],
): string {
  return lines.map((l, i) => `${i + 1}. ${l.name} — ${l.qty_display}`).join('\n')
}

// =============================================================================================
// Shared response pieces
// =============================================================================================

const SupplierRef = z.object({
  id: zId,
  name: z.string(),
  phone: z.string().nullable(),
  gstin: z.string().nullable(),
  state_code: z.string().nullable(),
  address: AddressSchema.nullable(),
  drug_license_no: z.string().nullable(),
  /** payable (+ = the shop owes the supplier). */
  balance_paise: z.int(),
  payment_terms_days: z.int().min(0).nullable(),
})

const ProductRef = z.object({
  id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  hsn_code: z.string().nullable(),
  track_batches: z.boolean(),
})

const TaxAmountFields = {
  taxable_paise: zPaise,
  cgst_paise: zPaise,
  sgst_paise: zPaise,
  igst_paise: zPaise,
  cess_paise: zPaise,
}

/** A payment allocated to a bill / debit note. */
export const PurchasePaymentRefSchema = z.object({
  payment_id: zId,
  number: z.string().nullable(),
  method: PaymentMethodSchema,
  amount_paise: zAmountPaise,
  payment_date: zDateStr,
  reference: z.string().nullable(),
  status: PaymentStatusSchema,
  origin: PaymentOriginSchema,
})

// =============================================================================================
// Purchase orders
// =============================================================================================

export const PurchaseOrderLineInputSchema = z.object({
  product_id: zId,
  qty_milli: zQtyMilli,
  /** Per pack, excluding tax. Default: the product's purchase price. */
  unit_cost_paise: zPaise.optional(),
  /** Default: the product's GST rate. */
  gst_rate_bp: zGstRateBp.optional(),
  notes: z.string().trim().max(200).optional(),
})
export type PurchaseOrderLineInput = z.input<typeof PurchaseOrderLineInputSchema>

const zPoLines = z
  .array(PurchaseOrderLineInputSchema)
  .min(1)
  .max(500)
  .refine((ls) => new Set(ls.map((l) => l.product_id)).size === ls.length, {
    message: 'duplicate_line_product',
  })

/** POST /purchase-orders — numbered (PO…) on create; interstate from supplier vs store state. */
export const PurchaseOrderCreateSchema = z.object({
  store_id: zId,
  supplier_id: zId,
  order_date: zDateStr.optional().describe('Default: today'),
  expected_date: zDateStr.optional(),
  lines: zPoLines,
  notes: z.string().trim().max(1000).optional(),
  terms: z.string().trim().max(2000).optional(),
  client_ref: zIdempotencyKey.optional(),
})
export type PurchaseOrderCreate = z.input<typeof PurchaseOrderCreateSchema>

/** PATCH /purchase-orders/:id — draft only; `lines` replaces every line. */
export const PurchaseOrderUpdateSchema = z
  .object({
    supplier_id: zId.optional(),
    order_date: zDateStr.optional(),
    expected_date: zDateStr.nullable().optional(),
    lines: zPoLines.optional(),
    notes: zNullableText(1000),
    terms: zNullableText(2000),
    if_updated_at: zIfUpdatedAt,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at'), {
    message: 'empty_patch',
  })
export type PurchaseOrderUpdate = z.input<typeof PurchaseOrderUpdateSchema>

/** POST /purchase-orders/:id/send — marks sent; optionally messages the supplier. */
export const PurchaseOrderSendSchema = z
  .object({
    via: z.enum(['whatsapp', 'sms']).nullable().optional(),
    /** Default: the supplier's phone. */
    phone: zOptionalPhone,
    /** Extra line added to the message. */
    message: z.string().trim().max(500).optional(),
  })
  .prefault({})
export type PurchaseOrderSend = z.input<typeof PurchaseOrderSendSchema>

export const PurchaseOrderStatusChangeSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .prefault({})

export const PurchaseOrderLineSchema = z.object({
  id: zId,
  line_no: z.int().min(1),
  product: ProductRef,
  product_id: zId,
  qty_milli: zQtyMilli,
  received_qty_milli: zMilli0,
  pending_qty_milli: zMilli0,
  unit_cost_paise: zPaise,
  gst_rate_bp: z.int().min(0),
  taxable_paise: zPaise,
  tax_paise: zPaise,
  total_paise: zPaise,
  notes: z.string().nullable(),
  /** Stock at the PO's store now. */
  current_stock_milli: z.int().nullable(),
  last_cost_paise: zPaise.nullable(),
})
export type PurchaseOrderLine = z.output<typeof PurchaseOrderLineSchema>

export const PurchaseOrderListRowSchema = z.object({
  id: zId,
  number: z.string(),
  fy: z.string(),
  order_date: zDateStr,
  expected_date: zDateStr.nullable(),
  status: PurchaseOrderStatusSchema,
  store_id: zId,
  supplier_id: zId,
  supplier_name: z.string(),
  line_count: z.int().min(0),
  taxable_paise: zPaise,
  tax_paise: zPaise,
  total_paise: zPaise,
  /**
   * Share of the order received, in bp (0..10000), weighted by the lines' taxable value (by
   * quantity when the order has no prices).
   */
  received_bp: zBp,
  sent_at: zTimestamp.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type PurchaseOrderListRow = z.output<typeof PurchaseOrderListRowSchema>

export const PurchaseOrderDetailSchema = PurchaseOrderListRowSchema.extend({
  is_interstate: z.boolean(),
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  supplier: SupplierRef,
  lines: z.array(PurchaseOrderLineSchema),
  bills: z.array(
    z.object({
      id: zId,
      number: z.string().nullable(),
      supplier_invoice_no: z.string(),
      received_date: zDateStr,
      status: PurchaseBillStatusSchema,
      total_paise: zPaise,
    }),
  ),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
})
export type PurchaseOrderDetail = z.output<typeof PurchaseOrderDetailSchema>

export const PurchaseOrderSendResultSchema = z.object({
  order: PurchaseOrderDetailSchema,
  notification_id: zId.nullable(),
  /** Message text (manual share / preview). */
  message: z.string(),
  wa_me_url: z.string().nullable(),
})

export const PurchaseOrderListQuerySchema = PageQuerySchema.extend({
  /** PO number or supplier name. */
  q: zSearchQuery.optional(),
  status: zQueryList(PurchaseOrderStatusSchema).optional(),
  supplier_id: zId.optional(),
  store_id: zId.optional(),
  ...DATE_RANGE_FIELDS,
  sort: sortQuery(['order_date', 'number', 'total_paise', 'expected_date', 'created_at']).prefault(
    '-order_date',
  ),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type PurchaseOrderListQuery = z.input<typeof PurchaseOrderListQuerySchema>

// =============================================================================================
// Purchase bills
// =============================================================================================

export const PurchaseBillLineInputSchema = z
  .object({
    product_id: zId,
    purchase_order_line_id: zId.optional(),
    /** Required (with expiry_date) for batch-tracked products. */
    batch_no: z.string().trim().min(1).max(40).optional(),
    mfg_date: zDateStr.optional(),
    expiry_date: zDateStr.optional(),
    /** Per pack; updates the batch / product MRP on posting. */
    mrp_paise: zPaise.optional(),
    qty_milli: zQtyMilli,
    free_qty_milli: zMilli0.optional(),
    /** Supplier rate per pack, excluding tax, before discount. */
    unit_cost_paise: zPaise,
    discount_bp: zBp.optional(),
    discount_paise: zPaise.optional(),
    /** Default: the product's rate. */
    gst_rate_bp: zGstRateBp.optional(),
    cess_rate_bp: z.int().min(0).max(30_000).optional(),
    hsn_code: zHsn.optional(),
    /** New selling price per pack to apply on posting (audited). */
    sale_price_paise: zPaise.optional(),
  })
  .refine((l) => !l.mfg_date || !l.expiry_date || l.expiry_date >= l.mfg_date, {
    message: 'expiry_before_mfg',
    path: ['expiry_date'],
  })
export type PurchaseBillLineInput = z.input<typeof PurchaseBillLineInputSchema>

const BillFields = {
  supplier_id: zId,
  store_id: zId,
  purchase_order_id: zId.optional(),
  supplier_invoice_no: z.string().trim().min(1, 'supplier_invoice_no_required').max(40),
  supplier_invoice_date: zDateStr,
  received_date: zDateStr.optional().describe('Default: today'),
  due_date: zDateStr
    .optional()
    .describe("Default: supplier invoice date + supplier's payment terms"),
  is_interstate: z.boolean().optional().describe('Default: supplier state ≠ store state'),
  reverse_charge: z
    .boolean()
    .default(false)
    .describe(
      'Reverse charge: the supplier is owed total − tax; the GST is the shop’s own liability (output tax)',
    ),
  itc_eligible: z
    .boolean()
    .default(true)
    .describe('Input tax credit; always false for composition / unregistered shops (tax → cost)'),
  other_charges_paise: zPaise.default(0),
  round_off_paise: z
    .int()
    .min(-99)
    .max(99)
    .nullable()
    .optional()
    .describe("Supplier's exact round-off; null/absent = automatic nearest rupee"),
  notes: z.string().trim().max(1000).optional(),
  attachment_file_id: zId.optional().describe('Photo / PDF of the supplier invoice (files API)'),
  lines: z.array(PurchaseBillLineInputSchema).min(1).max(500),
}

/**
 * POST /purchase-bills — a draft. Totals are computed server-side (purchaseBillTotals). A supplier
 * invoice number already used by the supplier in the FY → 409 DUPLICATE with
 * DuplicateSupplierInvoiceDetails.
 */
export const PurchaseBillCreateSchema = z.object({
  ...BillFields,
  client_ref: zIdempotencyKey.optional(),
})
export type PurchaseBillCreate = z.input<typeof PurchaseBillCreateSchema>

/** PATCH /purchase-bills/:id — draft only; `lines` replaces every line. */
export const PurchaseBillUpdateSchema = z
  .object({
    supplier_id: zId.optional(),
    purchase_order_id: zId.nullable().optional(),
    supplier_invoice_no: z
      .string()
      .trim()
      .min(1, 'supplier_invoice_no_required')
      .max(40)
      .optional(),
    supplier_invoice_date: zDateStr.optional(),
    received_date: zDateStr.optional(),
    due_date: zDateStr.nullable().optional(),
    is_interstate: z.boolean().optional(),
    reverse_charge: z.boolean().optional(),
    itc_eligible: z.boolean().optional(),
    other_charges_paise: zPaise.optional(),
    round_off_paise: z.int().min(-99).max(99).nullable().optional(),
    notes: zNullableText(1000),
    attachment_file_id: zId.nullable().optional(),
    lines: z.array(PurchaseBillLineInputSchema).min(1).max(500).optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at'), {
    message: 'empty_patch',
  })
export type PurchaseBillUpdate = z.input<typeof PurchaseBillUpdateSchema>

/** POST /purchase-bills/from-order/:orderId — a draft with the PO's pending quantities. */
export const PurchaseBillFromOrderSchema = z
  .object({
    supplier_invoice_no: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe("'' until entered; required to post"),
    supplier_invoice_date: zDateStr.optional(),
    received_date: zDateStr.optional(),
  })
  .prefault({})

/** POST /purchase-bills/:id/post */
export const PurchaseBillPostSchema = z
  .object({
    if_updated_at: zIfUpdatedAt,
    /** Apply MRP / sale price updates of the lines to products and batches (audited). */
    update_prices: z.boolean().default(true),
    /** Accept batches already expired (e.g. received for return). */
    allow_past_expiry: z.boolean().default(false),
  })
  .prefault({})
export type PurchaseBillPost = z.input<typeof PurchaseBillPostSchema>

/** POST /purchase-bills/:id/cancel — refused (409) while live payments are allocated to it. */
export const PurchaseBillCancelSchema = z.object({ reason: zReason })

/** details of the 409 DUPLICATE for a reused supplier invoice number. */
export const DuplicateSupplierInvoiceDetailsSchema = z.object({
  reason: z.literal('duplicate_supplier_invoice'),
  existing_bill_id: zId,
  existing_number: z.string().nullable(),
  existing_status: PurchaseBillStatusSchema,
})

export const PurchaseBillLineSchema = z.object({
  id: zId,
  line_no: z.int().min(1),
  product_id: zId,
  product: ProductRef,
  purchase_order_line_id: zId.nullable(),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  mfg_date: zDateStr.nullable(),
  expiry_date: zDateStr.nullable(),
  hsn_code: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zQtyMilli,
  free_qty_milli: zMilli0,
  mrp_paise: zPaise.nullable(),
  unit_cost_paise: zPaise,
  discount_bp: zBp,
  /** Flat discount as entered (with discount_bp); the line's total discount is gross − taxable. */
  discount_paise: zPaise,
  gross_paise: zPaise,
  ...TaxAmountFields,
  gst_rate_bp: z.int().min(0),
  cess_rate_bp: z.int().min(0),
  total_paise: zPaise,
  /** Per pack incl. free quantity dilution, other-charges share and non-ITC tax. */
  landed_unit_cost_paise: zPaise,
  sale_price_paise: zPaise.nullable(),
  returned_qty_milli: zMilli0,
  returnable_qty_milli: zMilli0,
  /** Product state now (grid warnings, margin %). */
  current: z.object({
    purchase_price_paise: zPaise,
    mrp_paise: zPaise.nullable(),
    sale_price_paise: zPaise,
    price_includes_tax: z.boolean(),
    gst_rate_bp: z.int().min(0),
    /** Unit cost of the latest posted bill line of the product (other bills). */
    last_cost_paise: zPaise.nullable(),
    stock_qty_milli: z.int().nullable(),
  }),
})
export type PurchaseBillLine = z.output<typeof PurchaseBillLineSchema>

export const PurchaseBillListRowSchema = z.object({
  id: zId,
  /** GRN number (assigned on posting). */
  number: z.string().nullable(),
  fy: z.string().nullable(),
  status: PurchaseBillStatusSchema,
  store_id: zId,
  supplier_id: zId,
  supplier_name: z.string(),
  supplier_invoice_no: z.string(),
  supplier_invoice_date: zDateStr,
  received_date: zDateStr,
  due_date: zDateStr.nullable(),
  purchase_order_id: zId.nullable(),
  purchase_order_number: z.string().nullable(),
  line_count: z.int().min(0),
  taxable_paise: zPaise,
  tax_paise: zPaise,
  total_paise: zPaise,
  paid_paise: zPaise,
  returned_paise: zPaise,
  due_paise: z.int(),
  payment_status: PurchasePaymentStatusSchema,
  /** due_paise > 0 and due_date < today. */
  overdue: z.boolean(),
  days_overdue: z.int().nullable(),
  posted_at: zTimestamp.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type PurchaseBillListRow = z.output<typeof PurchaseBillListRowSchema>

export const PurchaseBillDetailSchema = PurchaseBillListRowSchema.extend({
  supplier_gstin: z.string().nullable(),
  supplier_state_code: z.string().nullable(),
  is_interstate: z.boolean(),
  reverse_charge: z.boolean(),
  itc_eligible: z.boolean(),
  gross_paise: zPaise,
  discount_paise: zPaise,
  ...TaxAmountFields,
  other_charges_paise: zPaise,
  round_off_paise: z.int().min(-99).max(99),
  notes: z.string().nullable(),
  attachment_file_id: zId.nullable(),
  supplier: SupplierRef,
  lines: z.array(PurchaseBillLineSchema),
  tax_breakup: z.array(TaxBreakupRowSchema),
  purchase_order: z.object({ id: zId, number: z.string() }).nullable(),
  payments: z.array(PurchasePaymentRefSchema),
  debit_notes: z.array(
    z.object({
      id: zId,
      number: z.string(),
      note_date: zDateStr,
      status: DebitNoteStatusSchema,
      settlement: DebitNoteSettlementSchema,
      total_paise: zPaise,
    }),
  ),
  journal_entry_id: zId.nullable(),
  posted_by: zId.nullable(),
  posted_by_name: z.string().nullable(),
  cancelled_at: zTimestamp.nullable(),
  cancelled_by: zId.nullable(),
  cancelled_by_name: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  warnings: z.array(PurchaseWarningSchema),
})
export type PurchaseBillDetail = z.output<typeof PurchaseBillDetailSchema>

export const PriceUpdateSchema = z.object({
  product_id: zId,
  product_name: z.string(),
  batch_id: zId.nullable(),
  field: z.enum(['purchase_price_paise', 'mrp_paise', 'sale_price_paise']),
  old_paise: zPaise.nullable(),
  new_paise: zPaise,
})
export type PriceUpdate = z.output<typeof PriceUpdateSchema>

export const PurchaseBillPostResultSchema = z.object({
  bill: PurchaseBillDetailSchema,
  price_updates: z.array(PriceUpdateSchema),
  batches_created: z.int().min(0),
  /** Number of stock movements posted (one per stock-tracked line, charged + free quantity). */
  stock_lines: z.int().min(0),
})
export type PurchaseBillPostResult = z.output<typeof PurchaseBillPostResultSchema>

export const PurchaseBillListQuerySchema = PageQuerySchema.extend({
  /** GRN number, supplier invoice number or supplier name. */
  q: zSearchQuery.optional(),
  status: zQueryList(PurchaseBillStatusSchema).optional(),
  payment_status: zQueryList(PurchasePaymentStatusSchema).optional(),
  supplier_id: zId.optional(),
  store_id: zId.optional(),
  purchase_order_id: zId.optional(),
  overdue: zBooleanQuery.optional(),
  has_due: zBooleanQuery.optional(),
  /** Received date range. */
  ...DATE_RANGE_FIELDS,
  sort: sortQuery([
    'received_date',
    'supplier_invoice_date',
    'due_date',
    'number',
    'total_paise',
    'due_paise',
    'created_at',
  ]).prefault('-received_date'),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type PurchaseBillListQuery = z.input<typeof PurchaseBillListQuerySchema>

/**
 * `summary` covers the whole filtered range: count of every listed bill; total / paid of the
 * non-cancelled ones (cancelled bills count only when the status filter asks for them).
 */
export const PurchaseBillListResponseSchema = listOf(PurchaseBillListRowSchema).extend({
  summary: z.object({
    count: z.int(),
    total_paise: zPaise,
    paid_paise: zPaise,
    due_paise: z.int(),
    overdue_paise: z.int(),
  }),
})

// ---- returnable -------------------------------------------------------------------------------

export const BillReturnableLineSchema = z.object({
  bill_line_id: zId,
  line_no: z.int().min(1),
  product_id: zId,
  product: ProductRef,
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zQtyMilli,
  free_qty_milli: zMilli0,
  returned_qty_milli: zMilli0,
  /** charged + free − returned. */
  returnable_qty_milli: zMilli0,
  /** Stock of the batch / product at the bill's store now. */
  available_qty_milli: z.int().nullable(),
  unit_cost_paise: zPaise,
  landed_unit_cost_paise: zPaise,
  ...TaxAmountFields,
  gst_rate_bp: z.int().min(0),
  cess_rate_bp: z.int().min(0),
  total_paise: zPaise,
  /** Amounts already returned by live debit notes (input of prorateReturnLine). */
  credited: z.object(TaxAmountFields),
})

export const BillReturnableResponseSchema = z.object({
  bill: z.object({
    id: zId,
    number: z.string().nullable(),
    supplier_id: zId,
    supplier_name: z.string(),
    supplier_invoice_no: z.string(),
    received_date: zDateStr,
    status: PurchaseBillStatusSchema,
    is_interstate: z.boolean(),
    total_paise: zPaise,
    due_paise: z.int(),
  }),
  lines: z.array(BillReturnableLineSchema),
})
export type BillReturnableResponse = z.output<typeof BillReturnableResponseSchema>

// =============================================================================================
// Debit notes (purchase returns)
// =============================================================================================

/**
 * A debit note line: against a bill line (pro-rata amounts, prorateReturnLine over charged + free
 * quantity) or free-form (product + batch at a cost; e.g. expiry returns without the bill).
 */
export const DebitNoteLineInputSchema = z
  .object({
    bill_line_id: zId.optional(),
    product_id: zId.optional(),
    batch_id: zId.optional(),
    qty_milli: zQtyMilli,
    /** Free-form: cost per pack excluding tax (default: the batch's landed cost). */
    unit_cost_paise: zPaise.optional(),
    gst_rate_bp: zGstRateBp.optional(),
    cess_rate_bp: z.int().min(0).max(30_000).optional(),
  })
  .refine((l) => (l.bill_line_id === undefined) !== (l.product_id === undefined), {
    message: 'debit_note_line_ref_required',
    path: ['bill_line_id'],
  })

/**
 * POST /debit-notes. Stock leaves at the line's landed cost ('purchase_return'); journal Dr
 * payable (supplier) total, Cr inventory, Cr input taxes. Settlement adjust_due reduces the bill
 * due (the excess becomes a supplier advance); refund_cash / refund_bank record a receipt from
 * the supplier.
 */
export const DebitNoteCreateSchema = z
  .object({
    client_ref: zIdempotencyKey.optional(),
    bill_id: zId.optional(),
    /** Required without a bill. */
    supplier_id: zId.optional(),
    store_id: zId.optional(),
    note_date: zDateStr.optional(),
    reason: DebitNoteReasonSchema,
    settlement: DebitNoteSettlementSchema.default('adjust_due'),
    /** Free-form: default supplier state ≠ store state. */
    is_interstate: z.boolean().optional(),
    lines: z.array(DebitNoteLineInputSchema).min(1).max(500),
    /** refund_bank: the bank ledger account credited by the supplier. */
    account_id: zId.optional(),
    refund_reference: z.string().trim().max(100).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    const freeForm = v.lines.filter((l) => l.product_id !== undefined).length
    if (freeForm > 0 && freeForm < v.lines.length) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'debit_note_mixed_lines' })
    }
    if (freeForm === 0 && v.bill_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['bill_id'], message: 'debit_note_line_ref_required' })
    }
    if (v.bill_id === undefined && (v.supplier_id === undefined || v.store_id === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['supplier_id'], message: 'debit_note_party_required' })
    }
    const refs = v.lines.flatMap((l) => (l.bill_line_id ? [l.bill_line_id] : []))
    if (new Set(refs).size !== refs.length) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'duplicate_bill_line' })
    }
  })
export type DebitNoteCreate = z.input<typeof DebitNoteCreateSchema>

export const DebitNoteCancelSchema = z.object({ reason: zReason })

export const DebitNoteLineSchema = z.object({
  id: zId,
  line_no: z.int().min(1),
  bill_line_id: zId.nullable(),
  product_id: zId,
  product: ProductRef,
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  hsn_code: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zQtyMilli,
  unit_cost_paise: zPaise,
  ...TaxAmountFields,
  gst_rate_bp: z.int().min(0),
  cess_rate_bp: z.int().min(0),
  total_paise: zPaise,
})
export type DebitNoteLine = z.output<typeof DebitNoteLineSchema>

export const DebitNoteListRowSchema = z.object({
  id: zId,
  number: z.string(),
  fy: z.string(),
  note_date: zDateStr,
  store_id: zId,
  supplier_id: zId,
  supplier_name: z.string(),
  bill_id: zId.nullable(),
  bill_number: z.string().nullable(),
  supplier_invoice_no: z.string().nullable(),
  reason: DebitNoteReasonSchema,
  status: DebitNoteStatusSchema,
  settlement: DebitNoteSettlementSchema,
  total_paise: zPaise,
  line_count: z.int().min(0),
  created_at: zTimestamp,
})
export type DebitNoteListRow = z.output<typeof DebitNoteListRowSchema>

export const DebitNoteDetailSchema = DebitNoteListRowSchema.extend({
  is_interstate: z.boolean(),
  ...TaxAmountFields,
  tax_paise: zPaise,
  round_off_paise: z.int().min(-99).max(99),
  notes: z.string().nullable(),
  supplier: SupplierRef,
  lines: z.array(DebitNoteLineSchema),
  tax_breakup: z.array(TaxBreakupRowSchema),
  /** Refund receipts (refund_cash / refund_bank). */
  payments: z.array(PurchasePaymentRefSchema),
  journal_entry_id: zId.nullable(),
  /**
   * adjust_due: the part applied against the bill's due (bill returned_paise); the rest of the
   * note is the supplier's advance. 0 for refunds and free-form notes.
   */
  adjusted_paise: zPaise.default(0),
  /**
   * What the supplier's account moves by: the total, or total − tax for a return against a
   * reverse-charge bill (the supplier was never owed the GST). Refunds equal this amount.
   */
  supplier_amount_paise: zPaise,
  cancelled_at: zTimestamp.nullable(),
  cancelled_by: zId.nullable(),
  cancelled_by_name: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  updated_at: zTimestamp,
})
export type DebitNoteDetail = z.output<typeof DebitNoteDetailSchema>

export const DebitNoteListQuerySchema = PageQuerySchema.extend({
  /** Number, bill / supplier invoice number or supplier name. */
  q: zSearchQuery.optional(),
  status: zQueryList(DebitNoteStatusSchema).optional(),
  reason: zQueryList(DebitNoteReasonSchema).optional(),
  settlement: zQueryList(DebitNoteSettlementSchema).optional(),
  supplier_id: zId.optional(),
  store_id: zId.optional(),
  bill_id: zId.optional(),
  ...DATE_RANGE_FIELDS,
  sort: sortQuery(['note_date', 'number', 'total_paise', 'created_at']).prefault('-note_date'),
  format: zListFormat,
}).refine(dateOrderOk, DATE_ORDER_ISSUE)
export type DebitNoteListQuery = z.input<typeof DebitNoteListQuerySchema>

export const DebitNoteListResponseSchema = listOf(DebitNoteListRowSchema).extend({
  summary: z.object({ count: z.int(), total_paise: zPaise }),
})

/**
 * GET /debit-notes/prefill?batch_ids=…&store_id=&supplier_id= — free-form return lines for
 * batches (the inventory batches page links to /purchases/returns/new with
 * purchaseReturnPrefillPath(); the page passes its query on, adding the current store).
 */
export const DebitNotePrefillQuerySchema = z.object({
  /** Repeated keys or comma-separated. */
  batch_ids: zQueryIds,
  store_id: zId,
  supplier_id: zId.optional(),
})
export type DebitNotePrefillQuery = z.input<typeof DebitNotePrefillQuerySchema>

export const DebitNotePrefillSchema = z.object({
  /** The common supplier of the batches (null when they differ / unknown). */
  supplier: z.object({ id: zId, name: z.string() }).nullable(),
  lines: z.array(
    z.object({
      product_id: zId,
      product: ProductRef,
      batch_id: zId,
      batch_no: z.string(),
      expiry_date: zDateStr.nullable(),
      available_qty_milli: z.int(),
      /** Landed cost of the batch's latest posted bill line, else the batch purchase price. */
      unit_cost_paise: zPaise,
      gst_rate_bp: z.int().min(0),
      cess_rate_bp: z.int().min(0),
      supplier_id: zId.nullable(),
      supplier_name: z.string().nullable(),
      bill_id: zId.nullable(),
      bill_line_id: zId.nullable(),
      bill_number: z.string().nullable(),
      /** Returnable on that bill line (null without a bill line). */
      returnable_qty_milli: zMilli0.nullable(),
    }),
  ),
})
export type DebitNotePrefill = z.output<typeof DebitNotePrefillSchema>

// =============================================================================================
// Reorder suggestions
// =============================================================================================

export const ReorderSuggestionsQuerySchema = z.object({
  store_id: zId,
  supplier_id: zId.optional(),
  category_id: zId.optional(),
  q: zSearchQuery.optional(),
  /**
   * Only these products — included even above their reorder level (the PO form opened with
   * inventory's reorderPrefillPath(): /purchases/orders/new?source=reorder&product_ids=…).
   */
  product_ids: zQueryIds.optional(),
})
export type ReorderSuggestionsQuery = z.input<typeof ReorderSuggestionsQuerySchema>

export const ReorderItemSchema = z.object({
  product_id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  category_id: zId.nullable(),
  current_stock_milli: z.int(),
  reorder_level_milli: zMilli0,
  reorder_qty_milli: zMilli0.nullable(),
  /** Over the last REORDER_SALES_WINDOW_DAYS days (averageDailySalesMilli). */
  avg_daily_sales_milli: zMilli0,
  /** current stock ÷ average daily sales (null when nothing sold). */
  days_of_cover: z.int().nullable(),
  /** suggestedReorderQtyMilli. */
  suggested_qty_milli: zMilli0,
  /** Still pending on sent / partially received purchase orders (informational). */
  open_po_qty_milli: zMilli0,
  last_cost_paise: zPaise.nullable(),
  last_bill_date: zDateStr.nullable(),
  gst_rate_bp: z.int().min(0),
  /**
   * Cost per pack (excl. tax) of the estimate and the PO default: the last cost, else the
   * product's purchase price (never bought from a supplier, e.g. opening stock only).
   */
  unit_cost_paise: zPaise,
  /** suggested × unit_cost_paise (excl. tax). */
  estimated_cost_paise: zPaise,
})
export type ReorderItem = z.output<typeof ReorderItemSchema>

export const REORDER_SALES_WINDOW_DAYS = 30

export const ReorderSuggestionsSchema = z.object({
  store_id: zId,
  generated_at: zTimestamp,
  window_days: z.int().min(1),
  /** Grouped by the supplier of the latest posted bill line (null = never purchased). */
  groups: z.array(
    z.object({
      supplier: z.object({ id: zId, name: z.string(), phone: z.string().nullable() }).nullable(),
      items: z.array(ReorderItemSchema),
      estimated_cost_paise: zPaise,
    }),
  ),
})
export type ReorderSuggestions = z.output<typeof ReorderSuggestionsSchema>

// =============================================================================================
// Route catalogue (docs/API.md "purchases")
// =============================================================================================

const IdParams = z.object({ id: zId })
const READ = 'purchases.read' as const
const WRITE = 'purchases.write' as const

export const purchasesRoutes = defineRoutes({
  // ---- purchase orders ----
  listOrders: {
    method: 'GET',
    path: '/purchase-orders',
    permission: READ,
    feature: 'purchases',
    query: PurchaseOrderListQuerySchema,
    response: listOf(PurchaseOrderListRowSchema),
    summary: 'Purchase orders (?format=csv)',
  },
  createOrder: {
    method: 'POST',
    path: '/purchase-orders',
    permission: WRITE,
    feature: 'purchases',
    idempotent: true,
    body: PurchaseOrderCreateSchema,
    response: dataOf(PurchaseOrderDetailSchema),
    status: 201,
  },
  getOrder: {
    method: 'GET',
    path: '/purchase-orders/:id',
    permission: READ,
    feature: 'purchases',
    params: IdParams,
    response: dataOf(PurchaseOrderDetailSchema),
  },
  updateOrder: {
    method: 'PATCH',
    path: '/purchase-orders/:id',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: PurchaseOrderUpdateSchema,
    response: dataOf(PurchaseOrderDetailSchema),
    summary: 'Edit a draft purchase order',
  },
  deleteOrder: {
    method: 'DELETE',
    path: '/purchase-orders/:id',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    summary: 'Delete a draft purchase order (internal document; its number is not reused)',
  },
  sendOrder: {
    method: 'POST',
    path: '/purchase-orders/:id/send',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: PurchaseOrderSendSchema,
    response: dataOf(PurchaseOrderSendResultSchema),
    summary: 'Mark sent; optional WhatsApp / SMS to the supplier (template po_to_supplier)',
  },
  cancelOrder: {
    method: 'POST',
    path: '/purchase-orders/:id/cancel',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: PurchaseOrderStatusChangeSchema,
    response: dataOf(PurchaseOrderDetailSchema),
    summary: 'Cancel a draft / sent order (received goods → close instead, 409)',
  },
  closeOrder: {
    method: 'POST',
    path: '/purchase-orders/:id/close',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: PurchaseOrderStatusChangeSchema,
    response: dataOf(PurchaseOrderDetailSchema),
    summary: 'Close a sent / partially received order (no more receipts expected)',
  },

  // ---- purchase bills ----
  listBills: {
    method: 'GET',
    path: '/purchase-bills',
    permission: READ,
    feature: 'purchases',
    query: PurchaseBillListQuerySchema,
    response: PurchaseBillListResponseSchema,
    summary: 'Purchase bills with due highlighting and totals (?format=csv)',
  },
  createBill: {
    method: 'POST',
    path: '/purchase-bills',
    permission: WRITE,
    feature: 'purchases',
    idempotent: true,
    body: PurchaseBillCreateSchema,
    response: dataOf(PurchaseBillDetailSchema),
    status: 201,
    summary: 'Save a draft bill (totals & landed costs computed server-side)',
  },
  getBill: {
    method: 'GET',
    path: '/purchase-bills/:id',
    permission: READ,
    feature: 'purchases',
    params: IdParams,
    response: dataOf(PurchaseBillDetailSchema),
  },
  updateBill: {
    method: 'PATCH',
    path: '/purchase-bills/:id',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: PurchaseBillUpdateSchema,
    response: dataOf(PurchaseBillDetailSchema),
    summary: 'Edit a draft bill',
  },
  deleteBill: {
    method: 'DELETE',
    path: '/purchase-bills/:id',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    summary: 'Delete a draft bill (posted bills are cancelled instead → 409)',
  },
  postBill: {
    method: 'POST',
    path: '/purchase-bills/:id/post',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: PurchaseBillPostSchema,
    response: dataOf(PurchaseBillPostResultSchema),
    summary: 'Post: GRN number, batches, stock at landed cost, journal, price updates',
  },
  cancelBill: {
    method: 'POST',
    path: '/purchase-bills/:id/cancel',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: PurchaseBillCancelSchema,
    response: dataOf(PurchaseBillDetailSchema),
    summary: 'Cancel a posted bill (stock still available; no live payments → else 422 / 409)',
  },
  billFromOrder: {
    method: 'POST',
    path: '/purchase-bills/from-order/:orderId',
    permission: WRITE,
    feature: 'purchases',
    params: z.object({ orderId: zId }),
    body: PurchaseBillFromOrderSchema,
    response: dataOf(PurchaseBillDetailSchema),
    status: 201,
    summary: "Draft bill prefilled with a purchase order's pending quantities",
  },
  billReturnable: {
    method: 'GET',
    path: '/purchase-bills/:id/returnable',
    permission: READ,
    feature: 'purchases',
    params: IdParams,
    response: dataOf(BillReturnableResponseSchema),
  },

  // ---- debit notes ----
  listDebitNotes: {
    method: 'GET',
    path: '/debit-notes',
    permission: READ,
    feature: 'purchases',
    query: DebitNoteListQuerySchema,
    response: DebitNoteListResponseSchema,
    summary: 'Purchase returns (?format=csv)',
  },
  createDebitNote: {
    method: 'POST',
    path: '/debit-notes',
    permission: WRITE,
    feature: 'purchases',
    idempotent: true,
    body: DebitNoteCreateSchema,
    response: dataOf(DebitNoteDetailSchema),
    status: 201,
  },
  debitNotePrefill: {
    method: 'GET',
    path: '/debit-notes/prefill',
    permission: READ,
    feature: 'purchases',
    query: DebitNotePrefillQuerySchema,
    response: dataOf(DebitNotePrefillSchema),
    summary: 'Free-form return lines for batches (expiry returns from the batches page)',
  },
  getDebitNote: {
    method: 'GET',
    path: '/debit-notes/:id',
    permission: READ,
    feature: 'purchases',
    params: IdParams,
    response: dataOf(DebitNoteDetailSchema),
  },
  cancelDebitNote: {
    method: 'POST',
    path: '/debit-notes/:id/cancel',
    permission: WRITE,
    feature: 'purchases',
    params: IdParams,
    body: DebitNoteCancelSchema,
    response: dataOf(DebitNoteDetailSchema),
    summary: 'Cancel a debit note (stock, journal and settlement reversed)',
  },

  // ---- reorder ----
  reorderSuggestions: {
    method: 'GET',
    path: '/purchases/reorder-suggestions',
    permission: READ,
    feature: 'purchases',
    query: ReorderSuggestionsQuerySchema,
    response: dataOf(ReorderSuggestionsSchema),
    summary: 'Products at / below reorder level with suggested quantities, grouped by supplier',
  },
})
