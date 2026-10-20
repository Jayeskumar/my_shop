/**
 * Tenant onboarding (ARCHITECTURE.md §8.5, §13): one SYSTEM transaction creates a ready-to-bill
 * business —
 *
 *   tenant (business type, GST scheme, state, GSTIN) with the vertical's settings preset
 *   → system roles (ROLE_PRESETS) → owner user (new, or an existing identity linked by its
 *   password / a verified OTP) → owner membership → store S1 → register A
 *   → system chart of accounts (DEFAULT_CHART) → vertical tax-slab rules + category tree
 *   → cloud: 14-day Valarchi (growth) trial subscription · on-prem: none (license)
 *
 *   const created = await createTenant(deps.db.systemDb, { business_name, business_type, … })
 *
 * The transaction sets app.tenant_id / app.user_id like a tenant transaction, so anything that
 * reads the session context sees the new tenant. systemDb is required: the tenant does not exist
 * yet (RLS would hide every row) and users are global identities.
 */
import { type Kysely, sql } from 'kysely'
import type { Address } from '@kadai/shared/api/common'
import {
  type BusinessType,
  DEFAULT_CHART,
  type DeploymentMode,
  type GstScheme,
  type Locale,
  ROLE_PRESETS,
  SYSTEM_ROLE_CODES,
  type SystemRoleCode,
  type TenantSettingsPatch,
  VERTICAL_PRESETS,
  flattenCategoryPresets,
  initialSettingsFor,
  isValidGstin,
  isValidStateCode,
  mergeSettings,
  newId,
  normalizeIndianPhone,
  panFromGstin,
} from '@kadai/shared'
import type { DB } from '../db/schema.generated'
import { type Tx, withSystemTx } from '../db/tenant'
import { jsonb } from '../db/json'
import { audit } from './audit'
import { AppError, duplicate, forbidden, invalidField, validationError } from './errors'
import { assertPasswordPolicy, hashPassword, hashPin, verifyPassword } from './passwords'

/** Trial granted to new cloud signups (PRODUCT.md: 14 days of Valarchi). */
export const SIGNUP_TRIAL = { plan_code: 'growth', days: 14 } as const
/** Base plan of a tenant (the trial falls back to it). */
export const BASE_PLAN_CODE = 'free'
/** A second signup by the same owner with the same business name within this window is a duplicate. */
const DUPLICATE_WINDOW_MS = 15 * 60_000

export interface CreateTenantInput {
  business_name: string
  business_name_ta?: string | null
  legal_name?: string | null
  business_type: BusinessType
  /** Defaults to 'regular' with a GSTIN, else 'unregistered'. */
  gst_scheme?: GstScheme
  gstin?: string | null
  state_code: string
  address?: Address
  /** Business default locale (also the owner's preferred locale for a new user). */
  locale?: Locale
  owner: {
    full_name: string
    /** Indian mobile (10 digits or E.164). */
    phone: string
    email?: string | null
    /** Required for a new user unless `phone_verified`; verifies an existing user otherwise. */
    password?: string | null
    /** Optional POS PIN for the owner membership. */
    pin?: string | null
  }
  /** The phone was proven by OTP: an existing user with it is linked without a password. */
  phone_verified?: boolean
  /** Name of store S1 (default: the business name). */
  store_name?: string | null
  /** cloud creates the trial subscription; onprem relies on the license. */
  mode: DeploymentMode
  /** Cloud trial (default SIGNUP_TRIAL); null = no subscription (tenant stays on the base plan). */
  trial?: { plan_code: string; days: number } | null
  /** Extra settings applied on top of the vertical preset. */
  settings?: TenantSettingsPatch
  /** Request metadata for the audit row. */
  meta?: { ip?: string; userAgent?: string; requestId?: string }
}

export interface CreatedTenant {
  tenant: {
    id: string
    name: string
    business_type: BusinessType
    gst_scheme: GstScheme
    gstin: string | null
    state_code: string
    plan_code: string
    default_locale: Locale
  }
  user: { id: string; phone: string; email: string | null; full_name: string; created: boolean }
  membership: { id: string; role_id: string; role_code: 'owner' }
  store: { id: string; code: string; name: string; state_code: string }
  register: { id: string; code: string; name: string; store_id: string }
  /** System role ids by code. */
  roles: Record<SystemRoleCode, string>
  subscription: { id: string; plan_code: string; status: 'trialing'; trial_ends_at: Date } | null
}

