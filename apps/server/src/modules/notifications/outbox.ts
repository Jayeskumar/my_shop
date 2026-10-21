/**
 * The outbox as seen by the API: row → NotificationSchema DTO (sensitive templates redacted),
 * the filtered / sorted / paginated list with facet counts, one notification, and retry.
 *
 * Notifications are tenant-wide (no store column) and readable with settings.manage only, so
 * there is no store scoping here; RLS keeps tenants apart.
 */
import {
  DEFAULT_TIMEZONE,
  type NotificationChannel,
  type NotificationStatus,
  instantRangeForDates,
} from '@kadai/shared'
import {
  NOTIFICATION_TEMPLATES,
  type Notification,
  type NotificationListResponse,
  type NotificationParams,
  isTemplateCode,
  notificationRefPath,
} from '@kadai/shared/api/notifications'
import type { NotificationListQuerySchema } from '@kadai/shared/api/notifications'
import { type Expression, type ExpressionBuilder, type SqlBool, sql } from 'kysely'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { conflict, notFound } from '../../core/errors'
import { parsePage, paginate } from '../../core/http'
import { kickSendJob } from '../../core/notify'
import type { DB } from '../../db/schema.generated'
import { type Tx, afterCommit } from '../../db/tenant'
import { escapeLike, iso, isoOrNull, localeOf } from './common'

type ListQuery = z.output<typeof NotificationListQuerySchema>

const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

/** Stored params as a NotificationParams value (defensive: older rows may hold anything). */
export function paramsOf(value: unknown): NotificationParams {
  const out: NotificationParams = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 40) break
    if (!PARAM_KEY_RE.test(k)) continue
    if (typeof v === 'string') out[k] = v.slice(0, 2000)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
  }
  return out
}

export function isSensitiveTemplate(code: string): boolean {
  return isTemplateCode(code) && NOTIFICATION_TEMPLATES[code].sensitive
}

export const RETRYABLE_STATUSES: readonly NotificationStatus[] = ['failed', 'cancelled']

/** Columns of a notification row plus the creator's name. */
export function selectNotification(tx: Tx) {
  return tx
    .selectFrom('notifications')
    .leftJoin('users', 'users.id', 'notifications.created_by')
    .select([
      'notifications.id',
      'notifications.channel',
      'notifications.template_code',
      'notifications.locale',
      'notifications.recipient',
      'notifications.recipient_name',
      'notifications.params',
      'notifications.rendered_body',
      'notifications.status',
      'notifications.provider',
      'notifications.provider_message_id',
      'notifications.error',
      'notifications.attempts',
      'notifications.ref_type',
      'notifications.ref_id',
      'notifications.scheduled_at',
      'notifications.sent_at',
      'notifications.created_by',
      'users.full_name as created_by_name',
      'notifications.created_at',
      'notifications.updated_at',
    ])
}

export type NotificationRow = Awaited<
  ReturnType<ReturnType<typeof selectNotification>['executeTakeFirstOrThrow']>
>

export function toNotificationDto(row: NotificationRow): Notification {
  const sensitive = isSensitiveTemplate(row.template_code)
  return {
    id: row.id,
    channel: row.channel as NotificationChannel,
    template_code: row.template_code,
    locale: localeOf(row.locale),
    recipient: row.recipient,
    recipient_name: row.recipient_name,
    params: sensitive ? {} : paramsOf(row.params),
    rendered_body: sensitive ? null : row.rendered_body,
    status: row.status as NotificationStatus,
    provider: row.provider,
    provider_message_id: row.provider_message_id,
    error: row.error,
    attempts: row.attempts,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    ref_path: notificationRefPath(row.ref_type, row.ref_id),
    scheduled_at: iso(row.scheduled_at),
    sent_at: isoOrNull(row.sent_at),
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    can_retry: RETRYABLE_STATUSES.includes(row.status as NotificationStatus),
  }
}

export async function loadNotification(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  id: string,
): Promise<Notification> {
  const row = await selectNotification(tx)
    .where('notifications.tenant_id', '=', ctx.tenantId)
    .where('notifications.id', '=', id)
    .executeTakeFirst()
  if (!row) throw notFound('notification', id)
  return toNotificationDto(row)
}

async function tenantTimezone(tx: Tx, ctx: Pick<RequestContext, 'tenantId'>): Promise<string> {
  const t = await tx
    .selectFrom('tenants')
    .select('timezone')
    .where('id', '=', ctx.tenantId)
    .executeTakeFirst()
  return t?.timezone || DEFAULT_TIMEZONE
}

type Facet = 'status' | 'channel'

