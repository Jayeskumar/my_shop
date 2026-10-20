import { describe, expect, it } from 'vitest'
import { GST_RATES_BP } from '../src/gst'
import {
  TaxSlabsSchema,
  computeDocument,
  computeLine,
  computePurchaseDocument,
  computePurchaseLine,
  landedUnitCostPaise,
  lineNetBeforeBillDiscount,
  prorateAmounts,
  resolveSlabRate,
  type DocumentInput,
  type LineInput,
  type TaxMode,
  type TaxSlab,
} from '../src/pricing'
import { createRng } from './helpers/prng'

const intra = { is_interstate: false, tax_mode: 'regular' as const }
const line = (over: Partial<LineInput>): LineInput => ({
  key: 'l1',
  unit_price_paise: 10000,
  qty_milli: 1000,
  price_includes_tax: false,
  gst_rate_bp: 1800,
  ...over,
})
const APPAREL: TaxSlab[] = [
  { max_unit_value_paise: 250000, gst_rate_bp: 500 },
  { max_unit_value_paise: null, gst_rate_bp: 1800 },
]

describe('computeLine — worked examples', () => {
  it('exclusive 18%, 2 units', () => {
    expect(computeLine(line({ qty_milli: 2000 }), intra)).toMatchObject({
      gross_paise: 20000,
      taxable_paise: 20000,
      cgst_paise: 1800,
      sgst_paise: 1800,
      igst_paise: 0,
      cess_paise: 0,
      total_paise: 23600,
      discount_paise: 0,
      gst_rate_bp: 1800,
    })
  })
  it('inclusive 18% backs tax out of the price', () => {
    expect(
      computeLine(line({ unit_price_paise: 11800, price_includes_tax: true }), intra),
    ).toMatchObject({
      taxable_paise: 10000,
      cgst_paise: 900,
      sgst_paise: 900,
      total_paise: 11800,
    })
  })
  it('inclusive 5% with an odd amount: taxable rounded, GST is the residual', () => {
    // 9999 × 10000 / 10500 = 9522.857 → 9523; gst = 476 → 238 + 238
    expect(
      computeLine(
        line({ unit_price_paise: 9999, price_includes_tax: true, gst_rate_bp: 500 }),
        intra,
      ),
    ).toMatchObject({
      taxable_paise: 9523,
      cgst_paise: 238,
      sgst_paise: 238,
      total_paise: 9999,
    })
  })
  it('odd GST paisa goes to CGST (sgst = floor)', () => {
    // exclusive 1234 × 5% = 61.7 → 62 → cgst 31, sgst 31; 1250 × 5% = 62.5 → 63 → 32 + 31
    expect(computeLine(line({ unit_price_paise: 1250, gst_rate_bp: 500 }), intra)).toMatchObject({
      cgst_paise: 32,
      sgst_paise: 31,
      total_paise: 1313,
    })
  })
  it('inclusive 28% + 12% cess', () => {
    // taxable = round(10000 × 10000 / 14000) = 7143; cess = round(857.16) = 857; gst = 2000
    expect(
      computeLine(
        line({
          unit_price_paise: 10000,
          price_includes_tax: true,
          gst_rate_bp: 2800,
          cess_rate_bp: 1200,
        }),
        intra,
      ),
    ).toMatchObject({
      taxable_paise: 7143,
      cess_paise: 857,
      cgst_paise: 1000,
      sgst_paise: 1000,
      total_paise: 10000,
      cess_rate_bp: 1200,
    })
  })
  it('exclusive with cess', () => {
    expect(
      computeLine(line({ unit_price_paise: 10000, gst_rate_bp: 4000, cess_rate_bp: 0 }), intra)
        .total_paise,
    ).toBe(14000)
    expect(
      computeLine(line({ unit_price_paise: 10000, gst_rate_bp: 2800, cess_rate_bp: 1200 }), intra),
    ).toMatchObject({
      cess_paise: 1200,
      cgst_paise: 1400,
      sgst_paise: 1400,
      total_paise: 14000,
    })
  })
  it('caps cess for tiny inclusive amounts with very high cess so GST never goes negative', () => {
    // taxable = round(3 × 10000 / 41800) = 1; cess = round(1 × 2.9) = 3 > 3 − 1 → capped to 2
    const r = computeLine(
      line({
        unit_price_paise: 3,
        price_includes_tax: true,
        gst_rate_bp: 2800,
        cess_rate_bp: 29000,
      }),
      intra,
    )
    expect(r).toMatchObject({
      taxable_paise: 1,
      cess_paise: 2,
      cgst_paise: 0,
      sgst_paise: 0,
      total_paise: 3,
    })
  })
  it('pharmacy: 3 loose tablets from a ₹35 strip of 10 at 5% inclusive', () => {
    expect(
      computeLine(
        line({
          unit_price_paise: 3500,
          qty_milli: 3000,
          pack_size: 10,
          price_includes_tax: true,
          gst_rate_bp: 500,
        }),
        intra,
      ),
    ).toMatchObject({
      gross_paise: 1050,
      taxable_paise: 1000,
      cgst_paise: 25,
      sgst_paise: 25,
      total_paise: 1050,
    })
  })
  it('weighed goods: 1.25 kg rice at ₹62/kg, 5% inclusive', () => {
    expect(
      computeLine(
        line({
          unit_price_paise: 6200,
          qty_milli: 1250,
          price_includes_tax: true,
          gst_rate_bp: 500,
        }),
        intra,
      ),
    ).toMatchObject({
      gross_paise: 7750,
      taxable_paise: 7381,
      cgst_paise: 185,
      sgst_paise: 184,
      total_paise: 7750,
    })
  })
  it('percentage + flat item discount', () => {
    expect(computeLine(line({ discount_bp: 1000, discount_paise: 500 }), intra)).toMatchObject({
      gross_paise: 10000,
      item_discount_paise: 1500,
      discount_paise: 1500,
      taxable_paise: 8500,
      cgst_paise: 765,
      sgst_paise: 765,
      total_paise: 10030,
    })
  })
  it('discount larger than gross is capped (never negative)', () => {
    expect(computeLine(line({ discount_paise: 20000 }), intra)).toMatchObject({
      item_discount_paise: 10000,
      taxable_paise: 0,
      cgst_paise: 0,
      total_paise: 0,
    })
    expect(computeLine(line({ discount_bp: 10000 }), intra).total_paise).toBe(0)
  })
  it('allocated bill discount is applied after item discount and capped at net', () => {
    expect(
      computeLine(line({ discount_paise: 2000 }), {
        ...intra,
        allocated_bill_discount_paise: 1000,
      }),
    ).toMatchObject({
      item_discount_paise: 2000,
      bill_discount_paise: 1000,
      discount_paise: 3000,
      taxable_paise: 7000,
    })
    expect(computeLine(line({}), { ...intra, allocated_bill_discount_paise: 99999 })).toMatchObject(
      {
        bill_discount_paise: 10000,
        total_paise: 0,
      },
    )
  })
  it('interstate puts all GST in IGST', () => {
    expect(computeLine(line({}), { is_interstate: true, tax_mode: 'regular' })).toMatchObject({
      igst_paise: 1800,
      cgst_paise: 0,
      sgst_paise: 0,
      total_paise: 11800,
    })
  })
  it.each<TaxMode>(['composition', 'unregistered'])(
    '%s charges no tax (inclusive and exclusive)',
    (tax_mode) => {
      for (const price_includes_tax of [true, false]) {
        expect(
          computeLine(line({ unit_price_paise: 11800, price_includes_tax, cess_rate_bp: 100 }), {
            is_interstate: false,
            tax_mode,
          }),
        ).toMatchObject({
          taxable_paise: 11800,
          cgst_paise: 0,
          sgst_paise: 0,
          igst_paise: 0,
          cess_paise: 0,
          total_paise: 11800,
          gst_rate_bp: 0,
          cess_rate_bp: 0,
        })
      }
    },
  )
  it('0% GST: taxable = net, no cess', () => {
    expect(
      computeLine(line({ gst_rate_bp: 0, cess_rate_bp: 500, price_includes_tax: true }), intra),
    ).toMatchObject({
      taxable_paise: 10000,
      cess_paise: 0,
      total_paise: 10000,
      gst_rate_bp: 0,
    })
  })
  it('MRP savings include free quantity', () => {
    const base = line({
      unit_price_paise: 11000,
      qty_milli: 2000,
      price_includes_tax: true,
      gst_rate_bp: 500,
      mrp_paise: 12000,
    })
    expect(computeLine(base, intra).mrp_savings_paise).toBe(2000)
    expect(computeLine({ ...base, free_qty_milli: 1000 }, intra).mrp_savings_paise).toBe(14000)
    expect(computeLine({ ...base, mrp_paise: 10000 }, intra).mrp_savings_paise).toBe(0)
    expect(computeLine({ ...base, mrp_paise: null }, intra).mrp_savings_paise).toBe(0)
  })
  it('handles amounts beyond the float-safe product range exactly', () => {
    // ₹9,99,999.99 per kg × 99,999.999 kg
    const r = computeLine(
      line({ unit_price_paise: 99999999, qty_milli: 99999999, price_includes_tax: true }),
      intra,
    )
    expect(r.gross_paise).toBe(9999999800000)
    expect(r.total_paise).toBe(r.gross_paise)
  })
  it.each<[string, Partial<LineInput>]>([
    ['zero qty', { qty_milli: 0 }],
    ['negative qty', { qty_milli: -1000 }],
    ['fractional qty', { qty_milli: 1.5 }],
    ['negative price', { unit_price_paise: -1 }],
    ['pack size 0', { pack_size: 0 }],
    ['rate > 100%', { gst_rate_bp: 10001 }],
    ['negative discount', { discount_paise: -1 }],
    ['discount > 100%', { discount_bp: 10001 }],
    ['fractional rate', { gst_rate_bp: 12.5 }],
  ])('rejects invalid input: %s', (_name, over) => {
    expect(() => computeLine(line(over), intra)).toThrow(RangeError)
  })
})

