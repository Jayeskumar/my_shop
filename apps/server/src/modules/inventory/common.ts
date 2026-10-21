/**
 * Shared helpers of the inventory module: store scoping (default store, `all`), stock-item and
 * batch checks for document lines, cost basis of stock rows, user names, business dates, CSV
 * replies and SQL fragments. Everything runs inside the caller's tenant transaction.
 */
import type { FastifyReply } from 'fastify'
import { type RawBuilder, sql } from 'kysely'
import { type ErrorCode, todayIn } from '@kadai/shared'
import {
  type InventoryErrorReason,
  type InventoryValidationKey,
  qtyAllowed,
} from '@kadai/shared/api/inventory'
import type { RequestContext } from '../../core/context'
import { assertFeature } from '../../core/entitlements'
import { AppError, notFound, validationError } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { stockLevelKey } from '../../core/inventory'
import { tenantCalendar } from '../../core/numbering'
import type { Tx } from '../../db/tenant'

export type Ctx = RequestContext

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** AppError carrying `details.reason` (INVENTORY_ERROR_REASONS). */
export function reasonError(
  code: ErrorCode,
  reason: InventoryErrorReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError(code, message, { reason, ...details })
}

/** 400 VALIDATION_ERROR with one snake_case message key at `path`. */
export function fieldIssue(path: (string | number)[], key: InventoryValidationKey): AppError {
  return validationError([{ path: path.join('.'), message: key, code: key }])
}

// ---------------------------------------------------------------------------------------------
// Business dates
// ---------------------------------------------------------------------------------------------

/** Today in the tenant timezone, and the timezone. */
export async function businessToday(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
): Promise<{ today: string; timezone: string }> {
  const cal = await tenantCalendar(tx, ctx)
  return { today: todayIn(cal.timezone), timezone: cal.timezone }
}

/** Rejects a business date after today (VALIDATION_ERROR future_date at `path`). */
export function assertNotFuture(date: string, today: string, path: (string | number)[]): void {
  if (date > today) throw fieldIssue(path, 'future_date')
}

// ---------------------------------------------------------------------------------------------
// Stores and store scope
// ---------------------------------------------------------------------------------------------

export interface StoreInfo {
  id: string
  code: string
  name: string
  name_ta: string | null
  is_active: boolean
}

