/**
 * Shared helpers of the payments module: context type, tenant (shop) profile, business dates,
 * reasoned errors (`details.reason`), best-effort job enqueueing and JSON readers.
 */
import { DEFAULT_TIMEZONE, type Permission, hasPermission, toDateStr, todayIn } from '@kadai/shared'
import type { RequestContext } from '../../core/context'
import { AppError, forbidden } from '../../core/errors'
import { type SendOptions, enqueue } from '../../core/jobs'
import type { Logger } from '../../core/logger'
import { tenantCalendar } from '../../core/numbering'
import type { Tx } from '../../db/tenant'

export type Ctx = RequestContext

export type JsonRecord = Record<string, unknown>

export function recordOf(v: unknown): JsonRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : {}
}

export function stringOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

export function iso(d: Date): string {
  return d.toISOString()
}

/** Error with `details.reason` (clients branch on it; the web translates it). */
export function reasonError(
  code: 'CONFLICT' | 'UNPROCESSABLE' | 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION_ERROR',
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): AppError {
  return new AppError(code, message, { reason, ...extra })
}

/** Any-of permission check inside a handler (direction-dependent permissions). */
export function assertPermission(ctx: Pick<Ctx, 'permissions'>, perms: Permission[]): void {
  if (!hasPermission(ctx.permissions, perms)) {
    throw forbidden('You do not have permission to do this', { required: perms })
  }
}

export interface ShopProfile {
  name: string
  name_ta: string | null
  phone: string | null
  city: string | null
  business_type: string
  timezone: string
}

const shopMemo = new WeakMap<Tx, ShopProfile>()

/** The tenant's business profile (name on QRs, pay pages, messages). */
export async function loadShop(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<ShopProfile> {
  const hit = shopMemo.get(tx)
  if (hit) return hit
  const row = await tx
    .selectFrom('tenants')
    .select(['name', 'name_ta', 'phone', 'address', 'business_type', 'timezone'])
    .where('id', '=', ctx.tenantId)
    .executeTakeFirstOrThrow()
  const shop: ShopProfile = {
    name: row.name,
    name_ta: row.name_ta,
    phone: row.phone,
    city: stringOf(recordOf(row.address).city),
    business_type: row.business_type,
    timezone: row.timezone || DEFAULT_TIMEZONE,
  }
  shopMemo.set(tx, shop)
  return shop
}

/** Today's business date in the tenant timezone. */
export async function tenantToday(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<string> {
  return todayIn((await tenantCalendar(tx, ctx)).timezone)
}

/** Business date of an instant in the tenant timezone. */
export async function tenantDateOf(tx: Tx, ctx: Pick<Ctx, 'tenantId'>, at: Date): Promise<string> {
  return toDateStr(at, (await tenantCalendar(tx, ctx)).timezone)
}

/**
 * Enqueues a job without failing the caller: payments keep working when the queue is down
 * (the periodic jobs pick the work up). Errors are logged.
 */
export async function enqueueSafely(
  logger: Pick<Logger, 'warn'>,
  name: string,
  data: object,
  opts: SendOptions = {},
): Promise<void> {
  try {
    await enqueue(name, data, opts)
  } catch (err) {
    logger.warn({ err, job: name }, 'payments: could not enqueue job (the periodic run will retry)')
  }
}
