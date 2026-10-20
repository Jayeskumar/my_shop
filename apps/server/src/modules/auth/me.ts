/**
 * GET /me — everything the web shell needs after sign-in, read in ONE tenant transaction:
 * user, business profile, membership (role + expanded permissions + store scope), entitlements,
 * typed settings (defaults filled), the stores / registers the member may use, deployment mode
 * and the trusted device of a PIN session.
 */
import { AddressSchema } from '@kadai/shared/api/common'
import type { MeResponse } from '@kadai/shared/api/auth'
import type { BusinessType, GstScheme, TenantStatus } from '@kadai/shared'
import type { RequestContext } from '../../core/context'
import { toEntitlementsDto } from '../../core/entitlements'
import { forbidden, notFound } from '../../core/errors'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import type { Tx } from '../../db/tenant'

function readAddress(raw: unknown): MeResponse['tenant']['address'] {
  const parsed = AddressSchema.safeParse(raw)
  return parsed.success ? parsed.data : AddressSchema.parse({})
}

export async function loadMe(
  deps: Pick<KadaiDeps, 'config' | 'entitlements'>,
  tx: Tx,
  ctx: RequestContext,
): Promise<MeResponse> {
  if (!ctx.userId || !ctx.membershipId) throw forbidden('API keys have no user profile')
  const t = ctx.tenantId
  const [user, tenant, role, settings, entitlements] = await Promise.all([
    tx
      .selectFrom('users')
      .select(['id', 'full_name', 'phone', 'email', 'preferred_locale', 'is_platform_admin'])
      .where('id', '=', ctx.userId)
      .executeTakeFirst(),
    tx.selectFrom('tenants').selectAll().where('id', '=', t).executeTakeFirst(),
    tx
      .selectFrom('memberships as m')
      .innerJoin('roles as r', (j) =>
        j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
      )
      .select(['r.code', 'r.name'])
      .where('m.tenant_id', '=', t)
      .where('m.id', '=', ctx.membershipId)
      .executeTakeFirst(),
    getSettings(tx, ctx),
    deps.entitlements.get(t),
  ])
  if (!user) throw notFound('user', ctx.userId)
  if (!tenant) throw notFound('tenant', t)
  if (!role) throw notFound('membership', ctx.membershipId)

  const storesQ = tx
    .selectFrom('stores')
    .select(['id', 'code', 'name', 'name_ta', 'state_code', 'gstin', 'is_active'])
    .where('tenant_id', '=', t)
    .orderBy('code')
  // Store scoping: null = every store of the business.
  const scope = ctx.storeIds
  const stores =
    scope === null
      ? await storesQ.execute()
      : scope.length === 0
        ? []
        : await storesQ.where('id', 'in', [...scope]).execute()
  const registers = stores.length
    ? await tx
        .selectFrom('registers')
        .select(['id', 'store_id', 'code', 'name', 'is_active'])
        .where('tenant_id', '=', t)
        .where(
          'store_id',
          'in',
          stores.map((s) => s.id),
        )
        .orderBy('store_id')
        .orderBy('code')
        .execute()
    : []
  const device = ctx.deviceId
    ? ((await tx
        .selectFrom('devices')
        .select(['id', 'store_id', 'register_id'])
        .where('tenant_id', '=', t)
        .where('id', '=', ctx.deviceId)
        .executeTakeFirst()) ?? null)
    : null

  return {
    user: { ...user, preferred_locale: user.preferred_locale === 'en' ? 'en' : 'ta' },
    tenant: {
      id: tenant.id,
      name: tenant.name,
      name_ta: tenant.name_ta,
      legal_name: tenant.legal_name,
      business_type: tenant.business_type as BusinessType,
      gst_scheme: tenant.gst_scheme as GstScheme,
      gstin: tenant.gstin,
      pan: tenant.pan,
      state_code: tenant.state_code,
      phone: tenant.phone,
      email: tenant.email,
      address: readAddress(tenant.address),
      logo_file_id: tenant.logo_file_id,
      default_locale: tenant.default_locale === 'en' ? 'en' : 'ta',
      timezone: tenant.timezone,
      fy_start_month: tenant.fy_start_month,
      status: tenant.status as TenantStatus,
      plan_code: tenant.plan_code,
    },
    membership: {
      id: ctx.membershipId,
      role_code: role.code,
      role_name: role.name,
      permissions: [...ctx.permissions].sort(),
      store_ids: ctx.storeIds ? [...ctx.storeIds] : null,
    },
    entitlements: toEntitlementsDto(entitlements),
    settings,
    stores,
    registers,
    mode: deps.config.mode,
    device,
    server_time: new Date().toISOString(),
  }
}
