/**
 * A small module used by the infrastructure tests. It exercises every route helper the way a
 * real module would (and is the reference example in the hand-over notes): schemas, permission /
 * feature / store guards, req.tx + RLS, pagination, idempotent creates, rate limits, catalogued
 * routes (`route()`), public routes and webhooks with raw bodies.
 */
import { z } from 'zod'
import { dataOf, defineRoutes, listOf, zId, PageQuerySchema } from '@kadai/shared/api/common'
import { newId } from '@kadai/shared'
import { sha256Hex } from '../core/crypto'
import { AppError, notFound } from '../core/errors'
import {
  type KadaiPlugin,
  RATE_LIMITS,
  idempotentTx,
  paginate,
  parsePage,
  requireFeature,
  requirePermission,
  requireStoreAccess,
  route,
} from '../core/http'
import { defineModule } from '../modules/module'

const BrandSchema = z.object({ id: zId, name: z.string(), is_active: z.boolean() })
const BrandCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  client_ref: z.string().min(8).max(200).optional(),
})

export const fixtureRoutes = defineRoutes({
  echo: {
    method: 'POST',
    path: '/__test/echo',
    permission: 'catalog.read',
    body: z.object({ text: z.string().min(1) }),
    response: dataOf(z.object({ text: z.string(), tenant_id: zId })),
  },
  onpremOnly: {
    method: 'GET',
    path: '/__test/onprem-only',
    mode: 'onprem',
    response: dataOf(z.object({ ok: z.boolean() })),
  },
  noContent: {
    method: 'DELETE',
    path: '/__test/nothing/:id',
    params: z.object({ id: zId }),
    permission: 'catalog.write',
  },
})

const routes: KadaiPlugin = async (app) => {
  app.get('/__test/whoami', async (req) => ({
    data: {
      tenant_id: req.ctx.tenantId,
      user_id: req.ctx.userId,
      role_code: req.ctx.roleCode,
      register_id: req.ctx.registerId,
      store_ids: req.ctx.storeIds,
      locale: req.ctx.locale,
      permission_count: req.ctx.permissions.size,
    },
  }))

  app.get(
    '/__test/brands',
    {
      schema: {
        querystring: PageQuerySchema.extend({ q: z.string().optional() }),
        response: { 200: listOf(BrandSchema) },
      },
      preHandler: [requirePermission('catalog.read')],
    },
    async (req) => {
      const page = parsePage(req.query)
      return req.tx((tx) => {
        let q = tx
          .selectFrom('brands')
          .select(['id', 'name', 'is_active'])
          .where('tenant_id', '=', req.ctx.tenantId)
        if (req.query.q) q = q.where('name', 'ilike', `%${req.query.q}%`)
        return paginate(q.orderBy('name'), page)
      })
    },
  )

  app.post(
    '/__test/brands',
    {
      schema: { body: BrandCreateSchema, response: { 201: dataOf(BrandSchema) } },
      preHandler: [requirePermission('catalog.write')],
    },
    async (req, reply) =>
      idempotentTx(req, reply, async (tx) => {
        const row = await tx
          .insertInto('brands')
          .values({ id: newId(), tenant_id: req.ctx.tenantId, name: req.body.name })
          .returning(['id', 'name', 'is_active'])
          .executeTakeFirstOrThrow()
        return { data: row }
      }),
  )

  app.get('/__test/brands/:id', { schema: { params: z.object({ id: zId }) } }, async (req) => {
    const row = await req.tx((tx) =>
      tx.selectFrom('brands').selectAll().where('id', '=', req.params.id).executeTakeFirst(),
    )
    if (!row) throw notFound('brand', req.params.id)
    return { data: row }
  })

  app.get('/__test/api-feature', { preHandler: [requireFeature('api_access')] }, async () => ({
    data: { ok: true },
  }))

  app.get(
    '/__test/scoped/:store_id',
    {
      schema: { params: z.object({ store_id: zId }) },
      preHandler: [requireStoreAccess((req) => (req.params as { store_id: string }).store_id)],
    },
    async (req) => ({ data: { store_id: req.params.store_id } }),
  )

  app.get(
    '/__test/limited',
    { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
    async () => ({ data: { ok: true } }),
  )

  app.get('/__test/boom', async () => {
    throw new Error('kaboom: internal detail')
  })

  app.get('/__test/conflict', async () => {
    throw new AppError('CONFLICT', 'Already done', { thing: 1 })
  })

  app.post('/__test/write', async (req) => req.tx(async () => ({ data: { ok: true } })))

  app.get('/__test/tenantless', { config: { auth: 'user' } }, async (req) => ({
    data: { user_id: req.auth?.kind === 'user' ? req.auth.userId : null, has_ctx: req.hasCtx },
  }))

  route(app, fixtureRoutes.echo, async (req) => ({
    data: { text: req.body.text, tenant_id: req.ctx.tenantId },
  }))
  route(app, fixtureRoutes.onpremOnly, async () => ({ data: { ok: true } }))
  route(app, fixtureRoutes.noContent, async () => app.kadai.logger.debug('nothing deleted'))

  app.get(
    '/__test/public-login',
    { config: { public: true, rateLimit: RATE_LIMITS.login } },
    async () => ({ data: { ok: true } }),
  )
}

const publicRoutes: KadaiPlugin = async (app) => {
  app.get('/__test/ping', async () => ({ data: { pong: true } }))
  // Installation-signed licensing requests hash the exact body (raw bytes kept).
  app.post('/licensing/__test/raw', async (req) => ({
    data: { raw_sha256: req.rawBody ? sha256Hex(req.rawBody) : null },
  }))
  app.post('/__test/raw', async (req) => ({
    data: { raw_sha256: req.rawBody ? sha256Hex(req.rawBody) : null },
  }))
}

const webhooks: KadaiPlugin = async (app) => {
  app.post('/__test/hook', async (req) => ({
    data: { raw_sha256: req.rawBody ? sha256Hex(req.rawBody) : null, parsed: req.body },
  }))
}

export const fixtureModule = defineModule({ name: 'platform', routes, publicRoutes, webhooks })
