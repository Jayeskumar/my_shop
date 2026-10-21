/**
 * MSW handlers for the parties screens, built from the route catalogues (paths come from the
 * contract definitions, never typed by hand) and answering with the contract-shaped fixtures.
 * Every request is recorded in `calls`, so tests can assert query strings and bodies.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import { type RouteDef } from '@kadai/shared/api/common'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { identityRoutes } from '@kadai/shared/api/identity'
import { notificationsRoutes } from '@kadai/shared/api/notifications'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import { purchasesRoutes } from '@kadai/shared/api/purchases'
import { salesRoutes } from '@kadai/shared/api/sales'
import { apiPath } from '@/test/msw'
import * as F from './fixtures'

export interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: Headers
}

type Reply = (call: Call, params: Record<string, string>) => HttpResponse<JsonBodyType> | Response

const methodOf = {
  GET: http.get,
  POST: http.post,
  PATCH: http.patch,
  PUT: http.put,
  DELETE: http.delete,
} as const

/** URL pattern of a catalogued route for MSW (':id' params work as-is). */
export function routePattern(route: RouteDef): string {
  return apiPath(route.path)
}

export function createPartiesApi(replies: Partial<Record<string, Reply>> = {}) {
  const calls: Call[] = []
  const customer = F.customer({ ...F.customerBook()[0]! })

  const defaults: Record<string, Reply> = {
    lookupCustomer: () =>
      HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'none' } }, { status: 404 }),
    listCustomers: () => HttpResponse.json({ data: F.customerBook(), page: F.page(5) }),
    createCustomer: (c) =>
      HttpResponse.json(
        {
          data: F.customer({
            id: F.pid(150),
            name: String((c.body as { name?: string }).name ?? 'New'),
          }),
        },
        { status: 201 },
      ),
    customerImportTemplate: () =>
      new HttpResponse('name,phone\n', { headers: { 'Content-Type': 'text/csv' } }),
    importCustomers: (c) =>
      HttpResponse.json(
        { data: F.importJob({ dry_run: (c.body as { dry_run?: boolean }).dry_run !== false }) },
        { status: 201 },
      ),
    getCustomer: () => HttpResponse.json({ data: customer }),
    updateCustomer: (c) => HttpResponse.json({ data: { ...customer, ...(c.body as object) } }),
    deleteCustomer: () => HttpResponse.json({ data: { id: customer.id, result: 'deactivated' } }),
    customerLedger: () => HttpResponse.json({ data: F.customerLedger() }),
    customerSummary: () => HttpResponse.json({ data: F.customerSummary() }),
    customerLoyalty: () => HttpResponse.json({ data: F.loyaltyEntries(), page: F.page(3, 20) }),
    adjustLoyalty: (c) => {
      const points = (c.body as { points: number }).points
      return HttpResponse.json({
        data: {
          customer_id: customer.id,
          loyalty_points: 340 + points,
          entry: { ...F.loyaltyEntries()[2]!, points },
        },
      })
    },
    listSuppliers: () => HttpResponse.json({ data: F.supplierBook(), page: F.page(3) }),
    createSupplier: () =>
      HttpResponse.json({ data: F.supplier({ id: F.pid(250) }) }, { status: 201 }),
    getSupplier: () => HttpResponse.json({ data: F.supplier() }),
    updateSupplier: () => HttpResponse.json({ data: F.supplier() }),
    supplierLedger: () => HttpResponse.json({ data: F.supplierLedger() }),
    listDoctors: () => HttpResponse.json({ data: [F.doctor({ id: F.pid(301) })], page: F.page(1) }),
    createDoctor: () => HttpResponse.json({ data: F.doctor({ id: F.pid(302) }) }, { status: 201 }),
    updateDoctor: () => HttpResponse.json({ data: F.doctor({ id: F.pid(301) }) }),
    deleteDoctor: () => HttpResponse.json({ data: { id: F.pid(301), result: 'deleted' } }),
    // other modules
    listInvoices: () => HttpResponse.json(F.invoiceList()),
    listBills: () => HttpResponse.json(F.billList()),
    listPayments: (c) =>
      HttpResponse.json(
        F.paymentList(c.query.get('party_type') === 'supplier' ? 'supplier' : 'customer'),
      ),
    openItems: (c) =>
      HttpResponse.json({
        data: F.openItems(c.query.get('party_type') === 'supplier' ? 'supplier' : 'customer'),
      }),
    createPayment: () =>
      HttpResponse.json(
        {
          data: {
            ...F.paymentList().data[0]!,
            allocations: [],
            intent: null,
            journal_entry_id: null,
            cancelled_by_name: null,
            updated_at: F.NOW,
          },
        },
        { status: 201 },
      ),
    remindCustomer: () =>
      HttpResponse.json({ error: { code: 'INTERNAL', message: 'not set' } }, { status: 500 }),
    uploadFile: () =>
      HttpResponse.json(
        {
          data: {
            id: F.pid(981),
            purpose: 'import',
            filename: 'customers.csv',
            content_type: 'text/csv',
            size_bytes: 120,
            checksum_sha256: 'a'.repeat(64),
            created_by: null,
            created_at: F.NOW,
            content_path: `/files/${F.pid(981)}/content`,
          },
        },
        { status: 201 },
      ),
    getImport: () => HttpResponse.json({ data: F.importJob({ dry_run: false }) }),
    // No open shift unless a test says otherwise.
    currentShift: () => HttpResponse.json({ data: null }),
  }

  const routes: Record<string, RouteDef> = {
    ...partiesRoutes,
    listInvoices: salesRoutes.listInvoices,
    listBills: purchasesRoutes.listBills,
    listPayments: paymentsRoutes.listPayments,
    openItems: paymentsRoutes.openItems,
    createPayment: paymentsRoutes.createPayment,
    remindCustomer: notificationsRoutes.remindCustomer,
    uploadFile: identityRoutes.uploadFile,
    getImport: catalogRoutes.getImport,
    currentShift: accountingRoutes.currentShift,
  }
  // Literal paths before parameterised ones (/customers/lookup before /customers/:id).
  const ordered = Object.entries(routes).sort(([, a], [, b]) => {
    const pa = a.path.includes(':') ? 1 : 0
    const pb = b.path.includes(':') ? 1 : 0
    return pa - pb
  })

  const handlers: HttpHandler[] = ordered.flatMap(([key, route]) => {
    const reply = replies[key] ?? defaults[key]
    if (!reply) return []
    return [
      methodOf[route.method](routePattern(route), async ({ request, params }) => {
        const url = new URL(request.url)
        let body: unknown = undefined
        if (request.method !== 'GET' && request.method !== 'DELETE') {
          const type = request.headers.get('content-type') ?? ''
          // Multipart uploads are not read (jsdom File bodies do not stream under undici).
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
          headers: request.headers,
        }
        calls.push(call)
        return reply(call, params as Record<string, string>)
      }),
    ]
  })

  return {
    calls,
    handlers,
    customer,
    /** Calls of one route (by method and the concrete path pattern). */
    callsTo(route: RouteDef): Call[] {
      const re = new RegExp(`^/api/v1${route.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`)
      return calls.filter((c) => c.method === route.method && re.test(c.path))
    },
  }
}
