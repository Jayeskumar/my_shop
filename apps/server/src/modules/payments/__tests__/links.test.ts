/**
 * Dues links and the public pay page: Kadai pay page for a UPI ID (UPI deep link with
 * tr = reference code), Razorpay hosted links, the payment_link notification (queued in the same
 * transaction, idempotent replay), a paid link recorded FIFO against the customer's dues, the
 * public page model (no internal ids) and the static / standee QR payload.
 */
import { parseUpiUri } from '@kadai/shared'
import type { PaymentLinkResult, PublicPayPage, UpiQrPayload } from '@kadai/shared/api/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../../../test/tenants'
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
  setCustomerBalance,
  startFakeRazorpay,
} from './fixtures'

describe('payments: links, pay page, static QR', () => {
  let t: TestApp
  let shop: TestShop
  let rzpShop: TestShop
  let rzp: FakeRazorpay
  let upiId: string

  beforeAll(async () => {
    rzp = await startFakeRazorpay()
    process.env.RAZORPAY_API_BASE = rzp.url
    t = await buildTestApp()
    shop = await createTestTenant(t)
    rzpShop = await createTestTenant(t)
    upiId = (await createUpiAccount(shop)).id
    await createRazorpayAccount(rzpShop)
  })
  afterAll(async () => {
    await closeOpenIntents(t, [shop, rzpShop])
    await t.close()
    await rzp.close()
  })

  const link = (
    on: TestShop,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
    as?: TestShop['owner'],
  ) =>
    on.inject({
      method: 'POST',
      url: api('/payments/links'),
      payload: { store_id: on.store.id, ...body },
      headers,
      as,
    })

  it('creates a Kadai pay page link for the customer due and queues the message', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id, {
      name: 'Lakshmi Narayanan',
      phone: '+919876543210',
    })
    await setCustomerBalance(t, c.id, 7_550)
    const key = `link-key-${c.id}`
    const res = await link(
      shop,
      { customer_id: c.id, send_via: 'whatsapp' },
      { 'idempotency-key': key },
    )
    const out = expectStatus<Data<PaymentLinkResult>>(res, 201).data
    expect(out.link_kind).toBe('pay_page')
    expect(out.url).toBe(`${t.config.publicBaseUrl}/pay/${out.intent.reference_code}`)
    expect(out.intent).toMatchObject({
      kind: 'link',
      purpose: 'customer_due',
      amount_paise: 7_550,
      customer_id: c.id,
      provider_account_id: upiId,
      status: 'pending',
    })
    expect(parseUpiUri(out.intent.upi_uri!)).toMatchObject({
      amount_paise: 7_550,
      reference: out.intent.reference_code,
    })
    // 72 hours by default.
    expect(Date.parse(out.intent.expires_at!) - Date.now()).toBeGreaterThan(71 * 3600_000)
    expect(out.message).toContain('₹75.50')
    expect(out.message).toContain(out.url)
    expect(out.wa_me_url).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    expect(out.notification_id).not.toBeNull()
    const notes = await t.deps.db.systemDb
      .selectFrom('notifications')
      .select(['id', 'template_code', 'channel', 'recipient', 'ref_id'])
      .where('tenant_id', '=', shop.tenant.id)
      .where('ref_id', '=', out.intent.id)
      .execute()
    expect(notes).toEqual([
      {
        id: out.notification_id,
        template_code: 'payment_link',
        channel: 'whatsapp',
        recipient: '+919876543210',
        ref_id: out.intent.id,
      },
    ])
    // Replay: the same link and notification, nothing queued twice.
    const again = await link(
      shop,
      { customer_id: c.id, send_via: 'whatsapp' },
      { 'idempotency-key': key },
    )
    const replay = expectStatus<Data<PaymentLinkResult>>(again, 201).data
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(replay.intent.id).toBe(out.intent.id)
    expect(replay.notification_id).toBe(out.notification_id)
    const count = await t.deps.db.systemDb
      .selectFrom('notifications')
      .select('id')
      .where('ref_id', '=', out.intent.id)
      .execute()
    expect(count).toHaveLength(1)
  })

  it('refuses links without a due, without a phone to send to, or without permission', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    expectError(await link(shop, { customer_id: c.id }), 422, 'UNPROCESSABLE', 'no_due')
    expectError(
      await link(shop, { customer_id: c.id, amount_paise: 500, send_via: 'sms' }),
      422,
      'UNPROCESSABLE',
      'phone_required',
    )
    const accountant = await shop.asRole('accountant')
    expectError(
      await link(shop, { customer_id: c.id, amount_paise: 500 }, undefined, accountant),
      403,
      'FORBIDDEN',
    )
    const bare = await createTestTenant(t)
    const bc = await insertTestCustomer(t.deps, bare.tenant.id)
    expectError(
      await link(bare, { customer_id: bc.id, amount_paise: 500 }),
      422,
      'UNPROCESSABLE',
      'no_upi_account',
    )
  })

  it('serves the public pay page and records the receipt FIFO once confirmed', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id, {
      name: 'Kannan Raj',
      phone: '+919876543299',
    })
    const first = await insertInvoice(t, shop, {
      customerId: c.id,
      total: 1_000,
      date: '2026-08-01',
    })
    const second = await insertInvoice(t, shop, {
      customerId: c.id,
      total: 2_000,
      date: '2026-08-05',
    })
    const out = expectStatus<Data<PaymentLinkResult>>(
      await link(shop, { customer_id: c.id, amount_paise: 2_500 }),
      201,
    ).data
    const pageRes = await t.app.inject({
      method: 'GET',
      url: `/public/v1/pay/${out.intent.reference_code}`,
    })
    const page = expectStatus<Data<PublicPayPage>>(pageRes, 200).data
    expect(page).toMatchObject({
      reference_code: out.intent.reference_code,
      status: 'pending',
      purpose: 'customer_due',
      amount_paise: 2_500,
      payee: { name: 'Murugan Stores', vpa: 'murugan.stores@okaxis' },
      customer_first_name: 'Kannan',
      short_url: null,
    })
    expect(page.shop.name).toBeTruthy()
    expect(parseUpiUri(page.upi_uri!)).toMatchObject({
      reference: out.intent.reference_code,
      amount_paise: 2_500,
    })
    expect(pageRes.body).not.toContain(shop.tenant.id)
    expect(pageRes.body).not.toContain(c.id)
    expect(pageRes.body).not.toContain(out.intent.id)

    // The cashier confirms the UPI payment: receipt allocated FIFO.
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${out.intent.id}/confirm`),
        payload: { utr: '765432109876' },
      }),
      200,
    )
    const row = await intentRow(t, out.intent.id)
    expect(row.payment_id).not.toBeNull()
    expect(await invoiceState(t, first.id)).toMatchObject({ due_paise: 0, payment_status: 'paid' })
    expect(await invoiceState(t, second.id)).toMatchObject({
      due_paise: 500,
      payment_status: 'partial',
    })
    const paidPage = expectStatus<Data<PublicPayPage>>(
      await t.app.inject({ method: 'GET', url: `/public/v1/pay/${out.intent.reference_code}` }),
      200,
    ).data
    expect(paidPage).toMatchObject({ status: 'paid', upi_uri: null })
    expect(paidPage.paid_at).not.toBeNull()

    expectError(
      await t.app.inject({ method: 'GET', url: '/public/v1/pay/KD0000000000' }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await t.app.inject({ method: 'GET', url: '/public/v1/pay/bad' }),
      400,
      'VALIDATION_ERROR',
    )
    // POS QR intents are not public.
    const qr = expectStatus<Data<{ reference_code: string }>>(
      await shop.inject({
        method: 'POST',
        url: api('/payments/intents'),
        payload: { purpose: 'pos_sale', store_id: shop.store.id, amount_paise: 100 },
      }),
      201,
    ).data
    expectError(
      await t.app.inject({ method: 'GET', url: `/public/v1/pay/${qr.reference_code}` }),
      404,
      'NOT_FOUND',
    )
  })

  it('creates Razorpay hosted links when a dynamic provider is set up', async () => {
    const c = await insertTestCustomer(t.deps, rzpShop.tenant.id, {
      name: 'Senthil',
      phone: '+919811122233',
    })
    const before = rzp.requests.length
    const out = expectStatus<Data<PaymentLinkResult>>(
      await link(rzpShop, { customer_id: c.id, amount_paise: 12_000, note: 'October dues' }),
      201,
    ).data
    expect(out.link_kind).toBe('provider')
    expect(out.url).toMatch(/^https:\/\/rzp\.io\/i\/plink_/)
    const call = rzp.requests.slice(before).find((r) => r.url === '/v1/payment_links')!
    expect(call.body).toMatchObject({
      amount: 12_000,
      currency: 'INR',
      reference_id: out.intent.reference_code,
      description: 'October dues',
      customer: { name: 'Senthil', contact: '+919811122233' },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { intent_id: out.intent.id },
    })
    expect(Number(call.body.expire_by)).toBeGreaterThan(Math.floor(Date.now() / 1000) + 15 * 60)
    const page = expectStatus<Data<PublicPayPage>>(
      await t.app.inject({ method: 'GET', url: `/public/v1/pay/${out.intent.reference_code}` }),
      200,
    ).data
    expect(page).toMatchObject({ short_url: out.url, upi_uri: null, payee: { vpa: null } })
  })

  it('builds the static standee QR of the shop UPI ID', async () => {
    const qr = expectStatus<Data<UpiQrPayload>>(
      await shop.inject({ method: 'GET', url: api(`/payments/upi-qr?store_id=${shop.store.id}`) }),
      200,
    ).data
    expect(qr).toMatchObject({
      provider_account_id: upiId,
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Murugan Stores',
      amount_paise: null,
      store: { id: shop.store.id },
    })
    expect(qr.upi_uri).not.toContain('am=')
    expect(qr.upi_uri).not.toContain('tr=')
    const withAmount = expectStatus<Data<UpiQrPayload>>(
      await shop.inject({
        method: 'GET',
        url: api(`/payments/upi-qr?provider_account_id=${upiId}&amount_paise=5000&note=Tea`),
      }),
      200,
    ).data
    expect(parseUpiUri(withAmount.upi_uri)).toMatchObject({ amount_paise: 5_000, note: 'Tea' })
    expectError(
      await shop.inject({ method: 'GET', url: api('/payments/upi-qr') }),
      400,
      'VALIDATION_ERROR',
    )
    const rzpAccount = await t.deps.db.systemDb
      .selectFrom('payment_provider_accounts')
      .select('id')
      .where('tenant_id', '=', rzpShop.tenant.id)
      .executeTakeFirstOrThrow()
    expectError(
      await rzpShop.inject({
        method: 'GET',
        url: api(`/payments/upi-qr?provider_account_id=${rzpAccount.id}`),
      }),
      422,
      'UNPROCESSABLE',
      'not_static_upi',
    )
    // Another tenant's account is invisible.
    expectError(
      await rzpShop.inject({
        method: 'GET',
        url: api(`/payments/upi-qr?provider_account_id=${upiId}`),
      }),
      404,
      'NOT_FOUND',
    )
    const cashier = await shop.asRole('cashier')
    expectStatus(
      await shop.inject({
        method: 'GET',
        url: api(`/payments/upi-qr?store_id=${shop.store.id}`),
        as: cashier,
      }),
      200,
    )
  })
})
