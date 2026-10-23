/**
 * Payment provider accounts: CRUD with encrypted, never-returned secrets (masked key id,
 * has_webhook_secret, webhook URL), one default per store (transactional switch), bank-only
 * settlement accounts, plan feature gating (upi_dynamic), credential tests against a fake
 * Razorpay, permissions, store scoping, tenant isolation and the audit trail.
 */
import type { PaymentProviderAccount, ProviderTestResult } from '@kadai/shared/api/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  type Data,
  type FakeRazorpay,
  type List,
  RZP_KEY_ID,
  RZP_KEY_SECRET,
  RZP_WEBHOOK_SECRET,
  api,
  auditRows,
  bankAccountId,
  createRazorpayAccount,
  createUpiAccount,
  expectError,
  expectStatus,
  startFakeRazorpay,
} from './fixtures'

describe('payments: provider accounts', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let rzp: FakeRazorpay

  beforeAll(async () => {
    rzp = await startFakeRazorpay()
    process.env.RAZORPAY_API_BASE = rzp.url
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(async () => {
    await t.close()
    await rzp.close()
  })

  const get = (id: string, on = shop, as?: TestShop['owner']) =>
    on.inject({ method: 'GET', url: api(`/payment-providers/${id}`), as })

  it('adds a UPI ID (first account becomes the store default) and audits it', async () => {
    const created = await createUpiAccount(shop, { vpa: 'Murugan.Stores@OKAXIS' })
    const acct = expectStatus<Data<PaymentProviderAccount>>(await get(created.id), 200).data
    expect(acct).toMatchObject({
      provider: 'upi_vpa',
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Murugan Stores',
      merchant_code: '5411',
      is_default: true,
      is_active: true,
      store_id: shop.store.id,
      key_id_masked: null,
      has_credentials: false,
      has_webhook_secret: false,
      webhook_url: null,
      webhook_events: [],
      capabilities: { manual_confirm: true, dynamic_qr: false },
    })
    expect((await auditRows(t, shop, 'payment_provider.create'))[0]?.entity_id).toBe(created.id)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: { provider: 'upi_vpa', display_name: 'X', vpa: 'not-a-vpa', payee_name: 'X' },
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('stores Razorpay secrets encrypted and never returns them', async () => {
    const created = await createRazorpayAccount(shop)
    const res = await get(created.id)
    expect(res.body).not.toContain(RZP_KEY_SECRET)
    expect(res.body).not.toContain(RZP_WEBHOOK_SECRET)
    expect(res.body).not.toContain(RZP_KEY_ID)
    const acct = expectStatus<Data<PaymentProviderAccount>>(res, 200).data
    expect(acct).toMatchObject({
      provider: 'razorpay',
      mode: 'test',
      key_id_masked: 'rzp_test_••••Abcd',
      has_credentials: true,
      has_webhook_secret: true,
      is_default: true,
      webhook_url: `${t.config.publicBaseUrl}/webhooks/payments/razorpay/${created.id}`,
      webhook_events: ['qr_code.credited', 'payment_link.paid', 'payment.failed'],
    })
    const row = await t.deps.db.systemDb
      .selectFrom('payment_provider_accounts')
      .select(['credentials_encrypted', 'webhook_secret_encrypted'])
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()
    expect(row.credentials_encrypted).toMatch(/^v1:/)
    expect(row.credentials_encrypted).not.toContain(RZP_KEY_SECRET)
    expect(row.webhook_secret_encrypted).toMatch(/^v1:/)
    // Switching the default is transactional: the UPI ID is no longer the store default.
    const list = expectStatus<List<PaymentProviderAccount>>(
      await shop.inject({ method: 'GET', url: api('/payment-providers?is_active=true') }),
      200,
    )
    expect(list.data.filter((a) => a.is_default && a.store_id === shop.store.id)).toHaveLength(1)
    expect(list.data.find((a) => a.is_default)?.id).toBe(created.id)
    const audit = await auditRows(t, shop, 'payment_provider.create')
    expect(JSON.stringify(audit)).not.toContain(RZP_KEY_SECRET)
    // Key id / mode mismatch.
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: {
          provider: 'razorpay',
          display_name: 'Live',
          mode: 'live',
          credentials: { key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET },
        },
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('updates, rotates secrets, switches the default and deactivates', async () => {
    const upi = await createUpiAccount(shop, {
      display_name: 'Second UPI',
      vpa: 'second@oksbi',
      is_default: false,
    })
    const before = expectStatus<Data<PaymentProviderAccount>>(await get(upi.id), 200).data
    expect(before.is_default).toBe(false)
    const patched = expectStatus<Data<PaymentProviderAccount>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/payment-providers/${upi.id}`),
        payload: {
          is_default: true,
          payee_name: 'Murugan Stores Madurai',
          if_updated_at: before.updated_at,
        },
      }),
      200,
    ).data
    expect(patched).toMatchObject({ is_default: true, payee_name: 'Murugan Stores Madurai' })
    const defaults = await t.deps.db.systemDb
      .selectFrom('payment_provider_accounts')
      .select('id')
      .where('tenant_id', '=', shop.tenant.id)
      .where('store_id', '=', shop.store.id)
      .where('is_default', '=', true)
      .execute()
    expect(defaults.map((d) => d.id)).toEqual([upi.id])
    // Stale write.
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/payment-providers/${upi.id}`),
        payload: { display_name: 'Stale', if_updated_at: before.updated_at },
      }),
      409,
      'STALE_WRITE',
    )
    // Fields that do not apply to the provider.
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/payment-providers/${upi.id}`),
        payload: { credentials: { key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET } },
      }),
      422,
      'UNPROCESSABLE',
      'field_not_applicable',
    )
    // Razorpay: rotate credentials, remove the webhook secret.
    const rp = await createRazorpayAccount(shop, { is_default: false, display_name: 'Rzp 2' })
    const rotated = expectStatus<Data<PaymentProviderAccount>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/payment-providers/${rp.id}`),
        payload: {
          credentials: { key_id: 'rzp_test_Rotated9876Wxyz', key_secret: 'another-secret-99' },
          webhook_secret: null,
        },
      }),
      200,
    ).data
    expect(rotated).toMatchObject({ key_id_masked: 'rzp_test_••••Wxyz', has_webhook_secret: false })
    const updAudit = (await auditRows(t, shop, 'payment_provider.update')).find(
      (a) => a.entity_id === rp.id,
    )
    expect(updAudit?.changes).toMatchObject({
      credentials_rotated: true,
      webhook_secret: 'removed',
    })
    expect(JSON.stringify(updAudit)).not.toContain('another-secret-99')
    // Mode change must match the key id.
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/payment-providers/${rp.id}`),
        payload: { mode: 'live' },
      }),
      422,
      'UNPROCESSABLE',
      'razorpay_key_mode_mismatch',
    )
    // Deactivate (DELETE) clears the default.
    expectStatus(
      await shop.inject({ method: 'DELETE', url: api(`/payment-providers/${upi.id}`) }),
      204,
    )
    const gone = expectStatus<Data<PaymentProviderAccount>>(await get(upi.id), 200).data
    expect(gone).toMatchObject({ is_active: false, is_default: false })
    expect((await auditRows(t, shop, 'payment_provider.deactivate'))[0]?.entity_id).toBe(upi.id)
  })

  it('accepts bank settlement accounts only', async () => {
    const bank = await bankAccountId(t, shop, 'bank')
    const cash = await bankAccountId(t, shop, 'cash')
    const ok = await createUpiAccount(shop, {
      settlement_account_id: bank,
      is_default: false,
      vpa: 'bank.settle@okhdfc',
    })
    const acct = expectStatus<Data<PaymentProviderAccount>>(await get(ok.id), 200).data
    expect(acct).toMatchObject({
      settlement_account_id: bank,
      settlement_account_name: 'Bank account',
    })
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: {
          provider: 'upi_vpa',
          display_name: 'Cash?',
          vpa: 'cash.settle@okhdfc',
          payee_name: 'X',
          settlement_account_id: cash,
        },
      }),
      422,
      'UNPROCESSABLE',
      'settlement_account_not_bank',
    )
  })

  it('tests credentials against Razorpay and gives a ₹1 test QR for a UPI ID', async () => {
    const rp = await createRazorpayAccount(shop, { is_default: false, display_name: 'Test creds' })
    const ok = expectStatus<Data<ProviderTestResult>>(
      await shop.inject({ method: 'POST', url: api(`/payment-providers/${rp.id}/test`) }),
      200,
    ).data
    expect(ok).toMatchObject({ ok: true, provider: 'razorpay', error_code: null })
    expect(rzp.requests.some((r) => r.url === '/v1/payments?count=1')).toBe(true)
    const verified = expectStatus<Data<PaymentProviderAccount>>(await get(rp.id), 200).data
    expect(verified.last_verified_at).not.toBeNull()

    expectStatus(
      await shop.inject({
        method: 'PATCH',
        url: api(`/payment-providers/${rp.id}`),
        payload: { credentials: { key_id: RZP_KEY_ID, key_secret: 'wrong-secret-000' } },
      }),
      200,
    )
    const bad = expectStatus<Data<ProviderTestResult>>(
      await shop.inject({ method: 'POST', url: api(`/payment-providers/${rp.id}/test`) }),
      200,
    ).data
    expect(bad).toMatchObject({ ok: false, error_code: 'BAD_REQUEST_ERROR' })

    const upi = await createUpiAccount(shop, { is_default: false, vpa: 'test.qr@okaxis' })
    const qr = expectStatus<Data<ProviderTestResult>>(
      await shop.inject({ method: 'POST', url: api(`/payment-providers/${upi.id}/test`) }),
      200,
    ).data
    expect(qr.ok).toBe(true)
    expect(qr.test_upi_uri).toMatch(
      /^upi:\/\/pay\?pa=test.qr@okaxis&pn=Murugan%20Stores&am=1\.00&cu=INR/,
    )
  })

  it('gates dynamic providers on plan feature upi_dynamic', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    expectError(
      await free.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: {
          provider: 'razorpay',
          display_name: 'Rzp',
          mode: 'test',
          credentials: { key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET },
        },
      }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    expectError(
      await free.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: { provider: 'mock', display_name: 'Mock' },
      }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    // The shop UPI ID works on every plan.
    await createUpiAccount(free)
  })

  it('enforces permissions and store scoping', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/payment-providers'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: { provider: 'upi_vpa', display_name: 'X', vpa: 'x.y@okaxis', payee_name: 'X' },
        as: cashier,
      }),
      403,
      'FORBIDDEN',
    )
    const accountant = await shop.asRole('accountant')
    expectStatus(
      await shop.inject({ method: 'GET', url: api('/payment-providers'), as: accountant }),
      200,
    )
    // A store-scoped manager cannot manage all-store accounts, and sees only their stores'.
    const store2 = await t.deps.db.systemDb
      .insertInto('stores')
      .values({ tenant_id: shop.tenant.id, code: 'S9', name: 'Branch', state_code: '33' })
      .returning('id')
      .executeTakeFirstOrThrow()
    const branchUpi = await createUpiAccount(shop, { store_id: store2.id, vpa: 'branch@okaxis' })
    const scoped = await shop.asRole('scoped_admin', {
      permissions: ['payments.configure'],
      store_ids: [shop.store.id],
    })
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/payment-providers'),
        payload: {
          provider: 'upi_vpa',
          display_name: 'All',
          vpa: 'all.stores@okaxis',
          payee_name: 'X',
          store_id: null,
        },
        as: scoped,
      }),
      403,
      'FORBIDDEN',
      'all_stores_required',
    )
    expectError(await get(branchUpi.id, shop, scoped), 404, 'NOT_FOUND')
    const visible = expectStatus<List<PaymentProviderAccount>>(
      await shop.inject({ method: 'GET', url: api('/payment-providers'), as: scoped }),
      200,
    )
    expect(visible.data.some((a) => a.id === branchUpi.id)).toBe(false)
  })

  it('keeps tenants apart', async () => {
    const mine = await createUpiAccount(other, { vpa: 'other.shop@okaxis' })
    expectError(await get(mine.id, shop), 404, 'NOT_FOUND')
    const list = expectStatus<List<PaymentProviderAccount>>(
      await shop.inject({ method: 'GET', url: api('/payment-providers?limit=200') }),
      200,
    )
    expect(list.data.some((a) => a.id === mine.id)).toBe(false)
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/payment-providers/${mine.id}`),
        payload: { display_name: 'Hijack' },
      }),
      404,
      'NOT_FOUND',
    )
  })
})
