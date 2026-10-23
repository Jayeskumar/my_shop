/**
 * Stock movement ledger reads: GET /stock/movements (filters, running balance via
 * balance_after_milli, user names, source document numbers, CSV export) and the movement rows
 * embedded in product stock, adjustment and transfer views.
 */
import { type RawBuilder, sql } from 'kysely'
import {
  type StockMovementType,
  addDays,
  milliToDecimalString,
  paiseToRupeesString,
  startOfDayInstant,
  toDateStr,
} from '@kadai/shared'
import { toCsv, type CsvValue } from '@kadai/shared/api/identity'
import {
  INVENTORY_EXPORT_MAX_ROWS,
  MOVEMENT_TYPE_LABELS,
  type MovementListQuerySchema,
  type MovementRow,
  stockValuePaise,
} from '@kadai/shared/api/inventory'
import type { z } from 'zod'
import { assertStoreAccess, type PageEnvelope, type PageParams, pageResult } from '../../core/http'
import type { Tx } from '../../db/tenant'
import { type Ctx, andAll, businessToday, iso, memberStoresSql, reasonError } from './common'

type MovementListQuery = z.output<typeof MovementListQuerySchema>

interface RawMovement {
  id: string
  created_at: Date
  store_id: string
  store_code: string
  product_id: string
  product_name: string
  product_name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  batch_id: string | null
  batch_no: string | null
  movement_type: StockMovementType
  qty_milli: number
  unit_cost_paise: number | null
  balance_after_milli: number
  ref_type: string | null
  ref_id: string | null
  ref_line_id: string | null
  reason: string | null
  created_by: string | null
  user_name: string | null
}

/** Source document tables whose `number` a movement reference resolves to. */
const REF_TABLES: Readonly<Record<string, string>> = {
  sales_invoice: 'sales_invoices',
  credit_note: 'credit_notes',
  purchase_bill: 'purchase_bills',
  debit_note: 'debit_notes',
  stock_adjustment: 'stock_adjustments',
  stock_transfer: 'stock_transfers',
}

/** Numbers of the referenced documents, by `${ref_type}:${ref_id}`. */
async function refNumbers(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  rows: readonly { ref_type: string | null; ref_id: string | null }[],
): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.ref_type || !r.ref_id || !REF_TABLES[r.ref_type]) continue
    const set = byType.get(r.ref_type) ?? new Set<string>()
    set.add(r.ref_id)
    byType.set(r.ref_type, set)
  }
  const out = new Map<string, string>()
  for (const [type, ids] of byType) {
    const res = await sql<{ id: string; number: string | null }>`
      select id, number from ${sql.table(REF_TABLES[type]!)}
       where tenant_id = ${ctx.tenantId} and id = any(${[...ids]}::uuid[])`.execute(tx)
    for (const r of res.rows) if (r.number) out.set(`${type}:${r.id}`, r.number)
  }
  return out
}

const MOVEMENT_SELECT = sql`
  m.id, m.created_at, m.store_id, s.code as store_code, m.product_id, p.name as product_name,
  p.name_ta as product_name_ta, p.sku, p.unit, p.pack_size, m.batch_id, b.batch_no,
  m.movement_type, m.qty_milli, m.unit_cost_paise, m.balance_after_milli, m.ref_type, m.ref_id,
  m.ref_line_id, m.reason, m.created_by, u.full_name as user_name`

const MOVEMENT_FROM = sql`
  from stock_movements m
  join stores s on s.tenant_id = m.tenant_id and s.id = m.store_id
  join products p on p.tenant_id = m.tenant_id and p.id = m.product_id
  left join batches b on b.tenant_id = m.tenant_id and b.id = m.batch_id
  left join users u on u.id = m.created_by`

async function toRows(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  raw: readonly RawMovement[],
): Promise<MovementRow[]> {
  const numbers = await refNumbers(tx, ctx, raw)
  return raw.map((r) => ({
    ...r,
    created_at: iso(r.created_at),
    value_paise:
      r.unit_cost_paise === null
        ? null
        : stockValuePaise(r.unit_cost_paise, r.qty_milli, r.pack_size),
    ref_number: r.ref_type && r.ref_id ? (numbers.get(`${r.ref_type}:${r.ref_id}`) ?? null) : null,
  }))
}

/** Movement rows matching `where` (oldest first unless `newestFirst`), at most `limit`. */
export async function movementRows(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  where: RawBuilder<unknown>,
  opts: { limit?: number; newestFirst?: boolean } = {},
): Promise<MovementRow[]> {
  const dir = opts.newestFirst ? sql`desc` : sql`asc`
  const res = await sql<RawMovement>`
    select ${MOVEMENT_SELECT} ${MOVEMENT_FROM}
     where m.tenant_id = ${ctx.tenantId} and ${where}
     order by m.created_at ${dir}, m.id ${dir}
     ${opts.limit ? sql`limit ${opts.limit}` : sql``}`.execute(tx)
  return toRows(tx, ctx, res.rows)
}

/** Movements posted for a document (ref_type / ref_id), oldest first. */
export function documentMovements(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  refType: string,
  refId: string,
): Promise<MovementRow[]> {
  return movementRows(tx, ctx, sql`m.ref_type = ${refType} and m.ref_id = ${refId}::uuid`)
}

