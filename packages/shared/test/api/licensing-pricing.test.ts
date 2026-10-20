import { describe, expect, it } from 'vitest'
import {
  PriceQuoteSchema,
  type PriceOrderInput,
  type PriceOrderLineInput,
  type PriceQuote,
  type PricingOffer,
  priceOrder,
} from '../../src/api/licensing'
import { mulDiv } from '../../src/math'
import { createRng, type Rng } from '../helpers/prng'

const NOW = '2026-10-20T06:00:00Z'
const TN = '33'

const line = (
  product_code: string,
  over: Partial<PriceOrderLineInput> = {},
): PriceOrderLineInput => {
  const book: Record<string, Omit<PriceOrderLineInput, 'product_code' | 'qty'>> = {
    onprem_starter: {
      kind: 'edition',
      unit_price_paise: 799_900,
      gst_rate_bp: 1800,
      term_months: null,
      included_amc_months: 12,
      renewal_price_paise: 159_900,
    },
    onprem_standard: {
      kind: 'edition',
      unit_price_paise: 1_499_900,
      gst_rate_bp: 1800,
      term_months: null,
      included_amc_months: 12,
      renewal_price_paise: 299_900,
    },
    onprem_pro_yearly: {
      kind: 'subscription',
      unit_price_paise: 899_900,
      gst_rate_bp: 1800,
      term_months: 12,
    },
    amc_renewal: { kind: 'amc', unit_price_paise: 299_900, gst_rate_bp: 1800, term_months: 12 },
    addon_counter: {
      kind: 'addon',
      unit_price_paise: 250_000,
      gst_rate_bp: 1800,
      term_months: null,
    },
    addon_connect: { kind: 'addon', unit_price_paise: 99_900, gst_rate_bp: 1800, term_months: 12 },
    service_installation: {
      kind: 'service',
      unit_price_paise: 150_000,
      gst_rate_bp: 1800,
      term_months: null,
    },
    cloud_growth_monthly: {
      kind: 'cloud_plan',
      unit_price_paise: 29_900,
      gst_rate_bp: 1800,
      term_months: 1,
    },
  }
  const p = book[product_code]
  if (!p) throw new Error(product_code)
  return { product_code, qty: 1, ...p, ...over }
}