describe('resolveSlabRate (price-slab GST)', () => {
  const r = (net: number, qty: number, inclusive: boolean, slabs = APPAREL) =>
    resolveSlabRate(slabs, { net_paise: net, qty_milli: qty, price_includes_tax: inclusive })
      .gst_rate_bp
  it.each([
    [250000, 1000, false, 500],
    [250001, 1000, false, 1800],
    [262500, 1000, true, 500], // 2625 / 1.05 = 2500.00 exactly
    [262501, 1000, true, 1800],
    [787500, 3000, true, 500], // three pieces at 2625
    [787503, 3000, true, 1800], // 2625.01 per piece
    [0, 1000, true, 500],
    [295000, 1000, true, 1800], // 2950 / 1.18 = 2500 → not ≤ 2500 at the 5% slab (2809.5)
  ])('net %d for qty %d (inclusive %s) → %d bp', (net, qty, inclusive, expected) => {
    expect(r(net, qty, inclusive)).toBe(expected)
  })
  it('accounts for cess on inclusive prices', () => {
    expect(
      resolveSlabRate(APPAREL, {
        net_paise: 262500,
        qty_milli: 1000,
        price_includes_tax: true,
        cess_rate_bp: 100,
      }).gst_rate_bp,
    ).toBe(500)
    expect(
      resolveSlabRate(APPAREL, {
        net_paise: 265000,
        qty_milli: 1000,
        price_includes_tax: true,
        cess_rate_bp: 0,
      }).gst_rate_bp,
    ).toBe(1800)
    expect(
      resolveSlabRate(APPAREL, {
        net_paise: 265000,
        qty_milli: 1000,
        price_includes_tax: true,
        cess_rate_bp: 100,
      }).gst_rate_bp,
    ).toBe(500)
  })
  it('falls back to the last slab when all are bounded', () => {
    const bounded: TaxSlab[] = [
      { max_unit_value_paise: 100000, gst_rate_bp: 500 },
      { max_unit_value_paise: 200000, gst_rate_bp: 1200 },
    ]
    expect(
      resolveSlabRate(bounded, { net_paise: 999999, qty_milli: 1000, price_includes_tax: false }),
    ).toEqual({ gst_rate_bp: 1200, slab_index: 1 })
    expect(() =>
      resolveSlabRate([], { net_paise: 1, qty_milli: 1000, price_includes_tax: false }),
    ).toThrow(RangeError)
  })
  it('computeLine resolves the slab from the net after discounts', () => {
    // ₹2,700 shirt inclusive → 18%; with 10% off → ₹2,430 → 5%
    const shirt = line({
      unit_price_paise: 270000,
      price_includes_tax: true,
      gst_rate_bp: 1800,
      tax_slabs: APPAREL,
    })
    expect(computeLine(shirt, intra).gst_rate_bp).toBe(1800)
    const discounted = computeLine({ ...shirt, discount_bp: 1000 }, intra)
    expect(discounted).toMatchObject({
      gst_rate_bp: 500,
      taxable_paise: 231429,
      total_paise: 243000,
    })
    // bill discount also counts: allocated through computeDocument
    const doc = computeDocument({
      lines: [shirt],
      is_interstate: false,
      tax_mode: 'regular',
      bill_discount_bp: 1000,
      round_off: 'none',
    })
    expect(doc.lines[0]!.gst_rate_bp).toBe(500)
  })
  it('TaxSlabsSchema validates ordering and open-ended last slab', () => {
    expect(TaxSlabsSchema.safeParse(APPAREL).success).toBe(true)
    expect(TaxSlabsSchema.safeParse([]).success).toBe(false)
    expect(
      TaxSlabsSchema.safeParse([
        { max_unit_value_paise: null, gst_rate_bp: 500 },
        { max_unit_value_paise: 100, gst_rate_bp: 1800 },
      ]).success,
    ).toBe(false)
    expect(
      TaxSlabsSchema.safeParse([
        { max_unit_value_paise: 200, gst_rate_bp: 500 },
        { max_unit_value_paise: 100, gst_rate_bp: 1800 },
      ]).success,
    ).toBe(false)
    expect(
      TaxSlabsSchema.safeParse([{ max_unit_value_paise: 200, gst_rate_bp: 550 }]).success,
    ).toBe(false)
  })
})

