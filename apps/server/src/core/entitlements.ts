/**
 * Entitlements & plan limits (ARCHITECTURE.md §2, §7.6).
 *
 * cloud  — live subscription (trialing/active/past_due within its period) → its plan, else
 *          tenants.plan_code; features/limits from `plans`, then subscriptions.limit_overrides.
 * onprem — the signed license in system_settings: plan features (or the license's own list),
 *          limits from the plan overridden by the license and `max_stores`.
 *            no license            → Free plan (evaluation), writable
 *            expired / not yet     → Free plan, writable (data is never locked away)
 *            tampered / foreign    → Free plan and READ-ONLY (writes get 403 LICENSE_INVALID)
 *
 * Results are cached per tenant for 60 s (invalidate() after plan/subscription/license changes;
 * cross-process via NOTIFY kadai_cache {scope:'entitlements'}).
 *
 * Module code uses the free functions getEntitlements / assertFeature / assertWithinLimit /
 * incrementUsage, which delegate to the process-wide service installed by buildApp / the worker
 * (setEntitlementsService).
 */
import { type Kysely, sql } from 'kysely'
import {
  DEFAULT_LICENSE_PLAN,
  DEFAULT_PLAN_FEATURES,
  DEFAULT_PLAN_LIMITS,
  type Entitlements,
  type Feature,
  LIMIT_METRICS,
  type LimitMetric,
  type PlanCode,
  type PlanLimits,
  PLAN_CODES,
  isFeature,
  periodOf,
  todayIn,
} from '@kadai/shared'
import type { Config } from '../config'
import type { DB } from '../db/schema.generated'
import type { Tx } from '../db/tenant'
import { TtlCache } from './cache'
import type { RequestContext } from './context'
import { AppError, featureNotInPlan, planLimitReached } from './errors'
import { CHANNELS, type EventBus, notify } from './events'
import {
  type LicenseFailure,
  type LicensePayload,
  getInstallationId,
  loadStoredLicense,
  trustedLicenseKeys,
  verifyLicense,
} from './license'

export type LicenseStatus = 'valid' | 'missing' | LicenseFailure

export interface ResolvedEntitlements {
  plan_code: string
  features: ReadonlySet<Feature>
  limits: PlanLimits
  source: 'plan' | 'license'
  /** Subscription period end / license expiry (ISO), null when unbounded. */
  valid_until: string | null
  /** On-prem with a tampered / foreign license: reject every write. */
  read_only: boolean
  /** On-prem only. */
  license_status?: LicenseStatus
  license?: LicensePayload
}

/** Shape for API responses (/me, billing) — @kadai/shared EntitlementsSchema. */
export function toEntitlementsDto(e: ResolvedEntitlements): Entitlements {
  return {
    plan_code: e.plan_code,
    features: [...e.features].sort(),
    limits: { ...e.limits },
    source: e.source,
    valid_until: e.valid_until,
  }
}

function isPlanCode(code: string): code is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(code)
}

/** Reads a plans.limits / limit_overrides JSON leniently into PlanLimits. */
function readLimits(raw: unknown, base: PlanLimits): PlanLimits {
  const out: PlanLimits = { ...base }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const metric of LIMIT_METRICS) {
      if (!Object.hasOwn(raw, metric)) continue
      const v = (raw as Record<string, unknown>)[metric]
      if (v === null) out[metric] = null
      else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[metric] = v
    }
  }
  return out
}

const UNLIMITED: PlanLimits = { stores: null, users: null, registers: null, products: null, invoices_per_month: null }
const ZERO_LIMITS: PlanLimits = { stores: 0, users: 0, registers: 0, products: 0, invoices_per_month: 0 }

/** usage_counters.metric used for a limit (only invoices are counted, the rest are row counts). */
export const USAGE_METRIC_FOR_LIMIT: Partial<Record<LimitMetric, string>> = { invoices_per_month: 'invoices' }

export interface EntitlementsServiceOptions {
  config: Pick<Config, 'mode' | 'isProduction' | 'licensePublicKey'>
  systemDb: Kysely<DB>
  ttlMs?: number
  /** Business "today" for license validity (tests). */
  today?: () => string
}

interface PlanRow {
  code: string
  features: string[]
  limits: unknown
}

export class EntitlementsService {
  private readonly cache: TtlCache<ResolvedEntitlements>
  private readonly licenseCache: TtlCache<ResolvedEntitlements>

  constructor(private readonly opts: EntitlementsServiceOptions) {
    this.cache = new TtlCache(opts.ttlMs ?? 60_000)
    this.licenseCache = new TtlCache(opts.ttlMs ?? 60_000)
  }

  get(tenantId: string): Promise<ResolvedEntitlements> {
    if (this.opts.config.mode === 'onprem') return this.licenseCache.getOrLoad('license', () => this.loadLicense())
    return this.cache.getOrLoad(tenantId, () => this.loadCloud(tenantId))
  }

