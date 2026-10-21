/**
 * Trusted counter devices (ARCHITECTURE.md §7.4): a manager registers a browser / PC for a store
 * (and optionally a register); the device secret is returned ONCE and only its sha256 is stored
 * (generateDeviceSecret). Cashiers then sign in on it with their PIN. Revoking a device ends
 * every session bound to it (auth_sessions.device_id) and drops the cached device checks, so the
 * next request from it fails with SESSION_REVOKED / DEVICE_NOT_TRUSTED.
 */
import type { z } from 'zod'
import { isUuid, newId } from '@kadai/shared'
import type {
  Device,
  DeviceCreateResult,
  DeviceCreateSchema,
  DeviceListQuerySchema,
  DeviceRevokeSchema,
} from '@kadai/shared/api/identity'
import { audit } from '../../core/audit'
import { notFound, validationError } from '../../core/errors'
import { type PageEnvelope, assertStoreAccess, parsePage } from '../../core/http'
import { notifyAccessChanged } from '../../core/rbac'
import { notifySessionsRevoked } from '../../core/session-cache'
import { generateDeviceSecret } from '../../core/tokens'
import { type Tx, afterCommit } from '../../db/tenant'
import { type Ctx, iso, isoOrNull, paginateQuery, reasonUnprocessable } from './common'
import { usableStore } from './stores'
import type { IdentityDeps } from './users'

type DeviceListQuery = z.output<typeof DeviceListQuerySchema>
type DeviceCreateBody = z.output<typeof DeviceCreateSchema>
type DeviceRevokeBody = z.output<typeof DeviceRevokeSchema>

function deviceQuery(tx: Tx, ctx: Ctx) {
  return tx
    .selectFrom('devices as d')
    .innerJoin('stores as s', (j) =>
      j.onRef('s.tenant_id', '=', 'd.tenant_id').onRef('s.id', '=', 'd.store_id'),
    )
    .leftJoin('registers as r', (j) =>
      j.onRef('r.tenant_id', '=', 'd.tenant_id').onRef('r.id', '=', 'd.register_id'),
    )
    .leftJoin('users as u', 'u.id', 'd.approved_by')
    .select([
      'd.id',
      'd.name',
      'd.store_id',
      's.code as store_code',
      's.name as store_name',
      'd.register_id',
      'r.code as register_code',
      'r.name as register_name',
      'd.user_agent',
      'd.is_active',
      'd.approved_by',
      'u.full_name as approved_by_name',
      'd.last_seen_at',
      'd.revoked_at',
      'd.created_at',
      'd.updated_at',
    ])
    .where('d.tenant_id', '=', ctx.tenantId)
}

