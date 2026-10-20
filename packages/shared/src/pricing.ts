/**
 * Line & document pricing engine (ARCHITECTURE.md §9.1). The SAME functions price a cart in the
 * POS (also offline) and on the server, which recomputes every document and is authoritative.
 *
 * All amounts are integer paise, quantities integer milli base units, rates basis points.
 * Every division rounds half away from zero ({@link roundDiv}); products that could leave the
 * safe-integer range are computed with BigInt ({@link mulDiv}).
 *
 *   gross       = round(unit_price × qty_milli / (pack_size × 1000))
 *   item_disc   = min(gross, discount_paise + round(gross × discount_bp / 10000))
 *   net         = gross − item_disc − allocated_bill_discount               (≥ 0)
 *   if tax_mode ≠ regular or gst rate = 0:  taxable = net; taxes = 0
 *   elif inclusive: taxable = round(net × 10000 / (10000 + gst_bp + cess_bp))
 *                   cess = round(taxable × cess_bp / 10000); gst = net − taxable − cess
 *   else:           taxable = net; cess = round(taxable × cess_bp / 10000)
 *                   gst = round(taxable × gst_bp / 10000)
 *   interstate → igst = gst; else sgst = ⌊gst / 2⌋, cgst = gst − sgst
 *   line_total = taxable + gst + cess
 */
import { z } from 'zod'
import { GST_RATES_BP, splitGst } from './gst'
import { allocateProRata, assertNonNegativeInt, assertSafeInt, mulDiv, sumSafe } from './math'
import { roundToRupee } from './money'

const BP = 10_000

export type TaxMode = 'regular' | 'composition' | 'unregistered'
export type RoundOffMode = 'nearest_rupee' | 'none'

// ---------------------------------------------------------------------------------------------
// Price-slab GST rules (tax_slab_rules.slabs)
// ---------------------------------------------------------------------------------------------

/** One slab: applies while the per-piece taxable value is ≤ max (null = no upper bound). */
export const TaxSlabSchema = z.object({
  max_unit_value_paise: z.int().min(0).nullable(),
  gst_rate_bp: z.literal(GST_RATES_BP),
})
export type TaxSlab = z.infer<typeof TaxSlabSchema>

/** Slabs ordered by strictly ascending max value; only the last may be open-ended (null). */
export const TaxSlabsSchema = z
  .array(TaxSlabSchema)
  .min(1)
  .max(10)
  .superRefine((slabs, ctx) => {
    slabs.forEach((slab, i) => {
      const prev = slabs[i - 1]
      if (slab.max_unit_value_paise === null && i !== slabs.length - 1) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'max_unit_value_paise'],
          message: 'only the last slab may be open-ended',
        })
      }
      if (
        prev &&
        prev.max_unit_value_paise !== null &&
        slab.max_unit_value_paise !== null &&
        slab.max_unit_value_paise <= prev.max_unit_value_paise
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'max_unit_value_paise'],
          message: 'slabs must be in ascending order',
        })
      }
    })
  })

export interface SlabRateInput {
  /** Line value after all discounts (inclusive or exclusive of tax per `price_includes_tax`). */
  net_paise: number
  qty_milli: number
  /** Accepted for convenience; the threshold is per piece = per base unit (qty_milli / 1000). */
  pack_size?: number
  price_includes_tax: boolean
  cess_rate_bp?: number
}

export interface SlabRateResult {
  gst_rate_bp: number
  slab_index: number
}

/**
 * Resolves the GST rate of a price-slab rule (e.g. apparel ≤ ₹2,500 per piece → 5%, else 18%).
 * For each slab in ascending order the per-piece taxable value at that slab's rate is
 * value = net ÷ pieces (exclusive) or net × 10000 ÷ ((10000 + rate + cess) × pieces)
 * (inclusive); the first slab whose max is ≥ value (or null) applies. The comparison is exact
 * (rational cross-multiplication, no rounding). Falls back to the last slab.
 */
