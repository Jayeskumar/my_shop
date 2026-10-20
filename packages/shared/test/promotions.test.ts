import { describe, expect, it } from 'vitest'
import { computeDocument } from '../src/pricing'
import {
  PromotionSchema,
  applyPromotions,
  isPromotionActive,
  parsePromotionRules,
  sortPromotions,
  type PromotionCartLine,
  type PromotionLike,
} from '../src/promotions'
import { createRng } from './helpers/prng'

// Fixed ids (UUID v7-shaped) for readability.
const id = (n: number) => `0192f1a2-0000-7000-8000-${String(n).padStart(12, '0')}`
const RICE = id(1)
const DAL = id(2)
const PASTE = id(3)
const BRUSH = id(4)
const SOAP = id(5)
const GROCERY = id(100)
const PERSONAL = id(101)
const BRAND_X = id(200)
const STORE = id(900)
const OTHER_STORE = id(901)
const NOW = new Date('2026-10-20T06:00:00Z') // Tuesday 11:30 IST
const ctx = { store_id: STORE, now: NOW }

let promoSeq = 1000
function promo(p: Partial<PromotionLike> & Pick<PromotionLike, 'kind' | 'rules'>): PromotionLike {
  return {
    id: id(promoSeq++),
    name: `${p.kind} offer`,
    store_ids: null,
    starts_at: null,
    ends_at: null,
    days_of_week: null,
    priority: 0,
    stackable: false,
    is_active: true,
    ...p,
  } as PromotionLike
}
const target = { all_items: false, product_ids: [] as string[], category_ids: [] as string[], brand_ids: [] as string[], exclude_product_ids: [] as string[] }
const cartLine = (key: string, product_id: string, unit_price_paise: number, qty_milli: number, extra: Partial<PromotionCartLine> = {}): PromotionCartLine => ({
  key, product_id, unit_price_paise, qty_milli, ...extra,
})

describe('item_percent / item_flat', () => {
  it('10% off a category, respecting min qty and cap', () => {
    const p = promo({ kind: 'item_percent', rules: { ...target, category_ids: [GROCERY], percent_bp: 1000 } })
    const res = applyPromotions(
      [cartLine('a', RICE, 10000, 2000, { category_id: GROCERY }), cartLine('b', SOAP, 5000, 1000, { category_id: PERSONAL })],
      [p], ctx,
    )
    expect(res.line_discounts).toEqual({ a: { discount_paise: 2000, promotion_ids: [p.id] }, b: { discount_paise: 0, promotion_ids: [] } })
    expect(res.applied).toEqual([{ promotion_id: p.id, name: p.name, discount_paise: 2000 }])
    expect(res.bill_discount_paise).toBe(0)

    const minQty = promo({ kind: 'item_percent', rules: { ...target, product_ids: [RICE], percent_bp: 1000, min_qty_milli: 5000 } })
    expect(applyPromotions([cartLine('a', RICE, 10000, 2000)], [minQty], ctx).line_discounts.a!.discount_paise).toBe(0)
    const capped = promo({ kind: 'item_percent', rules: { ...target, all_items: true, percent_bp: 5000, max_discount_paise: 1500 } })
    expect(applyPromotions([cartLine('a', RICE, 10000, 2000)], [capped], ctx).line_discounts.a!.discount_paise).toBe(1500)
  })
  it('targets brands and honours exclusions', () => {
    const p = promo({ kind: 'item_percent', rules: { ...target, all_items: true, exclude_product_ids: [RICE], percent_bp: 1000 } })
    const res = applyPromotions([cartLine('a', RICE, 10000, 1000), cartLine('b', DAL, 10000, 1000, { brand_id: BRAND_X })], [p], ctx)
    expect(res.line_discounts.a!.discount_paise).toBe(0)
    expect(res.line_discounts.b!.discount_paise).toBe(1000)
    const brand = promo({ kind: 'item_percent', rules: { ...target, brand_ids: [BRAND_X], percent_bp: 500 } })
    expect(applyPromotions([cartLine('b', DAL, 10000, 1000, { brand_id: BRAND_X })], [brand], ctx).line_discounts.b!.discount_paise).toBe(500)
  })
  it('flat ₹ per unit on weighed goods, capped at the line amount', () => {
    const p = promo({ kind: 'item_flat', rules: { ...target, product_ids: [RICE], flat_paise: 200 } })
    expect(applyPromotions([cartLine('a', RICE, 6000, 5250)], [p], ctx).line_discounts.a!.discount_paise).toBe(1050)
    const huge = promo({ kind: 'item_flat', rules: { ...target, product_ids: [RICE], flat_paise: 100000 } })
    expect(applyPromotions([cartLine('a', RICE, 6000, 1000)], [huge], ctx).line_discounts.a!.discount_paise).toBe(6000)
  })
})

