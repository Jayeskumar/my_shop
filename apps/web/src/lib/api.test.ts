import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { SessionResponseSchema } from '@kadai/shared/api/auth'
import { defineRoutes, dataOf } from '@kadai/shared/api/common'
import { z } from 'zod'
import { makeSession } from '@/test/fixtures'
import { apiPath, errorResponse, server } from '@/test/msw'
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
      response: dataOf(z.object({ id: z.string(), qty_milli: z.int() })),
    },
  })

  it('builds the URL from the route definition and validates the response', async () => {
    server.use(
      http.get(apiPath('/things/abc'), () =>
        HttpResponse.json({ data: { id: 'abc', qty_milli: 1500, extra: true } }),
      ),
    )
    const res = await callRoute(routes.getThing, { params: { id: 'abc' } })
    expect(res.data).toEqual({ id: 'abc', qty_milli: 1500 })
  })

  it('returns the raw body (and logs) when the response drifts from the contract', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(
      http.get(apiPath('/things/abc'), () =>
        HttpResponse.json({ data: { id: 'abc', qty_milli: 'x' } }),
      ),
    )
    const res = await callRoute(routes.getThing, { params: { id: 'abc' } })
    expect((res.data as { qty_milli: unknown }).qty_milli).toBe('x')
    expect(log).toHaveBeenCalled()
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
