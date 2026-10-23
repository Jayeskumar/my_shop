/**
 * payments module — providers, UPI intents, webhooks, receipts/vouchers, reconciliation, dues
 * links. Owned by the payments module (ARCHITECTURE.md §3.1, §8.4, §11).
 *
 * Endpoints: docs/API.md "payments & UPI". Every route is registered from the shared catalogue
 * (`paymentsRoutes` in @kadai/shared/api/payments): method, path, schemas, permission guards and
 * the Idempotency-Key check come from the contract. Plan features are checked per provider
 * (dynamic providers need `upi_dynamic`, the shop UPI ID `upi_static`).
 *
 * Idempotency: intent / link creation use the intent's own unique idempotency key (body
 * `idempotency_key` or the Idempotency-Key header), because the provider call happens between
 * two transactions; apply and POST /payments use core idempotency (idempotentTx).
 *
 * System-pool uses (justified in place): webhook account lookup + raw webhook events
 * (./webhooks.ts), public pay page tenant resolution (./links.ts), job fan-out (./polling.ts,
 * ./webhooks.ts sweep).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { buildUpiUri, generateReferenceCode, hasPermission } from '@kadai/shared'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import { audit } from '../../core/audit'
import { forbidden } from '../../core/errors'
import {
  type KadaiPlugin,
  RATE_LIMITS,
  type RouteImpls,
  type RouteRequestFor,
  idempotencyKeyOf,
  registerRoutes,
} from '../../core/http'
import { assertIdempotencyKey } from '../../core/idempotency'
import { defineModule } from '../module'
import {
  assertVisibleAccount,
  createProviderAccount,
  deactivateProviderAccount,
  getProviderAccount,
  listProviders,
  loadAccountRuntime,
  markVerified,
  updateProviderAccount,
} from './accounts'
import { tenantToday } from './common'
import {
  applyIntent,
  cancelIntent,
  confirmIntent,
  listIntents,
  mockPayIntent,
  openIntent,
  toIntent,
} from './intents'
import { createPaymentLink, publicPayPage, staticUpiQr } from './links'
import { getProvider, isProviderFailure, providerErrorCode } from './providers'
import {
  cancelManualPayment,
  createManualPayment,
  getPaymentDetail,
  listPayments,
  openItemsFor,
  paymentsCsv,
} from './receipts'
import { closeAllStreams, getIntentWithWait, streamIntent } from './stream'
import { receiveWebhook } from './webhooks'

type Routes = typeof paymentsRoutes

/** The body key, else the Idempotency-Key header. */
function intentKey(req: FastifyRequest, bodyKey: string | undefined): string | null {
  const key = bodyKey ?? idempotencyKeyOf(req)
  if (key) assertIdempotencyKey(key)
  return key
}

/** ?format=csv exports need an export-capable role and are audited (ARCHITECTURE.md §7.7). */
function assertCanExport(req: FastifyRequest): void {
  if (!hasPermission(req.ctx.permissions, ['data.export', 'reports.read'])) {
    throw forbidden('Exporting needs permission', { required: ['data.export', 'reports.read'] })
  }
}

async function testProviderRoute(req: RouteRequestFor<Routes['testProvider']>) {
  const deps = req.server.kadai
  const account = await req.tx(async (tx) => {
    await assertVisibleAccount(tx, req.ctx, req.params.id)
    return loadAccountRuntime(deps, tx, req.ctx, req.params.id)
  })
  const checkedAt = new Date()
  const base = { provider: account.provider, checked_at: checkedAt.toISOString() }
  if (account.provider === 'upi_vpa') {
    return {
      data: {
        ...base,
        ok: Boolean(account.vpa),
        error_code: null,
        message: null,
        test_upi_uri: account.vpa
          ? buildUpiUri({
              vpa: account.vpa,
              payee_name: account.payee_name,
              amount_paise: 100,
              note: 'Kadai UPI test',
              reference: generateReferenceCode('KT'),
              mcc: account.merchant_code,
            })
          : null,
      },
    }
  }
  try {
    await getProvider(account.provider, deps).testCredentials(account)
  } catch (err) {
    if (!isProviderFailure(err)) throw err
    return {
      data: {
        ...base,
        ok: false,
        error_code: providerErrorCode(err),
        message: err.message,
        test_upi_uri: null,
      },
    }
  }
  await req.tx((tx) => markVerified(tx, req.ctx, account.id, checkedAt))
  return { data: { ...base, ok: true, error_code: null, message: null, test_upi_uri: null } }
}

