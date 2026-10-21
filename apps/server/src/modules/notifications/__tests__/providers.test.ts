/**
 * Provider adapters against fake HTTP servers: request formats (MSG91 Flow, WhatsApp Cloud
 * template, e-mail webhook with HMAC signature), success parsing and the retryable / permanent
 * classification of failures (HTTP status, provider error codes, timeouts, network errors).
 */
import { createHmac } from 'node:crypto'
import {
  NotificationProviderError,
  type OutboundMessage,
  buildOutboundMessage,
  createNotificationProviderRegistry,
  sendWithProvider,
} from '@kadai/shared/api/notifications'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getTestConfig } from '../../../test/helpers'
import { buildNotificationProviders, providerStatuses } from '../providers'
import { createEmailWebhookProvider, emailWebhookSignature } from '../providers/email-webhook'
import { parseRetryAfter } from '../providers/http'
import { createLogProvider } from '../providers/log'
import { createMsg91Provider } from '../providers/msg91'
import { classifyWhatsAppError, createWhatsAppCloudProvider } from '../providers/whatsapp-cloud'
import { type FakeHttpServer, startFakeServer } from './fixtures'

const reminderParams = {
  shop_name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
  customer_name: 'லட்சுமி',
  due: '₹2,450.00',
  days: 15,
  link: 'https://kadai.app/pay/KD7Q2M9X4B1Z',
  shop_phone: '98765 43210',
}

function message(
  channel: 'sms' | 'whatsapp' | 'email',
  over: Partial<Parameters<typeof buildOutboundMessage>[0]> = {},
): OutboundMessage {
  const m = buildOutboundMessage({
    notification_id: '019a0000-0000-7000-8000-000000000001',
    tenant_id: '019a0000-0000-7000-8000-000000000002',
    code: channel === 'email' ? 'invoice_share' : 'due_reminder',
    channel,
    locale: 'ta',
    to: '+919876543210',
    recipient_name: 'Lakshmi',
    params:
      channel === 'email'
        ? {
            shop_name: 'Sri Murugan Stores',
            customer_name: 'Lakshmi',
            number: 'S1-A/2627/00042',
            amount: '₹1,250.00',
            due: null,
            link: 'https://kadai.app/i/abc',
          }
        : reminderParams,
    attempt: 2,
    ...over,
  })
  if (!m) throw new Error('no message')
  return m
}

let server: FakeHttpServer
beforeAll(async () => {
  server = await startFakeServer()
})
afterAll(() => server.close())
beforeEach(() => {
  server.requests.length = 0
  server.respond.length = 0
})

