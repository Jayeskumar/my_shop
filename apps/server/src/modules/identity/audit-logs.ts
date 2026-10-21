/**
 * Audit trail (docs/API.md "identity" → audit log; ARCHITECTURE.md §7.7): newest first, filters
 * by member, action prefix, entity, and business-date range (tenant timezone). audit_logs is
 * append-only; this module only reads it (writers use core/audit).
 */
import type { z } from 'zod'
import { addDays, startOfDayInstant } from '@kadai/shared'
import type { AuditLog, AuditLogListQuerySchema } from '@kadai/shared/api/identity'
import { type PageEnvelope, parsePage } from '../../core/http'
import type { Tx } from '../../db/tenant'
import { type Ctx, escapeLike, iso, paginateQuery, tenantToday } from './common'

type AuditLogListQuery = z.output<typeof AuditLogListQuerySchema>

export async function listAuditLogs(
  tx: Tx,
  ctx: Ctx,
  query: AuditLogListQuery,
): Promise<PageEnvelope<AuditLog>> {
  let q = tx
    .selectFrom('audit_logs as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .select([
      'a.id',
      'a.user_id',
      'u.full_name as user_name',
      'a.action',
      'a.entity_type',
      'a.entity_id',
      'a.summary',
      'a.changes',
      'a.ip',
      'a.user_agent',
      'a.request_id',
      'a.created_at',
    ])
    .where('a.tenant_id', '=', ctx.tenantId)
  if (query.user_id) q = q.where('a.user_id', '=', query.user_id)
  if (query.action) q = q.where('a.action', 'like', `${escapeLike(query.action)}%`)
  if (query.entity_type) q = q.where('a.entity_type', '=', query.entity_type)
  if (query.entity_id) q = q.where('a.entity_id', '=', query.entity_id)
  if (query.from || query.to) {
    const { timezone } = await tenantToday(tx, ctx)
    if (query.from) q = q.where('a.created_at', '>=', startOfDayInstant(query.from, timezone))
    if (query.to)
      q = q.where('a.created_at', '<', startOfDayInstant(addDays(query.to, 1), timezone))
  }
  const page = await paginateQuery(
    q.orderBy('a.created_at', 'desc').orderBy('a.id', 'desc'),
    parsePage(query),
  )
  return {
    data: page.data.map((r) => ({
      id: Number(r.id),
      user_id: r.user_id,
      user_name: r.user_name,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      summary: r.summary,
      changes: r.changes ?? null,
      ip: r.ip,
      user_agent: r.user_agent,
      request_id: r.request_id,
      created_at: iso(r.created_at),
    })),
    page: page.page,
  }
}
