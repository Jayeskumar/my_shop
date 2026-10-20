/**
 * Loyalty points posting (docs/API.md "parties"; feature `loyalty`) — the ONLY writer of
 * loyalty_ledger and customers.loyalty_points.
 *
 *   await earnPoints(tx, ctx, { customer_id, amount_paise: invoice.total_paise,
 *                               ref_type: 'sales_invoice', ref_id: invoice.id })
 *   await redeemPoints(tx, ctx, { customer_id, points: 120, bill_total_paise,
 *                                 ref_type: 'sales_invoice', ref_id: invoice.id })
 *   await reversePoints(tx, ctx, { customer_id, ref_type: 'sales_invoice', ref_id })  // cancel
 *   await adjustPoints(tx, ctx, { customer_id, points: -20, notes: 'Correction' })    // audited
 *
 * * Every call locks the customer row (SELECT … FOR UPDATE) in the caller's transaction, appends
 *   the ledger row(s) and writes the new balance, so concurrent earn/redeem calls serialise and
 *   Σ loyalty_ledger.points = customers.loyalty_points at all times.
 * * The balance never goes below zero: redemptions and negative adjustments beyond the balance
 *   are 422 UNPROCESSABLE (details.reason = a parties validation key); reversals of points that
 *   were already spent are clamped and report `shortfall_points`. The DB CHECK is the backstop.
 * * Points maths comes from settings.loyalty via @kadai/shared/api/parties (same as the POS).
 *   With loyalty disabled, earnPoints records nothing and redeemPoints is refused.
 * * Reversal rows reference the ORIGINAL document (ref_type/ref_id), so what is still reversible
 *   for a document is derived from its ledger rows: earned = Σ earn + Σ negative reverse,
 *   redeemed = −Σ redeem − Σ positive reverse. Repeating a full reversal is a no-op.
 */
import { newId } from '@kadai/shared'
import {
  loyaltyPointsForAmount,
  loyaltyRedeemIssue,
  loyaltyValuePaise,
} from '@kadai/shared/api/parties'
import { sql } from 'kysely'
import type { Tx } from '../db/tenant'
import { audit } from './audit'
import type { RequestContext } from './context'
import { invalidField, notFound, unprocessable } from './errors'
import { getSettings } from './settings'

type Ctx = Pick<RequestContext, 'tenantId' | 'userId'>
type AuditCtx = Pick<RequestContext, 'tenantId' | 'userId' | 'ip' | 'userAgent' | 'requestId'>

/** Largest points value a single call accepts. */
const MAX_POINTS = 1_000_000_000

export interface LoyaltyPosting {
  /** The ledger row written (null when nothing was recorded). */
  entry_id: string | null
  /** Signed change of the balance. */
  points: number
  /** Balance after the call. */
  balance: number
}

export interface EarnPointsInput {
  customer_id: string
  /** Bill amount the points are earned on (settings.loyalty.points_per_100_rupees). */
  amount_paise?: number
  /** Explicit points (e.g. computed by an offline POS); overrides amount_paise. */
  points?: number
  ref_type: string
  ref_id: string
  notes?: string | null
}

export interface RedeemPointsInput {
  customer_id: string
  points: number
  /** Payable amount of the bill: the redemption value may not exceed it. */
  bill_total_paise?: number
  ref_type: string
  ref_id: string
  notes?: string | null
}

export interface ReversePointsInput {
  customer_id: string
  /** The document whose points are reversed (the one passed to earn/redeem). */
  ref_type: string
  ref_id: string
  /** Earned points to take back (default: all still reversible) — e.g. a partial return. */
  earned_points?: number
  /** Redeemed points to give back (default: all still reversible). */
  redeemed_points?: number
  notes?: string | null
}

export interface ReversePointsResult {
  entries: Array<{ entry_id: string; points: number }>
  balance: number
  /** Redeemed points given back. */
  restored_points: number
  /** Earned points taken back. */
  removed_points: number
  /** Earned points that could not be taken back because they were already spent. */
  shortfall_points: number
}

export interface AdjustPointsInput {
  customer_id: string
  /** Signed, non-zero. */
  points: number
  notes: string
}

export interface ExpirePointsInput {
  customer_id: string
  points: number
  notes?: string | null
}

function assertPoints(
  value: number,
  path: string,
  { allowZero = false, signed = false } = {},
): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_POINTS)
    throw invalidField(path, 'Points must be a whole number')
  if (!signed && value < 0) throw invalidField(path, 'Points must not be negative')
  if (!allowZero && value === 0) throw invalidField(path, 'Points must not be zero')
}

