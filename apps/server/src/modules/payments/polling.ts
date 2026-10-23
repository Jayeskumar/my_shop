/**
 * Status polling and expiry (jobs payments.poll-intents / payments.expire-intents).
 *
 * Cross-tenant selection of due intents uses the SYSTEM pool (job fan-out across tenants,
 * ARCHITECTURE.md §14) and reads only (id, tenant_id); every claim and state change runs in that
 * tenant's own RLS transaction with systemContext. Provider calls happen outside transactions.
 *
 *  - poll: pending intents of polling-capable providers whose last poll is older than the
 *    backoff for their poll_count (3 s, 5 s, 10 s, then every 30 s). The claim (last_polled_at,
 *    poll_count) is an atomic conditional UPDATE, so concurrent workers never poll one intent
 *    twice in a window. Paid → markIntentPaid (confirmation 'poll'); closed/expired at the
 *    provider → expired.
 *  - expire: open intents past expires_at — a polling provider is asked once more (a payment in
 *    the last second is confirmed, not expired), then the QR / link is closed at the provider and
 *    the intent marked expired. Closes that failed (also after cancel) are retried with a status
 *    check first, so a late payment is still recorded (paid, unapplied → reconciliation).
 */
import { type PaymentProviderCode } from '@kadai/shared'
import { INTENT_POLL_BACKOFF_SECONDS } from '@kadai/shared/api/payments'
import { type RawBuilder, sql } from 'kysely'
import { systemContext } from '../../core/context'
import type { KadaiDeps } from '../../core/runtime'
import { withTenant } from '../../db/tenant'
import { loadAccountRuntime } from './accounts'
import { enqueueSafely } from './common'
import { POLL_JOB, providerIntentOf } from './intents'
import { markIntentPaid, noteIntentFailure, notifyIntent } from './mark-paid'
import { POLLING_PROVIDER_CODES, getProvider, isPollingProvider } from './providers'

type JobDeps = Pick<KadaiDeps, 'config' | 'crypto' | 'db' | 'logger' | 'metrics'>

/** Close attempts after which the expire job gives up (the provider closes QRs at close_by). */
export const MAX_CLOSE_ATTEMPTS = 5

/** SQL: the backoff interval (seconds) for `i.poll_count`. */
function backoffSql(): RawBuilder<number> {
  const steps = INTENT_POLL_BACKOFF_SECONDS
  const cases = steps
    .slice(0, -1)
    .map((s, i) => `when ${i} then ${s}`)
    .join(' ')
  return sql<number>`(case least(i.poll_count, ${sql.raw(String(steps.length - 1))}) ${sql.raw(cases)} else ${sql.raw(String(steps[steps.length - 1]))} end)`
}

const duePredicate = () =>
  sql<boolean>`coalesce(i.last_polled_at, i.created_at) <= now() - make_interval(secs => ${backoffSql()})`

/** Concurrent provider calls of one job run (each in its own tenant transaction). */
export const POLL_CONCURRENCY = 8
/** Time budget of one poll run: it must finish before the next 15 s tick. */
export const POLL_BUDGET_MS = 12_000
/** Time budget of one expire run (cron every minute). */
export const EXPIRE_BUDGET_MS = 45_000

/**
 * Runs `fn` over `items` with bounded concurrency and stops starting new items after the
 * deadline (a provider outage — 8 s timeouts — must not make one run last for minutes; the rest
 * stays due for the next run).
 */
async function runBounded<T>(
  items: readonly T[],
  opts: { concurrency: number; budgetMs: number },
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + opts.budgetMs
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length && Date.now() < deadline) {
      const item = items[next++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, items.length) }, worker))
}

export type PollOutcome = 'skipped' | 'pending' | 'paid' | 'closed' | 'error'

