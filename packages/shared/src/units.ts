/**
 * Units of measure. Quantities are integer milli base units (`qty_milli`, 1 unit = 1000) and
 * product prices are per PACK of `pack_size` base units (ARCHITECTURE.md §5):
 *   amount = round(price_per_pack × qty_milli / (pack_size × 1000))
 */
import { assertNonNegativeInt, assertSafeInt, mulDiv } from './math'

export type UnitFamily = 'count' | 'weight' | 'volume' | 'length' | 'area' | 'pack'

export interface UnitDef {
  code: string
  name_en: string
  name_ta: string
  /** GST Unique Quantity Code used in GSTR-1 HSN summary. */
  uqc: string
  /** Fractional quantities allowed by default (weighed / measured goods). */
  decimal_allowed: boolean
  family: UnitFamily
  /** Short label for quantities: singular / plural (English) and Tamil. */
  symbol_en: string
  symbol_en_plural: string
  symbol_ta: string
}

const u = (
  code: string,
  name_en: string,
  name_ta: string,
  uqc: string,
  decimal_allowed: boolean,
  family: UnitFamily,
  symbol_en: string,
  symbol_en_plural: string,
  symbol_ta: string,
): UnitDef => ({ code, name_en, name_ta, uqc, decimal_allowed, family, symbol_en, symbol_en_plural, symbol_ta })

/** Supported unit catalogue (`products.unit` stores the code). */
export const UNITS: readonly UnitDef[] = [
  u('PCS', 'Pieces', 'துண்டுகள்', 'NOS', false, 'count', 'pc', 'pcs', 'எண்'),
  u('KG', 'Kilogram', 'கிலோகிராம்', 'KGS', true, 'weight', 'kg', 'kg', 'கிலோ'),
  u('G', 'Gram', 'கிராம்', 'GMS', true, 'weight', 'g', 'g', 'கிராம்'),
  u('QTL', 'Quintal', 'குவிண்டால்', 'QTL', true, 'weight', 'qtl', 'qtl', 'குவிண்டால்'),
  u('L', 'Litre', 'லிட்டர்', 'LTR', true, 'volume', 'L', 'L', 'லி'),
  u('ML', 'Millilitre', 'மில்லிலிட்டர்', 'MLT', true, 'volume', 'ml', 'ml', 'மி.லி'),
  u('M', 'Metre', 'மீட்டர்', 'MTR', true, 'length', 'm', 'm', 'மீ'),
  u('CM', 'Centimetre', 'சென்டிமீட்டர்', 'CMS', true, 'length', 'cm', 'cm', 'செ.மீ'),
  u('SQFT', 'Square feet', 'சதுர அடி', 'SQF', true, 'area', 'sq ft', 'sq ft', 'ச.அடி'),
  u('BOX', 'Box', 'பெட்டி', 'BOX', false, 'pack', 'box', 'boxes', 'பெட்டி'),
  u('PACK', 'Pack', 'பேக்', 'PAC', false, 'pack', 'pack', 'packs', 'பேக்'),
  u('DOZ', 'Dozen', 'டஜன்', 'DOZ', false, 'count', 'doz', 'doz', 'டஜன்'),
  u('PAIR', 'Pair', 'ஜோடி', 'PRS', false, 'count', 'pair', 'pairs', 'ஜோடி'),
  u('SET', 'Set', 'செட்', 'SET', false, 'count', 'set', 'sets', 'செட்'),
  u('STRIP', 'Strip', 'அட்டை', 'OTH', false, 'pack', 'strip', 'strips', 'அட்டை'),
  u('TAB', 'Tablet', 'மாத்திரை', 'TBS', false, 'count', 'tab', 'tabs', 'மாத்திரை'),
  u('CAP', 'Capsule', 'கேப்சூல்', 'OTH', false, 'count', 'cap', 'caps', 'கேப்சூல்'),
  u('BTL', 'Bottle', 'பாட்டில்', 'BTL', false, 'pack', 'btl', 'btls', 'பாட்டில்'),
  u('CAN', 'Can', 'டின்', 'CAN', false, 'pack', 'can', 'cans', 'டின்'),
  u('BAG', 'Bag', 'பை', 'BAG', false, 'pack', 'bag', 'bags', 'பை'),
  u('ROLL', 'Roll', 'ரோல்', 'ROL', false, 'pack', 'roll', 'rolls', 'ரோல்'),
  u('BUNDLE', 'Bundle', 'கட்டு', 'BDL', false, 'pack', 'bundle', 'bundles', 'கட்டு'),
  u('PKT', 'Packet', 'பாக்கெட்', 'PAC', false, 'pack', 'pkt', 'pkts', 'பாக்கெட்'),
  u('NOS', 'Numbers', 'எண்ணிக்கை', 'NOS', false, 'count', 'no', 'nos', 'எண்'),
  u('TUBE', 'Tube', 'டியூப்', 'TUB', false, 'pack', 'tube', 'tubes', 'டியூப்'),
  u('VIAL', 'Vial', 'குப்பி', 'OTH', false, 'pack', 'vial', 'vials', 'குப்பி'),
  u('SACHET', 'Sachet', 'சாஷே', 'OTH', false, 'pack', 'sachet', 'sachets', 'சாஷே'),
]

