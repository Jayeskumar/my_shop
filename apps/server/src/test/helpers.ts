/**
 * Test helpers for integration tests (real PostgreSQL, see global-setup.ts).
 *
 *   const t = await buildTestApp()                    // one app per test file; t.app.inject(...)
 *   afterAll(() => t.close())
 *   const tenant = await insertTestTenant(t.deps.db.systemDb, { business_type: 'pharmacy' })
 *   const token = await signTestToken(t.deps, tenant.owner)
 *   const res = await t.app.inject({ method: 'GET', url: '/api/v1/…', headers: bearer(token) })
 *
 * insertTestTenant is a MINIMAL raw fixture (tenant + owner role/user/membership + store S1 +
 * register A). Domain tests that need the chart of accounts, number series and vertical presets
 * should use the onboarding-based fixture once it exists.
 */
import { randomInt } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Kysely } from 'kysely'
import { type AuthMethod, type BusinessType, PERMISSION_CODES, newId } from '@kadai/shared'
import { type BuildAppOptions, type KadaiApp, buildApp } from '../app'
import { type Config, loadConfig, loadDotEnv } from '../config'
import { type Databases, createDatabases } from '../db'
import type { DB } from '../db/schema.generated'
import { type MemoryOtpSender, createMemoryOtpSender } from '../core/otp'
import type { KadaiDeps } from '../core/runtime'
import { createSession, signAccessToken } from '../core/tokens'
import { testDatabaseUrls } from './env'

let dataDir: string | null = null

/** Environment for test configs: repo .env + test database + quiet, isolated defaults. */
export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  loadDotEnv()
  const { url, systemUrl } = testDatabaseUrls()
  dataDir ??= mkdtempSync(path.join(os.tmpdir(), 'kadai-test-'))
  return {
    ...process.env,
    NODE_ENV: 'test',
    KADAI_MODE: 'cloud',
    DATABASE_URL: url,
    DATABASE_SYSTEM_URL: systemUrl,
    DATABASE_POOL_MAX: '5',
    DATABASE_SYSTEM_POOL_MAX: '5',
    KADAI_MIGRATE_ON_BOOT: 'false',
    KADAI_EMBEDDED_WORKER: 'false',
    KADAI_HEALTH_REQUIRE_WORKER: 'false',
    KADAI_SERVE_WEB: 'false',
    KADAI_API_DOCS: 'false',
    KADAI_DATA_DIR: dataDir,
    KADAI_ENABLE_MOCK_PAYMENTS: 'true',
    KADAI_LICENSE_PUBLIC_KEY: '',
    REDIS_URL: '',
    CORS_ORIGINS: 'http://localhost:5173',
    METRICS_TOKEN: '',
    SMS_PROVIDER: 'log',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    LOG_PRETTY: 'false',
    RATE_LIMIT_GLOBAL_MAX: '100000',
    ...overrides,
  }
}

export function getTestConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig(testEnv(overrides))
}

export interface TestApp {
  app: KadaiApp
  deps: KadaiDeps
  config: Config
  /** OTP codes "sent" by the app. */
  otp: MemoryOtpSender
  close(): Promise<void>
}

export interface BuildTestAppOptions extends Omit<BuildAppOptions, 'deps'> {
  env?: Record<string, string | undefined>
}

/** Builds and readies an app on the test database (one per test file). */
export async function buildTestApp(opts: BuildTestAppOptions = {}): Promise<TestApp> {
  const config = getTestConfig(opts.env)
  const otp = createMemoryOtpSender()
  const app = await buildApp(config, {
    ...opts,
    depsOptions: { defaultMetrics: false, otpSender: otp, ...opts.depsOptions },
  })
  await app.ready()
  return { app, deps: app.kadai, config, otp, close: () => app.close() }
}

let sharedDb: Databases | null = null

/** appDb / systemDb on the test database for direct assertions (shared within the test file). */
export function testDb(): Databases {
  sharedDb ??= createDatabases(getTestConfig(), { applicationName: 'kadai-test' })
  return sharedDb
}

export async function closeTestDb(): Promise<void> {
  const db = sharedDb
  sharedDb = null
  await db?.destroy()
}

/** Random valid Indian mobile in E.164 (+91 6-9xxxxxxxxx). */
export function randomPhone(): string {
  return `+91${randomInt(6, 10)}${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`
}

export interface TestMember {
  user_id: string
  tenant_id: string
  membership_id: string
  role_id: string
  role_code: string
  phone: string
}

export interface TestTenant {
  tenant: { id: string; name: string; business_type: BusinessType; plan_code: string }
  owner: TestMember
  store: { id: string; code: string }
  register: { id: string; code: string; store_id: string }
}

export interface InsertTestTenantOptions {
  business_type?: BusinessType
  plan_code?: string
  name?: string
  status?: 'active' | 'suspended' | 'closed'
  state_code?: string
}

