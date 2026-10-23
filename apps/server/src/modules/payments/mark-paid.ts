/**
 * markIntentPaid — the ONE transition of a payment intent to `paid` (ARCHITECTURE.md §11.2),
 * used by webhook processing, the poll / expire jobs, manual confirmation and mock-pay.
 *
 *  - The intent row is locked FOR UPDATE: concurrent confirmations (webhook + poll) serialise.
 *  - Already paid with the same provider payment id (or without ids on either side) →
 *    idempotent no-op. Paid with a DIFFERENT provider payment → the extra money is recorded as
 *    a new paid-but-unapplied intent (`failure_reason 'duplicate_payment'`,
 *    `metadata.duplicate_of`) so it shows up in reconciliation for refund / apply.
 *  - Amount check: a different amount is still recorded as paid (the money arrived) with
 *    `failure_reason 'amount_mismatch: …'`; core recordPayment refuses to consume it for the
 *    original amount, so it lands in reconciliation (unapplied). Dues links are not
 *    auto-applied in that case either.
 *  - Late payments (after expiry / cancel / failure) are recorded the same way
 *    (`late_payment: …`).
 *  - Payment-link intents (kind 'link', purpose customer_due) paid with the exact amount are
 *    applied at once (also when the payment came after expiry): a receipt for the customer
 *    allocated FIFO to their oldest dues (rest = advance). That step runs in a savepoint: if it
 *    fails the intent stays paid and unapplied (with a note) instead of losing the confirmation.
 *  - NOTIFY kadai_payment_intents {tenant_id, intent_id, status} inside the transaction (SSE).
 */
import {
  type PaymentConfirmation,
  generateReferenceCode,
  isValidVpa,
  newId,
  normalizeVpa,
} from '@kadai/shared'
import { sql } from 'kysely'
import { invalidField, notFound } from '../../core/errors'
import { CHANNELS, notify } from '../../core/events'
import type { KadaiMetrics } from '../../core/metrics'
import { recordPayment } from '../../core/payments'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { type Ctx, recordOf, tenantDateOf } from './common'
import { errorText, type ReceivedPayment } from './providers'
import { fifoAllocations } from './receipts'

export interface MarkPaidInput {
  intent_id: string
  confirmation: PaymentConfirmation
  payment: ReceivedPayment
  confirmed_by?: string | null
}

export interface MarkPaidResult {
  outcome: 'paid' | 'already_paid' | 'duplicate'
  intent_id: string
  /** The extra intent recording a second payment (outcome 'duplicate'). */
  duplicate_intent_id: string | null
  /** Receipt recorded for a payment-link intent (FIFO to the customer's dues). */
  payment_id: string | null
}

/** Sends the status-change event for an intent (delivered on commit). */
export async function notifyIntent(
  tx: Tx,
  tenantId: string,
  intentId: string,
  status: string,
): Promise<void> {
  await notify(tx, CHANNELS.paymentIntents, { tenant_id: tenantId, intent_id: intentId, status })
}

function cleanVpa(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  const valid: boolean = isValidVpa(t)
  return valid ? normalizeVpa(t) : t.slice(0, 255)
}

const LATE_STATUSES = new Set(['expired', 'cancelled', 'failed'])

