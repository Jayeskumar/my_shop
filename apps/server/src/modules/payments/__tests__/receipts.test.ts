/**
 * Receipts & payment vouchers: RC / PV numbering, explicit allocations and auto FIFO (opening
 * balance first, oldest documents next, rest as advance), supplier payments to purchase bills,
 * open items, list filters + summary + audited CSV export, detail with document numbers,
 * cancellation of manual payments only (POS tenders → 409), idempotency, direction-dependent
 * permissions, store scoping and tenant isolation.
 */
import { newId } from '@kadai/shared'
import {
  type OpenItemsResponse,
  type PaymentDetail,
  type PaymentListResponse,
  paymentClientRef,
} from '@kadai/shared/api/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordPayment } from '../../../core/payments'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import {
  type TestShop,
  createTestTenant,
  insertTestCustomer,
  insertTestSupplier,
} from '../../../test/tenants'
import {
  type Data,
  TODAY,
  api,
  auditRows,
  billState,
  expectError,
  expectStatus,
  insertBill,
  insertInvoice,
  invoiceState,
} from './fixtures'

describe('payments: receipts & vouchers', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const create = (
    body: Record<string, unknown>,
    as?: TestShop['owner'],
    headers?: Record<string, string>,
    on = shop,
  ) =>
    on.inject({
      method: 'POST',
      url: api('/payments'),
      payload: { store_id: on.store.id, payment_date: TODAY, ...body },
      as,
      headers,
    })

  it('records a customer receipt with allocations (RC number, document numbers)', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const inv = await insertInvoice(t, shop, { customerId: c.id, total: 5_000 })
    const p = expectStatus<Data<PaymentDetail>>(
      await create({
        direction: 'in',
        party_type: 'customer',
        party_id: c.id,
        method: 'cash',
        amount_paise: 6_000,
        reference: 'counter',
        allocations: [{ target_type: 'sales_invoice', target_id: inv.id, amount_paise: 5_000 }],
      }),
      201,
    ).data
    expect(p).toMatchObject({
      direction: 'in',
      method: 'cash',
      amount_paise: 6_000,
      allocated_paise: 5_000,
      unallocated_paise: 1_000,
      party_name: c.name,
      account_name: 'Cash in hand',
      origin: 'manual',
      status: 'completed',
      created_by: shop.owner.user.id,
    })
    expect(p.number).toMatch(/^RCS1\/2627\/\d{5}$/)
    expect(p.allocations).toEqual([
      expect.objectContaining({
        target_type: 'sales_invoice',
        target_id: inv.id,
        amount_paise: 5_000,
        document_number: inv.number,
        document_date: TODAY,
        document_total_paise: 5_000,
        document_due_paise: 0,
      }),
    ])
    expect(p.journal_entry_id).not.toBeNull()
    expect(await invoiceState(t, inv.id)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
    const detail = expectStatus<Data<PaymentDetail>>(
      await shop.inject({ method: 'GET', url: api(`/payments/${p.id}`) }),
      200,
    ).data
    expect(detail.id).toBe(p.id)
  })

  it('auto-allocates FIFO: opening balance first, then the oldest invoices; rest is advance', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id, { opening_balance_paise: 1_000 })
    const old = await insertInvoice(t, shop, { customerId: c.id, total: 2_000, date: '2026-09-01' })
    const mid = await insertInvoice(t, shop, { customerId: c.id, total: 3_000, date: '2026-09-20' })
    const items = expectStatus<Data<OpenItemsResponse>>(
      await shop.inject({
        method: 'GET',
        url: api(`/payments/open-items?party_type=customer&party_id=${c.id}`),
      }),
      200,
    ).data
    expect(items.direction).toBe('in')
    expect(items.items.map((i) => [i.target_type, i.due_paise])).toEqual([
      ['opening_balance', 1_000],
      ['sales_invoice', 2_000],
      ['sales_invoice', 3_000],
    ])
    expect(items.total_due_paise).toBe(6_000)
    const p = expectStatus<Data<PaymentDetail>>(
      await create({
        direction: 'in',
        party_type: 'customer',
        party_id: c.id,
        method: 'upi',
        amount_paise: 4_500,
        auto_allocate: 'fifo',
      }),
      201,
    ).data
    expect(p.allocations.map((a) => [a.target_type, a.target_id, a.amount_paise])).toEqual([
      ['opening_balance', c.id, 1_000],
      ['sales_invoice', old.id, 2_000],
      ['sales_invoice', mid.id, 1_500],
    ])
    expect(p.unallocated_paise).toBe(0)
    expect(await invoiceState(t, mid.id)).toMatchObject({
      due_paise: 1_500,
      payment_status: 'partial',
    })
    const big = expectStatus<Data<PaymentDetail>>(
      await create({
        direction: 'in',
        party_type: 'customer',
        party_id: c.id,
        method: 'cash',
        amount_paise: 2_000,
        auto_allocate: 'fifo',
      }),
      201,
    ).data
    expect(big).toMatchObject({ allocated_paise: 1_500, unallocated_paise: 500 })
    expectError(
      await create({
        direction: 'in',
        party_type: 'customer',
        party_id: c.id,
        method: 'cash',
        amount_paise: 100,
        auto_allocate: 'fifo',
        allocations: [{ target_type: 'sales_invoice', target_id: old.id, amount_paise: 100 }],
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('pays suppliers against purchase bills (PV number, payments.pay)', async () => {
    const s = await insertTestSupplier(t.deps, shop.tenant.id)
    const b1 = await insertBill(t, shop, { supplierId: s.id, total: 10_000, date: '2026-09-01' })
    const b2 = await insertBill(t, shop, { supplierId: s.id, total: 8_000, date: '2026-09-10' })
    const open = expectStatus<Data<OpenItemsResponse>>(
      await shop.inject({
        method: 'GET',
        url: api(`/payments/open-items?party_type=supplier&party_id=${s.id}`),
      }),
      200,
    ).data
    expect(open.direction).toBe('out')
    expect(open.items.map((i) => i.target_id)).toEqual([b1.id, b2.id])
    const cashier = await shop.asRole('cashier')
    expectError(
      await create(
        {
          direction: 'out',
          party_type: 'supplier',
          party_id: s.id,
          method: 'bank_transfer',
          amount_paise: 12_000,
          auto_allocate: 'fifo',
        },
        cashier,
      ),
      403,
      'FORBIDDEN',
    )
    const accountantPay = await shop.asRole('payer', { permissions: ['payments.pay'] })
    const pv = expectStatus<Data<PaymentDetail>>(
      await create(
        {
          direction: 'out',
          party_type: 'supplier',
          party_id: s.id,
          method: 'bank_transfer',
          amount_paise: 12_000,
          auto_allocate: 'fifo',
          reference: 'NEFT123',
        },
        accountantPay,
      ),
      201,
    ).data
    expect(pv.number).toMatch(/^PVS1\/2627\//)
    expect(pv.allocations.map((a) => [a.target_id, a.amount_paise, a.document_number])).toEqual([
      [b1.id, 10_000, b1.number],
      [b2.id, 2_000, b2.number],
    ])
    expect(await billState(t, b1.id)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
    expect(await billState(t, b2.id)).toMatchObject({ due_paise: 6_000, payment_status: 'partial' })
    // A receipt by someone with payments.pay only is refused.
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    expectError(
      await create(
        {
          direction: 'in',
          party_type: 'customer',
          party_id: c.id,
          method: 'cash',
          amount_paise: 100,
        },
        accountantPay,
      ),
      403,
      'FORBIDDEN',
    )
    // Over-allocation is refused by the posting service.
    expectError(
      await create({
        direction: 'out',
        party_type: 'supplier',
        party_id: s.id,
        method: 'cash',
        amount_paise: 9_000,
        allocations: [{ target_type: 'purchase_bill', target_id: b2.id, amount_paise: 9_000 }],
      }),
      422,
      'UNPROCESSABLE',
    )
  })

  it('is idempotent on Idempotency-Key and refuses reserved client refs', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const key = `rcpt-${newId()}`
    const body = {
      direction: 'in',
      party_type: 'customer',
      party_id: c.id,
      method: 'cash',
      amount_paise: 700,
    }
    const first = await create(body, undefined, { 'idempotency-key': key })
    const a = expectStatus<Data<PaymentDetail>>(first, 201).data
    const second = await create(body, undefined, { 'idempotency-key': key })
    expect(expectStatus<Data<PaymentDetail>>(second, 201).data.id).toBe(a.id)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expectError(
      await create({ ...body, amount_paise: 800 }, undefined, { 'idempotency-key': key }),
      409,
      'IDEMPOTENCY_MISMATCH',
    )
    expectError(await create({ ...body, client_ref: 'tender:abc:0' }), 400, 'VALIDATION_ERROR')
  })

  it('cancels manual payments only (POS tenders are cancelled with the bill)', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const inv = await insertInvoice(t, shop, { customerId: c.id, total: 3_000 })
    const p = expectStatus<Data<PaymentDetail>>(
      await create({
        direction: 'in',
        party_type: 'customer',
        party_id: c.id,
        method: 'cash',
        amount_paise: 3_000,
        auto_allocate: 'fifo',
      }),
      201,
    ).data
    const cancelled = expectStatus<Data<PaymentDetail>>(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/${p.id}/cancel`),
        payload: { reason: 'Entered twice' },
      }),
      200,
    ).data
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'Entered twice',
      cancelled_by_name: shop.owner.user.full_name,
    })
    expect(await invoiceState(t, inv.id)).toMatchObject({
      due_paise: 3_000,
      payment_status: 'unpaid',
    })
    expect((await auditRows(t, shop, 'payment.cancel'))[0]?.entity_id).toBe(p.id)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/${p.id}/cancel`),
        payload: { reason: 'Again' },
      }),
      409,
      'CONFLICT',
      'payment_not_completed',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/${p.id}/cancel`),
        payload: { reason: 'x' },
      }),
      400,
      'VALIDATION_ERROR',
    )
    // A POS tender (recorded with the invoice) → 409.
    const posInv = await insertInvoice(t, shop, { customerId: null, total: 1_000 })
    const tender = await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        method: 'cash',
        amount_paise: 1_000,
        payment_date: TODAY,
        allocations: [{ target_type: 'sales_invoice', target_id: posInv.id, amount_paise: 1_000 }],
        client_ref: paymentClientRef.salesTender(posInv.id, 0),
      }),
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/${tender.id}/cancel`),
        payload: { reason: 'Mistake' },
      }),
      409,
      'CONFLICT',
      'payment_not_cancellable',
    )
  })

  it('lists with filters, summary and an audited CSV export', async () => {
    const list = expectStatus<PaymentListResponse>(
      await shop.inject({ method: 'GET', url: api('/payments?limit=200') }),
      200,
    )
    expect(list.data.length).toBeGreaterThan(3)
    const completed = list.data.filter((p) => p.status === 'completed')
    expect(list.summary.count).toBe(completed.length)
    expect(list.summary.in_paise).toBe(
      completed.filter((p) => p.direction === 'in').reduce((s, p) => s + p.amount_paise, 0),
    )
    expect(list.summary.out_paise).toBe(
      completed.filter((p) => p.direction === 'out').reduce((s, p) => s + p.amount_paise, 0),
    )
    expect(list.summary.net_paise).toBe(list.summary.in_paise - list.summary.out_paise)
    const outs = expectStatus<PaymentListResponse>(
      await shop.inject({
        method: 'GET',
        url: api('/payments?direction=out&method=bank_transfer'),
      }),
      200,
    )
    expect(outs.data.length).toBeGreaterThan(0)
    expect(outs.data.every((p) => p.direction === 'out' && p.method === 'bank_transfer')).toBe(true)
    const tenders = expectStatus<PaymentListResponse>(
      await shop.inject({ method: 'GET', url: api('/payments?origin=sales_tender') }),
      200,
    )
    expect(tenders.data.every((p) => p.origin === 'sales_tender')).toBe(true)
    expect(tenders.data.length).toBe(1)
    const ranged = expectStatus<PaymentListResponse>(
      await shop.inject({
        method: 'GET',
        url: api(`/payments?from=${TODAY}&to=${TODAY}&status=completed&sort=-amount_paise`),
      }),
      200,
    )
    const amounts = ranged.data.map((p) => p.amount_paise)
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts)
    const one = list.data.find((p) => p.number)!
    const byNumber = expectStatus<PaymentListResponse>(
      await shop.inject({
        method: 'GET',
        url: api(`/payments?q=${encodeURIComponent(one.number!)}`),
      }),
      200,
    )
    expect(byNumber.data.map((p) => p.id)).toContain(one.id)

    const csv = await shop.inject({ method: 'GET', url: api('/payments?format=csv') })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.headers['content-disposition']).toMatch(
      /attachment; filename="payments-\d{4}-\d{2}-\d{2}\.csv"/,
    )
    expect(csv.body.split('\r\n')[0]).toContain('Date,Number,Direction')
    expect((await auditRows(t, shop, 'payment.export')).length).toBeGreaterThan(0)
    const reader = await shop.asRole('reader', { permissions: ['payments.read'] })
    expectStatus(await shop.inject({ method: 'GET', url: api('/payments'), as: reader }), 200)
    expectError(
      await shop.inject({ method: 'GET', url: api('/payments?format=csv'), as: reader }),
      403,
      'FORBIDDEN',
    )
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/payments'), as: cashier }),
      403,
      'FORBIDDEN',
    )
  })

  it('scopes payments to the member stores and the tenant', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const p = expectStatus<Data<PaymentDetail>>(
      await create({
        direction: 'in',
        party_type: 'customer',
        party_id: c.id,
        method: 'cash',
        amount_paise: 250,
      }),
      201,
    ).data
    const store2 = await t.deps.db.systemDb
      .insertInto('stores')
      .values({ tenant_id: shop.tenant.id, code: 'S5', name: 'Branch 5', state_code: '33' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const branch = await shop.asRole('branch_staff', {
      permissions: ['payments.read', 'payments.collect'],
      store_ids: [store2.id],
    })
    expectError(
      await shop.inject({ method: 'GET', url: api(`/payments/${p.id}`), as: branch }),
      404,
      'NOT_FOUND',
    )
    const branchList = expectStatus<PaymentListResponse>(
      await shop.inject({ method: 'GET', url: api('/payments'), as: branch }),
      200,
    )
    expect(branchList.page.total).toBe(0)
    expectError(
      await create(
        {
          direction: 'in',
          party_type: 'customer',
          party_id: c.id,
          method: 'cash',
          amount_paise: 100,
        },
        branch,
      ),
      403,
      'FORBIDDEN',
    )
    expectError(
      await other.inject({ method: 'GET', url: api(`/payments/${p.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'POST',
        url: api(`/payments/${p.id}/cancel`),
        payload: { reason: 'Not mine' },
      }),
      404,
      'NOT_FOUND',
    )
    const otherList = expectStatus<PaymentListResponse>(
      await other.inject({ method: 'GET', url: api('/payments') }),
      200,
    )
    expect(otherList.data.some((x) => x.id === p.id)).toBe(false)
    // Parties of another tenant cannot be paid.
    expectError(
      await create(
        {
          direction: 'in',
          party_type: 'customer',
          party_id: c.id,
          method: 'cash',
          amount_paise: 100,
        },
        undefined,
        undefined,
        other,
      ),
      404,
      'NOT_FOUND',
    )
  })
})
