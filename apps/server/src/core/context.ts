/**
 * Request context (ARCHITECTURE.md §7.2): who is acting, for which tenant, with which
 * permissions. Resolved per request by the auth plugin (`req.ctx`) and passed to every service as
 * `(tx, ctx, input)`. Background jobs use {@link systemContext}.
 */
import { type Locale, PERMISSION_CODES, type Permission, newId } from '@kadai/shared'

export type ContextAuthMethod = 'password' | 'otp' | 'pin' | 'api' | 'system'

export interface RequestContext {
  requestId: string
  /** Always set for tenant routes. */
  tenantId: string
  /** null for API keys and system jobs. */
  userId: string | null
  membershipId: string | null
  /** auth_sessions.id of the access token (null for API keys / jobs). */
  sessionId: string | null
  /** api_keys.id when authenticated with X-Api-Key. */
  apiKeyId: string | null
  /** Role code ('owner', 'cashier', custom…); 'api_key' / 'system' for non-user actors. */
  roleCode: string
  /** Effective permissions (wildcards and implications expanded). */
  permissions: ReadonlySet<Permission>
  /** null = all stores. */
  storeIds: readonly string[] | null
  /** Trusted device of a PIN session. */
  deviceId: string | null
  /** Register bound to the trusted device. */
  registerId: string | null
  locale: Locale
  ip: string
  userAgent: string
  /** Authentication methods of the session (`amr`), or ['system'] / ['api']. */
  authMethods: readonly ContextAuthMethod[]
}

const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSION_CODES)

/**
 * Context for background jobs and system flows acting on behalf of a tenant: every permission,
 * all stores, no user (audit rows get user_id NULL).
 */
export function systemContext(
  tenantId: string,
  opts: { requestId?: string; locale?: Locale; userId?: string | null } = {},
): RequestContext {
  return {
    requestId: opts.requestId ?? `system:${newId()}`,
    tenantId,
    userId: opts.userId ?? null,
    membershipId: null,
    sessionId: null,
    apiKeyId: null,
    roleCode: 'system',
    permissions: ALL_PERMISSIONS,
    storeIds: null,
    deviceId: null,
    registerId: null,
    locale: opts.locale ?? 'ta',
    ip: '',
    userAgent: 'kadai-system',
    authMethods: ['system'],
  }
}

/** True when the context may act on `storeId` (membership store scoping). */
export function canAccessStore(ctx: Pick<RequestContext, 'storeIds'>, storeId: string): boolean {
  return ctx.storeIds === null || ctx.storeIds.includes(storeId)
}
