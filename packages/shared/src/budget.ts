/**
 * StockSense cash budget order: spend the cash the owner has today on the reorder list.
 *
 * Every suggested item is split into two parts:
 *  - must-have: the units needed to avoid running out before the delivery
 *    (forecast demand − stock still in date at delivery − open orders, capped at the suggestion);
 *  - buffer: the rest of the suggestion (safety stock, reorder-level top-up).
 * Pass 1 buys must-haves in StockSense rank order (priority, days short, margin); pass 2 spends
 * what is left on buffers in the same order. An item that does not fit is cut to whole packs.
 * Cash is the supplier price per pack plus GST, rounded per line, so totals match what is paid.
 */

export const BUDGET_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export type BudgetPriority = (typeof BUDGET_PRIORITIES)[number]

const PRIORITY_RANK: Readonly<Record<BudgetPriority, number>> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
}

export interface BudgetItemInput {
  product_id: string
  name: string
  priority: BudgetPriority
  stockout_urgency_days: number
  margin_bp: number | null
  /** StockSense quantity (a whole number of packs). */
  suggested_qty_milli: number
  /** Demand until delivery (0 without history). */
  forecast_demand_milli: number
  /** Usable stock still in date at delivery. */
  durable_stock_milli: number
  /** Pending on sent purchase orders. */
  open_po_qty_milli: number
  pack_size: number
  /** Supplier price per pack, excluding GST. */
  unit_cost_paise: number
  gst_rate_bp: number
}

export type BudgetLineStatus = 'full' | 'must_have' | 'partial' | 'left_out'

export interface BudgetLine {
  product_id: string
  /** Units to order (whole packs); 0 = left out. */
  qty_milli: number
  /** Cash for that quantity including GST. */
  cash_paise: number
  /** Cash for the full suggestion including GST. */
  full_cash_paise: number
  /** Must-have units of this item. */
  must_have_qty_milli: number
  status: BudgetLineStatus
}

export interface BudgetPlan {
  budget_paise: number
  spent_paise: number
  left_paise: number
  /** Cash of every suggestion in full. */
  full_cash_paise: number
  /** Cash of all must-have units. */
  must_have_cash_paise: number
  /** Share of the must-have cash that the budget buys, basis points (10000 when none needed). */
  must_have_covered_bp: number
  /** In the order they were ranked. */
  lines: BudgetLine[]
}

function packMilli(packSize: number): number {
  return (Number.isSafeInteger(packSize) && packSize >= 1 ? packSize : 1) * 1000
}

/** Cash (incl. GST) of one pack. */
export function packCashPaise(unitCostPaise: number, gstRateBp: number): number {
  return Math.round((Math.max(0, unitCostPaise) * (10_000 + Math.max(0, gstRateBp))) / 10_000)
}

/** Must-have units: the shortage before delivery, in whole packs, at most the suggestion. */
export function mustHaveQtyMilli(item: BudgetItemInput): number {
  const pack = packMilli(item.pack_size)
  const shortage = Math.max(
    0,
    item.forecast_demand_milli - item.durable_stock_milli - item.open_po_qty_milli,
  )
  const packs = Math.ceil(shortage / pack)
  return Math.min(packs * pack, Math.max(0, item.suggested_qty_milli))
}

/** StockSense order: priority, then days short, then margin, then name. */
export function compareBudgetRank(a: BudgetItemInput, b: BudgetItemInput): number {
  const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
  if (byPriority !== 0) return byPriority
  const byUrgency = b.stockout_urgency_days - a.stockout_urgency_days
  if (byUrgency !== 0) return byUrgency
  const byMargin =
    (b.margin_bp ?? Number.NEGATIVE_INFINITY) - (a.margin_bp ?? Number.NEGATIVE_INFINITY)
  if (byMargin !== 0) return byMargin
  return a.name.localeCompare(b.name, 'en')
}

export function planWithinBudget(
  items: readonly BudgetItemInput[],
  budgetPaise: number,
): BudgetPlan {
  const budget = Math.max(0, Math.floor(Number.isFinite(budgetPaise) ? budgetPaise : 0))
  const ranked = items.filter((i) => i.suggested_qty_milli > 0).sort(compareBudgetRank)

  const state = ranked.map((item) => {
    const pack = packMilli(item.pack_size)
    const packCash = packCashPaise(item.unit_cost_paise, item.gst_rate_bp)
    const totalPacks = Math.floor(item.suggested_qty_milli / pack)
    const mustPacks = Math.floor(mustHaveQtyMilli(item) / pack)
    return { item, pack, packCash, totalPacks, mustPacks, bought: 0 }
  })

  let left = budget
  const buy = (s: (typeof state)[number], wantPacks: number): void => {
    const want = Math.max(0, wantPacks - s.bought)
    if (want === 0) return
    const affordable = s.packCash > 0 ? Math.min(want, Math.floor(left / s.packCash)) : want
    s.bought += affordable
    left -= affordable * s.packCash
  }
  for (const s of state) buy(s, s.mustPacks)
  for (const s of state) buy(s, s.totalPacks)

  let fullCash = 0
  let mustCash = 0
  let mustBought = 0
  const lines: BudgetLine[] = state.map((s) => {
    const full = s.totalPacks * s.packCash
    const must = s.mustPacks * s.packCash
    fullCash += full
    mustCash += must
    mustBought += Math.min(s.bought, s.mustPacks) * s.packCash
    const status: BudgetLineStatus =
      s.bought === 0
        ? 'left_out'
        : s.bought >= s.totalPacks
          ? 'full'
          : s.mustPacks > 0 && s.bought >= s.mustPacks
            ? 'must_have'
            : 'partial'
    return {
      product_id: s.item.product_id,
      qty_milli: s.bought * s.pack,
      cash_paise: s.bought * s.packCash,
      full_cash_paise: full,
      must_have_qty_milli: s.mustPacks * s.pack,
      status,
    }
  })

  return {
    budget_paise: budget,
    spent_paise: budget - left,
    left_paise: left,
    full_cash_paise: fullCash,
    must_have_cash_paise: mustCash,
    must_have_covered_bp: mustCash > 0 ? Math.floor((mustBought / mustCash) * 10_000) : 10_000,
    lines,
  }
}
