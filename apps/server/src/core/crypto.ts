/**
 * Cryptographic helpers (ARCHITECTURE.md §8.5, §11.1, §17).
 *
 * SecretBox — AES-256-GCM envelopes for secrets at rest (payment provider credentials, webhook
 * secrets): `v1:<kid>:<iv>:<tag>:<ciphertext>` (base64url parts). The key ring comes from
 * KADAI_ENCRYPTION_KEYS: the first key encrypts, every key decrypts, so keys rotate by
 * prepending a new key and re-encrypting rows whose `needsReencrypt()` is true. An optional AAD
 * (e.g. `<tenant_id>:<column>`) binds a ciphertext to its row so it cannot be copied elsewhere.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { EncryptionKey } from '../config'

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DecryptionError'
  }
}

export class SecretBox {
  private readonly keys: ReadonlyMap<string, Buffer>
  readonly activeKid: string

  constructor(ring: readonly EncryptionKey[]) {
    const first = ring[0]
    if (!first) throw new Error('SecretBox needs at least one key')
    for (const k of ring) {
      if (k.key.length !== 32) throw new Error(`encryption key ${k.kid} must be 32 bytes`)
    }
    this.keys = new Map(ring.map((k) => [k.kid, k.key]))
    this.activeKid = first.kid
  }

  encrypt(plaintext: string | Buffer, aad?: string): string {
    const key = this.keys.get(this.activeKid)!
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ct = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, this.activeKid, b64u(iv), b64u(tag), b64u(ct)].join(':')
  }

  decryptToBuffer(envelope: string, aad?: string): Buffer {
    const parts = envelope.split(':')
    if (parts.length !== 5 || parts[0] !== VERSION) throw new DecryptionError('malformed envelope')
    const [, kid, ivPart, tagPart, ctPart] = parts as [string, string, string, string, string]
    const key = this.keys.get(kid)
    if (!key) throw new DecryptionError(`unknown encryption key id "${kid}"`)
    const iv = fromB64u(ivPart)
    const tag = fromB64u(tagPart)
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError('malformed envelope')
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(fromB64u(ctPart)), decipher.final()])
    } catch (err) {
      throw new DecryptionError('ciphertext failed authentication (tampered or wrong key/AAD)', { cause: err })
    }
  }

  decrypt(envelope: string, aad?: string): string {
    return this.decryptToBuffer(envelope, aad).toString('utf8')
  }

  /** Encrypts a JSON value (credentials objects). */
  encryptJson(value: unknown, aad?: string): string {
    return this.encrypt(JSON.stringify(value), aad)
  }

  decryptJson(envelope: string, aad?: string): unknown {
    return JSON.parse(this.decrypt(envelope, aad)) as unknown
  }

  /** True when the envelope was produced by a key other than the active one. */
  needsReencrypt(envelope: string): boolean {
    return envelope.split(':')[1] !== this.activeKid
  }

  /** Decrypts with any key and re-encrypts with the active key (rotation). */
  reencrypt(envelope: string, aad?: string): string {
    return this.encrypt(this.decryptToBuffer(envelope, aad), aad)
  }
}

export function b64u(buf: Buffer): string {
  return buf.toString('base64url')
}

export function fromB64u(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new DecryptionError('invalid base64url')
  return Buffer.from(s, 'base64url')
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

export function hmacSha256(key: string | Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

/**
 * Constant-time string comparison. Both sides are hashed first so neither the content nor the
 * length of the secret leaks through timing.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}

/** URL-safe random token (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Derives a purpose-specific 32-byte key from a master secret (HKDF-SHA256). */
export function deriveKey(secret: string | Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from('kadai'), Buffer.from(purpose), 32))
}

/** JSON with object keys sorted recursively: stable input for hashes and signatures. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}
