/**
 * Debit notes (purchase returns): pro-rata amounts from bill lines (exact remainder on the final
 * return, also after a cancelled note), stock 'purchase_return', journal, settlements (adjust_due
 * with advance, cash refund receipt, bank account validation), free-form expiry returns with the
 * prefill endpoint, cancellation reversal, refusals and list / CSV.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { recordPayment } from '../../../core/payments'
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
  makeProduct,
  makeSupplier,
  movementsOf,
  netBySubtype,
  req,
} from './fixtures'

interface NoteView {
  id: string
  number: string
  status: string
  settlement: string
  bill_id: string | null
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  tax_paise: number
  total_paise: number
  adjusted_paise: number
  supplier_amount_paise: number
  cancel_reason: string | null
  lines: {
    bill_line_id: string | null
    batch_id: string | null
    batch_no: string | null
    qty_milli: number
    unit_cost_paise: number
    taxable_paise: number
    cgst_paise: number
    total_paise: number
    gst_rate_bp: number
  }[]
  payments: {
    payment_id: string
    method: string
    amount_paise: number
    status: string
    origin: string
  }[]
}
interface BillView {
  id: string
  number: string
  total_paise: number
  due_paise: number
  returned_paise: number
  payment_status: string
  lines: {
    id: string
    batch_id: string | null
    returned_qty_milli: number
    returnable_qty_milli: number
  }[]
  debit_notes: { id: string; status: string }[]
}

const today = todayIn('Asia/Kolkata')

describe('purchases: debit notes', () => {
  let t: TestApp
  let shop: TestShop
  let strict: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    strict = await createTestTenant(t, {
      business_type: 'pharmacy',
      settings: { inventory: { allow_negative_stock: false } },
    })
  })
  afterAll(() => t.close())

  async function postedBill(
    s: TestShop,
    supplierId: string,
    lines: unknown[],
    extra: Record<string, unknown> = {},
  ): Promise<BillView> {
    const bill = dataOf<{ id: string }>(
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
    return dataOf<{ bill: BillView }>(await req(s, 'POST', `/purchase-bills/${bill.id}/post`, {}))
      .bill
  }
  const getBill = (s: TestShop, id: string) =>
    req(s, 'GET', `/purchase-bills/${id}`).then((r) => dataOf<BillView>(r))
  const createNote = (s: TestShop, payload: Record<string, unknown>) =>
    req(s, 'POST', '/debit-notes', payload)

  it('returns bill lines pro-rata, exactly to the paisa over successive returns (adjust_due)', async () => {
    const s = await makeSupplier(t, shop.tenant.id)
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 1800 })
    // 2 charged + 1 free at ₹50 → taxable ₹100.00, GST ₹18.00, total ₹118.00.
    const bill = await postedBill(shop, s.id, [
      { product_id: p.id, qty_milli: 2_000, free_qty_milli: 1_000, unit_cost_paise: 5_000 },
    ])
    const lineId = bill.lines[0]!.id
    const returnOne = async (qty: number) =>
      dataOf<NoteView>(
        await createNote(shop, {
          bill_id: bill.id,
          reason: 'damaged',
          lines: [{ bill_line_id: lineId, qty_milli: qty }],
        }),
        201,
      )
    const n1 = await returnOne(1_000)
    expect(n1.number).toMatch(/^DNS1\/\d{4}\/\d{3,5}$/)
    expect(n1).toMatchObject({
      taxable_paise: 3_333,
      cgst_paise: 300,
      sgst_paise: 300,
      total_paise: 3_933,
      adjusted_paise: 3_933,
      settlement: 'adjust_due',
    })
    expect(n1.lines[0]!.unit_cost_paise).toBe(3_333) // landed cost: ₹100.00 over 3 units
    let b = await getBill(shop, bill.id)
    expect(b).toMatchObject({
      due_paise: 11_800 - 3_933,
      returned_paise: 3_933,
      payment_status: 'unpaid',
    })
    expect(b.lines[0]).toMatchObject({ returned_qty_milli: 1_000, returnable_qty_milli: 2_000 })
    const n2 = await returnOne(1_000)
    expect(n2.total_paise).toBe(3_933)
    const n3 = await returnOne(1_000)
    // Final return takes the exact remainder: 10000 − 2 × 3333 = 3334.
    expect(n3).toMatchObject({
      taxable_paise: 3_334,
      cgst_paise: 300,
      sgst_paise: 300,
      total_paise: 3_934,
    })
    expect(n1.total_paise + n2.total_paise + n3.total_paise).toBe(11_800)
    b = await getBill(shop, bill.id)
    expect(b).toMatchObject({ due_paise: 0, returned_paise: 11_800, payment_status: 'paid' })
    expect(b.debit_notes).toHaveLength(3)
    expectError(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'return',
        lines: [{ bill_line_id: lineId, qty_milli: 1 }],
      }),
      422,
      'UNPROCESSABLE',
      'returnable_exceeded',
    )
    // Stock: 3 in, 3 out at the batchless row.
    expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(0)
    expect(
      (await movementsOf(t, shop.tenant.id, 'debit_note', n1.id)).map((m) => [
        m.movement_type,
        m.qty_milli,
      ]),
    ).toEqual([['purchase_return', -1_000]])
    // Journal: Dr payable, Cr inventory, Cr input taxes.
    expect(netBySubtype(await journalOf(t, shop.tenant.id, 'debit_note', n1.id))).toEqual({
      payable: 3_933,
      inventory: -3_333,
      input_cgst: -300,
      input_sgst: -300,
    })
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(0)
    // Cancelling the middle note gives back its quantity, amount and due; returning again then
    // re-uses exactly what is still uncredited.
    const c2 = dataOf<NoteView>(
      await req(shop, 'POST', `/debit-notes/${n2.id}/cancel`, { reason: 'Supplier refused' }),
    )
    expect(c2).toMatchObject({ status: 'cancelled', cancel_reason: 'Supplier refused' })
    b = await getBill(shop, bill.id)
    expect(b).toMatchObject({ due_paise: 3_933, returned_paise: 11_800 - 3_933 })
    expect(b.lines[0]!.returnable_qty_milli).toBe(1_000)
    expect(await levelOf(t, shop.tenant.id, shop.store.id, p.id)).toBe(1_000)
    const n4 = await returnOne(1_000)
    expect(n4).toMatchObject({ taxable_paise: 3_333, total_paise: 3_933 })
    expect(await auditActions(t, shop.tenant.id, n2.id)).toEqual([
      'debit_note.create',
      'debit_note.cancel',
    ])
    expectError(
      await req(shop, 'POST', `/debit-notes/${n2.id}/cancel`, { reason: 'Again please' }),
      409,
      'CONFLICT',
      'debit_note_cancelled',
    )
    // A bill with live debit notes cannot be cancelled.
    expectError(
      await req(shop, 'POST', `/purchase-bills/${bill.id}/cancel`, { reason: 'Wrong entry' }),
      409,
      'CONFLICT',
      'bill_has_debit_notes',
    )
    await assertJournalsBalanced(t, shop.tenant.id)
    await assertLevelsMatchMovements(t, shop.tenant.id)
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(0)
  })

  it('adjust_due beyond the bill due leaves a supplier advance', async () => {
    const s = await makeSupplier(t, shop.tenant.id)
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 0 })
    const bill = await postedBill(shop, s.id, [
      { product_id: p.id, qty_milli: 4_000, unit_cost_paise: 2_500 },
    ])
    await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: shop.store.id,
        method: 'cash',
        amount_paise: 8_000,
        payment_date: today,
        party: { type: 'supplier', id: s.id },
        allocations: [{ target_type: 'purchase_bill', target_id: bill.id, amount_paise: 8_000 }],
      }),
    )
    const note = dataOf<NoteView>(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'return',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 3_000 }],
      }),
      201,
    )
    expect(note).toMatchObject({
      total_paise: 7_500,
      adjusted_paise: 2_000,
      supplier_amount_paise: 7_500,
    })
    const b = await getBill(shop, bill.id)
    expect(b).toMatchObject({ due_paise: 0, returned_paise: 2_000, payment_status: 'paid' })
    // Supplier owes the shop ₹55 (advance): 10000 − 8000 − 7500.
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(-5_500)
    dataOf(await req(shop, 'POST', `/debit-notes/${note.id}/cancel`, { reason: 'Kept the goods' }))
    expect(await getBill(shop, bill.id)).toMatchObject({
      due_paise: 2_000,
      returned_paise: 0,
      payment_status: 'partial',
    })
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(2_000)
  })

  it('returns against a reverse-charge bill reduce the payable by the value without GST', async () => {
    const s = await makeSupplier(t, shop.tenant.id, { gstin: null, state_code: '33' })
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 500 })
    // 4 × ₹250 + 5% GST paid by the shop: the supplier is owed ₹1,000, the GST ₹50 is output tax.
    const bill = await postedBill(
      shop,
      s.id,
      [{ product_id: p.id, qty_milli: 4_000, unit_cost_paise: 25_000 }],
      { reverse_charge: true },
    )
    expect(bill).toMatchObject({ total_paise: 105_000, due_paise: 100_000 })
    const note = dataOf<NoteView>(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'damaged',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    // The GST document is worth ₹262.50; the supplier's claim drops by ₹250 only.
    expect(note).toMatchObject({
      total_paise: 26_250,
      tax_paise: 1_250,
      adjusted_paise: 25_000,
      supplier_amount_paise: 25_000,
    })
    expect(await getBill(shop, bill.id)).toMatchObject({
      due_paise: 75_000,
      returned_paise: 25_000,
    })
    expect(netBySubtype(await journalOf(t, shop.tenant.id, 'debit_note', note.id))).toEqual({
      payable: 25_000,
      output_cgst: 625,
      output_sgst: 625,
      inventory: -25_000,
      input_cgst: -625,
      input_sgst: -625,
    })
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(75_000)

    // A cash refund of a reverse-charge return is the value without GST as well.
    const refund = dataOf<NoteView>(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'return',
        settlement: 'refund_cash',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(refund.payments).toEqual([expect.objectContaining({ amount_paise: 25_000 })])
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(75_000)
    dataOf(await req(shop, 'POST', `/debit-notes/${note.id}/cancel`, { reason: 'Entered twice' }))
    expect(await getBill(shop, bill.id)).toMatchObject({ due_paise: 100_000, returned_paise: 0 })
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(100_000)
    await assertJournalsBalanced(t, shop.tenant.id)
  })

  it('refund_cash records a receipt from the supplier; cancelling the note cancels it', async () => {
    const s = await makeSupplier(t, shop.tenant.id)
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 500 })
    const bill = await postedBill(shop, s.id, [
      { product_id: p.id, qty_milli: 2_000, unit_cost_paise: 10_000 },
    ])
    const note = dataOf<NoteView>(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'short_supply',
        settlement: 'refund_cash',
        refund_reference: 'Cash at counter',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(note.total_paise).toBe(10_500)
    expect(note.adjusted_paise).toBe(0)
    expect(note.payments).toEqual([
      expect.objectContaining({
        method: 'cash',
        amount_paise: 10_500,
        status: 'completed',
        origin: 'debit_note_settlement',
      }),
    ])
    // The bill's due is untouched; the supplier's balance nets to the bill.
    expect((await getBill(shop, bill.id)).due_paise).toBe(21_000)
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(21_000)
    const cancelled = dataOf<NoteView>(
      await req(shop, 'POST', `/debit-notes/${note.id}/cancel`, { reason: 'Refund reversed' }),
    )
    expect(cancelled.payments[0]!.status).toBe('cancelled')
    expect(await assertSupplierBalanceMatchesLedger(t, shop.tenant.id, s.id)).toBe(21_000)
    await assertJournalsBalanced(t, shop.tenant.id)

    const expense = await t.deps.db.systemDb
      .selectFrom('accounts')
      .select('id')
      .where('tenant_id', '=', shop.tenant.id)
      .where('type', '=', 'expense')
      .executeTakeFirstOrThrow()
    expectError(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'return',
        settlement: 'refund_bank',
        account_id: expense.id,
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 }],
      }),
      422,
      'UNPROCESSABLE',
      'refund_account_invalid',
    )
    const bank = dataOf<NoteView>(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'return',
        settlement: 'refund_bank',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    expect(bank.payments[0]!.method).toBe('bank_transfer')
  })

  it('free-form expiry returns of batches: prefill, default landed cost and GST, stock checks', async () => {
    const s = await makeSupplier(t, strict.tenant.id, { name: 'Apollo Pharma Distributors' })
    const p = await makeProduct(t, strict.tenant.id, {
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
      gst_rate_bp: 1200,
    })
    const bill = await postedBill(strict, s.id, [
      {
        product_id: p.id,
        batch_no: 'EXP01',
        expiry_date: addDays(today, 20),
        qty_milli: 100_000,
        free_qty_milli: 20_000,
        unit_cost_paise: 6_000,
      },
    ])
    const batchId = bill.lines[0]!.batch_id!
    const prefill = dataOf<{
      supplier: { id: string; name: string } | null
      lines: {
        batch_id: string
        available_qty_milli: number
        unit_cost_paise: number
        gst_rate_bp: number
        bill_line_id: string | null
        returnable_qty_milli: number | null
      }[]
    }>(
      await req(
        strict,
        'GET',
        `/debit-notes/prefill?store_id=${strict.store.id}&batch_ids=${batchId}`,
      ),
    )
    expect(prefill.supplier).toEqual({ id: s.id, name: 'Apollo Pharma Distributors' })
    expect(prefill.lines[0]).toMatchObject({
      batch_id: batchId,
      available_qty_milli: 120_000,
      unit_cost_paise: 5_000, // 60000 taxable / 12 strips
      gst_rate_bp: 1200,
      bill_line_id: bill.lines[0]!.id,
      returnable_qty_milli: 120_000,
    })
    expectError(
      await req(
        strict,
        'GET',
        `/debit-notes/prefill?store_id=${strict.store.id}&batch_ids=${newId()}`,
      ),
      404,
      'NOT_FOUND',
    )

    const note = dataOf<NoteView>(
      await createNote(strict, {
        supplier_id: s.id,
        store_id: strict.store.id,
        reason: 'expired',
        lines: [{ product_id: p.id, batch_id: batchId, qty_milli: 30_000 }],
      }),
      201,
    )
    expect(note.bill_id).toBeNull()
    expect(note.lines[0]).toMatchObject({
      batch_id: batchId,
      batch_no: 'EXP01',
      unit_cost_paise: 5_000,
      taxable_paise: 15_000,
      cgst_paise: 900,
      total_paise: 16_800,
      gst_rate_bp: 1200,
    })
    expect(note.adjusted_paise).toBe(0)
    expect(await levelOf(t, strict.tenant.id, strict.store.id, p.id, batchId)).toBe(90_000)
    // Not against the bill: the bill due stays, the supplier balance drops (advance against dues).
    expect((await getBill(strict, bill.id)).due_paise).toBe(bill.total_paise)
    expect(await assertSupplierBalanceMatchesLedger(t, strict.tenant.id, s.id)).toBe(
      bill.total_paise - 16_800,
    )

    expectError(
      await createNote(strict, {
        supplier_id: s.id,
        store_id: strict.store.id,
        reason: 'expired',
        lines: [{ product_id: p.id, qty_milli: 1_000 }],
      }),
      422,
      'UNPROCESSABLE',
      'batch_mismatch',
    )
    expectError(
      await createNote(strict, {
        supplier_id: s.id,
        store_id: strict.store.id,
        reason: 'expired',
        lines: [{ product_id: p.id, batch_id: batchId, qty_milli: 500_000 }],
      }),
      422,
      'INSUFFICIENT_STOCK',
    )
    const mixed = await createNote(strict, {
      bill_id: bill.id,
      reason: 'expired',
      lines: [
        { product_id: p.id, batch_id: batchId, qty_milli: 1_000 },
        { bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 },
      ],
    })
    expect(
      expectError(mixed, 400, 'VALIDATION_ERROR').details?.issues?.map((i) => i.message),
    ).toContain('debit_note_mixed_lines')
    expectError(
      await createNote(strict, {
        reason: 'expired',
        lines: [{ product_id: p.id, batch_id: batchId, qty_milli: 1 }],
      }),
      400,
      'VALIDATION_ERROR',
    )
    const plain = await makeProduct(t, strict.tenant.id, { gst_rate_bp: 0 })
    expect(
      validationKeyOf(
        await createNote(strict, {
          supplier_id: s.id,
          store_id: strict.store.id,
          reason: 'other',
          lines: [{ product_id: plain.id, qty_milli: 1_000 }],
        }),
      ),
    ).toBe('debit_note_free_form_cost_required')
  })

  it('refuses returns against drafts / other suppliers and lists with filters and CSV', async () => {
    const s = await makeSupplier(t, shop.tenant.id, { name: `Lakshmi Stores ${newId().slice(-4)}` })
    const p = await makeProduct(t, shop.tenant.id, { gst_rate_bp: 1200 })
    const draft = dataOf<{ id: string; lines: { id: string }[] }>(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: s.id,
        store_id: shop.store.id,
        supplier_invoice_no: 'DRAFT-1',
        supplier_invoice_date: today,
        lines: [{ product_id: p.id, qty_milli: 1_000, unit_cost_paise: 1_000 }],
      }),
      201,
    )
    expectError(
      await createNote(shop, {
        bill_id: draft.id,
        reason: 'return',
        lines: [{ bill_line_id: draft.lines[0]!.id, qty_milli: 1_000 }],
      }),
      422,
      'UNPROCESSABLE',
      'bill_not_posted',
    )
    const bill = await postedBill(shop, s.id, [
      { product_id: p.id, qty_milli: 5_000, unit_cost_paise: 1_000 },
    ])
    const other = await makeSupplier(t, shop.tenant.id)
    expectError(
      await createNote(shop, {
        bill_id: bill.id,
        supplier_id: other.id,
        reason: 'return',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 }],
      }),
      422,
      'UNPROCESSABLE',
      'bill_mismatch',
    )
    const n1 = dataOf<NoteView>(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'damaged',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 1_000 }],
      }),
      201,
    )
    const n2 = dataOf<NoteView>(
      await createNote(shop, {
        bill_id: bill.id,
        reason: 'return',
        lines: [{ bill_line_id: bill.lines[0]!.id, qty_milli: 2_000 }],
      }),
      201,
    )
    dataOf(await req(shop, 'POST', `/debit-notes/${n1.id}/cancel`, { reason: 'Mistake' }))
    const list = (qs: string) =>
      req(shop, 'GET', `/debit-notes?supplier_id=${s.id}&${qs}`).then((r) => {
        expect(r.statusCode).toBe(200)
        return r.json<{
          data: { id: string; bill_number: string | null; line_count: number }[]
          summary: { count: number; total_paise: number }
        }>()
      })
    const all = await list('sort=-total_paise')
    expect(all.data.map((r) => r.id)).toEqual([n2.id, n1.id])
    expect(all.summary).toEqual({ count: 2, total_paise: n2.total_paise })
    expect(all.data[0]!.bill_number).toBe(bill.number)
    expect((await list('status=cancelled')).data.map((r) => r.id)).toEqual([n1.id])
    expect((await list('reason=return')).data.map((r) => r.id)).toEqual([n2.id])
    expect((await list(`q=${encodeURIComponent(n2.number)}`)).data.map((r) => r.id)).toEqual([
      n2.id,
    ])
    expect((await list(`bill_id=${bill.id}&settlement=adjust_due`)).data).toHaveLength(2)
    const csv = await req(shop, 'GET', `/debit-notes?supplier_id=${s.id}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(
      csv.body
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n'),
    ).toHaveLength(3)
    const detail = dataOf<NoteView>(await req(shop, 'GET', `/debit-notes/${n2.id}`))
    expect(detail.lines[0]!.bill_line_id).toBe(bill.lines[0]!.id)
  })
})

/** The first validation message key of a 400 response. */
function validationKeyOf(res: {
  statusCode: number
  json: <T>() => T
  body: string
}): string | undefined {
  if (res.statusCode !== 400)
    throw new Error(`expected 400, got ${String(res.statusCode)}: ${res.body}`)
  return res.json<{ error: { details?: { issues?: { message: string }[] } } }>().error.details
    ?.issues?.[0]?.message
}
