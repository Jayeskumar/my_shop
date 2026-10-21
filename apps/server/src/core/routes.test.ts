/**
 * Catalogue route registration (core/http.ts: route / registerRoute / registerRoutes /
 * routePlugins): every shared catalogue boots on one server in both deployment modes with an
 * OpenAPI document, and the definition-driven guards behave (permission any-of, feature, mode,
 * public opt-out, status codes, idempotent `tx` implementations, Idempotency-Key validation).
 */
import type { FastifyReply } from 'fastify'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { newId } from '@kadai/shared'
import { ROUTE_CATALOGUES, allCatalogueRoutes } from '@kadai/shared/api/catalogues'
import { type RouteDef, dataOf, defineRoutes, listOf, zId } from '@kadai/shared/api/common'
import { type KadaiModule, type ModuleName, defineModule } from '../modules'
import { type TestApp, buildTestApp } from '../test/helpers'
import { type TestShop, createTestTenant } from '../test/tenants'
import {
  type KadaiPlugin,
  type RouteImpls,
  registerRoutes,
  routePlugins,
  scopeOfPrefix,
  unimplementedRoutes,
} from './http'

// ---------------------------------------------------------------------------------------------
// Every catalogue on one server
// ---------------------------------------------------------------------------------------------

const notImplemented = async (_req: unknown, reply: FastifyReply) =>
  reply.code(501).send({ error: { code: 'INTERNAL', message: 'not implemented (test stub)' } })

function stubImpls<C extends Record<string, RouteDef>>(routes: C): RouteImpls<C> {
  return Object.fromEntries(
    Object.keys(routes).map((k) => [k, notImplemented]),
  ) as unknown as RouteImpls<C>
}

/** One stub module per server module (licensing registers both of its catalogues). */
function catalogueModules(): KadaiModule[] {
  const modules: KadaiModule[] = []
  for (const [name, routes] of Object.entries(ROUTE_CATALOGUES)) {
    if (name === 'licensing' || name === 'licensingPublic') continue
    modules.push(
      defineModule({
        name: name as ModuleName,
        ...routePlugins(routes as Record<string, RouteDef>, stubImpls(routes)),
      }),
    )
  }
  const vendor: KadaiPlugin = async (app) => {
    registerRoutes(app, ROUTE_CATALOGUES.licensing, stubImpls(ROUTE_CATALOGUES.licensing), {
      // Vendor console routes are tenant-less staff routes (the module adds its staff guard here).
      extras: () => ({ config: { auth: 'user' } }),
    })
  }
  const licensingPublic: KadaiPlugin = async (app) => {
    registerRoutes(
      app,
      ROUTE_CATALOGUES.licensingPublic,
      stubImpls(ROUTE_CATALOGUES.licensingPublic),
    )
  }
  modules.push(defineModule({ name: 'licensing', routes: vendor, publicRoutes: licensingPublic }))
  return modules
}

const swaggerPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')

