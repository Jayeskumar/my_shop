/**
 * Inventory posting (ARCHITECTURE.md §8.2) — the ONLY writer of stock_levels and stock_movements.
 *
 *   const posted = await postStock(tx, ctx, [
 *     { store_id, product_id, batch_id, qty_milli: -2000, movement_type: 'sale',
 *       ref_type: 'sales_invoice', ref_id: invoice.id, ref_line_id: line.id },
 *   ])
 *   posted[0].cost_paise   // COGS of the line (cost per pack × qty / (pack_size × 1000))
 *
 * * stock_levels is the materialised balance per (store, product, batch); stock_movements is the
 *   append-only ledger. Both are written in the caller's transaction, so
 *   Σ movements = level at all times.
 * * Rows are locked in a deterministic order — (product_id, batch_id NULLS FIRST, store_id) —
 *   after an `INSERT … ON CONFLICT DO NOTHING` that creates missing rows in the same order, so
 *   concurrent postings never deadlock and never lose updates.
 * * Costs are per PACK (`products.pack_size` base units), excluding tax. Inbound movements move
 *   the average: new_avg = (old_qty × old_avg + in_qty × in_cost) / (old_qty + in_qty), or the
 *   inbound cost when old_qty ≤ 0. Outbound movements are costed at the row's average; for
 *   batch-tracked products the row IS the batch, so its average is the batch's (landed) purchase
 *   price — batches.purchase_price_paise is the fallback for a batch without cost history.
 * * Negative stock follows `settings.inventory.allow_negative_stock` unless `opts.allowNegative`
 *   overrides it; otherwise 422 INSUFFICIENT_STOCK {product_id, name, available_milli,
 *   requested_milli, store_id, batch_id, items[]}.
 * * Products with track_inventory = false (services) are skipped (returned with skipped: true).
 */
import { sql } from 'kysely'
import {
  type StockMovementType,
  StockMovementTypeSchema,
  isDateStr,
  isUuid,
  mulDiv,
  newId,
  roundDivBig,
  toSafeNumber,
} from '@kadai/shared'
import type { Tx } from '../db/tenant'
import type { RequestContext } from './context'
import { AppError, invalidField, notFound, unprocessable } from './errors'
import { getSettings } from './settings'

type Ctx = Pick<RequestContext, 'tenantId' | 'userId'>

/** Sign each movement type must have (0 = either: adjustments / stock takes). */
export const MOVEMENT_DIRECTION: Readonly<Record<StockMovementType, 1 | -1 | 0>> = {
  opening: 1,
  purchase: 1,
  purchase_return: -1,
  sale: -1,
  sale_return: 1,
  adjustment: 0,
  stock_take: 0,
  damage: -1,
  expiry_writeoff: -1,
  transfer_out: -1,
  transfer_in: 1,
  sale_cancel: 1,
  purchase_cancel: -1,
}

/**
 * Inbound types that must carry their own cost. Other inbound movements (adjustment gains,
 * returns / cancellations posted without a cost) fall back to the row's current cost.
 */
const COST_REQUIRED: ReadonlySet<StockMovementType> = new Set([
  'opening',
  'purchase',
  'transfer_in',
])

export interface StockMovementInput {
  store_id: string
  product_id: string
  /** Required for batch-tracked products, must be null/omitted otherwise. */
  batch_id?: string | null
  /** Signed base-unit milli quantity: + in, − out. Never 0. */
  qty_milli: number
  movement_type: StockMovementType
  /** Cost per pack excl. tax; required for opening / purchase / transfer_in. */
  unit_cost_paise?: number | null
  ref_type?: string | null
  ref_id?: string | null
  ref_line_id?: string | null
  reason?: string | null
}

export interface PostedMovement {
  /** stock_movements.id (null when skipped). */
  movement_id: string | null
  store_id: string
  product_id: string
  batch_id: string | null
  qty_milli: number
  movement_type: StockMovementType
  /** Cost per pack used for this movement (inbound: the given cost; outbound: COGS basis). */
  unit_cost_paise: number
  /** |value| of the movement at unit cost: round(unit_cost × |qty| / (pack_size × 1000)). */
  cost_paise: number
  /** Signed value (same sign as qty_milli). */
  value_paise: number
  /** Row balance after this movement. */
  balance_after_milli: number
  /** Row average cost per pack after this movement. */
  avg_cost_after_paise: number
  /** True for products that do not track inventory (nothing was written). */
  skipped: boolean
}

