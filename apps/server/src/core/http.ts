/**
 * Route helpers for module plugins (ARCHITECTURE.md §7.2, §7.3).
 *
 *   const routes: KadaiPlugin = async (app) => {
 *     app.get('/products', {
 *       schema: { querystring: ProductListQuery, response: { 200: listOf(ProductSchema) } },
 *       preHandler: [requirePermission('catalog.read')],
 *     }, async (req) => {
 *       const page = parsePage(req.query)
 *       return req.tx((tx) => paginate(tx.selectFrom('products').selectAll().where(…), page))
 *     })
 *   }
 *
 * Route catalogues from @kadai/shared/api/<module> (`defineRoutes`) are registered with
 * {@link route} / {@link registerRoute}, which apply schemas, permission/feature/mode guards,
 * the idempotency-key check and auth config from the definition. A whole catalogue is wired with
 * {@link registerRoutes} (inside a scope plugin) or {@link routePlugins} (all three scopes):
 *
 *   export const catalogModule = defineModule({
 *     name: 'catalog',
 *     ...routePlugins(catalogRoutes, {
 *       getBrand: async (req) => ({ data: await loadBrand(req) }),
 *       // `tx` implementations run in ONE tenant transaction — idempotently (Idempotency-Key /
 *       // client_ref replay) when the definition is `idempotent`.
 *       createProduct: { tx: async (tx, req) => ({ data: await createProduct(tx, req.ctx, req.body) }) },
 *     }),
 *   })
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  FastifyBaseLogger,
  FastifyContextConfig,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawServerDefault,
  preHandlerAsyncHookHandler,
} from 'fastify'
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod'
import { type SelectQueryBuilder, sql } from 'kysely'
import type { z } from 'zod'
import { type Feature, type Permission, hasPermission } from '@kadai/shared'
import {
  ROUTE_SCOPE_PREFIX,
  type RouteDef,
  type RouteResponse,
  type RouteScope,
  routePermissions,
} from '@kadai/shared/api/common'
import type { DB } from '../db/schema.generated'
import type { Tx } from '../db/tenant'
import { type RequestContext, canAccessStore } from './context'
import { AppError, featureNotInPlan, forbidden } from './errors'
import { assertIdempotencyKey, requestHash, runIdempotent } from './idempotency'

/** Fastify instance with the zod type provider (what module plugins receive). */
export type KadaiInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>

/** A module route plugin (`export const routes: KadaiPlugin = async (app) => { … }`). */
export type KadaiPlugin<Options extends Record<string, unknown> = Record<never, never>> =
  FastifyPluginAsyncZod<Options>

// ---------------------------------------------------------------------------------------------
// Guards (use as `preHandler: [...]`)
// ---------------------------------------------------------------------------------------------

/** Any-of permission check → 403 FORBIDDEN with the required permissions in details. */
export function requirePermission(...permissions: Permission[]): preHandlerAsyncHookHandler {
  if (permissions.length === 0) throw new Error('requirePermission() needs at least one permission')
  return async (req) => {
    if (!hasPermission(req.ctx.permissions, permissions)) {
      throw forbidden('You do not have permission to do this', { required: permissions })
    }
  }
}

/** Plan / license feature check → 402 FEATURE_NOT_IN_PLAN {feature, plan}. */
export function requireFeature(feature: Feature): preHandlerAsyncHookHandler {
  return async (req) => {
    const ent = await req.server.kadai.entitlements.get(req.ctx.tenantId)
    if (!ent.features.has(feature)) throw featureNotInPlan(feature, ent.plan_code)
  }
}

/** Throws 403 FORBIDDEN when the member's store scope excludes `storeId`. */
export function assertStoreAccess(ctx: Pick<RequestContext, 'storeIds'>, storeId: string): void {
  if (!canAccessStore(ctx, storeId))
    throw forbidden('You do not have access to this store', { store_id: storeId })
}

/**
 * Store scoping guard: `requireStoreAccess((req) => (req.query as { store_id?: string }).store_id)`. A missing store id
 * passes (list endpoints then filter by `ctx.storeIds` themselves).
 */
