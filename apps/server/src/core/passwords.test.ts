import { describe, expect, it } from 'vitest'
import {
  ARGON2_PARAMS,
  assertPasswordPolicy,
  hashPassword,
  hashPin,
  isWeakPin,
  needsRehash,
  passwordPolicyIssues,
  verifyPassword,
  verifyPasswordOrDummy,
  verifyPin,
} from './passwords'

describe('passwords (argon2id)', () => {
  it('hashes with argon2id m=19456,t=2,p=1 and verifies', async () => {
    const h = await hashPassword('kadai-strong-pass')
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(ARGON2_PARAMS).toMatchObject({ memoryCost: 19456, timeCost: 2, parallelism: 1 })
    expect(await verifyPassword(h, 'kadai-strong-pass')).toBe(true)
    expect(await verifyPassword(h, 'kadai-strong-pasS')).toBe(false)
    expect(needsRehash(h)).toBe(false)
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$abc$def')).toBe(true)
  })

  it('normalises Unicode (Tamil passwords typed on different keyboards)', async () => {
    const composed = 'கடைொ' // vowel sign O as one code point
    const decomposed = 'கடைொ' // same, as two code points
    const h = await hashPassword(`${composed}-secret`)
    expect(await verifyPassword(h, `${decomposed}-secret`)).toBe(true)
  })

  it('never throws on malformed hashes and burns time for unknown users', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false)
    expect(await verifyPasswordOrDummy(null, 'whatever')).toBe(false)
    const h = await hashPassword('right-password')
    expect(await verifyPasswordOrDummy(h, 'right-password')).toBe(true)
  })

  it('PINs: 4–6 digits, hashed, weak ones detectable', async () => {
    const h = await hashPin('4826')
    expect(await verifyPin(h, '4826')).toBe(true)
    expect(await verifyPin(h, '4827')).toBe(false)
    expect(await verifyPin(h, 'abcd')).toBe(false)
    await expect(hashPin('12')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(isWeakPin('1111')).toBe(true)
    expect(isWeakPin('1234')).toBe(true)
    expect(isWeakPin('654321')).toBe(true)
    expect(isWeakPin('4826')).toBe(false)
  })
})

describe('password policy', () => {
  it('accepts reasonable passwords', () => {
    expect(passwordPolicyIssues('Murugan@Stores2026')).toEqual([])
  })

  it('rejects short, repeated, common and personal passwords', () => {
    expect(passwordPolicyIssues('short').map((i) => i.code)).toContain('too_short')
    expect(passwordPolicyIssues('aaaaaaaaaa').map((i) => i.code)).toContain('repeated')
    expect(passwordPolicyIssues('Password123').map((i) => i.code)).toContain('common')
    expect(
      passwordPolicyIssues('shop9876543210', { phone: '+919876543210' }).map((i) => i.code),
    ).toContain('contains_phone')
    expect(
      passwordPolicyIssues('selvam-secret-1', { email: 'selvam@example.in' }).map((i) => i.code),
    ).toContain('contains_email')
    expect(() => assertPasswordPolicy('12345678', {}, 'new_password')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })
})