describe('msg91 provider (Flow API)', () => {
  const provider = () =>
    createMsg91Provider({
      authKey: 'auth-key-1',
      senderId: 'KADAIS',
      baseUrl: server.url,
      templateIds: { due_reminder: 'flow-due-1' },
      timeoutMs: 2000,
    })

  it('posts the DLT flow with the auth key, template id and named variables', async () => {
    server.respond.push({ status: 200, body: { type: 'success', message: '3561707a6c4a373833383334' } })
    const out = await sendWithProvider(provider(), message('sms'))
    expect(out).toMatchObject({
      ok: true,
      provider: 'msg91',
      result: { provider_message_id: '3561707a6c4a373833383334', status: 'sent' },
    })
    const req = server.requests[0]!
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/api/v5/flow')
    expect(req.headers.authkey).toBe('auth-key-1')
    expect(req.json).toEqual({
      template_id: 'flow-due-1',
      short_url: '0',
      sender: 'KADAIS',
      recipients: [
        {
          mobiles: '919876543210',
          shop_name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
          customer_name: 'லட்சுமி',
          due: '₹2,450.00',
          days: '15',
          link: 'https://kadai.app/pay/KD7Q2M9X4B1Z',
          shop_phone: '98765 43210',
        },
      ],
    })
  })

  it('uses the override DLT id (provider_template_id) before the env template id', async () => {
    server.respond.push({ status: 200, body: { type: 'success', message: 'req-2' } })
    await sendWithProvider(provider(), { ...message('sms'), provider_template_id: 'flow-override' })
    expect((server.requests[0]!.json as { template_id: string }).template_id).toBe('flow-override')
  })

  it('fails permanently without a DLT template id or auth key (no HTTP call)', async () => {
    const out = await sendWithProvider(provider(), message('sms', { code: 'welcome', params: {
      shop_name: 'S', customer_name: 'C', link: null,
    } }))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatchObject({ kind: 'permanent', code: 'not_configured' })
    const noKey = createMsg91Provider({
      authKey: null,
      senderId: null,
      baseUrl: server.url,
      templateIds: {},
      timeoutMs: 1000,
    })
    expect(noKey.configured).toBe(false)
    const out2 = await sendWithProvider(noKey, message('sms'))
    expect(out2.ok).toBe(false)
    if (!out2.ok) expect(out2.error.code).toBe('not_configured')
    expect(server.requests).toHaveLength(0)
  })

  it('classifies failures: 200 type=error permanent, 5xx / 429 retryable with Retry-After', async () => {
    server.respond.push({ status: 200, body: { type: 'error', message: 'Mobile number not valid' } })
    const a = await sendWithProvider(provider(), message('sms'))
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toMatchObject({ kind: 'permanent', code: 'invalid_recipient' })

    server.respond.push({ status: 503, body: { type: 'error', message: 'Service unavailable' } })
    const b = await sendWithProvider(provider(), message('sms'))
    if (!b.ok) expect(b.error).toMatchObject({ kind: 'retryable', http_status: 503 })
    else expect.unreachable()

    server.respond.push({ status: 429, body: {}, headers: { 'retry-after': '120' } })
    const c = await sendWithProvider(provider(), message('sms'))
    if (!c.ok)
      expect(c.error).toMatchObject({ kind: 'retryable', code: 'rate_limited', retry_after_seconds: 120 })
    else expect.unreachable()

    server.respond.push({ status: 401, body: { type: 'error', message: 'Authentication failure' } })
    const d = await sendWithProvider(provider(), message('sms'))
    if (!d.ok) expect(d.error).toMatchObject({ kind: 'permanent', code: 'not_configured' })
    else expect.unreachable()
  })

  it('times out (retryable) when the provider does not answer in time', async () => {
    server.respond.push({ status: 200, body: { type: 'success', message: 'late' }, delayMs: 800 })
    const slow = createMsg91Provider({
      authKey: 'k',
      senderId: null,
      baseUrl: server.url,
      templateIds: { due_reminder: 'f' },
      timeoutMs: 150,
    })
    const out = await sendWithProvider(slow, message('sms'))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatchObject({ kind: 'retryable', code: 'timeout' })
  })

  it('network errors are retryable', async () => {
    const dead = createMsg91Provider({
      authKey: 'k',
      senderId: null,
      baseUrl: 'http://127.0.0.1:1',
      templateIds: { due_reminder: 'f' },
      timeoutMs: 1000,
    })
    const out = await sendWithProvider(dead, message('sms'))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatchObject({ kind: 'retryable', code: 'network' })
  })
})

