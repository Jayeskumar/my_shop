/**
 * Fastify type augmentation for Kadai: `app.kadai` (runtime deps), `req.auth`, `req.ctx`,
 * `req.tx()`, `req.rawBody` and the route `config` flags understood by the auth plugin.
 */
import type { AuthMethod } from '@kadai/shared'
import type { RequestContext } from '../core/context'
import type { KadaiDeps } from '../core/runtime'
import type { Tx, TxOptions } from '../db/tenant'

/**
 * Route authentication requirement (`config.auth`):
 *   'tenant'   — default under /api: a user token scoped to a tenant, or an API key → req.ctx
 *   'user'     — any valid user token, tenant-less allowed (select-tenant, logout, password change)
 *   'optional' — parse credentials when present, never reject (e.g. /setup/status)
 *   'none'     — default outside /api: credentials ignored
 */
export type AuthRequirement = 'tenant' | 'user' | 'optional' | 'none'

export type AuthInfo =
  | {
      kind: 'user'
      userId: string
      /** null for a tenant-less token (must call /auth/select-tenant). */
      tenantId: string | null
      membershipId: string | null
      sessionId: string
      /** Refresh family of the session — logout revokes the family. */
      familyId: string
      deviceId: string | null
      amr: readonly AuthMethod[]
    }
  | {
      kind: 'api_key'
      apiKeyId: string
      tenantId: string
      keyPrefix: string
    }

declare module 'fastify' {
  interface FastifyInstance {
    kadai: KadaiDeps
  }

  interface FastifyRequest {
    /** Verified credentials (null when the route did not require / receive any). */
    auth: AuthInfo | null
    /** Tenant request context; throws UNAUTHENTICATED when the route has none. */
    readonly ctx: RequestContext
    /** True when req.ctx is available. */
    readonly hasCtx: boolean
    /** Runs `fn` in ONE tenant transaction (RLS) for req.ctx — `withTenant(appDb, req.ctx, fn)`. */
    tx<T>(fn: (tx: Tx) => Promise<T>, opts?: TxOptions): Promise<T>
    /** Raw request body (Buffer) for /webhooks routes — needed for signature verification. */
    rawBody?: Buffer
    /** @internal set by the auth plugin. */
    kadaiCtx: RequestContext | null
  }

  interface FastifyContextConfig {
    /** No authentication at all (credentials are not even parsed). */
    public?: boolean
    auth?: AuthRequirement
    /** Reachable while the tenant is suspended (billing / self-service). */
    allowSuspended?: boolean
    /** Writable while an on-prem license is invalid (license upload, logout). */
    allowReadOnly?: boolean
  }
}
