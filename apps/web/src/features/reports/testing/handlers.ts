/**
 * MSW handlers for the reports and dashboard screens, built from the route catalogues (paths come
 * from the contract definitions, never typed by hand) and answering with the contract-shaped
 * fixtures. Every request is recorded so tests can assert query strings and bodies.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import { ROUTE_SCOPE_PREFIX, type RouteDef } from '@kadai/shared/api/common'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { identityRoutes } from '@kadai/shared/api/identity'
import { notificationsRoutes } from '@kadai/shared/api/notifications'
import { reportsRoutes } from '@kadai/shared/api/reports'
import { ORIGIN } from '@/test/msw'
import * as F from './fixtures'

export interface Call {
  key: string
  method: string
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

type Reply = (call: Call) => Response | Promise<Response>

const methodOf = {
  GET: http.get,
  POST: http.post,
  PATCH: http.patch,
  PUT: http.put,
  DELETE: http.delete,
} as const

/** MSW URL pattern of a catalogued route (':id' params work as-is). */
export function routePattern(route: RouteDef): string {
  return `${ORIGIN}${ROUTE_SCOPE_PREFIX[route.scope ?? 'api']}${route.path}`
}

export function json(data: JsonBodyType, status = 200): Response {
  return HttpResponse.json(data, { status })
}

export function apiError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): Response {
  return HttpResponse.json(
    { error: { code, message: code, ...(details ? { details } : {}), request_id: 'req-test' } },
    { status },
  )
}

const ROUTES = {
  dashboard: reportsRoutes.dashboard,
  salesSummary: reportsRoutes.salesSummary,
  itemSales: reportsRoutes.itemSales,
  customerOutstanding: reportsRoutes.customerOutstanding,
  expiry: reportsRoutes.expiry,
  profit: reportsRoutes.profit,
  gstr1: reportsRoutes.gstr1,
  gstr1Export: reportsRoutes.gstr1Export,
  gstr3b: reportsRoutes.gstr3b,
  remindCustomer: notificationsRoutes.remindCustomer,
} as const
export type RouteKey = keyof typeof ROUTES

const DEFAULT_REPLIES: Record<RouteKey, Reply> = {
  dashboard: () => json({ data: F.dashboardFixture() }),
  salesSummary: () => json(F.salesSummaryFixture()),
  itemSales: () => json(F.itemSalesFixture()),
  customerOutstanding: () => json(F.customerOutstandingFixture()),
  expiry: () => json(F.expiryFixture()),
  profit: () => apiError(402, 'FEATURE_NOT_IN_PLAN'),
  gstr1: () => json({ data: F.gstr1Fixture() }),
  gstr1Export: (call) =>
    new HttpResponse(call.query.get('format') === 'csv' ? 'a,b\r\n' : '{"gstin":"x"}', {
      headers: {
        'content-type': call.query.get('format') === 'csv' ? 'text/csv' : 'application/json',
        'content-disposition': `attachment; filename="GSTR1_33AAAPL1234C1ZV_092026.${call.query.get('format') ?? 'json'}"`,
      },
    }),
  gstr3b: () => json({ data: F.gstr3bFixture() }),
  remindCustomer: (call) =>
    json(
      {
        data: {
          customer_id: call.params.id,
          due_paise: 1_250_000,
          amount_paise: 1_250_000,
          channel: (call.body as { channel?: string } | null)?.channel ?? 'whatsapp',
          notification: null,
          link: null,
          message: 'Vanakkam, your due is ₹12,500.',
          wa_me_url: 'https://wa.me/919790054321?text=Vanakkam',
          last_reminded_at: null,
        },
      },
      200,
    ),
}

export function createReportsApi(replies: Partial<Record<RouteKey, Reply>> = {}) {
  const calls: Call[] = []
  const handlers: HttpHandler[] = (Object.keys(ROUTES) as RouteKey[]).map((key) => {
    const route = ROUTES[key]
    return methodOf[route.method](routePattern(route), async ({ request, params }) => {
      const url = new URL(request.url)
      let body: unknown = null
      if (request.method !== 'GET') {
        const text = await request.text()
        body = text ? (JSON.parse(text) as unknown) : null
      }
      const call: Call = {
        key,
        method: request.method,
        params: params as Record<string, string>,
        query: url.searchParams,
        body,
      }
      calls.push(call)
      return (replies[key] ?? DEFAULT_REPLIES[key])(call)
    })
  })
  // Pickers in the filter bar load their lists; answer with empty lists.
  handlers.push(
    http.get(routePattern(catalogRoutes.listCategories), () => json({ data: [] })),
    http.get(routePattern(identityRoutes.userDirectory), () => json({ data: [] })),
  )
  return {
    handlers,
    calls,
    callsTo: (key: RouteKey) => calls.filter((c) => c.key === key),
  }
}
