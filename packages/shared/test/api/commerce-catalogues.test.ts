import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { type RouteDef, routePermissions } from '../../src/api/common'
import { paymentsRoutes } from '../../src/api/payments'
import { purchasesRoutes } from '../../src/api/purchases'
import { salesRoutes } from '../../src/api/sales'
import { isFeature } from '../../src/features'
import { isPermission } from '../../src/permissions'

const catalogues: Record<string, Record<string, RouteDef>> = {
  sales: salesRoutes,
  payments: paymentsRoutes,
  purchases: purchasesRoutes,
}

const all = Object.entries(catalogues).flatMap(([module, routes]) =>
  Object.entries(routes).map(([name, def]) => ({ module, name, def })),
)

describe('sales / payments / purchases route catalogues', () => {
  it.each(all.map((r) => [`${r.module}.${r.name}`, r.def] as const))(
    '%s is well-formed',
    (_n, def) => {
      const pathParams = [...def.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)]
        .map((m) => m[1]!)
        .sort()
      if (pathParams.length) {
        expect(def.params, 'routes with :params need a params schema').toBeDefined()
        const shape = (def.params as z.ZodObject).shape as Record<string, unknown>
        expect(Object.keys(shape).sort()).toEqual(pathParams)
      } else {
        expect(def.params).toBeUndefined()
      }
      if (def.method === 'GET') expect(def.body).toBeUndefined()
      if (def.method !== 'DELETE' && !def.stream)
        expect(def.response, 'response schema').toBeDefined()
      if (def.idempotent) expect(def.method).toBe('POST')
      if (def.scope === 'public' || def.scope === 'webhook') expect(def.auth).toBe('public')
      else
        expect(routePermissions(def).length, 'tenant routes declare a permission').toBeGreaterThan(
          0,
        )
      for (const p of routePermissions(def)) expect(isPermission(p)).toBe(true)
      if (def.feature) expect(isFeature(def.feature)).toBe(true)
      expect(def.path.startsWith('/')).toBe(true)
    },
  )

  it('method + path are unique per scope', () => {
    const keys = all.map((r) => `${r.def.scope ?? 'api'} ${r.def.method} ${r.def.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('list responses are list envelopes', () => {
    for (const r of all) {
      if (!r.def.response) continue
      const shape = (r.def.response as z.ZodObject).shape as Record<string, unknown> | undefined
      expect(shape && 'data' in shape, `${r.module}.${r.name} response is an envelope`).toBe(true)
    }
  })
})
