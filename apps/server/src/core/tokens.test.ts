import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestTenant, closeTestDb, getTestConfig, insertTestTenant, testDb } from '../test/helpers'
import { AppError } from './errors'
import {
  createSession,
  generateApiKey,
  hashApiKey,
  hashRefreshToken,
  parseApiKey,
  revokeFamily,
  revokeSessions,
  rotateSession,
  signAccessToken,
  verifyAccessToken,
} from './tokens'

const config = getTestConfig()

describe('access tokens (HS256 JWT)', () => {
  const claims = { userId: newId(), tenantId: newId(), membershipId: newId(), sessionId: newId(), deviceId: null, amr: ['password' as const] }

  it('signs and verifies the documented claims', async () => {
    const { token, expiresIn } = await signAccessToken(config, claims)
    expect(expiresIn).toBe(900)
    const c = await verifyAccessToken(config, token)
    expect(c).toMatchObject({ sub: claims.userId, tid: claims.tenantId, mid: claims.membershipId, sid: claims.sessionId, did: null, amr: ['password'] })
    expect(c.exp! - c.iat!).toBe(900)
  })

  it('rejects expired tokens', async () => {
    const { token } = await signAccessToken(config, claims, { ttlSeconds: 60, now: new Date(Date.now() - 120_000) })
    await expect(verifyAccessToken(config, token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Access token expired' })
  })

  it('rejects tokens signed with another secret or with tampered claims', async () => {
    const { token } = await signAccessToken({ auth: { ...config.auth, jwtSecret: 'another-secret-another-secret-123456' } }, claims)
    await expect(verifyAccessToken(config, token)).rejects.toBeInstanceOf(AppError)
    const { token: good } = await signAccessToken(config, claims)
    const [h, p, s] = good.split('.')
    const forged = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>
    forged.tid = newId()
    const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`
    await expect(verifyAccessToken(config, tampered)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('supports tenant-less tokens', async () => {
    const { token } = await signAccessToken(config, { ...claims, tenantId: null, membershipId: null })
    expect(await verifyAccessToken(config, token)).toMatchObject({ tid: null, mid: null })
  })
})

describe('refresh sessions: rotation & reuse detection', () => {
  let shop: TestTenant
  beforeAll(async () => {
    shop = await insertTestTenant(testDb().systemDb)
  })
  afterAll(() => closeTestDb())

  const create = () =>
    createSession(testDb().systemDb, config, { userId: shop.owner.user_id, tenantId: shop.tenant.id, authMethod: 'password', ip: '10.0.0.5', userAgent: 'test' })

  it('stores only the sha256 of the refresh token', async () => {
    const s = await create()
    expect(s.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const row = await testDb().systemDb.selectFrom('auth_sessions').selectAll().where('id', '=', s.sessionId).executeTakeFirstOrThrow()
    expect(row.refresh_token_hash).toBe(hashRefreshToken(s.refreshToken))
    expect(row.refresh_token_hash).not.toContain(s.refreshToken)
    expect(row.ip).toBe('10.0.0.5')
  })

  it('rotates: a new token in the same family, the old one marked rotated', async () => {
    const s = await create()
    const r = await rotateSession(testDb().systemDb, config, s.refreshToken)
    expect(r.familyId).toBe(s.familyId)
    expect(r.sessionId).not.toBe(s.sessionId)
    expect(r.previousSessionId).toBe(s.sessionId)
    const old = await testDb().systemDb.selectFrom('auth_sessions').selectAll().where('id', '=', s.sessionId).executeTakeFirstOrThrow()
    expect(old).toMatchObject({ revoked_reason: 'rotated', replaced_by: r.sessionId })
    const r2 = await rotateSession(testDb().systemDb, config, r.refreshToken)
    expect(r2.familyId).toBe(s.familyId)
  })

  it('reuse of a rotated token revokes the whole family', async () => {
    const s = await create()
    const r = await rotateSession(testDb().systemDb, config, s.refreshToken)
    await expect(rotateSession(testDb().systemDb, config, s.refreshToken)).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    // The legitimate (latest) token is dead too.
    await expect(rotateSession(testDb().systemDb, config, r.refreshToken)).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    const live = await testDb().systemDb.selectFrom('auth_sessions').select('id').where('family_id', '=', s.familyId).where('revoked_at', 'is', null).execute()
    expect(live).toEqual([])
    const reasons = await testDb().systemDb.selectFrom('auth_sessions').select('revoked_reason').where('family_id', '=', s.familyId).execute()
    expect(reasons.map((x) => x.revoked_reason).sort()).toEqual(['reuse_detected', 'rotated'])
  })

  it('rejects unknown and expired refresh tokens', async () => {
    await expect(rotateSession(testDb().systemDb, config, 'x'.repeat(43))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    const s = await createSession(testDb().systemDb, config, { userId: shop.owner.user_id, tenantId: null, authMethod: 'otp', ttlDays: 1 })
    await testDb().systemDb.updateTable('auth_sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', s.sessionId).execute()
    await expect(rotateSession(testDb().systemDb, config, s.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('revokeFamily / revokeSessions (logout, logout everywhere)', async () => {
    const a = await create()
    const b = await create()
    expect(await revokeFamily(testDb().systemDb, a.familyId)).toEqual([a.sessionId])
    await expect(rotateSession(testDb().systemDb, config, a.refreshToken)).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
    const revoked = await revokeSessions(testDb().systemDb, shop.owner.user_id, { exceptSessionId: b.sessionId })
    expect(revoked).not.toContain(b.sessionId)
    expect((await rotateSession(testDb().systemDb, config, b.refreshToken)).familyId).toBe(b.familyId)
  })
})

describe('API keys', () => {
  it('generates kd_<mode>_<prefix>_<secret> keys with matching prefix and hash', () => {
    const k = generateApiKey('live')
    expect(k.key).toMatch(/^kd_live_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/)
    expect(parseApiKey(k.key)).toEqual({ mode: 'live', keyPrefix: k.keyPrefix })
    expect(hashApiKey(k.key)).toBe(k.keyHash)
    expect(generateApiKey('test').key.startsWith('kd_test_')).toBe(true)
    expect(parseApiKey('kd_prod_abc_def')).toBeNull()
    expect(parseApiKey('Bearer xyz')).toBeNull()
  })
})
