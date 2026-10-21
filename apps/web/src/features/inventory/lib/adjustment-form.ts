/**
 * State and payload rules of the adjustment editor (adjustment, stock take, damage, expiry
 * write-off). Pure functions — the page keeps the lines in React state and builds the contract
 * body (AdjustmentCreate / AdjustmentUpdate lines) with these.
 *
 *  - adjustment: a direction (+ found / − missing) and a quantity → qty_delta_milli = ±qty;
 *  - damage / expiry write-off: always a loss → qty_delta_milli = −qty;
 *  - stock take: the counted quantity → counted_qty_milli (the server posts counted − system at
 *    posting time, under lock). Lines not counted yet are left out (stock unchanged).
 */
import {
  type AdjustmentLineInput,
  WRITE_OFF_KINDS,
  adjustmentLineIssues,
  adjustmentValueSummary,
  stockTakeDelta,
  stockValuePaise,
  type EditableAdjustmentKind,
  type InventoryValidationKey,
} from '@kadai/shared/api/inventory'
import type { LineBatch, LineProduct } from './lines'
import { lineIdentity } from './lines'

export interface AdjLine {
  key: string
  product: LineProduct
  batch: LineBatch | null
  /** adjustment kind: +1 stock found / added, −1 stock missing / removed. */
  direction: 1 | -1
  /** Quantity of the change (adjustment, damage, expiry write-off), milli, positive. */
  qty_milli: number | null
  /** stock take: physically counted quantity. */
  counted_milli: number | null
  /** Current stock of the (store, product, batch) row when known. */
  system_milli: number | null
  /** Cost per pack of gains (default: the current average cost). */
  unit_cost_paise: number | null
  reason: string | null
}

export type AdjLineField = 'product' | 'batch' | 'qty' | 'counted'
export type AdjLineErrors = Record<
  string,
  Partial<Record<AdjLineField, InventoryValidationKey | 'batch_required' | 'required'>>
>

export function isLossOnly(kind: EditableAdjustmentKind): boolean {
  return WRITE_OFF_KINDS.includes(kind)
}

/** Signed change a line will post (null when not known yet). */
export function lineDelta(kind: EditableAdjustmentKind, l: AdjLine): number | null {
  if (kind === 'stock_take') {
    if (l.counted_milli === null || l.system_milli === null) return null
    return stockTakeDelta(l.system_milli, l.counted_milli)
  }
  if (l.qty_milli === null) return null
  const direction = isLossOnly(kind) ? -1 : l.direction
  return direction * l.qty_milli
}

/** Cost per pack used for the value estimate of a line. */
export function lineCost(l: AdjLine): number {
  return l.unit_cost_paise ?? l.product.cost_paise
}

/** Estimated signed value of a line (null when the change is not known yet). */
export function lineValue(kind: EditableAdjustmentKind, l: AdjLine): number | null {
  const delta = lineDelta(kind, l)
  if (delta === null) return null
  return stockValuePaise(lineCost(l), delta, l.product.pack_size)
}

/** Gain / loss / net estimate of the editor lines (the server values losses at average cost). */
export function estimateSummary(kind: EditableAdjustmentKind, lines: readonly AdjLine[]) {
  const priced = lines.flatMap((l) => {
    const delta = lineDelta(kind, l)
    return delta === null || delta === 0
      ? []
      : [{ qty_delta_milli: delta, unit_cost_paise: lineCost(l), pack_size: l.product.pack_size }]
  })
  return adjustmentValueSummary(kind, priced)
}

/** Stock take lines without a count (left unchanged on posting). */
export function uncountedLines(kind: EditableAdjustmentKind, lines: readonly AdjLine[]): AdjLine[] {
  return kind === 'stock_take' ? lines.filter((l) => l.counted_milli === null) : []
}

/** The contract lines for a save (stock take lines without a count are skipped). */
export function linesPayload(
  kind: EditableAdjustmentKind,
  lines: readonly AdjLine[],
): AdjustmentLineInput[] {
  const out: AdjustmentLineInput[] = []
  for (const l of lines) {
    const base = {
      product_id: l.product.id,
      batch_id: l.batch?.id ?? null,
      reason: l.reason?.trim() ? l.reason.trim() : null,
    }
    if (kind === 'stock_take') {
      if (l.counted_milli === null) continue
      out.push({ ...base, counted_qty_milli: l.counted_milli })
      continue
    }
    const delta = lineDelta(kind, l)
    out.push({
      ...base,
      ...(delta === null ? {} : { qty_delta_milli: delta }),
      ...(kind === 'adjustment' && l.direction === 1 && l.unit_cost_paise !== null
        ? { unit_cost_paise: l.unit_cost_paise }
        : {}),
    })
  }
  return out
}

/** Line problems to show before saving: missing batch / quantity, duplicates, contract rules. */
export function editorIssues(
  kind: EditableAdjustmentKind,
  lines: readonly AdjLine[],
): AdjLineErrors {
  const errors: AdjLineErrors = {}
  const set = (key: string, field: AdjLineField, code: AdjLineErrors[string][AdjLineField]) => {
    errors[key] = { ...errors[key], [field]: errors[key]?.[field] ?? code }
  }
  for (const l of lines) {
    if (l.product.track_batches && !l.batch) set(l.key, 'batch', 'batch_required')
    if (kind !== 'stock_take' && (l.qty_milli === null || l.qty_milli === 0))
      set(l.key, 'qty', 'required')
  }
  // Duplicate (product, batch) lines — the same rule the contract applies.
  const seen = new Map<string, string>()
  for (const l of lines) {
    const id = lineIdentity(l.product.id, l.batch?.id ?? null)
    if (seen.has(id)) set(l.key, 'product', 'duplicate_line')
    else seen.set(id, l.key)
  }
  // Contract refinements on what will actually be sent.
  const counted = kind === 'stock_take' ? lines.filter((l) => l.counted_milli !== null) : lines
  const sent = linesPayload(kind, counted).map((p) => ({
    product_id: p.product_id,
    batch_id: p.batch_id ?? null,
    qty_delta_milli: p.qty_delta_milli,
    counted_qty_milli: p.counted_qty_milli,
  }))
  for (const issue of adjustmentLineIssues(kind, sent)) {
    const index = issue.path[1]
    const line = typeof index === 'number' ? counted[index] : undefined
    if (!line) continue
    const field: AdjLineField =
      issue.path[2] === 'counted_qty_milli'
        ? 'counted'
        : issue.path[2] === 'qty_delta_milli'
          ? 'qty'
          : 'product'
    set(line.key, field, issue.code)
  }
  return errors
}

/** Lines whose kind-specific values are reset when the kind changes. */
export function linesForKind(kind: EditableAdjustmentKind, lines: readonly AdjLine[]): AdjLine[] {
  return lines.map((l) =>
    isLossOnly(kind) ? { ...l, direction: -1 as const, unit_cost_paise: null } : l,
  )
}
