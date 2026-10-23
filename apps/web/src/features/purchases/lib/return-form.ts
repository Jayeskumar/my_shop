/**
 * State model of the purchase-return (debit note) editor — pure functions, unit-tested.
 *
 *  - Against a bill: the bill's returnable lines; each line returns up to charged + free −
 *    already returned. Amounts are pro-rata of the bill line (prorateReturnLine — the same
 *    function the server uses, so the preview equals the saved note).
 *  - Free-form (no bill; e.g. pharmacy expiry returns from the batches page): product + batch at
 *    a cost per pack (computePurchaseLine with the supplier/store interstate flag).
 *
 * Quantities are milli base units; costs are per pack excluding tax.
 */
import type {
  BillReturnableResponse,
  DebitNoteCreate,
  DebitNotePrefill,
  PurchasesValidationKey,
} from '@kadai/shared/api/purchases'
import type { DebitNoteReason, DebitNoteSettlement } from '@kadai/shared'
import { prorateReturnLine } from '@kadai/shared/api/sales'
import { isValidGstRate } from '@kadai/shared/gst'
import { newId } from '@kadai/shared/ids'
import { computePurchaseLine } from '@kadai/shared/pricing'
import { type ValidationKey, validationToken } from '@/lib/validation'

export type ReturnableLine = BillReturnableResponse['lines'][number]

export interface ReturnAmounts {
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  total_paise: number
}

/** A returnable bill line and the quantity being returned (null / 0 = not returned). */
export interface BillReturnLineDraft {
  line: ReturnableLine
  qty_milli: number | null
}

export interface FreeReturnProduct {
  id: string
  name: string
  name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  track_batches: boolean
  gst_rate_bp: number
}

export interface FreeReturnLineDraft {
  key: string
  product: FreeReturnProduct
  batch_id: string | null
  batch_no: string | null
  expiry_date: string | null
  /** Stock of the batch / product in the store (null = unknown). */
  available_qty_milli: number | null
  qty_milli: number | null
  /** Per pack excluding tax (landed cost of the batch by default). */
  unit_cost_paise: number | null
  gst_rate_bp: number
  cess_rate_bp: number
  /** Where the batch came from (prefill), for the hint under the line. */
  bill_number: string | null
}

export interface ReturnHeaderDraft {
  supplier: { id: string; name: string; state_code: string | null } | null
  store_id: string | null
  note_date: string | null
  reason: DebitNoteReason
  settlement: DebitNoteSettlement
  account_id: string | null
  refund_reference: string
  notes: string
}

export type ReturnDraft =
  | {
      mode: 'bill'
      header: ReturnHeaderDraft
      bill: BillReturnableResponse['bill']
      lines: BillReturnLineDraft[]
    }
  | { mode: 'free'; header: ReturnHeaderDraft; lines: FreeReturnLineDraft[] }

export function emptyReturnHeader(opts: {
  store_id: string | null
  today: string
  reason?: DebitNoteReason
}): ReturnHeaderDraft {
  return {
    supplier: null,
    store_id: opts.store_id,
    note_date: opts.today,
    reason: opts.reason ?? 'return',
    settlement: 'adjust_due',
    account_id: null,
    refund_reference: '',
    notes: '',
  }
}

/** Bill mode: every returnable line, nothing selected yet. */
export function billReturnDraft(
  data: BillReturnableResponse,
  header: ReturnHeaderDraft,
): ReturnDraft {
  return {
    mode: 'bill',
    header: {
      ...header,
      supplier: { id: data.bill.supplier_id, name: data.bill.supplier_name, state_code: null },
    },
    bill: data.bill,
    lines: data.lines.map((line) => ({ line, qty_milli: null })),
  }
}

/** Free-form lines from the batches-page prefill (whole available stock of each batch). */
export function freeLinesFromPrefill(prefill: DebitNotePrefill): FreeReturnLineDraft[] {
  return prefill.lines.map((l) => ({
    key: newId(),
    product: {
      id: l.product_id,
      name: l.product.name,
      name_ta: l.product.name_ta,
      sku: l.product.sku,
      unit: l.product.unit,
      pack_size: l.product.pack_size,
      track_batches: l.product.track_batches,
      gst_rate_bp: l.gst_rate_bp,
    },
    batch_id: l.batch_id,
    batch_no: l.batch_no,
    expiry_date: l.expiry_date,
    available_qty_milli: l.available_qty_milli,
    qty_milli: l.available_qty_milli > 0 ? l.available_qty_milli : null,
    unit_cost_paise: l.unit_cost_paise > 0 ? l.unit_cost_paise : null,
    gst_rate_bp: l.gst_rate_bp,
    cess_rate_bp: l.cess_rate_bp,
    bill_number: l.bill_number,
  }))
}

