import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureModule } from '../test/fixture-module'
import { type TestApp, buildTestApp } from '../test/helpers'

describe('security headers, CORS, metrics', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp({
      modules: [fixtureModule],
      env: { METRICS_TOKEN: 'metrics-secret-token', CORS_ORIGINS: 'https://app.kadai.in' },
    })
  })
  afterAll(() => t.close())

  it('sets a strict CSP without upgrade-insecure-requests on http deployments', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/live' })
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toContain('upgrade-insecure-requests')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['strict-transport-security']).toBeUndefined()
  })

  it('marks API answers (including errors) as no-store', async () => {
    const ok = await t.app.inject({ method: 'GET', url: '/public/v1/__test/ping' })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    const err = await t.app.inject({ method: 'GET', url: '/api/v1/__test/whoami' })
    expect(err.statusCode).toBe(401)
    expect(err.headers['cache-control']).toBe('no-store')
    const live = await t.app.inject({ method: 'GET', url: '/health/live' })
    expect(live.headers['cache-control']).not.toBe('no-store')
  })

  it('answers CORS preflights for allowed origins only', async () => {
    const ok = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/__test/whoami',
      headers: {
        origin: 'https://app.kadai.in',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,idempotency-key',
      },
    })
    expect(ok.statusCode).toBe(204)
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.kadai.in')
    expect(ok.headers['access-control-allow-credentials']).toBe('true')
    expect(String(ok.headers['access-control-allow-headers'])).toContain('idempotency-key')
    const evil = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/__test/whoami',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    })
    expect(evil.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('protects /metrics with METRICS_TOKEN and records HTTP histograms by route', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401)
    await t.app.inject({ method: 'GET', url: '/public/v1/__test/ping' })
    const res = await t.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret-token' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('kadai_http_request_duration_seconds_bucket')
    expect(res.body).toContain('route="/public/v1/__test/ping"')
    expect(res.body).toContain('kadai_db_pool_connections')
    expect(res.body).toContain('kadai_build_info')
  })
})

describe('OpenAPI docs', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp({ modules: [fixtureModule], env: { KADAI_API_DOCS: 'true' } })
  })
  afterAll(() => t.close())

  it('serves the OpenAPI document with module tags and security schemes (no auth needed)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/docs/json' })
    expect(res.statusCode).toBe(200)
    const doc = res.json<{
      openapi: string
      paths: Record<string, Record<string, { tags?: string[] }>>
      components: { securitySchemes: Record<string, unknown> }
    }>()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/api/v1/__test/brands']?.post?.tags).toEqual(['platform'])
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['bearerAuth', 'apiKey'])
    expect(doc.paths['/metrics']).toBeUndefined()
    const ui = await t.app.inject({ method: 'GET', url: '/api/docs/' })
    expect(ui.statusCode).toBe(200)
    // Swagger UI needs inline styles; scripts stay same-origin only.
    const csp = String(ui.headers['content-security-policy'])
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toMatch(/script-src 'self'\s*;/)
    expect(csp).not.toContain('upgrade-insecure-requests')
  })
})

describe('static web app with SPA fallback', () => {
  let t: TestApp
  let dist: string
  beforeAll(async () => {
    dist = await mkdtemp(path.join(os.tmpdir(), 'kadai-web-'))
    await mkdir(path.join(dist, 'assets'))
    await writeFile(
      path.join(dist, 'index.html'),
      '<!doctype html><title>Kadai</title><div id="root"></div>',
    )
    await writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("kadai")')
    await writeFile(path.join(dist, 'manifest.webmanifest'), '{}')
    t = await buildTestApp({
      modules: [fixtureModule],
      env: { KADAI_SERVE_WEB: 'true', KADAI_WEB_DIST: dist },
    })
  })
  afterAll(async () => {
    await t.close()
    await rm(dist, { recursive: true, force: true })
  })

  it('serves hashed assets with long-lived caching', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    const manifest = await t.app.inject({ method: 'GET', url: '/manifest.webmanifest' })
    expect(manifest.headers['cache-control']).toBe('no-cache')
  })

  it('falls back to index.html for client routes, not for API paths or missing assets', async () => {
    for (const url of ['/', '/pos', '/settings/users?tab=roles']) {
      const res = await t.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.body).toContain('<div id="root">')
    }
    const api = await t.app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(api.statusCode).toBe(404)
    expect(api.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND')
    expect((await t.app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404)
    expect((await t.app.inject({ method: 'POST', url: '/pos' })).statusCode).toBe(404)
  })
})
