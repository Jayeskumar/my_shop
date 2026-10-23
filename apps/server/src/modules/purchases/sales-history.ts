/**
 * POST /purchases/sales-history — CSV of past sales (product, date, quantity) for StockSense.
 * Rows land in demand_history and are added to the forecast. Stock balances are not touched:
 * recorded sales already live on the stock-movement ledger, which is written only by postStock.
 * Re-importing the same product and date replaces that imported quantity.
 */
import { parse } from 'csv-parse/sync'
import { sql } from 'kysely'
import { isDateStr, isUuid, tryParseQty } from '@kadai/shared'
import type { SalesHistoryImportResult } from '@kadai/shared/api/purchases'
import { audit } from '../../core/audit'
import { invalidField } from '../../core/errors'
import type { Tx } from '../../db/tenant'
import { type Ctx, businessToday, loadStore } from './common'

const MAX_ROWS = 5_000
const SKIPPED_LIMIT = 20

const PRODUCT_COLS = ['product', 'sku', 'product_id', 'barcode', 'identifier', 'product_sku']
const DATE_COLS = ['date', 'sale_date', 'sold_on']
const QTY_COLS = ['qty', 'quantity', 'quantity_sold', 'qty_sold']

type SkipReason = SalesHistoryImportResult['skipped'][number]['reason']

interface ProductRow {
  id: string
  sku: string | null
}

export async function importSalesHistory(
  tx: Tx,
  ctx: Ctx,
  input: { store_id: string; csv: string },
): Promise<SalesHistoryImportResult> {
  const store = await loadStore(tx, ctx, input.store_id, { requireActive: true })
  const cal = await businessToday(tx, ctx)
  let records: Record<string, string>[]
  try {
    records = parse(input.csv, {
      columns: (headers: string[]) =>
        headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Record<string, string>[]
  } catch {
    throw invalidField('csv', 'sales_history_columns')
  }
  if (records.length === 0) throw invalidField('csv', 'sales_history_columns')
  const sample = records[0]!
  if (
    cell(sample, PRODUCT_COLS) === undefined ||
    cell(sample, DATE_COLS) === undefined ||
    cell(sample, QTY_COLS) === undefined
  ) {
    throw invalidField('csv', 'sales_history_columns')
  }

  const skipped: SalesHistoryImportResult['skipped'] = []
  let skippedCount = 0
  const note = (row: number, reason: SkipReason): void => {
    skippedCount += 1
    if (skipped.length < SKIPPED_LIMIT) skipped.push({ row, reason })
  }

  const pending: { row: number; product: string; date: string; qty: string }[] = []
  records.forEach((record, index) => {
    const row = index + 2
    if (pending.length >= MAX_ROWS) {
      note(row, 'too_many')
      return
    }
    const product = cell(record, PRODUCT_COLS)?.trim() ?? ''
    const date = cell(record, DATE_COLS)?.trim() ?? ''
    const qty = cell(record, QTY_COLS)?.trim() ?? ''
    if (!product && !date && !qty) return
    pending.push({ row, product, date, qty })
  })

  const ids = [...new Set(pending.map((r) => r.product).filter((p) => isUuid(p)))]
  const skus = [
    ...new Set(
      pending.map((r) => r.product.trim().toLowerCase()).filter((p) => p !== '' && !isUuid(p)),
    ),
  ]
  const products = new Map<string, ProductRow>()
  const bySku = new Map<string, ProductRow>()
  const byBarcode = new Map<string, string>()
  if (ids.length > 0) {
    const rows = await tx
      .selectFrom('products')
      .select(['id', 'sku'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', ids)
      .where('is_active', '=', true)
      .execute()
    for (const row of rows) products.set(row.id, row)
  }
  if (skus.length > 0) {
    const rows = await tx
      .selectFrom('products')
      .select(['id', 'sku'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('is_active', '=', true)
      .where(sql<string>`lower(sku)`, 'in', skus)
      .execute()
    for (const row of rows) {
      products.set(row.id, row)
      if (row.sku) bySku.set(row.sku.toLowerCase(), row)
    }
    const codes = await tx
      .selectFrom('product_barcodes')
      .select(['product_id', 'barcode'])
      .where('tenant_id', '=', ctx.tenantId)
      .where(
        'barcode',
        'in',
        pending.map((r) => r.product.trim()).filter((p) => p !== ''),
      )
      .execute()
    for (const code of codes) byBarcode.set(code.barcode, code.product_id)
    const missingIds = [...new Set([...byBarcode.values()].filter((id) => !products.has(id)))]
    if (missingIds.length > 0) {
      const extra = await tx
        .selectFrom('products')
        .select(['id', 'sku'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', 'in', missingIds)
        .where('is_active', '=', true)
        .execute()
      for (const row of extra) products.set(row.id, row)
    }
  }

  const totals = new Map<string, number>()
  for (const line of pending) {
    const product =
      products.get(line.product) ??
      bySku.get(line.product.toLowerCase()) ??
      products.get(byBarcode.get(line.product) ?? '')
    if (!product) {
      note(line.row, 'unknown_product')
      continue
    }
    if (!isDateStr(line.date)) {
      note(line.row, 'bad_date')
      continue
    }
    if (line.date > cal.today) {
      note(line.row, 'future_date')
      continue
    }
    const qty = tryParseQty(line.qty, 'PCS', { allowDecimal: true })
    if (qty === null) {
      note(line.row, 'bad_qty')
      continue
    }
    const key = `${product.id}|${line.date}`
    totals.set(key, (totals.get(key) ?? 0) + qty)
  }

  const values = [...totals.entries()].map(([key, qty]) => {
    const split = key.indexOf('|')
    return {
      tenant_id: ctx.tenantId,
      store_id: store.id,
      product_id: key.slice(0, split),
      sale_date: key.slice(split + 1),
      qty_milli: qty,
      created_by: ctx.userId,
    }
  })
  for (let i = 0; i < values.length; i += 200) {
    const chunk = values.slice(i, i + 200)
    await tx
      .insertInto('demand_history')
      .values(chunk)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'store_id', 'product_id', 'sale_date']).doUpdateSet({
          qty_milli: sql`excluded.qty_milli`,
        }),
      )
      .execute()
  }

  await audit(tx, ctx, {
    action: 'sales_history.import',
    entity_type: 'demand_history',
    summary: `Imported ${String(values.length)} sales-history rows`,
    changes: { store_id: store.id, rows: values.length, skipped: skippedCount },
  })

  return {
    imported_rows: values.length,
    products: new Set(values.map((v) => v.product_id)).size,
    skipped_count: skippedCount,
    skipped,
  }
}

function cell(row: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = row[name]
    if (value !== undefined) return value
  }
  return undefined
}