export function requireStoreAccess(
  getStoreId: (req: FastifyRequest) => string | null | undefined,
): preHandlerAsyncHookHandler {
  return async (req) => {
    const storeId = getStoreId(req)
    if (storeId) assertStoreAccess(req.ctx, storeId)
  }
}

/** Platform (vendor) administrators only — cloud admin routes with `config: { auth: 'user' }`. */
export function requirePlatformAdmin(): preHandlerAsyncHookHandler {
  return async (req) => {
    const auth = req.auth
    if (!auth || auth.kind !== 'user')
      throw new AppError('UNAUTHENTICATED', 'Authentication required')
    const row = await req.server.kadai.db.systemDb
      .selectFrom('users')
      .select(['is_platform_admin', 'status'])
      .where('id', '=', auth.userId)
      .executeTakeFirst()
    if (!row?.is_platform_admin || row.status !== 'active')
      throw forbidden('Platform administrators only')
  }
}

/** Route-level rate limit presets (ARCHITECTURE.md §17): `config: { rateLimit: RATE_LIMITS.login }`. */
export const RATE_LIMITS = {
  /** Password / PIN login: 10 per minute per IP. */
  login: { max: 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `ip:${req.ip}` },
  /** OTP request: 10 per 10 minutes per IP (per-phone limits are enforced by OtpService). */
  otp: { max: 10, timeWindow: '10 minutes', keyGenerator: (req: FastifyRequest) => `ip:${req.ip}` },
  /** Provider webhooks: 300 per minute per IP. */
  webhook: {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
  },
  /** Public pages (invoice links): 120 per minute per IP. */
  public: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => `ip:${req.ip}`,
  },
} as const

// ---------------------------------------------------------------------------------------------
// Pagination (ARCHITECTURE.md §6.5: limit default 50, max 200, offset; total in the envelope)
// ---------------------------------------------------------------------------------------------

export interface PageParams {
  limit: number
  offset: number
}

export interface PageEnvelope<T> {
  data: T[]
  page: { limit: number; offset: number; total: number }
}

export function parsePage(
  query: { limit?: number | string | null; offset?: number | string | null } = {},
): PageParams {
  const limit = Number(query.limit ?? 50)
  const offset = Number(query.offset ?? 0)
  return {
    limit: Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 50,
    offset: Number.isInteger(offset) ? Math.max(0, offset) : 0,
  }
}

export function pageResult<T>(data: T[], page: PageParams, total: number): PageEnvelope<T> {
  return { data, page: { limit: page.limit, offset: page.offset, total } }
}

/**
 * Executes a list query with `count(*) over()` (one round trip) and returns the list envelope.
 * Apply filters and ORDER BY before calling; limit/offset are added here.
 */
export async function paginate<TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  page: PageParams,
): Promise<PageEnvelope<O>> {
  const rows = (await qb
    .select(sql<number>`count(*) over()`.as('__total'))
    .limit(page.limit)
    .offset(page.offset)
    .execute()) as Array<O & { __total: number | string }>
  let total: number
  if (rows.length > 0) {
    total = Number(rows[0]!.__total)
  } else if (page.offset > 0) {
    // Past the end: count separately so the client can jump back.
    const c = (await qb
      .clearSelect()
      .clearOrderBy()
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirst()) as { n: number | string } | undefined
    total = Number(c?.n ?? 0)
  } else {
    total = 0
  }
  const data = rows.map((r) => {
    const { __total: _omit, ...rest } = r
    return rest as unknown as O
  })
  return pageResult(data, page, total)
}

// ---------------------------------------------------------------------------------------------
// Idempotent creates (Idempotency-Key header or body client_ref)
// ---------------------------------------------------------------------------------------------

/** The request's idempotency key: `Idempotency-Key` header, else body `client_ref`. */
export function idempotencyKeyOf(req: FastifyRequest): string | null {
  const header = req.headers['idempotency-key']
  const fromHeader = Array.isArray(header) ? header[0] : header
  if (fromHeader && fromHeader.trim()) return fromHeader.trim()
  const body = req.body
  if (body && typeof body === 'object' && 'client_ref' in body) {
    const ref = (body as { client_ref?: unknown }).client_ref
    if (typeof ref === 'string' && ref.trim()) return ref.trim()
  }
  return null
}

