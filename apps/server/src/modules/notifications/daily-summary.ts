/**
 * Job `notifications.daily-summary` (21:30 IST): today's business in one message to every owner's
 * phone — net sales (bills − returns), bill count, money received by cash / UPI / card, sold on
 * credit, dues collected (receipts applied to earlier bills or the opening balance), the best
 * selling item and the number of products at or below their reorder level.
 *
 * Only for active tenants with the plan feature 'notifications' and
 * settings.notifications.daily_summary_to_owner; days without any bill, return or receipt are
 * skipped; one summary per owner phone and date (ref tenant, params.date) even if the job runs
 * twice. WhatsApp when live, else SMS (outside production: WhatsApp through the log provider).
 */
import { formatDateDisplay, formatINR, sumPaise, toDateStr } from '@kadai/shared'
import { type DailySummaryParamsSchema } from '@kadai/shared/api/notifications'
import { sql } from 'kysely'
import type { z } from 'zod'
import { systemContext } from '../../core/context'
import { enqueueNotification } from '../../core/notify'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import { type Tx, withTenant } from '../../db/tenant'
import type { RequestContext } from '../../core/context'
import { localeOf, loadShop, shopNameFor } from './common'
import { installNotificationProviders } from './providers'
import { automaticChannel } from './reminders'

type DailySummaryParams = z.input<typeof DailySummaryParamsSchema>

export interface DailyFigures {
  date: string
  bills: number
  sales_paise: number
  returns_paise: number
  net_sales_paise: number
  credit_paise: number
  received: { cash: number; upi: number; card: number; other: number }
  dues_collected_paise: number
  top_item: { name: string; name_ta: string | null; total_paise: number } | null
  low_stock_count: number
}

const SALE_DOC_TYPES = ['tax_invoice', 'bill_of_supply'] as const