/** Locks the customer row and returns its current points balance. */
async function lockCustomer(tx: Tx, ctx: Ctx, customerId: string): Promise<number> {
  const row = await tx
    .selectFrom('customers')
    .select(['id', 'loyalty_points'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', customerId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('customer', customerId)
  return Number(row.loyalty_points)
}

async function writeEntry(
  tx: Tx,
  ctx: Ctx,
  entry: {
    customer_id: string
    points: number
    kind: 'earn' | 'redeem' | 'adjust' | 'expire' | 'reverse'
    ref_type?: string | null
    ref_id?: string | null
    notes?: string | null
  },
): Promise<string> {
  const id = newId()
  await tx
    .insertInto('loyalty_ledger')
    .values({
      id,
      tenant_id: ctx.tenantId,
      customer_id: entry.customer_id,
      points: entry.points,
      kind: entry.kind,
      ref_type: entry.ref_type ?? null,
      ref_id: entry.ref_id ?? null,
      notes: entry.notes?.slice(0, 500) ?? null,
      created_by: ctx.userId,
    })
    .execute()
  return id
}

async function setBalance(tx: Tx, ctx: Ctx, customerId: string, balance: number): Promise<void> {
  await tx
    .updateTable('customers')
    .set({ loyalty_points: balance })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', customerId)
    .execute()
}

/**
 * Credits points for a document. Idempotent per (customer, ref): a second earn for the same
 * document returns the existing entry unchanged (retries / offline sync).
 */
export async function earnPoints(
  tx: Tx,
  ctx: Ctx,
  input: EarnPointsInput,
): Promise<LoyaltyPosting> {
  const settings = (await getSettings(tx, ctx)).loyalty
  const balance = await lockCustomer(tx, ctx, input.customer_id)
  if (!settings.enabled) return { entry_id: null, points: 0, balance }
  let points: number
  if (input.points !== undefined) {
    assertPoints(input.points, 'points', { allowZero: true })
    points = input.points
  } else {
    const amount = input.amount_paise ?? 0
    if (!Number.isSafeInteger(amount)) throw invalidField('amount_paise', 'Invalid amount')
    points = loyaltyPointsForAmount(amount, settings)
  }
  if (points === 0) return { entry_id: null, points: 0, balance }

  const existing = await tx
    .selectFrom('loyalty_ledger')
    .select(['id', 'points'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('customer_id', '=', input.customer_id)
    .where('kind', '=', 'earn')
    .where('ref_type', '=', input.ref_type)
    .where('ref_id', '=', input.ref_id)
    .executeTakeFirst()
  if (existing) return { entry_id: existing.id, points: 0, balance }

  const next = balance + points
  const entryId = await writeEntry(tx, ctx, {
    customer_id: input.customer_id,
    points,
    kind: 'earn',
    ref_type: input.ref_type,
    ref_id: input.ref_id,
    notes: input.notes,
  })
  await setBalance(tx, ctx, input.customer_id, next)
  return { entry_id: entryId, points, balance: next }
}

/**
 * Debits redeemed points (never more than the balance, at least settings.loyalty
 * .min_redeem_points, worth at most `bill_total_paise`). Returns the rupee value of the points.
 */
export async function redeemPoints(
  tx: Tx,
  ctx: Ctx,
  input: RedeemPointsInput,
): Promise<LoyaltyPosting & { value_paise: number }> {
  assertPoints(input.points, 'points')
  const settings = (await getSettings(tx, ctx)).loyalty
  const balance = await lockCustomer(tx, ctx, input.customer_id)
  const issue = loyaltyRedeemIssue({
    points: input.points,
    balance_points: balance,
    settings,
    ...(input.bill_total_paise !== undefined ? { bill_total_paise: input.bill_total_paise } : {}),
  })
  if (issue) {
    throw unprocessable('Loyalty points cannot be redeemed', {
      reason: issue,
      points: input.points,
      balance_points: balance,
      min_redeem_points: settings.min_redeem_points,
    })
  }
  const next = balance - input.points
  const entryId = await writeEntry(tx, ctx, {
    customer_id: input.customer_id,
    points: -input.points,
    kind: 'redeem',
    ref_type: input.ref_type,
    ref_id: input.ref_id,
    notes: input.notes,
  })
  await setBalance(tx, ctx, input.customer_id, next)
  return {
    entry_id: entryId,
    points: -input.points,
    balance: next,
    value_paise: loyaltyValuePaise(input.points, settings),
  }
}

/** What is still reversible for a document: earned and redeemed points net of earlier reversals. */
export async function reversiblePoints(
  tx: Tx,
  ctx: Ctx,
  ref: { customer_id: string; ref_type: string; ref_id: string },
): Promise<{ earned: number; redeemed: number }> {
  const row = await tx
    .selectFrom('loyalty_ledger')
    .select([
      sql<string>`coalesce(sum(points) filter (where kind = 'earn'), 0)`.as('earn'),
      sql<string>`coalesce(sum(points) filter (where kind = 'redeem'), 0)`.as('redeem'),
      sql<string>`coalesce(sum(points) filter (where kind = 'reverse' and points < 0), 0)`.as(
        'rev_neg',
      ),
      sql<string>`coalesce(sum(points) filter (where kind = 'reverse' and points > 0), 0)`.as(
        'rev_pos',
      ),
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('customer_id', '=', ref.customer_id)
    .where('ref_type', '=', ref.ref_type)
    .where('ref_id', '=', ref.ref_id)
    .executeTakeFirstOrThrow()
  return {
    earned: Math.max(0, Number(row.earn) + Number(row.rev_neg)),
    redeemed: Math.max(0, -Number(row.redeem) - Number(row.rev_pos)),
  }
}

/**
 * Reverses a document's points (invoice cancellation, returns): first gives back redeemed
 * points, then takes back earned points — clamped to the balance (the rest is reported as
 * `shortfall_points`). Nothing left to reverse → no rows (a repeated call is a no-op).
 */
export async function reversePoints(
  tx: Tx,
  ctx: Ctx,
  input: ReversePointsInput,
): Promise<ReversePointsResult> {
  if (input.earned_points !== undefined)
    assertPoints(input.earned_points, 'earned_points', { allowZero: true })
  if (input.redeemed_points !== undefined)
    assertPoints(input.redeemed_points, 'redeemed_points', { allowZero: true })
  let balance = await lockCustomer(tx, ctx, input.customer_id)
  const reversible = await reversiblePoints(tx, ctx, input)
  const restore = Math.min(input.redeemed_points ?? reversible.redeemed, reversible.redeemed)
  const wantRemove = Math.min(input.earned_points ?? reversible.earned, reversible.earned)

  const entries: ReversePointsResult['entries'] = []
  const ref = { ref_type: input.ref_type, ref_id: input.ref_id, notes: input.notes }
  if (restore > 0) {
    const id = await writeEntry(tx, ctx, {
      customer_id: input.customer_id,
      points: restore,
      kind: 'reverse',
      ...ref,
    })
    entries.push({ entry_id: id, points: restore })
    balance += restore
  }
  const remove = Math.min(wantRemove, balance)
  if (remove > 0) {
    const id = await writeEntry(tx, ctx, {
      customer_id: input.customer_id,
      points: -remove,
      kind: 'reverse',
      ...ref,
    })
    entries.push({ entry_id: id, points: -remove })
    balance -= remove
  }
  if (entries.length) await setBalance(tx, ctx, input.customer_id, balance)
  return {
    entries,
    balance,
    restored_points: restore,
    removed_points: remove,
    shortfall_points: wantRemove - remove,
  }
}

/**
 * Manual correction (POST /customers/:id/loyalty/adjust). Audited here
 * ('customer.loyalty_adjust'); callers must not audit again. Never below zero (422).
 */
export async function adjustPoints(
  tx: Tx,
  ctx: AuditCtx,
  input: AdjustPointsInput,
): Promise<LoyaltyPosting> {
  assertPoints(input.points, 'points', { signed: true })
  const notes = input.notes?.trim()
  if (!notes) throw invalidField('notes', 'A reason is required')
  const balance = await lockCustomer(tx, ctx, input.customer_id)
  const next = balance + input.points
  if (next < 0) {
    throw unprocessable('Loyalty points cannot go below zero', {
      reason: 'loyalty_insufficient',
      points: input.points,
      balance_points: balance,
    })
  }
  const entryId = await writeEntry(tx, ctx, {
    customer_id: input.customer_id,
    points: input.points,
    kind: 'adjust',
    notes,
  })
  await setBalance(tx, ctx, input.customer_id, next)
  await audit(tx, ctx, {
    action: 'customer.loyalty_adjust',
    entity_type: 'customer',
    entity_id: input.customer_id,
    summary: `Loyalty points ${input.points > 0 ? '+' : ''}${input.points}: ${notes}`.slice(0, 500),
    changes: { before: { loyalty_points: balance }, after: { loyalty_points: next } },
  })
  return { entry_id: entryId, points: input.points, balance: next }
}

/** Expires points (settings.loyalty.expiry_days job): clamped to the balance; 0 → nothing. */
export async function expirePoints(
  tx: Tx,
  ctx: Ctx,
  input: ExpirePointsInput,
): Promise<LoyaltyPosting> {
  assertPoints(input.points, 'points', { allowZero: true })
  const balance = await lockCustomer(tx, ctx, input.customer_id)
  const points = Math.min(input.points, balance)
  if (points === 0) return { entry_id: null, points: 0, balance }
  const entryId = await writeEntry(tx, ctx, {
    customer_id: input.customer_id,
    points: -points,
    kind: 'expire',
    notes: input.notes,
  })
  await setBalance(tx, ctx, input.customer_id, balance - points)
  return { entry_id: entryId, points: -points, balance: balance - points }
}