describe('buy_x_get_y', () => {
  const b2g1 = (over: Record<string, unknown> = {}) =>
    promo({ kind: 'buy_x_get_y', rules: { ...target, product_ids: [SOAP], buy_qty: 2, get_qty: 1, get_discount_bp: 10000, get_product_ids: [], get_category_ids: [], get_brand_ids: [], ...over } as never })
  it.each([
    [2000, 0],
    [3000, 4000],
    [5000, 4000],
    [6000, 8000],
    [9500, 12000], // 9.5 units → 9 whole units → 3 free
  ])('buy 2 get 1 free, qty %d → discount %d', (qty, discount) => {
    expect(applyPromotions([cartLine('s', SOAP, 4000, qty)], [b2g1()], ctx).line_discounts.s!.discount_paise).toBe(discount)
  })
  it('discounts the cheapest units across a mixed set', () => {
    const p = promo({ kind: 'buy_x_get_y', rules: { ...target, category_ids: [PERSONAL], buy_qty: 2, get_qty: 1, get_discount_bp: 10000, get_product_ids: [], get_category_ids: [], get_brand_ids: [] } })
    const res = applyPromotions(
      [cartLine('paste', PASTE, 10000, 2000, { category_id: PERSONAL }), cartLine('soap', SOAP, 6000, 1000, { category_id: PERSONAL })],
      [p], ctx,
    )
    expect(res.line_discounts.paste!.discount_paise).toBe(0)
    expect(res.line_discounts.soap!.discount_paise).toBe(6000)
  })
  it('half price on the reward and max applications', () => {
    expect(applyPromotions([cartLine('s', SOAP, 4000, 6000)], [b2g1({ get_discount_bp: 5000 })], ctx).line_discounts.s!.discount_paise).toBe(4000)
    expect(applyPromotions([cartLine('s', SOAP, 4000, 9000)], [b2g1({ max_applications: 1 })], ctx).line_discounts.s!.discount_paise).toBe(4000)
  })
  it('separate reward set: buy 2 toothpaste, get a brush free', () => {
    const p = promo({ kind: 'buy_x_get_y', rules: { ...target, product_ids: [PASTE], buy_qty: 2, get_qty: 1, get_discount_bp: 10000, get_product_ids: [BRUSH], get_category_ids: [], get_brand_ids: [] } })
    const res = applyPromotions([cartLine('p', PASTE, 9500, 2000), cartLine('b', BRUSH, 3000, 2000)], [p], ctx)
    expect(res.line_discounts.p!.discount_paise).toBe(0)
    expect(res.line_discounts.b!.discount_paise).toBe(3000)
    expect(applyPromotions([cartLine('p', PASTE, 9500, 1000), cartLine('b', BRUSH, 3000, 1000)], [p], ctx).line_discounts.b!.discount_paise).toBe(0)
    expect(applyPromotions([cartLine('p', PASTE, 9500, 4000)], [p], ctx).line_discounts.p!.discount_paise).toBe(0) // no reward item in cart
  })
  it('pack-priced units (tablets from a strip)', () => {
    const p = promo({ kind: 'buy_x_get_y', rules: { ...target, product_ids: [DAL], buy_qty: 10, get_qty: 2, get_discount_bp: 10000, get_product_ids: [], get_category_ids: [], get_brand_ids: [] } })
    // 12 tablets from ₹35 strips of 10 → 2 free tablets = ₹7
    expect(applyPromotions([cartLine('t', DAL, 3500, 12000, { pack_size: 10 })], [p], ctx).line_discounts.t!.discount_paise).toBe(700)
  })
})

