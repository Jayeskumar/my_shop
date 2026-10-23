/** Branch price grid edits → PUT /store-prices body. */
import type { StorePriceRow, StorePricesUpdate } from '@kadai/shared/api/catalog'

export interface StorePriceEdit {
  sale: number | null
  mrp: number | null
}

/** Grid edits → PUT body: a cleared price deletes the override. */
export function storePricesBody(
  storeId: string,
  edits: Readonly<Record<string, StorePriceEdit>>,
  rows: readonly StorePriceRow[],
): StorePricesUpdate {
  const upserts: { product_id: string; sale_price_paise: number; mrp_paise: number | null }[] = []
  const deletes: string[] = []
  for (const [productId, e] of Object.entries(edits)) {
    const row = rows.find((r) => r.product_id === productId)
    if (e.sale === null) {
      if (row?.store_sale_price_paise !== null) deletes.push(productId)
      continue
    }
    upserts.push({ product_id: productId, sale_price_paise: e.sale, mrp_paise: e.mrp })
  }
  return { store_id: storeId, upserts, deletes }
}
