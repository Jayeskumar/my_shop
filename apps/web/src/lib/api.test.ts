import { http, HttpResponse } from 'msw'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { SessionResponseSchema } from '@kadai/shared/api/auth'
import { defineRoutes, dataOf } from '@kadai/shared/api/common'
import { z } from 'zod'
import { makeMe, makeSession } from '@/test/fixtures'
import { ORIGIN, apiPath, errorResponse, server } from '@/test/msw'
import {
  ApiError,
  api,
  buildQuery,
  callRoute,
  createSseParser,
  getAccessToken,
  onAuthEvent,
  refreshSession,
  setSession,
  type RouteCallInput,
  type SseMessage,
} from './api'
import { getOnlineStatus } from './online'

describe('buildQuery', () => {
  it('drops empty values and repeats array keys', () => {
    expect(buildQuery({ q: 'rice', limit: 50, empty: '', none: null, u: undefined })).toBe(
      '?q=rice&limit=50',
    )
    expect(buildQuery({ ids: ['a', 'b'], active: true })).toBe('?ids=a&ids=b&active=true')
    expect(buildQuery({})).toBe('')
    expect(buildQuery({ q: 'அரிசி 1kg' })).toBe(
      '?q=%E0%AE%85%E0%AE%B0%E0%AE%BF%E0%AE%9A%E0%AE%BF+1kg',
    )
  })
})

