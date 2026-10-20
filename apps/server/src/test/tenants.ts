/**
 * Onboarding-based tenant fixture for domain and module tests (ARCHITECTURE.md §18). Unlike the
 * minimal insertTestTenant (helpers.ts), createTestTenant runs the real onboarding: system roles,
 * owner, store S1, register A, chart of accounts, vertical categories / tax-slab rules and
 * settings — so posting services (numbering, stock, ledger, payments) work out of the box.
 *
 *   const t = await buildTestApp()
 *   const shop = await createTestTenant(t, { business_type: 'pharmacy' })
 *   await shop.tx((tx) => postStock(tx, shop.ctx, [...]))                 // owner context, RLS
 *   const res = await shop.inject({ method: 'GET', url: '/api/v1/me' })   // as the owner
 *   const cashier = await shop.asRole('cashier')
 *   await shop.inject({ method: 'POST', url: '/api/v1/…', payload, as: cashier })
 */
import { randomInt } from 'node:crypto'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import {
  type BusinessType,
  type GstScheme,
  type Permission,
  ROLE_PRESETS,
  type SystemRoleCode,
  type TenantSettingsPatch,
  expandPermissions,
  isUuid,
  makeGstin,
  newId,
} from '@kadai/shared'
import type { RequestContext } from '../core/context'
import { type CreatedTenant, createTenant } from '../core/onboarding'
import { hashPassword, hashPin } from '../core/passwords'
import type { KadaiDeps } from '../core/runtime'
import { type Tx, withTenant } from '../db/tenant'
import { type TestApp, bearer, randomPhone, signTestSession } from './helpers'

/** Password of every fixture user (passes the password policy). */
export const TEST_PASSWORD = 'Kadai-Test-Pass#2026'

export interface TestShopMember {
  user: { id: string; phone: string; full_name: string }
  membership: { id: string; role_id: string; role_code: string }
  password: string
  /** Access token of a real session (auth_sessions row). */
  token: string
  session: { id: string; family_id: string; refresh_token: string }
  /** Request context equivalent to what the auth plugin builds for this member. */
  ctx: RequestContext
  headers: { authorization: string }
}

export interface TestShop {
  tenant: CreatedTenant['tenant']
  store: CreatedTenant['store']
  register: CreatedTenant['register']
  /** System role ids by code. */
  roles: Record<SystemRoleCode, string>
  owner: TestShopMember
  /** The owner's context (shortcut for owner.ctx). */
  ctx: RequestContext
  /** Adds a member with a system role (or a custom role from `permissions`). */
  asRole(
    roleCode: SystemRoleCode | string,
    opts?: { permissions?: readonly string[]; store_ids?: string[] | null; pin?: string },
  ): Promise<TestShopMember>
  /** app.inject as `as` (default: the owner); `as: null` sends no credentials. */
  inject(opts: InjectOptions & { as?: TestShopMember | null }): Promise<LightMyRequestResponse>
  /** One RLS tenant transaction (withTenant on the app database) as `as` (default owner). */
  tx<T>(fn: (tx: Tx) => Promise<T>, as?: TestShopMember): Promise<T>
}

export interface CreateTestTenantOptions {
  business_type?: BusinessType
  /** Default 'regular' (with a generated valid GSTIN). */
  gst_scheme?: GstScheme
  state_code?: string
  name?: string
  /**
   * Entitlements: 'trial' keeps the onboarding trial (growth), 'free' cancels it, any other plan
   * code turns the subscription into an active subscription of that plan. Default 'pro'.
   */
  plan_code?: 'trial' | 'free' | 'growth' | 'pro' | 'enterprise'
  settings?: TenantSettingsPatch
  owner_pin?: string
  phone?: string
}

/** A random valid GSTIN for `stateCode` (PAN of a proprietor). */
export function randomGstin(stateCode = '33'): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const l = () => letters[randomInt(letters.length)]!
  const pan = `${l()}${l()}${l()}P${l()}${String(randomInt(0, 10_000)).padStart(4, '0')}${l()}`
  return makeGstin(stateCode, pan, String(randomInt(1, 10)))
}

function memberCtx(
  tenantId: string,
  m: { user_id: string; membership_id: string; role_code: string; session_id: string },
  permissions: ReadonlySet<Permission>,
  storeIds: readonly string[] | null,
): RequestContext {
  return {
    requestId: `test:${newId()}`,
    tenantId,
    userId: m.user_id,
    membershipId: m.membership_id,
    sessionId: m.session_id,
    apiKeyId: null,
    roleCode: m.role_code,
    permissions,
    storeIds,
    deviceId: null,
    registerId: null,
    locale: 'ta',
    ip: '127.0.0.1',
    userAgent: 'vitest',
    authMethods: ['password'],
  }
}

