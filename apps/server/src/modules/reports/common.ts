/**
 * Shared plumbing of the reports module (docs/API.md "reports & GST"): the report environment
 * (tenant, business date, settings), store scoping, SQL fragments, the tabular report runner
 * (one CTE named `rows`, paged with count(*) over(), totals over the whole filtered set) and CSV
 * downloads (English column labels of the REPORTS catalogue + a totals row, audited as data
 * exports — ARCHITECTURE.md §7.7).
 *
 * Every query runs inside the request's tenant transaction (RLS) and filters `tenant_id`
 * explicitly as well (§6.5). Amount aggregates are cast to bigint so pg returns JS numbers.
 */
import type { FastifyReply } from 'fastify'
import { type RawBuilder, sql } from 'kysely'
import {
  type BusinessType,
  type GstScheme,
  type TenantSettings,
  instantRangeForDates,
  todayIn,
} from '@kadai/shared'
import {
  REPORTS_BY_KEY,
  REPORT_CSV_MAX_ROWS,
  type ReportKey,
  type ReportsErrorReason,
  type ReportMeta,
  reportCsv,
  reportCsvFilename,
} from '@kadai/shared/api/reports'
import { audit } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { AppError, notFound } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { tenantCalendar } from '../../core/numbering'
import { getSettings } from '../../core/settings'
import type { Tx } from '../../db/tenant'

export type Ctx = RequestContext
export type Sql = RawBuilder<unknown>
type ReportNote = ReportMeta['notes'][number]

/** AppError with `details.reason` from REPORTS_ERROR_REASONS. */
export function reasonError(
  code: 'FORBIDDEN' | 'NOT_FOUND' | 'UNPROCESSABLE',
  reason: ReportsErrorReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError(code, message, { reason, ...details })
}

// ---------------------------------------------------------------------------------------------
// Report environment
// ---------------------------------------------------------------------------------------------

export interface TenantInfo {
  id: string
  name: string
  name_ta: string | null
  legal_name: string | null
  gstin: string | null
  gst_scheme: GstScheme
  state_code: string
  business_type: BusinessType
}

export interface ReportEnv {
  tenant: TenantInfo
  timezone: string
  fyStartMonth: number
  /** Business date "today" in the tenant timezone. */
  today: string
  settings: TenantSettings
  generatedAt: Date
}

export async function reportEnv(tx: Tx, ctx: Ctx): Promise<ReportEnv> {
  const cal = await tenantCalendar(tx, ctx)
  const row = await tx
    .selectFrom('tenants')
    .select([
      'id',
      'name',
      'name_ta',
      'legal_name',
      'gstin',
      'gst_scheme',
      'state_code',
      'business_type',
    ])
    .where('id', '=', ctx.tenantId)
    .executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  return {
    tenant: {
      ...row,
      gst_scheme: row.gst_scheme as GstScheme,
      business_type: row.business_type as BusinessType,
    },
    timezone: cal.timezone,
    fyStartMonth: cal.fyStartMonth,
    today: todayIn(cal.timezone),
    settings: await getSettings(tx, ctx),
    generatedAt: new Date(),
  }
}

/** Half-open instant range [start, end) of inclusive business dates (timestamptz filters). */
export function instantRange(env: ReportEnv, from: string, to: string): { start: Date; end: Date } {
  return instantRangeForDates(from, to, env.timezone)
}

// ---------------------------------------------------------------------------------------------
// Store scope
// ---------------------------------------------------------------------------------------------

export interface StoreScope {
  /** The single store asked for (null = every accessible store). */
  storeId: string | null
  storeName: string | null
  /** Stores the report may read; null = every store of the tenant. */
  storeIds: readonly string[] | null
  /** The member is store-scoped and no single store was asked for. */
  restricted: boolean
}

/**
 * `store_id` = a store id (must be accessible → 403, must exist → 404), or 'all' / omitted =
 * every store the member can access (ctx.storeIds).
 */
