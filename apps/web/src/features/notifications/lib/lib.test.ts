import { describe, expect, it } from 'vitest'
import { errorInfo, statusesOfTab } from './labels'
import { insertPlaceholder, overrideIssues, sampleParams } from './templates'

describe('insertPlaceholder', () => {
  it('inserts at the caret and keeps words and tokens apart', () => {
    expect(insertPlaceholder('Hello ', 'customer_name', 6)).toEqual({
      text: 'Hello {{customer_name}}',
      caret: 23,
    })
    expect(insertPlaceholder('வணக்கம்', 'customer_name', 7).text).toBe('வணக்கம் {{customer_name}}')
    expect(insertPlaceholder('{{due}}', 'link', 7).text).toBe('{{due}} {{link}}')
    expect(insertPlaceholder('Pay now', 'link', 4, 7).text).toBe('Pay {{link}}')
    expect(insertPlaceholder('ab', 'due', 1).text).toBe('a {{due}} b')
  })
})

describe('overrideIssues (same rules as PUT /notification-templates)', () => {
  it('needs a DLT id for SMS and an approved template name for WhatsApp', () => {
    const body = '{{shop_name}}: due {{due}}'
    expect(
      overrideIssues({
        code: 'due_reminder',
        channel: 'sms',
        body,
        subject: null,
        provider_template_id: null,
      }),
    ).toEqual([{ path: 'provider_template_id', code: 'dlt_template_id_required' }])
    expect(
      overrideIssues({
        code: 'due_reminder',
        channel: 'whatsapp',
        body,
        subject: null,
        provider_template_id: 'Bad Name',
      }),
    ).toEqual([{ path: 'provider_template_id', code: 'whatsapp_template_name' }])
    expect(
      overrideIssues({
        code: 'due_reminder',
        channel: 'whatsapp',
        body,
        subject: null,
        provider_template_id: 'murugan_due_ta',
      }),
    ).toEqual([])
  })

  it('reports unknown and missing placeholders and the email subject', () => {
    const issues = overrideIssues({
      code: 'invoice_share',
      channel: 'email',
      body: 'Thanks {{customer_nmae}}',
      subject: '',
      provider_template_id: null,
    })
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'body', code: 'unknown_placeholder', placeholder: 'customer_nmae' },
        { path: 'body', code: 'missing_required_placeholder', placeholder: 'link' },
        { path: 'subject', code: 'subject_required' },
      ]),
    )
  })
})

describe('helpers', () => {
  it('uses the shop name in the message language for samples', () => {
    const shop = { name: 'Anna Stores', name_ta: 'அண்ணா ஸ்டோர்ஸ்' }
    expect(sampleParams('welcome', 'ta', null, shop).shop_name).toBe('அண்ணா ஸ்டோர்ஸ்')
    expect(sampleParams('welcome', 'en', null, shop).shop_name).toBe('Anna Stores')
    expect(sampleParams('otp', 'en', null, shop)).not.toHaveProperty('shop_name')
  })

  it('splits stored errors into a reason and the provider detail', () => {
    expect(errorInfo('invalid_recipient: NDNC number', 'en')).toEqual({
      code: 'invalid_recipient',
      reason: 'Invalid number or address',
      detail: 'NDNC number',
    })
    expect(errorInfo('stuck', 'ta')?.reason).toBe('அனுப்புவது இடையில் நின்றுவிட்டது')
    expect(errorInfo('Something odd', 'en')).toEqual({
      code: null,
      reason: 'Something odd',
      detail: null,
    })
    expect(errorInfo(null, 'en')).toBeNull()
    expect(statusesOfTab('pending')).toEqual(['queued', 'sending'])
    expect(statusesOfTab('all')).toBeNull()
  })
})

describe('notificationsPatch', () => {
  it('sends only changed fields and treats the day list as a set', async () => {
    const { notificationsPatch } = await import('./settings')
    const base = {
      whatsapp_invoice: true,
      sms_invoice: false,
      due_reminder_days: [30, 7, 15],
      daily_summary_to_owner: true,
      low_stock_digest: true,
    }
    expect(notificationsPatch(base, { ...base, due_reminder_days: [7, 15, 30] })).toBeNull()
    expect(
      notificationsPatch(base, { ...base, sms_invoice: true, due_reminder_days: [7] }),
    ).toEqual({
      sms_invoice: true,
      due_reminder_days: [7],
    })
  })
})
