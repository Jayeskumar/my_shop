/**
 * Stores and registers (billing counters) — docs/API.md "identity".
 *
 * Stores: plan limit `stores` (active stores) and feature multi_store for more than one active
 * store; code A-Z0-9 ≤ 4, unique, frozen once the store has number series (codes are part of
 * document numbers); GSTIN (optional, checksum) must start with the store's state code; the
 * business keeps at least one active store. Readable by any member (pickers, transfers).
 *
 * Registers: plan limit `registers` (active registers); code ≤ 2 characters, unique per store,
 * frozen once it has number series; settings are a deep-partial PATCH validated in full.
 * Store-scoped admins work only with registers of their stores.
 */
import type { z } from 'zod'
import { RegisterSettingsSchema, isUuid, newId } from '@kadai/shared'
import type {
  Register,
  RegisterCreateSchema,
  RegisterListQuerySchema,
  RegisterUpdateSchema,
  Store,
  StoreCreateSchema,
  StoreListQuerySchema,
  StoreUpdateSchema,
} from '@kadai/shared/api/identity'
import { sql } from 'kysely'
import { audit, diffChanges } from '../../core/audit'
import { assertWithinLimit, getEntitlements } from '../../core/entitlements'
import {
  assertNotStale,
  duplicate,
  featureNotInPlan,
  notFound,
  validationError,
} from '../../core/errors'
import { type PageEnvelope, assertStoreAccess, parsePage } from '../../core/http'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import {
  assertAllStores,
  containsPattern,
  type Ctx,
  iso,
  isoOrNull,
  lockKey,
  mergeDeep,
  paginateQuery,
  readAddress,
  readRegisterSettings,
  reasonConflict,
  reasonUnprocessable,
} from './common'

type StoreListQuery = z.output<typeof StoreListQuerySchema>
type StoreCreateBody = z.output<typeof StoreCreateSchema>
type StoreUpdateBody = z.output<typeof StoreUpdateSchema>
type RegisterListQuery = z.output<typeof RegisterListQuerySchema>
type RegisterCreateBody = z.output<typeof RegisterCreateSchema>
type RegisterUpdateBody = z.output<typeof RegisterUpdateSchema>

// =============================================================================================
// Stores
// =============================================================================================

function storeQuery(tx: Tx, ctx: Ctx) {
  return tx
    .selectFrom('stores as s')
    .select([
      's.id',
      's.code',
      's.name',
      's.name_ta',
      's.gstin',
      's.state_code',
      's.address',
      's.phone',
      's.email',
      's.drug_license_numbers',
      's.fssai_number',
      's.is_active',
      's.created_at',
      's.updated_at',
    ])
    .select((eb) =>
      eb
        .selectFrom('registers as r')
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('r.tenant_id', '=', 's.tenant_id')
        .whereRef('r.store_id', '=', 's.id')
        .where('r.is_active', '=', true)
        .as('register_count'),
    )
    .where('s.tenant_id', '=', ctx.tenantId)
}

type StoreRow = Awaited<ReturnType<ReturnType<typeof storeQuery>['executeTakeFirstOrThrow']>>

