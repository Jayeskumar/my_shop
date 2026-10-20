import { generateReferenceCode, newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tx } from '../db/tenant'
import { type TestApp, buildTestApp } from '../test/helpers'
import {
  type TestShop,
  createTestTenant,
  insertTestCustomer,
  insertTestSupplier,
} from '../test/tenants'
import { systemAccountId } from './ledger'
import { cancelPayment, getPayment, recordPayment, storeCreditBalance } from './payments'

const TODAY = '2026-10-20'

describe('core/payments', () => {
  let t: TestApp
  let shop: TestShop
  const sys = () => t.deps.db.systemDb

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  async function insertInvoice(customerId: string | null, total: number): Promise<string> {
    const id = newId()
    await sys()
      .insertInto('sales_invoices')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        doc_type: 'tax_invoice',
        number: `T/${id.slice(-8)}`,
        fy: '2026-27',
        invoice_date: TODAY,
        status: 'completed',
        customer_id: customerId,
        place_of_supply: '33',
        taxable_paise: total,
        total_paise: total,
        due_paise: total,
      })
      .execute()
    return id
  }

  async function insertBill(supplierId: string, total: number): Promise<string> {
    const id = newId()
    await sys()
      .insertInto('purchase_bills')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        supplier_id: supplierId,
        number: `G/${id.slice(-8)}`,
        fy: '2026-27',
        supplier_invoice_no: `INV-${id.slice(-6)}`,
        supplier_invoice_date: TODAY,
        received_date: TODAY,
        status: 'posted',
        taxable_paise: total,
        total_paise: total,
        due_paise: total,
      })
      .execute()
    return id
  }

  async function insertIntent(opts: {
    provider: 'upi_vpa' | 'razorpay'
    amount: number
    status?: string
    settlementAccountId?: string | null
  }): Promise<string> {
    const accountId = newId()
    await sys()
      .insertInto('payment_provider_accounts')
      .values({
        id: accountId,
        tenant_id: shop.tenant.id,
        provider: opts.provider,
        display_name: opts.provider,
        vpa: opts.provider === 'upi_vpa' ? 'kadai.shop@okaxis' : null,
        settlement_account_id: opts.settlementAccountId ?? null,
      })
      .execute()
    const intentId = newId()
    await sys()
      .insertInto('payment_intents')
      .values({
        id: intentId,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        provider_account_id: accountId,
        provider: opts.provider,
        purpose: 'pos_sale',
        reference_code: generateReferenceCode(),
        amount_paise: opts.amount,
        status: opts.status ?? 'paid',
        paid_amount_paise: opts.status === 'pending' ? null : opts.amount,
        utr: '429876543210',
      })
      .execute()
    return intentId
  }

  const invoiceOf = (id: string) =>
    sys()
      .selectFrom('sales_invoices')
      .select(['paid_paise', 'due_paise', 'payment_status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const balanceOf = (customerId: string) =>
    sys().selectFrom('customers').select('balance_paise').where('id', '=', customerId).executeTakeFirstOrThrow()

  async function journalOf(tx: Tx, paymentId: string) {
    return tx
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.subtype', 'l.debit_paise', 'l.credit_paise', 'l.party_id', 'e.reverses_entry_id'])
      .where('e.source_type', '=', 'payment')
      .where('e.source_id', '=', paymentId)
      .orderBy('l.debit_paise', 'desc')
      .execute()
  }

  it('records a customer receipt, allocates it to invoices and keeps the remainder as advance', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const inv1 = await insertInvoice(c.id, 1_000)
    const inv2 = await insertInvoice(c.id, 2_000)
    const p = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        method: 'cash',
        amount_paise: 1_800,
        payment_date: TODAY,
        party: { type: 'customer', id: c.id },
        allocations: [
          { target_type: 'sales_invoice', target_id: inv1, amount_paise: 1_000 },
          { target_type: 'sales_invoice', target_id: inv2, amount_paise: 300 },
          { target_type: 'sales_invoice', target_id: inv2, amount_paise: 200 },
        ],
        number: true,
        reference: 'counter',
      }),
    )
    expect(p).toMatchObject({
      direction: 'in',
      status: 'completed',
      amount_paise: 1_800,
      unallocated_paise: 300,
      number: 'RCS1/2627/00001',
      fy: '2026-27',
      party_type: 'customer',
      party_id: c.id,
      replayed: false,
    })
    expect(p.allocations.map((a) => [a.target_id, a.amount_paise]).sort()).toEqual(
      [
        [inv1, 1_000],
        [inv2, 500],
      ].sort(),
    )
    expect(await invoiceOf(inv1)).toEqual({ paid_paise: 1_000, due_paise: 0, payment_status: 'paid' })
    expect(await invoiceOf(inv2)).toEqual({ paid_paise: 500, due_paise: 1_500, payment_status: 'partial' })
    const lines = await shop.tx((tx) => journalOf(tx, p.id))
    expect(lines.map((l) => [l.subtype, l.debit_paise, l.credit_paise, l.party_id])).toEqual([
      ['cash', 1_800, 0, null],
      ['receivable', 0, 1_800, c.id],
    ])
    expect((await balanceOf(c.id)).balance_paise).toBe(-1_800)
    expect(p.account_id).toBe(await shop.tx((tx) => systemAccountId(tx, shop.ctx, 'cash')))
  })

  it('rejects over-allocation, allocations above the amount and other parties’ documents', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const c2 = await insertTestCustomer(t.deps, shop.tenant.id)
    const inv = await insertInvoice(c.id, 1_000)
    const base = {
      direction: 'in' as const,
      store_id: shop.store.id,
      method: 'cash' as const,
      payment_date: TODAY,
    }
    const attempt = (input: Partial<Parameters<typeof recordPayment>[2]>) =>
      shop.tx((tx) => recordPayment(tx, shop.ctx, { ...base, amount_paise: 2_000, ...input }))
    await expect(
      attempt({
        party: { type: 'customer', id: c.id },
        allocations: [{ target_type: 'sales_invoice', target_id: inv, amount_paise: 1_001 }],
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', status: 422, details: { open_paise: 1_000 } })
    await expect(
      attempt({
        amount_paise: 500,
        party: { type: 'customer', id: c.id },
        allocations: [{ target_type: 'sales_invoice', target_id: inv, amount_paise: 600 }],
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', details: { allocated_paise: 600 } })
    await expect(
      attempt({
        party: { type: 'customer', id: c2.id },
        allocations: [{ target_type: 'sales_invoice', target_id: inv, amount_paise: 100 }],
      }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
    await expect(
      attempt({ allocations: [{ target_type: 'purchase_bill', target_id: newId(), amount_paise: 100 }] }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
    expect(await invoiceOf(inv)).toEqual({ paid_paise: 0, due_paise: 1_000, payment_status: 'unpaid' })
  })

  it('settles walk-in invoices without a party (POS tenders)', async () => {
    const inv = await insertInvoice(null, 5_900)
    const p = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        register_id: shop.register.id,
        method: 'card',
        amount_paise: 5_900,
        payment_date: TODAY,
        reference: 'APPR-1234',
        allocations: [{ target_type: 'sales_invoice', target_id: inv, amount_paise: 5_900 }],
      }),
    )
    expect(p).toMatchObject({ party_type: null, unallocated_paise: 0, number: null, register_id: shop.register.id })
    expect(await invoiceOf(inv)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
    const lines = await shop.tx((tx) => journalOf(tx, p.id))
    expect(lines.map((l) => [l.subtype, l.debit_paise, l.credit_paise])).toEqual([
      ['card_clearing', 5_900, 0],
      ['receivable', 0, 5_900],
    ])
  })

  it('pays suppliers (voucher numbers, Dr payable / Cr bank) and opening balances', async () => {
    const s = await insertTestSupplier(t.deps, shop.tenant.id, { opening_balance_paise: 10_000 })
    const bill = await insertBill(s.id, 50_000)
    const p = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: shop.store.id,
        method: 'bank_transfer',
        amount_paise: 45_000,
        payment_date: TODAY,
        party: { type: 'supplier', id: s.id },
        allocations: [
          { target_type: 'purchase_bill', target_id: bill, amount_paise: 40_000 },
          { target_type: 'opening_balance', target_id: null, amount_paise: 5_000 },
        ],
        number: true,
      }),
    )
    expect(p.number).toBe('PVS1/2627/00001')
    const billRow = await sys()
      .selectFrom('purchase_bills')
      .select(['paid_paise', 'due_paise', 'payment_status'])
      .where('id', '=', bill)
      .executeTakeFirstOrThrow()
    expect(billRow).toEqual({ paid_paise: 40_000, due_paise: 10_000, payment_status: 'partial' })
    const lines = await shop.tx((tx) => journalOf(tx, p.id))
    expect(lines.map((l) => [l.subtype, l.debit_paise, l.credit_paise, l.party_id])).toEqual([
      ['payable', 45_000, 0, s.id],
      ['bank', 0, 45_000, null],
    ])
    const supplier = await sys().selectFrom('suppliers').select('balance_paise').where('id', '=', s.id).executeTakeFirstOrThrow()
    expect(supplier.balance_paise).toBe(-45_000)
    // Opening balance allocations cannot exceed it.
    await expect(
      shop.tx((tx) =>
        recordPayment(tx, shop.ctx, {
          direction: 'out',
          store_id: shop.store.id,
          method: 'cash',
          amount_paise: 6_000,
          payment_date: TODAY,
          party: { type: 'supplier', id: s.id },
          allocations: [{ target_type: 'opening_balance', target_id: s.id, amount_paise: 6_000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', details: { open_paise: 5_000 } })
  })

  it('resolves UPI accounts from the payment intent and links / protects the intent', async () => {
    const bankId = await shop.tx((tx) => systemAccountId(tx, shop.ctx, 'bank'))
    const clearingId = await shop.tx((tx) => systemAccountId(tx, shop.ctx, 'upi_clearing'))
    const settlementId = newId()
    await sys()
      .insertInto('accounts')
      .values({ id: settlementId, tenant_id: shop.tenant.id, code: '1201', name: 'HDFC current', type: 'asset' })
      .execute()
    const vpaIntent = await insertIntent({ provider: 'upi_vpa', amount: 2_500 })
    const pspIntent = await insertIntent({ provider: 'razorpay', amount: 3_000 })
    const settledIntent = await insertIntent({ provider: 'razorpay', amount: 1_000, settlementAccountId: settlementId })
    const pending = await insertIntent({ provider: 'razorpay', amount: 1_000, status: 'pending' })
    const pay = (intentId: string, amount: number) =>
      shop.tx((tx) =>
        recordPayment(tx, shop.ctx, {
          direction: 'in',
          store_id: shop.store.id,
          method: 'upi',
          amount_paise: amount,
          payment_date: TODAY,
          payment_intent_id: intentId,
        }),
      )
    const a = await pay(vpaIntent, 2_500)
    const b = await pay(pspIntent, 3_000)
    const c = await pay(settledIntent, 1_000)
    expect([a.account_id, b.account_id, c.account_id]).toEqual([bankId, clearingId, settlementId])
    expect(a.reference).toBe('429876543210') // UTR of the intent
    const linked = await sys().selectFrom('payment_intents').select('payment_id').where('id', '=', vpaIntent).executeTakeFirstOrThrow()
    expect(linked.payment_id).toBe(a.id)
    await expect(pay(vpaIntent, 2_500)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(pay(pending, 1_000)).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
    const other = await insertIntent({ provider: 'upi_vpa', amount: 700 })
    await expect(pay(other, 701)).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
    // Without an intent a UPI payment goes to the bank (static VPA).
    const plain = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, { direction: 'in', store_id: shop.store.id, method: 'upi', amount_paise: 100, payment_date: TODAY }),
    )
    expect(plain.account_id).toBe(bankId)
  })

  it('issues and redeems store credit on customer_advance, never beyond the balance', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const customer = { type: 'customer' as const, id: c.id }
    // Credit note settled as store credit: the shop "pays" the customer in store credit.
    await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: shop.store.id,
        method: 'store_credit',
        amount_paise: 1_500,
        payment_date: TODAY,
        party: customer,
      }),
    )
    expect(await shop.tx((tx) => storeCreditBalance(tx, shop.ctx, c.id))).toBe(1_500)
    expect((await balanceOf(c.id)).balance_paise).toBe(1_500) // Dr receivable: credit moved out of AR
    const inv = await insertInvoice(c.id, 2_000)
    const redeemed = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        method: 'store_credit',
        amount_paise: 1_000,
        payment_date: TODAY,
        party: customer,
        allocations: [{ target_type: 'sales_invoice', target_id: inv, amount_paise: 1_000 }],
      }),
    )
    const lines = await shop.tx((tx) => journalOf(tx, redeemed.id))
    expect(lines.map((l) => [l.subtype, l.debit_paise, l.credit_paise, l.party_id])).toEqual([
      ['customer_advance', 1_000, 0, c.id],
      ['receivable', 0, 1_000, c.id],
    ])
    expect(await shop.tx((tx) => storeCreditBalance(tx, shop.ctx, c.id))).toBe(500)
    await expect(
      shop.tx((tx) =>
        recordPayment(tx, shop.ctx, {
          direction: 'in',
          store_id: shop.store.id,
          method: 'store_credit',
          amount_paise: 501,
          payment_date: TODAY,
          party: customer,
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', details: { available_paise: 500 } })
    await expect(
      shop.tx((tx) =>
        recordPayment(tx, shop.ctx, {
          direction: 'in',
          store_id: shop.store.id,
          method: 'store_credit',
          amount_paise: 1,
          payment_date: TODAY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
  })

  it('is idempotent on client_ref', async () => {
    const ref = `pos-${newId()}`
    const input = {
      direction: 'in' as const,
      store_id: shop.store.id,
      method: 'cash' as const,
      amount_paise: 4_200,
      payment_date: TODAY,
      client_ref: ref,
    }
    const first = await shop.tx((tx) => recordPayment(tx, shop.ctx, input))
    const again = await shop.tx((tx) => recordPayment(tx, shop.ctx, input))
    expect(again).toMatchObject({ id: first.id, replayed: true })
    await expect(shop.tx((tx) => recordPayment(tx, shop.ctx, { ...input, amount_paise: 4_300 }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
      status: 409,
    })
    const count = await sys().selectFrom('payments').select('id').where('client_ref', '=', ref).execute()
    expect(count).toHaveLength(1)
  })

  it('links shifts and validates them', async () => {
    const shiftId = newId()
    await sys()
      .insertInto('register_shifts')
      .values({
        id: shiftId,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        register_id: shop.register.id,
        opened_by: shop.owner.user.id,
      })
      .execute()
    const p = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        shift_id: shiftId,
        method: 'cash',
        amount_paise: 100,
        payment_date: TODAY,
      }),
    )
    expect(p).toMatchObject({ shift_id: shiftId, register_id: shop.register.id })
    await sys().updateTable('register_shifts').set({ status: 'closed', closed_at: new Date() }).where('id', '=', shiftId).execute()
    await expect(
      shop.tx((tx) =>
        recordPayment(tx, shop.ctx, {
          direction: 'in',
          store_id: shop.store.id,
          shift_id: shiftId,
          method: 'cash',
          amount_paise: 100,
          payment_date: TODAY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('enforces store scoping of the member', async () => {
    const scoped = await shop.asRole('cashier', { store_ids: [newId()] })
    await expect(
      shop.tx(
        (tx) =>
          recordPayment(tx, scoped.ctx, {
            direction: 'in',
            store_id: shop.store.id,
            method: 'cash',
            amount_paise: 100,
            payment_date: TODAY,
          }),
        scoped,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('cancels a payment: reverses the journal, restores documents, releases the intent, audits', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const inv = await insertInvoice(c.id, 2_500)
    const intent = await insertIntent({ provider: 'upi_vpa', amount: 2_500 })
    const balanceBefore = (await balanceOf(c.id)).balance_paise
    const p = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        method: 'upi',
        amount_paise: 2_500,
        payment_date: TODAY,
        party: { type: 'customer', id: c.id },
        payment_intent_id: intent,
        allocations: [{ target_type: 'sales_invoice', target_id: inv, amount_paise: 2_500 }],
        number: true,
      }),
    )
    expect(await invoiceOf(inv)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
    const res = await shop.tx((tx) =>
      cancelPayment(tx, shop.ctx, { payment_id: p.id, reason: 'Wrong customer', date: '2026-10-21' }),
    )
    expect(res.reversal_entry_id).toEqual(expect.any(String))
    expect(await invoiceOf(inv)).toEqual({ paid_paise: 0, due_paise: 2_500, payment_status: 'unpaid' })
    expect((await balanceOf(c.id)).balance_paise).toBe(balanceBefore)
    const after = await shop.tx((tx) => getPayment(tx, shop.ctx, p.id))
    expect(after).toMatchObject({ status: 'cancelled', cancel_reason: 'Wrong customer', number: p.number })
    expect(after.allocations).toHaveLength(1) // kept for history
    const released = await sys().selectFrom('payment_intents').select('payment_id').where('id', '=', intent).executeTakeFirstOrThrow()
    expect(released.payment_id).toBeNull()
    const lines = await shop.tx((tx) => journalOf(tx, p.id))
    expect(lines).toHaveLength(4)
    expect(lines.filter((l) => l.reverses_entry_id !== null)).toHaveLength(2)
    const auditRow = await sys()
      .selectFrom('audit_logs')
      .select(['action', 'user_id'])
      .where('tenant_id', '=', shop.tenant.id)
      .where('entity_id', '=', p.id)
      .executeTakeFirstOrThrow()
    expect(auditRow).toEqual({ action: 'payment.cancel', user_id: shop.owner.user.id })
    await expect(
      shop.tx((tx) => cancelPayment(tx, shop.ctx, { payment_id: p.id, reason: 'again' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // The released intent can fund a new receipt.
    const again = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        method: 'upi',
        amount_paise: 2_500,
        payment_date: TODAY,
        payment_intent_id: intent,
      }),
    )
    expect(again.unallocated_paise).toBe(2_500)
  })

  it('refunds credit notes (settled_paise) and checks them', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const cn = newId()
    await sys()
      .insertInto('credit_notes')
      .values({
        id: cn,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        number: `CN/${cn.slice(-6)}`,
        fy: '2026-27',
        note_date: TODAY,
        customer_id: c.id,
        place_of_supply: '33',
        reason: 'return',
        settlement: 'cash',
        taxable_paise: 800,
        total_paise: 800,
      })
      .execute()
    const refund = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: shop.store.id,
        method: 'cash',
        amount_paise: 800,
        payment_date: TODAY,
        party: { type: 'customer', id: c.id },
        allocations: [{ target_type: 'credit_note', target_id: cn, amount_paise: 800 }],
      }),
    )
    const row = await sys().selectFrom('credit_notes').select('settled_paise').where('id', '=', cn).executeTakeFirstOrThrow()
    expect(row.settled_paise).toBe(800)
    const lines = await shop.tx((tx) => journalOf(tx, refund.id))
    expect(lines.map((l) => [l.subtype, l.debit_paise, l.credit_paise])).toEqual([
      ['receivable', 800, 0],
      ['cash', 0, 800],
    ])
    await shop.tx((tx) => cancelPayment(tx, shop.ctx, { payment_id: refund.id, reason: 'reissue' }))
    const reverted = await sys().selectFrom('credit_notes').select('settled_paise').where('id', '=', cn).executeTakeFirstOrThrow()
    expect(reverted.settled_paise).toBe(0)
  })
})