function trimmed(value: string | null | undefined, max: number): string | null {
  const t = value?.trim()
  return t ? t.slice(0, max) : null
}

interface ValidatedInput {
  name: string
  nameTa: string | null
  legalName: string | null
  gstScheme: GstScheme
  gstin: string | null
  phone: string
  email: string | null
  ownerName: string
  locale: Locale
}

/** Validates the invariants once more (callers validate with zod; CLI/tests call directly). */
function validateInput(input: CreateTenantInput): ValidatedInput {
  const issues: Array<{ path: string; message: string }> = []
  const name = trimmed(input.business_name, 200)
  if (!name) issues.push({ path: 'business_name', message: 'Business name is required' })
  if (!VERTICAL_PRESETS[input.business_type]) {
    issues.push({ path: 'business_type', message: 'Unknown business type' })
  }
  if (!isValidStateCode(input.state_code)) {
    issues.push({ path: 'state_code', message: 'Unknown GST state code' })
  }
  const gstin = trimmed(input.gstin, 15)?.toUpperCase() ?? null
  const gstScheme: GstScheme = input.gst_scheme ?? (gstin ? 'regular' : 'unregistered')
  if (gstin) {
    if (!isValidGstin(gstin)) issues.push({ path: 'gstin', message: 'Invalid GSTIN' })
    else if (gstin.slice(0, 2) !== input.state_code) {
      issues.push({ path: 'gstin', message: 'GSTIN state code does not match the selected state' })
    }
    if (gstScheme === 'unregistered') {
      issues.push({ path: 'gst_scheme', message: 'An unregistered business cannot have a GSTIN' })
    }
  } else if (gstScheme !== 'unregistered') {
    issues.push({ path: 'gstin', message: 'GSTIN is required for registered businesses' })
  }
  const phone = normalizeIndianPhone(input.owner.phone)
  if (!phone) issues.push({ path: 'phone', message: 'Enter a valid 10-digit Indian mobile number' })
  const ownerName = trimmed(input.owner.full_name, 120)
  if (!ownerName) issues.push({ path: 'owner_name', message: 'Owner name is required' })
  const email = trimmed(input.owner.email, 254)?.toLowerCase() ?? null
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    issues.push({ path: 'email', message: 'Invalid email address' })
  }
  if (issues.length) throw validationError(issues, issues[0]!.message)
  return {
    name: name!,
    nameTa: trimmed(input.business_name_ta, 200),
    legalName: trimmed(input.legal_name, 200),
    gstScheme,
    gstin,
    phone: phone!,
    email,
    ownerName: ownerName!,
    locale: input.locale ?? 'ta',
  }
}

