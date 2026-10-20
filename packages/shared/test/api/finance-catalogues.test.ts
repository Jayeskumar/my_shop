import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { accountingRoutes } from '../../src/api/accounting'
import { type RouteDef, routePermissions } from '../../src/api/common'
import { notificationsRoutes } from '../../src/api/notifications'
import { reportsRoutes } from '../../src/api/reports'
import { isFeature } from '../../src/features'
import { isPermission } from '../../src/permissions'

const catalogues: Record<string, Record<string, RouteDef>> = {
  accounting: accountingRoutes,
  reports: reportsRoutes,
  notifications: notificationsRoutes,
}

const all = Object.entries(catalogues).flatMap(([module, routes]) =>
  Object.entries(routes).map(([name, def]) => ({ module, name, def })),
)

/** Routes answering something other than a JSON envelope (text challenge). */
const NON_JSON = new Set(['notifications.webhookVerify'])

describe('accounting / reports / notifications route catalogues', () => {
  it.each(all.map((r) => [`${r.module}.${r.name}`, r.def] as const))(
    '%s is well-formed',
    (name, def) => {
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
      if (def.method !== 'DELETE' && !def.stream && !NON_JSON.has(name))
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

  it('responses are envelopes', () => {
    for (const r of all) {
      if (!r.def.response) continue
      const shape = (r.def.response as z.ZodObject).shape as Record<string, unknown> | undefined
      expect(shape && 'data' in shape, `${r.module}.${r.name} response is an envelope`).toBe(true)
    }
  })

  it('every report endpoint takes ?format=csv except the dashboard / GST JSON sections', () => {
    for (const [name, def] of Object.entries(reportsRoutes)) {
      const shape = (def.query as z.ZodObject).shape as Record<string, unknown>
      const csv = name !== 'dashboard' && name !== 'gstr1' && name !== 'gstr3b'
      expect('format' in shape, name).toBe(csv)
    }
  })
})
