/**
 * Stock transfers between stores (features stock_transfers + multi_store).
 *
 * * Drafts (CRUD): source store, destination store, date, notes and lines (product, batch for
 *   batch-tracked products, quantity). Draft costs and values are live (current average cost at
 *   the source); the source store's available stock is shown per line.
 * * POST :id/dispatch — numbers the transfer ('stock_transfer' series of the source store) and
 *   posts transfer_out at the source at the current average cost, which is fixed on each line.
 *   Needs access to the source store. No journal yet: the goods are in transit and stay in the
 *   source store's inventory account until they are received.
 * * POST :id/receive — needs access to the destination store. The received quantity is posted as
 *   transfer_in at the destination at the dispatch cost; a shortfall is returned to the source
 *   (transfer_in at the dispatch cost) and written off there as 'damage' at the source cost, so
 *   total stock changes only by the recorded shortfall. Journal: Dr inventory (to) / Cr inventory
 *   (from) for the received value, Dr inventory_writeoff / Cr inventory (from) for the shortfall,
 *   and the per-movement rounding residue (≤ 1 paisa per line) to inventory_adjustment — from the
 *   values actually posted, so each store's inventory account equals its stock movements.
 * * POST :id/cancel — a draft becomes 'cancelled'; a dispatched transfer brings its stock back to
 *   the source (transfer_in at the dispatch cost); received / cancelled transfers → 409.
 * * Dispatch, receive and cancel are audited.
 */
import { type RawBuilder, sql } from 'kysely'
import { type TransferStatus, newId } from '@kadai/shared'
import {
  type StockTransfer,
  type StockTransferDetail,
  type TransferAction,
  type TransferCreateSchema,
  type TransferLine,
  type TransferListQuerySchema,
  type TransferReceiveSchema,
  type TransferUpdateSchema,
  stockValuePaise,
  transferAccessStoreId,
  transferShortfall,
} from '@kadai/shared/api/inventory'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { assertNotStale, forbidden, notFound, validationError } from '../../core/errors'
import { assertStoreAccess, type PageEnvelope, type PageParams, pageResult } from '../../core/http'
import { type StockMovementInput, postStock } from '../../core/inventory'
import { type JournalLineInput, postJournal } from '../../core/ledger'
import { nextNumber } from '../../core/numbering'
import { canAccessStore } from '../../core/context'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  type StoreInfo,
  andAll,
  assertNotFuture,
  businessToday,
  checkStockLines,
  fieldIssue,
  iso,
  likePattern,
  loadStore,
  reasonError,
  rowKey,
  rowStates,
  userNames,
} from './common'

type TransferCreate = z.output<typeof TransferCreateSchema>
type TransferUpdate = z.output<typeof TransferUpdateSchema>
type TransferReceive = z.output<typeof TransferReceiveSchema>
type TransferListQuery = z.output<typeof TransferListQuerySchema>
type LineInput = TransferCreate['lines'][number]

export const TRANSFER_REF = 'stock_transfer'

interface HeaderRow {
  id: string
  number: string | null
  fy: string | null
  from_store_id: string
  to_store_id: string
  transfer_date: string
  status: TransferStatus
  notes: string | null
  dispatched_at: Date | null
  dispatched_by: string | null
  received_at: Date | null
  received_by: string | null
  received_date: string | null
  shortfall_reason: string | null
  cancelled_at: Date | null
  cancelled_by: string | null
  cancel_reason: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
}

interface LineRow {
  id: string
  line_no: number
  product_id: string
  batch_id: string | null
  qty_milli: number
  received_qty_milli: number | null
  unit_cost_paise: number
  shortfall_value_paise: number
}

const HEADER_COLUMNS = [
  'id',
  'number',
  'fy',
  'from_store_id',
  'to_store_id',
  'transfer_date',
  'status',
  'notes',
  'dispatched_at',
  'dispatched_by',
  'received_at',
  'received_by',
  'received_date',
  'shortfall_reason',
  'cancelled_at',
  'cancelled_by',
  'cancel_reason',
  'created_by',
  'created_at',
  'updated_at',
] as const

const LINE_COLUMNS = [
  'id',
  'line_no',
  'product_id',
  'batch_id',
  'qty_milli',
  'received_qty_milli',
  'unit_cost_paise',
  'shortfall_value_paise',
] as const