/** createTenant inside an existing SYSTEM transaction (e.g. on-prem setup records completion). */
export async function createTenantTx(tx: Tx, input: CreateTenantInput): Promise<CreatedTenant> {
  const v = validateInput(input)
  const now = new Date()
  const tenantId = newId()

  // Serialise signups for the same phone so the user lookup below cannot be raced.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`kadai_signup:${v.phone}`}, 0))`.execute(tx)
  await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx)

  // ---- owner identity ------------------------------------------------------------------------
  const existing = await tx
    .selectFrom('users')
    .select(['id', 'phone', 'email', 'full_name', 'password_hash', 'status'])
    .where('phone', '=', v.phone)
    .executeTakeFirst()
  let user: CreatedTenant['user']
  if (existing) {
    if (existing.status !== 'active') {
      throw forbidden('This mobile number belongs to a disabled account', { field: 'phone' })
    }
    const proven =
      input.phone_verified === true ||
      (Boolean(input.owner.password) &&
        Boolean(existing.password_hash) &&
        (await verifyPassword(existing.password_hash!, input.owner.password!)))
    if (!proven) {
      throw duplicate(
        'This mobile number is already registered. Sign in with your password, or verify the number by OTP to add a new business.',
        { field: 'phone', reason: 'phone_registered' },
      )
    }
    // Double-submitted signup: same owner, same business name, moments ago.
    const recent = await tx
      .selectFrom('memberships as m')
      .innerJoin('tenants as t', 't.id', 'm.tenant_id')
      .innerJoin('roles as r', (j) => j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'))
      .select(['t.id'])
      .where('m.user_id', '=', existing.id)
      .where('r.code', '=', 'owner')
      .where(sql<boolean>`lower(t.name) = lower(${v.name})`)
      .where('t.created_at', '>', new Date(now.getTime() - DUPLICATE_WINDOW_MS))
      .executeTakeFirst()
    if (recent) {
      throw duplicate('This business was just created; sign in to continue', {
        reason: 'duplicate_signup',
        tenant_id: recent.id,
      })
    }
    user = {
      id: existing.id,
      phone: v.phone,
      email: existing.email,
      full_name: existing.full_name,
      created: false,
    }
  } else {
    if (v.email) {
      const taken = await tx.selectFrom('users').select('id').where('email', '=', v.email).executeTakeFirst()
      if (taken) {
        throw duplicate('This email is already used by another account', {
          field: 'email',
          reason: 'email_registered',
        })
      }
    }
    const password = input.owner.password ?? null
    if (!password && !input.phone_verified) {
      throw invalidField('password', 'A password is required')
    }
    if (password) assertPasswordPolicy(password, { phone: v.phone, email: v.email, name: v.ownerName })
    const userId = newId()
    await tx
      .insertInto('users')
      .values({
        id: userId,
        phone: v.phone,
        email: v.email,
        full_name: v.ownerName,
        password_hash: password ? await hashPassword(password) : null,
        password_changed_at: password ? now : null,
        preferred_locale: v.locale,
      })
      .execute()
    user = { id: userId, phone: v.phone, email: v.email, full_name: v.ownerName, created: true }
  }
  await sql`select set_config('app.user_id', ${user.id}, true)`.execute(tx)

  // ---- tenant ------------------------------------------------------------------------------
  const settings = input.settings
    ? mergeSettings(initialSettingsFor(input.business_type), input.settings)
    : initialSettingsFor(input.business_type)
  const address = input.address ?? {}
  await tx
    .insertInto('tenants')
    .values({
      id: tenantId,
      name: v.name,
      name_ta: v.nameTa,
      legal_name: v.legalName,
      business_type: input.business_type,
      gst_scheme: v.gstScheme,
      gstin: v.gstin,
      pan: v.gstin && v.gstScheme !== 'unregistered' ? panFromGstin(v.gstin) : null,
      state_code: input.state_code,
      phone: v.phone,
      email: v.email,
      address: jsonb(address),
      default_locale: v.locale,
      timezone: 'Asia/Kolkata',
      fy_start_month: 4,
      settings: jsonb(settings),
      plan_code: BASE_PLAN_CODE,
      status: 'active',
    })
    .execute()

  // ---- roles & owner membership ----------------------------------------------------------------
  const roles = {} as Record<SystemRoleCode, string>
  await tx
    .insertInto('roles')
    .values(
      SYSTEM_ROLE_CODES.map((code) => {
        const preset = ROLE_PRESETS[code]
        roles[code] = newId()
        return {
          id: roles[code],
          tenant_id: tenantId,
          code,
          name: preset.name_en,
          name_ta: preset.name_ta,
          description: preset.description,
          // The owner holds every permission, including ones added in later versions.
          permissions: code === 'owner' ? ['*'] : [...preset.permissions],
          is_system: true,
        }
      }),
    )
    .execute()
  const membershipId = newId()
  await tx
    .insertInto('memberships')
    .values({
      id: membershipId,
      tenant_id: tenantId,
      user_id: user.id,
      role_id: roles.owner,
      store_ids: null,
      status: 'active',
      pos_pin_hash: input.owner.pin ? await hashPin(input.owner.pin) : null,
    })
    .execute()

  // ---- store S1 & register A ------------------------------------------------------------------
  const storeId = newId()
  const storeName = trimmed(input.store_name, 200) ?? v.name
  await tx
    .insertInto('stores')
    .values({
      id: storeId,
      tenant_id: tenantId,
      code: 'S1',
      name: storeName,
      name_ta: v.nameTa,
      gstin: v.gstin,
      state_code: input.state_code,
      address: jsonb(address),
      phone: v.phone,
      email: v.email,
    })
    .execute()
  const registerId = newId()
  await tx
    .insertInto('registers')
    .values({ id: registerId, tenant_id: tenantId, store_id: storeId, code: 'A', name: 'Counter A' })
    .execute()

  // ---- chart of accounts -------------------------------------------------------------------
  await tx
    .insertInto('accounts')
    .values(
      DEFAULT_CHART.map((a) => ({
        id: newId(),
        tenant_id: tenantId,
        code: a.code,
        name: a.name,
        name_ta: a.name_ta,
        type: a.type,
        subtype: a.subtype,
        is_system: true,
      })),
    )
    .execute()

  // ---- vertical presets: price-slab GST rules and the category tree ---------------------------
  const preset = VERTICAL_PRESETS[input.business_type]
  const ruleIds = new Map<string, string>()
  if (preset.tax_slab_rules.length) {
    await tx
      .insertInto('tax_slab_rules')
      .values(
        preset.tax_slab_rules.map((r) => {
          const id = newId()
          ruleIds.set(r.key, id)
          return {
            id,
            tenant_id: tenantId,
            name: r.name,
            description: r.description,
            slabs: jsonb(r.slabs),
          }
        }),
      )
      .execute()
  }
  const flat = flattenCategoryPresets(preset.categories)
  if (flat.length) {
    const ids = new Map<string, string>(flat.map((c) => [c.name, newId()]))
    // FK checks run at the end of the statement, so parents and children go in one insert.
    await tx
      .insertInto('categories')
      .values(
        flat.map((c) => ({
          id: ids.get(c.name)!,
          tenant_id: tenantId,
          parent_id: c.parent_name ? (ids.get(c.parent_name) ?? null) : null,
          name: c.name,
          name_ta: c.name_ta,
          hsn_code: c.hsn_code ?? null,
          gst_rate_bp: c.gst_rate_bp ?? null,
          tax_slab_rule_id: c.tax_slab_rule ? (ruleIds.get(c.tax_slab_rule) ?? null) : null,
          sort_order: c.sort_order,
        })),
      )
      .execute()
  }

  // ---- subscription (cloud trial) ---------------------------------------------------------------
  let subscription: CreatedTenant['subscription'] = null
  const trial = input.mode === 'cloud' ? (input.trial === undefined ? SIGNUP_TRIAL : input.trial) : null
  if (trial) {
    const plan = await tx.selectFrom('plans').select('code').where('code', '=', trial.plan_code).executeTakeFirst()
    if (!plan) throw new AppError('INTERNAL', `Trial plan "${trial.plan_code}" does not exist`)
    const ends = new Date(now.getTime() + trial.days * 86_400_000)
    const id = newId()
    await tx
      .insertInto('subscriptions')
      .values({
        id,
        tenant_id: tenantId,
        plan_code: trial.plan_code,
        status: 'trialing',
        billing_cycle: 'monthly',
        current_period_start: now,
        current_period_end: ends,
        trial_ends_at: ends,
        provider: null,
      })
      .execute()
    subscription = { id, plan_code: trial.plan_code, status: 'trialing', trial_ends_at: ends }
  }

  await audit(
    tx,
    {
      tenantId,
      userId: user.id,
      ip: input.meta?.ip ?? '',
      userAgent: input.meta?.userAgent ?? '',
      requestId: input.meta?.requestId ?? `onboarding:${tenantId}`,
    },
    {
      action: 'tenant.create',
      entity_type: 'tenant',
      entity_id: tenantId,
      summary: `Business "${v.name}" created (${input.business_type})`,
      changes: {
        business_type: input.business_type,
        gst_scheme: v.gstScheme,
        state_code: input.state_code,
        owner_user_id: user.id,
        owner_created: user.created,
        trial: subscription ? { plan_code: subscription.plan_code, ends_at: subscription.trial_ends_at } : null,
      },
    },
  )

  return {
    tenant: {
      id: tenantId,
      name: v.name,
      business_type: input.business_type,
      gst_scheme: v.gstScheme,
      gstin: v.gstin,
      state_code: input.state_code,
      plan_code: BASE_PLAN_CODE,
      default_locale: v.locale,
    },
    user,
    membership: { id: membershipId, role_id: roles.owner, role_code: 'owner' },
    store: { id: storeId, code: 'S1', name: storeName, state_code: input.state_code },
    register: { id: registerId, code: 'A', name: 'Counter A', store_id: storeId },
    roles,
    subscription,
  }
}

/** Creates a tenant with everything it needs to start billing, in one system transaction. */
export function createTenant(systemDb: Kysely<DB>, input: CreateTenantInput): Promise<CreatedTenant> {
  return withSystemTx(systemDb, (tx) => createTenantTx(tx, input))
}