/** The list filters (all, or all but one facet) as one WHERE expression on `notifications`. */
function listFilter(
  eb: ExpressionBuilder<DB, 'notifications'>,
  ctx: Pick<RequestContext, 'tenantId'>,
  q: ListQuery,
  range: { start: Date; end: Date } | null,
  except?: Facet,
): Expression<SqlBool> {
  const conds: Array<Expression<SqlBool>> = [eb('notifications.tenant_id', '=', ctx.tenantId)]
  if (q.status?.length && except !== 'status')
    conds.push(eb('notifications.status', 'in', q.status))
  if (q.channel?.length && except !== 'channel')
    conds.push(eb('notifications.channel', 'in', q.channel))
  if (q.template_code?.length) conds.push(eb('notifications.template_code', 'in', q.template_code))
  if (q.ref_type) conds.push(eb('notifications.ref_type', '=', q.ref_type))
  if (q.ref_id) conds.push(eb('notifications.ref_id', '=', q.ref_id))
  if (range) {
    conds.push(eb('notifications.created_at', '>=', range.start))
    conds.push(eb('notifications.created_at', '<', range.end))
  }
  if (q.q) {
    const text = q.q.trim()
    const digits = text.replace(/\D/g, '')
    const like = `%${escapeLike(text.toLowerCase())}%`
    const ors: Array<Expression<SqlBool>> = [
      sql<SqlBool>`lower(notifications.recipient) like ${like}`,
      sql<SqlBool>`lower(coalesce(notifications.recipient_name, '')) like ${like}`,
    ]
    // Phone digits typed as '98765 43210' / '098765…' still match the stored E.164.
    if (digits.length >= 3)
      ors.push(eb('notifications.recipient', 'like', `%${escapeLike(digits.slice(-10))}%`))
    conds.push(eb.or(ors))
  }
  return eb.and(conds)
}

/** Date range (business dates in the tenant's timezone) → instant range on created_at. */
function rangeOf(q: ListQuery, tz: string): { start: Date; end: Date } | null {
  if (!q.from && !q.to) return null
  return instantRangeForDates(q.from ?? '2000-01-01', q.to ?? '2999-12-31', tz)
}

export async function listNotifications(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  q: ListQuery,
): Promise<NotificationListResponse> {
  const page = parsePage(q)
  const range = rangeOf(q, await tenantTimezone(tx, ctx))
  const sortCol =
    q.sort.field === 'scheduled_at'
      ? 'notifications.scheduled_at'
      : q.sort.field === 'status'
        ? 'notifications.status'
        : 'notifications.created_at'
  const listQb = selectNotification(tx)
    .where((eb) => listFilter(eb, ctx, q, range))
    .orderBy(sortCol, q.sort.direction)
    .orderBy('notifications.id', q.sort.direction)
  const result = await paginate(listQb, page)

  const byStatus = await tx
    .selectFrom('notifications')
    .select(['notifications.status', sql<string>`count(*)`.as('count')])
    .where((eb) => listFilter(eb, ctx, q, range, 'status'))
    .groupBy('notifications.status')
    .orderBy('notifications.status')
    .execute()
  const byChannel = await tx
    .selectFrom('notifications')
    .select(['notifications.channel', sql<string>`count(*)`.as('count')])
    .where((eb) => listFilter(eb, ctx, q, range, 'channel'))
    .groupBy('notifications.channel')
    .orderBy('notifications.channel')
    .execute()

  return {
    data: result.data.map(toNotificationDto),
    page: result.page,
    summary: {
      by_status: byStatus.map((r) => ({
        status: r.status as NotificationStatus,
        count: Number(r.count),
      })),
      by_channel: byChannel.map((r) => ({
        channel: r.channel as NotificationChannel,
        count: Number(r.count),
      })),
    },
  }
}

/**
 * Queues a failed / cancelled notification again: attempts reset, delivery fields cleared, the
 * send job kicked after commit. Other statuses → 409 CONFLICT {reason: 'not_retryable'}. Audited.
 */
export async function retryNotification(
  tx: Tx,
  ctx: RequestContext,
  id: string,
): Promise<Notification> {
  const current = await tx
    .selectFrom('notifications')
    .select(['id', 'status', 'template_code', 'recipient', 'error'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!current) throw notFound('notification', id)
  if (!RETRYABLE_STATUSES.includes(current.status as NotificationStatus))
    throw conflict('Only failed or cancelled messages can be sent again', {
      reason: 'not_retryable',
      status: current.status,
    })
  const now = new Date()
  await tx
    .updateTable('notifications')
    .set({
      status: 'queued',
      attempts: 0,
      error: null,
      provider: null,
      provider_message_id: null,
      sent_at: null,
      scheduled_at: now,
      updated_at: now,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'notification.retry',
    entity_type: 'notification',
    entity_id: id,
    summary: `Retry ${current.template_code} (was ${current.status})`,
    changes: {
      before: { status: current.status, error: current.error },
      after: { status: 'queued' },
    },
  })
  afterCommit(tx, () => kickSendJob({ tenant_id: ctx.tenantId, notification_id: id }))
  return loadNotification(tx, ctx, id)
}