describe('whatsapp_cloud provider (Meta Graph API)', () => {
  const provider = () =>
    createWhatsAppCloudProvider({
      phoneNumberId: '1098765432',
      accessToken: 'EAAG-token',
      apiVersion: 'v20.0',
      baseUrl: server.url,
      timeoutMs: 2000,
    })

  it('sends an approved template with Tamil language and body parameters in placeholder order', async () => {
    server.respond.push({
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '919876543210', wa_id: '919876543210' }],
        messages: [{ id: 'wamid.HBgM123' }],
      },
    })
    const m = message('whatsapp')
    const withButton: OutboundMessage = {
      ...m,
      whatsapp: { ...m.whatsapp!, button_url_param: 'pay/KD7Q2M9X4B1Z' },
    }
    const out = await sendWithProvider(provider(), withButton)
    expect(out).toMatchObject({ ok: true, result: { provider_message_id: 'wamid.HBgM123', status: 'sent' } })
    const req = server.requests[0]!
    expect(req.url).toBe('/v20.0/1098765432/messages')
    expect(req.headers.authorization).toBe('Bearer EAAG-token')
    expect(req.json).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'kadai_due_reminder',
        language: { code: 'ta' },
        components: [
          {
            type: 'body',
            // ta text order: customer_name, shop_name, due, days, link
            parameters: [
              { type: 'text', text: 'லட்சுமி' },
              { type: 'text', text: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' },
              { type: 'text', text: '₹2,450.00' },
              { type: 'text', text: '15' },
              { type: 'text', text: 'https://kadai.app/pay/KD7Q2M9X4B1Z' },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: 'pay/KD7Q2M9X4B1Z' }],
          },
        ],
      },
    })
  })

  it('classifies Meta error codes', async () => {
    server.respond.push({
      status: 400,
      body: { error: { message: 'Message undeliverable', code: 131026 } },
    })
    const a = await sendWithProvider(provider(), message('whatsapp'))
    if (!a.ok) expect(a.error).toMatchObject({ kind: 'permanent', code: 'invalid_recipient' })
    else expect.unreachable()

    server.respond.push({ status: 400, body: { error: { message: 'Rate limit hit', code: 130429 } } })
    const b = await sendWithProvider(provider(), message('whatsapp'))
    if (!b.ok) expect(b.error).toMatchObject({ kind: 'retryable', code: 'rate_limited' })
    else expect.unreachable()

    server.respond.push({ status: 401, body: { error: { message: 'token expired', code: 190 } } })
    const c = await sendWithProvider(provider(), message('whatsapp'))
    if (!c.ok) expect(c.error).toMatchObject({ kind: 'permanent', code: 'not_configured' })
    else expect.unreachable()

    server.respond.push({ status: 500, body: {} })
    const d = await sendWithProvider(provider(), message('whatsapp'))
    if (!d.ok) expect(d.error.kind).toBe('retryable')
    else expect.unreachable()

    expect(classifyWhatsAppError(400, 132001)).toEqual({ kind: 'permanent', code: 'provider_error' })
  })

  it('needs credentials and an approved template', async () => {
    const unconfigured = createWhatsAppCloudProvider({
      phoneNumberId: null,
      accessToken: null,
      apiVersion: 'v21.0',
      baseUrl: server.url,
      timeoutMs: 1000,
    })
    expect(unconfigured.configured).toBe(false)
    const a = await sendWithProvider(unconfigured, message('whatsapp'))
    if (!a.ok) expect(a.error.code).toBe('not_configured')
    const b = await sendWithProvider(provider(), { ...message('whatsapp'), whatsapp: null })
    if (!b.ok) expect(b.error).toMatchObject({ kind: 'permanent', code: 'template_unavailable' })
    else expect.unreachable()
    expect(server.requests).toHaveLength(0)
  })
})

describe('email_webhook provider', () => {
  it('posts the payload signed with HMAC-SHA256 and an idempotency key', async () => {
    server.respond.push({ status: 202, body: { id: 'mail-77' } })
    const p = createEmailWebhookProvider({
      url: `${server.url}/mail`,
      secret: 'whsec-1',
      from: 'Kadai <bills@kadai.app>',
      timeoutMs: 2000,
    })
    const m = message('email', { to: 'lakshmi@example.in', locale: 'en' })
    const out = await sendWithProvider(p, m)
    expect(out).toMatchObject({ ok: true, result: { provider_message_id: 'mail-77', status: 'sent' } })
    const req = server.requests[0]!
    expect(req.url).toBe('/mail')
    expect(req.headers['idempotency-key']).toBe(m.idempotency_key)
    const expected = `sha256=${createHmac('sha256', 'whsec-1').update(req.body).digest('hex')}`
    expect(req.headers['x-kadai-signature']).toBe(expected)
    expect(emailWebhookSignature('whsec-1', req.body)).toBe(expected)
    expect(req.json).toMatchObject({
      event: 'notification.email',
      id: m.idempotency_key,
      from: 'Kadai <bills@kadai.app>',
      to: 'lakshmi@example.in',
      to_name: 'Lakshmi',
      subject: 'Bill S1-A/2627/00042 from Sri Murugan Stores',
      template_code: 'invoice_share',
    })
    expect((req.json as { text: string }).text).toContain('https://kadai.app/i/abc')
  })

  it('retries 5xx and fails 4xx; unconfigured fails permanently', async () => {
    const p = createEmailWebhookProvider({ url: server.url, secret: null, from: 'x@y.in', timeoutMs: 2000 })
    server.respond.push({ status: 503 })
    const a = await sendWithProvider(p, message('email', { to: 'a@b.in' }))
    if (!a.ok) expect(a.error.kind).toBe('retryable')
    else expect.unreachable()
    expect(server.requests[0]!.headers['x-kadai-signature']).toBeUndefined()
    server.respond.push({ status: 422, body: { error: 'bad address' } })
    const b = await sendWithProvider(p, message('email', { to: 'a@b.in' }))
    if (!b.ok) expect(b.error.kind).toBe('permanent')
    else expect.unreachable()
    const none = createEmailWebhookProvider({ url: null, secret: null, from: 'x', timeoutMs: 1 })
    const c = await sendWithProvider(none, message('email', { to: 'a@b.in' }))
    if (!c.ok) expect(c.error.code).toBe('not_configured')
    else expect.unreachable()
  })
})