export const UNIT_CODES: readonly string[] = UNITS.map((x) => x.code)

const UNIT_BY_CODE: ReadonlyMap<string, UnitDef> = new Map(UNITS.map((x) => [x.code, x]))

/** Unit definition by code (case-insensitive), or undefined for unknown codes. */
export function getUnit(code: string): UnitDef | undefined {
  return UNIT_BY_CODE.get(code.toUpperCase())
}

export function isUnitCode(code: string): boolean {
  return UNIT_BY_CODE.has(code.toUpperCase())
}

/** True when the unit allows fractional quantities by default (unknown units: false). */
export function isDecimalUnit(code: string): boolean {
  return getUnit(code)?.decimal_allowed ?? false
}

/** GST UQC for a unit code ('OTH' for unknown units). */
export function uqcFor(code: string): string {
  return getUnit(code)?.uqc ?? 'OTH'
}

export interface ParseQtyOptions {
  /** Override the unit default (e.g. product.decimal_qty / allow_loose). */
  allowDecimal?: boolean
}

const QTY_RE = /^(\d+)?(?:\.(\d*))?$/

/**
 * Parses a positive quantity typed in base units into milli units: "1.5" kg → 1500,
 * "2" pcs → 2000. At most 3 decimals; fractions only for decimal units (or allowDecimal).
 * @throws RangeError for invalid, zero or negative input.
 */
export function parseQty(input: string, unit: string, options: ParseQtyOptions = {}): number {
  const qty = tryParseQty(input, unit, options)
  if (qty === null) throw new RangeError(`invalid quantity ${JSON.stringify(input)} for unit ${unit}`)
  return qty
}

/** Like {@link parseQty} but returns null instead of throwing. */
export function tryParseQty(input: string, unit: string, options: ParseQtyOptions = {}): number | null {
  if (typeof input !== 'string') return null
  const m = QTY_RE.exec(input.trim())
  if (!m) return null
  const intPart = m[1] ?? ''
  const fracPart = m[2] ?? ''
  if (intPart === '' && fracPart === '') return null
  if (fracPart.length > 3) return null
  const decimalAllowed = options.allowDecimal ?? isDecimalUnit(unit)
  if (!decimalAllowed && /[1-9]/.test(fracPart)) return null
  const milli = Number(intPart || '0') * 1000 + Number(fracPart.padEnd(3, '0'))
  if (!Number.isSafeInteger(milli) || milli <= 0) return null
  return milli
}

let intFormatter: Intl.NumberFormat | undefined

