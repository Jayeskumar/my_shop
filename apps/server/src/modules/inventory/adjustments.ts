/**
 * Stock adjustments, stock takes, damage and expiry write-offs (and the read side of opening
 * stock, which is a posted adjustment of kind 'opening').
 *
 * * Drafts (CRUD): lines carry product, batch (required for batch-tracked products), the change
 *   (qty_delta_milli; stock takes: counted_qty_milli), an optional unit cost (gains) and a reason.
 *   Draft values are computed live from the current stock rows.
 * * POST :id/post — numbers the document ('stock_adjustment' series), posts the stock through core
 *   postStock (movement type per kind) and the journal (ARCHITECTURE.md §10): losses Dr
 *   inventory_adjustment (inventory_writeoff for damage / expiry) / Cr inventory, gains Dr inventory
 *   / Cr inventory_adjustment — from the values actually posted, so the inventory account always
 *   equals Σ movement values. Stock takes lock the stock rows and post counted − system quantity.
 * * POST :id/cancel — posted only, once: reverses every movement (losses come back at their
 *   original cost; gains leave at the current average) and the journal (reverseJournal), plus a
 *   cost-difference entry when a reversed gain left at a different average.
 * * Posting, cancelling and deleting are audited.
 */
import { type RawBuilder, sql } from 'kysely'
import { newId } from '@kadai/shared'
import {
  ADJUSTMENT_KIND_LABELS,
  ADJUSTMENT_MOVEMENT_TYPE,
  type AdjustmentCreateSchema,
  type AdjustmentLine,
  type AdjustmentListQuerySchema,
  type AdjustmentUpdateSchema,
  type EditableAdjustmentKind,
  type StockAdjustment,
  type StockAdjustmentDetail,
  WRITE_OFF_KINDS,
  adjustmentLineIssues,
  stockValuePaise,
} from '@kadai/shared/api/inventory'
import type { AdjustmentKind, AdjustmentStatus, StockMovementType } from '@kadai/shared'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { assertNotStale, notFound, validationError } from '../../core/errors'
import { assertStoreAccess, type PageEnvelope, type PageParams, pageResult } from '../../core/http'
import { lockStockLevels, postStock, type StockMovementInput } from '../../core/inventory'
import { postJournal, reverseJournal } from '../../core/ledger'
import { nextNumber } from '../../core/numbering'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  andAll,
  assertNotFuture,
  businessToday,
  checkStockLines,
  iso,
  likePattern,
  loadStore,
  memberStoresSql,
  reasonError,
  rowKey,
  rowStates,
  userNames,
} from './common'
import { documentMovements } from './movements'

type AdjustmentCreate = z.output<typeof AdjustmentCreateSchema>
type AdjustmentUpdate = z.output<typeof AdjustmentUpdateSchema>
type AdjustmentListQuery = z.output<typeof AdjustmentListQuerySchema>
type LineInput = AdjustmentCreate['lines'][number]

export const ADJUSTMENT_REF = 'stock_adjustment'

interface HeaderRow {
  id: string
  number: string | null
  fy: string | null
  store_id: string
  adjustment_date: string
  kind: AdjustmentKind
  status: AdjustmentStatus
  notes: string | null
  total_value_paise: number
  posted_at: Date | null
  posted_by: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
  cancelled_at: Date | null
  cancelled_by: string | null
  cancel_reason: string | null
}

interface LineRow {
  id: string
  line_no: number
  product_id: string
  batch_id: string | null
  system_qty_milli: number | null
  counted_qty_milli: number | null
  qty_delta_milli: number
  unit_cost_paise: number
  unit_cost_given: boolean
  reason: string | null
}

const HEADER_COLUMNS = [
  'id',
  'number',
  'fy',
  'store_id',
  'adjustment_date',
  'kind',
  'status',
  'notes',
  'total_value_paise',
  'posted_at',
  'posted_by',
  'created_by',
  'created_at',
  'updated_at',
  'cancelled_at',
  'cancelled_by',
  'cancel_reason',
] as const

const LINE_COLUMNS = [
  'id',
  'line_no',
  'product_id',
  'batch_id',
  'system_qty_milli',
  'counted_qty_milli',
  'qty_delta_milli',
  'unit_cost_paise',
  'unit_cost_given',
  'reason',
] as const

