import { describe, expect, it } from 'vitest'
import {
  InvoiceSaveResultSchema,
  PosBootstrapSchema,
  QuoteResultSchema,
} from '@kadai/shared/api/sales'
import { priceLocalCart } from '../lib/pricing'
import { cartOf, dal, invoiceResultFor, lineOf, makeBootstrap, quoteFor, rice } from './fixtures'
import { pricingEnvOf } from './helpers'

describe('POS test fixtures follow the sales contract', () => {
  it('bootstrap', () => {
    expect(PosBootstrapSchema.safeParse(makeBootstrap()).error).toBeUndefined()
  })

  it('quote and invoice save result', () => {
    const cart = cartOf([lineOf(rice), lineOf(dal, { qty_milli: 2000 })])
    const pricing = priceLocalCart(cart, pricingEnvOf(makeBootstrap()))
    const quote = quoteFor(cart, pricing)
    expect(QuoteResultSchema.safeParse(quote).error).toBeUndefined()
    const saved = invoiceResultFor(quote, {
      client_ref: cart.id,
      number: 'S1-A/2627/00005',
      cash_paise: 100_000,
    })
    expect(InvoiceSaveResultSchema.safeParse(saved).error).toBeUndefined()
  })
})
