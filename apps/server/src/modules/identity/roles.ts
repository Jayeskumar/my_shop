/**
 * Roles & permissions (docs/API.md "identity" → roles; ARCHITECTURE.md §7.5).
 *
 * System roles (seeded per tenant by onboarding) keep their permissions; they can only be
 * renamed (the owner role always holds '*'). Custom roles need feature custom_roles to create,
 * edit or delete; their permissions are validated codes from the shared catalogue. A role that is
 * assigned to any membership cannot be deleted. Role edits drop every member's cached access
 * (NOTIFY kadai_cache for the whole tenant). Roles are business-wide, so store-scoped admins
 * may create roles (to assign inside their stores) but not edit or delete them
 * (403 all_stores_required).
 */
import type { z } from 'zod'
import { SYSTEM_ROLE_CODES, expandPermissions, isUuid, newId } from '@kadai/shared'
import type {
  Role,
  RoleCreateSchema,
  RoleListQuerySchema,
  RoleUpdateSchema,
} from '@kadai/shared/api/identity'
import { sql } from 'kysely'
import { audit, diffChanges } from '../../core/audit'
import { getEntitlements } from '../../core/entitlements'
import { assertNotStale, duplicate, featureNotInPlan, notFound } from '../../core/errors'
import { type PageEnvelope, parsePage } from '../../core/http'
import { notifyAccessChanged } from '../../core/rbac'
import { type Tx, afterCommit } from '../../db/tenant'
import {
  type Ctx,
  assertAllStores,
  assertGrantable,
  containsPattern,
  iso,
  isOwnerCtx,
  paginateQuery,
  reasonConflict,
  reasonForbidden,
} from './common'
import { type IdentityDeps, OWNER_ROLE_CODE } from './users'

type RoleListQuery = z.output<typeof RoleListQuerySchema>
type RoleCreateBody = z.output<typeof RoleCreateSchema>
type RoleUpdateBody = z.output<typeof RoleUpdateSchema>

function roleQuery(tx: Tx, ctx: Ctx) {
  return tx
    .selectFrom('roles as r')
    .select([
      'r.id',
      'r.code',
      'r.name',
      'r.name_ta',
      'r.description',
      'r.permissions',
      'r.is_system',
      'r.created_at',
      'r.updated_at',
    ])
    .select((eb) =>
      eb
        .selectFrom('memberships as m')
        .select(sql<number>`count(*)::int`.as('n'))
        .whereRef('m.tenant_id', '=', 'r.tenant_id')
        .whereRef('m.role_id', '=', 'r.id')
        .as('member_count'),
    )
    .where('r.tenant_id', '=', ctx.tenantId)
}

type RoleRow = Awaited<ReturnType<ReturnType<typeof roleQuery>['executeTakeFirstOrThrow']>>

function toRole(row: RoleRow, customRolesEnabled: boolean): Role {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    name_ta: row.name_ta,
    description: row.description,
    permissions: [...row.permissions],
    effective_permissions: [...expandPermissions(row.permissions)].sort(),
    is_system: row.is_system,
    editable: !row.is_system && customRolesEnabled,
    member_count: Number(row.member_count ?? 0),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

async function customRolesEnabled(ctx: Ctx): Promise<boolean> {
  return (await getEntitlements(ctx)).features.has('custom_roles')
}

async function assertCustomRolesFeature(ctx: Ctx): Promise<void> {
  const ent = await getEntitlements(ctx)
  if (!ent.features.has('custom_roles')) throw featureNotInPlan('custom_roles', ent.plan_code)
}

export async function listRoles(
  tx: Tx,
  ctx: Ctx,
  query: RoleListQuery,
): Promise<PageEnvelope<Role>> {
  let q = roleQuery(tx, ctx)
  if (query.q) {
    const pattern = containsPattern(query.q)
    q = q.where((eb) =>
      eb.or([
        eb('r.name', 'ilike', pattern),
        eb('r.name_ta', 'ilike', pattern),
        eb('r.code', 'ilike', pattern),
      ]),
    )
  }
  if (query.is_system !== undefined) q = q.where('r.is_system', '=', query.is_system)
  // System roles first in their seeded order, then custom roles by name.
  q = q
    .orderBy('r.is_system', 'desc')
    .orderBy(sql`array_position(${sql.val([...SYSTEM_ROLE_CODES])}::text[], r.code)`)
    .orderBy('r.name')
    .orderBy('r.id')
  const page = await paginateQuery(q, parsePage(query))
  const enabled = await customRolesEnabled(ctx)
  return { data: page.data.map((r) => toRole(r, enabled)), page: page.page }
}

export async function getRole(tx: Tx, ctx: Ctx, id: string): Promise<Role> {
  if (!isUuid(id)) throw notFound('role', id)
  const row = await roleQuery(tx, ctx).where('r.id', '=', id).executeTakeFirst()
  if (!row) throw notFound('role', id)
  return toRole(row, await customRolesEnabled(ctx))
}

/** 'Billing Staff 2' → 'billing_staff_2'; non-Latin names fall back to 'custom_role'. */
export function slugRoleCode(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/g, '')
    .slice(0, 32)
  return slug.length >= 2 ? slug : 'custom_role'
}

const RESERVED_CODES = new Set<string>(SYSTEM_ROLE_CODES)

