/**
 * Khata due reminders: POST /customers/:id/remind (one customer, on demand) and the daily job
 * `notifications.due-reminders` (10:00 IST). Both build the `due_reminder` message the same way:
 * the due, the age of the oldest unpaid bill, a UPI pay link (./payment-link.ts) and the shop
 * phone; the source of every reminder is ref_type 'customer' / ref_id <customer id>, which is
 * how "reminded in the last DUE_REMINDER_MIN_GAP_DAYS days" and last_reminded_at are found.
 */
import {
  type Locale,
  type NotificationChannel,
  diffDays,
  formatINR,
  formatPhoneDisplay,
  toDateStr,
} from '@kadai/shared'
import {
  type CustomerRemindResult,
  type CustomerRemindSchema,
  type NotificationProviderRegistry,
  type NotificationsErrorReason,
  type TemplateOverride,
  renderNotification,
  renderTemplate,
  resolveTemplate,
  shouldSendDueReminder,
  waMeUrl,
} from '@kadai/shared/api/notifications'
import { sql } from 'kysely'
import type { z } from 'zod'
import type { Config } from '../../config'
import { audit } from '../../core/audit'
import { type RequestContext, systemContext } from '../../core/context'
import { assertFeature } from '../../core/entitlements'
import { type AppError, notFound, unprocessable } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { enqueueNotification } from '../../core/notify'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import { type Tx, withTenant } from '../../db/tenant'
import { type ShopInfo, isoOrNull, loadShop, shopNameFor } from './common'
import { loadNotification } from './outbox'
import { type DueLink, createDueLinkIntent, vpaAccountFor } from './payment-link'
import { installNotificationProviders, isLiveProvider } from './providers'

type RemindBody = z.output<typeof CustomerRemindSchema>

/** Reminders sent per tenant and run at most (the rest wait for the next day's run). */
export const DUE_REMINDERS_PER_RUN = 1000

/** 422 UNPROCESSABLE with a NOTIFICATIONS_ERROR_REASONS `details.reason`. */
function reason(
  message: string,
  r: Extract<
    NotificationsErrorReason,
    'no_due' | 'no_phone' | 'whatsapp_opt_out' | 'channel_not_configured' | 'amount_exceeds_due'
  >,
): AppError {
  return unprocessable(message, { reason: r })
}

/**
 * The channel automatic messages use: the first of `prefer` with a live provider; outside
 * production the first preference (log provider) — in production null when nothing is live.
 */
export function automaticChannel(
  registry: NotificationProviderRegistry,
  config: Pick<Config, 'isProduction'>,
  prefer: readonly NotificationChannel[],
): NotificationChannel | null {
  for (const ch of prefer) if (isLiveProvider(registry.forChannel(ch))) return ch
  return config.isProduction ? null : (prefer[0] ?? null)
}

/** True when `channel` can be used now (a live provider; or any provider outside production). */
export function channelUsable(
  registry: NotificationProviderRegistry,
  config: Pick<Config, 'isProduction'>,
  channel: NotificationChannel,
): boolean {
  const p = registry.forChannel(channel)
  return config.isProduction ? isLiveProvider(p) : p !== undefined
}

