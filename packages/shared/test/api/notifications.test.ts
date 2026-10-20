import { describe, expect, it } from 'vitest'
import { RelayMessageRequestSchema } from '../../src/api/licensing'
import {
  ADHOC_TEMPLATE_CODES,
  CustomerRemindResultSchema,
  CustomerRemindSchema,
  EmailWebhookPayloadSchema,
  NOTIFICATION_PROVIDER_CHANNELS,
  NOTIFICATION_SETTING_TOGGLES,
  NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_CODES,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  NotificationProviderError,
  NotificationSchema,
  NotificationSendJobSchema,
  NotificationSendSchema,
  NotificationTemplateCatalogSchema,
  NotificationTemplateUpsertSchema,
  OutboundMessageSchema,
  WhatsAppVerifyQuerySchema,
  buildOutboundMessage,
  classifyHttpStatus,
  createNotificationProviderRegistry,
  dltTemplateText,
  maskRecipient,
  msg91FlowRequest,
  nextNotificationStatus,
  normalizeRecipient,
  notificationRetryDelaySeconds,
  notificationWebhookPath,
  notificationsRoutes,
  parseHubSignature,
  parseMsg91Report,
  parseTemplate,
  parseWhatsAppStatuses,
  relayRequestFrom,
  renderNotification,
  renderTemplate,
  requiresWhatsAppOptIn,
  resolveTemplate,
  sanitizeWhatsAppParam,
  sendWithProvider,
  shouldSendDueReminder,
  smsSegments,
  templateBodyIssues,
  templatePlaceholderKeys,
  toNotificationProviderError,
  truncateText,
  waMeUrl,
  whatsappTemplateRequest,
  whatsappTemplateText,
  type NotificationProvider,
  type OutboundMessage,
} from '../../src/api/notifications'
import { NotificationSettingsSchema } from '../../src/settings'
import { LocaleSchema } from '../../src/enums'
import { newId } from '../../src/ids'

const LOCALE_CODES = LocaleSchema.options
const id = () => newId()
const NOW = '2026-10-20T10:00:00+05:30'

const issueKeys = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  r.success ? [] : (r.error?.issues.map((i) => i.message) ?? [])

// ---------------------------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------------------------

describe('default templates', () => {
  it.each(NOTIFICATION_TEMPLATE_CODES.map((c) => [c] as const))(
    '%s is complete and consistent',
    (code) => {
      const def = NOTIFICATION_TEMPLATES[code]
      expect(def.code).toBe(code)
      expect(def.channels.length).toBeGreaterThan(0)
      const allowed = new Set(templatePlaceholderKeys(code))
      for (const r of def.required) expect(allowed.has(r), `required ${r}`).toBe(true)
      for (const locale of LOCALE_CODES) {
        // samples satisfy the params schema of the template (what callers must send)
        expect(def.params.safeParse(def.sample[locale]).success, `${code} sample ${locale}`).toBe(
          true,
        )
        for (const channel of def.channels) {
          const text = def.defaults[locale][channel]
          expect(text, `${code} ${locale} ${channel}`).toBeDefined()
          expect(
            templateBodyIssues({ code, channel, body: text!.body, subject: text!.subject }),
          ).toEqual([])
          const parsed = parseTemplate(text!.body)
          if (channel !== 'email') {
            // DLT / Meta templates are fixed texts: no conditional sections
            expect(parsed.placeholders).toEqual(parsed.variables)
          }
          const rendered = renderNotification({
            code,
            channel,
            locale,
            params: def.sample[locale],
          })!
          expect(rendered.body).not.toMatch(/\{\{|\}\}/)
          expect(rendered.body.length).toBeGreaterThan(10)
          if (locale === 'ta') expect(rendered.body).toMatch(/[஀-௿]/)
          if (channel === 'email') expect(rendered.subject).toBeTruthy()
        }
        for (const channel of ['sms', 'whatsapp', 'email'] as const)
          if (!def.channels.includes(channel)) expect(def.defaults[locale][channel]).toBeUndefined()
      }
      if (def.channels.includes('whatsapp'))
        expect(def.whatsapp_template).toMatch(/^kadai_[a-z_]+$/)
      if (def.channels.includes('sms')) expect(def.sms_dlt_env).toMatch(/^MSG91_[A-Z_]+$/)
    },
  )

  it('ad-hoc templates exclude system and sensitive ones', () => {
    expect(ADHOC_TEMPLATE_CODES).not.toContain('otp')
    expect(ADHOC_TEMPLATE_CODES).not.toContain('daily_summary')
    expect(ADHOC_TEMPLATE_CODES).toContain('due_reminder')
    expect(NOTIFICATION_TEMPLATES.otp.sensitive).toBe(true)
    expect(NOTIFICATION_TEMPLATES.otp.sms_dlt_env).toBe('MSG91_OTP_TEMPLATE_ID')
  })

  it('settings toggles map to real settings keys and templates', () => {
    const keys = Object.keys(NotificationSettingsSchema.shape)
    for (const t of NOTIFICATION_SETTING_TOGGLES) {
      expect(keys).toContain(t.key)
      for (const code of t.templates) expect(NOTIFICATION_TEMPLATE_CODES).toContain(code)
    }
    expect(
      NOTIFICATION_SETTING_TOGGLES.find((t) => t.key === 'due_reminder_days')!.options,
    ).toEqual([7, 15, 30, 45, 60])
  })
})

