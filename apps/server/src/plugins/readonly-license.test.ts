import { generateKeyPairSync } from 'node:crypto'
import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signLicense, storeLicense } from '../core/license'
import { fixtureModule } from '../test/fixture-module'
import { type TestApp, type TestTenant, bearer, buildTestApp, insertTestTenant, signTestToken } from '../test/helpers'

describe('on-prem read-only mode (tampered license)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const licenseKey = `license_test_${newId()}`
  let t: TestApp
  let shop: TestTenant
  let token: string

  beforeAll(async () => {
    t = await buildTestApp({
      modules: [fixtureModule],
      env: { KADAI_MODE: 'onprem', KADAI_LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      depsOptions: { licenseSettingsKey: licenseKey },
    })
    shop = await insertTestTenant(t.deps.db.systemDb)
    token = await signTestToken(t.deps, shop.owner)
  })
  afterAll(async () => {
    await t.deps.db.systemDb.deleteFrom('system_settings').where('key', '=', licenseKey).execute()
    await t.close()
  })

  it('allows writes without a license (evaluation) and blocks them with a tampered one', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/__test/write', headers: bearer(token) })).statusCode).toBe(200)

    const doc = signLicense(
      {
        license_id: 'L1',
        licensee: 'Shop',
        business_name: 'Shop',
        plan_code: 'pro',
        max_stores: 1,
        valid_from: '2026-01-01',
        valid_until: null,
        issued_at: new Date().toISOString(),
      },
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'k',
    )
    await storeLicense(t.deps.db.systemDb, { ...doc, license: { ...doc.license, max_stores: 99 } }, licenseKey)
    t.deps.entitlements.invalidate()

    const write = await t.app.inject({ method: 'POST', url: '/api/v1/__test/write', headers: bearer(token) })
    expect(write.statusCode).toBe(403)
    expect(write.json<{ error: { code: string } }>().error.code).toBe('LICENSE_INVALID')
    // Reads keep working: data is never locked away.
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(token) })).statusCode).toBe(200)
    // The on-prem-only catalogued route exists in this mode.
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/__test/onprem-only', headers: bearer(token) })).statusCode).toBe(200)

    await storeLicense(t.deps.db.systemDb, doc, licenseKey)
    t.deps.entitlements.invalidate()
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/__test/write', headers: bearer(token) })).statusCode).toBe(200)
  })
})
