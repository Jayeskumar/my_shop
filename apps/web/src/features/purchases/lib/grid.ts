/**
 * Cell ids and keyboard order of the line grids (bill entry, purchase order): every editable
 * cell has a stable DOM id so Enter / arrow keys and "focus the new row" can move focus.
 */
import type { BillLineDraft } from './bill-form'

/** Editable columns of the bill grid, in keyboard (Enter) order. */
export const GRID_COLUMNS = [
  'batch_no',
  'expiry',
  'mrp',
  'qty',
  'free',
  'unit_cost',
  'discount',
  'gst',
  'sale_price',
] as const
export type GridColumn = (typeof GRID_COLUMNS)[number]

export function cellId(key: string, col: GridColumn): string {
  return `bl-${key}-${col}`
}

/** Batch and expiry cells exist only for batch-tracked items (and when batches are shown). */
export function columnEnabled(line: BillLineDraft, col: GridColumn, showBatch: boolean): boolean {
  if (col === 'batch_no' || col === 'expiry') return showBatch && line.product.track_batches
  return true
}

/** First editable cell of a new row (batch for batch-tracked items, else quantity). */
export function firstCellOf(line: BillLineDraft, showBatch: boolean): string {
  return cellId(line.key, columnEnabled(line, 'batch_no', showBatch) ? 'batch_no' : 'qty')
}

/** Editable columns of the purchase-order grid, in keyboard order. */
export const ORDER_COLUMNS = ['qty', 'rate', 'gst'] as const
export type OrderColumn = (typeof ORDER_COLUMNS)[number]

export function orderCellId(key: string, col: OrderColumn): string {
  return `ol-${key}-${col}`
}
