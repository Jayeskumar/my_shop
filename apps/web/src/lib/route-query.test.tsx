import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { dataOf, defineRoutes, listOf } from '@kadai/shared/api/common'
import { testQueryClient } from '@/test/render'
import { apiPath, errorResponse, server } from '@/test/msw'
import type { ApiError } from './api'
import { invalidateRoutes, routeQueryKey, useRouteMutation, useRouteQuery } from './query'

const Brand = z.object({ id: z.string(), name: z.string() })
const routes = defineRoutes({
  listBrands: {
    method: 'GET',
    path: '/brands',
    query: z.object({ q: z.string().optional(), limit: z.coerce.number().optional() }),
    response: listOf(Brand),
  },
  getBrand: {
    method: 'GET',
    path: '/brands/:id',
    params: z.object({ id: z.string() }),
    response: dataOf(Brand),
  },
  createBrand: {
    method: 'POST',
    path: '/brands',
    idempotent: true,
    status: 201,
    body: z.object({ name: z.string() }),
    response: dataOf(Brand),
  },
  renameBrand: {
    method: 'PATCH',
    path: '/brands/:id',
    params: z.object({ id: z.string() }),
    body: z.object({ name: z.string() }),
    response: dataOf(Brand),
  },
})

function setup() {
  const client = testQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, wrapper }
}

describe('routeQueryKey / invalidateRoutes', () => {
  it('keys queries by the full path template, params and query', () => {
    expect(routeQueryKey(routes.getBrand, { params: { id: 'b1' } })).toEqual([
      'route',
      '/api/v1/brands/:id',
      { id: 'b1' },
      {},
    ])
    expect(routeQueryKey(routes.listBrands)).toEqual(['route', '/api/v1/brands'])
  })

  it('invalidates a route and the routes nested under its path', async () => {
    const { client } = setup()
    client.setQueryData(routeQueryKey(routes.listBrands, { query: { q: 'a' } }), { data: [] })
    client.setQueryData(routeQueryKey(routes.getBrand, { params: { id: 'b1' } }), { data: {} })
    client.setQueryData(['route', '/api/v1/brands-archive', {}, {}], { data: [] })
    client.setQueryData(['catalog', 'brands'], { data: [] })
    await invalidateRoutes(client, [routes.listBrands])
    const stale = client
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.isInvalidated)
      .map((q) => q.queryKey[1])
    expect(stale.sort()).toEqual(['/api/v1/brands', '/api/v1/brands/:id'])
  })
})

describe('useRouteQuery', () => {
  it('fetches through the route definition with params and query', async () => {
    let search = ''
    server.use(
      http.get(apiPath('/brands'), ({ request }) => {
        search = new URL(request.url).search
        return HttpResponse.json({
          data: [{ id: 'b1', name: 'Aachi' }],
          page: { limit: 20, offset: 0, total: 1 },
        })
      }),
      http.get(apiPath('/brands/b1'), () =>
        HttpResponse.json({ data: { id: 'b1', name: 'Aachi' } }),
      ),
    )
    const { wrapper } = setup()
    const list = renderHook(
      () => useRouteQuery(routes.listBrands, { query: { q: 'aa', limit: 20 } }),
      { wrapper },
    )
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(list.result.current.data?.data[0]?.name).toBe('Aachi')
    expect(search).toBe('?q=aa&limit=20')

    const one = renderHook(
      () =>
        useRouteQuery(routes.getBrand, { params: { id: 'b1' } }, { select: (r) => r.data.name }),
      { wrapper },
    )
    await waitFor(() => expect(one.result.current.data).toBe('Aachi'))
    expectTypeOf(one.result.current.data).toEqualTypeOf<string | undefined>()
  })

  it('exposes ApiError failures and honours enabled', async () => {
    let calls = 0
    server.use(
      http.get(apiPath('/brands/missing'), () => {
        calls++
        return errorResponse(404, 'NOT_FOUND')
      }),
    )
    const { wrapper } = setup()
    const disabled = renderHook(
      () => useRouteQuery(routes.getBrand, { params: { id: 'missing' } }, { enabled: false }),
      { wrapper },
    )
    expect(disabled.result.current.fetchStatus).toBe('idle')
    expect(calls).toBe(0)
    const failing = renderHook(
      () =>
        useRouteQuery(
          routes.getBrand,
          { params: { id: 'missing' } },
          { meta: { errorToast: false } },
        ),
      { wrapper },
    )
    await waitFor(() => expect(failing.result.current.isError).toBe(true))
    expectTypeOf(failing.result.current.error).toEqualTypeOf<ApiError | null>()
    expect(failing.result.current.error?.code).toBe('NOT_FOUND')
  })
})

describe('useRouteMutation', () => {
  it('sends a fresh Idempotency-Key per call on idempotent routes and invalidates', async () => {
    const keys: (string | null)[] = []
    server.use(
      http.post(apiPath('/brands'), async ({ request }) => {
        keys.push(request.headers.get('idempotency-key'))
        const body = (await request.json()) as { name: string }
        return HttpResponse.json({ data: { id: 'new', name: body.name } }, { status: 201 })
      }),
    )
    const { client, wrapper } = setup()
    client.setQueryData(routeQueryKey(routes.listBrands, {}), { data: [], page: {} })
    const { result } = renderHook(
      () => useRouteMutation(routes.createBrand, { invalidates: [routes.listBrands] }),
      { wrapper },
    )
    let created: unknown
    await act(async () => {
      created = await result.current.mutateAsync({ body: { name: 'Sakthi' } })
    })
    expect(created).toEqual({ data: { id: 'new', name: 'Sakthi' } })
    await act(async () => {
      await result.current.mutateAsync({ body: { name: 'Again' }, idempotencyKey: 'form-key-123' })
    })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(keys[1]).toBe('form-key-123')
    const listQuery = client
      .getQueryCache()
      .find({ queryKey: routeQueryKey(routes.listBrands, {}) })
    expect(listQuery?.state.isInvalidated).toBe(true)
  })

  it('sends no key for non-idempotent routes and calls the caller onSuccess', async () => {
    let key: string | null = 'unset'
    server.use(
      http.patch(apiPath('/brands/b1'), async ({ request }) => {
        key = request.headers.get('idempotency-key')
        return HttpResponse.json({ data: { id: 'b1', name: 'Renamed' } })
      }),
    )
    const { wrapper } = setup()
    let seen = ''
    const { result } = renderHook(
      () =>
        useRouteMutation(routes.renameBrand, {
          onSuccess: (res) => {
            seen = res.data.name
          },
        }),
      { wrapper },
    )
    await act(async () => {
      await result.current.mutateAsync({ params: { id: 'b1' }, body: { name: 'Renamed' } })
    })
    expect(key).toBeNull()
    expect(seen).toBe('Renamed')
  })
})
