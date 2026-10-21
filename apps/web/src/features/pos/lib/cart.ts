/**
 * POS cart state + reducer (ARCHITECTURE.md §16 "POS cart in a reducer + IndexedDB persistence").
 *
 * Every line keeps a snapshot of the product, its batch, the store price and the tax slabs it was
 * added with, so the cart can be priced (shared `priceCart`), printed and queued offline without
 * touching IndexedDB again — and a reloaded tab restores exactly what the cashier saw. The cart id
 * is the bill's `client_ref` (idempotency key of POST /sales/invoices and POST /pos/sync).
 */
import { newId } from '@kadai/shared/ids'
import type { TaxSlab } from '@kadai/shared/pricing'
import type { PriceTier } from '@kadai/shared/enums'
import type { RxInput } from '@kadai/shared/api/sales'
import { isDecimalUnit } from '@kadai/shared/units'
import type { PosBatch, PosProduct } from './types'

export interface CartStorePrice {
  sale_price_paise: number
  mrp_paise: number | null
}

export interface CartLine {
  key: string
  product: PosProduct
  qty_milli: number
  /** Selected batch (batch-tracked products); `batch_auto` = FEFO default, not sent to the server. */
  batch: PosBatch | null
  batch_auto: boolean
  store_price: CartStorePrice | null
  tax_slabs: TaxSlab[] | null
  /** Manual price per pack (null = resolved price). */
  price_override_paise: number | null
  /** Manual line discount. */
  discount_bp: number
  discount_paise: number
  serial_numbers: string[]
  scanned_code: string | null
  note: string | null
}

export interface CartCustomer {
  id: string
  name: string
  name_ta: string | null
  phone: string | null
  gstin: string | null
  state_code: string | null
  price_tier: PriceTier
  /** + = owes the shop (due), − = advance. */
  balance_paise: number
  credit_limit_paise: number | null
  loyalty_points: number
}

export interface CartState {
  /** client_ref of the bill (UUID v7). */
  id: string
  lines: CartLine[]
  selected_key: string | null
  customer: CartCustomer | null
  bill_discount_bp: number
  bill_discount_paise: number
  loyalty_redeem_points: number
  rx: RxInput | null
  notes: string | null
  /** A held bill recalled from the server (completed with POST /sales/invoices/:id/complete). */
  held_invoice_id: string | null
  held_updated_at: string | null
  created_at: string
  /** Bumped on every change (persistence, customer display). */
  version: number
}

export type NewCartLine = Omit<CartLine, 'key'> & { key?: string }

export type CartAction =
  | { type: 'add'; line: NewCartLine; merge?: boolean }
  | { type: 'set_qty'; key: string; qty_milli: number }
  | { type: 'step_qty'; key: string; direction: 1 | -1 }
  | { type: 'remove'; key: string }
  | { type: 'set_price'; key: string; price_paise: number | null }
  | { type: 'set_discount'; key: string; discount_bp: number; discount_paise: number }
  | { type: 'set_batch'; key: string; batch: PosBatch | null; auto: boolean }
  | { type: 'set_note'; key: string; note: string | null }
  | { type: 'set_serials'; key: string; serial_numbers: string[] }
  | { type: 'select'; key: string | null }
  | { type: 'select_move'; delta: 1 | -1 }
  | { type: 'set_customer'; customer: CartCustomer | null }
  | { type: 'set_bill_discount'; discount_bp: number; discount_paise: number }
  | { type: 'set_loyalty'; points: number }
  | { type: 'set_rx'; rx: RxInput | null }
  | { type: 'set_notes'; notes: string | null }
  | { type: 'clear' }
  | { type: 'load'; cart: CartState }
  | {
      type: 'refresh_products'
      products: ReadonlyMap<
        string,
        { product: PosProduct; store_price: CartStorePrice | null; tax_slabs: TaxSlab[] | null }
      >
    }

export function emptyCart(): CartState {
  return {
    id: newId(),
    lines: [],
    selected_key: null,
    customer: null,
    bill_discount_bp: 0,
    bill_discount_paise: 0,
    loyalty_redeem_points: 0,
    rx: null,
    notes: null,
    held_invoice_id: null,
    held_updated_at: null,
    created_at: new Date().toISOString(),
    version: 0,
  }
}

