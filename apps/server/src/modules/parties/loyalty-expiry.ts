/**
 * Loyalty points expiry (settings.loyalty.expiry_days; feature `loyalty`). Redemptions and other
 * debits consume the OLDEST points first (FIFO), so for a customer
 *
 *   expiring = max(0, Σ credits earned before the cut-off − Σ debits ever)   (clamped to balance)
 *
 * where cut-off = start of (today − expiry_days) in the tenant timezone: points earned on day E
 * are valid through E + expiry_days. Expiry entries are debits themselves, so a second run on the
 * same day expires nothing (idempotent). Each customer is expired in its own short transaction
 * with the customer row locked (core/loyalty expirePoints), so concurrent sales are never blocked
 * for long and never see a negative balance.
 */
import { addDays, readSettings, startOfDayInstant, todayIn } from '@kadai/shared'
import { sql } from 'kysely'
import { type RequestContext, systemContext } from '../../core/context'
import { expirePoints } from '../../core/loyalty'
import { tenantCalendar } from '../../core/numbering'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import { type Tx, withTenant } from '../../db/tenant'

export const LOYALTY_EXPIRY_JOB = 'parties.loyalty-expiry'
export const LOYALTY_EXPIRY_TENANT_JOB = 'parties.loyalty-expiry-tenant'

export interface TenantExpiryResult {
  tenant_id: string
  /** Skipped: loyalty off, no expiry configured or the plan lacks the feature. */
  skipped: boolean
  customers: number
  points: number
}

/** Locks the customer and returns its points that have expired by `cutoff` (FIFO). */
async function expiringPoints(
  tx: Tx,
  ctx: RequestContext,
  customerId: string,
  cutoff: Date,
): Promise<number> {
  const customer = await tx
    .selectFrom('customers')
    .select('loyalty_points')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', customerId)
    .forUpdate()
    .executeTakeFirst()
  if (!customer || customer.loyalty_points <= 0) return 0
  const res = await sql<{ old_credits: number; debits: number }>`
    select coalesce(sum(ll.points) filter (where ll.points > 0 and ll.created_at < ${cutoff}), 0)::bigint
             as old_credits,
           coalesce(-sum(ll.points) filter (where ll.points < 0), 0)::bigint as debits
      from loyalty_ledger ll
     where ll.tenant_id = ${ctx.tenantId} and ll.customer_id = ${customerId}`.execute(tx)
  const r = res.rows[0]
  const due = Number(r?.old_credits ?? 0) - Number(r?.debits ?? 0)
  return Math.max(0, Math.min(due, customer.loyalty_points))
}

/**
 * Expires the points of one tenant as of `today` (default: today in the tenant timezone).
 * Exported for the job handler, the CLI and tests.
 */
export async function expireTenantLoyalty(
  deps: Pick<KadaiDeps, 'db' | 'entitlements'>,
  tenantId: string,
  opts: { today?: string } = {},
): Promise<TenantExpiryResult> {
  const ctx = systemContext(tenantId)
  const ent = await deps.entitlements.get(tenantId)
  const skipped: TenantExpiryResult = {
    tenant_id: tenantId,
    skipped: true,
    customers: 0,
    points: 0,
  }
  if (!ent.features.has('loyalty')) return skipped

  const plan = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const settings = (await getSettings(tx, ctx)).loyalty
    if (!settings.enabled || settings.expiry_days === null) return null
    const cal = await tenantCalendar(tx, ctx)
    const today = opts.today ?? todayIn(cal.timezone)
    const cutoff = startOfDayInstant(addDays(today, -settings.expiry_days), cal.timezone)
    const candidates = await tx
      .selectFrom('customers as c')
      .select('c.id')
      .where('c.tenant_id', '=', tenantId)
      .where('c.loyalty_points', '>', 0)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('loyalty_ledger as ll')
            .select('ll.id')
            .whereRef('ll.tenant_id', '=', 'c.tenant_id')
            .whereRef('ll.customer_id', '=', 'c.id')
            .where('ll.points', '>', 0)
            .where('ll.created_at', '<', cutoff),
        ),
      )
      .orderBy('c.id')
      .execute()
    return { cutoff, days: settings.expiry_days, ids: candidates.map((c) => c.id) }
  })
  if (!plan) return skipped

  let customers = 0
  let points = 0
  for (const customerId of plan.ids) {
    const expired = await withTenant(deps.db.appDb, ctx, async (tx) => {
      const n = await expiringPoints(tx, ctx, customerId, plan.cutoff)
      if (n <= 0) return 0
      const res = await expirePoints(tx, ctx, {
        customer_id: customerId,
        points: n,
        notes: `Points older than ${plan.days} days expired`,
      })
      return -res.points
    })
    if (expired > 0) {
      customers += 1
      points += expired
    }
  }
  return { tenant_id: tenantId, skipped: false, customers, points }
}

/**
 * Tenants that may have points to expire: active, loyalty enabled with an expiry period.
 * systemDb: cross-tenant fan-out of a cron job (ARCHITECTURE.md §6.1, §14); only tenant ids and
 * settings are read here, the expiry itself runs per tenant under RLS.
 */
export async function loyaltyExpiryTenants(deps: Pick<KadaiDeps, 'db'>): Promise<string[]> {
  const rows = await deps.db.systemDb
    .selectFrom('tenants')
    .select(['id', 'settings'])
    .where('status', '=', 'active')
    .where(sql<boolean>`(settings -> 'loyalty' ->> 'enabled') = 'true'`)
    .where(sql<boolean>`(settings -> 'loyalty' ->> 'expiry_days') is not null`)
    .orderBy('id')
    .execute()
  return rows
    .filter((r) => {
      const loyalty = readSettings(r.settings).loyalty
      return loyalty.enabled && loyalty.expiry_days !== null
    })
    .map((r) => r.id)
}
