/**
 * On-prem (the primary segment, ARCHITECTURE.md §21): no SMS is needed to add staff (temporary
 * password, admin reset), limits come from the licence (none installed → the Free evaluation
 * limits), and counters register as trusted devices for PIN sign-in.
 */
import { newId } from '@kadai/shared'
import {
  type DeviceCreateResult,
  type MemberCreateResult,
  type ResetPasswordResult,
  TEMPORARY_PASSWORD_RE,
} from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp, randomPhone } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { type Data, api, expectError, expectStatus, randomIp } from './fixtures'

describe('identity on-prem', () => {
  let t: TestApp
  let shop: TestShop

  beforeAll(async () => {
    t = await buildTestApp({
      env: { KADAI_MODE: 'onprem' },
      // A key of its own: no licence installed → Free evaluation entitlements.
      depsOptions: { licenseSettingsKey: `license_identity_${newId()}` },
    })
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const login = (identifier: string, password: string) =>
    t.app.inject({
      method: 'POST',
      url: api('/auth/login'),
      payload: { identifier, password },
      headers: { 'x-kadai-token-delivery': 'body' },
      remoteAddress: randomIp(),
    })

  it('adds staff with a temporary password and resets it without SMS', async () => {
    const phone = randomPhone()
    const created = expectStatus<Data<MemberCreateResult>>(
      await shop.inject({
        method: 'POST',
        url: api('/users'),
        payload: { phone, full_name: 'Counter staff', role_id: shop.roles.cashier, pin: '2580' },
      }),
      201,
    ).data
    expect(created.temporary_password).toMatch(TEMPORARY_PASSWORD_RE)
    expectStatus(await login(phone, created.temporary_password!), 200)
    const reset = expectStatus<Data<ResetPasswordResult>>(
      await shop.inject({ method: 'POST', url: api(`/users/${created.member.id}/reset-password`) }),
      200,
    ).data
    expectStatus(await login(phone, reset.temporary_password!), 200)

    // The licence decides the limits: without one, the Free evaluation allows 2 users.
    const err = expectError(
      await shop.inject({
        method: 'POST',
        url: api('/users'),
        payload: { phone: randomPhone(), full_name: 'Third', role_id: shop.roles.cashier },
      }),
      402,
      'PLAN_LIMIT_REACHED',
    )
    expect(err.details).toMatchObject({ metric: 'users', limit: 2 })
  })

  it('registers a counter as a trusted device for PIN sign-in', async () => {
    const device = expectStatus<Data<DeviceCreateResult>>(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'Billing PC 1', store_id: shop.store.id, register_id: shop.register.id },
      }),
      201,
    ).data
    const users = expectStatus<Data<Array<{ user_id: string }>>>(
      await t.app.inject({
        method: 'GET',
        url: api(
          `/auth/pin-users?device_id=${device.device.id}&device_secret=${encodeURIComponent(device.device_secret)}`,
        ),
        remoteAddress: randomIp(),
      }),
      200,
    ).data
    expect(users.length).toBeGreaterThan(0)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/stores'),
        payload: { code: 'S2', name: 'Second branch', state_code: '33' },
      }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
  })
})
