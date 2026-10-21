/**
 * The send job (processNotification) and the sweep against the module test database: rendering
 * ta / en with tenant overrides, retry with exponential backoff and the attempt limit, permanent
 * failures, WhatsApp opt-out, plan / settings gating, production without a live provider, usage
 * counters, stuck rows and tenant isolation of the claim.
 */
import { newId, periodOf, todayIn } from '@kadai/shared'
import {
  NOTIFICATION_JOBS,
  NOTIFICATION_MAX_ATTEMPTS,
  type NotificationProviderRegistry,
  notificationRetryDelaySeconds,
} from '@kadai/shared/api/notifications'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { systemContext } from '../../../core/context'
import { enqueueNotification, getNotificationProviders } from '../../../core/notify'
import { withTenant } from '../../../db/tenant'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { jobs } from '../jobs'
import { processNotification, sweepNotifications } from '../send'
import {
  type FakeProvider,
  fakeProvider,
  insertCustomer,
  insertInvoice,
  patchSettings,
  permanentError,
  retryableError,
  useProviders,
} from './fixtures'

const invoiceParams = {
  shop_name: 'Sri Murugan Stores',
  customer_name: 'Lakshmi',
  number: 'S1-A/2627/00042',
  amount: '₹1,250.00',
  due: null,
  link: 'https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
}

