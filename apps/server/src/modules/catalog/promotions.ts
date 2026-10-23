/**
 * Promotions (feature promotions): rules validated per kind with the shared promotion schemas
 * (stored parsed, defaults filled), referenced products / categories / brands / stores must exist
 * in the tenant, status computed from the switch and the time window. DELETE removes a promotion
 * never applied on an invoice line, otherwise deactivates it.
 */
import { type RawBuilder, sql } from 'kysely'
import {
  PROMOTION_RULE_SCHEMAS,
  type PromotionKind,
  PromotionKindSchema,
  newId,
} from '@kadai/shared'
import {
  type PromotionCreateSchema,
  type PromotionListQuerySchema,
  type PromotionResponse,
  type PromotionUpdateSchema,
  promotionStatus,
} from '@kadai/shared/api/catalog'
import type { DeleteResult } from '@kadai/shared/api/identity'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { AppError, assertNotStale, forbidden, notFound } from '../../core/errors'
import { type PageEnvelope, assertStoreAccess, pageResult, parsePage } from '../../core/http'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  andAll,
  containsPattern,
  iso,
  isoOrNull,
  issue,
  jsonObject,
  pgCode,
  withSavepoint,
} from './shared'

interface PromotionRow {
  id: string
  name: string
  name_ta: string | null
  kind: string
  rules: unknown
  store_ids: string[] | null
  starts_at: Date | null
  ends_at: Date | null
  days_of_week: number[] | null
  priority: number
  stackable: boolean
  is_active: boolean
  created_by: string | null
  created_at: Date
  updated_at: Date
}

const COLUMNS = [
  'id',
  'name',
  'name_ta',
  'kind',
  'rules',
  'store_ids',
  'starts_at',
  'ends_at',
  'days_of_week',
  'priority',
  'stackable',
  'is_active',
  'created_by',
  'created_at',
  'updated_at',
] as const