describe('combo_price', () => {
  const combo = () => promo({ kind: 'combo_price', rules: { items: [{ product_id: PASTE, qty_milli: 1000 }, { product_id: BRUSH, qty_milli: 1000 }], combo_price_paise: 12000 } })
  it('prices a complete combo and allocates the discount pro-rata', () => {
    const p = combo()
    const res = applyPromotions([cartLine('p', PASTE, 10000, 1000), cartLine('b', BRUSH, 6000, 1000)], [p], ctx)
    expect(res.line_discounts.p!.discount_paise).toBe(2500)
    expect(res.line_discounts.b!.discount_paise).toBe(1500)
    expect(res.applied[0]!.discount_paise).toBe(4000)
  })
  it('only complete combos count; extra quantity stays at regular price', () => {
    const p = combo()
    const res = applyPromotions([cartLine('p', PASTE, 10000, 3000), cartLine('b', BRUSH, 6000, 1000)], [p], ctx)
    expect(res.line_discounts.p!.discount_paise + res.line_discounts.b!.discount_paise).toBe(4000)
    expect(applyPromotions([cartLine('p', PASTE, 10000, 3000)], [p], ctx).applied).toEqual([])
  })
  it('never increases the price', () => {
    const p = promo({ kind: 'combo_price', rules: { items: [{ product_id: PASTE, qty_milli: 1000 }, { product_id: BRUSH, qty_milli: 1000 }], combo_price_paise: 50000 } })
    expect(applyPromotions([cartLine('p', PASTE, 10000, 1000), cartLine('b', BRUSH, 6000, 1000)], [p], ctx).applied).toEqual([])
  })
})

describe('bill level & stacking', () => {
  it('bill percent with minimum bill and cap, applied on the amount after item offers', () => {
    const item = promo({ kind: 'item_percent', rules: { ...target, all_items: true, percent_bp: 1000 } })
    const bill = promo({ kind: 'bill_percent', rules: { percent_bp: 500, min_bill_paise: 50000, max_discount_paise: 10000 } })
    const res = applyPromotions([cartLine('a', RICE, 60000, 1000)], [item, bill], ctx)
    expect(res.line_discounts.a!.discount_paise).toBe(6000)
    expect(res.bill_discount_paise).toBe(2700) // 5% of 54000
    expect(applyPromotions([cartLine('a', RICE, 50000, 1000)], [item, bill], ctx).bill_discount_paise).toBe(0) // 45000 < 50000
    expect(applyPromotions([cartLine('a', RICE, 1000000, 1000)], [bill], ctx).bill_discount_paise).toBe(10000)
  })
  it('bill flat with minimum, never more than the bill', () => {
    const flat = promo({ kind: 'bill_flat', rules: { flat_paise: 5000, min_bill_paise: 50000 } })
    expect(applyPromotions([cartLine('a', RICE, 50000, 1000)], [flat], ctx).bill_discount_paise).toBe(5000)
    expect(applyPromotions([cartLine('a', RICE, 49999, 1000)], [flat], ctx).bill_discount_paise).toBe(0)
    const noMin = promo({ kind: 'bill_flat', rules: { flat_paise: 5000 } })
    expect(applyPromotions([cartLine('a', RICE, 3000, 1000)], [noMin], ctx).bill_discount_paise).toBe(3000)
  })
  it('best non-stackable wins per line, stackables add, total capped at the line', () => {
    const ten = promo({ kind: 'item_percent', rules: { ...target, all_items: true, percent_bp: 1000 } })
    const fifteen = promo({ kind: 'item_percent', rules: { ...target, product_ids: [RICE], percent_bp: 1500 } })
    const extra = promo({ kind: 'item_percent', stackable: true, rules: { ...target, all_items: true, percent_bp: 500 } })
    const res = applyPromotions([cartLine('a', RICE, 10000, 1000), cartLine('b', DAL, 10000, 1000)], [ten, fifteen, extra], ctx)
    expect(res.line_discounts.a).toEqual({ discount_paise: 2000, promotion_ids: [fifteen.id, extra.id] })
    expect(res.line_discounts.b).toEqual({ discount_paise: 1500, promotion_ids: [ten.id, extra.id] })
    const total = res.applied.reduce((s, a) => s + a.discount_paise, 0)
    expect(total).toBe(3500)
    const big = promo({ kind: 'item_percent', stackable: true, rules: { ...target, all_items: true, percent_bp: 9000 } })
    const capped = applyPromotions([cartLine('a', RICE, 10000, 1000)], [fifteen, big], ctx)
    expect(capped.line_discounts.a!.discount_paise).toBe(10000)
    expect(capped.applied.map((a) => a.discount_paise)).toEqual([1500, 8500])
  })
  it('ties between non-stackables resolve by priority then id', () => {
    const low = promo({ kind: 'item_percent', priority: 1, rules: { ...target, all_items: true, percent_bp: 1000 } })
    const high = promo({ kind: 'item_percent', priority: 5, rules: { ...target, all_items: true, percent_bp: 1000 } })
    const res = applyPromotions([cartLine('a', RICE, 10000, 1000)], [low, high], ctx)
    expect(res.line_discounts.a!.promotion_ids).toEqual([high.id])
    expect(sortPromotions([low, high]).map((p) => p.id)).toEqual([high.id, low.id])
  })
})

