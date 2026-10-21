/**
 * Sales invoices: posting (stock, journal, tenders, due), idempotency, numbering, held bills,
 * cancellation, dues collection, lists, permissions, plan limits and tenant isolation.
 */
import { generateReferenceCode, newId, periodOf, todayIn } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  API,
  type SaleData,
  addStock,
  clientRef,
  createSale,
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
  stockOf,
} from './fixtures'

let t: TestApp
let shop: TestShop
let today: string

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t, { settings: { credit: { block_over_limit: true } } })
  today = todayIn('Asia/Kolkata')
})
afterAll(() => t.close())

async function paymentJournal(sale: SaleData) {
  const ids = sale.tenders.map((x) => x.payment_id).filter((x): x is string => x !== null)
  const lines = []
  for (const id of ids) lines.push(...(await journalOf(t, shop.tenant.id, 'payment', id)))
  return lines
}

describe('POST /sales/invoices — completed bills', () => {
  it('cash sale: inclusive GST, change, stock, COGS and a balanced journal', async () => {
    const p = await insertProduct(t, shop, {
      sale_price_paise: 11_800,
      gst_rate_bp: 1800,
      mrp_paise: 12_500,
    })
    await addStock(shop, { product_id: p, qty_milli: 10_000, unit_cost_paise: 7_000 })
    const r = await sell(shop, {
      lines: [line(p, 2000)],
      tenders: [{ method: 'cash', amount_paise: 30_000 }],
    })
    const inv = r.invoice
    expect(inv.status).toBe('completed')
    expect(inv.number).toMatch(/^S1-A\/\d{4}\/\d+$/)
    expect(inv.total_paise).toBe(23_600)
    expect(inv['taxable_paise']).toBe(20_000)
    expect(inv['cgst_paise']).toBe(1_800)
    expect(inv['sgst_paise']).toBe(1_800)
    expect(inv.paid_paise).toBe(23_600)
    expect(inv.due_paise).toBe(0)
    expect(inv.payment_status).toBe('paid')
    expect(inv.cost_paise).toBe(14_000)
    expect(inv['mrp_savings_paise']).toBe(1_400)
    expect(r.change_paise).toBe(6_400)
    expect(r.tenders[0]).toMatchObject({ applied_paise: 23_600, change_paise: 6_400 })
    expect(await stockOf(t, shop.tenant.id, p)).toBe(8_000)

    const payments = inv['payments'] as Array<{ change_paise: number | null; origin: string }>
    expect(payments[0]).toMatchObject({ change_paise: 6_400, origin: 'sales_tender' })

    const sale = netBySubtype(await journalOf(t, shop.tenant.id, 'sales_invoice', inv.id))
    expect(sale).toMatchObject({
      receivable: 23_600,
      sales: -20_000,
      output_cgst: -1_800,
      output_sgst: -1_800,
      cogs: 14_000,
      inventory: -14_000,
    })
    const pay = netBySubtype(await paymentJournal(r))
    expect(pay).toMatchObject({ cash: 23_600, receivable: -23_600 })
    expect(inv['journal_entry_id']).toBeTruthy()
    await expectLedgerBalanced(t, shop.tenant.id)
    await expectStockConsistent(t, shop.tenant.id)
  })

  it('exclusive prices to another state: IGST and place of supply', async () => {
    const p = await insertProduct(t, shop, {
      sale_price_paise: 10_000,
      gst_rate_bp: 1800,
      price_includes_tax: false,
      track_inventory: false,
    })
    const r = await sell(shop, {
      channel: 'backoffice',
      register_id: undefined,
      place_of_supply: '29',
      lines: [line(p)],
      tenders: [{ method: 'bank_transfer', amount_paise: 11_800, reference: 'NEFT123' }],
    })
    expect(r.invoice['is_interstate']).toBe(true)
    expect(r.invoice['igst_paise']).toBe(1_800)
    expect(r.invoice['cgst_paise']).toBe(0)
    expect(r.invoice.total_paise).toBe(11_800)
    expect(r.invoice.number).toMatch(/^S1\/\d{4}\//)
    const j = netBySubtype(await journalOf(t, shop.tenant.id, 'sales_invoice', r.invoice.id))
    expect(j.output_igst).toBe(-1_800)
  })

  it('cess and round off to the rupee', async () => {
    const p = await insertProduct(t, shop, {
      sale_price_paise: 10_000,
      gst_rate_bp: 2800,
      cess_rate_bp: 1200,
      price_includes_tax: false,
      track_inventory: false,
    })
    const q = await insertProduct(t, shop, { sale_price_paise: 9_999, track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p), line(q)],
      tenders: [{ method: 'cash', amount_paise: 30_000 }],
    })
    expect(r.invoice['cess_paise']).toBe(1_200)
    // 14000 + 9999 = 23999 → 24000
    expect(r.invoice['round_off_paise']).toBe(1)
    expect(r.invoice.total_paise).toBe(24_000)
    const j = netBySubtype(await journalOf(t, shop.tenant.id, 'sales_invoice', r.invoice.id))
    expect(j.output_cess).toBe(-1_200)
    expect(j.round_off).toBe(-1)
    await expectLedgerBalanced(t, shop.tenant.id)
  })

  it('split tenders: UPI (static QR) + card + cash with change', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 50_000, track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p)],
      tenders: [
        { method: 'cash', amount_paise: 20_000 },
        { method: 'upi', amount_paise: 20_000, reference: '412345678901' },
        { method: 'card', amount_paise: 15_000 },
      ],
    })
    // Non-cash first: 20000 + 15000, then cash 15000 of the 20000 handed over.
    expect(r.tenders.map((x) => x.applied_paise)).toEqual([15_000, 20_000, 15_000])
    expect(r.change_paise).toBe(5_000)
    expect(r.invoice.paid_paise).toBe(50_000)
    const pay = netBySubtype(await paymentJournal(r))
    expect(pay).toMatchObject({
      cash: 15_000,
      bank: 20_000,
      card_clearing: 15_000,
      receivable: -50_000,
    })
  })

  it('credit sale: due on the customer, balance and due date', async () => {
    const c = await insertCustomer(t, shop, { credit_limit_paise: 100_000, credit_days: 15 })
    const p = await insertProduct(t, shop, { sale_price_paise: 30_000, track_inventory: false })
    const r = await sell(shop, {
      customer_id: c,
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    expect(r.invoice.due_paise).toBe(20_000)
    expect(r.invoice.payment_status).toBe('partial')
    expect(r.invoice['due_date']).toBe(
      new Date(Date.parse(`${today}T00:00:00Z`) + 15 * 86_400_000).toISOString().slice(0, 10),
    )
    expect((await customerBalance(t, c)).balance_paise).toBe(20_000)
    const j = await journalOf(t, shop.tenant.id, 'sales_invoice', r.invoice.id)
    expect(j.find((l) => l.subtype === 'receivable')?.party_id).toBe(c)
  })

  it('credit needs a customer, sales.credit and respects the limit (override audited)', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 60_000, track_inventory: false })
    const walkIn = await createSale(shop, { lines: [line(p)], tenders: [] })
    expect(walkIn.statusCode).toBe(422)
    expect(errorOf(walkIn).details?.['reason']).toBe('customer_required_for_credit')

    const c = await insertCustomer(t, shop, { credit_limit_paise: 50_000 })
    const over = await createSale(shop, { customer_id: c, lines: [line(p)] })
    expect(over.statusCode).toBe(422)
    expect(errorOf(over).code).toBe('CREDIT_LIMIT_EXCEEDED')

    const noCredit = await shop.asRole('no_credit', {
      permissions: ['pos.use', 'sales.create', 'sales.read'],
    })
    const denied = await createSale(shop, { customer_id: c, lines: [line(p)] }, noCredit)
    expect(denied.statusCode).toBe(403)
    expect(errorOf(denied).details?.['reason']).toBe('credit_permission_required')

    const ok = await sell(shop, { customer_id: c, lines: [line(p)], credit_limit_override: true })
    expect(ok.invoice.due_paise).toBe(60_000)
    expect(ok.warnings.map((w) => w.code)).toContain('over_credit_limit')
    const detail = dataOf<{ audit: Array<{ action: string }> }>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${ok.invoice.id}` }),
    )
    expect(detail.audit.map((a) => a.action)).toContain('sales_invoice.override')
  })

  it('UPI intent tender is consumed exactly once', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 25_000, track_inventory: false })
    const acct = newId()
    await t.deps.db.systemDb
      .insertInto('payment_provider_accounts')
      .values({
        id: acct,
        tenant_id: shop.tenant.id,
        provider: 'upi_vpa',
        display_name: 'Shop UPI',
        vpa: 'kadai.shop@okaxis',
      })
      .execute()
    const intent = newId()
    await t.deps.db.systemDb
      .insertInto('payment_intents')
      .values({
        id: intent,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        provider_account_id: acct,
        provider: 'upi_vpa',
        purpose: 'pos_sale',
        reference_code: generateReferenceCode(),
        amount_paise: 25_000,
        status: 'paid',
        paid_amount_paise: 25_000,
        utr: '429876543210',
      })
      .execute()
    const tender = { method: 'upi' as const, amount_paise: 25_000, payment_intent_id: intent }
    const r = await sell(shop, { lines: [line(p)], tenders: [tender] })
    expect(r.invoice.payment_status).toBe('paid')
    const used = await t.deps.db.systemDb
      .selectFrom('payment_intents')
      .select('payment_id')
      .where('id', '=', intent)
      .executeTakeFirstOrThrow()
    expect(used.payment_id).toBe(r.tenders[0]!.payment_id)
    // Walk-in: the receivable posted by the sale is cleared by the UPI receipt (bank for upi_vpa).
    const sale = netBySubtype(await journalOf(t, shop.tenant.id, 'sales_invoice', r.invoice.id))
    const pay = netBySubtype(await paymentJournal(r))
    expect((sale.receivable ?? 0) + (pay.receivable ?? 0)).toBe(0)
    expect(pay.bank).toBe(25_000)
    const again = await createSale(shop, { lines: [line(p)], tenders: [tender] })
    expect(again.statusCode).toBe(422)
    expect(errorOf(again).details?.['reason']).toBe('payment_intent_invalid')
  })

  it('validation errors: unknown product, POS without client_ref, bad tender', async () => {
    const unknown = await createSale(shop, { lines: [line(newId())] })
    expect(unknown.statusCode).toBe(404)
    expect(errorOf(unknown).details?.['reason']).toBe('product_not_found')

    const noRef = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices`,
      payload: { store_id: shop.store.id, lines: [line(newId())] },
    })
    expect(noRef.statusCode).toBe(400)

    const p = await insertProduct(t, shop, { sale_price_paise: 1_000, track_inventory: false })
    const tooMuch = await createSale(shop, {
      lines: [line(p)],
      tenders: [{ method: 'card', amount_paise: 5_000 }],
    })
    expect(tooMuch.statusCode).toBe(422)
    expect(errorOf(tooMuch).details?.['reason']).toBe('tender_exceeds_due')
  })
})

