/**
 * MSW handlers for the notifications screens, built from the route catalogues (paths come from
 * the contract definitions, never typed by hand) and answering with contract-shaped fixtures.
 * Every request is recorded, so tests can assert query strings, bodies and headers. A reply can
 * be replaced per route key: `createNotificationsApi({ retryNotification: () => errorResponse(…) })`.
 */
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw'
import type { RouteDef } from '@kadai/shared/api/common'
import { identityRoutes } from '@kadai/shared/api/identity'
import {
  type NotificationTemplateCatalog,
  notificationsRoutes,
} from '@kadai/shared/api/notifications'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { DEFAULT_SETTINGS } from '@kadai/shared/settings'
import { makeMe } from '@/test/fixtures'
import { apiPath } from '@/test/msw'
import * as F from './fixtures'

export interface Call {
  key: string
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: Headers
  params: Record<string, string>
}

type Reply = (call: Call) => HttpResponse<JsonBodyType> | Response | Promise<Response>

const ROUTES = {
  listNotifications: notificationsRoutes.listNotifications,
  getNotification: notificationsRoutes.getNotification,
  retryNotification: notificationsRoutes.retryNotification,
  sendNotification: notificationsRoutes.sendNotification,
  listTemplates: notificationsRoutes.listTemplates,
  upsertTemplate: notificationsRoutes.upsertTemplate,
  deleteTemplate: notificationsRoutes.deleteTemplate,
  remindCustomer: notificationsRoutes.remindCustomer,
  updateSettings: identityRoutes.updateSettings,
  getSettings: identityRoutes.getSettings,
  customerSummary: partiesRoutes.customerSummary,
  listCustomers: partiesRoutes.listCustomers,
  lookupCustomer: partiesRoutes.lookupCustomer,
} satisfies Record<string, RouteDef>

export type RouteKey = keyof typeof ROUTES

const methodOf = {
  GET: http.get,
  POST: http.post,
  PATCH: http.patch,
  PUT: http.put,
  DELETE: http.delete,
} as const

export function createNotificationsApi(
  replies: Partial<Record<RouteKey, Reply>> = {},
  state: { catalog?: NotificationTemplateCatalog } = {},
) {
  const calls: Call[] = []
  let catalog = state.catalog ?? F.catalog()
  const tenant = makeMe().tenant

  const defaults: Record<RouteKey, Reply> = {
    listNotifications: () => HttpResponse.json(F.outboxList()),
    getNotification: (c) => {
      const row = F.outboxRows().find((r) => r.id === c.params.id)
      return row
        ? HttpResponse.json({ data: row })
        : HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 })
    },
    retryNotification: (c) => {
      const row = F.outboxRows().find((r) => r.id === c.params.id) ?? F.notification()
      return HttpResponse.json({
        data: { ...row, status: 'queued', error: null, attempts: 0, can_retry: false },
      })
    },
    sendNotification: (c) => {
      const b = c.body as {
        channel: 'sms' | 'whatsapp' | 'email'
        template_code: string
        to: string
      }
      return HttpResponse.json(
        {
          data: F.notification({
            id: F.nid(77),
            channel: b.channel,
            template_code: b.template_code,
            recipient: b.to,
            status: 'queued',
            rendered_body: null,
            sent_at: null,
            provider: null,
            provider_message_id: null,
            attempts: 0,
            ref_type: null,
            ref_id: null,
            ref_path: null,
          }),
        },
        { status: 201 },
      )
    },
    listTemplates: () => HttpResponse.json({ data: catalog }),
    upsertTemplate: (c) => {
      const b = c.body as {
        subject: string | null
        body: string
        provider_template_id: string | null
        is_active?: boolean
      }
      const entry = F.templateEntry(
        c.params.code as never,
        c.params.channel as never,
        c.params.locale as never,
        {
          code: c.params.code as never,
          channel: c.params.channel as never,
          locale: c.params.locale as never,
          subject: b.subject,
          body: b.body,
          provider_template_id: b.provider_template_id,
          is_active: b.is_active ?? true,
        },
      )
      return HttpResponse.json({ data: entry })
    },
    deleteTemplate: (c) =>
      HttpResponse.json({
        data: F.templateEntry(
          c.params.code as never,
          c.params.channel as never,
          c.params.locale as never,
        ),
      }),
    remindCustomer: (c) => {
      const b = (c.body ?? {}) as { channel?: 'whatsapp' | 'sms' | 'wa_me' }
      const channel = b.channel ?? 'whatsapp'
      return HttpResponse.json({
        data: F.remindResult(
          channel === 'wa_me'
            ? {
                channel,
                notification: null,
                wa_me_url: 'https://wa.me/919876543210?text=hello',
              }
            : { channel },
        ),
      })
    },
    updateSettings: (c) => {
      const b = c.body as { notifications?: Record<string, unknown> }
      const notifications = { ...catalog.settings, ...(b.notifications ?? {}) }
      catalog = { ...catalog, settings: notifications as typeof catalog.settings }
      return HttpResponse.json({ data: F.settingsResponse(notifications, tenant) })
    },
    getSettings: () =>
      HttpResponse.json({ data: F.settingsResponse(DEFAULT_SETTINGS.notifications, tenant) }),
    customerSummary: () => HttpResponse.json({ data: F.customerSummary() }),
    listCustomers: () =>
      HttpResponse.json({
        data: [
          F.customer(),
          F.customer({ id: F.nid(905), name: 'Kannan', name_ta: 'கண்ணன்', balance_paise: 80_000 }),
        ],
        page: { limit: 20, offset: 0, total: 2 },
      }),
    lookupCustomer: () =>
      HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'none' } }, { status: 404 }),
  }

  const handlers: HttpHandler[] = (Object.keys(ROUTES) as RouteKey[]).map((key) => {
    const route = ROUTES[key]
    return methodOf[route.method](apiPath(route.path), async ({ request, params }) => {
      const url = new URL(request.url)
      let body: unknown = undefined
      if (request.method !== 'GET' && request.method !== 'DELETE') {
        const text = await request.text()
        body = text ? (JSON.parse(text) as unknown) : undefined
      }
      const call: Call = {
        key,
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: request.headers,
        params: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? '') : String(v)]),
        ),
      }
      calls.push(call)
      return (replies[key] ?? defaults[key])(call)
    })
  })

  return {
    handlers,
    calls,
    callsTo: (key: RouteKey) => calls.filter((c) => c.key === key),
    get catalog() {
      return catalog
    },
  }
}
