/**
 * Background jobs of the inventory module (collected by src/jobs/registry.ts). See src/jobs/types.ts.
 *
 * `inventory.alerts` — daily 08:00 IST. The cron run (no payload) fans out one run per active
 * tenant (`{tenant_id, date}`, InventoryAlertsJobSchema; singleton per tenant and day). A tenant
 * run builds, per active store, the low-stock digest (low + out of stock) and — with the
 * batches_expiry feature — the expiry digest (expiring within settings.inventory.expiry_warning_days
 * + expired batches with stock), and queues them for every active owner through core notify
 * (templates low_stock_digest / expiry_digest; WhatsApp to the owner's phone, else email), when
 * settings.notifications.low_stock_digest is on and the plan has the notifications feature.
 * A digest already queued for the same owner, store and day is not queued again (retries).
 */
import type { Kysely } from 'kysely'
import {
  type Locale,
  formatDateDisplay,
  formatINR,
  formatQty,
  startOfDayInstant,
  todayIn,
} from '@kadai/shared'
import {
  type ExpiryAlertItem,
  type ExpiryDigestParams,
  INVENTORY_DIGEST_TEMPLATES,
  InventoryAlertsJobSchema,
  type LowStockDigestParams,
  type StockAlertItem,
} from '@kadai/shared/api/inventory'
import { normalizeRecipient } from '@kadai/shared/api/notifications'
import { systemContext } from '../../core/context'
import { getEntitlements } from '../../core/entitlements'
import { type SendOptions, enqueue } from '../../core/jobs'
import { enqueueNotification } from '../../core/notify'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import type { DB } from '../../db/schema.generated'
import { type Tx, withTenant } from '../../db/tenant'
import { type KadaiJob, defineJob } from '../../jobs/types'
import { computeAlerts } from './alerts'

export const INVENTORY_ALERTS_JOB = 'inventory.alerts'

/** Items listed in one digest message (the counts cover everything). */
export const DIGEST_ITEM_LIMIT = 10

/**
 * Longest items_text (characters): notification params are capped at 2000 and a WhatsApp template
 * parameter at 1024, so long product names drop the last lines instead of failing the digest.
 */
export const DIGEST_TEXT_MAX = 900

/** ref_type of digest notifications (ref_id = the store). */
export const DIGEST_REF_TYPE = 'store'

type AlertDeps = Pick<KadaiDeps, 'db' | 'config'>

/**
 * Active tenants. §6.1: the cron fan-out runs across tenants, so it reads `tenants` through the
 * system pool (ids only); every tenant's work then runs in its own RLS transaction.
 */
export async function listAlertTenants(systemDb: Kysely<DB>): Promise<string[]> {
  const rows = await systemDb
    .selectFrom('tenants')
    .select('id')
    .where('status', '=', 'active')
    .orderBy('id')
    .execute()
  return rows.map((r) => r.id)
}

export type JobSender = (name: string, data: object, options: SendOptions) => Promise<unknown>

/** Cron run: one `inventory.alerts` job per active tenant for `date` (singleton per day). */
export async function fanOutInventoryAlerts(
  deps: Pick<KadaiDeps, 'db'>,
  date: string,
  send: JobSender = enqueue,
): Promise<number> {
  const tenants = await listAlertTenants(deps.db.systemDb)
  for (const tenantId of tenants) {
    await send(
      INVENTORY_ALERTS_JOB,
      { tenant_id: tenantId, date },
      { singletonKey: `${INVENTORY_ALERTS_JOB}:${tenantId}:${date}`, singletonSeconds: 86_400 },
    )
  }
  return tenants.length
}

export interface DigestRecipient {
  user_id: string
  full_name: string
  channel: 'whatsapp' | 'email'
  /** Normalised recipient (E.164 phone / lower-case email), as stored by core notify. */
  to: string
  locale: Locale
}

export interface InventoryAlertsResult {
  tenant_id: string
  date: string
  skipped: null | 'disabled' | 'feature' | 'no_recipients'
  stores: number
  queued: number
  duplicates: number
}