function toStore(row: StoreRow): Store {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    name_ta: row.name_ta,
    gstin: row.gstin,
    state_code: row.state_code,
    address: readAddress(row.address),
    phone: row.phone,
    email: row.email,
    drug_license_numbers: row.drug_license_numbers,
    fssai_number: row.fssai_number,
    is_active: row.is_active,
    register_count: Number(row.register_count ?? 0),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

export async function listStores(
  tx: Tx,
  ctx: Ctx,
  query: StoreListQuery,
): Promise<PageEnvelope<Store>> {
  let q = storeQuery(tx, ctx)
  if (query.q) {
    const pattern = containsPattern(query.q)
    q = q.where((eb) =>
      eb.or([
        eb('s.name', 'ilike', pattern),
        eb('s.name_ta', 'ilike', pattern),
        eb('s.code', 'ilike', pattern),
      ]),
    )
  }
  if (query.is_active !== undefined) q = q.where('s.is_active', '=', query.is_active)
  const page = await paginateQuery(q.orderBy('s.code').orderBy('s.id'), parsePage(query))
  return { data: page.data.map(toStore), page: page.page }
}

export async function getStore(tx: Tx, ctx: Ctx, id: string): Promise<Store> {
  if (!isUuid(id)) throw notFound('store', id)
  const row = await storeQuery(tx, ctx).where('s.id', '=', id).executeTakeFirst()
  if (!row) throw notFound('store', id)
  return toStore(row)
}

async function activeStoreCount(tx: Tx, ctx: Ctx, exceptId?: string): Promise<number> {
  let q = tx
    .selectFrom('stores')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('is_active', '=', true)
  if (exceptId) q = q.where('id', '<>', exceptId)
  return (await q.executeTakeFirstOrThrow()).n
}

/** A second active store needs feature multi_store; every active store counts for the limit. */
async function assertCanAddActiveStore(tx: Tx, ctx: Ctx, exceptId?: string): Promise<void> {
  if ((await activeStoreCount(tx, ctx, exceptId)) >= 1) {
    const ent = await getEntitlements(ctx)
    if (!ent.features.has('multi_store')) throw featureNotInPlan('multi_store', ent.plan_code)
  }
  await assertWithinLimit(tx, ctx, 'stores')
}

async function assertStoreCodeFree(tx: Tx, ctx: Ctx, code: string, exceptId?: string) {
  let q = tx
    .selectFrom('stores')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('code', '=', code)
  if (exceptId) q = q.where('id', '<>', exceptId)
  if (await q.executeTakeFirst()) {
    throw duplicate(`Store code "${code}" is already used`, { field: 'code' })
  }
}

function assertGstinMatchesState(gstin: string | null, stateCode: string, path: string): void {
  if (gstin && gstin.slice(0, 2) !== stateCode) {
    throw validationError([{ path, message: 'gstin_state', code: 'gstin_state' }])
  }
}

/** POST /stores. */
export async function createStore(tx: Tx, ctx: Ctx, body: StoreCreateBody): Promise<Store> {
  assertAllStores(ctx, 'Adding a store')
  await assertCanAddActiveStore(tx, ctx)
  await assertStoreCodeFree(tx, ctx, body.code)
  assertGstinMatchesState(body.gstin ?? null, body.state_code, 'gstin')
  const id = newId()
  await tx
    .insertInto('stores')
    .values({
      id,
      tenant_id: ctx.tenantId,
      code: body.code,
      name: body.name,
      name_ta: body.name_ta ?? null,
      gstin: body.gstin ?? null,
      state_code: body.state_code,
      address: jsonb(body.address),
      phone: body.phone ?? null,
      email: body.email ?? null,
      drug_license_numbers: body.drug_license_numbers ?? null,
      fssai_number: body.fssai_number ?? null,
    })
    .execute()
  await audit(tx, ctx, {
    action: 'store.create',
    entity_type: 'store',
    entity_id: id,
    summary: `Store ${body.code} "${body.name}" added`,
    changes: {
      code: body.code,
      name: body.name,
      state_code: body.state_code,
      gstin: body.gstin ?? null,
    },
  })
  return getStore(tx, ctx, id)
}

async function hasSeries(
  tx: Tx,
  ctx: Ctx,
  where: { store_id?: string; register_id?: string },
): Promise<boolean> {
  let q = tx.selectFrom('number_series').select('id').where('tenant_id', '=', ctx.tenantId)
  if (where.store_id) q = q.where('store_id', '=', where.store_id)
  if (where.register_id) q = q.where('register_id', '=', where.register_id)
  return Boolean(await q.limit(1).executeTakeFirst())
}

/** PATCH /stores/:id. */
export async function updateStore(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: StoreUpdateBody,
): Promise<Store> {
  if (!isUuid(id)) throw notFound('store', id)
  const store = await tx
    .selectFrom('stores')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!store) throw notFound('store', id)
  assertStoreAccess(ctx, id)
  assertNotStale(store.updated_at, body.if_updated_at, 'store', id)

  if (body.code !== undefined && body.code !== store.code) {
    if (await hasSeries(tx, ctx, { store_id: id })) {
      throw reasonConflict(
        'store_code_locked',
        'The store code is already part of document numbers and cannot change',
      )
    }
    await assertStoreCodeFree(tx, ctx, body.code, id)
  }
  const stateCode = body.state_code ?? store.state_code
  const gstin = body.gstin !== undefined ? body.gstin : store.gstin
  assertGstinMatchesState(gstin, stateCode, body.gstin !== undefined ? 'gstin' : 'state_code')

  if (body.is_active === false && store.is_active) {
    // Same lock as the stores limit (assertWithinLimit): two admins deactivating the last two
    // active stores at once are serialised, so one of them sees the other's change.
    await lockKey(tx, `kadai_limit:${ctx.tenantId}:stores`)
    if ((await activeStoreCount(tx, ctx, id)) === 0) {
      throw reasonConflict('last_active_store', 'The business must keep one active store')
    }
  }
  if (body.is_active === true && !store.is_active) await assertCanAddActiveStore(tx, ctx, id)

  const patch = {
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.name_ta !== undefined ? { name_ta: body.name_ta } : {}),
    ...(body.gstin !== undefined ? { gstin: body.gstin } : {}),
    ...(body.state_code !== undefined ? { state_code: body.state_code } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.drug_license_numbers !== undefined
      ? { drug_license_numbers: body.drug_license_numbers }
      : {}),
    ...(body.fssai_number !== undefined ? { fssai_number: body.fssai_number } : {}),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
  }
  const beforeAddress = readAddress(store.address)
  const before = {
    code: store.code,
    name: store.name,
    name_ta: store.name_ta,
    gstin: store.gstin,
    state_code: store.state_code,
    phone: store.phone,
    email: store.email,
    drug_license_numbers: store.drug_license_numbers,
    fssai_number: store.fssai_number,
    is_active: store.is_active,
    address: beforeAddress,
  }
  const after = { ...before, ...patch, ...(body.address ? { address: body.address } : {}) }
  const changes = diffChanges(before, after)
  if (!changes) return getStore(tx, ctx, id)
  await tx
    .updateTable('stores')
    .set({ ...patch, ...(body.address ? { address: jsonb(body.address) } : {}) })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  const action =
    body.is_active === false && store.is_active
      ? 'store.deactivate'
      : body.is_active === true && !store.is_active
        ? 'store.activate'
        : 'store.update'
  await audit(tx, ctx, {
    action,
    entity_type: 'store',
    entity_id: id,
    summary: `Store ${after.code} "${after.name}" updated`,
    changes,
  })
  return getStore(tx, ctx, id)
}

