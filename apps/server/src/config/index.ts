/**
 * Server configuration (ARCHITECTURE.md §19): environment variables validated with zod into a
 * typed, frozen {@link Config}. Code branches on deployment mode only through `config.mode` and
 * {@link isCloud} / {@link isOnPrem}; feature checks go through the entitlements service.
 */
import { createPrivateKey } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { isValidGstin, isValidStateCode, normalizeGstin } from '@kadai/shared'

export type DeploymentMode = 'cloud' | 'onprem'
export type NodeEnv = 'development' | 'test' | 'production'
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

export interface EncryptionKey {
  /** Key id embedded in every envelope (`v1:<kid>:…`). */
  kid: string
  /** 32-byte AES-256 key. */
  key: Buffer
}

export interface S3Config {
  bucket: string
  region: string
  endpoint: string | null
  accessKeyId: string | null
  secretAccessKey: string | null
  forcePathStyle: boolean
}

export interface VendorConfig {
  /** KADAI_VENDOR_CONSOLE: serve the vendor console (/api/v1/platform/*) and public licensing API. */
  console: boolean
  /** KADAI_LICENSE_SIGNING_KEY: signs on-prem licences (kadai-license-v1); vendor secret. */
  licenseSigningKey: string | null
  /** KADAI_LICENSE_SIGNING_KID: key id written into licences (must be trusted by shop servers). */
  licenseSigningKid: string
  /** KADAI_RELEASE_SIGNING_KEY: signs release artifacts (sha256|version|platform). */
  releaseSigningKey: string | null
  /** KADAI_VENDOR_STATE_CODE: our GST state (place-of-supply comparison), default '33'. */
  stateCode: string
  /** KADAI_VENDOR_GSTIN: our GSTIN on tax invoices (must belong to stateCode). */
  gstin: string | null
  /**
   * Encrypted on-prem cloud backups (add-on): KADAI_BACKUP_S3_BUCKET; region, endpoint and
   * credentials from the S3_* variables. null = cloud backup storage is not offered.
   */
  backupS3: S3Config | null
}

export interface Config {
  mode: DeploymentMode
  nodeEnv: NodeEnv
  isProduction: boolean
  port: number
  host: string
  logLevel: LogLevel
  /** Pretty, human-readable logs (development on a TTY by default). */
  logPretty: boolean
  /** Fastify `trustProxy`: true, false, a hop count or a list of trusted addresses / CIDRs. */
  trustProxy: boolean | number | string[]
  /** Maximum JSON request body size in bytes. */
  bodyLimitBytes: number

  database: {
    /** Runtime role (RLS enforced). */
    url: string
    /** Table-owner role (migrations, cross-tenant lookups, jobs). */
    systemUrl: string
    /** True when DATABASE_SYSTEM_URL was not set and the runtime URL is used for both pools. */
    systemUrlIsDefault: boolean
    appRole: string
    poolMax: number
    systemPoolMax: number
    /** Default per-statement timeout for pooled connections and tenant transactions. */
    statementTimeoutMs: number
    /** Abort transactions left idle by a crashed handler. */
    idleInTransactionTimeoutMs: number
  }
  migrateOnBoot: boolean

  auth: {
    jwtSecret: string
    accessTokenTtlSeconds: number
    refreshTokenTtlDays: number
  }
  /** AES-256-GCM key ring; the first key encrypts, all keys decrypt. */
  encryptionKeys: readonly EncryptionKey[]

  publicBaseUrl: string
  corsOrigins: readonly string[]
  redisUrl: string | null
  /** Absolute path of the data directory (files, backups). */
  dataDir: string
  s3: S3Config | null

  serveWeb: boolean
  /** Absolute path of the built web app (apps/web/dist). */
  webDistDir: string
  embeddedWorker: boolean
  /** /health/ready fails when the worker heartbeat is stale. */
  healthRequireWorker: boolean
  /** Ed25519 public key (PEM or base64 SPKI DER) overriding the embedded license keys. */
  licensePublicKey: string | null
  /**
   * On-prem first-run wizard: when set, POST /setup must carry this token (shown by the
   * installer), so another PC on the LAN cannot claim a fresh installation first.
   */
  setupToken: string | null

