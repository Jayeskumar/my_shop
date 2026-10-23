/**
 * MSW server for component tests. Default handlers model a cloud deployment with a signed-out
 * browser; tests override per case with `server.use(...)`.
 */
import { http, HttpResponse, type JsonBodyType } from 'msw'
import { setupServer } from 'msw/node'

export const ORIGIN = 'http://localhost:5173'
export const apiPath = (path: string): string => `${ORIGIN}/api/v1${path}`

export function errorResponse(
  status: number,
  code: string,
  message = code,
  details?: Record<string, unknown>,
): HttpResponse<JsonBodyType> {
  return HttpResponse.json(
    { error: { code, message, ...(details ? { details } : {}), request_id: 'req-test-1' } },
    { status },
  )
}

export const defaultHandlers = [
  http.get(`${ORIGIN}/health/live`, () => HttpResponse.json({ status: 'ok' })),
  // Cloud deployment probe (no first-run setup).
  http.get(apiPath('/setup/status'), () =>
    HttpResponse.json({
      data: { setup_required: false, mode: 'cloud', version: '0.1.0', token_required: false },
    }),
  ),
  // Signed out: no refresh cookie.
  http.post(apiPath('/auth/refresh'), () => errorResponse(401, 'UNAUTHENTICATED')),
  http.post(apiPath('/auth/logout'), () => new HttpResponse(null, { status: 204 })),
  // Fallback handlers when a navigation test lands on / or /platform without page-specific MSW setup.
  http.get(apiPath('/purchases/reorder-suggestions'), ({ request }) => {
    const storeId =
      new URL(request.url).searchParams.get('store_id') ??
      '0192f0a0-0000-7000-8000-000000000301'
    return HttpResponse.json({
      data: {
        store_id: storeId,
        generated_at: '2026-10-20T10:00:00.000Z',
        window_days: 90,
        forecast: true,
        lead_time_days: 7,
        weekday_adjusted: true,
        model: 'smart',
        assumptions: [],
        groups: [],
      },
    })
  }),
  http.get(apiPath('/platform/audit-logs'), () =>
    HttpResponse.json({ data: [], page: { limit: 10, offset: 0, total: 0 } }),
  ),
]

export const server = setupServer(...defaultHandlers)
