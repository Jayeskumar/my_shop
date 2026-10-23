import { describe, expect, it } from 'vitest'
import {
  compareStockSense,
  coverDays,
  demandBetween,
  excessStockMilli,
  expiryRisk,
  forecastProfile,
  planStockSense,
} from '../src/stocksense'

const flat = (days: number, perDay: number) => Array.from({ length: days }, () => perDay)

const plan = (over: Partial<Parameters<typeof planStockSense>[0]> = {}) =>
  planStockSense({
    profile: forecastProfile({
      history_milli: flat(7, 10_000),
      observed_days: 7,
      today_weekday: 3,
      weekday_adjust: false,
    }),
    usable_milli: 0,
    durable_milli: 0,
    incoming_milli: 0,
    lead_time_days: 3,
    cycle_days: 7,
    safety_days: 2,
    shelf_life_days: null,
    pack_size: 1,
    reorder_level_milli: null,
    reorder_qty_milli: null,
    unit_cost_paise: 4_000,
    unit_margin_paise: 1_000,
    ...over,
  })

describe('forecastProfile', () => {
  it('70 units over 7 days is 10 a day', () => {
    const p = forecastProfile({
      history_milli: flat(7, 10_000),
      observed_days: 7,
      today_weekday: 0,
      weekday_adjust: true,
    })
    expect(p.daily_milli).toBe(10_000)
    expect(demandBetween(p, 1, 5)).toBe(50_000)
    // Fewer than 14 days: no weekday pattern.
    expect(p.weekday_adjusted).toBe(false)
  })

  it('averages over the days the product had data, not the whole window', () => {
    const history = [...flat(20, 0), ...flat(10, 6_000)]
    const p = forecastProfile({
      history_milli: history,
      observed_days: 10,
      today_weekday: 1,
      weekday_adjust: false,
    })
    expect(p.daily_milli).toBe(6_000)
  })

  it('learns a weekend peak from two or more weeks', () => {
    // 28 days ending yesterday; today is Monday (1) so yesterday was Sunday (0).
    const history = Array.from({ length: 28 }, (_, i) => {
      const dow = (((1 - (28 - i)) % 7) + 7) % 7
      return dow === 0 ? 30_000 : 10_000
    })
    const p = forecastProfile({
      history_milli: history,
      observed_days: 28,
      today_weekday: 1,
      weekday_adjust: true,
    })
    expect(p.weekday_adjusted).toBe(true)
    expect(p.weekday_factors[0]!).toBeGreaterThan(2_000)
    // Day 7 from Monday is Sunday.
    expect(demandBetween(p, 7, 7)).toBeGreaterThan(demandBetween(p, 1, 1) * 2)
  })

  it('has no history when nothing sold', () => {
    const p = forecastProfile({
      history_milli: flat(30, 0),
      observed_days: 30,
      today_weekday: 2,
      weekday_adjust: true,
    })
    expect(p.has_history).toBe(false)
    expect(coverDays(p, 5_000)).toBeNull()
  })
})

describe('planStockSense', () => {
  it('orders lead + cycle + safety minus stock and open orders, urgent when it runs out first', () => {
    // 10/day × (3 + 7 + 2) = 120; 15 on hand lasts 1 day < 3-day lead time.
    const r = plan({ usable_milli: 15_000, durable_milli: 15_000, incoming_milli: 5_000 })
    expect(r.order_qty_milli).toBe(100_000)
    expect(r.cover_days).toBe(1)
    expect(r.priority).toBe('urgent')
    expect(r.reason).toBe('stockout_before_delivery')
    expect(r.order_cost_paise).toBe(400_000)
    expect(r.profit_per_day_paise).toBe(10_000)
    // Short before delivery: 30 − 15 − 5 = 10 units × ₹10 margin.
    expect(r.lost_profit_paise).toBe(10_000)
  })

  it('does not count stock that expires before delivery', () => {
    const r = plan({ usable_milli: 50_000, durable_milli: 0 })
    expect(r.order_qty_milli).toBe(120_000)
  })

  it('caps the order to what can sell within the shelf life and rounds down to packs', () => {
    // Shelf life 4 days after delivery → 40 can sell; packs of 6 → 36.
    const r = plan({ shelf_life_days: 4, pack_size: 6, unit_cost_paise: 24_000 })
    expect(r.uncapped_qty_milli).toBe(120_000)
    expect(r.order_qty_milli).toBe(36_000)
    expect(r.capped_by_shelf_life).toBe(true)
  })

  it('rounds up to whole packs', () => {
    const r = plan({ usable_milli: 100_000, durable_milli: 100_000, pack_size: 12 })
    expect(r.order_qty_milli).toBe(24_000)
    expect(r.priority).toBe('normal')
  })

  it('orders nothing when stock and open orders cover the horizon', () => {
    const r = plan({ usable_milli: 200_000, durable_milli: 200_000 })
    expect(r.order_qty_milli).toBe(0)
    expect(r.priority).toBe('ok')
    expect(r.reason).toBe('covered')
  })

  it('falls back to the reorder level without sales history', () => {
    const r = plan({
      profile: forecastProfile({
        history_milli: flat(30, 0),
        observed_days: 30,
        today_weekday: 0,
        weekday_adjust: true,
      }),
      usable_milli: 2_000,
      durable_milli: 2_000,
      reorder_level_milli: 5_000,
      reorder_qty_milli: 10_000,
    })
    expect(r.reason).toBe('reorder_level')
    expect(r.order_qty_milli).toBe(10_000)
  })
})

describe('expiry and slow stock', () => {
  const p = forecastProfile({
    history_milli: flat(14, 2_000),
    observed_days: 14,
    today_weekday: 0,
    weekday_adjust: false,
  })

  it('sells the first-expiring batch first and flags what cannot sell in time', () => {
    const risk = expiryRisk(p, [
      { batch_id: 'b', expiry_in_days: 9, qty_milli: 30_000 },
      { batch_id: 'a', expiry_in_days: 4, qty_milli: 6_000 },
      { batch_id: 'x', expiry_in_days: -1, qty_milli: 1_000 },
    ])
    // 'a' sells 6 in 5 days (2/day × 5 = 10); 'b' gets 20 − 6 = 14 by day 10 → 16 at risk.
    expect(risk.get('a')).toEqual({ sellable_milli: 6_000, at_risk_milli: 0 })
    expect(risk.get('b')).toEqual({ sellable_milli: 14_000, at_risk_milli: 16_000 })
    expect(risk.get('x')).toEqual({ sellable_milli: 0, at_risk_milli: 1_000 })
  })

  it('counts stock beyond 90 days of sales as excess', () => {
    expect(excessStockMilli(p, 200_000, 90)).toBe(20_000)
  })
})

describe('compareStockSense', () => {
  it('ranks urgent first, then fewer days of stock, then profit at risk', () => {
    const rows = [
      {
        name: 'C',
        priority: 'normal' as const,
        cover_days: 9,
        lost_profit_paise: 0,
        profit_per_day_paise: 900,
      },
      {
        name: 'B',
        priority: 'urgent' as const,
        cover_days: 2,
        lost_profit_paise: 100,
        profit_per_day_paise: 50,
      },
      {
        name: 'A',
        priority: 'urgent' as const,
        cover_days: 2,
        lost_profit_paise: 500,
        profit_per_day_paise: 10,
      },
      {
        name: 'D',
        priority: 'urgent' as const,
        cover_days: 0,
        lost_profit_paise: 0,
        profit_per_day_paise: 0,
      },
    ]
    expect(rows.sort(compareStockSense).map((r) => r.name)).toEqual(['D', 'A', 'B', 'C'])
  })
})