async function codeTaken(tx: Tx, ctx: Ctx, code: string): Promise<boolean> {
  const row = await tx
    .selectFrom('roles')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('code', '=', code)
    .executeTakeFirst()
  return Boolean(row)
}

/** POST /roles (feature custom_roles, guarded by the route definition). */
export async function createRole(tx: Tx, ctx: Ctx, body: RoleCreateBody): Promise<Role> {
  const effective = expandPermissions(body.permissions)
  assertGrantable(ctx, effective)
  let code: string
  if (body.code) {
    if (RESERVED_CODES.has(body.code)) {
      throw reasonConflict('role_code_reserved', `"${body.code}" is a system role code`)
    }
    if (await codeTaken(tx, ctx, body.code)) {
      throw duplicate(`A role with code "${body.code}" already exists`, { field: 'code' })
    }
    code = body.code
  } else {
    const base = slugRoleCode(body.name)
    code = base
    for (let n = 2; RESERVED_CODES.has(code) || (await codeTaken(tx, ctx, code)); n++) {
      code = `${base.slice(0, 36)}_${n}`
    }
  }
  const id = newId()
  await tx
    .insertInto('roles')
    .values({
      id,
      tenant_id: ctx.tenantId,
      code,
      name: body.name,
      name_ta: body.name_ta ?? null,
      description: body.description ?? null,
      permissions: [...new Set(body.permissions)].sort(),
      is_system: false,
    })
    .execute()
  await audit(tx, ctx, {
    action: 'role.create',
    entity_type: 'role',
    entity_id: id,
    summary: `Role "${body.name}" created`,
    changes: { code, permissions: [...new Set(body.permissions)].sort() },
  })
  return getRole(tx, ctx, id)
}

async function lockRole(tx: Tx, ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound('role', id)
  const row = await tx
    .selectFrom('roles')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('role', id)
  return row
}

/** Every member of the tenant may hold the role: drop all cached access after commit. */
async function rolesChanged(deps: IdentityDeps, tx: Tx, ctx: Ctx): Promise<void> {
  await notifyAccessChanged(tx, { tenant_id: ctx.tenantId })
  afterCommit(tx, () => deps.rbac.invalidate({ tenantId: ctx.tenantId }))
}

/** PATCH /roles/:id — system roles: name / name_ta / description only. */
export async function updateRole(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: RoleUpdateBody,
): Promise<Role> {
  const role = await lockRole(tx, ctx, id)
  // Roles are business-wide: editing one changes the access of members in every store.
  assertAllStores(ctx, 'Changing a role')
  assertNotStale(role.updated_at, body.if_updated_at, 'role', id)
  if (!role.is_system) await assertCustomRolesFeature(ctx)
  if (role.code === OWNER_ROLE_CODE && !isOwnerCtx(ctx)) {
    throw reasonForbidden('owner_only', 'Only an owner can change the owner role')
  }
  const patch: {
    name?: string
    name_ta?: string | null
    description?: string | null
    permissions?: string[]
  } = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.name_ta !== undefined) patch.name_ta = body.name_ta
  if (body.description !== undefined) patch.description = body.description
  if (body.permissions !== undefined) {
    const next = [...new Set(body.permissions)].sort()
    const same = JSON.stringify(next) === JSON.stringify([...role.permissions].sort())
    if (!same) {
      if (role.is_system) {
        throw reasonConflict('system_role', 'The permissions of system roles cannot be changed')
      }
      // A non-owner can neither add permissions they lack nor edit a role holding such.
      assertGrantable(ctx, expandPermissions(next))
      assertGrantable(ctx, expandPermissions(role.permissions))
      patch.permissions = next
    }
  }
  const before = {
    name: role.name,
    name_ta: role.name_ta,
    description: role.description,
    permissions: [...role.permissions].sort(),
  }
  const changes = diffChanges(before, { ...before, ...patch })
  if (!changes) return getRole(tx, ctx, id)
  await tx
    .updateTable('roles')
    .set(patch)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  // Permissions and the role name are part of every holder's cached access.
  await rolesChanged(deps, tx, ctx)
  await audit(tx, ctx, {
    action: patch.permissions ? 'role.permissions_change' : 'role.update',
    entity_type: 'role',
    entity_id: id,
    summary: `Role "${patch.name ?? role.name}" updated`,
    changes,
  })
  return getRole(tx, ctx, id)
}

/** DELETE /roles/:id — custom roles that no membership references. */
export async function deleteRole(deps: IdentityDeps, tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const role = await lockRole(tx, ctx, id)
  assertAllStores(ctx, 'Deleting a role')
  if (role.is_system) throw reasonConflict('system_role', 'System roles cannot be deleted')
  await assertCustomRolesFeature(ctx)
  assertGrantable(ctx, expandPermissions(role.permissions))
  const used = await tx
    .selectFrom('memberships')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('role_id', '=', id)
    .executeTakeFirstOrThrow()
  if (used.n > 0) {
    throw reasonConflict('role_in_use', 'The role is assigned to members; move them first', {
      member_count: used.n,
    })
  }
  await tx.deleteFrom('roles').where('tenant_id', '=', ctx.tenantId).where('id', '=', id).execute()
  await rolesChanged(deps, tx, ctx)
  await audit(tx, ctx, {
    action: 'role.delete',
    entity_type: 'role',
    entity_id: id,
    summary: `Role "${role.name}" deleted`,
    changes: { code: role.code, permissions: role.permissions },
  })
}
