/**
 * Typed tenant settings (ARCHITECTURE.md §8.5). Stored as tenants.settings jsonb; read leniently
 * (every field validated on its own, invalid/missing → default, via shared readSettings) and
 * patched with deep-merge + full validation (shared mergeSettings). Changes are audited.
 */
import {
  type TenantSettings,
  type TenantSettingsPatch,
  mergeSettings,
  readSettings,
} from '@kadai/shared'
import type { Tx } from '../db/tenant'
import { jsonb } from '../db/json'
import { audit, diffChanges } from './audit'
import type { RequestContext } from './context'
import { notFound } from './errors'

// Settings are read many times per transaction (pricing, posting); memoise per transaction.
const memo = new WeakMap<Tx, TenantSettings>()

export async function getSettings(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
): Promise<TenantSettings> {
  const cached = memo.get(tx)
  if (cached) return cached
  const row = await tx
    .selectFrom('tenants')
    .select('settings')
    .where('id', '=', ctx.tenantId)
    .executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  const settings = readSettings(row.settings)
  memo.set(tx, settings)
  return settings
}

/**
 * Applies a PATCH (any subset of sections/fields) and returns the full new settings.
 * @throws ZodError (→ 400 VALIDATION_ERROR) when the merged result is invalid.
 */
export async function updateSettings(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId' | 'userId' | 'ip' | 'userAgent' | 'requestId'>,
  patch: TenantSettingsPatch,
): Promise<TenantSettings> {
  // Lock the tenant row so concurrent PATCHes merge sequentially instead of losing updates.
  const row = await tx
    .selectFrom('tenants')
    .select('settings')
    .where('id', '=', ctx.tenantId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  const before = readSettings(row.settings)
  const after = mergeSettings(before, patch)
  const changes = diffChanges(before, after)
  if (changes) {
    await tx
      .updateTable('tenants')
      .set({ settings: jsonb(after) })
      .where('id', '=', ctx.tenantId)
      .execute()
    await audit(tx, ctx, {
      action: 'settings.update',
      entity_type: 'tenant',
      entity_id: ctx.tenantId,
      summary: `Settings changed: ${Object.keys(changes.after).join(', ')}`,
      changes,
    })
  }
  memo.set(tx, after)
  return after
}
