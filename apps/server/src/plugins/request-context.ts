/**
 * Request id & access log (ARCHITECTURE.md §7.1 step 1, §7.8).
 * The id comes from a well-formed `x-request-id` header (load balancers, the web client) or a
 * fresh UUID v7; it is echoed in the response, set on the request logger (`request_id`) and put
 * in every error envelope. One structured line is logged per completed request.
 */
import type { IncomingMessage } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { newId } from '@kadai/shared'

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/

/** Fastify `genReqId`. Rejects malformed ids so they cannot be used for log injection. */
export function genRequestId(req: IncomingMessage): string {
  const header = req.headers['x-request-id']
  const value = Array.isArray(header) ? header[0] : header
  return value && REQUEST_ID_RE.test(value) ? value : newId()
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id)
  })

  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode
    const line = {
      method: req.method,
      url: req.url.split('?')[0],
      route: req.routeOptions.url ?? null,
      status,
      duration_ms: Math.round(reply.elapsedTime * 10) / 10,
      tenant_id: req.kadaiCtx?.tenantId ?? null,
      user_id: req.kadaiCtx?.userId ?? null,
    }
    if (status >= 500) req.log.error(line, 'request failed')
    else if (req.url.startsWith('/health') || req.url === '/metrics') req.log.debug(line, 'request completed')
    else req.log.info(line, 'request completed')
  })
}
