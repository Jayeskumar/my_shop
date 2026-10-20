import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeHeartbeat } from '../jobs/worker-runtime'
import { type TestApp, buildTestApp } from '../test/helpers'

describe('health endpoints', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(() => t.close())

  it('GET /health/live reports the process', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ status: string; version: string; mode: string }>()
    expect(body.status).toBe('ok')
    expect(body.mode).toBe('cloud')
    expect(res.headers['x-request-id']).toBeTruthy()
  })

  it('GET /health/ready checks database and migrations (worker not required)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/ready' })
    const body = res.json<{
      status: string
      checks: Record<string, { status: string; pending?: string[] }>
    }>()
    expect(res.statusCode, JSON.stringify(body)).toBe(200)
    expect(body.checks.database?.status).toBe('ok')
    expect(body.checks.migrations?.status).toBe('ok')
    expect(body.checks.worker?.status).toBe('skipped')
  })

  it('echoes a well-formed x-request-id and replaces a malformed one', async () => {
    const ok = await t.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'req-12345678' },
    })
    expect(ok.headers['x-request-id']).toBe('req-12345678')
    const bad = await t.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    })
    expect(bad.headers['x-request-id']).not.toContain('bad')
  })
})

describe('health with a required worker', () => {
  let t: TestApp
  const heartbeatKey = `worker_heartbeat_test_${newId()}`
  beforeAll(async () => {
    t = await buildTestApp({ health: { requireWorker: true, heartbeatKey } })
  })
  afterAll(async () => {
    await t.deps.db.systemDb.deleteFrom('system_settings').where('key', '=', heartbeatKey).execute()
    await t.close()
  })

  it('is not ready without a heartbeat, ready once the worker has beaten', async () => {
    const missing = await t.app.inject({ method: 'GET', url: '/health/ready' })
    expect(missing.statusCode).toBe(503)
    expect(missing.json<{ checks: { worker: { status: string } } }>().checks.worker.status).toBe(
      'error',
    )

    await writeHeartbeat(t.deps, 1, heartbeatKey)
    const fresh = await t.app.inject({ method: 'GET', url: '/health/ready' })
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json<{ checks: { worker: { status: string } } }>().checks.worker.status).toBe('ok')
  })
})
