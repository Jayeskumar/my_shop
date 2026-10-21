/**
 * MSW handlers for the purchases screens, built from the route catalogues (paths come from the
 * contract definitions, never typed by hand) and answering with the contract-shaped fixtures.
 * Every request is recorded in `calls`, so tests can assert query strings and bodies.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import type { RouteDef } from '@kadai/shared/api/common'
import { identityRoutes } from '@kadai/shared/api/identity'
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import { purchasesRoutes } from '@kadai/shared/api/purchases'
import { apiPath } from '@/test/msw'
import * as F from './fixtures'

export interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

export type Reply = (
  call: Call,
  params: Record<string, string>,
) => HttpResponse<JsonBodyType> | Response

const methodOf = {
  GET: http.get,
  POST: http.post,
  PATCH: http.patch,
  PUT: http.put,
  DELETE: http.delete,
} as const

const ROUTES: Record<string, RouteDef> = {
  ...purchasesRoutes,
  listSuppliers: partiesRoutes.listSuppliers,
  getSupplier: partiesRoutes.getSupplier,
  listProducts: catalogRoutes.listProducts,
  lookupProduct: catalogRoutes.lookupProduct,
  listBatches: inventoryRoutes.listBatches,
  createPayment: paymentsRoutes.createPayment,
  uploadFile: identityRoutes.uploadFile,
  getFile: identityRoutes.getFile,
  listAccounts: accountingRoutes.listAccounts,
}

const json = (data: unknown, status = 200) => HttpResponse.json(data as JsonBodyType, { status })

export function createPurchasesApi(
  replies: Partial<Record<keyof typeof ROUTES | string, Reply>> = {},
) {
  const calls: Call[] = []
  const defaults: Record<string, Reply> = {
    // bills
    listBills: () => json(F.billList()),
    getBill: (_c, p) =>
      json({
        data:
          p.id === F.IDS.billDraft
            ? F.draftBill()
            : p.id === F.IDS.billOverdue
              ? F.overdueBill()
              : F.bill(),
      }),
    createBill: () => json({ data: F.draftBill() }, 201),
    updateBill: () => json({ data: F.draftBill() }),
    deleteBill: () => new HttpResponse(null, { status: 204 }),
    postBill: () =>
      json({
        data: {
          bill: F.bill({ id: F.IDS.billDraft, paid_paise: 0, payments: [] }),
          price_updates: [],
          batches_created: 1,
          stock_lines: 2,
        },
      }),
    cancelBill: () => json({ data: F.bill({ status: 'cancelled', cancel_reason: 'Wrong bill' }) }),
    billFromOrder: () =>
      json(
        {
          data: F.draftBill({
            purchase_order_id: F.IDS.order,
            purchase_order: { id: F.IDS.order, number: 'POS1/2627/00004' },
          }),
        },
        201,
      ),
    billReturnable: () => json({ data: F.returnable() }),
    // orders
    listOrders: () => json({ data: [F.order(), F.draftOrder()].map(F.orderRow), page: F.page(2) }),
    getOrder: (_c, p) => json({ data: p.id === F.IDS.orderDraft ? F.draftOrder() : F.order() }),
    createOrder: () => json({ data: F.draftOrder() }, 201),
    updateOrder: () => json({ data: F.draftOrder() }),
    deleteOrder: () => new HttpResponse(null, { status: 204 }),
    sendOrder: () =>
      json({
        data: {
          order: F.draftOrder({ status: 'sent', sent_at: F.NOW }),
          notification_id: null,
          message: 'Purchase order POS1/2627/00005\n1. Aashirvaad Atta 5 kg — 40 pcs',
          wa_me_url: 'https://wa.me/919443012345?text=PO',
        },
      }),
    cancelOrder: () => json({ data: F.draftOrder({ status: 'cancelled' }) }),
    closeOrder: () => json({ data: F.order({ status: 'closed' }) }),
    reorderSuggestions: () => json({ data: F.reorderSuggestions() }),
    // debit notes
    listDebitNotes: () => json(F.debitNoteList()),
    getDebitNote: () => json({ data: F.debitNote() }),
    createDebitNote: () => json({ data: F.debitNote() }, 201),
    cancelDebitNote: () => json({ data: F.debitNote({ status: 'cancelled' }) }),
    debitNotePrefill: () => json({ data: F.debitNotePrefill() }),
    // other modules
    listSuppliers: () =>
      json({ data: [F.supplierListItem(), F.supplier2ListItem()], page: F.page(2, 20) }),
    getSupplier: (_c, p) =>
      json({
        data: p.id === F.IDS.supplier2 ? F.supplier({ ...F.supplier2ListItem() }) : F.supplier(),
      }),
    listProducts: (c) => {
      const q = (c.query.get('q') ?? '').toLowerCase()
      const all = [F.product(), F.doloProduct(), F.oilProduct()]
      const rows = q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all
      return json({ data: rows, page: F.page(rows.length, 20) })
    },
    lookupProduct: () => json({ error: { code: 'NOT_FOUND', message: 'none' } }, 404),
    listBatches: () => json({ data: [F.batchRow()], page: F.page(1, 200) }),
    createPayment: (c) =>
      json(
        {
          data: F.paymentDetail({
            amount_paise: (c.body as { amount_paise?: number }).amount_paise ?? 0,
          }),
        },
        201,
      ),
    uploadFile: () =>
      json(
        {
          data: {
            id: F.IDS.file,
            purpose: 'attachment',
            filename: 'bill.jpg',
            content_type: 'image/jpeg',
            size_bytes: 2048,
            checksum_sha256: 'a'.repeat(64),
            created_by: null,
            created_at: F.NOW,
            content_path: `/files/${F.IDS.file}/content`,
          },
        },
        201,
      ),
    listAccounts: () =>
      json({ data: { as_of: F.TODAY, store_id: null, accounts: [], totals: [] } }),
  }

  // Literal paths before parameterised ones (/debit-notes/prefill before /debit-notes/:id).
  const ordered = Object.entries(ROUTES).sort(([, a], [, b]) => {
    const pa = a.path.includes(':') ? 1 : 0
    const pb = b.path.includes(':') ? 1 : 0
    return pa - pb
  })

  const handlers: HttpHandler[] = ordered.flatMap(([key, route]) => {
    const reply = replies[key] ?? defaults[key]
    if (!reply) return []
    return [
      methodOf[route.method](apiPath(route.path), async ({ request, params }) => {
        const url = new URL(request.url)
        let body: unknown = undefined
        if (request.method !== 'GET' && request.method !== 'DELETE') {
          const type = request.headers.get('content-type') ?? ''
          body = type.includes('json')
            ? await request.json()
            : type.includes('multipart')
              ? 'multipart'
              : await request.text()
        }
        const call: Call = {
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          body,
        }
        calls.push(call)
        return reply(call, params as Record<string, string>)
      }),
    ]
  })

  return {
    calls,
    handlers,
    /** Calls of one route (method + concrete path pattern). */
    callsTo(route: RouteDef): Call[] {
      const re = new RegExp(`^/api/v1${route.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`)
      return calls.filter((c) => c.method === route.method && re.test(c.path))
    },
  }
}