/** Minimal raw tenant fixture via the system database (bypasses RLS). */
export async function insertTestTenant(systemDb: Kysely<DB>, opts: InsertTestTenantOptions = {}): Promise<TestTenant> {
  const tenantId = newId()
  const businessType = opts.business_type ?? 'general_store'
  const name = opts.name ?? `Test Shop ${tenantId.slice(-6)}`
  const planCode = opts.plan_code ?? 'pro'
  const stateCode = opts.state_code ?? '33'
  return systemDb.transaction().execute(async (tx) => {
    await tx
      .insertInto('tenants')
      .values({ id: tenantId, name, business_type: businessType, gst_scheme: 'unregistered', state_code: stateCode, plan_code: planCode, status: opts.status ?? 'active' })
      .execute()
    const roleId = newId()
    await tx
      .insertInto('roles')
      .values({ id: roleId, tenant_id: tenantId, code: 'owner', name: 'Owner', name_ta: 'உரிமையாளர்', permissions: [...PERMISSION_CODES], is_system: true })
      .execute()
    const userId = newId()
    const phone = randomPhone()
    await tx.insertInto('users').values({ id: userId, phone, full_name: `Owner ${tenantId.slice(-4)}` }).execute()
    const membershipId = newId()
    await tx.insertInto('memberships').values({ id: membershipId, tenant_id: tenantId, user_id: userId, role_id: roleId }).execute()
    const storeId = newId()
    await tx.insertInto('stores').values({ id: storeId, tenant_id: tenantId, code: 'S1', name: `${name} Main`, state_code: stateCode }).execute()
    const registerId = newId()
    await tx.insertInto('registers').values({ id: registerId, tenant_id: tenantId, store_id: storeId, code: 'A', name: 'Counter A' }).execute()
    return {
      tenant: { id: tenantId, name, business_type: businessType, plan_code: planCode },
      owner: { user_id: userId, tenant_id: tenantId, membership_id: membershipId, role_id: roleId, role_code: 'owner', phone },
      store: { id: storeId, code: 'S1' },
      register: { id: registerId, code: 'A', store_id: storeId },
    }
  })
}

/** Adds a user with a custom role (`permissions` stored as given: codes, 'group.*' or '*'). */
export async function insertTestMember(
  systemDb: Kysely<DB>,
  tenantId: string,
  opts: { role_code?: string; permissions: readonly string[]; store_ids?: string[] | null; status?: 'active' | 'invited' | 'disabled' },
): Promise<TestMember> {
  const roleCode = opts.role_code ?? `role_${randomInt(1e6, 1e7)}`
  return systemDb.transaction().execute(async (tx) => {
    const roleId = newId()
    await tx.insertInto('roles').values({ id: roleId, tenant_id: tenantId, code: roleCode, name: roleCode, permissions: [...opts.permissions] }).execute()
    const userId = newId()
    const phone = randomPhone()
    await tx.insertInto('users').values({ id: userId, phone, full_name: `User ${userId.slice(-4)}` }).execute()
    const membershipId = newId()
    await tx
      .insertInto('memberships')
      .values({ id: membershipId, tenant_id: tenantId, user_id: userId, role_id: roleId, store_ids: opts.store_ids ?? null, status: opts.status ?? 'active' })
      .execute()
    return { user_id: userId, tenant_id: tenantId, membership_id: membershipId, role_id: roleId, role_code: roleCode, phone }
  })
}

export interface SignTestTokenOptions {
  device_id?: string | null
  amr?: AuthMethod[]
  /** Mint a tenant-less token (select-tenant flow). */
  tenantless?: boolean
  ttlSeconds?: number
}

/**
 * Creates a real refresh session (auth_sessions) and signs an access token for a member.
 * Returns the access token; `signTestSession` also returns the session/refresh token.
 */
export async function signTestToken(deps: Pick<KadaiDeps, 'config' | 'db'>, member: Pick<TestMember, 'user_id' | 'tenant_id' | 'membership_id'>, opts: SignTestTokenOptions = {}): Promise<string> {
  return (await signTestSession(deps, member, opts)).accessToken
}

export async function signTestSession(
  deps: Pick<KadaiDeps, 'config' | 'db'>,
  member: Pick<TestMember, 'user_id' | 'tenant_id' | 'membership_id'>,
  opts: SignTestTokenOptions = {},
): Promise<{ accessToken: string; sessionId: string; familyId: string; refreshToken: string }> {
  const tenantId = opts.tenantless ? null : member.tenant_id
  const session = await createSession(deps.db.systemDb, deps.config, {
    userId: member.user_id,
    tenantId,
    deviceId: opts.device_id ?? null,
    authMethod: opts.amr?.[0] ?? 'password',
    ip: '127.0.0.1',
    userAgent: 'vitest',
  })
  const { token } = await signAccessToken(
    deps.config,
    {
      userId: member.user_id,
      tenantId,
      membershipId: opts.tenantless ? null : member.membership_id,
      sessionId: session.sessionId,
      deviceId: opts.device_id ?? null,
      amr: opts.amr ?? ['password'],
    },
    { ttlSeconds: opts.ttlSeconds },
  )
  return { accessToken: token, sessionId: session.sessionId, familyId: session.familyId, refreshToken: session.refreshToken }
}

export const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` })
