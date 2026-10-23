import { describe, expect, it } from 'vitest'
import type { DisplayCart } from '@/lib/display-channel'
import { displayCartOf } from '../hooks/use-customer-display'
import { nextScreen } from '../lib/display'
import { priceLocalCart } from '../lib/pricing'
import { cartOf, dal, lineOf, makeBootstrap, rice } from './fixtures'
import { pricingEnvOf } from './helpers'

const cart: DisplayCart = {
  lines: [
    {
      key: 'a',
      name: 'Rice',
      name_ta: null,
      qty_milli: 1000,
      unit: 'PCS',
      unit_price_paise: 100,
      total_paise: 100,
      mrp_paise: null,
    },
  ],
  item_count: 1,
  discount_paise: 0,
  tax_paise: 5,
  total_paise: 100,
  mrp_savings_paise: 0,
  customer_name: null,
}

describe('customer display', () => {
  it('walks idle → cart → UPI QR → paid → thank you → idle', () => {
    let s = nextScreen({ kind: 'idle' }, { type: 'cart', cart })
    expect(s.kind).toBe('cart')
    s = nextScreen(s, {
      type: 'upi_qr',
      upi_uri: 'upi://pay?pa=x',
      amount_paise: 100,
      payee_name: 'Shop',
      expires_at: null,
    })
    expect(s).toMatchObject({ kind: 'upi', amount_paise: 100, cart })
    s = nextScreen(s, { type: 'payment_status', status: 'paid' })
    expect(s).toMatchObject({ kind: 'status', status: 'paid', cart })
    s = nextScreen(s, {
      type: 'thank_you',
      total_paise: 100,
      paid_paise: 200,
      change_paise: 100,
      invoice_number: 'S1-A/2627/00005',
    })
    expect(s).toMatchObject({ kind: 'thanks', change_paise: 100, number: 'S1-A/2627/00005' })
    expect(nextScreen(s, { type: 'idle' })).toEqual({ kind: 'idle' })
    expect(nextScreen({ kind: 'idle' }, { type: 'cart', cart: { ...cart, lines: [] } })).toEqual({
      kind: 'idle',
    })
  })

  it('shows the cart as priced on the counter', () => {
    const b = makeBootstrap()
    const c = cartOf([lineOf(rice), lineOf(dal, { qty_milli: 2000 })])
    const d = displayCartOf(c, priceLocalCart(c, pricingEnvOf(b)))
    expect(d.total_paise).toBe(72_500)
    expect(d.mrp_savings_paise).toBe(5_500)
    expect(d.lines.map((l) => [l.name_ta, l.qty_milli, l.total_paise])).toEqual([
      ['பொன்னி அரிசி 5 கிலோ', 1000, 39_500],
      ['துவரம் பருப்பு 1 கிலோ', 2000, 33_000],
    ])
  })
})