describe('schedules', () => {
  const base = { kind: 'bill_flat' as const, rules: { flat_paise: 100 } }
  it.each<[string, Partial<PromotionLike>, boolean]>([
    ['inactive', { is_active: false }, false],
    ['other store', { store_ids: [OTHER_STORE] }, false],
    ['this store', { store_ids: [OTHER_STORE, STORE] }, true],
    ['not started', { starts_at: '2026-10-21T00:00:00+05:30' }, false],
    ['started', { starts_at: '2026-10-20T00:00:00+05:30' }, true],
    ['ended (exclusive end)', { ends_at: NOW.toISOString() }, false],
    ['before end', { ends_at: new Date(NOW.getTime() + 1) }, true],
    ['Date start', { starts_at: new Date('2026-10-01T00:00:00Z') }, true],
    ['Tuesday only', { days_of_week: [2] }, true],
    ['weekends only', { days_of_week: [0, 6] }, false],
  ])('%s → %s', (_name, over, expected) => {
    expect(isPromotionActive(promo({ ...base, ...over }), ctx)).toBe(expected)
  })
  it('evaluates days_of_week in IST, not UTC', () => {
    const mondayOnly = promo({ ...base, days_of_week: [1] })
    // 2026-10-18T20:00Z is Sunday in UTC but Monday 01:30 in India
    expect(isPromotionActive(mondayOnly, { store_id: STORE, now: new Date('2026-10-18T20:00:00Z') })).toBe(true)
    expect(isPromotionActive(mondayOnly, { store_id: STORE, now: new Date('2026-10-18T18:00:00Z') })).toBe(false)
    expect(isPromotionActive(mondayOnly, { store_id: STORE, now: new Date('2026-10-18T20:00:00Z'), timezone: 'UTC' })).toBe(false)
  })
})

describe('schemas', () => {
  it('parses a promotion with defaults', () => {
    const parsed = PromotionSchema.parse({
      id: id(1), name: 'Diwali 10%', kind: 'item_percent', rules: { category_ids: [GROCERY], percent_bp: 1000 },
    })
    expect(parsed).toMatchObject({ store_ids: null, priority: 0, stackable: false, is_active: true, days_of_week: null })
    if (parsed.kind !== 'item_percent') throw new Error('narrowing')
    expect(parsed.rules).toEqual({ all_items: false, product_ids: [], category_ids: [GROCERY], brand_ids: [], exclude_product_ids: [], percent_bp: 1000 })
  })
  it.each<[string, unknown]>([
    ['no target', { id: id(1), name: 'x', kind: 'item_percent', rules: { percent_bp: 1000 } }],
    ['percent > 100', { id: id(1), name: 'x', kind: 'item_percent', rules: { all_items: true, percent_bp: 10001 } }],
    ['bad kind', { id: id(1), name: 'x', kind: 'mystery', rules: {} }],
    ['ends before start', { id: id(1), name: 'x', kind: 'bill_flat', rules: { flat_paise: 1 }, starts_at: '2026-10-02T00:00:00Z', ends_at: '2026-10-01T00:00:00Z' }],
    ['combo with one item', { id: id(1), name: 'x', kind: 'combo_price', rules: { items: [{ product_id: RICE, qty_milli: 1000 }], combo_price_paise: 1 } }],
    ['combo duplicate item', { id: id(1), name: 'x', kind: 'combo_price', rules: { items: [{ product_id: RICE, qty_milli: 1000 }, { product_id: RICE, qty_milli: 1000 }], combo_price_paise: 1 } }],
    ['bad weekday', { id: id(1), name: 'x', kind: 'bill_flat', rules: { flat_paise: 1 }, days_of_week: [7] }],
  ])('rejects %s', (_name, input) => {
    expect(PromotionSchema.safeParse(input).success).toBe(false)
  })
  it('parsePromotionRules validates per kind', () => {
    expect(parsePromotionRules('bill_flat', { flat_paise: 500 })).toEqual({ flat_paise: 500 })
    expect(parsePromotionRules('buy_x_get_y', { all_items: true, buy_qty: 1, get_qty: 1 }).get_discount_bp).toBe(10000)
    expect(() => parsePromotionRules('bill_flat', { flat_paise: 0 })).toThrow()
  })
})

