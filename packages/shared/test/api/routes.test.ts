import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineRoutes, routePermissions, routeUrl, type RouteResponse } from '../../src/api/common'

const routes = defineRoutes({
  get: {
    method: 'GET',
    path: '/products/:id',
    permission: 'catalog.read',
    response: z.object({ id: z.string() }),
  },
  pub: { method: 'GET', path: '/invoices/:token', scope: 'public', auth: 'public' },
  hook: {
    method: 'POST',
    path: '/payments/:provider/:account_id',
    scope: 'webhook',
    permission: ['payments.read', 'payments.collect'],
  },
})

describe('route catalogue helpers', () => {
  it('builds scoped URLs with encoded params', () => {
    expect(routeUrl(routes.get, { id: 'a/b' })).toBe('/api/v1/products/a%2Fb')
    expect(routeUrl(routes.pub, { token: 'tok' })).toBe('/public/v1/invoices/tok')
    expect(routeUrl(routes.hook, { provider: 'razorpay', account_id: 'x' })).toBe(
      '/webhooks/payments/razorpay/x',
    )
  })
  it('rejects missing params', () => {
    expect(() => routeUrl(routes.get, {})).toThrow(/missing route param :id/)
  })
  it('normalises permissions', () => {
    expect(routePermissions(routes.get)).toEqual(['catalog.read'])
    expect(routePermissions(routes.hook)).toEqual(['payments.read', 'payments.collect'])
    expect(routePermissions(routes.pub)).toEqual([])
  })
  it('infers response types', () => {
    const r: RouteResponse<typeof routes.get> = { id: 'x' }
    expect(r.id).toBe('x')
  })
})