describe('notifications.send', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let free: TestShop
  let sms: FakeProvider
  let wa: FakeProvider
  let mail: FakeProvider
  let envRegistry: NotificationProviderRegistry

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    free = await createTestTenant(t, { plan_code: 'free' })
    envRegistry = getNotificationProviders()
  })
  afterAll(async () => {
    useProviders([...envRegistry.list()], { withLog: false })
    await t.close()
  })
  beforeEach(() => {
    sms = fakeProvider('msg91', ['sms'])
    wa = fakeProvider('whatsapp_cloud', ['whatsapp'])
    mail = fakeProvider('email_webhook', ['email'])
    useProviders([sms, wa, mail])
  })

  async function enqueue(
    s: TestShop,
    input: Partial<Parameters<typeof enqueueNotification>[2]> = {},
  ): Promise<string> {
    const q = await s.tx((tx) =>
      enqueueNotification(tx, s.ctx, {
        channel: 'whatsapp',
        template_code: 'invoice_share',
        to: '98765 43210',
        params: invoiceParams,
        ...input,
      }),
    )
    return q.id
  }
  const send = (s: TestShop, id: string) =>
    processNotification(t.deps, { tenant_id: s.tenant.id, notification_id: id })
  const row = (id: string) =>
    t.deps.db.systemDb
      .selectFrom('notifications')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  it('renders the Tamil default WhatsApp template and stores the outcome and usage', async () => {
    const before = await usage(shop, 'whatsapp')
    const id = await enqueue(shop, { locale: 'ta' })
    const out = await send(shop, id)
    expect(out).toMatchObject({ kind: 'sent', status: 'sent', provider: 'whatsapp_cloud' })
    const m = wa.sent[0]!
    expect(m.whatsapp).toMatchObject({ template_name: 'kadai_invoice_share', language: 'ta' })
    expect(m.whatsapp!.body_params).toEqual([
      'Lakshmi',
      'Sri Murugan Stores',
      'S1-A/2627/00042',
      '₹1,250.00',
      'https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
    ])
    expect(m.body).toBe(
      'வணக்கம் Lakshmi, Sri Murugan Stores கடையில் வாங்கியதற்கு நன்றி! உங்கள் பில் S1-A/2627/00042, தொகை ₹1,250.00: https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
    )
    expect(m.idempotency_key).toBe(`${id}:1`)
    const r = await row(id)
    expect(r).toMatchObject({
      status: 'sent',
      provider: 'whatsapp_cloud',
      attempts: 1,
      error: null,
      rendered_body: m.body,
    })
    expect(r.provider_message_id).toMatch(/^fake-/)
    expect(r.sent_at).toBeInstanceOf(Date)
    expect(await usage(shop, 'whatsapp')).toBe(before + 1)
    // A second job for the same notification finds nothing to claim.
    expect(await send(shop, id)).toEqual({ kind: 'skipped' })
    expect(wa.sent).toHaveLength(1)
  })

  it('renders English and applies an active tenant override (SMS with its DLT id)', async () => {
    await t.deps.db.systemDb
      .insertInto('notification_templates')
      .values({
        tenant_id: shop.tenant.id,
        code: 'invoice_share',
        channel: 'sms',
        locale: 'en',
        body: '{{shop_name}}: bill {{number}} = {{amount}}. {{link}} - thank you',
        provider_template_id: 'dlt-override-77',
      })
      .execute()
    const id = await enqueue(shop, { channel: 'sms', locale: 'en' })
    await send(shop, id)
    expect(sms.sent[0]).toMatchObject({
      channel: 'sms',
      locale: 'en',
      provider_template_id: 'dlt-override-77',
      body: 'Sri Murugan Stores: bill S1-A/2627/00042 = ₹1,250.00. https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v - thank you',
      params: { shop_name: 'Sri Murugan Stores', due: '', number: 'S1-A/2627/00042' },
    })
    // Inactive override → the default English text again.
    await t.deps.db.systemDb
      .updateTable('notification_templates')
      .set({ is_active: false })
      .where('tenant_id', '=', shop.tenant.id)
      .where('code', '=', 'invoice_share')
      .execute()
    const id2 = await enqueue(shop, { channel: 'sms', locale: 'en' })
    await send(shop, id2)
    expect(sms.sent[1]!.body).toBe(
      'Sri Murugan Stores: Thank you! Bill S1-A/2627/00042 for ₹1,250.00. View: https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
    )
    expect(sms.sent[1]!.provider_template_id).toBeNull()
    // Another tenant never sees the override.
    const id3 = await enqueue(other, { channel: 'sms', locale: 'en' })
    await send(other, id3)
    expect(sms.sent[2]!.body).toBe(sms.sent[1]!.body)
  })

  it('retries a retryable failure with exponential backoff and kicks a delayed job', async () => {
    wa.script.push(retryableError('whatsapp_cloud'))
    const id = await enqueue(shop)
    const started = Date.now()
    const out = await send(shop, id)
    expect(out.kind).toBe('retry')
    const r = await row(id)
    expect(r.status).toBe('queued')
    expect(r.attempts).toBe(1)
    expect(r.error).toMatch(/^provider_error: /)
    const delay = (r.scheduled_at.getTime() - started) / 1000
    expect(delay).toBeGreaterThanOrEqual(notificationRetryDelaySeconds(1) - 1)
    expect(delay).toBeLessThan(notificationRetryDelaySeconds(1) + 5)
    const kicked = await sql<{ start_after: Date }>`
      select start_after from pgboss.job
       where name = ${NOTIFICATION_JOBS.send} and data->>'notification_id' = ${id}
       order by created_on desc limit 1`.execute(t.deps.db.systemDb)
    expect(kicked.rows[0]!.start_after.getTime()).toBeGreaterThan(Date.now() + 20_000)
    // Not due yet: a job running now does nothing.
    expect(await send(shop, id)).toEqual({ kind: 'skipped' })
  })

  it('honours a longer Retry-After and fails for good after NOTIFICATION_MAX_ATTEMPTS', async () => {
    const id = await enqueue(shop)
    for (let attempt = 1; attempt <= NOTIFICATION_MAX_ATTEMPTS; attempt++) {
      wa.script.push(retryableError('whatsapp_cloud', attempt === 1 ? 900 : null))
      await t.deps.db.systemDb
        .updateTable('notifications')
        .set({ scheduled_at: new Date(Date.now() - 1000) })
        .where('id', '=', id)
        .execute()
      const before = Date.now()
      const out = await send(shop, id)
      const r = await row(id)
      expect(r.attempts).toBe(attempt)
      if (attempt === 1) {
        expect(out.kind).toBe('retry')
        expect((r.scheduled_at.getTime() - before) / 1000).toBeGreaterThanOrEqual(899)
      } else if (attempt < NOTIFICATION_MAX_ATTEMPTS) {
        expect(out.kind).toBe('retry')
        const expected = notificationRetryDelaySeconds(attempt)
        expect((r.scheduled_at.getTime() - before) / 1000).toBeGreaterThanOrEqual(expected - 1)
      } else {
        expect(out.kind).toBe('failed')
        expect(r.status).toBe('failed')
      }
    }
    expect(wa.sent).toHaveLength(NOTIFICATION_MAX_ATTEMPTS)
    expect(wa.sent.map((m) => m.idempotency_key)).toEqual(
      Array.from({ length: NOTIFICATION_MAX_ATTEMPTS }, (_, i) => `${id}:${i + 1}`),
    )
  })

  it('fails immediately on a permanent provider error (no retry, no usage)', async () => {
    const before = await usage(shop, 'sms')
    sms.script.push(permanentError())
    const id = await enqueue(shop, { channel: 'sms' })
    const out = await send(shop, id)
    expect(out.kind).toBe('failed')
    const r = await row(id)
    expect(r).toMatchObject({ status: 'failed', attempts: 1 })
    expect(r.error).toMatch(/^invalid_recipient: /)
    expect(await usage(shop, 'sms')).toBe(before)
  })

  it("respects the customer's WhatsApp opt-out (by phone, ref customer or the invoice's customer)", async () => {
    const c = await insertCustomer(t, shop, { whatsapp_opt_in: false })
    const byPhone = await enqueue(shop, { to: c.phone! })
    expect(await send(shop, byPhone)).toEqual({ kind: 'cancelled', reason: 'whatsapp_opt_out' })
    expect((await row(byPhone)).error).toBe('whatsapp_opt_out')

    const inv = await insertInvoice(t, shop, {
      customer_id: c.id,
      invoice_date: todayIn(),
      total_paise: 10_000,
    })
    const byInvoice = await enqueue(shop, { ref_type: 'sales_invoice', ref_id: inv.id })
    expect(await send(shop, byInvoice)).toMatchObject({ kind: 'cancelled' })

    // SMS is not subject to the WhatsApp opt-in; neither are owner messages.
    const smsId = await enqueue(shop, { channel: 'sms', to: c.phone! })
    expect((await send(shop, smsId)).kind).toBe('sent')
    expect(wa.sent).toHaveLength(0)
    const optedIn = await insertCustomer(t, shop, { whatsapp_opt_in: true })
    const ok = await enqueue(shop, { to: optedIn.phone!, ref_type: 'customer', ref_id: optedIn.id })
    expect((await send(shop, ok)).kind).toBe('sent')
  })

  it('cancels SMS / WhatsApp on a plan without notifications; e-mail still goes', async () => {
    const id = await enqueue(free)
    expect(await send(free, id)).toEqual({ kind: 'cancelled', reason: 'feature_not_in_plan' })
    expect((await row(id)).error).toMatch(/^feature_not_in_plan/)
    const mailId = await enqueue(free, { channel: 'email', to: 'Lakshmi@Example.in' })
    expect((await send(free, mailId)).kind).toBe('sent')
    expect(mail.sent[0]).toMatchObject({ to: 'lakshmi@example.in', subject: expect.any(String) })
  })

  it('cancels owner digests switched off in settings.notifications', async () => {
    const s = await createTestTenant(t)
    await patchSettings(t, s, { notifications: { daily_summary_to_owner: false } })
    const id = await enqueue(s, {
      template_code: 'daily_summary',
      params: {
        shop_name: 'S',
        date: '20-10-2026',
        net_sales: '₹1.00',
        bills: 1,
        cash: '₹1.00',
        upi: '₹0.00',
        card: '₹0.00',
        credit: '₹0.00',
        dues_collected: '₹0.00',
        top_item: '-',
        low_stock_count: 0,
        link: null,
      },
    })
    expect(await send(s, id)).toEqual({ kind: 'cancelled', reason: 'disabled_in_settings' })
  })

  it('cancels the queued messages of a suspended business (nothing reaches the provider)', async () => {
    const s = await createTestTenant(t)
    const id = await enqueue(s)
    const mailId = await enqueue(s, { channel: 'email', to: 'owner@example.in' })
    await t.deps.db.systemDb
      .updateTable('tenants')
      .set({ status: 'suspended' })
      .where('id', '=', s.tenant.id)
      .execute()
    expect(await send(s, id)).toEqual({ kind: 'cancelled', reason: 'tenant_inactive' })
    expect(await send(s, mailId)).toEqual({ kind: 'cancelled', reason: 'tenant_inactive' })
    expect(await row(id)).toMatchObject({
      status: 'cancelled',
      error: 'tenant_inactive: tenant suspended',
    })
    expect(wa.sent).toHaveLength(0)
    expect(mail.sent).toHaveLength(0)
  })

  it('in production, cancels a channel without a live provider (log only)', async () => {
    useProviders([], { withLog: true })
    const id = await enqueue(shop)
    const prodDeps = { ...t.deps, config: { ...t.deps.config, isProduction: true } }
    const out = await processNotification(prodDeps, {
      tenant_id: shop.tenant.id,
      notification_id: id,
    })
    expect(out).toEqual({ kind: 'cancelled', reason: 'channel_not_configured' })
    // Outside production the log provider "delivers" it.
    const id2 = await enqueue(shop)
    expect(await send(shop, id2)).toMatchObject({
      kind: 'sent',
      status: 'delivered',
      provider: 'log',
    })
  })

  it('redacts the rendered body of sensitive templates (OTP)', async () => {
    const id = await enqueue(shop, {
      channel: 'sms',
      template_code: 'otp',
      params: { otp: '482913', minutes: 5 },
    })
    await send(shop, id)
    expect(sms.sent[0]!.body).toContain('482913')
    expect((await row(id)).rendered_body).toBeNull()
  })

  it('never claims another tenant’s notification', async () => {
    const id = await enqueue(other)
    expect(await send(shop, id)).toEqual({ kind: 'skipped' })
    expect((await row(id)).status).toBe('queued')
  })

  it('sweeps stuck sending rows back to queued (or failed when attempts are used up) and kicks jobs', async () => {
    const s = await createTestTenant(t)
    const stuck = await enqueue(s)
    const exhausted = await enqueue(s)
    const due = await enqueue(s)
    // updated_at is maintained by a trigger, so the sweep runs "10 minutes later" instead.
    await t.deps.db.systemDb
      .updateTable('notifications')
      .set({ status: 'sending', attempts: 2 })
      .where('id', '=', stuck)
      .execute()
    await t.deps.db.systemDb
      .updateTable('notifications')
      .set({ status: 'sending', attempts: NOTIFICATION_MAX_ATTEMPTS })
      .where('id', '=', exhausted)
      .execute()
    // Right now nothing is stuck and the queued row still has its own job pending.
    expect(await sweepNotifications(t.deps, { tenantIds: [s.tenant.id] })).toEqual({
      requeued_stuck: 0,
      failed_stuck: 0,
      kicked: 0,
    })
    const later = new Date(Date.now() + 10 * 60_000)
    const res = await sweepNotifications(t.deps, { tenantIds: [s.tenant.id], now: later })
    expect(res).toEqual({ requeued_stuck: 1, failed_stuck: 1, kicked: 2 })
    expect(await row(stuck)).toMatchObject({ status: 'queued', attempts: 2 })
    expect(await row(exhausted)).toMatchObject({ status: 'failed' })
    expect((await row(exhausted)).error).toMatch(/^stuck/)
    const kicked = await sql<{ id: string }>`
      select data->>'notification_id' as id from pgboss.job
       where name = ${NOTIFICATION_JOBS.send} and singleton_key in (${stuck}, ${due})
         and singleton_on is not null`.execute(t.deps.db.systemDb)
    expect(new Set(kicked.rows.map((r) => r.id))).toEqual(new Set([stuck, due]))
    // The re-queued row is then delivered by the send job.
    expect((await send(s, stuck)).kind).toBe('sent')
    expect(await row(stuck)).toMatchObject({ status: 'sent', attempts: 3 })
  })

  it('registers its jobs and the send handler validates its payload', async () => {
    const names = jobs.map((j) => j.name)
    expect(names).toEqual([
      'notifications.send',
      'notifications.sweep',
      'notifications.due-reminders',
      'notifications.daily-summary',
    ])
    expect(jobs.find((j) => j.name === 'notifications.sweep')!.cron).toBe('* * * * *')
    expect(jobs.find((j) => j.name === 'notifications.due-reminders')).toMatchObject({
      cron: '0 10 * * *',
      tz: 'Asia/Kolkata',
    })
    expect(jobs.find((j) => j.name === 'notifications.daily-summary')).toMatchObject({
      cron: '30 21 * * *',
      tz: 'Asia/Kolkata',
    })
    const handler = jobs.find((j) => j.name === 'notifications.send')!.handler
    await expect(
      handler(
        { id: 'j', name: 'notifications.send', data: { tenant_id: 'x' }, retryCount: 0 },
        t.deps,
      ),
    ).rejects.toThrow()
    const id = await enqueue(shop)
    await handler(
      {
        id: 'j2',
        name: 'notifications.send',
        data: { tenant_id: shop.tenant.id, notification_id: id },
        retryCount: 0,
      },
      t.deps,
    )
    expect((await row(id)).status).toBe('sent')
  })

  async function usage(s: TestShop, metric: string): Promise<number> {
    const period = periodOf(todayIn('Asia/Kolkata'))
    const r = await withTenant(t.deps.db.appDb, systemContext(s.tenant.id), (tx) =>
      tx
        .selectFrom('usage_counters')
        .select('value')
        .where('tenant_id', '=', s.tenant.id)
        .where('metric', '=', metric)
        .where('period', '=', period)
        .executeTakeFirst(),
    )
    return Number(r?.value ?? 0)
  }
  void newId
})
