/**
 * Tenant settings and the business profile (docs/API.md "identity" → settings).
 *
 * GET /settings: the tenant profile (as in /me) + typed settings with defaults (lenient read).
 * PATCH /settings: strict deep-partial body (unknown keys → 400), deep-merged and validated in
 * full by core/settings.updateSettings, which audits the changed paths.
 *
 * GET/PATCH /settings/business: name, legal name, GSTIN (checksum; its first two digits are the
 * state code; it embeds the PAN), PAN, GST scheme, state, contact, address, logo, default
 * language. Changing the GST scheme once invoices were issued in the current financial year needs
 * `confirm_gst_scheme_change` (audited separately as business.gst_scheme_change).
 *
 * Both PATCHes are business-wide: store-scoped managers get 403 all_stores_required.
 */
import type { z } from 'zod'
import {
  type BusinessType,
  type GstScheme,
  type TenantStatus,
  fyRange,
  panFromGstin,
} from '@kadai/shared'
import type {
  BusinessProfile,
  BusinessProfileUpdateSchema,
  SettingsPatch,
  SettingsResponse,
} from '@kadai/shared/api/identity'
import { audit, diffChanges } from '../../core/audit'
import { assertNotStale, notFound, validationError } from '../../core/errors'
import { notifyAccessChanged } from '../../core/rbac'
import { getSettings, updateSettings } from '../../core/settings'
import { jsonb } from '../../db/json'
import { type Tx, afterCommit } from '../../db/tenant'
import { type Ctx, assertAllStores, iso, readAddress, reasonConflict, tenantToday } from './common'
import type { IdentityDeps } from './users'

type BusinessUpdateBody = z.output<typeof BusinessProfileUpdateSchema>

async function loadTenant(tx: Tx, ctx: Ctx, lock = false) {
  let q = tx.selectFrom('tenants').selectAll().where('id', '=', ctx.tenantId)
  if (lock) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  return row
}

type TenantRow = Awaited<ReturnType<typeof loadTenant>>

function tenantProfile(t: TenantRow): SettingsResponse['tenant'] {
  return {
    id: t.id,
    name: t.name,
    name_ta: t.name_ta,
    legal_name: t.legal_name,
    business_type: t.business_type as BusinessType,
    gst_scheme: t.gst_scheme as GstScheme,
    gstin: t.gstin,
    pan: t.pan,
    state_code: t.state_code,
    phone: t.phone,
    email: t.email,
    address: readAddress(t.address),
    logo_file_id: t.logo_file_id,
    default_locale: t.default_locale === 'en' ? 'en' : 'ta',
    timezone: t.timezone,
    fy_start_month: t.fy_start_month,
    status: t.status as TenantStatus,
    plan_code: t.plan_code,
  }
}

export async function getSettingsResponse(tx: Tx, ctx: Ctx): Promise<SettingsResponse> {
  const [tenant, settings] = await Promise.all([loadTenant(tx, ctx), getSettings(tx, ctx)])
  return { tenant: tenantProfile(tenant), settings }
}

export async function patchSettings(
  tx: Tx,
  ctx: Ctx,
  patch: SettingsPatch,
): Promise<SettingsResponse> {
  // Settings apply to every store: a branch-scoped manager may not change them for the others.
  assertAllStores(ctx, 'Changing business-wide settings')
  const settings = await updateSettings(tx, ctx, patch)
  return { tenant: tenantProfile(await loadTenant(tx, ctx)), settings }
}

// ---------------------------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------------------------

/** Documents numbered under GST in the FY (number series used, or numbered invoices). */
async function gstDocumentsIssued(tx: Tx, ctx: Ctx, fy: string, fyStartMonth: number) {
  const series = await tx
    .selectFrom('number_series')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('fy', '=', fy)
    .where('doc_type', 'in', ['sales_invoice', 'bill_of_supply', 'credit_note'])
    .where('next_number', '>', 1)
    .limit(1)
    .executeTakeFirst()
  if (series) return true
  const range = fyRange(fy, fyStartMonth)
  const invoice = await tx
    .selectFrom('sales_invoices')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('doc_type', 'in', ['tax_invoice', 'bill_of_supply'])
    .where('number', 'is not', null)
    .where('invoice_date', '>=', range.from)
    .where('invoice_date', '<=', range.to)
    .limit(1)
    .executeTakeFirst()
  return Boolean(invoice)
}

async function toBusinessProfile(tx: Tx, ctx: Ctx, t: TenantRow): Promise<BusinessProfile> {
  const cal = await tenantToday(tx, ctx)
  return {
    name: t.name,
    name_ta: t.name_ta,
    legal_name: t.legal_name,
    business_type: t.business_type as BusinessType,
    gst_scheme: t.gst_scheme as GstScheme,
    gstin: t.gstin,
    pan: t.pan,
    state_code: t.state_code,
    phone: t.phone,
    email: t.email,
    address: readAddress(t.address),
    logo_file_id: t.logo_file_id,
    default_locale: t.default_locale === 'en' ? 'en' : 'ta',
    timezone: t.timezone,
    fy_start_month: t.fy_start_month,
    current_fy: cal.fy,
    gst_scheme_change_requires_confirm: await gstDocumentsIssued(tx, ctx, cal.fy, cal.fyStartMonth),
    updated_at: iso(t.updated_at),
  }
}

export async function getBusinessProfile(tx: Tx, ctx: Ctx): Promise<BusinessProfile> {
  return toBusinessProfile(tx, ctx, await loadTenant(tx, ctx))
}

