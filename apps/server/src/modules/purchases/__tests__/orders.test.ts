/**
 * Purchase orders: numbered create with defaults and totals, draft-only edit / delete, send
 * (outbox notification po_to_supplier, message text, wa.me link), cancel / close rules, receipts
 * from posted bills (partially_received → received, back on bill cancel), from-order drafts,
 * list filters and CSV.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { auditActions, dataOf, expectError, makeProduct, makeSupplier, req } from './fixtures'

interface OrderView {
  id: string
  number: string
  status: string
  is_interstate: boolean
  taxable_paise: number
  tax_paise: number
  total_paise: number
  received_bp: number
  sent_at: string | null
  updated_at: string
  supplier: { id: string; name: string }
  lines: {
    id: string
    product_id: string
    qty_milli: number
    received_qty_milli: number
    pending_qty_milli: number
    unit_cost_paise: number
    gst_rate_bp: number
    taxable_paise: number
    tax_paise: number
    total_paise: number
    current_stock_milli: number | null
    last_cost_paise: number | null
  }[]
  bills: { id: string; status: string }[]
  created_by_name: string | null
}
interface BillView {
  id: string
  status: string
  purchase_order_id: string | null
  lines: {
    product_id: string
    purchase_order_line_id: string | null
    qty_milli: number
    unit_cost_paise: number
  }[]
}

const today = todayIn('Asia/Kolkata')

describe('purchases: purchase orders', () => {
  let t: TestApp
  let shop: TestShop
  let supplier: { id: string; name: string }
  let p1: { id: string; name: string }
  let p2: { id: string; name: string }

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    supplier = await makeSupplier(t, shop.tenant.id, {
      phone: '+919876543210',
      name: 'Sri Murugan Traders',
    })
    p1 = await makeProduct(t, shop.tenant.id, {
      name: 'Toor dal 1kg',
      purchase_price_paise: 12_000,
      gst_rate_bp: 500,
    })
    p2 = await makeProduct(t, shop.tenant.id, {
      name: 'Amoxicillin 250',
      unit: 'TAB',
      pack_size: 10,
      purchase_price_paise: 4_000,
      gst_rate_bp: 1200,
    })
  })
  afterAll(() => t.close())

  async function createOrder(extra: Record<string, unknown> = {}): Promise<OrderView> {
    return dataOf<OrderView>(
      await req(shop, 'POST', '/purchase-orders', {
        store_id: shop.store.id,
        supplier_id: supplier.id,
        lines: [
          { product_id: p1.id, qty_milli: 10_000 },
          { product_id: p2.id, qty_milli: 50_000, unit_cost_paise: 3_800 },
        ],
        ...extra,
      }),
      201,
    )
  }

  it('creates a numbered draft with product defaults and computed totals', async () => {
    const order = await createOrder({
      expected_date: addDays(today, 5),
      notes: 'Deliver by Friday',
    })
    expect(order.number).toMatch(/^POS1\/\d{4}\/\d{3,5}$/)
    expect(order.status).toBe('draft')
    expect(order.is_interstate).toBe(false)
    expect(
      order.lines.map((l) => [l.unit_cost_paise, l.gst_rate_bp, l.taxable_paise, l.tax_paise]),
    ).toEqual([
      [12_000, 500, 120_000, 6_000],
      [3_800, 1200, 19_000, 2_280], // 5 strips × ₹38
    ])
    expect(order).toMatchObject({ taxable_paise: 139_000, tax_paise: 8_280, total_paise: 147_280 })
    expect(
      order.lines.every((l) => l.pending_qty_milli === l.qty_milli && l.received_qty_milli === 0),
    ).toBe(true)
    expect(order.lines[0]!.current_stock_milli).toBe(0)
    expect(order.created_by_name).toBe(shop.owner.user.full_name)

    expectError(
      await req(shop, 'POST', '/purchase-orders', {
        store_id: shop.store.id,
        supplier_id: supplier.id,
        lines: [
          { product_id: p1.id, qty_milli: 1_000 },
          { product_id: p1.id, qty_milli: 2_000 },
        ],
      }),
      400,
      'VALIDATION_ERROR',
    )
    const badDates = await req(shop, 'POST', '/purchase-orders', {
      store_id: shop.store.id,
      supplier_id: supplier.id,
      order_date: today,
      expected_date: addDays(today, -1),
      lines: [{ product_id: p1.id, qty_milli: 1_000 }],
    })
    expect(expectError(badDates, 400, 'VALIDATION_ERROR').details?.issues?.[0]?.message).toBe(
      'date_order',
    )
    const inter = await makeSupplier(t, shop.tenant.id, { state_code: '32' })
    const interOrder = await createOrder({ supplier_id: inter.id })
    expect(interOrder.is_interstate).toBe(true)
  })

  it('edits and deletes only drafts; numbers are not reused', async () => {
    const order = await createOrder()
    const edited = dataOf<OrderView>(
      await req(shop, 'PATCH', `/purchase-orders/${order.id}`, {
        lines: [{ product_id: p1.id, qty_milli: 3_000, unit_cost_paise: 11_000 }],
        notes: null,
        if_updated_at: order.updated_at,
      }),
    )
    expect(edited.lines).toHaveLength(1)
    expect(edited.total_paise).toBe(33_000 + 1_650)
    expectError(
      await req(shop, 'PATCH', `/purchase-orders/${order.id}`, {
        notes: 'stale',
        if_updated_at: order.updated_at,
      }),
      409,
      'STALE_WRITE',
    )
    expect((await req(shop, 'DELETE', `/purchase-orders/${order.id}`)).statusCode).toBe(204)
    expect(await auditActions(t, shop.tenant.id, order.id)).toEqual(['purchase_order.delete'])
    const next = await createOrder()
    expect(next.number).not.toBe(order.number)

    dataOf(await req(shop, 'POST', `/purchase-orders/${next.id}/send`, {}))
    expectError(
      await req(shop, 'PATCH', `/purchase-orders/${next.id}`, { notes: 'x' }),
      409,
      'CONFLICT',
      'order_not_draft',
    )
    expectError(
      await req(shop, 'DELETE', `/purchase-orders/${next.id}`),
      409,
      'CONFLICT',
      'order_not_draft',
    )
  })

  it('sends to the supplier by WhatsApp through the outbox, with the text and a wa.me link', async () => {
    const order = await createOrder()
    const res = await req(shop, 'POST', `/purchase-orders/${order.id}/send`, {
      via: 'whatsapp',
      message: 'Please send fresh stock',
    })
    const result = dataOf<{
      order: OrderView
      notification_id: string | null
      message: string
      wa_me_url: string | null
    }>(res)
    expect(result.order.status).toBe('sent')
    expect(result.order.sent_at).not.toBeNull()
    expect(result.notification_id).not.toBeNull()
    expect(result.message).toContain(order.number)
    expect(result.message).toContain('Toor dal 1kg')
    expect(result.message).toContain('Please send fresh stock')
    expect(result.wa_me_url).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    const row = await t.deps.db.systemDb
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', result.notification_id!)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      tenant_id: shop.tenant.id,
      channel: 'whatsapp',
      template_code: 'po_to_supplier',
      recipient: '+919876543210',
      ref_type: 'purchase_order',
      ref_id: order.id,
    })
    expect(await auditActions(t, shop.tenant.id, order.id)).toContain('purchase_order.send')

    // Without a phone: a manual share works, a WhatsApp send needs a number.
    const silent = await makeSupplier(t, shop.tenant.id)
    const o2 = await createOrder({ supplier_id: silent.id })
    expectError(
      await req(shop, 'POST', `/purchase-orders/${o2.id}/send`, { via: 'whatsapp' }),
      422,
      'UNPROCESSABLE',
      'recipient_phone_required',
    )
    const manual = dataOf<{
      notification_id: string | null
      wa_me_url: string | null
      message: string
    }>(await req(shop, 'POST', `/purchase-orders/${o2.id}/send`, {}))
    expect(manual).toMatchObject({ notification_id: null, wa_me_url: null })
    const given = dataOf<{ wa_me_url: string | null }>(
      await req(shop, 'POST', `/purchase-orders/${o2.id}/send`, { phone: '98400 12345' }),
    )
    expect(given.wa_me_url).toMatch(/^https:\/\/wa\.me\/919840012345/)
  })

  it('tracks receipts from posted bills: partially received → received → back on bill cancel', async () => {
    const order = await createOrder()
    dataOf(await req(shop, 'POST', `/purchase-orders/${order.id}/send`, {}))
    const first = dataOf<BillView>(
      await req(shop, 'POST', `/purchase-bills/from-order/${order.id}`, {
        supplier_invoice_no: `SMT-${newId().slice(-6)}`,
      }),
      201,
    )
    expect(first.purchase_order_id).toBe(order.id)
    expect(first.lines.map((l) => [l.product_id, l.qty_milli, l.unit_cost_paise])).toEqual([
      [p1.id, 10_000, 12_000],
      [p2.id, 50_000, 3_800],
    ])
    // Receive 6 of 10 of the first item only (the line link is kept by product).
    dataOf(
      await req(shop, 'PATCH', `/purchase-bills/${first.id}`, {
        lines: [{ product_id: p1.id, qty_milli: 6_000, unit_cost_paise: 12_000 }],
      }),
    )
    dataOf(await req(shop, 'POST', `/purchase-bills/${first.id}/post`, {}))
    let po = dataOf<OrderView>(await req(shop, 'GET', `/purchase-orders/${order.id}`))
    expect(po.status).toBe('partially_received')
    expect(po.lines.map((l) => [l.received_qty_milli, l.pending_qty_milli])).toEqual([
      [6_000, 4_000],
      [0, 50_000],
    ])
    // Weighted by value: 6 × ₹120 = ₹720 of ₹1,390 ordered (10 dal + 5 strips of ₹38); by
    // quantity alone (6 of 60 units) it would read 10%.
    expect(po.received_bp).toBe(5_180)
    const listed = dataOf<OrderView[]>(
      await req(shop, 'GET', `/purchase-orders?supplier_id=${supplier.id}`),
    ).find((o) => o.id === order.id)
    expect(listed?.received_bp).toBe(5_180)
    expect(po.lines[0]!.last_cost_paise).toBe(12_000)
    expect(po.lines[0]!.current_stock_milli).toBe(6_000)
    expectError(
      await req(shop, 'POST', `/purchase-orders/${order.id}/cancel`, {}),
      409,
      'CONFLICT',
      'order_has_receipts',
    )

    const second = dataOf<BillView>(
      await req(shop, 'POST', `/purchase-bills/from-order/${order.id}`, {
        supplier_invoice_no: `SMT-${newId().slice(-6)}`,
      }),
      201,
    )
    expect(second.lines.map((l) => [l.product_id, l.qty_milli])).toEqual([
      [p1.id, 4_000],
      [p2.id, 50_000],
    ])
    dataOf(await req(shop, 'POST', `/purchase-bills/${second.id}/post`, {}))
    po = dataOf<OrderView>(await req(shop, 'GET', `/purchase-orders/${order.id}`))
    expect(po.status).toBe('received')
    expect(po.received_bp).toBe(10_000)
    expect(po.bills.map((b) => b.id).sort()).toEqual([first.id, second.id].sort())
    expectError(
      await req(shop, 'POST', `/purchase-bills/from-order/${order.id}`, {}),
      422,
      'UNPROCESSABLE',
      'order_not_receivable',
    )

    dataOf(
      await req(shop, 'POST', `/purchase-bills/${second.id}/cancel`, { reason: 'Entered twice' }),
    )
    po = dataOf<OrderView>(await req(shop, 'GET', `/purchase-orders/${order.id}`))
    expect(po.status).toBe('partially_received')
    expect(po.lines.map((l) => l.received_qty_milli)).toEqual([6_000, 0])

    const closed = dataOf<OrderView>(
      await req(shop, 'POST', `/purchase-orders/${order.id}/close`, {
        reason: 'Supplier out of stock',
      }),
    )
    expect(closed.status).toBe('closed')
    expect(await auditActions(t, shop.tenant.id, order.id)).toContain('purchase_order.close')
    expectError(
      await req(shop, 'POST', `/purchase-bills/from-order/${order.id}`, {}),
      422,
      'UNPROCESSABLE',
      'order_not_receivable',
    )
  })

  it('cancels draft / sent orders and refuses wrong transitions', async () => {
    const draft = await createOrder()
    expectError(
      await req(shop, 'POST', `/purchase-orders/${draft.id}/close`, {}),
      409,
      'CONFLICT',
      'order_not_closable',
    )
    const cancelled = dataOf<OrderView>(
      await req(shop, 'POST', `/purchase-orders/${draft.id}/cancel`, { reason: 'Not needed' }),
    )
    expect(cancelled.status).toBe('cancelled')
    expectError(
      await req(shop, 'POST', `/purchase-orders/${draft.id}/cancel`, {}),
      409,
      'CONFLICT',
      'order_not_cancellable',
    )
    expectError(
      await req(shop, 'POST', `/purchase-orders/${draft.id}/send`, {}),
      409,
      'CONFLICT',
      'order_not_sendable',
    )
    // A draft bill against an order blocks cancelling it.
    const sent = await createOrder()
    const bill = dataOf<BillView>(
      await req(shop, 'POST', `/purchase-bills/from-order/${sent.id}`, {}),
      201,
    )
    expectError(
      await req(shop, 'PATCH', `/purchase-orders/${sent.id}`, { notes: 'edit' }),
      409,
      'CONFLICT',
      'order_has_bills',
    )
    expectError(
      await req(shop, 'POST', `/purchase-orders/${sent.id}/cancel`, {}),
      409,
      'CONFLICT',
      'order_has_bills',
    )
    expect((await req(shop, 'DELETE', `/purchase-bills/${bill.id}`)).statusCode).toBe(204)
    dataOf(await req(shop, 'POST', `/purchase-orders/${sent.id}/cancel`, {}))
  })

  it('validates bill links to orders (supplier / store / lines)', async () => {
    const order = await createOrder()
    const other = await makeSupplier(t, shop.tenant.id)
    expectError(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: other.id,
        store_id: shop.store.id,
        purchase_order_id: order.id,
        supplier_invoice_no: 'LNK-1',
        supplier_invoice_date: today,
        lines: [{ product_id: p1.id, qty_milli: 1_000, unit_cost_paise: 100 }],
      }),
      422,
      'UNPROCESSABLE',
      'order_mismatch',
    )
    expectError(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: supplier.id,
        store_id: shop.store.id,
        purchase_order_id: order.id,
        supplier_invoice_no: 'LNK-2',
        supplier_invoice_date: today,
        lines: [
          {
            product_id: p2.id,
            purchase_order_line_id: order.lines[0]!.id,
            qty_milli: 1_000,
            unit_cost_paise: 100,
          },
        ],
      }),
      422,
      'UNPROCESSABLE',
      'order_line_mismatch',
    )
    const linked = dataOf<BillView>(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: supplier.id,
        store_id: shop.store.id,
        purchase_order_id: order.id,
        supplier_invoice_no: 'LNK-3',
        supplier_invoice_date: today,
        lines: [{ product_id: p2.id, qty_milli: 60_000, unit_cost_paise: 3_800 }],
      }),
      201,
    )
    expect(linked.lines[0]!.purchase_order_line_id).toBe(order.lines[1]!.id)
    const detail = dataOf<{ warnings: { code: string }[] }>(
      await req(shop, 'GET', `/purchase-bills/${linked.id}`),
    )
    expect(detail.warnings.map((w) => w.code)).toContain('received_more_than_ordered')
  })

  it('lists with filters, search and CSV', async () => {
    const s = await makeSupplier(t, shop.tenant.id, {
      name: `Kaveri Distributors ${newId().slice(-4)}`,
    })
    const o1 = await createOrder({ supplier_id: s.id })
    const o2 = await createOrder({ supplier_id: s.id, order_date: addDays(today, -2) })
    dataOf(await req(shop, 'POST', `/purchase-orders/${o2.id}/send`, {}))
    const list = (qs: string) =>
      req(shop, 'GET', `/purchase-orders?supplier_id=${s.id}&${qs}`).then((r) => {
        expect(r.statusCode).toBe(200)
        return r.json<{
          data: { id: string; line_count: number; supplier_name: string }[]
          page: { total: number }
        }>()
      })
    expect((await list('sort=order_date')).data.map((r) => r.id)).toEqual([o2.id, o1.id])
    expect((await list('status=sent')).data.map((r) => r.id)).toEqual([o2.id])
    expect((await list(`q=${encodeURIComponent(o1.number)}`)).data.map((r) => r.id)).toEqual([
      o1.id,
    ])
    expect((await list(`from=${today}`)).data.map((r) => r.id)).toEqual([o1.id])
    const all = await list('limit=1')
    expect(all.data).toHaveLength(1)
    expect(all.page.total).toBe(2)
    expect(all.data[0]!.line_count).toBe(2)
    const csv = await req(shop, 'GET', `/purchase-orders?supplier_id=${s.id}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-disposition']).toContain('purchase-orders-')
    const rows = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(rows[0]).toContain('PO number')
    expect(rows).toHaveLength(3)
  })
})
