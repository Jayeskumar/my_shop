/**
 * Helpers shared by the identity services: LIKE-safe search, advisory locks, lenient readers for
 * stored JSON (addresses, register settings), store-scope checks, the tenant calendar and the
 * request context subset every service needs.
 */
import { type Address, AddressSchema } from '@kadai/shared/api/common'
import type { IdentityErrorReason } from '@kadai/shared/api/identity'
import {
  type Permission,
  type RegisterSettings,
  RegisterSettingsSchema,
  fyOf,
  hasAllPermissions,
  todayIn,
} from '@kadai/shared'
import { type Expression, type SelectQueryBuilder, type SqlBool, sql } from 'kysely'
import type { RequestContext } from '../../core/context'
import type { AppError } from '../../core/errors'
import { conflict, forbidden, unprocessable } from '../../core/errors'
import type { PageEnvelope, PageParams } from '../../core/http'
import { tenantCalendar } from '../../core/numbering'
import type { Tx } from '../../db/tenant'

/** The request context fields the identity services use. */
export type Ctx = RequestContext

/** ISO string of a timestamptz value (response types are the schemas' string outputs). */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/** Escapes LIKE wildcards (backslash is PostgreSQL's default LIKE escape character). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** `%text%` pattern for ILIKE searches. */
export function containsPattern(text: string): string {
  return `%${escapeLike(text.trim())}%`
}

/**
 * Digits to match against stored E.164 phones when the query looks like (part of) a phone
 * number: at least 3 digits, only digits / spaces / + - ( ). Leading zeros are dropped.
 */
export function phoneSearchDigits(q: string): string | null {
  if (!/^[\d\s+\-()]+$/.test(q)) return null
  const digits = q.replace(/\D/g, '').replace(/^0+/, '')
  return digits.length >= 3 ? digits : null
}

/** OR of the given conditions (wrapped in parentheses). */
export function anyOf(parts: readonly Expression<SqlBool>[]): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.join(parts, sql` or `)})`
}

/**
 * core/http paginate() for queries over aliased / joined tables (its signature only admits plain
 * table names): `count(*) over()` in the same round trip, a separate count past the end.
 */
export async function paginateQuery<DBX, TB extends keyof DBX, O>(
  qb: SelectQueryBuilder<DBX, TB, O>,
  page: PageParams,
): Promise<PageEnvelope<O>> {
  const rows = (await qb
    .select(sql<string>`count(*) over()`.as('__total'))
    .limit(page.limit)
    .offset(page.offset)
    .execute()) as unknown as Array<O & { __total: string | number }>
  let total = 0
  if (rows.length > 0) {
    total = Number(rows[0]!.__total)
  } else if (page.offset > 0) {
    const c = await qb
      .clearSelect()
      .clearOrderBy()
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirst()
    total = Number((c as { n?: string | number } | undefined)?.n ?? 0)
  }
  const data = rows.map((r) => {
    const { __total: _omit, ...rest } = r
    return rest as unknown as O
  })
  return { data, page: { limit: page.limit, offset: page.offset, total } }
}

/** Transaction-scoped advisory lock on an arbitrary key. */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx)
}

/** Reads a stored address jsonb leniently (invalid / missing → {}). */
export function readAddress(value: unknown): Address {
  const parsed = AddressSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : AddressSchema.parse({})
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Lenient read of registers.settings: starts from the defaults and keeps every stored field
 * (recursively for nested objects such as `scale`) that still validates; invalid or unknown
 * fields fall back to their defaults. Never throws.
 */
export function readRegisterSettings(stored: unknown): RegisterSettings {
  let current: RegisterSettings = RegisterSettingsSchema.parse({})
  if (!isPlainObject(stored)) return current
  const apply = (path: string[], value: unknown): void => {
    const patch: Record<string, unknown> = {}
    let cursor = patch
    path.forEach((key, i) => {
      if (i === path.length - 1) cursor[key] = value
      else {
        const next: Record<string, unknown> = {}
        cursor[key] = next
        cursor = next
      }
    })
    const parsed = RegisterSettingsSchema.safeParse(mergeDeep(current, patch))
    if (parsed.success) {
      current = parsed.data
      return
    }
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) apply([...path, k], v)
    }
  }
  const defaults = current as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(stored)) {
    if (key in defaults) apply([key], value)
  }
  return current
}

/** Deep merge: plain objects merge recursively, arrays and scalars replace, undefined is skipped. */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? mergeDeep(out[key], value) : value
  }
  return out as T
}

// ---------------------------------------------------------------------------------------------
// Errors with a details.reason (IDENTITY_ERROR_REASONS)
// ---------------------------------------------------------------------------------------------

export function reasonConflict(
  reason: IdentityErrorReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return conflict(message, { reason, ...details })
}

export function reasonForbidden(
  reason: IdentityErrorReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return forbidden(message, { reason, ...details })
}

export function reasonUnprocessable(
  reason: IdentityErrorReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return unprocessable(message, { reason, ...details })
}

// ---------------------------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------------------------

/** The caller holds the owner role (system role code 'owner'). */
export function isOwnerCtx(ctx: Pick<Ctx, 'roleCode'>): boolean {
  return ctx.roleCode === 'owner' || ctx.roleCode === 'system'
}

/**
 * Store scope of a target (member store_ids, null = all stores) is inside the caller's scope.
 * Unscoped callers (null) cover everything; scoped callers only cover explicit subsets.
 */
export function scopeCovers(
  ctx: Pick<Ctx, 'storeIds'>,
  storeIds: readonly string[] | null,
): boolean {
  if (ctx.storeIds === null) return true
  if (storeIds === null) return false
  return storeIds.every((id) => ctx.storeIds!.includes(id))
}

/** 403 store_scope unless the caller's store access covers `storeIds`. */
export function assertScopeCovers(
  ctx: Pick<Ctx, 'storeIds'>,
  storeIds: readonly string[] | null,
  what: string,
): void {
  if (!scopeCovers(ctx, storeIds)) {
    throw reasonForbidden('store_scope', `${what} is outside your store access`, {
      store_ids: storeIds,
    })
  }
}

/** 403 all_stores_required for store-scoped callers. */
export function assertAllStores(ctx: Pick<Ctx, 'storeIds'>, what: string): void {
  if (ctx.storeIds !== null) {
    throw reasonForbidden('all_stores_required', `${what} needs access to every store`)
  }
}

/**
 * A non-owner may not hand out (or create) a role with permissions they do not hold
 * themselves — otherwise users.manage would be a path to every permission.
 */
export function assertGrantable(
  ctx: Pick<Ctx, 'roleCode' | 'permissions'>,
  effective: Iterable<Permission>,
): void {
  if (isOwnerCtx(ctx)) return
  const needed = [...effective]
  if (!hasAllPermissions(ctx.permissions, needed)) {
    const missing = needed.filter((p) => !ctx.permissions.has(p)).sort()
    throw reasonForbidden(
      'role_exceeds_own_permissions',
      'You cannot grant permissions you do not have yourself',
      { missing },
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

/** Today's business date and financial year of the tenant. */
export async function tenantToday(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
): Promise<{ today: string; fy: string; fyStartMonth: number; timezone: string }> {
  const cal = await tenantCalendar(tx, { tenantId: ctx.tenantId })
  const today = todayIn(cal.timezone)
  return {
    today,
    fy: fyOf(today, cal.fyStartMonth),
    fyStartMonth: cal.fyStartMonth,
    timezone: cal.timezone,
  }
}
