/**
 * Razorpay webhooks: HMAC signature over the raw body (valid → processed, invalid / missing
 * secret → 401 and logged with signature_valid=false), de-duplication by event id, idempotent
 * re-delivery of the same payment, a second payment recorded as a duplicate unapplied intent,
 * amount mismatch, payment_link.paid → FIFO receipt, payment.failed notes, unknown accounts and
 * stored processing failures retried by the payments.process-webhook job handler.
 */
import { newId } from '@kadai/shared'
import type { PaymentIntent } from '@kadai/shared/api/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jsonb } from '../../../db/json'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import { jobs } from '../jobs'
import { processWebhookEvent } from '../webhooks'
import {
  type Data,
  type FakeRazorpay,
  api,
  closeOpenIntents,
  createRazorpayAccount,
  createUpiAccount,
  expectError,
  expectStatus,
  insertInvoice,
  intentRow,
  invoiceState,
  qrCreditedEvent,
  sendWebhook,
  startFakeRazorpay,
} from './fixtures'

describe('payments: webhooks', () => {
  let t: TestApp
  let shop: TestShop
  let rzp: FakeRazorpay
  let accountId: string

  beforeAll(async () => {
    rzp = await startFakeRazorpay()
    process.env.RAZORPAY_API_BASE = rzp.url
    t = await buildTestApp()
    shop = await createTestTenant(t)
    accountId = (await createRazorpayAccount(shop)).id
  })
  afterAll(async () => {
    await closeOpenIntents(t, [shop])
    await t.close()
    await rzp.close()
  })

  const newIntent = async (amount = 10_000) =>
    expectStatus<Data<PaymentIntent>>(
      await shop.inject({
        method: 'POST',
        url: api('/payments/intents'),
        payload: { purpose: 'pos_sale', store_id: shop.store.id, amount_paise: amount },
      }),
      201,
    ).data

  const events = (eventId: string) =>
    t.deps.db.systemDb
      .selectFrom('payment_webhook_events')
      .selectAll()
      .where('provider_account_id', '=', accountId)
      .where('event_id', '=', eventId)
      .execute()

  it('verifies the signature and marks the intent paid (qr_code.credited)', async () => {
    const intent = await newIntent(10_000)
    const eventId = `evt_${newId().slice(-12)}`
    const res = await sendWebhook(
      t,
      accountId,
      qrCreditedEvent({
        qrId: intent.provider_ref!,
        intentId: intent.id,
        amount: 10_000,
        paymentId: 'pay_A1',
        rrn: '429900001111',
      }),
      { eventId },
    )
    expect(expectStatus<Data<{ ok: boolean; duplicate?: boolean }>>(res, 200).data).toEqual({
      ok: true,
    })
    const row = await intentRow(t, intent.id)
    expect(row).toMatchObject({
      status: 'paid',
      confirmation: 'webhook',
      provider_payment_id: 'pay_A1',
      payer_vpa: 'ravi.kumar@okicici',
      utr: '429900001111',
      paid_amount_paise: 10_000,
      fee_paise: 59,
      failure_reason: null,
    })
    const [ev] = await events(eventId)
    expect(ev).toMatchObject({
      signature_valid: true,
      event_type: 'qr_code.credited',
      tenant_id: shop.tenant.id,
      attempts: 1,
    })
    expect(ev?.processed_at).not.toBeNull()

    // The same event again → acknowledged as a duplicate, not processed twice.
    const dup = await sendWebhook(
      t,
      accountId,
      qrCreditedEvent({
        qrId: intent.provider_ref!,
        intentId: intent.id,
        amount: 10_000,
        paymentId: 'pay_A1',
      }),
      { eventId },
    )
    expect(expectStatus<Data<{ ok: boolean; duplicate?: boolean }>>(dup, 200).data).toEqual({
      ok: true,
      duplicate: true,
    })
    expect(await events(eventId)).toHaveLength(1)

    // Re-delivery of the same payment under a new event id: idempotent, no extra intent.
    expectStatus(
      await sendWebhook(
        t,
        accountId,
        qrCreditedEvent({
          qrId: intent.provider_ref!,
          intentId: intent.id,
          amount: 10_000,
          paymentId: 'pay_A1',
        }),
      ),
      200,
    )
    const extras = await t.deps.db.systemDb
      .selectFrom('payment_intents')
      .select('id')
      .where('tenant_id', '=', shop.tenant.id)
      .where('failure_reason', 'like', 'duplicate_payment%')
      .execute()
    expect(extras).toHaveLength(0)

    // A second, different payment for the same QR is kept as an unapplied intent.
    expectStatus(
      await sendWebhook(
        t,
        accountId,
        qrCreditedEvent({
          qrId: intent.provider_ref!,
          intentId: intent.id,
          amount: 10_000,
          paymentId: 'pay_B2',
        }),
      ),
      200,
    )
    const dupIntent = await t.deps.db.systemDb
      .selectFrom('payment_intents')
      .selectAll()
      .where('tenant_id', '=', shop.tenant.id)
      .where('provider_payment_id', '=', 'pay_B2')
      .executeTakeFirstOrThrow()
    expect(dupIntent).toMatchObject({ status: 'paid', payment_id: null, paid_amount_paise: 10_000 })
    expect(dupIntent.failure_reason).toContain('duplicate_payment')
    expect(dupIntent.metadata).toMatchObject({ duplicate_of: intent.id })
  })

  it('rejects bad signatures with 401 and logs the attempt', async () => {
    const intent = await newIntent(2_000)
    const body = qrCreditedEvent({ qrId: intent.provider_ref!, intentId: intent.id, amount: 2_000 })
    const forgedId = `evt_forged_${newId()}`
    const res = await sendWebhook(t, accountId, body, {
      secret: 'not-the-secret',
      eventId: forgedId,
    })
    expectError(res, 401, 'UNAUTHENTICATED', 'invalid_signature')
    expect((await intentRow(t, intent.id)).status).toBe('pending')
    const logged = await t.deps.db.systemDb
      .selectFrom('payment_webhook_events')
      .select(['event_id', 'signature_valid', 'processed_at'])
      .where('provider_account_id', '=', accountId)
      .where('signature_valid', '=', false)
      .execute()
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.every((e) => e.event_id.startsWith('invalid:') && e.processed_at === null)).toBe(
      true,
    )
    // The forged attempt does not block the real event with the same id.
    expectStatus(await sendWebhook(t, accountId, body, { eventId: forgedId }), 200)
    expect((await intentRow(t, intent.id)).status).toBe('paid')
    expectError(await sendWebhook(t, accountId, body, { signature: 'zz' }), 401, 'UNAUTHENTICATED')

    // An account without a webhook secret cannot be called.
    const noSecret = await createRazorpayAccount(shop, {
      webhook_secret: undefined,
      is_default: false,
      display_name: 'No secret',
    })
    expectError(await sendWebhook(t, noSecret.id, body), 401, 'UNAUTHENTICATED')
  })

  it('404s unknown accounts and providers without webhooks', async () => {
    expectError(await sendWebhook(t, newId(), { event: 'qr_code.credited' }), 404, 'NOT_FOUND')
    const upi = await createUpiAccount(shop, { is_default: false })
    const res = await t.app.inject({
      method: 'POST',
      url: `/webhooks/payments/upi_vpa/${upi.id}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expectError(res, 404, 'NOT_FOUND')
    const wrong = await t.app.inject({
      method: 'POST',
      url: `/webhooks/payments/mock/${accountId}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    })
    expectError(wrong, 404, 'NOT_FOUND')
  })

  it('records an amount mismatch as paid but unapplicable for the intent amount', async () => {
    const intent = await newIntent(5_000)
    expectStatus(
      await sendWebhook(
        t,
        accountId,
        qrCreditedEvent({ qrId: intent.provider_ref!, intentId: intent.id, amount: 4_000 }),
      ),
      200,
    )
    const row = await intentRow(t, intent.id)
    expect(row).toMatchObject({ status: 'paid', paid_amount_paise: 4_000, payment_id: null })
    expect(row.failure_reason).toContain('amount_mismatch')
    const api_ = expectStatus<Data<PaymentIntent>>(
      await shop.inject({ method: 'GET', url: api(`/payments/intents/${intent.id}`) }),
      200,
    ).data
    expect(api_.amount_mismatch).toBe(true)
  })

  it('notes payment.failed without closing the intent', async () => {
    const intent = await newIntent(1_500)
    expectStatus(
      await sendWebhook(t, accountId, {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_fail_1',
              status: 'failed',
              amount: 1_500,
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Payment was declined by the bank',
              notes: { intent_id: intent.id },
            },
          },
        },
      }),
      200,
    )
    const row = await intentRow(t, intent.id)
    expect(row.status).toBe('pending')
    expect(row.failure_reason).toContain('declined by the bank')
  })

  it('records a FIFO receipt when a dues link is paid (payment_link.paid)', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id, { phone: '+919876500011' })
    const a = await insertInvoice(t, shop, { customerId: c.id, total: 2_000, date: '2026-09-01' })
    const b = await insertInvoice(t, shop, { customerId: c.id, total: 3_000, date: '2026-09-15' })
    const link = expectStatus<Data<{ intent: PaymentIntent; link_kind: string }>>(
      await shop.inject({
        method: 'POST',
        url: api('/payments/links'),
        payload: { customer_id: c.id, store_id: shop.store.id, amount_paise: 4_000 },
      }),
      201,
    ).data
    expect(link.link_kind).toBe('provider')
    expectStatus(
      await sendWebhook(t, accountId, {
        event: 'payment_link.paid',
        payload: {
          payment_link: {
            entity: {
              id: link.intent.provider_ref,
              status: 'paid',
              amount: 4_000,
              amount_paid: 4_000,
              reference_id: link.intent.reference_code,
              notes: { intent_id: link.intent.id },
            },
          },
          payment: {
            entity: {
              id: 'pay_link_1',
              amount: 4_000,
              status: 'captured',
              vpa: 'cust@okaxis',
              acquirer_data: { rrn: '700011112222' },
            },
          },
        },
      }),
      200,
    )
    const row = await intentRow(t, link.intent.id)
    expect(row.status).toBe('paid')
    expect(row.payment_id).not.toBeNull()
    expect(await invoiceState(t, a.id)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
    expect(await invoiceState(t, b.id)).toMatchObject({
      due_paise: 1_000,
      payment_status: 'partial',
    })
    const payment = await t.deps.db.systemDb
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', row.payment_id!)
      .executeTakeFirstOrThrow()
    expect(payment).toMatchObject({
      direction: 'in',
      method: 'upi',
      amount_paise: 4_000,
      party_id: c.id,
      reference: '700011112222',
    })
    expect(payment.number).toMatch(/^RCS1\//)
  })

  it('leaves a dues link paid with a different amount unapplied until it is applied', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id, { phone: '+919876500012' })
    const inv = await insertInvoice(t, shop, { customerId: c.id, total: 5_000, date: '2026-09-02' })
    const link = expectStatus<Data<{ intent: PaymentIntent }>>(
      await shop.inject({
        method: 'POST',
        url: api('/payments/links'),
        payload: { customer_id: c.id, store_id: shop.store.id, amount_paise: 5_000 },
      }),
      201,
    ).data
    expectStatus(
      await sendWebhook(t, accountId, {
        event: 'payment_link.paid',
        payload: {
          payment_link: {
            entity: {
              id: link.intent.provider_ref,
              status: 'paid',
              amount: 5_000,
              amount_paid: 3_000,
              reference_id: link.intent.reference_code,
              notes: { intent_id: link.intent.id },
            },
          },
          payment: {
            entity: { id: 'pay_link_short', amount: 3_000, status: 'captured', vpa: 'c@okaxis' },
          },
        },
      }),
      200,
    )
    const row = await intentRow(t, link.intent.id)
    expect(row).toMatchObject({ status: 'paid', paid_amount_paise: 3_000, payment_id: null })
    expect(row.failure_reason).toContain('amount_mismatch')
    expect(await invoiceState(t, inv.id)).toMatchObject({ due_paise: 5_000 })

    // Reconciliation: applied to the customer (FIFO) by hand.
    const applied = expectStatus<Data<{ payment: { amount_paise: number } }>>(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${link.intent.id}/apply`),
        payload: { target_type: 'customer', target_id: c.id },
      }),
      201,
    ).data
    expect(applied.payment.amount_paise).toBe(3_000)
    expect(await invoiceState(t, inv.id)).toMatchObject({
      due_paise: 2_000,
      payment_status: 'partial',
    })
  })

  it('stores processing failures and retries them from the process-webhook job', async () => {
    const intent = await newIntent(3_000)
    const job = jobs.find((j) => j.name === 'payments.process-webhook')!
    // An event that cannot be processed (provider without an adapter): failure stored.
    const bad = await t.deps.db.systemDb
      .insertInto('payment_webhook_events')
      .values({
        provider: 'cashfree',
        provider_account_id: accountId,
        tenant_id: shop.tenant.id,
        event_id: `evt_bad_${newId()}`,
        event_type: 'unknown',
        signature_valid: true,
        payload: jsonb({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await expect(
      job.handler(
        { id: newId(), name: job.name, data: { webhook_event_id: bad.id }, retryCount: 0 },
        t.deps,
      ),
    ).rejects.toThrow()
    const failed = await t.deps.db.systemDb
      .selectFrom('payment_webhook_events')
      .select(['attempts', 'processing_error', 'processed_at'])
      .where('id', '=', bad.id)
      .executeTakeFirstOrThrow()
    expect(failed).toMatchObject({ attempts: 1, processed_at: null })
    expect(failed.processing_error).toBeTruthy()

    // A stored, unprocessed valid event is processed by the job.
    const pending = await t.deps.db.systemDb
      .insertInto('payment_webhook_events')
      .values({
        provider: 'razorpay',
        provider_account_id: accountId,
        tenant_id: shop.tenant.id,
        event_id: `evt_retry_${newId()}`,
        event_type: 'qr_code.credited',
        signature_valid: true,
        payload: jsonb(
          qrCreditedEvent({
            qrId: intent.provider_ref!,
            intentId: intent.id,
            amount: 3_000,
            paymentId: 'pay_retry',
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await job.handler(
      { id: newId(), name: job.name, data: { webhook_event_id: pending.id }, retryCount: 1 },
      t.deps,
    )
    expect((await intentRow(t, intent.id)).status).toBe('paid')
    // Already processed → skipped.
    expect((await processWebhookEvent(t.deps, pending.id)).status).toBe('skipped')
  })
})