let seq = 0
const offer = (
  over: Partial<PricingOffer> & Pick<PricingOffer, 'kind' | 'value'>,
): PricingOffer => {
  seq += 1
  return {
    id: `0192f7a4-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    code: null,
    name: `Offer ${seq}`,
    ...over,
  }
}

const input = (over: Partial<PriceOrderInput> = {}): PriceOrderInput => ({
  lines: [line('onprem_standard')],
  buyer: { channel: 'onprem', state_code: TN, business_type: 'pharmacy', segments: ['new'] },
  vendor_state_code: TN,
  now: NOW,
  ...over,
})

describe('priceOrder — GST & partner pricing', () => {
  it('intra-state: CGST + SGST at 18%', () => {
    const q = priceOrder(input())
    expect(q).toMatchObject({
      subtotal_paise: 1_499_900,
      discount_paise: 0,
      taxable_paise: 1_499_900,
      cgst_paise: 134_991,
      sgst_paise: 134_991,
      igst_paise: 0,
      tax_paise: 269_982,
      total_paise: 1_769_882,
      place_of_supply: '33',
      is_interstate: false,
      applied_offers: [],
      coupon: null,
    })
    expect(q.lines[0]).toMatchObject({ key: '1', sac: '997331', name: 'onprem_standard' })
    expect(PriceQuoteSchema.parse(q)).toEqual(q)
  })

  it('inter-state: IGST', () => {
    const q = priceOrder(input({ buyer: { channel: 'onprem', state_code: '29' } }))
    expect(q).toMatchObject({
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 269_982,
      total_paise: 1_769_882,
      place_of_supply: '29',
      is_interstate: true,
    })
  })

  it('odd tax splits CGST ≥ SGST by one paisa', () => {
    const q = priceOrder(input({ lines: [line('amc_renewal', { unit_price_paise: 100_003 })] }))
    // 100003 × 18% = 18000.54 → 18001 → cgst 9001 + sgst 9000
    expect(q).toMatchObject({ tax_paise: 18_001, cgst_paise: 9001, sgst_paise: 9000 })
  })

  it('partner discount comes off list first, per line', () => {
    const q = priceOrder(
      input({
        lines: [line('onprem_standard'), line('addon_counter', { qty: 2 })],
        partner_discount_bp: 2000,
      }),
    )
    expect(q.lines.map((l) => [l.gross_paise, l.partner_discount_paise, l.taxable_paise])).toEqual([
      [1_499_900, 299_980, 1_199_920],
      [500_000, 100_000, 400_000],
    ])
    // 1199920 × 18% = 215985.6 → 215986; 400000 → 72000
    expect(q.tax_paise).toBe(215_986 + 72_000)
    expect(q.partner_discount_paise).toBe(399_980)
    expect(q.discount_paise).toBe(399_980)
    expect(q.total_paise).toBe(1_199_920 + 400_000 + 215_986 + 72_000)
  })

  it('multiple GST rates are taxed per line', () => {
    const q = priceOrder(
      input({
        lines: [line('onprem_standard'), line('service_installation', { gst_rate_bp: 1200 })],
      }),
    )
    expect(q.lines.map((l) => l.tax_paise)).toEqual([269_982, 18_000])
  })

  it('validates lines', () => {
    expect(() => priceOrder(input({ lines: [line('amc_renewal', { qty: 0 })] }))).toThrow(
      RangeError,
    )
    expect(() =>
      priceOrder(input({ lines: [line('amc_renewal', { gst_rate_bp: 1700 })] })),
    ).toThrow(RangeError)
    expect(() =>
      priceOrder(input({ lines: [line('amc_renewal', { unit_price_paise: -1 })] })),
    ).toThrow(RangeError)
    expect(() => priceOrder(input({ lines: [line('amc_renewal', { term_months: 0 })] }))).toThrow(
      RangeError,
    )
    expect(() =>
      priceOrder(
        input({ lines: [line('amc_renewal', { key: 'a' }), line('addon_counter', { key: 'a' })] }),
      ),
    ).toThrow(RangeError)
    expect(() => priceOrder(input({ partner_discount_bp: 10_001 }))).toThrow(RangeError)
  })
})

describe('priceOrder — offer kinds', () => {
  it('percent on applicable products, with max_discount cap', () => {
    const deepavali = offer({ kind: 'percent', value: 2000, applies_to: ['onprem_standard'] })
    const lines = [line('onprem_standard'), line('addon_connect')]
    const q = priceOrder(input({ lines, offers: [deepavali] }))
    expect(q.lines.map((l) => l.offer_discount_paise)).toEqual([299_980, 0])
    expect(q.applied_offers).toEqual([
      expect.objectContaining({
        offer_id: deepavali.id,
        discount_paise: 299_980,
        free_months: 0,
        line_keys: ['1'],
      }),
    ])
    expect(q.offer_ids).toEqual([deepavali.id])
    expect(q.lines[0]!.offer_ids).toEqual([deepavali.id])
    const capped = priceOrder(
      input({ lines, offers: [{ ...deepavali, max_discount_paise: 250_000 }] }),
    )
    expect(capped.offer_discount_paise).toBe(250_000)
  })

  it('flat amount spread pro-rata, never more than the lines', () => {
    const flat = offer({ kind: 'flat', value: 100_000 })
    const q = priceOrder(
      input({ lines: [line('onprem_standard'), line('service_installation')], offers: [flat] }),
    )
    const parts = q.lines.map((l) => l.offer_discount_paise)
    expect(parts[0]! + parts[1]!).toBe(100_000)
    expect(parts[0]!).toBeGreaterThan(parts[1]!)
    expect(Math.abs(parts[1]! - mulDiv(100_000, 150_000, 1_649_900))).toBeLessThanOrEqual(1)
    const huge = priceOrder(
      input({ lines: [line('service_installation')], offers: [{ ...flat, value: 10_000_000 }] }),
    )
    expect(huge).toMatchObject({ taxable_paise: 0, total_paise: 0, offer_discount_paise: 150_000 })
  })

  it('price override lowers the unit price (× qty), never raises it', () => {
    const pongal = offer({
      kind: 'price_override',
      value: 1_199_900,
      applies_to: ['onprem_standard'],
    })
    const q = priceOrder(input({ lines: [line('onprem_standard', { qty: 2 })], offers: [pongal] }))
    expect(q.offer_discount_paise).toBe(600_000)
    const higher = priceOrder(input({ offers: [{ ...pongal, value: 2_000_000 }] }))
    expect(higher.offer_discount_paise).toBe(0)
    expect(higher.applied_offers).toEqual([])
  })

  it('free months extend terms and included AMC, and are valued for comparison', () => {
    const sixFree = offer({ kind: 'free_months', value: 6 })
    const amc = priceOrder(input({ lines: [line('amc_renewal')], offers: [sixFree] }))
    expect(amc).toMatchObject({ free_months: 6, offer_discount_paise: 0, total_paise: 353_882 })
    expect(amc.lines[0]).toMatchObject({ free_months: 6, term_months: 12 })
    expect(amc.applied_offers[0]).toMatchObject({ free_months: 6, discount_paise: 0 })

    // perpetual edition: extends the included AMC
    const edition = priceOrder(input({ offers: [sixFree] }))
    expect(edition.lines[0]!.free_months).toBe(6)
    // services / perpetual add-ons have no term → not applicable
    const svc = priceOrder(input({ lines: [line('service_installation')], offers: [sixFree] }))
    expect(svc.applied_offers).toEqual([])

    // 6 free AMC months (₹1,499.50 of value) beat 10% off AMC (₹299.90)
    const tenPct = offer({ kind: 'percent', value: 1000 })
    const best = priceOrder(input({ lines: [line('amc_renewal')], offers: [tenPct, sixFree] }))
    expect(best.offer_ids).toEqual([sixFree.id])
    // …but 20% off a ₹14,999 edition (₹2,999.80) beats 6 AMC months (₹1,499.50)
    const twenty = offer({ kind: 'percent', value: 2000 })
    const best2 = priceOrder(input({ offers: [twenty, sixFree] }))
    expect(best2.offer_ids).toEqual([twenty.id])
  })
})

describe('priceOrder — stacking & selection', () => {
  it('stackable offers combine; a better non-stackable offer wins alone', () => {
    const a = offer({ kind: 'percent', value: 1000, stackable: true })
    const b = offer({ kind: 'flat', value: 50_000, stackable: true })
    const combined = priceOrder(input({ offers: [a, b] }))
    // 10% = 149990, then ₹500 off the rest
    expect(combined.offer_discount_paise).toBe(199_990)
    expect(combined.applied_offers.map((x) => x.offer_id)).toEqual([a.id, b.id])

    const c = offer({ kind: 'percent', value: 1500 })
    const alone = priceOrder(input({ offers: [a, b, c] }))
    expect(alone.offer_ids).toEqual([c.id])
    expect(alone.offer_discount_paise).toBe(224_985)

    const weak = offer({ kind: 'percent', value: 1200 })
    const stack = priceOrder(input({ offers: [a, b, weak] }))
    expect(stack.offer_ids).toEqual([a.id, b.id])
  })

  it('stackable order: price override → percent → flat → free months', () => {
    const flat = offer({ kind: 'flat', value: 100_000, stackable: true })
    const pct = offer({ kind: 'percent', value: 1000, stackable: true })
    const over = offer({ kind: 'price_override', value: 1_299_900, stackable: true })
    const months = offer({ kind: 'free_months', value: 3, stackable: true })
    const q = priceOrder(input({ offers: [flat, months, pct, over] }))
    expect(q.applied_offers.map((x) => x.kind)).toEqual([
      'price_override',
      'percent',
      'flat',
      'free_months',
    ])
    // 1499900 → override 1299900 → −10% 129990 → −100000
    expect(q.offer_discount_paise).toBe(200_000 + 129_990 + 100_000)
    expect(q.free_months).toBe(3)
  })

  it('ignores coded offers in the automatic list and duplicates', () => {
    const coded = offer({ kind: 'percent', value: 5000, code: 'SECRET' })
    const auto = offer({ kind: 'percent', value: 1000 })
    const q = priceOrder(input({ offers: [coded, auto, auto] }))
    expect(q.offer_ids).toEqual([auto.id])
  })

  it('automatic campaigns honour audience, schedule and limits', () => {
    const forApparel = offer({
      kind: 'percent',
      value: 3000,
      audience: { business_types: ['apparel'] },
    })
    const ended = offer({ kind: 'percent', value: 3000, ends_at: '2026-10-01T00:00:00Z' })
    const minOrder = offer({
      kind: 'flat',
      value: 50_000,
      audience: { min_order_paise: 2_000_000 },
    })
    const exhausted = offer({
      kind: 'percent',
      value: 3000,
      max_redemptions: 10,
      redeemed_count: 10,
    })
    const lapsed = offer({ kind: 'percent', value: 3000, audience: { segment: 'lapsed_amc' } })
    const q = priceOrder(input({ offers: [forApparel, ended, minOrder, exhausted, lapsed] }))
    expect(q.applied_offers).toEqual([])
    const lapsedBuyer = priceOrder(
      input({
        offers: [lapsed],
        buyer: { channel: 'onprem', state_code: TN, segments: ['existing', 'lapsed_amc'] },
      }),
    )
    expect(lapsedBuyer.offer_ids).toEqual([lapsed.id])
  })
})

describe('priceOrder — coupons', () => {
  const auto20 = offer({ kind: 'percent', value: 2000 })

  it('unknown code', () => {
    const q = priceOrder(input({ coupon_code: ' nope ', coupon: null }))
    expect(q.coupon).toEqual({ code: 'NOPE', status: 'invalid', reason: 'unknown_code' })
    expect(q.offer_discount_paise).toBe(0)
  })

  it('applied, and reported in offer_ids', () => {
    const c = offer({ kind: 'percent', value: 2500, code: 'PONGAL25' })
    const q = priceOrder(input({ coupon_code: 'pongal25', coupon: c, offers: [auto20] }))
    expect(q.coupon).toEqual({ code: 'PONGAL25', status: 'applied', reason: null })
    expect(q.offer_ids).toEqual([c.id])
  })

  it('a better automatic offer → not_better', () => {
    const c = offer({ kind: 'percent', value: 1000, code: 'TEN' })
    const q = priceOrder(input({ coupon_code: 'TEN', coupon: c, offers: [auto20] }))
    expect(q.coupon).toEqual({ code: 'TEN', status: 'not_better', reason: 'better_offer_applied' })
    expect(q.offer_ids).toEqual([auto20.id])
  })

  it('ties prefer the entered coupon', () => {
    const c = offer({ kind: 'percent', value: 2000, code: 'TWENTY' })
    const q = priceOrder(input({ coupon_code: 'TWENTY', coupon: c, offers: [auto20] }))
    expect(q.coupon?.status).toBe('applied')
    expect(q.offer_ids).toEqual([c.id])
  })

  it('stackable coupon combines with stackable campaigns', () => {
    const camp = offer({ kind: 'percent', value: 1000, stackable: true })
    const c = offer({ kind: 'flat', value: 100_000, code: 'EXPO', stackable: true })
    const q = priceOrder(input({ coupon_code: 'EXPO', coupon: c, offers: [camp] }))
    expect(q.coupon?.status).toBe('applied')
    expect(q.offer_ids.sort()).toEqual([camp.id, c.id].sort())
  })

  it('ineligible coupons explain why', () => {
    const expired = offer({
      kind: 'percent',
      value: 5000,
      code: 'OLD',
      ends_at: '2026-01-01T00:00:00Z',
    })
    expect(priceOrder(input({ coupon_code: 'OLD', coupon: expired })).coupon).toEqual({
      code: 'OLD',
      status: 'not_eligible',
      reason: 'ended',
    })
    const proOnly = offer({ kind: 'percent', value: 5000, code: 'PRO', applies_to: ['onprem_pro'] })
    expect(priceOrder(input({ coupon_code: 'PRO', coupon: proOnly })).coupon).toMatchObject({
      status: 'not_eligible',
      reason: 'not_applicable',
    })
    const partnerOnly = offer({
      kind: 'percent',
      value: 5000,
      code: 'DEALER',
      partner_id: '0192f7a4-0000-7000-8000-0000000000ff',
    })
    expect(priceOrder(input({ coupon_code: 'DEALER', coupon: partnerOnly })).coupon).toMatchObject({
      status: 'not_eligible',
      reason: 'partner_only',
    })
    expect(
      priceOrder(
        input({
          coupon_code: 'DEALER',
          coupon: partnerOnly,
          buyer: { channel: 'onprem', state_code: TN, partner_id: partnerOnly.partner_id },
        }),
      ).coupon?.status,
    ).toBe('applied')
    const usedUp = offer({
      kind: 'percent',
      value: 5000,
      code: 'ONCE',
      per_customer_limit: 1,
      customer_redeemed_count: 1,
    })
    expect(priceOrder(input({ coupon_code: 'ONCE', coupon: usedUp })).coupon?.reason).toBe(
      'customer_limit',
    )
    const cloudOnly = offer({ kind: 'percent', value: 5000, code: 'CLOUD', channel: 'cloud' })
    expect(priceOrder(input({ coupon_code: 'CLOUD', coupon: cloudOnly })).coupon?.reason).toBe(
      'channel',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Property tests (seeded, reproducible)
// ---------------------------------------------------------------------------------------------

const PRODUCTS = [
  'onprem_starter',
  'onprem_standard',
  'onprem_pro_yearly',
  'amc_renewal',
  'addon_counter',
  'addon_connect',
  'service_installation',
  'cloud_growth_monthly',
] as const

function randomOffer(rng: Rng, code: string | null = null): PricingOffer {
  const kind = rng.pick(['percent', 'flat', 'free_months', 'price_override'] as const)
  const value =
    kind === 'percent'
      ? rng.int(0, 10_000)
      : kind === 'flat'
        ? rng.int(0, 3_000_000)
        : kind === 'free_months'
          ? rng.int(1, 12)
          : rng.int(0, 2_000_000)
  return offer({
    kind,
    value,
    code,
    stackable: rng.bool(0.5),
    max_discount_paise: rng.bool(0.3) ? rng.int(0, 500_000) : null,
    applies_to: rng.bool(0.4) ? [rng.pick(PRODUCTS), rng.pick(PRODUCTS)] : [],
    audience: rng.bool(0.2)
      ? { business_types: [rng.pick(['pharmacy', 'apparel'] as const)] }
      : rng.bool(0.1)
        ? { min_order_paise: rng.int(0, 3_000_000) }
        : {},
    ends_at: rng.bool(0.1) ? '2026-01-01T00:00:00Z' : null,
  })
}

function randomInput(rng: Rng): PriceOrderInput {
  const n = rng.int(1, 4)
  const codes = new Set<string>()
  while (codes.size < n) codes.add(rng.pick(PRODUCTS))
  const lines = [...codes].map((code) =>
    line(code, {
      qty: rng.int(1, 5),
      gst_rate_bp: rng.pick([1800, 1800, 1800, 1200, 500, 0] as const),
      ...(rng.bool(0.2) ? { unit_price_paise: rng.int(0, 5_000_000) } : {}),
    }),
  )
  const offers = Array.from({ length: rng.int(0, 4) }, () => randomOffer(rng))
  const coupon = rng.bool(0.4) ? randomOffer(rng, 'CODE') : null
  return input({
    lines,
    offers,
    coupon,
    coupon_code: coupon ? 'CODE' : rng.bool(0.1) ? 'UNKNOWN' : null,
    partner_discount_bp: rng.bool(0.3) ? rng.pick([2000, 2500, 3000, 1234]) : 0,
    buyer: {
      channel: 'onprem',
      state_code: rng.pick(['33', '33', '29', '32']),
      business_type: rng.pick(['pharmacy', 'general_store'] as const),
      segments: ['existing'],
    },
  })
}

/** Buyer value of a quote: offer discounts + free months valued like priceOrder does. */
function quoteValue(q: PriceQuote, inp: PriceOrderInput): number {
  return q.lines.reduce((sum, l, i) => {
    const src = inp.lines[i]!
    const base = l.gross_paise - l.partner_discount_paise
    const fm = l.free_months
    const months =
      fm <= 0
        ? 0
        : (src.term_months ?? 0) > 0
          ? mulDiv(base, fm, src.term_months!)
          : mulDiv((src.renewal_price_paise ?? 0) * src.qty, fm, 12)
    return sum + l.offer_discount_paise + months
  }, 0)
}

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('priceOrder — properties', () => {
  const ITERATIONS = 600

  it('totals reconcile, GST splits correctly, discounts stay within lines', () => {
    const rng = createRng(20261020)
    for (let it = 0; it < ITERATIONS; it++) {
      const inp = randomInput(rng)
      const q = priceOrder(inp)
      expect(PriceQuoteSchema.safeParse(q).success).toBe(true)
      const interstate = inp.buyer.state_code !== inp.vendor_state_code
      expect(q.is_interstate).toBe(interstate)
      for (const l of q.lines) {
        expect(l.gross_paise).toBe(l.qty * l.unit_price_paise)
        expect(l.discount_paise).toBe(l.partner_discount_paise + l.offer_discount_paise)
        expect(l.taxable_paise).toBe(l.gross_paise - l.discount_paise)
        expect(l.taxable_paise).toBeGreaterThanOrEqual(0)
        expect(l.tax_paise).toBe(mulDiv(l.taxable_paise, l.gst_rate_bp, 10_000))
        expect(l.cgst_paise + l.sgst_paise + l.igst_paise).toBe(l.tax_paise)
        if (interstate) {
          expect(l.cgst_paise + l.sgst_paise).toBe(0)
        } else {
          expect(l.igst_paise).toBe(0)
          expect(l.cgst_paise - l.sgst_paise).toBeGreaterThanOrEqual(0)
          expect(l.cgst_paise - l.sgst_paise).toBeLessThanOrEqual(1)
        }
        expect(l.total_paise).toBe(l.taxable_paise + l.tax_paise)
      }
      const sum = (f: (l: PriceQuote['lines'][number]) => number) =>
        q.lines.reduce((s, l) => s + f(l), 0)
      expect(q.subtotal_paise).toBe(sum((l) => l.gross_paise))
      expect(q.taxable_paise).toBe(sum((l) => l.taxable_paise))
      expect(q.total_paise).toBe(q.taxable_paise + q.cgst_paise + q.sgst_paise + q.igst_paise)
      expect(q.total_paise).toBe(sum((l) => l.total_paise))
      expect(q.discount_paise).toBe(q.partner_discount_paise + q.offer_discount_paise)
      expect(q.applied_offers.reduce((s, a) => s + a.discount_paise, 0)).toBe(
        q.offer_discount_paise,
      )
      for (const a of q.applied_offers) {
        const src = [...(inp.offers ?? []), inp.coupon].find((o) => o?.id === a.offer_id)!
        if (src.max_discount_paise != null)
          expect(a.discount_paise).toBeLessThanOrEqual(src.max_discount_paise)
        expect(a.discount_paise > 0 || a.free_months > 0).toBe(true)
      }
      if (q.coupon?.status === 'applied') expect(q.offer_ids).toContain(inp.coupon!.id)
      else if (inp.coupon) expect(q.offer_ids).not.toContain(inp.coupon.id)
    }
  })

  it('the chosen option is worth at least any single eligible offer', () => {
    const rng = createRng(777)
    for (let it = 0; it < ITERATIONS; it++) {
      const inp = randomInput(rng)
      const q = priceOrder(inp)
      const best = quoteValue(q, inp)
      for (const o of inp.offers ?? []) {
        if (o.code != null) continue
        const single = { ...inp, offers: [o], coupon: null, coupon_code: null }
        expect(best).toBeGreaterThanOrEqual(quoteValue(priceOrder(single), single))
      }
      if (inp.coupon) {
        const single = { ...inp, offers: [] }
        expect(best).toBeGreaterThanOrEqual(quoteValue(priceOrder(single), single))
      }
    }
  })

  it('does not depend on the order of the offers', () => {
    const rng = createRng(4242)
    for (let it = 0; it < ITERATIONS; it++) {
      const inp = randomInput(rng)
      const a = priceOrder(inp)
      const b = priceOrder({ ...inp, offers: shuffle(rng, inp.offers ?? []) })
      expect(b).toEqual(a)
    }
  })

  it('adding an eligible offer never lowers the buyer value', () => {
    const rng = createRng(99)
    for (let it = 0; it < ITERATIONS; it++) {
      const inp = randomInput(rng)
      const before = quoteValue(priceOrder(inp), inp)
      const more = { ...inp, offers: [...(inp.offers ?? []), randomOffer(rng)] }
      expect(quoteValue(priceOrder(more), more)).toBeGreaterThanOrEqual(before)
    }
  })
})