  invalidate(tenantId?: string): void {
    this.licenseCache.clear()
    if (tenantId) this.cache.delete(tenantId)
    else this.cache.clear()
  }

  listen(events: EventBus): () => void {
    return events.subscribe(CHANNELS.cache, (payload) => {
      if (typeof payload !== 'object' || payload === null) return
      const p = payload as Record<string, unknown>
      if (p.scope !== 'entitlements') return
      this.invalidate(typeof p.tenant_id === 'string' ? p.tenant_id : undefined)
    })
  }

  private async plan(code: string): Promise<PlanRow | null> {
    const row = await this.opts.systemDb
      .selectFrom('plans')
      .select(['code', 'features', 'limits'])
      .where('code', '=', code)
      .executeTakeFirst()
    return row ?? null
  }

  private planFallback(code: string): PlanRow {
    const known = isPlanCode(code) ? code : 'free'
    return { code: known, features: [...DEFAULT_PLAN_FEATURES[known]], limits: DEFAULT_PLAN_LIMITS[known] }
  }

  private async loadCloud(tenantId: string): Promise<ResolvedEntitlements> {
    const db = this.opts.systemDb
    const tenant = await db.selectFrom('tenants').select(['plan_code']).where('id', '=', tenantId).executeTakeFirst()
    if (!tenant) throw new AppError('NOT_FOUND', 'Tenant not found', { entity: 'tenant', id: tenantId })
    const now = new Date()
    const sub = await db
      .selectFrom('subscriptions')
      .select(['plan_code', 'status', 'current_period_end', 'trial_ends_at', 'limit_overrides'])
      .where('tenant_id', '=', tenantId)
      .where('status', 'in', ['trialing', 'active', 'past_due'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst()
    // A live subscription counts until its period (or trial) ends; the renewals job moves it to
    // expired, this only guards against a late job run.
    const subEnd = sub ? (sub.status === 'trialing' ? (sub.trial_ends_at ?? sub.current_period_end) : sub.current_period_end) : null
    const live = sub && subEnd && subEnd.getTime() > now.getTime() ? sub : null
    const planCode = live?.plan_code ?? tenant.plan_code
    const plan = (await this.plan(planCode)) ?? this.planFallback(planCode)
    const base = readLimits(plan.limits, ZERO_LIMITS)
    return {
      plan_code: plan.code,
      features: new Set(plan.features.filter(isFeature)),
      limits: live ? readLimits(live.limit_overrides, base) : base,
      source: 'plan',
      valid_until: live && subEnd ? subEnd.toISOString() : null,
      read_only: false,
    }
  }

  private async loadLicense(): Promise<ResolvedEntitlements> {
    const db = this.opts.systemDb
    const doc = await loadStoredLicense(db)
    const free = async (status: LicenseStatus, readOnly: boolean, license?: LicensePayload): Promise<ResolvedEntitlements> => {
      const plan = (await this.plan('free')) ?? this.planFallback('free')
      return {
        plan_code: plan.code,
        features: new Set(plan.features.filter(isFeature)),
        limits: readLimits(plan.limits, DEFAULT_PLAN_LIMITS.free),
        source: 'license',
        valid_until: null,
        read_only: readOnly,
        license_status: status,
        license,
      }
    }
    if (doc === null) return free('missing', false)
    const result = verifyLicense(doc, {
      keys: trustedLicenseKeys(this.opts.config.licensePublicKey),
      production: this.opts.config.isProduction,
      today: this.opts.today?.() ?? todayIn('Asia/Kolkata'),
      installationId: await getInstallationId(db),
    })
    if (!result.ok) {
      // Expired / not-yet-valid licenses degrade to Free; anything that smells of tampering
      // (bad signature, foreign key or installation) makes the installation read-only.
      const tampered = result.reason !== 'expired' && result.reason !== 'not_yet_valid'
      return free(result.reason, tampered, result.license)
    }
    const lic = result.license
    const planCode = lic.plan_code || DEFAULT_LICENSE_PLAN
    const plan = (await this.plan(planCode)) ?? this.planFallback(planCode)
    const limits = readLimits(lic.limits ?? {}, readLimits(plan.limits, UNLIMITED))
    limits.stores = lic.max_stores
    return {
      plan_code: plan.code,
      features: new Set((lic.features ?? plan.features).filter(isFeature)),
      limits,
      source: 'license',
      valid_until: lic.valid_until ? `${lic.valid_until}T23:59:59.999+05:30` : null,
      read_only: false,
      license_status: 'valid',
      license: lic,
    }
  }
}

/** Tell every process to drop cached entitlements (call inside the changing transaction). */
export function notifyEntitlementsChanged(tx: Tx | Kysely<DB>, tenantId?: string): Promise<void> {
  return notify(tx, CHANNELS.cache, tenantId ? { scope: 'entitlements', tenant_id: tenantId } : { scope: 'entitlements' })
}

// ---------------------------------------------------------------------------------------------
// Process-wide service + module-facing helpers
// ---------------------------------------------------------------------------------------------

let current: EntitlementsService | null = null

/** Installed by buildApp() and the worker. */
export function setEntitlementsService(service: EntitlementsService | null): void {
  current = service
}

function service(): EntitlementsService {
  if (!current) throw new Error('entitlements service is not initialised (buildApp/startWorker sets it)')
  return current
}

export function getEntitlements(ctx: Pick<RequestContext, 'tenantId'>): Promise<ResolvedEntitlements> {
  return service().get(ctx.tenantId)
}

/** Throws 402 FEATURE_NOT_IN_PLAN when the tenant's plan/license lacks `feature`. */
export async function assertFeature(ctx: Pick<RequestContext, 'tenantId'>, feature: Feature): Promise<void> {
  const ent = await getEntitlements(ctx)
  if (!ent.features.has(feature)) throw featureNotInPlan(feature, ent.plan_code)
}

/** Current count for a limit metric, read inside the tenant transaction. */
export async function countForLimit(tx: Tx, ctx: Pick<RequestContext, 'tenantId'>, metric: LimitMetric, tz = 'Asia/Kolkata'): Promise<number> {
  const t = ctx.tenantId
  switch (metric) {
    case 'stores': {
      const r = await tx.selectFrom('stores').select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', t).where('is_active', '=', true).executeTakeFirstOrThrow()
      return Number(r.n)
    }
    case 'users': {
      const r = await tx.selectFrom('memberships').select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', t).where('status', 'in', ['active', 'invited']).executeTakeFirstOrThrow()
      return Number(r.n)
    }
    case 'registers': {
      const r = await tx.selectFrom('registers').select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', t).where('is_active', '=', true).executeTakeFirstOrThrow()
      return Number(r.n)
    }
    case 'products': {
      const r = await tx
        .selectFrom('products')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('tenant_id', '=', t)
        .where('is_active', '=', true)
        .where('kind', '<>', 'variant_parent')
        .executeTakeFirstOrThrow()
      return Number(r.n)
    }
    case 'invoices_per_month': {
      const r = await tx
        .selectFrom('usage_counters')
        .select('value')
        .where('tenant_id', '=', t)
        .where('metric', '=', 'invoices')
        .where('period', '=', periodOf(todayIn(tz)))
        .executeTakeFirst()
      return r?.value ?? 0
    }
  }
}

/**
 * Throws 402 PLAN_LIMIT_REACHED when adding `adding` more of `metric` would exceed the limit.
 * Takes a transaction-scoped advisory lock per (tenant, metric) before counting so concurrent
 * creates cannot both slip under the limit; call it in the same transaction as the insert.
 */
export async function assertWithinLimit(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  metric: LimitMetric,
  opts: { adding?: number } = {},
): Promise<void> {
  const ent = await getEntitlements(ctx)
  const limit = ent.limits[metric]
  if (limit === null) return
  await sql`select pg_advisory_xact_lock(hashtextextended(${`kadai_limit:${ctx.tenantId}:${metric}`}, 0))`.execute(tx)
  const current = await countForLimit(tx, ctx, metric)
  if (current + (opts.adding ?? 1) > limit) throw planLimitReached(metric, limit, current, ent.plan_code)
}

/**
 * Atomically increments a usage counter for the tenant's current month (IST) and returns the new
 * value. With `enforce` (default true) for 'invoices', exceeding invoices_per_month throws 402
 * PLAN_LIMIT_REACHED and the surrounding transaction rolls the increment back. Offline-synced
 * invoices (already printed) pass `enforce: false`.
 */
export async function incrementUsage(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  /** usage_counters.metric: 'invoices', 'sms', 'whatsapp', … */
  metric: string,
  opts: { by?: number; enforce?: boolean; period?: string } = {},
): Promise<number> {
  const by = opts.by ?? 1
  const period = opts.period ?? periodOf(todayIn('Asia/Kolkata'))
  const row = await tx
    .insertInto('usage_counters')
    .values({ tenant_id: ctx.tenantId, metric, period, value: by })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'metric', 'period']).doUpdateSet((eb) => ({
        value: eb('usage_counters.value', '+', by),
        updated_at: sql<Date>`now()`,
      })),
    )
    .returning('value')
    .executeTakeFirstOrThrow()
  if (metric === 'invoices' && (opts.enforce ?? true)) {
    const ent = await getEntitlements(ctx)
    const limit = ent.limits.invoices_per_month
    if (limit !== null && row.value > limit) {
      throw planLimitReached('invoices_per_month', limit, row.value - by, ent.plan_code)
    }
  }
  return row.value
}