export function resolveSlabRate(slabs: readonly TaxSlab[], input: SlabRateInput): SlabRateResult {
  if (slabs.length === 0) throw new RangeError('at least one tax slab is required')
  assertNonNegativeInt(input.net_paise, 'net_paise')
  assertSafeInt(input.qty_milli, 'qty_milli')
  if (input.qty_milli <= 0) throw new RangeError('qty_milli must be > 0')
  const cess = BigInt(input.cess_rate_bp ?? 0)
  const net = BigInt(input.net_paise)
  const qty = BigInt(input.qty_milli)

  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i]!
    if (slab.max_unit_value_paise === null) return { gst_rate_bp: slab.gst_rate_bp, slab_index: i }
    const max = BigInt(slab.max_unit_value_paise)
    // value = net × 1000 / qty_milli (exclusive) — compare net × 1000 ≤ max × qty.
    // inclusive: value = net × 1000 × 10000 / (qty × (10000 + rate + cess)).
    const fits = input.price_includes_tax
      ? net * 1000n * 10_000n <= max * qty * (10_000n + BigInt(slab.gst_rate_bp) + cess)
      : net * 1000n <= max * qty
    if (fits) return { gst_rate_bp: slab.gst_rate_bp, slab_index: i }
  }
  const last = slabs.length - 1
  return { gst_rate_bp: slabs[last]!.gst_rate_bp, slab_index: last }
}

// ---------------------------------------------------------------------------------------------
// Sales lines & documents
// ---------------------------------------------------------------------------------------------

export interface LineInput {
  /** Caller's line identifier (cart line id / line_no); echoed in the result. */
  key: string
  /** Price per pack of `pack_size` base units, as entered (inclusive or exclusive of tax). */
  unit_price_paise: number
  qty_milli: number
  /** Default 1. */
  pack_size?: number
  price_includes_tax: boolean
  /** Used unless `tax_slabs` is given. */
  gst_rate_bp: number
  cess_rate_bp?: number
  /** Percentage line discount (bp of gross). */
  discount_bp?: number
  /** Flat line discount (paise), added to the percentage discount. */
  discount_paise?: number
  /** MRP per pack, for "You saved ₹x". */
  mrp_paise?: number | null
  /** Free quantity (not charged; counts towards MRP savings). */
  free_qty_milli?: number
  /** Price-slab rule: when present the rate is resolved from the final net value. */
  tax_slabs?: readonly TaxSlab[] | null
}

export interface LineOptions {
  is_interstate: boolean
  tax_mode: TaxMode
  /** This line's share of the bill discount (computeDocument allocates it). */
  allocated_bill_discount_paise?: number
}

export interface LineResult {
  key: string
  gross_paise: number
  item_discount_paise: number
  bill_discount_paise: number
  /** item + bill discount (the `discount_paise` column of invoice lines). */
  discount_paise: number
  taxable_paise: number
  /** Effective rate charged: 0 when no tax is charged (composition / unregistered). */
  gst_rate_bp: number
  cess_rate_bp: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  total_paise: number
  mrp_savings_paise: number
}

interface PreparedLine {
  line: LineInput
  packSize: number
  gross: number
  itemDiscount: number
  netBeforeBill: number
}

function prepareLine(line: LineInput): PreparedLine {
  const packSize = line.pack_size ?? 1
  assertSafeInt(line.unit_price_paise, 'unit_price_paise')
  if (line.unit_price_paise < 0) throw new RangeError('unit_price_paise must be >= 0')
  assertSafeInt(line.qty_milli, 'qty_milli')
  if (line.qty_milli <= 0) throw new RangeError('qty_milli must be > 0')
  assertSafeInt(packSize, 'pack_size')
  if (packSize < 1) throw new RangeError('pack_size must be >= 1')
  assertRate(line.gst_rate_bp, 'gst_rate_bp', BP)
  assertRate(line.cess_rate_bp ?? 0, 'cess_rate_bp', 3 * BP)
  assertRate(line.discount_bp ?? 0, 'discount_bp', BP)
  assertNonNegativeInt(line.discount_paise ?? 0, 'discount_paise')
  assertNonNegativeInt(line.free_qty_milli ?? 0, 'free_qty_milli')
  if (line.mrp_paise != null) assertNonNegativeInt(line.mrp_paise, 'mrp_paise')

  const gross = mulDiv(line.unit_price_paise, line.qty_milli, packSize * 1000)
  const pctDiscount = mulDiv(gross, line.discount_bp ?? 0, BP)
  const itemDiscount = Math.min(gross, sumSafe([line.discount_paise ?? 0, pctDiscount]))
  return { line, packSize, gross, itemDiscount, netBeforeBill: gross - itemDiscount }
}

function assertRate(value: number, name: string, max: number): void {
  assertNonNegativeInt(value, name)
  if (value > max) throw new RangeError(`${name} must be <= ${max}`)
}