type DeviceRow = Awaited<ReturnType<ReturnType<typeof deviceQuery>['executeTakeFirstOrThrow']>>

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    store_id: row.store_id,
    store_code: row.store_code,
    store_name: row.store_name,
    register_id: row.register_id,
    register_code: row.register_code,
    register_name: row.register_name,
    user_agent: row.user_agent,
    status: row.is_active && row.revoked_at === null ? 'active' : 'revoked',
    approved_by: row.approved_by,
    approved_by_name: row.approved_by_name,
    last_seen_at: isoOrNull(row.last_seen_at),
    revoked_at: isoOrNull(row.revoked_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

export async function listDevices(
  tx: Tx,
  ctx: Ctx,
  query: DeviceListQuery,
): Promise<PageEnvelope<Device>> {
  let q = deviceQuery(tx, ctx)
  if (query.store_id) {
    assertStoreAccess(ctx, query.store_id)
    q = q.where('d.store_id', '=', query.store_id)
  }
  if (ctx.storeIds !== null) {
    if (ctx.storeIds.length === 0) return { data: [], page: { ...parsePage(query), total: 0 } }
    q = q.where('d.store_id', 'in', [...ctx.storeIds])
  }
  if (query.register_id) q = q.where('d.register_id', '=', query.register_id)
  if (query.status === 'active') {
    q = q.where('d.is_active', '=', true).where('d.revoked_at', 'is', null)
  } else if (query.status === 'revoked') {
    q = q.where((eb) => eb.or([eb('d.is_active', '=', false), eb('d.revoked_at', 'is not', null)]))
  }
  const page = await paginateQuery(
    q.orderBy('d.created_at', 'desc').orderBy('d.id', 'desc'),
    parsePage(query),
  )
  return { data: page.data.map(toDevice), page: page.page }
}

export async function getDevice(tx: Tx, ctx: Ctx, id: string): Promise<Device> {
  if (!isUuid(id)) throw notFound('device', id)
  const row = await deviceQuery(tx, ctx).where('d.id', '=', id).executeTakeFirst()
  if (!row) throw notFound('device', id)
  return toDevice(row)
}

/** POST /devices — returns the device and its secret (shown once). */
export async function createDevice(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  body: DeviceCreateBody,
): Promise<DeviceCreateResult> {
  const store = await usableStore(tx, ctx, body.store_id)
  if (body.register_id) {
    const reg = isUuid(body.register_id)
      ? await tx
          .selectFrom('registers')
          .select(['id', 'store_id', 'is_active'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', body.register_id)
          .executeTakeFirst()
      : undefined
    if (!reg) {
      throw validationError([
        { path: 'register_id', message: 'Unknown register', code: 'register_unknown' },
      ])
    }
    if (reg.store_id !== store.id) {
      throw reasonUnprocessable('register_store_mismatch', 'The counter belongs to another store')
    }
    if (!reg.is_active) {
      throw reasonUnprocessable('register_inactive', 'This counter is deactivated')
    }
  }
  const { secret, hash } = generateDeviceSecret()
  const id = newId()
  await tx
    .insertInto('devices')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: store.id,
      register_id: body.register_id,
      name: body.name,
      device_secret_hash: hash,
      user_agent: ctx.userAgent ? ctx.userAgent.slice(0, 512) : null,
      approved_by: ctx.userId,
    })
    .execute()
  await notifyAccessChanged(tx, { tenant_id: ctx.tenantId })
  afterCommit(tx, () => deps.rbac.invalidate({ tenantId: ctx.tenantId }))
  await audit(tx, ctx, {
    action: 'device.create',
    entity_type: 'device',
    entity_id: id,
    summary: `Device "${body.name}" trusted for store ${store.code}`,
    changes: { store_id: store.id, register_id: body.register_id },
  })
  return { device: await getDevice(tx, ctx, id), device_secret: secret }
}

/** POST /devices/:id/revoke — idempotent; signs out every session bound to the device. */
export async function revokeDevice(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: DeviceRevokeBody,
): Promise<Device> {
  if (!isUuid(id)) throw notFound('device', id)
  const device = await tx
    .selectFrom('devices')
    .select(['id', 'name', 'store_id', 'is_active', 'revoked_at'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!device) throw notFound('device', id)
  assertStoreAccess(ctx, device.store_id)
  if (!device.is_active || device.revoked_at) return getDevice(tx, ctx, id)
  await tx
    .updateTable('devices')
    .set({ is_active: false, revoked_at: new Date() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await notifyAccessChanged(tx, { tenant_id: ctx.tenantId })
  afterCommit(tx, () => deps.rbac.invalidate({ tenantId: ctx.tenantId }))
  await audit(tx, ctx, {
    action: 'device.revoke',
    entity_type: 'device',
    entity_id: id,
    summary: `Device "${device.name}" revoked${body.reason ? `: ${body.reason}` : ''}`,
    changes: { reason: body.reason ?? null },
  })
  // system db: auth_sessions is system-only — end every live session bound to this device.
  const revoked = await deps.db.systemDb
    .updateTable('auth_sessions')
    .set({ revoked_at: new Date(), revoked_reason: 'device_revoked' })
    .where('device_id', '=', id)
    .where('tenant_id', '=', ctx.tenantId)
    .where('revoked_at', 'is', null)
    .returning(['id', 'user_id'])
    .execute()
  for (const userId of new Set(revoked.map((r) => r.user_id))) {
    await notifySessionsRevoked(deps.db.systemDb, { user_id: userId })
    deps.sessions.invalidate({ userId })
  }
  return getDevice(tx, ctx, id)
}
