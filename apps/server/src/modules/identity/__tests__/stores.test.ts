/**
 * Stores, registers and trusted devices: CRUD with GSTIN / state rules, code freezing once
 * numbered, last active store protection, plan limits (stores / registers) and feature
 * multi_store, register settings deep-PATCH, device secret shown once, PIN login on a trusted
 * device and revocation that ends its sessions, store scoping and tenant isolation.
 */
import { createHash } from 'node:crypto'
import { makeGstin, newId, todayIn } from '@kadai/shared'
import type { Device, DeviceCreateResult, Register, Store } from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nextNumber } from '../../../core/numbering'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { readRegisterSettings } from '../common'
import {
  type Data,
  type List,
  api,
  auditRows,
  expectError,
  expectStatus,
  liveSessions,
  randomIp,
} from './fixtures'

describe('identity: stores, registers, devices', () => {
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

  const createStore = (
    payload: Record<string, unknown>,
    on: TestShop = shop,
    as?: TestShop['owner'],
  ) => on.inject({ method: 'POST', url: api('/stores'), payload, as })
  const patchStore = (
    id: string,
    payload: Record<string, unknown>,
    on: TestShop = shop,
    as?: TestShop['owner'],
  ) => on.inject({ method: 'PATCH', url: api(`/stores/${id}`), payload, as })
  const createRegister = (payload: Record<string, unknown>, on: TestShop = shop) =>
    on.inject({ method: 'POST', url: api('/registers'), payload })

  // ---- stores ----------------------------------------------------------------------------------

  it('lists stores for every member (pickers)', async () => {
    const cashier = await shop.asRole('cashier')
    const res = expectStatus<List<Store>>(
      await shop.inject({ method: 'GET', url: api('/stores'), as: cashier }),
      200,
    )
    const s1 = res.data.find((s) => s.id === shop.store.id)!
    expect(s1).toMatchObject({ code: 'S1', is_active: true, register_count: 1, state_code: '33' })
    expectStatus(
      await shop.inject({ method: 'GET', url: api(`/stores/${shop.store.id}`), as: cashier }),
      200,
    )
    expectError(
      await createStore({ code: 'S9', name: 'No', state_code: '33' }, shop, cashier),
      403,
      'FORBIDDEN',
    )
  })

  it('adds a store with GSTIN, licences and address; validates codes and GSTIN', async () => {
    const gstin = makeGstin('33', 'AABCK1234M', '2')
    const store = expectStatus<Data<Store>>(
      await createStore({
        code: 's2',
        name: 'Madurai Branch',
        name_ta: 'மதுரை கிளை',
        gstin: gstin.toLowerCase(),
        state_code: '33',
        address: {
          line1: '12, East Masi Street',
          city: 'Madurai',
          district: 'Madurai',
          pincode: '625001',
        },
        phone: '9876543210',
        drug_license_numbers: 'TN-MDU-20-1234, TN-MDU-21-1234',
        fssai_number: '12345678901234',
      }),
      201,
    ).data
    expect(store).toMatchObject({
      code: 'S2',
      gstin,
      phone: '+919876543210',
      register_count: 0,
      address: { city: 'Madurai', pincode: '625001' },
      fssai_number: '12345678901234',
    })
    expect((await auditRows(t, shop, { action: 'store.create', entity_id: store.id })).length).toBe(
      1,
    )

    expectError(await createStore({ code: 'S2', name: 'Dup', state_code: '33' }), 409, 'DUPLICATE')
    expectError(
      await createStore({ code: 'TOOLONG', name: 'X', state_code: '33' }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await createStore({ code: 'S-3', name: 'X', state_code: '33' }),
      400,
      'VALIDATION_ERROR',
    )
    const wrongState = expectError(
      await createStore({ code: 'S3', name: 'X', state_code: '29', gstin }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(wrongState.details)).toContain('gstin_state')
    const badChecksum = `${gstin.slice(0, 14)}${gstin.endsWith('A') ? 'B' : 'A'}`
    expectError(
      await createStore({ code: 'S3', name: 'X', state_code: '33', gstin: badChecksum }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await createStore({ code: 'S3', name: 'X', state_code: '33', fssai_number: '123' }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('needs multi_store for a second store on single-store plans', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const err = expectError(
      await createStore({ code: 'S2', name: 'Branch', state_code: '33' }, free),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    expect(err.details).toMatchObject({ feature: 'multi_store' })
  })

  it('enforces the stores limit of the plan', async () => {
    const pro = await createTestTenant(t, { plan_code: 'pro' })
    for (const code of ['S2', 'S3', 'S4', 'S5']) {
      expectStatus(await createStore({ code, name: `Store ${code}`, state_code: '33' }, pro), 201)
    }
    const err = expectError(
      await createStore({ code: 'S6', name: 'One too many', state_code: '33' }, pro),
      402,
      'PLAN_LIMIT_REACHED',
    )
    expect(err.details).toMatchObject({ metric: 'stores', limit: 5, current: 5 })
    // A deactivated store frees its slot; reactivating it counts again.
    const list = expectStatus<List<Store>>(
      await pro.inject({ method: 'GET', url: api('/stores') }),
      200,
    )
    const s5 = list.data.find((s) => s.code === 'S5')!
    expectStatus(await patchStore(s5.id, { is_active: false }, pro), 200)
    expectStatus(await createStore({ code: 'S6', name: 'Replacement', state_code: '33' }, pro), 201)
    expectError(await patchStore(s5.id, { is_active: true }, pro), 402, 'PLAN_LIMIT_REACHED')
  })

  it('updates stores; codes freeze once numbered; one active store always stays', async () => {
    const solo = await createTestTenant(t)
    const updated = expectStatus<Data<Store>>(
      await patchStore(solo.store.id, { name: 'Main Bazaar', code: 'MB' }, solo),
      200,
    ).data
    expect(updated).toMatchObject({ name: 'Main Bazaar', code: 'MB' })
    await solo.tx((tx) =>
      nextNumber(tx, solo.ctx, { docType: 'sales_invoice', storeId: solo.store.id, date: today }),
    )
    expectError(
      await patchStore(solo.store.id, { code: 'M1' }, solo),
      409,
      'CONFLICT',
      'store_code_locked',
    )
    // GSTIN checked against the stored state code.
    const karnataka = makeGstin('29', 'AABCK1234M')
    const mismatch = expectError(
      await patchStore(solo.store.id, { gstin: karnataka }, solo),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(mismatch.details)).toContain('gstin_state')
    expectStatus(await patchStore(solo.store.id, { gstin: karnataka, state_code: '29' }, solo), 200)
    expectError(
      await patchStore(solo.store.id, { is_active: false }, solo),
      409,
      'CONFLICT',
      'last_active_store',
    )
    expectError(
      await patchStore(solo.store.id, { name: 'Late', if_updated_at: updated.updated_at }, solo),
      409,
      'STALE_WRITE',
    )
    const [row] = await auditRows(t, solo, { action: 'store.update', entity_id: solo.store.id })
    expect(row?.changes).toBeTruthy()
  })

  it('keeps one active store when the last two are deactivated at the same time', async () => {
    const duo = await createTestTenant(t)
    const s2 = expectStatus<Data<Store>>(
      await createStore({ code: 'S2', name: 'Second', state_code: '33' }, duo),
      201,
    ).data
    const results = await Promise.all([
      patchStore(duo.store.id, { is_active: false }, duo),
      patchStore(s2.id, { is_active: false }, duo),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const refused = results.find((r) => r.statusCode === 409)!
    expectError(refused, 409, 'CONFLICT', 'last_active_store')
    const active = expectStatus<List<Store>>(
      await duo.inject({ method: 'GET', url: api('/stores?is_active=true') }),
      200,
    )
    expect(active.page.total).toBe(1)
  })

  it('scopes store administration to the admin’s stores', async () => {
    const branch = await createTestTenant(t)
    const s2 = expectStatus<Data<Store>>(
      await createStore({ code: 'S2', name: 'Branch', state_code: '33' }, branch),
      201,
    ).data
    const scoped = await branch.asRole('branch_settings', {
      permissions: ['settings.manage'],
      store_ids: [branch.store.id],
    })
    expectStatus(await patchStore(branch.store.id, { name: 'Own store' }, branch, scoped), 200)
    expectError(await patchStore(s2.id, { name: 'Not mine' }, branch, scoped), 403, 'FORBIDDEN')
    expectError(
      await createStore({ code: 'S3', name: 'New', state_code: '33' }, branch, scoped),
      403,
      'FORBIDDEN',
      'all_stores_required',
    )
    const regs = expectStatus<List<Register>>(
      await branch.inject({ method: 'GET', url: api('/registers'), as: scoped }),
      200,
    )
    expect(regs.data.every((r) => r.store_id === branch.store.id)).toBe(true)
    expectError(
      await branch.inject({ method: 'GET', url: api(`/registers?store_id=${s2.id}`), as: scoped }),
      403,
      'FORBIDDEN',
    )
  })

  it('keeps stores per business', async () => {
    expectError(
      await other.inject({ method: 'GET', url: api(`/stores/${shop.store.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(await patchStore(shop.store.id, { name: 'Hijack' }, other), 404, 'NOT_FOUND')
    const list = expectStatus<List<Store>>(
      await other.inject({ method: 'GET', url: api('/stores') }),
      200,
    )
    expect(list.data.map((s) => s.id)).toEqual([other.store.id])
  })

  // ---- registers -------------------------------------------------------------------------------

  it('adds registers with settings; codes are unique per store', async () => {
    const reg = expectStatus<Data<Register>>(
      await createRegister({
        store_id: shop.store.id,
        code: 'b',
        name: 'Counter B',
        settings: { print_format: 'thermal_58', customer_display: true },
      }),
      201,
    ).data
    expect(reg).toMatchObject({
      code: 'B',
      store_code: 'S1',
      device_count: 0,
      settings: { print_format: 'thermal_58', customer_display: true, auto_print: true },
    })
    expect(reg.settings.scale.baud_rate).toBe(9600)
    expectError(
      await createRegister({ store_id: shop.store.id, code: 'B', name: 'Again' }),
      409,
      'DUPLICATE',
    )
    expectError(
      await createRegister({ store_id: shop.store.id, code: 'ABC', name: 'Too long' }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await createRegister({ store_id: other.store.id, code: 'Z', name: 'Foreign' }),
      400,
      'VALIDATION_ERROR',
    )
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/registers'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const list = expectStatus<List<Register>>(
      await shop.inject({ method: 'GET', url: api(`/registers?store_id=${shop.store.id}`) }),
      200,
    )
    expect(list.data.map((r) => r.code)).toEqual(expect.arrayContaining(['A', 'B']))
  })

  it('deep-patches register settings and validates the result', async () => {
    const reg = expectStatus<Data<Register>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/registers/${shop.register.id}`),
        payload: { settings: { cash_drawer: true, scale: { enabled: true, baud_rate: 2400 } } },
      }),
      200,
    ).data
    expect(reg.settings).toMatchObject({
      cash_drawer: true,
      auto_print: true,
      scale: { enabled: true, baud_rate: 2400, data_bits: 8, parity: 'none' },
    })
    // A second partial patch keeps the earlier values.
    const again = expectStatus<Data<Register>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/registers/${shop.register.id}`),
        payload: { settings: { scale: { weight_unit: 'g' } } },
      }),
      200,
    ).data
    expect(again.settings.scale).toMatchObject({ enabled: true, baud_rate: 2400, weight_unit: 'g' })
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/registers/${shop.register.id}`),
        payload: { settings: { unknown_flag: true } },
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/registers/${shop.register.id}`),
        payload: { settings: { scale: { baud_rate: 1234 } } },
      }),
      400,
      'VALIDATION_ERROR',
    )
    expect(
      (await auditRows(t, shop, { action: 'register.update', entity_id: shop.register.id })).length,
    ).toBeGreaterThan(0)
  })

  it('reads stored register settings leniently', () => {
    const s = readRegisterSettings({
      auto_print: 'yes',
      printer_name: 'EPSON TM-T82',
      scale: { baud_rate: 7, parity: 'even' },
      legacy: 1,
    })
    expect(s.auto_print).toBe(true)
    expect(s.printer_name).toBe('EPSON TM-T82')
    expect(s.scale).toMatchObject({ baud_rate: 9600, parity: 'even' })
    expect('legacy' in s).toBe(false)
    expect(readRegisterSettings(null).print_format).toBeNull()
  })

  it('freezes register codes once numbered and enforces the registers limit', async () => {
    const solo = await createTestTenant(t)
    await solo.tx((tx) =>
      nextNumber(tx, solo.ctx, {
        docType: 'sales_invoice',
        storeId: solo.store.id,
        registerId: solo.register.id,
        date: today,
      }),
    )
    expectError(
      await solo.inject({
        method: 'PATCH',
        url: api(`/registers/${solo.register.id}`),
        payload: { code: 'Z' },
      }),
      409,
      'CONFLICT',
      'register_code_locked',
    )
    const free = await createTestTenant(t, { plan_code: 'free' })
    const err = expectError(
      await createRegister({ store_id: free.store.id, code: 'B', name: 'Second counter' }, free),
      402,
      'PLAN_LIMIT_REACHED',
    )
    expect(err.details).toMatchObject({ metric: 'registers', limit: 1 })
    // Deactivate A → B fits; A cannot come back while B is active.
    expectStatus(
      await free.inject({
        method: 'PATCH',
        url: api(`/registers/${free.register.id}`),
        payload: { is_active: false },
      }),
      200,
    )
    expectStatus(await createRegister({ store_id: free.store.id, code: 'B', name: 'B' }, free), 201)
    expectError(
      await free.inject({
        method: 'PATCH',
        url: api(`/registers/${free.register.id}`),
        payload: { is_active: true },
      }),
      402,
      'PLAN_LIMIT_REACHED',
    )
  })

  it('keeps registers per business', async () => {
    expectError(
      await other.inject({ method: 'GET', url: api(`/registers/${shop.register.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'PATCH',
        url: api(`/registers/${shop.register.id}`),
        payload: { name: 'Hijack' },
      }),
      404,
      'NOT_FOUND',
    )
  })

  // ---- devices ---------------------------------------------------------------------------------

  it('trusts a device: the secret is shown once and only its hash is stored', async () => {
    const created = expectStatus<Data<DeviceCreateResult>>(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'Counter 1 PC', store_id: shop.store.id, register_id: shop.register.id },
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' },
      }),
      201,
    ).data
    expect(created.device_secret.length).toBeGreaterThanOrEqual(16)
    expect(created.device).toMatchObject({
      name: 'Counter 1 PC',
      status: 'active',
      store_code: 'S1',
      register_code: 'A',
      approved_by: shop.owner.user.id,
      user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
    })
    const row = await t.deps.db.systemDb
      .selectFrom('devices')
      .select('device_secret_hash')
      .where('id', '=', created.device.id)
      .executeTakeFirstOrThrow()
    expect(row.device_secret_hash).toBe(
      createHash('sha256').update(created.device_secret).digest('hex'),
    )
    const list = await shop.inject({ method: 'GET', url: api('/devices') })
    expect(list.body).not.toContain(created.device_secret)
    expect(list.body).not.toContain(row.device_secret_hash)
    const reg = expectStatus<Data<Register>>(
      await shop.inject({ method: 'GET', url: api(`/registers/${shop.register.id}`) }),
      200,
    ).data
    expect(reg.device_count).toBeGreaterThanOrEqual(1)
  })

  it('validates the device’s store and register', async () => {
    const s2 = expectStatus<Data<Store>>(
      await createStore({ code: 'D2', name: 'Device branch', state_code: '33' }),
      201,
    ).data
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'PC', store_id: s2.id, register_id: shop.register.id },
      }),
      422,
      'UNPROCESSABLE',
      'register_store_mismatch',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'PC', store_id: newId() },
      }),
      400,
      'VALIDATION_ERROR',
    )
    // Issue messages are translation keys (settings:validation.register_unknown).
    const unknownRegister = expectError(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'PC', store_id: shop.store.id, register_id: newId() },
      }),
      400,
      'VALIDATION_ERROR',
    )
    expect(unknownRegister.details?.issues).toEqual([
      { path: 'register_id', message: 'register_unknown', code: 'register_unknown' },
    ])
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'PC', store_id: shop.store.id },
        as: cashier,
      }),
      403,
      'FORBIDDEN',
    )
  })

  it('revoking a device ends its PIN sessions and refuses further PIN sign-ins', async () => {
    const created = expectStatus<Data<DeviceCreateResult>>(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'Counter 2 PC', store_id: shop.store.id, register_id: shop.register.id },
      }),
      201,
    ).data
    const cashier = await shop.asRole('cashier', { pin: '2580' })
    const pinLogin = () =>
      t.app.inject({
        method: 'POST',
        url: api('/auth/pin-login'),
        payload: {
          device_id: created.device.id,
          device_secret: created.device_secret,
          user_id: cashier.user.id,
          pin: '2580',
        },
        headers: { 'x-kadai-token-delivery': 'body' },
        remoteAddress: randomIp(),
      })
    const session = expectStatus<Data<{ access_token: string }>>(await pinLogin(), 200).data
    const deviceSessions = (await liveSessions(t, cashier.user.id)).filter(
      (s) => s.device_id === created.device.id,
    )
    expect(deviceSessions.length).toBe(1)
    const pinHeaders = { authorization: `Bearer ${session.access_token}` }
    expectStatus(await t.app.inject({ method: 'GET', url: api('/me'), headers: pinHeaders }), 200)

    const revoked = expectStatus<Data<Device>>(
      await shop.inject({
        method: 'POST',
        url: api(`/devices/${created.device.id}/revoke`),
        payload: { reason: 'PC replaced' },
      }),
      200,
    ).data
    expect(revoked.status).toBe('revoked')
    expect(revoked.revoked_at).not.toBeNull()
    expect(
      (await liveSessions(t, cashier.user.id)).filter((s) => s.device_id === created.device.id),
    ).toEqual([])
    const after = await t.app.inject({ method: 'GET', url: api('/me'), headers: pinHeaders })
    expect([401, 403]).toContain(after.statusCode)
    expectError(await pinLogin(), 403, 'DEVICE_NOT_TRUSTED')
    // Revoking again is a no-op; the list filters by status.
    expectStatus(
      await shop.inject({ method: 'POST', url: api(`/devices/${created.device.id}/revoke`) }),
      200,
    )
    const active = expectStatus<List<Device>>(
      await shop.inject({ method: 'GET', url: api('/devices?status=active') }),
      200,
    )
    expect(active.data.some((d) => d.id === created.device.id)).toBe(false)
    const revokedList = expectStatus<List<Device>>(
      await shop.inject({ method: 'GET', url: api('/devices?status=revoked') }),
      200,
    )
    expect(revokedList.data.some((d) => d.id === created.device.id)).toBe(true)
    expect(
      (await auditRows(t, shop, { action: 'device.revoke', entity_id: created.device.id })).length,
    ).toBe(1)
  })

  it('keeps devices per business', async () => {
    const created = expectStatus<Data<DeviceCreateResult>>(
      await shop.inject({
        method: 'POST',
        url: api('/devices'),
        payload: { name: 'Private PC', store_id: shop.store.id },
      }),
      201,
    ).data
    expectError(
      await other.inject({ method: 'POST', url: api(`/devices/${created.device.id}/revoke`) }),
      404,
      'NOT_FOUND',
    )
    const list = expectStatus<List<Device>>(
      await other.inject({ method: 'GET', url: api('/devices?status=all') }),
      200,
    )
    expect(list.data.some((d) => d.id === created.device.id)).toBe(false)
  })
})
