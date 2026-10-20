import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppError } from '../core/errors'
import { fixtureModule } from '../test/fixture-module'
import { type TestApp, type TestTenant, bearer, buildTestApp, insertTestTenant, signTestToken } from '../test/helpers'
import { toAppError } from './error-handler'

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown>; request_id: string }
}

describe('error envelope', () => {
  let t: TestApp
  let shop: TestTenant
  let token: string

  beforeAll(async () => {
    t = await buildTestApp({ modules: [fixtureModule] })
    shop = await insertTestTenant(t.deps.db.systemDb)
    token = await signTestToken(t.deps, shop.owner)
  })
  afterAll(() => t.close())

  it('unknown routes → 404 NOT_FOUND', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/does-not-exist' })
    expect(res.statusCode).toBe(404)
    const body = res.json<ErrorJson>()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.request_id).toBeTruthy()
    expect((await t.app.inject({ method: 'GET', url: '/nothing-here' })).statusCode).toBe(404)
  })

  it('schema validation → 400 VALIDATION_ERROR with field issues', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/__test/brands', headers: bearer(token), payload: { name: 42 } })
    expect(res.statusCode).toBe(400)
    const body = res.json<ErrorJson>()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({ location: 'body' })
    const issues = body.error.details?.issues as Array<{ path: string; message: string }>
    expect(issues[0]?.path).toBe('name')

    const q = await t.app.inject({ method: 'GET', url: '/api/v1/__test/brands?limit=0', headers: bearer(token) })
    expect(q.statusCode).toBe(400)
    expect(q.json<ErrorJson>().error.details).toMatchObject({ location: 'querystring' })
  })

  it('malformed JSON → 400 VALIDATION_ERROR', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/__test/brands',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: '{"name": ',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorJson>().error.code).toBe('VALIDATION_ERROR')
  })

  it('AppError keeps code, message and details', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/conflict', headers: bearer(token) })
    expect(res.statusCode).toBe(409)
    expect(res.json<ErrorJson>().error).toMatchObject({ code: 'CONFLICT', message: 'Already done', details: { thing: 1 } })
  })

  it('unique violations → 409 DUPLICATE with the constraint name', async () => {
    const first = await t.app.inject({ method: 'POST', url: '/api/v1/__test/brands', headers: bearer(token), payload: { name: 'Hatsun' } })
    expect(first.statusCode).toBe(201)
    const dup = await t.app.inject({ method: 'POST', url: '/api/v1/__test/brands', headers: bearer(token), payload: { name: 'HATSUN' } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json<ErrorJson>().error).toMatchObject({ code: 'DUPLICATE', details: { constraint: 'brands_tenant_id_name_key' } })
  })

  it('unexpected errors → 500 INTERNAL (message shown outside production only)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/__test/boom', headers: bearer(token) })
    expect(res.statusCode).toBe(500)
    const body = res.json<ErrorJson>()
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.message).toContain('kaboom')
  })
})

describe('toAppError mapping', () => {
  const pg = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR', ...extra })

  it('maps postgres error codes', () => {
    expect(toAppError(pg('23505', { constraint: 'x_uq' }), false)).toMatchObject({ code: 'DUPLICATE', status: 409, details: { constraint: 'x_uq' } })
    expect(toAppError(pg('23503'), false)).toMatchObject({ code: 'UNPROCESSABLE', status: 422 })
    expect(toAppError(pg('23514'), false)).toMatchObject({ code: 'UNPROCESSABLE', status: 422 })
    expect(toAppError(pg('42501'), false)).toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(toAppError(pg('P0001', { message: 'table stock_movements is append-only (UPDATE not allowed)' }), false)).toMatchObject({ code: 'CONFLICT', status: 409 })
    expect(toAppError(pg('P0001', { message: 'journal entry x is not balanced' }), false)).toMatchObject({ code: 'UNPROCESSABLE', status: 422 })
    expect(toAppError(pg('40001'), false)).toMatchObject({ code: 'CONFLICT', details: { retryable: true } })
    expect(toAppError(pg('22P02'), false)).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 })
  })

  it('maps thrown ZodErrors and hides internals in production', () => {
    const zerr = z.object({ a: z.int() }).safeParse({ a: 'x' }).error
    expect(toAppError(zerr, false)).toMatchObject({ code: 'VALIDATION_ERROR', details: { issues: [{ path: 'a' }] } })
    expect(toAppError(new Error('secret db detail'), false).message).toBe('Internal error')
    expect(toAppError(new Error('secret db detail'), true).message).toBe('secret db detail')
    const app = new AppError('RX_REQUIRED', 'Prescription needed')
    expect(toAppError(app, false)).toBe(app)
    expect(app.status).toBe(422)
  })
})