/** Stepper increment of a product: one pack (strip) for pack-priced goods, else one unit. */
export function qtyStepMilli(product: Pick<PosProduct, 'pack_size' | 'unit'>): number {
  return product.pack_size > 1 ? product.pack_size * 1000 : 1000
}

/** Whether a quantity may be typed with decimals (weighed / measured goods, loose tablets). */
export function allowsDecimalQty(product: Pick<PosProduct, 'decimal_qty' | 'unit'>): boolean {
  return product.decimal_qty || isDecimalUnit(product.unit)
}

/** Default quantity of one scan / tap: one pack for strips that cannot be sold loose. */
export function defaultQtyMilli(product: Pick<PosProduct, 'pack_size' | 'allow_loose'>): number {
  return product.pack_size > 1 && !product.allow_loose ? product.pack_size * 1000 : 1000
}

const MAX_QTY_MILLI = 1_000_000_000

function validQty(qty: number): boolean {
  return Number.isSafeInteger(qty) && qty > 0 && qty <= MAX_QTY_MILLI
}

/** Same product sold the same way: a repeated scan adds to the line instead of a new one. */
function canMerge(existing: CartLine, line: NewCartLine): boolean {
  if (existing.product.id !== line.product.id) return false
  if (existing.price_override_paise !== null || line.price_override_paise !== null) return false
  if (existing.serial_numbers.length > 0 || line.serial_numbers.length > 0) return false
  // Weighed goods: every weighing / scale label is its own line.
  if (line.product.is_weighed || existing.product.is_weighed) return false
  if (existing.batch_auto !== line.batch_auto) return false
  if (!line.batch_auto && (existing.batch?.id ?? null) !== (line.batch?.id ?? null)) return false
  return existing.note === line.note
}

function touch(state: CartState, patch: Partial<CartState>): CartState {
  return { ...state, ...patch, version: state.version + 1 }
}