describe('computeDocument — worked examples', () => {
  it('allocates a flat bill discount pro-rata (largest remainder) on inclusive values', () => {
    const doc = computeDocument({
      lines: [
        line({ key: 'a', unit_price_paise: 11800, price_includes_tax: true, gst_rate_bp: 1800 }),
        line({
          key: 'b',
          unit_price_paise: 5000,
          qty_milli: 2000,
          price_includes_tax: true,
          gst_rate_bp: 500,
        }),
      ],
      is_interstate: false,
      tax_mode: 'regular',
      bill_discount_paise: 1000,
      round_off: 'nearest_rupee',
    })
    expect(doc.lines.map((l) => l.bill_discount_paise)).toEqual([541, 459])
    expect(doc.lines[0]).toMatchObject({
      taxable_paise: 9542,
      cgst_paise: 859,
      sgst_paise: 858,
      total_paise: 11259,
    })
    expect(doc.lines[1]).toMatchObject({
      taxable_paise: 9087,
      cgst_paise: 227,
      sgst_paise: 227,
      total_paise: 9541,
    })
    expect(doc).toMatchObject({
      gross_paise: 21800,
      item_discount_paise: 0,
      bill_discount_paise: 1000,
      taxable_paise: 18629,
      cgst_paise: 1086,
      sgst_paise: 1085,
      igst_paise: 0,
      cess_paise: 0,
      tax_paise: 2171,
      round_off_paise: 0,
      total_paise: 20800,
    })
    expect(doc.tax_breakup).toEqual([
      {
        gst_rate_bp: 500,
        taxable_paise: 9087,
        cgst_paise: 227,
        sgst_paise: 227,
        igst_paise: 0,
        cess_paise: 0,
      },
      {
        gst_rate_bp: 1800,
        taxable_paise: 9542,
        cgst_paise: 859,
        sgst_paise: 858,
        igst_paise: 0,
        cess_paise: 0,
      },
    ])
  })
  it('rounds the payable to the nearest rupee', () => {
    const doc = computeDocument({
      lines: [line({ unit_price_paise: 9999 })],
      is_interstate: false,
      tax_mode: 'regular',
      round_off: 'nearest_rupee',
    })
    expect(doc).toMatchObject({
      taxable_paise: 9999,
      tax_paise: 1800,
      round_off_paise: 1,
      total_paise: 11800,
    })
    const none = computeDocument({
      lines: [line({ unit_price_paise: 9999 })],
      is_interstate: false,
      tax_mode: 'regular',
      round_off: 'none',
    })
    expect(none).toMatchObject({ round_off_paise: 0, total_paise: 11799 })
  })
  it('percentage bill discount on top of item discounts, plus flat', () => {
    const doc = computeDocument({
      lines: [line({ key: 'a', discount_bp: 1000 }), line({ key: 'b', unit_price_paise: 5000 })],
      is_interstate: false,
      tax_mode: 'regular',
      bill_discount_bp: 1000,
      bill_discount_paise: 100,
      round_off: 'none',
    })
    // nets 9000 + 5000 = 14000; bill = 100 + 1400 = 1500 → 964.29/535.71 → 964 / 536
    expect(doc.bill_discount_paise).toBe(1500)
    expect(doc.lines.map((l) => l.bill_discount_paise)).toEqual([964, 536])
  })
  it('bill discount cannot exceed the bill', () => {
    const doc = computeDocument({
      lines: [line({})],
      is_interstate: false,
      tax_mode: 'regular',
      bill_discount_paise: 50000,
      round_off: 'nearest_rupee',
    })
    expect(doc).toMatchObject({ bill_discount_paise: 10000, total_paise: 0, round_off_paise: 0 })
  })
  it('empty document is all zeros', () => {
    const doc = computeDocument({
      lines: [],
      is_interstate: false,
      tax_mode: 'regular',
      bill_discount_paise: 100,
      round_off: 'nearest_rupee',
    })
    expect(doc).toMatchObject({ total_paise: 0, bill_discount_paise: 0, tax_breakup: [] })
  })
  it('rejects duplicate keys', () => {
    expect(() =>
      computeDocument({
        lines: [line({}), line({})],
        is_interstate: false,
        tax_mode: 'regular',
        round_off: 'none',
      }),
    ).toThrow(/duplicate/)
  })
  it('lineNetBeforeBillDiscount', () => {
    expect(lineNetBeforeBillDiscount(line({ discount_bp: 2500 }))).toBe(7500)
  })
})