describe('idempotency and numbering', () => {
  it('the same client_ref twice returns the same invoice (one document, one stock movement)', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 5_000 })
    await addStock(shop, { product_id: p, qty_milli: 5_000 })
    const ref = clientRef()
    const body = {
      client_ref: ref,
      lines: [line(p)],
      tenders: [{ method: 'cash' as const, amount_paise: 5_000 }],
    }
    const a = await sell(shop, body)
    const second = await createSale(shop, body)
    expect(second.statusCode).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    const b = dataOf<SaleData>(second, 201)
    expect(b.invoice.id).toBe(a.invoice.id)
    expect(b.invoice.number).toBe(a.invoice.number)
    expect(await stockOf(t, shop.tenant.id, p)).toBe(4_000)

    const mismatch = await createSale(shop, { ...body, lines: [line(p, 2000)] })
    expect(mismatch.statusCode).toBe(409)
    expect(errorOf(mismatch).code).toBe('IDEMPOTENCY_MISMATCH')
  })

  it('concurrent POS saves get gapless consecutive numbers', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 1_000, track_inventory: false })
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createSale(shop, { lines: [line(p)], tenders: [{ method: 'cash', amount_paise: 1_000 }] }),
      ),
    )
    const numbers = results.map((r) => dataOf<SaleData>(r, 201).invoice.number!)
    const seqs = numbers.map((n) => Number(n.split('/').at(-1))).sort((x, y) => x - y)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1)
    expect(new Set(numbers).size).toBe(8)
  })
})

