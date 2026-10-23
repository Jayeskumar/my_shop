/**
 * The payments catalogue is fully implemented and registered with its contract guards:
 * unauthenticated → 401 (api scope), members without the permission → 403 (or 400 when body
 * validation runs first), public / webhook routes need no token.
 */
import { newId } from '@kadai/shared'
import { type RouteDef, routePermissions, routeUrl } from '@kadai/shared/api/common'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unimplementedRoutes } from '../../../core/http'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { paymentsImpls } from '../index'

describe('payments: route catalogue', () => {
  let t: TestApp
  let shop: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const params = {
    id: newId(),
    referenceCode: 'KD0000000000',
    provider: 'razorpay',
    accountId: newId(),
  }

  it('implements every route of the catalogue', () => {
    expect(unimplementedRoutes(paymentsRoutes, paymentsImpls, 'cloud')).toEqual([])
    expect(unimplementedRoutes(paymentsRoutes, paymentsImpls, 'onprem')).toEqual([])
  })

  it('registers api routes behind authentication; public and webhook routes without', async () => {
    for (const [key, def] of Object.entries(paymentsRoutes) as Array<[string, RouteDef]>) {
      const url = routeUrl(def, params)
      const res = await t.app.inject({
        method: def.method,
        url,
        payload: def.method === 'GET' || def.method === 'DELETE' ? undefined : {},
      })
      if ((def.scope ?? 'api') === 'api') {
        expect(res.statusCode, `${key} ${def.method} ${url}`).toBe(401)
      } else {
        expect(res.statusCode, `${key} ${def.method} ${url}: ${res.body}`).not.toBe(401)
      }
    }
  })

  it('applies the permission guards of the contract', async () => {
    const viewer = await shop.asRole('viewer', { permissions: ['reports.read'] })
    for (const [key, def] of Object.entries(paymentsRoutes) as Array<[string, RouteDef]>) {
      if ((def.scope ?? 'api') !== 'api' || routePermissions(def).length === 0) continue
      const url = routeUrl(def, params)
      const res = await shop.inject({
        method: def.method,
        url,
        payload: def.method === 'GET' || def.method === 'DELETE' ? undefined : {},
        as: viewer,
      })
      expect([400, 403], `${key} ${def.method} ${url}: ${res.body}`).toContain(res.statusCode)
    }
  })
})