  rateLimit: {
    /** Requests per minute per user (or IP for anonymous requests) on /api, /public, /webhooks. */
    globalMax: number
  }

  sms: {
    provider: 'log' | 'msg91'
    msg91: {
      authKey: string | null
      senderId: string | null
      dltEntityId: string | null
      otpTemplateId: string | null
    }
  }
  whatsapp: {
    provider: 'log' | 'whatsapp_cloud'
    phoneNumberId: string | null
    accessToken: string | null
    apiVersion: string
    appSecret: string | null
    webhookVerifyToken: string | null
  }
  email: {
    provider: 'log' | 'smtp'
    smtpUrl: string | null
    from: string
  }
  razorpayPlatform: {
    keyId: string | null
    keySecret: string | null
    webhookSecret: string | null
  }
  enableMockPayments: boolean

  /**
   * Vendor control plane (licensing module, ARCHITECTURE.md §21) — only our cloud deployment
   * sets KADAI_VENDOR_CONSOLE=true. Keys are Ed25519 private keys (PKCS8 PEM, or base64 DER).
   */
  vendor: VendorConfig

  metricsToken: string | null
  apiDocs: boolean
  otelEndpoint: string | null
}

/** Used only outside production when JWT_SECRET is not set. */
const DEV_JWT_SECRET = 'kadai-insecure-development-jwt-secret-do-not-use-in-production'
/** Used only outside production when KADAI_ENCRYPTION_KEYS is not set (32 zero-ish bytes). */
const DEV_ENCRYPTION_KEYS = `devonly:${Buffer.from('kadai-insecure-dev-encryption-k!').toString('base64')}`

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length ? `${message}\n  - ${issues.join('\n  - ')}` : message)
    this.name = 'ConfigError'
  }
}

// ---------------------------------------------------------------------------------------------
// Env parsing helpers (empty strings count as "not set": `S3_BUCKET=` in .env files)
// ---------------------------------------------------------------------------------------------

const optionalString = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim()
    return t ? t : undefined
  })

const envBool = (fallback: boolean | undefined) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return fallback
    const s = v.toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(s)) return true
    if (['false', '0', 'no', 'off'].includes(s)) return false
    ctx.addIssue({ code: 'custom', message: `expected a boolean, got "${v}"` })
    return z.NEVER
  })

const envInt = (fallback: number, min: number, max: number) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({ code: 'custom', message: `expected an integer ${min}..${max}, got "${v}"` })
      return z.NEVER
    }
    return n
  })

const postgresUrl = z
  .string()
  .trim()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// connection URL')