function toPromotion(r: PromotionRow, now = new Date()): PromotionResponse {
  const kindParsed = PromotionKindSchema.safeParse(r.kind)
  if (!kindParsed.success) throw new AppError('INTERNAL', `Unknown promotion kind ${r.kind}`)
  const kind = kindParsed.data
  const parsed = PROMOTION_RULE_SCHEMAS[kind].safeParse(r.rules)
  if (!parsed.success)
    throw new AppError('INTERNAL', `Stored rules of promotion ${r.id} are invalid`)
  const base = {
    id: r.id,
    name: r.name,
    name_ta: r.name_ta,
    store_ids: r.store_ids,
    starts_at: isoOrNull(r.starts_at),
    ends_at: isoOrNull(r.ends_at),
    days_of_week: r.days_of_week,
    priority: r.priority,
    stackable: r.stackable,
    is_active: r.is_active,
    status: promotionStatus(r, now),
    created_by: r.created_by,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
  return { ...base, kind, rules: parsed.data } as PromotionResponse
}

/** Products / categories / brands referenced by rules (and stores) must belong to the tenant. */
async function assertReferences(
  tx: Tx,
  ctx: Ctx,
  kind: PromotionKind,
  rules: Record<string, unknown>,
  storeIds: readonly string[] | null | undefined,
): Promise<void> {
  const ids = (key: string): string[] =>
    Array.isArray(rules[key])
      ? (rules[key] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
  const productIds = [
    ...ids('product_ids'),
    ...ids('exclude_product_ids'),
    ...ids('get_product_ids'),
    ...(kind === 'combo_price' && Array.isArray(rules.items)
      ? (rules.items as Array<{ product_id?: unknown }>)
          .map((i) => i.product_id)
          .filter((x): x is string => typeof x === 'string')
      : []),
  ]
  const categoryIds = [...ids('category_ids'), ...ids('get_category_ids')]
  const brandIds = [...ids('brand_ids'), ...ids('get_brand_ids')]
  const missing = async (
    table: 'products' | 'categories' | 'brands' | 'stores',
    list: readonly string[],
  ): Promise<boolean> => {
    const unique = [...new Set(list)]
    if (unique.length === 0) return false
    const rows = await tx
      .selectFrom(table)
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', unique)
      .execute()
    return rows.length !== unique.length
  }
  if (await missing('products', productIds)) throw issue('rules.product_ids', 'reference_not_found')
  if (await missing('categories', categoryIds))
    throw issue('rules.category_ids', 'reference_not_found')
  if (await missing('brands', brandIds)) throw issue('rules.brand_ids', 'reference_not_found')
  if (storeIds) {
    for (const s of storeIds) assertStoreAccess(ctx, s)
    if (await missing('stores', storeIds)) throw issue('store_ids', 'reference_not_found')
  }
}

/**
 * Store scope of promotion writes: a member limited to some stores may only write promotions
 * limited to those stores (an all-store promotion, or one of another store, changes prices
 * there too) — 403 {reason: 'all_stores_required'}.
 */
function assertPromotionScope(ctx: Ctx, storeIds: readonly string[] | null): void {
  if (ctx.storeIds === null) return
  if (storeIds === null || storeIds.some((s) => !ctx.storeIds!.includes(s)))
    throw forbidden('This promotion applies to stores you cannot manage', {
      reason: 'all_stores_required',
    })
}

async function promotionOrThrow(
  tx: Tx,
  ctx: Ctx,
  id: string,
  forUpdate = false,
): Promise<PromotionRow> {
  let q = tx
    .selectFrom('promotions')
    .select(COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('promotion', id)
  return row
}

const STATUS_SQL: Record<string, RawBuilder<unknown>> = {
  inactive: sql`NOT p.is_active`,
  expired: sql`p.is_active AND p.ends_at IS NOT NULL AND p.ends_at <= now()`,
  scheduled: sql`p.is_active AND (p.ends_at IS NULL OR p.ends_at > now()) AND p.starts_at IS NOT NULL AND p.starts_at > now()`,
  active: sql`p.is_active AND (p.ends_at IS NULL OR p.ends_at > now()) AND (p.starts_at IS NULL OR p.starts_at <= now())`,
}

const SORT_SQL: Record<string, RawBuilder<unknown>> = {
  priority: sql`p.priority`,
  name: sql`lower(p.name)`,
  created_at: sql`p.created_at`,
  starts_at: sql`p.starts_at`,
}

export async function listPromotions(
  tx: Tx,
  ctx: Ctx,
  q: z.output<typeof PromotionListQuerySchema>,
): Promise<PageEnvelope<PromotionResponse>> {
  const page = parsePage(q)
  const conds: RawBuilder<unknown>[] = [sql`p.tenant_id = ${ctx.tenantId}`]
  if (q.q)
    conds.push(
      sql`(p.name ILIKE ${containsPattern(q.q)} OR coalesce(p.name_ta, '') ILIKE ${containsPattern(q.q)})`,
    )
  if (q.kind) conds.push(sql`p.kind = ${q.kind}`)
  if (q.status) conds.push(STATUS_SQL[q.status]!)
  if (q.active === true) conds.push(STATUS_SQL.active!)
  if (q.active === false) conds.push(sql`NOT (${STATUS_SQL.active!})`)
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    conds.push(sql`(p.store_ids IS NULL OR ${q.store_id}::uuid = ANY(p.store_ids))`)
  }
  const dir = q.sort.direction === 'desc' ? sql`DESC` : sql`ASC`
  const nulls = q.sort.field === 'starts_at' ? sql` NULLS FIRST` : sql``
  const res = await sql<PromotionRow & { __total: number }>`
    SELECT p.id, p.name, p.name_ta, p.kind, p.rules, p.store_ids, p.starts_at, p.ends_at,
           p.days_of_week, p.priority, p.stackable, p.is_active, p.created_by, p.created_at,
           p.updated_at, count(*) OVER () AS __total
      FROM promotions p
     WHERE ${andAll(conds)}
     ORDER BY ${SORT_SQL[q.sort.field] ?? SORT_SQL.priority!} ${dir}${nulls}, p.id
     LIMIT ${page.limit} OFFSET ${page.offset}`.execute(tx)
  let total = res.rows[0] ? Number(res.rows[0].__total) : 0
  if (!res.rows[0] && page.offset > 0) {
    const c = await sql<{
      n: number
    }>`SELECT count(*)::int AS n FROM promotions p WHERE ${andAll(conds)}`.execute(tx)
    total = Number(c.rows[0]?.n ?? 0)
  }
  const now = new Date()
  return pageResult(
    res.rows.map((r) => toPromotion(r, now)),
    page,
    total,
  )
}

export async function getPromotion(tx: Tx, ctx: Ctx, id: string): Promise<PromotionResponse> {
  return toPromotion(await promotionOrThrow(tx, ctx, id))
}

export async function createPromotion(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof PromotionCreateSchema>,
): Promise<PromotionResponse> {
  assertPromotionScope(ctx, body.store_ids)
  await assertReferences(tx, ctx, body.kind, body.rules as Record<string, unknown>, body.store_ids)
  const row = await tx
    .insertInto('promotions')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      name: body.name,
      name_ta: body.name_ta ?? null,
      kind: body.kind,
      rules: jsonb(body.rules),
      store_ids: body.store_ids,
      starts_at: body.starts_at,
      ends_at: body.ends_at,
      days_of_week: body.days_of_week,
      priority: body.priority,
      stackable: body.stackable,
      is_active: body.is_active,
      created_by: ctx.userId,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow()
  await audit(tx, ctx, {
    action: 'promotion.create',
    entity_type: 'promotion',
    entity_id: row.id,
    summary: `${body.name} (${body.kind})`,
    changes: { after: { kind: body.kind, rules: body.rules } },
  })
  return toPromotion(row)
}

export async function updatePromotion(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: z.output<typeof PromotionUpdateSchema>,
): Promise<PromotionResponse> {
  const current = await promotionOrThrow(tx, ctx, id, true)
  assertNotStale(current.updated_at, body.if_updated_at, 'promotion', id)
  assertPromotionScope(ctx, current.store_ids)
  if (body.store_ids !== undefined) assertPromotionScope(ctx, body.store_ids)
  const kind = body.kind ?? (current.kind as PromotionKind)
  const rules = body.rules ?? jsonObject(current.rules)
  const storeIds = body.store_ids === undefined ? current.store_ids : body.store_ids
  if (body.rules !== undefined || body.store_ids !== undefined)
    await assertReferences(tx, ctx, kind, rules, body.store_ids ?? null)
  const startsAt = body.starts_at === undefined ? current.starts_at : body.starts_at
  const endsAt = body.ends_at === undefined ? current.ends_at : body.ends_at
  if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime())
    throw issue('ends_at', 'promotion_dates')
  const before = {
    name: current.name,
    name_ta: current.name_ta,
    kind: current.kind,
    rules: jsonObject(current.rules),
    store_ids: current.store_ids,
    starts_at: isoOrNull(current.starts_at),
    ends_at: isoOrNull(current.ends_at),
    days_of_week: current.days_of_week,
    priority: current.priority,
    stackable: current.stackable,
    is_active: current.is_active,
  }
  const after = {
    name: body.name ?? before.name,
    name_ta: body.name_ta === undefined ? before.name_ta : body.name_ta,
    kind,
    rules,
    store_ids: storeIds,
    starts_at: startsAt === null ? null : iso(startsAt),
    ends_at: endsAt === null ? null : iso(endsAt),
    days_of_week: body.days_of_week === undefined ? before.days_of_week : body.days_of_week,
    priority: body.priority ?? before.priority,
    stackable: body.stackable ?? before.stackable,
    is_active: body.is_active ?? before.is_active,
  }
  const changes = diffChanges(before, after)
  if (!changes) return toPromotion(current)
  const row = await tx
    .updateTable('promotions')
    .set({ ...after, rules: jsonb(after.rules) })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow()
  await audit(tx, ctx, {
    action:
      after.is_active === false && before.is_active ? 'promotion.deactivate' : 'promotion.update',
    entity_type: 'promotion',
    entity_id: id,
    summary: after.name,
    changes,
  })
  return toPromotion(row)
}

export async function deletePromotion(tx: Tx, ctx: Ctx, id: string): Promise<DeleteResult> {
  const current = await promotionOrThrow(tx, ctx, id, true)
  assertPromotionScope(ctx, current.store_ids)
  try {
    await withSavepoint(tx, () =>
      tx
        .deleteFrom('promotions')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', id)
        .execute(),
    )
    await audit(tx, ctx, {
      action: 'promotion.delete',
      entity_type: 'promotion',
      entity_id: id,
      summary: current.name,
    })
    return { id, result: 'deleted' }
  } catch (err) {
    // Applied on invoice lines (FK) → keep for history.
    if (pgCode(err) !== '23503') throw err
  }
  if (current.is_active) {
    await tx
      .updateTable('promotions')
      .set({ is_active: false })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    await audit(tx, ctx, {
      action: 'promotion.deactivate',
      entity_type: 'promotion',
      entity_id: id,
      summary: current.name,
    })
  }
  return { id, result: 'deactivated' }
}
