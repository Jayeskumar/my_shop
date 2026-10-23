/**
 * State model of the purchase-bill entry screen (pure functions, unit-tested): draft header and
 * lines, the live totals (purchaseBillTotals — the same maths the server runs on save), grid
 * warnings (purchaseLineWarnings), client-side validation and the request bodies of
 * POST /purchase-bills and PATCH /purchase-bills/:id.
 *
 * Quantities are milli base units; prices are per pack of `pack_size` base units (pharmacy
 * strips: unit TAB, pack 10, MRP / rate per strip). The grid edits pack-priced products in packs.
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import type { PurchaseDocumentLineResult, PurchaseDocumentResult } from '@kadai/shared/pricing'
import {
  type PurchaseBillCreate,
  type PurchaseBillDetail,
  type PurchaseBillLine,
  type PurchaseBillLineInput,
  type PurchaseBillUpdate,
  type PurchaseWarning,
  type PurchasesValidationKey,
  marginBp,
  purchaseBillTotals,
  purchaseLineWarnings,
} from '@kadai/shared/api/purchases'
import { addDays, compareDates } from '@kadai/shared/fy'
import { isValidGstRate } from '@kadai/shared/gst'
import { newId } from '@kadai/shared/ids'
import { type ValidationKey, validationToken } from '@/lib/validation'
import { expiryInputText, parseExpiryText } from './expiry'

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** What the grid needs to know about a line's product (from the picker or the saved bill). */
export interface LineProduct {
  id: string
  name: string
  name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  hsn_code: string | null
  track_batches: boolean
  gst_rate_bp: number
  price_includes_tax: boolean
  mrp_paise: number | null
  sale_price_paise: number
  /** Product purchase price now (landed cost of the last receipt). */
  purchase_price_paise: number
  /** Supplier rate of the latest posted bill line (null = never bought / unknown). */
  last_cost_paise: number | null
  stock_qty_milli: number | null
}

export interface BillLineDraft {
  key: string
  product: LineProduct
  purchase_order_line_id: string | null
  batch_no: string
  /** Expiry cell text ('MM/YY', 'MM/YYYY' or dd-MM-yyyy). */
  expiry_text: string
  mfg_date: string | null
  mrp_paise: number | null
  qty_milli: number | null
  free_qty_milli: number | null
  /** Supplier rate per pack, excluding tax, before discount. */
  unit_cost_paise: number | null
  discount_bp: number | null
  /** Flat discount kept from a saved line (not edited in the grid). */
  discount_paise: number
  gst_rate_bp: number
  cess_rate_bp: number
  hsn_code: string | null
  /** New selling price per pack to apply on posting; null = keep the current price. */
  sale_price_paise: number | null
}

/** Supplier fields the editor uses (a SupplierListItem or the bill's supplier ref). */
export interface SupplierLite {
  id: string
  name: string
  phone: string | null
  gstin: string | null
  state_code: string | null
  payment_terms_days: number | null
  balance_paise: number
}

export interface BillHeaderDraft {
  supplier: SupplierLite | null
  store_id: string | null
  purchase_order: { id: string; number: string } | null
  supplier_invoice_no: string
  supplier_invoice_date: string | null
  received_date: string | null
  /** Used only when `due_date_manual`; otherwise invoice date + supplier terms. */
  due_date: string | null
  due_date_manual: boolean
  /** null = automatic (supplier state ≠ store state). */
  interstate_manual: boolean | null
  reverse_charge: boolean
  itc_eligible: boolean
  other_charges_paise: number | null
  /** null = automatic nearest-rupee round-off; else the supplier's exact round-off. */
  round_off_manual: number | null
  notes: string
  attachment_file_id: string | null
}

export interface BillDraft {
  header: BillHeaderDraft
  lines: BillLineDraft[]
}

