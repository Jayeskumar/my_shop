/**
 * State model of the purchase-order editor (pure functions, unit-tested): draft header and lines,
 * live estimated totals (computePurchaseLine per line — the same maths the server stores), the
 * validation and the bodies of POST /purchase-orders and PATCH /purchase-orders/:id.
 *
 * Quantities are milli base units; rates are per pack of `pack_size` base units, excluding tax.
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import type {
  PurchaseOrderCreate,
  PurchaseOrderDetail,
  PurchaseOrderLineInput,
  PurchaseOrderUpdate,
  ReorderItem,
} from '@kadai/shared/api/purchases'
import { compareDates } from '@kadai/shared/fy'
import { isValidGstRate } from '@kadai/shared/gst'
import { newId } from '@kadai/shared/ids'
import { computePurchaseLine } from '@kadai/shared/pricing'
import { type ValidationKey, validationToken } from '@/lib/validation'
import { isInterstateAuto } from './bill-form'

export interface OrderProduct {
  id: string
  name: string
  name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  gst_rate_bp: number
  /** Product purchase price (default rate of a new line). */
  purchase_price_paise: number
  last_cost_paise: number | null
  stock_qty_milli: number | null
}

export interface OrderLineDraft {
  key: string
  product: OrderProduct
  qty_milli: number | null
  /** Per pack, excluding tax; null = the product's purchase price (server default). */
  unit_cost_paise: number | null
  gst_rate_bp: number
  notes: string
  /** Reorder suggestion this line came from (shown as a hint). */
  suggested_qty_milli: number | null
  /** Saved order: already received against the line (lines with receipts are not removable). */
  received_qty_milli: number
}

export interface OrderSupplier {
  id: string
  name: string
  phone: string | null
  state_code: string | null
}

export interface OrderDraft {
  supplier: OrderSupplier | null
  store_id: string | null
  order_date: string | null
  expected_date: string | null
  notes: string
  terms: string
  lines: OrderLineDraft[]
}

export function orderProductFromListItem(p: ProductListItem): OrderProduct {
  return {
    id: p.id,
    name: p.name,
    name_ta: p.name_ta,
    sku: p.sku,
    unit: p.unit,
    pack_size: p.pack_size,
    gst_rate_bp: p.gst_rate_bp,
    purchase_price_paise: p.purchase_price_paise,
    last_cost_paise: p.purchase_price_paise > 0 ? p.purchase_price_paise : null,
    stock_qty_milli: p.stock_qty_milli,
  }
}

export function orderLineFromProduct(
  product: OrderProduct,
  qty: number | null = null,
): OrderLineDraft {
  return {
    key: newId(),
    product,
    qty_milli: qty,
    unit_cost_paise:
      product.last_cost_paise ??
      (product.purchase_price_paise > 0 ? product.purchase_price_paise : null),
    gst_rate_bp: product.gst_rate_bp,
    notes: '',
    suggested_qty_milli: null,
    received_qty_milli: 0,
  }
}

/** A line from a reorder suggestion: suggested quantity at the last purchase cost. */
export function orderLineFromReorder(item: ReorderItem, qty?: number): OrderLineDraft {
  return {
    key: newId(),
    product: {
      id: item.product_id,
      name: item.name,
      name_ta: item.name_ta,
      sku: item.sku,
      unit: item.unit,
      pack_size: item.pack_size,
      gst_rate_bp: item.gst_rate_bp,
      purchase_price_paise: item.last_cost_paise ?? 0,
      last_cost_paise: item.last_cost_paise,
      stock_qty_milli: item.current_stock_milli,
    },
    qty_milli: qty ?? (item.suggested_qty_milli > 0 ? item.suggested_qty_milli : null),
    unit_cost_paise: item.last_cost_paise,
    gst_rate_bp: item.gst_rate_bp,
    notes: '',
    suggested_qty_milli: item.suggested_qty_milli,
    received_qty_milli: 0,
  }
}

export function emptyOrder(opts: { store_id: string | null; today: string }): OrderDraft {
  return {
    supplier: null,
    store_id: opts.store_id,
    order_date: opts.today,
    expected_date: null,
    notes: '',
    terms: '',
    lines: [],
  }
}

export function draftFromOrder(order: PurchaseOrderDetail): OrderDraft {
  return {
    supplier: {
      id: order.supplier.id,
      name: order.supplier.name,
      phone: order.supplier.phone,
      state_code: order.supplier.state_code,
    },
    store_id: order.store_id,
    order_date: order.order_date,
    expected_date: order.expected_date,
    notes: order.notes ?? '',
    terms: order.terms ?? '',
    lines: order.lines.map((l) => ({
      key: l.id,
      product: {
        id: l.product_id,
        name: l.product.name,
        name_ta: l.product.name_ta,
        sku: l.product.sku,
        unit: l.product.unit,
        pack_size: l.product.pack_size,
        gst_rate_bp: l.gst_rate_bp,
        purchase_price_paise: l.unit_cost_paise,
        last_cost_paise: l.last_cost_paise,
        stock_qty_milli: l.current_stock_milli,
      },
      qty_milli: l.qty_milli,
      unit_cost_paise: l.unit_cost_paise,
      gst_rate_bp: l.gst_rate_bp,
      notes: l.notes ?? '',
      suggested_qty_milli: null,
      received_qty_milli: l.received_qty_milli,
    })),
  }
}

// ---------------------------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------------------------

export interface OrderLineAmounts {
  taxable_paise: number
  tax_paise: number
  total_paise: number
}