function responseSchemaFor(req: FastifyRequest, status: number): z.ZodType | null {
  const response = (req.routeOptions.schema as { response?: Record<string, unknown> } | undefined)
    ?.response
  const s = response?.[String(status)] ?? response?.[`${String(status)[0]}xx`]
  return s && typeof (s as z.ZodType).parse === 'function' ? (s as z.ZodType) : null
}

/**
 * Runs `work` in the request's tenant transaction, idempotently when the request carries a key:
 * the first response (serialised through the route's response schema) is stored with the key
 * and replayed verbatim for identical retries (`Idempotent-Replayed: true`); a different body
 * with the same key gets 409 IDEMPOTENCY_MISMATCH.
 */
export async function idempotentTx<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  work: (tx: Tx) => Promise<T>,
  opts: { status?: number } = {},
): Promise<FastifyReply> {
  const status = opts.status ?? 201
  const key = idempotencyKeyOf(req)
  if (!key) {
    const body = await req.tx(work)
    return reply.code(status).send(body)
  }
  assertIdempotencyKey(key)
  const path = req.routeOptions.url ?? req.url.split('?')[0]!
  const outcome = await req.tx((tx) =>
    runIdempotent(
      tx,
      req.ctx,
      {
        key,
        method: req.method,
        path,
        requestHash: requestHash(req.body, {
          query: req.query ?? null,
          params: req.params ?? null,
        }),
      },
      async () => {
        const body = await work(tx)
        const schema = responseSchemaFor(req, status)
        // Store exactly what the client receives (schema output, JSON round-tripped).
        const serialised = JSON.parse(
          JSON.stringify(schema ? schema.parse(body) : body) ?? 'null',
        ) as unknown
        return { status, body: serialised }
      },
    ),
  )
  return reply
    .code(outcome.status)
    .header('idempotent-replayed', String(outcome.replayed))
    .type('application/json; charset=utf-8')
    .serializer((payload: unknown) => JSON.stringify(payload))
    .send(outcome.body)
}

// ---------------------------------------------------------------------------------------------
// Route catalogues (@kadai/shared/api/<module>: defineRoutes)
// ---------------------------------------------------------------------------------------------

type Out<S> = S extends z.ZodType ? z.output<S> : unknown

export type RouteRequestFor<R extends RouteDef> = FastifyRequest<{
  Params: Out<R['params']>
  Querystring: Out<R['query']>
  Body: Out<R['body']>
}>

/**
 * Handler for a catalogued route: return the response body (typed by the definition's
 * `response` schema — the whole envelope, e.g. `dataOf(X)` / `listOf(X)`), or the reply itself
 * after sending (streams, idempotentTx).
 */
export type RouteHandlerFor<R extends RouteDef> = (
  req: RouteRequestFor<R>,
  reply: FastifyReply,
) => Promise<RouteResponse<R> | FastifyReply>

export interface RouteExtras {
  preHandler?: preHandlerAsyncHookHandler[]
  config?: FastifyContextConfig
  bodyLimit?: number
}

/** Scope of a module plugin instance from its prefix (/api/v1 → 'api'); null for other prefixes. */
export function scopeOfPrefix(prefix: string): RouteScope | null {
  const entry = Object.entries(ROUTE_SCOPE_PREFIX).find(([, p]) => p === prefix)
  return entry ? (entry[0] as RouteScope) : null
}

/** Rejects a malformed `Idempotency-Key` header early (400) on idempotent catalogue routes. */
const checkIdempotencyKeyHeader: preHandlerAsyncHookHandler = async (req) => {
  const header = req.headers['idempotency-key']
  const value = Array.isArray(header) ? header[0] : header
  if (value !== undefined && value.trim() !== '') assertIdempotencyKey(value.trim())
}

/**
 * Registers a route from its catalogue definition on the scope instance the module was given
 * (`/api/v1`, `/public/v1` or `/webhooks`). Applies params/query/body/response schemas, the
 * permission (any-of) and feature guards, `auth`/scope → `config.public`, the deployment
 * `mode` (the route is not registered — 404 — in the other mode) and, for `idempotent`
 * definitions, validation of the `Idempotency-Key` header (the handler still decides how to
 * replay: `idempotentTx`, or a `tx` implementation through {@link registerRoute}).
 *
 * Returns false when the route was skipped because of its `mode`.
 */
