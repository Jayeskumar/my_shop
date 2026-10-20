/**
 * Role-based access control resolution (ARCHITECTURE.md §7.4, §7.5).
 *
 * resolve(userId, tenantId) loads the user's membership, role permissions, store scope and the
 * tenant/user status in ONE tenant-scoped query on the app database (RLS applies), then caches
 * it for 30 s in-process. Changes to roles, memberships, users or tenant status must call
 * {@link notifyAccessChanged} inside their transaction: the NOTIFY reaches every API process
 * (including this one) after commit and drops the affected cache entries.
 */
import type { Kysely } from 'kysely'
import { type Locale, type Permission, expandPermissions } from '@kadai/shared'
import type { DB } from '../db/schema.generated'
import { type Tx, withTenant } from '../db/tenant'
import { TtlCache } from './cache'
import { CHANNELS, type EventBus, notify } from './events'

export interface MembershipAccess {
  tenantId: string
  userId: string
  membershipId: string
  roleId: string
  roleCode: string
  roleName: string
  permissions: ReadonlySet<Permission>
  /** null = all stores. */
  storeIds: readonly string[] | null
  membershipStatus: 'active' | 'invited' | 'disabled'
  userStatus: 'active' | 'disabled'
  tenantStatus: 'active' | 'suspended' | 'closed'
  locale: Locale
  isPlatformAdmin: boolean
}

export interface DeviceAccess {
  deviceId: string
  tenantId: string
  storeId: string
  registerId: string | null
  isActive: boolean
}

/** Payload of kadai_cache notifications handled here. */
export interface AccessChange {
  scope: 'rbac'
  tenant_id: string
  /** Omitted = every user of the tenant (role edited, tenant suspended). */
  user_id?: string
}

export class RbacService {
  private readonly memberships: TtlCache<MembershipAccess | null>
  private readonly devices: TtlCache<DeviceAccess | null>

  constructor(
    private readonly appDb: Kysely<DB>,
    opts: { ttlMs?: number } = {},
  ) {
    this.memberships = new TtlCache(opts.ttlMs ?? 30_000)
    this.devices = new TtlCache(opts.ttlMs ?? 30_000)
  }

  /** Membership of `userId` in `tenantId` (any status), or null when there is none. */
  resolve(userId: string, tenantId: string): Promise<MembershipAccess | null> {
    return this.memberships.getOrLoad(`${tenantId}:${userId}`, () => this.load(userId, tenantId))
  }

  /** Trusted device (PIN sessions) — null when unknown in that tenant. */
  resolveDevice(deviceId: string, tenantId: string): Promise<DeviceAccess | null> {
    return this.devices.getOrLoad(`${tenantId}:${deviceId}`, async () => {
      const row = await withTenant(this.appDb, { tenantId, userId: null }, (tx) =>
        tx
          .selectFrom('devices')
          .select(['id', 'tenant_id', 'store_id', 'register_id', 'is_active', 'revoked_at'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', deviceId)
          .executeTakeFirst(),
      )
      if (!row) return null
      return {
        deviceId: row.id,
        tenantId: row.tenant_id,
        storeId: row.store_id,
        registerId: row.register_id,
        isActive: row.is_active && row.revoked_at === null,
      }
    })
  }

  /** Drops cached entries: one user in a tenant, a whole tenant, or everything. */
  invalidate(change: { tenantId?: string; userId?: string } = {}): void {
    if (!change.tenantId) {
      this.memberships.clear()
      this.devices.clear()
      return
    }
    if (change.userId) {
      this.memberships.delete(`${change.tenantId}:${change.userId}`)
      return
    }
    const prefix = `${change.tenantId}:`
    this.memberships.deleteWhere((k) => k.startsWith(prefix))
    this.devices.deleteWhere((k) => k.startsWith(prefix))
  }

  /** Wires cross-process invalidation; returns the unsubscribe function. */
  listen(events: EventBus): () => void {
    return events.subscribe(CHANNELS.cache, (payload) => {
      if (!isAccessChange(payload)) return
      this.invalidate({ tenantId: payload.tenant_id, userId: payload.user_id })
    })
  }

  private async load(userId: string, tenantId: string): Promise<MembershipAccess | null> {
    const row = await withTenant(this.appDb, { tenantId, userId }, (tx) =>
      tx
        .selectFrom('memberships as m')
        .innerJoin('roles as r', (j) =>
          j.onRef('r.id', '=', 'm.role_id').onRef('r.tenant_id', '=', 'm.tenant_id'),
        )
        .innerJoin('tenants as t', 't.id', 'm.tenant_id')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select([
          'm.id as membership_id',
          'm.role_id',
          'm.store_ids',
          'm.status as membership_status',
          'r.code as role_code',
          'r.name as role_name',
          'r.permissions',
          't.status as tenant_status',
          't.default_locale',
          'u.status as user_status',
          'u.preferred_locale',
          'u.is_platform_admin',
        ])
        .where('m.tenant_id', '=', tenantId)
        .where('m.user_id', '=', userId)
        .executeTakeFirst(),
    )
    if (!row) return null
    return {
      tenantId,
      userId,
      membershipId: row.membership_id,
      roleId: row.role_id,
      roleCode: row.role_code,
      roleName: row.role_name,
      permissions: expandPermissions(row.permissions),
      storeIds: row.store_ids,
      membershipStatus: row.membership_status as MembershipAccess['membershipStatus'],
      userStatus: row.user_status as MembershipAccess['userStatus'],
      tenantStatus: row.tenant_status as MembershipAccess['tenantStatus'],
      locale: (row.preferred_locale || row.default_locale) === 'en' ? 'en' : 'ta',
      isPlatformAdmin: row.is_platform_admin,
    }
  }
}

function isAccessChange(v: unknown): v is AccessChange {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    o.scope === 'rbac' &&
    typeof o.tenant_id === 'string' &&
    (o.user_id === undefined || typeof o.user_id === 'string')
  )
}

/**
 * Call inside the transaction that changes a role, membership, user status, device or tenant
 * status. Every process drops the affected cache entries once the transaction commits.
 */
export function notifyAccessChanged(
  tx: Tx | Kysely<DB>,
  change: { tenant_id: string; user_id?: string },
): Promise<void> {
  const payload: AccessChange = { scope: 'rbac', tenant_id: change.tenant_id }
  if (change.user_id) payload.user_id = change.user_id
  return notify(tx, CHANNELS.cache, { ...payload })
}
