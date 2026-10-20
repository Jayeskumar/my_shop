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
  // Cloud: the on-prem setup endpoint does not exist.
  http.get(apiPath('/setup/status'), () => errorResponse(404, 'NOT_FOUND')),
  // Signed out: no refresh cookie.
  http.post(apiPath('/auth/refresh'), () => errorResponse(401, 'UNAUTHENTICATED')),
  http.post(apiPath('/auth/logout'), () => new HttpResponse(null, { status: 204 })),
]

export const server = setupServer(...defaultHandlers)