/** Milli units as a plain decimal string with trailing zeros removed: 1500 → "1.5". */
export function milliToDecimalString(qtyMilli: number, grouping = false): string {
  assertSafeInt(qtyMilli, 'qtyMilli')
  const abs = Math.abs(qtyMilli)
  const frac = abs % 1000
  const whole = (abs - frac) / 1000
  intFormatter ??= new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
  const wholeText = grouping ? intFormatter.format(whole) : String(whole)
  const fracText = frac === 0 ? '' : `.${String(frac).padStart(3, '0').replace(/0+$/, '')}`
  return `${qtyMilli < 0 ? '-' : ''}${wholeText}${fracText}`
}

/**
 * Quantity with its unit label: (1500, 'KG') → "1.5 kg", (2000, 'PCS') → "2 pcs",
 * (1000, 'PCS') → "1 pc", (2000, 'PCS', 'ta') → "2 எண்". Unknown units print their code.
 */
export function formatQty(qtyMilli: number, unit: string, locale: 'en' | 'ta' = 'en'): string {
  const def = getUnit(unit)
  const value = milliToDecimalString(qtyMilli, true)
  if (!def) return `${value} ${unit}`
  if (locale === 'ta') return `${value} ${def.symbol_ta}`
  return `${value} ${qtyMilli === 1000 ? def.symbol_en : def.symbol_en_plural}`
}

/**
 * Line amount for a quantity at a per-pack price:
 * round(price × qty_milli / (pack_size × 1000)), exact (BigInt when the product is large).
 * e.g. strip of 10 tablets at ₹35.00, 3 tablets → amountForQty(3500, 3000, 10) = 1050.
 */
export function amountForQty(pricePerPackPaise: number, qtyMilli: number, packSize = 1): number {
  assertSafeInt(pricePerPackPaise, 'pricePerPackPaise')
  assertSafeInt(qtyMilli, 'qtyMilli')
  assertPackSize(packSize)
  return mulDiv(pricePerPackPaise, qtyMilli, packSize * 1000)
}

/** Per-base-unit price from a per-pack price (rounded): strip ₹35 / 10 tabs → 350 paise. */
export function unitPriceFromPack(pricePerPackPaise: number, packSize = 1): number {
  return amountForQty(pricePerPackPaise, 1000, packSize)
}

export interface PacksAndLoose {
  /** Whole packs contained in the quantity. */
  packs: number
  /** Remaining base units (milli) that do not fill a pack. */
  loose_milli: number
}

/** Splits a quantity into whole packs and loose units: (23000, 10) → { packs: 2, loose_milli: 3000 }. */
export function packsAndLoose(qtyMilli: number, packSize: number): PacksAndLoose {
  assertSafeInt(qtyMilli, 'qtyMilli')
  assertPackSize(packSize)
  const perPack = packSize * 1000
  const abs = Math.abs(qtyMilli)
  const loose = abs % perPack
  const packs = (abs - loose) / perPack
  const sign = qtyMilli < 0 ? -1 : 1
  return { packs: packs * sign + 0, loose_milli: loose * sign + 0 }
}

/**
 * Display of a pack-priced quantity: (23000, 10, 'TAB', 'STRIP') → "2 strips + 3 tabs";
 * (20000, 10, 'TAB', 'STRIP') → "2 strips"; (3000, 10, 'TAB') → "3 tabs".
 */
export function formatPacksAndLoose(
  qtyMilli: number,
  packSize: number,
  unit: string,
  packUnit = 'PACK',
  locale: 'en' | 'ta' = 'en',
): string {
  if (packSize === 1) return formatQty(qtyMilli, unit, locale)
  const { packs, loose_milli } = packsAndLoose(qtyMilli, packSize)
  const parts: string[] = []
  if (packs !== 0) parts.push(formatQty(packs * 1000, packUnit, locale))
  if (loose_milli !== 0 || packs === 0) parts.push(formatQty(loose_milli, unit, locale))
  return parts.join(' + ')
}

function assertPackSize(packSize: number): void {
  assertNonNegativeInt(packSize, 'packSize')
  if (packSize < 1) throw new RangeError('packSize must be >= 1')
}