function finishLine(p: PreparedLine, opts: LineOptions): LineResult {
  const { line } = p
  const requestedBill = opts.allocated_bill_discount_paise ?? 0
  assertNonNegativeInt(requestedBill, 'allocated_bill_discount_paise')
  const billDiscount = Math.min(requestedBill, p.netBeforeBill)
  const net = p.netBeforeBill - billDiscount

  const charged = opts.tax_mode === 'regular'
  let gstRate = line.gst_rate_bp
  if (charged && line.tax_slabs && line.tax_slabs.length > 0) {
    gstRate = resolveSlabRate(line.tax_slabs, {
      net_paise: net,
      qty_milli: line.qty_milli,
      price_includes_tax: line.price_includes_tax,
      cess_rate_bp: line.cess_rate_bp ?? 0,
    }).gst_rate_bp
  }
  const cessRate = line.cess_rate_bp ?? 0

  let taxable: number
  let gst: number
  let cess: number
  if (!charged || gstRate === 0) {
    taxable = net
    gst = 0
    cess = 0
  } else if (line.price_includes_tax) {
    taxable = mulDiv(net, BP, BP + gstRate + cessRate)
    cess = mulDiv(taxable, cessRate, BP)
    // With very high cess on a few paise, independent rounding could push taxable + cess past
    // net; cap cess so GST is never negative and the inclusive total still equals net exactly.
    if (taxable + cess > net) cess = net - taxable
    gst = net - taxable - cess
  } else {
    taxable = net
    cess = mulDiv(taxable, cessRate, BP)
    gst = mulDiv(taxable, gstRate, BP)
  }

  let cgst = 0
  let sgst = 0
  let igst = 0
  if (opts.is_interstate) {
    igst = gst
  } else {
    const split = splitGst(gst)
    cgst = split.cgst_paise
    sgst = split.sgst_paise
  }
  const total = sumSafe([taxable, gst, cess])

  let mrpSavings = 0
  if (line.mrp_paise != null) {
    const mrpValue = mulDiv(
      line.mrp_paise,
      sumSafe([line.qty_milli, line.free_qty_milli ?? 0]),
      p.packSize * 1000,
    )
    mrpSavings = Math.max(0, mrpValue - total)
  }

  return {
    key: line.key,
    gross_paise: p.gross,
    item_discount_paise: p.itemDiscount,
    bill_discount_paise: billDiscount,
    discount_paise: p.itemDiscount + billDiscount,
    taxable_paise: taxable,
    gst_rate_bp: charged ? gstRate : 0,
    cess_rate_bp: charged && gstRate !== 0 ? cessRate : 0,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    cess_paise: cess,
    total_paise: total,
    mrp_savings_paise: mrpSavings,
  }
}

/** Prices one line (see the module comment for the formula). */
export function computeLine(line: LineInput, opts: LineOptions): LineResult {
  return finishLine(prepareLine(line), opts)
}

/** Gross − item discount of a line: the weight used to allocate the bill discount. */
export function lineNetBeforeBillDiscount(line: LineInput): number {
  return prepareLine(line).netBeforeBill
}

export interface DocumentInput {
  lines: readonly LineInput[]
  is_interstate: boolean
  tax_mode: TaxMode
  /** Bill-level percentage discount (bp of Σ line net after item discounts). */
  bill_discount_bp?: number
  /** Bill-level flat discount (paise), added to the percentage part. */
  bill_discount_paise?: number
  round_off: RoundOffMode
}

export interface TaxBreakupRow {
  gst_rate_bp: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
}

export interface DocumentResult {
  lines: LineResult[]
  gross_paise: number
  item_discount_paise: number
  bill_discount_paise: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  /** cgst + sgst + igst + cess */
  tax_paise: number
  round_off_paise: number
  /** taxable + tax + round_off (amount payable) */
  total_paise: number
  mrp_savings_paise: number
  /** Totals per GST rate, ascending by rate (invoice tax summary, GSTR-1 rate split). */
  tax_breakup: TaxBreakupRow[]
}

/**
 * Prices a whole document.
 *
 * Bill discount = min(Σ net, bill_discount_paise + round(Σ net × bill_discount_bp / 10000)),
 * where net = gross − item discount; it is allocated to lines pro-rata to net with the
 * largest-remainder method so allocations sum exactly and never exceed a line's net.
 * When prices include tax the bill discount (like item discounts) is taken off the
 * tax-inclusive values and tax is then backed out of the reduced amount.
 * Round-off (nearest rupee, |round_off| ≤ 50) applies to taxable + taxes.
 */
