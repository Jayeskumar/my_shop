/**
 * MSW helpers for settings tests: handlers are declared from the shared route catalogue entries
 * (method + path pattern), never from hand-written URLs, and requests can be recorded.
 */
import { http, HttpResponse, type JsonBodyType } from 'msw'
import { ROUTE_SCOPE_PREFIX, type RouteDef } from '@kadai/shared/api/common'
import { ORIGIN } from '@/test/msw'

/** MSW URL pattern of a catalogue route ('/users/:id' → 'http://…/api/v1/users/:id'). */
export function routePattern(route: RouteDef): string {
  return `${ORIGIN}${ROUTE_SCOPE_PREFIX[route.scope ?? 'api']}${route.path}`
}

export interface RecordedRequest {
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

type Reply =
  | JsonBodyType
  | HttpResponse<JsonBodyType>
  | ((req: RecordedRequest) => JsonBodyType | HttpResponse<JsonBodyType>)

/**
 * Handler for a catalogue route answering `reply` (JSON body or a full response); every call is
 * pushed to `calls`.
 */
export function onRoute(route: RouteDef, reply: Reply, calls?: RecordedRequest[]) {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'
  return http[method](routePattern(route), async ({ request, params }) => {
    const url = new URL(request.url)
    let body: unknown = undefined
    if (route.method !== 'GET' && route.method !== 'DELETE') {
      const text = await request.text()
      body = text ? (JSON.parse(text) as unknown) : undefined
    }
    const rec: RecordedRequest = {
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      query: url.searchParams,
      body,
    }
    calls?.push(rec)
    const out = typeof reply === 'function' ? reply(rec) : reply
    if (out instanceof HttpResponse) return out
    return HttpResponse.json(out, { status: route.status ?? 200 })
  })
}
