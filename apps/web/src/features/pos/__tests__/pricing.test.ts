import { describe, expect, it } from 'vitest'
import { priceCart } from '@kadai/shared/api/sales'
import { cartPricingLines, linePrice, priceLocalCart, quoteDiff } from '../lib/pricing'
import { toLineInput } from '../lib/requests'
import {
  batches,
  cartOf,
  dal,
  lineOf,
  makeBootstrap,
  paracetamol,
  quoteFor,
  rice,
  sugar,
} from './fixtures'
import { pricingEnvOf } from './helpers'

const env = pricingEnvOf(makeBootstrap())

describe('priceLocalCart (shared engine, same input as the server)', () => {
  it('matches the server quote of the dev counter run: ₹791.00, GST ₹37.66, saved ₹61.00', () => {
    // Totals of POST /pos/quote for this cart on the dev server (S1-A/2627/00003).
    const cart = cartOf([
      lineOf(rice),
      lineOf(dal, { qty_milli: 2000 }),
      lineOf(sugar, { qty_milli: 1500 }),
    ])
    const p = priceLocalCart(cart, env)
    expect(p.error).toBeNull()
    expect(p.result.total_paise).toBe(79_100)
    expect(p.result.tax_paise).toBe(3_766)
    expect(p.result.taxable_paise).toBe(75_334)
    expect(p.result.cgst_paise + p.result.sgst_paise).toBe(3_766)
    expect(p.savings_paise).toBe(6_100) // (420−395) + 2×(180−165) + 1.5×(48−44)
    expect(p.lines.map((l) => l.total_paise)).toEqual([39_500, 33_000, 6_600])
    expect(p.item_count).toBe(3)
  })

  it('feeds priceCart exactly what the request lines describe (parity with the server build)', () => {
    const cart = cartOf([lineOf(rice, { discount_bp: 500 }), lineOf(sugar, { qty_milli: 750 })], {
      bill_discount_paise: 1_000,
    })
    const direct = priceCart({
      lines: cartPricingLines(cart),
      tax_mode: 'regular',
      is_interstate: false,
      round_off: env.round_off,
      bill_discount_bp: 0,
      bill_discount_paise: 1_000,
      promotions: [],
      promotion_context: { store_id: env.store_id, now: env.now!, timezone: env.timezone },
      loyalty: null,
    })
    expect(priceLocalCart(cart, env).result).toEqual(direct)
    // What is sent for the line is what was priced.
    const input = toLineInput(cart.lines[0]!, 'retail')
    expect(input).toMatchObject({ product_id: rice.id, qty_milli: 1000, discount_bp: 500 })
  })

  it('resolves prices: wholesale tier, batch price, manual override', () => {
    expect(linePrice(lineOf(rice), 'wholesale')).toMatchObject({
      unit_price_paise: 38_000,
      source: 'price_tier',
    })
    const old = batches[1]!
    expect(linePrice(lineOf(paracetamol, { batch: old }), 'retail')).toMatchObject({
      unit_price_paise: 3_200,
      mrp_paise: 3_200,
      source: 'batch',
    })
    const manual = linePrice(lineOf(rice, { price_override_paise: 39_000 }), 'retail')
    expect(manual).toMatchObject({
      unit_price_paise: 39_000,
      resolved_price_paise: 39_500,
      source: 'manual',
    })
    // An "override" equal to the resolved price is not manual.
    expect(linePrice(lineOf(rice, { price_override_paise: 39_500 }), 'retail').source).toBe(
      'product',
    )
  })

  it('loose tablets are priced per tablet of the strip price', () => {
    const p = priceLocalCart(cartOf([lineOf(paracetamol, { qty_milli: 5_000 })]), env)
    // 5 of 15 tablets at ₹34.00 a strip.
    expect(p.lines[0]?.total_paise).toBe(1_133)
  })

  it('reports out-of-range amounts instead of throwing', () => {
    const p = priceLocalCart(
      cartOf([
        lineOf(
          { ...rice, sale_price_paise: Number.MAX_SAFE_INTEGER },
          { qty_milli: 1_000_000_000 },
        ),
      ]),
      env,
    )
    expect(p.error).not.toBeNull()
    expect(p.result.total_paise).toBe(0)
  })

  it('an empty cart is zero', () => {
    const p = priceLocalCart(cartOf([]), env)
    expect(p.result.total_paise).toBe(0)
    expect(p.lines).toEqual([])
  })
})

describe('quoteDiff', () => {
  it('is null when the server agrees, else names the lines and the total difference', () => {
    const cart = cartOf([lineOf(rice, { key: 'r' }), lineOf(dal, { key: 'd' })])
    const local = priceLocalCart(cart, env)
    expect(quoteDiff(local, quoteFor(cart, local))).toBeNull()

    const server = quoteFor(cart, local)
    server.lines[1] = { ...server.lines[1]!, total_paise: 16_000 }
    server.total_paise -= 500
    expect(quoteDiff(local, server)).toEqual({ total_paise: -500, price_keys: ['d'] })
  })

  it('compares FEFO split parts by their sum', () => {
    const cart = cartOf([lineOf(rice, { key: 'r', qty_milli: 2000 })])
    const local = priceLocalCart(cart, env)
    const server = quoteFor(cart, local)
    const part = server.lines[0]!
    server.lines = [
      { ...part, key: 'r#1', qty_milli: 1000, total_paise: 39_500 },
      { ...part, key: 'r#2', qty_milli: 1000, total_paise: 39_500 },
    ]
    expect(quoteDiff(local, server)).toBeNull()
  })
})
