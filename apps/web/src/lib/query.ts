/**
 * TanStack Query client defaults (ARCHITECTURE.md §16). Query keys follow
 * `[module, resource, params]`, e.g. `['catalog', 'products', { q, limit, offset }]`; queries made
 * with `useRouteQuery` (shared route catalogues) use `['route', '/api/v1/<path>', params, query]`
 * (`routeQueryKey`) and are invalidated per route with `invalidateRoutes`.
 *
 *  - staleTime 30 s; retries only for transient failures (network, timeout, 5xx, 429,
 *    IDEMPOTENCY_IN_PROGRESS) with backoff that honours Retry-After; 4xx never retry.
 *  - Errors are toasted once, centrally: a query opts out with `meta: { errorToast: false }`;
 *    a mutation is toasted unless it has its own `onError` (forms show inline errors) or sets
 *    `meta.errorToast` explicitly. 401s are never toasted (the auth store signs the user out).
 */
import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { newId } from '@kadai/shared/ids'
import {
  ROUTE_SCOPE_PREFIX,
  type RouteBody,
  type RouteDef,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
} from '@kadai/shared/api/common'
import { type ApiError, callRoute, isApiError } from './api'

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: { errorToast?: boolean }
    mutationMeta: { errorToast?: boolean }
  }
}

const TRANSIENT_CODES = new Set(['RATE_LIMITED', 'IDEMPOTENCY_IN_PROGRESS', 'PROVIDER_ERROR'])

export function isTransientError(error: unknown): boolean {
  if (!isApiError(error)) return true
  return error.status === 0 || error.status >= 500 || TRANSIENT_CODES.has(error.code)
}

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (!isTransientError(error)) return false
  return failureCount < 3
}

export function retryDelay(attempt: number, error: unknown): number {
  if (isApiError(error) && error.retryAfterSeconds !== undefined) {
    return Math.min(60_000, Math.max(1_000, error.retryAfterSeconds * 1000))
  }
  return Math.min(15_000, 1_000 * 2 ** attempt)
}

function isUnauthenticated(error: unknown): boolean {
  return isApiError(error) && error.status === 401
}

export interface QueryClientOptions {
  /** Shows an error to the user (the app passes the toast helper). */
  onError?: (error: unknown) => void
}

export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const report = (error: unknown): void => {
    if (isUnauthenticated(error)) return
    options.onError?.(error)
  }
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.errorToast === false) return
        report(error)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const explicit = mutation.meta?.errorToast
        if (explicit === false) return
        if (explicit === undefined && mutation.options.onError) return
        report(error)
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        // Financial creates are idempotent (Idempotency-Key) but retrying is a user decision.
        retry: false,
      },
    },
  })
}

// ---------------------------------------------------------------------------------------------
// Route-catalogue hooks: `useRouteQuery(catalogRoutes.listProducts, { query })` and
// `useRouteMutation(catalogRoutes.createProduct, { invalidates: [catalogRoutes.listProducts] })`.
// ---------------------------------------------------------------------------------------------

/** Query-key root of every route-catalogue query (`['route', '/api/v1/products', …]`). */
export const ROUTE_QUERY_ROOT = 'route'

/** `/api/v1/products/:id` — the route's full path template (scope prefix + path). */
function routeTemplate(route: RouteDef): string {
  return ROUTE_SCOPE_PREFIX[route.scope ?? 'api'] + route.path
}

/**
 * Query key of a catalogued GET: `['route', '/api/v1/products/:id', params, query]`. Without
 * `input` it is the prefix matching every call of the route (for invalidation).
 */
export function routeQueryKey<R extends RouteDef>(
  route: R,
  input?: { params?: RouteParams<R>; query?: RouteQuery<R> },
): QueryKey {
  const base = [ROUTE_QUERY_ROOT, routeTemplate(route)] as const
  if (!input) return base
  return [...base, input.params ?? {}, input.query ?? {}]
}