describe('held bills and drafts', () => {
  it('hold → list → edit → complete at current prices; delete a draft', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 4_000 })
    await addStock(shop, { product_id: p, qty_milli: 10_000 })
    const held = await sell(shop, { status: 'held', lines: [line(p, 2000)], notes: 'Table 4' })
    expect(held.invoice.status).toBe('held')
    expect(held.invoice.number).toBeNull()
    expect(held.invoice.total_paise).toBe(8_000)
    expect(await stockOf(t, shop.tenant.id, p)).toBe(10_000)
    expect(await journalOf(t, shop.tenant.id, 'sales_invoice', held.invoice.id)).toHaveLength(0)

    const list = dataOf<Array<{ id: string }>>(
      await shop.inject({ method: 'GET', url: `${API}/sales/held?store_id=${shop.store.id}` }),
    )
    expect(list.map((h) => h.id)).toContain(held.invoice.id)

    const patched = dataOf<{ total_paise: number; lines: unknown[]; updated_at: string }>(
      await shop.inject({
        method: 'PATCH',
        url: `${API}/sales/invoices/${held.invoice.id}`,
        payload: { lines: [line(p, 3000)] },
      }),
    )
    expect(patched.total_paise).toBe(12_000)
    const stale = await shop.inject({
      method: 'PATCH',
      url: `${API}/sales/invoices/${held.invoice.id}`,
      payload: { notes: 'x', if_updated_at: '2020-01-01T00:00:00.000Z' },
    })
    expect(stale.statusCode).toBe(409)
    expect(errorOf(stale).code).toBe('STALE_WRITE')

    // The price went up after the bill was held: completion re-prices.
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ sale_price_paise: 5_000 })
      .where('id', '=', p)
      .execute()
    const done = dataOf<SaleData>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${held.invoice.id}/complete`,
        payload: {
          tenders: [{ method: 'cash', amount_paise: 15_000 }],
          register_id: shop.register.id,
        },
      }),
    )
    expect(done.invoice.id).toBe(held.invoice.id)
    expect(done.invoice.status).toBe('completed')
    expect(done.invoice.total_paise).toBe(15_000)
    expect(done.invoice.number).toBeTruthy()
    expect(await stockOf(t, shop.tenant.id, p)).toBe(7_000)

    const again = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${held.invoice.id}/complete`,
      payload: { tenders: [] },
    })
    expect(again.statusCode).toBe(409)
    const del = await shop.inject({
      method: 'DELETE',
      url: `${API}/sales/invoices/${held.invoice.id}`,
    })
    expect(del.statusCode).toBe(409)

    const draft = await sell(shop, { status: 'draft', channel: 'backoffice', lines: [line(p)] })
    const gone = await shop.inject({
      method: 'DELETE',
      url: `${API}/sales/invoices/${draft.invoice.id}`,
    })
    expect(gone.statusCode).toBe(204)
    const missing = await shop.inject({
      method: 'GET',
      url: `${API}/sales/invoices/${draft.invoice.id}`,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('held bills cannot carry tenders', async () => {
    const p = await insertProduct(t, shop, { track_inventory: false })
    const res = await createSale(shop, {
      status: 'held',
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 100 }],
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /sales/invoices/:id/cancel', () => {
  it('restores stock at the original cost, reverses the ledger and the customer balance', async () => {
    const c = await insertCustomer(t, shop, { credit_limit_paise: 1_000_000 })
    const p = await insertProduct(t, shop, { sale_price_paise: 10_000, gst_rate_bp: 500 })
    await addStock(shop, { product_id: p, qty_milli: 5_000, unit_cost_paise: 6_000 })
    const r = await sell(shop, {
      customer_id: c,
      lines: [line(p, 2000)],
      tenders: [{ method: 'cash', amount_paise: 5_000 }],
    })
    expect((await customerBalance(t, c)).balance_paise).toBe(15_000)
    const cashier = await shop.asRole('cashier')
    const denied = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/cancel`,
      payload: { reason: 'Wrong bill' },
      as: cashier,
    })
    expect(denied.statusCode).toBe(403)

    const res = dataOf<{
      invoice: { status: string; due_paise: number; payment_status: string }
      refunds: Array<{ method: string; amount_paise: number; psp_refund_required: boolean }>
    }>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${r.invoice.id}/cancel`,
        payload: { reason: 'Wrong bill' },
      }),
    )
    expect(res.invoice.status).toBe('cancelled')
    expect(res.refunds).toEqual([
      expect.objectContaining({ method: 'cash', amount_paise: 5_000, psp_refund_required: false }),
    ])
    expect(await stockOf(t, shop.tenant.id, p)).toBe(5_000)
    expect((await customerBalance(t, c)).balance_paise).toBe(0)
    const net = netBySubtype(await journalOf(t, shop.tenant.id, 'sales_invoice', r.invoice.id))
    for (const v of Object.values(net)) expect(v).toBe(0)
    const movements = await t.deps.db.systemDb
      .selectFrom('stock_movements')
      .select(['movement_type', 'unit_cost_paise'])
      .where('ref_id', '=', r.invoice.id)
      .execute()
    expect(movements.find((m) => m.movement_type === 'sale_cancel')?.unit_cost_paise).toBe(6_000)

    const twice = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/cancel`,
      payload: { reason: 'Again' },
    })
    expect(twice.statusCode).toBe(409)
    await expectLedgerBalanced(t, shop.tenant.id)
    await expectStockConsistent(t, shop.tenant.id)
  })

  it('a UPI tender is flagged for a manual PSP refund', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 2_000, track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p)],
      tenders: [{ method: 'upi', amount_paise: 2_000 }],
    })
    const res = dataOf<{ refunds: Array<{ psp_refund_required: boolean }> }>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${r.invoice.id}/cancel`,
        payload: { reason: 'Customer changed mind' },
      }),
    )
    expect(res.refunds[0]?.psp_refund_required).toBe(true)
  })
})

