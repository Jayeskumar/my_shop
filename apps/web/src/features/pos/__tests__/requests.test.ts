/**
 * Cart → request bodies: what the counter sends to the sales contract (parsed with the shared
 * request schemas, so a body the server would reject fails here first).
 */
import { describe, expect, it } from 'vitest'
import { newId } from '@kadai/shared/ids'
import {
  InvoiceCreateSchema,
  PosSyncRequestSchema,
  QuoteRequestSchema,
} from '@kadai/shared/api/sales'
import { IDS } from '@/test/fixtures'
import { heldCreateBody, invoiceCreateBody, quoteRequest, syncInvoiceBody } from '../lib/requests'
import { TODAY, cartOf, dal, lineOf, rice } from './fixtures'

const SCOPE = { store_id: IDS.store, register_id: IDS.register }

describe('request bodies', () => {
  it('only what the cashier decided: manual price, hand-picked batch, discounts', () => {
    const cart = cartOf([
      lineOf(rice, { qty_milli: 2_000 }),
      lineOf(dal, { key: 'dal', price_override_paise: 9_900, discount_bp: 500 }),
    ])
    const body = quoteRequest(cart, SCOPE, [{ method: 'cash', amount_paise: 50_000 }])
    expect(QuoteRequestSchema.safeParse(body).success).toBe(true)
    expect(body.lines[0]).toEqual({
      key: cart.lines[0]!.key,
      product_id: rice.id,
      qty_milli: 2_000,
    })
    expect(body.lines[1]).toMatchObject({ unit_price_paise: 9_900, discount_bp: 500 })
    expect(body.lines[1]).not.toHaveProperty('batch_id')
  })

  it('bills and held bills carry the cart id as client_ref', () => {
    const cart = cartOf([lineOf(rice)])
    const bill = invoiceCreateBody(cart, SCOPE, [{ method: 'cash', amount_paise: 10_000 }])
    expect(InvoiceCreateSchema.safeParse(bill).success).toBe(true)
    expect(bill).toMatchObject({ client_ref: cart.id, status: 'completed', channel: 'pos' })
    const held = heldCreateBody(cart, SCOPE, 'Table 4')
    expect(held).toMatchObject({ client_ref: cart.id, status: 'held', notes: 'Table 4' })
  })

  it('an offline bill of a recalled held bill names the held bill (retired at sync)', () => {
    const heldId = newId()
    const cart = cartOf([lineOf(rice)], { held_invoice_id: heldId })
    const clientRef = newId()
    const body = syncInvoiceBody(cart, SCOPE, {
      client_ref: clientRef,
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
      offline_number: 'S1-A/2627/00007',
      invoice_date: TODAY,
      created_at: new Date().toISOString(),
    })
    expect(body).toMatchObject({ client_ref: clientRef, held_invoice_id: heldId })
    const parsed = PosSyncRequestSchema.safeParse({ register_id: IDS.register, invoices: [body] })
    expect(parsed.success).toBe(true)

    const fresh = syncInvoiceBody(cartOf([lineOf(rice)]), SCOPE, {
      client_ref: newId(),
      tenders: [],
      offline_number: null,
      invoice_date: TODAY,
      created_at: new Date().toISOString(),
    })
    expect(fresh).not.toHaveProperty('held_invoice_id')
  })
})