/** Polls one intent if it is (still) due. */
export async function pollIntent(
  deps: JobDeps,
  tenantId: string,
  intentId: string,
): Promise<PollOutcome> {
  const ctx = systemContext(tenantId, { requestId: `poll:${intentId}` })
  const claim = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const row = await sql<{
      id: string
      tenant_id: string
      kind: string
      purpose: string
      reference_code: string
      amount_paise: number
      provider_ref: string | null
      provider: string
      provider_account_id: string
      created_at: Date
      expires_at: Date | null
      metadata: unknown
    }>`
      update payment_intents i
         set last_polled_at = now(), poll_count = i.poll_count + 1
       where i.tenant_id = ${tenantId} and i.id = ${intentId} and i.status = 'pending'
         and i.provider_ref is not null and ${duePredicate()}
      returning i.id, i.tenant_id, i.kind, i.purpose, i.reference_code, i.amount_paise, i.provider_ref,
                i.provider, i.provider_account_id, i.created_at, i.expires_at, i.metadata`.execute(
      tx,
    )
    const intent = row.rows[0]
    if (!intent) return null
    const account = await loadAccountRuntime(deps, tx, ctx, intent.provider_account_id)
    return { intent, account }
  })
  if (!claim) return 'skipped'
  const code = claim.intent.provider as PaymentProviderCode
  if (!isPollingProvider(code)) return 'skipped'
  let status
  try {
    status = await getProvider(code, deps).fetchStatus(
      claim.account,
      providerIntentOf(claim.intent),
    )
  } catch (err) {
    deps.logger.warn({ err, intent_id: intentId }, 'payment intent poll failed')
    return 'error'
  }
  switch (status.status) {
    case 'paid':
      await withTenant(deps.db.appDb, ctx, (tx) =>
        markIntentPaid(
          tx,
          ctx,
          { intent_id: intentId, confirmation: 'poll', payment: status },
          { metrics: deps.metrics },
        ),
      )
      return 'paid'
    case 'expired':
    case 'cancelled':
      await withTenant(deps.db.appDb, ctx, async (tx) => {
        const r = await tx
          .updateTable('payment_intents')
          .set({ status: 'expired', provider_closed_at: new Date() })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', intentId)
          .where('status', 'in', ['created', 'pending'])
          .returning('provider')
          .executeTakeFirst()
        if (r) {
          await notifyIntent(tx, tenantId, intentId, 'expired')
          deps.metrics.paymentIntents.inc({ provider: r.provider, status: 'expired' })
        }
      })
      return 'closed'
    case 'failed':
      await withTenant(deps.db.appDb, ctx, (tx) =>
        noteIntentFailure(tx, ctx, intentId, status.reason),
      )
      return 'pending'
    default:
      return 'pending'
  }
}

/** One run of payments.poll-intents; re-schedules itself while polls are due soon. */
export async function pollDueIntents(
  deps: JobDeps,
  opts: { limit?: number; reschedule?: boolean; budgetMs?: number } = {},
): Promise<Record<PollOutcome, number>> {
  const counts: Record<PollOutcome, number> = {
    skipped: 0,
    pending: 0,
    paid: 0,
    closed: 0,
    error: 0,
  }
  const due = await sql<{ id: string; tenant_id: string }>`
    select i.id, i.tenant_id from payment_intents i
     where i.status = 'pending' and i.provider = any(${[...POLLING_PROVIDER_CODES]}::text[])
       and i.provider_ref is not null and ${duePredicate()}
     order by coalesce(i.last_polled_at, i.created_at)
     limit ${opts.limit ?? 200}`.execute(deps.db.systemDb)
  await runBounded(
    due.rows,
    { concurrency: POLL_CONCURRENCY, budgetMs: opts.budgetMs ?? POLL_BUDGET_MS },
    async (r) => {
      try {
        counts[await pollIntent(deps, r.tenant_id, r.id)]++
      } catch (err) {
        counts.error++
        deps.logger.error({ err, intent_id: r.id }, 'payment intent poll crashed')
      }
    },
  )
  if (opts.reschedule !== false) {
    const next = await sql<{ secs: number | null }>`
      select ceil(extract(epoch from min(coalesce(i.last_polled_at, i.created_at) + make_interval(secs => ${backoffSql()})) - now()))::int as secs
        from payment_intents i
       where i.status = 'pending' and i.provider = any(${[...POLLING_PROVIDER_CODES]}::text[])
         and i.provider_ref is not null`.execute(deps.db.systemDb)
    const secs = next.rows[0]?.secs
    // Due within the periodic interval: run again sooner so the 3 s / 5 s / 10 s backoff holds.
    if (secs !== null && secs !== undefined && secs < 15) {
      await enqueueSafely(
        deps.logger,
        POLL_JOB,
        {},
        {
          startAfter: Math.max(3, secs),
          singletonKey: `${POLL_JOB}:soon`,
          singletonSeconds: 3,
        },
      )
    }
  }
  return counts
}

export type ExpireOutcome = 'skipped' | 'paid' | 'expired'

/** Expires one open intent past expires_at (after a last status check). */
export async function expireIntent(
  deps: JobDeps,
  tenantId: string,
  intentId: string,
): Promise<ExpireOutcome> {
  const ctx = systemContext(tenantId, { requestId: `expire:${intentId}` })
  const first = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const row = await tx
      .selectFrom('payment_intents')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', intentId)
      .where('status', 'in', ['created', 'pending'])
      .where('expires_at', '<=', new Date())
      .executeTakeFirst()
    if (!row) return null
    const account = row.provider_ref
      ? await loadAccountRuntime(deps, tx, ctx, row.provider_account_id)
      : null
    return { row, account }
  })
  if (!first) return 'skipped'
  const code = first.row.provider as PaymentProviderCode
  let closed = first.row.provider_ref === null
  if (first.account && first.row.provider_ref) {
    const adapter = getProvider(code, deps)
    const intent = providerIntentOf(first.row)
    if (adapter.capabilities.polling) {
      const status = await adapter.fetchStatus(first.account, intent).catch((err: unknown) => {
        deps.logger.warn({ err, intent_id: intentId }, 'status check before expiry failed')
        return null
      })
      if (status?.status === 'paid') {
        await withTenant(deps.db.appDb, ctx, (tx) =>
          markIntentPaid(
            tx,
            ctx,
            { intent_id: intentId, confirmation: 'poll', payment: status },
            { metrics: deps.metrics },
          ),
        )
        return 'paid'
      }
    }
    try {
      await adapter.cancel(first.account, intent)
      closed = true
    } catch (err) {
      deps.logger.warn(
        { err, intent_id: intentId },
        'closing an expired QR at the provider failed (will retry)',
      )
    }
  }
  const expired = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const r = await tx
      .updateTable('payment_intents')
      .set((eb) => ({
        status: 'expired',
        provider_closed_at: first.row.provider_ref && closed ? new Date() : null,
        close_attempts: closed ? eb.ref('close_attempts') : eb('close_attempts', '+', 1),
      }))
      .where('tenant_id', '=', tenantId)
      .where('id', '=', intentId)
      .where('status', 'in', ['created', 'pending'])
      .returning('id')
      .executeTakeFirst()
    if (r) await notifyIntent(tx, tenantId, intentId, 'expired')
    return Boolean(r)
  })
  if (expired) deps.metrics.paymentIntents.inc({ provider: code, status: 'expired' })
  return expired ? 'expired' : 'skipped'
}