/**
 * Invalidates every cached query of the given routes, plus — for each route — queries of routes
 * nested under its path (`/products` also refreshes `/products/:id`, `/products/lookup`).
 */
export function invalidateRoutes(
  queryClient: QueryClient,
  routes: readonly RouteDef[],
): Promise<void> {
  const templates = routes.map(routeTemplate)
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const [root, template] = query.queryKey as readonly unknown[]
      if (root !== ROUTE_QUERY_ROOT || typeof template !== 'string') return false
      return templates.some((t) => template === t || template.startsWith(`${t}/`))
    },
  })
}

type RouteQueryInput<R extends RouteDef> = R['params'] extends object
  ? { params: RouteParams<R>; query?: RouteQuery<R> }
  : { params?: undefined; query?: RouteQuery<R> }

export type UseRouteQueryOptions<R extends RouteDef, TData> = Omit<
  UseQueryOptions<RouteResponse<R>, ApiError, TData, QueryKey>,
  'queryKey' | 'queryFn'
> & {
  /** Validate the response against the contract (default: development only). */
  validate?: boolean
}

/**
 * TanStack query for a catalogued GET route. The key is {@link routeQueryKey}; pass
 * `placeholderData: keepPreviousData` for paginated lists and `enabled` for dependent queries.
 */
export function useRouteQuery<R extends RouteDef, TData = RouteResponse<R>>(
  route: R,
  input: RouteQueryInput<R>,
  options: UseRouteQueryOptions<R, TData> = {},
): UseQueryResult<TData, ApiError> {
  const { validate, ...queryOptions } = options
  return useQuery({
    ...queryOptions,
    queryKey: routeQueryKey(route, input as { params?: RouteParams<R>; query?: RouteQuery<R> }),
    queryFn: ({ signal }) =>
      (callRoute as (r: RouteDef, i: object) => Promise<RouteResponse<R>>)(route, {
        ...input,
        signal,
        ...(validate === undefined ? {} : { validate }),
      }),
  })
}

/** Variables of {@link useRouteMutation}: the route's params / query / body. */
export type RouteMutationVariables<R extends RouteDef> = (R['params'] extends object
  ? { params: RouteParams<R> }
  : { params?: undefined }) & {
  query?: RouteQuery<R>
  body?: RouteBody<R>
  /**
   * Idempotency-Key for this call. Routes marked `idempotent` get a fresh key per `mutate()`
   * when omitted; pass a key kept for the whole form session to make re-submits safe.
   */
  idempotencyKey?: string
}

export type UseRouteMutationOptions<R extends RouteDef, TContext> = Omit<
  UseMutationOptions<RouteResponse<R>, ApiError, RouteMutationVariables<R>, TContext>,
  'mutationFn'
> & {
  /** Routes whose cached queries are invalidated after success (see {@link invalidateRoutes}). */
  invalidates?: readonly RouteDef[]
}

/** TanStack mutation for a catalogued route (POST / PUT / PATCH / DELETE). */
export function useRouteMutation<R extends RouteDef, TContext = unknown>(
  route: R,
  options: UseRouteMutationOptions<R, TContext> = {},
): UseMutationResult<RouteResponse<R>, ApiError, RouteMutationVariables<R>, TContext> {
  const queryClient = useQueryClient()
  const { invalidates, onSuccess, ...mutationOptions } = options
  return useMutation({
    ...mutationOptions,
    mutationFn: (variables: RouteMutationVariables<R>) =>
      (callRoute as (r: RouteDef, i: object) => Promise<RouteResponse<R>>)(route, {
        ...variables,
        idempotencyKey: variables.idempotencyKey ?? (route.idempotent ? newId() : undefined),
      }),
    onSuccess: async (...args) => {
      if (invalidates?.length) await invalidateRoutes(queryClient, invalidates)
      await onSuccess?.(...args)
    },
  })
}