export async function markIntentPaid(
  tx: Tx,
  ctx: Ctx,
  input: MarkPaidInput,
  opts: { metrics?: Pick<KadaiMetrics, 'paymentIntents'> } = {},
): Promise<MarkPaidResult> {
  const p = input.payment
  if (!Number.isSafeInteger(p.amount_paise) || p.amount_paise <= 0) {
    throw invalidField('amount_paise', 'The received amount must be a positive integer (paise)')
  }
  const row = await tx
    .selectFrom('payment_intents')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', input.intent_id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('payment_intent', input.intent_id)
  const paidAt = p.paid_at ?? new Date()

  if (row.status === 'paid') {
    const same =
      p.provider_payment_id === null ||
      row.provider_payment_id === null ||
      p.provider_payment_id === row.provider_payment_id
    if (same) {
      return {
        outcome: 'already_paid',
        intent_id: row.id,
        duplicate_intent_id: null,
        payment_id: row.payment_id,
      }
    }
    // A second, different payment for the same QR / link: keep the money visible.
    const dupId = newId()
    await tx
      .insertInto('payment_intents')
      .values({
        id: dupId,
        tenant_id: ctx.tenantId,
        store_id: row.store_id,
        register_id: row.register_id,
        provider_account_id: row.provider_account_id,
        provider: row.provider,
        kind: row.kind,
        purpose: row.purpose,
        ref_type: row.ref_type,
        ref_id: row.ref_id,
        customer_id: row.customer_id,
        reference_code: generateReferenceCode(),
        amount_paise: p.amount_paise,
        status: 'paid',
        provider_payment_id: p.provider_payment_id,
        payer_vpa: cleanVpa(p.payer_vpa),
        payer_name: p.payer_name,
        utr: p.utr,
        paid_amount_paise: p.amount_paise,
        fee_paise: p.fee_paise,
        confirmation: input.confirmation,
        confirmed_by: input.confirmed_by ?? null,
        paid_at: paidAt,
        failure_reason: `duplicate_payment: a second payment for intent ${row.reference_code}`,
        metadata: jsonb({ duplicate_of: row.id, provider_ref: row.provider_ref }),
        created_by: input.confirmed_by ?? null,
      })
      .execute()
    await notifyIntent(tx, ctx.tenantId, dupId, 'paid')
    opts.metrics?.paymentIntents.inc({ provider: row.provider, status: 'duplicate' })
    return { outcome: 'duplicate', intent_id: row.id, duplicate_intent_id: dupId, payment_id: null }
  }

  const notes: string[] = []
  if (LATE_STATUSES.has(row.status)) {
    notes.push(`late_payment: received after the intent was ${row.status}`)
  }
  if (p.amount_paise !== row.amount_paise) {
    notes.push(`amount_mismatch: received ${p.amount_paise} paise, expected ${row.amount_paise}`)
  }
  await tx
    .updateTable('payment_intents')
    .set({
      status: 'paid',
      paid_amount_paise: p.amount_paise,
      provider_payment_id: p.provider_payment_id,
      payer_vpa: cleanVpa(p.payer_vpa),
      payer_name: p.payer_name,
      utr: p.utr,
      fee_paise: p.fee_paise,
      paid_at: paidAt,
      confirmation: input.confirmation,
      confirmed_by: input.confirmed_by ?? null,
      failure_reason: notes.length ? notes.join('; ') : null,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', row.id)
    .execute()
  await notifyIntent(tx, ctx.tenantId, row.id, 'paid')
  opts.metrics?.paymentIntents.inc({ provider: row.provider, status: 'paid' })

  let paymentId: string | null = null
  // A different amount is never applied automatically, not even for a dues link: it stays
  // unapplied (reconciliation) until someone applies it to the customer or a bill.
  const amountMatches = p.amount_paise === row.amount_paise
  if (
    row.kind === 'link' &&
    row.purpose === 'customer_due' &&
    row.customer_id &&
    !row.payment_id &&
    amountMatches
  ) {
    paymentId = await applyLinkPayment(tx, ctx, {
      intent_id: row.id,
      store_id: row.store_id,
      customer_id: row.customer_id,
      amount_paise: p.amount_paise,
      reference_code: row.reference_code,
      paid_at: paidAt,
      notes: notes.join('; '),
    })
  }
  return { outcome: 'paid', intent_id: row.id, duplicate_intent_id: null, payment_id: paymentId }
}

/**
 * Receipt for a paid dues link: FIFO over the customer's open items, the rest as advance. Runs
 * in a savepoint; on failure the intent stays paid & unapplied with a note.
 */
async function applyLinkPayment(
  tx: Tx,
  ctx: Ctx,
  input: {
    intent_id: string
    store_id: string
    customer_id: string
    amount_paise: number
    reference_code: string
    paid_at: Date
    notes: string
  },
): Promise<string | null> {
  await sql`savepoint kadai_link_receipt`.execute(tx)
  try {
    const party = { type: 'customer' as const, id: input.customer_id }
    const fifo = await fifoAllocations(tx, ctx, {
      party_type: 'customer',
      party_id: input.customer_id,
      direction: 'in',
      amount_paise: input.amount_paise,
    })
    const payment = await recordPayment(tx, ctx, {
      direction: 'in',
      store_id: input.store_id,
      method: 'upi',
      amount_paise: input.amount_paise,
      payment_date: await tenantDateOf(tx, ctx, input.paid_at),
      party,
      payment_intent_id: input.intent_id,
      allocations: fifo.allocations,
      notes: `Payment link ${input.reference_code}`,
      number: true,
      paid_at: input.paid_at,
    })
    await sql`release savepoint kadai_link_receipt`.execute(tx)
    return payment.id
  } catch (err) {
    await sql`rollback to savepoint kadai_link_receipt`.execute(tx)
    const note = `auto_apply_failed: ${errorText(err, 300)}`
    await tx
      .updateTable('payment_intents')
      .set({ failure_reason: input.notes ? `${input.notes}; ${note}` : note })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', input.intent_id)
      .execute()
    return null
  }
}

/** Records a provider-reported failure note on an open intent (the customer may retry). */
export async function noteIntentFailure(
  tx: Tx,
  ctx: Ctx,
  intentId: string,
  reason: string,
): Promise<boolean> {
  const row = await tx
    .selectFrom('payment_intents')
    .select(['id', 'status', 'metadata'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', intentId)
    .forUpdate()
    .executeTakeFirst()
  if (!row || (row.status !== 'pending' && row.status !== 'created')) return false
  const meta = recordOf(row.metadata)
  const attempts = typeof meta.failed_attempts === 'number' ? meta.failed_attempts + 1 : 1
  await tx
    .updateTable('payment_intents')
    .set({
      failure_reason: `payment_failed: ${reason.slice(0, 300)}`,
      metadata: jsonb({ ...meta, failed_attempts: attempts }),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', row.id)
    .execute()
  await notifyIntent(tx, ctx.tenantId, row.id, row.status)
  return true
}