export function route<R extends RouteDef>(
  app: KadaiInstance,
  def: R,
  handler: RouteHandlerFor<R>,
  extras: RouteExtras = {},
): boolean {
  const scope = def.scope ?? 'api'
  if (def.mode && def.mode !== app.kadai.config.mode) return false
  const expected = ROUTE_SCOPE_PREFIX[scope]
  if (app.prefix !== expected) {
    throw new Error(
      `route ${def.method} ${def.path} has scope "${scope}" but was registered under "${app.prefix || '/'}"`,
    )
  }
  const perms = routePermissions(def)
  const preHandler: preHandlerAsyncHookHandler[] = []
  if (perms.length) preHandler.push(requirePermission(...perms))
  if (def.feature) preHandler.push(requireFeature(def.feature))
  if (def.idempotent) preHandler.push(checkIdempotencyKeyHeader)
  preHandler.push(...(extras.preHandler ?? []))
  const status = def.status ?? 200
  const isPublic = scope !== 'api' || def.auth === 'public'
  // Fastify validates a missing body as `null`, which `.optional()` / `.prefault({})` never see.
  // A contract body that may be omitted (e.g. POST /auth/refresh, /auth/logout) therefore treats
  // a body-less request (curl, sendBeacon, no Content-Type) exactly like `{}`.
  const omittableBody =
    def.body !== undefined &&
    def.body.safeParse(undefined).success &&
    def.body.safeParse({}).success
  app.route({
    method: def.method,
    url: def.path,
    bodyLimit: extras.bodyLimit,
    ...(omittableBody
      ? {
          preValidation: async (req: FastifyRequest) => {
            if (req.body === undefined || req.body === null) req.body = {}
          },
        }
      : {}),
    schema: {
      ...(def.summary ? { summary: def.summary } : {}),
      ...(def.params ? { params: def.params } : {}),
      ...(def.query ? { querystring: def.query } : {}),
      ...(def.body ? { body: def.body } : {}),
      ...(def.response && !def.stream ? { response: { [status]: def.response } } : {}),
      ...(isPublic ? {} : { security: [{ bearerAuth: [] }, { apiKey: [] }] }),
    },
    config: { ...(isPublic ? { public: true } : {}), ...extras.config },
    preHandler,
    handler: async (req, reply) => {
      const result = await handler(req as unknown as RouteRequestFor<R>, reply)
      if (result === reply || reply.sent) return reply
      if (!def.response && !def.stream) return reply.code(204).send()
      return reply.code(status).send(result)
    },
  })
  return true
}

// ---------------------------------------------------------------------------------------------
// Catalogue implementations (registerRoute / registerRoutes / routePlugins)
// ---------------------------------------------------------------------------------------------

/** `{ handler, ...extras }`: a plain handler with route-specific extras (rate limit, config). */
export interface RouteHandlerImpl<R extends RouteDef> extends RouteExtras {
  handler: RouteHandlerFor<R>
}

/**
 * `{ tx, ...extras }`: runs in ONE tenant transaction (`req.tx`) and returns the response body.
 * For `idempotent` definitions the transaction goes through {@link idempotentTx} with the
 * definition's status: a retry with the same `Idempotency-Key` header (or body `client_ref`)
 * replays the stored response (`Idempotent-Replayed: true`), a different body → 409.
 */
export interface RouteTxImpl<R extends RouteDef> extends RouteExtras {
  tx: (tx: Tx, req: RouteRequestFor<R>, reply: FastifyReply) => Promise<RouteResponse<R>>
}

export type RouteImpl<R extends RouteDef> =
  RouteHandlerFor<R> | RouteHandlerImpl<R> | RouteTxImpl<R>

/** Implementations for (some of) a catalogue's routes, by route key. */
export type RouteImpls<C extends Record<string, RouteDef>> = {
  [K in keyof C]?: RouteImpl<C[K]>
}

/** Extras applied to every route of a {@link registerRoutes} call (e.g. a staff guard). */
export type RouteExtrasFor = (def: RouteDef, key: string) => RouteExtras | undefined