const EnvSchema = z.object({
  KADAI_MODE: optionalString.pipe(z.enum(['cloud', 'onprem']).default('cloud')),
  NODE_ENV: optionalString.pipe(
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: envInt(8080, 1, 65_535),
  HOST: optionalString.transform((v) => v ?? '0.0.0.0'),
  LOG_LEVEL: optionalString.pipe(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  LOG_PRETTY: envBool(undefined),
  TRUST_PROXY: optionalString,
  BODY_LIMIT_BYTES: envInt(1_048_576, 1024, 64 * 1_048_576),

  DATABASE_URL: postgresUrl,
  DATABASE_SYSTEM_URL: optionalString.pipe(postgresUrl.optional()),
  DATABASE_APP_ROLE: optionalString
    .transform((v) => v ?? 'kadai_app')
    .pipe(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a plain lower-case role name')),
  DATABASE_POOL_MAX: envInt(20, 1, 500),
  DATABASE_SYSTEM_POOL_MAX: envInt(10, 1, 200),
  DATABASE_STATEMENT_TIMEOUT_MS: envInt(15_000, 100, 3_600_000),
  DATABASE_IDLE_TX_TIMEOUT_MS: envInt(60_000, 1000, 3_600_000),
  KADAI_MIGRATE_ON_BOOT: envBool(undefined),

  JWT_SECRET: optionalString,
  ACCESS_TOKEN_TTL_SECONDS: envInt(900, 60, 86_400),
  REFRESH_TOKEN_TTL_DAYS: envInt(30, 1, 365),
  KADAI_ENCRYPTION_KEYS: optionalString,

  PUBLIC_BASE_URL: optionalString.transform((v) =>
    (v ?? 'http://localhost:8080').replace(/\/+$/, ''),
  ),
  CORS_ORIGINS: optionalString,
  REDIS_URL: optionalString,
  KADAI_DATA_DIR: optionalString.transform((v) => v ?? './data'),

  S3_BUCKET: optionalString,
  S3_REGION: optionalString.transform((v) => v ?? 'ap-south-1'),
  S3_ENDPOINT: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: envBool(false),

  KADAI_SERVE_WEB: envBool(true),
  KADAI_WEB_DIST: optionalString,
  KADAI_EMBEDDED_WORKER: envBool(undefined),
  KADAI_HEALTH_REQUIRE_WORKER: envBool(undefined),
  KADAI_LICENSE_PUBLIC_KEY: optionalString,
  KADAI_SETUP_TOKEN: optionalString.pipe(
    z.string().min(8, 'must be at least 8 characters').max(200).optional(),
  ),
  RATE_LIMIT_GLOBAL_MAX: envInt(600, 1, 1_000_000),

  SMS_PROVIDER: optionalString.pipe(z.enum(['log', 'msg91']).default('log')),
  MSG91_AUTH_KEY: optionalString,
  MSG91_SENDER_ID: optionalString,
  MSG91_DLT_ENTITY_ID: optionalString,
  MSG91_OTP_TEMPLATE_ID: optionalString,
  WHATSAPP_PROVIDER: optionalString.pipe(z.enum(['log', 'whatsapp_cloud']).default('log')),
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_API_VERSION: optionalString.transform((v) => v ?? 'v21.0'),
  WHATSAPP_APP_SECRET: optionalString,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalString,
  EMAIL_PROVIDER: optionalString.pipe(z.enum(['log', 'smtp']).default('log')),
  SMTP_URL: optionalString,
  SMTP_FROM: optionalString.transform((v) => v ?? 'Kadai <no-reply@localhost>'),
  RAZORPAY_PLATFORM_KEY_ID: optionalString,
  RAZORPAY_PLATFORM_KEY_SECRET: optionalString,
  RAZORPAY_PLATFORM_WEBHOOK_SECRET: optionalString,
  KADAI_ENABLE_MOCK_PAYMENTS: envBool(false),

  KADAI_VENDOR_CONSOLE: envBool(false),
  KADAI_LICENSE_SIGNING_KEY: optionalString,
  KADAI_LICENSE_SIGNING_KID: optionalString.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, 'must be 1-64 characters A-Z a-z 0-9 . _ -')
      .optional(),
  ),
  KADAI_RELEASE_SIGNING_KEY: optionalString,
  KADAI_VENDOR_STATE_CODE: optionalString,
  KADAI_VENDOR_GSTIN: optionalString,
  KADAI_BACKUP_S3_BUCKET: optionalString,

  METRICS_TOKEN: optionalString,
  KADAI_API_DOCS: envBool(undefined),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
})

/** Parses `kid1:base64key,kid2:…`; every key must decode to exactly 32 bytes. */
export function parseEncryptionKeys(raw: string): EncryptionKey[] {
  const keys: EncryptionKey[] = []
  const seen = new Set<string>()
  for (const part of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const idx = part.indexOf(':')
    if (idx <= 0)
      throw new ConfigError(
        `KADAI_ENCRYPTION_KEYS: entry "${part.slice(0, 8)}…" must be kid:base64key`,
      )
    const kid = part.slice(0, idx)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) {
      throw new ConfigError(
        `KADAI_ENCRYPTION_KEYS: invalid key id "${kid}" (use A-Z a-z 0-9 _ -, max 32)`,
      )
    }
    if (seen.has(kid)) throw new ConfigError(`KADAI_ENCRYPTION_KEYS: duplicate key id "${kid}"`)
    const key = Buffer.from(part.slice(idx + 1), 'base64')
    if (key.length !== 32) {
      throw new ConfigError(
        `KADAI_ENCRYPTION_KEYS: key "${kid}" must be 32 bytes (got ${key.length})`,
      )
    }
    seen.add(kid)
    keys.push({ kid, key })
  }
  if (keys.length === 0) throw new ConfigError('KADAI_ENCRYPTION_KEYS is empty')
  return keys
}

