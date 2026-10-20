/**
 * Body parsers. JSON keeps Fastify's prototype-poisoning protection (its default parser) and,
 * for /webhooks routes, also keeps the raw bytes on `req.rawBody`: providers sign the exact body
 * (Razorpay `X-Razorpay-Signature`, Meta `X-Hub-Signature-256`), and re-serialising parsed JSON
 * would not reproduce it. Webhooks may also post form-encoded or plain-text bodies.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'

const isWebhook = (req: FastifyRequest): boolean => req.url.startsWith('/webhooks/')

export function registerBodyParsers(app: FastifyInstance): void {
  const defaultJson = app.getDefaultJsonParser('error', 'error')

  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    if (isWebhook(req)) req.rawBody = body
    defaultJson(req, body.toString('utf8'), done)
  })

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    if (isWebhook(req)) req.rawBody = body
    done(null, Object.fromEntries(new URLSearchParams(body.toString('utf8'))))
  })

  app.removeContentTypeParser('text/plain')
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    if (isWebhook(req)) req.rawBody = body
    done(null, body.toString('utf8'))
  })
}