export function computeDocument(input: DocumentInput): DocumentResult {
  assertUniqueKeys(input.lines.map((l) => l.key))
  const prepared = input.lines.map(prepareLine)
  const weights = prepared.map((p) => p.netBeforeBill)
  const netTotal = sumSafe(weights)

  const billBp = input.bill_discount_bp ?? 0
  const billFlat = input.bill_discount_paise ?? 0
  assertRate(billBp, 'bill_discount_bp', BP)
  assertNonNegativeInt(billFlat, 'bill_discount_paise')
  const billDiscount = Math.min(netTotal, sumSafe([billFlat, mulDiv(netTotal, billBp, BP)]))
  const allocations = allocateProRata(billDiscount, weights)

  const lines = prepared.map((p, i) =>
    finishLine(p, {
      is_interstate: input.is_interstate,
      tax_mode: input.tax_mode,
      allocated_bill_discount_paise: allocations[i] ?? 0,
    }),
  )

  const sum = (pick: (l: LineResult) => number): number => sumSafe(lines.map(pick))
  const taxable = sum((l) => l.taxable_paise)
  const cgst = sum((l) => l.cgst_paise)
  const sgst = sum((l) => l.sgst_paise)
  const igst = sum((l) => l.igst_paise)
  const cess = sum((l) => l.cess_paise)
  const tax = sumSafe([cgst, sgst, igst, cess])
  const beforeRounding = taxable + tax
  const roundOff =
    input.round_off === 'nearest_rupee' ? roundToRupee(beforeRounding).round_off_paise : 0

  return {
    lines,
    gross_paise: sum((l) => l.gross_paise),
    item_discount_paise: sum((l) => l.item_discount_paise),
    bill_discount_paise: sum((l) => l.bill_discount_paise),
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    cess_paise: cess,
    tax_paise: tax,
    round_off_paise: roundOff,
    total_paise: beforeRounding + roundOff,
    mrp_savings_paise: sum((l) => l.mrp_savings_paise),
    tax_breakup: taxBreakup(lines),
  }
}

/** Groups line amounts by GST rate (ascending). */
export function taxBreakup(
  lines: ReadonlyArray<
    Pick<
      LineResult,
      'gst_rate_bp' | 'taxable_paise' | 'cgst_paise' | 'sgst_paise' | 'igst_paise' | 'cess_paise'
    >
  >,
): TaxBreakupRow[] {
  const byRate = new Map<number, TaxBreakupRow>()
  for (const l of lines) {
    const row = byRate.get(l.gst_rate_bp) ?? {
      gst_rate_bp: l.gst_rate_bp,
      taxable_paise: 0,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 0,
      cess_paise: 0,
    }
    row.taxable_paise += l.taxable_paise
    row.cgst_paise += l.cgst_paise
    row.sgst_paise += l.sgst_paise
    row.igst_paise += l.igst_paise
    row.cess_paise += l.cess_paise
    byRate.set(l.gst_rate_bp, row)
  }
  return [...byRate.values()].sort((a, b) => a.gst_rate_bp - b.gst_rate_bp)
}

function assertUniqueKeys(keys: readonly string[]): void {
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) throw new RangeError(`duplicate line key: ${key}`)
    seen.add(key)
  }
}

// ---------------------------------------------------------------------------------------------
// Returns (credit / debit notes): proportional tax amounts
// ---------------------------------------------------------------------------------------------

export interface TaxAmounts {
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
}

export interface ProrateOptions {
  /** Quantity being returned now. */
  qty_milli: number
  /** Quantity of the original line (charged quantity). */
  total_qty_milli: number
  /** Quantity already returned earlier against the same line. Default 0. */
  already_returned_milli?: number
}

/**
 * Share of an original line's amounts for a partial return, per tax head.
 * Uses cumulative rounding — share = round(x × (before + qty) / total) − round(x × before / total)
 * — so successive partial returns add up to exactly the original amounts when everything has
 * been returned (no paisa left over or over-refunded).
 */