export const paymentsImpls: RouteImpls<Routes> = {
  // ---- providers -------------------------------------------------------------------------------
  listProviders: {
    tx: (tx, req) => listProviders(tx, req.ctx, req.query, req.server.kadai.config.publicBaseUrl),
  },
  createProvider: {
    tx: async (tx, req) => ({
      data: await createProviderAccount(req.server.kadai, tx, req.ctx, req.body),
    }),
  },
  getProvider: {
    tx: async (tx, req) => ({
      data: await getProviderAccount(
        tx,
        req.ctx,
        req.params.id,
        req.server.kadai.config.publicBaseUrl,
      ),
    }),
  },
  updateProvider: {
    tx: async (tx, req) => ({
      data: await updateProviderAccount(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },
  deleteProvider: {
    tx: async (tx, req) => {
      await deactivateProviderAccount(tx, req.ctx, req.params.id)
    },
  },
  testProvider: { handler: testProviderRoute },

  // ---- intents ---------------------------------------------------------------------------------
  createIntent: {
    handler: async (req, reply) => {
      const b = req.body
      const { row, replayed } = await openIntent(req.server.kadai, req.ctx, {
        kind: 'qr',
        purpose: b.purpose,
        store_id: b.store_id,
        register_id: b.register_id ?? null,
        ref_type: b.ref_type ?? null,
        ref_id: b.ref_id ?? null,
        customer_id: b.customer_id ?? null,
        provider_account_id: b.provider_account_id ?? null,
        amount_paise: b.amount_paise,
        note: b.note ?? null,
        idempotency_key: intentKey(req, b.idempotency_key),
      })
      reply.header('idempotent-replayed', String(replayed))
      return { data: toIntent(row) }
    },
  },
  listIntents: { tx: (tx, req) => listIntents(tx, req.ctx, req.query) },
  getIntent: { handler: (req, reply) => getIntentWithWait(req.server.kadai, req, reply) },
  streamIntent: { handler: (req, reply) => streamIntent(req.server.kadai, req, reply) },
  confirmIntent: {
    tx: async (tx, req) => ({
      data: await confirmIntent(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },
  cancelIntent: {
    handler: async (req) => ({
      data: await cancelIntent(req.server.kadai, req.ctx, req.params.id, req.body.reason),
    }),
  },
  mockPayIntent: {
    tx: async (tx, req) => ({
      data: await mockPayIntent(req.server.kadai, tx, req.ctx, req.params.id, req.body),
    }),
  },
  applyIntent: {
    tx: async (tx, req) => ({ data: await applyIntent(tx, req.ctx, req.params.id, req.body) }),
  },

  // ---- links, QR -------------------------------------------------------------------------------
  createLink: {
    handler: async (req, reply) => {
      const { result, replayed } = await createPaymentLink(
        req.server.kadai,
        req.ctx,
        req.body,
        intentKey(req, undefined),
      )
      reply.header('idempotent-replayed', String(replayed))
      return { data: result }
    },
  },
  upiQr: { tx: async (tx, req) => ({ data: await staticUpiQr(tx, req.ctx, req.query) }) },

  // ---- receipts & vouchers ---------------------------------------------------------------------
  openItems: { tx: async (tx, req) => ({ data: await openItemsFor(tx, req.ctx, req.query) }) },
  listPayments: {
    handler: async (req, reply: FastifyReply) => {
      if (req.query.format === 'csv') {
        assertCanExport(req)
        const out = await req.tx(async (tx) => {
          const csv = await paymentsCsv(tx, req.ctx, req.query)
          await audit(tx, req.ctx, {
            action: 'payment.export',
            entity_type: 'payment',
            summary: 'Receipts & payments exported (CSV)',
            changes: { query: req.query },
          })
          return { csv, today: await tenantToday(tx, req.ctx) }
        })
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="payments-${out.today}.csv"`)
          .send(out.csv)
      }
      return req.tx((tx) => listPayments(tx, req.ctx, req.query))
    },
  },
  createPayment: {
    tx: async (tx, req) => ({ data: await createManualPayment(tx, req.ctx, req.body) }),
  },
  getPayment: {
    tx: async (tx, req) => ({ data: await getPaymentDetail(tx, req.ctx, req.params.id) }),
  },
  cancelPayment: {
    tx: async (tx, req) => ({
      data: await cancelManualPayment(tx, req.ctx, req.params.id, req.body.reason),
    }),
  },

  // ---- public & webhooks -----------------------------------------------------------------------
  publicPayPage: {
    handler: async (req) => ({
      data: await publicPayPage(req.server.kadai, req.params.referenceCode),
    }),
    config: { rateLimit: RATE_LIMITS.public },
  },
  webhook: {
    handler: (req) => receiveWebhook(req.server.kadai, req),
    config: { rateLimit: RATE_LIMITS.webhook },
  },
}

/** One plugin for the three scopes (each instance registers the routes of its own scope). */
const plugin: KadaiPlugin = async (app) => {
  registerRoutes(app, paymentsRoutes, paymentsImpls)
  if (app.prefix === '/api/v1') {
    // Open SSE streams must not keep the server from shutting down.
    app.addHook('preClose', async () => closeAllStreams())
  }
}

export const paymentsModule = defineModule({
  name: 'payments',
  routes: plugin,
  publicRoutes: plugin,
  webhooks: plugin,
})