export async function loadStore(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  storeId: string,
  opts: { requireActive?: boolean; path?: string } = {},
): Promise<StoreInfo> {
  const row = await tx
    .selectFrom('stores')
    .select(['id', 'code', 'name', 'name_ta', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', storeId)
    .executeTakeFirst()
  if (!row) throw notFound('store', storeId)
  if (opts.requireActive && !row.is_active) {
    throw reasonError('UNPROCESSABLE', 'store_inactive', `Store ${row.code} is deactivated`, {
      store_id: row.id,
      ...(opts.path ? { path: opts.path } : {}),
    })
  }
  return row
}

/**
 * The member's default store when a request names none: the trusted device's register store,
 * else the first store of a store-scoped membership, else the tenant's first active store.
 */
export async function defaultStoreId(tx: Tx, ctx: Ctx): Promise<string> {
  if (ctx.registerId) {
    const reg = await tx
      .selectFrom('registers')
      .select('store_id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', ctx.registerId)
      .executeTakeFirst()
    if (reg && (ctx.storeIds === null || ctx.storeIds.includes(reg.store_id))) return reg.store_id
  }
  if (ctx.storeIds !== null) {
    const first = ctx.storeIds[0]
    if (!first) throw reasonError('FORBIDDEN', 'all_stores_required', 'No store is assigned to you')
    return first
  }
  const row = await tx
    .selectFrom('stores')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('is_active', 'desc')
    .orderBy('created_at')
    .orderBy('code')
    .executeTakeFirst()
  if (!row) throw notFound('store')
  return row.id
}

/**
 * Store scope of a read: `single` = one store (default store when omitted); `all` = every store
 * (storeIds null), which needs access to every store and the multi_store feature.
 */
export type StoreScope = { kind: 'single'; storeId: string } | { kind: 'all' }

export async function resolveStoreScope(
  tx: Tx,
  ctx: Ctx,
  storeId: string | undefined,
): Promise<StoreScope> {
  if (storeId === 'all') {
    if (ctx.storeIds !== null) {
      throw reasonError(
        'FORBIDDEN',
        'all_stores_required',
        'Viewing all stores together needs access to every store',
      )
    }
    await assertFeature(ctx, 'multi_store')
    return { kind: 'all' }
  }
  const id = storeId ?? (await defaultStoreId(tx, ctx))
  assertStoreAccess(ctx, id)
  await loadStore(tx, ctx, id)
  return { kind: 'single', storeId: id }
}

/** SQL condition restricting `column` (a store id) to the scope (and the member's stores). */
export function storeScopeSql(column: RawBuilder<unknown>, scope: StoreScope): RawBuilder<unknown> {
  return scope.kind === 'single' ? sql`${column} = ${scope.storeId}::uuid` : sql`true`
}

/** SQL condition restricting `column` to the member's stores (no-op for all-store members). */
export function memberStoresSql(
  column: RawBuilder<unknown>,
  ctx: Pick<Ctx, 'storeIds'>,
): RawBuilder<unknown> {
  if (ctx.storeIds === null) return sql`true`
  if (ctx.storeIds.length === 0) return sql`false`
  return sql`${column} = any(${[...ctx.storeIds]}::uuid[])`
}

// ---------------------------------------------------------------------------------------------
// Products and batches of document lines
// ---------------------------------------------------------------------------------------------

export interface StockProduct {
  id: string
  name: string
  name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  kind: string
  allow_loose: boolean
  decimal_qty: boolean
  track_inventory: boolean
  track_batches: boolean
  purchase_price_paise: number
  is_active: boolean
}

export async function loadProducts(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  ids: readonly string[],
): Promise<Map<string, StockProduct>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await tx
    .selectFrom('products')
    .select([
      'id',
      'name',
      'name_ta',
      'sku',
      'unit',
      'pack_size',
      'kind',
      'allow_loose',
      'decimal_qty',
      'track_inventory',
      'track_batches',
      'purchase_price_paise',
      'is_active',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', unique)
    .execute()
  return new Map(rows.map((r) => [r.id, r]))
}

export interface BatchInfo {
  id: string
  product_id: string
  batch_no: string
  expiry_date: string | null
  mfg_date: string | null
  mrp_paise: number | null
  sale_price_paise: number | null
  purchase_price_paise: number | null
  is_active: boolean
}

export async function loadBatches(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  ids: readonly string[],
): Promise<Map<string, BatchInfo>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await tx
    .selectFrom('batches')
    .select([
      'id',
      'product_id',
      'batch_no',
      'expiry_date',
      'mfg_date',
      'mrp_paise',
      'sale_price_paise',
      'purchase_price_paise',
      'is_active',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', unique)
    .execute()
  return new Map(rows.map((r) => [r.id, r]))
}

/** Quantity fields of a document line checked by {@link checkStockLine} (whichever are set). */
export const QTY_FIELDS = ['qty_milli', 'qty_delta_milli', 'counted_qty_milli'] as const

export interface StockLineInput {
  product_id: string
  batch_id: string | null
  qty_milli?: number | null | undefined
  qty_delta_milli?: number | null | undefined
  counted_qty_milli?: number | null | undefined
}

/**
 * 400 VALIDATION_ERROR decimal_qty_not_allowed at `path` when a quantity is fractional for a
 * product counted in whole units (qtyAllowed).
 */
export function assertQtyAllowed(
  product: Pick<StockProduct, 'unit' | 'decimal_qty'>,
  qtyMilli: number,
  path: (string | number)[],
): void {
  if (!qtyAllowed(product, qtyMilli)) throw fieldIssue(path, 'decimal_qty_not_allowed')
}

/**
 * Checks a document line's product (exists, holds stock), batch (required for batch-tracked
 * products, forbidden otherwise, of the same product) and quantities (whole units unless the
 * product is measured in decimals). `path` is the line path ('lines.3').
 */
export function checkStockLine(
  line: StockLineInput,
  products: ReadonlyMap<string, StockProduct>,
  batches: ReadonlyMap<string, BatchInfo>,
  path: string,
): StockProduct {
  const p = products.get(line.product_id)
  if (!p) throw notFound('product', line.product_id)
  if (!p.track_inventory || p.kind === 'variant_parent' || p.kind === 'service') {
    throw reasonError('UNPROCESSABLE', 'not_stock_item', `${p.name} does not hold stock`, {
      product_id: p.id,
      path: `${path}.product_id`,
    })
  }
  if (p.track_batches && !line.batch_id) {
    throw reasonError(
      'UNPROCESSABLE',
      'batch_required',
      `${p.name} is batch-tracked: choose a batch`,
      {
        product_id: p.id,
        path: `${path}.batch_id`,
      },
    )
  }
  if (!p.track_batches && line.batch_id) {
    throw reasonError('UNPROCESSABLE', 'batch_not_allowed', `${p.name} does not track batches`, {
      product_id: p.id,
      path: `${path}.batch_id`,
    })
  }
  if (line.batch_id) {
    const b = batches.get(line.batch_id)
    if (!b) throw notFound('batch', line.batch_id)
    if (b.product_id !== p.id) {
      throw reasonError(
        'UNPROCESSABLE',
        'batch_product_mismatch',
        `Batch ${b.batch_no} belongs to another product`,
        { batch_id: b.id, product_id: p.id, path: `${path}.batch_id` },
      )
    }
  }
  for (const field of QTY_FIELDS) {
    const qty = line[field]
    if (typeof qty === 'number') assertQtyAllowed(p, qty, [...path.split('.'), field])
  }
  return p
}

/** Loads and checks the products / batches of document lines in one go. */
export async function checkStockLines(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  lines: readonly StockLineInput[],
): Promise<{ products: Map<string, StockProduct>; batches: Map<string, BatchInfo> }> {
  const products = await loadProducts(
    tx,
    ctx,
    lines.map((l) => l.product_id),
  )
  const batches = await loadBatches(
    tx,
    ctx,
    lines.flatMap((l) => (l.batch_id ? [l.batch_id] : [])),
  )
  lines.forEach((l, i) => checkStockLine(l, products, batches, `lines.${String(i)}`))
  return { products, batches }
}

// ---------------------------------------------------------------------------------------------
// Stock rows: current quantity and cost basis (no lock; postStock re-reads under lock)
// ---------------------------------------------------------------------------------------------

export interface RowKey {
  store_id: string
  product_id: string
  batch_id: string | null
}

export interface RowState {
  qty_milli: number
  /** Cost per pack postStock would use for an outbound movement now (average or fallback). */
  unit_cost_paise: number
}

export const rowKey = (k: RowKey): string => stockLevelKey(k)

/**
 * Current quantity and cost basis of stock rows: the row's moving average once it has moved,
 * else the batch purchase price, else the product purchase price (mirrors core postStock).
 */
export async function rowStates(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  keys: readonly RowKey[],
): Promise<Map<string, RowState>> {
  const out = new Map<string, RowState>()
  if (keys.length === 0) return out
  const productIds = [...new Set(keys.map((k) => k.product_id))]
  const storeIds = [...new Set(keys.map((k) => k.store_id))]
  const levels = await tx
    .selectFrom('stock_levels')
    .select([
      'store_id',
      'product_id',
      'batch_id',
      'qty_milli',
      'avg_cost_paise',
      'last_movement_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('product_id', 'in', productIds)
    .where('store_id', 'in', storeIds)
    .execute()
  const byKey = new Map(levels.map((l) => [rowKey(l), l]))
  const products = await loadProducts(tx, ctx, productIds)
  const batches = await loadBatches(
    tx,
    ctx,
    keys.flatMap((k) => (k.batch_id ? [k.batch_id] : [])),
  )
  for (const k of keys) {
    const level = byKey.get(rowKey(k))
    const fallback =
      (k.batch_id ? batches.get(k.batch_id)?.purchase_price_paise : null) ??
      products.get(k.product_id)?.purchase_price_paise ??
      0
    out.set(rowKey(k), {
      qty_milli: level?.qty_milli ?? 0,
      unit_cost_paise: level && level.last_movement_at !== null ? level.avg_cost_paise : fallback,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

/** full_name by user id (users visible through the tenant's memberships). */
export async function userNames(
  tx: Tx,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => typeof v === 'string'))]
  if (unique.length === 0) return new Map()
  const rows = await tx
    .selectFrom('users')
    .select(['id', 'full_name'])
    .where('id', 'in', unique)
    .execute()
  return new Map(rows.map((r) => [r.id, r.full_name]))
}

// ---------------------------------------------------------------------------------------------
// SQL & replies
// ---------------------------------------------------------------------------------------------

/** `a and b and …` (true when empty). */
export function andAll(conds: readonly RawBuilder<unknown>[]): RawBuilder<unknown> {
  return conds.length ? sql`(${sql.join(conds, sql` and `)})` : sql`true`
}

/** ILIKE pattern for user text (escapes %, _ and \). */
export function likePattern(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** CSV download (UTF-8, attachment). */
export function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_')
  return reply
    .code(200)
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${safe}"`)
    .send(Buffer.from(csv, 'utf8'))
}

/** Timestamp column → ISO string (response schemas output strings). */
export function iso(value: Date | string): string
export function iso(value: Date | string | null): string | null
export function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