/**
 * Normalises an Ed25519 private key from the environment (PKCS8 PEM — literal `\\n` escapes
 * allowed — or base64 of the PKCS8 DER) to PEM. Throws ConfigError when it is not Ed25519.
 */
export function parseEd25519PrivateKey(raw: string, name: string): string {
  const text = raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n').trim() : raw.trim()
  try {
    const key = text.includes('-----BEGIN')
      ? createPrivateKey(text)
      : createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' })
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519')
    return key.export({ format: 'pem', type: 'pkcs8' }).toString()
  } catch {
    throw new ConfigError(`${name} must be an Ed25519 private key (PKCS8 PEM or base64 DER)`)
  }
}

function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined) return false
  const s = raw.toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^\d+$/.test(s)) return Number(s)
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/** Repository root (directory holding pnpm-workspace.yaml) found by walking up from `start`. */
export function findRepoRoot(
  start: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  let dir = path.resolve(start)
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Loads `<repo root>/.env` into process.env (existing variables win) outside production.
 * Production deployments get their environment from the container / service manager only.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') return null
  const roots = [findRepoRoot(process.cwd()), findRepoRoot()].filter((r): r is string => r !== null)
  for (const root of roots) {
    const file = path.join(root, '.env')
    if (existsSync(file)) {
      process.loadEnvFile(file)
      return file
    }
  }
  return null
}

function defaultWebDist(): string {
  const root = findRepoRoot()
  return root ? path.join(root, 'apps/web/dist') : path.resolve('apps/web/dist')
}

