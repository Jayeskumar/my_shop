/**
 * Live cart pricing with the shared engine (`priceCart` from @kadai/shared/api/sales — the very
 * function the server runs for POST /pos/quote and invoice create), fed from the cart snapshots:
 * resolveUnitPrice (store price > wholesale tier > batch > product), manual overrides, price-slab
 * GST, active promotions (feature promotions) and loyalty redemption (feature loyalty).
 *
 * The server stays authoritative: before a bill is saved online the POS asks for a quote and
 * shows any difference (see quoteDiff).
 */
import {
  type CartPricingLine,
  type CartPricingResult,
  type QuoteResult,
  priceCart,
  resolveUnitPrice,
} from '@kadai/shared/api/sales'
import type { PromotionLike } from '@kadai/shared/promotions'
import type { RoundOffMode, TaxMode } from '@kadai/shared/pricing'
import type { TenantSettings } from '@kadai/shared/settings'
import { amountForQty } from '@kadai/shared/units'
import type { CartLine, CartState } from './cart'

export interface PricingEnv {
  tax_mode: TaxMode
  round_off: RoundOffMode
  store_id: string
  timezone: string
  /** Active promotions (empty without feature promotions). */
  promotions: readonly PromotionLike[]
  /** settings.loyalty when the plan has feature loyalty, else null. */
  loyalty: TenantSettings['loyalty'] | null
  /** Instant the promotions are evaluated for (default now). */
  now?: Date
}

export interface LinePrice {
  /** Charged price per pack. */
  unit_price_paise: number
  /** Price before any override. */
  resolved_price_paise: number
  mrp_paise: number | null
  source: 'store_price' | 'price_tier' | 'batch' | 'product' | 'manual'
}

/** Price of a cart line for the customer's tier (walk-in = retail). */
export function linePrice(line: CartLine, priceTier: 'retail' | 'wholesale'): LinePrice {
  const resolved = resolveUnitPrice({
    product: {
      sale_price_paise: line.product.sale_price_paise,
      mrp_paise: line.product.mrp_paise,
      wholesale_price_paise: line.product.wholesale_price_paise,
    },
    store_price: line.store_price,
    batch: line.batch
      ? { sale_price_paise: line.batch.sale_price_paise, mrp_paise: line.batch.mrp_paise }
      : null,
    price_tier: priceTier,
  })
  const manual =
    line.price_override_paise !== null && line.price_override_paise !== resolved.unit_price_paise
  return {
    unit_price_paise: manual ? line.price_override_paise! : resolved.unit_price_paise,
    resolved_price_paise: resolved.unit_price_paise,
    mrp_paise: resolved.mrp_paise,
    source: manual ? 'manual' : resolved.source,
  }
}

export interface PricedCartLine {
  line: CartLine
  price: LinePrice
  gross_paise: number
  /** Item discount (manual + promotion). */
  discount_paise: number
  promotion_discount_paise: number
  total_paise: number
  gst_rate_bp: number
  mrp_savings_paise: number
  /** MRP amount of the quantity (null without MRP). */
  mrp_amount_paise: number | null
}

export interface CartPricing {
  result: CartPricingResult
  lines: PricedCartLine[]
  /** Σ MRP savings + discounts shown as "நீங்கள் சேமித்தது ₹x". */
  savings_paise: number
  item_count: number
  /** Pricing failed (amount out of range): the cart cannot be saved. */
  error: string | null
}

const EMPTY_RESULT: CartPricingResult = {
  lines: [],
  gross_paise: 0,
  item_discount_paise: 0,
  bill_discount_paise: 0,
  taxable_paise: 0,
  cgst_paise: 0,
  sgst_paise: 0,
  igst_paise: 0,
  cess_paise: 0,
  tax_paise: 0,
  round_off_paise: 0,
  total_paise: 0,
  mrp_savings_paise: 0,
  tax_breakup: [],
  line_promotions: {},
  applied_promotions: [],
  manual_bill_discount_paise: 0,
  promotion_bill_discount_paise: 0,
  loyalty_redeem_paise: 0,
  loyalty_points_redeemed: 0,
  loyalty_issue: null,
  manual_discount_bp: {},
  manual_bill_discount_bp: 0,
}

