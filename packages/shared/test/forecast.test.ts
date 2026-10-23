import { describe, expect, it } from 'vitest'
import {
  crostonSbaModel,
  holtWintersModel,
  smartForecast,
  weekdayAverageModel,
} from '../src/forecast'

/** Weekly pattern (Sunday first) with a weekend peak, in milli-units. */
const WEEK = [14_000, 8_000, 8_000, 9_000, 9_000, 10_000, 15_000]

function seasonal(weeks: number, growthPerDay = 0): number[] {
  const out: number[] = []
  for (let i = 0; i < weeks * 7; i++) out.push(WEEK[i % 7]! + growthPerDay * i)
  return out
}

describe('forecast models', () => {
  it('weekday average repeats the weekday means', () => {
    const f = weekdayAverageModel(seasonal(4), 0, 7)
    // history starts on Sunday and has 28 days → day 1 of the horizon is Sunday again
    expect(f).toEqual(WEEK)
  })

  it('Holt-Winters follows a rising trend that the weekday average lags behind', () => {
    const history = seasonal(8, 100)
    const next = seasonal(9, 100).slice(-7)
    const hw = holtWintersModel(history, 0, 7)
    const avg = weekdayAverageModel(history, 0, 7)
    const err = (f: number[]) => f.reduce((s, v, i) => s + Math.abs(v - next[i]!), 0)
    expect(err(hw)).toBeLessThan(err(avg))
  })

  it('Croston-SBA forecasts a flat rate for intermittent demand', () => {
    // 3 units every third day ≈ 1 a day, SBA shades it down slightly
    const history = Array.from({ length: 30 }, (_, i) => (i % 3 === 2 ? 3_000 : 0))
    const f = crostonSbaModel()(history, 0, 5)
    expect(new Set(f).size).toBe(1)
    expect(f[0]!).toBeGreaterThan(900)
    expect(f[0]!).toBeLessThan(1_000)
  })
})

describe('smartForecast', () => {
  it('returns no history for an all-zero series', () => {
    const f = smartForecast({ history_milli: [0, 0, 0], first_weekday: 0, lead_time_days: 7 })
    expect(f.has_history).toBe(false)
    expect(f.demand_milli).toBe(0)
    expect(f.safety_stock_milli).toBe(0)
  })

  it('backtests every candidate and reports the winner with its accuracy', () => {
    const f = smartForecast({ history_milli: seasonal(8, 100), first_weekday: 0, lead_time_days: 7 })
    expect(f.candidates.map((c) => c.method).sort()).toEqual(
      ['croston_sba', 'holt_winters', 'weekday_average'],
    )
    const best = Math.min(...f.candidates.map((c) => c.wape_bp!))
    expect(f.accuracy_bp).toBe(10_000 - best)
    expect(f.holdout_days).toBe(14)
    expect(f.method).toBe('holt_winters')
    expect(f.demand_milli).toBeGreaterThan(0)
    expect(f.daily_milli).toBe(Math.round(f.demand_milli / 7))
  })

  it('a perfectly repeating week is forecast exactly with no safety stock', () => {
    const f = smartForecast({ history_milli: seasonal(6), first_weekday: 0, lead_time_days: 7 })
    expect(f.accuracy_bp).toBe(10_000)
    expect(f.demand_milli).toBe(WEEK.reduce((s, v) => s + v, 0))
    expect(f.safety_stock_milli).toBe(0)
  })

  it('noisier demand gets more safety stock', () => {
    const noisy = seasonal(8).map((v, i) => v + (i % 2 === 0 ? 4_000 : -4_000))
    const calm = smartForecast({ history_milli: seasonal(8), first_weekday: 0, lead_time_days: 7 })
    const wild = smartForecast({ history_milli: noisy, first_weekday: 0, lead_time_days: 7 })
    expect(wild.safety_stock_milli).toBeGreaterThan(calm.safety_stock_milli)
  })

  it('short histories skip the backtest and use the weekday average', () => {
    const f = smartForecast({ history_milli: [5_000, 6_000, 4_000], first_weekday: 2, lead_time_days: 3 })
    expect(f.method).toBe('weekday_average')
    expect(f.accuracy_bp).toBeNull()
    expect(f.holdout_days).toBe(0)
    expect(f.has_history).toBe(true)
  })
})