/** A member sees a transfer when it can access its source or its destination store. */
function canSee(ctx: Pick<Ctx, 'storeIds'>, h: Pick<HeaderRow, 'from_store_id' | 'to_store_id'>) {
  return canAccessStore(ctx, h.from_store_id) || canAccessStore(ctx, h.to_store_id)
}

/** Store access an action needs (receive: destination; everything else: source). */
function assertActionAccess(
  ctx: Pick<Ctx, 'storeIds'>,
  action: TransferAction,
  h: Pick<HeaderRow, 'from_store_id' | 'to_store_id'>,
): void {
  assertStoreAccess(ctx, transferAccessStoreId(action, h))
}

async function loadHeader(
  tx: Tx,
  ctx: Ctx,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<HeaderRow> {
  let q = tx
    .selectFrom('stock_transfers')
    .select(HEADER_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (opts.lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('stock_transfer', id)
  if (!canSee(ctx, row)) {
    throw forbidden('You do not have access to the stores of this transfer', {
      store_id: row.from_store_id,
    })
  }
  return row as HeaderRow
}

async function loadLines(tx: Tx, ctx: Ctx, transferId: string): Promise<LineRow[]> {
  return tx
    .selectFrom('stock_transfer_lines')
    .select(LINE_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('transfer_id', '=', transferId)
    .orderBy('line_no')
    .execute()
}

function lineValues(ctx: Ctx, transferId: string, lines: readonly LineInput[]) {
  return lines.map((l, i) => ({
    id: newId(),
    tenant_id: ctx.tenantId,
    transfer_id: transferId,
    line_no: i + 1,
    product_id: l.product_id,
    batch_id: l.batch_id,
    qty_milli: l.qty_milli,
  }))
}

/** Both stores exist, differ and are active; returns them. */
async function checkStores(
  tx: Tx,
  ctx: Ctx,
  fromStoreId: string,
  toStoreId: string,
): Promise<{ from: StoreInfo; to: StoreInfo }> {
  if (fromStoreId === toStoreId) throw fieldIssue(['to_store_id'], 'transfer_same_store')
  const from = await loadStore(tx, ctx, fromStoreId, {
    requireActive: true,
    path: 'from_store_id',
  })
  const to = await loadStore(tx, ctx, toStoreId, { requireActive: true, path: 'to_store_id' })
  return { from, to }
}

function statusConflict(h: HeaderRow, expected: 'draft' | 'dispatched'): never {
  if (h.status === 'cancelled') {
    throw reasonError('CONFLICT', 'already_cancelled', 'This transfer is already cancelled', {
      status: h.status,
    })
  }
  if (expected === 'draft') {
    throw reasonError(
      'CONFLICT',
      'not_draft',
      `Only draft transfers can be changed or dispatched (this one is ${h.status})`,
      { status: h.status },
    )
  }
  throw reasonError(
    'CONFLICT',
    'not_dispatched',
    `Only dispatched transfers can be received (this one is ${h.status})`,
    { status: h.status },
  )
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Live cost per pack and source stock of draft lines (no lock). */
async function draftStates(
  tx: Tx,
  ctx: Ctx,
  items: readonly { from_store_id: string; product_id: string; batch_id: string | null }[],
) {
  return rowStates(
    tx,
    ctx,
    items.map((i) => ({
      store_id: i.from_store_id,
      product_id: i.product_id,
      batch_id: i.batch_id,
    })),
  )
}

function timeline(
  h: HeaderRow,
  names: ReadonlyMap<string, string>,
): StockTransferDetail['timeline'] {
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  const events: StockTransferDetail['timeline'] = [
    {
      event: 'created',
      at: iso(h.created_at),
      user_id: h.created_by,
      user_name: name(h.created_by),
      note: h.notes,
    },
  ]
  if (h.dispatched_at) {
    events.push({
      event: 'dispatched',
      at: iso(h.dispatched_at),
      user_id: h.dispatched_by,
      user_name: name(h.dispatched_by),
      note: h.number,
    })
  }
  if (h.received_at) {
    events.push({
      event: 'received',
      at: iso(h.received_at),
      user_id: h.received_by,
      user_name: name(h.received_by),
      note: h.shortfall_reason,
    })
  }
  if (h.cancelled_at) {
    events.push({
      event: 'cancelled',
      at: iso(h.cancelled_at),
      user_id: h.cancelled_by,
      user_name: name(h.cancelled_by),
      note: h.cancel_reason,
    })
  }
  return events
}

/** Full transfer view (lines with product / batch details and costs, status timeline). */
export async function transferDetail(tx: Tx, ctx: Ctx, id: string): Promise<StockTransferDetail> {
  const h = await loadHeader(tx, ctx, id)
  const from = await loadStore(tx, ctx, h.from_store_id)
  const to = await loadStore(tx, ctx, h.to_store_id)
  const lines = await tx
    .selectFrom('stock_transfer_lines as l')
    .innerJoin('products as p', (j) =>
      j.onRef('p.tenant_id', '=', 'l.tenant_id').onRef('p.id', '=', 'l.product_id'),
    )
    .leftJoin('batches as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.batch_id'),
    )
    .select([
      ...LINE_COLUMNS.map((c) => `l.${c}` as const),
      'p.name as product_name',
      'p.name_ta as product_name_ta',
      'p.sku',
      'p.unit',
      'p.pack_size',
      'p.track_batches',
      'b.batch_no',
      'b.expiry_date',
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.transfer_id', '=', id)
    .orderBy('l.line_no')
    .execute()
  const isDraft = h.status === 'draft'
  const states = isDraft
    ? await draftStates(
        tx,
        ctx,
        lines.map((l) => ({ ...l, from_store_id: h.from_store_id })),
      )
    : new Map()
  let total = 0
  let shortfallValue = 0
  const outLines: TransferLine[] = lines.map((l) => {
    const state = isDraft
      ? states.get(
          rowKey({ store_id: h.from_store_id, product_id: l.product_id, batch_id: l.batch_id }),
        )
      : undefined
    const cost = isDraft ? (state?.unit_cost_paise ?? 0) : l.unit_cost_paise
    const value = stockValuePaise(cost, l.qty_milli, l.pack_size)
    total += value
    shortfallValue += l.shortfall_value_paise
    return {
      id: l.id,
      line_no: l.line_no,
      product_id: l.product_id,
      product_name: l.product_name,
      product_name_ta: l.product_name_ta,
      sku: l.sku,
      unit: l.unit,
      pack_size: l.pack_size,
      track_batches: l.track_batches,
      batch_id: l.batch_id,
      batch_no: l.batch_no,
      expiry_date: l.expiry_date,
      qty_milli: l.qty_milli,
      received_qty_milli: l.received_qty_milli,
      shortfall_qty_milli: transferShortfall(l.qty_milli, l.received_qty_milli),
      unit_cost_paise: cost,
      value_paise: value,
      available_qty_milli: isDraft ? (state?.qty_milli ?? 0) : null,
    }
  })
  const names = await userNames(tx, [h.created_by, h.dispatched_by, h.received_by, h.cancelled_by])
  return {
    id: h.id,
    number: h.number,
    fy: h.fy,
    from_store_id: h.from_store_id,
    from_store_code: from.code,
    from_store_name: from.name,
    to_store_id: h.to_store_id,
    to_store_code: to.code,
    to_store_name: to.name,
    transfer_date: h.transfer_date,
    status: h.status,
    notes: h.notes,
    line_count: lines.length,
    total_value_paise: total,
    shortfall_value_paise: shortfallValue,
    dispatched_at: h.dispatched_at === null ? null : iso(h.dispatched_at),
    dispatched_by_name: h.dispatched_by ? (names.get(h.dispatched_by) ?? null) : null,
    received_at: h.received_at === null ? null : iso(h.received_at),
    received_by_name: h.received_by ? (names.get(h.received_by) ?? null) : null,
    created_by_name: h.created_by ? (names.get(h.created_by) ?? null) : null,
    created_at: iso(h.created_at),
    updated_at: iso(h.updated_at),
    lines: outLines,
    timeline: timeline(h, names),
  }
}

function listOrder(q: TransferListQuery): RawBuilder<unknown> {
  const dir = q.sort.direction === 'asc' ? sql`asc` : sql`desc`
  switch (q.sort.field) {
    case 'created_at':
      return sql`t.created_at ${dir}, t.id ${dir}`
    case 'number':
      return sql`t.number ${dir} nulls last, t.created_at desc, t.id desc`
    case 'transfer_date':
      return sql`t.transfer_date ${dir}, t.created_at ${dir}, t.id ${dir}`
  }
}

/** Visibility of a transfer row `t` for the member (source or destination accessible). */
function visibleSql(ctx: Pick<Ctx, 'storeIds'>): RawBuilder<unknown> {
  if (ctx.storeIds === null) return sql`true`
  if (ctx.storeIds.length === 0) return sql`false`
  const ids = [...ctx.storeIds]
  return sql`(t.from_store_id = any(${ids}::uuid[]) or t.to_store_id = any(${ids}::uuid[]))`
}

/** GET /stock-transfers */
export async function listTransfers(
  tx: Tx,
  ctx: Ctx,
  q: TransferListQuery,
  page: PageParams,
): Promise<PageEnvelope<StockTransfer>> {
  const conds: RawBuilder<unknown>[] = [visibleSql(ctx)]
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    if (q.direction === 'in') conds.push(sql`t.to_store_id = ${q.store_id}::uuid`)
    else if (q.direction === 'out') conds.push(sql`t.from_store_id = ${q.store_id}::uuid`)
    else
      conds.push(
        sql`(t.from_store_id = ${q.store_id}::uuid or t.to_store_id = ${q.store_id}::uuid)`,
      )
  }
  if (q.from_store_id) conds.push(sql`t.from_store_id = ${q.from_store_id}::uuid`)
  if (q.to_store_id) conds.push(sql`t.to_store_id = ${q.to_store_id}::uuid`)
  if (q.status) conds.push(sql`t.status = ${q.status}`)
  if (q.q) {
    const like = likePattern(q.q)
    conds.push(
      sql`(lower(coalesce(t.number, '')) like ${like} or lower(coalesce(t.notes, '')) like ${like})`,
    )
  }
  if (q.from) conds.push(sql`t.transfer_date >= ${q.from}::date`)
  if (q.to) conds.push(sql`t.transfer_date <= ${q.to}::date`)
  const where = andAll(conds)
  const res = await sql<
    HeaderRow & {
      from_store_code: string
      from_store_name: string
      to_store_code: string
      to_store_name: string
      line_count: number
      value_paise: number
      shortfall_value_paise: number
      dispatched_by_name: string | null
      received_by_name: string | null
      created_by_name: string | null
      __total: number
    }
  >`
    select t.id, t.number, t.fy, t.from_store_id, t.to_store_id, t.transfer_date, t.status, t.notes,
           t.dispatched_at, t.dispatched_by, t.received_at, t.received_by, t.received_date,
           t.shortfall_reason, t.cancelled_at, t.cancelled_by, t.cancel_reason, t.created_by,
           t.created_at, t.updated_at,
           fs.code as from_store_code, fs.name as from_store_name,
           ts.code as to_store_code, ts.name as to_store_name,
           coalesce(lt.line_count, 0)::int as line_count,
           coalesce(lt.value_paise, 0)::bigint as value_paise,
           coalesce(lt.shortfall_value_paise, 0)::bigint as shortfall_value_paise,
           du.full_name as dispatched_by_name, ru.full_name as received_by_name,
           cu.full_name as created_by_name,
           count(*) over()::bigint as __total
      from stock_transfers t
      join stores fs on fs.tenant_id = t.tenant_id and fs.id = t.from_store_id
      join stores ts on ts.tenant_id = t.tenant_id and ts.id = t.to_store_id
      left join lateral (
        select count(*) as line_count,
               sum(round(l.unit_cost_paise::numeric * l.qty_milli / (p.pack_size * 1000))) as value_paise,
               sum(l.shortfall_value_paise) as shortfall_value_paise
          from stock_transfer_lines l
          join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         where l.tenant_id = t.tenant_id and l.transfer_id = t.id
      ) lt on true
      left join users du on du.id = t.dispatched_by
      left join users ru on ru.id = t.received_by
      left join users cu on cu.id = t.created_by
     where t.tenant_id = ${ctx.tenantId} and ${where}
     order by ${listOrder(q)}
     limit ${page.limit} offset ${page.offset}`.execute(tx)
  let total = Number(res.rows[0]?.__total ?? 0)
  if (res.rows.length === 0 && page.offset > 0) {
    const c = await sql<{ n: number }>`
      select count(*)::bigint as n from stock_transfers t
       where t.tenant_id = ${ctx.tenantId} and ${where}`.execute(tx)
    total = Number(c.rows[0]?.n ?? 0)
  }
  const live = await draftValues(
    tx,
    ctx,
    res.rows.filter((r) => r.status === 'draft'),
  )
  const data: StockTransfer[] = res.rows.map((r) => ({
    id: r.id,
    number: r.number,
    fy: r.fy,
    from_store_id: r.from_store_id,
    from_store_code: r.from_store_code,
    from_store_name: r.from_store_name,
    to_store_id: r.to_store_id,
    to_store_code: r.to_store_code,
    to_store_name: r.to_store_name,
    transfer_date: r.transfer_date,
    status: r.status,
    notes: r.notes,
    line_count: r.line_count,
    total_value_paise: r.status === 'draft' ? (live.get(r.id) ?? 0) : Number(r.value_paise),
    shortfall_value_paise: Number(r.shortfall_value_paise),
    dispatched_at: r.dispatched_at === null ? null : iso(r.dispatched_at),
    dispatched_by_name: r.dispatched_by_name,
    received_at: r.received_at === null ? null : iso(r.received_at),
    received_by_name: r.received_by_name,
    created_by_name: r.created_by_name,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }))
  return pageResult(data, page, total)
}

/** Live value (current source average cost) of draft transfers. */
async function draftValues(
  tx: Tx,
  ctx: Ctx,
  drafts: readonly { id: string; from_store_id: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (drafts.length === 0) return out
  const lines = await tx
    .selectFrom('stock_transfer_lines as l')
    .innerJoin('products as p', (j) =>
      j.onRef('p.tenant_id', '=', 'l.tenant_id').onRef('p.id', '=', 'l.product_id'),
    )
    .select(['l.transfer_id', 'l.product_id', 'l.batch_id', 'l.qty_milli', 'p.pack_size'])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where(
      'l.transfer_id',
      'in',
      drafts.map((d) => d.id),
    )
    .execute()
  const fromById = new Map(drafts.map((d) => [d.id, d.from_store_id]))
  const states = await draftStates(
    tx,
    ctx,
    lines.map((l) => ({ ...l, from_store_id: fromById.get(l.transfer_id)! })),
  )
  for (const d of drafts) out.set(d.id, 0)
  for (const l of lines) {
    const storeId = fromById.get(l.transfer_id)!
    const cost =
      states.get(rowKey({ store_id: storeId, product_id: l.product_id, batch_id: l.batch_id }))
        ?.unit_cost_paise ?? 0
    out.set(
      l.transfer_id,
      out.get(l.transfer_id)! + stockValuePaise(cost, l.qty_milli, l.pack_size),
    )
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Draft writes
// ---------------------------------------------------------------------------------------------

/** POST /stock-transfers (draft; source store access). */
export async function createTransfer(
  tx: Tx,
  ctx: Ctx,
  body: TransferCreate,
): Promise<StockTransferDetail> {
  assertActionAccess(ctx, 'create', body)
  await checkStores(tx, ctx, body.from_store_id, body.to_store_id)
  const { today } = await businessToday(tx, ctx)
  const date = body.transfer_date ?? today
  assertNotFuture(date, today, ['transfer_date'])
  await checkStockLines(tx, ctx, body.lines)
  const id = newId()
  await tx
    .insertInto('stock_transfers')
    .values({
      id,
      tenant_id: ctx.tenantId,
      from_store_id: body.from_store_id,
      to_store_id: body.to_store_id,
      transfer_date: date,
      status: 'draft',
      notes: body.notes ?? null,
      created_by: ctx.userId,
    })
    .execute()
  await tx
    .insertInto('stock_transfer_lines')
    .values(lineValues(ctx, id, body.lines))
    .execute()
  return transferDetail(tx, ctx, id)
}

/** PATCH /stock-transfers/:id (draft only; `lines` replaces every line). */
export async function updateTransfer(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: TransferUpdate,
): Promise<StockTransferDetail> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  if (h.status !== 'draft') statusConflict(h, 'draft')
  assertActionAccess(ctx, 'update', h)
  assertNotStale(h.updated_at, body.if_updated_at, 'stock_transfer', id)
  const next = {
    from_store_id: body.from_store_id ?? h.from_store_id,
    to_store_id: body.to_store_id ?? h.to_store_id,
  }
  assertActionAccess(ctx, 'update', next)
  if (next.from_store_id !== h.from_store_id || next.to_store_id !== h.to_store_id) {
    await checkStores(tx, ctx, next.from_store_id, next.to_store_id)
  }
  if (body.transfer_date) {
    const { today } = await businessToday(tx, ctx)
    assertNotFuture(body.transfer_date, today, ['transfer_date'])
  }
  if (body.lines) {
    await checkStockLines(tx, ctx, body.lines)
    await tx
      .deleteFrom('stock_transfer_lines')
      .where('tenant_id', '=', ctx.tenantId)
      .where('transfer_id', '=', id)
      .execute()
    await tx
      .insertInto('stock_transfer_lines')
      .values(lineValues(ctx, id, body.lines))
      .execute()
  }
  await tx
    .updateTable('stock_transfers')
    .set({
      from_store_id: next.from_store_id,
      to_store_id: next.to_store_id,
      ...(body.transfer_date ? { transfer_date: body.transfer_date } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      updated_at: sql<Date>`now()`,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  return transferDetail(tx, ctx, id)
}

// ---------------------------------------------------------------------------------------------
// Dispatch / receive / cancel
// ---------------------------------------------------------------------------------------------

/** POST /stock-transfers/:id/dispatch (source store access). */
export async function dispatchTransfer(tx: Tx, ctx: Ctx, id: string): Promise<StockTransferDetail> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  if (h.status !== 'draft') statusConflict(h, 'draft')
  assertActionAccess(ctx, 'dispatch', h)
  const { from, to } = await checkStores(tx, ctx, h.from_store_id, h.to_store_id)
  const { today } = await businessToday(tx, ctx)
  assertNotFuture(h.transfer_date, today, ['transfer_date'])
  const lines = await loadLines(tx, ctx, id)
  if (lines.length === 0) {
    throw reasonError('UNPROCESSABLE', 'empty_document', 'Add at least one line before dispatching')
  }
  await checkStockLines(tx, ctx, lines)

  const posted = await postStock(
    tx,
    ctx,
    lines.map((l) => ({
      store_id: h.from_store_id,
      product_id: l.product_id,
      batch_id: l.batch_id,
      qty_milli: -l.qty_milli,
      movement_type: 'transfer_out' as const,
      ref_type: TRANSFER_REF,
      ref_id: id,
      ref_line_id: l.id,
      reason: h.notes,
    })),
  )
  await sql`
    update stock_transfer_lines as l
       set unit_cost_paise = v.cost
      from (values ${sql.join(
        lines.map((l, i) => sql`(${l.id}::uuid, ${posted[i]!.unit_cost_paise}::bigint)`),
      )}) as v(id, cost)
     where l.tenant_id = ${ctx.tenantId} and l.id = v.id`.execute(tx)
  const num = await nextNumber(tx, ctx, {
    docType: 'stock_transfer',
    storeId: h.from_store_id,
    date: h.transfer_date,
  })
  await tx
    .updateTable('stock_transfers')
    .set({
      status: 'dispatched',
      number: num.number,
      fy: num.fy,
      dispatched_at: sql<Date>`now()`,
      dispatched_by: ctx.userId,
      updated_at: sql<Date>`now()`,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  const value = posted.reduce((acc, r) => acc + r.cost_paise, 0)
  await audit(tx, ctx, {
    action: 'stock_transfer.dispatch',
    entity_type: TRANSFER_REF,
    entity_id: id,
    summary: `Transfer ${num.number} dispatched from ${from.code} to ${to.code}: ${String(lines.length)} lines, value ${String(value)} paise`,
    changes: {
      from_store_id: from.id,
      to_store_id: to.id,
      lines: lines.length,
      value_paise: value,
    },
  })
  return transferDetail(tx, ctx, id)
}

/** Received quantity per line from the receipt body (lines not listed: received in full). */
function receivedQuantities(lines: readonly LineRow[], body: TransferReceive): Map<string, number> {
  const out = new Map(lines.map((l) => [l.id, l.qty_milli]))
  const issues: { path: string; message: string; code: string }[] = []
  body.lines?.forEach((r, i) => {
    const line = lines.find((l) => l.id === r.line_id)
    if (!line) {
      issues.push({
        path: `lines.${String(i)}.line_id`,
        message: 'unknown_line',
        code: 'unknown_line',
      })
      return
    }
    if (r.received_qty_milli > line.qty_milli) {
      issues.push({
        path: `lines.${String(i)}.received_qty_milli`,
        message: 'received_exceeds_dispatched',
        code: 'received_exceeds_dispatched',
      })
      return
    }
    out.set(line.id, r.received_qty_milli)
  })
  if (issues.length) throw validationError(issues)
  return out
}

/** POST /stock-transfers/:id/receive (destination store access). */
export async function receiveTransfer(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: TransferReceive,
): Promise<StockTransferDetail> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  if (h.status !== 'dispatched') statusConflict(h, 'dispatched')
  assertActionAccess(ctx, 'receive', h)
  const to = await loadStore(tx, ctx, h.to_store_id, { requireActive: true, path: 'to_store_id' })
  const from = await loadStore(tx, ctx, h.from_store_id)
  const { today } = await businessToday(tx, ctx)
  const receivedDate = body.received_date ?? today
  assertNotFuture(receivedDate, today, ['received_date'])
  if (receivedDate < h.transfer_date)
    throw fieldIssue(['received_date'], 'received_before_dispatch')
  const lines = await loadLines(tx, ctx, id)
  const received = receivedQuantities(lines, body)
  const packs = new Map(
    (
      await tx
        .selectFrom('products')
        .select(['id', 'pack_size'])
        .where('tenant_id', '=', ctx.tenantId)
        .where(
          'id',
          'in',
          lines.map((l) => l.product_id),
        )
        .execute()
    ).map((p) => [p.id, p.pack_size]),
  )

  // Movements: received → transfer_in at the destination; shortfall → back to the source and
  // written off there (net zero at the source, so negative balances there never block it).
  type Planned = { line: LineRow; role: 'in_dest' | 'return_src' | 'damage_src' }
  const planned: Planned[] = []
  const inputs: StockMovementInput[] = []
  const shortfallNote = body.shortfall_reason ?? null
  for (const l of lines) {
    const rec = received.get(l.id) ?? l.qty_milli
    const short = l.qty_milli - rec
    const base = {
      product_id: l.product_id,
      batch_id: l.batch_id,
      ref_type: TRANSFER_REF,
      ref_id: id,
      ref_line_id: l.id,
    }
    if (rec > 0) {
      planned.push({ line: l, role: 'in_dest' })
      inputs.push({
        ...base,
        store_id: h.to_store_id,
        qty_milli: rec,
        movement_type: 'transfer_in',
        unit_cost_paise: l.unit_cost_paise,
        reason: h.notes,
      })
    }
    if (short > 0) {
      planned.push({ line: l, role: 'return_src' }, { line: l, role: 'damage_src' })
      inputs.push(
        {
          ...base,
          store_id: h.from_store_id,
          qty_milli: short,
          movement_type: 'transfer_in',
          unit_cost_paise: l.unit_cost_paise,
          reason: `Short on receipt${shortfallNote ? `: ${shortfallNote}` : ''}`,
        },
        {
          ...base,
          store_id: h.from_store_id,
          qty_milli: -short,
          movement_type: 'damage',
          reason: `Transit shortfall${shortfallNote ? `: ${shortfallNote}` : ''}`,
        },
      )
    }
  }
  const posted = await postStock(tx, ctx, inputs, { allowNegative: true })

  let inDest = 0
  let returned = 0
  let damaged = 0
  const damageByLine = new Map<string, number>()
  posted.forEach((r, i) => {
    const p = planned[i]!
    if (p.role === 'in_dest') inDest += r.cost_paise
    else if (p.role === 'return_src') returned += r.cost_paise
    else {
      damaged += r.cost_paise
      damageByLine.set(p.line.id, (damageByLine.get(p.line.id) ?? 0) + r.cost_paise)
    }
  })
  const dispatched = lines.reduce(
    (acc, l) => acc + stockValuePaise(l.unit_cost_paise, l.qty_milli, packs.get(l.product_id) ?? 1),
    0,
  )
  // Source credit = what left it at dispatch less what came back; any difference to the value
  // received is per-movement rounding.
  const sourceCredit = dispatched - returned
  const residue = sourceCredit - inDest
  const journalLines: JournalLineInput[] = [
    { account: { subtype: 'inventory' }, debit_paise: inDest, store_id: h.to_store_id },
    { account: { subtype: 'inventory' }, credit_paise: sourceCredit, store_id: h.from_store_id },
    {
      account: { subtype: 'inventory_writeoff' },
      debit_paise: damaged,
      store_id: h.from_store_id,
      memo: shortfallNote,
    },
    { account: { subtype: 'inventory' }, credit_paise: damaged, store_id: h.from_store_id },
  ]
  if (residue !== 0) {
    journalLines.push(
      residue > 0
        ? {
            account: { subtype: 'inventory_adjustment' },
            debit_paise: residue,
            store_id: h.from_store_id,
          }
        : {
            account: { subtype: 'inventory_adjustment' },
            credit_paise: -residue,
            store_id: h.from_store_id,
          },
    )
  }
  await postJournal(tx, ctx, {
    entry_date: receivedDate,
    store_id: h.to_store_id,
    source_type: 'stock_transfer',
    source_id: id,
    narration: `Stock transfer ${h.number ?? ''} ${from.code} → ${to.code}`,
    lines: journalLines,
  })

  await sql`
    update stock_transfer_lines as l
       set received_qty_milli = v.received, shortfall_value_paise = v.shortfall
      from (values ${sql.join(
        lines.map(
          (l) =>
            sql`(${l.id}::uuid, ${received.get(l.id) ?? l.qty_milli}::bigint, ${damageByLine.get(l.id) ?? 0}::bigint)`,
        ),
      )}) as v(id, received, shortfall)
     where l.tenant_id = ${ctx.tenantId} and l.id = v.id`.execute(tx)
  await tx
    .updateTable('stock_transfers')
    .set({
      status: 'received',
      received_at: sql<Date>`now()`,
      received_by: ctx.userId,
      received_date: receivedDate,
      shortfall_reason: shortfallNote,
      updated_at: sql<Date>`now()`,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  const shortLines = lines.filter((l) => (received.get(l.id) ?? l.qty_milli) < l.qty_milli).length
  await audit(tx, ctx, {
    action: 'stock_transfer.receive',
    entity_type: TRANSFER_REF,
    entity_id: id,
    summary: `Transfer ${h.number ?? ''} received at ${to.code}${
      shortLines ? `: ${String(shortLines)} lines short, written off ${String(damaged)} paise` : ''
    }`,
    changes: {
      received_value_paise: inDest,
      shortfall_value_paise: damaged,
      short_lines: shortLines,
      ...(shortfallNote ? { shortfall_reason: shortfallNote } : {}),
    },
  })
  return transferDetail(tx, ctx, id)
}

/** POST /stock-transfers/:id/cancel (source store access). */
export async function cancelTransfer(
  tx: Tx,
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<StockTransferDetail> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  if (h.status === 'cancelled') statusConflict(h, 'draft')
  if (h.status === 'received') {
    throw reasonError(
      'CONFLICT',
      'already_received',
      'A received transfer cannot be cancelled; transfer the stock back instead',
      { status: h.status },
    )
  }
  assertActionAccess(ctx, 'cancel', h)
  let reversed = 0
  if (h.status === 'dispatched') {
    const lines = await loadLines(tx, ctx, id)
    const posted = await postStock(
      tx,
      ctx,
      lines.map((l) => ({
        store_id: h.from_store_id,
        product_id: l.product_id,
        batch_id: l.batch_id,
        qty_milli: l.qty_milli,
        movement_type: 'transfer_in' as const,
        unit_cost_paise: l.unit_cost_paise,
        ref_type: TRANSFER_REF,
        ref_id: id,
        ref_line_id: l.id,
        reason: `Cancelled ${h.number ?? ''}: ${reason}`.slice(0, 500),
      })),
    )
    reversed = posted.reduce((acc, r) => acc + r.cost_paise, 0)
  }
  await tx
    .updateTable('stock_transfers')
    .set({
      status: 'cancelled',
      cancelled_at: sql<Date>`now()`,
      cancelled_by: ctx.userId,
      cancel_reason: reason,
      updated_at: sql<Date>`now()`,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'stock_transfer.cancel',
    entity_type: TRANSFER_REF,
    entity_id: id,
    summary: `Transfer ${h.number ?? '(draft)'} cancelled: ${reason}`,
    changes: { previous_status: h.status, reason, returned_value_paise: reversed },
  })
  return transferDetail(tx, ctx, id)
}
