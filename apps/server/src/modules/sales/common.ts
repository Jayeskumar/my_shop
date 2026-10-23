/**
 * Internal helpers of the sales module: master-data loaders (tenant, store, register, customer,
 * open shift), lenient JSON readers and the issue → error mapping shared by every sales flow.
 */
import {
  type Feature,
  type GstScheme,
  type Permission,
  type TenantSettings,
  hasPermission,
  todayIn,
} from '@kadai/shared'
import { AddressSchema, type Address } from '@kadai/shared/api/common'
import {
  type SalesBlockingIssueCode,
  type SalesIssue,
  isBlockingSalesIssue,
  salesIssueErrorCode,
} from '@kadai/shared/api/sales'
import type { Tx } from '../../db/tenant'
import type { RequestContext } from '../../core/context'
import { getEntitlements } from '../../core/entitlements'
import { AppError, notFound, unprocessable } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { tenantCalendar } from '../../core/numbering'
import { getSettings } from '../../core/settings'

export type SalesCtx = RequestContext

// ---------------------------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>

export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A stored jsonb object (anything else → {}). */
export function recordOf(v: unknown): JsonRecord {
  return isRecord(v) ? v : {}
}

/** Stored address jsonb → Address (invalid fields dropped), null when empty. */
export function addressOf(v: unknown): Address | null {
  if (!isRecord(v)) return null
  const parsed = AddressSchema.safeParse(v)
  if (parsed.success) {
    const a = parsed.data
    return Object.values(a).some((x) => x !== undefined && x !== '') ? a : null
  }
  // Keep the valid fields one by one.
  const out: JsonRecord = {}
  for (const [k, value] of Object.entries(v)) {
    const one = AddressSchema.safeParse({ [k]: value })
    if (one.success && (one.data as JsonRecord)[k] !== undefined) {
      out[k] = (one.data as JsonRecord)[k]
    }
  }
  return Object.keys(out).length ? (out as Address) : null
}

export function stringRecordOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(recordOf(v))) {
    if (typeof x === 'string') out[k] = x
    else if (typeof x === 'number' || typeof x === 'boolean') out[k] = String(x)
  }
  return out
}

export function intOf(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : fallback
}

// ---------------------------------------------------------------------------------------------
// Tenant, settings, entitlements
// ---------------------------------------------------------------------------------------------

export interface TenantInfo {
  id: string
  name: string
  name_ta: string | null
  legal_name: string | null
  business_type: string
  gst_scheme: GstScheme
  gstin: string | null
  pan: string | null
  state_code: string
  phone: string | null
  email: string | null
  address: unknown
  logo_file_id: string | null
  default_locale: 'ta' | 'en'
  timezone: string
  fy_start_month: number
}

const tenantMemo = new WeakMap<Tx, TenantInfo>()

export async function loadTenant(tx: Tx, ctx: Pick<SalesCtx, 'tenantId'>): Promise<TenantInfo> {
  const hit = tenantMemo.get(tx)
  if (hit) return hit
  const row = await tx
    .selectFrom('tenants')
    .select([
      'id',
      'name',
      'name_ta',
      'legal_name',
      'business_type',
      'gst_scheme',
      'gstin',
      'pan',
      'state_code',
      'phone',
      'email',
      'address',
      'logo_file_id',
      'default_locale',
      'timezone',
      'fy_start_month',
    ])
    .where('id', '=', ctx.tenantId)
    .executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  const info: TenantInfo = {
    ...row,
    gst_scheme: row.gst_scheme as GstScheme,
    default_locale: row.default_locale === 'en' ? 'en' : 'ta',
    email: row.email ?? null,
  }
  tenantMemo.set(tx, info)
  return info
}

/** Business "today" of the tenant (timezone aware). */
export async function tenantToday(tx: Tx, ctx: Pick<SalesCtx, 'tenantId'>): Promise<string> {
  return todayIn((await tenantCalendar(tx, ctx)).timezone)
}

export interface SalesEnv {
  tenant: TenantInfo
  settings: TenantSettings
  features: ReadonlySet<Feature>
  planCode: string
  today: string
  timezone: string
}

export async function salesEnv(tx: Tx, ctx: SalesCtx): Promise<SalesEnv> {
  const tenant = await loadTenant(tx, ctx)
  const settings = await getSettings(tx, ctx)
  const ent = await getEntitlements(ctx)
  return {
    tenant,
    settings,
    features: ent.features,
    planCode: ent.plan_code,
    today: todayIn(tenant.timezone),
    timezone: tenant.timezone,
  }
}

export function can(ctx: Pick<SalesCtx, 'permissions'>, p: Permission | Permission[]): boolean {
  return hasPermission(ctx.permissions, p)
}

// ---------------------------------------------------------------------------------------------
// Store, register, customer, shift
// ---------------------------------------------------------------------------------------------

export interface StoreInfo {
  id: string
  code: string
  name: string
  name_ta: string | null
  gstin: string | null
  state_code: string
  address: unknown
  phone: string | null
  email: string | null
  drug_license_numbers: string | null
  fssai_number: string | null
  is_active: boolean
}

