/**
 * Returns (credit notes): returnable quantities, exact pro-rata amounts over partial returns,
 * restocking at the original cost, journal, settlement variants, loyalty reversal, cancellation,
 * free-form returns, permissions and tenant isolation.
 */
import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { storeCreditBalance } from '../../../core/payments'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  API,
  addStock,
  clientRef,
  customerBalance,
  dataOf,
  errorOf,
  expectLedgerBalanced,
  expectStockConsistent,
  insertCustomer,
  insertProduct,
  journalOf,
  line,
  netBySubtype,
  sell,
  setSettings,
  stockOf,
} from './fixtures'

let t: TestApp
let shop: TestShop

interface Note {
  id: string
  number: string
  status: string
  total_paise: number
  settled_paise: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  round_off_paise: number
  cost_paise: number
  settlement: string
  loyalty_points_reversed: number
  loyalty_points_restored: number
  payments: Array<{ method: string; direction: string; amount_paise: number; status: string }>
  lines: Array<{
    taxable_paise: number
    cgst_paise: number
    sgst_paise: number
    total_paise: number
    restock: boolean
    cost_paise: number
  }>
}

async function returnGoods(
  s: TestShop,
  body: Record<string, unknown>,
  as?: Parameters<TestShop['inject']>[0]['as'],
) {
  return s.inject({
    method: 'POST',
    url: `${API}/sales/credit-notes`,
    payload: { client_ref: clientRef(), reason: 'return', settlement: 'cash', ...body },
    ...(as !== undefined ? { as } : {}),
  })
}

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t)
})
afterAll(() => t.close())

