import { describe, expect, it } from 'vitest'
import {
  REFERENCE_CODE_LENGTH,
  buildUpiUri,
  generateReferenceCode,
  isValidVpa,
  normalizeVpa,
  parseUpiUri,
} from '../src/upi'

describe('isValidVpa', () => {
  it.each([
    ['shop@oksbi', true],
    ['kadai.store-1_tn@ybl', true],
    ['9876543210@paytm', true],
    ['ab@upi', true],
    ['a@upi', false], // handle min 2 chars
    ['shop@', false],
    ['@oksbi', false],
    ['shop@1bank', false], // psp must start with a letter
    ['shop name@oksbi', false],
    ['shop@ok.sbi', false],
    ['shop', false],
    [42, false],
  ])('isValidVpa(%j) = %s', (vpa, expected) => {
    expect(isValidVpa(vpa)).toBe(expected)
  })
  it('normalizeVpa', () => {
    expect(normalizeVpa(' Shop.Name@OKSBI ')).toBe('shop.name@oksbi')
  })
})

describe('buildUpiUri', () => {
  it('builds a dynamic QR URI with all parameters', () => {
    expect(
      buildUpiUri({
        vpa: 'murugan.stores@oksbi',
        payee_name: 'Murugan Stores',
        amount_paise: 12345,
        note: 'Bill S1A/2627/00042',
        reference: 'KD7Q2M9X4LZ0',
        mcc: '5411',
      }),
    ).toBe(
      'upi://pay?pa=murugan.stores@oksbi&pn=Murugan%20Stores&am=123.45&cu=INR&tn=Bill%20S1A%2F2627%2F00042&tr=KD7Q2M9X4LZ0&mc=5411',
    )
  })
  it('omits absent parameters (static QR)', () => {
    expect(buildUpiUri({ vpa: 'shop@ybl', payee_name: 'Shop' })).toBe(
      'upi://pay?pa=shop@ybl&pn=Shop&cu=INR',
    )
    expect(
      buildUpiUri({
        vpa: 'shop@ybl',
        payee_name: 'Shop',
        amount_paise: null,
        note: '  ',
        reference: null,
        mcc: null,
      }),
    ).toBe('upi://pay?pa=shop@ybl&pn=Shop&cu=INR')
  })
  it('formats the amount with two decimals', () => {
    expect(buildUpiUri({ vpa: 'shop@ybl', payee_name: 'S', amount_paise: 100 })).toContain(
      '&am=1.00&',
    )
    expect(buildUpiUri({ vpa: 'shop@ybl', payee_name: 'S', amount_paise: 5 })).toContain(
      '&am=0.05&',
    )
    expect(buildUpiUri({ vpa: 'shop@ybl', payee_name: 'S', amount_paise: 1234567 })).toContain(
      '&am=12345.67&',
    )
  })
  it('percent-encodes Tamil names and notes, truncating notes to 50 characters', () => {
    const uri = buildUpiUri({
      vpa: 'shop@ybl',
      payee_name: 'முருகன் ஸ்டோர்ஸ் & Co',
      note: 'x'.repeat(80),
    })
    expect(uri).toContain(`pn=${encodeURIComponent('முருகன் ஸ்டோர்ஸ் & Co')}`)
    expect(uri).toContain(`tn=${'x'.repeat(50)}`)
    expect(uri).not.toContain('x'.repeat(51))
    const tamilNote = 'தமிழ்'.repeat(20) // never cut inside a grapheme
    const parsed = parseUpiUri(buildUpiUri({ vpa: 'shop@ybl', payee_name: 'S', note: tamilNote }))!
    expect([...parsed.note!].length).toBeLessThanOrEqual(50)
    expect(tamilNote.startsWith(parsed.note!)).toBe(true)
    expect(parsed.note!.endsWith('ழ்')).toBe(true)
  })
  it.each([
    [{ vpa: 'not a vpa', payee_name: 'S' }],
    [{ vpa: 'shop@ybl', payee_name: '  ' }],
    [{ vpa: 'shop@ybl', payee_name: 'S', amount_paise: 0 }],
    [{ vpa: 'shop@ybl', payee_name: 'S', amount_paise: -100 }],
    [{ vpa: 'shop@ybl', payee_name: 'S', amount_paise: 10.5 }],
    [{ vpa: 'shop@ybl', payee_name: 'S', reference: 'has-dash' }],
    [{ vpa: 'shop@ybl', payee_name: 'S', reference: 'A'.repeat(36) }],
    [{ vpa: 'shop@ybl', payee_name: 'S', reference: '' }],
    [{ vpa: 'shop@ybl', payee_name: 'S', mcc: '541' }],
  ])('rejects %j', (params) => {
    expect(() => buildUpiUri(params)).toThrow(RangeError)
  })
})

describe('parseUpiUri', () => {
  it('round-trips buildUpiUri', () => {
    const params = {
      vpa: 'murugan.stores@oksbi',
      payee_name: 'முருகன் Stores & Co',
      amount_paise: 99950,
      note: 'Due 100% + tip',
      reference: 'KD12345ABCDE',
      mcc: '5912',
    }
    const parsed = parseUpiUri(buildUpiUri(params))
    expect(parsed).toMatchObject({
      vpa: params.vpa,
      payee_name: params.payee_name,
      amount_paise: 99950,
      currency: 'INR',
      note: params.note,
      reference: params.reference,
      mcc: '5912',
    })
  })
  it('accepts third-party QR formats (%40, + as space, upper-case scheme, extra params)', () => {
    expect(parseUpiUri('UPI://pay?pa=shop%40ybl&pn=My+Shop&am=10&tid=abc&mode=02')).toMatchObject({
      vpa: 'shop@ybl',
      payee_name: 'My Shop',
      amount_paise: 1000,
      currency: null,
      params: { tid: 'abc', mode: '02' },
    })
  })
  it.each([
    'https://example.com',
    'upi://pay?pn=NoVpa',
    'upi://pay?pa=bad',
    'upi://pay?pa=shop@ybl&am=abc',
    'upi://pay?pa=shop@ybl&pn=%E0%A4',
    'upi://mandate?pa=shop@ybl',
  ])('returns null for %s', (uri) => {
    expect(parseUpiUri(uri)).toBeNull()
  })
})

describe('generateReferenceCode', () => {
  it('produces 12 uppercase alphanumerics with the prefix', () => {
    const codes = Array.from({ length: 2000 }, () => generateReferenceCode())
    for (const code of codes) {
      expect(code).toMatch(/^KD[0-9A-Z]{10}$/)
      expect(code).toHaveLength(REFERENCE_CODE_LENGTH)
    }
    expect(new Set(codes).size).toBe(codes.length)
    expect(generateReferenceCode('PAY')).toMatch(/^PAY[0-9A-Z]{9}$/)
    expect(generateReferenceCode('')).toMatch(/^[0-9A-Z]{12}$/)
  })
  it('is roughly uniform over the alphabet', () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 3000; i++)
      for (const ch of generateReferenceCode('').slice(0)) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    expect(counts.size).toBe(36)
    for (const n of counts.values()) expect(n).toBeGreaterThan(700) // expected 1000 each
  })
  it('rejects invalid prefixes', () => {
    expect(() => generateReferenceCode('kd')).toThrow(RangeError)
    expect(() => generateReferenceCode('ABCDEFGHI')).toThrow(RangeError)
  })
})
