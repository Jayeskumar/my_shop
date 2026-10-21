/**
 * Batches: GET /batches (product / store / supplier filters, expiring within N days, expired,
 * with stock only, search, sort; quantity and value at cost in the store, else summed over the
 * member's stores) and PATCH /batches/:id (MRP / prices / dates / active flag — audited; expiry
 * and manufacturing date changes need inventory.adjust).
 */
import { type RawBuilder, sql } from 'kysely'
import { addDays, hasPermission } from '@kadai/shared'
import {
  type BatchListQuerySchema,
  type BatchRow,
  type BatchUpdateSchema,
  expiryStatus,
} from '@kadai/shared/api/inventory'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { assertNotStale, notFound } from '../../core/errors'
import { assertStoreAccess, type PageEnvelope, type PageParams, pageResult } from '../../core/http'
import { getSettings } from '../../core/settings'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  andAll,
  businessToday,
  fieldIssue,
  iso,
  likePattern,
  memberStoresSql,
  reasonError,
} from './common'

type BatchListQuery = z.output<typeof BatchListQuerySchema>
type BatchUpdate = z.output<typeof BatchUpdateSchema>

interface RawBatch {
  id: string
  product_id: string
  product_name: string
  product_name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  batch_no: string
  mfg_date: string | null
  expiry_date: string | null
  mrp_paise: number | null
  purchase_price_paise: number | null
  sale_price_paise: number | null
  supplier_id: string | null
  supplier_name: string | null
  is_active: boolean
  qty_milli: number
  value_cost_paise: number
  created_at: Date
  updated_at: Date
}

function batchQuery(
  ctx: Ctx,
  storeId: string | undefined,
  where: RawBuilder<unknown>,
  tail: RawBuilder<unknown>,
) {
  const levelStore = storeId ? sql`l.store_id = ${storeId}::uuid` : sql`true`
  return sql<RawBatch & { __total: number }>`
    with q as (
      select l.batch_id, sum(l.qty_milli)::bigint as qty_milli,
             sum(round(l.avg_cost_paise::numeric * l.qty_milli / (lp.pack_size * 1000)))::bigint as value_cost_paise
        from stock_levels l
        join products lp on lp.tenant_id = l.tenant_id and lp.id = l.product_id
       where l.tenant_id = ${ctx.tenantId} and l.batch_id is not null
         and ${levelStore} and ${memberStoresSql(sql`l.store_id`, ctx)}
       group by l.batch_id
    )
    select b.id, b.product_id, p.name as product_name, p.name_ta as product_name_ta, p.sku, p.unit,
           p.pack_size, b.batch_no, b.mfg_date, b.expiry_date, b.mrp_paise, b.purchase_price_paise,
           b.sale_price_paise, b.supplier_id, s.name as supplier_name, b.is_active,
           coalesce(q.qty_milli, 0)::bigint as qty_milli,
           coalesce(q.value_cost_paise, 0)::bigint as value_cost_paise,
           b.created_at, b.updated_at, count(*) over()::bigint as __total
      from batches b
      join products p on p.tenant_id = b.tenant_id and p.id = b.product_id
      left join suppliers s on s.tenant_id = b.tenant_id and s.id = b.supplier_id
      left join q on q.batch_id = b.id
     where b.tenant_id = ${ctx.tenantId} and ${where}
     ${tail}`
}

