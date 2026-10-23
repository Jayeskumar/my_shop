/**
 * The catalog module implements every route of its contract catalogue, registers its job, and
 * the OpenAPI document builds with the catalog schemas.
 */
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unimplementedRoutes } from '../../../core/http'
import { JOB_DEFINITIONS } from '../../../jobs/registry'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { catalogImpls } from '../index'
import { HSN_ENTRIES } from '../directory'

let t: TestApp

beforeAll(async () => {
  t = await buildTestApp({ env: { KADAI_API_DOCS: 'true' } })
})
afterAll(() => t.close())

describe('catalog module wiring', () => {
  it('implements every catalogue route', () => {
    expect(unimplementedRoutes(catalogRoutes, catalogImpls)).toEqual([])
  })

  it('registers the catalog.import job', () => {
    expect(JOB_DEFINITIONS.map((j) => j.name)).toContain('catalog.import')
  })

  it('requires authentication on every route', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/products' })
    expect(res.statusCode).toBe(401)
    const units = await t.app.inject({ method: 'GET', url: '/api/v1/units' })
    expect(units.statusCode).toBe(401)
  })

  it('builds the OpenAPI document with the catalog routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/docs/json' })
    expect(res.statusCode).toBe(200)
    const paths = Object.keys(res.json<{ paths: Record<string, unknown> }>().paths)
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/products',
        '/api/v1/products/{id}/variants',
        '/api/v1/hsn/search',
      ]),
    )
  })

  it('ships a curated HSN list with unique code + description pairs', () => {
    expect(HSN_ENTRIES.length).toBeGreaterThanOrEqual(400)
    const keys = new Set(HSN_ENTRIES.map((e) => `${e.code}|${e.description}`))
    expect(keys.size).toBe(HSN_ENTRIES.length)
    for (const e of HSN_ENTRIES) expect(e.code).toMatch(/^(\d{4}|\d{6}|\d{8})$/)
  })
})
