import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DecryptionError, SecretBox, canonicalJson, deriveKey, hmacSha256Hex, randomToken, sha256Hex, timingSafeEqualStr } from './crypto'

const key = (kid: string) => ({ kid, key: randomBytes(32) })

describe('SecretBox (AES-256-GCM envelopes)', () => {
  const k1 = key('k1')
  const k2 = key('k2')

  it('round-trips strings, buffers and JSON', () => {
    const box = new SecretBox([k1])
    const env = box.encrypt('rzp_live_secret_ಠ_தமிழ்')
    expect(env).toMatch(/^v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    expect(box.decrypt(env)).toBe('rzp_live_secret_ಠ_தமிழ்')
    expect(box.decryptToBuffer(box.encrypt(Buffer.from([0, 1, 2]))).equals(Buffer.from([0, 1, 2]))).toBe(true)
    expect(box.decryptJson(box.encryptJson({ key_id: 'rzp', key_secret: 's' }))).toEqual({ key_id: 'rzp', key_secret: 's' })
  })

  it('uses a fresh IV every time', () => {
    const box = new SecretBox([k1])
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'))
  })

  it('detects tampering of ciphertext, tag, IV and key id', () => {
    const box = new SecretBox([k1, k2])
    const env = box.encrypt('payload')
    const parts = env.split(':')
    const flip = (s: string) => (s[0] === 'A' ? `B${s.slice(1)}` : `A${s.slice(1)}`)
    for (const idx of [2, 3, 4]) {
      const tampered = [...parts]
      tampered[idx] = flip(tampered[idx]!)
      expect(() => box.decrypt(tampered.join(':'))).toThrow(DecryptionError)
    }
    const otherKid = [...parts]
    otherKid[1] = 'k2'
    expect(() => box.decrypt(otherKid.join(':'))).toThrow(DecryptionError)
    expect(() => box.decrypt('v2:k1:a:b:c')).toThrow(DecryptionError)
    expect(() => box.decrypt('garbage')).toThrow(DecryptionError)
  })

  it('binds ciphertexts to their AAD', () => {
    const box = new SecretBox([k1])
    const env = box.encrypt('secret', 'tenant-a:credentials')
    expect(box.decrypt(env, 'tenant-a:credentials')).toBe('secret')
    expect(() => box.decrypt(env, 'tenant-b:credentials')).toThrow(DecryptionError)
    expect(() => box.decrypt(env)).toThrow(DecryptionError)
  })

  it('rotates keys: old ciphertexts decrypt with the ring, re-encrypt with the new active key', () => {
    const old = new SecretBox([k1])
    const env = old.encrypt('v')
    const rotated = new SecretBox([k2, k1])
    expect(rotated.decrypt(env)).toBe('v')
    expect(rotated.needsReencrypt(env)).toBe(true)
    const re = rotated.reencrypt(env)
    expect(re.startsWith('v1:k2:')).toBe(true)
    expect(rotated.needsReencrypt(re)).toBe(false)
    // A ring without the old key cannot decrypt it.
    expect(() => new SecretBox([k2]).decrypt(env)).toThrow(/unknown encryption key/)
  })

  it('rejects bad key material', () => {
    expect(() => new SecretBox([])).toThrow()
    expect(() => new SecretBox([{ kid: 'x', key: randomBytes(16) }])).toThrow(/32 bytes/)
  })
})

describe('hash helpers', () => {
  it('sha256Hex / hmacSha256Hex match known vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // RFC 4231 test case 2
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  })

  it('timingSafeEqualStr compares exactly', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true)
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false)
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualStr('', '')).toBe(true)
  })

  it('randomToken is url-safe with the requested entropy', () => {
    const t = randomToken(32)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(randomToken())
  })

  it('deriveKey is deterministic and purpose-separated', () => {
    expect(deriveKey('s', 'otp').equals(deriveKey('s', 'otp'))).toBe(true)
    expect(deriveKey('s', 'otp').equals(deriveKey('s', 'cookie'))).toBe(false)
    expect(deriveKey('s', 'otp')).toHaveLength(32)
  })

  it('canonicalJson sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}')
  })
})
