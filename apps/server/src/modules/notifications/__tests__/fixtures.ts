/**
 * Fixtures for the notifications integration tests: raw documents (sales / payments are built by
 * other modules), customers with dues, a UPI ID account, fake provider HTTP servers and a
 * controllable in-memory provider registry.
 */
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { newId } from '@kadai/shared'
import {
  type NotificationProvider,
  type NotificationProviderRegistry,
  NotificationProviderError,
  type OutboundMessage,
  type ProviderSendResult,
  createNotificationProviderRegistry,
} from '@kadai/shared/api/notifications'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { setNotificationProviders } from '../../../core/notify'
import { jsonb } from '../../../db/json'
import type { TestApp } from '../../../test/helpers'
import { randomPhone } from '../../../test/helpers'
import type { TestShop } from '../../../test/tenants'
import { adoptNotificationProviders } from '../providers'
import { createLogProvider } from '../providers/log'

export const api = (path: string) => `/api/v1${path}`

/** Parses a JSON response and asserts the status (prints the body on mismatch). */
export function expectStatus<T = unknown>(res: LightMyRequestResponse, status: number): T {
  expect(res.statusCode, res.body).toBe(status)
  return (res.body ? JSON.parse(res.body) : null) as T
}

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

export function errorOf(res: LightMyRequestResponse, status: number): ErrorBody['error'] {
  return expectStatus<ErrorBody>(res, status).error
}

// ---------------------------------------------------------------------------------------------
// Master data & documents
// ---------------------------------------------------------------------------------------------

export async function insertCustomer(
  t: TestApp,
  shop: TestShop,
  opts: {
    name?: string
    name_ta?: string | null
    phone?: string | null
    balance_paise?: number
    whatsapp_opt_in?: boolean
    is_active?: boolean
  } = {},
): Promise<{ id: string; name: string; phone: string | null }> {
  const id = newId()
  const name = opts.name ?? `Customer ${id.slice(-6)}`
  const phone = opts.phone === undefined ? randomPhone() : opts.phone
  await t.deps.db.systemDb
    .insertInto('customers')
    .values({
      id,
      tenant_id: shop.tenant.id,
      name,
      name_ta: opts.name_ta ?? null,
      phone,
      balance_paise: opts.balance_paise ?? 0,
      whatsapp_opt_in: opts.whatsapp_opt_in ?? true,
      is_active: opts.is_active ?? true,
    })
    .execute()
  return { id, name, phone }
}

export interface InvoiceFixture {
  customer_id: string | null
  invoice_date: string
  total_paise: number
  due_paise?: number
  store_id?: string
  status?: 'completed' | 'cancelled' | 'held'
  doc_type?: 'tax_invoice' | 'bill_of_supply' | 'estimate'
  lines?: Array<{ product_id?: string | null; name: string; name_ta?: string; total_paise: number }>
}

/** Inserts a sales invoice (and lines) directly; totals are consistent with the CHECKs. */
export async function insertInvoice(
  t: TestApp,
  shop: TestShop,
  inv: InvoiceFixture,
): Promise<{ id: string; number: string }> {
  const id = newId()
  const number = `T${id.slice(-10).toUpperCase()}`
  const due = inv.due_paise ?? 0
  await t.deps.db.systemDb
    .insertInto('sales_invoices')
    .values({
      id,
      tenant_id: shop.tenant.id,
      store_id: inv.store_id ?? shop.store.id,
      doc_type: inv.doc_type ?? 'tax_invoice',
      number: inv.status === 'held' ? null : number,
      fy: '2627',
      invoice_date: inv.invoice_date,
      invoice_at: new Date(`${inv.invoice_date}T10:00:00+05:30`),
      status: inv.status ?? 'completed',
      customer_id: inv.customer_id,
      place_of_supply: '33',
      gross_paise: inv.total_paise,
      taxable_paise: inv.total_paise,
      total_paise: inv.total_paise,
      paid_paise: inv.total_paise - due,
      due_paise: due,
      payment_status: due === 0 ? 'paid' : due === inv.total_paise ? 'unpaid' : 'partial',
      item_count: inv.lines?.length ?? 0,
    })
    .execute()
  if (inv.lines?.length)
    await t.deps.db.systemDb
      .insertInto('sales_invoice_lines')
      .values(
        inv.lines.map((l, i) => ({
          id: newId(),
          tenant_id: shop.tenant.id,
          invoice_id: id,
          line_no: i + 1,
          product_id: l.product_id ?? null,
          name: l.name,
          name_ta: l.name_ta ?? null,
          unit: 'PCS',
          qty_milli: 1000,
          unit_price_paise: l.total_paise,
          gross_paise: l.total_paise,
          taxable_paise: l.total_paise,
          total_paise: l.total_paise,
        })),
      )
      .execute()
  return { id, number }
}

async function cashAccountId(t: TestApp, shop: TestShop): Promise<string> {
  const row = await t.deps.db.systemDb
    .selectFrom('accounts')
    .select('id')
    .where('tenant_id', '=', shop.tenant.id)
    .where('subtype', '=', 'cash')
    .executeTakeFirstOrThrow()
  return row.id
}