function toBatchRow(r: RawBatch, today: string, warn: number): BatchRow {
  const exp = expiryStatus(r.expiry_date, today, warn)
  return {
    ...r,
    expiry_status: exp.status,
    days_to_expiry: exp.days_to_expiry,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

function orderBy(q: BatchListQuery): RawBuilder<unknown> {
  const dir = q.sort.direction === 'asc' ? sql`asc` : sql`desc`
  const tail = sql`b.batch_no asc, b.id asc`
  switch (q.sort.field) {
    case 'product_name':
      return sql`p.name ${dir}, b.expiry_date asc nulls last, ${tail}`
    case 'qty':
      return sql`qty_milli ${dir}, ${tail}`
    case 'created_at':
      return sql`b.created_at ${dir}, ${tail}`
    case 'expiry_date':
      return sql`b.expiry_date ${dir} nulls last, p.name asc, ${tail}`
  }
}

/** GET /batches */
export async function listBatches(
  tx: Tx,
  ctx: Ctx,
  q: BatchListQuery,
  page: PageParams,
): Promise<PageEnvelope<BatchRow>> {
  if (q.store_id) assertStoreAccess(ctx, q.store_id)
  const { today } = await businessToday(tx, ctx)
  const warn = (await getSettings(tx, ctx)).inventory.expiry_warning_days
  const conds: RawBuilder<unknown>[] = []
  if (q.product_id) conds.push(sql`b.product_id = ${q.product_id}::uuid`)
  if (q.supplier_id) conds.push(sql`b.supplier_id = ${q.supplier_id}::uuid`)
  if (q.ids?.length) conds.push(sql`b.id = any(${q.ids}::uuid[])`)
  if (q.is_active !== undefined) conds.push(sql`b.is_active = ${q.is_active}`)
  if (q.q) {
    const like = likePattern(q.q)
    conds.push(sql`(lower(b.batch_no) like ${like} or p.search_text like ${like})`)
  }
  if (q.expiring_within_days !== undefined) {
    conds.push(
      sql`b.expiry_date >= ${today}::date and b.expiry_date <= ${addDays(today, q.expiring_within_days)}::date`,
    )
  }
  if (q.expired === true) conds.push(sql`b.expiry_date < ${today}::date`)
  if (q.expired === false)
    conds.push(sql`(b.expiry_date is null or b.expiry_date >= ${today}::date)`)
  if (q.with_stock_only) conds.push(sql`coalesce(q.qty_milli, 0) > 0`)
  const res = await batchQuery(
    ctx,
    q.store_id,
    andAll(conds),
    sql`order by ${orderBy(q)} limit ${page.limit} offset ${page.offset}`,
  ).execute(tx)
  let total = Number(res.rows[0]?.__total ?? 0)
  if (res.rows.length === 0 && page.offset > 0) {
    const c = await batchQuery(ctx, q.store_id, andAll(conds), sql``).execute(tx)
    total = c.rows.length
  }
  return pageResult(
    res.rows.map(({ __total: _t, ...r }) => toBatchRow(r, today, warn)),
    page,
    total,
  )
}

/** One batch row (quantity over the member's stores). */
export async function getBatchRow(tx: Tx, ctx: Ctx, id: string): Promise<BatchRow> {
  const { today } = await businessToday(tx, ctx)
  const warn = (await getSettings(tx, ctx)).inventory.expiry_warning_days
  const res = await batchQuery(ctx, undefined, sql`b.id = ${id}::uuid`, sql``).execute(tx)
  const row = res.rows[0]
  if (!row) throw notFound('batch', id)
  const { __total: _t, ...r } = row
  return toBatchRow(r, today, warn)
}

/** PATCH /batches/:id (audited 'batch.update'). */
export async function updateBatch(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: BatchUpdate,
): Promise<BatchRow> {
  const before = await tx
    .selectFrom('batches')
    .select([
      'id',
      'product_id',
      'batch_no',
      'mrp_paise',
      'sale_price_paise',
      'purchase_price_paise',
      'expiry_date',
      'mfg_date',
      'is_active',
      'updated_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!before) throw notFound('batch', id)
  assertNotStale(before.updated_at, body.if_updated_at, 'batch', id)

  const datesChange =
    (body.expiry_date !== undefined && body.expiry_date !== before.expiry_date) ||
    (body.mfg_date !== undefined && body.mfg_date !== before.mfg_date)
  if (datesChange && !hasPermission(ctx.permissions, 'inventory.adjust')) {
    throw reasonError(
      'FORBIDDEN',
      'expiry_change_forbidden',
      'Changing expiry or manufacturing dates needs the stock adjustment permission',
      { required: ['inventory.adjust'] },
    )
  }
  const next = {
    mrp_paise: body.mrp_paise === undefined ? before.mrp_paise : body.mrp_paise,
    sale_price_paise:
      body.sale_price_paise === undefined ? before.sale_price_paise : body.sale_price_paise,
    purchase_price_paise:
      body.purchase_price_paise === undefined
        ? before.purchase_price_paise
        : body.purchase_price_paise,
    expiry_date: body.expiry_date === undefined ? before.expiry_date : body.expiry_date,
    mfg_date: body.mfg_date === undefined ? before.mfg_date : body.mfg_date,
    is_active: body.is_active ?? before.is_active,
  }
  if (next.mfg_date && next.expiry_date && next.mfg_date > next.expiry_date) {
    throw fieldIssue(['expiry_date'], 'batch_dates')
  }
  const { updated_at: _u, id: _id, product_id: _p, batch_no: _b, ...prev } = before
  const changes = diffChanges(prev, next)
  if (changes) {
    await tx
      .updateTable('batches')
      .set({ ...next, updated_at: sql<Date>`now()` })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    await audit(tx, ctx, {
      action: 'batch.update',
      entity_type: 'batch',
      entity_id: id,
      summary: `Batch ${before.batch_no} changed: ${Object.keys(changes.after).join(', ')}`,
      changes,
    })
  }
  return getBatchRow(tx, ctx, id)
}
