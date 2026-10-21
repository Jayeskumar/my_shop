import { describe, expect, it } from 'vitest'
import {
  type CartState,
  allowsDecimalQty,
  cartReducer,
  defaultQtyMilli,
  emptyCart,
  isCartState,
  packUnitOf,
  qtyStepMilli,
} from '../lib/cart'
import { PIDS, batches, cartOf, dal, lineOf, newLineOf, paracetamol, rice, sugar } from './fixtures'

function apply(state: CartState, ...actions: Parameters<typeof cartReducer>[1][]): CartState {
  return actions.reduce(cartReducer, state)
}

describe('cartReducer: adding', () => {
  it('a repeated scan adds to the same line and selects it', () => {
    const s = apply(
      emptyCart(),
      { type: 'add', line: newLineOf(rice) },
      { type: 'add', line: newLineOf(dal) },
      { type: 'add', line: newLineOf(rice, { scanned_code: '8901234500011' }) },
    )
    expect(s.lines).toHaveLength(2)
    expect(s.lines[0]?.qty_milli).toBe(2000)
    expect(s.lines[0]?.scanned_code).toBe('8901234500011')
    expect(s.selected_key).toBe(s.lines[0]?.key)
  })

  it('weighed goods, manual prices, serials and different batches get their own line', () => {
    const base = emptyCart()
    const weighed = apply(
      base,
      { type: 'add', line: newLineOf(sugar, { qty_milli: 1500 }) },
      { type: 'add', line: newLineOf(sugar, { qty_milli: 750 }) },
    )
    expect(weighed.lines.map((l) => l.qty_milli)).toEqual([1500, 750])

    const priced = apply(
      base,
      { type: 'add', line: newLineOf(rice) },
      { type: 'add', line: newLineOf(rice, { price_override_paise: 38_000 }) },
    )
    expect(priced.lines).toHaveLength(2)

    const [newer, older] = batches
    const batched = apply(
      base,
      { type: 'add', line: newLineOf(paracetamol, { batch: older!, batch_auto: false }) },
      { type: 'add', line: newLineOf(paracetamol, { batch: newer!, batch_auto: false }) },
      { type: 'add', line: newLineOf(paracetamol, { batch: older!, batch_auto: false }) },
    )
    expect(batched.lines.map((l) => [l.batch?.batch_no, l.qty_milli])).toEqual([
      ['B-OLD', 30_000],
      ['B-NEW', 15_000],
    ])
  })

  it('merge: false always appends; invalid quantities are ignored', () => {
    const s = apply(
      emptyCart(),
      { type: 'add', line: newLineOf(rice) },
      { type: 'add', line: newLineOf(rice), merge: false },
      { type: 'add', line: newLineOf(rice, { qty_milli: 0 }) },
      { type: 'add', line: newLineOf(rice, { qty_milli: 1.5 }) },
    )
    expect(s.lines.map((l) => l.qty_milli)).toEqual([1000, 1000])
  })
})