async function applyPlan(
  deps: Pick<KadaiDeps, 'db' | 'entitlements'>,
  tenantId: string,
  plan: NonNullable<CreateTestTenantOptions['plan_code']>,
): Promise<void> {
  if (plan === 'trial') return
  const db = deps.db.systemDb
  if (plan === 'free') {
    await db
      .updateTable('subscriptions')
      .set({ status: 'cancelled' })
      .where('tenant_id', '=', tenantId)
      .execute()
  } else {
    const now = new Date()
    const updated = await db
      .updateTable('subscriptions')
      .set({
        plan_code: plan,
        status: 'active',
        trial_ends_at: null,
        current_period_start: now,
        current_period_end: new Date(now.getTime() + 365 * 86_400_000),
      })
      .where('tenant_id', '=', tenantId)
      .returning('id')
      .execute()
    if (updated.length === 0) {
      await db.updateTable('tenants').set({ plan_code: plan }).where('id', '=', tenantId).execute()
    }
  }
  deps.entitlements.invalidate(tenantId)
}

/** Creates a tenant through onboarding (see the module comment). */
export async function createTestTenant(
  t: Pick<TestApp, 'app' | 'deps'>,
  opts: CreateTestTenantOptions = {},
): Promise<TestShop> {
  const deps = t.deps
  const stateCode = opts.state_code ?? '33'
  const scheme = opts.gst_scheme ?? 'regular'
  const suffix = newId().slice(-6)
  const created = await createTenant(deps.db.systemDb, {
    business_name: opts.name ?? `Test Shop ${suffix}`,
    business_name_ta: `சோதனைக் கடை ${suffix}`,
    business_type: opts.business_type ?? 'general_store',
    gst_scheme: scheme,
    gstin: scheme === 'unregistered' ? null : randomGstin(stateCode),
    state_code: stateCode,
    locale: 'ta',
    owner: {
      full_name: `Owner ${suffix}`,
      phone: opts.phone ?? randomPhone(),
      password: TEST_PASSWORD,
      pin: opts.owner_pin ?? null,
    },
    mode: deps.config.mode,
    settings: opts.settings,
  })
  await applyPlan(deps, created.tenant.id, opts.plan_code ?? 'pro')

  const tenantId = created.tenant.id
  const allPermissions = expandPermissions(['*'])

  async function session(member: {
    user_id: string
    membership_id: string
  }): Promise<{ token: string; session: TestShopMember['session'] }> {
    const s = await signTestSession(deps, { ...member, tenant_id: tenantId })
    return {
      token: s.accessToken,
      session: { id: s.sessionId, family_id: s.familyId, refresh_token: s.refreshToken },
    }
  }

  const ownerSession = await session({
    user_id: created.user.id,
    membership_id: created.membership.id,
  })
  const owner: TestShopMember = {
    user: { id: created.user.id, phone: created.user.phone, full_name: created.user.full_name },
    membership: {
      id: created.membership.id,
      role_id: created.membership.role_id,
      role_code: 'owner',
    },
    password: TEST_PASSWORD,
    ...ownerSession,
    ctx: memberCtx(
      tenantId,
      {
        user_id: created.user.id,
        membership_id: created.membership.id,
        role_code: 'owner',
        session_id: ownerSession.session.id,
      },
      allPermissions,
      null,
    ),
    headers: bearer(ownerSession.token),
  }

  const passwordHash = await hashPassword(TEST_PASSWORD)

  const asRole: TestShop['asRole'] = async (roleCode, roleOpts = {}) => {
    const preset = (ROLE_PRESETS as Record<string, (typeof ROLE_PRESETS)[SystemRoleCode]>)[roleCode]
    let roleId: string
    let permissions: readonly string[]
    if (preset && !roleOpts.permissions) {
      roleId = created.roles[roleCode as SystemRoleCode]
      permissions = roleCode === 'owner' ? ['*'] : preset.permissions
    } else {
      if (!roleOpts.permissions)
        throw new Error(`asRole(${roleCode}): unknown role, pass permissions`)
      roleId = newId()
      permissions = roleOpts.permissions
      await deps.db.systemDb
        .insertInto('roles')
        .values({
          id: roleId,
          tenant_id: tenantId,
          code: `${roleCode}_${randomInt(1e5, 1e6)}`.slice(0, 40),
          name: roleCode,
          permissions: [...permissions],
        })
        .execute()
    }
    const userId = newId()
    const phone = randomPhone()
    const fullName = `${roleCode} ${userId.slice(-4)}`
    const storeIds = roleOpts.store_ids ?? null
    if (storeIds && !storeIds.every(isUuid)) throw new Error('asRole: store_ids must be UUIDs')
    const membershipId = newId()
    await deps.db.systemDb.transaction().execute(async (tx) => {
      await tx
        .insertInto('users')
        .values({
          id: userId,
          phone,
          full_name: fullName,
          password_hash: passwordHash,
          password_changed_at: new Date(),
        })
        .execute()
      await tx
        .insertInto('memberships')
        .values({
          id: membershipId,
          tenant_id: tenantId,
          user_id: userId,
          role_id: roleId,
          store_ids: storeIds,
          pos_pin_hash: roleOpts.pin ? await hashPin(roleOpts.pin) : null,
        })
        .execute()
    })
    const s = await session({ user_id: userId, membership_id: membershipId })
    return {
      user: { id: userId, phone, full_name: fullName },
      membership: { id: membershipId, role_id: roleId, role_code: roleCode },
      password: TEST_PASSWORD,
      ...s,
      ctx: memberCtx(
        tenantId,
        {
          user_id: userId,
          membership_id: membershipId,
          role_code: roleCode,
          session_id: s.session.id,
        },
        expandPermissions(permissions),
        storeIds,
      ),
      headers: bearer(s.token),
    }
  }

  return {
    tenant: created.tenant,
    store: created.store,
    register: created.register,
    roles: created.roles,
    owner,
    ctx: owner.ctx,
    asRole,
    inject({ as, ...injectOpts }) {
      const member = as === undefined ? owner : as
      const headers = { ...(member ? member.headers : {}), ...(injectOpts.headers ?? {}) }
      return t.app.inject({ ...injectOpts, headers })
    },
    tx(fn, as) {
      return withTenant(deps.db.appDb, (as ?? owner).ctx, fn)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Raw master-data fixtures (system database; for tests of posting services)
// ---------------------------------------------------------------------------------------------

type FixtureDeps = Pick<KadaiDeps, 'db'>

export interface TestProductOptions {
  name?: string
  kind?: 'standard' | 'variant_parent' | 'service'
  unit?: string
  pack_size?: number
  track_inventory?: boolean
  track_batches?: boolean
  purchase_price_paise?: number
  sale_price_paise?: number
  mrp_paise?: number | null
  gst_rate_bp?: number
}

export async function insertTestProduct(
  deps: FixtureDeps,
  tenantId: string,
  opts: TestProductOptions = {},
): Promise<{ id: string; name: string; pack_size: number }> {
  const id = newId()
  const name = opts.name ?? `Product ${id.slice(-6)}`
  const kind = opts.kind ?? 'standard'
  const packSize = opts.pack_size ?? 1
  await deps.db.systemDb
    .insertInto('products')
    .values({
      id,
      tenant_id: tenantId,
      kind,
      name,
      unit: opts.unit ?? 'PCS',
      pack_size: packSize,
      track_inventory: kind === 'service' ? false : (opts.track_inventory ?? true),
      track_batches: opts.track_batches ?? false,
      purchase_price_paise: opts.purchase_price_paise ?? 0,
      sale_price_paise: opts.sale_price_paise ?? 0,
      mrp_paise: opts.mrp_paise ?? null,
      gst_rate_bp: opts.gst_rate_bp ?? 0,
    })
    .execute()
  return { id, name, pack_size: packSize }
}

export async function insertTestBatch(
  deps: FixtureDeps,
  tenantId: string,
  productId: string,
  opts: {
    batch_no?: string
    expiry_date?: string | null
    purchase_price_paise?: number | null
  } = {},
): Promise<{ id: string; batch_no: string }> {
  const id = newId()
  const batchNo = opts.batch_no ?? `B${id.slice(-6).toUpperCase()}`
  await deps.db.systemDb
    .insertInto('batches')
    .values({
      id,
      tenant_id: tenantId,
      product_id: productId,
      batch_no: batchNo,
      expiry_date: opts.expiry_date ?? null,
      purchase_price_paise: opts.purchase_price_paise ?? null,
    })
    .execute()
  return { id, batch_no: batchNo }
}

export async function insertTestCustomer(
  deps: FixtureDeps,
  tenantId: string,
  opts: { name?: string; phone?: string | null; opening_balance_paise?: number } = {},
): Promise<{ id: string; name: string }> {
  const id = newId()
  const name = opts.name ?? `Customer ${id.slice(-6)}`
  await deps.db.systemDb
    .insertInto('customers')
    .values({
      id,
      tenant_id: tenantId,
      name,
      phone: opts.phone ?? null,
      opening_balance_paise: opts.opening_balance_paise ?? 0,
    })
    .execute()
  return { id, name }
}

export async function insertTestSupplier(
  deps: FixtureDeps,
  tenantId: string,
  opts: { name?: string; opening_balance_paise?: number } = {},
): Promise<{ id: string; name: string }> {
  const id = newId()
  const name = opts.name ?? `Supplier ${id.slice(-6)}`
  await deps.db.systemDb
    .insertInto('suppliers')
    .values({
      id,
      tenant_id: tenantId,
      name,
      opening_balance_paise: opts.opening_balance_paise ?? 0,
    })
    .execute()
  return { id, name }
}