export function prorateAmounts(
  amounts: TaxAmounts,
  opts: ProrateOptions,
): TaxAmounts & { total_paise: number } {
  const before = opts.already_returned_milli ?? 0
  assertNonNegativeInt(before, 'already_returned_milli')
  assertSafeInt(opts.qty_milli, 'qty_milli')
  assertSafeInt(opts.total_qty_milli, 'total_qty_milli')
  if (opts.qty_milli <= 0) throw new RangeError('qty_milli must be > 0')
  if (opts.total_qty_milli <= 0) throw new RangeError('total_qty_milli must be > 0')
  if (before + opts.qty_milli > opts.total_qty_milli)
    throw new RangeError('cannot return more than the original quantity')
  const after = before + opts.qty_milli
  const share = (x: number): number =>
    mulDiv(x, after, opts.total_qty_milli) - mulDiv(x, before, opts.total_qty_milli)
  const result = {
    taxable_paise: share(amounts.taxable_paise),
    cgst_paise: share(amounts.cgst_paise),
    sgst_paise: share(amounts.sgst_paise),
    igst_paise: share(amounts.igst_paise),
    cess_paise: share(amounts.cess_paise),
  }
  return {
    ...result,
    total_paise: sumSafe([
      result.taxable_paise,
      result.cgst_paise,
      result.sgst_paise,
      result.igst_paise,
      result.cess_paise,
    ]),
  }
}

// ---------------------------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------------------------

export interface PurchaseLineBase {
  key?: string
  /** Supplier rate per pack, excluding tax, before discount. */
  unit_cost_paise: number
  qty_milli: number
  free_qty_milli?: number
  pack_size?: number
  discount_bp?: number
  discount_paise?: number
  gst_rate_bp: number
  cess_rate_bp?: number
}

export interface PurchaseLineInput extends PurchaseLineBase {
  is_interstate: boolean
}

export interface PurchaseLineResult {
  key?: string
  gross_paise: number
  discount_paise: number
  taxable_paise: number
  gst_rate_bp: number
  cess_rate_bp: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  /** cgst + sgst + igst + cess */
  tax_paise: number
  total_paise: number
}

/**
 * Purchase bill line (rates exclusive of tax): gross = round(cost × qty / (pack × 1000)) —
 * free quantity is not charged; discount = min(gross, flat + round(gross × bp / 10000));
 * taxable = gross − discount; GST and cess on taxable; split CGST/SGST or IGST.
 */
export function computePurchaseLine(input: PurchaseLineInput): PurchaseLineResult {
  const packSize = input.pack_size ?? 1
  assertNonNegativeInt(input.unit_cost_paise, 'unit_cost_paise')
  assertSafeInt(input.qty_milli, 'qty_milli')
  if (input.qty_milli <= 0) throw new RangeError('qty_milli must be > 0')
  assertNonNegativeInt(input.free_qty_milli ?? 0, 'free_qty_milli')
  assertSafeInt(packSize, 'pack_size')
  if (packSize < 1) throw new RangeError('pack_size must be >= 1')
  assertRate(input.discount_bp ?? 0, 'discount_bp', BP)
  assertNonNegativeInt(input.discount_paise ?? 0, 'discount_paise')
  assertRate(input.gst_rate_bp, 'gst_rate_bp', BP)
  const cessRate = input.cess_rate_bp ?? 0
  assertRate(cessRate, 'cess_rate_bp', 3 * BP)

  const gross = mulDiv(input.unit_cost_paise, input.qty_milli, packSize * 1000)
  const discount = Math.min(
    gross,
    sumSafe([input.discount_paise ?? 0, mulDiv(gross, input.discount_bp ?? 0, BP)]),
  )
  const taxable = gross - discount
  const gst = mulDiv(taxable, input.gst_rate_bp, BP)
  const cess = mulDiv(taxable, cessRate, BP)
  const { cgst_paise, sgst_paise } = input.is_interstate
    ? { cgst_paise: 0, sgst_paise: 0 }
    : splitGst(gst)
  return {
    ...(input.key !== undefined ? { key: input.key } : {}),
    gross_paise: gross,
    discount_paise: discount,
    taxable_paise: taxable,
    gst_rate_bp: input.gst_rate_bp,
    cess_rate_bp: cessRate,
    cgst_paise,
    sgst_paise,
    igst_paise: input.is_interstate ? gst : 0,
    cess_paise: cess,
    tax_paise: gst + cess,
    total_paise: sumSafe([taxable, gst, cess]),
  }
}

export interface LandedCostInput {
  taxable_paise: number
  /** This line's share of freight / other charges. */
  other_charges_alloc_paise: number
  /** Tax that cannot be claimed as input credit (itc_eligible = false) and is therefore cost. */
  non_itc_tax_paise: number
  qty_milli: number
  free_qty_milli: number
  pack_size: number
}

