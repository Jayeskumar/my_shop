/**
 * MSW handlers for the accounting screens, built from the route catalogues (paths come from the
 * contract definitions, never typed by hand) and answering with the contract-shaped fixtures.
 * Every request is recorded, so tests can assert query strings and request bodies.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import type { RouteDef } from '@kadai/shared/api/common'
import { identityRoutes } from '@kadai/shared/api/identity'
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
    { error: { code, message: code, ...(details ? { details } : {}), request_id: 'req-acc-1' } },
    { status },
  )
}

const ROUTES = {
  ...accountingRoutes,
  listSuppliers: partiesRoutes.listSuppliers,
  userDirectory: identityRoutes.userDirectory,
} satisfies Record<string, RouteDef>

export type AccountingRouteKey = keyof typeof ROUTES

const csv = (name: string) =>
  new HttpResponse('date,amount\n', {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
    },
  })

export function createAccountingApi(replies: Partial<Record<AccountingRouteKey, Reply>> = {}) {
  const calls: Call[] = []

  const defaults: Record<AccountingRouteKey, Reply> = {
    listAccounts: (c) =>
      HttpResponse.json({
        data: F.chart({
          type: c.query.getAll('type'),
          money: c.query.get('money'),
          balances: c.query.get('balances') !== 'false',
          as_of: c.query.get('as_of') ?? undefined,
        }),
      }),
    createAccount: (c) => {
      const body = c.body as { name: string; name_ta?: string | null; type: 'expense' }
      return HttpResponse.json(
        {
          data: {
            ...F.accountDetail(F.A.godownRent),
            id: F.iid(5410),
            code: '5410',
            name: body.name,
            name_ta: body.name_ta ?? null,
            parent_id: null,
            parent: null,
            depth: 0,
            has_entries: false,
          },
        },
        { status: 201 },
      )
    },
    getAccount: (_c, p) => HttpResponse.json({ data: F.accountDetail(p.id ?? F.A.rent) }),
    updateAccount: (c, p) =>
      HttpResponse.json({
        data: { ...F.accountDetail(p.id ?? F.A.rent), ...(c.body as Record<string, unknown>) },
      }),
    deleteAccount: (_c, p) => HttpResponse.json({ data: { id: p.id, result: 'deleted' } }),
    listJournalEntries: (c) =>
      c.query.get('format') === 'csv' ? csv('journal') : HttpResponse.json(F.journalList()),
    getJournalEntry: (_c, p) =>
      HttpResponse.json({
        data: p.id === F.JV_ID ? F.journalDetail() : F.expenseJournalDetail(),
      }),
    createJournalEntry: () =>
      HttpResponse.json(
        { data: F.journalDetail({ id: F.iid(5009), number: 'JVS1/2627/00003' }) },
        { status: 201 },
      ),
    reverseJournalEntry: () =>
      HttpResponse.json(
        {
          data: F.journalDetail({
            id: F.iid(5010),
            number: 'JVS1/2627/00004',
            reverses_entry_id: F.JV_ID,
            can_reverse: false,
          }),
        },
        { status: 201 },
      ),
    listExpenses: (c) =>
      c.query.get('format') === 'csv'
        ? csv('expenses')
        : HttpResponse.json(F.expenseList({ offset: Number(c.query.get('offset') ?? 0) || 0 })),
    createExpense: () =>
      HttpResponse.json({ data: F.expenseDetail({ id: F.iid(2009) }) }, { status: 201 }),
    getExpense: (_c, p) =>
      HttpResponse.json({
        data:
          p.id === F.EXPENSE_ID
            ? F.expenseDetail()
            : F.expenseDetail({ ...F.expenseRows().find((e) => e.id === p.id) }),
      }),
    cancelExpense: (c) =>
      HttpResponse.json({
        data: F.expenseDetail({
          status: 'cancelled',
          cancelled_at: F.NOW,
          cancelled_by: F.USER_ID,
          cancelled_by_name: 'Murugan K',
          cancel_reason: (c.body as { reason: string }).reason,
          reversal_entry_id: F.iid(3102),
          can_cancel: false,
        }),
      }),
    openShift: (c) => {
      const body = c.body as { opening_cash_paise: number }
      return HttpResponse.json(
        {
          data: F.shiftDetail({
            id: F.iid(4009),
            opening_cash_paise: body.opening_cash_paise,
            cash_entries: [],
          }),
        },
        { status: 201 },
      )
    },
    currentShift: () => HttpResponse.json({ data: F.shiftDetail() }),
    listShifts: (c) =>
      c.query.get('format') === 'csv' ? csv('shifts') : HttpResponse.json(F.shiftList()),
    getShift: (_c, p) =>
      HttpResponse.json({
        data: p.id === F.SHIFT_CLOSED_ID ? F.closedShiftDetail() : F.shiftDetail(),
      }),
    addShiftCashEntry: (c) =>
      HttpResponse.json(
        { data: F.cashEntry({ id: F.iid(4109), ...(c.body as Record<string, unknown>) }) },
        { status: 201 },
      ),
    closeShift: () => HttpResponse.json({ data: F.closedShiftDetail({ id: F.SHIFT_OPEN_ID }) }),
    dayBook: (c) =>
      c.query.get('format') === 'csv'
        ? csv('day-book')
        : HttpResponse.json(F.dayBook(c.query.get('date') ?? F.TODAY)),
    cashBook: (c) =>
      c.query.get('format') === 'csv'
        ? csv('cash-book')
        : HttpResponse.json(
            F.ledger(c.query.get('account_id') ?? F.A.cash, {
              from: c.query.get('from') ?? '2026-10-01',
              to: c.query.get('to') ?? F.TODAY,
            }),
          ),
    accountLedger: (c, p) =>
      c.query.get('format') === 'csv'
        ? csv('ledger')
        : HttpResponse.json(
            F.ledger(p.accountId ?? F.A.cash, {
              from: c.query.get('from') ?? '2026-10-01',
              to: c.query.get('to') ?? F.TODAY,
            }),
          ),
    trialBalance: (c) =>
      HttpResponse.json({ data: F.trialBalance(c.query.get('as_of') ?? F.TODAY) }),
    profitLoss: (c) =>
      HttpResponse.json({
        data: F.profitLoss({
          from: c.query.get('from') ?? undefined,
          to: c.query.get('to') ?? undefined,
          compare_from: c.query.get('compare_from') ?? undefined,
          compare_to: c.query.get('compare_to') ?? undefined,
        }),
      }),
    balanceSheet: (c) =>
      HttpResponse.json({ data: F.balanceSheet(c.query.get('as_of') ?? F.TODAY) }),
    // other modules (pickers)
    listSuppliers: () => HttpResponse.json({ data: [F.supplier()], page: F.page(1, 20) }),
    userDirectory: () => HttpResponse.json({ data: F.users() }),
  }

  // Literal paths before parameterised ones (/shifts/current before /shifts/:id).
  const ordered = (Object.entries(ROUTES) as [AccountingRouteKey, RouteDef][]).sort(
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
