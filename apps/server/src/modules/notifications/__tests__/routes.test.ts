/**
 * HTTP endpoints of the module (app.inject on the module test database): the outbox list / get /
 * retry, ad-hoc template sends, the template catalogue with overrides — happy paths, validation,
 * permission denial, plan gating, idempotency, rate limiting and tenant isolation.
 */
import { newId } from '@kadai/shared'
import {
  type Notification,
  type NotificationListResponse,
  type NotificationTemplateCatalog,
  type NotificationTemplateEntry,
  notificationsRoutes,
} from '@kadai/shared/api/notifications'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enqueueNotification } from '../../../core/notify'
import { unimplementedRoutes } from '../../../core/http'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, type TestShopMember, createTestTenant } from '../../../test/tenants'
import { notificationImpls } from '../index'
import { processNotification } from '../send'
import { api, errorOf, expectStatus, insertCustomer } from './fixtures'

const invoiceParams = {
  shop_name: 'Sri Murugan Stores',
  customer_name: 'Lakshmi',
  number: 'S1-A/2627/00042',
  amount: '₹1,250.00',
  due: '₹450.00',
  link: 'https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
}

describe('notifications routes', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let free: TestShop
  let cashier: TestShopMember
  let sender: TestShopMember

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    free = await createTestTenant(t, { plan_code: 'free' })
    cashier = await shop.asRole('cashier')
    sender = await shop.asRole('messenger', { permissions: ['notifications.send'] })
  })
  afterAll(() => t.close())

  async function seed(s: TestShop, input: Partial<Parameters<typeof enqueueNotification>[2]> = {}) {
    return s.tx((tx) =>
      enqueueNotification(tx, s.ctx, {
        channel: 'whatsapp',
        template_code: 'invoice_share',
        to: '98765 43210',
        recipient_name: 'Lakshmi',
        params: invoiceParams,
        ...input,
      }),
    )
  }

  it('implements every catalogue route', () => {
    expect(unimplementedRoutes(notificationsRoutes, notificationImpls)).toEqual([])
  })

  describe('outbox', () => {
    let s: TestShop
    let ids: { wa: string; sms: string; mail: string; otp: string }

    beforeAll(async () => {
      s = await createTestTenant(t)
      const wa = await seed(s, { ref_type: 'sales_invoice', ref_id: newId() })
      const sms = await seed(s, { channel: 'sms', to: '+919000000001', recipient_name: 'Murugan' })
      const mail = await seed(s, { channel: 'email', to: 'kumar@example.in' })
      const otp = await seed(s, {
        channel: 'sms',
        template_code: 'otp',
        to: '+919000000002',
        params: { otp: '482913', minutes: 5 },
      })
      ids = { wa: wa.id, sms: sms.id, mail: mail.id, otp: otp.id }
      await processNotification(t.deps, { tenant_id: s.tenant.id, notification_id: sms.id })
      await processNotification(t.deps, { tenant_id: s.tenant.id, notification_id: otp.id })
      await seed(other) // another tenant's row must never show up
    })

    it('lists newest first with facet counts, filters and pagination', async () => {
      const all = expectStatus<NotificationListResponse>(
        await s.inject({ method: 'GET', url: api('/notifications') }),
        200,
      )
      expect(all.page).toEqual({ limit: 50, offset: 0, total: 4 })
      expect(all.data.map((n) => n.id)).toEqual([ids.otp, ids.mail, ids.sms, ids.wa])
      expect(all.summary.by_status).toEqual([
        { status: 'delivered', count: 2 },
        { status: 'queued', count: 2 },
      ])
      expect(all.summary.by_channel).toEqual([
        { channel: 'email', count: 1 },
        { channel: 'sms', count: 2 },
        { channel: 'whatsapp', count: 1 },
      ])
      const wa = all.data.find((n) => n.id === ids.wa)!
      expect(wa).toMatchObject({
        channel: 'whatsapp',
        recipient: '+919876543210',
        recipient_name: 'Lakshmi',
        status: 'queued',
        ref_type: 'sales_invoice',
        created_by: s.owner.user.id,
        created_by_name: s.owner.user.full_name,
        can_retry: false,
        params: invoiceParams,
      })
      expect(wa.ref_path).toMatch(/^\//)

      const sms = expectStatus<NotificationListResponse>(
        await s.inject({ method: 'GET', url: api('/notifications?channel=sms&status=delivered') }),
        200,
      )
      expect(sms.data.map((n) => n.id).sort()).toEqual([ids.sms, ids.otp].sort())
      // Facets ignore their own filter: by_channel counts every channel of delivered messages…
      expect(sms.summary.by_channel).toEqual([{ channel: 'sms', count: 2 }])
      const queued = expectStatus<NotificationListResponse>(
        await s.inject({ method: 'GET', url: api('/notifications?status=queued') }),
        200,
      )
      expect(queued.data.map((n) => n.id)).toEqual([ids.mail, ids.wa])
      // …and by_status every status (the tabs keep their counts while one is selected).
      expect(queued.summary.by_status).toEqual([
        { status: 'delivered', count: 2 },
        { status: 'queued', count: 2 },
      ])
      expect(queued.summary.by_channel).toEqual([
        { channel: 'email', count: 1 },
        { channel: 'whatsapp', count: 1 },
      ])

      const byDigits = expectStatus<NotificationListResponse>(
        await s.inject({ method: 'GET', url: api('/notifications?q=90000%2000001') }),
        200,
      )
      expect(byDigits.data.map((n) => n.id)).toEqual([ids.sms])
      const byName = expectStatus<NotificationListResponse>(
        await s.inject({ method: 'GET', url: api('/notifications?q=muru') }),
        200,
      )
      expect(byName.data.map((n) => n.id)).toEqual([ids.sms])
      const byTemplate = expectStatus<NotificationListResponse>(
        await s.inject({
          method: 'GET',
          url: api('/notifications?template_code=otp&template_code=invoice_share&sort=created_at'),
        }),
        200,
      )
      expect(byTemplate.data[0]!.id).toBe(ids.wa)
      const page2 = expectStatus<NotificationListResponse>(
        await s.inject({ method: 'GET', url: api('/notifications?limit=2&offset=2') }),
        200,
      )
      expect(page2.data.map((n) => n.id)).toEqual([ids.sms, ids.wa])
      expect(page2.page.total).toBe(4)
      const range = expectStatus<NotificationListResponse>(
        await s.inject({ method: 'GET', url: api(`/notifications?from=2020-01-01&to=2020-12-31`) }),
        200,
      )
      expect(range.page.total).toBe(0)
    })

    it('redacts OTP params and bodies', async () => {
      const n = expectStatus<{ data: Notification }>(
        await s.inject({ method: 'GET', url: api(`/notifications/${ids.otp}`) }),
        200,
      ).data
      expect(n.params).toEqual({})
      expect(n.rendered_body).toBeNull()
      expect(JSON.stringify(n)).not.toContain('482913')
      const sms = expectStatus<{ data: Notification }>(
        await s.inject({ method: 'GET', url: api(`/notifications/${ids.sms}`) }),
        200,
      ).data
      expect(sms.rendered_body).toContain('S1-A/2627/00042')
      expect(sms.status).toBe('delivered')
      expect(sms.provider).toBe('log')
    })

    it('validates list filters', async () => {
      const bad = errorOf(
        await s.inject({ method: 'GET', url: api('/notifications?status=lost') }),
        400,
      )
      expect(bad.code).toBe('VALIDATION_ERROR')
      const order = errorOf(
        await s.inject({ method: 'GET', url: api('/notifications?from=2026-10-10&to=2026-10-01') }),
        400,
      )
      expect(JSON.stringify(order.details)).toContain('date_order')
      errorOf(await s.inject({ method: 'GET', url: api('/notifications?sort=-recipient') }), 400)
    })

    it('retries failed / cancelled messages only (409 not_retryable), audited', async () => {
      const conflict = errorOf(
        await s.inject({ method: 'POST', url: api(`/notifications/${ids.sms}/retry`) }),
        409,
      )
      expect(conflict.details).toMatchObject({ reason: 'not_retryable', status: 'delivered' })
      await t.deps.db.systemDb
        .updateTable('notifications')
        .set({ status: 'failed', attempts: 5, error: 'invalid_recipient: bad number' })
        .where('id', '=', ids.wa)
        .execute()
      const listed = expectStatus<{ data: Notification }>(
        await s.inject({ method: 'GET', url: api(`/notifications/${ids.wa}`) }),
        200,
      ).data
      expect(listed.can_retry).toBe(true)
      const retried = expectStatus<{ data: Notification }>(
        await s.inject({ method: 'POST', url: api(`/notifications/${ids.wa}/retry`) }),
        200,
      ).data
      expect(retried).toMatchObject({
        status: 'queued',
        attempts: 0,
        error: null,
        can_retry: false,
      })
      const audits = await t.deps.db.systemDb
        .selectFrom('audit_logs')
        .select('action')
        .where('tenant_id', '=', s.tenant.id)
        .where('entity_id', '=', ids.wa)
        .execute()
      expect(audits.map((a) => a.action)).toContain('notification.retry')
      errorOf(await s.inject({ method: 'POST', url: api(`/notifications/${newId()}/retry`) }), 404)
    })

    it('keeps tenants apart and needs settings.manage', async () => {
      errorOf(await other.inject({ method: 'GET', url: api(`/notifications/${ids.wa}`) }), 404)
      errorOf(
        await other.inject({ method: 'POST', url: api(`/notifications/${ids.wa}/retry`) }),
        404,
      )
      const theirs = expectStatus<NotificationListResponse>(
        await other.inject({ method: 'GET', url: api('/notifications') }),
        200,
      )
      expect(theirs.data.some((n) => Object.values(ids).includes(n.id))).toBe(false)
      const denied = errorOf(
        await shop.inject({ method: 'GET', url: api('/notifications'), as: cashier }),
        403,
      )
      expect(denied.details).toMatchObject({ required: ['settings.manage'] })
      errorOf(await shop.inject({ method: 'GET', url: api('/notifications'), as: null }), 401)
    })
  })

  describe('POST /notifications/send', () => {
    const body = {
      channel: 'whatsapp',
      template_code: 'invoice_share',
      to: '98765 43210',
      recipient_name: 'Lakshmi',
      params: invoiceParams,
    }

    it('queues a template message in the business locale, audited', async () => {
      const n = expectStatus<{ data: Notification }>(
        await shop.inject({
          method: 'POST',
          url: api('/notifications/send'),
          payload: body,
          as: sender,
        }),
        201,
      ).data
      expect(n).toMatchObject({
        channel: 'whatsapp',
        template_code: 'invoice_share',
        recipient: '+919876543210',
        locale: 'ta',
        status: 'queued',
        created_by: sender.user.id,
      })
      const audit = await t.deps.db.systemDb
        .selectFrom('audit_logs')
        .select('action')
        .where('tenant_id', '=', shop.tenant.id)
        .where('entity_id', '=', n.id)
        .executeTakeFirst()
      expect(audit?.action).toBe('notification.send')
      const en = expectStatus<{ data: Notification }>(
        await shop.inject({
          method: 'POST',
          url: api('/notifications/send'),
          payload: { ...body, channel: 'email', to: 'Lakshmi@Example.IN', locale: 'en' },
        }),
        201,
      ).data
      expect(en).toMatchObject({ recipient: 'lakshmi@example.in', locale: 'en' })
    })

    it('replays an identical retry with the same Idempotency-Key', async () => {
      const key = `send-${newId()}`
      const a = await shop.inject({
        method: 'POST',
        url: api('/notifications/send'),
        payload: body,
        headers: { 'idempotency-key': key },
      })
      const b = await shop.inject({
        method: 'POST',
        url: api('/notifications/send'),
        payload: body,
        headers: { 'idempotency-key': key },
      })
      expect(expectStatus<{ data: Notification }>(b, 201).data.id).toBe(
        expectStatus<{ data: Notification }>(a, 201).data.id,
      )
      expect(b.headers['idempotent-replayed']).toBe('true')
      const mismatch = await shop.inject({
        method: 'POST',
        url: api('/notifications/send'),
        payload: { ...body, to: '98765 00000' },
        headers: { 'idempotency-key': key },
      })
      expect(errorOf(mismatch, 409).code).toBe('IDEMPOTENCY_MISMATCH')
    })

    it('rejects free text, non ad-hoc templates, wrong channels, bad recipients and params', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ ...body, to: '12345' }, 'recipient_phone'],
        [{ ...body, channel: 'email', to: 'not-an-email' }, 'recipient_email'],
        [
          { ...body, template_code: 'otp', channel: 'sms', params: { otp: '1234', minutes: 5 } },
          'template_not_adhoc',
        ],
        [{ ...body, template_code: 'daily_summary' }, 'template_not_adhoc'],
        [{ ...body, template_code: 'due_reminder', channel: 'email' }, 'template_channel'],
        [{ ...body, template_code: 'free_text', params: { text: 'hi' } }, 'template_code'],
      ]
      for (const [payload, needle] of cases) {
        const e = errorOf(
          await shop.inject({ method: 'POST', url: api('/notifications/send'), payload }),
          400,
        )
        expect(e.code).toBe('VALIDATION_ERROR')
        expect(JSON.stringify(e.details), needle).toContain(needle)
      }
      const params = errorOf(
        await shop.inject({
          method: 'POST',
          url: api('/notifications/send'),
          payload: { ...body, params: { shop_name: 'S' } },
        }),
        400,
      )
      expect(JSON.stringify(params.details)).toContain('params.link')
    })

    it('refuses WhatsApp to a customer who opted out (422)', async () => {
      const c = await insertCustomer(t, shop, { whatsapp_opt_in: false })
      const e = errorOf(
        await shop.inject({
          method: 'POST',
          url: api('/notifications/send'),
          payload: { ...body, to: c.phone },
        }),
        422,
      )
      expect(e.details).toMatchObject({ reason: 'whatsapp_opt_out' })
      expectStatus(
        await shop.inject({
          method: 'POST',
          url: api('/notifications/send'),
          payload: { ...body, channel: 'sms', to: c.phone },
        }),
        201,
      )
    })

    it('needs notifications.send and the plan feature', async () => {
      const denied = errorOf(
        await shop.inject({
          method: 'POST',
          url: api('/notifications/send'),
          payload: body,
          as: cashier,
        }),
        403,
      )
      expect(denied.details).toMatchObject({ required: ['notifications.send'] })
      const plan = errorOf(
        await free.inject({ method: 'POST', url: api('/notifications/send'), payload: body }),
        402,
      )
      expect(plan).toMatchObject({
        code: 'FEATURE_NOT_IN_PLAN',
        details: { feature: 'notifications' },
      })
    })

    it('is rate limited per business (30 per minute)', async () => {
      const s = await createTestTenant(t)
      const second = await s.asRole('manager')
      let limited = 0
      for (let i = 0; i < 32; i++) {
        const res = await s.inject({
          method: 'POST',
          url: api('/notifications/send'),
          payload: { ...body, to: `98765 ${String(10000 + i)}` },
          ...(i % 2 ? { as: second } : {}),
        })
        if (res.statusCode === 429) limited++
        else expect(res.statusCode, res.body).toBe(201)
      }
      expect(limited).toBe(2)
      const res = await s.inject({ method: 'POST', url: api('/notifications/send'), payload: body })
      expect(errorOf(res, 429).code).toBe('RATE_LIMITED')
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    })
  })

  describe('notification templates', () => {
    let s: TestShop
    beforeAll(async () => {
      s = await createTestTenant(t)
    })
    const url = (code: string, channel: string, locale: string) =>
      api(`/notification-templates/${code}/${channel}/${locale}`)

    it('lists defaults × channels × locales with providers, settings and the DLT note', async () => {
      const cat = expectStatus<{ data: NotificationTemplateCatalog }>(
        await s.inject({ method: 'GET', url: api('/notification-templates') }),
        200,
      ).data
      const due = cat.templates.filter((e) => e.code === 'due_reminder')
      expect(due.map((e) => `${e.channel}/${e.locale}`).sort()).toEqual([
        'sms/en',
        'sms/ta',
        'whatsapp/en',
        'whatsapp/ta',
      ])
      const waTa = due.find((e) => e.channel === 'whatsapp' && e.locale === 'ta')!
      expect(waTa).toMatchObject({
        is_override: false,
        is_active: true,
        default_provider_template_id: 'kadai_due_reminder',
        max_length: 1024,
        audience: 'customer',
      })
      expect(waTa.body).toContain('நினைவூட்டல்')
      expect(waTa.placeholders).toContainEqual({ key: 'due', required: true })
      expect(waTa.sample).toMatchObject({ customer_name: 'லட்சுமி' })
      expect(cat.templates.filter((e) => e.code === 'otp').map((e) => e.channel)).toEqual([
        'sms',
        'sms',
      ])
      expect(cat.providers.map((p) => p.channel)).toEqual(['whatsapp', 'sms', 'email'])
      expect(cat.providers.every((p) => p.provider === 'log' && !p.live)).toBe(true)
      expect(cat.settings).toMatchObject({ whatsapp_invoice: true, due_reminder_days: [7, 15, 30] })
      expect(cat.dlt_note.ta).toContain('DLT')
      const filtered = expectStatus<{ data: NotificationTemplateCatalog }>(
        await s.inject({
          method: 'GET',
          url: api('/notification-templates?code=payment_receipt&channel=email&locale=en'),
        }),
        200,
      ).data
      expect(filtered.templates).toHaveLength(1)
      expect(filtered.templates[0]).toMatchObject({ subject: 'Payment received — {{shop_name}}' })
    })

    it('saves an override (placeholder validation), merges it into the list and deletes it', async () => {
      const saved = expectStatus<{ data: NotificationTemplateEntry }>(
        await s.inject({
          method: 'PUT',
          url: url('due_reminder', 'sms', 'ta'),
          payload: {
            body: '{{shop_name}}: {{customer_name}}, நிலுவை {{due}}. செலுத்த {{link}}',
            provider_template_id: '1207168000000012345',
          },
        }),
        200,
      ).data
      expect(saved).toMatchObject({
        is_override: true,
        is_active: true,
        provider_template_id: '1207168000000012345',
        body: '{{shop_name}}: {{customer_name}}, நிலுவை {{due}}. செலுத்த {{link}}',
      })
      expect(saved.default_body).toContain('அன்புள்ள')
      expect(saved.override_updated_at).not.toBeNull()
      const listed = expectStatus<{ data: NotificationTemplateCatalog }>(
        await s.inject({ method: 'GET', url: api('/notification-templates?code=due_reminder') }),
        200,
      ).data.templates
      expect(listed.find((e) => e.channel === 'sms' && e.locale === 'ta')!.is_override).toBe(true)
      expect(listed.find((e) => e.channel === 'sms' && e.locale === 'en')!.is_override).toBe(false)

      // Update (upsert) and deactivate: the effective text is the default again.
      const off = expectStatus<{ data: NotificationTemplateEntry }>(
        await s.inject({
          method: 'PUT',
          url: url('due_reminder', 'sms', 'ta'),
          payload: {
            body: '{{shop_name}}: நிலுவை {{due}}',
            provider_template_id: 'flow-2',
            is_active: false,
          },
        }),
        200,
      ).data
      expect(off).toMatchObject({ is_override: true, is_active: false })
      expect(off.body).toBe(off.default_body)

      // Other tenants keep the defaults.
      const theirs = expectStatus<{ data: NotificationTemplateCatalog }>(
        await other.inject({
          method: 'GET',
          url: api('/notification-templates?code=due_reminder&channel=sms&locale=ta'),
        }),
        200,
      ).data.templates[0]!
      expect(theirs.is_override).toBe(false)

      const back = expectStatus<{ data: NotificationTemplateEntry }>(
        await s.inject({ method: 'DELETE', url: url('due_reminder', 'sms', 'ta') }),
        200,
      ).data
      expect(back).toMatchObject({ is_override: false, provider_template_id: null })
      // Idempotent.
      expectStatus(await s.inject({ method: 'DELETE', url: url('due_reminder', 'sms', 'ta') }), 200)
      const actions = await t.deps.db.systemDb
        .selectFrom('audit_logs')
        .select('action')
        .where('tenant_id', '=', s.tenant.id)
        .where('action', 'like', 'notification_template.%')
        .execute()
      expect(actions.map((a) => a.action).sort()).toEqual([
        'notification_template.delete',
        'notification_template.upsert',
        'notification_template.upsert',
      ])
    })

    it('validates overrides: placeholders, DLT id, WhatsApp template, subject, channel', async () => {
      const unknown = errorOf(
        await s.inject({
          method: 'PUT',
          url: url('due_reminder', 'whatsapp', 'en'),
          payload: {
            body: 'Hi {{customer_name}}, pay {{due}} at {{upi_id}}',
            provider_template_id: 'kadai_due_v2',
          },
        }),
        400,
      )
      expect(unknown.details).toMatchObject({
        issues: [{ path: 'body', message: 'unknown_placeholder', code: 'unknown_placeholder' }],
        unknown_placeholders: ['upi_id'],
      })
      const missing = errorOf(
        await s.inject({
          method: 'PUT',
          url: url('due_reminder', 'sms', 'en'),
          payload: { body: 'Hello {{customer_name}}' },
        }),
        400,
      )
      expect(missing.details).toMatchObject({ missing_placeholders: ['due'] })
      const codes = (missing.details as { issues: Array<{ code: string }> }).issues.map(
        (i) => i.code,
      )
      expect(codes).toEqual(['missing_required_placeholder', 'dlt_template_id_required'])
      const wa = errorOf(
        await s.inject({
          method: 'PUT',
          url: url('due_reminder', 'whatsapp', 'en'),
          payload: { body: 'Due {{due}}' },
        }),
        400,
      )
      expect(JSON.stringify(wa.details)).toContain('whatsapp_template_required')
      const badName = errorOf(
        await s.inject({
          method: 'PUT',
          url: url('due_reminder', 'whatsapp', 'en'),
          payload: { body: 'Due {{due}}', provider_template_id: 'Due Reminder!' },
        }),
        400,
      )
      expect(JSON.stringify(badName.details)).toContain('provider_template_id_invalid')
      const subject = errorOf(
        await s.inject({
          method: 'PUT',
          url: url('payment_receipt', 'email', 'ta'),
          payload: { body: 'பெற்றோம் {{amount}}' },
        }),
        400,
      )
      expect(JSON.stringify(subject.details)).toContain('subject_required')
      const syntax = errorOf(
        await s.inject({
          method: 'PUT',
          url: url('payment_receipt', 'email', 'en'),
          payload: { subject: 'Hi', body: 'Got {{amount}} {{#balance}}due {{balance}}' },
        }),
        400,
      )
      expect(JSON.stringify(syntax.details)).toContain('template_syntax')
      const channel = errorOf(
        await s.inject({
          method: 'PUT',
          url: url('otp', 'whatsapp', 'en'),
          payload: { body: '{{otp}}', provider_template_id: 'x' },
        }),
        400,
      )
      expect(JSON.stringify(channel.details)).toContain('template_channel')
      errorOf(
        await s.inject({ method: 'PUT', url: url('nope', 'sms', 'en'), payload: { body: 'x' } }),
        400,
      )
      // A valid e-mail override with a section.
      expectStatus(
        await s.inject({
          method: 'PUT',
          url: url('payment_receipt', 'email', 'en'),
          payload: {
            subject: '{{shop_name}} receipt',
            body: 'Got {{amount}}{{#balance}}, due {{balance}}{{/balance}}.',
          },
        }),
        200,
      )
    })

    it('needs settings.manage (and the plan feature to save)', async () => {
      errorOf(
        await shop.inject({ method: 'GET', url: api('/notification-templates'), as: cashier }),
        403,
      )
      errorOf(
        await shop.inject({
          method: 'PUT',
          url: url('welcome', 'sms', 'ta'),
          payload: { body: '{{shop_name}} வரவேற்கிறது', provider_template_id: 'f1' },
          as: cashier,
        }),
        403,
      )
      expectStatus(await free.inject({ method: 'GET', url: api('/notification-templates') }), 200)
      const plan = errorOf(
        await free.inject({
          method: 'PUT',
          url: url('welcome', 'sms', 'ta'),
          payload: { body: '{{shop_name}} வரவேற்கிறது', provider_template_id: 'f1' },
        }),
        402,
      )
      expect(plan.code).toBe('FEATURE_NOT_IN_PLAN')
      expectStatus(await free.inject({ method: 'DELETE', url: url('welcome', 'sms', 'ta') }), 200)
    })
  })
})