// ---------------------------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------------------------

describe('template engine', () => {
  it('renders variables, sections and inverted sections', () => {
    const body = 'Bill {{number}}{{#due}} — due {{due}}{{/due}}{{^due}} — paid{{/due}}.'
    expect(renderTemplate(body, { number: 'S1/1', due: '₹450.00' }).text).toBe(
      'Bill S1/1 — due ₹450.00.',
    )
    expect(renderTemplate(body, { number: 'S1/1', due: null }).text).toBe('Bill S1/1 — paid.')
    expect(renderTemplate('{{#n}}{{n}} items{{/n}}', { n: 0 }).text).toBe('')
    expect(renderTemplate('Hi {{ name }}', {}).missing).toEqual(['name'])
    expect(renderTemplate('<b>{{x}}</b>', { x: '<a & "b">' }, { escape: 'html' }).text).toBe(
      '<b>&lt;a &amp; &quot;b&quot;&gt;</b>',
    )
    expect(renderTemplate('{{n}} pcs', { n: 12 }).text).toBe('12 pcs')
    expect(renderTemplate('{{a}}{{a}}', { a: 'x' }, { maxLength: 1 }).text).toBe('…')
  })

  it('reports syntax problems', () => {
    expect(parseTemplate('{{#due}}x').errors).toHaveLength(1)
    expect(parseTemplate('x{{/due}}').errors).toHaveLength(1)
    expect(parseTemplate('{{#a}}{{/b}}').errors.length).toBeGreaterThan(0)
    expect(parseTemplate('Hello {{ Name }}').errors).toHaveLength(1)
    expect(parseTemplate('a {{b}} {{c}} {{b}}').variables).toEqual(['b', 'c'])
  })

  it('validates override bodies', () => {
    const issues = templateBodyIssues({
      code: 'invoice_share',
      channel: 'whatsapp',
      body: 'Hi {{customer_name}} {{otp}} {{#due}}x',
    })
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'template_syntax',
        'unknown_placeholder',
        'missing_required_placeholder',
      ]),
    )
    expect(issues.find((i) => i.code === 'unknown_placeholder')!.placeholder).toBe('otp')
    expect(
      templateBodyIssues({ code: 'otp', channel: 'whatsapp', body: '{{otp}}' }).map((i) => i.code),
    ).toEqual(['template_channel'])
    expect(
      templateBodyIssues({
        code: 'welcome',
        channel: 'email',
        body: '{{shop_name}}',
        subject: ' ',
      }).map((i) => i.code),
    ).toEqual(['subject_required'])
    expect(
      templateBodyIssues({
        code: 'welcome',
        channel: 'sms',
        body: `{{shop_name}} ${'x'.repeat(1000)}`,
      }).map((i) => i.code),
    ).toEqual(['body_too_long'])
  })

  it('resolves overrides only when active', () => {
    const override = {
      subject: null,
      body: 'Custom {{link}}',
      provider_template_id: '1207168000000000001',
      is_active: true,
    }
    expect(
      resolveTemplate({ code: 'invoice_share', channel: 'sms', locale: 'ta', override }),
    ).toMatchObject({
      body: 'Custom {{link}}',
      source: 'override',
    })
    expect(
      resolveTemplate({
        code: 'invoice_share',
        channel: 'sms',
        locale: 'ta',
        override: { ...override, is_active: false },
      })!.source,
    ).toBe('default')
    expect(resolveTemplate({ code: 'otp', channel: 'email', locale: 'en' })).toBeNull()
  })

  it('renders WhatsApp templates with positional, sanitized parameters per language', () => {
    const params = { ...NOTIFICATION_TEMPLATES.po_to_supplier.sample.en }
    const en = renderNotification({
      code: 'po_to_supplier',
      channel: 'whatsapp',
      locale: 'en',
      params,
    })!
    expect(en.whatsapp).toEqual({
      template_name: 'kadai_purchase_order',
      language: 'en',
      body_params: [
        'Annai Traders',
        'POS1/2627/00008',
        '20-10-2026',
        'Sri Murugan Stores',
        '1. Ponni rice 25 kg × 20 bags · 2. Toor dal 1 kg × 50 pcs',
      ],
    })
    // Tamil word order differs: parameters follow the Tamil text
    const ta = renderNotification({
      code: 'invoice_share',
      channel: 'whatsapp',
      locale: 'ta',
      params: NOTIFICATION_TEMPLATES.invoice_share.sample.ta,
    })!
    expect(ta.whatsapp!.body_params).toEqual([
      'லட்சுமி',
      'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
      'S1-A/2627/00042',
      '₹1,250.00',
      'https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
    ])
    expect(ta.body).toContain('லட்சுமி')
    const sms = renderNotification({
      code: 'invoice_share',
      channel: 'sms',
      locale: 'en',
      params: { number: 'X' },
    })!
    expect(sms.whatsapp).toBeNull()
    expect(sms.missing).toEqual(expect.arrayContaining(['shop_name', 'amount', 'link']))
  })

  it('text helpers', () => {
    expect(sanitizeWhatsAppParam('a\nb\t c      d')).toBe('a · b · c    d')
    expect(sanitizeWhatsAppParam('   ')).toBe('-')
    expect(truncateText('வணக்கம்', 3)).toHaveLength(2 + 1)
    expect(smsSegments('Hello')).toEqual({ encoding: 'gsm7', length: 5, segments: 1 })
    expect(smsSegments('x'.repeat(161)).segments).toBe(2)
    const ta = smsSegments('வணக்கம் '.repeat(10))
    expect(ta.encoding).toBe('unicode')
    expect(ta.segments).toBe(2)
    expect(smsSegments('').segments).toBe(0)
    expect(dltTemplateText('{{shop_name}}: Bill {{number}}{{#x}}y{{/x}}')).toBe(
      '{#var#}: Bill {#var#}y',
    )
    expect(whatsappTemplateText('Hi {{a}}, {{b}} and {{a}}')).toBe('Hi {{1}}, {{2}} and {{1}}')
  })

  it('recipients and opt-in', () => {
    expect(normalizeRecipient('sms', '98765 43210')).toBe('+919876543210')
    expect(normalizeRecipient('whatsapp', '+14155550100')).toBe('+14155550100')
    expect(normalizeRecipient('sms', '12345')).toBeNull()
    expect(normalizeRecipient('email', ' Owner@Shop.IN ')).toBe('owner@shop.in')
    expect(normalizeRecipient('email', 'nope')).toBeNull()
    expect(maskRecipient('+919876543210')).not.toContain('9876543')
    expect(maskRecipient('lakshmi@gmail.com')).toBe('la***@gmail.com')
    expect(requiresWhatsAppOptIn('invoice_share', 'whatsapp')).toBe(true)
    expect(requiresWhatsAppOptIn('invoice_share', 'sms')).toBe(false)
    expect(requiresWhatsAppOptIn('daily_summary', 'whatsapp')).toBe(false)
    expect(waMeUrl('+919876543210', 'வணக்கம் & hi')).toBe(
      `https://wa.me/919876543210?text=${encodeURIComponent('வணக்கம் & hi')}`,
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Sending: retries, receipts, providers
// ---------------------------------------------------------------------------------------------

describe('sending rules', () => {
  it('exponential backoff, capped at an hour', () => {
    expect([1, 2, 3, 4, 5, 6].map(notificationRetryDelaySeconds)).toEqual([
      30, 120, 480, 1920, 3600, 3600,
    ])
    expect(notificationRetryDelaySeconds(0)).toBe(30)
  })

  it('due reminder selection', () => {
    const base = {
      due_paise: 1000,
      oldest_due_days: 15,
      reminder_days: [7, 15, 30],
      can_message: true,
      days_since_last_reminder: null,
    }
    expect(shouldSendDueReminder(base)).toBe(true)
    expect(shouldSendDueReminder({ ...base, oldest_due_days: 16 })).toBe(false)
    expect(shouldSendDueReminder({ ...base, due_paise: 0 })).toBe(false)
    expect(shouldSendDueReminder({ ...base, can_message: false })).toBe(false)
    expect(shouldSendDueReminder({ ...base, days_since_last_reminder: 2 })).toBe(false)
    expect(shouldSendDueReminder({ ...base, days_since_last_reminder: 3 })).toBe(true)
    expect(shouldSendDueReminder({ ...base, oldest_due_days: null })).toBe(false)
  })

  it('delivery receipts only move forward', () => {
    expect(nextNotificationStatus('sent', 'delivered')).toBe('delivered')
    expect(nextNotificationStatus('read', 'delivered')).toBeNull()
    expect(nextNotificationStatus('delivered', 'read')).toBe('read')
    expect(nextNotificationStatus('sending', 'sent')).toBe('sent')
    expect(nextNotificationStatus('sent', 'failed')).toBe('failed')
    expect(nextNotificationStatus('delivered', 'failed')).toBeNull()
    expect(nextNotificationStatus('failed', 'delivered')).toBe('delivered')
    expect(nextNotificationStatus('cancelled', 'read')).toBeNull()
    expect(nextNotificationStatus('sent', 'sent')).toBeNull()
  })

  it('classifies provider errors', () => {
    expect([408, 425, 429, 500, 503].map(classifyHttpStatus)).toEqual(Array(5).fill('retryable'))
    expect([400, 401, 403, 404, 422].map(classifyHttpStatus)).toEqual(Array(5).fill('permanent'))
    const timeout = toNotificationProviderError(
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
      'msg91',
    )
    expect(timeout).toMatchObject({ kind: 'retryable', code: 'timeout', provider: 'msg91' })
    expect(toNotificationProviderError(new TypeError('fetch failed'), 'x').code).toBe('network')
    expect(
      toNotificationProviderError(Object.assign(new Error('r'), { code: 'ECONNRESET' }), 'x').code,
    ).toBe('network')
    expect(toNotificationProviderError('weird', 'x')).toMatchObject({
      kind: 'retryable',
      code: 'unknown',
    })
    const permanent = new NotificationProviderError({
      message: 'invalid number',
      kind: 'permanent',
      provider: 'whatsapp_cloud',
      code: 'http_400',
      http_status: 400,
    })
    expect(toNotificationProviderError(permanent, 'other')).toBe(permanent)
    expect(permanent).toBeInstanceOf(Error)
    expect(permanent.name).toBe('NotificationProviderError')
  })

  const message: OutboundMessage = buildOutboundMessage({
    notification_id: id(),
    tenant_id: id(),
    code: 'due_reminder',
    channel: 'whatsapp',
    locale: 'ta',
    to: '+919876543210',
    recipient_name: 'லட்சுமி',
    params: NOTIFICATION_TEMPLATES.due_reminder.sample.ta,
    attempt: 2,
  })!

  const fake = (
    code: NotificationProvider['code'],
    channels: NotificationProvider['channels'],
    configured: boolean,
    send: NotificationProvider['send'] = async () => ({
      provider_message_id: `${code}-1`,
      status: 'sent',
    }),
  ): NotificationProvider => ({ code, channels, configured, send })

  it('builds provider messages', () => {
    expect(OutboundMessageSchema.parse(message)).toEqual(message)
    expect(message.idempotency_key).toBe(`${message.notification_id}:2`)
    expect(message.whatsapp).toMatchObject({
      template_name: 'kadai_due_reminder',
      language: 'ta',
      button_url_param: null,
    })
    expect(message.params.days).toBe('15')
    expect(
      buildOutboundMessage({
        notification_id: null,
        tenant_id: null,
        code: 'otp',
        channel: 'whatsapp',
        locale: 'en',
        to: '+919876543210',
        params: { otp: '123456', minutes: 5 },
      }),
    ).toBeNull()
    const relay = relayRequestFrom(message)
    expect(RelayMessageRequestSchema.parse(relay)).toMatchObject({
      channel: 'whatsapp',
      template_code: 'due_reminder',
      client_ref: message.notification_id,
    })
  })

  it('provider registry picks the channel provider', () => {
    const reg = createNotificationProviderRegistry([
      fake('log', NOTIFICATION_PROVIDER_CHANNELS.log, true),
    ])
    expect(reg.forChannel('sms')!.code).toBe('log')
    reg.register(fake('msg91', ['sms'], false))
    expect(reg.forChannel('sms')!.code).toBe('log') // not configured
    reg.register(fake('msg91', ['sms'], true), { replace: true })
    expect(reg.forChannel('sms')!.code).toBe('msg91')
    expect(() => reg.register(fake('msg91', ['sms'], true))).toThrow(/already registered/)
    reg.register(fake('kadai_relay', ['sms', 'whatsapp'], true))
    expect(reg.forChannel('whatsapp')!.code).toBe('kadai_relay')
    reg.select('sms', 'kadai_relay')
    expect(reg.selected('sms')).toBe('kadai_relay')
    expect(reg.forChannel('sms')!.code).toBe('kadai_relay')
    reg.select('sms', 'whatsapp_cloud') // pinned but not registered → automatic
    expect(reg.forChannel('sms')!.code).toBe('msg91')
    reg.select('sms', null)
    expect(reg.unregister('msg91')).toBe(true)
    expect(reg.list().map((p) => p.code)).toEqual(['log', 'kadai_relay'])
    expect(createNotificationProviderRegistry().forChannel('email')).toBeUndefined()
  })

  it('sendWithProvider normalises outcomes', async () => {
    const ok = await sendWithProvider(fake('whatsapp_cloud', ['whatsapp'], true), message)
    expect(ok).toEqual({
      ok: true,
      provider: 'whatsapp_cloud',
      result: { provider_message_id: 'whatsapp_cloud-1', status: 'sent' },
    })
    const failing = fake('whatsapp_cloud', ['whatsapp'], true, async () => {
      throw new TypeError('fetch failed')
    })
    const err = await sendWithProvider(failing, message)
    expect(err.ok).toBe(false)
    if (!err.ok)
      expect(err.error).toMatchObject({
        kind: 'retryable',
        code: 'network',
        provider: 'whatsapp_cloud',
      })
    const custom = await sendWithProvider(
      {
        ...failing,
        classifyError: () =>
          new NotificationProviderError({
            message: 'x',
            kind: 'permanent',
            provider: 'whatsapp_cloud',
            code: 'blocked',
          }),
      },
      message,
    )
    expect(!custom.ok && custom.error.kind).toBe('permanent')
  })

  it('provider wire formats', () => {
    const wa = whatsappTemplateRequest(message)
    expect(wa).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: { name: 'kadai_due_reminder', language: { code: 'ta' } },
    })
    const body = (wa.template as { components: Array<{ parameters: Array<{ text: string }> }> })
      .components[0]!
    expect(body.parameters.map((p) => p.text)).toEqual(message.whatsapp!.body_params)
    expect(() => whatsappTemplateRequest({ ...message, whatsapp: null })).toThrow()
    const sms = { ...message, channel: 'sms' as const, whatsapp: null }
    expect(msg91FlowRequest(sms, '1207168000000000001', 'KADAIS')).toEqual({
      template_id: '1207168000000000001',
      short_url: '0',
      sender: 'KADAIS',
      recipients: [{ mobiles: '919876543210', ...message.params }],
    })
    expect(notificationWebhookPath('whatsapp_cloud')).toBe('/webhooks/notifications/whatsapp_cloud')
  })

  it('webhook parsing', () => {
    const hex = 'a'.repeat(64)
    expect(parseHubSignature(`sha256=${hex.toUpperCase()}`)).toBe(hex)
    expect(parseHubSignature('sha1=abc')).toBeNull()
    expect(parseHubSignature(undefined)).toBeNull()
    const receipts = parseWhatsAppStatuses({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                statuses: [
                  {
                    id: 'wamid.1',
                    status: 'delivered',
                    timestamp: '1790000000',
                    recipient_id: '919876543210',
                  },
                  {
                    id: 'wamid.2',
                    status: 'failed',
                    timestamp: '1790000001',
                    errors: [{ code: 131026, title: 'Message undeliverable' }],
                  },
                  { id: 'wamid.3', status: 'deleted' },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(receipts).toEqual([
      {
        provider_message_id: 'wamid.1',
        status: 'delivered',
        at: new Date(1_790_000_000_000).toISOString(),
        error: null,
      },
      {
        provider_message_id: 'wamid.2',
        status: 'failed',
        at: new Date(1_790_000_001_000).toISOString(),
        error: '131026 Message undeliverable',
      },
    ])
    expect(parseWhatsAppStatuses('garbage')).toEqual([])
    expect(
      parseMsg91Report({
        data: [
          {
            requestId: 'r1',
            report: [
              {
                number: '919876543210',
                status: '1',
                desc: 'DELIVERED',
                date: '2026-10-20 10:00:01',
              },
            ],
          },
        ],
      }),
    ).toEqual([
      { provider_message_id: 'r1', status: 'delivered', at: '2026-10-20 10:00:01', error: null },
    ])
    expect(parseMsg91Report([{ requestId: 'r2', report: [{ desc: 'NDNC' }] }])[0]).toMatchObject({
      status: 'failed',
      error: 'NDNC',
    })
    expect(parseMsg91Report({ request_id: 'r3', status: 'SUBMITTED' })[0]!.status).toBe('sent')
    expect(parseMsg91Report(null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------------------------

describe('request and response schemas', () => {
  it('send body validates recipient, template and channel', () => {
    const ok = NotificationSendSchema.parse({
      channel: 'sms',
      template_code: 'payment_receipt',
      to: '98765 43210',
      params: { amount: '₹500.00' },
    })
    expect(ok.to).toBe('+919876543210')
    expect(
      issueKeys(
        NotificationSendSchema.safeParse({
          channel: 'email',
          template_code: 'welcome',
          to: 'x',
          params: {},
        }),
      ),
    ).toContain('recipient_email')
    expect(
      issueKeys(
        NotificationSendSchema.safeParse({
          channel: 'sms',
          template_code: 'otp',
          to: '9876543210',
          params: {},
        }),
      ),
    ).toEqual(expect.arrayContaining(['template_not_adhoc']))
    expect(
      issueKeys(
        NotificationSendSchema.safeParse({
          channel: 'email',
          template_code: 'due_reminder',
          to: 'a@b.in',
          params: {},
        }),
      ),
    ).toContain('template_channel')
    expect(
      NotificationSendSchema.safeParse({
        channel: 'sms',
        template_code: 'welcome',
        to: '9876543210',
        params: { 'Bad Key': 'x' },
      }).success,
    ).toBe(false)
  })

  it('queries and bodies', () => {
    const q = NotificationListQuerySchema.parse({
      status: 'failed',
      channel: ['sms', 'whatsapp'],
      template_code: 'due_reminder',
    })
    expect(q).toMatchObject({
      status: ['failed'],
      channel: ['sms', 'whatsapp'],
      template_code: ['due_reminder'],
    })
    expect(q.sort).toEqual({ field: 'created_at', direction: 'desc' })
    expect(
      NotificationTemplateUpsertSchema.parse({ body: ' Hi {{link}} ', provider_template_id: '' }),
    ).toEqual({
      body: 'Hi {{link}}',
      provider_template_id: null,
      is_active: true,
    })
    expect(CustomerRemindSchema.parse({})).toEqual({
      channel: 'whatsapp',
      include_payment_link: true,
      phone: null,
    })
    expect(CustomerRemindSchema.parse({ channel: 'wa_me', phone: '9876543210' }).phone).toBe(
      '+919876543210',
    )
    expect(
      NotificationSendJobSchema.safeParse({ tenant_id: id(), notification_id: id() }).success,
    ).toBe(true)
    expect(
      WhatsAppVerifyQuerySchema.parse({
        'hub.mode': 'subscribe',
        'hub.verify_token': 't',
        'hub.challenge': '42',
      })['hub.challenge'],
    ).toBe('42')
    expect(notificationsRoutes.remindCustomer.body.parse(undefined)).toMatchObject({
      channel: 'whatsapp',
    })
  })

  const notification = {
    id: id(),
    channel: 'whatsapp',
    template_code: 'invoice_share',
    locale: 'ta',
    recipient: '+919876543210',
    recipient_name: 'லட்சுமி',
    params: { shop_name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்', amount: '₹1,250.00', due: null },
    rendered_body: 'வணக்கம் லட்சுமி…',
    status: 'delivered',
    provider: 'whatsapp_cloud',
    provider_message_id: 'wamid.1',
    error: null,
    attempts: 1,
    ref_type: 'sales_invoice',
    ref_id: id(),
    ref_path: null,
    scheduled_at: NOW,
    sent_at: new Date(),
    created_by: null,
    created_by_name: null,
    created_at: NOW,
    updated_at: NOW,
    can_retry: false,
  }

  it('outbox, catalogue and remind results', () => {
    NotificationSchema.parse(notification)
    NotificationListResponseSchema.parse({
      data: [notification],
      page: { limit: 50, offset: 0, total: 1 },
      summary: {
        by_status: [{ status: 'delivered', count: 1 }],
        by_channel: [{ channel: 'whatsapp', count: 1 }],
      },
    })
    const def = NOTIFICATION_TEMPLATES.invoice_share
    NotificationTemplateCatalogSchema.parse({
      templates: [
        {
          code: 'invoice_share',
          channel: 'sms',
          locale: 'ta',
          label: def.label,
          description: def.description,
          audience: def.audience,
          subject: null,
          body: def.defaults.ta.sms!.body,
          provider_template_id: null,
          is_active: true,
          is_override: false,
          override_updated_at: null,
          default_subject: null,
          default_body: def.defaults.ta.sms!.body,
          default_provider_template_id: '1207168000000000002',
          placeholders: templatePlaceholderKeys('invoice_share').map((key) => ({
            key,
            required: def.required.includes(key),
          })),
          sample: def.sample.ta,
          max_length: 1000,
        },
      ],
      providers: [
        {
          channel: 'sms',
          provider: 'msg91',
          configured: true,
          live: true,
          display: 'KADAIS',
          webhook_path: '/webhooks/notifications/msg91',
        },
        {
          channel: 'whatsapp',
          provider: 'kadai_relay',
          configured: true,
          live: true,
          display: null,
          webhook_path: null,
        },
        {
          channel: 'email',
          provider: 'log',
          configured: true,
          live: false,
          display: null,
          webhook_path: null,
        },
      ],
      settings: NotificationSettingsSchema.parse({}),
      dlt_note: { en: 'x', ta: 'y' },
    })
    CustomerRemindResultSchema.parse({
      customer_id: id(),
      due_paise: 245_000,
      amount_paise: 245_000,
      channel: 'wa_me',
      notification: null,
      link: null,
      message: 'வணக்கம் லட்சுமி…',
      wa_me_url: waMeUrl('+919876543210', 'வணக்கம்'),
      last_reminded_at: null,
    })
    EmailWebhookPayloadSchema.parse({
      event: 'notification.email',
      id: id(),
      tenant_id: id(),
      notification_id: id(),
      template_code: 'daily_summary',
      locale: 'en',
      from: 'Kadai <no-reply@shop.in>',
      to: 'owner@shop.in',
      to_name: null,
      subject: 'Daily summary',
      text: 'Sales …',
    })
  })
})