describe('api request basics', () => {
  it('sends JSON with the CSRF header, bearer token, credentials and idempotency key', async () => {
    setSession(makeSession({ access_token: 'tok-1' }), { broadcast: false })
    let seen: Request | null = null
    server.use(
      http.post(apiPath('/sales/invoices'), async ({ request }) => {
        seen = request.clone()
        return HttpResponse.json({ data: { id: 'x' } }, { status: 201 })
      }),
    )
    const body = await api.post<{ data: { id: string } }>(
      '/sales/invoices',
      { total_paise: 11800, client_ref: 'abc' },
      { idempotencyKey: 'idem-key-123' },
    )
    expect(body.data.id).toBe('x')
    const req = seen as unknown as Request
    expect(req.headers.get('x-requested-with')).toBe('kadai')
    expect(req.headers.get('authorization')).toBe('Bearer tok-1')
    expect(req.headers.get('idempotency-key')).toBe('idem-key-123')
    expect(req.headers.get('content-type')).toBe('application/json')
    expect(req.credentials).toBe('include')
    expect(await req.json()).toEqual({ total_paise: 11800, client_ref: 'abc' })
  })

  it('passes query strings and returns undefined for 204', async () => {
    server.use(
      http.get(apiPath('/products'), ({ request }) => {
        const url = new URL(request.url)
        return HttpResponse.json({
          data: [{ q: url.searchParams.get('q') }],
          page: { limit: Number(url.searchParams.get('limit')), offset: 0, total: 1 },
        })
      }),
      http.delete(apiPath('/products/1'), () => new HttpResponse(null, { status: 204 })),
    )
    const list = await api.get<{ data: { q: string }[]; page: { limit: number } }>('/products', {
      query: { q: 'dal', limit: 20 },
    })
    expect(list.data[0]?.q).toBe('dal')
    expect(list.page.limit).toBe(20)
    await expect(api.del('/products/1')).resolves.toBeUndefined()
  })

  it('maps the error envelope to ApiError', async () => {
    server.use(
      http.post(apiPath('/products'), () =>
        errorResponse(400, 'VALIDATION_ERROR', 'Invalid body', {
          issues: [{ path: 'name', message: 'Required' }],
        }),
      ),
    )
    const error = await api.post('/products', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    const e = error as ApiError
    expect(e.status).toBe(400)
    expect(e.code).toBe('VALIDATION_ERROR')
    expect(e.message).toBe('Invalid body')
    expect(e.requestId).toBe('req-test-1')
    expect(e.validationIssues).toEqual([{ path: 'name', message: 'Required' }])
    expect(e.is('VALIDATION_ERROR')).toBe(true)
  })

  it('maps non-envelope errors by status and reads Retry-After', async () => {
    server.use(
      http.get(
        apiPath('/busy'),
        () => new HttpResponse('slow down', { status: 429, headers: { 'Retry-After': '7' } }),
      ),
    )
    const e = (await api.get('/busy').catch((x: unknown) => x)) as ApiError
    expect(e.code).toBe('RATE_LIMITED')
    expect(e.retryAfterSeconds).toBe(7)
  })

  it('turns network failures into NETWORK_ERROR and marks the server unreachable', async () => {
    server.use(http.get(apiPath('/down'), () => HttpResponse.error()))
    const e = (await api.get('/down').catch((x: unknown) => x)) as ApiError
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('NETWORK_ERROR')
    expect(e.status).toBe(0)
    expect(e.isNetworkError).toBe(true)
    expect(getOnlineStatus().serverReachable).toBe(false)
  })

  it('rejects with AbortError (not ApiError) when the caller aborts', async () => {
    server.use(
      http.get(apiPath('/slow'), async () => {
        await new Promise((r) => setTimeout(r, 200))
        return HttpResponse.json({ data: 1 })
      }),
    )
    const controller = new AbortController()
    const promise = api.get('/slow', { signal: controller.signal })
    controller.abort()
    const e = await promise.catch((x: unknown) => x)
    expect(e).not.toBeInstanceOf(ApiError)
    expect((e as Error).name).toBe('AbortError')
  })

  it('times out with TIMEOUT', async () => {
    server.use(
      http.get(apiPath('/hang'), async () => {
        await new Promise((r) => setTimeout(r, 500))
        return HttpResponse.json({ data: 1 })
      }),
    )
    const e = (await api.get('/hang', { timeoutMs: 50 }).catch((x: unknown) => x)) as ApiError
    expect(e.code).toBe('TIMEOUT')
  })
})

describe('token refresh', () => {
  it('refreshes once for concurrent 401s and retries each request with the new token', async () => {
    setSession(makeSession({ access_token: 'expired' }), { broadcast: false })
    let refreshCalls = 0
    server.use(
      http.post(apiPath('/auth/refresh'), async ({ request }) => {
        refreshCalls++
        expect(request.headers.get('x-requested-with')).toBe('kadai')
        await new Promise((r) => setTimeout(r, 20))
        return HttpResponse.json({ data: makeSession({ access_token: 'fresh' }) })
      }),
      http.get(apiPath('/items/:n'), ({ request, params }) => {
        if (request.headers.get('authorization') !== 'Bearer fresh') {
          return errorResponse(401, 'UNAUTHENTICATED')
        }
        return HttpResponse.json({ data: Number(params.n) })
      }),
    )
    const events: string[] = []
    onAuthEvent((e) => events.push(e.type))

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => api.get<{ data: number }>(`/items/${n}`)),
    )
    expect(results.map((r) => r.data)).toEqual([1, 2, 3, 4])
    expect(refreshCalls).toBe(1)
    expect(getAccessToken()).toBe('fresh')
    expect(events).toEqual(['session'])
  })

  it('signs out (unauthenticated event) when the refresh is rejected', async () => {
    setSession(makeSession({ access_token: 'revoked' }), { broadcast: false })
    server.use(http.get(apiPath('/me'), () => errorResponse(401, 'SESSION_REVOKED')))
    const listener = vi.fn()
    onAuthEvent(listener)
    const e = (await api.get('/me').catch((x: unknown) => x)) as ApiError
    expect(e.code).toBe('SESSION_REVOKED')
    expect(getAccessToken()).toBeNull()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'unauthenticated' }))
  })

  it('does not refresh on 401 from the login endpoint', async () => {
    let refreshCalls = 0
    server.use(
      http.post(apiPath('/auth/refresh'), () => {
        refreshCalls++
        return errorResponse(401, 'UNAUTHENTICATED')
      }),
      http.post(apiPath('/auth/login'), () => errorResponse(401, 'INVALID_CREDENTIALS')),
    )
    const e = (await api
      .post('/auth/login', { identifier: 'x', password: 'y' }, { auth: false })
      .catch((x: unknown) => x)) as ApiError
    expect(e.code).toBe('INVALID_CREDENTIALS')
    expect(refreshCalls).toBe(0)
  })

  it('keeps the session when the refresh fails because the server is unreachable', async () => {
    setSession(makeSession({ access_token: 'old' }), { broadcast: false })
    server.use(http.post(apiPath('/auth/refresh'), () => HttpResponse.error()))
    await expect(refreshSession()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(getAccessToken()).toBe('old')
  })

  it('refreshes proactively when the token is about to expire', async () => {
    setSession(makeSession({ access_token: 'stale', expires_in: 10 }), { broadcast: false })
    server.use(
      http.post(apiPath('/auth/refresh'), () =>
        HttpResponse.json({ data: makeSession({ access_token: 'renewed' }) }),
      ),
      http.get(apiPath('/ping'), ({ request }) =>
        HttpResponse.json({ data: request.headers.get('authorization') }),
      ),
    )
    const res = await api.get<{ data: string }>('/ping')
    expect(res.data).toBe('Bearer renewed')
  })
})

