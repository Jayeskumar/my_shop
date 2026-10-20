import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  configWarnings,
  isCloud,
  isOnPrem,
  loadConfig,
  parseEncryptionKeys,
} from './index'

const base = { DATABASE_URL: 'postgres://kadai_app:kadai_app@localhost:5432/kadai' }
const key32 = () => randomBytes(32).toString('base64')
const prodSecrets = {
  NODE_ENV: 'production',
  JWT_SECRET: 'p'.repeat(48),
  KADAI_ENCRYPTION_KEYS: `k2026:${key32()}`,
}

describe('loadConfig', () => {
  it('applies documented defaults (cloud)', () => {
    const c = loadConfig({ ...base })
    expect(c).toMatchObject({
      mode: 'cloud',
      nodeEnv: 'development',
      port: 8080,
      host: '0.0.0.0',
      migrateOnBoot: false,
      embeddedWorker: false,
      serveWeb: true,
      enableMockPayments: false,
      publicBaseUrl: 'http://localhost:8080',
      redisUrl: null,
      s3: null,
    })
    expect(c.database).toMatchObject({
      appRole: 'kadai_app',
      poolMax: 20,
      systemUrl: base.DATABASE_URL,
      systemUrlIsDefault: true,
    })
    expect(isCloud(c)).toBe(true)
    expect(configWarnings(c).join('\n')).toMatch(/DATABASE_SYSTEM_URL/)
    expect(Object.isFrozen(c.database)).toBe(true)
  })

  it('on-prem defaults: migrate on boot and embedded worker', () => {
    const c = loadConfig({ ...base, KADAI_MODE: 'onprem' })
    expect(isOnPrem(c)).toBe(true)
    expect(c.migrateOnBoot).toBe(true)
    expect(c.embeddedWorker).toBe(true)
    expect(
      loadConfig({ ...base, KADAI_MODE: 'onprem', KADAI_EMBEDDED_WORKER: 'false' }).embeddedWorker,
    ).toBe(false)
  })

  it('treats empty strings as unset and parses lists, booleans and numbers', () => {
    const c = loadConfig({
      ...base,
      S3_BUCKET: '',
      REDIS_URL: '',
      CORS_ORIGINS: 'https://app.kadai.in/, http://localhost:5173',
      KADAI_SERVE_WEB: 'no',
      PORT: '9090',
      TRUST_PROXY: '2',
    })
    expect(c.s3).toBeNull()
    expect(c.redisUrl).toBeNull()
    expect(c.corsOrigins).toEqual(['https://app.kadai.in', 'http://localhost:5173'])
    expect(c.serveWeb).toBe(false)
    expect(c.port).toBe(9090)
    expect(c.trustProxy).toBe(2)
  })

  it('reports every invalid variable at once', () => {
    try {
      loadConfig({ DATABASE_URL: 'mysql://x', KADAI_MODE: 'hybrid', PORT: 'eighty' })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      const issues = (err as ConfigError).issues.join('\n')
      expect(issues).toMatch(/DATABASE_URL/)
      expect(issues).toMatch(/KADAI_MODE/)
      expect(issues).toMatch(/PORT/)
    }
  })

  it('production guards: real secrets required, no mock payments', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/JWT_SECRET is required/)
    expect(() => loadConfig({ ...base, ...prodSecrets, JWT_SECRET: 'short' })).toThrow(
      /at least 32 bytes/,
    )
    expect(() => loadConfig({ ...base, ...prodSecrets, KADAI_ENCRYPTION_KEYS: '' })).toThrow(
      /KADAI_ENCRYPTION_KEYS is required/,
    )
    expect(() =>
      loadConfig({ ...base, ...prodSecrets, KADAI_ENABLE_MOCK_PAYMENTS: 'true' }),
    ).toThrow(/MOCK_PAYMENTS/)
    const c = loadConfig({ ...base, ...prodSecrets })
    expect(c.isProduction).toBe(true)
    expect(c.apiDocs).toBe(false)
    expect(c.healthRequireWorker).toBe(true)
  })

  it('development falls back to insecure dev secrets with warnings', () => {
    const c = loadConfig({ ...base })
    expect(c.auth.jwtSecret.length).toBeGreaterThanOrEqual(32)
    expect(c.encryptionKeys[0]?.key).toHaveLength(32)
    expect(configWarnings(c).some((w) => /JWT_SECRET/.test(w))).toBe(true)
  })

  it('warns that an OTLP endpoint is not exported by this build', () => {
    const quiet = loadConfig({ ...base })
    expect(configWarnings(quiet).some((w) => /OTEL/.test(w))).toBe(false)
    const c = loadConfig({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })
    expect(c.otelEndpoint).toBe('http://otel:4318')
    expect(configWarnings(c).some((w) => /OTEL_EXPORTER_OTLP_ENDPOINT/.test(w))).toBe(true)
  })
})

describe('parseEncryptionKeys', () => {
  it('parses a key ring (first = active)', () => {
    const ring = parseEncryptionKeys(`new:${key32()}, old:${key32()}`)
    expect(ring.map((k) => k.kid)).toEqual(['new', 'old'])
  })

  it('rejects bad entries', () => {
    expect(() => parseEncryptionKeys(`k1:${randomBytes(16).toString('base64')}`)).toThrow(
      /32 bytes/,
    )
    expect(() => parseEncryptionKeys(`k1:${key32()},k1:${key32()}`)).toThrow(/duplicate/)
    expect(() => parseEncryptionKeys('nokid')).toThrow(/kid:base64key/)
    expect(() => parseEncryptionKeys(`bad kid:${key32()}`)).toThrow(/invalid key id/)
  })
})