function updateLine(state: CartState, key: string, fn: (line: CartLine) => CartLine): CartState {
  let changed = false
  const lines = state.lines.map((l) => {
    if (l.key !== key) return l
    const next = fn(l)
    if (next !== l) changed = true
    return next
  })
  return changed ? touch(state, { lines }) : state
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const { line } = action
      if (!validQty(line.qty_milli)) return state
      if (action.merge !== false) {
        const existing = state.lines.find((l) => canMerge(l, line))
        if (existing) {
          const qty = existing.qty_milli + line.qty_milli
          if (!validQty(qty)) return state
          const lines = state.lines.map((l) =>
            l.key === existing.key
              ? { ...l, qty_milli: qty, scanned_code: line.scanned_code ?? l.scanned_code }
              : l,
          )
          return touch(state, { lines, selected_key: existing.key })
        }
      }
      const key = line.key ?? newId()
      return touch(state, { lines: [...state.lines, { ...line, key }], selected_key: key })
    }
    case 'set_qty': {
      if (action.qty_milli <= 0) return cartReducer(state, { type: 'remove', key: action.key })
      if (!validQty(action.qty_milli)) return state
      return updateLine(state, action.key, (l) =>
        l.qty_milli === action.qty_milli ? l : { ...l, qty_milli: action.qty_milli },
      )
    }
    case 'step_qty': {
      const line = state.lines.find((l) => l.key === action.key)
      if (!line) return state
      const step = qtyStepMilli(line.product)
      let next = line.qty_milli + action.direction * step
      // From a loose quantity (2.5 strips) a step lands on the nearest whole pack/unit.
      if (line.qty_milli % step !== 0) {
        next =
          action.direction > 0
            ? Math.ceil(line.qty_milli / step) * step
            : Math.floor(line.qty_milli / step) * step
      }
      if (next <= 0) return state
      return cartReducer(state, { type: 'set_qty', key: action.key, qty_milli: next })
    }
    case 'remove': {
      const index = state.lines.findIndex((l) => l.key === action.key)
      if (index < 0) return state
      const lines = state.lines.filter((l) => l.key !== action.key)
      const neighbour = lines[Math.min(index, lines.length - 1)] ?? null
      return touch(state, {
        lines,
        selected_key:
          state.selected_key === action.key ? (neighbour?.key ?? null) : state.selected_key,
      })
    }
    case 'set_price':
      if (
        action.price_paise !== null &&
        !(Number.isSafeInteger(action.price_paise) && action.price_paise >= 0)
      )
        return state
      return updateLine(state, action.key, (l) => ({
        ...l,
        price_override_paise: action.price_paise,
      }))
    case 'set_discount': {
      const bp = Math.max(0, Math.min(10_000, Math.round(action.discount_bp)))
      const paise = Math.max(0, Math.round(action.discount_paise))
      return updateLine(state, action.key, (l) => ({
        ...l,
        discount_bp: bp,
        discount_paise: paise,
      }))
    }
    case 'set_batch':
      return updateLine(state, action.key, (l) => ({
        ...l,
        batch: action.batch,
        batch_auto: action.auto,
      }))
    case 'set_note': {
      const note = action.note?.trim() || null
      return updateLine(state, action.key, (l) => (l.note === note ? l : { ...l, note }))
    }
    case 'set_serials':
      return updateLine(state, action.key, (l) => ({
        ...l,
        serial_numbers: action.serial_numbers.map((s) => s.trim()).filter(Boolean),
      }))
    case 'select':
      if (state.selected_key === action.key) return state
      if (action.key !== null && !state.lines.some((l) => l.key === action.key)) return state
      return { ...state, selected_key: action.key }
    case 'select_move': {
      if (state.lines.length === 0) return state
      const index = state.lines.findIndex((l) => l.key === state.selected_key)
      const nextIndex =
        index < 0
          ? action.delta > 0
            ? 0
            : state.lines.length - 1
          : Math.max(0, Math.min(state.lines.length - 1, index + action.delta))
      return { ...state, selected_key: state.lines[nextIndex]?.key ?? null }
    }
    case 'set_customer': {
      const loyalty = action.customer ? state.loyalty_redeem_points : 0
      return touch(state, { customer: action.customer, loyalty_redeem_points: loyalty })
    }
    case 'set_bill_discount':
      return touch(state, {
        bill_discount_bp: Math.max(0, Math.min(10_000, Math.round(action.discount_bp))),
        bill_discount_paise: Math.max(0, Math.round(action.discount_paise)),
      })
    case 'set_loyalty':
      return touch(state, { loyalty_redeem_points: Math.max(0, Math.floor(action.points)) })
    case 'set_rx':
      return touch(state, { rx: action.rx })
    case 'set_notes':
      return touch(state, { notes: action.notes?.trim() || null })
    case 'clear':
      return { ...emptyCart(), version: state.version + 1 }
    case 'load':
      return { ...action.cart, version: state.version + 1 }
    case 'refresh_products': {
      let changed = false
      const lines = state.lines.map((l) => {
        const fresh = action.products.get(l.product.id)
        if (!fresh) return l
        changed = true
        return {
          ...l,
          product: fresh.product,
          store_price: fresh.store_price,
          tax_slabs: fresh.tax_slabs,
        }
      })
      return changed ? touch(state, { lines }) : state
    }
  }
}

/** Pack unit shown for pack-priced goods: strips for tablets / capsules, else packs. */
export function packUnitOf(product: Pick<PosProduct, 'unit'>): string {
  return product.unit === 'TAB' || product.unit === 'CAP' ? 'STRIP' : 'PACK'
}

export function isCartEmpty(cart: Pick<CartState, 'lines'>): boolean {
  return cart.lines.length === 0
}

/** Persisted carts are validated loosely (shape only) before they are restored. */
export function isCartState(value: unknown): value is CartState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<CartState>
  return (
    typeof v.id === 'string' &&
    Array.isArray(v.lines) &&
    v.lines.every(
      (l) =>
        typeof l === 'object' &&
        l !== null &&
        typeof (l as CartLine).key === 'string' &&
        typeof (l as CartLine).qty_milli === 'number' &&
        typeof (l as CartLine).product?.id === 'string',
    ) &&
    typeof v.bill_discount_bp === 'number' &&
    typeof v.bill_discount_paise === 'number'
  )
}
