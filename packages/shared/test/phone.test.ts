import { describe, expect, it } from 'vitest'
import { formatPhoneDisplay, isE164, isValidIndianMobile, maskPhone, normalizeIndianPhone, toWhatsAppNumber } from '../src/phone'

describe('normalizeIndianPhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['98765-43210', '+919876543210'],
    ['098765 43210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['(+91) 98765 43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['0091 9876543210', '+919876543210'],
    ['  6000000000 ', '+916000000000'],
    ['7012345678', '+917012345678'],
    ['8012345678', '+918012345678'],
  ])('%j → %s', (input, expected) => {
    expect(normalizeIndianPhone(input)).toBe(expected)
    expect(isValidIndianMobile(input)).toBe(true)
  })
  it.each([
    '5876543210', // mobiles start 6-9
    '987654321', // 9 digits
    '98765432101', // 11 digits
    '+1 9876543210',
    '+44 7911 123456',
    '044 2345 6789', // landline
    '98765a3210',
    '+9198765432',
    '9876+543210',
    '',
  ])('rejects %j', (input) => {
    expect(normalizeIndianPhone(input)).toBeNull()
    expect(isValidIndianMobile(input)).toBe(false)
  })
  it('rejects non-strings at runtime', () => {
    expect(normalizeIndianPhone(9876543210 as unknown as string)).toBeNull()
  })
})

describe('display helpers', () => {
  it('formatPhoneDisplay', () => {
    expect(formatPhoneDisplay('+919876543210')).toBe('98765 43210')
    expect(formatPhoneDisplay('+919876543210', { withCountryCode: true })).toBe('+91 98765 43210')
    expect(formatPhoneDisplay('9876543210')).toBe('98765 43210')
    expect(formatPhoneDisplay('+447911123456')).toBe('+447911123456')
    expect(formatPhoneDisplay('garbage')).toBe('garbage')
  })
  it('toWhatsAppNumber', () => {
    expect(toWhatsAppNumber('+919876543210')).toBe('919876543210')
    expect(toWhatsAppNumber('98765 43210')).toBe('919876543210')
    expect(toWhatsAppNumber('+447911123456')).toBe('447911123456')
    expect(toWhatsAppNumber('123')).toBeNull()
  })
  it('maskPhone', () => {
    expect(maskPhone('+919876543210')).toBe('98XXX XX210')
    expect(maskPhone('+447911123456')).toBe('XXXXXXXXXX456')
    expect(maskPhone('12')).toBe('XXXX')
  })
  it('isE164', () => {
    expect(isE164('+919876543210')).toBe(true)
    expect(isE164('919876543210')).toBe(false)
    expect(isE164('+0123456789')).toBe(false)
  })
})
