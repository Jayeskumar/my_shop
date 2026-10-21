/**
 * MSW handlers for the payments screens, built from the route catalogues (paths come from the
 * contract definitions, never typed by hand) and answering with the contract-shaped fixtures.
 * Every request is recorded in `calls`, so tests can assert query strings, bodies and headers.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import { ROUTE_SCOPE_PREFIX, type RouteDef } from '@kadai/shared/api/common'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import { salesRoutes } from '@kadai/shared/api/sales'
import { ORIGIN } from '@/test/msw'
import * as F from './fixtures'
import { sseResponse } from './sse'

export interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: Headers
  params: Record<string, string>
}

export type Reply = (call: Call) => HttpResponse<JsonBodyType> | Response | Promise<Response>

const methodOf = {
  GET: http.get,
  POST: http.post,
  PATCH: http.patch,
  PUT: http.put,
  DELETE: http.delete,
} as const

/** Full path template of a catalogued route ('/api/v1/payments/:id', '/public/v1/pay/:referenceCode'). */
function templateOf(route: RouteDef): string {
  return ROUTE_SCOPE_PREFIX[route.scope ?? 'api'] + route.path
}

const ROUTES = {
  ...paymentsRoutes,
  listAccounts: accountingRoutes.listAccounts,
  currentShift: accountingRoutes.currentShift,
  listCustomers: partiesRoutes.listCustomers,
  lookupCustomer: partiesRoutes.lookupCustomer,
  listSuppliers: partiesRoutes.listSuppliers,
  listInvoices: salesRoutes.listInvoices,
} as const satisfies Record<string, RouteDef>

export type RouteKey = keyof typeof ROUTES

export const json = (body: JsonBodyType, status = 200) => HttpResponse.json(body, { status })

/** Query string → object for the contract query schemas (repeated keys become arrays). */
export function queryObject(query: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key)
    out[key] = values.length > 1 ? values : (values[0] ?? '')
  }
  return out
}