/** A completed receipt (optionally allocated to an invoice / the opening balance). */
export async function insertReceipt(
  t: TestApp,
  shop: TestShop,
  p: {
    method: 'cash' | 'upi' | 'card' | 'bank_transfer'
    amount_paise: number
    payment_date: string
    customer_id?: string | null
    allocate_to?: { target_type: 'sales_invoice' | 'opening_balance'; target_id: string | null }
  },
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('payments')
    .values({
      id,
      tenant_id: shop.tenant.id,
      store_id: shop.store.id,
      direction: 'in',
      party_type: p.customer_id ? 'customer' : null,
      party_id: p.customer_id ?? null,
      method: p.method,
      amount_paise: p.amount_paise,
      payment_date: p.payment_date,
      account_id: await cashAccountId(t, shop),
    })
    .execute()
  if (p.allocate_to)
    await t.deps.db.systemDb
      .insertInto('payment_allocations')
      .values({
        id: newId(),
        tenant_id: shop.tenant.id,
        payment_id: id,
        target_type: p.allocate_to.target_type,
        target_id: p.allocate_to.target_id,
        amount_paise: p.amount_paise,
      })
      .execute()
  return id
}

/** The shop's UPI ID (all stores, default). */
export async function insertVpaAccount(
  t: TestApp,
  shop: TestShop,
  vpa = 'murugan.stores@okaxis',
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('payment_provider_accounts')
    .values({
      id,
      tenant_id: shop.tenant.id,
      store_id: null,
      provider: 'upi_vpa',
      display_name: 'Shop UPI',
      vpa,
      payee_name: 'Sri Murugan Stores',
      merchant_code: '5411',
      is_default: true,
    })
    .execute()
  return id
}

/** Deep-merges a settings patch into tenants.settings (identity owns PATCH /settings). */
export async function patchSettings(
  t: TestApp,
  shop: TestShop,
  patch: Record<string, Record<string, unknown>>,
): Promise<void> {
  const row = await t.deps.db.systemDb
    .selectFrom('tenants')
    .select('settings')
    .where('id', '=', shop.tenant.id)
    .executeTakeFirstOrThrow()
  const current = (row.settings ?? {}) as Record<string, Record<string, unknown>>
  const next: Record<string, Record<string, unknown>> = { ...current }
  for (const [section, values] of Object.entries(patch))
    next[section] = { ...(current[section] ?? {}), ...values }
  await t.deps.db.systemDb
    .updateTable('tenants')
    .set({ settings: jsonb(next) })
    .where('id', '=', shop.tenant.id)
    .execute()
}

/** Notification rows of a tenant (newest first). */
export function notificationsOf(t: TestApp, shop: TestShop) {
  return t.deps.db.systemDb
    .selectFrom('notifications')
    .selectAll()
    .where('tenant_id', '=', shop.tenant.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

export interface FakeProvider extends NotificationProvider {
  sent: OutboundMessage[]
  /** Next results (shifted per send); default ok 'sent'. */
  script: Array<ProviderSendResult | NotificationProviderError>
}

/** An in-memory provider; `code` lets it stand in for msg91 / whatsapp_cloud. */
export function fakeProvider(
  code: NotificationProvider['code'],
  channels: NotificationProvider['channels'],
): FakeProvider {
  const sent: OutboundMessage[] = []
  const script: FakeProvider['script'] = []
  return {
    code,
    channels,
    configured: true,
    sent,
    script,
    async send(message) {
      sent.push(message)
      const next = script.shift()
      if (next instanceof NotificationProviderError) throw next
      return next ?? { provider_message_id: `fake-${newId()}`, status: 'sent' }
    },
  }
}

export function retryableError(provider = 'msg91', retryAfter: number | null = null) {
  return new NotificationProviderError({
    message: 'HTTP 503: busy',
    kind: 'retryable',
    provider,
    code: 'provider_error',
    http_status: 503,
    retry_after_seconds: retryAfter,
  })
}

export function permanentError(provider = 'msg91') {
  return new NotificationProviderError({
    message: 'HTTP 400: invalid number',
    kind: 'permanent',
    provider,
    code: 'invalid_recipient',
    http_status: 400,
  })
}

/**
 * Replaces the process registry with `providers` (+ a quiet log provider unless given) and pins
 * them; returns the registry. Restore with useEnvProviders() / setNotificationProviders(prev).
 */
export function useProviders(
  providers: NotificationProvider[],
  opts: { withLog?: boolean } = {},
): NotificationProviderRegistry {
  const all = [...providers]
  if (opts.withLog !== false && !providers.some((p) => p.code === 'log'))
    all.push(createLogProvider({ info: () => undefined }, { revealBody: false }))
  const registry = createNotificationProviderRegistry(all)
  for (const p of providers) for (const ch of p.channels) registry.select(ch, p.code)
  adoptNotificationProviders(registry)
  setNotificationProviders(registry)
  return registry
}

// ---------------------------------------------------------------------------------------------
// Fake HTTP servers (provider adapters)
// ---------------------------------------------------------------------------------------------

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
  json: unknown
}

export interface FakeHttpServer {
  url: string
  requests: RecordedRequest[]
  /** Next responses (shifted per request); default 200 {}. */
  respond: Array<{
    status: number
    body?: unknown
    headers?: Record<string, string>
    delayMs?: number
  }>
  close(): Promise<void>
}

export async function startFakeServer(): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = []
  const respond: FakeHttpServer['respond'] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let json: unknown = null
      try {
        json = body ? (JSON.parse(body) as unknown) : null
      } catch {
        json = null
      }
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        json,
      })
      const r = respond.shift() ?? { status: 200, body: {} }
      const send = () => {
        res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers })
        res.end(r.body === undefined ? '' : JSON.stringify(r.body))
      }
      if (r.delayMs) setTimeout(send, r.delayMs)
      else send()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
