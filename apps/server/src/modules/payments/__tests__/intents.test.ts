/**
 * Payment intents: UPI ID / Razorpay / mock QR creation (fake Razorpay), idempotency, provider
 * failure → 502 with the intent recorded as failed, get + long poll, reconciliation list with
 * summary, cancel (closed at the provider; paid → 409; paid-at-provider detected), manual
 * confirmation (audited, UPI ID only, UTR re-use refused, amount mismatch), mock-pay, apply to an
 * invoice / a customer (FIFO), permissions, plan gating, store scoping and tenant isolation.
 */
import { newId, parseUpiUri } from '@kadai/shared'
import type {
  PaymentDetail,
  PaymentIntent,
  PaymentIntentListResponse,
} from '@kadai/shared/api/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import {
  type Data,
  type FakeRazorpay,
  api,
  closeOpenIntents,
  auditRows,
  createRazorpayAccount,
  createUpiAccount,
  expectError,
  expectStatus,
  insertInvoice,
  intentRow,
  invoiceState,
  startFakeRazorpay,
} from './fixtures'

describe('payments: intents', () => {
  let t: TestApp
  let shop: TestShop
  let rzpShop: TestShop
  let other: TestShop
  let rzp: FakeRazorpay
  let upiAccountId: string

  beforeAll(async () => {
    rzp = await startFakeRazorpay()
    process.env.RAZORPAY_API_BASE = rzp.url
    t = await buildTestApp()
    shop = await createTestTenant(t)
    rzpShop = await createTestTenant(t)
    other = await createTestTenant(t)
    upiAccountId = (await createUpiAccount(shop)).id
    await createRazorpayAccount(rzpShop)
    await createUpiAccount(other, { vpa: 'other.shop@okaxis' })
  })
  afterAll(async () => {
    await closeOpenIntents(t, [shop, rzpShop, other])
    await t.close()
    await rzp.close()
  })

  const create = (
    on: TestShop,
    body: Record<string, unknown>,
    as?: TestShop['owner'],
    headers?: Record<string, string>,
  ) =>
    on.inject({
      method: 'POST',
      url: api('/payments/intents'),
      payload: { purpose: 'pos_sale', store_id: on.store.id, amount_paise: 12_345, ...body },
      as,
      headers,
    })
  const get = (on: TestShop, id: string, query = '', as?: TestShop['owner']) =>
    on.inject({ method: 'GET', url: api(`/payments/intents/${id}${query}`), as })

  it('creates a UPI ID intent with an NPCI URI (tr = reference code) and replays by key', async () => {
    const cart = newId()
    const key = `cart-${cart}`
    const res = await create(shop, {
      ref_type: 'pos_cart',
      ref_id: cart,
      register_id: shop.register.id,
      idempotency_key: key,
    })
    const intent = expectStatus<Data<PaymentIntent>>(res, 201).data
    expect(res.headers['idempotent-replayed']).toBe('false')
    expect(intent).toMatchObject({
      status: 'pending',
      provider: 'upi_vpa',
      provider_account_id: upiAccountId,
      kind: 'qr',
      amount_paise: 12_345,
      register_id: shop.register.id,
      image_url: null,
      payment_id: null,
      amount_mismatch: false,
    })
    expect(intent.reference_code).toMatch(/^KD[0-9A-Z]{10}$/)
    const uri = parseUpiUri(intent.upi_uri!)
    expect(uri).toMatchObject({
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Murugan Stores',
      amount_paise: 12_345,
      reference: intent.reference_code,
      mcc: '5411',
    })
    expect(intent.expires_in_seconds).toBeGreaterThan(590)
    expect(intent.expires_in_seconds).toBeLessThanOrEqual(600)

    const again = await create(shop, {
      ref_type: 'pos_cart',
      ref_id: cart,
      register_id: shop.register.id,
      idempotency_key: key,
    })
    expect(expectStatus<Data<PaymentIntent>>(again, 201).data.id).toBe(intent.id)
    expect(again.headers['idempotent-replayed']).toBe('true')
    // Same key through the header works too; a different request with it → 409.
    const viaHeader = await create(
      shop,
      { ref_type: 'pos_cart', ref_id: cart, register_id: shop.register.id },
      undefined,
      {
        'idempotency-key': key,
      },
    )
    expect(expectStatus<Data<PaymentIntent>>(viaHeader, 201).data.id).toBe(intent.id)
    expectError(
      await create(shop, { amount_paise: 99_999, idempotency_key: key }),
      409,
      'IDEMPOTENCY_MISMATCH',
    )
  })

  it('validates references, registers and the provider set-up', async () => {
    expectError(await create(shop, { ref_type: 'pos_cart' }), 400, 'VALIDATION_ERROR')
    expectError(await create(shop, { purpose: 'customer_due' }), 400, 'VALIDATION_ERROR')
    const otherStoreRegister = await t.deps.db.systemDb
      .selectFrom('registers')
      .select('id')
      .where('tenant_id', '=', other.tenant.id)
      .executeTakeFirstOrThrow()
    expectError(await create(shop, { register_id: otherStoreRegister.id }), 404, 'NOT_FOUND')
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const inv = await insertInvoice(t, shop, { customerId: c.id, total: 5_000 })
    expectError(
      await create(shop, {
        purpose: 'invoice_due',
        ref_type: 'sales_invoice',
        ref_id: inv.id,
        amount_paise: 6_000,
      }),
      422,
      'UNPROCESSABLE',
      'amount_exceeds_due',
    )
    const ok = expectStatus<Data<PaymentIntent>>(
      await create(shop, {
        purpose: 'invoice_due',
        ref_type: 'sales_invoice',
        ref_id: inv.id,
        amount_paise: 5_000,
      }),
      201,
    ).data
    expect(ok.customer_id).toBe(c.id)
    expect(ok.customer_name).toBe(c.name)
    const bare = await createTestTenant(t)
    expectError(await create(bare, {}), 422, 'UNPROCESSABLE', 'no_payment_provider')
  })

  it('creates a Razorpay single-use fixed-amount QR', async () => {
    const before = rzp.requests.length
    const intent = expectStatus<Data<PaymentIntent>>(
      await create(rzpShop, { amount_paise: 25_000, note: 'Bill 42' }),
      201,
    ).data
    expect(intent).toMatchObject({ status: 'pending', provider: 'razorpay', upi_uri: null })
    expect(intent.provider_ref).toMatch(/^qr_/)
    expect(intent.image_url).toBe(`https://rzp.io/qr/${intent.provider_ref}`)
    const call = rzp.requests
      .slice(before)
      .find((r) => r.method === 'POST' && r.url === '/v1/payments/qr_codes')!
    expect(call.body).toMatchObject({
      type: 'upi_qr',
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: 25_000,
      description: 'Bill 42',
      notes: {
        tenant_id: rzpShop.tenant.id,
        intent_id: intent.id,
        reference_code: intent.reference_code,
      },
    })
    // Razorpay needs close_by ≥ 15 minutes ahead; our own expiry stays shorter.
    expect(Number(call.body.close_by)).toBeGreaterThanOrEqual(
      Math.floor(Date.now() / 1000) + 15 * 60,
    )
    expect(Date.parse(intent.expires_at!)).toBeLessThan(Number(call.body.close_by) * 1000)
    expect(call.authorization).toMatch(/^Basic /)
  })

  it('records a failed intent and answers 502 PROVIDER_ERROR when Razorpay refuses', async () => {
    rzp.failNextCreate = {
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      description: 'The amount is invalid',
    }
    const key = `fail-${newId()}`
    const err = expectError(await create(rzpShop, { idempotency_key: key }), 502, 'PROVIDER_ERROR')
    expect(err.details).toMatchObject({
      provider: 'razorpay',
      provider_error_code: 'BAD_REQUEST_ERROR',
    })
    const intentId = err.details?.intent_id as string
    const row = await intentRow(t, intentId)
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toContain('The amount is invalid')
    // A replay with the same key gives the same failure (not a second QR).
    const replay = expectError(
      await create(rzpShop, { idempotency_key: key }),
      502,
      'PROVIDER_ERROR',
      'intent_failed',
    )
    expect(replay.details?.intent_id).toBe(intentId)
    // Creates are not idempotent at Razorpay: a 5xx is not retried (one call only).
    rzp.failNextCreate = { status: 500, code: 'SERVER_ERROR', description: 'down' }
    const before = rzp.requests.filter((r) => r.url === '/v1/payments/qr_codes').length
    expectError(await create(rzpShop, {}), 502, 'PROVIDER_ERROR')
    expect(rzp.requests.filter((r) => r.url === '/v1/payments/qr_codes').length).toBe(before + 1)
  })

  it('answers get immediately and long-polls with ?wait', async () => {
    const intent = expectStatus<Data<PaymentIntent>>(await create(shop, {}), 201).data
    expect(expectStatus<Data<PaymentIntent>>(await get(shop, intent.id), 200).data.id).toBe(
      intent.id,
    )
    const started = Date.now()
    const waited = expectStatus<Data<PaymentIntent>>(
      await get(shop, intent.id, '?wait=1'),
      200,
    ).data
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(waited.status).toBe('pending')
    // A status change wakes the long poll early.
    const pending = get(shop, intent.id, '?wait=20&since_status=pending')
    await new Promise((r) => setTimeout(r, 300))
    const t0 = Date.now()
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/confirm`),
        payload: {},
      }),
      200,
    )
    const woke = expectStatus<Data<PaymentIntent>>(await pending, 200).data
    expect(woke.status).toBe('paid')
    expect(Date.now() - t0).toBeLessThan(10_000)
    // since_status other than the current status answers at once.
    expect(
      expectStatus<Data<PaymentIntent>>(
        await get(shop, intent.id, '?wait=20&since_status=pending'),
        200,
      ).data.status,
    ).toBe('paid')
  })

  it('cancels at the provider; paid intents cannot be cancelled', async () => {
    const intent = expectStatus<Data<PaymentIntent>>(await create(rzpShop, {}), 201).data
    const cancelled = expectStatus<Data<PaymentIntent>>(
      await rzpShop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/cancel`),
        payload: { reason: 'Customer paid cash' },
      }),
      200,
    ).data
    expect(cancelled.status).toBe('cancelled')
    expect(
      rzp.requests.some((r) => r.url === `/v1/payments/qr_codes/${intent.provider_ref}/close`),
    ).toBe(true)
    expect((await intentRow(t, intent.id)).provider_closed_at).not.toBeNull()
    // Idempotent.
    expect(
      expectStatus<Data<PaymentIntent>>(
        await rzpShop.inject({ method: 'POST', url: api(`/payments/intents/${intent.id}/cancel`) }),
        200,
      ).data.status,
    ).toBe('cancelled')

    // Paid at Razorpay but the webhook was missed: the cancel finds it and refuses.
    const paidMeanwhile = expectStatus<Data<PaymentIntent>>(
      await create(rzpShop, { amount_paise: 4_000 }),
      201,
    ).data
    rzp.qrPayments
      .get(paidMeanwhile.provider_ref!)!
      .push({ id: `pay_${newId().slice(-10)}`, amount: 4_000, status: 'captured' })
    expectError(
      await rzpShop.inject({
        method: 'POST',
        url: api(`/payments/intents/${paidMeanwhile.id}/cancel`),
      }),
      409,
      'CONFLICT',
      'intent_paid',
    )
    const row = await intentRow(t, paidMeanwhile.id)
    expect(row).toMatchObject({ status: 'paid', confirmation: 'poll', paid_amount_paise: 4_000 })
  })

  it('confirms UPI ID payments by hand (audited) and refuses re-used UTRs', async () => {
    const intent = expectStatus<Data<PaymentIntent>>(
      await create(shop, { amount_paise: 8_800 }),
      201,
    ).data
    const paid = expectStatus<Data<PaymentIntent>>(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/confirm`),
        payload: { utr: '612345678901', payer_vpa: 'Selvi@OKSBI', note: 'soundbox' },
      }),
      200,
    ).data
    expect(paid).toMatchObject({
      status: 'paid',
      confirmation: 'manual',
      confirmed_by: shop.owner.user.id,
      confirmed_by_name: shop.owner.user.full_name,
      utr: '612345678901',
      payer_vpa: 'selvi@oksbi',
      paid_amount_paise: 8_800,
      amount_mismatch: false,
    })
    const audit = (await auditRows(t, shop, 'payment_intent.confirm')).find(
      (a) => a.entity_id === intent.id,
    )
    expect(audit?.user_id).toBe(shop.owner.user.id)
    expect(audit?.changes).toMatchObject({ utr: '612345678901', paid_amount_paise: 8_800 })
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/confirm`),
        payload: {},
      }),
      409,
      'CONFLICT',
      'intent_paid',
    )
    const second = expectStatus<Data<PaymentIntent>>(
      await create(shop, { amount_paise: 1_000 }),
      201,
    ).data
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${second.id}/confirm`),
        payload: { utr: '612345678901' },
      }),
      409,
      'CONFLICT',
      'utr_already_used',
    )
    // Received a different amount: recorded as paid with a mismatch note.
    const mismatch = expectStatus<Data<PaymentIntent>>(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${second.id}/confirm`),
        payload: { paid_amount_paise: 900 },
      }),
      200,
    ).data
    expect(mismatch).toMatchObject({
      status: 'paid',
      paid_amount_paise: 900,
      amount_mismatch: true,
    })
    expect(mismatch.failure_reason).toContain('amount_mismatch')
    // Dynamic providers confirm themselves.
    const rz = expectStatus<Data<PaymentIntent>>(await create(rzpShop, {}), 201).data
    expectError(
      await rzpShop.inject({
        method: 'POST',
        url: api(`/payments/intents/${rz.id}/confirm`),
        payload: {},
      }),
      422,
      'UNPROCESSABLE',
      'manual_confirm_not_supported',
    )
    // A cashier (payments.collect) may confirm.
    const cashier = await shop.asRole('cashier')
    const third = expectStatus<Data<PaymentIntent>>(
      await create(shop, { amount_paise: 700 }, cashier),
      201,
    ).data
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${third.id}/confirm`),
        payload: {},
        as: cashier,
      }),
      200,
    )
  })

  it('pays or fails mock intents through mock-pay', async () => {
    const mockShop = await createTestTenant(t)
    expectStatus(
      await mockShop.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: { provider: 'mock', display_name: 'Mock PSP', store_id: mockShop.store.id },
      }),
      201,
    )
    const a = expectStatus<Data<PaymentIntent>>(
      await create(mockShop, { amount_paise: 3_300 }),
      201,
    ).data
    expect(a.provider).toBe('mock')
    expect(a.upi_uri).toContain('pa=kadai.mock@mockbank')
    const paid = expectStatus<Data<PaymentIntent>>(
      await mockShop.inject({
        method: 'POST',
        url: api(`/payments/intents/${a.id}/mock-pay`),
        payload: {},
      }),
      200,
    ).data
    expect(paid).toMatchObject({
      status: 'paid',
      confirmation: 'webhook',
      paid_amount_paise: 3_300,
    })
    expect(paid.provider_payment_id).toMatch(/^mock_pay_/)
    // Repeating is idempotent (same simulated payment).
    expectStatus(
      await mockShop.inject({
        method: 'POST',
        url: api(`/payments/intents/${a.id}/mock-pay`),
        payload: {},
      }),
      200,
    )
    const b = expectStatus<Data<PaymentIntent>>(await create(mockShop, {}), 201).data
    const failed = expectStatus<Data<PaymentIntent>>(
      await mockShop.inject({
        method: 'POST',
        url: api(`/payments/intents/${b.id}/mock-pay`),
        payload: { outcome: 'failed' },
      }),
      200,
    ).data
    expect(failed.status).toBe('failed')
    const upi = expectStatus<Data<PaymentIntent>>(await create(shop, {}), 201).data
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${upi.id}/mock-pay`),
        payload: {},
      }),
      422,
      'UNPROCESSABLE',
      'not_mock_intent',
    )
  })

  it('applies a paid, unapplied intent to a customer (FIFO) or an invoice', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const old = await insertInvoice(t, shop, { customerId: c.id, total: 3_000, date: '2026-10-01' })
    const newer = await insertInvoice(t, shop, {
      customerId: c.id,
      total: 4_000,
      date: '2026-10-10',
    })
    const intent = expectStatus<Data<PaymentIntent>>(
      await create(shop, { amount_paise: 5_000 }),
      201,
    ).data
    // Not paid yet.
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/apply`),
        payload: { target_type: 'customer', target_id: c.id },
      }),
      422,
      'UNPROCESSABLE',
      'intent_not_paid',
    )
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/confirm`),
        payload: {},
      }),
      200,
    )
    const unapplied = expectStatus<PaymentIntentListResponse>(
      await shop.inject({ method: 'GET', url: api('/payments/intents?unapplied=true&limit=200') }),
      200,
    )
    expect(unapplied.data.some((i) => i.id === intent.id)).toBe(true)
    const applied = expectStatus<Data<{ intent: PaymentIntent; payment: PaymentDetail }>>(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/apply`),
        payload: { target_type: 'customer', target_id: c.id },
      }),
      201,
    ).data
    expect(applied.intent.payment_id).toBe(applied.payment.id)
    expect(applied.intent.payment_number).toMatch(/^RCS1\//)
    expect(applied.payment).toMatchObject({
      direction: 'in',
      method: 'upi',
      amount_paise: 5_000,
      unallocated_paise: 0,
      party_id: c.id,
      payment_intent_id: intent.id,
    })
    expect(applied.payment.allocations.map((a) => [a.target_id, a.amount_paise])).toEqual([
      [old.id, 3_000],
      [newer.id, 2_000],
    ])
    expect(applied.payment.allocations[0]?.document_number).toBe(old.number)
    expect(await invoiceState(t, old.id)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
    expect(await invoiceState(t, newer.id)).toMatchObject({
      due_paise: 2_000,
      payment_status: 'partial',
    })
    expect((await auditRows(t, shop, 'payment_intent.apply'))[0]?.entity_id).toBe(intent.id)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/apply`),
        payload: { target_type: 'customer', target_id: c.id },
      }),
      409,
      'CONFLICT',
      'intent_used',
    )

    // Walk-in invoice with a smaller due cannot take the whole payment.
    const walkIn = await insertInvoice(t, shop, { customerId: null, total: 1_000 })
    const big = expectStatus<Data<PaymentIntent>>(
      await create(shop, { amount_paise: 1_500 }),
      201,
    ).data
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${big.id}/confirm`),
        payload: {},
      }),
      200,
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${big.id}/apply`),
        payload: { target_type: 'sales_invoice', target_id: walkIn.id },
      }),
      422,
      'UNPROCESSABLE',
      'intent_exceeds_due',
    )
    // Customer invoice: the part above the due becomes the customer's advance.
    const custInv = await insertInvoice(t, shop, { customerId: c.id, total: 1_000 })
    const viaInvoice = expectStatus<Data<{ intent: PaymentIntent; payment: PaymentDetail }>>(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${big.id}/apply`),
        payload: { target_type: 'sales_invoice', target_id: custInv.id },
      }),
      201,
    ).data
    expect(viaInvoice.payment).toMatchObject({
      amount_paise: 1_500,
      allocated_paise: 1_000,
      unallocated_paise: 500,
    })
  })

  it('lists intents with filters and a summary over the filtered set', async () => {
    const list = expectStatus<PaymentIntentListResponse>(
      await shop.inject({ method: 'GET', url: api('/payments/intents?limit=2&sort=-created_at') }),
      200,
    )
    expect(list.data).toHaveLength(2)
    expect(list.page.total).toBeGreaterThan(2)
    const totalCount = list.summary.by_status.reduce((s, r) => s + r.count, 0)
    expect(totalCount).toBe(list.page.total)
    expect(list.summary.by_provider[0]).toMatchObject({
      provider: 'upi_vpa',
      provider_account_id: upiAccountId,
    })
    const paidOnly = expectStatus<PaymentIntentListResponse>(
      await shop.inject({ method: 'GET', url: api('/payments/intents?status=paid&limit=200') }),
      200,
    )
    expect(paidOnly.data.every((i) => i.status === 'paid')).toBe(true)
    expect(paidOnly.summary.paid_total_paise).toBe(
      paidOnly.data.reduce((s, i) => s + (i.paid_amount_paise ?? i.amount_paise), 0),
    )
    const one = paidOnly.data[0]!
    const byRef = expectStatus<PaymentIntentListResponse>(
      await shop.inject({ method: 'GET', url: api(`/payments/intents?q=${one.reference_code}`) }),
      200,
    )
    expect(byRef.data.map((i) => i.id)).toEqual([one.id])
    expectError(
      await shop.inject({
        method: 'GET',
        url: api('/payments/intents?from=2026-10-10&to=2026-10-01'),
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('enforces permissions, plan features, store scoping and tenant isolation', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/payments/intents'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const accountant = await shop.asRole('accountant')
    expectError(await create(shop, {}, accountant), 403, 'FORBIDDEN')
    const intent = expectStatus<Data<PaymentIntent>>(await create(shop, {}), 201).data
    expectStatus(await get(shop, intent.id, '', accountant), 200)

    // Free plan: a dynamic provider account (left from an earlier plan) cannot take payments.
    const free = await createTestTenant(t, { plan_code: 'free' })
    await t.deps.db.systemDb
      .insertInto('payment_provider_accounts')
      .values({
        tenant_id: free.tenant.id,
        provider: 'mock',
        display_name: 'Old mock',
        is_default: true,
        store_id: free.store.id,
      })
      .execute()
    expectError(await create(free, {}), 402, 'FEATURE_NOT_IN_PLAN')

    // Store scoping: a member of another store.
    const store2 = await t.deps.db.systemDb
      .insertInto('stores')
      .values({ tenant_id: shop.tenant.id, code: 'S7', name: 'Branch 7', state_code: '33' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const branchCashier = await shop.asRole('branch_cashier', {
      permissions: ['payments.collect', 'payments.read'],
      store_ids: [store2.id],
    })
    expectError(await create(shop, {}, branchCashier), 403, 'FORBIDDEN')
    expectError(await get(shop, intent.id, '', branchCashier), 404, 'NOT_FOUND')
    const scopedList = expectStatus<PaymentIntentListResponse>(
      await shop.inject({ method: 'GET', url: api('/payments/intents'), as: branchCashier }),
      200,
    )
    expect(scopedList.page.total).toBe(0)

    // Tenant isolation.
    expectError(await get(other, intent.id), 404, 'NOT_FOUND')
    expectError(
      await other.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/confirm`),
        payload: {},
      }),
      404,
      'NOT_FOUND',
    )
    const otherList = expectStatus<PaymentIntentListResponse>(
      await other.inject({ method: 'GET', url: api('/payments/intents?limit=200') }),
      200,
    )
    expect(otherList.data.some((i) => i.id === intent.id)).toBe(false)
    expectError(await create(other, { store_id: shop.store.id }), 404, 'NOT_FOUND')
  })
})