/** Retries closing a cancelled / expired intent at the provider (late payments are recorded). */
export async function retryClose(
  deps: JobDeps,
  tenantId: string,
  intentId: string,
): Promise<'closed' | 'paid' | 'failed' | 'skipped'> {
  const ctx = systemContext(tenantId, { requestId: `close:${intentId}` })
  const first = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const row = await tx
      .selectFrom('payment_intents')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', intentId)
      .where('status', 'in', ['expired', 'cancelled'])
      .where('provider_ref', 'is not', null)
      .where('provider_closed_at', 'is', null)
      .executeTakeFirst()
    if (!row) return null
    return { row, account: await loadAccountRuntime(deps, tx, ctx, row.provider_account_id) }
  })
  if (!first) return 'skipped'
  const adapter = getProvider(first.row.provider as PaymentProviderCode, deps)
  const intent = providerIntentOf(first.row)
  const setClosed = (attemptFailed: boolean) =>
    withTenant(deps.db.appDb, ctx, (tx) =>
      tx
        .updateTable('payment_intents')
        .set((eb) =>
          attemptFailed
            ? { close_attempts: eb('close_attempts', '+', 1) }
            : { provider_closed_at: new Date() },
        )
        .where('tenant_id', '=', tenantId)
        .where('id', '=', intentId)
        .execute(),
    )
  if (adapter.capabilities.polling) {
    const status = await adapter.fetchStatus(first.account, intent).catch(() => null)
    if (status?.status === 'paid') {
      await withTenant(deps.db.appDb, ctx, (tx) =>
        markIntentPaid(
          tx,
          ctx,
          { intent_id: intentId, confirmation: 'poll', payment: status },
          { metrics: deps.metrics },
        ),
      )
      await setClosed(false)
      return 'paid'
    }
  }
  try {
    await adapter.cancel(first.account, intent)
    await setClosed(false)
    return 'closed'
  } catch (err) {
    deps.logger.warn({ err, intent_id: intentId }, 'closing a QR at the provider failed again')
    await setClosed(true)
    return 'failed'
  }
}

/** One run of payments.expire-intents. */
export async function expireDueIntents(
  deps: JobDeps,
  opts: { limit?: number; budgetMs?: number } = {},
): Promise<{ expired: number; paid: number; closed: number; close_failed: number }> {
  const out = { expired: 0, paid: 0, closed: 0, close_failed: 0 }
  const due = await deps.db.systemDb
    .selectFrom('payment_intents')
    .select(['id', 'tenant_id'])
    .where('status', 'in', ['created', 'pending'])
    .where('expires_at', '<=', new Date())
    .orderBy('expires_at')
    .limit(opts.limit ?? 200)
    .execute()
  const budget = { concurrency: 4, budgetMs: opts.budgetMs ?? EXPIRE_BUDGET_MS }
  await runBounded(due, budget, async (row) => {
    try {
      const r = await expireIntent(deps, row.tenant_id, row.id)
      if (r === 'expired') out.expired++
      if (r === 'paid') out.paid++
    } catch (err) {
      deps.logger.error({ err, intent_id: row.id }, 'payment intent expiry failed')
    }
  })
  const unclosed = await deps.db.systemDb
    .selectFrom('payment_intents')
    .select(['id', 'tenant_id'])
    .where('status', 'in', ['expired', 'cancelled'])
    .where('provider_ref', 'is not', null)
    .where('provider_closed_at', 'is', null)
    .where('close_attempts', '<', MAX_CLOSE_ATTEMPTS)
    .where('updated_at', '<', new Date(Date.now() - 60_000))
    .orderBy('updated_at')
    .limit(opts.limit ?? 100)
    .execute()
  await runBounded(unclosed, budget, async (row) => {
    try {
      const r = await retryClose(deps, row.tenant_id, row.id)
      if (r === 'closed') out.closed++
      if (r === 'paid') out.paid++
      if (r === 'failed') out.close_failed++
    } catch (err) {
      deps.logger.error({ err, intent_id: row.id }, 'payment intent close retry failed')
    }
  })
  return out
}