describe.each(['cloud', 'onprem'] as const)('all route catalogues in %s mode', (mode) => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp({
      modules: catalogueModules(),
      env: { KADAI_MODE: mode, KADAI_API_DOCS: 'true' },
    })
  })
  afterAll(() => t.close())

  const routes = allCatalogueRoutes()
  const here = routes.filter((r) => !r.def.mode || r.def.mode === mode)
  const elsewhere = routes.filter((r) => r.def.mode && r.def.mode !== mode)

  it('registers every route of this mode and documents it in OpenAPI', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/docs/json' })
    expect(res.statusCode).toBe(200)
    const doc = res.json<{ paths: Record<string, Record<string, unknown>> }>()
    const missing = here.filter((r) => {
      const scopePrefix = { api: '/api/v1', public: '/public/v1', webhook: '/webhooks' }[
        r.def.scope ?? 'api'
      ]
      const op = doc.paths[swaggerPath(scopePrefix + r.def.path)]?.[r.def.method.toLowerCase()]
      return op === undefined
    })
    expect(missing.map((r) => `${r.catalogue}.${r.key}`)).toEqual([])
    expect(here.length).toBeGreaterThan(250)
  })

  it('answers routes of the other mode with 404 (not registered)', async () => {
    expect(elsewhere.length).toBeGreaterThan(0)
    for (const r of elsewhere.slice(0, 15)) {
      const prefix = { api: '/api/v1', public: '/public/v1', webhook: '/webhooks' }[
        r.def.scope ?? 'api'
      ]
      const url = prefix + r.def.path.replace(/:[A-Za-z0-9_]+/g, newId())
      const res = await t.app.inject({ method: r.def.method, url })
      expect(res.statusCode, `${r.catalogue}.${r.key} ${url}`).toBe(404)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Guards and implementation forms
// ---------------------------------------------------------------------------------------------

const BrandSchema = z.object({ id: zId, name: z.string() })

const testRoutes = defineRoutes({
  listBrands: {
    method: 'GET',
    path: '/__routes/brands',
    permission: ['catalog.read', 'reports.read'],
    query: z.object({ q: z.string().optional() }),
    response: listOf(BrandSchema),
  },
  getBrand: {
    method: 'GET',
    path: '/__routes/brands/:id',
    permission: 'catalog.read',
    params: z.object({ id: zId }),
    response: dataOf(BrandSchema),
  },
  createBrand: {
    method: 'POST',
    path: '/__routes/brands',
    permission: 'catalog.write',
    idempotent: true,
    status: 201,
    body: z.object({ name: z.string().trim().min(1), client_ref: z.string().optional() }),
    response: dataOf(BrandSchema),
  },
  renameBrand: {
    method: 'POST',
    path: '/__routes/brands/:id/rename',
    permission: 'catalog.write',
    idempotent: true,
    params: z.object({ id: zId }),
    body: z.object({ name: z.string().trim().min(1) }),
    response: dataOf(BrandSchema),
  },
  deleteBrand: {
    method: 'DELETE',
    path: '/__routes/brands/:id',
    permission: 'catalog.write',
    params: z.object({ id: zId }),
  },
  apiOnly: {
    method: 'GET',
    path: '/__routes/api-access',
    permission: 'catalog.read',
    feature: 'api_access',
    response: dataOf(z.object({ ok: z.boolean() })),
  },
  onpremOnly: {
    method: 'GET',
    path: '/__routes/onprem',
    permission: 'catalog.read',
    mode: 'onprem',
    response: dataOf(z.object({ ok: z.boolean() })),
  },
  openProbe: {
    method: 'GET',
    path: '/__routes/probe',
    auth: 'public',
    response: dataOf(z.object({ ok: z.boolean() })),
  },
  publicPage: {
    method: 'GET',
    path: '/__routes/page/:token',
    scope: 'public',
    auth: 'public',
    params: z.object({ token: z.string().min(4) }),
    response: dataOf(z.object({ token: z.string() })),
  },
  hook: {
    method: 'POST',
    path: '/__routes/hook',
    scope: 'webhook',
    auth: 'public',
    response: dataOf(z.object({ bytes: z.int() })),
  },
  unimplemented: {
    method: 'GET',
    path: '/__routes/later',
    permission: 'catalog.read',
    response: dataOf(z.object({ ok: z.boolean() })),
  },
})

const impls: RouteImpls<typeof testRoutes> = {
  listBrands: {
    tx: async (tx, req) => {
      let q = tx
        .selectFrom('brands')
        .select(['id', 'name'])
        .where('tenant_id', '=', req.ctx.tenantId)
      if (req.query.q) q = q.where('name', '=', req.query.q)
      const data = await q.orderBy('name').execute()
      return { data, page: { limit: 200, offset: 0, total: data.length } }
    },
  },
  getBrand: async (req) => {
    expectTypeOf(req.params.id).toEqualTypeOf<string>()
    const row = await req.tx((tx) =>
      tx
        .selectFrom('brands')
        .select(['id', 'name'])
        .where('id', '=', req.params.id)
        .executeTakeFirstOrThrow(),
    )
    return { data: row }
  },
  createBrand: {
    tx: async (tx, req) => {
      const row = await tx
        .insertInto('brands')
        .values({ id: newId(), tenant_id: req.ctx.tenantId, name: req.body.name })
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow()
      return { data: row }
    },
  },
  renameBrand: {
    tx: async (tx, req) => {
      const row = await tx
        .updateTable('brands')
        .set({ name: req.body.name })
        .where('id', '=', req.params.id)
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow()
      return { data: row }
    },
  },
  deleteBrand: async () => undefined,
  apiOnly: async () => ({ data: { ok: true } }),
  onpremOnly: async () => ({ data: { ok: true } }),
  openProbe: { handler: async () => ({ data: { ok: true } }), config: { allowSuspended: true } },
  publicPage: async (req) => ({ data: { token: req.params.token } }),
  hook: async (req) => ({ data: { bytes: req.rawBody?.length ?? 0 } }),
}

describe('registerRoutes / routePlugins behaviour', () => {
  let t: TestApp
  let shop: TestShop
  beforeAll(async () => {
    t = await buildTestApp({
      modules: [defineModule({ name: 'catalog', ...routePlugins(testRoutes, impls) })],
    })
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  it('creates idempotently with the definition status and replays retries', async () => {
    const key = `brand-${newId()}`
    const first = await shop.inject({
      method: 'POST',
      url: '/api/v1/__routes/brands',
      headers: { 'idempotency-key': key },
      payload: { name: 'Aachi' },
    })
    expect(first.statusCode).toBe(201)
    expect(first.headers['idempotent-replayed']).toBe('false')
    const again = await shop.inject({
      method: 'POST',
      url: '/api/v1/__routes/brands',
      headers: { 'idempotency-key': key },
      payload: { name: 'Aachi' },
    })
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(again.json()).toEqual(first.json())
    const other = await shop.inject({
      method: 'POST',
      url: '/api/v1/__routes/brands',
      headers: { 'idempotency-key': key },
      payload: { name: 'Sakthi' },
    })
    expect(other.statusCode).toBe(409)
    const list = await shop.inject({ method: 'GET', url: '/api/v1/__routes/brands?q=Aachi' })
    expect(list.statusCode).toBe(200)
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(1)
  })

  it('uses the definition status (200 by default) for idempotent tx implementations', async () => {
    const created = await shop.inject({
      method: 'POST',
      url: '/api/v1/__routes/brands',
      payload: { name: `Brand ${newId()}` },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json<{ data: { id: string } }>().data.id
    const key = `rename-${newId()}`
    const rename = () =>
      shop.inject({
        method: 'POST',
        url: `/api/v1/__routes/brands/${id}/rename`,
        headers: { 'idempotency-key': key },
        payload: { name: 'Renamed' },
      })
    const first = await rename()
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ data: { id, name: 'Renamed' } })
    const replay = await rename()
    expect(replay.statusCode).toBe(200)
    expect(replay.headers['idempotent-replayed']).toBe('true')
  })

  it('rejects a malformed Idempotency-Key before running the handler', async () => {
    const res = await shop.inject({
      method: 'POST',
      url: '/api/v1/__routes/brands',
      headers: { 'idempotency-key': 'short' },
      payload: { name: 'Never created' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR')
  })

  it('applies the any-of permission guard', async () => {
    const reportsOnly = await shop.asRole('custom_reports', { permissions: ['reports.read'] })
    const list = await shop.inject({
      method: 'GET',
      url: '/api/v1/__routes/brands',
      as: reportsOnly,
    })
    expect(list.statusCode).toBe(200)
    const create = await shop.inject({
      method: 'POST',
      url: '/api/v1/__routes/brands',
      payload: { name: 'X' },
      as: reportsOnly,
    })
    expect(create.statusCode).toBe(403)
    expect(
      create.json<{ error: { details: { required: string[] } } }>().error.details.required,
    ).toEqual(['catalog.write'])
    const anonymous = await shop.inject({ method: 'GET', url: '/api/v1/__routes/brands', as: null })
    expect(anonymous.statusCode).toBe(401)
  })

  it('applies the plan feature guard', async () => {
    const free = await createTestTenant(t, { plan_code: 'free' })
    const res = await free.inject({ method: 'GET', url: '/api/v1/__routes/api-access' })
    expect(res.statusCode).toBe(402)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('FEATURE_NOT_IN_PLAN')
  })

  it('does not register routes of the other deployment mode', async () => {
    const res = await shop.inject({ method: 'GET', url: '/api/v1/__routes/onprem' })
    expect(res.statusCode).toBe(404)
  })

  it('validates params and answers 204 without a response schema', async () => {
    const bad = await shop.inject({ method: 'GET', url: '/api/v1/__routes/brands/not-a-uuid' })
    expect(bad.statusCode).toBe(400)
    const del = await shop.inject({ method: 'DELETE', url: `/api/v1/__routes/brands/${newId()}` })
    expect(del.statusCode).toBe(204)
  })

  it('opts out of authentication for auth: public and mounts public / webhook scopes', async () => {
    const probe = await t.app.inject({ method: 'GET', url: '/api/v1/__routes/probe' })
    expect(probe.statusCode).toBe(200)
    const page = await t.app.inject({ method: 'GET', url: '/public/v1/__routes/page/abcd1234' })
    expect(page.json()).toEqual({ data: { token: 'abcd1234' } })
    const hook = await t.app.inject({
      method: 'POST',
      url: '/webhooks/__routes/hook',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    })
    expect(hook.json()).toEqual({ data: { bytes: 7 } })
  })

  it('leaves unimplemented routes absent and reports them', async () => {
    const res = await shop.inject({ method: 'GET', url: '/api/v1/__routes/later' })
    expect(res.statusCode).toBe(404)
    expect(unimplementedRoutes(testRoutes, impls, 'cloud')).toEqual(['unimplemented'])
    expect(unimplementedRoutes(testRoutes, impls, 'onprem')).toEqual(['unimplemented'])
    expect(unimplementedRoutes(testRoutes, {}, 'cloud')).not.toContain('onpremOnly')
  })
})

describe('registration errors', () => {
  it('maps scope prefixes', () => {
    expect(scopeOfPrefix('/api/v1')).toBe('api')
    expect(scopeOfPrefix('/public/v1')).toBe('public')
    expect(scopeOfPrefix('/webhooks')).toBe('webhook')
    expect(scopeOfPrefix('/other')).toBeNull()
  })

  it('rejects implementations of unknown route keys', () => {
    expect(() =>
      routePlugins(testRoutes, { nope: async () => undefined } as unknown as RouteImpls<
        typeof testRoutes
      >),
    ).toThrow(/"nope" is not a route/)
  })

  it('only creates the scope plugins that have implementations', () => {
    const apiOnly = routePlugins(testRoutes, { getBrand: impls.getBrand })
    expect(Object.keys(apiOnly)).toEqual(['routes'])
    const all = routePlugins(testRoutes, impls)
    expect(Object.keys(all).sort()).toEqual(['publicRoutes', 'routes', 'webhooks'])
  })
})
