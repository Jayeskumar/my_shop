/**
 * Helpers shared by the catalog module's services: tenant facts, store resolution, savepoints,
 * validation issues and small mapping utilities.
 */
import { type RawBuilder, sql } from 'kysely'
import { type BusinessType, BusinessTypeSchema, type ValidationIssue } from '@kadai/shared'
import type { CatalogValidationKey } from '@kadai/shared/api/catalog'
import type { RequestContext } from '../../core/context'
import { canAccessStore } from '../../core/context'
import { AppError, notFound, validationError } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import type { Tx } from '../../db/tenant'

export type Ctx = RequestContext

// ---------------------------------------------------------------------------------------------
// Tenant facts (memoised per transaction)
// ---------------------------------------------------------------------------------------------

export interface TenantInfo {
  id: string
  name: string
  name_ta: string | null
  business_type: BusinessType
  timezone: string
}

const tenantMemo = new WeakMap<Tx, TenantInfo>()

export async function tenantInfo(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<TenantInfo> {
  const cached = tenantMemo.get(tx)
  if (cached) return cached
  const row = await tx
    .selectFrom('tenants')
    .select(['id', 'name', 'name_ta', 'business_type', 'timezone'])
    .where('id', '=', ctx.tenantId)
    .executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  const bt = BusinessTypeSchema.safeParse(row.business_type)
  const info: TenantInfo = {
    id: row.id,
    name: row.name,
    name_ta: row.name_ta,
    business_type: bt.success ? bt.data : 'other',
    timezone: row.timezone,
  }
  tenantMemo.set(tx, info)
  return info
}

// ---------------------------------------------------------------------------------------------
// Store resolution (stock columns, store prices)
// ---------------------------------------------------------------------------------------------

/**
 * The store whose stock / prices a read uses: the requested store (access-checked, must exist),
 * else the device's register store, else the member's only store, else the tenant's only active
 * store; null when none applies (multi-store owner without a device and no ?store_id).
 */
export async function resolveStoreId(
  tx: Tx,
  ctx: Ctx,
  requested: string | null | undefined,
): Promise<string | null> {
  if (requested) {
    assertStoreAccess(ctx, requested)
    const store = await tx
      .selectFrom('stores')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', requested)
      .executeTakeFirst()
    if (!store) throw issue('store_id', 'reference_not_found')
    return store.id
  }
  if (ctx.registerId) {
    const reg = await tx
      .selectFrom('registers')
      .select('store_id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', ctx.registerId)
      .executeTakeFirst()
    if (reg && canAccessStore(ctx, reg.store_id)) return reg.store_id
  }
  if (ctx.storeIds && ctx.storeIds.length === 1) return ctx.storeIds[0]!
  const stores = await tx
    .selectFrom('stores')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('is_active', '=', true)
    .limit(2)
    .execute()
  if (stores.length === 1 && canAccessStore(ctx, stores[0]!.id)) return stores[0]!.id
  return null
}

// ---------------------------------------------------------------------------------------------
// Validation issues
// ---------------------------------------------------------------------------------------------

/** One VALIDATION_ERROR issue whose message is a catalog validation key. */
export function issue(path: string, key: CatalogValidationKey | string): AppError {
  return validationError([{ path, message: key, code: 'custom' }], key)
}

export function issues(list: ValidationIssue[]): AppError {
  return validationError(list, list[0]?.message ?? 'Validation failed')
}

/** 409 CONFLICT with a catalog error reason (CATALOG_ERROR_REASONS). */
export function conflictReason(
  message: string,
  reason: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError('CONFLICT', message, { reason, ...details })
}

/** 409 DUPLICATE with a catalog error reason and the conflicting field. */
export function duplicateReason(
  message: string,
  reason: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError('DUPLICATE', message, { reason, ...details })
}

// ---------------------------------------------------------------------------------------------
// Savepoints (partial rollback inside the request transaction)
// ---------------------------------------------------------------------------------------------

let savepointSeq = 0

/** Runs `fn` inside SAVEPOINT; a failure rolls back to it (the transaction stays usable). */
export async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  savepointSeq = (savepointSeq + 1) % 1_000_000_000
  const name = `kadai_sp_${savepointSeq}`
  await sql.raw(`SAVEPOINT ${name}`).execute(tx)
  try {
    const result = await fn()
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(tx)
    return result
  } catch (err) {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(tx)
    throw err
  }
}

/** PostgreSQL error code of a thrown driver error ('23503' FK violation, '23505' unique). */
export function pgCode(err: unknown): string | null {
  const code = err instanceof Error ? (err as unknown as { code?: unknown }).code : undefined
  if (typeof code === 'string') {
    return /^[0-9A-Z]{5}$/.test(code) ? code : null
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

export function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

export function isoOrNull(d: Date | string | null): string | null {
  return d === null ? null : iso(d)
}

/** Escapes LIKE / ILIKE wildcards in user text. */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** `%a%` ILIKE pattern of a search word. */
export function containsPattern(text: string): string {
  return `%${likeEscape(text.toLowerCase())}%`
}

/** Search words of a query (lower case, de-duplicated, at most 8). */
export function searchTokens(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ].slice(0, 8)
}

/** Plain-object view of a jsonb value ({} for anything else). */
export function jsonObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** String-valued record of a jsonb value (variant_attributes). */
export function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(jsonObject(v))) if (typeof x === 'string') out[k] = x
  return out
}

/** sql`a AND b AND …` (TRUE when empty). */
export function andAll(conds: readonly RawBuilder<unknown>[]): RawBuilder<unknown> {
  return conds.length ? sql`(${sql.join(conds, sql` AND `)})` : sql`TRUE`
}

/** Bumps products.updated_at (POS delta sync picks up barcode / store price changes). */
export async function touchProducts(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  productIds: readonly string[],
): Promise<void> {
  if (productIds.length === 0) return
  await tx
    .updateTable('products')
    .set({ updated_at: sql<Date>`now()` })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', [...new Set(productIds)])
    .execute()
}
