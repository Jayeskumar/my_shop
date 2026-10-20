import { describe, expect, it } from 'vitest'
import {
  SALES_BLOCKING_ISSUE_CODES,
  SALES_WARNING_CODES,
  SHARE_TOKEN_RE,
  allocateTenders,
  batchExpiryStatus,
  cartLineKey,
  cashTenderNotes,
  creditCheck,
  creditNoteSettlementOptions,
  defaultRestock,
  discountBpOf,
  discountLimitBp,
  drugScheduleOf,
  formatSeriesNumber,
  generateShareToken,
  isBlockingSalesIssue,
  lineRequiresRx,
  loyaltyPointsEarned,
  loyaltyRedemption,
  parseCashTenderNotes,
  priceCart,
  prorateReturnLine,
  qtyIssue,
  resolveUnitPrice,
  returnableQtyMilli,
  salesDocumentModeFor,
  salesIssueErrorCode,
  seriesDocTypeFor,
  splitLineKey,
  type CartPricingInput,
  type CartPricingLine,
} from '../../src/api/sales'
import { isErrorCode } from '../../src/errors'
import { computeDocument, type TaxAmounts, type TaxSlab } from '../../src/pricing'
import type { PromotionLike } from '../../src/promotions'
import { createRng } from '../helpers/prng'

const P1 = '0192f000-0000-7000-8000-000000000001'
const P2 = '0192f000-0000-7000-8000-000000000002'
const P3 = '0192f000-0000-7000-8000-000000000003'
const STORE = '0192f000-0000-7000-8000-0000000000aa'
const PROMO_ITEM = '0192f000-0000-7000-8000-0000000000b1'
const PROMO_BILL = '0192f000-0000-7000-8000-0000000000b2'

const line = (over: Partial<CartPricingLine>): CartPricingLine => ({
  key: 'a',
  product_id: P1,
  unit_price_paise: 10_000,
  qty_milli: 1000,
  pack_size: 1,
  price_includes_tax: true,
  gst_rate_bp: 1800,
  ...over,
})

const base = (over: Partial<CartPricingInput>): CartPricingInput => ({
  lines: [line({})],
  tax_mode: 'regular',
  is_interstate: false,
  round_off: 'nearest_rupee',
  ...over,
})