describe('computeDocument — randomized invariants', () => {
  const rng = createRng(20261020)
  const randomLine = (i: number): LineInput => {
    const decimal = rng.bool(0.3)
    const pack = rng.bool(0.2) ? rng.pick([10, 15, 30]) : 1
    return {
      key: `k${i}`,
      unit_price_paise: rng.bool(0.05) ? 0 : rng.int(1, rng.bool(0.1) ? 50_000_000 : 500_000),
      qty_milli: decimal ? rng.int(1, 25_000) : rng.int(1, 40) * 1000,
      pack_size: pack,
      price_includes_tax: rng.bool(0.7),
      gst_rate_bp: rng.pick(GST_RATES_BP),
      cess_rate_bp: rng.bool(0.1) ? rng.pick([100, 1200, 2200, 29000]) : 0,
      discount_bp: rng.bool(0.3) ? rng.int(0, 10000) : 0,
      discount_paise: rng.bool(0.2) ? rng.int(0, 50_000) : 0,
      mrp_paise: rng.bool(0.5) ? rng.int(0, 600_000) : null,
      free_qty_milli: rng.bool(0.1) ? rng.int(0, 5) * 1000 : 0,
      tax_slabs: rng.bool(0.1) ? APPAREL : null,
    }
  }

  it('holds for 4,000 random carts', () => {
    let iter = 0
    let current: DocumentInput | undefined
    // Plain checks inside the hot loop (expect() per assertion is too slow for 4k carts).
    const check = (ok: boolean, what: string): void => {
      if (!ok)
        throw new Error(
          `invariant failed at iteration ${iter}: ${what}\n${JSON.stringify(current)}`,
        )
    }
    for (iter = 0; iter < 4000; iter++) {
      const input: DocumentInput = {
        lines: Array.from({ length: rng.int(0, 15) }, (_, i) => randomLine(i)),
        is_interstate: rng.bool(0.2),
        tax_mode: rng.pick<TaxMode>([
          'regular',
          'regular',
          'regular',
          'composition',
          'unregistered',
        ]),
        bill_discount_bp: rng.bool(0.3) ? rng.int(0, 5000) : 0,
        bill_discount_paise: rng.bool(0.3) ? rng.int(0, 100_000) : 0,
        round_off: rng.bool(0.8) ? 'nearest_rupee' : 'none',
      }
      current = input
      const doc = computeDocument(input)
      const sum = (f: (l: (typeof doc.lines)[number]) => number) =>
        doc.lines.reduce((s, l) => s + f(l), 0)

      // Σ line totals + round_off = total; total = taxable + taxes + round_off
      check(
        sum((l) => l.total_paise) + doc.round_off_paise === doc.total_paise,
        'sum((l) => l.total_paise) + doc.round_off_paise === doc.total_paise',
      )
      check(
        doc.taxable_paise +
          doc.cgst_paise +
          doc.sgst_paise +
          doc.igst_paise +
          doc.cess_paise +
          doc.round_off_paise ===
          doc.total_paise,
        'doc.taxable_paise + doc.cgst_paise + doc.sgst_paise + doc.igst_paise + doc.cess_',
      )
      check(
        doc.tax_paise === doc.cgst_paise + doc.sgst_paise + doc.igst_paise + doc.cess_paise,
        'doc.tax_paise === doc.cgst_paise + doc.sgst_paise + doc.igst_paise + doc.cess_pa',
      )
      check(
        Math.abs(doc.round_off_paise) <= (input.round_off === 'none' ? 0 : 50),
        'round-off within bounds',
      )
      if (input.round_off === 'nearest_rupee')
        check(Math.abs(doc.total_paise % 100) === 0, 'Math.abs(doc.total_paise % 100) === 0')
      check(doc.total_paise >= 0, 'doc.total_paise >= 0')

      // bill discount allocations sum exactly and never exceed a line's net
      check(
        sum((l) => l.bill_discount_paise) === doc.bill_discount_paise,
        'sum((l) => l.bill_discount_paise) === doc.bill_discount_paise',
      )
      const netTotal = input.lines.reduce((s, l) => s + lineNetBeforeBillDiscount(l), 0)
      const expectedBill = Math.min(
        netTotal,
        (input.bill_discount_paise ?? 0) +
          Math.round((netTotal * (input.bill_discount_bp ?? 0)) / 10000 + 0),
      )
      check(
        Math.abs(doc.bill_discount_paise - expectedBill) <= 1,
        'Math.abs(doc.bill_discount_paise - expectedBill) <= 1',
      )

      // tax breakup reconciles with the totals
      const tb = doc.tax_breakup
      check(
        tb.reduce((s, r) => s + r.taxable_paise, 0) === doc.taxable_paise,
        'tb.reduce((s, r) => s + r.taxable_paise, 0) === doc.taxable_paise',
      )
      check(
        tb.reduce((s, r) => s + r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_paise, 0) ===
          doc.tax_paise,
        'tb.reduce((s, r) => s + r.cgst_paise + r.sgst_paise + r.igst_paise + r.cess_pais',
      )
      check(
        JSON.stringify(tb.map((r) => r.gst_rate_bp)) ===
          JSON.stringify([...tb.map((r) => r.gst_rate_bp)].sort((a, b) => a - b)),
        'tb.map((r) => r.gst_rate_bp)',
      )

      doc.lines.forEach((l, i) => {
        const src = input.lines[i]!
        const net = l.gross_paise - l.discount_paise
        const gst = l.cgst_paise + l.sgst_paise + l.igst_paise
        check(l.key === src.key, 'l.key === src.key')
        check(
          l.discount_paise === l.item_discount_paise + l.bill_discount_paise,
          'l.discount_paise === l.item_discount_paise + l.bill_discount_paise',
        )
        check(net >= 0, 'net >= 0')
        check(
          l.total_paise === l.taxable_paise + gst + l.cess_paise,
          'l.total_paise === l.taxable_paise + gst + l.cess_paise',
        )
        for (const v of [
          l.taxable_paise,
          l.cgst_paise,
          l.sgst_paise,
          l.igst_paise,
          l.cess_paise,
          l.mrp_savings_paise,
        ]) {
          check(Number.isSafeInteger(v) && v >= 0, 'amounts are non-negative safe integers')
        }
        if (input.is_interstate) {
          check(l.cgst_paise + l.sgst_paise === 0, 'l.cgst_paise + l.sgst_paise === 0')
        } else {
          check(l.igst_paise === 0, 'l.igst_paise === 0')
          check(l.sgst_paise === Math.floor(gst / 2), 'l.sgst_paise === Math.floor(gst / 2)')
          check(
            l.cgst_paise === gst - Math.floor(gst / 2),
            'l.cgst_paise === gst - Math.floor(gst / 2)',
          )
        }
        if (input.tax_mode !== 'regular') {
          check(gst + l.cess_paise === 0, 'gst + l.cess_paise === 0')
          check(l.total_paise === net, 'l.total_paise === net')
        } else if (src.price_includes_tax) {
          check(l.total_paise === net, 'l.total_paise === net') // no paise drift on inclusive prices
          if (l.gst_rate_bp > 0) {
            const exact = (net * 10000) / (10000 + l.gst_rate_bp + (src.cess_rate_bp ?? 0))
            check(
              Math.abs(l.taxable_paise - exact) <= 0.5,
              'Math.abs(l.taxable_paise - exact) <= 0.5',
            )
          }
        } else {
          check(l.taxable_paise === net, 'l.taxable_paise === net')
          check(
            gst === Math.round((net * l.gst_rate_bp) / 10000),
            'gst === Math.round((net * l.gst_rate_bp) / 10000)',
          )
        }
      })
    }
    expect(iter).toBe(4000)
  }, 60_000)
})

