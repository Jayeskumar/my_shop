/**
 * Cart → request bodies of the sales contract (POST /pos/quote, POST /sales/invoices, held bills,
 * estimates, POST /pos/sync). Only what the cashier decided is sent: a price only when it was
 * overridden, a batch only when it was chosen by hand (FEFO picks are left to the server, which
 * may split the line across batches), discounts only when set.
 */
import type {
  CartLineInput,
  EstimateCreate,
  InvoiceCreate,
  InvoiceUpdate,
  QuoteRequest,
  SyncInvoice,
  TenderInput,
} from '@kadai/shared/api/sales'
import type { CartLine, CartState } from './cart'
import { linePrice } from './pricing'

export interface CartScope {
  store_id: string
  register_id: string | null
}

export function toLineInput(line: CartLine, priceTier: 'retail' | 'wholesale'): CartLineInput {
  const price = linePrice(line, priceTier)
  return {
    key: line.key,
    product_id: line.product.id,
    qty_milli: line.qty_milli,
    ...(price.source === 'manual' ? { unit_price_paise: price.unit_price_paise } : {}),
    ...(line.discount_bp > 0 ? { discount_bp: line.discount_bp } : {}),
    ...(line.discount_paise > 0 ? { discount_paise: line.discount_paise } : {}),
    ...(line.batch && !line.batch_auto ? { batch_id: line.batch.id } : {}),
    ...(line.serial_numbers.length ? { serial_numbers: line.serial_numbers } : {}),
    ...(line.scanned_code ? { scanned_code: line.scanned_code.slice(0, 64) } : {}),
    ...(line.note ? { note: line.note.slice(0, 200) } : {}),
  }
}

/** Fields shared by quote / create / estimate / sync. */
export function cartFields(cart: CartState, scope: CartScope) {
  const tier = cart.customer?.price_tier ?? 'retail'
  return {
    store_id: scope.store_id,
    ...(scope.register_id ? { register_id: scope.register_id } : {}),
    customer_id: cart.customer?.id ?? null,
    lines: cart.lines.map((l) => toLineInput(l, tier)),
    ...(cart.bill_discount_bp > 0 ? { bill_discount_bp: cart.bill_discount_bp } : {}),
    ...(cart.bill_discount_paise > 0 ? { bill_discount_paise: cart.bill_discount_paise } : {}),
    ...(cart.customer && cart.loyalty_redeem_points > 0
      ? { loyalty_redeem_points: cart.loyalty_redeem_points }
      : {}),
    ...(cart.rx ? { rx: cart.rx } : {}),
    ...(cart.notes ? { notes: cart.notes } : {}),
  }
}

export function quoteRequest(
  cart: CartState,
  scope: CartScope,
  tenders: TenderInput[] | null,
  options: { credit_limit_override?: boolean } = {},
): QuoteRequest {
  return {
    ...cartFields(cart, scope),
    ...(tenders ? { tenders } : {}),
    ...(options.credit_limit_override ? { credit_limit_override: true } : {}),
  }
}

export function invoiceCreateBody(
  cart: CartState,
  scope: CartScope,
  tenders: TenderInput[],
  options: { credit_limit_override?: boolean } = {},
): InvoiceCreate {
  return {
    ...cartFields(cart, scope),
    client_ref: cart.id,
    status: 'completed',
    channel: 'pos',
    tenders,
    credit_limit_override: options.credit_limit_override === true,
  }
}

export function heldCreateBody(
  cart: CartState,
  scope: CartScope,
  label: string | null,
): InvoiceCreate {
  return {
    ...cartFields(cart, scope),
    client_ref: cart.id,
    status: 'held',
    channel: 'pos',
    tenders: [],
    ...(label ? { notes: label } : {}),
  }
}

/** PATCH of a recalled held bill (lines replace every line). */
export function heldUpdateBody(cart: CartState, scope: CartScope): InvoiceUpdate {
  const f = cartFields(cart, scope)
  return {
    customer_id: f.customer_id,
    lines: f.lines,
    bill_discount_bp: cart.bill_discount_bp,
    bill_discount_paise: cart.bill_discount_paise,
    loyalty_redeem_points: cart.customer ? cart.loyalty_redeem_points : 0,
    rx: cart.rx,
    notes: cart.notes,
    ...(cart.held_updated_at ? { if_updated_at: cart.held_updated_at } : {}),
  }
}

export function estimateBody(cart: CartState, scope: CartScope): EstimateCreate {
  return { ...cartFields(cart, scope), client_ref: cart.id }
}

export function syncInvoiceBody(
  cart: CartState,
  scope: CartScope,
  input: {
    client_ref: string
    tenders: TenderInput[]
    offline_number: string | null
    invoice_date: string
    created_at: string
    credit_limit_override?: boolean
  },
): SyncInvoice {
  return {
    ...cartFields(cart, scope),
    client_ref: input.client_ref,
    offline_number: input.offline_number,
    offline_created_at: input.created_at,
    invoice_date: input.invoice_date,
    tenders: input.tenders,
    credit_limit_override: input.credit_limit_override === true,
    // A recalled held bill billed offline: the server retires the held bill at sync.
    ...(cart.held_invoice_id ? { held_invoice_id: cart.held_invoice_id } : {}),
  }
}
