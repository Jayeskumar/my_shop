import { describe, expect, it } from 'vitest'
import {
  INTERNAL_BARCODE_PREFIX,
  ScaleBarcodeConfigSchema,
  ean13CheckDigit,
  generateInternalBarcode,
  gtinCheckDigit,
  isInternalBarcode,
  isValidEan13,
  isValidGtin,
  makeEan13,
  makeScaleBarcode,
  normalizePlu,
  parseScaleBarcode,
} from '../src/scale'

describe('EAN-13 / GTIN', () => {
  it.each(['4006381333931', '5901234123457', '9780306406157', '8901030704932'])('valid EAN-13 %s', (code) => {
    expect(isValidEan13(code)).toBe(true)
    expect(ean13CheckDigit(code.slice(0, 12))).toBe(Number(code[12]))
    expect(makeEan13(code.slice(0, 12))).toBe(code)
  })
  it.each(['4006381333932', '400638133393', '40063813339311', '400638133393a', '', 4006381333931])('invalid EAN-13 %j', (code) => {
    expect(isValidEan13(code)).toBe(false)
  })
  it('validates other GTIN lengths', () => {
    expect(isValidGtin('96385074')).toBe(true) // EAN-8
    expect(isValidGtin('036000291452')).toBe(true) // UPC-A
    expect(isValidGtin('036000291453')).toBe(false)
    expect(isValidGtin('1234567')).toBe(false)
    expect(gtinCheckDigit('03600029145')).toBe(2)
    expect(() => gtinCheckDigit('12a')).toThrow(RangeError)
    expect(() => ean13CheckDigit('123')).toThrow(RangeError)
  })
  it('detects every single-digit error', () => {
    const code = '8901030704932'
    for (let i = 0; i < 13; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === code[i]) continue
        expect(isValidEan13(code.slice(0, i) + d + code.slice(i + 1))).toBe(false)
      }
    }
  })
})

describe('scale barcodes', () => {
  const config = ScaleBarcodeConfigSchema.parse({ enabled: true })
  it('has sensible defaults', () => {
    expect(ScaleBarcodeConfigSchema.parse({})).toEqual({
      enabled: false, prefixes: ['21', '22', '23', '24', '25', '26', '27', '28', '29'], item_code_length: 5,
      value_length: 5, value_type: 'weight', weight_unit_divisor: 1000, price_divisor: 100,
    })
  })
  it('parses a weight barcode (grams → milli kg)', () => {
    const code = makeScaleBarcode('21', '123', 1500, config)
    expect(code).toMatch(/^2100123015000?\d$/)
    expect(parseScaleBarcode(code, config)).toEqual({ prefix: '21', plu: '00123', qty_milli: 1500 })
    expect(normalizePlu('00123')).toBe('123')
    expect(normalizePlu('00000')).toBe('0')
  })
  it('parses a price barcode', () => {
    const priceConfig = ScaleBarcodeConfigSchema.parse({ enabled: true, value_type: 'price' })
    expect(parseScaleBarcode(makeScaleBarcode('28', '45', 12550, priceConfig), priceConfig)).toEqual({ prefix: '28', plu: '00045', price_paise: 12550 })
    const tenPaise = { ...priceConfig, price_divisor: 10 }
    expect(parseScaleBarcode(makeScaleBarcode('28', '45', 1255, tenPaise), tenPaise)?.price_paise).toBe(12550)
  })
  it('supports other weight units and layouts', () => {
    const tenGram = { ...config, weight_unit_divisor: 100 } // value in 10 g units
    expect(parseScaleBarcode(makeScaleBarcode('22', '7', 150, tenGram), tenGram)?.qty_milli).toBe(1500)
    const six = ScaleBarcodeConfigSchema.parse({ enabled: true, prefixes: ['2'], item_code_length: 6, value_length: 5 })
    expect(parseScaleBarcode(makeScaleBarcode('2', '654321', 750, six), six)).toEqual({ prefix: '2', plu: '654321', qty_milli: 750 })
  })
  it('returns null when disabled, invalid, zero or not a scale prefix', () => {
    const code = makeScaleBarcode('21', '123', 1500, config)
    expect(parseScaleBarcode(code, { ...config, enabled: false })).toBeNull()
    expect(parseScaleBarcode(code.slice(0, 12) + ((Number(code[12]) + 1) % 10), config)).toBeNull()
    expect(parseScaleBarcode(makeScaleBarcode('21', '123', 0, config), config)).toBeNull()
    expect(parseScaleBarcode('8901030704932', config)).toBeNull()
    expect(parseScaleBarcode(generateInternalBarcode(5), config)).toBeNull()
  })
  it('validates the layout adds up to 13 digits', () => {
    expect(ScaleBarcodeConfigSchema.safeParse({ prefixes: ['21'], item_code_length: 6 }).success).toBe(false)
    expect(ScaleBarcodeConfigSchema.safeParse({ prefixes: ['2a'] }).success).toBe(false)
    expect(() => makeScaleBarcode('21', '1234567', 1, config)).toThrow(RangeError)
    expect(() => makeScaleBarcode('21', '1', 123456, config)).toThrow(RangeError)
  })
})

describe('internal barcodes', () => {
  it('generates valid EAN-13 codes with the 20 prefix', () => {
    expect(generateInternalBarcode(1)).toBe(makeEan13('200000000001'))
    expect(generateInternalBarcode(9_999_999_999)).toMatch(/^209999999999\d$/)
    for (let i = 0; i < 1000; i += 13) {
      const code = generateInternalBarcode(i)
      expect(isValidEan13(code)).toBe(true)
      expect(code.startsWith(INTERNAL_BARCODE_PREFIX)).toBe(true)
      expect(isInternalBarcode(code)).toBe(true)
    }
    expect(isInternalBarcode('8901030704932')).toBe(false)
  })
  it('rejects invalid sequences', () => {
    expect(() => generateInternalBarcode(-1)).toThrow(RangeError)
    expect(() => generateInternalBarcode(10_000_000_000)).toThrow(RangeError)
    expect(() => generateInternalBarcode(1.5)).toThrow(RangeError)
  })
})