describe('integration with pricing & properties', () => {
  it('feeds computeDocument', () => {
    const item = promo({ kind: 'item_percent', rules: { ...target, all_items: true, percent_bp: 1000 } })
    const bill = promo({ kind: 'bill_flat', rules: { flat_paise: 1000 } })
    const cart = [cartLine('a', RICE, 11800, 1000), cartLine('b', DAL, 10500, 2000)]
    const res = applyPromotions(cart, [item, bill], ctx)
    const doc = computeDocument({
      lines: cart.map((c) => ({ key: c.key, unit_price_paise: c.unit_price_paise, qty_milli: c.qty_milli, price_includes_tax: true, gst_rate_bp: 500, discount_paise: res.line_discounts[c.key]!.discount_paise })),
      is_interstate: false, tax_mode: 'regular', bill_discount_paise: res.bill_discount_paise, round_off: 'nearest_rupee',
    })
    expect(doc.item_discount_paise).toBe(1180 + 2100)
    expect(doc.bill_discount_paise).toBe(1000)
    expect(doc.total_paise).toBe(Math.round((11800 + 21000 - 3280 - 1000) / 100) * 100)
  })

  it('property: never below zero, totals reconcile, order of promotions is irrelevant', () => {
    const rng = createRng(77)
    const products = [RICE, DAL, PASTE, BRUSH, SOAP]
    for (let iter = 0; iter < 400; iter++) {
      const cart = Array.from({ length: rng.int(1, 8) }, (_, i) =>
        cartLine(`k${i}`, rng.pick(products), rng.int(0, 50000), rng.int(1, 10) * (rng.bool(0.3) ? 750 : 1000), {
          category_id: rng.pick([GROCERY, PERSONAL, null]), brand_id: rng.pick([BRAND_X, null]), pack_size: rng.pick([1, 1, 10]),
        }),
      )
      const promos: PromotionLike[] = Array.from({ length: rng.int(0, 6) }, () => {
        const stackable = rng.bool(0.3)
        const priority = rng.int(0, 3)
        switch (rng.int(0, 5)) {
          case 0: return promo({ kind: 'item_percent', stackable, priority, rules: { ...target, all_items: rng.bool(), product_ids: [rng.pick(products)], percent_bp: rng.int(1, 10000) } })
          case 1: return promo({ kind: 'item_flat', stackable, priority, rules: { ...target, category_ids: [GROCERY], flat_paise: rng.int(1, 5000) } })
          case 2: return promo({ kind: 'buy_x_get_y', stackable, priority, rules: { ...target, all_items: true, buy_qty: rng.int(1, 3), get_qty: rng.int(1, 2), get_discount_bp: rng.int(1, 10000), get_product_ids: rng.bool() ? [BRUSH] : [], get_category_ids: [], get_brand_ids: [] } })
          case 3: return promo({ kind: 'combo_price', stackable, priority, rules: { items: [{ product_id: RICE, qty_milli: 1000 }, { product_id: DAL, qty_milli: 1000 }], combo_price_paise: rng.int(0, 60000) } })
          case 4: return promo({ kind: 'bill_percent', stackable, priority, rules: { percent_bp: rng.int(1, 10000), min_bill_paise: rng.int(0, 50000) } })
          default: return promo({ kind: 'bill_flat', stackable, priority, rules: { flat_paise: rng.int(1, 100000) } })
        }
      })
      const res = applyPromotions(cart, promos, ctx)
      const shuffled = applyPromotions(cart, [...promos].reverse(), ctx)
      expect(shuffled).toEqual(res)
      let gross = 0
      let lineTotal = 0
      for (const c of cart) {
        const g = Math.round((c.unit_price_paise * c.qty_milli) / ((c.pack_size ?? 1) * 1000))
        const d = res.line_discounts[c.key]!.discount_paise
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThanOrEqual(g + 1)
        gross += g
        lineTotal += d
      }
      expect(res.bill_discount_paise).toBeGreaterThanOrEqual(0)
      expect(lineTotal + res.bill_discount_paise).toBeLessThanOrEqual(gross + cart.length)
      expect(res.applied.reduce((s, a) => s + a.discount_paise, 0)).toBe(lineTotal + res.bill_discount_paise)
    }
  })

  it('rejects duplicate cart keys', () => {
    expect(() => applyPromotions([cartLine('a', RICE, 1, 1000), cartLine('a', DAL, 1, 1000)], [], ctx)).toThrow(RangeError)
  })
})