export function createPaymentsApi(replies: Partial<Record<RouteKey, Reply>> = {}) {
  const calls: Call[] = []

  const defaults: Partial<Record<RouteKey, Reply>> = {
    listProviders: () => json({ data: F.providerList(), page: F.page(3, 200) }),
    createProvider: (c) => {
      const body = c.body as { provider: string }
      const base = body.provider === 'razorpay' ? F.razorpayAccount() : F.vpaAccount()
      return json({ data: { ...base, id: F.pid(9050) } }, 201)
    },
    updateProvider: (c) => {
      const base = F.providerList().find((p) => p.id === c.params.id) ?? F.vpaAccount()
      return json({ data: { ...base, ...(c.body as object), updated_at: F.NOW } })
    },
    deleteProvider: () => new HttpResponse(null, { status: 204 }),
    testProvider: (c) =>
      c.params.id === F.ID.rzpAccount
        ? json({
            data: {
              ok: true,
              provider: 'razorpay',
              checked_at: F.NOW,
              error_code: null,
              message: null,
              test_upi_uri: null,
            },
          })
        : json({ data: F.vpaTestResult() }),
    upiQr: () => json({ data: F.upiQrPayload() }),
    listIntents: (c) => {
      const statuses = c.query.getAll('status')
      const unapplied = c.query.get('unapplied') === 'true'
      const rows = F.todaysIntents().filter(
        (i) =>
          (statuses.length === 0 || statuses.includes(i.status)) &&
          (!unapplied || (i.status === 'paid' && i.payment_id === null)),
      )
      return json(F.intentList(rows))
    },
    getIntent: (c) =>
      json({ data: F.todaysIntents().find((i) => i.id === c.params.id) ?? F.intent() }),
    // The server sends the current intent at once and keeps the stream open.
    streamIntent: (c) =>
      sseResponse([F.todaysIntents().find((i) => i.id === c.params.id) ?? F.intent()], {
        keepOpen: true,
      }),
    confirmIntent: (c) => {
      const base = F.todaysIntents().find((i) => i.id === c.params.id) ?? F.intent()
      const body = c.body as { utr?: string }
      return json({ data: F.paidIntent(base, { utr: body.utr ?? null }) })
    },
    cancelIntent: (c) => {
      const base = F.todaysIntents().find((i) => i.id === c.params.id) ?? F.intent()
      return json({ data: { ...base, status: 'cancelled', expires_in_seconds: null } })
    },
    applyIntent: (c) => {
      const base = F.todaysIntents().find((i) => i.id === c.params.id) ?? F.intent()
      return json(
        {
          data: {
            intent: { ...base, payment_id: F.ID.payment1, payment_number: 'RC/2627/00043' },
            payment: F.paymentDetail({ number: 'RC/2627/00043' }),
          },
        },
        201,
      )
    },
    openItems: (c) =>
      json({
        data: F.openItems(c.query.get('party_type') === 'supplier' ? 'supplier' : 'customer'),
      }),
    listPayments: () => json(F.paymentList()),
    createPayment: (c) => {
      const body = c.body as { direction: 'in' | 'out'; amount_paise: number }
      return json(
        {
          data: F.paymentDetail(
            body.direction === 'out'
              ? {
                  id: F.ID.payment3,
                  number: 'PV/2627/00016',
                  direction: 'out',
                  party_type: 'supplier',
                  party_id: F.ID.supplier,
                  party_name: 'Sri Lakshmi Traders',
                  amount_paise: body.amount_paise,
                  allocations: [],
                  intent: null,
                }
              : { number: 'RC/2627/00043', amount_paise: body.amount_paise },
          ),
        },
        201,
      )
    },
    getPayment: (c) => {
      const row = F.paymentRows().find((p) => p.id === c.params.id)
      return json({ data: F.paymentDetail(row ? { ...row } : {}) })
    },
    cancelPayment: (c) =>
      json({
        data: F.paymentDetail({
          id: c.params.id ?? F.ID.payment1,
          status: 'cancelled',
          cancelled_at: F.NOW,
          cancel_reason: (c.body as { reason: string }).reason,
          cancelled_by_name: 'Murugan K',
        }),
      }),
    publicPayPage: () => json({ data: F.publicPayPage() }),
    // other modules
    listAccounts: () => json({ data: F.chartOfAccounts() }),
    currentShift: () => json({ data: null }),
    listCustomers: () =>
      json({
        data: [
          F.customerListItem(),
          F.customerListItem({
            id: F.ID.customer2,
            name: 'Ravi Kumar',
            name_ta: 'ரவி குமார்',
            phone: '+919876512345',
            balance_paise: 1_430_00,
          }),
        ],
        page: F.page(2, 20),
      }),
    lookupCustomer: () => json({ error: { code: 'NOT_FOUND', message: 'none' } }, 404),
    listSuppliers: () => json({ data: [F.supplierListItem()], page: F.page(1, 20) }),
    listInvoices: () => json(F.dueInvoices()),
  }

  // Literal paths before parameterised ones (/payments/intents before /payments/:id).
  const ordered = (Object.entries(ROUTES) as [RouteKey, RouteDef][]).sort(([, a], [, b]) => {
    const pa = a.path.includes(':') ? 1 : 0
    const pb = b.path.includes(':') ? 1 : 0
    return pa - pb
  })

  const handlers: HttpHandler[] = ordered.flatMap(([key, route]) => {
    const reply = replies[key] ?? defaults[key]
    if (!reply) return []
    return [
      methodOf[route.method](`${ORIGIN}${templateOf(route)}`, async ({ request, params }) => {
        const url = new URL(request.url)
        let body: unknown = undefined
        if (request.method !== 'GET' && request.method !== 'DELETE') {
          const text = await request.text()
          body = text ? (JSON.parse(text) as unknown) : undefined
        }
        const call: Call = {
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          body,
          headers: request.headers,
          params: params as Record<string, string>,
        }
        calls.push(call)
        return reply(call)
      }),
    ]
  })

  return {
    calls,
    handlers,
    /** Calls of one route (by method and the concrete path pattern). */
    callsTo(route: RouteDef): Call[] {
      const re = new RegExp(`^${templateOf(route).replace(/:[A-Za-z]+/g, '[^/]+')}$`)
      return calls.filter((c) => c.method === route.method && re.test(c.path))
    },
  }
}