export async function resolveScope(
  tx: Tx,
  ctx: Ctx,
  storeId: string | undefined | null,
): Promise<StoreScope> {
  if (storeId && storeId !== 'all') {
    assertStoreAccess(ctx, storeId)
    const row = await tx
      .selectFrom('stores')
      .select(['id', 'name'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', storeId)
      .executeTakeFirst()
    if (!row) throw notFound('store', storeId)
    return { storeId: row.id, storeName: row.name, storeIds: [row.id], restricted: false }
  }
  return {
    storeId: null,
    storeName: null,
    storeIds: ctx.storeIds,
    restricted: ctx.storeIds !== null,
  }
}

/** `<col> = any(store ids)` — `true` when the scope covers every store. */
export function inStores(col: string, scope: Pick<StoreScope, 'storeIds'>): Sql {
  if (scope.storeIds === null) return sql`true`
  return sql`${sql.ref(col)} = any(${[...scope.storeIds]}::uuid[])`
}

/** Optional equality filter (`true` when the value is absent). */
export function eqOpt(col: string, value: string | null | undefined): Sql {
  return value ? sql`${sql.ref(col)} = ${value}` : sql`true`
}

/** `<col>` is the category or one of its descendants (`true` without a category). */
export function inCategoryTree(col: string, ctx: Ctx, categoryId: string | undefined): Sql {
  if (!categoryId) return sql`true`
  return sql`${sql.ref(col)} in (
    with recursive sub(id) as (
      select c.id from categories c where c.tenant_id = ${ctx.tenantId} and c.id = ${categoryId}
      union all
      select c.id from categories c join sub on c.parent_id = sub.id
       where c.tenant_id = ${ctx.tenantId}
    )
    select id from sub)`
}

/** ILIKE pattern of a free-text search (wildcards in the input are literal). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/** Business date of a timestamptz column in the tenant timezone. */
export function localDate(col: string, env: ReportEnv): Sql {
  return sql`(${sql.ref(col)} at time zone ${env.timezone})::date`
}

/** Recursive category tree CTE body: id, parent_id, name, name_ta, root_id, path, depth. */
export function categoryTreeCte(ctx: Ctx): Sql {
  return sql`cat_tree as (
    select c.id, c.parent_id, c.name, c.name_ta, c.id as root_id, c.name::text as path, 1 as depth
      from categories c
     where c.tenant_id = ${ctx.tenantId} and c.parent_id is null
    union all
    select c.id, c.parent_id, c.name, c.name_ta, t.root_id, t.path || ' / ' || c.name, t.depth + 1
      from categories c
      join cat_tree t on c.parent_id = t.id
     where c.tenant_id = ${ctx.tenantId} and t.depth < 10
  )`
}

/** ORDER BY from a whitelisted sort map (trusted SQL) + a deterministic tie-breaker. */
export function orderBy<F extends string>(
  sort: { field: F; direction: 'asc' | 'desc' },
  columns: Readonly<Record<F, string>>,
  tieBreaker: string,
): Sql {
  const dir = sort.direction === 'desc' ? 'desc' : 'asc'
  return sql.raw(`${columns[sort.field]} ${dir} nulls last, ${tieBreaker}`)
}

// ---------------------------------------------------------------------------------------------
// Report envelope / meta
// ---------------------------------------------------------------------------------------------

export interface MetaInput {
  from?: string | null
  to?: string | null
  as_of?: string | null
  group_by?: string | null
  notes?: ReportNote[]
}

export function reportMeta(
  key: ReportKey,
  env: ReportEnv,
  scope: StoreScope,
  input: MetaInput,
): ReportMeta {
  const notes = new Set<ReportNote>(input.notes ?? [])
  if (scope.restricted) notes.add('store_filter_applied')
  return {
    report: key,
    from: input.from ?? null,
    to: input.to ?? null,
    as_of: input.as_of ?? null,
    store_id: scope.storeId,
    store_name: scope.storeName,
    group_by: input.group_by ?? null,
    generated_at: env.generatedAt.toISOString(),
    notes: [...notes],
  }
}

// ---------------------------------------------------------------------------------------------
// Tabular runner
// ---------------------------------------------------------------------------------------------

export interface TabularQuery {
  /** `with recursive …, rows as (…)` — the CTE list must define `rows`. */
  cte: Sql
  /** ORDER BY expression over the columns of `rows` (alias r). */
  order: Sql
  /** One-row aggregate `select … from rows r`. */
  totals: Sql
}

export interface PageInput {
  limit: number
  offset: number
  format: 'json' | 'csv'
}

export interface TabularResult<R, T> {
  rows: R[]
  total: number
  totals: T
  truncated: boolean
}

/** Runs a tabular report: one page (json) or every row up to REPORT_CSV_MAX_ROWS (csv). */
export async function runTabular<R extends object, T extends object>(
  tx: Tx,
  q: TabularQuery,
  page: PageInput,
): Promise<TabularResult<R, T>> {
  const totalsRow = (await sql<T>`${q.cte} ${q.totals}`.execute(tx)).rows[0]
  if (!totalsRow) throw new Error('report totals query returned no row')
  if (page.format === 'csv') {
    const all = await sql<R>`${q.cte}
      select r.* from rows r order by ${q.order} limit ${REPORT_CSV_MAX_ROWS + 1}`.execute(tx)
    const truncated = all.rows.length > REPORT_CSV_MAX_ROWS
    const rows = truncated ? all.rows.slice(0, REPORT_CSV_MAX_ROWS) : all.rows
    return { rows, total: rows.length, totals: totalsRow, truncated }
  }
  const res = await sql<R & { __total: number }>`${q.cte}
    select r.*, count(*) over() as __total from rows r
     order by ${q.order} limit ${page.limit} offset ${page.offset}`.execute(tx)
  let total = res.rows[0] ? Number(res.rows[0].__total) : 0
  if (res.rows.length === 0 && page.offset > 0) {
    const c = await sql<{ n: number }>`${q.cte} select count(*) as n from rows`.execute(tx)
    total = Number(c.rows[0]?.n ?? 0)
  }
  const rows = res.rows.map((r) => {
    const { __total: _omit, ...rest } = r
    return rest as unknown as R
  })
  return { rows, total, totals: totalsRow, truncated: false }
}

export type ReportOutcome<B> =
  { kind: 'json'; body: B } | { kind: 'csv'; filename: string; csv: string }

export interface ReportBody<Row, Totals> {
  data: Row[]
  page: { limit: number; offset: number; total: number }
  totals: Totals
  meta: ReportMeta
}

/**
 * Builds the report envelope, or (format=csv) the CSV text — audited as a data export in the
 * same transaction. Call {@link sendOutcome} after the transaction.
 */
export async function reportOutcome<Row, Totals>(
  tx: Tx,
  ctx: Ctx,
  key: ReportKey,
  page: PageInput,
  result: { rows: Row[]; total: number; totals: Totals; truncated: boolean },
  meta: ReportMeta,
  filters: Record<string, unknown>,
): Promise<ReportOutcome<ReportBody<Row, Totals>>> {
  if (page.format === 'csv') {
    const defn = REPORTS_BY_KEY[key]
    const csv = reportCsv(
      defn,
      result.rows as unknown as Record<string, unknown>[],
      result.totals as unknown as Record<string, unknown>,
      { group_by: meta.group_by },
    )
    await audit(tx, ctx, {
      action: 'report.export',
      entity_type: 'report',
      summary: `Exported ${defn.title.en} (${result.rows.length} rows${result.truncated ? ', truncated' : ''})`,
      changes: { report: key, format: 'csv', rows: result.rows.length, filters },
    })
    return { kind: 'csv', filename: reportCsvFilename(key, meta.from, meta.to), csv }
  }
  return {
    kind: 'json',
    body: {
      data: result.rows,
      page: { limit: page.limit, offset: page.offset, total: result.total },
      totals: result.totals,
      meta: result.truncated ? { ...meta, notes: [...meta.notes, 'truncated'] } : meta,
    },
  }
}

/** Sends a CSV document as a download. */
export function sendFile(
  reply: FastifyReply,
  filename: string,
  body: string,
  contentType: string,
): FastifyReply {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_')
  return reply
    .code(200)
    .header('content-type', contentType)
    .header('content-disposition', `attachment; filename="${safe}"`)
    .send(Buffer.from(body, 'utf8'))
}

export function sendOutcome<B>(reply: FastifyReply, outcome: ReportOutcome<B>): B | FastifyReply {
  if (outcome.kind === 'csv')
    return sendFile(reply, outcome.filename, outcome.csv, 'text/csv; charset=utf-8')
  return outcome.body
}

// ---------------------------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------------------------

/** pg numeric/bigint values → number (null stays null). */
export function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

export function numOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? v : Number(v)
}

/** Timestamp column → ISO string. */
export function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

export function isoOrNull(v: Date | string | null): string | null {
  return v === null ? null : iso(v)
}