export async function loadStore(
  tx: Tx,
  ctx: SalesCtx,
  storeId: string,
  opts: { requireActive?: boolean; checkAccess?: boolean } = {},
): Promise<StoreInfo> {
  if (opts.checkAccess !== false) assertStoreAccess(ctx, storeId)
  const row = await tx
    .selectFrom('stores')
    .select([
      'id',
      'code',
      'name',
      'name_ta',
      'gstin',
      'state_code',
      'address',
      'phone',
      'email',
      'drug_license_numbers',
      'fssai_number',
      'is_active',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', storeId)
    .executeTakeFirst()
  if (!row) throw notFound('store', storeId)
  if (opts.requireActive !== false && !row.is_active) {
    throw unprocessable('The store is inactive', { reason: 'store_inactive', store_id: storeId })
  }
  return { ...row, email: row.email ?? null }
}

export interface RegisterInfo {
  id: string
  store_id: string
  code: string
  name: string
  is_active: boolean
  settings: unknown
}

export async function loadRegister(
  tx: Tx,
  ctx: SalesCtx,
  registerId: string,
  storeId: string | null,
  opts: { requireActive?: boolean } = {},
): Promise<RegisterInfo> {
  const row = await tx
    .selectFrom('registers')
    .select(['id', 'store_id', 'code', 'name', 'is_active', 'settings'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', registerId)
    .executeTakeFirst()
  if (!row) throw notFound('register', registerId)
  if (storeId && row.store_id !== storeId) {
    throw unprocessable('The register belongs to another store', {
      reason: 'register_store_mismatch',
      register_id: registerId,
      store_id: storeId,
    })
  }
  assertStoreAccess(ctx, row.store_id)
  if (opts.requireActive !== false && !row.is_active) {
    throw unprocessable('The register is inactive', {
      reason: 'register_inactive',
      register_id: registerId,
    })
  }
  return row
}

export interface CustomerInfo {
  id: string
  name: string
  name_ta: string | null
  phone: string | null
  gstin: string | null
  state_code: string | null
  address: unknown
  customer_type: string
  price_tier: 'retail' | 'wholesale'
  credit_limit_paise: number | null
  credit_days: number | null
  balance_paise: number
  loyalty_points: number
  is_active: boolean
}

export async function loadCustomer(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  customerId: string,
  opts: { forUpdate?: boolean; requireActive?: boolean } = {},
): Promise<CustomerInfo> {
  let q = tx
    .selectFrom('customers')
    .select([
      'id',
      'name',
      'name_ta',
      'phone',
      'gstin',
      'state_code',
      'address',
      'customer_type',
      'price_tier',
      'credit_limit_paise',
      'credit_days',
      'balance_paise',
      'loyalty_points',
      'is_active',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', customerId)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('customer', customerId)
  if (opts.requireActive !== false && !row.is_active) {
    throw unprocessable('The customer is inactive', {
      reason: 'customer_inactive',
      customer_id: customerId,
    })
  }
  return { ...row, price_tier: row.price_tier === 'wholesale' ? 'wholesale' : 'retail' }
}

export interface OpenShift {
  id: string
  store_id: string
  register_id: string
  opened_at: Date
  opened_by: string
  opened_by_name: string | null
  opening_cash_paise: number
}

export async function openShiftOf(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  registerId: string,
): Promise<OpenShift | null> {
  const row = await tx
    .selectFrom('register_shifts as s')
    .leftJoin('users as u', 'u.id', 's.opened_by')
    .select([
      's.id',
      's.store_id',
      's.register_id',
      's.opened_at',
      's.opened_by',
      'u.full_name as opened_by_name',
      's.opening_cash_paise',
    ])
    .where('s.tenant_id', '=', ctx.tenantId)
    .where('s.register_id', '=', registerId)
    .where('s.status', '=', 'open')
    .executeTakeFirst()
  return row ?? null
}

// ---------------------------------------------------------------------------------------------
// Issues → errors
// ---------------------------------------------------------------------------------------------

const ISSUE_MESSAGES: Partial<Record<SalesBlockingIssueCode, string>> = {
  empty_cart: 'The bill has no items',
  product_not_found: 'A product of the bill was not found',
  product_inactive: 'A product of the bill is inactive',
  not_sellable: 'A product of the bill cannot be sold (variant group)',
  decimal_qty_not_allowed: 'This product is sold in whole units only',
  loose_not_allowed: 'This product is sold in whole packs only',
  batch_not_found: 'The batch was not found for this product',
  expired_batch: 'The batch has expired',
  insufficient_stock: 'Not enough stock',
  serial_numbers_required: 'Serial numbers are required for every unit',
  rx_required: 'Prescription details are required for scheduled drugs',
  price_override_required: 'Changing the price needs manager permission',
  below_min_price: 'The price is below the minimum selling price',
  discount_override_required: 'The discount is above your limit',
  credit_permission_required: 'Selling on credit needs permission',
  customer_required_for_credit: 'Select a customer to sell on credit',
  credit_not_in_plan: 'Credit sales are not included in your plan',
  credit_limit_exceeded: "The sale exceeds the customer's credit limit",
  tender_exceeds_due: 'A payment is more than the amount due',
  cash_tender_not_needed: 'The cash tender is not needed',
  payment_intent_invalid: 'The UPI payment cannot be used for this bill',
  store_credit_insufficient: 'Not enough store credit',
  loyalty_disabled: 'Loyalty points cannot be redeemed',
  loyalty_insufficient: 'Not enough loyalty points',
  loyalty_below_minimum: 'Too few loyalty points to redeem',
  backdate_not_allowed: 'This bill date is not allowed',
  shift_required: 'Open a shift on this counter before billing',
}

/** The error thrown for the first blocking issue (create / complete / sync). */
export function issueError(issues: readonly SalesIssue[]): AppError {
  const blocking = issues.filter((i) => i.severity === 'error')
  const first = blocking[0]
  if (!first || !isBlockingSalesIssue(first.code)) {
    return unprocessable('The bill cannot be completed', { issues: blocking })
  }
  const code = first.code
  return new AppError(salesIssueErrorCode(code), ISSUE_MESSAGES[code] ?? code, {
    ...first.params,
    reason: code,
    line_key: first.line_key,
    issues: blocking,
  })
}

export function assertNoBlocking(issues: readonly SalesIssue[]): void {
  if (issues.some((i) => i.severity === 'error')) throw issueError(issues)
}
