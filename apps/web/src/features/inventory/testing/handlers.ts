/**
 * MSW handlers for the inventory screens, built from the route catalogues (paths come from the
 * contract definitions, never typed by hand) and answering with the contract-shaped fixtures.
 * Every request is recorded in `calls`, so tests can assert query strings and bodies.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import type { RouteDef } from '@kadai/shared/api/common'
import { identityRoutes } from '@kadai/shared/api/identity'
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { apiPath } from '@/test/msw'
import * as F from './fixtures'

export interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: Headers
}

export type Reply = (
  call: Call,
  params: Record<string, string>,
) => HttpResponse<JsonBodyType> | Response | Promise<HttpResponse<JsonBodyType> | Response>

const methodOf = {
  GET: http.get,
  POST: http.post,
  PATCH: http.patch,
  PUT: http.put,
  DELETE: http.delete,
} as const

export function apiError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): HttpResponse<JsonBodyType> {
  return HttpResponse.json(
    { error: { code, message: code, ...(details ? { details } : {}), request_id: 'req-inv-1' } },
    { status },
  )
}

const ROUTES = {
  ...inventoryRoutes,
  listProducts: catalogRoutes.listProducts,
  lookupProduct: catalogRoutes.lookupProduct,
  listCategories: catalogRoutes.listCategories,
  listSuppliers: partiesRoutes.listSuppliers,
  listStores: identityRoutes.listStores,
} satisfies Record<string, RouteDef>

export type InventoryRouteKey = keyof typeof ROUTES

export function createInventoryApi(replies: Partial<Record<InventoryRouteKey, Reply>> = {}) {
  const calls: Call[] = []

  const defaults: Record<InventoryRouteKey, Reply> = {
    listStock: (c) => {
      if (c.query.get('format') === 'csv')
        return new HttpResponse('name,qty\n', {
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="stock.csv"',
          },
        })
      return HttpResponse.json(F.stockList())
    },
    stockAlerts: () => HttpResponse.json({ data: F.stockAlerts() }),
    listMovements: (c) => {
      if (c.query.get('format') === 'csv')
        return new HttpResponse('date,type\n', { headers: { 'Content-Type': 'text/csv' } })
      return HttpResponse.json({ data: F.movements(), page: F.page(3) })
    },
    productStock: () => HttpResponse.json({ data: F.productStock() }),
    postOpeningStock: () =>
      HttpResponse.json(
        {
          data: {
            adjustment: F.adjustmentDetail({ kind: 'opening', number: 'ADJS1/2627/00010' }),
            total_value_paise: 2_760_000,
            journal_entry_id: F.iid(7691),
            batches_created: [],
          },
        },
        { status: 201 },
      ),
    listBatches: () => HttpResponse.json({ data: F.batches(), page: F.page(3) }),
    updateBatch: (c) =>
      HttpResponse.json({ data: { ...F.batch(), ...(c.body as Record<string, unknown>) } }),
    listAdjustments: () =>
      HttpResponse.json({
        data: [F.adjustment(), F.draftAdjustmentRow()],
        page: F.page(2),
      }),
    createAdjustment: () =>
      HttpResponse.json(
        { data: F.adjustmentDetail({ id: F.iid(7609), status: 'draft' }) },
        {
          status: 201,
        },
      ),
    getAdjustment: (_c, p) =>
      HttpResponse.json({
        data: p.id === F.ADJ_DRAFT_ID ? F.draftStockTake() : F.adjustmentDetail(),
      }),
    updateAdjustment: (_c, p) =>
      HttpResponse.json({
        data: p.id === F.ADJ_DRAFT_ID ? F.draftStockTake() : F.adjustmentDetail(),
      }),
    deleteAdjustment: () => new HttpResponse(null, { status: 204 }),
    postAdjustment: () => HttpResponse.json({ data: F.adjustmentDetail() }),
    cancelAdjustment: () =>
      HttpResponse.json({
        data: F.adjustmentDetail({
          status: 'cancelled',
          cancelled_at: F.NOW,
          cancelled_by_name: 'Murugan K',
          cancel_reason: 'Entered twice',
        }),
      }),
    listTransfers: () =>
      HttpResponse.json({
        data: [F.transfer(), F.transfer({ id: F.iid(7802), number: null, status: 'draft' })],
        page: F.page(2),
      }),
    createTransfer: () =>
      HttpResponse.json(
        { data: F.transferDetail({ id: F.iid(7809), number: null, status: 'draft' }) },
        { status: 201 },
      ),
    getTransfer: () => HttpResponse.json({ data: F.transferDetail() }),
    updateTransfer: () => HttpResponse.json({ data: F.transferDetail({ status: 'draft' }) }),
    dispatchTransfer: () => HttpResponse.json({ data: F.transferDetail() }),
    receiveTransfer: () =>
      HttpResponse.json({
        data: F.transferDetail({
          status: 'received',
          received_at: F.NOW,
          received_by_name: 'Selvi',
        }),
      }),
    cancelTransfer: () => HttpResponse.json({ data: F.transferDetail({ status: 'cancelled' }) }),
    // other modules (pickers)
    listProducts: (c) => {
      const ids = c.query.getAll('ids')
      const q = (c.query.get('q') ?? '').toLowerCase()
      const rows = F.catalog().filter(
        (p) =>
          (ids.length === 0 || ids.includes(p.id)) &&
          (!q || p.name.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q)),
      )
      return HttpResponse.json({ data: rows, page: F.page(rows.length, 20) })
    },
    lookupProduct: (c) => {
      const code = c.query.get('code') ?? ''
      const hit = F.catalog().find((p) => p.primary_barcode === code || p.sku === code)
      if (!hit) return apiError(404, 'NOT_FOUND')
      return HttpResponse.json({ data: F.lookupResult(hit, code) })
    },
    listCategories: () => HttpResponse.json({ data: [{ ...F.category(), children: [] }] }),
    listSuppliers: () => HttpResponse.json({ data: [F.supplier()], page: F.page(1, 20) }),
    listStores: () => HttpResponse.json({ data: F.stores(), page: F.page(2, 200) }),
  }

  // Literal paths before parameterised ones (/stock/alerts before /stock/products/:productId).
  const ordered = (Object.entries(ROUTES) as [InventoryRouteKey, RouteDef][]).sort(
    ([, a], [, b]) => (a.path.includes(':') ? 1 : 0) - (b.path.includes(':') ? 1 : 0),
  )

  const handlers: HttpHandler[] = ordered.map(([key, route]) =>
    methodOf[route.method](apiPath(route.path), async ({ request, params }) => {
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
      }
      calls.push(call)
      const reply = replies[key] ?? defaults[key]
      return reply(call, params as Record<string, string>)
    }),
  )

  return {
    calls,
    handlers,
    /** Calls of one route (by method and the concrete path pattern). */
    callsTo(route: RouteDef): Call[] {
      const re = new RegExp(`^/api/v1${route.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`)
      return calls.filter((c) => c.method === route.method && re.test(c.path))
    },
  }
}