async function movementConditions(
  tx: Tx,
  ctx: Ctx,
  q: MovementListQuery,
): Promise<RawBuilder<unknown>> {
  const conds: RawBuilder<unknown>[] = [memberStoresSql(sql`m.store_id`, ctx)]
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    conds.push(sql`m.store_id = ${q.store_id}::uuid`)
  }
  if (q.product_id) conds.push(sql`m.product_id = ${q.product_id}::uuid`)
  if (q.batch_id) conds.push(sql`m.batch_id = ${q.batch_id}::uuid`)
  if (q.type?.length) conds.push(sql`m.movement_type = any(${q.type}::text[])`)
  if (q.ref_type) conds.push(sql`m.ref_type = ${q.ref_type}`)
  if (q.ref_id) conds.push(sql`m.ref_id = ${q.ref_id}::uuid`)
  if (q.user_id) conds.push(sql`m.created_by = ${q.user_id}::uuid`)
  if (q.from || q.to) {
    const { timezone } = await businessToday(tx, ctx)
    if (q.from) conds.push(sql`m.created_at >= ${startOfDayInstant(q.from, timezone)}`)
    if (q.to) conds.push(sql`m.created_at < ${startOfDayInstant(addDays(q.to, 1), timezone)}`)
  }
  return andAll(conds)
}

/** GET /stock/movements (JSON page). */
export async function listMovements(
  tx: Tx,
  ctx: Ctx,
  q: MovementListQuery,
  page: PageParams,
): Promise<PageEnvelope<MovementRow>> {
  const where = await movementConditions(tx, ctx, q)
  const dir = q.sort.direction === 'asc' ? sql`asc` : sql`desc`
  const res = await sql<RawMovement & { __total: number }>`
    select ${MOVEMENT_SELECT}, count(*) over()::bigint as __total ${MOVEMENT_FROM}
     where m.tenant_id = ${ctx.tenantId} and ${where}
     order by m.created_at ${dir}, m.id ${dir}
     limit ${page.limit} offset ${page.offset}`.execute(tx)
  let total = res.rows[0]?.__total ?? 0
  if (res.rows.length === 0 && page.offset > 0) {
    const c = await sql<{ n: number }>`
      select count(*)::bigint as n from stock_movements m
       where m.tenant_id = ${ctx.tenantId} and ${where}`.execute(tx)
    total = c.rows[0]?.n ?? 0
  }
  const rows = await toRows(
    tx,
    ctx,
    res.rows.map(({ __total: _t, ...r }) => r),
  )
  return pageResult(rows, page, Number(total))
}

const CSV_HEADERS = {
  en: [
    'Date & time',
    'Store',
    'Product',
    'SKU',
    'Batch',
    'Type',
    'Quantity',
    'Unit',
    'Unit cost (Rs)',
    'Value (Rs)',
    'Balance after',
    'Reference',
    'Reason',
    'User',
  ],
  ta: [
    'தேதி & நேரம்',
    'கிளை',
    'பொருள்',
    'SKU',
    'பேட்ச்',
    'வகை',
    'அளவு',
    'அலகு',
    'அலகு விலை (ரூ)',
    'மதிப்பு (ரூ)',
    'பின் இருப்பு',
    'ஆவணம்',
    'காரணம்',
    'பயனர்',
  ],
} as const

function dateTimeText(d: Date, timezone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  const [y, m, day] = toDateStr(d, timezone).split('-')
  return `${day ?? ''}-${m ?? ''}-${y ?? ''} ${time}`
}

/** GET /stock/movements?format=csv — every filtered row (≤ INVENTORY_EXPORT_MAX_ROWS). */
export async function movementsCsv(
  tx: Tx,
  ctx: Ctx,
  q: MovementListQuery,
): Promise<{ csv: string; rows: number }> {
  const where = await movementConditions(tx, ctx, q)
  const dir = q.sort.direction === 'asc' ? sql`asc` : sql`desc`
  const res = await sql<RawMovement>`
    select ${MOVEMENT_SELECT} ${MOVEMENT_FROM}
     where m.tenant_id = ${ctx.tenantId} and ${where}
     order by m.created_at ${dir}, m.id ${dir}
     limit ${INVENTORY_EXPORT_MAX_ROWS + 1}`.execute(tx)
  if (res.rows.length > INVENTORY_EXPORT_MAX_ROWS) {
    throw reasonError(
      'UNPROCESSABLE',
      'export_too_large',
      `More than ${String(INVENTORY_EXPORT_MAX_ROWS)} movements match; narrow the filters`,
      { max_rows: INVENTORY_EXPORT_MAX_ROWS },
    )
  }
  const rows = await toRows(tx, ctx, res.rows)
  const { timezone } = await businessToday(tx, ctx)
  const locale = ctx.locale
  const lines: CsvValue[][] = [[...CSV_HEADERS[locale]]]
  for (const r of rows) {
    lines.push([
      dateTimeText(new Date(r.created_at), timezone),
      r.store_code,
      locale === 'ta' && r.product_name_ta ? r.product_name_ta : r.product_name,
      r.sku,
      r.batch_no,
      MOVEMENT_TYPE_LABELS[r.movement_type][locale],
      milliToDecimalString(r.qty_milli),
      r.unit,
      r.unit_cost_paise === null ? null : paiseToRupeesString(r.unit_cost_paise),
      r.value_paise === null ? null : paiseToRupeesString(r.value_paise),
      milliToDecimalString(r.balance_after_milli),
      r.ref_number ?? r.ref_type,
      r.reason,
      r.user_name,
    ])
  }
  return { csv: toCsv(lines), rows: rows.length }
}