/**
 * Validates the environment into a frozen Config. When `env` is `process.env` (the default) the
 * repo-root `.env` is loaded first outside production. Throws {@link ConfigError} listing every
 * problem at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv(env)
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(
      'Invalid server configuration',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    )
  }
  const e = parsed.data
  const isProduction = e.NODE_ENV === 'production'
  const mode = e.KADAI_MODE
  const issues: string[] = []

  // Production guards: refuse to boot with development secrets or test-only features.
  if (isProduction) {
    if (!e.JWT_SECRET) issues.push('JWT_SECRET is required in production')
    else if (Buffer.byteLength(e.JWT_SECRET) < 32)
      issues.push('JWT_SECRET must be at least 32 bytes')
    else if (e.JWT_SECRET === DEV_JWT_SECRET)
      issues.push('JWT_SECRET must not be the development default')
    if (!e.KADAI_ENCRYPTION_KEYS) issues.push('KADAI_ENCRYPTION_KEYS is required in production')
    if (e.KADAI_ENABLE_MOCK_PAYMENTS)
      issues.push('KADAI_ENABLE_MOCK_PAYMENTS must be false in production')
  } else if (e.JWT_SECRET && Buffer.byteLength(e.JWT_SECRET) < 32) {
    issues.push('JWT_SECRET must be at least 32 bytes')
  }
  if (e.S3_BUCKET && Boolean(e.S3_ACCESS_KEY_ID) !== Boolean(e.S3_SECRET_ACCESS_KEY)) {
    issues.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together')
  }
  if (e.SMS_PROVIDER === 'msg91' && (!e.MSG91_AUTH_KEY || !e.MSG91_OTP_TEMPLATE_ID)) {
    issues.push('SMS_PROVIDER=msg91 requires MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID')
  }

  // Vendor control plane (licensing module).
  const vendorStateCode = e.KADAI_VENDOR_STATE_CODE ?? '33'
  if (!isValidStateCode(vendorStateCode))
    issues.push(`KADAI_VENDOR_STATE_CODE "${vendorStateCode}" is not a GST state code`)
  const vendorGstin = e.KADAI_VENDOR_GSTIN ? normalizeGstin(e.KADAI_VENDOR_GSTIN) : null
  if (vendorGstin !== null) {
    if (!isValidGstin(vendorGstin)) issues.push('KADAI_VENDOR_GSTIN is not a valid GSTIN')
    else if (vendorGstin.slice(0, 2) !== vendorStateCode)
      issues.push('KADAI_VENDOR_GSTIN does not belong to KADAI_VENDOR_STATE_CODE')
  }
  const vendorKey = (name: string, raw: string | undefined): string | null => {
    if (!raw) return null
    try {
      return parseEd25519PrivateKey(raw, name)
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err))
      return null
    }
  }
  const licenseSigningKey = vendorKey('KADAI_LICENSE_SIGNING_KEY', e.KADAI_LICENSE_SIGNING_KEY)
  const releaseSigningKey = vendorKey('KADAI_RELEASE_SIGNING_KEY', e.KADAI_RELEASE_SIGNING_KEY)
  if (e.KADAI_VENDOR_CONSOLE) {
    if (mode !== 'cloud') issues.push('KADAI_VENDOR_CONSOLE requires KADAI_MODE=cloud')
    if (isProduction && !e.KADAI_LICENSE_SIGNING_KEY)
      issues.push('KADAI_LICENSE_SIGNING_KEY is required when KADAI_VENDOR_CONSOLE=true')
    if (isProduction && !e.KADAI_LICENSE_SIGNING_KID)
      issues.push('KADAI_LICENSE_SIGNING_KID is required when KADAI_VENDOR_CONSOLE=true')
  }

  let encryptionKeys: EncryptionKey[] = []
  try {
    encryptionKeys = parseEncryptionKeys(e.KADAI_ENCRYPTION_KEYS ?? DEV_ENCRYPTION_KEYS)
    if (isProduction && encryptionKeys.some((k) => k.kid === 'devonly')) {
      issues.push('KADAI_ENCRYPTION_KEYS must not use the development key')
    }
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err))
  }
  if (issues.length) throw new ConfigError('Invalid server configuration', issues)

  const corsOrigins = (e.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)

  const config: Config = {
    mode,
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY ?? (e.NODE_ENV === 'development' && Boolean(process.stdout.isTTY)),
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    database: {
      url: e.DATABASE_URL,
      systemUrl: e.DATABASE_SYSTEM_URL ?? e.DATABASE_URL,
      systemUrlIsDefault: !e.DATABASE_SYSTEM_URL,
      appRole: e.DATABASE_APP_ROLE,
      poolMax: e.DATABASE_POOL_MAX,
      systemPoolMax: e.DATABASE_SYSTEM_POOL_MAX,
      statementTimeoutMs: e.DATABASE_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: e.DATABASE_IDLE_TX_TIMEOUT_MS,
    },
    migrateOnBoot: e.KADAI_MIGRATE_ON_BOOT ?? mode === 'onprem',
    auth: {
      jwtSecret: e.JWT_SECRET ?? DEV_JWT_SECRET,
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    },
    encryptionKeys: Object.freeze(encryptionKeys),
    publicBaseUrl: e.PUBLIC_BASE_URL,
    corsOrigins: Object.freeze(corsOrigins),
    redisUrl: e.REDIS_URL ?? null,
    dataDir: path.resolve(e.KADAI_DATA_DIR),
    s3: e.S3_BUCKET
      ? {
          bucket: e.S3_BUCKET,
          region: e.S3_REGION,
          endpoint: e.S3_ENDPOINT ?? null,
          accessKeyId: e.S3_ACCESS_KEY_ID ?? null,
          secretAccessKey: e.S3_SECRET_ACCESS_KEY ?? null,
          forcePathStyle: e.S3_FORCE_PATH_STYLE ?? false,
        }
      : null,
    serveWeb: e.KADAI_SERVE_WEB ?? true,
    webDistDir: path.resolve(e.KADAI_WEB_DIST ?? defaultWebDist()),
    embeddedWorker: e.KADAI_EMBEDDED_WORKER ?? mode === 'onprem',
    healthRequireWorker: e.KADAI_HEALTH_REQUIRE_WORKER ?? isProduction,
    licensePublicKey: e.KADAI_LICENSE_PUBLIC_KEY ?? null,
    setupToken: e.KADAI_SETUP_TOKEN ?? null,
    rateLimit: { globalMax: e.RATE_LIMIT_GLOBAL_MAX },
    sms: {
      provider: e.SMS_PROVIDER,
      msg91: {
        authKey: e.MSG91_AUTH_KEY ?? null,
        senderId: e.MSG91_SENDER_ID ?? null,
        dltEntityId: e.MSG91_DLT_ENTITY_ID ?? null,
        otpTemplateId: e.MSG91_OTP_TEMPLATE_ID ?? null,
      },
    },
    whatsapp: {
      provider: e.WHATSAPP_PROVIDER,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID ?? null,
      accessToken: e.WHATSAPP_ACCESS_TOKEN ?? null,
      apiVersion: e.WHATSAPP_API_VERSION,
      appSecret: e.WHATSAPP_APP_SECRET ?? null,
      webhookVerifyToken: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? null,
    },
    email: { provider: e.EMAIL_PROVIDER, smtpUrl: e.SMTP_URL ?? null, from: e.SMTP_FROM },
    razorpayPlatform: {
      keyId: e.RAZORPAY_PLATFORM_KEY_ID ?? null,
      keySecret: e.RAZORPAY_PLATFORM_KEY_SECRET ?? null,
      webhookSecret: e.RAZORPAY_PLATFORM_WEBHOOK_SECRET ?? null,
    },
    enableMockPayments: e.KADAI_ENABLE_MOCK_PAYMENTS ?? false,
    vendor: {
      console: e.KADAI_VENDOR_CONSOLE ?? false,
      licenseSigningKey,
      licenseSigningKid: e.KADAI_LICENSE_SIGNING_KID ?? 'dev-2026',
      releaseSigningKey,
      stateCode: vendorStateCode,
      gstin: vendorGstin,
      backupS3: e.KADAI_BACKUP_S3_BUCKET
        ? {
            bucket: e.KADAI_BACKUP_S3_BUCKET,
            region: e.S3_REGION,
            endpoint: e.S3_ENDPOINT ?? null,
            accessKeyId: e.S3_ACCESS_KEY_ID ?? null,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY ?? null,
            forcePathStyle: e.S3_FORCE_PATH_STYLE ?? false,
          }
        : null,
    },
    metricsToken: e.METRICS_TOKEN ?? null,
    apiDocs: e.KADAI_API_DOCS ?? !isProduction,
    otelEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
  }
  return deepFreeze(config)
}

/** Warnings worth logging at boot (not fatal). */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = []
  if (config.database.systemUrlIsDefault) {
    warnings.push(
      'DATABASE_SYSTEM_URL is not set: the runtime URL is used for the system pool too (development only)',
    )
  }
  if (!config.isProduction && config.auth.jwtSecret === DEV_JWT_SECRET) {
    warnings.push('JWT_SECRET is not set: using an insecure development secret')
  }
  if (!config.isProduction && config.encryptionKeys.some((k) => k.kid === 'devonly')) {
    warnings.push('KADAI_ENCRYPTION_KEYS is not set: using an insecure development key')
  }
  if (config.isProduction && !config.metricsToken) {
    warnings.push('METRICS_TOKEN is not set: /metrics is reachable without authentication')
  }
  if (config.isProduction && config.sms.provider === 'log') {
    warnings.push('SMS_PROVIDER=log in production: OTP messages are not delivered')
  }
  if (config.otelEndpoint) {
    warnings.push(
      'OTEL_EXPORTER_OTLP_ENDPOINT is set but this build bundles no OpenTelemetry exporter: ' +
        'traces are not exported (use /metrics and the JSON logs)',
    )
  }
  return warnings
}

export const isCloud = (config: Pick<Config, 'mode'>): boolean => config.mode === 'cloud'
export const isOnPrem = (config: Pick<Config, 'mode'>): boolean => config.mode === 'onprem'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
