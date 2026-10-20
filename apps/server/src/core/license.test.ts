import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId } from '@kadai/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { closeTestDb, getTestConfig, insertTestTenant, testDb } from '../test/helpers'
import { EntitlementsService } from './entitlements'
import {
  INSTALLATION_ID_KEY,
  type LicensePayload,
  type TrustedKey,
  getInstallationId,
  parsePublicKey,
  signLicense,
  storeLicense,
  trustedLicenseKeys,
  verifyLicense,
} from './license'

const here = path.dirname(fileURLToPath(import.meta.url))

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  license_id: 'LIC-2026-0001',
  licensee: 'Murugan Stores',
  business_name: 'Murugan Stores',
  plan_code: 'pro',
  max_stores: 2,
  valid_from: '2026-01-01',
  valid_until: '2026-12-31',
  issued_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('license signing & verification', () => {
  const kp = keypair()
  const keys: TrustedKey[] = [{ kid: 'test-1', key: parsePublicKey(kp.publicPem), devOnly: false }]

  it('verifies a correctly signed license', () => {
    const doc = signLicense(payload(), kp.privatePem, 'test-1')
    const res = verifyLicense(doc, { keys, production: true, today: '2026-06-01' })
    expect(res).toMatchObject({ ok: true, kid: 'test-1', license: { plan_code: 'pro', max_stores: 2 } })
  })

  it('detects tampering of any field, including unknown ones', () => {
    const doc = signLicense(payload(), kp.privatePem, 'test-1')
    const raised = { ...doc, license: { ...doc.license, max_stores: 50 } }
    expect(verifyLicense(raised, { keys, production: true, today: '2026-06-01' })).toMatchObject({ ok: false, reason: 'bad_signature' })
    const extra = { ...doc, license: { ...doc.license, sneaky: true } }
    expect(verifyLicense(extra, { keys, production: true, today: '2026-06-01' })).toMatchObject({ ok: false, reason: 'bad_signature' })
    const badSig = { ...doc, signature: Buffer.alloc(64).toString('base64') }
    expect(verifyLicense(badSig, { keys, production: true, today: '2026-06-01' })).toMatchObject({ ok: false, reason: 'bad_signature' })
  })

  it('rejects licenses signed by an unknown key or a foreign keypair', () => {
    const other = keypair()
    const doc = signLicense(payload(), other.privatePem, 'test-1')
    expect(verifyLicense(doc, { keys, production: true, today: '2026-06-01' })).toMatchObject({ ok: false, reason: 'bad_signature' })
    const unknownKid = signLicense(payload(), kp.privatePem, 'nope')
    expect(verifyLicense(unknownKid, { keys, production: true, today: '2026-06-01' })).toMatchObject({ ok: false, reason: 'unknown_key' })
  })

  it('enforces the validity window (inclusive) and perpetual licenses', () => {
    const doc = signLicense(payload(), kp.privatePem, 'test-1')
    expect(verifyLicense(doc, { keys, production: true, today: '2026-12-31' }).ok).toBe(true)
    expect(verifyLicense(doc, { keys, production: true, today: '2027-01-01' })).toMatchObject({ ok: false, reason: 'expired' })
    expect(verifyLicense(doc, { keys, production: true, today: '2025-12-31' })).toMatchObject({ ok: false, reason: 'not_yet_valid' })
    const perpetual = signLicense(payload({ valid_until: null }), kp.privatePem, 'test-1')
    expect(verifyLicense(perpetual, { keys, production: true, today: '2099-01-01' }).ok).toBe(true)
  })

  it('binds to an installation when installation_id is set', () => {
    const doc = signLicense(payload({ installation_id: 'inst-1' }), kp.privatePem, 'test-1')
    expect(verifyLicense(doc, { keys, production: true, today: '2026-06-01', installationId: 'inst-1' }).ok).toBe(true)
    expect(verifyLicense(doc, { keys, production: true, today: '2026-06-01', installationId: 'inst-2' })).toMatchObject({ ok: false, reason: 'installation_mismatch' })
  })

  it('rejects malformed documents', () => {
    expect(verifyLicense({ hello: 'world' }, { keys, production: true })).toMatchObject({ ok: false, reason: 'malformed' })
    expect(verifyLicense(null, { keys, production: true })).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('the embedded dev key verifies dev-signed licenses outside production only', async () => {
    const devPrivate = await readFile(path.resolve(here, '../../scripts/dev-keys/license-dev-2026.private.pem'), 'utf8')
    const doc = signLicense(payload(), devPrivate, 'dev-2026')
    const embedded = trustedLicenseKeys(null)
    expect(verifyLicense(doc, { keys: embedded, production: false, today: '2026-06-01' }).ok).toBe(true)
    expect(verifyLicense(doc, { keys: embedded, production: true, today: '2026-06-01' })).toMatchObject({ ok: false, reason: 'dev_key_in_production' })
  })

  it('KADAI_LICENSE_PUBLIC_KEY override accepts PEM or base64 SPKI and replaces embedded keys', () => {
    const der = parsePublicKey(kp.publicPem).export({ type: 'spki', format: 'der' }).toString('base64')
    const viaDer = trustedLicenseKeys(der)
    expect(viaDer).toHaveLength(1)
    const doc = signLicense(payload(), kp.privatePem, 'anything')
    expect(verifyLicense(doc, { keys: viaDer, production: true, today: '2026-06-01' }).ok).toBe(true)
  })
})

describe('on-prem entitlements from the license', () => {
  const kp = keypair()
  // A private system_settings key per run: the real 'license' row is never touched.
  const licenseKey = `license_test_${newId()}`

  afterAll(async () => {
    await testDb().systemDb.deleteFrom('system_settings').where('key', '=', licenseKey).execute()
    await closeTestDb()
  })

  const service = () =>
    new EntitlementsService({
      config: { ...getTestConfig({ KADAI_MODE: 'onprem' }), licensePublicKey: kp.publicPem },
      systemDb: testDb().systemDb,
      ttlMs: 0,
      today: () => '2026-06-01',
      licenseSettingsKey: licenseKey,
    })

  it('no license → Free plan, writable', async () => {
    const tenant = await insertTestTenant(testDb().systemDb)
    const ent = await service().get(tenant.tenant.id)
    expect(ent).toMatchObject({ plan_code: 'free', source: 'license', read_only: false, license_status: 'missing' })
    expect(ent.limits.invoices_per_month).toBe(300)
  })

  it('valid license → its plan with max_stores and limit overrides', async () => {
    const { systemDb } = testDb()
    const installationId = await getInstallationId(systemDb)
    expect(await getInstallationId(systemDb)).toBe(installationId)
    await storeLicense(systemDb, signLicense(payload({ installation_id: installationId, limits: { users: 40 } }), kp.privatePem, 'k'), licenseKey)
    const tenant = await insertTestTenant(systemDb)
    const ent = await service().get(tenant.tenant.id)
    expect(ent).toMatchObject({ plan_code: 'pro', read_only: false, license_status: 'valid' })
    expect(ent.limits).toMatchObject({ stores: 2, users: 40, registers: 15 })
    expect(ent.features.has('api_access')).toBe(true)
    expect(ent.valid_until).toBe('2026-12-31T23:59:59.999+05:30')
  })

  it('tampered license → Free plan and read-only', async () => {
    const { systemDb } = testDb()
    const doc = signLicense(payload(), kp.privatePem, 'k')
    await storeLicense(systemDb, { ...doc, license: { ...doc.license, plan_code: 'enterprise' } }, licenseKey)
    const tenant = await insertTestTenant(systemDb)
    const ent = await service().get(tenant.tenant.id)
    expect(ent).toMatchObject({ plan_code: 'free', read_only: true, license_status: 'bad_signature' })
  })

  it('expired license → Free plan but still writable', async () => {
    const { systemDb } = testDb()
    await storeLicense(systemDb, signLicense(payload({ valid_until: '2026-03-31' }), kp.privatePem, 'k'), licenseKey)
    const tenant = await insertTestTenant(systemDb)
    const ent = await service().get(tenant.tenant.id)
    expect(ent).toMatchObject({ plan_code: 'free', read_only: false, license_status: 'expired' })
  })

  it('stores the installation id once', async () => {
    const rows = await testDb().systemDb.selectFrom('system_settings').select('key').where('key', '=', INSTALLATION_ID_KEY).execute()
    expect(rows).toHaveLength(1)
  })
})