describe('log provider, env selection and status cards', () => {
  it('logs (never the body of sensitive templates in production) and reports delivered', async () => {
    const lines: Array<Record<string, unknown>> = []
    const logger = { info: (o: object) => lines.push(o as Record<string, unknown>) }
    const prod = createLogProvider(logger, { revealBody: false })
    const otp = buildOutboundMessage({
      notification_id: null,
      tenant_id: null,
      code: 'otp',
      channel: 'sms',
      locale: 'en',
      to: '+919876543210',
      params: { otp: '482913', minutes: 5 },
      idempotency_key: 'otp:1',
    })!
    const res = await prod.send(otp)
    expect(res.status).toBe('delivered')
    expect(JSON.stringify(lines)).not.toContain('482913')
    expect(lines[0]).toMatchObject({ redacted: true, to: '98XXX XX210' })
    const dev = createLogProvider(logger, { revealBody: true })
    await dev.send(message('sms'))
    expect(lines[1]!.body).toContain('₹2,450.00')
  })

  it('registers only the env-selected providers and reports their status', () => {
    const config = getTestConfig({
      SMS_PROVIDER: 'msg91',
      MSG91_AUTH_KEY: 'k',
      MSG91_OTP_TEMPLATE_ID: 'otp-flow',
      MSG91_SENDER_ID: 'KADAIS',
      MSG91_TEMPLATE_DUE_REMINDER: 'flow-due',
      WHATSAPP_PROVIDER: 'whatsapp_cloud',
      WHATSAPP_PHONE_NUMBER_ID: '1098',
      WHATSAPP_TOKEN: 'legacy-token-name',
      EMAIL_PROVIDER: 'email_webhook',
      EMAIL_WEBHOOK_URL: 'https://mail.example.in/hook/',
    })
    expect(config.sms.msg91.templateIds).toMatchObject({ due_reminder: 'flow-due', otp: 'otp-flow' })
    expect(config.whatsapp.accessToken).toBe('legacy-token-name')
    expect(config.email.webhookUrl).toBe('https://mail.example.in/hook')
    const providers = buildNotificationProviders(config, { info: () => undefined })
    expect(providers.map((p) => p.code)).toEqual(['log', 'msg91', 'whatsapp_cloud', 'email_webhook'])
    const registry = createNotificationProviderRegistry(providers)
    const statuses = providerStatuses(registry)
    expect(statuses).toEqual([
      {
        channel: 'whatsapp',
        provider: 'whatsapp_cloud',
        configured: true,
        live: true,
        display: '1098',
        webhook_path: '/webhooks/notifications/whatsapp_cloud',
      },
      {
        channel: 'sms',
        provider: 'msg91',
        configured: true,
        live: true,
        display: 'KADAIS',
        webhook_path: '/webhooks/notifications/msg91',
      },
      {
        channel: 'email',
        provider: 'email_webhook',
        configured: true,
        live: true,
        display: config.email.from,
        webhook_path: null,
      },
    ])
    const logOnly = buildNotificationProviders(getTestConfig({ SMS_PROVIDER: 'log' }), {
      info: () => undefined,
    })
    expect(logOnly.map((p) => p.code)).toEqual(['log'])
    expect(providerStatuses(createNotificationProviderRegistry(logOnly))[0]).toMatchObject({
      provider: 'log',
      configured: true,
      live: false,
    })
  })

  it('parses Retry-After headers', () => {
    expect(parseRetryAfter('30')).toBe(30)
    expect(parseRetryAfter('99999')).toBe(3600)
    expect(parseRetryAfter(null)).toBeNull()
    const now = Date.parse('2026-10-21T10:00:00Z')
    expect(parseRetryAfter('Wed, 21 Oct 2026 10:01:00 GMT', now)).toBe(60)
    expect(parseRetryAfter('soon')).toBeNull()
  })

  it('is a NotificationProviderError subclass for every failure', async () => {
    const p = createMsg91Provider({
      authKey: null,
      senderId: null,
      baseUrl: server.url,
      templateIds: {},
      timeoutMs: 1,
    })
    await expect(p.send(message('sms'))).rejects.toBeInstanceOf(NotificationProviderError)
  })
})