describe('POST /sales/invoices/:id/payments (dues collection)', () => {
  it('collects part of the due with a numbered receipt', async () => {
    const c = await insertCustomer(t, shop, { credit_limit_paise: 1_000_000 })
    const p = await insertProduct(t, shop, { sale_price_paise: 40_000, track_inventory: false })
    const r = await sell(shop, { customer_id: c, lines: [line(p)] })
    expect(r.invoice.due_paise).toBe(40_000)
    const res = dataOf<{
      invoice: {
        due_paise: number
        paid_paise: number
        payment_status: string
        payments: Array<{ number: string | null }>
      }
      change_paise: number
    }>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${r.invoice.id}/payments`,
        payload: { tenders: [{ method: 'cash', amount_paise: 25_000 }], client_ref: clientRef() },
      }),
      201,
    )
    expect(res.invoice.due_paise).toBe(15_000)
    expect(res.invoice.payment_status).toBe('partial')
    expect(res.invoice.payments[0]?.number).toMatch(/^RC/)
    expect((await customerBalance(t, c)).balance_paise).toBe(15_000)

    const tooMuch = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/payments`,
      payload: { tenders: [{ method: 'upi', amount_paise: 20_000 }] },
    })
    expect(tooMuch.statusCode).toBe(422)
    const viewer = await shop.asRole('viewer_x', { permissions: ['sales.read'] })
    const denied = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/payments`,
      payload: { tenders: [{ method: 'cash', amount_paise: 100 }] },
      as: viewer,
    })
    expect(denied.statusCode).toBe(403)
  })
})

describe('GET /sales/invoices', () => {
  it('filters, summary and CSV; excludes held bills and estimates by default', async () => {
    const c = await insertCustomer(t, shop, {
      name: 'Murugan Stores',
      phone: '+919840012345',
      credit_limit_paise: 1_000_000,
    })
    const p = await insertProduct(t, shop, { sale_price_paise: 7_700, track_inventory: false })
    const a = await sell(shop, { customer_id: c, lines: [line(p)] })
    await sell(shop, { status: 'held', customer_id: c, lines: [line(p)] })
    const list = dataOf<{ id: string }[]>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices?customer_id=${c}` }),
    )
    expect(list.map((r) => r.id)).toEqual([a.invoice.id])
    const res = await shop.inject({
      method: 'GET',
      url: `${API}/sales/invoices?q=Murugan&has_due=true`,
    })
    const body = res.json() as {
      data: Array<{ id: string }>
      summary: { due_paise: number }
      page: { total: number }
    }
    expect(body.data.map((r) => r.id)).toContain(a.invoice.id)
    expect(body.summary.due_paise).toBeGreaterThanOrEqual(7_700)
    const byPhone = dataOf<{ id: string }[]>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices?q=40012345` }),
    )
    expect(byPhone.map((r) => r.id)).toContain(a.invoice.id)

    const csv = await shop.inject({
      method: 'GET',
      url: `${API}/sales/invoices?format=csv&customer_id=${c}`,
    })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body).toContain('Murugan Stores')
    expect(csv.body).toContain('77.00')
    const cashier = await shop.asRole('cashier')
    const noExport = await shop.inject({
      method: 'GET',
      url: `${API}/sales/invoices?format=csv`,
      as: cashier,
    })
    expect(noExport.statusCode).toBe(403)

    const sorted = dataOf<Array<{ total_paise: number }>>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices?sort=-total_paise&limit=5` }),
    )
    const totals = sorted.map((r) => r.total_paise)
    expect([...totals].sort((x, y) => y - x)).toEqual(totals)
  })

  it('store-scoped members only see their stores', async () => {
    const otherStore = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({
        id: otherStore,
        tenant_id: shop.tenant.id,
        code: `S${Math.floor(Math.random() * 90 + 10)}`,
        name: 'Branch',
        state_code: '33',
      })
      .execute()
    const scoped = await shop.asRole('cashier', { store_ids: [otherStore] })
    const list = (
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices`, as: scoped })
    ).json() as {
      data: unknown[]
    }
    expect(list.data).toHaveLength(0)
    const p = await insertProduct(t, shop, { track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const forbidden = await shop.inject({
      method: 'GET',
      url: `${API}/sales/invoices/${r.invoice.id}`,
      as: scoped,
    })
    expect(forbidden.statusCode).toBe(403)
  })
})

describe('plans and isolation', () => {
  it('free plan: the monthly bill limit is enforced', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const p = await insertProduct(t, free, { sale_price_paise: 1_000, track_inventory: false })
    await t.deps.db.systemDb
      .insertInto('usage_counters')
      .values({
        tenant_id: free.tenant.id,
        metric: 'invoices',
        period: periodOf(today),
        value: 300,
      })
      .execute()
    const res = await createSale(free, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 1_000 }],
    })
    expect(res.statusCode).toBe(402)
    expect(errorOf(res).code).toBe('PLAN_LIMIT_REACHED')
    // A held bill does not count.
    const held = await createSale(free, { status: 'held', lines: [line(p)] })
    expect(held.statusCode).toBe(201)
  })

  it("tenant B never sees tenant A's invoices", async () => {
    const other = await createTestTenant(t)
    const p = await insertProduct(t, shop, { track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const get = await other.inject({ method: 'GET', url: `${API}/sales/invoices/${r.invoice.id}` })
    expect(get.statusCode).toBe(404)
    const list = (await other.inject({ method: 'GET', url: `${API}/sales/invoices` })).json() as {
      data: Array<{ id: string }>
    }
    expect(list.data.map((x) => x.id)).not.toContain(r.invoice.id)
    const cancel = await other.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/cancel`,
      payload: { reason: 'nope' },
    })
    expect(cancel.statusCode).toBe(404)
    // Tenant A's product is unknown to tenant B.
    const foreign = await createSale(other, {
      store_id: other.store.id,
      register_id: other.register.id,
      lines: [line(p)],
    })
    expect(foreign.statusCode).toBe(404)
  })
})