export interface PostStockOptions {
  /** Allow balances to go below zero regardless of the tenant setting (offline sync). */
  allowNegative?: boolean
}

interface ProductInfo {
  id: string
  name: string
  kind: string
  pack_size: number
  track_inventory: boolean
  track_batches: boolean
  purchase_price_paise: number
}

interface BatchInfo {
  id: string
  product_id: string
  purchase_price_paise: number | null
}

interface LevelState {
  id: string
  qty: number
  avg: number
  /** The row has moved before (its average is meaningful). */
  hasHistory: boolean
}

interface Shortfall {
  product_id: string
  name: string
  store_id: string
  batch_id: string | null
  available_milli: number
  requested_milli: number
}

const levelKey = (storeId: string, productId: string, batchId: string | null): string =>
  `${productId}|${batchId ?? ''}|${storeId}`

/** Deterministic lock order: product, batch (null first), store — mirrors the SQL ORDER BY. */
function compareKeys(
  a: { product_id: string; batch_id: string | null; store_id: string },
  b: { product_id: string; batch_id: string | null; store_id: string },
): number {
  if (a.product_id !== b.product_id) return a.product_id < b.product_id ? -1 : 1
  if (a.batch_id !== b.batch_id) {
    if (a.batch_id === null) return -1
    if (b.batch_id === null) return 1
    return a.batch_id < b.batch_id ? -1 : 1
  }
  if (a.store_id !== b.store_id) return a.store_id < b.store_id ? -1 : 1
  return 0
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)]

function normalizeId(value: unknown, path: string): string {
  if (!isUuid(value)) throw invalidField(path, 'Expected a UUID')
  return value.toLowerCase()
}

interface NormalizedMovement {
  store_id: string
  product_id: string
  batch_id: string | null
  qty_milli: number
  movement_type: StockMovementType
  unit_cost_paise: number | null
  ref_type: string | null
  ref_id: string | null
  ref_line_id: string | null
  reason: string | null
}

function normalize(m: StockMovementInput, i: number): NormalizedMovement {
  const path = `movements.${i}`
  if (!StockMovementTypeSchema.safeParse(m.movement_type).success) {
    throw invalidField(
      `${path}.movement_type`,
      `Unknown movement type "${String(m.movement_type)}"`,
    )
  }
  if (!Number.isSafeInteger(m.qty_milli) || m.qty_milli === 0) {
    throw invalidField(`${path}.qty_milli`, 'Quantity must be a non-zero integer (milli units)')
  }
  const dir = MOVEMENT_DIRECTION[m.movement_type]
  if (dir !== 0 && Math.sign(m.qty_milli) !== dir) {
    throw invalidField(
      `${path}.qty_milli`,
      `A ${m.movement_type} movement must be ${dir > 0 ? 'positive (inbound)' : 'negative (outbound)'}`,
    )
  }
  const cost = m.unit_cost_paise ?? null
  if (cost !== null && (!Number.isSafeInteger(cost) || cost < 0)) {
    throw invalidField(`${path}.unit_cost_paise`, 'Cost must be a non-negative integer (paise)')
  }
  if (m.qty_milli > 0 && cost === null && COST_REQUIRED.has(m.movement_type)) {
    throw invalidField(`${path}.unit_cost_paise`, `A ${m.movement_type} movement needs a unit cost`)
  }
  return {
    store_id: normalizeId(m.store_id, `${path}.store_id`),
    product_id: normalizeId(m.product_id, `${path}.product_id`),
    batch_id: m.batch_id == null ? null : normalizeId(m.batch_id, `${path}.batch_id`),
    qty_milli: m.qty_milli,
    movement_type: m.movement_type,
    unit_cost_paise: cost,
    ref_type: m.ref_type ?? null,
    ref_id: m.ref_id == null ? null : normalizeId(m.ref_id, `${path}.ref_id`),
    ref_line_id: m.ref_line_id == null ? null : normalizeId(m.ref_line_id, `${path}.ref_line_id`),
    reason: m.reason ? m.reason.slice(0, 500) : null,
  }
}

/** round(unit_cost × |qty| / (pack × 1000)), overflow-safe. */
export function stockValuePaise(unitCostPaise: number, qtyMilli: number, packSize: number): number {
  return mulDiv(unitCostPaise, Math.abs(qtyMilli), packSize * 1000)
}

