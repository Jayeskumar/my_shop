/**
 * Settings and business profile: typed settings with defaults, strict deep-partial PATCH with an
 * audited diff of the changed paths, business profile rules (GSTIN checksum / state / PAN, GST
 * scheme vs GSTIN, scheme change after invoices needs confirmation and is audited, logo must be
 * a logo upload), permissions and tenant isolation.
 */
import { DEFAULT_SETTINGS, fyOf, makeGstin, newId, todayIn } from '@kadai/shared'
import type { BusinessProfile, FileMeta, SettingsResponse } from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nextNumber } from '../../../core/numbering'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  type Data,
  api,
  auditRows,
  expectError,
  expectStatus,
  multipart,
  pngBytes,
} from './fixtures'

describe('identity: settings & business profile', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  const today = todayIn('Asia/Kolkata')

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const patchSettings = (payload: unknown, as?: TestShop['owner']) =>
    shop.inject({ method: 'PATCH', url: api('/settings'), payload: payload as object, as })
  const patchBusiness = (payload: Record<string, unknown>, on: TestShop = shop) =>
    on.inject({ method: 'PATCH', url: api('/settings/business'), payload })
  const business = async (on: TestShop = shop) =>
    expectStatus<Data<BusinessProfile>>(
      await on.inject({ method: 'GET', url: api('/settings/business') }),
      200,
    ).data

  it('returns the tenant profile and settings with defaults to every member', async () => {
    const cashier = await shop.asRole('cashier')
    const res = expectStatus<Data<SettingsResponse>>(
      await shop.inject({ method: 'GET', url: api('/settings'), as: cashier }),
      200,
    ).data
    expect(res.tenant).toMatchObject({
      id: shop.tenant.id,
      gst_scheme: 'regular',
      state_code: '33',
    })
    expect(res.settings.invoice.copies).toBe(DEFAULT_SETTINGS.invoice.copies)
    expect(res.settings.pos.scale_barcode).toBeDefined()
  })

  it('patches settings deep-partially and audits the changed paths', async () => {
    const res = expectStatus<Data<SettingsResponse>>(
      await patchSettings({
        invoice: { copies: 2, footer_text: 'Nandri, again!' },
        notifications: { due_reminder_days: [10, 20] },
      }),
      200,
    ).data
    expect(res.settings.invoice).toMatchObject({
      copies: 2,
      footer_text: 'Nandri, again!',
      // untouched siblings keep their values
      footer_text_ta: DEFAULT_SETTINGS.invoice.footer_text_ta,
      print_format: DEFAULT_SETTINGS.invoice.print_format,
    })
    expect(res.settings.notifications.due_reminder_days).toEqual([10, 20])
    const [row] = await auditRows(t, shop, { action: 'settings.update' })
    expect(row?.changes).toMatchObject({
      before: { invoice: { copies: 1 } },
      after: { invoice: { copies: 2, footer_text: 'Nandri, again!' } },
    })
    expect(row?.summary).toContain('invoice')
    // The other business is untouched.
    const theirs = expectStatus<Data<SettingsResponse>>(
      await other.inject({ method: 'GET', url: api('/settings') }),
      200,
    ).data
    expect(theirs.settings.invoice.copies).toBe(DEFAULT_SETTINGS.invoice.copies)
  })

  it('rejects unknown keys, invalid values and empty patches', async () => {
    expectError(await patchSettings({ invoice: { nope: true } }), 400, 'VALIDATION_ERROR')
    expectError(await patchSettings({ marketing: {} }), 400, 'VALIDATION_ERROR')
    expectError(await patchSettings({ invoice: { copies: 9 } }), 400, 'VALIDATION_ERROR')
    expectError(
      await patchSettings({ pos: { quick_keys: ['not-a-uuid'] } }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(await patchSettings({}), 400, 'VALIDATION_ERROR')
    const cashier = await shop.asRole('cashier')
    expectError(await patchSettings({ invoice: { copies: 3 } }, cashier), 403, 'FORBIDDEN')
  })

  it('keeps business-wide changes away from branch-scoped managers', async () => {
    const branch = await shop.asRole('branch_settings', {
      permissions: ['settings.manage'],
      store_ids: [shop.store.id],
    })
    expectError(
      await patchSettings({ invoice: { copies: 3 } }, branch),
      403,
      'FORBIDDEN',
      'all_stores_required',
    )
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api('/settings/business'),
        payload: { name: 'Branch takeover' },
        as: branch,
      }),
      403,
      'FORBIDDEN',
      'all_stores_required',
    )
    // Reading stays open to them, and nothing changed.
    const profile = expectStatus<Data<BusinessProfile>>(
      await shop.inject({ method: 'GET', url: api('/settings/business'), as: branch }),
      200,
    ).data
    expect(profile.name).not.toBe('Branch takeover')
    const res = expectStatus<Data<SettingsResponse>>(
      await shop.inject({ method: 'GET', url: api('/settings'), as: branch }),
      200,
    ).data
    expect(res.settings.invoice.copies).not.toBe(3)
  })

  it('serves the business profile to settings managers only', async () => {
    const profile = await business()
    expect(profile).toMatchObject({
      gst_scheme: 'regular',
      state_code: '33',
      current_fy: fyOf(today),
      gst_scheme_change_requires_confirm: false,
    })
    expect(profile.pan).toBe(profile.gstin!.slice(2, 12))
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/settings/business'), as: cashier }),
      403,
      'FORBIDDEN',
    )
  })

  it('updates the profile; the GSTIN must be valid and match the state; PAN follows it', async () => {
    const before = await business()
    const updated = expectStatus<Data<BusinessProfile>>(
      await patchBusiness({
        name: 'Sri Murugan Stores',
        name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
        legal_name: 'Sri Murugan Traders',
        phone: '9876501234',
        email: 'Shop@Example.com',
        address: { line1: '4, Car Street', city: 'Tiruchirappalli', pincode: '620001' },
        default_locale: 'en',
        if_updated_at: before.updated_at,
      }),
      200,
    ).data
    expect(updated).toMatchObject({
      name: 'Sri Murugan Stores',
      phone: '+919876501234',
      email: 'shop@example.com',
      default_locale: 'en',
      address: { city: 'Tiruchirappalli' },
    })
    const [row] = await auditRows(t, shop, { action: 'business.update' })
    expect(row?.changes).toMatchObject({ after: { name: 'Sri Murugan Stores' } })
    expectError(
      await patchBusiness({ name: 'Late', if_updated_at: before.updated_at }),
      409,
      'STALE_WRITE',
    )

    const newGstin = makeGstin('33', 'AAFCM9876Q', '3')
    const regstd = expectStatus<Data<BusinessProfile>>(
      await patchBusiness({ gstin: newGstin }),
      200,
    ).data
    expect(regstd).toMatchObject({ gstin: newGstin, pan: 'AAFCM9876Q' })
    const wrongState = expectError(
      await patchBusiness({ gstin: makeGstin('29', 'AAFCM9876Q') }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(wrongState.details)).toContain('gstin_state')
    expectError(
      await patchBusiness({
        gstin: `${newGstin.slice(0, 14)}${newGstin.endsWith('Z') ? 'Y' : 'Z'}`,
      }),
      400,
      'VALIDATION_ERROR',
    )
    const panMismatch = expectError(
      await patchBusiness({ pan: 'ABCPE1234F' }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(panMismatch.details)).toContain('pan_gstin_mismatch')
    // Moving state without a matching GSTIN is refused.
    expectError(await patchBusiness({ state_code: '29' }), 400, 'VALIDATION_ERROR')
  })

  it('keeps the GST scheme consistent with the GSTIN', async () => {
    const shop2 = await createTestTenant(t)
    const unreg = expectError(
      await patchBusiness({ gst_scheme: 'unregistered' }, shop2),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(unreg.details)).toContain('gstin_unregistered')
    const cleared = expectStatus<Data<BusinessProfile>>(
      await patchBusiness({ gst_scheme: 'unregistered', gstin: null }, shop2),
      200,
    ).data
    expect(cleared).toMatchObject({ gst_scheme: 'unregistered', gstin: null })
    const needs = expectError(
      await patchBusiness({ gst_scheme: 'composition' }, shop2),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(needs.details)).toContain('gstin_required')
  })

  it('needs confirmation to change the GST scheme once invoices were issued this FY', async () => {
    const shop3 = await createTestTenant(t)
    await shop3.tx((tx) =>
      nextNumber(tx, shop3.ctx, { docType: 'sales_invoice', storeId: shop3.store.id, date: today }),
    )
    expect((await business(shop3)).gst_scheme_change_requires_confirm).toBe(true)
    const err = expectError(
      await patchBusiness({ gst_scheme: 'composition' }, shop3),
      409,
      'CONFLICT',
      'gst_scheme_change_requires_confirm',
    )
    expect(err.details).toMatchObject({ from: 'regular', to: 'composition', fy: fyOf(today) })
    const changed = expectStatus<Data<BusinessProfile>>(
      await patchBusiness({ gst_scheme: 'composition', confirm_gst_scheme_change: true }, shop3),
      200,
    ).data
    expect(changed.gst_scheme).toBe('composition')
    const [row] = await auditRows(t, shop3, { action: 'business.gst_scheme_change' })
    expect(row?.changes).toMatchObject({
      before: { gst_scheme: 'regular' },
      after: { gst_scheme: 'composition' },
      confirmed: true,
    })
  })

  it('accepts only a logo upload of this business as the logo', async () => {
    expectError(await patchBusiness({ logo_file_id: newId() }), 400, 'VALIDATION_ERROR')
    const upload = async (on: TestShop, purpose: string) => {
      const body = multipart('logo.png', 'image/png', pngBytes(600))
      return expectStatus<Data<FileMeta>>(
        await on.inject({
          method: 'POST',
          url: api(`/files?purpose=${purpose}`),
          payload: body.payload,
          headers: body.headers,
        }),
        201,
      ).data
    }
    const attachment = await upload(shop, 'attachment')
    const notLogo = expectError(
      await patchBusiness({ logo_file_id: attachment.id }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(notLogo.details)).toContain('logo_file')
    const foreign = await upload(other, 'logo')
    expectError(await patchBusiness({ logo_file_id: foreign.id }), 400, 'VALIDATION_ERROR')
    const logo = await upload(shop, 'logo')
    const set = expectStatus<Data<BusinessProfile>>(
      await patchBusiness({ logo_file_id: logo.id }),
      200,
    ).data
    expect(set.logo_file_id).toBe(logo.id)
    const removed = expectStatus<Data<BusinessProfile>>(
      await patchBusiness({ logo_file_id: null }),
      200,
    ).data
    expect(removed.logo_file_id).toBeNull()
  })
})
