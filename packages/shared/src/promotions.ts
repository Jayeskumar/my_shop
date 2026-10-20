/**
 * Promotions engine, evaluated identically in the POS (offline too) and on the server.
 *
 * Kinds (promotions.kind) and their `rules` JSON:
 *  - item_percent  — % off matching items           { targeting, percent_bp, min_qty_milli?, max_discount_paise? }
 *  - item_flat     — ₹ off per unit of matching items { targeting, flat_paise, min_qty_milli?, max_discount_paise? }
 *  - buy_x_get_y   — buy X units get Y units at a discount (default free); the cheapest units are discounted
 *  - bill_percent  — % off the bill                  { percent_bp, min_bill_paise?, max_discount_paise? }
 *  - bill_flat     — ₹ off the bill                  { flat_paise, min_bill_paise? }
 *  - combo_price   — fixed price for a set of items  { items: [{product_id, qty_milli}], combo_price_paise }
 * Targeting: product_ids / category_ids / brand_ids (any match), or all_items; exclude_product_ids wins.
 *
 * Evaluation (deterministic):
 *  1. Active promotions for the store and instant (date window, IST day of week) are ordered by
 *     priority desc, then id.
 *  2. Item level: every item promotion proposes a discount per line (computed on the undiscounted
 *     line amount). Per line the best non-stackable proposal is applied, plus every stackable one;
 *     the line total discount is capped at the line amount.
 *  3. Bill level: on the remaining amount (Σ line amount − item discounts) the best non-stackable
 *     bill promotion plus every stackable one apply, capped at the remaining amount.
 * `stackable` combines promotions within a level; item and bill levels always combine.
 * The output feeds pricing.ts: line discounts → LineInput.discount_paise (added to any manual
 * discount), bill discount → DocumentInput.bill_discount_paise.
 */
import { z } from 'zod'
import { DEFAULT_TIMEZONE, dayOfWeekIn } from './fy'
import { allocateProRata, mulDiv, sumSafe } from './math'
import { amountForQty } from './units'

const BP = 10_000

const zUuid = z.uuid()
const zIds = z.array(zUuid).max(5000)
const zPositiveInt = z.int().min(1)

const TargetingShape = {
  all_items: z.boolean().default(false),
  product_ids: zIds.default([]),
  category_ids: zIds.default([]),
  brand_ids: zIds.default([]),
  exclude_product_ids: zIds.default([]),
}

interface TargetingLike {
  all_items: boolean
  product_ids: string[]
  category_ids: string[]
  brand_ids: string[]
  exclude_product_ids: string[]
}

const hasTarget = (t: TargetingLike): boolean =>
  t.all_items || t.product_ids.length + t.category_ids.length + t.brand_ids.length > 0
const TARGET_MESSAGE = 'select products, categories or brands (or all items)'

export const ItemPercentRulesSchema = z
  .object({
    ...TargetingShape,
    percent_bp: z.int().min(1).max(BP),
    /** Minimum quantity on the line for the offer to apply. */
    min_qty_milli: z.int().min(1).optional(),
    /** Cap per line. */
    max_discount_paise: z.int().min(0).optional(),
  })
  .refine(hasTarget, { message: TARGET_MESSAGE })

export const ItemFlatRulesSchema = z
  .object({
    ...TargetingShape,
    /** Discount per base unit (per piece / kg / tablet): round(flat × qty_milli / 1000). */
    flat_paise: z.int().min(1),
    min_qty_milli: z.int().min(1).optional(),
    max_discount_paise: z.int().min(0).optional(),
  })
  .refine(hasTarget, { message: TARGET_MESSAGE })

export const BuyXGetYRulesSchema = z
  .object({
    ...TargetingShape,
    /** Units (whole base units) to buy. */
    buy_qty: zPositiveInt,
    /** Units given at `get_discount_bp`. */
    get_qty: zPositiveInt,
    /** 10000 = free (default), 5000 = half price. */
    get_discount_bp: z.int().min(1).max(BP).default(BP),
    /** Optional different reward set ("buy toothpaste, get a brush"); default = same set. */
    get_product_ids: zIds.default([]),
    get_category_ids: zIds.default([]),
    get_brand_ids: zIds.default([]),
    /** Maximum number of times the offer applies per bill. */
    max_applications: zPositiveInt.optional(),
  })
  .refine(hasTarget, { message: TARGET_MESSAGE })

