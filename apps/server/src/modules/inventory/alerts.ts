/**
 * Stock alerts (GET /stock/alerts and the inventory.alerts digest): low stock (0 < qty ≤ reorder
 * level), out of stock (qty ≤ 0 for products stocked in the scope before or with a reorder level;
 * never-stocked catalogue items are not alerts), batches expiring within
 * settings.inventory.expiry_warning_days and expired batches that still hold stock — counts plus
 * the top `limit` items of each list.
 */
import { type RawBuilder, sql } from 'kysely'
import { addDays } from '@kadai/shared'
import type { ExpiryAlertItem, StockAlertItem, StockAlerts } from '@kadai/shared/api/inventory'
import { getSettings } from '../../core/settings'
import type { Tx } from '../../db/tenant'
import { type Ctx, type StoreScope, businessToday, memberStoresSql, storeScopeSql } from './common'

type ScopeCtx = Pick<Ctx, 'tenantId' | 'storeIds'>

function productAggCte(ctx: ScopeCtx, scope: StoreScope): RawBuilder<unknown> {
  return sql`with agg as (
      select l.product_id, sum(l.qty_milli)::bigint as qty_milli, count(*)::bigint as row_count
        from stock_levels l
       where l.tenant_id = ${ctx.tenantId}
         and ${storeScopeSql(sql`l.store_id`, scope)}
         and ${memberStoresSql(sql`l.store_id`, ctx)}
       group by l.product_id
    ),
    items as (
      select p.id as product_id, p.sku, p.name, p.name_ta, p.unit, p.pack_size,
             coalesce(a.qty_milli, 0)::bigint as qty_milli,
             p.reorder_level_milli, p.reorder_qty_milli,
             coalesce(a.row_count, 0)::bigint as row_count
        from products p
        left join agg a on a.product_id = p.id
       where p.tenant_id = ${ctx.tenantId} and p.is_active and p.track_inventory
         and p.kind <> 'variant_parent'
    )`
}

const LOW = sql`qty_milli > 0 and reorder_level_milli is not null and qty_milli <= reorder_level_milli`
const OUT = sql`qty_milli <= 0 and (row_count > 0 or reorder_level_milli is not null)`

function batchAggCte(ctx: ScopeCtx, scope: StoreScope): RawBuilder<unknown> {
  return sql`with bagg as (
      select l.batch_id, l.product_id, sum(l.qty_milli)::bigint as qty_milli,
             sum(round(l.avg_cost_paise::numeric * l.qty_milli / (p.pack_size * 1000)))::bigint as value_cost_paise
        from stock_levels l
        join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       where l.tenant_id = ${ctx.tenantId} and l.batch_id is not null
         and ${storeScopeSql(sql`l.store_id`, scope)}
         and ${memberStoresSql(sql`l.store_id`, ctx)}
       group by l.batch_id, l.product_id
      having sum(l.qty_milli) > 0
    ),
    bitems as (
      select a.batch_id, b.batch_no, a.product_id, p.name, p.name_ta, p.unit, p.pack_size,
             b.expiry_date, a.qty_milli, a.value_cost_paise
        from bagg a
        join batches b on b.tenant_id = ${ctx.tenantId} and b.id = a.batch_id
        join products p on p.tenant_id = ${ctx.tenantId} and p.id = a.product_id
       where b.expiry_date is not null
    )`
}

type RawStockItem = Omit<StockAlertItem, 'store_id'>
type RawExpiryItem = Omit<ExpiryAlertItem, 'store_id'>

/** Counts and top items for a scope (a single store, or every store with storeIds null). */
export async function computeAlerts(
  tx: Tx,
  ctx: ScopeCtx,
  scope: StoreScope,
  limit: number,
  opts: { today?: string } = {},
): Promise<StockAlerts> {
  const today = opts.today ?? (await businessToday(tx, ctx)).today
  const warn = (await getSettings(tx, ctx)).inventory.expiry_warning_days
  const until = addDays(today, warn)
  const storeId = scope.kind === 'single' ? scope.storeId : null

  const pcte = productAggCte(ctx, scope)
  const counts = await sql<{ low: number; out: number; negative: number }>`${pcte}
    select count(*) filter (where ${LOW})::bigint as low,
           count(*) filter (where ${OUT} and qty_milli = 0)::bigint as out,
           count(*) filter (where ${OUT} and qty_milli < 0)::bigint as negative
      from items`.execute(tx)
  const low = await sql<RawStockItem>`${pcte}
    select product_id, sku, name, name_ta, unit, pack_size, qty_milli, reorder_level_milli,
           reorder_qty_milli
      from items where ${LOW}
     order by qty_milli::numeric / nullif(reorder_level_milli, 0) asc nulls first, name asc, product_id
     limit ${limit}`.execute(tx)
  const out = await sql<RawStockItem>`${pcte}
    select product_id, sku, name, name_ta, unit, pack_size, qty_milli, reorder_level_milli,
           reorder_qty_milli
      from items where ${OUT}
     order by qty_milli asc, name asc, product_id
     limit ${limit}`.execute(tx)

  const bcte = batchAggCte(ctx, scope)
  const expiryWhere = {
    expiring: sql`expiry_date >= ${today}::date and expiry_date <= ${until}::date`,
    expired: sql`expiry_date < ${today}::date`,
  }
  const bcounts = await sql<{
    expiring: number
    expired: number
    expiring_value: number
    expired_value: number
  }>`${bcte}
    select count(*) filter (where ${expiryWhere.expiring})::bigint as expiring,
           count(*) filter (where ${expiryWhere.expired})::bigint as expired,
           coalesce(sum(value_cost_paise) filter (where ${expiryWhere.expiring}), 0)::bigint as expiring_value,
           coalesce(sum(value_cost_paise) filter (where ${expiryWhere.expired}), 0)::bigint as expired_value
      from bitems`.execute(tx)
  const batchList = (where: RawBuilder<unknown>) =>
    sql<RawExpiryItem>`${bcte}
      select batch_id, batch_no, product_id, name, name_ta, unit, pack_size, expiry_date,
             (expiry_date - ${today}::date)::int as days_to_expiry, qty_milli, value_cost_paise
        from bitems where ${where}
       order by expiry_date asc, name asc, batch_id
       limit ${limit}`.execute(tx)
  const expiring = await batchList(expiryWhere.expiring)
  const expired = await batchList(expiryWhere.expired)

  const c = counts.rows[0]
  const bc = bcounts.rows[0]
  const stockItem = (r: RawStockItem): StockAlertItem => ({ store_id: storeId, ...r })
  const expiryItem = (r: RawExpiryItem): ExpiryAlertItem => ({ store_id: storeId, ...r })
  return {
    store_id: storeId,
    as_of: today,
    expiry_warning_days: warn,
    counts: {
      low_stock: Number(c?.low ?? 0),
      out_of_stock: Number(c?.out ?? 0),
      negative: Number(c?.negative ?? 0),
      expiring: Number(bc?.expiring ?? 0),
      expired: Number(bc?.expired ?? 0),
    },
    low_stock: low.rows.map(stockItem),
    out_of_stock: out.rows.map(stockItem),
    expiring: expiring.rows.map(expiryItem),
    expired: expired.rows.map(expiryItem),
    expiring_value_paise: Number(bc?.expiring_value ?? 0),
    expired_value_paise: Number(bc?.expired_value ?? 0),
  }
}
