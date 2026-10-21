import { describe, expect, it } from 'vitest'
import { PAYMENTS_ERROR_REASONS, PAYMENTS_VALIDATION_KEYS } from '@kadai/shared/api/payments'
import { PaymentIntentStatusSchema, PaymentMethodSchema } from '@kadai/shared/enums'
import en from '@/locales/en/payments.json'
import ta from '@/locales/ta/payments.json'
import * as F from '../testing/fixtures'
import { escapeHtml, receiptHtml, receiptPaper, standeeHtml } from './print-docs'
import { qrMatrix, qrSvgMarkup } from './qr'

const shop = {
  name: 'Sri Murugan Stores',
  name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
  address: '12 East Masi Street, Madurai',
  phone: '+919876543210',
  gstin: '33AAAPL1234C1ZV',
}

describe('receipt print', () => {
  it('prints a bilingual receipt with the amount in words and what it settled', () => {
    const html = receiptHtml(F.paymentDetail({ unallocated_paise: 50_00 }), shop)
    expect(html).toContain('பணம் பெற்றதற்கான ரசீது')
    expect(html).toContain('Payment receipt')
    expect(html).toContain('RC/2627/00042')
    expect(html).toContain('₹1,250.00')
    expect(html).toContain('S1-A/2627/00412')
    expect(html).toContain('ஆயிரத்து')
    expect(html).toMatch(/one thousand two hundred fifty/i)
    expect(html).toContain('UPI / UPI')
    expect(html).toContain('628194773311')
    expect(html).toContain('Advance')
    expect(html).not.toContain('CANCELLED')
  })

  it('marks a cancelled voucher and escapes every value', () => {
    const html = receiptHtml(
      F.paymentDetail({
        direction: 'out',
        status: 'cancelled',
        party_name: '<script>alert(1)</script> & Co',
        notes: '"quoted"',
        allocations: [],
        intent: null,
        reference: null,
      }),
      shop,
    )
    expect(html).toContain('Payment voucher')
    expect(html).toContain('CANCELLED')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co')
    expect(html).toContain('&quot;quoted&quot;')
  })

  it('uses half-A4 for A4 shops and thermal otherwise', () => {
    expect(receiptPaper('a4')).toBe('a5')
    expect(receiptPaper('thermal_58')).toBe('thermal_58')
    expect(receiptPaper(null)).toBe('thermal_80')
  })
})

describe('standee poster', () => {
  it('has both shop names, the QR, the UPI ID and the Tamil scan line', () => {
    const qr = F.upiQrPayload()
    const html = standeeHtml({
      shop: qr.shop,
      store: { name: 'Anna Nagar', name_ta: 'அண்ணா நகர்' },
      vpa: qr.vpa,
      payee_name: qr.payee_name,
      upi_uri: qr.upi_uri,
      paper: 'a5',
    })
    expect(html).toContain('ஸ்ரீ முருகன் ஸ்டோர்ஸ்')
    expect(html).toContain('Sri Murugan Stores')
    expect(html).toContain('அண்ணா நகர் · Anna Nagar')
    expect(html).toContain('எந்த UPI செயலியிலும் ஸ்கேன் செய்யவும்')
    expect(html).toContain('Scan with any UPI app')
    expect(html).toContain('murugan.stores@okaxis')
    expect(html).toMatch(/<svg [^>]*viewBox=/)
  })
})

describe('QR', () => {
  it('encodes UPI URIs and refuses empty input', () => {
    const m = qrMatrix(F.upiQrPayload().upi_uri)
    expect(m?.size).toBeGreaterThanOrEqual(21)
    expect(m?.path).toMatch(/^M\d/)
    expect(qrMatrix('')).toBeNull()
    expect(qrSvgMarkup('upi://pay?pa=a@b&pn=X', 200)).toContain('width="200"')
  })

  it('escapes html', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
  })
})

describe('payments translations', () => {
  it.each([
    ['en', en],
    ['ta', ta],
  ] as const)('%s has every contract reason, validation key and status', (_lang, messages) => {
    for (const reason of PAYMENTS_ERROR_REASONS) {
      expect(messages.errors, reason).toHaveProperty(reason)
    }
    for (const key of PAYMENTS_VALIDATION_KEYS) {
      expect(messages.validation, key).toHaveProperty(key)
    }
    for (const status of PaymentIntentStatusSchema.options) {
      expect(messages.intent_status, status).toHaveProperty(status)
    }
    expect(Object.keys(messages.provider).length).toBeGreaterThan(0)
    expect(PaymentMethodSchema.options.length).toBeGreaterThan(0)
  })
})