export const BillPercentRulesSchema = z.object({
  percent_bp: z.int().min(1).max(BP),
  min_bill_paise: z.int().min(0).optional(),
  max_discount_paise: z.int().min(0).optional(),
})

export const BillFlatRulesSchema = z.object({
  flat_paise: z.int().min(1),
  min_bill_paise: z.int().min(0).optional(),
})

export const ComboPriceRulesSchema = z
  .object({
    items: z
      .array(z.object({ product_id: zUuid, qty_milli: z.int().min(1) }))
      .min(2)
      .max(20),
    /** Price of one complete combo (inclusive/exclusive like the items' prices). */
    combo_price_paise: z.int().min(0),
    max_applications: zPositiveInt.optional(),
  })
  .refine((r) => new Set(r.items.map((i) => i.product_id)).size === r.items.length, {
    message: 'each product may appear only once in a combo',
    path: ['items'],
  })

export const PromotionKindSchema = z.enum([
  'item_percent',
  'item_flat',
  'buy_x_get_y',
  'bill_percent',
  'bill_flat',
  'combo_price',
])
export type PromotionKind = z.infer<typeof PromotionKindSchema>

export const PROMOTION_RULE_SCHEMAS = {
  item_percent: ItemPercentRulesSchema,
  item_flat: ItemFlatRulesSchema,
  buy_x_get_y: BuyXGetYRulesSchema,
  bill_percent: BillPercentRulesSchema,
  bill_flat: BillFlatRulesSchema,
  combo_price: ComboPriceRulesSchema,
} as const satisfies Record<PromotionKind, z.ZodType>

export type ItemPercentRules = z.infer<typeof ItemPercentRulesSchema>
export type ItemFlatRules = z.infer<typeof ItemFlatRulesSchema>
export type BuyXGetYRules = z.infer<typeof BuyXGetYRulesSchema>
export type BillPercentRules = z.infer<typeof BillPercentRulesSchema>
export type BillFlatRules = z.infer<typeof BillFlatRulesSchema>
export type ComboPriceRules = z.infer<typeof ComboPriceRulesSchema>

/** Validates `rules` JSON for a kind (e.g. a row read from the database). */
export function parsePromotionRules<K extends PromotionKind>(
  kind: K,
  rules: unknown,
): z.infer<(typeof PROMOTION_RULE_SCHEMAS)[K]> {
  return PROMOTION_RULE_SCHEMAS[kind].parse(rules) as z.infer<(typeof PROMOTION_RULE_SCHEMAS)[K]>
}

const zTimestamp = z.iso.datetime({ offset: true })

const PromotionBase = {
  id: zUuid,
  name: z.string().trim().min(1).max(120),
  name_ta: z.string().trim().max(120).nullable().optional(),
  /** null = all stores. */
  store_ids: z.array(zUuid).nullable().default(null),
  starts_at: zTimestamp.nullable().default(null),
  /** Exclusive end instant. */
  ends_at: zTimestamp.nullable().default(null),
  /** 0 = Sunday … 6 = Saturday (in the tenant timezone); null = every day. */
  days_of_week: z.array(z.int().min(0).max(6)).max(7).nullable().default(null),
  priority: z.int().min(-1000).max(1000).default(0),
  stackable: z.boolean().default(false),
  is_active: z.boolean().default(true),
}

export const PromotionSchema = z
  .discriminatedUnion('kind', [
    z.object({ ...PromotionBase, kind: z.literal('item_percent'), rules: ItemPercentRulesSchema }),
    z.object({ ...PromotionBase, kind: z.literal('item_flat'), rules: ItemFlatRulesSchema }),
    z.object({ ...PromotionBase, kind: z.literal('buy_x_get_y'), rules: BuyXGetYRulesSchema }),
    z.object({ ...PromotionBase, kind: z.literal('bill_percent'), rules: BillPercentRulesSchema }),
    z.object({ ...PromotionBase, kind: z.literal('bill_flat'), rules: BillFlatRulesSchema }),
    z.object({ ...PromotionBase, kind: z.literal('combo_price'), rules: ComboPriceRulesSchema }),
  ])
  .refine((p) => !p.starts_at || !p.ends_at || Date.parse(p.ends_at) > Date.parse(p.starts_at), {
    message: 'ends_at must be after starts_at',
    path: ['ends_at'],
  })
