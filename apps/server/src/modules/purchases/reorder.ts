/**
 * GET /purchases/reorder-suggestions?store_id= — products at / below their reorder level at a
 * store (or exactly the requested product_ids), with:
 *  - current stock (all batches) at the store;
 *  - average daily sales over the last REORDER_SALES_WINDOW_DAYS days (net of sale returns and
 *    cancellations, from the stock movement ledger: averageDailySalesMilli);
 *  - suggested quantity: max(reorder_qty, 2 × reorder_level − stock) (suggestedReorderQtyMilli);
 *  - quantity still pending on sent / partially received purchase orders of the store;
 *  - last supplier, cost and date from the latest posted bill line of the product;
 * grouped by that supplier (never purchased → the `supplier: null` group, last).
 */
import { sql } from 'kysely'
import { addDays, amountForQty, instantRangeForDates } from '@kadai/shared'
import {
  REORDER_SALES_WINDOW_DAYS,
  type ReorderItem,
  type ReorderSuggestions,
  type ReorderSuggestionsQuerySchema,
  averageDailySalesMilli,
  suggestedReorderQtyMilli,
} from '@kadai/shared/api/purchases'
import type { z } from 'zod'
import type { Tx } from '../../db/tenant'
import { type Ctx, businessToday, iso, lastPurchases, loadStore } from './common'
import { likePattern } from './orders'

type ReorderQuery = z.output<typeof ReorderSuggestionsQuerySchema>

/** Upper bound of products considered in one request. */
const MAX_ITEMS = 2000