async function ownerRecipients(tx: Tx, tenantId: string): Promise<DigestRecipient[]> {
  const rows = await tx
    .selectFrom('memberships as m')
    .innerJoin('roles as r', (j) =>
      j.onRef('r.tenant_id', '=', 'm.tenant_id').onRef('r.id', '=', 'm.role_id'),
    )
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id', 'u.full_name', 'u.phone', 'u.email', 'u.preferred_locale'])
    .where('m.tenant_id', '=', tenantId)
    .where('m.status', '=', 'active')
    .where('r.code', '=', 'owner')
    .where('u.status', '=', 'active')
    .orderBy('u.id')
    .execute()
  const out: DigestRecipient[] = []
  for (const r of rows) {
    const locale: Locale = r.preferred_locale === 'en' ? 'en' : 'ta'
    const phone = r.phone ? normalizeRecipient('whatsapp', r.phone) : null
    const email = r.email ? normalizeRecipient('email', r.email) : null
    if (phone) {
      out.push({ user_id: r.id, full_name: r.full_name, channel: 'whatsapp', to: phone, locale })
    } else if (email) {
      out.push({ user_id: r.id, full_name: r.full_name, channel: 'email', to: email, locale })
    }
  }
  return out
}

function itemName(item: { name: string; name_ta: string | null }, locale: Locale): string {
  return locale === 'ta' && item.name_ta ? item.name_ta : item.name
}

/** One line per item, as many whole lines as fit in DIGEST_TEXT_MAX (a lone line is cut). */
function joinLines(lines: readonly string[]): string {
  let out = ''
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line
    if (next.length > DIGEST_TEXT_MAX) return out || `${line.slice(0, DIGEST_TEXT_MAX - 1)}…`
    out = next
  }
  return out
}

/** "Ponni Rice 1 kg — 3 pcs" lines for the low-stock digest. */
export function lowStockItemsText(
  items: readonly StockAlertItem[],
  locale: Locale,
  limit = DIGEST_ITEM_LIMIT,
): string {
  return joinLines(
    items
      .slice(0, limit)
      .map((i) => `${itemName(i, locale)} — ${formatQty(i.qty_milli, i.unit, locale)}`),
  )
}

/** "Paracetamol 500 (B123) — 20-11-2026 — 30 tabs" lines for the expiry digest. */
export function expiryItemsText(
  items: readonly ExpiryAlertItem[],
  locale: Locale,
  limit = DIGEST_ITEM_LIMIT,
): string {
  return joinLines(
    items
      .slice(0, limit)
      .map(
        (i) =>
          `${itemName(i, locale)} (${i.batch_no}) — ${formatDateDisplay(i.expiry_date)} — ${formatQty(i.qty_milli, i.unit, locale)}`,
      ),
  )
}

/** A digest of `template` for this recipient and store was queued since `since` (job retries). */
async function alreadyQueued(
  tx: Tx,
  tenantId: string,
  template: string,
  recipient: DigestRecipient,
  storeId: string,
  since: Date,
): Promise<boolean> {
  const row = await tx
    .selectFrom('notifications')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('template_code', '=', template)
    .where('channel', '=', recipient.channel)
    .where('ref_type', '=', DIGEST_REF_TYPE)
    .where('ref_id', '=', storeId)
    .where('recipient', '=', recipient.to)
    .where('created_at', '>=', since)
    .limit(1)
    .executeTakeFirst()
  return row !== undefined
}

