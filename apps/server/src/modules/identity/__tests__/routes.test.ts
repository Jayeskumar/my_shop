/**
 * The identity catalogue is fully implemented and registered with its contract guards
 * (unauthenticated → 401, members without the permission → 403), and the module has no jobs.
 */
import { identityRoutes } from '@kadai/shared/api/identity'
import { routePermissions, routeUrl } from '@kadai/shared/api/common'
import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unimplementedRoutes } from '../../../core/http'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { identityImpls } from '../index'
import { jobs } from '../jobs'

describe('identity: route catalogue', () => {
  let t: TestApp
  let shop: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  it('implements every route of the catalogue', () => {
    expect(unimplementedRoutes(identityRoutes, identityImpls, 'cloud')).toEqual([])
    expect(unimplementedRoutes(identityRoutes, identityImpls, 'onprem')).toEqual([])
    expect(jobs).toEqual([])
  })

  it('registers every route behind authentication', async () => {
    for (const [key, def] of Object.entries(identityRoutes)) {
      const url = routeUrl(def, { id: newId() })
      const res = await t.app.inject({
        method: def.method,
        url,
        payload: def.method === 'GET' || def.method === 'DELETE' ? undefined : {},
      })
      expect(res.statusCode, `${key} ${def.method} ${url}`).toBe(401)
    }
  })

  it('applies the permission guards of the contract', async () => {
    const viewer = await shop.asRole('viewer', { permissions: ['reports.read'] })
    for (const [key, def] of Object.entries(identityRoutes)) {
      if (routePermissions(def).length === 0) continue
      const url = routeUrl(def, { id: newId() })
      const res = await shop.inject({
        method: def.method,
        url,
        payload: def.method === 'GET' || def.method === 'DELETE' ? undefined : {},
        as: viewer,
      })
      // Body validation may run first for some routes; never a success for a viewer.
      expect([400, 403], `${key} ${def.method} ${url}: ${res.body}`).toContain(res.statusCode)
    }
  })
})
