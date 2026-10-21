/**
 * The product facts the line editors (opening stock, adjustments, stock takes, transfers) need,
 * whichever list they came from: a picked catalogue product, a batch row, a stock row or a saved
 * document line. Plus small helpers shared by the editors.
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import type { AdjustmentLine, BatchRow, StockRow, TransferLine } from '@kadai/shared/api/inventory'
import { newId } from '@kadai/shared/ids'

export interface LineProduct {
  id: string
  name: string
  name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  track_batches: boolean
  /** Cost per pack used for value estimates (average cost when known, else purchase price). */
  cost_paise: number
  mrp_paise: number | null
}

export interface LineBatch {
  id: string
  batch_no: string
  expiry_date: string | null
}

export function fromListItem(p: ProductListItem): LineProduct {
  return {
    id: p.id,
    name: p.name,
    name_ta: p.name_ta,
    sku: p.sku,
    unit: p.unit,
    pack_size: p.pack_size,
    track_batches: p.track_batches,
    cost_paise: p.purchase_price_paise,
    mrp_paise: p.mrp_paise,
  }
}

export function fromBatchRow(b: BatchRow): { product: LineProduct; batch: LineBatch } {
  return {
    product: {
      id: b.product_id,
      name: b.product_name,
      name_ta: b.product_name_ta,
      sku: b.sku,
      unit: b.unit,
      pack_size: b.pack_size,
      track_batches: true,
      cost_paise: b.purchase_price_paise ?? 0,
      mrp_paise: b.mrp_paise,
    },
    batch: { id: b.id, batch_no: b.batch_no, expiry_date: b.expiry_date },
  }
}

export function fromStockRow(r: StockRow): { product: LineProduct; batch: LineBatch | null } {
  return {
    product: {
      id: r.product_id,
      name: r.name,
      name_ta: r.name_ta,
      sku: r.sku,
      unit: r.unit,
      pack_size: r.pack_size,
      track_batches: r.track_batches,
      cost_paise: r.avg_cost_paise,
      mrp_paise: r.mrp_paise,
    },
    batch:
      r.batch_id && r.batch_no
        ? { id: r.batch_id, batch_no: r.batch_no, expiry_date: r.expiry_date }
        : null,
  }
}

export function fromDocumentLine(l: AdjustmentLine | TransferLine): {
  product: LineProduct
  batch: LineBatch | null
} {
  return {
    product: {
      id: l.product_id,
      name: l.product_name,
      name_ta: l.product_name_ta,
      sku: l.sku,
      unit: l.unit,
      pack_size: l.pack_size,
      track_batches: l.track_batches,
      cost_paise: l.unit_cost_paise,
      mrp_paise: null,
    },
    batch:
      l.batch_id && l.batch_no
        ? { id: l.batch_id, batch_no: l.batch_no, expiry_date: l.expiry_date }
        : null,
  }
}

/** Client key of an editor line. */
export function lineKey(): string {
  return newId()
}

/** "product:batch" identity used for duplicate detection (matches the contract rule). */
export function lineIdentity(productId: string, batchId: string | null): string {
  return `${productId}:${batchId ?? '-'}`
}

/** One base unit (1 pc, 1 tab, 1 kg) in milli — the scan-count increment. */
export const ONE_UNIT_MILLI = 1000

/** Moves focus to the input with this id on the next frame (after React renders it). */
export function focusLater(id: string): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(id)
    if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
      el.focus()
      if (el instanceof HTMLInputElement) el.select()
    }
  })
}