export interface BillContext {
  /** State code of the receiving store. */
  store_state_code: string | null
  /** Composition / unregistered shops never take input tax credit. */
  itc_allowed: boolean
  today: string
  expiry_warning_days: number
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

export function productFromListItem(p: ProductListItem): LineProduct {
  return {
    id: p.id,
    name: p.name,
    name_ta: p.name_ta,
    sku: p.sku,
    unit: p.unit,
    pack_size: p.pack_size,
    hsn_code: p.hsn_code,
    track_batches: p.track_batches,
    gst_rate_bp: p.gst_rate_bp,
    price_includes_tax: p.price_includes_tax,
    mrp_paise: p.mrp_paise,
    sale_price_paise: p.sale_price_paise,
    purchase_price_paise: p.purchase_price_paise,
    last_cost_paise: p.purchase_price_paise > 0 ? p.purchase_price_paise : null,
    stock_qty_milli: p.stock_qty_milli,
  }
}

export function productFromBillLine(l: PurchaseBillLine): LineProduct {
  return {
    id: l.product_id,
    name: l.product.name,
    name_ta: l.product.name_ta,
    sku: l.product.sku,
    unit: l.unit,
    pack_size: l.pack_size,
    hsn_code: l.product.hsn_code,
    track_batches: l.product.track_batches,
    gst_rate_bp: l.current.gst_rate_bp,
    price_includes_tax: l.current.price_includes_tax,
    mrp_paise: l.current.mrp_paise,
    sale_price_paise: l.current.sale_price_paise,
    purchase_price_paise: l.current.purchase_price_paise,
    last_cost_paise: l.current.last_cost_paise,
    stock_qty_milli: l.current.stock_qty_milli,
  }
}

/** A new grid row for a picked product: rate = last purchase price, MRP and GST from the product. */
export function lineFromProduct(product: LineProduct): BillLineDraft {
  return {
    key: newId(),
    product,
    purchase_order_line_id: null,
    batch_no: '',
    expiry_text: '',
    mfg_date: null,
    mrp_paise: product.mrp_paise,
    qty_milli: null,
    free_qty_milli: null,
    unit_cost_paise: product.purchase_price_paise > 0 ? product.purchase_price_paise : null,
    discount_bp: null,
    discount_paise: 0,
    gst_rate_bp: product.gst_rate_bp,
    cess_rate_bp: 0,
    hsn_code: product.hsn_code,
    sale_price_paise: null,
  }
}

export function lineFromBillLine(l: PurchaseBillLine): BillLineDraft {
  return {
    key: l.id,
    product: productFromBillLine(l),
    purchase_order_line_id: l.purchase_order_line_id,
    batch_no: l.batch_no ?? '',
    expiry_text: expiryInputText(l.expiry_date),
    mfg_date: l.mfg_date,
    mrp_paise: l.mrp_paise,
    qty_milli: l.qty_milli,
    free_qty_milli: l.free_qty_milli > 0 ? l.free_qty_milli : null,
    unit_cost_paise: l.unit_cost_paise,
    discount_bp: l.discount_bp > 0 ? l.discount_bp : null,
    discount_paise: l.discount_paise,
    gst_rate_bp: l.gst_rate_bp,
    cess_rate_bp: l.cess_rate_bp,
    hsn_code: l.hsn_code,
    sale_price_paise: l.sale_price_paise,
  }
}

export function emptyHeader(opts: {
  store_id: string | null
  today: string
  itc_allowed: boolean
}): BillHeaderDraft {
  return {
    supplier: null,
    store_id: opts.store_id,
    purchase_order: null,
    supplier_invoice_no: '',
    supplier_invoice_date: opts.today,
    received_date: opts.today,
    due_date: null,
    due_date_manual: false,
    interstate_manual: null,
    reverse_charge: false,
    itc_eligible: opts.itc_allowed,
    other_charges_paise: null,
    round_off_manual: null,
    notes: '',
    attachment_file_id: null,
  }
}

/** Editor state of a saved draft. */
export function draftFromBill(
  bill: PurchaseBillDetail,
  ctx: Pick<BillContext, 'store_state_code'>,
): BillDraft {
  const autoInterstate = isInterstateAuto(bill.supplier.state_code, ctx.store_state_code)
  return {
    header: {
      supplier: bill.supplier,
      store_id: bill.store_id,
      purchase_order: bill.purchase_order,
      supplier_invoice_no: bill.supplier_invoice_no,
      supplier_invoice_date: bill.supplier_invoice_date,
      received_date: bill.received_date,
      due_date: bill.due_date,
      due_date_manual: bill.due_date !== null,
      // A saved flag that differs from the automatic one was an explicit choice.
      interstate_manual: bill.is_interstate === autoInterstate ? null : bill.is_interstate,
      reverse_charge: bill.reverse_charge,
      itc_eligible: bill.itc_eligible,
      other_charges_paise: bill.other_charges_paise > 0 ? bill.other_charges_paise : null,
      round_off_manual: null,
      notes: bill.notes ?? '',
      attachment_file_id: bill.attachment_file_id,
    },
    lines: bill.lines.map(lineFromBillLine),
  }
}

/**
 * Keeps the supplier's exact round-off of a saved draft when it differs from the automatic one
 * (computed with the saved lines).
 */
export function savedRoundOff(
  bill: PurchaseBillDetail,
  draft: BillDraft,
  ctx: BillContext,
): number | null {
  const auto = computeBill({ ...draft, header: { ...draft.header, round_off_manual: null } }, ctx)
  if (!auto.doc) return null
  return auto.doc.round_off_paise === bill.round_off_paise ? null : bill.round_off_paise
}

// ---------------------------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------------------------

/** Interstate when both states are known and differ (GST: IGST instead of CGST + SGST). */
export function isInterstateAuto(
  supplierState: string | null | undefined,
  storeState: string | null | undefined,
): boolean {
  if (!supplierState || !storeState) return false
  return supplierState !== storeState
}

export function effectiveInterstate(header: BillHeaderDraft, ctx: BillContext): boolean {
  return (
    header.interstate_manual ??
    isInterstateAuto(header.supplier?.state_code ?? null, ctx.store_state_code)
  )
}

/** Due date: entered, else supplier invoice date + the supplier's payment terms (null = none). */
export function effectiveDueDate(header: BillHeaderDraft): string | null {
  if (header.due_date_manual) return header.due_date
  const terms = header.supplier?.payment_terms_days
  if (!header.supplier_invoice_date || terms === null || terms === undefined) return null
  return addDays(header.supplier_invoice_date, terms)
}

export function lineComputable(l: BillLineDraft): boolean {
  return (
    l.qty_milli !== null &&
    l.qty_milli > 0 &&
    l.unit_cost_paise !== null &&
    l.unit_cost_paise >= 0 &&
    (l.discount_bp ?? 0) <= 10_000
  )
}

export interface BillComputation {
  doc: PurchaseDocumentResult | null
  byKey: Map<string, PurchaseDocumentLineResult>
  is_interstate: boolean
  itc_eligible: boolean
}

/** Live totals of the grid (only complete lines count). */
export function computeBill(draft: BillDraft, ctx: BillContext): BillComputation {
  const is_interstate = effectiveInterstate(draft.header, ctx)
  const itc_eligible = ctx.itc_allowed && draft.header.itc_eligible
  const lines = draft.lines.filter(lineComputable)
  const byKey = new Map<string, PurchaseDocumentLineResult>()
  if (lines.length === 0) return { doc: null, byKey, is_interstate, itc_eligible }
  try {
    const doc = purchaseBillTotals({
      lines: lines.map((l) => ({
        key: l.key,
        unit_cost_paise: l.unit_cost_paise ?? 0,
        qty_milli: l.qty_milli ?? 0,
        free_qty_milli: l.free_qty_milli ?? 0,
        pack_size: l.product.pack_size,
        discount_bp: l.discount_bp ?? 0,
        discount_paise: l.discount_paise,
        gst_rate_bp: l.gst_rate_bp,
        cess_rate_bp: l.cess_rate_bp,
      })),
      is_interstate,
      other_charges_paise: draft.header.other_charges_paise ?? 0,
      itc_eligible,
      round_off_paise: draft.header.round_off_manual,
    })
    doc.lines.forEach((r, i) => byKey.set(lines[i]!.key, r))
    return { doc, byKey, is_interstate, itc_eligible }
  } catch {
    return { doc: null, byKey, is_interstate, itc_eligible }
  }
}

/** Expiry date of a line ('YYYY-MM-DD'), null when empty or not parseable. */
export function lineExpiry(l: BillLineDraft): string | null {
  const parsed = parseExpiryText(l.expiry_text)
  return parsed.kind === 'ok' ? parsed.date : null
}

/** Grid warnings of a line (cost above last, MRP changed, near expiry, margin, GST rate). */
export function lineWarnings(
  l: BillLineDraft,
  index: number,
  calc: BillComputation,
  ctx: BillContext,
): PurchaseWarning[] {
  const result = calc.byKey.get(l.key)
  if (l.unit_cost_paise === null) return []
  return purchaseLineWarnings(
    {
      line_no: index + 1,
      product_id: l.product.id,
      unit_cost_paise: l.unit_cost_paise,
      mrp_paise: l.mrp_paise,
      expiry_date: lineExpiry(l),
      gst_rate_bp: l.gst_rate_bp,
      landed_unit_cost_paise: result?.landed_unit_cost_paise ?? l.unit_cost_paise,
      sale_price_paise: l.sale_price_paise,
    },
    {
      last_cost_paise: l.product.last_cost_paise,
      mrp_paise: l.product.mrp_paise,
      gst_rate_bp: l.product.gst_rate_bp,
      price_includes_tax: l.product.price_includes_tax,
      cess_rate_bp: l.cess_rate_bp,
    },
    { today: ctx.today, expiry_warning_days: ctx.expiry_warning_days },
  )
}

/**
 * Margin of the line's selling price (the new one, else the current one) over its landed cost,
 * in bp of the net selling price; null when unknown.
 */
export function lineMarginBp(l: BillLineDraft, calc: BillComputation): number | null {
  const result = calc.byKey.get(l.key)
  if (!result) return null
  const sale = l.sale_price_paise ?? l.product.sale_price_paise
  if (sale <= 0) return null
  return marginBp({
    sale_price_paise: sale,
    price_includes_tax: l.product.price_includes_tax,
    gst_rate_bp: l.gst_rate_bp,
    cess_rate_bp: l.cess_rate_bp,
    cost_paise: result.landed_unit_cost_paise,
  })
}

/** Price changes posting will apply (purchase price always; MRP / selling price when chosen). */
export interface PlannedPriceChange {
  key: string
  product: LineProduct
  field: 'purchase_price_paise' | 'mrp_paise' | 'sale_price_paise'
  old_paise: number | null
  new_paise: number
}

export function plannedPriceChanges(draft: BillDraft, calc: BillComputation): PlannedPriceChange[] {
  const out: PlannedPriceChange[] = []
  for (const l of draft.lines) {
    const result = calc.byKey.get(l.key)
    if (result && result.landed_unit_cost_paise !== l.product.purchase_price_paise) {
      out.push({
        key: l.key,
        product: l.product,
        field: 'purchase_price_paise',
        old_paise: l.product.purchase_price_paise,
        new_paise: result.landed_unit_cost_paise,
      })
    }
    if (l.mrp_paise !== null && l.mrp_paise !== l.product.mrp_paise) {
      out.push({
        key: l.key,
        product: l.product,
        field: 'mrp_paise',
        old_paise: l.product.mrp_paise,
        new_paise: l.mrp_paise,
      })
    }
    if (l.sale_price_paise !== null && l.sale_price_paise !== l.product.sale_price_paise) {
      out.push({
        key: l.key,
        product: l.product,
        field: 'sale_price_paise',
        old_paise: l.product.sale_price_paise,
        new_paise: l.sale_price_paise,
      })
    }
  }
  return out
}

/** Stock posting brings in: charged + free quantity per line. */
export function receivedQtyMilli(l: BillLineDraft): number {
  return (l.qty_milli ?? 0) + (l.free_qty_milli ?? 0)
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export type HeaderField =
  | 'supplier'
  | 'store'
  | 'supplier_invoice_no'
  | 'supplier_invoice_date'
  | 'received_date'
  | 'due_date'
  | 'round_off'
  | 'lines'

export type LineField =
  'qty' | 'free' | 'unit_cost' | 'discount' | 'batch_no' | 'expiry' | 'mrp' | 'sale_price'

/** Messages are purchases validation keys or shared validation tokens (validationText()). */
export interface BillErrors {
  header: Partial<Record<HeaderField, string>>
  lines: Record<string, Partial<Record<LineField, string>>>
}

const token = (key: ValidationKey): string => validationToken(key)
const key = (k: PurchasesValidationKey): string => k

export function hasErrors(errors: BillErrors): boolean {
  return (
    Object.keys(errors.header).length > 0 ||
    Object.values(errors.lines).some((e) => Object.keys(e).length > 0)
  )
}

/**
 * Checks the draft before saving / posting. Posting additionally needs the supplier invoice
 * number (drafts made from a purchase order may still lack it).
 */
export function validateBill(
  draft: BillDraft,
  ctx: BillContext,
  purpose: 'save' | 'post',
): BillErrors {
  const { header } = draft
  const errors: BillErrors = { header: {}, lines: {} }
  if (!header.supplier) errors.header.supplier = token('required')
  if (!header.store_id) errors.header.store = token('required')
  if (!header.supplier_invoice_no.trim()) {
    if (purpose === 'post' || !header.purchase_order) {
      errors.header.supplier_invoice_no = key('supplier_invoice_no_required')
    }
  }
  if (!header.supplier_invoice_date) errors.header.supplier_invoice_date = token('required')
  else if (compareDates(header.supplier_invoice_date, ctx.today) > 0) {
    errors.header.supplier_invoice_date = key('future_date')
  }
  if (!header.received_date) errors.header.received_date = token('required')
  else if (compareDates(header.received_date, ctx.today) > 0) {
    errors.header.received_date = key('future_date')
  } else if (
    header.supplier_invoice_date &&
    compareDates(header.received_date, header.supplier_invoice_date) < 0
  ) {
    errors.header.received_date = key('date_order')
  }
  const due = effectiveDueDate(header)
  if (header.due_date_manual && due && header.supplier_invoice_date) {
    if (compareDates(due, header.supplier_invoice_date) < 0)
      errors.header.due_date = key('date_order')
  }
  if (header.round_off_manual !== null && Math.abs(header.round_off_manual) > 99) {
    errors.header.round_off = token('invalid')
  }
  if (draft.lines.length === 0) errors.header.lines = token('select')

  for (const l of draft.lines) {
    const e: Partial<Record<LineField, string>> = {}
    if (l.qty_milli === null || l.qty_milli <= 0) e.qty = token('qty')
    if (l.unit_cost_paise === null) e.unit_cost = token('amount')
    if ((l.discount_bp ?? 0) > 10_000) e.discount = token('invalid')
    const expiry = parseExpiryText(l.expiry_text)
    if (l.product.track_batches) {
      if (!l.batch_no.trim()) e.batch_no = key('batch_no_required')
      if (expiry.kind === 'empty') e.expiry = key('expiry_required')
    }
    if (expiry.kind === 'invalid') e.expiry = key('expiry_format')
    else if (expiry.kind === 'ok' && l.mfg_date && compareDates(expiry.date, l.mfg_date) < 0) {
      e.expiry = key('expiry_before_mfg')
    }
    if (Object.keys(e).length) errors.lines[l.key] = e
  }
  return errors
}

/** Server issue path ("lines.2.batch_no", "supplier_invoice_no") → editor field. */
export function mapServerIssue(
  path: string,
  draft: BillDraft,
): { line?: string; field: HeaderField | LineField } | null {
  const parts = path.split('.')
  if (parts[0] === 'lines' && parts.length >= 3) {
    const line = draft.lines[Number(parts[1])]
    if (!line) return { field: 'lines' }
    const map: Record<string, LineField> = {
      qty_milli: 'qty',
      free_qty_milli: 'free',
      unit_cost_paise: 'unit_cost',
      discount_bp: 'discount',
      discount_paise: 'discount',
      batch_no: 'batch_no',
      expiry_date: 'expiry',
      mfg_date: 'expiry',
      mrp_paise: 'mrp',
      sale_price_paise: 'sale_price',
    }
    const field = map[parts[2]!]
    return field ? { line: line.key, field } : null
  }
  const header: Record<string, HeaderField> = {
    supplier_id: 'supplier',
    store_id: 'store',
    supplier_invoice_no: 'supplier_invoice_no',
    supplier_invoice_date: 'supplier_invoice_date',
    received_date: 'received_date',
    due_date: 'due_date',
    round_off_paise: 'round_off',
    lines: 'lines',
  }
  const field = header[parts[0] ?? '']
  return field ? { field } : null
}

// ---------------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------------

export function toLineInput(l: BillLineDraft): PurchaseBillLineInput {
  const expiry = lineExpiry(l)
  const input: PurchaseBillLineInput = {
    product_id: l.product.id,
    qty_milli: l.qty_milli ?? 0,
    unit_cost_paise: l.unit_cost_paise ?? 0,
  }
  // The grid only offers valid slab rates; an unknown saved rate falls back to the product's.
  if (isValidGstRate(l.gst_rate_bp)) input.gst_rate_bp = l.gst_rate_bp
  if (l.purchase_order_line_id) input.purchase_order_line_id = l.purchase_order_line_id
  if (l.product.track_batches) {
    if (l.batch_no.trim()) input.batch_no = l.batch_no.trim()
    if (expiry) input.expiry_date = expiry
    if (l.mfg_date) input.mfg_date = l.mfg_date
  }
  if (l.mrp_paise !== null) input.mrp_paise = l.mrp_paise
  if (l.free_qty_milli) input.free_qty_milli = l.free_qty_milli
  if (l.discount_bp) input.discount_bp = l.discount_bp
  if (l.discount_paise) input.discount_paise = l.discount_paise
  if (l.cess_rate_bp) input.cess_rate_bp = l.cess_rate_bp
  if (l.hsn_code) input.hsn_code = l.hsn_code
  if (l.sale_price_paise !== null) input.sale_price_paise = l.sale_price_paise
  return input
}

export function toCreateBody(
  draft: BillDraft,
  ctx: BillContext,
  clientRef: string,
): PurchaseBillCreate {
  const { header } = draft
  const body: PurchaseBillCreate = {
    supplier_id: header.supplier?.id ?? '',
    store_id: header.store_id ?? '',
    supplier_invoice_no: header.supplier_invoice_no.trim(),
    supplier_invoice_date: header.supplier_invoice_date ?? ctx.today,
    received_date: header.received_date ?? ctx.today,
    is_interstate: effectiveInterstate(header, ctx),
    reverse_charge: header.reverse_charge,
    itc_eligible: ctx.itc_allowed && header.itc_eligible,
    other_charges_paise: header.other_charges_paise ?? 0,
    round_off_paise: header.round_off_manual,
    lines: draft.lines.map(toLineInput),
    client_ref: clientRef,
  }
  const due = effectiveDueDate(header)
  if (due) body.due_date = due
  if (header.purchase_order) body.purchase_order_id = header.purchase_order.id
  if (header.notes.trim()) body.notes = header.notes.trim()
  if (header.attachment_file_id) body.attachment_file_id = header.attachment_file_id
  return body
}

export function toUpdateBody(
  draft: BillDraft,
  ctx: BillContext,
  bill: Pick<PurchaseBillDetail, 'updated_at'>,
): PurchaseBillUpdate {
  const { header } = draft
  const body: PurchaseBillUpdate = {
    received_date: header.received_date ?? ctx.today,
    is_interstate: effectiveInterstate(header, ctx),
    reverse_charge: header.reverse_charge,
    itc_eligible: ctx.itc_allowed && header.itc_eligible,
    other_charges_paise: header.other_charges_paise ?? 0,
    round_off_paise: header.round_off_manual,
    notes: header.notes.trim() || null,
    attachment_file_id: header.attachment_file_id,
    lines: draft.lines.map(toLineInput),
    if_updated_at: bill.updated_at,
  }
  if (header.supplier) body.supplier_id = header.supplier.id
  if (header.supplier_invoice_no.trim())
    body.supplier_invoice_no = header.supplier_invoice_no.trim()
  if (header.supplier_invoice_date) body.supplier_invoice_date = header.supplier_invoice_date
  const due = effectiveDueDate(header)
  if (due) body.due_date = due
  else if (header.due_date_manual) body.due_date = null
  return body
}

// ---------------------------------------------------------------------------------------------
// Pack quantities (pharmacy strips)
// ---------------------------------------------------------------------------------------------

/** Base-unit milli → packs × 1000 (the grid edits pack-priced products in packs). */
export function toPackMilli(qtyMilli: number | null, packSize: number): number | null {
  if (qtyMilli === null) return null
  return packSize > 1 ? Math.round(qtyMilli / packSize) : qtyMilli
}

/** Packs × 1000 → base-unit milli. */
export function fromPackMilli(packMilli: number | null, packSize: number): number | null {
  if (packMilli === null) return null
  return packSize > 1 ? packMilli * packSize : packMilli
}