export type Promotion = z.infer<typeof PromotionSchema>

/** Omit that keeps a discriminated union discriminated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A promotion as evaluated: schedule instants may be Date objects (database rows) or ISO strings. */
export type PromotionLike = DistributiveOmit<Promotion, 'starts_at' | 'ends_at'> & {
  starts_at: string | Date | null
  ends_at: string | Date | null
}

export interface PromotionCartLine {
  key: string
  product_id: string
  category_id?: string | null
  brand_id?: string | null
  /** Price per pack (the same price that will be passed to pricing). */
  unit_price_paise: number
  qty_milli: number
  pack_size?: number
}

export interface PromotionContext {
  store_id: string
  now: Date
  /** Tenant timezone for days_of_week (default Asia/Kolkata). */
  timezone?: string
}

export interface LineDiscount {
  discount_paise: number
  promotion_ids: string[]
}

export interface AppliedPromotion {
  promotion_id: string
  name: string
  discount_paise: number
}

export interface PromotionResult {
  /** Every cart key is present (discount 0 when nothing applies). */
  line_discounts: Record<string, LineDiscount>
  bill_discount_paise: number
  /** Promotions that gave a discount, in evaluation order; Σ = line discounts + bill discount. */
  applied: AppliedPromotion[]
}

const toMs = (v: string | Date | null): number | null =>
  v === null ? null : v instanceof Date ? v.getTime() : Date.parse(v)

/** Whether a promotion applies at a store and instant (active flag, store, date window, weekday). */
export function isPromotionActive(promo: PromotionLike, ctx: PromotionContext): boolean {
  if (!promo.is_active) return false
  if (promo.store_ids && !promo.store_ids.includes(ctx.store_id)) return false
  const now = ctx.now.getTime()
  const start = toMs(promo.starts_at)
  const end = toMs(promo.ends_at)
  if (start !== null && now < start) return false
  if (end !== null && now >= end) return false
  if (
    promo.days_of_week &&
    !promo.days_of_week.includes(dayOfWeekIn(ctx.now, ctx.timezone ?? DEFAULT_TIMEZONE))
  ) {
    return false
  }
  return true
}