describe('returns: prorateAmounts', () => {
  const original = {
    taxable_paise: 1000,
    cgst_paise: 25,
    sgst_paise: 25,
    igst_paise: 0,
    cess_paise: 3,
  }
  it('splits a line in three returns that add up exactly', () => {
    const parts = [0, 1000, 2000].map((before) =>
      prorateAmounts(original, {
        qty_milli: 1000,
        total_qty_milli: 3000,
        already_returned_milli: before,
      }),
    )
    expect(parts.map((p) => p.taxable_paise)).toEqual([333, 334, 333])
    expect(parts.reduce((s, p) => s + p.cgst_paise, 0)).toBe(25)
    expect(parts.reduce((s, p) => s + p.cess_paise, 0)).toBe(3)
    expect(parts.reduce((s, p) => s + p.total_paise, 0)).toBe(1053)
    for (const p of parts)
      expect(p.total_paise).toBe(
        p.taxable_paise + p.cgst_paise + p.sgst_paise + p.igst_paise + p.cess_paise,
      )
  })
  it('full return gives back the original amounts', () => {
    expect(prorateAmounts(original, { qty_milli: 3000, total_qty_milli: 3000 })).toEqual({
      ...original,
      total_paise: 1053,
    })
  })
  it('property: any sequence of partial returns sums to the original', () => {
    const rng = createRng(5)
    for (let i = 0; i < 500; i++) {
      const total = rng.int(1, 50) * 1000
      const amounts = {
        taxable_paise: rng.int(0, 1e7),
        cgst_paise: rng.int(0, 1e5),
        sgst_paise: rng.int(0, 1e5),
        igst_paise: 0,
        cess_paise: rng.int(0, 1e4),
      }
      let before = 0
      const acc = { taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, cess_paise: 0 }
      while (before < total) {
        const qty = Math.min(total - before, rng.int(1, 10) * 1000)
        const p = prorateAmounts(amounts, {
          qty_milli: qty,
          total_qty_milli: total,
          already_returned_milli: before,
        })
        for (const k of Object.keys(acc) as Array<keyof typeof acc>) acc[k] += p[k]
        before += qty
      }
      expect(acc).toEqual(amounts)
    }
  })
  it('rejects over-returns', () => {
    expect(() =>
      prorateAmounts(original, {
        qty_milli: 2000,
        total_qty_milli: 3000,
        already_returned_milli: 2000,
      }),
    ).toThrow(RangeError)
    expect(() => prorateAmounts(original, { qty_milli: 0, total_qty_milli: 3000 })).toThrow(
      RangeError,
    )
  })
})

