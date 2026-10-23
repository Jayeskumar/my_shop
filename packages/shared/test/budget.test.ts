import { describe, expect, it } from 'vitest'
import {
  type BudgetItemInput,
  mustHaveQtyMilli,
  packCashPaise,
  planWithinBudget,
} from '../src/budget'

function item(overrides: Partial<BudgetItemInput> & { product_id: string }): BudgetItemInput {
  return {
    name: overrides.product_id,
    priority: 'normal',
    stockout_urgency_days: 0,
    margin_bp: 1000,
    suggested_qty_milli: 10_000,
    forecast_demand_milli: 0,
    durable_stock_milli: 0,
    open_po_qty_milli: 0,
    pack_size: 1,
    unit_cost_paise: 10_000,
    gst_rate_bp: 0,
    ...overrides,
  }
}

// Milk-like: urgent shortage of 60 of a 100-unit suggestion, ₹20 a pack + 5% GST = ₹21.
const milk = item({
  product_id: 'milk',
  priority: 'high',
  stockout_urgency_days: 5,
  suggested_qty_milli: 100_000,
  forecast_demand_milli: 80_000,
  durable_stock_milli: 20_000,
  unit_cost_paise: 2_000,
  gst_rate_bp: 500,
})
// Rice: normal priority, no shortage, 10 bags at ₹1,000.
const rice = item({ product_id: 'rice', suggested_qty_milli: 10_000, unit_cost_paise: 100_000 })

describe('budget helpers', () => {
  it('adds GST to the pack cost', () => {
    expect(packCashPaise(2_000, 500)).toBe(2_100)
    expect(packCashPaise(10_000, 0)).toBe(10_000)
  })

  it('must-have is the shortage before delivery, in whole packs, capped at the suggestion', () => {
    expect(mustHaveQtyMilli(milk)).toBe(60_000)
    expect(mustHaveQtyMilli(item({ product_id: 'x', forecast_demand_milli: 7_500, pack_size: 4, suggested_qty_milli: 40_000 }))).toBe(8_000)
    expect(mustHaveQtyMilli(item({ product_id: 'y', forecast_demand_milli: 50_000, suggested_qty_milli: 10_000 }))).toBe(10_000)
    expect(mustHaveQtyMilli(rice)).toBe(0)
  })
})

describe('planWithinBudget', () => {
  it('a big enough budget buys every suggestion in full', () => {
    const plan = planWithinBudget([rice, milk], 2_000_000)
    expect(plan.lines.map((l) => l.status)).toEqual(['full', 'full'])
    expect(plan.spent_paise).toBe(100 * 2_100 + 10 * 100_000)
    expect(plan.must_have_covered_bp).toBe(10_000)
    // ranked: the high-priority item comes first whatever the input order
    expect(plan.lines[0]!.product_id).toBe('milk')
  })

  it('buys the urgent must-have before anything else', () => {
    // ₹1,500: milk must-have (60 × ₹21 = ₹1,260) first, ₹240 left buys no rice (₹1,000 a bag)
    // but 11 more milk packs as buffer.
    const plan = planWithinBudget([rice, milk], 150_000)
    const byId = Object.fromEntries(plan.lines.map((l) => [l.product_id, l]))
    expect(byId.milk!.qty_milli).toBe(71_000)
    expect(byId.milk!.status).toBe('must_have')
    expect(byId.rice!.status).toBe('left_out')
    expect(plan.must_have_covered_bp).toBe(10_000)
    expect(plan.spent_paise).toBe(71 * 2_100)
    expect(plan.left_paise).toBe(150_000 - 71 * 2_100)
  })

  it('cuts to whole packs and reports partial coverage of the must-haves', () => {
    const plan = planWithinBudget([milk], 63_000) // 30 packs of the 60 needed
    expect(plan.lines[0]!.qty_milli).toBe(30_000)
    expect(plan.lines[0]!.status).toBe('partial')
    expect(plan.must_have_covered_bp).toBe(5_000)
  })

  it('never spends more than the budget and ignores items with nothing suggested', () => {
    const none = item({ product_id: 'none', suggested_qty_milli: 0 })
    for (const budget of [0, 1, 99_999, 123_456, 1_000_000]) {
      const plan = planWithinBudget([rice, milk, none], budget)
      expect(plan.spent_paise).toBeLessThanOrEqual(budget)
      expect(plan.spent_paise + plan.left_paise).toBe(budget)
      expect(plan.lines.find((l) => l.product_id === 'none')).toBeUndefined()
    }
  })

  it('a zero budget leaves everything out', () => {
    const plan = planWithinBudget([rice, milk], 0)
    expect(plan.lines.every((l) => l.status === 'left_out' && l.qty_milli === 0)).toBe(true)
    expect(plan.must_have_covered_bp).toBe(0)
  })

  it('within the same priority, the higher margin is funded first', () => {
    const a = item({ product_id: 'a', margin_bp: 500, suggested_qty_milli: 5_000 })
    const b = item({ product_id: 'b', margin_bp: 2_000, suggested_qty_milli: 5_000 })
    const plan = planWithinBudget([a, b], 50_000)
    expect(plan.lines[0]!.product_id).toBe('b')
    expect(plan.lines[0]!.status).toBe('full')
    expect(plan.lines[1]!.status).toBe('left_out')
  })
})
