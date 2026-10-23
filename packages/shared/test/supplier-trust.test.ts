import { describe, expect, it } from 'vitest'
import { type SupplierDelivery, priceChangeBp, supplierTrust } from '../src/supplier-trust'

function delivery(order: string, expected: string | null, received: string, fill = 1): SupplierDelivery {
  return {
    order_date: order,
    expected_date: expected,
    first_received_date: received,
    ordered_milli: 100_000,
    received_milli: Math.round(100_000 * fill),
  }
}

describe('supplierTrust', () => {
  it('keeps learning until enough orders are delivered', () => {
    const t = supplierTrust([delivery('2026-10-01', '2026-10-04', '2026-10-03')])
    expect(t.level).toBe('learning')
    expect(t.trust).toBeNull()
    expect(t.learned_lead_days).toBeNull()
    expect(t.orders_measured).toBe(1)
  })

  it('a punctual supplier who sends everything scores high and is reliable', () => {
    const t = supplierTrust([
      delivery('2026-09-01', '2026-09-04', '2026-09-03'),
      delivery('2026-09-10', '2026-09-13', '2026-09-13'),
      delivery('2026-09-20', '2026-09-23', '2026-09-22'),
      delivery('2026-10-01', '2026-10-04', '2026-10-03'),
    ])
    expect(t.on_time_bp).toBe(10_000)
    expect(t.fill_rate_bp).toBe(10_000)
    expect(t.avg_lead_days).toBe(2.3)
    expect(t.learned_lead_days).toBe(3)
    expect(t.trust).toBeGreaterThanOrEqual(85)
    expect(t.level).toBe('good')
    expect(t.alerts).toEqual([{ code: 'reliable' }])
  })

  it('a late, short-supplying supplier is flagged with what to do', () => {
    const t = supplierTrust([
      delivery('2026-09-01', '2026-09-04', '2026-09-08', 0.8),
      delivery('2026-09-10', '2026-09-13', '2026-09-19', 0.85),
      delivery('2026-09-20', '2026-09-23', '2026-09-23', 0.8),
      delivery('2026-10-01', '2026-10-04', '2026-10-10', 0.85),
    ])
    expect(t.on_time_bp).toBe(2_500)
    expect(t.fill_rate_bp).toBe(8_250)
    expect(t.avg_lead_days).toBe(7)
    expect(t.learned_lead_days).toBe(7)
    expect(t.level).toBe('poor')
    expect(t.alerts).toContainEqual({ code: 'order_earlier', days: 4 })
    expect(t.alerts).toContainEqual({ code: 'short_supply', fill_pct: 83 })
  })

  it('without expected dates the score uses fill rate and consistency only', () => {
    const t = supplierTrust([
      delivery('2026-09-01', null, '2026-09-03'),
      delivery('2026-09-10', null, '2026-09-12'),
      delivery('2026-09-20', null, '2026-09-22'),
    ])
    expect(t.on_time_bp).toBeNull()
    expect(t.trust).toBe(100)
  })

  it('never counts more received than ordered', () => {
    const t = supplierTrust([
      { order_date: '2026-09-01', expected_date: null, first_received_date: '2026-09-02', ordered_milli: 10_000, received_milli: 15_000 },
      delivery('2026-09-10', null, '2026-09-11'),
      delivery('2026-09-20', null, '2026-09-21'),
    ])
    expect(t.fill_rate_bp).toBe(10_000)
  })
})

describe('priceChangeBp', () => {
  it('weights the per-product change by spend and ignores single purchases', () => {
    const bp = priceChangeBp([
      { product_id: 'oil', date: '2026-09-01', unit_cost_paise: 12_800, amount_paise: 1_000_000 },
      { product_id: 'oil', date: '2026-10-01', unit_cost_paise: 13_600, amount_paise: 1_000_000 },
      { product_id: 'ghee', date: '2026-10-01', unit_cost_paise: 12_000, amount_paise: 500_000 },
    ])
    expect(bp).toBe(625)
  })

  it('a price rise shows up as an alert even while learning', () => {
    const t = supplierTrust(
      [delivery('2026-10-01', null, '2026-10-02')],
      [
        { product_id: 'oil', date: '2026-09-01', unit_cost_paise: 10_000, amount_paise: 100 },
        { product_id: 'oil', date: '2026-10-01', unit_cost_paise: 10_500, amount_paise: 100 },
      ],
    )
    expect(t.alerts).toEqual([{ code: 'price_up', pct: 5 }])
  })

  it('no repeat purchases → no price change', () => {
    expect(priceChangeBp([{ product_id: 'a', date: '2026-10-01', unit_cost_paise: 100, amount_paise: 1 }])).toBeNull()
  })
})
