/**
 * Helpers for the payments integration tests: URL prefix, status assertions, audit lookups, raw
 * document fixtures (completed invoices, posted bills) and a fake Razorpay API server (Fastify
 * on a random port, pointed at by RAZORPAY_API_BASE) that records every request.
 */
import { createHmac, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { LightMyRequestResponse } from 'fastify'
import { newId } from '@kadai/shared'
import { expect } from 'vitest'
import type { TestApp } from '../../../test/helpers'
import type { TestShop } from '../../../test/tenants'

export const api = (path: string) => `/api/v1${path}`
export const TODAY = '2026-10-20'

export type Data<T> = { data: T }
export type List<T> = { data: T[]; page: { limit: number; offset: number; total: number } }
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

export function expectStatus<T = unknown>(res: LightMyRequestResponse, status: number): T {
  expect(res.statusCode, res.body).toBe(status)
  return (res.body ? JSON.parse(res.body) : null) as T
}

export function expectError(
  res: LightMyRequestResponse,
  status: number,
  code: string,
  reason?: string,
): ErrorBody['error'] {
  const body = expectStatus<ErrorBody>(res, status)
  expect(body.error.code).toBe(code)
  if (reason !== undefined) expect(body.error.details?.reason).toBe(reason)
  return body.error
}

export async function auditRows(t: TestApp, shop: TestShop, action: string) {
  return t.deps.db.systemDb
    .selectFrom('audit_logs')
    .select(['action', 'entity_type', 'entity_id', 'user_id', 'summary', 'changes'])
    .where('tenant_id', '=', shop.tenant.id)
    .where('action', '=', action)
    .orderBy('id', 'desc')
    .execute()
}

export async function bankAccountId(t: TestApp, shop: TestShop, subtype = 'bank'): Promise<string> {
  const row = await t.deps.db.systemDb
    .selectFrom('accounts')
    .select('id')
    .where('tenant_id', '=', shop.tenant.id)
    .where('subtype', '=', subtype)
    .executeTakeFirstOrThrow()
  return row.id
}

/** A completed sales invoice with its full total due (raw fixture). */
export async function insertInvoice(
  t: TestApp,
  shop: TestShop,
  opts: { customerId: string | null; total: number; date?: string; storeId?: string },
): Promise<{ id: string; number: string }> {
  const id = newId()
  const number = `T/${id.slice(-8)}`
  await t.deps.db.systemDb
    .insertInto('sales_invoices')
    .values({
      id,
      tenant_id: shop.tenant.id,
      store_id: opts.storeId ?? shop.store.id,
      doc_type: 'tax_invoice',
      number,
      fy: '2026-27',
      invoice_date: opts.date ?? TODAY,
      status: 'completed',
      customer_id: opts.customerId,
      place_of_supply: '33',
      taxable_paise: opts.total,
      total_paise: opts.total,
      due_paise: opts.total,
    })
    .execute()
  return { id, number }
}

/** A posted purchase bill with its full total due (raw fixture). */
export async function insertBill(
  t: TestApp,
  shop: TestShop,
  opts: { supplierId: string; total: number; date?: string },
): Promise<{ id: string; number: string }> {
  const id = newId()
  const number = `G/${id.slice(-8)}`
  await t.deps.db.systemDb
    .insertInto('purchase_bills')
    .values({
      id,
      tenant_id: shop.tenant.id,
      store_id: shop.store.id,
      supplier_id: opts.supplierId,
      number,
      fy: '2026-27',
      supplier_invoice_no: `INV-${id.slice(-6)}`,
      supplier_invoice_date: opts.date ?? TODAY,
      received_date: opts.date ?? TODAY,
      status: 'posted',
      taxable_paise: opts.total,
      total_paise: opts.total,
      due_paise: opts.total,
    })
    .execute()
  return { id, number }
}

export const invoiceState = (t: TestApp, id: string) =>
  t.deps.db.systemDb
    .selectFrom('sales_invoices')
    .select(['paid_paise', 'due_paise', 'payment_status'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

export const billState = (t: TestApp, id: string) =>
  t.deps.db.systemDb
    .selectFrom('purchase_bills')
    .select(['paid_paise', 'due_paise', 'payment_status'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

export const intentRow = (t: TestApp, id: string) =>
  t.deps.db.systemDb
    .selectFrom('payment_intents')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

/**
 * Cancels the tenants' still-open intents (afterAll): the fake Razorpay of this file is gone
 * afterwards, and job tests in other files must not keep polling QRs that no server knows.
 */
export async function closeOpenIntents(t: TestApp, shops: readonly TestShop[]): Promise<void> {
  if (shops.length === 0) return
  await t.deps.db.systemDb
    .updateTable('payment_intents')
    .set({ status: 'cancelled', provider_closed_at: new Date() })
    .where(
      'tenant_id',
      'in',
      shops.map((s) => s.tenant.id),
    )
    .where('status', 'in', ['created', 'pending'])
    .execute()
}

/** Sets a customer's receivable balance (the ledger is not exercised by these fixtures). */
export async function setCustomerBalance(t: TestApp, customerId: string, paise: number) {
  await t.deps.db.systemDb
    .updateTable('customers')
    .set({ balance_paise: paise })
    .where('id', '=', customerId)
    .execute()
}

export const RZP_KEY_ID = 'rzp_test_Kadai1234Abcd'
export const RZP_KEY_SECRET = 'kadai-test-secret-1234'
export const RZP_WEBHOOK_SECRET = 'whsec-kadai-test-0001'

/** Creates the shop UPI ID account (default of the store). */
export async function createUpiAccount(
  shop: TestShop,
  body: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await shop.inject({
    method: 'POST',
    url: api('/payment-providers'),
    payload: {
      provider: 'upi_vpa',
      display_name: 'Shop UPI',
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Murugan Stores',
      store_id: shop.store.id,
      ...body,
    },
  })
  return expectStatus<Data<{ id: string }>>(res, 201).data
}

export async function createRazorpayAccount(
  shop: TestShop,
  body: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await shop.inject({
    method: 'POST',
    url: api('/payment-providers'),
    payload: {
      provider: 'razorpay',
      display_name: 'Razorpay',
      mode: 'test',
      credentials: { key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET },
      webhook_secret: RZP_WEBHOOK_SECRET,
      store_id: shop.store.id,
      is_default: true,
      ...body,
    },
  })
  return expectStatus<Data<{ id: string }>>(res, 201).data
}

export function signRazorpay(body: string, secret = RZP_WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/** Sends a signed Razorpay webhook to the account. */
export function sendWebhook(
  t: TestApp,
  accountId: string,
  payload: unknown,
  opts: { eventId?: string; secret?: string; signature?: string } = {},
) {
  const body = JSON.stringify(payload)
  return t.app.inject({
    method: 'POST',
    url: `/webhooks/payments/razorpay/${accountId}`,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': opts.signature ?? signRazorpay(body, opts.secret),
      'x-razorpay-event-id': opts.eventId ?? `evt_${randomBytes(8).toString('hex')}`,
    },
    payload: body,
  })
}

export function qrCreditedEvent(opts: {
  qrId: string
  intentId: string
  amount: number
  paymentId?: string
  vpa?: string
  rrn?: string
}) {
  return {
    entity: 'event',
    account_id: 'acc_test',
    event: 'qr_code.credited',
    contains: ['payment', 'qr_code'],
    payload: {
      payment: {
        entity: {
          id: opts.paymentId ?? `pay_${randomBytes(6).toString('hex')}`,
          entity: 'payment',
          amount: opts.amount,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          vpa: opts.vpa ?? 'Ravi.Kumar@okicici',
          acquirer_data: { rrn: opts.rrn ?? '429912345678' },
          fee: 59,
          created_at: Math.floor(Date.now() / 1000),
        },
      },
      qr_code: {
        entity: {
          id: opts.qrId,
          entity: 'qr_code',
          status: 'active',
          notes: { intent_id: opts.intentId },
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  }
}

// ---------------------------------------------------------------------------------------------
// Fake Razorpay
// ---------------------------------------------------------------------------------------------

export interface RecordedRequest {
  method: string
  url: string
  body: Record<string, unknown>
  authorization: string | undefined
}

export interface FakePayment {
  id: string
  amount: number
  status: 'captured' | 'failed' | 'authorized'
  vpa?: string
  rrn?: string
  created_at?: number
}

export interface FakeRazorpay {
  url: string
  requests: RecordedRequest[]
  /** Payments made to a QR (polling). */
  qrPayments: Map<string, FakePayment[]>
  /** Link status (polling). */
  links: Map<
    string,
    { status: string; amount: number; amount_paid: number; payments: FakePayment[] }
  >
  payments: Map<string, FakePayment>
  /** Next QR / link create answers with this error. */
  failNextCreate: { status: number; code: string; description: string } | null
  /** Close / cancel calls answer 500 while set. */
  failCloses: boolean
  close(): Promise<void>
}

const decodeAuth = (h: string | undefined) =>
  h?.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString('utf8') : ''

export async function startFakeRazorpay(): Promise<FakeRazorpay> {
  const app: FastifyInstance = Fastify({ logger: false })
  const prefix = randomBytes(4).toString('hex')
  let seq = 0
  const state: Omit<FakeRazorpay, 'url' | 'close'> = {
    requests: [],
    qrPayments: new Map(),
    links: new Map(),
    payments: new Map(),
    failNextCreate: null,
    failCloses: false,
  }
  const authOk = (h: string | undefined) => decodeAuth(h) === `${RZP_KEY_ID}:${RZP_KEY_SECRET}`
  const authError = {
    error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed', source: 'NA' },
  }
  app.addHook('onRequest', async (req) => {
    state.requests.push({
      method: req.method,
      url: req.url,
      body: {},
      authorization: req.headers.authorization,
    })
  })
  app.addHook('preHandler', async (req) => {
    const last = state.requests[state.requests.length - 1]
    if (last) last.body = (req.body as Record<string, unknown> | undefined) ?? {}
  })
  const createGuard = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const fail = state.failNextCreate
    if (!fail) return null
    state.failNextCreate = null
    return reply
      .code(fail.status)
      .send({ error: { code: fail.code, description: fail.description } })
  }
  app.post('/v1/payments/qr_codes', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    const failed = createGuard(reply)
    if (failed) return failed
    const id = `qr_${prefix}${++seq}`
    state.qrPayments.set(id, [])
    const body = req.body as Record<string, unknown>
    return {
      id,
      entity: 'qr_code',
      status: 'active',
      image_url: `https://rzp.io/qr/${id}`,
      ...body,
    }
  })
  app.get('/v1/payments/qr_codes/:id/payments', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    const { id } = req.params as { id: string }
    const items = state.qrPayments.get(id)
    if (!items)
      return reply
        .code(400)
        .send({
          error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' },
        })
    return {
      entity: 'collection',
      count: items.length,
      items: items.map((p) => ({
        id: p.id,
        entity: 'payment',
        amount: p.amount,
        status: p.status,
        method: 'upi',
        vpa: p.vpa ?? 'payer@okhdfcbank',
        acquirer_data: { rrn: p.rrn ?? '512345678901' },
        fee: 0,
        created_at: p.created_at ?? Math.floor(Date.now() / 1000),
      })),
    }
  })
  app.post('/v1/payments/qr_codes/:id/close', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    if (state.failCloses)
      return reply.code(500).send({ error: { code: 'SERVER_ERROR', description: 'down' } })
    return { id: (req.params as { id: string }).id, status: 'closed' }
  })
  app.post('/v1/payment_links', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    const failed = createGuard(reply)
    if (failed) return failed
    const id = `plink_${prefix}${++seq}`
    const body = req.body as { amount: number }
    state.links.set(id, { status: 'created', amount: body.amount, amount_paid: 0, payments: [] })
    return { id, short_url: `https://rzp.io/i/${id}`, status: 'created', ...body }
  })
  app.get('/v1/payment_links/:id', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    const link = state.links.get((req.params as { id: string }).id)
    if (!link)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } })
    return {
      id: (req.params as { id: string }).id,
      status: link.status,
      amount: link.amount,
      amount_paid: link.amount_paid,
      payments: link.payments.map((p) => ({
        payment_id: p.id,
        amount: p.amount,
        status: p.status,
      })),
    }
  })
  app.post('/v1/payment_links/:id/cancel', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    if (state.failCloses)
      return reply.code(500).send({ error: { code: 'SERVER_ERROR', description: 'down' } })
    const link = state.links.get((req.params as { id: string }).id)
    if (link) link.status = 'cancelled'
    return { status: 'cancelled' }
  })
  app.get('/v1/payments/:id', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    const p = state.payments.get((req.params as { id: string }).id)
    if (!p)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } })
    return {
      id: p.id,
      amount: p.amount,
      status: p.status,
      vpa: p.vpa ?? null,
      acquirer_data: { rrn: p.rrn ?? null },
      created_at: p.created_at ?? Math.floor(Date.now() / 1000),
    }
  })
  app.get('/v1/payments', async (req, reply) => {
    if (!authOk(req.headers.authorization)) return reply.code(401).send(authError)
    return { entity: 'collection', count: 0, items: [] }
  })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  return Object.assign(state, {
    url: address,
    close: () => app.close(),
  }) as FakeRazorpay
}