async function loadHeader(
  tx: Tx,
  ctx: Ctx,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<HeaderRow> {
  let q = tx
    .selectFrom('stock_adjustments')
    .select(HEADER_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (opts.lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('stock_adjustment', id)
  assertStoreAccess(ctx, row.store_id)
  return row as HeaderRow
}

async function loadLines(tx: Tx, ctx: Ctx, adjustmentId: string): Promise<LineRow[]> {
  return tx
    .selectFrom('stock_adjustment_lines')
    .select(LINE_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('adjustment_id', '=', adjustmentId)
    .orderBy('line_no')
    .execute()
}

/** Rows to insert for draft lines (stock takes keep the count, others the change). */
function lineValues(
  ctx: Ctx,
  adjustmentId: string,
  kind: AdjustmentKind,
  lines: readonly LineInput[],
) {
  return lines.map((l, i) => ({
    id: newId(),
    tenant_id: ctx.tenantId,
    adjustment_id: adjustmentId,
    line_no: i + 1,
    product_id: l.product_id,
    batch_id: l.batch_id,
    counted_qty_milli: kind === 'stock_take' ? (l.counted_qty_milli ?? 0) : null,
    qty_delta_milli: kind === 'stock_take' ? 0 : (l.qty_delta_milli ?? 0),
    unit_cost_paise: l.unit_cost_paise ?? 0,
    unit_cost_given: l.unit_cost_paise !== undefined,
    reason: l.reason ?? null,
  }))
}

function lineRuleIssues(kind: EditableAdjustmentKind, lines: readonly LineRow[]) {
  return adjustmentLineIssues(
    kind,
    lines.map((l) => ({
      product_id: l.product_id,
      batch_id: l.batch_id,
      ...(kind === 'stock_take'
        ? { counted_qty_milli: l.counted_qty_milli ?? undefined }
        : { qty_delta_milli: l.qty_delta_milli }),
    })),
  )
}

function throwIssues(issues: ReturnType<typeof adjustmentLineIssues>): void {
  if (issues.length) {
    throw validationError(
      issues.map((i) => ({ path: i.path.join('.'), message: i.code, code: i.code })),
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Live values of draft lines
// ---------------------------------------------------------------------------------------------

interface LiveLine {
  current_qty_milli: number
  qty_delta_milli: number
  unit_cost_paise: number
}

/** Change and cost each draft line would post now (losses at the current average cost). */
function liveLine(
  kind: AdjustmentKind,
  line: LineRow,
  state: { qty_milli: number; unit_cost_paise: number } | undefined,
): LiveLine {
  const current = state?.qty_milli ?? 0
  const basis = state?.unit_cost_paise ?? 0
  const delta =
    kind === 'stock_take' ? (line.counted_qty_milli ?? 0) - current : line.qty_delta_milli
  const cost = delta > 0 && line.unit_cost_given ? line.unit_cost_paise : basis
  return { current_qty_milli: current, qty_delta_milli: delta, unit_cost_paise: cost }
}

/** Live total value (gain − loss) of draft adjustments. */
async function draftTotals(
  tx: Tx,
  ctx: Ctx,
  drafts: readonly { id: string; store_id: string; kind: AdjustmentKind }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (drafts.length === 0) return out
  const lines = await tx
    .selectFrom('stock_adjustment_lines as l')
    .innerJoin('products as p', (j) =>
      j.onRef('p.tenant_id', '=', 'l.tenant_id').onRef('p.id', '=', 'l.product_id'),
    )
    .select(['l.adjustment_id', ...LINE_COLUMNS.map((c) => `l.${c}` as const), 'p.pack_size'])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where(
      'l.adjustment_id',
      'in',
      drafts.map((d) => d.id),
    )
    .execute()
  const byId = new Map(drafts.map((d) => [d.id, d]))
  const states = await rowStates(
    tx,
    ctx,
    lines.map((l) => ({
      store_id: byId.get(l.adjustment_id)!.store_id,
      product_id: l.product_id,
      batch_id: l.batch_id,
    })),
  )
  for (const d of drafts) out.set(d.id, 0)
  for (const l of lines) {
    const d = byId.get(l.adjustment_id)!
    const live = liveLine(
      d.kind,
      l,
      states.get(rowKey({ store_id: d.store_id, product_id: l.product_id, batch_id: l.batch_id })),
    )
    out.set(
      d.id,
      out.get(d.id)! + stockValuePaise(live.unit_cost_paise, live.qty_delta_milli, l.pack_size),
    )
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Journal entry of a document source (the original posting, not its reversal). */
export async function journalEntryId(
  tx: Tx,
  ctx: Ctx,
  sourceType: 'stock_adjustment' | 'stock_transfer',
  sourceId: string,
): Promise<string | null> {
  const row = await tx
    .selectFrom('journal_entries')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('source_type', '=', sourceType)
    .where('source_id', '=', sourceId)
    .where('reverses_entry_id', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst()
  return row?.id ?? null
}

/** Full adjustment view (lines with product / batch details, movements, journal). */
export async function adjustmentDetail(
  tx: Tx,
  ctx: Ctx,
  id: string,
): Promise<StockAdjustmentDetail> {
  const h = await loadHeader(tx, ctx, id)
  const store = await loadStore(tx, ctx, h.store_id)
  const lines = await tx
    .selectFrom('stock_adjustment_lines as l')
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
    .where('l.adjustment_id', '=', id)
    .orderBy('l.line_no')
    .execute()
  const isDraft = h.status === 'draft'
  const states = isDraft
    ? await rowStates(
        tx,
        ctx,
        lines.map((l) => ({
          store_id: h.store_id,
          product_id: l.product_id,
          batch_id: l.batch_id,
        })),
      )
    : new Map()

  let gain = 0
  let loss = 0
  const outLines: AdjustmentLine[] = lines.map((l) => {
    let delta = l.qty_delta_milli
    let cost = l.unit_cost_paise
    let current: number | null = null
    if (isDraft) {
      const live = liveLine(
        h.kind,
        l,
        states.get(
          rowKey({ store_id: h.store_id, product_id: l.product_id, batch_id: l.batch_id }),
        ),
      )
      delta = live.qty_delta_milli
      cost = live.unit_cost_paise
      current = live.current_qty_milli
    }
    const value = stockValuePaise(cost, delta, l.pack_size)
    if (value > 0) gain += value
    else loss -= value
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
      system_qty_milli: isDraft ? null : l.system_qty_milli,
      counted_qty_milli: l.counted_qty_milli,
      qty_delta_milli: delta,
      unit_cost_paise: cost,
      value_paise: value,
      reason: l.reason,
      current_qty_milli: current,
    }
  })
  const names = await userNames(tx, [h.posted_by, h.created_by, h.cancelled_by])
  return {
    id: h.id,
    number: h.number,
    fy: h.fy,
    store_id: h.store_id,
    store_code: store.code,
    store_name: store.name,
    adjustment_date: h.adjustment_date,
    kind: h.kind,
    status: h.status,
    notes: h.notes,
    total_value_paise: isDraft ? gain - loss : h.total_value_paise,
    line_count: lines.length,
    posted_at: h.posted_at === null ? null : iso(h.posted_at),
    posted_by: h.posted_by,
    posted_by_name: h.posted_by ? (names.get(h.posted_by) ?? null) : null,
    created_by: h.created_by,
    created_by_name: h.created_by ? (names.get(h.created_by) ?? null) : null,
    created_at: iso(h.created_at),
    updated_at: iso(h.updated_at),
    lines: outLines,
    gain_value_paise: gain,
    loss_value_paise: loss,
    movements: await documentMovements(tx, ctx, ADJUSTMENT_REF, h.id),
    journal_entry_id: await journalEntryId(tx, ctx, 'stock_adjustment', h.id),
    cancelled_at: h.cancelled_at === null ? null : iso(h.cancelled_at),
    cancelled_by_name: h.cancelled_by ? (names.get(h.cancelled_by) ?? null) : null,
    cancel_reason: h.cancel_reason,
  }
}

function listOrder(q: AdjustmentListQuery): RawBuilder<unknown> {
  const dir = q.sort.direction === 'asc' ? sql`asc` : sql`desc`
  switch (q.sort.field) {
    case 'created_at':
      return sql`a.created_at ${dir}, a.id ${dir}`
    case 'number':
      return sql`a.number ${dir} nulls last, a.created_at desc, a.id desc`
    case 'adjustment_date':
      return sql`a.adjustment_date ${dir}, a.created_at ${dir}, a.id ${dir}`
  }
}

/** GET /stock-adjustments */
export async function listAdjustments(
  tx: Tx,
  ctx: Ctx,
  q: AdjustmentListQuery,
  page: PageParams,
): Promise<PageEnvelope<StockAdjustment>> {
  const conds: RawBuilder<unknown>[] = [memberStoresSql(sql`a.store_id`, ctx)]
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    conds.push(sql`a.store_id = ${q.store_id}::uuid`)
  }
  if (q.kind) conds.push(sql`a.kind = ${q.kind}`)
  if (q.status) conds.push(sql`a.status = ${q.status}`)
  if (q.q) {
    const like = likePattern(q.q)
    conds.push(
      sql`(lower(coalesce(a.number, '')) like ${like} or lower(coalesce(a.notes, '')) like ${like})`,
    )
  }
  if (q.from) conds.push(sql`a.adjustment_date >= ${q.from}::date`)
  if (q.to) conds.push(sql`a.adjustment_date <= ${q.to}::date`)
  const where = andAll(conds)
  const res = await sql<
    HeaderRow & {
      store_code: string
      store_name: string
      line_count: number
      posted_by_name: string | null
      created_by_name: string | null
      __total: number
    }
  >`
    select a.id, a.number, a.fy, a.store_id, a.adjustment_date, a.kind, a.status, a.notes,
           a.total_value_paise, a.posted_at, a.posted_by, a.created_by, a.created_at, a.updated_at,
           a.cancelled_at, a.cancelled_by, a.cancel_reason,
           s.code as store_code, s.name as store_name,
           (select count(*) from stock_adjustment_lines l
             where l.tenant_id = a.tenant_id and l.adjustment_id = a.id)::int as line_count,
           pu.full_name as posted_by_name, cu.full_name as created_by_name,
           count(*) over()::bigint as __total
      from stock_adjustments a
      join stores s on s.tenant_id = a.tenant_id and s.id = a.store_id
      left join users pu on pu.id = a.posted_by
      left join users cu on cu.id = a.created_by
     where a.tenant_id = ${ctx.tenantId} and ${where}
     order by ${listOrder(q)}
     limit ${page.limit} offset ${page.offset}`.execute(tx)
  let total = Number(res.rows[0]?.__total ?? 0)
  if (res.rows.length === 0 && page.offset > 0) {
    const c = await sql<{ n: number }>`
      select count(*)::bigint as n from stock_adjustments a
       where a.tenant_id = ${ctx.tenantId} and ${where}`.execute(tx)
    total = Number(c.rows[0]?.n ?? 0)
  }
  const live = await draftTotals(
    tx,
    ctx,
    res.rows.filter((r) => r.status === 'draft'),
  )
  const data: StockAdjustment[] = res.rows.map((r) => ({
    id: r.id,
    number: r.number,
    fy: r.fy,
    store_id: r.store_id,
    store_code: r.store_code,
    store_name: r.store_name,
    adjustment_date: r.adjustment_date,
    kind: r.kind,
    status: r.status,
    notes: r.notes,
    total_value_paise: r.status === 'draft' ? (live.get(r.id) ?? 0) : r.total_value_paise,
    line_count: r.line_count,
    posted_at: r.posted_at === null ? null : iso(r.posted_at),
    posted_by: r.posted_by,
    posted_by_name: r.posted_by_name,
    created_by: r.created_by,
    created_by_name: r.created_by_name,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }))
  return pageResult(data, page, total)
}

// ---------------------------------------------------------------------------------------------
// Draft writes
// ---------------------------------------------------------------------------------------------

/** POST /stock-adjustments (draft). */
export async function createAdjustment(
  tx: Tx,
  ctx: Ctx,
  body: AdjustmentCreate,
): Promise<StockAdjustmentDetail> {
  assertStoreAccess(ctx, body.store_id)
  await loadStore(tx, ctx, body.store_id, { requireActive: true, path: 'store_id' })
  const { today } = await businessToday(tx, ctx)
  const date = body.adjustment_date ?? today
  assertNotFuture(date, today, ['adjustment_date'])
  await checkStockLines(tx, ctx, body.lines)
  const id = newId()
  await tx
    .insertInto('stock_adjustments')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: body.store_id,
      adjustment_date: date,
      kind: body.kind,
      status: 'draft',
      notes: body.notes ?? null,
      created_by: ctx.userId,
    })
    .execute()
  if (body.lines.length) {
    await tx
      .insertInto('stock_adjustment_lines')
      .values(lineValues(ctx, id, body.kind, body.lines))
      .execute()
  }
  return adjustmentDetail(tx, ctx, id)
}

function assertDraft(h: HeaderRow): void {
  if (h.status !== 'draft') {
    throw reasonError(
      'CONFLICT',
      'not_draft',
      `Only drafts can be changed (this one is ${h.status})`,
      {
        status: h.status,
      },
    )
  }
}

/** PATCH /stock-adjustments/:id (draft only; `lines` replaces every line). */
export async function updateAdjustment(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: AdjustmentUpdate,
): Promise<StockAdjustmentDetail> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  assertDraft(h)
  assertNotStale(h.updated_at, body.if_updated_at, 'stock_adjustment', id)
  if (h.kind === 'opening') {
    throw reasonError('CONFLICT', 'not_draft', 'Opening stock is posted directly')
  }
  const storeId = body.store_id ?? h.store_id
  if (body.store_id && body.store_id !== h.store_id) {
    assertStoreAccess(ctx, body.store_id)
    await loadStore(tx, ctx, body.store_id, { requireActive: true, path: 'store_id' })
  }
  const kind: EditableAdjustmentKind = body.kind ?? h.kind
  const { today } = await businessToday(tx, ctx)
  if (body.adjustment_date) assertNotFuture(body.adjustment_date, today, ['adjustment_date'])
  if (body.lines) {
    // The schema checks lines against `kind` only when both are sent.
    if (!body.kind) throwIssues(adjustmentLineIssues(kind, body.lines))
    await checkStockLines(tx, ctx, body.lines)
    await tx
      .deleteFrom('stock_adjustment_lines')
      .where('tenant_id', '=', ctx.tenantId)
      .where('adjustment_id', '=', id)
      .execute()
    if (body.lines.length) {
      await tx
        .insertInto('stock_adjustment_lines')
        .values(lineValues(ctx, id, kind, body.lines))
        .execute()
    }
  } else if (body.kind && body.kind !== h.kind) {
    // Kind changed without new lines: the stored lines must satisfy the new kind (a stock
    // take's lines carry counts, the others' changes, so switching to / from stock_take needs
    // new lines).
    throwIssues(lineRuleIssues(kind, await loadLines(tx, ctx, id)))
  }
  await tx
    .updateTable('stock_adjustments')
    .set({
      store_id: storeId,
      kind,
      ...(body.adjustment_date ? { adjustment_date: body.adjustment_date } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      updated_at: sql<Date>`now()`,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  return adjustmentDetail(tx, ctx, id)
}

/** DELETE /stock-adjustments/:id (drafts only; audited). */
export async function deleteAdjustment(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  assertDraft(h)
  await tx
    .deleteFrom('stock_adjustments')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'stock_adjustment.delete',
    entity_type: ADJUSTMENT_REF,
    entity_id: id,
    summary: `Draft ${ADJUSTMENT_KIND_LABELS[h.kind].en.toLowerCase()} deleted`,
  })
}

// ---------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------

/** Journal lines of an adjustment from the values actually posted (§10). */
export function adjustmentJournalLines(kind: AdjustmentKind, gainPaise: number, lossPaise: number) {
  const lossAccount = WRITE_OFF_KINDS.includes(kind) ? 'inventory_writeoff' : 'inventory_adjustment'
  const gainAccount = kind === 'opening' ? 'opening_balance' : 'inventory_adjustment'
  return [
    { account: { subtype: lossAccount }, debit_paise: lossPaise },
    { account: { subtype: 'inventory' }, credit_paise: lossPaise },
    { account: { subtype: 'inventory' }, debit_paise: gainPaise },
    { account: { subtype: gainAccount }, credit_paise: gainPaise },
  ] as const
}

/** Applies posted unit costs / stock-take snapshots to the lines. */
async function writeBackLines(
  tx: Tx,
  ctx: Ctx,
  updates: readonly {
    id: string
    system_qty_milli: number | null
    qty_delta_milli: number
    unit_cost_paise: number
  }[],
): Promise<void> {
  if (updates.length === 0) return
  await sql`
    update stock_adjustment_lines as l
       set system_qty_milli = v.system_qty, qty_delta_milli = v.delta, unit_cost_paise = v.cost
      from (values ${sql.join(
        updates.map(
          (u) =>
            sql`(${u.id}::uuid, ${u.system_qty_milli}::bigint, ${u.qty_delta_milli}::bigint, ${u.unit_cost_paise}::bigint)`,
        ),
      )}) as v(id, system_qty, delta, cost)
     where l.tenant_id = ${ctx.tenantId} and l.id = v.id`.execute(tx)
}

/** POST /stock-adjustments/:id/post */
export async function postAdjustment(tx: Tx, ctx: Ctx, id: string): Promise<StockAdjustmentDetail> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  assertDraft(h)
  if (h.kind === 'opening')
    throw reasonError('CONFLICT', 'not_draft', 'Opening stock is posted directly')
  await loadStore(tx, ctx, h.store_id, { requireActive: true, path: 'store_id' })
  const lines = await loadLines(tx, ctx, id)
  if (lines.length === 0) {
    throw reasonError('UNPROCESSABLE', 'empty_document', 'Add at least one line before posting')
  }
  const { today } = await businessToday(tx, ctx)
  assertNotFuture(h.adjustment_date, today, ['adjustment_date'])
  const kind = h.kind
  throwIssues(lineRuleIssues(kind, lines))
  await checkStockLines(tx, ctx, lines)

  // Stock takes: system quantity read under lock, so the posted delta is exact.
  const keys = lines.map((l) => ({
    store_id: h.store_id,
    product_id: l.product_id,
    batch_id: l.batch_id,
  }))
  const locked = kind === 'stock_take' ? await lockStockLevels(tx, ctx, keys) : null
  const basis = await rowStates(tx, ctx, keys)
  const movementType: StockMovementType = ADJUSTMENT_MOVEMENT_TYPE[kind]
  const planned = lines.map((l) => {
    const key = rowKey({ store_id: h.store_id, product_id: l.product_id, batch_id: l.batch_id })
    const system = locked ? (locked.get(key)?.qty_milli ?? 0) : null
    const delta = system === null ? l.qty_delta_milli : (l.counted_qty_milli ?? 0) - system
    return { line: l, key, system, delta }
  })
  const moving = planned.filter((p) => p.delta !== 0)
  const inputs: StockMovementInput[] = moving.map((p) => ({
    store_id: h.store_id,
    product_id: p.line.product_id,
    batch_id: p.line.batch_id,
    qty_milli: p.delta,
    movement_type: movementType,
    unit_cost_paise: p.delta > 0 && p.line.unit_cost_given ? p.line.unit_cost_paise : null,
    ref_type: ADJUSTMENT_REF,
    ref_id: id,
    ref_line_id: p.line.id,
    reason: p.line.reason ?? h.notes,
  }))
  const posted = await postStock(tx, ctx, inputs)
  const costByLine = new Map(posted.map((r, i) => [moving[i]!.line.id, r.unit_cost_paise]))
  let gain = 0
  let loss = 0
  for (const r of posted) {
    if (r.value_paise > 0) gain += r.value_paise
    else loss -= r.value_paise
  }
  await writeBackLines(
    tx,
    ctx,
    planned.map((p) => ({
      id: p.line.id,
      system_qty_milli: p.system,
      qty_delta_milli: p.delta,
      unit_cost_paise: costByLine.get(p.line.id) ?? basis.get(p.key)?.unit_cost_paise ?? 0,
    })),
  )

  const num = await nextNumber(tx, ctx, {
    docType: 'stock_adjustment',
    storeId: h.store_id,
    date: h.adjustment_date,
  })
  await postJournal(tx, ctx, {
    entry_date: h.adjustment_date,
    store_id: h.store_id,
    source_type: 'stock_adjustment',
    source_id: id,
    narration: `${ADJUSTMENT_KIND_LABELS[kind].en} ${num.number}`,
    lines: adjustmentJournalLines(kind, gain, loss),
  })
  await tx
    .updateTable('stock_adjustments')
    .set({
      status: 'posted',
      number: num.number,
      fy: num.fy,
      total_value_paise: gain - loss,
      posted_at: sql<Date>`now()`,
      posted_by: ctx.userId,
      updated_at: sql<Date>`now()`,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'stock_adjustment.post',
    entity_type: ADJUSTMENT_REF,
    entity_id: id,
    summary: `${ADJUSTMENT_KIND_LABELS[kind].en} ${num.number} posted: ${String(moving.length)} of ${String(lines.length)} lines changed stock, value ${String(gain - loss)} paise`,
    changes: { gain_paise: gain, loss_paise: loss, lines: lines.length, moved: moving.length },
  })
  return adjustmentDetail(tx, ctx, id)
}

/** POST /stock-adjustments/:id/cancel */
export async function cancelAdjustment(
  tx: Tx,
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<StockAdjustmentDetail> {
  const h = await loadHeader(tx, ctx, id, { lock: true })
  if (h.status === 'cancelled') {
    throw reasonError('CONFLICT', 'already_cancelled', 'This adjustment is already cancelled')
  }
  if (h.status !== 'posted') {
    throw reasonError(
      'CONFLICT',
      'not_posted',
      'Only posted adjustments can be cancelled; delete the draft instead',
    )
  }
  const { today } = await businessToday(tx, ctx)
  const original = await tx
    .selectFrom('stock_movements as m')
    .innerJoin('products as p', (j) =>
      j.onRef('p.tenant_id', '=', 'm.tenant_id').onRef('p.id', '=', 'm.product_id'),
    )
    .select([
      'm.store_id',
      'm.product_id',
      'm.batch_id',
      'm.qty_milli',
      'm.movement_type',
      'm.unit_cost_paise',
      'm.ref_line_id',
      'p.pack_size',
    ])
    .where('m.tenant_id', '=', ctx.tenantId)
    .where('m.ref_type', '=', ADJUSTMENT_REF)
    .where('m.ref_id', '=', id)
    .orderBy('m.created_at')
    .orderBy('m.id')
    .execute()
  const note = `Cancelled ${h.number ?? ''}: ${reason}`.slice(0, 500)
  const bidirectional = h.kind === 'adjustment' || h.kind === 'stock_take'
  const reversals: StockMovementInput[] = original.map((m) => ({
    store_id: m.store_id,
    product_id: m.product_id,
    batch_id: m.batch_id,
    qty_milli: -m.qty_milli,
    movement_type: bidirectional ? (m.movement_type as StockMovementType) : 'adjustment',
    // Losses come back at the cost they left with; gains leave at the current average.
    unit_cost_paise: -m.qty_milli > 0 ? m.unit_cost_paise : null,
    ref_type: ADJUSTMENT_REF,
    ref_id: id,
    ref_line_id: m.ref_line_id,
    // The user's cancel reason as typed (any language); the narration below says "Cancelled …".
    reason,
  }))
  const posted = await postStock(tx, ctx, reversals)
  const originalValue = original.reduce(
    (acc, m) => acc + stockValuePaise(m.unit_cost_paise ?? 0, m.qty_milli, m.pack_size),
    0,
  )
  const reversalValue = posted.reduce((acc, r) => acc + r.value_paise, 0)
  await reverseJournal(tx, ctx, {
    source_type: 'stock_adjustment',
    source_id: id,
    entry_date: today,
    narration: note,
  })
  // A reversed gain leaves at today's average: book the difference so the inventory account
  // keeps matching the stock ledger.
  const diff = originalValue + reversalValue
  if (diff !== 0) {
    await postJournal(tx, ctx, {
      entry_date: today,
      store_id: h.store_id,
      source_type: 'stock_adjustment',
      source_id: id,
      narration: `Cost difference on cancelling ${h.number ?? ''}`,
      lines:
        diff > 0
          ? [
              { account: { subtype: 'inventory' }, debit_paise: diff },
              { account: { subtype: 'inventory_adjustment' }, credit_paise: diff },
            ]
          : [
              { account: { subtype: 'inventory_adjustment' }, debit_paise: -diff },
              { account: { subtype: 'inventory' }, credit_paise: -diff },
            ],
    })
  }
  await tx
    .updateTable('stock_adjustments')
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
    action: 'stock_adjustment.cancel',
    entity_type: ADJUSTMENT_REF,
    entity_id: id,
    summary: `${ADJUSTMENT_KIND_LABELS[h.kind].en} ${h.number ?? ''} cancelled: ${reason}`,
    changes: { reason, reversed_movements: posted.length, cost_difference_paise: diff },
  })
  return adjustmentDetail(tx, ctx, id)
}
