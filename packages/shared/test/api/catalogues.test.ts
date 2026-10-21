/**
 * Cross-module contract checks over EVERY route catalogue (docs/API.md): the per-module tests
 * check their own routes; these catch what only shows up when all modules are registered on one
 * server (method + path clashes across modules, param naming, guard declarations).
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ROUTE_CATALOGUES, allCatalogueRoutes, routeIdentity } from '../../src/api/catalogues'
import { routePermissions } from '../../src/api/common'
import { isFeature } from '../../src/features'
import { isPermission } from '../../src/permissions'

const all = allCatalogueRoutes()
const named = all.map((r) => [`${r.catalogue}.${r.key}`, r] as const)

/** Tenant API routes open to any authenticated member (no permission on purpose). */
const ANY_MEMBER = new Set([
  'auth.passwordChange',
  'auth.selectTenant',
  'auth.logout',
  'auth.me',
  'identity.userDirectory',
  'identity.listStores',
  'identity.getStore',
  'identity.getSettings',
  'identity.uploadFile',
  'identity.getFile',
  'identity.getFileContent',
  'catalog.listUnits',
  'catalog.searchHsn',
  'platform.announcements',
  'platform.dismissAnnouncement',
  'onprem.vendorState',
  'onprem.dismissBanner',
])

/** Routes that answer something other than a JSON envelope without declaring `stream`. */
const NON_JSON = new Set(['notifications.webhookVerify'])

const pathParams = (path: string) =>
  [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!)

describe('all route catalogues', () => {
  it('covers every module catalogue', () => {
    expect(Object.keys(ROUTE_CATALOGUES)).toEqual([
      'auth',
      'identity',
      'catalog',
      'parties',
      'inventory',
      'sales',
      'payments',
      'purchases',
      'accounting',
      'reports',
      'notifications',
      'platform',
      'licensing',
      'licensingPublic',
      'onprem',
    ])
    expect(all.length).toBeGreaterThan(380)
  })

  it('method + path are unique across all modules (per scope)', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const [name, r] of named) {
      const id = routeIdentity(r.def)
      const prev = seen.get(id)
      if (prev) clashes.push(`${id}: ${prev} vs ${name}`)
      seen.set(id, name)
    }
    expect(clashes).toEqual([])
  })

  it('no two routes differ only by a path-param name (Fastify would refuse to boot)', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const [name, r] of named) {
      const shape = `${r.def.scope ?? 'api'} ${r.def.method} ${r.def.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':')}`
      const prev = seen.get(shape)
      if (prev) clashes.push(`${shape}: ${prev} vs ${name}`)
      seen.set(shape, name)
    }
    expect(clashes).toEqual([])
  })

  it.each(named)('%s is well-formed', (name, { def }) => {
    // Paths: kebab-case static segments, camelCase params, no trailing slash.
    expect(def.path).toMatch(/^(\/([a-z0-9]+(-[a-z0-9]+)*|:[a-z][A-Za-z0-9]*))+$/)
    const params = pathParams(def.path)
    if (params.length) {
      expect(def.params, 'routes with :params need a params schema').toBeDefined()
      const shape = (def.params as z.ZodObject).shape as Record<string, unknown>
      expect(Object.keys(shape).sort()).toEqual([...params].sort())
    } else {
      expect(def.params).toBeUndefined()
    }
    if (def.method === 'GET') expect(def.body).toBeUndefined()
    if (def.idempotent) expect(['POST', 'PUT']).toContain(def.method)
    if (def.mode) expect(['cloud', 'onprem']).toContain(def.mode)
    for (const p of routePermissions(def)) expect(isPermission(p), p).toBe(true)
    if (def.feature) expect(isFeature(def.feature), def.feature).toBe(true)

    const scope = def.scope ?? 'api'
    if (scope !== 'api')
      expect(def.auth, 'public / webhook scopes are unauthenticated').toBe('public')
    const isVendor = 'vendor' in def
    if (scope === 'api' && def.auth !== 'public' && !isVendor && !ANY_MEMBER.has(name)) {
      expect(routePermissions(def).length, 'tenant routes declare a permission').toBeGreaterThan(0)
    }
    if (ANY_MEMBER.has(name)) expect(routePermissions(def)).toEqual([])

    // Responses: a JSON envelope; no response schema = 204 No Content (or a stream).
    if (!def.response && !def.stream && !NON_JSON.has(name)) {
      expect(def.status ?? 204, 'a route without a response schema answers 204').toBe(204)
    }
    if (def.status === 204) expect(def.response).toBeUndefined()
    if (def.response && !def.stream) {
      const shape = (def.response as z.ZodObject).shape as Record<string, unknown> | undefined
      expect(shape && 'data' in shape, 'response is a { data } envelope').toBe(true)
    }
  })

  it('the ANY_MEMBER allow-list only names existing routes', () => {
    const names = new Set<string>(named.map(([n]) => n))
    for (const n of ANY_MEMBER) expect(names.has(n), n).toBe(true)
  })
})