describe('purchases', () => {
  it('computePurchaseLine: discount, free qty not charged, 12% intra-state', () => {
    expect(
      computePurchaseLine({
        unit_cost_paise: 10000,
        qty_milli: 10000,
        free_qty_milli: 1000,
        pack_size: 1,
        discount_bp: 500,
        discount_paise: 0,
        gst_rate_bp: 1200,
        cess_rate_bp: 0,
        is_interstate: false,
      }),
    ).toEqual({
      gross_paise: 100000,
      discount_paise: 5000,
      taxable_paise: 95000,
      gst_rate_bp: 1200,
      cess_rate_bp: 0,
      cgst_paise: 5700,
      sgst_paise: 5700,
      igst_paise: 0,
      cess_paise: 0,
      tax_paise: 11400,
      total_paise: 106400,
    })
  })
  it('computePurchaseLine: pack pricing and IGST', () => {
    // 25 strips of 10 tabs (250 tabs) at ₹20/strip, 5% IGST
    expect(
      computePurchaseLine({
        key: 'x',
        unit_cost_paise: 2000,
        qty_milli: 250000,
        pack_size: 10,
        gst_rate_bp: 500,
        is_interstate: true,
      }),
    ).toMatchObject({
      key: 'x',
      gross_paise: 50000,
      taxable_paise: 50000,
      igst_paise: 2500,
      cgst_paise: 0,
      total_paise: 52500,
    })
  })
  it('landedUnitCostPaise spreads cost over free quantity and charges', () => {
    expect(
      landedUnitCostPaise({
        taxable_paise: 95000,
        other_charges_alloc_paise: 0,
        non_itc_tax_paise: 0,
        qty_milli: 10000,
        free_qty_milli: 1000,
        pack_size: 1,
      }),
    ).toBe(8636)
    expect(
      landedUnitCostPaise({
        taxable_paise: 50000,
        other_charges_alloc_paise: 1000,
        non_itc_tax_paise: 2500,
        qty_milli: 250000,
        free_qty_milli: 0,
        pack_size: 10,
      }),
    ).toBe(2140)
    expect(() =>
      landedUnitCostPaise({
        taxable_paise: 1,
        other_charges_alloc_paise: 0,
        non_itc_tax_paise: 0,
        qty_milli: 0,
        free_qty_milli: 0,
        pack_size: 1,
      }),
    ).toThrow(RangeError)
  })
  it('computePurchaseDocument allocates other charges and reconciles', () => {
    const doc = computePurchaseDocument({
      lines: [
        { unit_cost_paise: 10000, qty_milli: 10000, gst_rate_bp: 1200 },
        { unit_cost_paise: 3333, qty_milli: 3000, gst_rate_bp: 500, free_qty_milli: 1000 },
      ],
      is_interstate: false,
      other_charges_paise: 1000,
      round_off: 'nearest_rupee',
      itc_eligible: true,
    })
    expect(doc.lines.map((l) => l.other_charges_alloc_paise)).toEqual([909, 91])
    expect(doc.lines.map((l) => l.landed_unit_cost_paise)).toEqual([10091, 2523])
    expect(doc.total_paise).toBe(
      doc.taxable_paise + doc.tax_paise + doc.other_charges_paise + doc.round_off_paise,
    )
    expect(Math.abs(doc.round_off_paise)).toBeLessThanOrEqual(50)
    expect(doc.total_paise % 100).toBe(0)
    // without ITC the GST becomes part of the landed cost
    const noItc = computePurchaseDocument({
      lines: [{ unit_cost_paise: 10000, qty_milli: 1000, gst_rate_bp: 1200 }],
      is_interstate: false,
      round_off: 'none',
      itc_eligible: false,
    })
    expect(noItc.lines[0]!.landed_unit_cost_paise).toBe(11200)
  })
})
