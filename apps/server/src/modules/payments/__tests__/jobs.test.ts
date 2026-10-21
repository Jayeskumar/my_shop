/**
 * Jobs: payments.poll-intents (backoff 3 s / 5 s / 10 s / 30 s, pending → paid via the fake
 * Razorpay QR payments and payment links, mock auto-pay), payments.expire-intents (last status
 * check, expiry + close at the provider, close retries) and the registered job definitions.
 * Handlers run directly against the test database.
 */
import { newId } from '@kadai/shared'
import type { PaymentIntent } from '@kadai/shared/api/payments'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
import { jobs } from '../jobs'
import { expireIntent, pollIntent, retryClose } from '../polling'
import {
  type Data,
  type FakeRazorpay,
  api,
  closeOpenIntents,
  createRazorpayAccount,
  expectStatus,
  insertInvoice,
  intentRow,
  invoiceState,
  startFakeRazorpay,
} from './fixtures'

describe('payments: jobs', () => {
  let t: TestApp
  let shop: TestShop
  let mockShop: TestShop
  let rzp: FakeRazorpay

  beforeAll(async () => {
    rzp = await startFakeRazorpay()
    process.env.RAZORPAY_API_BASE = rzp.url
    t = await buildTestApp()
    shop = await createTestTenant(t)
    mockShop = await createTestTenant(t)
    await createRazorpayAccount(shop)
    expectStatus(
      await mockShop.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: {
          provider: 'mock',
          display_name: 'Mock',
          store_id: mockShop.store.id,
          auto_pay_delay_ms: 1,
        },
      }),
      201,
    )
  })
  afterAll(async () => {
    await closeOpenIntents(t, [shop, mockShop])
    await t.close()
    await rzp.close()
  })

  const newIntent = async (on: TestShop, amount = 6_000) =>
    expectStatus<Data<PaymentIntent>>(
      await on.inject({
        method: 'POST',
        url: api('/payments/intents'),
        payload: { purpose: 'pos_sale', store_id: on.store.id, amount_paise: amount },
      }),
      201,
    ).data

  /** Moves the intent's poll clock back (seconds since the last poll / creation). */
  const ageIntent = (id: string, seconds: number) =>
    sql`update payment_intents
           set created_at = now() - make_interval(secs => ${seconds}),
               last_polled_at = case when last_polled_at is null then null else now() - make_interval(secs => ${seconds}) end
         where id = ${id}`.execute(t.deps.db.systemDb)

  it('registers the three jobs with their schedules', () => {
    const byName = new Map(jobs.map((j) => [j.name, j]))
    expect(byName.get('payments.poll-intents')?.intervalSeconds).toBe(15)
    expect(byName.get('payments.expire-intents')?.cron).toBe('* * * * *')
    expect(byName.get('payments.process-webhook')).toBeDefined()
  })

  it('polls with backoff and turns a captured QR payment into paid', async () => {
    const intent = await newIntent(shop)
    // Just created: the first poll is due after 3 s.
    expect(await pollIntent(t.deps, shop.tenant.id, intent.id)).toBe('skipped')
    await ageIntent(intent.id, 4)
    expect(await pollIntent(t.deps, shop.tenant.id, intent.id)).toBe('pending')
    let row = await intentRow(t, intent.id)
    expect(row.poll_count).toBe(1)
    expect(row.last_polled_at).not.toBeNull()
    // poll_count 1 → next poll after 5 s.
    await ageIntent(intent.id, 4)
    expect(await pollIntent(t.deps, shop.tenant.id, intent.id)).toBe('skipped')
    await ageIntent(intent.id, 6)
    rzp.qrPayments.get(intent.provider_ref!)!.push({
      id: 'pay_poll_1',
      amount: 6_000,
      status: 'captured',
      vpa: 'Poll.Payer@okhdfcbank',
      rrn: '600011112222',
    })
    expect(await pollIntent(t.deps, shop.tenant.id, intent.id)).toBe('paid')
    row = await intentRow(t, intent.id)
    expect(row).toMatchObject({
      status: 'paid',
      confirmation: 'poll',
      provider_payment_id: 'pay_poll_1',
      payer_vpa: 'poll.payer@okhdfcbank',
      utr: '600011112222',
      poll_count: 2,
    })
    // Paid intents are not polled again.
    await ageIntent(intent.id, 60)
    expect(await pollIntent(t.deps, shop.tenant.id, intent.id)).toBe('skipped')
  })

  it('polls payment links and records the FIFO receipt', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id, { phone: '+919876500022' })
    const inv = await insertInvoice(t, shop, { customerId: c.id, total: 2_500 })
    const link = expectStatus<Data<{ intent: PaymentIntent }>>(
      await shop.inject({
        method: 'POST',
        url: api('/payments/links'),
        payload: { customer_id: c.id, store_id: shop.store.id, amount_paise: 2_500 },
      }),
      201,
    ).data.intent
    const fake = rzp.links.get(link.provider_ref!)!
    fake.status = 'paid'
    fake.amount_paid = 2_500
    fake.payments.push({ id: 'pay_link_poll', amount: 2_500, status: 'captured' })
    rzp.payments.set('pay_link_poll', {
      id: 'pay_link_poll',
      amount: 2_500,
      status: 'captured',
      vpa: 'cust@okaxis',
      rrn: '611122223333',
    })
    await ageIntent(link.id, 4)
    expect(await pollIntent(t.deps, shop.tenant.id, link.id)).toBe('paid')
    const row = await intentRow(t, link.id)
    expect(row).toMatchObject({ status: 'paid', utr: '611122223333', payer_vpa: 'cust@okaxis' })
    expect(row.payment_id).not.toBeNull()
    expect(await invoiceState(t, inv.id)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
  })

  it('auto-pays mock intents after their delay', async () => {
    const intent = await newIntent(mockShop, 1_200)
    await ageIntent(intent.id, 4)
    expect(await pollIntent(t.deps, mockShop.tenant.id, intent.id)).toBe('paid')
    expect(await intentRow(t, intent.id)).toMatchObject({
      status: 'paid',
      confirmation: 'poll',
      paid_amount_paise: 1_200,
    })
  })

  it('expires open intents and closes their QR at the provider', async () => {
    const intent = await newIntent(shop)
    await sql`update payment_intents set expires_at = now() - interval '1 second' where id = ${intent.id}`.execute(
      t.deps.db.systemDb,
    )
    const closesBefore = rzp.requests.filter((r) =>
      r.url.endsWith(`${intent.provider_ref}/close`),
    ).length
    expect(await expireIntent(t.deps, shop.tenant.id, intent.id)).toBe('expired')
    const row = await intentRow(t, intent.id)
    expect(row.status).toBe('expired')
    expect(row.provider_closed_at).not.toBeNull()
    expect(rzp.requests.filter((r) => r.url.endsWith(`${intent.provider_ref}/close`)).length).toBe(
      closesBefore + 1,
    )
    expect(await expireIntent(t.deps, shop.tenant.id, intent.id)).toBe('skipped')
  })

  it('confirms a last-second payment instead of expiring it', async () => {
    const intent = await newIntent(shop, 7_000)
    rzp.qrPayments
      .get(intent.provider_ref!)!
      .push({ id: 'pay_last_sec', amount: 7_000, status: 'captured' })
    await sql`update payment_intents set expires_at = now() - interval '1 second' where id = ${intent.id}`.execute(
      t.deps.db.systemDb,
    )
    expect(await expireIntent(t.deps, shop.tenant.id, intent.id)).toBe('paid')
    expect(await intentRow(t, intent.id)).toMatchObject({
      status: 'paid',
      provider_payment_id: 'pay_last_sec',
    })
  })

  it('retries failed closes and records late payments found then', async () => {
    const intent = await newIntent(shop, 3_100)
    await sql`update payment_intents set expires_at = now() - interval '1 second' where id = ${intent.id}`.execute(
      t.deps.db.systemDb,
    )
    rzp.failCloses = true
    expect(await expireIntent(t.deps, shop.tenant.id, intent.id)).toBe('expired')
    let row = await intentRow(t, intent.id)
    expect(row).toMatchObject({ status: 'expired', provider_closed_at: null, close_attempts: 1 })
    rzp.failCloses = false
    expect(await retryClose(t.deps, shop.tenant.id, intent.id)).toBe('closed')
    row = await intentRow(t, intent.id)
    expect(row.provider_closed_at).not.toBeNull()

    // A payment that arrived after expiry: the close retry finds and records it (unapplied).
    const late = await newIntent(shop, 2_200)
    await sql`update payment_intents set expires_at = now() - interval '1 second' where id = ${late.id}`.execute(
      t.deps.db.systemDb,
    )
    rzp.failCloses = true
    await expireIntent(t.deps, shop.tenant.id, late.id)
    rzp.failCloses = false
    rzp.qrPayments
      .get(late.provider_ref!)!
      .push({ id: 'pay_late', amount: 2_200, status: 'captured' })
    expect(await retryClose(t.deps, shop.tenant.id, late.id)).toBe('paid')
    const lateRow = await intentRow(t, late.id)
    expect(lateRow).toMatchObject({ status: 'paid', payment_id: null })
    expect(lateRow.failure_reason).toContain('late_payment')
  })

  it('runs the job handlers end to end', async () => {
    const poll = jobs.find((j) => j.name === 'payments.poll-intents')!
    const expire = jobs.find((j) => j.name === 'payments.expire-intents')!
    const sweep = jobs.find((j) => j.name === 'payments.process-webhook')!
    const due = await newIntent(shop, 9_100)
    rzp.qrPayments
      .get(due.provider_ref!)!
      .push({ id: `pay_${newId().slice(-8)}`, amount: 9_100, status: 'captured' })
    await ageIntent(due.id, 4)
    const stale = await newIntent(shop, 9_200)
    await sql`update payment_intents set expires_at = now() - interval '1 second' where id = ${stale.id}`.execute(
      t.deps.db.systemDb,
    )
    const job = (name: string) => ({ id: newId(), name, data: {}, retryCount: 0 })
    await poll.handler(job(poll.name), t.deps)
    await expire.handler(job(expire.name), t.deps)
    await sweep.handler(job(sweep.name), t.deps)
    expect((await intentRow(t, due.id)).status).toBe('paid')
    expect((await intentRow(t, stale.id)).status).toBe('expired')
  })
})
