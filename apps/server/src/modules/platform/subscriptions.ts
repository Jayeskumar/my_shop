/**
 * Tenant subscriptions (cloud): reading the live row, the SubscriptionView DTO and the writers
 * every plan change goes through (tenants.plan_code + entitlements invalidation). Functions take
 * any transaction — a tenant transaction (RLS) from the routes and jobs, or the system
 * transaction of the Razorpay webhook.
 */
import { type BillingCycle, BillingCycleSchema, type SubscriptionStatus, SubscriptionStatusSchema } from '@kadai/shared'
import { CLOUD_PLAN_NAMES, type SubscriptionView, daysLeft } from '@kadai/shared/api/platform'
import type { EntitlementsService } from '../../core/entitlements'
import { notifyEntitlementsChanged } from '../../core/entitlements'
import { type Tx, afterCommit } from '../../db/tenant'
import { iso } from './util'

/** The plan a tenant falls back to when nothing is paid (data is kept). */
export const FREE_PLAN = 'free'
export const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const

export interface SubscriptionRow {
  id: string
  tenant_id: string
  plan_code: string
  status: SubscriptionStatus
  billing_cycle: BillingCycle
  current_period_start: Date
  current_period_end: Date
  trial_ends_at: Date | null
  cancel_at_period_end: boolean
  provider: 'razorpay' | 'manual' | null
  provider_subscription_id: string | null
  past_due_since: Date | null
  cancel_requested_at: Date | null
  ended_at: Date | null
  created_at: Date
}

const COLUMNS = [
  'id',
  'tenant_id',
  'plan_code',
  'status',
  'billing_cycle',
  'current_period_start',
  'current_period_end',
  'trial_ends_at',
  'cancel_at_period_end',
  'provider',
  'provider_subscription_id',
  'past_due_since',
  'cancel_requested_at',
  'ended_at',
  'created_at',
] as const

function baseQuery(tx: Tx) {
  return tx.selectFrom('subscriptions').select([...COLUMNS])
}
type RawRow = Awaited<ReturnType<ReturnType<typeof baseQuery>['executeTakeFirstOrThrow']>>

function toRow(r: RawRow): SubscriptionRow {
  return {
    ...r,
    status: SubscriptionStatusSchema.parse(r.status),
    billing_cycle: BillingCycleSchema.parse(r.billing_cycle),
    provider: r.provider === 'razorpay' || r.provider === 'manual' ? r.provider : null,
  }
}