/** The shared engine's input for a cart (identical to what the server builds). */
export function cartPricingLines(cart: CartState): CartPricingLine[] {
  const tier = cart.customer?.price_tier ?? 'retail'
  return cart.lines.map((line) => {
    const price = linePrice(line, tier)
    return {
      key: line.key,
      product_id: line.product.id,
      category_id: line.product.category_id,
      brand_id: line.product.brand_id,
      unit_price_paise: price.unit_price_paise,
      qty_milli: line.qty_milli,
      pack_size: line.product.pack_size,
      price_includes_tax: line.product.price_includes_tax,
      gst_rate_bp: line.product.gst_rate_bp,
      cess_rate_bp: line.product.cess_rate_bp,
      tax_slabs: line.tax_slabs,
      mrp_paise: price.mrp_paise,
      discount_bp: line.discount_bp,
      discount_paise: line.discount_paise,
    }
  })
}

/** Prices the cart (synchronous; safe to call on every render through useMemo). */
export function priceLocalCart(cart: CartState, env: PricingEnv): CartPricing {
  if (cart.lines.length === 0) {
    return { result: EMPTY_RESULT, lines: [], savings_paise: 0, item_count: 0, error: null }
  }
  const tier = cart.customer?.price_tier ?? 'retail'
  let result: CartPricingResult
  try {
    result = priceCart({
      lines: cartPricingLines(cart),
      tax_mode: env.tax_mode,
      is_interstate: false,
      round_off: env.round_off,
      bill_discount_bp: cart.bill_discount_bp,
      bill_discount_paise: cart.bill_discount_paise,
      promotions: env.promotions,
      promotion_context: {
        store_id: env.store_id,
        now: env.now ?? new Date(),
        timezone: env.timezone,
      },
      loyalty:
        env.loyalty && cart.customer && cart.loyalty_redeem_points > 0
          ? {
              redeem_points: cart.loyalty_redeem_points,
              available_points: cart.customer.loyalty_points,
              settings: env.loyalty,
            }
          : null,
    })
  } catch (error) {
    return {
      result: EMPTY_RESULT,
      lines: [],
      savings_paise: 0,
      item_count: cart.lines.length,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const lines: PricedCartLine[] = cart.lines.map((line, i) => {
    const r = result.lines[i]
    const price = linePrice(line, tier)
    const promo = result.line_promotions[line.key]?.discount_paise ?? 0
    return {
      line,
      price,
      gross_paise: r?.gross_paise ?? 0,
      discount_paise: r?.item_discount_paise ?? 0,
      promotion_discount_paise: promo,
      total_paise: r?.total_paise ?? 0,
      gst_rate_bp: r?.gst_rate_bp ?? line.product.gst_rate_bp,
      mrp_savings_paise: r?.mrp_savings_paise ?? 0,
      mrp_amount_paise:
        price.mrp_paise !== null
          ? amountForQty(price.mrp_paise, line.qty_milli, line.product.pack_size)
          : null,
    }
  })
  // Same rule as the printed receipt: MRP savings of MRP lines + discounts of the others.
  const savings = lines.reduce((sum, l, i) => {
    const r = result.lines[i]
    return sum + (l.price.mrp_paise !== null ? l.mrp_savings_paise : (r?.discount_paise ?? 0))
  }, 0)
  return { result, lines, savings_paise: savings, item_count: cart.lines.length, error: null }
}

export interface QuoteDiff {
  /** Server total − local total. */
  total_paise: number
  /** Lines whose charged price differs (cart line keys). */
  price_keys: string[]
}

/** Differences between the local pricing and the server's quote (null = identical). */
export function quoteDiff(local: CartPricing, quote: QuoteResult): QuoteDiff | null {
  const price_keys: string[] = []
  for (const l of local.lines) {
    const server = quote.lines.filter((q) => q.source_key === l.line.key)
    if (server.length === 0) continue
    // FEFO splits may carry different batch prices: compare the line amount.
    const serverTotal = server.reduce((s, q) => s + q.total_paise, 0)
    if (serverTotal !== l.total_paise) price_keys.push(l.line.key)
  }
  const total = quote.total_paise - local.result.total_paise
  if (total === 0 && price_keys.length === 0) return null
  return { total_paise: total, price_keys }
}
