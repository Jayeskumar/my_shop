/**
 * Authentication & request context (ARCHITECTURE.md §7.1 step 4, §7.2, §7.4, §7.6).
 *
 * onRequest, per route requirement (`config.auth`, default 'tenant' under /api, 'none' elsewhere;
 * `config.public: true` skips everything):
 *
 *   Authorization: Bearer <jwt>  → verify signature/expiry → session (sid) alive and owned by sub
 *                                  → req.auth
 *   X-Api-Key: kd_<mode>_<prefix>_<secret> → api_keys by key_prefix (system db), constant-time
 *                                  hash compare, not revoked/expired, feature api_access
 *
 *   'tenant' routes then resolve the membership (rbac, cached 30 s): active membership & user,
 *   tenant not suspended/closed (unless `config.allowSuspended`), trusted device still active →
 *   req.ctx. On-prem with a tampered license, writes are refused (403 LICENSE_INVALID) unless
 *   `config.allowReadOnly`.
 *
 * Also decorates `req.tx(fn)` = withTenant(appDb, req.ctx, fn).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { type Locale, expandPermissions, isPermission } from '@kadai/shared'
import { TtlCache } from '../core/cache'
import type { RequestContext } from '../core/context'
import { timingSafeEqualStr } from '../core/crypto'
import { CHANNELS } from '../core/events'
import { AppError, featureNotInPlan, forbidden, unauthenticated } from '../core/errors'
import type { KadaiDeps } from '../core/runtime'
import { hashApiKey, parseApiKey, verifyAccessToken } from '../core/tokens'
import { withTenant } from '../db/tenant'
import type { AuthInfo, AuthRequirement } from './fastify-types'

interface ApiKeyAccess {
  id: string
  tenantId: string
  keyPrefix: string
  keyHash: string
  permissions: readonly string[]
  storeIds: readonly string[] | null
  expiresAt: Date | null
  revoked: boolean
  tenantStatus: string
  tenantLocale: Locale
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function requirementOf(req: FastifyRequest): AuthRequirement {
  const cfg = req.routeOptions.config
  if (cfg.public) return 'none'
  if (cfg.auth) return cfg.auth
  return req.url.startsWith('/api/') ? 'tenant' : 'none'
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function localeOverride(req: FastifyRequest): Locale | null {
  const v = headerValue(req.headers['x-locale'])
  return v === 'ta' || v === 'en' ? v : null
}

export function registerAuth(app: FastifyInstance, deps: KadaiDeps): void {
  const { config } = deps
  const apiKeyCache = new TtlCache<ApiKeyAccess | null>(30_000)
  const apiKeyLastUsed = new Map<string, number>()
  // Revoked / changed keys: NOTIFY kadai_cache {scope:'api_key'} (notifyApiKeysChanged).
  deps.events.subscribe(CHANNELS.cache, (payload) => {
    if (typeof payload === 'object' && payload !== null && (payload as { scope?: unknown }).scope === 'api_key') {
      apiKeyCache.clear()
    }
  })

  app.decorateRequest('auth', null)
  app.decorateRequest('kadaiCtx', null)
  app.decorateRequest('ctx', {
    getter(this: FastifyRequest): RequestContext {
      if (!this.kadaiCtx) throw unauthenticated('This route has no tenant context')
      return this.kadaiCtx
    },
  })
  app.decorateRequest('hasCtx', {
    getter(this: FastifyRequest): boolean {
      return this.kadaiCtx !== null
    },
  })
  app.decorateRequest('tx', function tx<T>(this: FastifyRequest, fn: Parameters<FastifyRequest['tx']>[0], opts?: Parameters<FastifyRequest['tx']>[1]): Promise<T> {
    return withTenant(deps.db.appDb, this.ctx, fn as never, opts) as Promise<T>
  })

  async function loadApiKey(key: string): Promise<ApiKeyAccess | null> {
    const parsed = parseApiKey(key)
    if (!parsed) return null
    // system db: API keys are looked up before any tenant is known.
    const row = await deps.db.systemDb
      .selectFrom('api_keys as k')
      .innerJoin('tenants as t', 't.id', 'k.tenant_id')
      .select(['k.id', 'k.tenant_id', 'k.key_prefix', 'k.key_hash', 'k.permissions', 'k.store_ids', 'k.expires_at', 'k.revoked_at', 't.status as tenant_status', 't.default_locale'])
      .where('k.key_prefix', '=', parsed.keyPrefix)
      .executeTakeFirst()
    if (!row) return null
    return {
      id: row.id,
      tenantId: row.tenant_id,
      keyPrefix: row.key_prefix,
      keyHash: row.key_hash,
      permissions: row.permissions,
      storeIds: row.store_ids,
      expiresAt: row.expires_at,
      revoked: row.revoked_at !== null,
      tenantStatus: row.tenant_status,
      tenantLocale: row.default_locale === 'en' ? 'en' : 'ta',
    }
  }

  function touchApiKey(id: string): void {
    const now = Date.now()
    if ((apiKeyLastUsed.get(id) ?? 0) > now - 60_000) return
    apiKeyLastUsed.set(id, now)
    deps.db.systemDb
      .updateTable('api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', id)
      .execute()
      .catch((err: unknown) => app.log.warn({ err }, 'api key last_used_at update failed'))
  }

  async function authenticateApiKey(req: FastifyRequest, key: string): Promise<void> {
    const hash = hashApiKey(key)
    const access = await apiKeyCache.getOrLoad(hash, () => loadApiKey(key))
    if (!access || !timingSafeEqualStr(access.keyHash, hash)) throw unauthenticated('Invalid API key')
    if (access.revoked) throw unauthenticated('API key was revoked')
    if (access.expiresAt && access.expiresAt.getTime() <= Date.now()) throw unauthenticated('API key expired')
    if (access.tenantStatus !== 'active' && !req.routeOptions.config.allowSuspended) {
      throw new AppError('TENANT_SUSPENDED', 'This account is suspended')
    }
    const ent = await deps.entitlements.get(access.tenantId)
    if (!ent.features.has('api_access')) throw featureNotInPlan('api_access', ent.plan_code)
    touchApiKey(access.id)
    req.auth = { kind: 'api_key', apiKeyId: access.id, tenantId: access.tenantId, keyPrefix: access.keyPrefix }
    req.kadaiCtx = {
      requestId: req.id,
      tenantId: access.tenantId,
      userId: null,
      membershipId: null,
      sessionId: null,
      apiKeyId: access.id,
      roleCode: 'api_key',
      permissions: expandPermissions(access.permissions.filter((p) => p === '*' || p.endsWith('.*') || isPermission(p))),
      storeIds: access.storeIds,
      deviceId: null,
      registerId: null,
      locale: localeOverride(req) ?? access.tenantLocale,
      ip: req.ip,
      userAgent: headerValue(req.headers['user-agent']) ?? '',
      authMethods: ['api'],
    }
  }

  async function authenticateBearer(req: FastifyRequest, token: string): Promise<Extract<AuthInfo, { kind: 'user' }>> {
    const claims = await verifyAccessToken(config, token)
    const session = await deps.sessions.get(claims.sub, claims.sid)
    // The tenant claim is not compared with auth_sessions.tenant_id: the token is ours, and the
    // membership check below proves the user belongs to `tid`.
    if (!session || session.userId !== claims.sub) throw new AppError('SESSION_REVOKED', 'Session not found')
    if (!session.active) throw new AppError('SESSION_REVOKED', 'Session was revoked')
    const auth: Extract<AuthInfo, { kind: 'user' }> = {
      kind: 'user',
      userId: claims.sub,
      tenantId: claims.tid,
      membershipId: claims.mid,
      sessionId: claims.sid,
      familyId: session.familyId,
      deviceId: claims.did,
      amr: claims.amr,
    }
    req.auth = auth
    return auth
  }

  async function resolveTenantContext(req: FastifyRequest, auth: Extract<AuthInfo, { kind: 'user' }>): Promise<void> {
    if (!auth.tenantId || !auth.membershipId) {
      throw forbidden('Select a business first', { reason: 'tenant_selection_required' })
    }
    const access = await deps.rbac.resolve(auth.userId, auth.tenantId)
    if (!access || access.membershipId !== auth.membershipId) {
      throw new AppError('SESSION_REVOKED', 'You are no longer a member of this business')
    }
    if (access.userStatus !== 'active') throw new AppError('SESSION_REVOKED', 'This user is disabled')
    if (access.membershipStatus !== 'active') throw forbidden('Your access to this business is disabled', { reason: 'membership_inactive' })
    if (access.tenantStatus !== 'active' && !req.routeOptions.config.allowSuspended) {
      throw new AppError('TENANT_SUSPENDED', access.tenantStatus === 'closed' ? 'This account is closed' : 'This account is suspended', {
        status: access.tenantStatus,
      })
    }
    let registerId: string | null = null
    if (auth.deviceId) {
      const device = await deps.rbac.resolveDevice(auth.deviceId, auth.tenantId)
      if (!device || !device.isActive) throw new AppError('DEVICE_NOT_TRUSTED', 'This device is no longer trusted')
      registerId = device.registerId
    }
    req.kadaiCtx = {
      requestId: req.id,
      tenantId: auth.tenantId,
      userId: auth.userId,
      membershipId: access.membershipId,
      sessionId: auth.sessionId,
      apiKeyId: null,
      roleCode: access.roleCode,
      permissions: access.permissions,
      storeIds: access.storeIds,
      deviceId: auth.deviceId,
      registerId,
      locale: localeOverride(req) ?? access.locale,
      ip: req.ip,
      userAgent: headerValue(req.headers['user-agent']) ?? '',
      authMethods: auth.amr,
    }
  }

  app.addHook('onRequest', async (req) => {
    if (req.is404) return
    const requirement = requirementOf(req)
    if (requirement === 'none') return
    const authorization = headerValue(req.headers.authorization)
    const apiKey = headerValue(req.headers['x-api-key'])
    const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]

    if (!bearer && !apiKey) {
      if (requirement === 'optional') return
      throw unauthenticated(authorization ? 'Unsupported Authorization scheme' : 'Authentication required')
    }
    try {
      if (apiKey && !bearer) {
        if (requirement === 'user') throw forbidden('API keys cannot use this endpoint')
        await authenticateApiKey(req, apiKey)
      } else {
        const auth = await authenticateBearer(req, bearer!)
        if (requirement === 'tenant') await resolveTenantContext(req, auth)
        else if (auth.tenantId && auth.membershipId) {
          // 'user'/'optional' routes still get a context when the token has a tenant.
          await resolveTenantContext(req, auth).catch(() => undefined)
        }
      }
    } catch (err) {
      if (requirement === 'optional') {
        req.auth = null
        req.kadaiCtx = null
        return
      }
      throw err
    }

    // On-prem read-only mode (tampered / foreign license): reads keep working, data is never
    // locked away, but nothing can be written until a valid license is installed.
    if (config.mode === 'onprem' && req.kadaiCtx && !SAFE_METHODS.has(req.method) && !req.routeOptions.config.allowReadOnly) {
      const ent = await deps.entitlements.get(req.kadaiCtx.tenantId)
      if (ent.read_only) {
        throw new AppError('LICENSE_INVALID', 'The license is invalid; the system is read-only until a valid license is installed', {
          license_status: ent.license_status ?? null,
        })
      }
    }
  })
}