const APPAREL: TaxSlab[] = [
  { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
  { max_unit_value_paise: null, gst_rate_bp: 1800 },
]

describe('priceCart', () => {
  it('equals computeDocument without promotions / loyalty (inclusive, intrastate)', () => {
    const input = base({
      lines: [
        line({ key: 'a', qty_milli: 2000, discount_bp: 500 }),
        line({ key: 'b', product_id: P2, unit_price_paise: 4_999, gst_rate_bp: 500, mrp_paise: 5_500 }),
      ],
      bill_discount_paise: 300,
    })
    const r = priceCart(input)
    const doc = computeDocument({
      lines: input.lines.map((l) => ({ ...l, cess_rate_bp: 0, discount_paise: 0 })),
      is_interstate: false,
      tax_mode: 'regular',
      bill_discount_paise: 300,
      round_off: 'nearest_rupee',
    })
    expect(r.total_paise).toBe(doc.total_paise)
    expect(r.taxable_paise).toBe(doc.taxable_paise)
    expect(r.bill_discount_paise).toBe(300)
    expect(r.manual_bill_discount_paise).toBe(300)
    expect(r.promotion_bill_discount_paise).toBe(0)
    expect(r.manual_discount_bp).toEqual({ a: 500, b: 0 })
    expect(r.total_paise % 100).toBe(0)
    expect(r.mrp_savings_paise).toBeGreaterThan(0)
  })

  it('exclusive interstate with cess → IGST only', () => {
    const r = priceCart(
      base({
        is_interstate: true,
        round_off: 'none',
        lines: [line({ price_includes_tax: false, gst_rate_bp: 2800, cess_rate_bp: 1200, qty_milli: 3000 })],
      }),
    )
    expect(r.taxable_paise).toBe(30_000)
    expect(r.igst_paise).toBe(8_400)
    expect(r.cess_paise).toBe(3_600)
    expect(r.cgst_paise + r.sgst_paise).toBe(0)
    expect(r.total_paise).toBe(42_000)
  })

  it('composition / unregistered charge no tax (bill of supply)', () => {
    for (const tax_mode of ['composition', 'unregistered'] as const) {
      const r = priceCart(base({ tax_mode, lines: [line({ qty_milli: 1500 })] }))
      expect(r.tax_paise).toBe(0)
      expect(r.taxable_paise).toBe(15_000)
      expect(r.lines[0]!.gst_rate_bp).toBe(0)
      expect(salesDocumentModeFor(tax_mode)).toMatchObject({ doc_type: 'bill_of_supply', series: 'bill_of_supply' })
    }
    expect(salesDocumentModeFor('regular')).toEqual({
      doc_type: 'tax_invoice',
      tax_mode: 'regular',
      series: 'sales_invoice',
    })
  })

  it('price-slab GST follows the net value after discounts (apparel ₹2,500 threshold)', () => {
    const above = priceCart(
      base({ round_off: 'none', lines: [line({ unit_price_paise: 280_000, tax_slabs: APPAREL })] }),
    )
    expect(above.lines[0]!.gst_rate_bp).toBe(1800)
    // A 10% discount brings the inclusive value under the threshold → 5%.
    const below = priceCart(
      base({
        round_off: 'none',
        lines: [line({ unit_price_paise: 280_000, tax_slabs: APPAREL, discount_bp: 1000 })],
      }),
    )
    expect(below.lines[0]!.gst_rate_bp).toBe(500)
  })

  it('applies item and bill promotions, splits the bill discount exactly', () => {
    const promotions: PromotionLike[] = [
      {
        id: PROMO_ITEM,
        name: '10% off rice',
        kind: 'item_percent',
        rules: {
          all_items: false,
          product_ids: [P1],
          category_ids: [],
          brand_ids: [],
          exclude_product_ids: [],
          percent_bp: 1000,
        },
        store_ids: null,
        starts_at: null,
        ends_at: null,
        days_of_week: null,
        priority: 0,
        stackable: false,
        is_active: true,
      },
      {
        id: PROMO_BILL,
        name: '₹20 off above ₹200',
        kind: 'bill_flat',
        rules: { flat_paise: 2_000, min_bill_paise: 20_000 },
        store_ids: null,
        starts_at: null,
        ends_at: null,
        days_of_week: null,
        priority: 0,
        stackable: false,
        is_active: true,
      },
    ]
    const r = priceCart(
      base({
        lines: [
          line({ key: 'a', qty_milli: 2000 }),
          line({ key: 'b', product_id: P2, unit_price_paise: 5_000 }),
          line({ key: 'c', product_id: null, unit_price_paise: 1_000 }),
        ],
        bill_discount_bp: 100,
        promotions,
        promotion_context: { store_id: STORE, now: new Date('2026-10-20T06:00:00Z') },
      }),
    )
    expect(r.line_promotions['a']).toEqual({ discount_paise: 2_000, promotion_ids: [PROMO_ITEM] })
    expect(r.line_promotions['b']!.discount_paise).toBe(0)
    expect(r.line_promotions['c']!.discount_paise).toBe(0) // ad-hoc lines are never promoted
    expect(r.promotion_bill_discount_paise).toBe(2_000)
    // manual 1% of Σ net after item discounts (20000 − 2000 + 5000 + 1000 = 24000)
    expect(r.manual_bill_discount_paise).toBe(240)
    expect(r.bill_discount_paise).toBe(2_240)
    expect(r.lines.reduce((s, l) => s + l.bill_discount_paise, 0)).toBe(2_240)
    expect(r.applied_promotions.map((a) => a.promotion_id)).toEqual([PROMO_ITEM, PROMO_BILL])
    expect(r.manual_discount_bp['a']).toBe(0) // promotions never count as manual discount
    expect(r.manual_bill_discount_bp).toBe(100)
  })

  it('redeems whole loyalty points, capped by the bill', () => {
    const settings = { enabled: true, point_value_paise: 100, min_redeem_points: 10 }
    const r = priceCart(
      base({
        round_off: 'none',
        lines: [line({ unit_price_paise: 5_050 })],
        loyalty: { redeem_points: 80, available_points: 500, settings },
      }),
    )
    // Cap 5050 → 50 whole points of ₹1.
    expect(r.loyalty_points_redeemed).toBe(50)
    expect(r.loyalty_redeem_paise).toBe(5_000)
    expect(r.total_paise).toBe(50)
    expect(r.loyalty_issue).toBeNull()
    const short = priceCart(base({ loyalty: { redeem_points: 80, available_points: 20, settings } }))
    expect(short.loyalty_issue).toBe('loyalty_insufficient_points')
    expect(short.loyalty_redeem_paise).toBe(0)
  })

  it('reconciles on random carts (Σ lines = header, total = taxable + tax + round off)', () => {
    const rng = createRng(4242)
    const rates = [0, 500, 1200, 1800, 2800]
    for (let n = 0; n < 300; n++) {
      const lines: CartPricingLine[] = Array.from({ length: rng.int(1, 8) }, (_, i) =>
        line({
          key: `k${i}`,
          product_id: rng.bool(0.9) ? P3 : null,
          unit_price_paise: rng.int(1, 500_000),
          qty_milli: rng.int(1, 20) * rng.pick([250, 500, 1000]),
          pack_size: rng.pick([1, 1, 10]),
          price_includes_tax: rng.bool(),
          gst_rate_bp: rng.pick(rates),
          cess_rate_bp: rng.bool(0.1) ? 1200 : 0,
          discount_bp: rng.bool(0.3) ? rng.int(0, 2000) : 0,
          discount_paise: rng.bool(0.2) ? rng.int(0, 500) : 0,
          tax_slabs: rng.bool(0.15) ? APPAREL : null,
        }),
      )
      const r = priceCart(
        base({
          lines,
          is_interstate: rng.bool(0.2),
          tax_mode: rng.pick(['regular', 'regular', 'composition'] as const),
          bill_discount_bp: rng.bool(0.3) ? rng.int(0, 1500) : 0,
          bill_discount_paise: rng.bool(0.3) ? rng.int(0, 2000) : 0,
          loyalty: rng.bool(0.3)
            ? {
                redeem_points: rng.int(0, 200),
                available_points: 1000,
                settings: { enabled: true, point_value_paise: 50, min_redeem_points: 0 },
              }
            : null,
        }),
      )
      const sum = (f: (l: (typeof r.lines)[number]) => number) => r.lines.reduce((s, l) => s + f(l), 0)
      expect(sum((l) => l.total_paise)).toBe(r.taxable_paise + r.tax_paise)
      expect(r.total_paise).toBe(r.taxable_paise + r.tax_paise + r.round_off_paise)
      expect(r.bill_discount_paise).toBe(
        r.manual_bill_discount_paise + r.promotion_bill_discount_paise + r.loyalty_redeem_paise,
      )
      expect(Math.abs(r.round_off_paise)).toBeLessThanOrEqual(50)
    }
  })
})

describe('resolveUnitPrice', () => {
  const product = { sale_price_paise: 1_000, mrp_paise: 1_200, wholesale_price_paise: 900 }
  it('store override > wholesale tier > batch > product', () => {
    expect(resolveUnitPrice({ product })).toEqual({ unit_price_paise: 1_000, mrp_paise: 1_200, source: 'product' })
    expect(resolveUnitPrice({ product, batch: { sale_price_paise: 1_050, mrp_paise: 1_250 } })).toEqual({
      unit_price_paise: 1_050,
      mrp_paise: 1_250,
      source: 'batch',
    })
    expect(
      resolveUnitPrice({ product, price_tier: 'wholesale', batch: { sale_price_paise: 1_050, mrp_paise: null } }),
    ).toMatchObject({ unit_price_paise: 900, source: 'price_tier', mrp_paise: 1_200 })
    expect(
      resolveUnitPrice({
        product,
        price_tier: 'wholesale',
        store_price: { sale_price_paise: 950, mrp_paise: 1_150 },
      }),
    ).toEqual({ unit_price_paise: 950, mrp_paise: 1_150, source: 'store_price' })
    expect(
      resolveUnitPrice({ product: { ...product, wholesale_price_paise: null }, price_tier: 'wholesale' }).source,
    ).toBe('product')
  })
})

describe('cart rules', () => {
  it('quantity rules', () => {
    expect(qtyIssue({ decimal_qty: false, allow_loose: false, pack_size: 1 }, 1500)).toBe(
      'decimal_qty_not_allowed',
    )
    expect(qtyIssue({ decimal_qty: true, allow_loose: false, pack_size: 1 }, 1250)).toBeNull()
    expect(qtyIssue({ decimal_qty: false, allow_loose: false, pack_size: 10 }, 3000)).toBe('loose_not_allowed')
    expect(qtyIssue({ decimal_qty: false, allow_loose: true, pack_size: 10 }, 3000)).toBeNull()
    expect(qtyIssue({ decimal_qty: false, allow_loose: false, pack_size: 10 }, 20_000)).toBeNull()
  })
  it('rx and schedules', () => {
    expect(drugScheduleOf({ schedule: 'H1' })).toBe('H1')
    expect(drugScheduleOf({ schedule: 'bogus' })).toBe('OTC')
    expect(drugScheduleOf(null)).toBe('OTC')
    expect(lineRequiresRx({ schedule: 'H' }, ['H', 'H1', 'X'])).toBe(true)
    expect(lineRequiresRx({ schedule: 'G' }, ['H', 'H1', 'X'])).toBe(false)
    expect(lineRequiresRx({ requires_prescription: true }, [])).toBe(true)
  })
  it('expiry status (sellable on the expiry date)', () => {
    expect(batchExpiryStatus('2026-10-19', '2026-10-20', 90)).toBe('expired')
    expect(batchExpiryStatus('2026-10-20', '2026-10-20', 90)).toBe('near_expiry')
    expect(batchExpiryStatus('2027-01-18', '2026-10-20', 90)).toBe('near_expiry')
    expect(batchExpiryStatus('2027-01-19', '2026-10-20', 90)).toBe('ok')
    expect(batchExpiryStatus(null, '2026-10-20', 90)).toBeNull()
  })
  it('discount limits', () => {
    expect(discountLimitBp(1000, null)).toBe(1000)
    expect(discountLimitBp(1000, 500)).toBe(500)
    expect(discountBpOf(1000, 125)).toBe(1250)
    expect(discountBpOf(0, 0)).toBe(0)
    expect(discountBpOf(0, 5)).toBe(10_000)
  })
  it('keys and numbering', () => {
    expect(splitLineKey('a', 1)).toBe('a')
    expect(splitLineKey('a', 3)).toBe('a#3')
    expect(cartLineKey({}, 0)).toBe('line-1')
    expect(cartLineKey({ key: 'x' }, 4)).toBe('x')
    expect(formatSeriesNumber('S1-A/2627/', 42, 5)).toBe('S1-A/2627/00042')
    expect(seriesDocTypeFor('tax_invoice')).toBe('sales_invoice')
    expect(seriesDocTypeFor('bill_of_supply')).toBe('bill_of_supply')
    expect(seriesDocTypeFor('estimate')).toBe('estimate')
    expect(seriesDocTypeFor('credit_note')).toBe('credit_note')
  })
  it('share tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateShareToken))
    expect(tokens.size).toBe(200)
    for (const t of tokens) expect(t).toMatch(SHARE_TOKEN_RE)
  })
  it('issue codes map to catalogue error codes', () => {
    for (const code of SALES_BLOCKING_ISSUE_CODES) {
      expect(isBlockingSalesIssue(code)).toBe(true)
      expect(isErrorCode(salesIssueErrorCode(code))).toBe(true)
    }
    for (const code of SALES_WARNING_CODES) expect(isBlockingSalesIssue(code)).toBe(false)
    expect(salesIssueErrorCode('rx_required')).toBe('RX_REQUIRED')
    expect(salesIssueErrorCode('expired_batch')).toBe('EXPIRED_BATCH')
    expect(salesIssueErrorCode('credit_limit_exceeded')).toBe('CREDIT_LIMIT_EXCEEDED')
    expect(salesIssueErrorCode('price_override_required')).toBe('FORBIDDEN')
  })
})

