import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureModule } from '../test/fixture-module'
import { type TestApp, type TestTenant, bearer, buildTestApp, insertTestTenant, signTestToken } from '../test/helpers'

describe('rate limits', () => {
  let t: TestApp
  let shop: TestTenant

  beforeAll(async () => {
    // A small global limit to observe it; per-route limits are tighter still.
    t = await buildTestApp({ modules: [fixtureModule], env: { RATE_LIMIT_GLOBAL_MAX: '5' } })
    shop = await insertTestTenant(t.deps.db.systemDb)
  })
  afterAll(() => t.close())

  it('route-level limit → 429 RATE_LIMITED envelope with Retry-After', async () => {
    const token = await signTestToken(t.deps, shop.owner)
    const call = () => t.app.inject({ method: 'GET', url: '/api/v1/__test/limited', headers: bearer(token) })
    expect((await call()).statusCode).toBe(200)
    expect((await call()).statusCode).toBe(200)
    const limited = await call()
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeTruthy()
    const body = limited.json<{ error: { code: string; details: { retry_after_seconds: number } } }>()
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(body.error.details.retry_after_seconds).toBeGreaterThan(0)
  })

  it('global limit is per user, not per IP', async () => {
    const tokenA = await signTestToken(t.deps, (await insertTestTenant(t.deps.db.systemDb)).owner)
    const tokenB = await signTestToken(t.deps, (await insertTestTenant(t.deps.db.systemDb)).owner)
    const callA = () => t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(tokenA) })
    for (let i = 0; i < 5; i++) expect((await callA()).statusCode).toBe(200)
    expect((await callA()).statusCode).toBe(429)
    // Same IP (inject), different user: unaffected.
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami', headers: bearer(tokenB) })).statusCode).toBe(200)
  })

  it('does not limit health checks', async () => {
    for (let i = 0; i < 8; i++) expect((await t.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
  })
})
