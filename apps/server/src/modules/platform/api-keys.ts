/**
 * API keys of a tenant (GET /api-keys, POST /api-keys, POST /api-keys/:id/revoke).
 *
 *  - Only a signed-in user may create or revoke API keys (an X-Api-Key caller gets 403
 *    api_key_actor).
 *  - Permissions must be a subset of the creator's effective permissions (403
 *    permission_not_held), and store_ids must be a subset of the creator's store access (403
 *    store_not_allowed).
 *  - The raw key `kd_live_<prefix>_<secret>` is returned once on creation; only `key_prefix` and
 *    `key_hash` (sha256) are stored.
 */
import { sql } from 'kysely'
import { type Permission, newId } from '@kadai/shared'
import {
  type ApiKey,
  apiKeyState,
  missingPermissions,
  type platformRoutes,
} from '@kadai/shared/api/platform'
import { audit } from '../../core/audit'
import { canAccessStore } from '../../core/context'
import { AppError, invalidField, notFound } from '../../core/errors'
import type { RouteImpls } from '../../core/http'
import { generateApiKey } from '../../core/tokens'
import type { Tx } from '../../db/tenant'
import type { PlatformRuntime } from './runtime'
import { iso } from './util'

type Routes = typeof platformRoutes

interface ApiKeyRow {
  id: string
  name: string
  key_prefix: string
  permissions: string[]
  store_ids: string[] | null
  last_used_at: Date | null
  expires_at: Date | null
  revoked_at: Date | null
  created_by: string | null
  created_by_name: string | null
  created_at: Date
  updated_at: Date
}

function toDto(row: ApiKeyRow, now: Date): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    permissions: row.permissions as Permission[],
    store_ids: row.store_ids,
    last_used_at: iso(row.last_used_at),
    expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at),
    state: apiKeyState({ revoked_at: row.revoked_at, expires_at: row.expires_at }, now),
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

async function loadApiKey(tx: Tx, tenantId: string, id: string, now: Date): Promise<ApiKey> {
  const row = await tx
    .selectFrom('api_keys as k')
    .leftJoin('users as u', 'u.id', 'k.created_by')
    .select([
      'k.id',
      'k.name',
      'k.key_prefix',
      'k.permissions',
      'k.store_ids',
      'k.last_used_at',
      'k.expires_at',
      'k.revoked_at',
      'k.created_by',
      'u.full_name as created_by_name',
      'k.created_at',
      'k.updated_at',
    ])
    .where('k.tenant_id', '=', tenantId)
    .where('k.id', '=', id)
    .executeTakeFirst()
  if (!row) throw notFound('api_key', id)
  return toDto(row, now)
}

