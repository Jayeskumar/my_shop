/**
 * Serves the built web app (apps/web/dist) from the API process (ARCHITECTURE.md §2, §7.1 step 8)
 * when KADAI_SERVE_WEB=true and the folder exists. Hashed assets are cached for a year; the
 * HTML shell, service worker and manifest are always revalidated. Unknown GET paths outside
 * the API namespaces fall back to index.html (client-side routing).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const RESERVED_PREFIXES = ['/api/', '/api', '/webhooks', '/public/', '/health', '/metrics']

export type SpaFallback = (req: FastifyRequest, reply: FastifyReply) => Promise<boolean>

/** Registers static serving; returns the SPA fallback for the not-found handler (or null). */
export async function registerStaticWeb(app: FastifyInstance, webDistDir: string): Promise<SpaFallback | null> {
  const indexHtml = path.join(webDistDir, 'index.html')
  if (!existsSync(indexHtml)) {
    app.log.warn({ webDistDir }, 'web app not built: static serving disabled')
    return null
  }
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: '/',
    wildcard: false,
    index: false,
    decorateReply: true,
    setHeaders(reply, filePath) {
      const rel = path.relative(webDistDir, filePath).split(path.sep).join('/')
      reply.header('cache-control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    },
  })
  return async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const url = req.url.split('?')[0]!
    if (RESERVED_PREFIXES.some((p) => url === p || url.startsWith(p.endsWith('/') ? p : `${p}/`))) return false
    // Missing assets (a file extension) are real 404s, not app routes.
    if (/\.[a-z0-9]{1,8}$/i.test(url) && !url.endsWith('.html')) return false
    await reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html')
    return true
  }
}
