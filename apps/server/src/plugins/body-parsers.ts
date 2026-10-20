/**
 * Body parsers. JSON keeps Fastify's prototype-poisoning protection (its default parser) and,
 * for /webhooks routes, also keeps the raw bytes on `req.rawBody`: providers sign the exact body
 * (Razorpay `X-Razorpay-Signature`, Meta `X-Hub-Signature-256`), and re-serialising parsed JSON
 * would not reproduce it. Webhooks may also post form-encoded or plain-text bodies.
 * Installation-signed requests to the public licensing API (/public/v1/licensing/*) are signed
 * over sha256 of the exact body too (`installationSignaturePayload`, @kadai/shared/api/licensing),
 * so their raw bytes are kept as well.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'

const RAW_BODY_PREFIXES = ['/webhooks/', '/public/v1/licensing/'] as const

const isWebhook = (req: FastifyRequest): boolean =>
  RAW_BODY_PREFIXES.some((prefix) => req.url.startsWith(prefix))

export function registerBodyParsers(app: FastifyInstance): void {
  const defaultJson = app.getDefaultJsonParser('error', 'error')

  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    if (isWebhook(req)) req.rawBody = body
    defaultJson(req, body.toString('utf8'), done)
  })

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      if (isWebhook(req)) req.rawBody = body
      done(null, Object.fromEntries(new URLSearchParams(body.toString('utf8'))))
    },
  )

  app.removeContentTypeParser('text/plain')
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    if (isWebhook(req)) req.rawBody = body
    done(null, body.toString('utf8'))
  })
}