/** Oldest completed bill with a due → business date, or null (a due from the opening balance only). */
export async function oldestDueDate(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  customerId: string,
): Promise<string | null> {
  const r = await tx
    .selectFrom('sales_invoices')
    .select(sql<string | null>`min(invoice_date)::text`.as('d'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('customer_id', '=', customerId)
    .where('status', '=', 'completed')
    .where('doc_type', '<>', 'estimate')
    .where('due_paise', '>', 0)
    .executeTakeFirst()
  return r?.d ?? null
}

/** created_at of the latest due reminder to the customer (cancelled ones excluded). */
export async function lastReminderAt(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  customerId: string,
): Promise<Date | null> {
  const r = await tx
    .selectFrom('notifications')
    .select(sql<Date | null>`max(created_at)`.as('at'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('template_code', '=', 'due_reminder')
    .where('ref_type', '=', 'customer')
    .where('ref_id', '=', customerId)
    .where('status', '<>', 'cancelled')
    .executeTakeFirst()
  return r?.at ?? null
}

/** Store of the customer's latest bill, else the first store the actor may use. */
async function defaultStoreFor(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId' | 'storeIds'>,
  customerId: string,
): Promise<string | null> {
  if (ctx.storeIds && ctx.storeIds.length === 0) return null
  let q = tx
    .selectFrom('sales_invoices')
    .select('store_id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('customer_id', '=', customerId)
    .where('status', '=', 'completed')
  if (ctx.storeIds) q = q.where('store_id', 'in', ctx.storeIds)
  const latest = await q
    .orderBy('invoice_date', 'desc')
    .orderBy('invoice_at', 'desc')
    .executeTakeFirst()
  if (latest) return latest.store_id
  let s = tx
    .selectFrom('stores')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('is_active', '=', true)
  if (ctx.storeIds) s = s.where('id', 'in', ctx.storeIds)
  const store = await s.orderBy('code').executeTakeFirst()
  return store?.id ?? null
}

async function overrideFor(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  channel: NotificationChannel,
  locale: Locale,
): Promise<TemplateOverride | null> {
  return (
    (await tx
      .selectFrom('notification_templates')
      .select(['subject', 'body', 'provider_template_id', 'is_active'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('code', '=', 'due_reminder')
      .where('channel', '=', channel)
      .where('locale', '=', locale)
      .executeTakeFirst()) ?? null
  )
}

interface ReminderInput {
  shop: ShopInfo
  customer: { id: string; name: string; name_ta: string | null }
  amount_paise: number
  /** Business date the due started (oldest unpaid bill; see dueSinceDate). */
  due_since: string | null
  locale: Locale
  store_id: string | null
  include_link: boolean
  today: string
  now: Date
}

/**
 * Business date the customer's due started: the oldest unpaid bill, else (a due carried over as
 * the opening balance only) the day the customer was added.
 */
export async function dueSinceDate(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  customer: { id: string; created_at: Date },
  timezone: string,
): Promise<string> {
  return (await oldestDueDate(tx, ctx, customer.id)) ?? toDateStr(customer.created_at, timezone)
}

interface BuiltReminder {
  params: {
    shop_name: string
    customer_name: string
    due: string
    days: number
    link: string
    shop_phone: string | null
  }
  link: DueLink | null
}

/** due_reminder params, creating the pay-link intent when asked and possible. */
async function buildReminder(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId' | 'userId'>,
  config: Pick<Config, 'publicBaseUrl'>,
  input: ReminderInput,
): Promise<BuiltReminder> {
  const shopName = shopNameFor(input.shop, input.locale)
  const customerName =
    input.locale === 'ta' && input.customer.name_ta?.trim()
      ? input.customer.name_ta.trim()
      : input.customer.name
  const days = input.due_since ? Math.max(0, diffDays(input.due_since, input.today)) : 0
  const shopPhone = input.shop.phone ? formatPhoneDisplay(input.shop.phone) : null
  let link: DueLink | null = null
  let linkText: string | null = null
  if (input.store_id) {
    if (input.include_link)
      link = await createDueLinkIntent(tx, ctx, config, {
        customer: { id: input.customer.id, name: input.customer.name },
        store_id: input.store_id,
        amount_paise: input.amount_paise,
        shop_name: input.shop.name,
        now: input.now,
      })
    if (link) linkText = link.url
    else {
      const acct = await vpaAccountFor(tx, ctx, input.store_id)
      if (acct) linkText = `UPI: ${acct.vpa}`
    }
  }
  return {
    params: {
      shop_name: shopName,
      customer_name: customerName,
      due: formatINR(input.amount_paise),
      days,
      link: linkText ?? shopPhone ?? '-',
      shop_phone: shopPhone,
    },
    link,
  }
}

/**
 * POST /customers/:id/remind. whatsapp / sms need the plan feature 'notifications' (402), a
 * phone, a usable provider (422 channel_not_configured → use 'wa_me') and, for WhatsApp, the
 * customer's opt-in (422 whatsapp_opt_out). 'wa_me' only returns the text and a wa.me link.
 */
export async function remindCustomer(
  tx: Tx,
  ctx: RequestContext,
  deps: Pick<KadaiDeps, 'config' | 'logger'>,
  customerId: string,
  body: RemindBody,
): Promise<CustomerRemindResult> {
  const registry = installNotificationProviders(deps.config, deps.logger)
  const customer = await tx
    .selectFrom('customers')
    .select([
      'id',
      'name',
      'name_ta',
      'phone',
      'balance_paise',
      'whatsapp_opt_in',
      'is_active',
      'created_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', customerId)
    .forUpdate()
    .executeTakeFirst()
  if (!customer) throw notFound('customer', customerId)
  const due = Number(customer.balance_paise)
  if (due <= 0) throw reason('The customer has nothing due', 'no_due')
  const amount = body.amount_paise ?? due
  if (amount > due) throw reason('The amount is more than the due', 'amount_exceeds_due')
  const phone = body.phone ?? customer.phone
  if (!phone) throw reason('The customer has no mobile number', 'no_phone')

  const channel = body.channel
  if (channel !== 'wa_me') {
    await assertFeature(ctx, 'notifications')
    if (channel === 'whatsapp' && !customer.whatsapp_opt_in)
      throw reason('The customer opted out of WhatsApp messages', 'whatsapp_opt_out')
    if (!channelUsable(registry, deps.config, channel))
      throw reason(`No ${channel} service is set up`, 'channel_not_configured')
  }

  const shop = await loadShop(tx, ctx)
  const locale = body.locale ?? shop.default_locale
  const storeId = body.store_id ?? (await defaultStoreFor(tx, ctx, customer.id))
  if (storeId) assertStoreAccess(ctx, storeId)
  const now = new Date()
  const previous = await lastReminderAt(tx, ctx, customer.id)
  const built = await buildReminder(tx, ctx, deps.config, {
    shop,
    customer,
    amount_paise: amount,
    due_since: await dueSinceDate(tx, ctx, customer, shop.timezone),
    locale,
    store_id: storeId,
    include_link: body.include_payment_link,
    today: toDateStr(now, shop.timezone),
    now,
  })

  const textChannel: NotificationChannel = channel === 'sms' ? 'sms' : 'whatsapp'
  const override = await overrideFor(tx, ctx, textChannel, locale)
  let message: string
  let notificationId: string | null = null
  if (channel === 'wa_me') {
    const t = resolveTemplate({ code: 'due_reminder', channel: 'whatsapp', locale, override })
    message = t ? renderTemplate(t.body, built.params).text : ''
  } else {
    message =
      renderNotification({ code: 'due_reminder', channel, locale, params: built.params, override })
        ?.body ?? ''
    const queued = await enqueueNotification(tx, ctx, {
      channel,
      template_code: 'due_reminder',
      to: phone,
      recipient_name: customer.name,
      locale,
      params: built.params,
      ref_type: 'customer',
      ref_id: customer.id,
    })
    notificationId = queued.id
  }
  await audit(tx, ctx, {
    action: 'customer.remind',
    entity_type: 'customer',
    entity_id: customer.id,
    summary: `Due reminder (${channel}) for ${built.params.due}`,
    changes: {
      channel,
      amount_paise: amount,
      notification_id: notificationId,
      payment_intent_id: built.link?.intent.id ?? null,
    },
  })
  return {
    customer_id: customer.id,
    due_paise: due,
    amount_paise: amount,
    channel,
    notification: notificationId ? await loadNotification(tx, ctx, notificationId) : null,
    link: built.link,
    message,
    wa_me_url: channel === 'wa_me' ? waMeUrl(phone, message) : null,
    last_reminded_at: isoOrNull(previous),
  }
}

// ---------------------------------------------------------------------------------------------
// Job notifications.due-reminders
// ---------------------------------------------------------------------------------------------

export interface DueReminderRunResult {
  tenants: number
  queued: number
}

/**
 * Daily due reminders of one tenant (see shouldSendDueReminder): customers with a due, WhatsApp
 * opt-in (consent for automatic reminders) and a mobile number, whose oldest unpaid bill is
 * exactly N days old today (N in settings.notifications.due_reminder_days, tenant timezone), not
 * reminded in the last DUE_REMINDER_MIN_GAP_DAYS days. WhatsApp when live, else SMS.
 */
export async function remindTenant(
  deps: Pick<KadaiDeps, 'db' | 'config' | 'logger' | 'entitlements'>,
  tenantId: string,
  now: Date,
): Promise<number> {
  const ent = await deps.entitlements.get(tenantId)
  if (!ent.features.has('notifications')) return 0
  const registry = installNotificationProviders(deps.config, deps.logger)
  const channel = automaticChannel(registry, deps.config, ['whatsapp', 'sms'])
  if (!channel) return 0
  const ctx = systemContext(tenantId, { requestId: `job:notifications.due-reminders:${tenantId}` })
  return withTenant(deps.db.appDb, ctx, async (tx) => {
    const settings = await getSettings(tx, ctx)
    const reminderDays = settings.notifications.due_reminder_days
    if (!reminderDays.length) return 0
    const shop = await loadShop(tx, ctx)
    if (shop.status !== 'active') return 0
    const today = toDateStr(now, shop.timezone)
    const rows = await tx
      .selectFrom('customers as c')
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('sales_invoices as si')
            .select([
              sql<string | null>`min(si.invoice_date)::text`.as('oldest'),
              sql<
                string | null
              >`(array_agg(si.store_id order by si.invoice_date desc, si.invoice_at desc))[1]::text`.as(
                'store_id',
              ),
            ])
            .whereRef('si.customer_id', '=', 'c.id')
            .where('si.tenant_id', '=', tenantId)
            .where('si.status', '=', 'completed')
            .where('si.doc_type', '<>', 'estimate')
            .where('si.due_paise', '>', 0)
            .as('d'),
        (join) => join.onTrue(),
      )
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('notifications as n')
            .select(sql<Date | null>`max(n.created_at)`.as('last_at'))
            .where('n.tenant_id', '=', tenantId)
            .where('n.template_code', '=', 'due_reminder')
            .where('n.ref_type', '=', 'customer')
            .whereRef('n.ref_id', '=', 'c.id')
            .where('n.status', '<>', 'cancelled')
            .as('r'),
        (join) => join.onTrue(),
      )
      .select([
        'c.id',
        'c.name',
        'c.name_ta',
        'c.phone',
        'c.balance_paise',
        'd.oldest',
        'd.store_id',
        'r.last_at',
      ])
      .where('c.tenant_id', '=', tenantId)
      .where('c.is_active', '=', true)
      .where('c.whatsapp_opt_in', '=', true)
      .where('c.phone', 'is not', null)
      .where('c.balance_paise', '>', 0)
      .where('d.oldest', 'is not', null)
      .orderBy('d.oldest')
      .orderBy('c.id')
      .execute()
    let queued = 0
    for (const r of rows) {
      if (queued >= DUE_REMINDERS_PER_RUN) break
      if (!r.oldest || !r.phone) continue
      const lastDate = r.last_at ? toDateStr(r.last_at, shop.timezone) : null
      const send = shouldSendDueReminder({
        due_paise: Number(r.balance_paise),
        oldest_due_days: diffDays(r.oldest, today),
        reminder_days: reminderDays,
        can_message: true,
        days_since_last_reminder: lastDate ? diffDays(lastDate, today) : null,
      })
      if (!send) continue
      const locale = shop.default_locale
      const built = await buildReminder(tx, ctx, deps.config, {
        shop,
        customer: { id: r.id, name: r.name, name_ta: r.name_ta },
        amount_paise: Number(r.balance_paise),
        due_since: r.oldest,
        locale,
        store_id: r.store_id,
        include_link: true,
        today,
        now,
      })
      await enqueueNotification(tx, ctx, {
        channel,
        template_code: 'due_reminder',
        to: r.phone,
        recipient_name: r.name,
        locale,
        params: built.params,
        ref_type: 'customer',
        ref_id: r.id,
      })
      queued++
    }
    return queued
  })
}

/**
 * Fans the due reminders out over active tenants. Uses the SYSTEM database only to list tenant
 * ids (a cron run has no tenant; ARCHITECTURE.md §6.1); each tenant runs under RLS. One tenant's
 * failure is logged and does not stop the others. `tenantIds` limits the run (tests / manual).
 */
export async function runDueReminders(
  deps: Pick<KadaiDeps, 'db' | 'config' | 'logger' | 'entitlements'>,
  opts: { now?: Date; tenantIds?: readonly string[] } = {},
): Promise<DueReminderRunResult> {
  const now = opts.now ?? new Date()
  if (opts.tenantIds && opts.tenantIds.length === 0) return { tenants: 0, queued: 0 }
  let q = deps.db.systemDb.selectFrom('tenants').select('id').where('status', '=', 'active')
  if (opts.tenantIds) q = q.where('id', 'in', opts.tenantIds)
  const tenants = await q.orderBy('id').execute()
  let queued = 0
  for (const t of tenants) {
    try {
      queued += await remindTenant(deps, t.id, now)
    } catch (err) {
      deps.logger.error({ err, tenant_id: t.id }, 'due reminders failed for a tenant')
    }
  }
  if (queued) deps.logger.info({ queued, tenants: tenants.length }, 'due reminders queued')
  return { tenants: tenants.length, queued }
}