describe('returns', () => {
  it('three partial returns sum exactly to the original line', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 3_333, gst_rate_bp: 500 })
    await addStock(shop, { product_id: p, qty_milli: 10_000, unit_cost_paise: 2_000 })
    const r = await sell(shop, {
      lines: [line(p, 3_000)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const src = r.invoice.lines[0]!
    const returnable = dataOf<{
      lines: Array<{ invoice_line_id: string; returnable_qty_milli: number }>
      refundable_paise: number
    }>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${r.invoice.id}/returnable` }),
    )
    expect(returnable.lines[0]).toMatchObject({
      invoice_line_id: src.id,
      returnable_qty_milli: 3_000,
    })
    expect(returnable.refundable_paise).toBe(r.invoice.total_paise)

    const notes: Note[] = []
    for (let i = 0; i < 3; i++) {
      notes.push(
        dataOf<Note>(
          await returnGoods(shop, {
            invoice_id: r.invoice.id,
            lines: [{ invoice_line_id: src.id, qty_milli: 1_000 }],
          }),
          201,
        ),
      )
    }
    const sum = (k: 'taxable_paise' | 'cgst_paise' | 'sgst_paise') =>
      notes.reduce((s, n) => s + n.lines[0]![k], 0)
    expect(sum('taxable_paise')).toBe(src['taxable_paise'])
    expect(sum('cgst_paise')).toBe(src['cgst_paise'])
    expect(sum('sgst_paise')).toBe(src['sgst_paise'])
    // The note that completes the return takes the round-off that makes Σ notes = the bill.
    expect(notes.reduce((s, n) => s + n.total_paise, 0)).toBe(r.invoice.total_paise)
    expect(notes[0]!.number).toMatch(/^CNS1\//)

    const more = await returnGoods(shop, {
      invoice_id: r.invoice.id,
      lines: [{ invoice_line_id: src.id, qty_milli: 1_000 }],
    })
    expect(more.statusCode).toBe(422)
    expect(errorOf(more).details?.['reason']).toBe('return_exceeds_returnable')

    const detail = dataOf<{
      returned_paise: number
      payment_status: string
      credit_notes: unknown[]
    }>(await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${r.invoice.id}` }))
    expect(detail.returned_paise).toBe(r.invoice.total_paise)
    expect(detail.payment_status).toBe('refunded')
    expect(detail.credit_notes).toHaveLength(3)
    expect(await stockOf(t, shop.tenant.id, p)).toBe(10_000)
    await expectLedgerBalanced(t, shop.tenant.id)
    await expectStockConsistent(t, shop.tenant.id)
  })

  it('restocks at the original cost; damaged goods are not restocked; journal per §10', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 11_800, gst_rate_bp: 1800 })
    await addStock(shop, { product_id: p, qty_milli: 5_000, unit_cost_paise: 5_000 })
    const r = await sell(shop, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 23_600 }],
    })
    // The average cost moves after the sale; the return must use the cost of the sale.
    await addStock(shop, { product_id: p, qty_milli: 3_000, unit_cost_paise: 9_000 })
    const src = r.invoice.lines[0]!
    const good = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: r.invoice.id,
        lines: [{ invoice_line_id: src.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(good.lines[0]).toMatchObject({ restock: true, cost_paise: 5_000 })
    expect(good.total_paise).toBe(11_800)
    const j = netBySubtype(await journalOf(t, shop.tenant.id, 'credit_note', good.id))
    expect(j).toMatchObject({
      sales_returns: 10_000,
      output_cgst: 900,
      output_sgst: 900,
      receivable: -11_800,
      inventory: 5_000,
      cogs: -5_000,
    })
    const damaged = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: r.invoice.id,
        reason: 'damaged',
        lines: [{ invoice_line_id: src.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(damaged.lines[0]?.restock).toBe(false)
    expect(damaged.cost_paise).toBe(0)
    expect(await stockOf(t, shop.tenant.id, p)).toBe(5_000 - 2_000 + 3_000 + 1_000)
    await expectLedgerBalanced(t, shop.tenant.id)
  })

  it('settlements: refund capped by what was paid, adjust against the due, store credit', async () => {
    const c = await insertCustomer(t, shop, { credit_limit_paise: 10_000_000 })
    const p = await insertProduct(t, shop, { sale_price_paise: 10_000, track_inventory: false })
    const credit = await sell(shop, {
      customer_id: c,
      lines: [line(p, 5_000)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    expect(credit.invoice.due_paise).toBe(40_000)
    const lineId = credit.invoice.lines[0]!.id

    // Paid 100, returning 200 by cash is more than was paid.
    const refund = await returnGoods(shop, {
      invoice_id: credit.invoice.id,
      lines: [{ invoice_line_id: lineId, qty_milli: 2_000 }],
    })
    expect(refund.statusCode).toBe(422)
    expect(errorOf(refund).details?.['reason']).toBe('settlement_not_allowed')

    const adjust = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: credit.invoice.id,
        settlement: 'adjust_due',
        lines: [{ invoice_line_id: lineId, qty_milli: 2_000 }],
      }),
      201,
    )
    expect(adjust.settled_paise).toBe(20_000)
    let inv = dataOf<{ due_paise: number; payment_status: string }>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${credit.invoice.id}` }),
    )
    expect(inv.due_paise).toBe(20_000)
    expect((await customerBalance(t, c)).balance_paise).toBe(20_000)

    const cash = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: credit.invoice.id,
        settlement: 'cash',
        lines: [{ invoice_line_id: lineId, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(cash.payments[0]).toMatchObject({
      method: 'cash',
      direction: 'out',
      amount_paise: 10_000,
    })
    expect(cash.settled_paise).toBe(10_000)

    // Due 200 left: returning 200 more as adjust_due clears it.
    const store = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: credit.invoice.id,
        settlement: 'store_credit',
        lines: [{ invoice_line_id: lineId, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(store.payments[0]).toMatchObject({ method: 'store_credit', direction: 'out' })
    expect(await shop.tx((tx) => storeCreditBalance(tx, shop.ctx, c))).toBe(10_000)
    inv = dataOf<{ due_paise: number; payment_status: string }>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${credit.invoice.id}` }),
    )
    expect(inv.due_paise).toBe(20_000)
    // Receivable: 400 due − 200 adjusted = 200 (refunds and store credit do not change it).
    expect((await customerBalance(t, c)).balance_paise).toBe(20_000)
    await expectLedgerBalanced(t, shop.tenant.id)
  })

  it('adjust_due beyond the due turns the excess into store credit (customer only)', async () => {
    const c = await insertCustomer(t, shop, { credit_limit_paise: 10_000_000 })
    const p = await insertProduct(t, shop, { sale_price_paise: 10_000, track_inventory: false })
    const r = await sell(shop, {
      customer_id: c,
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 15_000 }],
    })
    expect(r.invoice.due_paise).toBe(5_000)
    const note = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: r.invoice.id,
        settlement: 'adjust_due',
        lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(note.settled_paise).toBe(10_000)
    expect(await shop.tx((tx) => storeCreditBalance(tx, shop.ctx, c))).toBe(5_000)
    expect((await customerBalance(t, c)).balance_paise).toBe(0)

    const walkIn = await sell(shop, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 20_000 }],
    })
    const notAllowed = await returnGoods(shop, {
      invoice_id: walkIn.invoice.id,
      settlement: 'store_credit',
      lines: [{ invoice_line_id: walkIn.invoice.lines[0]!.id, qty_milli: 1_000 }],
    })
    expect(notAllowed.statusCode).toBe(422)
  })

  it('reverses loyalty proportionally', async () => {
    const s = await createTestTenant(t, {
      settings: {
        loyalty: {
          enabled: true,
          points_per_100_rupees: 10,
          point_value_paise: 100,
          min_redeem_points: 1,
        },
      },
    })
    const c = await insertCustomer(t, s, {})
    const p = await insertProduct(t, s, { sale_price_paise: 10_000, track_inventory: false })
    const r = await sell(s, {
      customer_id: c,
      lines: [line(p, 4_000)],
      tenders: [{ method: 'cash', amount_paise: 40_000 }],
    })
    expect(r.invoice['loyalty_points_earned']).toBe(40)
    const note = dataOf<Note>(
      await returnGoods(s, {
        invoice_id: r.invoice.id,
        lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(note.loyalty_points_reversed).toBe(10)
    expect((await customerBalance(t, c)).loyalty_points).toBe(30)
  })

  it('cancel a credit note: stock, journal, settlement and returned quantities are restored', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 5_000 })
    await addStock(shop, { product_id: p, qty_milli: 5_000 })
    const r = await sell(shop, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const note = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: r.invoice.id,
        lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(await stockOf(t, shop.tenant.id, p)).toBe(4_000)
    const blocked = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/cancel`,
      payload: { reason: 'oops' },
    })
    expect(blocked.statusCode).toBe(409)
    expect(errorOf(blocked).details?.['reason']).toBe('has_credit_notes')

    const cashier = await shop.asRole('cashier')
    const denied = await shop.inject({
      method: 'POST',
      url: `${API}/sales/credit-notes/${note.id}/cancel`,
      payload: { reason: 'Entered by mistake' },
      as: cashier,
    })
    expect(denied.statusCode).toBe(403)
    const cancelled = dataOf<Note>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/credit-notes/${note.id}/cancel`,
        payload: { reason: 'Entered by mistake' },
      }),
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.payments[0]?.status).toBe('cancelled')
    expect(await stockOf(t, shop.tenant.id, p)).toBe(3_000)
    const net = netBySubtype(await journalOf(t, shop.tenant.id, 'credit_note', note.id))
    for (const v of Object.values(net)) expect(v).toBe(0)
    const ret = dataOf<{ lines: Array<{ returnable_qty_milli: number }> }>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${r.invoice.id}/returnable` }),
    )
    expect(ret.lines[0]?.returnable_qty_milli).toBe(2_000)
    const twice = await shop.inject({
      method: 'POST',
      url: `${API}/sales/credit-notes/${note.id}/cancel`,
      payload: { reason: 'again' },
    })
    expect(twice.statusCode).toBe(409)
    // Now the invoice can be cancelled.
    const ok = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/cancel`,
      payload: { reason: 'oops' },
    })
    expect(ok.statusCode).toBe(200)
    await expectLedgerBalanced(t, shop.tenant.id)
    await expectStockConsistent(t, shop.tenant.id)
  })

  it('free-form returns need manager permission, a store and prices', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 11_800, gst_rate_bp: 1800 })
    const cashier = await shop.asRole('cashier')
    const body = {
      store_id: shop.store.id,
      lines: [{ product_id: p, qty_milli: 1_000, unit_price_paise: 11_800 }],
    }
    const denied = await returnGoods(shop, body, cashier)
    expect(denied.statusCode).toBe(403)
    const noStore = await returnGoods(shop, { lines: body.lines })
    expect(noStore.statusCode).toBe(400)
    const note = dataOf<Note>(await returnGoods(shop, body), 201)
    expect(note.total_paise).toBe(11_800)
    expect(note.taxable_paise).toBe(10_000)
    expect(await stockOf(t, shop.tenant.id, p)).toBe(1_000)
  })

  it('lists, detail, CSV and print', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 2_500, track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 5_000 }],
    })
    const note = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: r.invoice.id,
        lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    const list = (
      await shop.inject({
        method: 'GET',
        url: `${API}/sales/credit-notes?invoice_id=${r.invoice.id}`,
      })
    ).json() as {
      data: Array<{ id: string; invoice_number: string }>
      summary: { count: number; total_paise: number }
    }
    expect(list.data.map((n) => n.id)).toEqual([note.id])
    expect(list.data[0]?.invoice_number).toBe(r.invoice.number)
    expect(list.summary).toEqual({ count: 1, total_paise: 2_500 })
    const csv = await shop.inject({
      method: 'GET',
      url: `${API}/sales/credit-notes?format=csv&invoice_id=${r.invoice.id}`,
    })
    expect(csv.body).toContain(note.number)
    const print = dataOf<{
      kind: string
      title: { en: string }
      document: { original_invoice: { number: string } | null }
      settlement: { method: string } | null
    }>(
      await shop.inject({
        method: 'GET',
        url: `${API}/sales/credit-notes/${note.id}/print?format=a4`,
      }),
    )
    expect(print.kind).toBe('credit_note')
    expect(print.title.en).toBe('Credit Note')
    expect(print.document.original_invoice?.number).toBe(r.invoice.number)
    expect(print.settlement?.method).toBe('cash')
    const viewer = await shop.asRole('viewer_y', { permissions: ['sales.read'] })
    expect(
      (
        await shop.inject({
          method: 'GET',
          url: `${API}/sales/credit-notes/${note.id}`,
          as: viewer,
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await returnGoods(
          shop,
          {
            invoice_id: r.invoice.id,
            lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
          },
          viewer,
        )
      ).statusCode,
    ).toBe(403)
  })

  it('is idempotent by client_ref and isolated per tenant', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 2_000, track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 4_000 }],
    })
    const ref = clientRef()
    const body = {
      client_ref: ref,
      invoice_id: r.invoice.id,
      lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
    }
    const a = dataOf<Note>(await returnGoods(shop, body), 201)
    const b = dataOf<Note>(await returnGoods(shop, body), 201)
    expect(b.id).toBe(a.id)
    const other = await createTestTenant(t)
    const foreign = await returnGoods(other, {
      invoice_id: r.invoice.id,
      lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
    })
    expect(foreign.statusCode).toBe(404)
    expect(
      (await other.inject({ method: 'GET', url: `${API}/sales/credit-notes/${a.id}` })).statusCode,
    ).toBe(404)
    expect(
      (await other.inject({ method: 'GET', url: `${API}/sales/invoices/${newId()}/returnable` }))
        .statusCode,
    ).toBe(404)
  })

  it('round-off follows settings', async () => {
    await setSettings(shop, { invoice: { round_off: 'none' } })
    const p = await insertProduct(t, shop, {
      sale_price_paise: 3_333,
      gst_rate_bp: 1800,
      track_inventory: false,
    })
    const r = await sell(shop, {
      lines: [line(p, 2_000)],
      tenders: [{ method: 'cash', amount_paise: 6_666 }],
    })
    expect(r.invoice.total_paise).toBe(6_666)
    const note = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: r.invoice.id,
        lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(note.round_off_paise).toBe(0)
    // Each tax head is pro-rated on its own: 2825 + 255 + 254.
    expect(note.total_paise).toBe(3_334)
    const rest = dataOf<Note>(
      await returnGoods(shop, {
        invoice_id: r.invoice.id,
        lines: [{ invoice_line_id: r.invoice.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(note.total_paise + rest.total_paise).toBe(6_666)
    await setSettings(shop, { invoice: { round_off: 'nearest_rupee' } })
  })
})