function mergeExtras(...parts: Array<RouteExtras | undefined>): RouteExtras {
  const out: RouteExtras = {}
  for (const p of parts) {
    if (!p) continue
    if (p.preHandler?.length) out.preHandler = [...(out.preHandler ?? []), ...p.preHandler]
    if (p.config) out.config = { ...out.config, ...p.config }
    if (p.bodyLimit !== undefined) out.bodyLimit = p.bodyLimit
  }
  return out
}

/**
 * Registers one catalogue route with a handler, `{ handler, ...extras }` or `{ tx, ...extras }`
 * (see {@link RouteTxImpl}). Returns false when skipped for the deployment mode.
 */
export function registerRoute<R extends RouteDef>(
  app: KadaiInstance,
  def: R,
  impl: RouteImpl<R>,
  extras: RouteExtras = {},
): boolean {
  if (typeof impl === 'function') return route(app, def, impl, extras)
  const { preHandler, config, bodyLimit } = impl
  const merged = mergeExtras(extras, { preHandler, config, bodyLimit })
  if ('handler' in impl) return route(app, def, impl.handler, merged)
  // Same status as route() registers the response schema under (idempotentTx serialises with it).
  const status = def.status ?? 200
  const handler: RouteHandlerFor<R> = def.idempotent
    ? (req, reply) => idempotentTx(req, reply, (tx) => impl.tx(tx, req, reply), { status })
    : (req, reply) => req.tx((tx) => impl.tx(tx, req, reply))
  return route(app, def, handler, merged)
}

/**
 * Registers the implemented routes of a catalogue whose scope is the instance's scope (call it
 * from the module's `routes`, `publicRoutes` and `webhooks` plugins with the same arguments, or
 * use {@link routePlugins}). Unimplemented routes are simply absent (404) — module tests should
 * assert `unimplementedRoutes(...)` is empty once the module is complete. Returns the keys
 * registered on this instance.
 */
export function registerRoutes<C extends Record<string, RouteDef>>(
  app: KadaiInstance,
  routes: C,
  impls: RouteImpls<C>,
  opts: { extras?: RouteExtrasFor } = {},
): string[] {
  const scope = scopeOfPrefix(app.prefix)
  if (!scope) throw new Error(`registerRoutes: "${app.prefix || '/'}" is not a route scope prefix`)
  const registered: string[] = []
  for (const [key, impl] of Object.entries(impls) as Array<[string, RouteImpl<RouteDef>]>) {
    if (impl === undefined) continue
    const def = routes[key]
    if (!def) throw new Error(`registerRoutes: "${key}" is not a route of this catalogue`)
    if ((def.scope ?? 'api') !== scope) continue
    if (registerRoute(app, def, impl, opts.extras?.(def, key))) registered.push(key)
  }
  return registered
}

/** Catalogue route keys without an implementation (routes of the other deployment mode excluded). */
export function unimplementedRoutes<C extends Record<string, RouteDef>>(
  routes: C,
  impls: RouteImpls<C>,
  mode?: 'cloud' | 'onprem',
): Array<keyof C & string> {
  return (Object.keys(routes) as Array<keyof C & string>).filter((key) => {
    const def = routes[key]!
    if (mode && def.mode && def.mode !== mode) return false
    return impls[key] === undefined
  })
}

/**
 * The module plugins for a catalogue: `{ routes, publicRoutes, webhooks }` (only the scopes the
 * implementations use), ready to spread into `defineModule({...})`.
 */
export function routePlugins<C extends Record<string, RouteDef>>(
  routes: C,
  impls: RouteImpls<C>,
  opts: { extras?: RouteExtrasFor } = {},
): { routes?: KadaiPlugin; publicRoutes?: KadaiPlugin; webhooks?: KadaiPlugin } {
  const scopes = new Set<RouteScope>()
  for (const key of Object.keys(impls)) {
    const def = routes[key]
    if (!def) throw new Error(`routePlugins: "${key}" is not a route of this catalogue`)
    if (impls[key] !== undefined) scopes.add(def.scope ?? 'api')
  }
  const plugin: KadaiPlugin = async (app) => {
    registerRoutes(app, routes, impls, opts)
  }
  return {
    ...(scopes.has('api') ? { routes: plugin } : {}),
    ...(scopes.has('public') ? { publicRoutes: plugin } : {}),
    ...(scopes.has('webhook') ? { webhooks: plugin } : {}),
  }
}
