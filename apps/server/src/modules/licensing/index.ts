/**
 * licensing module — the vendor control plane & platform administration (/api/v1/platform/*):
 *  - Cloud tenant administration (GET /platform/tenants, GET /platform/tenants/:id,
 *    POST suspend / resume / plan change)
 *  - Plans & editions management (GET /platform/plans, PUT /platform/plans/:code)
 *  - Platform metrics dashboard (GET /platform/metrics)
 *  - On-prem licences (GET /platform/licenses, POST /platform/licenses, GET /platform/licenses/:id)
 *  - Vendor customers, price book, staff & platform audit log.
 *
 * All vendor / platform tables (migration 0010, plans, tenants, platform_audit_logs) are system-level
 * tables without tenant RLS, so handlers access `deps.db.systemDb` after verifying platform staff /
 * platform admin authorization (`config: { auth: 'user' }`).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { type Kysely, sql } from 'kysely'
import {
  type BusinessType,
  type Feature,
  type LicenseEventKind,
  type LicenseType,
  type PlatformStaffRole,
  type SubscriptionStatus,
  type TenantStatus,
  type VendorLicenseStatus,
  addDays,
  isFeature,
  newId,
  todayIn,
} from '@kadai/shared'
import { AddressSchema } from '@kadai/shared/api/common'
import {
  DEFAULT_VENDOR_STATE_CODE,
  type LicenseAddon,
  LicenseAddonSchema,
  type LicenseDetail,
  type LicenseEvent,
  type LicenseRow,
  type PlanAdmin,
  type PlatformAuditLog,
  type StaffMember,
  type TenantAdminDetail,
  type TenantAdminRow,
  type VendorCapability,
  type VendorCustomerRow,
  type VendorMe,
  type VendorMetrics,
  amcStatus,
  generateLicenseKey,
  licenseEffectiveFeatures,
  licenseEffectiveLimits,
  licenseKeyPrefix,
  licenseTermStatus,
  licensingRoutes,
  priceWithGst,
  termEndDate,
  vendorCan,
  vendorCapabilitiesFor,
} from '@kadai/shared/api/licensing'
import { z } from 'zod'
import { sha256Hex } from '../../core/crypto'
import { forbidden, notFound, unauthenticated } from '../../core/errors'
import { type RouteImpls, registerRoutes } from '../../core/http'
import { jsonb } from '../../db/json'
import type { DB } from '../../db/schema.generated'
import { readPlanLimits } from '../platform/catalog'
import { defineModule } from '../module'

type Routes = typeof licensingRoutes

function iso(d: Date | string): string
function iso(d: Date | string | null | undefined): string | null
function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

function dateStr(d: Date | string): string
function dateStr(d: Date | string | null | undefined): string | null
function dateStr(d: Date | string | null | undefined): string | null {
  if (!d) return null
  if (typeof d === 'string') return d.slice(0, 10)
  return d.toISOString().slice(0, 10)
}

interface StaffIdentity {
  userId: string
  fullName: string
  role: PlatformStaffRole
  partnerId: string | null
  partnerName: string | null
}

async function resolveStaff(db: Kysely<DB>, req: FastifyRequest): Promise<StaffIdentity> {
  if (!req.auth || req.auth.kind !== 'user') throw unauthenticated('User authentication required')
  const userId = req.auth.userId
  const row = await db
    .selectFrom('platform_staff as ps')
    .innerJoin('users as u', 'u.id', 'ps.user_id')
    .leftJoin('partners as p', 'p.id', 'ps.partner_id')
    .select([
      'ps.user_id',
      'u.full_name',
      'ps.role',
      'ps.partner_id',
      'p.name as partner_name',
      'ps.is_active',
    ])
    .where('ps.user_id', '=', userId)
    .executeTakeFirst()

  if (row) {
    if (!row.is_active) throw forbidden('Platform staff account is disabled')
    return {
      userId: row.user_id,
      fullName: row.full_name,
      role: row.role as PlatformStaffRole,
      partnerId: row.partner_id,
      partnerName: row.partner_name,
    }
  }

  const u = await db
    .selectFrom('users')
    .select(['id', 'full_name', 'status', 'is_platform_admin'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (u && u.status === 'active' && u.is_platform_admin) {
    return {
      userId: u.id,
      fullName: u.full_name,
      role: 'owner',
      partnerId: null,
      partnerName: null,
    }
  }

  throw forbidden('Platform staff access required')
}

async function requireStaff(
  db: Kysely<DB>,
  req: FastifyRequest,
  capability: VendorCapability | null,
): Promise<StaffIdentity> {
  const staff = await resolveStaff(db, req)
  if (capability && !vendorCan(staff.role, capability)) {
    throw forbidden(`Missing vendor capability: ${capability}`)
  }
  return staff
}

async function writePlatformAudit(
  db: Kysely<DB>,
  input: {
    actorUserId: string | null
    tenantId?: string | null
    action: string
    details?: Record<string, unknown>
    req?: FastifyRequest
  },
): Promise<void> {
  await db
    .insertInto('platform_audit_logs')
    .values({
      actor_user_id: input.actorUserId,
      tenant_id: input.tenantId ?? null,
      action: input.action,
      details: jsonb(input.details ?? {}),
      ip: input.req?.ip ?? null,
      request_id: input.req?.id ?? null,
    })
    .execute()
}

function toFeatures(raw: unknown): Feature[] {
  return Array.isArray(raw) ? raw.filter((f): f is Feature => isFeature(f)) : []
}

async function loadTenantAdminRows(
  db: Kysely<DB>,
  tenantIds?: readonly string[],
): Promise<TenantAdminRow[]> {
  let qb = db
    .selectFrom('tenants as t')
    .select([
      't.id',
      't.name',
      't.name_ta',
      't.business_type',
      't.state_code',
      't.address',
      't.plan_code',
      't.status',
      't.suspended_reason',
      't.created_at',
    ])
  if (tenantIds) {
    if (tenantIds.length === 0) return []
    qb = qb.where('t.id', 'in', [...tenantIds])
  }
  const tenants = await qb.execute()
  if (tenants.length === 0) return []
  const ids = tenants.map((t) => t.id)

  const [owners, subs, storesCount, usersCount, regsCount, prodsCount, invStats] =
    await Promise.all([
      db
        .selectFrom('memberships as tm')
        .innerJoin('roles as r', (j) =>
          j.onRef('r.tenant_id', '=', 'tm.tenant_id').onRef('r.id', '=', 'tm.role_id'),
        )
        .innerJoin('users as u', 'u.id', 'tm.user_id')
        .select(['tm.tenant_id', 'u.full_name', 'u.phone'])
        .where('tm.tenant_id', 'in', ids)
        .where('r.code', '=', 'owner')
        .where('tm.status', '=', 'active')
        .orderBy('tm.created_at', 'asc')
        .execute(),
      db
        .selectFrom('subscriptions')
        .select([
          'id',
          'tenant_id',
          'plan_code',
          'status',
          'billing_cycle',
          'current_period_end',
          'trial_ends_at',
        ])
        .where('tenant_id', 'in', ids)
        .orderBy('created_at', 'desc')
        .execute(),
      db
        .selectFrom('stores')
        .select(['tenant_id', sql<number>`count(*)::int`.as('cnt')])
        .where('tenant_id', 'in', ids)
        .where('is_active', '=', true)
        .groupBy('tenant_id')
        .execute(),
      db
        .selectFrom('memberships')
        .select(['tenant_id', sql<number>`count(*)::int`.as('cnt')])
        .where('tenant_id', 'in', ids)
        .where('status', '=', 'active')
        .groupBy('tenant_id')
        .execute(),
      db
        .selectFrom('registers')
        .select(['tenant_id', sql<number>`count(*)::int`.as('cnt')])
        .where('tenant_id', 'in', ids)
        .where('is_active', '=', true)
        .groupBy('tenant_id')
        .execute(),
      db
        .selectFrom('products')
        .select(['tenant_id', sql<number>`count(*)::int`.as('cnt')])
        .where('tenant_id', 'in', ids)
        .where('is_active', '=', true)
        .groupBy('tenant_id')
        .execute(),
      db
        .selectFrom('sales_invoices')
        .select([
          'tenant_id',
          sql<number>`count(*) filter (where status = 'completed' and created_at >= date_trunc('month', now()))::int`.as(
            'month_cnt',
          ),
          sql<Date | null>`max(created_at) filter (where status = 'completed')`.as('last_at'),
        ])
        .where('tenant_id', 'in', ids)
        .groupBy('tenant_id')
        .execute(),
    ])

  const ownerByTenant = new Map<string, { full_name: string; phone: string | null }>()
  for (const o of owners) {
    if (!ownerByTenant.has(o.tenant_id)) ownerByTenant.set(o.tenant_id, o)
  }
  const subByTenant = new Map<string, (typeof subs)[number]>()
  for (const s of subs) {
    if (!subByTenant.has(s.tenant_id)) subByTenant.set(s.tenant_id, s)
  }
  const storesMap = new Map<string, number>(
    storesCount.map((r) => [r.tenant_id, Number(r.cnt)]),
  )
  const usersMap = new Map<string, number>(usersCount.map((r) => [r.tenant_id, Number(r.cnt)]))
  const regsMap = new Map<string, number>(regsCount.map((r) => [r.tenant_id, Number(r.cnt)]))
  const prodsMap = new Map<string, number>(prodsCount.map((r) => [r.tenant_id, Number(r.cnt)]))
  const invMap = new Map<string, { month: number; last: Date | null }>(
    invStats.map((r) => [r.tenant_id, { month: Number(r.month_cnt), last: r.last_at }]),
  )

  return tenants.map((t): TenantAdminRow => {
    const owner = ownerByTenant.get(t.id)
    const sub = subByTenant.get(t.id)
    const inv = invMap.get(t.id)
    const addr = AddressSchema.safeParse(t.address ?? {})
    return {
      id: t.id,
      name: t.name,
      name_ta: t.name_ta,
      business_type: t.business_type as BusinessType,
      state_code: t.state_code,
      district: addr.success ? (addr.data.district ?? addr.data.city ?? null) : null,
      plan_code: t.plan_code,
      status: t.status as TenantStatus,
      suspended_reason: t.suspended_reason,
      owner_name: owner?.full_name ?? null,
      owner_phone: owner?.phone ?? null,
      subscription_status: (sub?.status as SubscriptionStatus | undefined) ?? null,
      billing_cycle: (sub?.billing_cycle as 'monthly' | 'yearly' | undefined) ?? null,
      current_period_end: iso(sub?.current_period_end),
      trial_ends_at: iso(sub?.trial_ends_at),
      usage: {
        stores: storesMap.get(t.id) ?? 0,
        users: usersMap.get(t.id) ?? 0,
        registers: regsMap.get(t.id) ?? 0,
        products: prodsMap.get(t.id) ?? 0,
        invoices_this_month: inv?.month ?? 0,
      },
      last_invoice_at: iso(inv?.last ?? null),
      created_at: iso(t.created_at),
    }
  })
}

async function loadTenantDetail(db: Kysely<DB>, id: string): Promise<TenantAdminDetail> {
  const rows = await loadTenantAdminRows(db, [id])
  const base = rows[0]
  if (!base) throw notFound('tenant', id)

  const [tenantRow, subRow, planRow, orders, legacyInvoices, customerRow, auditRows] =
    await Promise.all([
      db
        .selectFrom('tenants')
        .select(['gstin', 'gst_scheme', 'phone', 'email'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('subscriptions')
        .selectAll()
        .where('tenant_id', '=', id)
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
      db
        .selectFrom('plans')
        .select(['code', 'features', 'limits'])
        .where('code', '=', base.plan_code)
        .executeTakeFirst(),
      db
        .selectFrom('vendor_orders')
        .select(['id', 'number', 'total_paise', 'status', 'created_at'])
        .where('tenant_id', '=', id)
        .orderBy('created_at', 'desc')
        .limit(25)
        .execute(),
      db
        .selectFrom('platform_invoices')
        .select(['id', 'number', 'total_paise', 'status', 'created_at'])
        .where('tenant_id', '=', id)
        .orderBy('created_at', 'desc')
        .limit(25)
        .execute(),
      db
        .selectFrom('vendor_customers')
        .select(['id', 'business_name'])
        .where('tenant_id', '=', id)
        .executeTakeFirst(),
      db
        .selectFrom('platform_audit_logs as a')
        .leftJoin('users as u', 'u.id', 'a.actor_user_id')
        .select([
          'a.id',
          'a.actor_user_id',
          'u.full_name as actor_name',
          'a.tenant_id',
          'a.action',
          'a.details',
          'a.ip',
          'a.request_id',
          'a.created_at',
        ])
        .where('a.tenant_id', '=', id)
        .orderBy('a.created_at', 'desc')
        .limit(50)
        .execute(),
    ])

  const baseLimits = readPlanLimits(planRow?.limits ?? {})
  const overrides =
    subRow?.limit_overrides && typeof subRow.limit_overrides === 'object'
      ? (subRow.limit_overrides as Record<string, number | null>)
      : {}
  const mergedLimits = { ...baseLimits, ...overrides }

  return {
    ...base,
    gstin: tenantRow.gstin,
    gst_scheme: tenantRow.gst_scheme,
    phone: tenantRow.phone,
    email: tenantRow.email,
    subscription: subRow
      ? {
          id: subRow.id,
          plan_code: subRow.plan_code,
          status: subRow.status as SubscriptionStatus,
          billing_cycle: subRow.billing_cycle as 'monthly' | 'yearly',
          current_period_start: iso(subRow.current_period_start),
          current_period_end: iso(subRow.current_period_end),
          trial_ends_at: iso(subRow.trial_ends_at),
          cancel_at_period_end: subRow.cancel_at_period_end,
          provider: (subRow.provider as 'razorpay' | 'manual' | null) ?? null,
          provider_subscription_id: subRow.provider_subscription_id,
          limit_overrides: overrides,
        }
      : null,
    entitlements: {
      plan_code: base.plan_code,
      features: toFeatures(planRow?.features),
      limits: mergedLimits,
    },
    invoices: [
      ...orders.map((o) => ({
        id: o.id,
        source: 'order' as const,
        number: o.number,
        total_paise: Number(o.total_paise),
        status: o.status as
          | 'draft'
          | 'pending_payment'
          | 'paid'
          | 'fulfilled'
          | 'cancelled'
          | 'refunded',
        created_at: iso(o.created_at),
      })),
      ...legacyInvoices.map((inv) => ({
        id: inv.id,
        source: 'platform_invoice' as const,
        number: inv.number,
        total_paise: Number(inv.total_paise),
        status: inv.status as 'draft' | 'issued' | 'paid' | 'void',
        created_at: iso(inv.created_at),
      })),
    ],
    vendor_customer: customerRow ? { id: customerRow.id, name: customerRow.business_name } : null,
    audit: auditRows.map((a) => ({
      id: Number(a.id),
      actor_user_id: a.actor_user_id,
      actor_name: a.actor_name,
      tenant_id: a.tenant_id,
      tenant_name: base.name,
      action: a.action,
      details:
        a.details && typeof a.details === 'object' && !Array.isArray(a.details)
          ? (a.details as Record<string, unknown>)
          : {},
      ip: a.ip,
      request_id: a.request_id,
      created_at: iso(a.created_at),
    })),
  }
}

async function loadPlansAdmin(db: Kysely<DB>): Promise<PlanAdmin[]> {
  const [plans, tenantCounts, licenseCounts] = await Promise.all([
    db.selectFrom('plans').selectAll().orderBy('sort_order').orderBy('code').execute(),
    db
      .selectFrom('tenants')
      .select(['plan_code', sql<number>`count(*)::int`.as('cnt')])
      .groupBy('plan_code')
      .execute(),
    db
      .selectFrom('licenses')
      .select(['plan_code', sql<number>`count(*)::int`.as('cnt')])
      .where('status', '=', 'active')
      .groupBy('plan_code')
      .execute(),
  ])
  const tMap = new Map(tenantCounts.map((r) => [r.plan_code, Number(r.cnt)]))
  const lMap = new Map(licenseCounts.map((r) => [r.plan_code, Number(r.cnt)]))

  return plans.map((p) => ({
    code: p.code,
    name: p.name,
    name_ta: p.name_ta,
    description: p.description,
    price_monthly_paise: Number(p.price_monthly_paise),
    price_yearly_paise: Number(p.price_yearly_paise),
    limits: readPlanLimits(p.limits),
    features: toFeatures(p.features),
    is_public: p.is_public,
    sort_order: p.sort_order,
    channel: p.code.startsWith('onprem_') ? 'onprem' : 'cloud',
    tenants_count: tMap.get(p.code) ?? 0,
    licenses_count: lMap.get(p.code) ?? 0,
    updated_at: iso(p.updated_at),
  }))
}

async function loadLicenseRow(
  db: Kysely<DB>,
  id: string,
  today: string,
): Promise<LicenseDetail | null> {
  const row = await db
    .selectFrom('licenses as l')
    .innerJoin('vendor_customers as c', 'c.id', 'l.customer_id')
    .innerJoin('license_products as lp', 'lp.code', 'l.product_code')
    .leftJoin('partners as p', 'p.id', 'l.partner_id')
    .leftJoin('users as u', 'u.id', 'l.issued_by')
    .select([
      'l.id',
      'l.key_prefix',
      'l.customer_id',
      'c.name as customer_name',
      'c.business_name',
      'c.phone as customer_phone',
      'l.partner_id',
      'p.name as partner_name',
      'l.product_code',
      'lp.name as product_name',
      'lp.name_ta as product_name_ta',
      'l.license_type',
      'l.plan_code',
      'l.status',
      'l.valid_from',
      'l.valid_until',
      'l.updates_until',
      'l.support_until',
      'l.grace_days',
      'l.max_activations',
      'l.addons',
      'l.features',
      'l.limits',
      'l.suspended_reason',
      'l.notes',
      'l.issued_by',
      'u.full_name as issued_by_name',
      'l.created_at',
      'l.updated_at',
    ])
    .where('l.id', '=', id)
    .executeTakeFirst()
  if (!row) return null

  const [planRow, activations, events] = await Promise.all([
    db
      .selectFrom('plans')
      .select(['features', 'limits'])
      .where('code', '=', row.plan_code)
      .executeTakeFirst(),
    db
      .selectFrom('license_activations')
      .selectAll()
      .where('license_id', '=', id)
      .orderBy('activated_at', 'desc')
      .execute(),
    db
      .selectFrom('license_events as e')
      .leftJoin('users as u', 'u.id', 'e.actor_user_id')
      .select([
        'e.id',
        'e.license_id',
        'e.activation_id',
        'e.kind',
        'e.actor_user_id',
        'u.full_name as actor_name',
        'e.details',
        'e.ip',
        'e.created_at',
      ])
      .where('e.license_id', '=', id)
      .orderBy('e.created_at', 'desc')
      .limit(50)
      .execute(),
  ])

  const parsedAddons = z.array(LicenseAddonSchema).safeParse(row.addons)
  const addons: LicenseAddon[] = parsedAddons.success ? parsedAddons.data : []
  const validFrom = dateStr(row.valid_from)
  const validUntil = dateStr(row.valid_until)
  const updatesUntil = dateStr(row.updates_until)
  const supportUntil = dateStr(row.support_until)
  const amc = amcStatus(updatesUntil, today)
  const term = licenseTermStatus(
    { valid_until: validUntil, grace_days: row.grace_days },
    today,
  )
  const activeActs = activations.filter((a) => a.status === 'active')
  const lastCheckIn = activeActs.reduce<Date | null>(
    (acc, a) =>
      a.last_check_in_at && (!acc || a.last_check_in_at > acc) ? a.last_check_in_at : acc,
    null,
  )

  const planFeatures = toFeatures(planRow?.features)
  const planLimits = readPlanLimits(planRow?.limits ?? {})
  const featuresOverride = row.features ? toFeatures(row.features) : null
  const limitsOverride =
    row.limits && typeof row.limits === 'object'
      ? (row.limits as Partial<typeof planLimits>)
      : {}

  const effectiveFeatures = licenseEffectiveFeatures(
    featuresOverride ?? planFeatures,
    addons,
    today,
  )
  const effectiveLimits = licenseEffectiveLimits(
    planLimits,
    limitsOverride,
    addons,
    today,
  )

  return {
    id: row.id,
    key_prefix: row.key_prefix,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    business_name: row.business_name,
    customer_phone: row.customer_phone,
    partner_id: row.partner_id,
    partner_name: row.partner_name,
    product_code: row.product_code,
    product_name: row.product_name,
    product_name_ta: row.product_name_ta,
    license_type: row.license_type as LicenseType,
    plan_code: row.plan_code,
    status: row.status as VendorLicenseStatus,
    valid_from: validFrom,
    valid_until: validUntil,
    updates_until: updatesUntil,
    support_until: supportUntil,
    grace_days: row.grace_days,
    max_activations: row.max_activations,
    active_activations: activeActs.length,
    amc,
    term,
    addons,
    last_check_in_at: iso(lastCheckIn),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    features_override: featuresOverride,
    limits_override: limitsOverride,
    effective_features: effectiveFeatures,
    effective_limits: effectiveLimits,
    suspended_reason: row.suspended_reason,
    notes: row.notes,
    issued_by: row.issued_by,
    issued_by_name: row.issued_by_name,
    transfers_last_365d: 0,
    transfers_left: 3,
    activations: activations.map((a) => ({
      id: a.id,
      license_id: a.license_id,
      key_prefix: row.key_prefix,
      customer_id: row.customer_id,
      business_name_customer: row.business_name,
      installation_id: a.installation_id,
      fingerprint_short: a.fingerprint_hash.slice(0, 12),
      machine_name: a.machine_name,
      os: a.os,
      app_version: a.app_version,
      last_version: a.last_version,
      business_name: a.business_name,
      method: a.method as 'online' | 'offline',
      status: a.status as 'active' | 'deactivated' | 'blocked',
      activated_at: iso(a.activated_at),
      last_check_in_at: iso(a.last_check_in_at),
      last_check_in_ip: a.last_check_in_ip,
      last_stats: {},
      connect_enabled: a.connect_enabled,
      cloud_backup_enabled: a.cloud_backup_enabled,
      stale: false,
      snapshot_generated_at: null,
      cloud_backup_used_bytes: 0,
      deactivated_at: iso(a.deactivated_at),
      deactivation_reason: a.deactivation_reason,
      created_at: iso(a.created_at),
      updated_at: iso(a.updated_at),
    })),
    events: events.map((e): LicenseEvent => ({
      id: Number(e.id),
      license_id: e.license_id,
      activation_id: e.activation_id,
      kind: e.kind as LicenseEventKind,
      actor_user_id: e.actor_user_id,
      actor_name: e.actor_name,
      details:
        e.details && typeof e.details === 'object' && !Array.isArray(e.details)
          ? (e.details as Record<string, unknown>)
          : {},
      ip: e.ip,
      created_at: iso(e.created_at),
    })),
    orders: [],
  }
}

function buildHandlers(app: FastifyInstance): RouteImpls<Routes> {
  const db = app.kadai.db.systemDb
  return {
    me: {
      handler: async (req) => {
        const staff = await requireStaff(db, req, null)
        const data: VendorMe = {
          user_id: staff.userId,
          full_name: staff.fullName,
          role: staff.role,
          partner_id: staff.partnerId,
          partner_name: staff.partnerName,
          capabilities: [...vendorCapabilitiesFor(staff.role)],
          vendor_state_code: DEFAULT_VENDOR_STATE_CODE,
        }
        return { data }
      },
    },

    metrics: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.dashboard')
        const now = new Date()
        const today = todayIn('Asia/Kolkata')
        const d30 = addDays(today, 30)
        const d60 = addDays(today, 60)
        const d90 = addDays(today, 90)

        const [
          tenantsByPlan,
          tenantsByStatus,
          tenantsByType,
          tenantsByState,
          subsRows,
          licensesRows,
          activationsRows,
          plansRows,
        ] = await Promise.all([
          db
            .selectFrom('tenants')
            .select(['plan_code as key', sql<number>`count(*)::int`.as('count')])
            .groupBy('plan_code')
            .execute(),
          db
            .selectFrom('tenants')
            .select(['status as key', sql<number>`count(*)::int`.as('count')])
            .groupBy('status')
            .execute(),
          db
            .selectFrom('tenants')
            .select(['business_type as key', sql<number>`count(*)::int`.as('count')])
            .groupBy('business_type')
            .execute(),
          db
            .selectFrom('tenants')
            .select(['state_code as key', sql<number>`count(*)::int`.as('count')])
            .groupBy('state_code')
            .execute(),
          db
            .selectFrom('subscriptions')
            .select(['plan_code', 'status', 'billing_cycle'])
            .where('status', 'in', ['active', 'trialing'])
            .execute(),
          db
            .selectFrom('licenses')
            .select(['id', 'product_code', 'license_type', 'status', 'updates_until'])
            .where('status', '=', 'active')
            .execute(),
          db
            .selectFrom('license_activations')
            .select(['id', 'last_version', 'last_check_in_at'])
            .where('status', '=', 'active')
            .execute(),
          db
            .selectFrom('plans')
            .select(['code', 'price_monthly_paise', 'price_yearly_paise'])
            .execute(),
        ])

        const planPriceMap = new Map(
          plansRows.map((p) => [
            p.code,
            {
              monthly: Number(p.price_monthly_paise),
              yearly: Math.round(Number(p.price_yearly_paise) / 12),
            },
          ]),
        )

        let mrrPaise = 0
        let payingTenants = 0
        let trialsActive = 0
        for (const s of subsRows) {
          if (s.status === 'trialing') {
            trialsActive++
          } else if (s.status === 'active' && s.plan_code !== 'free') {
            payingTenants++
            const price = planPriceMap.get(s.plan_code)
            if (price) {
              mrrPaise += s.billing_cycle === 'yearly' ? price.yearly : price.monthly
            }
          }
        }

        const tenantsTotal = tenantsByStatus.reduce((sum, r) => sum + Number(r.count), 0)
        const byEditionMap = new Map<string, number>()
        const byTypeMap = new Map<LicenseType, number>()
        let due30 = 0
        let due60 = 0
        let due90 = 0
        for (const l of licensesRows) {
          byEditionMap.set(l.product_code, (byEditionMap.get(l.product_code) ?? 0) + 1)
          const lt = l.license_type as LicenseType
          byTypeMap.set(lt, (byTypeMap.get(lt) ?? 0) + 1)
          const upd = dateStr(l.updates_until)
          if (upd && upd >= today) {
            if (upd <= d30) due30++
            if (upd <= d60) due60++
            if (upd <= d90) due90++
          }
        }

        const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000)
        let checkIns7d = 0
        const versionMap = new Map<string, number>()
        for (const a of activationsRows) {
          if (a.last_check_in_at && a.last_check_in_at >= sevenDaysAgo) checkIns7d++
          const v = a.last_version ?? '0.1.0'
          versionMap.set(v, (versionMap.get(v) ?? 0) + 1)
        }

        const metrics: VendorMetrics = {
          generated_at: iso(now),
          kpis: {
            mrr_paise: mrrPaise,
            license_revenue_this_month_paise: 0,
            active_licenses: licensesRows.length,
            amc_due_30d: due30,
            renewal_rate_bp: 8500,
            active_installs_7d: checkIns7d,
          },
          cloud: {
            tenants_total: tenantsTotal,
            paying_tenants: payingTenants,
            trials_active: trialsActive,
            by_plan: tenantsByPlan.map((r) => ({ key: r.key, count: Number(r.count) })),
            by_status: tenantsByStatus.map((r) => ({ key: r.key, count: Number(r.count) })),
            by_business_type: tenantsByType.map((r) => ({ key: r.key, count: Number(r.count) })),
            by_state: tenantsByState.map((r) => ({ key: r.key, count: Number(r.count) })),
            mrr_paise: mrrPaise,
            signups_90d: [],
            invoices_per_day: [],
          },
          onprem: {
            active_licenses: licensesRows.length,
            by_edition: [...byEditionMap.entries()].map(([key, count]) => ({ key, count })),
            by_type: [...byTypeMap.entries()].map(([key, count]) => ({ key, count })),
            activations_active: activationsRows.length,
            check_ins_7d: checkIns7d,
            version_adoption: [...versionMap.entries()].map(([version, count]) => ({
              version,
              count,
            })),
            renewals_due: {
              d30: { count: due30, value_paise: due30 * 250_000 },
              d60: { count: due60, value_paise: due60 * 250_000 },
              d90: { count: due90, value_paise: due90 * 250_000 },
            },
            renewal_rate_bp: 8500,
            top_districts: [],
          },
          revenue_by_month: [],
          partner_revenue: [],
          recent_orders: [],
        }
        return { data: metrics }
      },
    },

    listTenants: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.tenants.read')
        const q = req.query
        let rows = await loadTenantAdminRows(db)
        if (q.q) {
          const needle = q.q.toLowerCase()
          rows = rows.filter(
            (r) =>
              r.name.toLowerCase().includes(needle) ||
              (r.name_ta?.toLowerCase().includes(needle) ?? false) ||
              (r.owner_phone?.includes(needle) ?? false) ||
              (r.owner_name?.toLowerCase().includes(needle) ?? false),
          )
        }
        if (q.plan_code) rows = rows.filter((r) => r.plan_code === q.plan_code)
        if (q.status) rows = rows.filter((r) => r.status === q.status)
        if (q.subscription_status)
          rows = rows.filter((r) => r.subscription_status === q.subscription_status)
        if (q.business_type) rows = rows.filter((r) => r.business_type === q.business_type)
        if (q.state_code) rows = rows.filter((r) => r.state_code === q.state_code)

        const dir = q.sort.direction === 'asc' ? 1 : -1
        rows.sort((a, b) => {
          let cmp = 0
          if (q.sort.field === 'name') {
            cmp = a.name.localeCompare(b.name, 'en')
          } else if (q.sort.field === 'invoices_this_month') {
            cmp = a.usage.invoices_this_month - b.usage.invoices_this_month
          } else {
            cmp = a.created_at.localeCompare(b.created_at)
          }
          return cmp !== 0 ? cmp * dir : a.id.localeCompare(b.id)
        })
        const page = rows.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: rows.length } }
      },
    },

    getTenant: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.tenants.read')
        return { data: await loadTenantDetail(db, req.params.id) }
      },
    },

    suspendTenant: {
      handler: async (req) => {
        const staff = await requireStaff(db, req, 'vendor.tenants.manage')
        const id = req.params.id
        const existing = await db
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst()
        if (!existing) throw notFound('tenant', id)
        await db
          .updateTable('tenants')
          .set({
            status: 'suspended',
            suspended_reason: req.body.reason,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute()
        await writePlatformAudit(db, {
          actorUserId: staff.userId,
          tenantId: id,
          action: 'tenant.suspend',
          details: { reason: req.body.reason },
          req,
        })
        await app.kadai.entitlements.invalidate(id)
        return { data: await loadTenantDetail(db, id) }
      },
    },

    resumeTenant: {
      handler: async (req) => {
        const staff = await requireStaff(db, req, 'vendor.tenants.manage')
        const id = req.params.id
        const existing = await db
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst()
        if (!existing) throw notFound('tenant', id)
        await db
          .updateTable('tenants')
          .set({
            status: 'active',
            suspended_reason: null,
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .execute()
        await writePlatformAudit(db, {
          actorUserId: staff.userId,
          tenantId: id,
          action: 'tenant.resume',
          details: { reason: req.body.reason ?? null },
          req,
        })
        await app.kadai.entitlements.invalidate(id)
        return { data: await loadTenantDetail(db, id) }
      },
    },

    changeTenantPlan: {
      handler: async (req) => {
        const staff = await requireStaff(db, req, 'vendor.tenants.manage')
        const id = req.params.id
        const body = req.body
        const [tenant, plan] = await Promise.all([
          db.selectFrom('tenants').select('id').where('id', '=', id).executeTakeFirst(),
          db
            .selectFrom('plans')
            .select('code')
            .where('code', '=', body.plan_code)
            .executeTakeFirst(),
        ])
        if (!tenant) throw notFound('tenant', id)
        if (!plan) throw notFound('plan', body.plan_code)

        const now = new Date()
        const periodEnd = body.period_end
          ? new Date(body.period_end)
          : new Date(now.getTime() + 365 * 86_400_000)

        await db
          .updateTable('tenants')
          .set({ plan_code: body.plan_code, updated_at: now })
          .where('id', '=', id)
          .execute()

        const existingSub = await db
          .selectFrom('subscriptions')
          .select('id')
          .where('tenant_id', '=', id)
          .orderBy('created_at', 'desc')
          .executeTakeFirst()

        if (existingSub) {
          await db
            .updateTable('subscriptions')
            .set({
              plan_code: body.plan_code,
              status: 'active',
              billing_cycle: body.billing_cycle ?? 'yearly',
              current_period_end: periodEnd,
              limit_overrides: jsonb(body.limit_overrides ?? {}),
              provider: 'manual',
              updated_at: now,
            })
            .where('id', '=', existingSub.id)
            .execute()
        } else {
          await db
            .insertInto('subscriptions')
            .values({
              id: newId(),
              tenant_id: id,
              plan_code: body.plan_code,
              status: 'active',
              billing_cycle: body.billing_cycle ?? 'yearly',
              current_period_start: now,
              current_period_end: periodEnd,
              limit_overrides: jsonb(body.limit_overrides ?? {}),
              provider: 'manual',
            })
            .execute()
        }

        await writePlatformAudit(db, {
          actorUserId: staff.userId,
          tenantId: id,
          action: 'tenant.change_plan',
          details: {
            plan_code: body.plan_code,
            limit_overrides: body.limit_overrides,
            reason: body.reason,
          },
          req,
        })
        await app.kadai.entitlements.invalidate(id)
        return { data: await loadTenantDetail(db, id) }
      },
    },

    listPlans: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.tenants.read')
        return { data: await loadPlansAdmin(db) }
      },
    },

    updatePlan: {
      handler: async (req) => {
        const staff = await requireStaff(db, req, 'vendor.plans.write')
        const code = req.params.code
        const body = req.body
        const existing = await db
          .selectFrom('plans')
          .select('code')
          .where('code', '=', code)
          .executeTakeFirst()
        if (!existing) throw notFound('plan', code)

        await db
          .updateTable('plans')
          .set({
            name: body.name,
            name_ta: body.name_ta ?? null,
            description: body.description ?? null,
            price_monthly_paise: body.price_monthly_paise,
            price_yearly_paise: body.price_yearly_paise,
            limits: jsonb(body.limits),
            features: body.features,
            is_public: body.is_public,
            sort_order: body.sort_order,
            updated_at: new Date(),
          })
          .where('code', '=', code)
          .execute()

        await writePlatformAudit(db, {
          actorUserId: staff.userId,
          action: 'plan.update',
          details: { code, name: body.name },
          req,
        })
        await app.kadai.entitlements.invalidate()
        const all = await loadPlansAdmin(db)
        const updated = all.find((p) => p.code === code)
        if (!updated) throw notFound('plan', code)
        return { data: updated }
      },
    },

    listLicenses: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.licenses.read')
        const q = req.query
        const today = todayIn('Asia/Kolkata')
        const idsRows = await db
          .selectFrom('licenses')
          .select('id')
          .orderBy('created_at', 'desc')
          .execute()
        const loaded = (
          await Promise.all(idsRows.map((r) => loadLicenseRow(db, r.id, today)))
        ).filter((x): x is LicenseDetail => x !== null)

        let items: LicenseRow[] = loaded
        if (q.q) {
          const needle = q.q.toLowerCase()
          items = items.filter(
            (l) =>
              l.key_prefix.toLowerCase().includes(needle) ||
              l.business_name.toLowerCase().includes(needle) ||
              l.customer_phone.includes(needle),
          )
        }
        if (q.status) items = items.filter((l) => l.status === q.status)
        if (q.product_code) items = items.filter((l) => l.product_code === q.product_code)
        if (q.license_type) items = items.filter((l) => l.license_type === q.license_type)
        if (q.customer_id) items = items.filter((l) => l.customer_id === q.customer_id)

        const page = items.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: items.length } }
      },
    },

    getLicense: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.licenses.read')
        const today = todayIn('Asia/Kolkata')
        const detail = await loadLicenseRow(db, req.params.id, today)
        if (!detail) throw notFound('license', req.params.id)
        return { data: detail }
      },
    },

    issueLicense: {
      handler: async (req) => {
        const staff = await requireStaff(db, req, 'vendor.licenses.issue')
        const body = req.body
        const today = todayIn('Asia/Kolkata')
        const [customer, product] = await Promise.all([
          db
            .selectFrom('vendor_customers')
            .select(['id', 'partner_id'])
            .where('id', '=', body.customer_id)
            .executeTakeFirst(),
          db
            .selectFrom('license_products')
            .select(['code', 'plan_code', 'included_amc_months', 'term_months'])
            .where('code', '=', body.product_code)
            .executeTakeFirst(),
        ])
        if (!customer) throw notFound('vendor_customer', body.customer_id)
        if (!product || !product.plan_code) throw notFound('license_product', body.product_code)

        const key = generateLicenseKey()
        const prefix = licenseKeyPrefix(key)
        const keyHash = sha256Hex(key)
        const validFrom = body.valid_from ?? today
        const amcMonths = product.included_amc_months || 12
        const updatesUntil =
          body.updates_until !== undefined
            ? body.updates_until
            : termEndDate(validFrom, amcMonths)
        const supportUntil =
          body.support_until !== undefined ? body.support_until : updatesUntil
        const id = newId()

        await db
          .insertInto('licenses')
          .values({
            id,
            key_prefix: prefix,
            key_hash: keyHash,
            customer_id: customer.id,
            partner_id: customer.partner_id,
            product_code: product.code,
            license_type: body.license_type,
            plan_code: product.plan_code,
            status: 'active',
            valid_from: validFrom,
            valid_until: body.valid_until ?? null,
            updates_until: updatesUntil ?? null,
            support_until: supportUntil ?? null,
            grace_days: body.grace_days,
            check_in_days: body.check_in_days,
            max_activations: body.max_activations,
            addons: jsonb([]),
            features: body.features_override,
            limits: jsonb(body.limits_override),
            notes: body.notes ?? null,
            issued_by: staff.userId,
          })
          .execute()

        await db
          .insertInto('license_events')
          .values({
            license_id: id,
            kind: 'issued',
            actor_user_id: staff.userId,
            details: jsonb({ product_code: product.code, license_type: body.license_type }),
            ip: req.ip,
          })
          .execute()

        await writePlatformAudit(db, {
          actorUserId: staff.userId,
          action: 'license.issue',
          details: { license_id: id, key_prefix: prefix, customer_id: customer.id },
          req,
        })

        const detail = await loadLicenseRow(db, id, today)
        if (!detail) throw notFound('license', id)
        return {
          data: {
            license: detail,
            license_key: key,
            delivered_via: [],
            whatsapp_url: null,
          },
        }
      },
    },

    listCustomers: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.customers.read')
        const q = req.query
        const rows = await db
          .selectFrom('vendor_customers as c')
          .leftJoin('partners as p', 'p.id', 'c.partner_id')
          .select([
            'c.id',
            'c.name',
            'c.business_name',
            'c.business_name_ta',
            'c.business_type',
            'c.phone',
            'c.email',
            'c.gstin',
            'c.state_code',
            'c.district',
            'c.address',
            'c.partner_id',
            'p.name as partner_name',
            'c.tenant_id',
            'c.referred_by_customer_id',
            'c.referral_code',
            'c.tags',
            'c.notes',
            'c.created_by',
            'c.created_at',
            'c.updated_at',
          ])
          .orderBy('c.business_name')
          .execute()

        let items: VendorCustomerRow[] = rows.map((r) => {
          const addr = AddressSchema.safeParse(r.address ?? {})
          return {
            id: r.id,
            name: r.name,
            business_name: r.business_name,
            business_name_ta: r.business_name_ta,
            business_type: r.business_type as BusinessType,
            phone: r.phone,
            email: r.email,
            gstin: r.gstin,
            state_code: r.state_code,
            district: r.district,
            address: addr.success
              ? addr.data
              : {
                  line1: undefined,
                  line2: undefined,
                  city: undefined,
                  district: undefined,
                  pincode: undefined,
                  state_code: r.state_code,
                },
            partner_id: r.partner_id,
            partner_name: r.partner_name,
            tenant_id: r.tenant_id,
            referred_by_customer_id: r.referred_by_customer_id,
            referral_code: r.referral_code,
            tags: r.tags ?? [],
            notes: r.notes,
            created_by: r.created_by,
            created_at: iso(r.created_at),
            updated_at: iso(r.updated_at),
            active_licenses: 0,
            active_activations: 0,
            next_due_on: null,
            amc: null,
            last_check_in_at: null,
          }
        })

        if (q.q) {
          const needle = q.q.toLowerCase()
          items = items.filter(
            (c) =>
              c.business_name.toLowerCase().includes(needle) ||
              c.name.toLowerCase().includes(needle) ||
              c.phone.includes(needle),
          )
        }
        const page = items.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: items.length } }
      },
    },

    listProducts: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.products.read')
        const q = req.query
        const rows = await db
          .selectFrom('license_products')
          .selectAll()
          .orderBy('sort_order')
          .orderBy('code')
          .execute()
        const items = rows.map((p) => ({
          code: p.code,
          kind: p.kind as 'edition' | 'subscription' | 'amc' | 'addon' | 'cloud_plan',
          channel: p.channel as 'onprem' | 'cloud' | 'both',
          name: p.name,
          name_ta: p.name_ta,
          description: p.description,
          description_ta: p.description_ta,
          plan_code: p.plan_code,
          price_paise: Number(p.price_paise),
          price_incl_gst_paise: priceWithGst(Number(p.price_paise), p.gst_rate_bp),
          term_months: p.term_months,
          included_amc_months: p.included_amc_months,
          renewal_price_paise:
            p.renewal_price_paise !== null ? Number(p.renewal_price_paise) : null,
          limits: {},
          features: toFeatures(p.features),
          hsn_sac: p.hsn_sac,
          gst_rate_bp: p.gst_rate_bp,
          is_active: p.is_active,
          sort_order: p.sort_order,
          created_at: iso(p.created_at),
          updated_at: iso(p.updated_at),
        }))
        const page = items.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: items.length } }
      },
    },

    listAuditLogs: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.audit.read')
        const q = req.query
        let qb = db
          .selectFrom('platform_audit_logs as a')
          .leftJoin('users as u', 'u.id', 'a.actor_user_id')
          .leftJoin('tenants as t', 't.id', 'a.tenant_id')
          .select([
            'a.id',
            'a.actor_user_id',
            'u.full_name as actor_name',
            'a.tenant_id',
            't.name as tenant_name',
            'a.action',
            'a.details',
            'a.ip',
            'a.request_id',
            'a.created_at',
          ])
        if (q.action) qb = qb.where('a.action', 'like', `${q.action}%`)
        if (q.tenant_id) qb = qb.where('a.tenant_id', '=', q.tenant_id)
        const rows = await qb.orderBy('a.created_at', 'desc').execute()
        const items: PlatformAuditLog[] = rows.map((a) => ({
          id: Number(a.id),
          actor_user_id: a.actor_user_id,
          actor_name: a.actor_name,
          tenant_id: a.tenant_id,
          tenant_name: a.tenant_name,
          action: a.action,
          details:
            a.details && typeof a.details === 'object' && !Array.isArray(a.details)
              ? (a.details as Record<string, unknown>)
              : {},
          ip: a.ip,
          request_id: a.request_id,
          created_at: iso(a.created_at),
        }))
        const page = items.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: items.length } }
      },
    },

    listStaff: {
      handler: async (req) => {
        await requireStaff(db, req, 'vendor.staff.manage')
        const q = req.query
        const rows = await db
          .selectFrom('platform_staff as ps')
          .innerJoin('users as u', 'u.id', 'ps.user_id')
          .leftJoin('partners as p', 'p.id', 'ps.partner_id')
          .select([
            'ps.user_id',
            'u.full_name',
            'u.phone',
            'u.email',
            'ps.role',
            'ps.partner_id',
            'p.name as partner_name',
            'ps.is_active',
            'u.last_login_at',
            'ps.created_by',
            'ps.created_at',
            'ps.updated_at',
          ])
          .orderBy('u.full_name')
          .execute()
        const items: StaffMember[] = rows.map((r) => ({
          user_id: r.user_id,
          full_name: r.full_name,
          phone: r.phone,
          email: r.email,
          role: r.role as PlatformStaffRole,
          partner_id: r.partner_id,
          partner_name: r.partner_name,
          is_active: r.is_active,
          last_login_at: iso(r.last_login_at),
          created_by: r.created_by,
          created_at: iso(r.created_at),
          updated_at: iso(r.updated_at),
        }))
        const page = items.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: items.length } }
      },
    },
  }
}

export const licensingModule = defineModule({
  name: 'licensing',
  routes: async (app) => {
    registerRoutes(app, licensingRoutes, buildHandlers(app), {
      extras: () => ({ config: { auth: 'user' } }),
    })
  },
})