/**
 * Landed cost per pack, spreading the cost over charged + free quantity:
 * round((taxable + other charges + non-ITC tax) × pack_size × 1000 / (qty + free)).
 */
export function landedUnitCostPaise(input: LandedCostInput): number {
  assertNonNegativeInt(input.taxable_paise, 'taxable_paise')
  assertNonNegativeInt(input.other_charges_alloc_paise, 'other_charges_alloc_paise')
  assertNonNegativeInt(input.non_itc_tax_paise, 'non_itc_tax_paise')
  assertNonNegativeInt(input.free_qty_milli, 'free_qty_milli')
  assertSafeInt(input.qty_milli, 'qty_milli')
  assertSafeInt(input.pack_size, 'pack_size')
  if (input.pack_size < 1) throw new RangeError('pack_size must be >= 1')
  const units = sumSafe([input.qty_milli, input.free_qty_milli])
  if (units <= 0) throw new RangeError('qty_milli + free_qty_milli must be > 0')
  const cost = sumSafe([
    input.taxable_paise,
    input.other_charges_alloc_paise,
    input.non_itc_tax_paise,
  ])
  return mulDiv(cost, input.pack_size * 1000, units)
}

export interface PurchaseDocumentInput {
  lines: readonly PurchaseLineBase[]
  is_interstate: boolean
  /** Freight / loading etc. on the bill, capitalised into inventory cost (not taxed here). */
  other_charges_paise?: number
  round_off: RoundOffMode
  /** When false, GST paid is added to inventory cost instead of input credit. Default true. */
  itc_eligible?: boolean
}

export interface PurchaseDocumentLineResult extends PurchaseLineResult {
  other_charges_alloc_paise: number
  landed_unit_cost_paise: number
}

export interface PurchaseDocumentResult {
  lines: PurchaseDocumentLineResult[]
  gross_paise: number
  discount_paise: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  tax_paise: number
  other_charges_paise: number
  round_off_paise: number
  /** taxable + tax + other charges + round_off (purchase_bills CHECK). */
  total_paise: number
  tax_breakup: TaxBreakupRow[]
}

/**
 * Prices a purchase bill: lines, other charges allocated pro-rata to taxable value (largest
 * remainder), landed cost per pack, and round-off of the payable total.
 */
export function computePurchaseDocument(input: PurchaseDocumentInput): PurchaseDocumentResult {
  const otherCharges = input.other_charges_paise ?? 0
  assertNonNegativeInt(otherCharges, 'other_charges_paise')
  const itc = input.itc_eligible ?? true
  const base = input.lines.map((l) =>
    computePurchaseLine({ ...l, is_interstate: input.is_interstate }),
  )
  const allocations = allocateProRata(
    otherCharges,
    base.map((l) => l.taxable_paise),
  )
  const lines = base.map((l, i): PurchaseDocumentLineResult => {
    const src = input.lines[i]!
    const alloc = allocations[i] ?? 0
    return {
      ...l,
      other_charges_alloc_paise: alloc,
      landed_unit_cost_paise: landedUnitCostPaise({
        taxable_paise: l.taxable_paise,
        other_charges_alloc_paise: alloc,
        non_itc_tax_paise: itc ? 0 : l.tax_paise,
        qty_milli: src.qty_milli,
        free_qty_milli: src.free_qty_milli ?? 0,
        pack_size: src.pack_size ?? 1,
      }),
    }
  })
  const sum = (pick: (l: PurchaseLineResult) => number): number => sumSafe(lines.map(pick))
  const taxable = sum((l) => l.taxable_paise)
  const cgst = sum((l) => l.cgst_paise)
  const sgst = sum((l) => l.sgst_paise)
  const igst = sum((l) => l.igst_paise)
  const cess = sum((l) => l.cess_paise)
  const tax = sumSafe([cgst, sgst, igst, cess])
  const beforeRounding = sumSafe([taxable, tax, otherCharges])
  const roundOff =
    input.round_off === 'nearest_rupee' ? roundToRupee(beforeRounding).round_off_paise : 0
  return {
    lines,
    gross_paise: sum((l) => l.gross_paise),
    discount_paise: sum((l) => l.discount_paise),
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    cess_paise: cess,
    tax_paise: tax,
    other_charges_paise: otherCharges,
    round_off_paise: roundOff,
    total_paise: beforeRounding + roundOff,
    tax_breakup: taxBreakup(lines),
  }
}