describe('loyalty', () => {
  const settings = { enabled: true, point_value_paise: 100, min_redeem_points: 100, points_per_100_rupees: 1 }
  it('redemption rules', () => {
    expect(loyaltyRedemption({ requested_points: 0, available_points: 10, cap_paise: 1, settings })).toEqual({
      points: 0,
      paise: 0,
      issue: null,
    })
    expect(
      loyaltyRedemption({ requested_points: 50, available_points: 500, cap_paise: 100_000, settings }).issue,
    ).toBe('loyalty_below_minimum')
    expect(
      loyaltyRedemption({
        requested_points: 150,
        available_points: 500,
        cap_paise: 100_000,
        settings: { ...settings, enabled: false },
      }).issue,
    ).toBe('loyalty_disabled')
    expect(
      loyaltyRedemption({ requested_points: 150, available_points: 500, cap_paise: 12_345, settings }),
    ).toEqual({ points: 123, paise: 12_300, issue: null })
  })
  it('earning', () => {
    expect(loyaltyPointsEarned(99_99, settings)).toBe(0)
    expect(loyaltyPointsEarned(25_000, settings)).toBe(2)
    expect(loyaltyPointsEarned(25_000, { ...settings, enabled: false })).toBe(0)
  })
})

describe('allocateTenders', () => {
  it('cash change', () => {
    const r = allocateTenders(38_000, [{ method: 'cash', amount_paise: 50_000 }])
    expect(r).toMatchObject({ paid_paise: 38_000, change_paise: 12_000, due_paise: 0, issue: null })
    expect(r.lines[0]).toMatchObject({ applied_paise: 38_000, change_paise: 12_000 })
  })
  it('split: non-cash first, then cash; remainder is due', () => {
    const r = allocateTenders(100_000, [
      { method: 'cash', amount_paise: 50_000 },
      { method: 'upi', amount_paise: 60_000 },
    ])
    expect(r.lines.map((l) => [l.method, l.applied_paise, l.change_paise])).toEqual([
      ['cash', 40_000, 10_000],
      ['upi', 60_000, 0],
    ])
    expect(r.due_paise).toBe(0)
    const credit = allocateTenders(100_000, [{ method: 'upi', amount_paise: 30_000 }])
    expect(credit).toMatchObject({ paid_paise: 30_000, due_paise: 70_000, issue: null })
  })
  it('flags tenders that do not fit', () => {
    expect(allocateTenders(10_000, [{ method: 'card', amount_paise: 10_001 }]).issue).toEqual({
      code: 'tender_exceeds_due',
      index: 0,
    })
    expect(
      allocateTenders(10_000, [
        { method: 'upi', amount_paise: 10_000 },
        { method: 'cash', amount_paise: 500 },
      ]).issue,
    ).toEqual({ code: 'cash_tender_not_needed', index: 1 })
  })
  it('cash notes round-trip', () => {
    const notes = cashTenderNotes(50_000, 12_000)
    expect(notes).toContain('change Rs 120.00')
    expect(parseCashTenderNotes(notes)).toEqual({ tendered_paise: 50_000, change_paise: 12_000 })
    expect(parseCashTenderNotes('UTR 1234')).toBeNull()
    expect(parseCashTenderNotes(null)).toBeNull()
  })
})