export async function reorderSuggestions(
  tx: Tx,
  ctx: Ctx,
  q: ReorderQuery,
): Promise<ReorderSuggestions> {
  const store = await loadStore(tx, ctx, q.store_id)
  const cal = await businessToday(tx, ctx)
  const t = ctx.tenantId

  let qb = tx
    .selectFrom('products as p')
    .leftJoin(
      (eb) =>
        eb
          .selectFrom('stock_levels')
          .select(['product_id', sql<number>`sum(qty_milli)::bigint`.as('qty')])
          .where('tenant_id', '=', t)
          .where('store_id', '=', store.id)
          .groupBy('product_id')
          .as('st'),
      (j) => j.onRef('st.product_id', '=', 'p.id'),
    )
    .select([
      'p.id',
      'p.name',
      'p.name_ta',
      'p.sku',
      'p.unit',
      'p.pack_size',
      'p.category_id',
      'p.gst_rate_bp',
      'p.purchase_price_paise',
      'p.reorder_level_milli',
      'p.reorder_qty_milli',
      sql<number>`coalesce(st.qty, 0)::bigint`.as('stock_milli'),
    ])
    .where('p.tenant_id', '=', t)
    .where('p.is_active', '=', true)
    .where('p.track_inventory', '=', true)
    .where('p.kind', 'in', ['standard', 'variant'])
  if (q.product_ids?.length) {
    qb = qb.where('p.id', 'in', q.product_ids)
  } else {
    qb = qb
      .where('p.reorder_level_milli', 'is not', null)
      .where(sql<boolean>`coalesce(st.qty, 0) <= p.reorder_level_milli`)
  }
  if (q.category_id) {
    qb = qb.where(
      sql<boolean>`p.category_id in (
        with recursive tree(id) as (
          select id from categories where tenant_id = ${t} and id = ${q.category_id}
          union all
          select c.id from categories c join tree on c.parent_id = tree.id where c.tenant_id = ${t}
        ) select id from tree)`,
    )
  }
  if (q.q) {
    const pattern = likePattern(q.q)
    qb = qb.where((eb) =>
      eb.or([
        eb('p.name', 'ilike', pattern),
        eb('p.name_ta', 'ilike', pattern),
        eb('p.sku', 'ilike', pattern),
        eb('p.search_text', 'ilike', pattern),
      ]),
    )
  }
  const products = await qb.orderBy('p.name').orderBy('p.id').limit(MAX_ITEMS).execute()
  const ids = products.map((p) => p.id)

  const window = instantRangeForDates(
    addDays(cal.today, -(REORDER_SALES_WINDOW_DAYS - 1)),
    cal.today,
    cal.timezone,
  )
  const [sales, openPo, last] = await Promise.all([
    ids.length
      ? tx
          .selectFrom('stock_movements')
          .select(['product_id', sql<number>`(-sum(qty_milli))::bigint`.as('sold')])
          .where('tenant_id', '=', t)
          .where('store_id', '=', store.id)
          .where('product_id', 'in', ids)
          .where('movement_type', 'in', ['sale', 'sale_return', 'sale_cancel'])
          .where('created_at', '>=', window.start)
          .where('created_at', '<', window.end)
          .groupBy('product_id')
          .execute()
      : Promise.resolve([]),
    ids.length
      ? tx
          .selectFrom('purchase_order_lines as l')
          .innerJoin('purchase_orders as o', (j) =>
            j.onRef('o.tenant_id', '=', 'l.tenant_id').onRef('o.id', '=', 'l.purchase_order_id'),
          )
          .select([
            'l.product_id',
            sql<number>`sum(greatest(l.qty_milli - l.received_qty_milli, 0))::bigint`.as('pending'),
          ])
          .where('l.tenant_id', '=', t)
          .where('o.store_id', '=', store.id)
          .where('o.status', 'in', ['sent', 'partially_received'])
          .where('l.product_id', 'in', ids)
          .groupBy('l.product_id')
          .execute()
      : Promise.resolve([]),
    lastPurchases(tx, ctx, ids),
  ])
  const soldOf = new Map(sales.map((r) => [r.product_id, Number(r.sold)]))
  const pendingOf = new Map(openPo.map((r) => [r.product_id, Number(r.pending)]))

  const groups = new Map<
    string,
    {
      supplier: { id: string; name: string; phone: string | null } | null
      items: ReorderItem[]
      estimated_cost_paise: number
    }
  >()
  for (const p of products) {
    const lp = last.get(p.id)
    if (q.supplier_id && lp?.supplier_id !== q.supplier_id) continue
    const stock = Number(p.stock_milli)
    const avg = averageDailySalesMilli(soldOf.get(p.id) ?? 0, REORDER_SALES_WINDOW_DAYS)
    const suggested = suggestedReorderQtyMilli({
      reorder_level_milli: p.reorder_level_milli ?? 0,
      reorder_qty_milli: p.reorder_qty_milli,
      stock_milli: stock,
    })
    const cost = lp?.unit_cost_paise ?? p.purchase_price_paise
    const item: ReorderItem = {
      product_id: p.id,
      name: p.name,
      name_ta: p.name_ta,
      sku: p.sku,
      unit: p.unit,
      pack_size: p.pack_size,
      category_id: p.category_id,
      current_stock_milli: stock,
      reorder_level_milli: p.reorder_level_milli ?? 0,
      reorder_qty_milli: p.reorder_qty_milli,
      avg_daily_sales_milli: avg,
      days_of_cover: avg > 0 ? Math.floor(Math.max(0, stock) / avg) : null,
      suggested_qty_milli: suggested,
      open_po_qty_milli: pendingOf.get(p.id) ?? 0,
      last_cost_paise: lp?.unit_cost_paise ?? null,
      last_bill_date: lp?.received_date ?? null,
      gst_rate_bp: p.gst_rate_bp,
      estimated_cost_paise: amountForQty(cost, suggested, p.pack_size),
    }
    const key = lp?.supplier_id ?? ''
    let group = groups.get(key)
    if (!group) {
      group = {
        supplier: lp
          ? { id: lp.supplier_id, name: lp.supplier_name, phone: lp.supplier_phone }
          : null,
        items: [],
        estimated_cost_paise: 0,
      }
      groups.set(key, group)
    }
    group.items.push(item)
    group.estimated_cost_paise += item.estimated_cost_paise
  }
  const ordered = [...groups.values()].sort((a, b) => {
    if (!a.supplier) return 1
    if (!b.supplier) return -1
    return a.supplier.name.localeCompare(b.supplier.name, 'en')
  })
  return {
    store_id: store.id,
    generated_at: iso(new Date()),
    window_days: REORDER_SALES_WINDOW_DAYS,
    groups: ordered,
  }
}