export function freeLineFromProduct(
  product: FreeReturnProduct & { purchase_price_paise: number; stock_qty_milli: number | null },
): FreeReturnLineDraft {
  return {
    key: newId(),
    product,
    batch_id: null,
    batch_no: null,
    expiry_date: null,
    available_qty_milli: product.track_batches ? null : product.stock_qty_milli,
    qty_milli: null,
    unit_cost_paise: product.purchase_price_paise > 0 ? product.purchase_price_paise : null,
    gst_rate_bp: product.gst_rate_bp,
    cess_rate_bp: 0,
    bill_number: null,
  }
}

// ---------------------------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------------------------

const ZERO: ReturnAmounts = {
  taxable_paise: 0,
  cgst_paise: 0,
  sgst_paise: 0,
  igst_paise: 0,
  cess_paise: 0,
  total_paise: 0,
}

/** Pro-rata amounts of returning `qty` of a bill line (null when the quantity is not valid). */
export function billLineAmounts(line: ReturnableLine, qty: number | null): ReturnAmounts | null {
  if (qty === null || qty <= 0 || qty > line.returnable_qty_milli) return null
  try {
    return prorateReturnLine(
      {
        taxable_paise: line.taxable_paise,
        cgst_paise: line.cgst_paise,
        sgst_paise: line.sgst_paise,
        igst_paise: line.igst_paise,
        cess_paise: line.cess_paise,
      },
      {
        qty_milli: qty,
        total_qty_milli: line.qty_milli + line.free_qty_milli,
        returned_qty_milli: line.returned_qty_milli,
        credited: line.credited,
      },
    )
  } catch {
    return null
  }
}

export function freeLineAmounts(l: FreeReturnLineDraft, interstate: boolean): ReturnAmounts | null {
  if (l.qty_milli === null || l.qty_milli <= 0 || l.unit_cost_paise === null) return null
  try {
    const r = computePurchaseLine({
      unit_cost_paise: l.unit_cost_paise,
      qty_milli: l.qty_milli,
      pack_size: l.product.pack_size,
      gst_rate_bp: l.gst_rate_bp,
      cess_rate_bp: l.cess_rate_bp,
      is_interstate: interstate,
    })
    return {
      taxable_paise: r.taxable_paise,
      cgst_paise: r.cgst_paise,
      sgst_paise: r.sgst_paise,
      igst_paise: r.igst_paise,
      cess_paise: r.cess_paise,
      total_paise: r.total_paise,
    }
  } catch {
    return null
  }
}

export interface ReturnTotals extends ReturnAmounts {
  tax_paise: number
  line_count: number
  byKey: Map<string, ReturnAmounts>
}

/** Interstate of the note: the bill's for bill returns, else supplier state ≠ store state. */
export function returnInterstate(
  draft: ReturnDraft,
  supplierState: string | null,
  storeState: string | null,
): boolean {
  if (draft.mode === 'bill') return draft.bill.is_interstate
  if (!supplierState || !storeState) return false
  return supplierState !== storeState
}