/** Moving average per pack after an inbound movement (BigInt: qty × cost can exceed 2^53). */
export function movingAverage(
  oldQty: number,
  oldAvg: number,
  inQty: number,
  inCost: number,
): number {
  if (oldQty <= 0) return inCost
  const total = BigInt(oldQty) * BigInt(oldAvg) + BigInt(inQty) * BigInt(inCost)
  return toSafeNumber(roundDivBig(total, BigInt(oldQty + inQty)))
}

function insufficient(shortfalls: Shortfall[]): AppError {
  const first = shortfalls[0]!
  return new AppError(
    'INSUFFICIENT_STOCK',
    `Not enough stock of ${first.name}: available ${first.available_milli / 1000}, requested ${first.requested_milli / 1000}`,
    { ...first, items: shortfalls },
  )
}

async function loadProducts(tx: Tx, ctx: Ctx, ids: string[]): Promise<Map<string, ProductInfo>> {
  const rows = await tx
    .selectFrom('products')
    .select([
      'id',
      'name',
      'kind',
      'pack_size',
      'track_inventory',
      'track_batches',
      'purchase_price_paise',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', ids)
    .execute()
  const map = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) if (!map.has(id)) throw notFound('product', id)
  return map
}

/**
 * Posts stock movements in the caller's transaction and returns, per input (same order), the
 * cost used and the resulting balance. See the module comment for the rules.
 */
export async function postStock(
  tx: Tx,
  ctx: Ctx,
  movements: readonly StockMovementInput[],
  opts: PostStockOptions = {},
): Promise<PostedMovement[]> {
  if (movements.length === 0) return []
  const items = movements.map(normalize)
  const products = await loadProducts(tx, ctx, unique(items.map((m) => m.product_id)))

  const batchIds = unique(items.flatMap((m) => (m.batch_id ? [m.batch_id] : [])))
  const batches = new Map<string, BatchInfo>()
  if (batchIds.length) {
    const rows = await tx
      .selectFrom('batches')
      .select(['id', 'product_id', 'purchase_price_paise'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', batchIds)
      .execute()
    for (const r of rows) batches.set(r.id, r)
  }

  items.forEach((m, i) => {
    const p = products.get(m.product_id)!
    if (!p.track_inventory) return
    if (p.kind === 'variant_parent') {
      throw unprocessable(`${p.name} is a variant template; post stock to its variants`, {
        product_id: p.id,
        index: i,
      })
    }
    if (p.track_batches && !m.batch_id) {
      throw unprocessable(`${p.name} is batch-tracked: a batch is required`, {
        product_id: p.id,
        index: i,
      })
    }
    if (!p.track_batches && m.batch_id) {
      throw unprocessable(`${p.name} does not track batches`, { product_id: p.id, index: i })
    }
    if (m.batch_id) {
      const b = batches.get(m.batch_id)
      if (!b) throw notFound('batch', m.batch_id)
      if (b.product_id !== m.product_id) {
        throw unprocessable('The batch belongs to another product', {
          batch_id: m.batch_id,
          product_id: m.product_id,
        })
      }
    }
  })

  const tracked = items.filter((m) => products.get(m.product_id)!.track_inventory)
  const state = new Map<string, LevelState>()
  if (tracked.length) {
    const keys = [
      ...new Map(
        tracked.map((m) => [
          levelKey(m.store_id, m.product_id, m.batch_id),
          { store_id: m.store_id, product_id: m.product_id, batch_id: m.batch_id },
        ]),
      ).values(),
    ].sort(compareKeys)

    // Create missing balance rows (same order as the lock below), then lock them all.
    await tx
      .insertInto('stock_levels')
      .values(
        keys.map((k) => ({
          id: newId(),
          tenant_id: ctx.tenantId,
          store_id: k.store_id,
          product_id: k.product_id,
          batch_id: k.batch_id,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute()
    const rows = await tx
      .selectFrom('stock_levels')
      .select([
        'id',
        'store_id',
        'product_id',
        'batch_id',
        'qty_milli',
        'avg_cost_paise',
        'last_movement_at',
      ])
      .where('tenant_id', '=', ctx.tenantId)
      .where((eb) =>
        eb.or(
          keys.map((k) =>
            eb.and([
              eb('store_id', '=', k.store_id),
              eb('product_id', '=', k.product_id),
              k.batch_id === null ? eb('batch_id', 'is', null) : eb('batch_id', '=', k.batch_id),
            ]),
          ),
        ),
      )
      .orderBy('product_id')
      .orderBy(sql`batch_id asc nulls first`)
      .orderBy('store_id')
      .forUpdate()
      .execute()
    for (const r of rows) {
      state.set(levelKey(r.store_id, r.product_id, r.batch_id), {
        id: r.id,
        qty: r.qty_milli,
        avg: r.avg_cost_paise,
        hasHistory: r.last_movement_at !== null,
      })
    }
    if (state.size !== keys.length) throw new Error('stock level rows missing after upsert')
  }

  const allowNegative =
    opts.allowNegative ?? (await getSettings(tx, ctx)).inventory.allow_negative_stock
  const shortfalls: Shortfall[] = []
  const results: PostedMovement[] = []
  const movementRows: Array<{
    id: string
    tenant_id: string
    store_id: string
    product_id: string
    batch_id: string | null
    movement_type: string
    qty_milli: number
    unit_cost_paise: number
    balance_after_milli: number
    ref_type: string | null
    ref_id: string | null
    ref_line_id: string | null
    reason: string | null
    created_by: string | null
  }> = []

  for (const m of items) {
    const p = products.get(m.product_id)!
    if (!p.track_inventory) {
      results.push({
        movement_id: null,
        store_id: m.store_id,
        product_id: m.product_id,
        batch_id: m.batch_id,
        qty_milli: m.qty_milli,
        movement_type: m.movement_type,
        unit_cost_paise: 0,
        cost_paise: 0,
        value_paise: 0,
        balance_after_milli: 0,
        avg_cost_after_paise: 0,
        skipped: true,
      })
      continue
    }
    const level = state.get(levelKey(m.store_id, m.product_id, m.batch_id))!
    const batch = m.batch_id ? batches.get(m.batch_id) : undefined
    // Cost basis of the row: its average once it has moved, else the batch / product price.
    const basis = level.hasHistory
      ? level.avg
      : (batch?.purchase_price_paise ?? p.purchase_price_paise)
    const before = level.qty
    let unitCost: number
    if (m.qty_milli > 0) {
      unitCost = m.unit_cost_paise ?? basis
      level.avg = movingAverage(before, level.hasHistory ? level.avg : 0, m.qty_milli, unitCost)
    } else {
      unitCost = basis
      if (before + m.qty_milli < 0 && !allowNegative) {
        shortfalls.push({
          product_id: p.id,
          name: p.name,
          store_id: m.store_id,
          batch_id: m.batch_id,
          available_milli: Math.max(0, before),
          requested_milli: -m.qty_milli,
        })
      }
      // An outbound movement on a row without history fixes its cost basis from now on.
      if (!level.hasHistory) level.avg = basis
    }
    level.qty = before + m.qty_milli
    if (!Number.isSafeInteger(level.qty)) throw new RangeError('stock quantity overflow')
    level.hasHistory = true
    const cost = stockValuePaise(unitCost, m.qty_milli, p.pack_size)
    const id = newId()
    movementRows.push({
      id,
      tenant_id: ctx.tenantId,
      store_id: m.store_id,
      product_id: m.product_id,
      batch_id: m.batch_id,
      movement_type: m.movement_type,
      qty_milli: m.qty_milli,
      unit_cost_paise: unitCost,
      balance_after_milli: level.qty,
      ref_type: m.ref_type,
      ref_id: m.ref_id,
      ref_line_id: m.ref_line_id,
      reason: m.reason,
      created_by: ctx.userId,
    })
    results.push({
      movement_id: id,
      store_id: m.store_id,
      product_id: m.product_id,
      batch_id: m.batch_id,
      qty_milli: m.qty_milli,
      movement_type: m.movement_type,
      unit_cost_paise: unitCost,
      cost_paise: cost,
      value_paise: m.qty_milli > 0 ? cost : -cost,
      balance_after_milli: level.qty,
      avg_cost_after_paise: level.avg,
      skipped: false,
    })
  }
  if (shortfalls.length) throw insufficient(shortfalls)

  if (movementRows.length) {
    const updates = [...state.values()]
    await sql`
      update stock_levels as s
         set qty_milli = v.qty_milli, avg_cost_paise = v.avg_cost_paise, last_movement_at = now()
        from (values ${sql.join(
          updates.map((u) => sql`(${u.id}::uuid, ${u.qty}::bigint, ${u.avg}::bigint)`),
        )}) as v(id, qty_milli, avg_cost_paise)
       where s.tenant_id = ${ctx.tenantId} and s.id = v.id`.execute(tx)
    await tx.insertInto('stock_movements').values(movementRows).execute()
  }
  return results
}

export interface StockLevelKey {
  store_id: string
  product_id: string
  batch_id: string | null
}

export interface LockedStockLevel extends StockLevelKey {
  qty_milli: number
  avg_cost_paise: number
  /** The row has moved before (its average is meaningful). */
  has_history: boolean
}

/** Map key of a stock row in {@link lockStockLevels} results. */
export const stockLevelKey = (k: StockLevelKey): string =>
  levelKey(k.store_id.toLowerCase(), k.product_id.toLowerCase(), k.batch_id?.toLowerCase() ?? null)

/**
 * Locks the stock_levels rows of `keys` FOR UPDATE for the rest of the caller's transaction —
 * creating missing zero rows first, in the same deterministic order as postStock — and returns
 * their balances (keyed by {@link stockLevelKey}). For postings that must read a balance and post
 * against it atomically (stock takes post counted − system quantity): a concurrent sale or
 * purchase waits for the commit, and the postStock call that follows in the same transaction
 * re-locks the rows without waiting.
 */
export async function lockStockLevels(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  keys: readonly StockLevelKey[],
): Promise<Map<string, LockedStockLevel>> {
  const out = new Map<string, LockedStockLevel>()
  if (keys.length === 0) return out
  const normalized = [
    ...new Map(
      keys.map((k, i) => {
        const n = {
          store_id: normalizeId(k.store_id, `keys.${i}.store_id`),
          product_id: normalizeId(k.product_id, `keys.${i}.product_id`),
          batch_id: k.batch_id == null ? null : normalizeId(k.batch_id, `keys.${i}.batch_id`),
        }
        return [levelKey(n.store_id, n.product_id, n.batch_id), n] as const
      }),
    ).values(),
  ].sort(compareKeys)
  await tx
    .insertInto('stock_levels')
    .values(
      normalized.map((k) => ({
        id: newId(),
        tenant_id: ctx.tenantId,
        store_id: k.store_id,
        product_id: k.product_id,
        batch_id: k.batch_id,
      })),
    )
    .onConflict((oc) => oc.doNothing())
    .execute()
  const rows = await tx
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
    .where((eb) =>
      eb.or(
        normalized.map((k) =>
          eb.and([
            eb('store_id', '=', k.store_id),
            eb('product_id', '=', k.product_id),
            k.batch_id === null ? eb('batch_id', 'is', null) : eb('batch_id', '=', k.batch_id),
          ]),
        ),
      ),
    )
    .orderBy('product_id')
    .orderBy(sql`batch_id asc nulls first`)
    .orderBy('store_id')
    .forUpdate()
    .execute()
  for (const r of rows) {
    out.set(levelKey(r.store_id, r.product_id, r.batch_id), {
      store_id: r.store_id,
      product_id: r.product_id,
      batch_id: r.batch_id,
      qty_milli: r.qty_milli,
      avg_cost_paise: r.avg_cost_paise,
      has_history: r.last_movement_at !== null,
    })
  }
  if (out.size !== normalized.length) throw new Error('stock level rows missing after upsert')
  return out
}

/**
 * On-hand quantity (milli). `batch_id` omitted = all batches (and the batch-less row) of the
 * product in the store; `null` = the batch-less row only; an id = that batch.
 */
export async function getAvailable(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  input: { store_id: string; product_id: string; batch_id?: string | null },
): Promise<number> {
  let q = tx
    .selectFrom('stock_levels')
    .select(sql<number>`coalesce(sum(qty_milli), 0)::bigint`.as('qty'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', input.store_id)
    .where('product_id', '=', input.product_id)
  if (input.batch_id === null) q = q.where('batch_id', 'is', null)
  else if (input.batch_id !== undefined) q = q.where('batch_id', '=', input.batch_id)
  const row = await q.executeTakeFirstOrThrow()
  return Number(row.qty)
}

export interface FefoPick {
  /** null for products that do not track batches (the whole quantity, unbatched). */
  batch_id: string | null
  qty_milli: number
  batch_no: string | null
  expiry_date: string | null
}

export interface PickBatchesInput {
  store_id: string
  product_id: string
  /** Positive quantity to sell (milli). */
  qty_milli: number
  /** Business date (tenant timezone): batches expiring before it are expired. */
  today: string
  /** Defaults to settings.inventory.allow_negative_stock. */
  allowNegative?: boolean
}

/**
 * Splits a sale quantity over batches, first-expiry-first-out (`settings.inventory.fefo`; FIFO by
 * batch creation otherwise). Expired batches (expiry_date < today) are skipped when
 * `settings.inventory.block_expired_sale`. When stock is short and negative stock is allowed the
 * remainder goes to the last batch picked (or the latest-expiring sellable batch); otherwise
 * INSUFFICIENT_STOCK. Products without batch tracking get one unbatched pick.
 *
 * Reads without locking: postStock re-checks the balances under lock, so a concurrent sale
 * cannot oversell — it fails with INSUFFICIENT_STOCK when negatives are not allowed.
 */
export async function pickBatchesFefo(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  input: PickBatchesInput,
): Promise<FefoPick[]> {
  if (!Number.isSafeInteger(input.qty_milli) || input.qty_milli <= 0) {
    throw invalidField('qty_milli', 'Quantity must be a positive integer (milli units)')
  }
  if (!isDateStr(input.today)) throw invalidField('today', 'Expected a date (YYYY-MM-DD)')
  const product = await tx
    .selectFrom('products')
    .select(['id', 'name', 'track_inventory', 'track_batches'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', input.product_id)
    .executeTakeFirst()
  if (!product) throw notFound('product', input.product_id)
  if (!product.track_inventory || !product.track_batches) {
    return [{ batch_id: null, qty_milli: input.qty_milli, batch_no: null, expiry_date: null }]
  }
  const settings = (await getSettings(tx, ctx)).inventory
  const allowNegative = input.allowNegative ?? settings.allow_negative_stock
  let q = tx
    .selectFrom('stock_levels as sl')
    .innerJoin('batches as b', (j) =>
      j.onRef('b.tenant_id', '=', 'sl.tenant_id').onRef('b.id', '=', 'sl.batch_id'),
    )
    .select(['b.id as batch_id', 'b.batch_no', 'b.expiry_date', 'sl.qty_milli'])
    .where('sl.tenant_id', '=', ctx.tenantId)
    .where('sl.store_id', '=', input.store_id)
    .where('sl.product_id', '=', input.product_id)
    .where('b.is_active', '=', true)
  if (settings.block_expired_sale) {
    q = q.where((eb) =>
      eb.or([eb('b.expiry_date', 'is', null), eb('b.expiry_date', '>=', input.today)]),
    )
  }
  q = settings.fefo
    ? q
        .orderBy(sql`b.expiry_date asc nulls last`)
        .orderBy('b.created_at')
        .orderBy('b.id')
    : q.orderBy('b.created_at').orderBy('b.id')
  const rows = await q.execute()

  const picks: FefoPick[] = []
  let remaining = input.qty_milli
  for (const r of rows) {
    if (remaining === 0) break
    if (r.qty_milli <= 0) continue
    const take = Math.min(remaining, r.qty_milli)
    picks.push({
      batch_id: r.batch_id,
      qty_milli: take,
      batch_no: r.batch_no,
      expiry_date: r.expiry_date,
    })
    remaining -= take
  }
  if (remaining > 0) {
    const available = input.qty_milli - remaining
    const target = picks.at(-1) ?? null
    if (allowNegative && (target || rows.length)) {
      if (target) {
        target.qty_milli += remaining
      } else {
        // No sellable stock at all: the latest-expiring sellable batch goes negative.
        const last = rows.at(-1)!
        picks.push({
          batch_id: last.batch_id,
          qty_milli: remaining,
          batch_no: last.batch_no,
          expiry_date: last.expiry_date,
        })
      }
      return picks
    }
    throw insufficient([
      {
        product_id: product.id,
        name: product.name,
        store_id: input.store_id,
        batch_id: null,
        available_milli: available,
        requested_milli: input.qty_milli,
      },
    ])
  }
  return picks
}