/** One tenant's digests for `date` (see the module comment). */
export async function runInventoryAlerts(
  deps: AlertDeps,
  tenantId: string,
  date: string,
): Promise<InventoryAlertsResult> {
  const ctx = systemContext(tenantId, { requestId: `job:${INVENTORY_ALERTS_JOB}:${tenantId}` })
  return withTenant(deps.db.appDb, ctx, async (tx) => {
    const result: InventoryAlertsResult = {
      tenant_id: tenantId,
      date,
      skipped: null,
      stores: 0,
      queued: 0,
      duplicates: 0,
    }
    const settings = await getSettings(tx, ctx)
    if (!settings.notifications.low_stock_digest) return { ...result, skipped: 'disabled' }
    const ent = await getEntitlements(ctx)
    if (!ent.features.has('notifications')) return { ...result, skipped: 'feature' }
    const recipients = await ownerRecipients(tx, tenantId)
    if (recipients.length === 0) return { ...result, skipped: 'no_recipients' }
    const withExpiry = ent.features.has('batches_expiry')

    const tenant = await tx
      .selectFrom('tenants')
      .select(['name', 'name_ta', 'timezone'])
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow()
    const since = startOfDayInstant(date, tenant.timezone)
    const stores = await tx
      .selectFrom('stores')
      .select(['id', 'code', 'name', 'name_ta'])
      .where('tenant_id', '=', tenantId)
      .where('is_active', '=', true)
      .orderBy('code')
      .execute()
    const base = deps.config.publicBaseUrl

    for (const store of stores) {
      result.stores += 1
      const alerts = await computeAlerts(
        tx,
        ctx,
        { kind: 'single', storeId: store.id },
        DIGEST_ITEM_LIMIT,
        { today: date },
      )
      const lowCount = alerts.counts.low_stock
      const outCount = alerts.counts.out_of_stock + alerts.counts.negative
      const expiringCount = alerts.counts.expiring
      const expiredCount = alerts.counts.expired
      for (const r of recipients) {
        const common = {
          shop_name: r.locale === 'ta' && tenant.name_ta ? tenant.name_ta : tenant.name,
          store_name: r.locale === 'ta' && store.name_ta ? store.name_ta : store.name,
          date: formatDateDisplay(date),
        }
        const send = async (
          template: (typeof INVENTORY_DIGEST_TEMPLATES)[keyof typeof INVENTORY_DIGEST_TEMPLATES],
          params: LowStockDigestParams | ExpiryDigestParams,
        ) => {
          if (await alreadyQueued(tx, tenantId, template, r, store.id, since)) {
            result.duplicates += 1
            return
          }
          await enqueueNotification(tx, ctx, {
            channel: r.channel,
            template_code: template,
            to: r.to,
            recipient_name: r.full_name,
            locale: r.locale,
            params,
            ref_type: DIGEST_REF_TYPE,
            ref_id: store.id,
          })
          result.queued += 1
        }
        if (lowCount + outCount > 0) {
          await send(INVENTORY_DIGEST_TEMPLATES.low_stock, {
            ...common,
            low_stock_count: lowCount,
            out_of_stock_count: outCount,
            items_text: lowStockItemsText([...alerts.out_of_stock, ...alerts.low_stock], r.locale),
            link: `${base}/inventory/stock?store_id=${store.id}&low_stock=true`,
          })
        }
        if (withExpiry && expiringCount + expiredCount > 0) {
          await send(INVENTORY_DIGEST_TEMPLATES.expiry, {
            ...common,
            expiring_count: expiringCount,
            expired_count: expiredCount,
            value_text: formatINR(alerts.expiring_value_paise + alerts.expired_value_paise),
            items_text: expiryItemsText([...alerts.expired, ...alerts.expiring], r.locale),
            link: `${base}/inventory/batches?store_id=${store.id}&expiring_within_days=${String(alerts.expiry_warning_days)}`,
          })
        }
      }
    }
    return result
  })
}

export const jobs: readonly KadaiJob[] = [
  defineJob<Record<string, unknown>>({
    name: INVENTORY_ALERTS_JOB,
    cron: '0 8 * * *',
    tz: 'Asia/Kolkata',
    options: { retryLimit: 3, retryDelay: 60, retryBackoff: true },
    async handler(job, deps) {
      const parsed = InventoryAlertsJobSchema.safeParse(job.data)
      if (!parsed.success) {
        // The cron run carries no tenant: fan out over the active tenants.
        const date = todayIn('Asia/Kolkata')
        const count = await fanOutInventoryAlerts(deps, date)
        deps.logger.info({ tenants: count, date }, 'inventory.alerts fan-out')
        return
      }
      const res = await runInventoryAlerts(deps, parsed.data.tenant_id, parsed.data.date)
      deps.logger.info({ ...res }, 'inventory.alerts done')
    },
  }),
]
