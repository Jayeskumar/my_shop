/**
 * On-prem first-run wizard. Runs against its own throw-away database: setup is only possible on
 * an installation without tenants, which the shared test database never is.
 */
import type { LightMyRequestResponse } from 'fastify'
import pg from 'pg'
import type { MeResponse, SessionResponse, SetupStatusResponse } from '@kadai/shared/api/auth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../../db/migrator'
import { testDatabaseUrls } from '../../test/env'
import { type TestApp, bearer, buildTestApp, randomPhone, testEnv } from '../../test/helpers'

const dbName = `kadai_onprem_${process.pid}_${Date.now().toString(36)}`
const SETUP_TOKEN = 'install-token-2026'
const PASSWORD = 'Shop-Server#2026'

function urlFor(database: string, role: 'owner' | 'app'): string {
  const urls = testDatabaseUrls(testEnv())
  const u = new URL(role === 'owner' ? urls.systemUrl : urls.url)
  u.pathname = `/${database}`
  return u.toString()
}

async function admin(sqlText: string): Promise<void> {
  const client = new pg.Client({ connectionString: urlFor('postgres', 'owner') })
  await client.connect()
  try {
    await client.query(sqlText)
  } finally {
    await client.end()
  }
}

describe('on-prem setup wizard', () => {
  let t: TestApp

  beforeAll(async () => {
    await admin(`CREATE DATABASE ${dbName}`)
    await migrate({
      connectionString: urlFor(dbName, 'owner'),
      appRole: 'kadai_app',
      logger: { info: () => undefined, warn: () => undefined },
    })
    t = await buildTestApp({
      env: {
        KADAI_MODE: 'onprem',
        DATABASE_URL: urlFor(dbName, 'app'),
        DATABASE_SYSTEM_URL: urlFor(dbName, 'owner'),
        KADAI_SETUP_TOKEN: SETUP_TOKEN,
      },
    })
  })

  afterAll(async () => {
    await t?.close()
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  })

  const status = async () =>
    (await t.app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json<{
      data: SetupStatusResponse
    }>().data

  function setupBody(overrides: Record<string, unknown> = {}) {
    return {
      business_name: 'Kaveri Medicals',
      business_name_ta: 'காவேரி மெடிக்கல்ஸ்',
      legal_name: 'Kaveri Medicals Pvt Ltd',
      store_name: 'Kaveri Medicals – Main Road',
      business_type: 'pharmacy',
      owner_name: 'Kaveri',
      phone: randomPhone().slice(3),
      password: PASSWORD,
      state_code: '33',
      locale: 'ta',
      setup_token: SETUP_TOKEN,
      ...overrides,
    }
  }
  const runSetup = (body: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    t.app.inject({ method: 'POST', url: '/api/v1/setup', payload: body })

  it('creates the single business exactly once', async () => {
    expect(await status()).toMatchObject({
      setup_required: true,
      mode: 'onprem',
      token_required: true,
    })

    const noToken = await runSetup(setupBody({ setup_token: undefined }))
    expect(noToken.statusCode).toBe(403)
    const wrongToken = await runSetup(setupBody({ setup_token: 'not-the-token' }))
    expect(wrongToken.statusCode).toBe(403)

    // Two browsers racing on a fresh install: one wins, the other is told it is done.
    const [a, b] = await Promise.all([
      runSetup(setupBody()),
      runSetup(setupBody({ business_name: 'Other Shop' })),
    ])
    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([201, 409])
    const winner = a.statusCode === 201 ? a : b
    const loser = a.statusCode === 201 ? b : a
    expect(loser.json<{ error: { code: string } }>().error.code).toBe('SETUP_ALREADY_DONE')

    expect(await status()).toMatchObject({ setup_required: false })
    expect((await runSetup(setupBody())).statusCode).toBe(409)

    const session = winner.json<{ data: SessionResponse }>().data
    expect(session.tenant_id).toEqual(expect.any(String))
    expect(winner.cookies.find((c) => c.name === 'kadai_rt')).toBeDefined()

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(session.access_token),
    })
    expect(me.statusCode).toBe(200)
    const profile = me.json<{ data: MeResponse }>().data
    expect(profile).toMatchObject({ mode: 'onprem' })
    expect(profile.tenant).toMatchObject({
      id: session.tenant_id,
      business_type: 'pharmacy',
      legal_name: 'Kaveri Medicals Pvt Ltd',
    })
    expect(profile.stores.map((s) => s.name)).toEqual(['Kaveri Medicals – Main Road'])
    // No license installed yet: evaluation on the Free plan, from the license source.
    expect(profile.entitlements).toMatchObject({ plan_code: 'free', source: 'license' })

    const db = t.deps.db.systemDb
    const marker = await db
      .selectFrom('system_settings')
      .select('value')
      .where('key', '=', 'onprem_setup')
      .executeTakeFirstOrThrow()
    expect(marker.value).toMatchObject({ tenant_id: session.tenant_id })
    expect(await db.selectFrom('subscriptions').select('id').execute()).toHaveLength(0)
    expect(await db.selectFrom('tenants').select('id').execute()).toHaveLength(1)
  })

  it('has no self-signup on-prem, but normal sign-in works', async () => {
    const signup = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: setupBody(),
    })
    expect(signup.statusCode).toBe(404)
    const owner = await t.deps.db.systemDb
      .selectFrom('users')
      .select('phone')
      .executeTakeFirstOrThrow()
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: owner.phone, password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
  })
})