export function apiKeyHandlers(
  rt: PlatformRuntime,
): Pick<RouteImpls<Routes>, 'listApiKeys' | 'createApiKey' | 'revokeApiKey'> {
  return {
    listApiKeys: {
      tx: async (tx, req) => {
        const now = rt.now()
        const q = req.query
        let qb = tx
          .selectFrom('api_keys as k')
          .leftJoin('users as u', 'u.id', 'k.created_by')
          .select([
            'k.id',
            'k.name',
            'k.key_prefix',
            'k.permissions',
            'k.store_ids',
            'k.last_used_at',
            'k.expires_at',
            'k.revoked_at',
            'k.created_by',
            'u.full_name as created_by_name',
            'k.created_at',
            'k.updated_at',
          ])
          .where('k.tenant_id', '=', req.ctx.tenantId)

        if (q.q) {
          const pat = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`
          qb = qb.where((eb) =>
            eb.or([eb('k.name', 'ilike', pat), eb('k.key_prefix', 'ilike', pat)]),
          )
        }

        const rows = await qb.execute()
        let items = rows.map((r) => toDto(r, now))
        if (q.state) {
          items = items.filter((item) => item.state === q.state)
        }
        const dir = q.sort.direction === 'asc' ? 1 : -1
        items.sort((a, b) => {
          let cmp = 0
          if (q.sort.field === 'name') {
            cmp = a.name.localeCompare(b.name, 'en')
          } else if (q.sort.field === 'last_used_at') {
            cmp = (a.last_used_at ?? '').localeCompare(b.last_used_at ?? '')
          } else {
            cmp = a.created_at.localeCompare(b.created_at)
          }
          return cmp !== 0 ? cmp * dir : a.id.localeCompare(b.id)
        })
        const page = items.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: items.length } }
      },
    },

    createApiKey: {
      tx: async (tx, req) => {
        if (req.ctx.apiKeyId !== null) {
          throw new AppError('FORBIDDEN', 'API keys cannot create API keys', {
            reason: 'api_key_actor',
          })
        }
        const now = rt.now()
        const body = req.body
        const missing = missingPermissions(body.permissions, req.ctx.permissions)
        if (missing.length > 0) {
          throw new AppError('FORBIDDEN', 'Cannot grant permissions you do not hold', {
            reason: 'permission_not_held',
            missing,
          })
        }
        if (req.ctx.storeIds !== null) {
          if (
            body.store_ids === null ||
            body.store_ids.some((sid) => !canAccessStore(req.ctx, sid))
          ) {
            throw new AppError('FORBIDDEN', 'Cannot grant access to stores outside your scope', {
              reason: 'store_not_allowed',
            })
          }
        }
        if (body.store_ids !== null) {
          const validStores = await tx
            .selectFrom('stores')
            .select('id')
            .where('tenant_id', '=', req.ctx.tenantId)
            .where('id', 'in', body.store_ids)
            .execute()
          if (validStores.length !== new Set(body.store_ids).size) {
            throw invalidField('store_ids', 'unknown_store')
          }
        }
        let expiresAt: Date | null = null
        if (body.expires_at !== null) {
          expiresAt = new Date(body.expires_at)
          if (expiresAt.getTime() <= now.getTime()) {
            throw invalidField('expires_at', 'expires_in_past')
          }
        }

        const generated = generateApiKey('live')
        const id = newId()
        await tx
          .insertInto('api_keys')
          .values({
            id,
            tenant_id: req.ctx.tenantId,
            name: body.name,
            key_prefix: generated.keyPrefix,
            key_hash: generated.keyHash,
            permissions: body.permissions,
            store_ids: body.store_ids,
            expires_at: expiresAt,
            created_by: req.ctx.userId,
            created_at: now,
            updated_at: now,
          })
          .execute()

        await audit(tx, req.ctx, {
          action: 'api_key.create',
          entity_type: 'api_key',
          entity_id: id,
          summary: `API key "${body.name}" (${generated.keyPrefix}) created`,
          changes: {
            name: body.name,
            key_prefix: generated.keyPrefix,
            permissions: body.permissions,
            store_ids: body.store_ids,
            expires_at: expiresAt ? expiresAt.toISOString() : null,
          },
        })

        const apiKey = await loadApiKey(tx, req.ctx.tenantId, id, now)
        return { data: { api_key: apiKey, key: generated.key } }
      },
    },

    revokeApiKey: {
      tx: async (tx, req) => {
        if (req.ctx.apiKeyId !== null) {
          throw new AppError('FORBIDDEN', 'API keys cannot revoke API keys', {
            reason: 'api_key_actor',
          })
        }
        const now = rt.now()
        const id = req.params.id
        const existing = await tx
          .selectFrom('api_keys')
          .select(['id', 'name', 'key_prefix', 'revoked_at'])
          .where('tenant_id', '=', req.ctx.tenantId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()
        if (!existing) throw notFound('api_key', id)

        if (!existing.revoked_at) {
          await tx
            .updateTable('api_keys')
            .set({ revoked_at: now, updated_at: sql`now()` })
            .where('tenant_id', '=', req.ctx.tenantId)
            .where('id', '=', id)
            .execute()
          await audit(tx, req.ctx, {
            action: 'api_key.revoke',
            entity_type: 'api_key',
            entity_id: id,
            summary: `API key "${existing.name}" (${existing.key_prefix}) revoked`,
            changes: { reason: req.body.reason ?? null },
          })
        }

        return { data: await loadApiKey(tx, req.ctx.tenantId, id, now) }
      },
    },
  }
}