/** Today's figures of the whole business (all stores) for `date` (tenant business date). */
export async function dailyFigures(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  date: string,
): Promise<DailyFigures> {
  const t = ctx.tenantId
  const inv = await tx
    .selectFrom('sales_invoices')
    .select([
      sql<string>`count(*)`.as('bills'),
      sql<string>`coalesce(sum(total_paise), 0)`.as('total'),
      sql<string>`coalesce(sum(due_paise), 0)`.as('due'),
    ])
    .where('tenant_id', '=', t)
    .where('status', '=', 'completed')
    .where('doc_type', 'in', SALE_DOC_TYPES)
    .where('invoice_date', '=', date)
    .executeTakeFirstOrThrow()
  const cn = await tx
    .selectFrom('credit_notes')
    .select(sql<string>`coalesce(sum(total_paise), 0)`.as('total'))
    .where('tenant_id', '=', t)
    .where('status', '=', 'completed')
    .where('note_date', '=', date)
    .executeTakeFirstOrThrow()
  const byMethod = await tx
    .selectFrom('payments')
    .select(['method', sql<string>`sum(amount_paise)`.as('amount')])
    .where('tenant_id', '=', t)
    .where('direction', '=', 'in')
    .where('status', '=', 'completed')
    .where('method', '<>', 'store_credit')
    .where('payment_date', '=', date)
    .groupBy('method')
    .execute()
  const collected = await tx
    .selectFrom('payment_allocations as pa')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.id', '=', 'pa.payment_id').onRef('p.tenant_id', '=', 'pa.tenant_id'),
    )
    .leftJoin('sales_invoices as si', (j) =>
      j.onRef('si.id', '=', 'pa.target_id').onRef('si.tenant_id', '=', 'pa.tenant_id'),
    )
    .select(sql<string>`coalesce(sum(pa.amount_paise), 0)`.as('amount'))
    .where('pa.tenant_id', '=', t)
    .where('p.direction', '=', 'in')
    .where('p.status', '=', 'completed')
    .where('p.payment_date', '=', date)
    .where((eb) =>
      eb.or([
        eb('pa.target_type', '=', 'opening_balance'),
        eb.and([eb('pa.target_type', '=', 'sales_invoice'), eb('si.invoice_date', '<', date)]),
      ]),
    )
    .executeTakeFirstOrThrow()
  const top = await tx
    .selectFrom('sales_invoice_lines as l')
    .innerJoin('sales_invoices as si', (j) =>
      j.onRef('si.id', '=', 'l.invoice_id').onRef('si.tenant_id', '=', 'l.tenant_id'),
    )
    .select([
      sql<string>`min(l.name)`.as('name'),
      sql<string | null>`min(l.name_ta)`.as('name_ta'),
      sql<string>`sum(l.total_paise)`.as('total'),
    ])
    .where('l.tenant_id', '=', t)
    .where('si.status', '=', 'completed')
    .where('si.doc_type', 'in', SALE_DOC_TYPES)
    .where('si.invoice_date', '=', date)
    .groupBy(sql`coalesce(l.product_id::text, l.name)`)
    .orderBy(sql`sum(l.total_paise)`, 'desc')
    .orderBy(sql`min(l.name)`)
    .limit(1)
    .executeTakeFirst()
  const low = await tx
    .selectFrom('products as p')
    .select(sql<string>`count(*)`.as('n'))
    .where('p.tenant_id', '=', t)
    .where('p.is_active', '=', true)
    .where('p.track_inventory', '=', true)
    .where('p.kind', '<>', 'variant_parent')
    .where('p.reorder_level_milli', 'is not', null)
    .where(
      sql<boolean>`coalesce((select sum(sl.qty_milli) from stock_levels sl
                              where sl.tenant_id = p.tenant_id and sl.product_id = p.id), 0)
                   <= p.reorder_level_milli`,
    )
    .executeTakeFirstOrThrow()

  const method = (m: string) => Number(byMethod.find((r) => r.method === m)?.amount ?? 0)
  const cash = method('cash')
  const upi = method('upi')
  const card = method('card')
  const total = sumPaise(byMethod.map((r) => Number(r.amount)))
  const sales = Number(inv.total)
  const returns = Number(cn.total)
  return {
    date,
    bills: Number(inv.bills),
    sales_paise: sales,
    returns_paise: returns,
    net_sales_paise: sales - returns,
    credit_paise: Number(inv.due),
    received: { cash, upi, card, other: total - cash - upi - card },
    dues_collected_paise: Number(collected.amount),
    top_item: top ? { name: top.name, name_ta: top.name_ta, total_paise: Number(top.total) } : null,
    low_stock_count: Number(low.n),
  }
}

/** True when nothing happened that day (no bill, return or receipt): no summary is sent. */
export function isQuietDay(f: DailyFigures): boolean {
  return (
    f.bills === 0 &&
    f.returns_paise === 0 &&
    f.received.cash + f.received.upi + f.received.card + f.received.other === 0
  )
}

export function dailySummaryParams(
  f: DailyFigures,
  input: { shop_name: string; locale: 'ta' | 'en'; link: string | null },
): DailySummaryParams {
  const top = f.top_item
    ? input.locale === 'ta' && f.top_item.name_ta?.trim()
      ? f.top_item.name_ta.trim()
      : f.top_item.name
    : '-'
  return {
    shop_name: input.shop_name,
    date: formatDateDisplay(f.date),
    net_sales: formatINR(f.net_sales_paise),
    bills: f.bills,
    cash: formatINR(f.received.cash),
    upi: formatINR(f.received.upi),
    card: formatINR(f.received.card),
    credit: formatINR(f.credit_paise),
    dues_collected: formatINR(f.dues_collected_paise),
    top_item: top.slice(0, 200),
    low_stock_count: f.low_stock_count,
    link: input.link,
  }
}