describe('cartReducer: editing', () => {
  const two = cartOf([lineOf(rice, { key: 'a' }), lineOf(dal, { key: 'b' })])

  it('set_qty to 0 removes the line; remove selects the neighbour', () => {
    const s = apply(two, { type: 'select', key: 'a' }, { type: 'set_qty', key: 'a', qty_milli: 0 })
    expect(s.lines.map((l) => l.key)).toEqual(['b'])
    expect(s.selected_key).toBe('b')
    expect(apply(s, { type: 'remove', key: 'b' }).selected_key).toBeNull()
  })

  it('step_qty moves by a pack for strips and snaps loose quantities to whole packs', () => {
    const strip = cartOf([lineOf(paracetamol, { key: 'p', qty_milli: 15_000 })])
    expect(apply(strip, { type: 'step_qty', key: 'p', direction: 1 }).lines[0]?.qty_milli).toBe(
      30_000,
    )
    const loose = cartOf([lineOf(paracetamol, { key: 'p', qty_milli: 20_000 })])
    expect(apply(loose, { type: 'step_qty', key: 'p', direction: 1 }).lines[0]?.qty_milli).toBe(
      30_000,
    )
    expect(apply(loose, { type: 'step_qty', key: 'p', direction: -1 }).lines[0]?.qty_milli).toBe(
      15_000,
    )
    // Never below one pack by stepping.
    expect(apply(strip, { type: 'step_qty', key: 'p', direction: -1 }).lines[0]?.qty_milli).toBe(
      15_000,
    )
  })

  it('discounts are clamped; notes and serials are trimmed', () => {
    const s = apply(
      two,
      { type: 'set_discount', key: 'a', discount_bp: 25_000, discount_paise: -5 },
      { type: 'set_note', key: 'a', note: '  gift wrap ' },
      { type: 'set_serials', key: 'b', serial_numbers: [' SN1 ', '', 'SN2'] },
      { type: 'set_bill_discount', discount_bp: 500.4, discount_paise: 1000 },
    )
    expect(s.lines[0]).toMatchObject({ discount_bp: 10_000, discount_paise: 0, note: 'gift wrap' })
    expect(s.lines[1]?.serial_numbers).toEqual(['SN1', 'SN2'])
    expect(s).toMatchObject({ bill_discount_bp: 500, bill_discount_paise: 1000 })
  })

  it('select_move walks the lines and stops at the ends', () => {
    let s = apply(two, { type: 'select', key: null }, { type: 'select_move', delta: 1 })
    expect(s.selected_key).toBe('a')
    s = apply(s, { type: 'select_move', delta: 1 }, { type: 'select_move', delta: 1 })
    expect(s.selected_key).toBe('b')
    s = apply(s, { type: 'select_move', delta: -1 }, { type: 'select_move', delta: -1 })
    expect(s.selected_key).toBe('a')
  })

  it('removing the customer drops loyalty redemption; clear starts a new bill id', () => {
    const customer = {
      id: PIDS.customer,
      name: 'Lakshmi',
      name_ta: null,
      phone: null,
      gstin: null,
      state_code: null,
      price_tier: 'retail' as const,
      balance_paise: 0,
      credit_limit_paise: null,
      loyalty_points: 100,
    }
    let s = apply(two, { type: 'set_customer', customer }, { type: 'set_loyalty', points: 40.7 })
    expect(s.loyalty_redeem_points).toBe(40)
    s = apply(s, { type: 'set_customer', customer: null })
    expect(s.loyalty_redeem_points).toBe(0)
    const cleared = apply(s, { type: 'clear' })
    expect(cleared.lines).toEqual([])
    expect(cleared.id).not.toBe(s.id)
    expect(cleared.version).toBeGreaterThan(s.version)
  })

  it('refresh_products swaps the product snapshot after a catalogue sync', () => {
    const fresh = { ...rice, sale_price_paise: 39_000 }
    const s = apply(two, {
      type: 'refresh_products',
      products: new Map([[rice.id, { product: fresh, store_price: null, tax_slabs: null }]]),
    })
    expect(s.lines[0]?.product.sale_price_paise).toBe(39_000)
    expect(s.lines[1]?.product).toBe(dal)
    const untouched = apply(two, { type: 'refresh_products', products: new Map() })
    expect(untouched).toBe(two)
  })

  it('every change bumps the version (persistence and the customer display key off it)', () => {
    const s = apply(two, { type: 'set_qty', key: 'a', qty_milli: 3000 })
    expect(s.version).toBe(two.version + 1)
    // No-op edits keep the same object.
    expect(apply(s, { type: 'set_qty', key: 'a', qty_milli: 3000 })).toBe(s)
  })
})

describe('unit helpers', () => {
  it('steps, decimals and default quantities follow the product unit', () => {
    expect(qtyStepMilli(rice)).toBe(1000)
    expect(qtyStepMilli(paracetamol)).toBe(15_000)
    expect(allowsDecimalQty(sugar)).toBe(true)
    expect(allowsDecimalQty(rice)).toBe(false)
    // One strip per scan / tap (loose tablets via the quantity dialog).
    expect(defaultQtyMilli(paracetamol)).toBe(15_000)
    expect(defaultQtyMilli({ ...paracetamol, allow_loose: false })).toBe(15_000)
    expect(defaultQtyMilli(rice)).toBe(1000)
    expect(packUnitOf(paracetamol)).toBe('STRIP')
    expect(packUnitOf(rice)).toBe('PACK')
  })

  it('isCartState accepts persisted carts and rejects junk', () => {
    expect(isCartState(cartOf([lineOf(rice)]))).toBe(true)
    expect(isCartState({ id: 'x', lines: [{ key: 1 }] })).toBe(false)
    expect(isCartState(null)).toBe(false)
  })
})