/** The tenant's live subscription (trialing / active / past_due), optionally locked. */
export async function loadLiveSubscription(
  tx: Tx,
  tenantId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<SubscriptionRow | null> {
  let q = baseQuery(tx)
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', [...LIVE_STATUSES])
    .orderBy('created_at', 'desc')
    .limit(1)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  return row ? toRow(row) : null
}

/** Live subscription, else the most recent one (ended trial / cancelled / expired). */
export async function loadCurrentSubscription(tx: Tx, tenantId: string): Promise<SubscriptionRow | null> {
  const live = await loadLiveSubscription(tx, tenantId)
  if (live) return live
  const row = await baseQuery(tx)
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ? toRow(row) : null
}

export async function loadSubscriptionByProviderId(
  tx: Tx,
  providerSubscriptionId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<SubscriptionRow | null> {
  let q = baseQuery(tx)
    .where('provider_subscription_id', '=', providerSubscriptionId)
    .orderBy('created_at', 'desc')
    .limit(1)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  return row ? toRow(row) : null
}

/** End of what the tenant has right now: trial end while trialing, else the period end. */
export function effectiveEnd(sub: Pick<SubscriptionRow, 'status' | 'trial_ends_at' | 'current_period_end'>): Date {
  return sub.status === 'trialing' ? (sub.trial_ends_at ?? sub.current_period_end) : sub.current_period_end
}

export function subscriptionView(
  sub: SubscriptionRow,
  plan: { name: string; name_ta: string | null } | null,
  now: Date,
): SubscriptionView {
  const names = plan ?? {
    name: CLOUD_PLAN_NAMES[sub.plan_code]?.en ?? sub.plan_code,
    name_ta: CLOUD_PLAN_NAMES[sub.plan_code]?.ta ?? null,
  }
  const live = (LIVE_STATUSES as readonly string[]).includes(sub.status)
  return {
    id: sub.id,
    plan_code: sub.plan_code,
    plan_name: names.name,
    plan_name_ta: names.name_ta,
    status: sub.status,
    billing_cycle: sub.billing_cycle,
    current_period_start: iso(sub.current_period_start),
    current_period_end: iso(sub.current_period_end),
    trial_ends_at: iso(sub.trial_ends_at),
    cancel_at_period_end: sub.cancel_at_period_end,
    provider: sub.provider,
    auto_renew: sub.provider_subscription_id !== null && !sub.cancel_at_period_end,
    days_left: live ? daysLeft(effectiveEnd(sub), now) : null,
  }
}

/**
 * Sets the plan in force (tenants.plan_code — what entitlements fall back to without a live
 * subscription) and invalidates cached entitlements in every process (NOTIFY in the same
 * transaction) and immediately in this one after COMMIT.
 */
export async function setTenantPlan(
  tx: Tx,
  entitlements: Pick<EntitlementsService, 'invalidate'>,
  tenantId: string,
  planCode: string,
): Promise<void> {
  await tx
    .updateTable('tenants')
    .set({ plan_code: planCode })
    .where('id', '=', tenantId)
    .where('plan_code', '<>', planCode)
    .execute()
  await entitlementsChanged(tx, entitlements, tenantId)
}

export async function entitlementsChanged(
  tx: Tx,
  entitlements: Pick<EntitlementsService, 'invalidate'>,
  tenantId: string,
): Promise<void> {
  await notifyEntitlementsChanged(tx, tenantId)
  afterCommit(tx, () => entitlements.invalidate(tenantId))
}

export interface ActivateInput {
  tenant_id: string
  plan_code: string
  billing_cycle: BillingCycle
  period_start: Date
  period_end: Date
  provider: 'razorpay' | 'manual'
  /** Razorpay subscription (monthly auto-renew); null for prepaid. */
  provider_subscription_id: string | null
  /**
   * Keep a pending "cancel at period end" request (a charge of the same Razorpay subscription
   * after the owner asked to cancel at cycle end).
   */
  keep_cancel_request?: boolean
}

/**
 * Makes `input` the tenant's live, active subscription: updates the live row in place (one live
 * subscription per tenant — subscriptions_one_live_idx) or inserts one. Returns its id.
 */
export async function activateSubscription(tx: Tx, input: ActivateInput): Promise<string> {
  const live = await loadLiveSubscription(tx, input.tenant_id, { forUpdate: true })
  const base = {
    plan_code: input.plan_code,
    status: 'active' as const,
    billing_cycle: input.billing_cycle,
    current_period_start: input.period_start,
    current_period_end: input.period_end,
    provider: input.provider,
    provider_subscription_id: input.provider_subscription_id,
    past_due_since: null,
    ended_at: null,
  }
  const values = input.keep_cancel_request
    ? base
    : {
        ...base,
        cancel_at_period_end: false,
        cancel_requested_at: null,
        cancel_reason: null,
        cancel_feedback: null,
      }
  if (live) {
    await tx.updateTable('subscriptions').set(values).where('id', '=', live.id).execute()
    return live.id
  }
  const row = await tx
    .insertInto('subscriptions')
    .values({ tenant_id: input.tenant_id, ...values })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** Ends a live subscription (cancelled / expired) at `now`. */
export async function endSubscription(
  tx: Tx,
  subscriptionId: string,
  status: 'cancelled' | 'expired',
  now: Date,
): Promise<void> {
  await tx
    .updateTable('subscriptions')
    .set({ status, ended_at: now })
    .where('id', '=', subscriptionId)
    .execute()
}