/** PATCH /settings/business — cross-field rules against the stored profile, audited diff. */
export async function updateBusinessProfile(
  deps: IdentityDeps,
  tx: Tx,
  ctx: Ctx,
  body: BusinessUpdateBody,
): Promise<BusinessProfile> {
  // The legal / GST identity of the whole business: not for branch-scoped managers.
  assertAllStores(ctx, 'Changing the business profile')
  const t = await loadTenant(tx, ctx, true)
  assertNotStale(t.updated_at, body.if_updated_at, 'business', ctx.tenantId)

  const scheme = (body.gst_scheme ?? t.gst_scheme) as GstScheme
  const stateCode = body.state_code ?? t.state_code
  let gstin = body.gstin !== undefined ? body.gstin : t.gstin
  // Switching to unregistered drops a stored GSTIN only when the body clears it explicitly.
  const issues: Array<{ path: string; message: string; code: string }> = []
  if (scheme === 'unregistered' && gstin) {
    issues.push({ path: 'gst_scheme', message: 'gstin_unregistered', code: 'gstin_unregistered' })
  }
  if (scheme !== 'unregistered' && !gstin) {
    issues.push({ path: 'gstin', message: 'gstin_required', code: 'gstin_required' })
  }
  if (gstin && gstin.slice(0, 2) !== stateCode) {
    issues.push({
      path: body.gstin !== undefined ? 'gstin' : 'state_code',
      message: 'gstin_state',
      code: 'gstin_state',
    })
  }
  // The GSTIN embeds the PAN: a given PAN must match it; otherwise the PAN follows the GSTIN.
  let pan = body.pan !== undefined ? body.pan : t.pan
  if (gstin) {
    const gstinPan = panFromGstin(gstin)
    if (body.pan !== undefined && body.pan && gstinPan && body.pan !== gstinPan) {
      issues.push({ path: 'pan', message: 'pan_gstin_mismatch', code: 'pan_gstin_mismatch' })
    } else if (gstinPan && (pan === null || (body.pan === undefined && pan !== gstinPan))) {
      pan = gstinPan
    }
  }
  if (body.logo_file_id) {
    const logo = await tx
      .selectFrom('files')
      .select(['id', 'purpose'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', body.logo_file_id)
      .executeTakeFirst()
    if (!logo || logo.purpose !== 'logo') {
      issues.push({ path: 'logo_file_id', message: 'logo_file', code: 'logo_file' })
    }
  }
  if (issues.length) throw validationError(issues, issues[0]!.message)
  if (scheme === 'unregistered') gstin = null

  const schemeChange = scheme !== t.gst_scheme
  if (schemeChange) {
    const cal = await tenantToday(tx, ctx)
    const issued = await gstDocumentsIssued(tx, ctx, cal.fy, cal.fyStartMonth)
    if (issued && !body.confirm_gst_scheme_change) {
      throw reasonConflict(
        'gst_scheme_change_requires_confirm',
        'Invoices were already issued this financial year; confirm the GST scheme change',
        { fy: cal.fy, from: t.gst_scheme, to: scheme },
      )
    }
  }

  const before = {
    name: t.name,
    name_ta: t.name_ta,
    legal_name: t.legal_name,
    gstin: t.gstin,
    pan: t.pan,
    gst_scheme: t.gst_scheme,
    state_code: t.state_code,
    phone: t.phone,
    email: t.email,
    address: readAddress(t.address),
    logo_file_id: t.logo_file_id,
    default_locale: t.default_locale,
  }
  const after = {
    name: body.name ?? t.name,
    name_ta: body.name_ta !== undefined ? body.name_ta : t.name_ta,
    legal_name: body.legal_name !== undefined ? body.legal_name : t.legal_name,
    gstin,
    pan,
    gst_scheme: scheme,
    state_code: stateCode,
    phone: body.phone !== undefined ? body.phone : t.phone,
    email: body.email !== undefined ? body.email : t.email,
    address: body.address ?? readAddress(t.address),
    logo_file_id: body.logo_file_id !== undefined ? body.logo_file_id : t.logo_file_id,
    default_locale: body.default_locale ?? t.default_locale,
  }
  const changes = diffChanges(before, after)
  if (!changes) return toBusinessProfile(tx, ctx, t)

  const { address, ...columns } = after
  await tx
    .updateTable('tenants')
    .set({ ...columns, address: jsonb(address) })
    .where('id', '=', ctx.tenantId)
    .execute()
  if (after.default_locale !== before.default_locale) {
    // The tenant language is the fallback locale of every cached member access.
    await notifyAccessChanged(tx, { tenant_id: ctx.tenantId })
    afterCommit(tx, () => deps.rbac.invalidate({ tenantId: ctx.tenantId }))
  }
  await audit(tx, ctx, {
    action: 'business.update',
    entity_type: 'tenant',
    entity_id: ctx.tenantId,
    summary: `Business profile changed: ${Object.keys(changes.after).join(', ')}`,
    changes,
  })
  if (schemeChange) {
    await audit(tx, ctx, {
      action: 'business.gst_scheme_change',
      entity_type: 'tenant',
      entity_id: ctx.tenantId,
      summary: `GST scheme changed from ${t.gst_scheme} to ${scheme}`,
      changes: {
        before: { gst_scheme: t.gst_scheme },
        after: { gst_scheme: scheme },
        confirmed: body.confirm_gst_scheme_change,
      },
    })
  }
  return toBusinessProfile(tx, ctx, await loadTenant(tx, ctx))
}
