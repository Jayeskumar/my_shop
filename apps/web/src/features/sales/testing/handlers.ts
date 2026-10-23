/**
 * MSW handlers for the sales screens, built from the route catalogues (paths come from the
 * contract definitions, never typed by hand) and answering with the contract-shaped fixtures.
 * Every request is recorded in `calls`, so tests can assert query strings, bodies and headers.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import { ROUTE_SCOPE_PREFIX, type RouteDef } from '@kadai/shared/api/common'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import { salesRoutes } from '@kadai/shared/api/sales'
import { ORIGIN } from '@/test/msw'
import * as F from './fixtures'

export interface Call {
  key: string
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  headers: Headers
}

type Reply = (call: Call) => HttpResponse<JsonBodyType> | Response | Promise<Response>

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

export function json(data: JsonBodyType, status = 200): HttpResponse<JsonBodyType> {
  return HttpResponse.json(data, { status })
}

export function apiError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): HttpResponse<JsonBodyType> {
  return HttpResponse.json(
    { error: { code, message: code, ...(details ? { details } : {}), request_id: 'req-test' } },
    { status },
  )
}

const ROUTES = {
  listInvoices: salesRoutes.listInvoices,
  getInvoice: salesRoutes.getInvoice,
  cancelInvoice: salesRoutes.cancelInvoice,
  collectPayment: salesRoutes.collectPayment,
  shareInvoice: salesRoutes.shareInvoice,
  deleteInvoice: salesRoutes.deleteInvoice,
  returnable: salesRoutes.returnable,
  convertEstimate: salesRoutes.convertEstimate,
  listCreditNotes: salesRoutes.listCreditNotes,
  createCreditNote: salesRoutes.createCreditNote,
  getCreditNote: salesRoutes.getCreditNote,
  cancelCreditNote: salesRoutes.cancelCreditNote,
  publicInvoice: salesRoutes.publicInvoice,
  upiQr: paymentsRoutes.upiQr,
  createIntent: paymentsRoutes.createIntent,
  getIntent: paymentsRoutes.getIntent,
  streamIntent: paymentsRoutes.streamIntent,
  cancelIntent: paymentsRoutes.cancelIntent,
  confirmIntent: paymentsRoutes.confirmIntent,
} as const
type RouteKey = keyof typeof ROUTES

export function createSalesApi(replies: Partial<Record<RouteKey, Reply>> = {}) {
  const calls: Call[] = []
  const defaults: Record<RouteKey, Reply> = {
    listInvoices: (c) => {
      const estimates = c.query.getAll('doc_type').includes('estimate')
      return json(
        estimates
          ? F.invoiceList([
              F.invoiceRow({
                id: F.ESTIMATE_ID,
                doc_type: 'estimate',
                number: 'EST/2627/00021',
                due_date: '2026-10-27',
                payment_status: 'unpaid',
              }),
            ])
          : F.invoiceList(),
      )
    },
    getInvoice: (c) =>
      json({ data: c.params.id === F.ESTIMATE_ID ? F.estimateDetail() : F.invoiceDetail() }),
    cancelInvoice: (c) =>
      json({
        data: {
          invoice: F.invoiceDetail({
            status: 'cancelled',
            cancel_reason: (c.body as { reason: string }).reason,
          }),
          refunds: [
            {
              payment_id: F.pid(701),
              method: 'cash',
              amount_paise: 50_000,
              psp_refund_required: false,
              provider: null,
              utr: null,
            },
          ],
        },
      }),
    collectPayment: () =>
      json(
        {
          data: {
            invoice: F.invoiceDetail({ paid_paise: 81_000, due_paise: 0, payment_status: 'paid' }),
            tenders: [
              {
                index: 0,
                method: 'cash',
                amount_paise: 50_000,
                applied_paise: 31_000,
                change_paise: 19_000,
                payment_id: F.pid(702),
              },
            ],
            change_paise: 19_000,
          },
        },
        201,
      ),
    shareInvoice: (c) =>
      json({
        data: {
          url: `https://shop.example.in/i/${F.SHARE_TOKEN}`,
          share_token: F.SHARE_TOKEN,
          notification_id: null,
          message: 'Sri Murugan Stores bill S1-A/2627/00412 ₹810.00',
          wa_me_url:
            (c.body as { channel: string }).channel === 'whatsapp'
              ? 'https://wa.me/919843012345?text=bill'
              : null,
        },
      }),
    deleteInvoice: () => new HttpResponse(null, { status: 204 }),
    returnable: () => json({ data: F.returnable() }),
    convertEstimate: (c) =>
      json(
        {
          data: {
            invoice: F.invoiceDetail({
              id: F.pid(860),
              status:
                (c.body as { status?: string }).status === 'completed' ? 'completed' : 'draft',
              number:
                (c.body as { status?: string }).status === 'completed' ? 'S1/2627/00090' : null,
              source_estimate: { id: F.ESTIMATE_ID, number: 'EST/2627/00021' },
            }),
            tenders: [],
            change_paise: 0,
            warnings: [],
          },
        },
        201,
      ),
    listCreditNotes: () => json(F.creditNoteList()),
    createCreditNote: () => json({ data: F.creditNoteDetail() }, 201),
    getCreditNote: () => json({ data: F.creditNoteDetail() }),
    cancelCreditNote: (c) =>
      json({
        data: F.creditNoteDetail({
          status: 'cancelled',
          cancel_reason: (c.body as { reason: string }).reason,
          cancelled_at: F.NOW,
          cancelled_by_name: 'Murugan K',
        }),
      }),
    publicInvoice: () => json({ data: F.publicInvoice() }),
    upiQr: (c) => {
      const amount = c.query.get('amount_paise')
      return json({ data: F.upiQr(amount ? Number(amount) : null) })
    },
    createIntent: () => json({ data: F.paymentIntent() }, 201),
    getIntent: () => json({ data: F.paymentIntent() }),
    // SSE: the intent as it is now, then paid.
    streamIntent: () =>
      new HttpResponse(
        [
          `event: intent\ndata: ${JSON.stringify(F.paymentIntent())}\n\n`,
          `event: intent\ndata: ${JSON.stringify(
            F.paymentIntent({ status: 'paid', paid_amount_paise: 31_000, utr: '412345678901' }),
          )}\n\n`,
        ].join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    cancelIntent: () => json({ data: F.paymentIntent({ status: 'cancelled' }) }),
    confirmIntent: () =>
      json({
        data: F.paymentIntent({ status: 'paid', paid_amount_paise: 31_000, utr: '412345678901' }),
      }),
  }

  const handlers: HttpHandler[] = (Object.keys(ROUTES) as RouteKey[]).map((key) => {
    const route = ROUTES[key]
    return methodOf[route.method](routePattern(route), async ({ request, params }) => {
      const url = new URL(request.url)
      const text =
        request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text()
      const call: Call = {
        key,
        method: request.method,
        path: url.pathname,
        params: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? '') : (v ?? '')]),
        ),
        query: url.searchParams,
        body: text ? (JSON.parse(text) as unknown) : undefined,
        headers: request.headers,
      }
      calls.push(call)
      return (replies[key] ?? defaults[key])(call)
    })
  })

  return {
    handlers,
    calls,
    callsTo: (key: RouteKey): Call[] => calls.filter((c) => c.key === key),
  }
}
