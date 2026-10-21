/**
 * Posting and cancelling purchase bills: GRN number, batches created / updated with costs,
 * stock (charged + free) at landed cost, product price updates (audited), the journal (ITC,
 * non-ITC, reverse charge, round-off), supplier balance = AP ledger, expiry rules, cancellation
 * reversal and its refusals (payments, debit notes, consumed stock without negative stock),
 * purchase-order receipts and the bill list's payment filters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { postStock } from '../../../core/inventory'
import { cancelPayment, recordPayment } from '../../../core/payments'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  assertJournalsBalanced,
  assertLevelsMatchMovements,
  assertSupplierBalanceMatchesLedger,
  auditActions,
  dataOf,
  expectError,
  journalOf,
  levelOf,
  makeBatch,
  makeProduct,
  makeSupplier,
  movementsOf,
  netBySubtype,
  req,
} from './fixtures'

interface BillView {
  id: string
  number: string | null
  fy: string | null
  status: string
  total_paise: number
  tax_paise: number
  due_paise: number
  paid_paise: number
  payment_status: string
  journal_entry_id: string | null
  posted_by_name: string | null
  cancel_reason: string | null
  updated_at: string
  lines: {
    id: string
    batch_id: string | null
    landed_unit_cost_paise: number
    qty_milli: number
    free_qty_milli: number
    returnable_qty_milli: number
    purchase_order_line_id: string | null
  }[]
  payments: { payment_id: string; status: string; amount_paise: number }[]
}
interface PostResult {
  bill: BillView
  price_updates: {
    product_id: string
    batch_id: string | null
    field: string
    old_paise: number | null
    new_paise: number
  }[]
  batches_created: number
  stock_lines: number
}

const today = todayIn('Asia/Kolkata')

describe('purchases: posting and cancelling bills', () => {
  let t: TestApp
  let shop: TestShop
  let strict: TestShop
  let supplier: { id: string }

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    strict = await createTestTenant(t, {
      business_type: 'pharmacy',
      settings: { inventory: { allow_negative_stock: false } },
    })
    supplier = await makeSupplier(t, shop.tenant.id, { payment_terms_days: 15 })
  })
  afterAll(() => t.close())

  async function draft(
    s: TestShop,
    supplierId: string,
    lines: unknown[],
    extra: Record<string, unknown> = {},
  ): Promise<BillView> {
    return dataOf<BillView>(
      await req(s, 'POST', '/purchase-bills', {
        supplier_id: supplierId,
        store_id: s.store.id,
        supplier_invoice_no: `INV-${newId().slice(-8)}`,
        supplier_invoice_date: today,
        lines,
        ...extra,
      }),
      201,
    )
  }
  async function post(s: TestShop, billId: string, body: Record<string, unknown> = {}) {
    return req(s, 'POST', `/purchase-bills/${billId}/post`, body)
  }

  it('posts: GRN number, batches, stock at landed cost, prices (audited) and a balanced journal', async () => {
    const a = await makeProduct(t, shop.tenant.id, {
      gst_rate_bp: 1800,
      purchase_price_paise: 9_000,
    })
    const b = await makeProduct(t, shop.tenant.id, {
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
      gst_rate_bp: 1200,
      mrp_paise: 6_000,
      sale_price_paise: 6_000,
    })
    const bill = await draft(
      shop,
      supplier.id,
      [
        {
          product_id: a.id,
          qty_milli: 10_000,
          free_qty_milli: 2_000,
          unit_cost_paise: 10_000,
          discount_bp: 1000,
        },
        {
          product_id: b.id,
          batch_no: 'PCM2301',
          expiry_date: addDays(today, 400),
          qty_milli: 100_000,
          unit_cost_paise: 5_000,
          discount_paise: 500,
          mrp_paise: 6_500,
          sale_price_paise: 6_200,
        },
      ],
      { other_charges_paise: 1001 },
    )
    const res = await post(shop, bill.id)
    const result = dataOf<PostResult>(res)
    const posted = result.bill
    expect(posted.status).toBe('posted')
    expect(posted.number).toMatch(/^GRNS1\/\d{4}\/\d{3,5}$/)
    expect(posted).toMatchObject({ total_paise: 162_600, due_paise: 162_600, paid_paise: 0 })
    expect(posted.payment_status).toBe('unpaid')
    expect(posted.journal_entry_id).not.toBeNull()
    expect(posted.posted_by_name).toBe(shop.owner.user.full_name)
    expect(result.batches_created).toBe(1)
    expect(result.stock_lines).toBe(2)

    // Stock: charged + free quantity, at the landed cost per pack.
    expect(await levelOf(t, shop.tenant.id, shop.store.id, a.id)).toBe(12_000)
    const batchId = posted.lines[1]!.batch_id!
    expect(await levelOf(t, shop.tenant.id, shop.store.id, b.id, batchId)).toBe(100_000)
    const moves = await movementsOf(t, shop.tenant.id, 'purchase_bill', bill.id)
    expect(moves.map((m) => [m.movement_type, m.qty_milli, m.unit_cost_paise])).toEqual([
      ['purchase', 12_000, 7_554],
      ['purchase', 100_000, 4_986],
    ])
    const batch = await t.deps.db.systemDb
      .selectFrom('batches')
      .selectAll()
      .where('id', '=', batchId)
      .executeTakeFirstOrThrow()
    expect(batch).toMatchObject({
      batch_no: 'PCM2301',
      expiry_date: addDays(today, 400),
      mrp_paise: 6_500,
      purchase_price_paise: 4_986,
      sale_price_paise: 6_200,
      supplier_id: supplier.id,
    })

    // Product prices: landed cost always; MRP / sale price from the line (update_prices).
    const products = await t.deps.db.systemDb
      .selectFrom('products')
      .select(['id', 'purchase_price_paise', 'mrp_paise', 'sale_price_paise'])
      .where('id', 'in', [a.id, b.id])
      .execute()
    const byId = new Map(products.map((p) => [p.id, p]))
    expect(byId.get(a.id)).toMatchObject({ purchase_price_paise: 7_554 })
    expect(byId.get(b.id)).toMatchObject({
      purchase_price_paise: 4_986,
      mrp_paise: 6_500,
      sale_price_paise: 6_200,
    })
    expect(
      result.price_updates
        .filter((u) => u.batch_id === null)
        .map((u) => [u.product_id, u.field, u.old_paise, u.new_paise]),
    ).toEqual(
      expect.arrayContaining([
        [a.id, 'purchase_price_paise', 9_000, 7_554],
        [b.id, 'purchase_price_paise', 0, 4_986],
        [b.id, 'mrp_paise', 6_000, 6_500],
        [b.id, 'sale_price_paise', 6_000, 6_200],
      ]),
    )
    expect(await auditActions(t, shop.tenant.id, a.id)).toContain('product.price_update')
    expect(await auditActions(t, shop.tenant.id, b.id)).toContain('product.price_update')
    expect(await auditActions(t, shop.tenant.id, bill.id)).toContain('purchase_bill.post')

    // Journal §10: Dr inventory (taxable + other charges), Dr input taxes, Cr payable, round off.
    const journal = await journalOf(t, shop.tenant.id, 'purchase_bill', bill.id)
    expect(netBySubtype(journal)).toEqual({
      inventory: 139_500 + 1_001,
      input_cgst: 11_070,
      input_sgst: 11_070,
      payable: -162_600,
      round_off: -41,
    })
    expect(journal.find((l) => l.subtype === 'payable')!.party_id).toBe(supplier.id)
    await assertJournalsBalanced(t, shop.tenant.id)
    await assertLevelsMatchMovements(t, shop.tenant.id)
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, supplier.id)).toBe(162_600)

    // Posted bills are immutable: no second post, PATCH or DELETE.
    expectError(await post(shop, bill.id), 409, 'CONFLICT', 'bill_not_draft')
    expectError(
      await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, { notes: 'x' }),
      409,
      'CONFLICT',
      'bill_not_draft',
    )
    expectError(
      await req(shop, 'DELETE', `/purchase-bills/${bill.id}`),
      409,
      'CONFLICT',
      'bill_not_draft',
    )

    // Returnable: charged + free.
    const ret = dataOf<{ lines: { returnable_qty_milli: number; available_qty_milli: number }[] }>(
      await req(shop, 'GET', `/purchase-bills/${bill.id}/returnable`),
    )
    expect(ret.lines.map((l) => [l.returnable_qty_milli, l.available_qty_milli])).toEqual([
      [12_000, 12_000],
      [100_000, 100_000],
    ])
  })

  it('posts input tax only when ITC-eligible (otherwise into inventory)', async () => {
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 1800 })
    const s = await makeSupplier(t, shop.tenant.id)
    const bill = await draft(
      shop,
      s.id,
      [{ product_id: p.id, qty_milli: 3_000, unit_cost_paise: 3_333 }],
      { itc_eligible: false },
    )
    const posted = dataOf<PostResult>(await post(shop, bill.id)).bill
    // 3 × 33.33 = 99.99, GST 18.00 → 117.99 → ₹118.00 (round off +1)
    expect(posted.total_paise).toBe(11_800)
    const net = netBySubtype(await journalOf(t, shop.tenant.id, 'purchase_bill', bill.id))
    expect(net).toEqual({ inventory: 9_999 + 1_800, payable: -11_800, round_off: 1 })
    expect(posted.lines[0]!.landed_unit_cost_paise).toBe(3_933) // (9999 + 1800) / 3
    await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)
  })

  it('reverse charge: the supplier is owed total − tax, the tax is the shop’s output liability', async () => {
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 500 })
    const s = await makeSupplier(t, shop.tenant.id, { gstin: null, state_code: '33' })
    const bill = await draft(
      shop,
      s.id,
      [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 100_000 }],
      { reverse_charge: true },
    )
    const posted = dataOf<PostResult>(await post(shop, bill.id)).bill
    expect(posted.total_paise).toBe(105_000)
    expect(posted.due_paise).toBe(100_000)
    const net = netBySubtype(await journalOf(t, shop.tenant.id, 'purchase_bill', bill.id))
    expect(net).toEqual({
      inventory: 100_000,
      input_cgst: 2_500,
      input_sgst: 2_500,
      payable: -100_000,
      output_cgst: -2_500,
      output_sgst: -2_500,
    })
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(100_000)
  })

  it('composition shops never claim ITC: tax is capitalised', async () => {
    const comp = await createTestTenant(t, { gst_scheme: 'composition' })
    const p = await makeProduct(t, comp.tenant.id, { gst_rate_bp: 1800 })
    const s = await makeSupplier(t, comp.tenant.id)
    const bill = await draft(comp, s.id, [
      { product_id: p.id, qty_milli: 1_000, unit_cost_paise: 10_000 },
    ])
    expect((bill as unknown as { itc_eligible: boolean }).itc_eligible).toBe(false)
    dataOf<PostResult>(await post(comp, bill.id))
    const net = netBySubtype(await journalOf(t, comp.tenant.id, 'purchase_bill', bill.id))
    expect(net).toEqual({ inventory: 11_800, payable: -11_800 })
  })

  it('refuses expired batches unless allow_past_expiry, and conflicting batch expiries', async () => {
    const p = await makeProduct(t, strict.tenant.id, { track_batches: true, gst_rate_bp: 1200 })
    const s = await makeSupplier(t, strict.tenant.id)
    const bill = await draft(strict, s.id, [
      {
        product_id: p.id,
        batch_no: 'OLD1',
        expiry_date: addDays(today, -1),
        qty_milli: 5_000,
        unit_cost_paise: 1_000,
      },
    ])
    expectError(await post(strict, bill.id), 422, 'EXPIRED_BATCH', 'expired_batch')
    const ok = dataOf<PostResult>(await post(strict, bill.id, { allow_past_expiry: true }))
    expect(ok.bill.status).toBe('posted')

    const existing = await makeBatch(t, strict.tenant.id, p.id, {
      batch_no: 'B77',
      expiry_date: addDays(today, 100),
    })
    const clash = await draft(strict, s.id, [
      {
        product_id: p.id,
        batch_no: 'B77',
        expiry_date: addDays(today, 200),
        qty_milli: 1_000,
        unit_cost_paise: 1_000,
      },
    ])
    const err = expectError(
      await post(strict, clash.id),
      422,
      'UNPROCESSABLE',
      'batch_expiry_mismatch',
    )
    expect(err.details?.batch_id).toBe(existing.id)
    // The same batch number with the same expiry reuses the batch.
    const reuse = await draft(strict, s.id, [
      {
        product_id: p.id,
        batch_no: 'B77',
        expiry_date: addDays(today, 100),
        qty_milli: 1_000,
        unit_cost_paise: 1_200,
        mrp_paise: 2_000,
      },
    ])
    const reused = dataOf<PostResult>(await post(strict, reuse.id))
    expect(reused.batches_created).toBe(0)
    expect(reused.bill.lines[0]!.batch_id).toBe(existing.id)
    expect(reused.price_updates.find((u) => u.batch_id === existing.id)).toMatchObject({
      field: 'mrp_paise',
      old_paise: null,
      new_paise: 2_000,
    })
  })

  it('needs the supplier invoice number to post a draft made from an order and keeps the duplicate guard', async () => {
    const p = await makeProduct(t, shop.tenant.id)
    const s = await makeSupplier(t, shop.tenant.id)
    const order = dataOf<{ id: string }>(
      await req(shop, 'POST', '/purchase-orders', {
        store_id: shop.store.id,
        supplier_id: s.id,
        lines: [{ product_id: p.id, qty_milli: 2_000, unit_cost_paise: 500 }],
      }),
      201,
    )
    const fromOrder = dataOf<BillView>(
      await req(shop, 'POST', `/purchase-bills/from-order/${order.id}`, {}),
      201,
    )
    expectError(
      await post(shop, fromOrder.id),
      422,
      'UNPROCESSABLE',
      'supplier_invoice_no_required',
    )
    const other = await draft(
      shop,
      s.id,
      [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 500 }],
      {
        supplier_invoice_no: 'S-900',
      },
    )
    dataOf<PostResult>(await post(shop, other.id))
    const dup = await req(shop, 'PATCH', `/purchase-bills/${fromOrder.id}`, {
      supplier_invoice_no: 'S-900',
    })
    expect(
      expectError(dup, 409, 'DUPLICATE', 'duplicate_supplier_invoice').details?.existing_status,
    ).toBe('posted')
    dataOf<BillView>(
      await req(shop, 'PATCH', `/purchase-bills/${fromOrder.id}`, { supplier_invoice_no: 'S-901' }),
    )
    expect(dataOf<PostResult>(await post(shop, fromOrder.id)).bill.status).toBe('posted')
  })

  it('cancels: stock out, journal reversed, supplier balance restored, audited', async () => {
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 1800 })
    const s = await makeSupplier(t, shop.tenant.id)
    const bill = await draft(shop, s.id, [
      { product_id: p.id, qty_milli: 4_000, free_qty_milli: 1_000, unit_cost_paise: 2_500 },
    ])
    dataOf<PostResult>(await post(shop, bill.id))
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(11_800)
    expectError(
      await req(shop, 'POST', `/purchase-bills/${bill.id}/cancel`, { reason: 'x' }),
      400,
      'VALIDATION_ERROR',
    )
    const cancelled = dataOf<BillView>(
      await req(shop, 'POST', `/purchase-bills/${bill.id}/cancel`, { reason: 'Wrong supplier' }),
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancel_reason).toBe('Wrong supplier')
    expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(0)
    const moves = await movementsOf(t, shop.tenant.id, 'purchase_bill', bill.id)
    expect(moves.map((m) => [m.movement_type, m.qty_milli])).toEqual([
      ['purchase', 5_000],
      ['purchase_cancel', -5_000],
    ])
    const journal = await journalOf(t, shop.tenant.id, 'purchase_bill', bill.id)
    const total = (k: 'debit_paise' | 'credit_paise', reversal: boolean) =>
      journal
        .filter((l) => (l.reverses_entry_id !== null) === reversal)
        .reduce((s2, l) => s2 + l[k], 0)
    expect(total('debit_paise', true)).toBe(total('credit_paise', false))
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(0)
    expect(await auditActions(t, shop.tenant.id, bill.id)).toContain('purchase_bill.cancel')
    expectError(
      await req(shop, 'POST', `/purchase-bills/${bill.id}/cancel`, { reason: 'Again please' }),
      409,
      'CONFLICT',
      'bill_not_posted',
    )
    // The cancelled bill frees its supplier invoice number.
    await draft(shop, s.id, [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 100 }], {
      supplier_invoice_no: (
        await t.deps.db.systemDb
          .selectFrom('purchase_bills')
          .select('supplier_invoice_no')
          .where('id', '=', bill.id)
          .executeTakeFirstOrThrow()
      ).supplier_invoice_no,
    })
  })

  it('refuses cancelling when the received stock was consumed and negative stock is off', async () => {
    const p = await makeProduct(t, strict.tenant.id, { gst_rate_bp: 0 })
    const s = await makeSupplier(t, strict.tenant.id)
    const bill = await draft(strict, s.id, [
      { product_id: p.id, qty_milli: 5_000, unit_cost_paise: 1_000 },
    ])
    dataOf<PostResult>(await post(strict, bill.id))
    await strict.tx((tx) =>
      postStock(tx, strict.ctx, [
        { store_id: strict.store.id, product_id: p.id, qty_milli: -2_000, movement_type: 'sale' },
      ]),
    )
    expectError(
      await req(strict, 'POST', `/purchase-bills/${bill.id}/cancel`, {
        reason: 'Supplier took back',
      }),
      422,
      'INSUFFICIENT_STOCK',
    )
    expect(await levelOf(t, strict.tenant.id, strict.store.id, p.id)).toBe(3_000)
    // A shop that allows negative stock may cancel anyway.
    const p2 = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 0 })
    const s2 = await makeSupplier(t, shop.tenant.id)
    const bill2 = await draft(shop, s2.id, [
      { product_id: p2.id, qty_milli: 5_000, unit_cost_paise: 1_000 },
    ])
    dataOf<PostResult>(await post(shop, bill2.id))
    await shop.tx((tx) =>
      postStock(tx, shop.ctx, [
        { store_id: shop.store.id, product_id: p2.id, qty_milli: -2_000, movement_type: 'sale' },
      ]),
    )
    dataOf<BillView>(
      await req(shop, 'POST', `/purchase-bills/${bill2.id}/cancel`, { reason: 'Returned all' }),
    )
    expect(await levelOf(t, shop.tenant.id, shop.store.id, p2.id)).toBe(-2_000)
  })

  it('refuses cancelling while supplier payments are allocated (409), then allows it', async () => {
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 0 })
    const s = await makeSupplier(t, shop.tenant.id)
    const bill = await draft(shop, s.id, [
      { product_id: p.id, qty_milli: 1_000, unit_cost_paise: 50_000 },
    ])
    dataOf<PostResult>(await post(shop, bill.id))
    const payment = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: shop.store.id,
        method: 'cash',
        amount_paise: 20_000,
        payment_date: today,
        party: { type: 'supplier', id: s.id },
        allocations: [{ target_type: 'purchase_bill', target_id: bill.id, amount_paise: 20_000 }],
      }),
    )
    const detail = dataOf<BillView>(await req(shop, 'GET', `/purchase-bills/${bill.id}`))
    expect(detail).toMatchObject({
      paid_paise: 20_000,
      due_paise: 30_000,
      payment_status: 'partial',
    })
    expect(detail.payments).toEqual([
      expect.objectContaining({
        payment_id: payment.id,
        status: 'completed',
        amount_paise: 20_000,
      }),
    ])
    const err = expectError(
      await req(shop, 'POST', `/purchase-bills/${bill.id}/cancel`, { reason: 'Wrong bill' }),
      409,
      'CONFLICT',
      'bill_has_payments',
    )
    expect(err.details?.payment_ids).toEqual([payment.id])
    await shop.tx((tx) =>
      cancelPayment(tx, shop.ctx, { payment_id: payment.id, reason: 'Undo payment' }),
    )
    dataOf<BillView>(
      await req(shop, 'POST', `/purchase-bills/${bill.id}/cancel`, { reason: 'Wrong bill' }),
    )
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(0)
  })

  it('filters by payment status, due and overdue; summary covers the filtered range', async () => {
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 0 })
    const s = await makeSupplier(t, shop.tenant.id)
    const overdue = await draft(
      shop,
      s.id,
      [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 10_000 }],
      {
        supplier_invoice_date: addDays(today, -40),
        received_date: addDays(today, -40),
        due_date: addDays(today, -10),
      },
    )
    dataOf<PostResult>(await post(shop, overdue.id))
    const paid = await draft(shop, s.id, [
      { product_id: p.id, qty_milli: 1_000, unit_cost_paise: 5_000 },
    ])
    dataOf<PostResult>(await post(shop, paid.id))
    await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: shop.store.id,
        method: 'bank_transfer',
        amount_paise: 5_000,
        payment_date: today,
        party: { type: 'supplier', id: s.id },
        allocations: [{ target_type: 'purchase_bill', target_id: paid.id, amount_paise: 5_000 }],
      }),
    )
    const list = (qs: string) =>
      req(shop, 'GET', `/purchase-bills?supplier_id=${s.id}&${qs}`).then((r) =>
        r.json<{
          data: {
            id: string
            overdue: boolean
            days_overdue: number | null
            payment_status: string
          }[]
          summary: {
            count: number
            total_paise: number
            paid_paise: number
            due_paise: number
            overdue_paise: number
          }
        }>(),
      )
    const overdueList = await list('overdue=true')
    expect(overdueList.data.map((r) => [r.id, r.overdue, r.days_overdue])).toEqual([
      [overdue.id, true, 10],
    ])
    expect((await list('payment_status=paid')).data.map((r) => r.id)).toEqual([paid.id])
    expect((await list('has_due=true')).data.map((r) => r.id)).toEqual([overdue.id])
    const all = await list('status=posted')
    expect(all.summary).toEqual({
      count: 2,
      total_paise: 15_000,
      paid_paise: 5_000,
      due_paise: 10_000,
      overdue_paise: 10_000,
    })
  })
})
