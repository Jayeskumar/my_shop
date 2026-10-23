/**
 * Brands: names unique per tenant case-insensitively (citext column + pre-check for a friendly
 * 409), delete only when no product uses the brand.
 */
import { sql } from 'kysely'
import { newId } from '@kadai/shared'
import type {
  Brand,
  BrandCreateSchema,
  BrandListQuerySchema,
  BrandUpdateSchema,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { assertNotStale, notFound } from '../../core/errors'
import { type PageEnvelope, pageResult, parsePage } from '../../core/http'
import type { Tx } from '../../db/tenant'
import { type Ctx, containsPattern, conflictReason, duplicateReason, iso } from './shared'

interface BrandRow {
  id: string
  name: string
  is_active: boolean
  product_count: number
  created_at: Date
  updated_at: Date
}

function toBrand(r: BrandRow): Brand {
  return {
    id: r.id,
    name: r.name,
    is_active: r.is_active,
    product_count: Number(r.product_count),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

function brandQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('brands as b')
    .select([
      'b.id',
      'b.name',
      'b.is_active',
      'b.created_at',
      'b.updated_at',
      sql<number>`(select count(*) from products p where p.tenant_id = b.tenant_id and p.brand_id = b.id)::int`.as(
        'product_count',
      ),
    ])
    .where('b.tenant_id', '=', ctx.tenantId)
}

export async function listBrands(
  tx: Tx,
  ctx: Ctx,
  q: z.output<typeof BrandListQuerySchema>,
): Promise<PageEnvelope<Brand>> {
  const page = parsePage(q)
  let qb = brandQuery(tx, ctx)
  if (q.q) qb = qb.where(sql<boolean>`b.name::text ilike ${containsPattern(q.q)}`)
  if (q.is_active !== undefined) qb = qb.where('b.is_active', '=', q.is_active)
  const dir = q.sort.direction
  qb =
    q.sort.field === 'product_count'
      ? qb.orderBy(sql`product_count`, dir).orderBy('b.name', 'asc')
      : qb.orderBy('b.name', dir)
  const rows = await qb
    .select(sql<number>`count(*) over()`.as('__total'))
    .limit(page.limit)
    .offset(page.offset)
    .execute()
  let total = rows[0] ? Number(rows[0].__total) : 0
  if (!rows[0] && page.offset > 0) {
    let c = tx
      .selectFrom('brands as b')
      .select(sql<number>`count(*)`.as('n'))
      .where('b.tenant_id', '=', ctx.tenantId)
    if (q.q) c = c.where(sql<boolean>`b.name::text ilike ${containsPattern(q.q)}`)
    if (q.is_active !== undefined) c = c.where('b.is_active', '=', q.is_active)
    total = Number((await c.executeTakeFirst())?.n ?? 0)
  }
  return pageResult(rows.map(toBrand), page, total)
}

async function brandOrThrow(tx: Tx, ctx: Ctx, id: string): Promise<BrandRow> {
  const row = await brandQuery(tx, ctx).where('b.id', '=', id).executeTakeFirst()
  if (!row) throw notFound('brand', id)
  return row
}

async function assertNameFree(tx: Tx, ctx: Ctx, name: string, exceptId: string | null) {
  let q = tx
    .selectFrom('brands')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where(sql<boolean>`lower(name::text) = lower(${name})`)
  if (exceptId) q = q.where('id', '<>', exceptId)
  const existing = await q.executeTakeFirst()
  if (existing)
    throw duplicateReason('A brand with this name already exists', 'name_taken', {
      field: 'name',
      existing_id: existing.id,
    })
}

/** Finds a brand by name (case-insensitive) — imports. */
export async function findBrandByName(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  return tx
    .selectFrom('brands')
    .select(['id', 'name'])
    .where('tenant_id', '=', ctx.tenantId)
    .where(sql<boolean>`lower(name::text) = lower(${name})`)
    .executeTakeFirst()
}

export async function createBrand(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof BrandCreateSchema>,
): Promise<Brand> {
  await assertNameFree(tx, ctx, body.name, null)
  const row = await tx
    .insertInto('brands')
    .values({ id: newId(), tenant_id: ctx.tenantId, name: body.name })
    .returning('id')
    .executeTakeFirstOrThrow()
  await audit(tx, ctx, {
    action: 'brand.create',
    entity_type: 'brand',
    entity_id: row.id,
    summary: body.name,
  })
  return toBrand(await brandOrThrow(tx, ctx, row.id))
}

export async function updateBrand(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: z.output<typeof BrandUpdateSchema>,
): Promise<Brand> {
  const current = await tx
    .selectFrom('brands')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!current) throw notFound('brand', id)
  assertNotStale(current.updated_at, body.if_updated_at, 'brand', id)
  if (body.name !== undefined && body.name !== current.name)
    await assertNameFree(tx, ctx, body.name, id)
  const patch = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
  }
  const before = { name: current.name, is_active: current.is_active }
  const changes = diffChanges(before, { ...before, ...patch })
  if (changes) {
    await tx
      .updateTable('brands')
      .set(patch)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    await audit(tx, ctx, {
      action: 'brand.update',
      entity_type: 'brand',
      entity_id: id,
      summary: patch.name ?? current.name,
      changes,
    })
  }
  return toBrand(await brandOrThrow(tx, ctx, id))
}

export async function deleteBrand(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const brand = await brandOrThrow(tx, ctx, id)
  if (brand.product_count > 0) {
    throw conflictReason('Products use this brand; deactivate it instead', 'in_use_deactivate', {
      hint: 'deactivate',
      product_count: brand.product_count,
    })
  }
  await tx.deleteFrom('brands').where('tenant_id', '=', ctx.tenantId).where('id', '=', id).execute()
  await audit(tx, ctx, {
    action: 'brand.delete',
    entity_type: 'brand',
    entity_id: id,
    summary: brand.name,
  })
}