describe('callRoute', () => {
  const routes = defineRoutes({
    getThing: {
      method: 'GET',
      path: '/things/:id',
      params: z.object({ id: z.string() }),
      query: z.object({ ids: z.array(z.string()).optional(), q: z.string().optional() }),
      response: dataOf(z.object({ id: z.string(), qty_milli: z.int() })),
    },
    createThing: {
      method: 'POST',
      path: '/things',
      idempotent: true,
      body: z.object({ name: z.string() }),
      response: dataOf(z.object({ id: z.string() })),
      status: 201,
    },
    publicThing: {
      method: 'GET',
      path: '/things/:token',
      scope: 'public',
      auth: 'public',
      params: z.object({ token: z.string() }),
      response: dataOf(z.object({ ok: z.boolean() })),
    },
    removeThing: { method: 'DELETE', path: '/things/:id', params: z.object({ id: z.string() }) },
  })

  it('builds the URL, query, body and headers from the route definition', async () => {
    setSession(makeSession({ access_token: 'tok-r' }), { broadcast: false })
    let url: URL | null = null
    let seen: Request | null = null
    server.use(
      http.get(apiPath('/things/abc'), ({ request }) => {
        url = new URL(request.url)
        return HttpResponse.json({ data: { id: 'abc', qty_milli: 1500 } })
      }),
      http.post(apiPath('/things'), async ({ request }) => {
        seen = request.clone()
        return HttpResponse.json({ data: { id: 'new' } }, { status: 201 })
      }),
    )
    const res = await callRoute(routes.getThing, {
      params: { id: 'abc' },
      query: { ids: ['a', 'b'], q: 'dal' },
    })
    expectTypeOf(res).toEqualTypeOf<{ data: { id: string; qty_milli: number } }>()
    expect(res.data).toEqual({ id: 'abc', qty_milli: 1500 })
    expect((url as URL | null)?.search).toBe('?ids=a&ids=b&q=dal')

    const created = await callRoute(routes.createThing, {
      body: { name: 'x' },
      idempotencyKey: 'idem-thing-1',
    })
    expect(created.data.id).toBe('new')
    const req = seen as unknown as Request
    expect(req.headers.get('idempotency-key')).toBe('idem-thing-1')
    expect(req.headers.get('authorization')).toBe('Bearer tok-r')
    expect(await req.json()).toEqual({ name: 'x' })
  })

  it('sends no token to public routes and resolves 204 routes to undefined', async () => {
    setSession(makeSession({ access_token: 'tok-p' }), { broadcast: false })
    let auth: string | null = 'unset'
    server.use(
      http.get(`${ORIGIN}/public/v1/things/t-1`, ({ request }) => {
        auth = request.headers.get('authorization')
        return HttpResponse.json({ data: { ok: true } })
      }),
      http.delete(apiPath('/things/abc'), () => new HttpResponse(null, { status: 204 })),
    )
    const res = await callRoute(routes.publicThing, { params: { token: 't-1' } })
    expect(res.data.ok).toBe(true)
    expect(auth).toBeNull()
    await expect(callRoute(routes.removeThing, { params: { id: 'abc' } })).resolves.toBeUndefined()
  })

  it('logs contract drift in development but still returns the body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(
      http.get(apiPath('/things/abc'), () =>
        HttpResponse.json({ data: { id: 'abc', qty_milli: 'x' } }),
      ),
    )
    const res = await callRoute(routes.getThing, { params: { id: 'abc' } })
    expect((res.data as { qty_milli: unknown }).qty_milli).toBe('x')
    expect(log).toHaveBeenCalledTimes(1)
    log.mockClear()
    await callRoute(routes.getThing, { params: { id: 'abc' }, validate: false })
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('requires params exactly when the route has path params (types)', () => {
    // Never invoked: the assertions are the compile-time errors below.
    const typeOnly = () => {
      // @ts-expect-error params are required for routes with path params
      void callRoute(routes.publicThing)
      // @ts-expect-error the param names come from the route's params schema
      void callRoute(routes.publicThing, { params: { id: 'x' } })
      void callRoute(routes.createThing, { body: { name: 'ok' } })
      // @ts-expect-error bodies are typed by the route's body schema
      void callRoute(routes.createThing, { body: { title: 'no' } })
    }
    expectTypeOf<RouteCallInput<typeof routes.createThing>['params']>().toEqualTypeOf<undefined>()
    expect(typeof typeOnly).toBe('function')
  })
})