describe('creditCheck', () => {
  it('limits', () => {
    expect(
      creditCheck({ due_paise: 5_000, balance_paise: 10_000, credit_limit_paise: 12_000, block_over_limit: true }),
    ).toEqual({ new_balance_paise: 15_000, available_credit_paise: 2_000, over_limit: true, blocked: true })
    expect(
      creditCheck({
        due_paise: 5_000,
        balance_paise: 10_000,
        credit_limit_paise: 12_000,
        block_over_limit: true,
        override: true,
      }).blocked,
    ).toBe(false)
    expect(
      creditCheck({ due_paise: 5_000, balance_paise: 10_000, credit_limit_paise: null, block_over_limit: true })
        .over_limit,
    ).toBe(false)
    expect(
      creditCheck({ due_paise: 1, balance_paise: 0, credit_limit_paise: 0, block_over_limit: false }),
    ).toMatchObject({ over_limit: true, blocked: false })
    expect(
      creditCheck({ due_paise: 0, balance_paise: 50_000, credit_limit_paise: 0, block_over_limit: true })
        .blocked,
    ).toBe(false)
  })
})

describe('returns', () => {
  const original: TaxAmounts = {
    taxable_paise: 10_000,
    cgst_paise: 251,
    sgst_paise: 250,
    igst_paise: 0,
    cess_paise: 0,
  }
  const zero: TaxAmounts = { taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, cess_paise: 0 }
  const add = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => ({
    taxable_paise: a.taxable_paise + b.taxable_paise,
    cgst_paise: a.cgst_paise + b.cgst_paise,
    sgst_paise: a.sgst_paise + b.sgst_paise,
    igst_paise: a.igst_paise + b.igst_paise,
    cess_paise: a.cess_paise + b.cess_paise,
  })

  it('successive partial returns sum exactly to the original line', () => {
    let credited = zero
    let returned = 0
    for (const qty of [1000, 1000, 1000]) {
      const r = prorateReturnLine(original, { qty_milli: qty, total_qty_milli: 3000, returned_qty_milli: returned, credited })
      credited = add(credited, r)
      returned += qty
    }
    expect(credited).toEqual(original)
  })

  it('stays exact when a note in between is cancelled', () => {
    const first = prorateReturnLine(original, { qty_milli: 1000, total_qty_milli: 3000, returned_qty_milli: 0, credited: zero })
    const second = prorateReturnLine(original, {
      qty_milli: 1000,
      total_qty_milli: 3000,
      returned_qty_milli: 1000,
      credited: first,
    })
    // The first note is cancelled: only `second` is live; return the remaining 2 units.
    const last = prorateReturnLine(original, { qty_milli: 2000, total_qty_milli: 3000, returned_qty_milli: 1000, credited: second })
    expect(add(second, last)).toEqual(original)
    expect(last.total_paise + second.total_paise).toBe(10_501)
  })

  it('random partial-return sequences never drift', () => {
    const rng = createRng(77)
    for (let n = 0; n < 200; n++) {
      const orig: TaxAmounts = {
        taxable_paise: rng.int(0, 1_000_000),
        cgst_paise: rng.int(0, 90_000),
        sgst_paise: rng.int(0, 90_000),
        igst_paise: 0,
        cess_paise: rng.int(0, 1_000),
      }
      const total = rng.int(1, 50) * 500
      let credited = zero
      let returned = 0
      while (returned < total) {
        const qty = Math.min(total - returned, rng.int(1, 10) * 500)
        const r = prorateReturnLine(orig, { qty_milli: qty, total_qty_milli: total, returned_qty_milli: returned, credited })
        for (const v of Object.values(r)) expect(v).toBeGreaterThanOrEqual(0)
        credited = add(credited, r)
        returned += qty
      }
      expect(credited).toEqual(orig)
    }
  })

  it('rejects over-returns', () => {
    expect(() =>
      prorateReturnLine(original, { qty_milli: 2000, total_qty_milli: 3000, returned_qty_milli: 1500, credited: zero }),
    ).toThrow(RangeError)
  })

  it('returnable qty, restock defaults and settlement options', () => {
    expect(returnableQtyMilli({ qty_milli: 3000, returned_qty_milli: 1000 })).toBe(2000)
    expect(returnableQtyMilli({ qty_milli: 3000, free_qty_milli: 1000, returned_qty_milli: 4000 })).toBe(0)
    expect(defaultRestock('return')).toBe(true)
    expect(defaultRestock('expired')).toBe(false)
    expect(defaultRestock('damaged')).toBe(false)
    expect(
      creditNoteSettlementOptions({
        has_invoice: true,
        has_customer: false,
        invoice_due_paise: 0,
        refundable_paise: 10_000,
        total_paise: 5_000,
      }),
    ).toEqual(['cash', 'upi', 'bank_transfer'])
    expect(
      creditNoteSettlementOptions({
        has_invoice: true,
        has_customer: true,
        invoice_due_paise: 3_000,
        refundable_paise: 0,
        total_paise: 5_000,
      }),
    ).toEqual(['adjust_due', 'store_credit'])
    expect(
      creditNoteSettlementOptions({
        has_invoice: true,
        has_customer: false,
        invoice_due_paise: 3_000,
        refundable_paise: 0,
        total_paise: 5_000,
      }),
    ).toEqual([])
  })
})
