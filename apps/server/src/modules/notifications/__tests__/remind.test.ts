/**
 * POST /customers/:id/remind: the due reminder with a UPI pay link (payment intent of kind 'link'
 * for the Kadai pay page /pay/<reference_code>) and the queued due_reminder notification;
 * wa_me sharing, locale and amount, validation, plan gating, permissions, store scoping,
 * idempotency and tenant isolation.
 */
import { addDays, newId, todayIn } from '@kadai/shared'
import type { CustomerRemindResult } from '@kadai/shared/api/notifications'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, type TestShopMember, createTestTenant } from '../../../test/tenants'
import { automaticChannel, channelUsable } from '../reminders'
import { processNotification } from '../send'
import {
  type FakeProvider,
  api,
  errorOf,
  expectStatus,
  fakeProvider,
  insertCustomer,
  insertInvoice,
  insertVpaAccount,
  notificationsOf,
  useProviders,
} from './fixtures'

type RemindResponse = { data: CustomerRemindResult }

describe('POST /customers/:id/remind', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let free: TestShop
  let wa: FakeProvider
  let sms: FakeProvider
  let readOnly: TestShopMember
  const today = todayIn('Asia/Kolkata')

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    free = await createTestTenant(t, { plan_code: 'free' })
    await insertVpaAccount(t, shop)
    readOnly = await shop.asRole('khata_viewer', { permissions: ['customers.read'] })
  })
  afterAll(() => t.close())
  beforeEach(() => {
    wa = fakeProvider('whatsapp_cloud', ['whatsapp'])
    sms = fakeProvider('msg91', ['sms'])
    useProviders([wa, sms])
  })

  const remind = (
    s: TestShop,
    customerId: string,
    payload: Record<string, unknown> = {},
    extra: { as?: TestShopMember | null; headers?: Record<string, string> } = {},
  ) =>
    s.inject({
      method: 'POST',
      url: api(`/customers/${customerId}/remind`),
      payload,
      ...extra,
    })

  async function customerWithDue(s: TestShop, opts: Parameters<typeof insertCustomer>[2] = {}) {
    const c = await insertCustomer(t, s, { balance_paise: 245_000, ...opts })
    await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: addDays(today, -15),
      total_paise: 300_000,
      due_paise: 200_000,
    })
    await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: addDays(today, -3),
      total_paise: 45_000,
      due_paise: 45_000,
    })
    return c
  }

  it('creates a pay-page link intent and queues a WhatsApp due reminder (Tamil)', async () => {
    const c = await customerWithDue(shop, { name: 'Lakshmi', name_ta: 'லட்சுமி' })
    const r = expectStatus<RemindResponse>(
      await remind(shop, c.id, { channel: 'whatsapp' }),
      200,
    ).data
    expect(r).toMatchObject({
      customer_id: c.id,
      due_paise: 245_000,
      amount_paise: 245_000,
      channel: 'whatsapp',
      wa_me_url: null,
      last_reminded_at: null,
    })
    const link = r.link!
    expect(link).toMatchObject({
      kind: 'pay_page',
      intent: {
        kind: 'link',
        purpose: 'customer_due',
        provider: 'upi_vpa',
        status: 'pending',
        amount_paise: 245_000,
        customer_id: c.id,
        store_id: shop.store.id,
        ref_type: 'customer',
        ref_id: c.id,
      },
    })
    expect(link.intent.reference_code).toMatch(/^[0-9A-Z]{12}$/)
    expect(link.url).toBe(`${t.config.publicBaseUrl}/pay/${link.intent.reference_code}`)
    expect(link.intent.short_url).toBe(link.url)
    expect(link.intent.upi_uri).toMatch(/^upi:\/\/pay\?pa=murugan\.stores@okaxis&/)
    expect(link.intent.upi_uri).toContain('am=2450.00')
    expect(link.intent.upi_uri).toContain(`tr=${link.intent.reference_code}`)

    const n = r.notification!
    expect(n).toMatchObject({
      channel: 'whatsapp',
      template_code: 'due_reminder',
      status: 'queued',
      recipient: c.phone,
      recipient_name: 'Lakshmi',
      locale: 'ta',
      ref_type: 'customer',
      ref_id: c.id,
      created_by: shop.owner.user.id,
    })
    expect(n.params).toMatchObject({
      customer_name: 'லட்சுமி',
      due: '₹2,450.00',
      days: 15,
      link: link.url,
    })
    expect(r.message).toContain('நினைவூட்டல்')
    expect(r.message).toContain('₹2,450.00')
    expect(r.message).toContain(link.url)

    const row = await t.deps.db.systemDb
      .selectFrom('payment_intents')
      .selectAll()
      .where('id', '=', link.intent.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      tenant_id: shop.tenant.id,
      kind: 'link',
      purpose: 'customer_due',
      status: 'pending',
      customer_id: c.id,
      created_by: shop.owner.user.id,
    })
    expect(row.expires_at!.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000)
    const audit = await t.deps.db.systemDb
      .selectFrom('audit_logs')
      .select(['action', 'changes'])
      .where('tenant_id', '=', shop.tenant.id)
      .where('entity_id', '=', c.id)
      .where('action', '=', 'customer.remind')
      .executeTakeFirstOrThrow()
    expect(audit.changes).toMatchObject({
      channel: 'whatsapp',
      notification_id: n.id,
      payment_intent_id: link.intent.id,
    })

    // The send job delivers it as the approved template with the link as a body parameter.
    await processNotification(t.deps, { tenant_id: shop.tenant.id, notification_id: n.id })
    expect(wa.sent[0]!.whatsapp).toMatchObject({ template_name: 'kadai_due_reminder' })
    expect(wa.sent[0]!.whatsapp!.body_params).toContain(link.url)

    // A second reminder reports the first; without a link it shows the shop's UPI ID.
    const again = expectStatus<RemindResponse>(
      await remind(shop, c.id, { channel: 'sms', include_payment_link: false }),
      200,
    ).data
    expect(again.last_reminded_at).toBe(n.created_at)
    expect(again.link).toBeNull()
    expect(again.notification).toMatchObject({ channel: 'sms' })
    expect(again.notification!.params.link).toBe('UPI: murugan.stores@okaxis')
  })

  it('English, a partial amount and a recipient override', async () => {
    const c = await customerWithDue(shop)
    const r = expectStatus<RemindResponse>(
      await remind(shop, c.id, {
        channel: 'sms',
        locale: 'en',
        amount_paise: 100_000,
        phone: '98765 11111',
      }),
      200,
    ).data
    expect(r).toMatchObject({ due_paise: 245_000, amount_paise: 100_000 })
    expect(r.link!.intent.amount_paise).toBe(100_000)
    expect(r.notification).toMatchObject({ locale: 'en', recipient: '+919876511111' })
    expect(r.notification!.params.due).toBe('₹1,000.00')
    expect(r.message).toMatch(/^.+: Dear .+, your due of ₹1,000\.00 is pending\. Pay: /)
  })

  it('wa_me returns the text and a wa.me link, queues nothing and works on the free plan', async () => {
    const c = await customerWithDue(free, { name: 'Murugan' })
    const r = expectStatus<RemindResponse>(await remind(free, c.id, { channel: 'wa_me' }), 200).data
    expect(r).toMatchObject({ channel: 'wa_me', notification: null, link: null })
    expect(r.wa_me_url).toBe(
      `https://wa.me/${c.phone!.slice(1)}?text=${encodeURIComponent(r.message)}`,
    )
    expect(r.message).toContain('₹2,450.00')
    expect(r.message).toContain('Murugan')
    expect(await notificationsOf(t, free)).toHaveLength(0)
    // WhatsApp / SMS by the provider need the plan feature.
    const plan = errorOf(await remind(free, c.id, { channel: 'whatsapp' }), 402)
    expect(plan).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      details: { feature: 'notifications' },
    })
    errorOf(await remind(free, c.id, { channel: 'sms' }), 402)
  })

  it('a due from the opening balance only is aged from the day the customer was added', async () => {
    const c = await insertCustomer(t, shop, { balance_paise: 50_000 })
    await t.deps.db.systemDb
      .updateTable('customers')
      .set({ created_at: new Date(Date.now() - 40 * 86_400_000) })
      .where('id', '=', c.id)
      .execute()
    const r = expectStatus<RemindResponse>(await remind(shop, c.id, { channel: 'wa_me' }), 200).data
    expect(r.message).toMatch(/40 நாட்களாக/)
  })

  it('validates the due, amount, phone, opt-in and the body', async () => {
    const none = await insertCustomer(t, shop, { balance_paise: 0 })
    expect(errorOf(await remind(shop, none.id), 422).details).toMatchObject({ reason: 'no_due' })
    const advance = await insertCustomer(t, shop, { balance_paise: -5_000 })
    expect(errorOf(await remind(shop, advance.id), 422).details).toMatchObject({
      reason: 'no_due',
    })
    const c = await customerWithDue(shop)
    expect(errorOf(await remind(shop, c.id, { amount_paise: 245_001 }), 422).details).toMatchObject(
      { reason: 'amount_exceeds_due' },
    )
    const noPhone = await insertCustomer(t, shop, { balance_paise: 1_000, phone: null })
    expect(errorOf(await remind(shop, noPhone.id), 422).details).toMatchObject({
      reason: 'no_phone',
    })
    const optedOut = await customerWithDue(shop, { whatsapp_opt_in: false })
    expect(
      errorOf(await remind(shop, optedOut.id, { channel: 'whatsapp' }), 422).details,
    ).toMatchObject({ reason: 'whatsapp_opt_out' })
    // SMS and manual sharing remain possible for an opted-out customer.
    expectStatus(await remind(shop, optedOut.id, { channel: 'sms' }), 200)
    expectStatus(await remind(shop, optedOut.id, { channel: 'wa_me' }), 200)

    for (const payload of [
      { channel: 'telegram' },
      { amount_paise: 0 },
      { amount_paise: 12.5 },
      { phone: '12345' },
      { store_id: 'not-a-uuid' },
      { locale: 'hi' },
    ]) {
      const e = errorOf(await remind(shop, c.id, payload), 400)
      expect(e.code, JSON.stringify(payload)).toBe('VALIDATION_ERROR')
    }
    errorOf(await remind(shop, 'not-a-uuid'), 400)
    errorOf(await remind(shop, newId()), 404)
    // The defaults apply to an empty body too.
    const empty = await shop.inject({ method: 'POST', url: api(`/customers/${c.id}/remind`) })
    expect(expectStatus<RemindResponse>(empty, 200).data.channel).toBe('whatsapp')
  })

  it('needs customers.write, keeps tenants apart and needs a session', async () => {
    const c = await customerWithDue(shop)
    const denied = errorOf(await remind(shop, c.id, {}, { as: readOnly }), 403)
    expect(denied.details).toMatchObject({ required: ['customers.write'] })
    const cashier = await shop.asRole('cashier')
    expectStatus(await remind(shop, c.id, { channel: 'wa_me' }, { as: cashier }), 200)
    errorOf(await remind(other, c.id), 404)
    errorOf(await remind(shop, c.id, {}, { as: null }), 401)
    expect(await notificationsOf(t, other)).toHaveLength(0)
  })

  it('creates the link only in a store the member may use', async () => {
    const s = await createTestTenant(t)
    await insertVpaAccount(t, s)
    const store2 = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({ id: store2, tenant_id: s.tenant.id, code: 'S2', name: 'Branch', state_code: '33' })
      .execute()
    const c = await insertCustomer(t, s, { balance_paise: 80_000 })
    await insertInvoice(t, s, {
      customer_id: c.id,
      invoice_date: addDays(today, -8),
      total_paise: 80_000,
      due_paise: 80_000,
      store_id: store2,
    })
    const scoped = await s.asRole('cashier', { store_ids: [s.store.id] })
    const e = errorOf(
      await remind(s, c.id, { channel: 'wa_me', store_id: store2 }, { as: scoped }),
      403,
    )
    expect(e.code).toBe('FORBIDDEN')
    // Without store_id the scoped member's own store is used (not the bill's store S2).
    const own = expectStatus<RemindResponse>(
      await remind(s, c.id, { channel: 'whatsapp' }, { as: scoped }),
      200,
    ).data
    expect(own.link!.intent.store_id).toBe(s.store.id)
    // The owner (all stores) gets the store of the latest bill.
    const owner = expectStatus<RemindResponse>(await remind(s, c.id, { channel: 'sms' }), 200).data
    expect(owner.link!.intent.store_id).toBe(store2)
    expect(owner.notification!.params.days).toBe(8)
  })

  it('replays a retry with the same Idempotency-Key (one link, one message)', async () => {
    const c = await customerWithDue(shop)
    const headers = { 'idempotency-key': `remind-${newId()}` }
    const a = expectStatus<RemindResponse>(await remind(shop, c.id, {}, { headers }), 200).data
    const replay = await remind(shop, c.id, {}, { headers })
    const b = expectStatus<RemindResponse>(replay, 200).data
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(b.notification!.id).toBe(a.notification!.id)
    expect(b.link!.intent.id).toBe(a.link!.intent.id)
    const intents = await t.deps.db.systemDb
      .selectFrom('payment_intents')
      .select('id')
      .where('tenant_id', '=', shop.tenant.id)
      .where('customer_id', '=', c.id)
      .execute()
    expect(intents).toHaveLength(1)
    errorOf(await remind(shop, c.id, { channel: 'sms' }, { headers }), 409)
  })

  it('channel availability: production needs a live provider, development uses the log', () => {
    const logOnly = useProviders([], { withLog: true })
    const dev = { isProduction: false }
    const prod = { isProduction: true }
    expect(channelUsable(logOnly, dev, 'whatsapp')).toBe(true)
    expect(channelUsable(logOnly, prod, 'whatsapp')).toBe(false)
    expect(automaticChannel(logOnly, dev, ['whatsapp', 'sms'])).toBe('whatsapp')
    expect(automaticChannel(logOnly, prod, ['whatsapp', 'sms'])).toBeNull()
    const smsOnly = useProviders([fakeProvider('msg91', ['sms'])])
    expect(automaticChannel(smsOnly, prod, ['whatsapp', 'sms'])).toBe('sms')
    expect(channelUsable(smsOnly, prod, 'sms')).toBe(true)
  })
})
