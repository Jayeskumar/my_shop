/**
 * Barcodes: EAN-13 / GTIN check digits, weighing-scale (price/weight embedded) barcodes and
 * shop-generated internal barcodes.
 *
 * Scale barcode layout (default): PP IIIII VVVVV C — 2-digit prefix (GS1 restricted
 * circulation 21–29), 5-digit item code (PLU, matched against products.scale_plu), 5-digit
 * value (weight or price) and the EAN-13 check digit.
 */
import { z } from 'zod'

const DIGITS_RE = /^\d+$/

/** GS1 mod-10 check digit for the digits of a GTIN without its check digit (any length). */
export function gtinCheckDigit(body: string): number {
  if (!DIGITS_RE.test(body)) throw new RangeError('barcode body must be digits')
  let sum = 0
  // Weights 3,1,3,1… from the rightmost digit of the body.
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48
    sum += digit * (i % 2 === 0 ? 3 : 1)
  }
  return (10 - (sum % 10)) % 10
}

/** Valid GTIN-8 / UPC-A (12) / EAN-13 / GTIN-14 with a correct check digit. */
export function isValidGtin(code: unknown): code is string {
  if (typeof code !== 'string' || !/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.charAt(code.length - 1))
}

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new RangeError('EAN-13 body must be 12 digits')
  return gtinCheckDigit(first12)
}

export function isValidEan13(code: unknown): code is string {
  return typeof code === 'string' && /^\d{13}$/.test(code) && isValidGtin(code)
}

/** Appends the check digit: makeEan13('890123456789') → '8901234567892'. */
export function makeEan13(first12: string): string {
  return `${first12}${ean13CheckDigit(first12)}`
}

export const ScaleBarcodeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Barcode prefixes produced by the shop's scales. */
    prefixes: z
      .array(z.string().regex(/^\d{1,3}$/))
      .min(1)
      .default(['21', '22', '23', '24', '25', '26', '27', '28', '29']),
    item_code_length: z.int().min(1).max(10).default(5),
    value_length: z.int().min(1).max(10).default(5),
    /** What the value digits encode. */
    value_type: z.enum(['weight', 'price']).default('weight'),
    /** Value units per base unit (kg): 1000 when the value is grams → qty_milli = grams. */
    weight_unit_divisor: z.int().min(1).max(1_000_000).default(1000),
    /** Value units per rupee: 100 when the value is paise, 10 for 10-paise units, 1 for rupees. */
    price_divisor: z.int().min(1).max(10_000).default(100),
  })
  .refine(
    (c) => c.prefixes.every((p) => p.length + c.item_code_length + c.value_length + 1 === 13),
    {
      message: 'prefix + item code + value + check digit must be 13 digits',
      path: ['prefixes'],
    },
  )
export type ScaleBarcodeConfig = z.infer<typeof ScaleBarcodeConfigSchema>

export interface ScaleBarcode {
  prefix: string
  /** Item code digits as printed (leading zeros kept); compare with normalizePlu(). */
  plu: string
  /** Quantity in milli base units (weight barcodes). */
  qty_milli?: number
  /** Line price in paise (price barcodes). */
  price_paise?: number
}

/** PLU without leading zeros, for matching products.scale_plu ('00123' → '123', '0' → '0'). */
export function normalizePlu(plu: string): string {
  return plu.replace(/^0+(?=\d)/, '')
}

/**
 * Parses a weighing-scale barcode. Returns null when scale barcodes are disabled, the code is
 * not a valid EAN-13, the prefix is not configured, or the value is zero.
 */
export function parseScaleBarcode(code: string, config: ScaleBarcodeConfig): ScaleBarcode | null {
  if (!config.enabled || !isValidEan13(code)) return null
  const prefix = [...config.prefixes]
    .sort((a, b) => b.length - a.length)
    .find((p) => code.startsWith(p))
  if (prefix === undefined) return null
  const plu = code.slice(prefix.length, prefix.length + config.item_code_length)
  const valueStart = prefix.length + config.item_code_length
  const value = Number(code.slice(valueStart, valueStart + config.value_length))
  if (!(value > 0)) return null
  if (config.value_type === 'weight') {
    // qty_milli = value × 1000 / units-per-kg (exact for the default grams encoding).
    const qty = Math.round((value * 1000) / config.weight_unit_divisor)
    return qty > 0 ? { prefix, plu, qty_milli: qty } : null
  }
  return { prefix, plu, price_paise: Math.round((value * 100) / config.price_divisor) }
}

/** Builds a scale barcode (tests, label printing for pre-packed loose items). */
export function makeScaleBarcode(
  prefix: string,
  plu: string,
  value: number,
  config: Pick<ScaleBarcodeConfig, 'item_code_length' | 'value_length'>,
): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('value must be a non-negative integer')
  const pluDigits = plu.padStart(config.item_code_length, '0')
  const valueDigits = String(value).padStart(config.value_length, '0')
  if (pluDigits.length !== config.item_code_length || valueDigits.length !== config.value_length) {
    throw new RangeError('plu or value does not fit the configured lengths')
  }
  const body = `${prefix}${pluDigits}${valueDigits}`
  if (!/^\d{12}$/.test(body)) throw new RangeError('scale barcode body must be 12 digits')
  return makeEan13(body)
}

/** Prefix of shop-generated product barcodes (GS1 restricted circulation, never a scale prefix). */
export const INTERNAL_BARCODE_PREFIX = '20'

/** Shop-generated EAN-13 for products without a manufacturer barcode: '20' + 10-digit sequence + check. */
export function generateInternalBarcode(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > 9_999_999_999) {
    throw new RangeError('seq must be an integer between 0 and 9999999999')
  }
  return makeEan13(`${INTERNAL_BARCODE_PREFIX}${String(seq).padStart(10, '0')}`)
}

export function isInternalBarcode(code: string): boolean {
  return isValidEan13(code) && code.startsWith(INTERNAL_BARCODE_PREFIX)
}