export function computeReturn(draft: ReturnDraft, interstate: boolean): ReturnTotals {
  const byKey = new Map<string, ReturnAmounts>()
  const add = (a: ReturnAmounts, b: ReturnAmounts): ReturnAmounts => ({
    taxable_paise: a.taxable_paise + b.taxable_paise,
    cgst_paise: a.cgst_paise + b.cgst_paise,
    sgst_paise: a.sgst_paise + b.sgst_paise,
    igst_paise: a.igst_paise + b.igst_paise,
    cess_paise: a.cess_paise + b.cess_paise,
    total_paise: a.total_paise + b.total_paise,
  })
  let sum = ZERO
  if (draft.mode === 'bill') {
    for (const l of draft.lines) {
      const a = billLineAmounts(l.line, l.qty_milli)
      if (!a) continue
      byKey.set(l.line.bill_line_id, a)
      sum = add(sum, a)
    }
  } else {
    for (const l of draft.lines) {
      const a = freeLineAmounts(l, interstate)
      if (!a) continue
      byKey.set(l.key, a)
      sum = add(sum, a)
    }
  }
  return {
    ...sum,
    tax_paise: sum.cgst_paise + sum.sgst_paise + sum.igst_paise + sum.cess_paise,
    line_count: byKey.size,
    byKey,
  }
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export type ReturnHeaderField = 'supplier' | 'store' | 'note_date' | 'lines' | 'account'
export type ReturnLineField = 'qty' | 'batch' | 'unit_cost'

export interface ReturnErrors {
  header: Partial<Record<ReturnHeaderField, string>>
  lines: Record<string, Partial<Record<ReturnLineField, string>>>
}

/** Line error: more than can be returned (purchases:returns.*). */
export const QTY_ABOVE_RETURNABLE = 'qty_above_returnable'

const token = (key: ValidationKey): string => validationToken(key)
const key = (k: PurchasesValidationKey): string => k

export function hasReturnErrors(errors: ReturnErrors): boolean {
  return (
    Object.keys(errors.header).length > 0 ||
    Object.values(errors.lines).some((e) => Object.keys(e).length > 0)
  )
}

export function validateReturn(draft: ReturnDraft, today: string): ReturnErrors {
  const errors: ReturnErrors = { header: {}, lines: {} }
  const { header } = draft
  if (!header.supplier) errors.header.supplier = key('debit_note_party_required')
  if (!header.store_id) errors.header.store = token('required')
  if (!header.note_date) errors.header.note_date = token('required')
  else if (header.note_date > today) errors.header.note_date = key('future_date')
  if (draft.mode === 'bill') {
    const chosen = draft.lines.filter((l) => (l.qty_milli ?? 0) > 0)
    if (chosen.length === 0) errors.header.lines = token('select')
    for (const l of chosen) {
      if ((l.qty_milli ?? 0) > l.line.returnable_qty_milli) {
        errors.lines[l.line.bill_line_id] = { qty: QTY_ABOVE_RETURNABLE }
      }
    }
  } else {
    if (draft.lines.length === 0) errors.header.lines = token('select')
    const seen = new Set<string>()
    for (const l of draft.lines) {
      const e: Partial<Record<ReturnLineField, string>> = {}
      if (l.qty_milli === null || l.qty_milli <= 0) e.qty = token('qty')
      else if (l.available_qty_milli !== null && l.qty_milli > l.available_qty_milli) {
        e.qty = QTY_ABOVE_RETURNABLE
      }
      if (l.product.track_batches && !l.batch_id) e.batch = key('batch_no_required')
      const ident = `${l.product.id}:${l.batch_id ?? ''}`
      if (seen.has(ident)) e.batch = key('duplicate_line_product')
      seen.add(ident)
      if (l.unit_cost_paise === null || l.unit_cost_paise <= 0) {
        e.unit_cost = key('debit_note_free_form_cost_required')
      }
      if (Object.keys(e).length) errors.lines[l.key] = e
    }
  }
  return errors
}

// ---------------------------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------------------------

export function toDebitNoteBody(
  draft: ReturnDraft,
  opts: { client_ref: string; interstate: boolean },
): DebitNoteCreate {
  const { header } = draft
  const base: DebitNoteCreate = {
    client_ref: opts.client_ref,
    reason: header.reason,
    settlement: header.settlement,
    lines: [],
  }
  if (header.note_date) base.note_date = header.note_date
  if (header.notes.trim()) base.notes = header.notes.trim()
  if (header.settlement === 'refund_bank' && header.account_id) base.account_id = header.account_id
  if (header.settlement !== 'adjust_due' && header.refund_reference.trim()) {
    base.refund_reference = header.refund_reference.trim()
  }
  if (draft.mode === 'bill') {
    return {
      ...base,
      bill_id: draft.bill.id,
      lines: draft.lines
        .filter((l) => (l.qty_milli ?? 0) > 0)
        .map((l) => ({ bill_line_id: l.line.bill_line_id, qty_milli: l.qty_milli ?? 0 })),
    }
  }
  return {
    ...base,
    supplier_id: header.supplier?.id ?? '',
    store_id: header.store_id ?? '',
    is_interstate: opts.interstate,
    lines: draft.lines.map((l) => ({
      product_id: l.product.id,
      ...(l.batch_id ? { batch_id: l.batch_id } : {}),
      qty_milli: l.qty_milli ?? 0,
      ...(l.unit_cost_paise !== null ? { unit_cost_paise: l.unit_cost_paise } : {}),
      ...(isValidGstRate(l.gst_rate_bp) ? { gst_rate_bp: l.gst_rate_bp } : {}),
      ...(l.cess_rate_bp > 0 ? { cess_rate_bp: l.cess_rate_bp } : {}),
    })),
  }
}

/** Default reason for prefilled batches: expired / near-expiry stock goes back as 'expired'. */
export function prefillReason(prefill: DebitNotePrefill, today: string): DebitNoteReason {
  return prefill.lines.some((l) => l.expiry_date !== null && l.expiry_date <= today)
    ? 'expired'
    : 'return'
}

export const EMPTY_RETURN_AMOUNTS = ZERO
