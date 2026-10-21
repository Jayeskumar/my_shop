/**
 * Roles & permissions API: system + custom roles, the permission catalogue, custom roles gated
 * by feature custom_roles, validated permission codes, fixed permissions of system roles,
 * deletion only when unused, privilege-escalation guard, immediate access refresh and isolation.
 */
import { PERMISSION_CODES, SYSTEM_ROLE_CODES, newId } from '@kadai/shared'
import type { PermissionCatalog, Role } from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { slugRoleCode } from '../roles'
import { type Data, type List, api, auditRows, expectError, expectStatus } from './fixtures'

describe('identity: roles & permissions', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const createRole = (
    payload: Record<string, unknown>,
    on: TestShop = shop,
    as?: TestShop['owner'],
  ) => on.inject({ method: 'POST', url: api('/roles'), payload, as })

  it('lists the system roles first with effective permissions and member counts', async () => {
    const res = expectStatus<List<Role>>(
      await shop.inject({ method: 'GET', url: api('/roles') }),
      200,
    )
    expect(res.data.slice(0, SYSTEM_ROLE_CODES.length).map((r) => r.code)).toEqual([
      ...SYSTEM_ROLE_CODES,
    ])
    const owner = res.data.find((r) => r.code === 'owner')!
    expect(owner).toMatchObject({
      is_system: true,
      editable: false,
      permissions: ['*'],
      member_count: 1,
    })
    expect(owner.effective_permissions).toHaveLength(PERMISSION_CODES.length)
    const cashier = res.data.find((r) => r.code === 'cashier')!
    expect(cashier.effective_permissions).toContain('sales.read')
    const custom = expectStatus<List<Role>>(
      await shop.inject({ method: 'GET', url: api('/roles?is_system=false') }),
      200,
    )
    expect(custom.data.every((r) => !r.is_system)).toBe(true)
  })

  it('serves the permission catalogue with Tamil and English labels', async () => {
    const cat = expectStatus<Data<PermissionCatalog>>(
      await shop.inject({ method: 'GET', url: api('/permissions') }),
      200,
    ).data
    const codes = cat.groups.flatMap((g) => g.permissions.map((p) => p.code))
    expect(new Set(codes).size).toBe(PERMISSION_CODES.length)
    const catalogWrite = cat.groups
      .flatMap((g) => g.permissions)
      .find((p) => p.code === 'catalog.write')!
    expect(catalogWrite.implies).toEqual(['catalog.read'])
    expect(catalogWrite.label_ta.length).toBeGreaterThan(0)
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/permissions'), as: cashier }),
      403,
      'FORBIDDEN',
    )
  })

  it('creates custom roles with valid permission codes', async () => {
    const role = expectStatus<Data<Role>>(
      await createRole({
        name: 'Billing Staff',
        name_ta: 'பில்லிங் பணியாளர்',
        permissions: ['pos.use', 'sales.create', 'catalog.read'],
      }),
      201,
    ).data
    expect(role).toMatchObject({
      code: 'billing_staff',
      is_system: false,
      editable: true,
      member_count: 0,
      permissions: ['catalog.read', 'pos.use', 'sales.create'],
    })
    expect(role.effective_permissions).toContain('sales.read')
    // Same name again → a unique code.
    const again = expectStatus<Data<Role>>(
      await createRole({ name: 'Billing Staff', permissions: ['pos.use'] }),
      201,
    ).data
    expect(again.code).toBe('billing_staff_2')
    expect((await auditRows(t, shop, { action: 'role.create', entity_id: role.id })).length).toBe(1)

    expectError(
      await createRole({ name: 'Bad', permissions: ['sales.fly'] }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(await createRole({ name: 'Empty', permissions: [] }), 400, 'VALIDATION_ERROR')
    expectError(
      await createRole({ name: 'Dup', permissions: ['pos.use', 'pos.use'] }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await createRole({ name: 'Owner 2', code: 'owner', permissions: ['pos.use'] }),
      409,
      'CONFLICT',
      'role_code_reserved',
    )
    expectError(
      await createRole({ name: 'Taken', code: 'billing_staff', permissions: ['pos.use'] }),
      409,
      'DUPLICATE',
    )
  })

  it('gates custom roles behind the custom_roles feature', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const err = expectError(
      await createRole({ name: 'Helper', permissions: ['pos.use'] }, free),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    expect(err.details).toMatchObject({ feature: 'custom_roles' })
    // System roles can still be renamed on every plan; they are not "editable" custom roles.
    const list = expectStatus<List<Role>>(
      await free.inject({ method: 'GET', url: api('/roles') }),
      200,
    )
    expect(list.data.every((r) => r.editable === false)).toBe(true)
    expectStatus(
      await free.inject({
        method: 'PATCH',
        url: api(`/roles/${free.roles.cashier}`),
        payload: { name: 'Counter staff', name_ta: 'கவுண்டர் பணியாளர்' },
      }),
      200,
    )
  })

  it('keeps system role permissions fixed and lets owners rename them', async () => {
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${shop.roles.cashier}`),
        payload: { permissions: ['pos.use'] },
      }),
      409,
      'CONFLICT',
      'system_role',
    )
    const renamed = expectStatus<Data<Role>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${shop.roles.cashier}`),
        payload: { name: 'Billing counter', description: 'Front desk' },
      }),
      200,
    ).data
    expect(renamed).toMatchObject({ name: 'Billing counter', description: 'Front desk' })
    expectError(
      await shop.inject({ method: 'DELETE', url: api(`/roles/${shop.roles.accountant}`) }),
      409,
      'CONFLICT',
      'system_role',
    )
  })

  it('applies a custom role’s new permissions to its members immediately', async () => {
    const role = expectStatus<Data<Role>>(
      await createRole({ name: 'Stock viewer', permissions: ['inventory.read'] }),
      201,
    ).data
    const member = await shop.asRole('stock_viewer', { permissions: ['inventory.read'] })
    await t.deps.db.systemDb
      .updateTable('memberships')
      .set({ role_id: role.id })
      .where('id', '=', member.membership.id)
      .execute()
    t.deps.rbac.invalidate({ tenantId: shop.tenant.id })
    expectError(
      await shop.inject({ method: 'GET', url: api('/roles'), as: member }),
      403,
      'FORBIDDEN',
    )
    const updated = expectStatus<Data<Role>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${role.id}`),
        payload: {
          permissions: ['inventory.read', 'users.manage'],
          if_updated_at: role.updated_at,
        },
      }),
      200,
    ).data
    expect(updated.permissions).toEqual(['inventory.read', 'users.manage'])
    expectStatus(await shop.inject({ method: 'GET', url: api('/roles'), as: member }), 200)
    const [row] = await auditRows(t, shop, {
      action: 'role.permissions_change',
      entity_id: role.id,
    })
    expect(row?.changes).toMatchObject({
      before: { permissions: ['inventory.read'] },
      after: { permissions: ['inventory.read', 'users.manage'] },
    })
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${role.id}`),
        payload: { name: 'Late', if_updated_at: role.updated_at },
      }),
      409,
      'STALE_WRITE',
    )
  })

  it('does not let a non-owner create or widen roles beyond their own permissions', async () => {
    const manager = await shop.asRole('manager')
    const err = expectError(
      await createRole({ name: 'Biller', permissions: ['billing.manage'] }, shop, manager),
      403,
      'FORBIDDEN',
      'role_exceeds_own_permissions',
    )
    expect(err.details?.missing).toEqual(['billing.manage'])
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${shop.roles.owner}`),
        payload: { name: 'Boss' },
        as: manager,
      }),
      403,
      'FORBIDDEN',
      'owner_only',
    )
    const role = expectStatus<Data<Role>>(
      await createRole({ name: 'Helper role', permissions: ['pos.use'] }, shop, manager),
      201,
    ).data
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${role.id}`),
        payload: { permissions: ['pos.use', 'billing.manage'] },
        as: manager,
      }),
      403,
      'FORBIDDEN',
      'role_exceeds_own_permissions',
    )
  })

  it('lets branch-scoped admins create roles but not change business-wide ones', async () => {
    const branchAdmin = await shop.asRole('branch_admin', {
      permissions: ['users.manage', 'pos.use', 'catalog.read'],
      store_ids: [shop.store.id],
    })
    const role = expectStatus<Data<Role>>(
      await createRole({ name: 'Branch helper', permissions: ['pos.use'] }, shop, branchAdmin),
      201,
    ).data
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${role.id}`),
        payload: { permissions: ['catalog.read'] },
        as: branchAdmin,
      }),
      403,
      'FORBIDDEN',
      'all_stores_required',
    )
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/roles/${shop.roles.cashier}`),
        payload: { name: 'Renamed by a branch' },
        as: branchAdmin,
      }),
      403,
      'FORBIDDEN',
      'all_stores_required',
    )
    expectError(
      await shop.inject({ method: 'DELETE', url: api(`/roles/${role.id}`), as: branchAdmin }),
      403,
      'FORBIDDEN',
      'all_stores_required',
    )
    // The owner (all stores) still can.
    const res = await shop.inject({ method: 'DELETE', url: api(`/roles/${role.id}`) })
    expect(res.statusCode).toBe(204)
  })

  it('deletes unused custom roles only', async () => {
    const role = expectStatus<Data<Role>>(
      await createRole({ name: 'Temporary', permissions: ['catalog.read'] }),
      201,
    ).data
    const member = await shop.asRole('temp', { permissions: ['catalog.read'] })
    await t.deps.db.systemDb
      .updateTable('memberships')
      .set({ role_id: role.id })
      .where('id', '=', member.membership.id)
      .execute()
    const inUse = expectError(
      await shop.inject({ method: 'DELETE', url: api(`/roles/${role.id}`) }),
      409,
      'CONFLICT',
      'role_in_use',
    )
    expect(inUse.details?.member_count).toBe(1)
    await t.deps.db.systemDb
      .updateTable('memberships')
      .set({ role_id: shop.roles.cashier })
      .where('id', '=', member.membership.id)
      .execute()
    const res = await shop.inject({ method: 'DELETE', url: api(`/roles/${role.id}`) })
    expect(res.statusCode).toBe(204)
    expectError(
      await shop.inject({ method: 'GET', url: api(`/roles/${role.id}`) }),
      404,
      'NOT_FOUND',
    )
    expect((await auditRows(t, shop, { action: 'role.delete', entity_id: role.id })).length).toBe(1)
  })

  it('keeps roles per business', async () => {
    const role = expectStatus<Data<Role>>(
      await createRole({ name: 'Private role', permissions: ['catalog.read'] }),
      201,
    ).data
    expectError(
      await other.inject({ method: 'GET', url: api(`/roles/${role.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'PATCH',
        url: api(`/roles/${role.id}`),
        payload: { name: 'X' },
      }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({ method: 'DELETE', url: api(`/roles/${role.id}`) }),
      404,
      'NOT_FOUND',
    )
    const list = expectStatus<List<Role>>(
      await other.inject({ method: 'GET', url: api('/roles?limit=200') }),
      200,
    )
    expect(list.data.some((r) => r.id === role.id)).toBe(false)
    expectError(
      await shop.inject({ method: 'GET', url: api(`/roles/${newId()}`) }),
      404,
      'NOT_FOUND',
    )
  })

  it('derives role codes from names', () => {
    expect(slugRoleCode('Senior Cashier')).toBe('senior_cashier')
    expect(slugRoleCode('  2nd shift  ')).toBe('nd_shift')
    expect(slugRoleCode('காசாளர்')).toBe('custom_role')
  })
})