export interface OrderTotals {
  is_interstate: boolean
  byKey: Map<string, OrderLineAmounts>
  taxable_paise: number
  tax_paise: number
  total_paise: number
}

/** Estimated totals (lines without a quantity or rate are skipped). */
export function computeOrder(draft: OrderDraft, storeStateCode: string | null): OrderTotals {
  const is_interstate = isInterstateAuto(draft.supplier?.state_code ?? null, storeStateCode)
  const byKey = new Map<string, OrderLineAmounts>()
  let taxable = 0
  let tax = 0
  for (const l of draft.lines) {
    const cost = l.unit_cost_paise ?? l.product.purchase_price_paise
    if (l.qty_milli === null || l.qty_milli <= 0 || cost < 0) continue
    const r = computePurchaseLine({
      unit_cost_paise: cost,
      qty_milli: l.qty_milli,
      pack_size: l.product.pack_size,
      gst_rate_bp: l.gst_rate_bp,
      is_interstate,
    })
    const lineTax = r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise
    byKey.set(l.key, {
      taxable_paise: r.taxable_paise,
      tax_paise: lineTax,
      total_paise: r.total_paise,
    })
    taxable += r.taxable_paise
    tax += lineTax
  }
  return {
    is_interstate,
    byKey,
    taxable_paise: taxable,
    tax_paise: tax,
    total_paise: taxable + tax,
  }
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export type OrderHeaderField = 'supplier' | 'store' | 'order_date' | 'expected_date' | 'lines'
export type OrderLineField = 'qty' | 'unit_cost'

export interface OrderErrors {
  header: Partial<Record<OrderHeaderField, string>>
  lines: Record<string, Partial<Record<OrderLineField, string>>>
}

const token = (key: ValidationKey): string => validationToken(key)

/** Line error: the ordered quantity is below what was already received (purchases:orders.*). */
export const QTY_BELOW_RECEIVED = 'qty_below_received'

export function hasOrderErrors(errors: OrderErrors): boolean {
  return (
    Object.keys(errors.header).length > 0 ||
    Object.values(errors.lines).some((e) => Object.keys(e).length > 0)
  )
}

export function validateOrder(draft: OrderDraft): OrderErrors {
  const errors: OrderErrors = { header: {}, lines: {} }
  if (!draft.supplier) errors.header.supplier = token('required')
  if (!draft.store_id) errors.header.store = token('required')
  if (!draft.order_date) errors.header.order_date = token('required')
  if (
    draft.order_date &&
    draft.expected_date &&
    compareDates(draft.expected_date, draft.order_date) < 0
  ) {
    errors.header.expected_date = 'date_order'
  }
  if (draft.lines.length === 0) errors.header.lines = token('select')
  for (const l of draft.lines) {
    const e: Partial<Record<OrderLineField, string>> = {}
    if (l.qty_milli === null || l.qty_milli <= 0) e.qty = token('qty')
    else if (l.qty_milli < l.received_qty_milli) e.qty = QTY_BELOW_RECEIVED
    if (Object.keys(e).length) errors.lines[l.key] = e
  }
  return errors
}

// ---------------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------------

export function toOrderLineInput(l: OrderLineDraft): PurchaseOrderLineInput {
  const input: PurchaseOrderLineInput = { product_id: l.product.id, qty_milli: l.qty_milli ?? 0 }
  if (l.unit_cost_paise !== null) input.unit_cost_paise = l.unit_cost_paise
  if (isValidGstRate(l.gst_rate_bp)) input.gst_rate_bp = l.gst_rate_bp
  if (l.notes.trim()) input.notes = l.notes.trim()
  return input
}

export function toOrderCreateBody(draft: OrderDraft, clientRef: string): PurchaseOrderCreate {
  const body: PurchaseOrderCreate = {
    store_id: draft.store_id ?? '',
    supplier_id: draft.supplier?.id ?? '',
    lines: draft.lines.map(toOrderLineInput),
    client_ref: clientRef,
  }
  if (draft.order_date) body.order_date = draft.order_date
  if (draft.expected_date) body.expected_date = draft.expected_date
  if (draft.notes.trim()) body.notes = draft.notes.trim()
  if (draft.terms.trim()) body.terms = draft.terms.trim()
  return body
}

export function toOrderUpdateBody(
  draft: OrderDraft,
  order: Pick<PurchaseOrderDetail, 'updated_at'>,
): PurchaseOrderUpdate {
  const body: PurchaseOrderUpdate = {
    lines: draft.lines.map(toOrderLineInput),
    expected_date: draft.expected_date,
    notes: draft.notes.trim() || null,
    terms: draft.terms.trim() || null,
    if_updated_at: order.updated_at,
  }
  if (draft.supplier) body.supplier_id = draft.supplier.id
  if (draft.order_date) body.order_date = draft.order_date
  return body
}

/** Lines of a reorder group as a PO create body (selected items with their chosen quantity). */
export function reorderOrderBody(input: {
  store_id: string
  supplier_id: string
  items: readonly { item: ReorderItem; qty_milli: number }[]
  client_ref: string
  order_date?: string
}): PurchaseOrderCreate {
  return {
    store_id: input.store_id,
    supplier_id: input.supplier_id,
    ...(input.order_date ? { order_date: input.order_date } : {}),
    lines: input.items.map(({ item, qty_milli }) => ({
      product_id: item.product_id,
      qty_milli,
      ...(item.last_cost_paise !== null ? { unit_cost_paise: item.last_cost_paise } : {}),
    })),
    client_ref: input.client_ref,
  }
}