describe('SSE parser', () => {
  it('parses events split across chunks, multi-line data, ids and comments', () => {
    const messages: SseMessage[] = []
    const parser = createSseParser((m) => messages.push(m))
    parser.push(': keep-alive\n')
    parser.push('event: status\nid: 7\nda')
    parser.push('ta: {"status":"pending"}\n\n')
    parser.push('data: line1\r\ndata: line2\r\n\r\n')
    parser.push('retry: 5000\n\n')
    expect(messages).toEqual([
      { event: 'status', data: '{"status":"pending"}', id: '7' },
      { event: 'message', data: 'line1\nline2', id: '7' },
    ])
    expect(parser.retryMs()).toBe(5000)
    expect(parser.lastEventId()).toBe('7')
  })
})

describe('fixtures', () => {
  it('session fixture satisfies the shared contract', () => {
    expect(SessionResponseSchema.safeParse(makeSession()).success).toBe(true)
  })
})

describe('cross-tab session sync', () => {
  it('adopts a session broadcast by another tab and follows its sign-out', async () => {
    // The auth store follows the other tab's business by loading /me.
    server.use(http.get(apiPath('/me'), () => HttpResponse.json({ data: makeMe() })))
    const events: string[] = []
    onAuthEvent((e) => events.push(e.type === 'session' ? `session:${e.source}` : e.type))
    const otherTab = new BroadcastChannel('kadai-auth')
    otherTab.postMessage({
      type: 'session',
      session: makeSession({ access_token: 'from-other-tab' }),
    })
    await vi.waitFor(() => expect(getAccessToken()).toBe('from-other-tab'))
    otherTab.postMessage({ type: 'logout' })
    await vi.waitFor(() => expect(getAccessToken()).toBeNull())
    expect(events).toEqual(['session:broadcast', 'unauthenticated'])
    otherTab.close()
  })

  it('tells other tabs about a refreshed session', async () => {
    setSession(makeSession({ access_token: 'old' }), { broadcast: false })
    server.use(
      http.post(apiPath('/auth/refresh'), () =>
        HttpResponse.json({ data: makeSession({ access_token: 'rotated' }) }),
      ),
    )
    const otherTab = new BroadcastChannel('kadai-auth')
    const received: unknown[] = []
    otherTab.onmessage = (e: MessageEvent) => received.push(e.data)
    await refreshSession()
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toMatchObject({ type: 'session', session: { access_token: 'rotated' } })
    otherTab.close()
  })
})
