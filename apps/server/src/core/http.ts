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
 * {@link route}, which applies schemas, permission/feature/mode guards and auth config from the
 * definition.
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

/**
 * Registers a route from its catalogue definition on the scope instance the module was given
 * (`/api/v1`, `/public/v1` or `/webhooks`). Applies params/query/body/response schemas, the
 * permission (any-of) and feature guards, `auth`/scope → `config.public`, and the deployment
 * `mode` (the route is not registered — 404 — in the other mode).
 */
export function route<R extends RouteDef>(
  app: KadaiInstance,
  def: R,
  handler: RouteHandlerFor<R>,
  extras: RouteExtras = {},
): void {
  const scope = def.scope ?? 'api'
  if (def.mode && def.mode !== app.kadai.config.mode) return
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
}