// =============================================================================================
// Registers
// =============================================================================================

function registerQuery(tx: Tx, ctx: Ctx) {
  return tx
    .selectFrom('registers as r')
    .innerJoin('stores as s', (j) =>
      j.onRef('s.tenant_id', '=', 'r.tenant_id').onRef('s.id', '=', 'r.store_id'),
    )
    .select([
      'r.id',
      'r.store_id',
      's.code as store_code',
      's.name as store_name',
      'r.code',
      'r.name',
      'r.is_active',
      'r.settings',
      'r.last_seen_at',
      'r.created_at',
      'r.updated_at',
    ])
    .select((eb) =>
      eb
        .selectFrom('devices as d')
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('d.tenant_id', '=', 'r.tenant_id')
        .whereRef('d.register_id', '=', 'r.id')
        .where('d.is_active', '=', true)
        .where('d.revoked_at', 'is', null)
        .as('device_count'),
    )
    .where('r.tenant_id', '=', ctx.tenantId)
}

type RegisterRow = Awaited<ReturnType<ReturnType<typeof registerQuery>['executeTakeFirstOrThrow']>>

function toRegister(row: RegisterRow): Register {
  return {
    id: row.id,
    store_id: row.store_id,
    store_code: row.store_code,
    store_name: row.store_name,
    code: row.code,
    name: row.name,
    is_active: row.is_active,
    settings: readRegisterSettings(row.settings),
    last_seen_at: isoOrNull(row.last_seen_at),
    device_count: Number(row.device_count ?? 0),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

export async function listRegisters(
  tx: Tx,
  ctx: Ctx,
  query: RegisterListQuery,
): Promise<PageEnvelope<Register>> {
  let q = registerQuery(tx, ctx)
  if (query.store_id) {
    assertStoreAccess(ctx, query.store_id)
    q = q.where('r.store_id', '=', query.store_id)
  }
  if (ctx.storeIds !== null) {
    if (ctx.storeIds.length === 0) return { data: [], page: { ...parsePage(query), total: 0 } }
    q = q.where('r.store_id', 'in', [...ctx.storeIds])
  }
  if (query.is_active !== undefined) q = q.where('r.is_active', '=', query.is_active)
  const page = await paginateQuery(
    q.orderBy('s.code').orderBy('r.code').orderBy('r.id'),
    parsePage(query),
  )
  return { data: page.data.map(toRegister), page: page.page }
}

export async function getRegister(tx: Tx, ctx: Ctx, id: string): Promise<Register> {
  if (!isUuid(id)) throw notFound('register', id)
  const row = await registerQuery(tx, ctx).where('r.id', '=', id).executeTakeFirst()
  if (!row) throw notFound('register', id)
  assertStoreAccess(ctx, row.store_id)
  return toRegister(row)
}

/** The store of a new register / device: exists, active and within the caller's access. */
export async function usableStore(tx: Tx, ctx: Ctx, storeId: string) {
  const store = isUuid(storeId)
    ? await tx
        .selectFrom('stores')
        .select(['id', 'code', 'is_active'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', storeId)
        .executeTakeFirst()
    : undefined
  if (!store) {
    throw validationError([{ path: 'store_id', message: 'store_unknown', code: 'store_unknown' }])
  }
  assertStoreAccess(ctx, store.id)
  if (!store.is_active) {
    throw reasonUnprocessable('store_inactive', 'This store is deactivated', { store_id: store.id })
  }
  return store
}

async function assertRegisterCodeFree(
  tx: Tx,
  ctx: Ctx,
  storeId: string,
  code: string,
  exceptId?: string,
): Promise<void> {
  let q = tx
    .selectFrom('registers')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', storeId)
    .where('code', '=', code)
  if (exceptId) q = q.where('id', '<>', exceptId)
  if (await q.executeTakeFirst()) {
    throw duplicate(`Counter code "${code}" is already used in this store`, { field: 'code' })
  }
}

/** POST /registers. */
export async function createRegister(
  tx: Tx,
  ctx: Ctx,
  body: RegisterCreateBody,
): Promise<Register> {
  const store = await usableStore(tx, ctx, body.store_id)
  await assertWithinLimit(tx, ctx, 'registers')
  await assertRegisterCodeFree(tx, ctx, store.id, body.code)
  const id = newId()
  await tx
    .insertInto('registers')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: store.id,
      code: body.code,
      name: body.name,
      settings: jsonb(RegisterSettingsSchema.parse(body.settings)),
    })
    .execute()
  await audit(tx, ctx, {
    action: 'register.create',
    entity_type: 'register',
    entity_id: id,
    summary: `Counter ${store.code}-${body.code} "${body.name}" added`,
    changes: { store_id: store.id, code: body.code, name: body.name },
  })
  return getRegister(tx, ctx, id)
}

/** PATCH /registers/:id. */
export async function updateRegister(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: RegisterUpdateBody,
): Promise<Register> {
  if (!isUuid(id)) throw notFound('register', id)
  const reg = await tx
    .selectFrom('registers')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!reg) throw notFound('register', id)
  assertStoreAccess(ctx, reg.store_id)
  assertNotStale(reg.updated_at, body.if_updated_at, 'register', id)

  if (body.code !== undefined && body.code !== reg.code) {
    if (await hasSeries(tx, ctx, { register_id: id })) {
      throw reasonConflict(
        'register_code_locked',
        'The counter code is already part of invoice numbers and cannot change',
      )
    }
    await assertRegisterCodeFree(tx, ctx, reg.store_id, body.code, id)
  }
  if (body.is_active === true && !reg.is_active) {
    const store = await tx
      .selectFrom('stores')
      .select('is_active')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', reg.store_id)
      .executeTakeFirstOrThrow()
    if (!store.is_active) {
      throw reasonUnprocessable('store_inactive', 'The store of this counter is deactivated')
    }
    await assertWithinLimit(tx, ctx, 'registers')
  }
  const beforeSettings = readRegisterSettings(reg.settings)
  // Deep-merge the partial settings, then validate the result in full (ZodError → 400).
  const settings = body.settings
    ? RegisterSettingsSchema.parse(mergeDeep(beforeSettings, body.settings))
    : beforeSettings
  const before = {
    code: reg.code,
    name: reg.name,
    is_active: reg.is_active,
    settings: beforeSettings,
  }
  const after = {
    code: body.code ?? reg.code,
    name: body.name ?? reg.name,
    is_active: body.is_active ?? reg.is_active,
    settings,
  }
  const changes = diffChanges(before, after)
  if (!changes) return getRegister(tx, ctx, id)
  await tx
    .updateTable('registers')
    .set({
      code: after.code,
      name: after.name,
      is_active: after.is_active,
      settings: jsonb(settings),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action:
      after.is_active !== before.is_active
        ? after.is_active
          ? 'register.activate'
          : 'register.deactivate'
        : 'register.update',
    entity_type: 'register',
    entity_id: id,
    summary: `Counter ${after.code} "${after.name}" updated`,
    changes,
  })
  return getRegister(tx, ctx, id)
}