/** Deterministic evaluation order: priority desc, then id asc. */
export function sortPromotions<T extends { priority: number; id: string }>(
  promotions: readonly T[],
): T[] {
  return [...promotions].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

interface PricedLine {
  line: PromotionCartLine
  index: number
  pack: number
  gross: number
  units: number
}

function matches(
  line: PromotionCartLine,
  t: {
    all_items: boolean
    product_ids: string[]
    category_ids: string[]
    brand_ids: string[]
    exclude_product_ids?: string[]
  },
): boolean {
  if (t.exclude_product_ids?.includes(line.product_id)) return false
  if (t.all_items) return true
  return (
    t.product_ids.includes(line.product_id) ||
    (line.category_id != null && t.category_ids.includes(line.category_id)) ||
    (line.brand_id != null && t.brand_ids.includes(line.brand_id))
  )
}

/** Cheaper per-unit price first (exact cross-multiplication), then cart order. */
function byUnitPrice(a: PricedLine, b: PricedLine): number {
  const diff = a.line.unit_price_paise * b.pack - b.line.unit_price_paise * a.pack
  return diff !== 0 ? Math.sign(diff) : a.index - b.index
}

/** Discount for `units` whole units of a line at `bp`. */
function unitsDiscount(p: PricedLine, units: number, bp: number): number {
  return mulDiv(amountForQty(p.line.unit_price_paise, units * 1000, p.pack), bp, BP)
}

function buyXGetYProposals(
  rules: BuyXGetYRules,
  lines: readonly PricedLine[],
): Map<string, number> {
  const out = new Map<string, number>()
  const getTarget = {
    all_items: false,
    product_ids: rules.get_product_ids,
    category_ids: rules.get_category_ids,
    brand_ids: rules.get_brand_ids,
    exclude_product_ids: rules.exclude_product_ids,
  }
  const separateReward = hasTarget(getTarget)
  let freeUnits: number
  let rewardLines: PricedLine[]
  if (separateReward) {
    rewardLines = lines.filter((p) => matches(p.line, getTarget))
    const buyUnits = sumSafe(
      lines
        .filter((p) => matches(p.line, rules) && !matches(p.line, getTarget))
        .map((p) => p.units),
    )
    let groups = Math.floor(buyUnits / rules.buy_qty)
    if (rules.max_applications !== undefined) groups = Math.min(groups, rules.max_applications)
    freeUnits = Math.min(groups * rules.get_qty, sumSafe(rewardLines.map((p) => p.units)))
  } else {
    rewardLines = lines.filter((p) => matches(p.line, rules))
    const units = sumSafe(rewardLines.map((p) => p.units))
    let groups = Math.floor(units / (rules.buy_qty + rules.get_qty))
    if (rules.max_applications !== undefined) groups = Math.min(groups, rules.max_applications)
    freeUnits = groups * rules.get_qty
  }
  // The cheapest units are the discounted ones.
  for (const p of [...rewardLines].sort(byUnitPrice)) {
    if (freeUnits <= 0) break
    const take = Math.min(freeUnits, p.units)
    if (take > 0) out.set(p.line.key, unitsDiscount(p, take, rules.get_discount_bp))
    freeUnits -= take
  }
  return out
}

function comboProposals(rules: ComboPriceRules, lines: readonly PricedLine[]): Map<string, number> {
  const out = new Map<string, number>()
  const linesFor = (productId: string): PricedLine[] =>
    lines.filter((p) => p.line.product_id === productId)
  let combos = Math.min(
    ...rules.items.map((item) =>
      Math.floor(sumSafe(linesFor(item.product_id).map((p) => p.line.qty_milli)) / item.qty_milli),
    ),
  )
  if (rules.max_applications !== undefined) combos = Math.min(combos, rules.max_applications)
  if (!(combos > 0)) return out

  // Regular value of the quantities consumed by the combos, taken from lines in cart order.
  const consumed: Array<{ key: string; value: number }> = []
  for (const item of rules.items) {
    let needed = item.qty_milli * combos
    for (const p of linesFor(item.product_id)) {
      if (needed <= 0) break
      const take = Math.min(needed, p.line.qty_milli)
      consumed.push({ key: p.line.key, value: amountForQty(p.line.unit_price_paise, take, p.pack) })
      needed -= take
    }
  }
  const regular = sumSafe(consumed.map((c) => c.value))
  const discount = Math.max(0, regular - rules.combo_price_paise * combos)
  if (discount === 0) return out
  const parts = allocateProRata(
    discount,
    consumed.map((c) => c.value),
  )
  consumed.forEach((c, i) => out.set(c.key, (out.get(c.key) ?? 0) + (parts[i] ?? 0)))
  return out
}

function itemProposals(promo: PromotionLike, lines: readonly PricedLine[]): Map<string, number> {
  const out = new Map<string, number>()
  switch (promo.kind) {
    case 'item_percent':
    case 'item_flat': {
      const r = promo.rules
      for (const p of lines) {
        if (!matches(p.line, r)) continue
        if (r.min_qty_milli !== undefined && p.line.qty_milli < r.min_qty_milli) continue
        let amount =
          promo.kind === 'item_percent'
            ? mulDiv(p.gross, promo.rules.percent_bp, BP)
            : Math.min(p.gross, mulDiv(promo.rules.flat_paise, p.line.qty_milli, 1000))
        if (r.max_discount_paise !== undefined) amount = Math.min(amount, r.max_discount_paise)
        if (amount > 0) out.set(p.line.key, amount)
      }
      return out
    }
    case 'buy_x_get_y':
      return buyXGetYProposals(promo.rules, lines)
    case 'combo_price':
      return comboProposals(promo.rules, lines)
    default:
      return out
  }
}

function billProposal(promo: PromotionLike, remaining: number): number {
  switch (promo.kind) {
    case 'bill_percent': {
      const r = promo.rules
      if (r.min_bill_paise !== undefined && remaining < r.min_bill_paise) return 0
      const amount = mulDiv(remaining, r.percent_bp, BP)
      return r.max_discount_paise !== undefined ? Math.min(amount, r.max_discount_paise) : amount
    }
    case 'bill_flat': {
      const r = promo.rules
      if (r.min_bill_paise !== undefined && remaining < r.min_bill_paise) return 0
      return Math.min(r.flat_paise, remaining)
    }
    default:
      return 0
  }
}

/** Picks the best non-stackable proposal (first wins ties) followed by all stackable ones. */
function selectProposals(
  proposals: Array<{ promo: PromotionLike; amount: number }>,
): Array<{ promo: PromotionLike; amount: number }> {
  let best: { promo: PromotionLike; amount: number } | undefined
  const stackable: Array<{ promo: PromotionLike; amount: number }> = []
  for (const p of proposals) {
    if (p.amount <= 0) continue
    if (p.promo.stackable) stackable.push(p)
    else if (!best || p.amount > best.amount) best = p
  }
  return best ? [best, ...stackable] : stackable
}

const ITEM_KINDS: ReadonlySet<PromotionKind> = new Set([
  'item_percent',
  'item_flat',
  'buy_x_get_y',
  'combo_price',
])

/**
 * Applies promotions to a cart. Pure and deterministic; never discounts below zero.
 * @throws RangeError on duplicate cart keys or invalid quantities/prices.
 */
export function applyPromotions(
  cart: readonly PromotionCartLine[],
  promotions: readonly PromotionLike[],
  ctx: PromotionContext,
): PromotionResult {
  const seen = new Set<string>()
  const lines: PricedLine[] = cart.map((line, index) => {
    if (seen.has(line.key)) throw new RangeError(`duplicate cart key: ${line.key}`)
    seen.add(line.key)
    const pack = line.pack_size ?? 1
    return {
      line,
      index,
      pack,
      gross: amountForQty(line.unit_price_paise, line.qty_milli, pack),
      units: Math.floor(line.qty_milli / 1000),
    }
  })

  const active = sortPromotions(promotions.filter((p) => isPromotionActive(p, ctx)))
  const appliedTotals = new Map<string, number>()
  const credit = (promo: PromotionLike, amount: number): void => {
    appliedTotals.set(promo.id, (appliedTotals.get(promo.id) ?? 0) + amount)
  }

  // ---- item level -----------------------------------------------------------------------
  const proposalsByLine = new Map<string, Array<{ promo: PromotionLike; amount: number }>>()
  for (const promo of active) {
    if (!ITEM_KINDS.has(promo.kind)) continue
    for (const [key, amount] of itemProposals(promo, lines)) {
      const list = proposalsByLine.get(key) ?? []
      list.push({ promo, amount })
      proposalsByLine.set(key, list)
    }
  }

  const line_discounts: Record<string, LineDiscount> = {}
  let remainingBill = 0
  for (const p of lines) {
    let left = p.gross
    const ids: string[] = []
    for (const { promo, amount } of selectProposals(proposalsByLine.get(p.line.key) ?? [])) {
      const take = Math.min(amount, left)
      if (take <= 0) continue
      left -= take
      ids.push(promo.id)
      credit(promo, take)
    }
    line_discounts[p.line.key] = { discount_paise: p.gross - left, promotion_ids: ids }
    remainingBill += left
  }

  // ---- bill level -----------------------------------------------------------------------
  const billProposals = active
    .filter((promo) => !ITEM_KINDS.has(promo.kind))
    .map((promo) => ({ promo, amount: billProposal(promo, remainingBill) }))
  let billLeft = remainingBill
  for (const { promo, amount } of selectProposals(billProposals)) {
    const take = Math.min(amount, billLeft)
    if (take <= 0) continue
    billLeft -= take
    credit(promo, take)
  }

  const applied: AppliedPromotion[] = active
    .filter((promo) => (appliedTotals.get(promo.id) ?? 0) > 0)
    .map((promo) => ({
      promotion_id: promo.id,
      name: promo.name,
      discount_paise: appliedTotals.get(promo.id) ?? 0,
    }))

  return { line_discounts, bill_discount_paise: remainingBill - billLeft, applied }
}