/** Queues today's summary for one tenant; returns the number of messages queued. */
export async function summarizeTenant(
  deps: Pick<KadaiDeps, 'db' | 'config' | 'logger' | 'entitlements'>,
  tenantId: string,
  now: Date,
): Promise<number> {
  const ent = await deps.entitlements.get(tenantId)
  if (!ent.features.has('notifications')) return 0
  const registry = installNotificationProviders(deps.config, deps.logger)
  const channel = automaticChannel(registry, deps.config, ['whatsapp', 'sms'])
  if (!channel) return 0
  const ctx = systemContext(tenantId, { requestId: `job:notifications.daily-summary:${tenantId}` })
  return withTenant(deps.db.appDb, ctx, async (tx) => {
    const settings = await getSettings(tx, ctx)
    if (!settings.notifications.daily_summary_to_owner) return 0
    const shop = await loadShop(tx, ctx)
    if (shop.status !== 'active') return 0
    const date = toDateStr(now, shop.timezone)
    const figures = await dailyFigures(tx, ctx, date)
    if (isQuietDay(figures)) return 0
    const owners = await tx
      .selectFrom('memberships as m')
      .innerJoin('roles as r', (j) =>
        j.onRef('r.id', '=', 'm.role_id').onRef('r.tenant_id', '=', 'm.tenant_id'),
      )
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.phone', 'u.full_name', 'u.preferred_locale'])
      .where('m.tenant_id', '=', tenantId)
      .where('m.status', '=', 'active')
      .where('r.code', '=', 'owner')
      .where('u.status', '=', 'active')
      .where('u.phone', 'is not', null)
      .orderBy('u.id')
      .execute()
    const displayDate = formatDateDisplay(date)
    const link = deps.config.publicBaseUrl.startsWith('https://')
      ? `${deps.config.publicBaseUrl}/`
      : null
    let queued = 0
    for (const o of owners) {
      if (!o.phone) continue
      const already = await tx
        .selectFrom('notifications')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('template_code', '=', 'daily_summary')
        .where('ref_type', '=', 'tenant')
        .where('ref_id', '=', tenantId)
        .where('recipient', '=', o.phone)
        .where(sql<boolean>`params->>'date' = ${displayDate}`)
        .executeTakeFirst()
      if (already) continue
      const locale = localeOf(o.preferred_locale)
      await enqueueNotification(tx, ctx, {
        channel,
        template_code: 'daily_summary',
        to: o.phone,
        recipient_name: o.full_name,
        locale,
        params: dailySummaryParams(figures, {
          shop_name: shopNameFor(shop, locale),
          locale,
          link,
        }),
        ref_type: 'tenant',
        ref_id: tenantId,
      })
      queued++
    }
    return queued
  })
}

/**
 * Fans the summary out over active tenants (SYSTEM database for the tenant ids only — a cron run
 * has no tenant; ARCHITECTURE.md §6.1). `tenantIds` limits the run (tests / manual runs).
 */
export async function runDailySummary(
  deps: Pick<KadaiDeps, 'db' | 'config' | 'logger' | 'entitlements'>,
  opts: { now?: Date; tenantIds?: readonly string[] } = {},
): Promise<{ tenants: number; queued: number }> {
  const now = opts.now ?? new Date()
  if (opts.tenantIds && opts.tenantIds.length === 0) return { tenants: 0, queued: 0 }
  let q = deps.db.systemDb.selectFrom('tenants').select('id').where('status', '=', 'active')
  if (opts.tenantIds) q = q.where('id', 'in', opts.tenantIds)
  const tenants = await q.orderBy('id').execute()
  let queued = 0
  for (const t of tenants) {
    try {
      queued += await summarizeTenant(deps, t.id, now)
    } catch (err) {
      deps.logger.error({ err, tenant_id: t.id }, 'daily summary failed for a tenant')
    }
  }
  if (queued) deps.logger.info({ queued, tenants: tenants.length }, 'daily summaries queued')
  return { tenants: tenants.length, queued }
}
