/**
 * Money in / out (ARCHITECTURE.md §8.4, §10, §11.2) — the ONLY writer of payments and
 * payment_allocations, and of the paid/due columns of the documents they settle.
 *
 *   const receipt = await recordPayment(tx, ctx, {
 *     direction: 'in', store_id, method: 'upi', amount_paise: 50_000, payment_date: today,
 *     party: { type: 'customer', id: customerId }, payment_intent_id,
 *     allocations: [{ target_type: 'sales_invoice', target_id: invoiceId, amount_paise: 30_000 }],
 *     number: true,                 // RC… receipt number (PV… voucher for direction 'out')
 *   })                              // receipt.unallocated_paise === 20_000 (advance)
 *
 * Ledger account by method (unless `account_id` is given):
 *   cash → cash · card → card_clearing · bank_transfer / cheque / other → bank ·
 *   wallet → upi_clearing · store_credit → customer_advance ·
 *   upi (and any payment linked to a payment intent) → the provider account's
 *     settlement_account_id when set, else upi_clearing for PSP providers (razorpay, cashfree,
 *     phonepe, paytm, mock: funds sit with the PSP until settlement), else bank (upi_vpa: the
 *     money lands directly in the shop's bank account).
 *
 * Journal (source_type 'payment', source_id = payment id). The counter account is `payable`
 * for a supplier party and `receivable` otherwise (walk-in tenders net against the walk-in
 * receivable the invoice posted):
 *   in:  Dr <account>          Cr receivable|payable (party)
 *   out: Dr receivable|payable (party)   Cr <account>
 * store_credit lines on customer_advance carry the customer as party, so the store-credit
 * balance of a customer is Σ (credit − debit) of customer_advance lines with that party:
 * `out` issues store credit (credit note settlement), `in` redeems it (checked: never more than
 * the customer holds).
 *
 * Allocations settle documents (rows locked FOR UPDATE, over-allocation is 422):
 *   in:  sales_invoice (paid/due/payment_status), debit_note, opening_balance
 *   out: purchase_bill (paid/due/payment_status), credit_note (settled_paise), expense (on
 *        credit), opening_balance
 * The remainder is kept as unallocated_paise (advance / on account). Allocation rows of a
 * cancelled payment are kept for history; sums over payment_allocations must join payments with
 * status 'completed' (the documents' paid/due columns are already corrected).
 */
import {
  type AllocationTargetType,
  AllocationTargetTypeSchema,
  type PaymentDirection,
  type PaymentMethod,
  PaymentMethodSchema,
  type SystemAccountSubtype,
  isDateStr,
  isUuid,
  newId,
  todayIn,
} from '@kadai/shared'
import { sql } from 'kysely'
import type { Tx } from '../db/tenant'
import { audit } from './audit'
import type { RequestContext } from './context'
import { canAccessStore } from './context'
import { AppError, conflict, forbidden, invalidField, notFound, unprocessable } from './errors'
import { postJournal, reverseJournal, systemAccountId } from './ledger'
import { nextNumber, tenantCalendar } from './numbering'

type Ctx = Pick<RequestContext, 'tenantId' | 'userId' | 'storeIds' | 'ip' | 'userAgent' | 'requestId'>

export interface PaymentParty {
  type: 'customer' | 'supplier'
  id: string
}

export interface PaymentAllocationInput {
  target_type: AllocationTargetType
  /** Document id; for 'opening_balance' the party id (or null = the payment's party). */
  target_id: string | null
  amount_paise: number
}

export interface RecordPaymentInput {
  direction: PaymentDirection
  store_id: string
  register_id?: string | null
  shift_id?: string | null
  method: PaymentMethod
  amount_paise: number
  /** Business date (YYYY-MM-DD). */
  payment_date: string
  party?: PaymentParty | null
  /** UTR / RRN / cheque no / card approval code. Defaults to the intent's UTR. */
  reference?: string | null
  /** A paid, unused payment intent (UPI QR / link) this payment consumes. */
  payment_intent_id?: string | null
  /** Override the ledger account resolved from the method. */
  account_id?: string | null
  allocations?: readonly PaymentAllocationInput[]
  notes?: string | null
  /** Idempotency: the same client_ref returns the existing payment. */
  client_ref?: string | null
  /** Allocate a receipt (in) / payment voucher (out) number. */
  number?: boolean
  /** Instant of payment (default now). */
  paid_at?: Date
}

export interface PaymentAllocationRecord {
  id: string
  target_type: AllocationTargetType
  target_id: string | null
  amount_paise: number
}

export interface PaymentRecord {
  id: string
  store_id: string
  register_id: string | null
  shift_id: string | null
  number: string | null
  fy: string | null
  direction: PaymentDirection
  party_type: 'customer' | 'supplier' | null
  party_id: string | null
  method: PaymentMethod
  amount_paise: number
  status: 'pending' | 'completed' | 'failed' | 'cancelled'
  payment_date: string
  paid_at: Date
  reference: string | null
  payment_intent_id: string | null
  account_id: string
  unallocated_paise: number
  notes: string | null
  client_ref: string | null
  cancelled_at: Date | null
  cancel_reason: string | null
  created_by: string | null
  created_at: Date
  allocations: PaymentAllocationRecord[]
  /** True when an earlier payment with the same client_ref was returned. */
  replayed: boolean
}

const ALLOWED_TARGETS: Readonly<Record<PaymentDirection, ReadonlySet<AllocationTargetType>>> = {
  in: new Set(['sales_invoice', 'debit_note', 'opening_balance']),
  out: new Set(['purchase_bill', 'credit_note', 'expense', 'opening_balance']),
}

const METHOD_ACCOUNT: Readonly<Record<Exclude<PaymentMethod, 'upi'>, SystemAccountSubtype>> = {
  cash: 'cash',
  card: 'card_clearing',
  bank_transfer: 'bank',
  cheque: 'bank',
  other: 'bank',
  wallet: 'upi_clearing',
  store_credit: 'customer_advance',
}

/** Providers that collect funds themselves and settle to the bank later. */
const PSP_PROVIDERS: ReadonlySet<string> = new Set(['razorpay', 'cashfree', 'phonepe', 'paytm', 'mock'])

const PAYMENT_COLUMNS = [
  'id',
  'store_id',
  'register_id',
  'shift_id',
  'number',
  'fy',
  'direction',
  'party_type',
  'party_id',
  'method',
  'amount_paise',
  'status',
  'payment_date',
  'paid_at',
  'reference',
  'payment_intent_id',
  'account_id',
  'unallocated_paise',
  'notes',
  'client_ref',
  'cancelled_at',
  'cancel_reason',
  'created_by',
  'created_at',
] as const

function assertStore(ctx: Pick<RequestContext, 'storeIds'>, storeId: string): void {
  if (!canAccessStore(ctx, storeId)) {
    throw forbidden('You do not have access to this store', { store_id: storeId })
  }
}

function cleanText(value: string | null | undefined, max: number): string | null {
  const t = value?.trim()
  return t ? t.slice(0, max) : null
}

function uuidOf(value: unknown, path: string): string {
  if (!isUuid(value)) throw invalidField(path, 'Expected a UUID')
  return value.toLowerCase()
}

/** Loads a payment with its allocations. */
export async function getPayment(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  paymentId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PaymentRecord> {
  let q = tx
    .selectFrom('payments')
    .select(PAYMENT_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', paymentId)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('payment', paymentId)
  const allocations = await tx
    .selectFrom('payment_allocations')
    .select(['id', 'target_type', 'target_id', 'amount_paise'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('payment_id', '=', paymentId)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return {
    ...row,
    direction: row.direction as PaymentDirection,
    party_type: row.party_type as PaymentRecord['party_type'],
    method: row.method as PaymentMethod,
    status: row.status as PaymentRecord['status'],
    allocations: allocations.map((a) => ({ ...a, target_type: a.target_type as AllocationTargetType })),
    replayed: false,
  }
}

/**
 * Ledger account a payment of `method` goes to (see the module comment). `intent` is the
 * payment intent's provider account when the payment consumes one.
 */
export async function resolvePaymentAccount(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  input: {
    method: PaymentMethod
    account_id?: string | null
    intent?: { provider: string; settlement_account_id: string | null } | null
  },
): Promise<{ account_id: string; subtype: string | null }> {
  if (input.account_id) {
    const row = await tx
      .selectFrom('accounts')
      .select(['id', 'subtype', 'is_active', 'type'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', input.account_id)
      .executeTakeFirst()
    if (!row) throw unprocessable('Account not found', { account_id: input.account_id })
    if (!row.is_active) throw unprocessable('Account is inactive', { account_id: input.account_id })
    if (row.type !== 'asset' && row.type !== 'liability') {
      throw unprocessable('Payments must use an asset (cash/bank) or liability account', {
        account_id: input.account_id,
        type: row.type,
      })
    }
    return { account_id: row.id, subtype: row.subtype }
  }
  if (input.intent) {
    if (input.intent.settlement_account_id) {
      return resolvePaymentAccount(tx, ctx, {
        method: input.method,
        account_id: input.intent.settlement_account_id,
      })
    }
    const subtype: SystemAccountSubtype = PSP_PROVIDERS.has(input.intent.provider)
      ? 'upi_clearing'
      : 'bank'
    return { account_id: await systemAccountId(tx, ctx, subtype), subtype }
  }
  const subtype: SystemAccountSubtype = input.method === 'upi' ? 'bank' : METHOD_ACCOUNT[input.method]
  return { account_id: await systemAccountId(tx, ctx, subtype), subtype }
}

/** Store credit a customer holds: Σ (credit − debit) on customer_advance lines with the party. */
export async function storeCreditBalance(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  customerId: string,
): Promise<number> {
  const accountId = await systemAccountId(tx, ctx, 'customer_advance')
  const row = await tx
    .selectFrom('journal_lines')
    .select(sql<number>`coalesce(sum(credit_paise - debit_paise), 0)::bigint`.as('balance'))
    .where('tenant_id', '=', ctx.tenantId)
    .where('account_id', '=', accountId)
    .where('party_type', '=', 'customer')
    .where('party_id', '=', customerId)
    .executeTakeFirstOrThrow()
  return Number(row.balance)
}

function paymentStatusOf(paid: number, due: number): 'unpaid' | 'partial' | 'paid' {
  if (due <= 0) return 'paid'
  return paid > 0 ? 'partial' : 'unpaid'
}

/** Sum of live (completed-payment) allocations to a target. */
async function allocatedTo(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  targetType: AllocationTargetType,
  targetId: string,
): Promise<number> {
  const row = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .select(sql<number>`coalesce(sum(a.amount_paise), 0)::bigint`.as('total'))
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', targetType)
    .where('a.target_id', '=', targetId)
    .where('p.status', '=', 'completed')
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

function overAllocated(
  target: { target_type: string; target_id: string | null },
  open: number,
  amount: number,
): AppError {
  return unprocessable(
    `Allocation of ${amount} paise exceeds the open amount of ${open} paise on the ${target.target_type}`,
    { target_type: target.target_type, target_id: target.target_id, open_paise: open, amount_paise: amount },
  )
}

function partyMismatch(target: { target_type: string; target_id: string | null }): AppError {
  return unprocessable(`The ${target.target_type} belongs to another party`, {
    target_type: target.target_type,
    target_id: target.target_id,
  })
}

/**
 * Applies (sign = 1) or un-applies (sign = −1) one allocation to its target document, with the
 * target row locked. Validation (status, party, open amount) only applies when applying.
 */
async function applyAllocation(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  a: { target_type: AllocationTargetType; target_id: string | null; amount_paise: number },
  party: PaymentParty | null,
  sign: 1 | -1,
): Promise<void> {
  const t = ctx.tenantId
  const amount = a.amount_paise * sign
  const applying = sign === 1
  switch (a.target_type) {
    case 'sales_invoice':
    case 'purchase_bill': {
      const isSale = a.target_type === 'sales_invoice'
      const id = a.target_id!
      const doc = isSale
        ? await tx
            .selectFrom('sales_invoices')
            .select(['status', 'paid_paise', 'due_paise', 'customer_id as party_id'])
            .where('tenant_id', '=', t)
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst()
        : await tx
            .selectFrom('purchase_bills')
            .select(['status', 'paid_paise', 'due_paise', 'supplier_id as party_id'])
            .where('tenant_id', '=', t)
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst()
      if (!doc) throw notFound(a.target_type, id)
      if (applying) {
        const live = isSale ? doc.status === 'completed' : doc.status === 'posted'
        if (!live) {
          throw unprocessable(`The ${a.target_type} is ${doc.status}; payments cannot be applied`, {
            target_type: a.target_type,
            target_id: id,
            status: doc.status,
          })
        }
        // Sales: the invoice's customer (or none for walk-in) must be the payer; a supplier never
        // pays a sales invoice. Purchases: the bill's supplier must be the payee.
        const partyOk = isSale
          ? party?.type !== 'supplier' && doc.party_id === (party?.id ?? null)
          : party?.type === 'supplier' && doc.party_id === party.id
        if (!partyOk) throw partyMismatch(a)
        if (a.amount_paise > doc.due_paise) throw overAllocated(a, doc.due_paise, a.amount_paise)
      }
      const paid = doc.paid_paise + amount
      const due = doc.due_paise - amount
      const status = paymentStatusOf(paid, due)
      if (isSale) {
        await tx
          .updateTable('sales_invoices')
          .set({ paid_paise: paid, due_paise: due, payment_status: status })
          .where('tenant_id', '=', t)
          .where('id', '=', id)
          .execute()
      } else {
        await tx
          .updateTable('purchase_bills')
          .set({ paid_paise: paid, due_paise: due, payment_status: status })
          .where('tenant_id', '=', t)
          .where('id', '=', id)
          .execute()
      }
      return
    }
    case 'credit_note': {
      const id = a.target_id!
      const doc = await tx
        .selectFrom('credit_notes')
        .select(['status', 'total_paise', 'settled_paise', 'customer_id'])
        .where('tenant_id', '=', t)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!doc) throw notFound('credit_note', id)
      if (applying) {
        if (doc.status !== 'completed') {
          throw unprocessable('The credit note is cancelled', { target_id: id })
        }
        if (party?.type === 'supplier' || doc.customer_id !== (party?.id ?? null)) {
          throw partyMismatch(a)
        }
        const open = doc.total_paise - doc.settled_paise
        if (a.amount_paise > open) throw overAllocated(a, open, a.amount_paise)
      }
      await tx
        .updateTable('credit_notes')
        .set({ settled_paise: doc.settled_paise + amount })
        .where('tenant_id', '=', t)
        .where('id', '=', id)
        .execute()
      return
    }
    case 'debit_note':
    case 'expense': {
      if (!applying) return // open amounts are derived from live allocations
      const id = a.target_id!
      const doc =
        a.target_type === 'debit_note'
          ? await tx
              .selectFrom('debit_notes')
              .select(['status', 'total_paise', 'supplier_id'])
              .where('tenant_id', '=', t)
              .where('id', '=', id)
              .forUpdate()
              .executeTakeFirst()
          : await tx
              .selectFrom('expenses')
              .select(['status', 'total_paise', 'supplier_id', 'payment_method'])
              .where('tenant_id', '=', t)
              .where('id', '=', id)
              .forUpdate()
              .executeTakeFirst()
      if (!doc) throw notFound(a.target_type, id)
      const live = a.target_type === 'debit_note' ? doc.status === 'completed' : doc.status === 'posted'
      if (!live) throw unprocessable(`The ${a.target_type} is cancelled`, { target_id: id })
      if ('payment_method' in doc && doc.payment_method !== 'credit') {
        throw unprocessable('Only expenses bought on credit can be paid later', { target_id: id })
      }
      if (party?.type !== 'supplier' || doc.supplier_id !== party.id) throw partyMismatch(a)
      const open = doc.total_paise - (await allocatedTo(tx, ctx, a.target_type, id))
      if (a.amount_paise > open) throw overAllocated(a, open, a.amount_paise)
      return
    }
    case 'opening_balance': {
      if (!applying) return
      if (!party || a.target_id !== party.id) throw partyMismatch(a)
      const row =
        party.type === 'customer'
          ? await tx
              .selectFrom('customers')
              .select('opening_balance_paise')
              .where('tenant_id', '=', t)
              .where('id', '=', party.id)
              .forUpdate()
              .executeTakeFirst()
          : await tx
              .selectFrom('suppliers')
              .select('opening_balance_paise')
              .where('tenant_id', '=', t)
              .where('id', '=', party.id)
              .forUpdate()
              .executeTakeFirst()
      if (!row) throw notFound(party.type, party.id)
      const open =
        Math.abs(row.opening_balance_paise) - (await allocatedTo(tx, ctx, 'opening_balance', party.id))
      if (a.amount_paise > open) throw overAllocated(a, open, a.amount_paise)
      return
    }
  }
}

function sameRequest(existing: PaymentRecord, input: RecordPaymentInput, party: PaymentParty | null): boolean {
  return (
    existing.direction === input.direction &&
    existing.store_id === input.store_id.toLowerCase() &&
    existing.method === input.method &&
    existing.amount_paise === input.amount_paise &&
    existing.payment_date === input.payment_date &&
    existing.party_type === (party?.type ?? null) &&
    existing.party_id === (party?.id ?? null)
  )
}

/** Records a completed payment (see the module comment). Runs in the caller's transaction. */
export async function recordPayment(
  tx: Tx,
  ctx: Ctx,
  input: RecordPaymentInput,
): Promise<PaymentRecord> {
  // ---- validation ------------------------------------------------------------------------
  if (input.direction !== 'in' && input.direction !== 'out') {
    throw invalidField('direction', 'Direction must be in or out')
  }
  if (!PaymentMethodSchema.safeParse(input.method).success) {
    throw invalidField('method', `Unknown payment method "${String(input.method)}"`)
  }
  if (!Number.isSafeInteger(input.amount_paise) || input.amount_paise <= 0) {
    throw invalidField('amount_paise', 'Amount must be a positive integer (paise)')
  }
  if (!isDateStr(input.payment_date)) {
    throw invalidField('payment_date', 'Expected a date (YYYY-MM-DD)')
  }
  const storeId = uuidOf(input.store_id, 'store_id')
  assertStore(ctx, storeId)
  const party: PaymentParty | null = input.party
    ? { type: input.party.type, id: uuidOf(input.party.id, 'party.id') }
    : null
  if (party && party.type !== 'customer' && party.type !== 'supplier') {
    throw invalidField('party.type', 'Party type must be customer or supplier')
  }
  const clientRef = cleanText(input.client_ref, 200)

  if (clientRef) {
    const existing = await tx
      .selectFrom('payments')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('client_ref', '=', clientRef)
      .executeTakeFirst()
    if (existing) {
      const payment = await getPayment(tx, ctx, existing.id)
      if (!sameRequest(payment, input, party)) {
        throw new AppError(
          'IDEMPOTENCY_MISMATCH',
          'client_ref was already used for a different payment',
          { client_ref: clientRef, payment_id: payment.id },
        )
      }
      return { ...payment, replayed: true }
    }
  }

  if (input.method === 'store_credit' && party?.type !== 'customer') {
    throw unprocessable('Store credit needs a customer', { method: input.method })
  }

  // Merge allocations per target and validate their shape.
  const merged = new Map<string, PaymentAllocationInput>()
  for (const [i, a] of (input.allocations ?? []).entries()) {
    if (!AllocationTargetTypeSchema.safeParse(a.target_type).success) {
      throw invalidField(`allocations.${i}.target_type`, 'Unknown allocation target')
    }
    if (!ALLOWED_TARGETS[input.direction].has(a.target_type)) {
      throw unprocessable(`A payment ${input.direction} cannot settle a ${a.target_type}`, {
        index: i,
        target_type: a.target_type,
        direction: input.direction,
      })
    }
    if (!Number.isSafeInteger(a.amount_paise) || a.amount_paise <= 0) {
      throw invalidField(`allocations.${i}.amount_paise`, 'Amount must be a positive integer (paise)')
    }
    const targetId =
      a.target_type === 'opening_balance'
        ? a.target_id
          ? uuidOf(a.target_id, `allocations.${i}.target_id`)
          : (party?.id ?? null)
        : uuidOf(a.target_id, `allocations.${i}.target_id`)
    const key = `${a.target_type}:${targetId ?? ''}`
    const prev = merged.get(key)
    merged.set(key, {
      target_type: a.target_type,
      target_id: targetId,
      amount_paise: (prev?.amount_paise ?? 0) + a.amount_paise,
    })
  }
  // Lock targets in a deterministic order.
  const allocations = [...merged.values()].sort((x, y) =>
    `${x.target_type}:${x.target_id}` < `${y.target_type}:${y.target_id}` ? -1 : 1,
  )
  const allocated = allocations.reduce((s, a) => s + a.amount_paise, 0)
  if (allocated > input.amount_paise) {
    throw unprocessable('Allocations exceed the payment amount', {
      amount_paise: input.amount_paise,
      allocated_paise: allocated,
    })
  }

  // ---- references ------------------------------------------------------------------------
  if (party) {
    const table = party.type === 'customer' ? 'customers' : 'suppliers'
    // Lock the party for store-credit redemption (balance check below); just check otherwise.
    let q = tx.selectFrom(table).select('id').where('tenant_id', '=', ctx.tenantId).where('id', '=', party.id)
    if (input.method === 'store_credit') q = q.forUpdate()
    if (!(await q.executeTakeFirst())) throw notFound(party.type, party.id)
  }

  let registerId = input.register_id ? uuidOf(input.register_id, 'register_id') : null
  const shiftId = input.shift_id ? uuidOf(input.shift_id, 'shift_id') : null
  if (shiftId) {
    const shift = await tx
      .selectFrom('register_shifts')
      .select(['status', 'store_id', 'register_id'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', shiftId)
      .executeTakeFirst()
    if (!shift) throw notFound('shift', shiftId)
    if (shift.status !== 'open') throw conflict('The shift is closed', { shift_id: shiftId })
    if (shift.store_id !== storeId || (registerId && registerId !== shift.register_id)) {
      throw unprocessable('The shift belongs to another store or register', { shift_id: shiftId })
    }
    registerId = shift.register_id
  } else if (registerId) {
    const register = await tx
      .selectFrom('registers')
      .select('store_id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', registerId)
      .executeTakeFirst()
    if (!register) throw notFound('register', registerId)
    if (register.store_id !== storeId) {
      throw unprocessable('The register belongs to another store', { register_id: registerId })
    }
  }

  let intent: {
    id: string
    provider: string
    settlement_account_id: string | null
    utr: string | null
  } | null = null
  if (input.payment_intent_id) {
    const intentId = uuidOf(input.payment_intent_id, 'payment_intent_id')
    const row = await tx
      .selectFrom('payment_intents as i')
      .innerJoin('payment_provider_accounts as pa', (j) =>
        j.onRef('pa.tenant_id', '=', 'i.tenant_id').onRef('pa.id', '=', 'i.provider_account_id'),
      )
      .select([
        'i.id',
        'i.status',
        'i.store_id',
        'i.customer_id',
        'i.amount_paise',
        'i.paid_amount_paise',
        'i.payment_id',
        'i.utr',
        'i.provider',
        'pa.settlement_account_id',
      ])
      .where('i.tenant_id', '=', ctx.tenantId)
      .where('i.id', '=', intentId)
      .forUpdate(['i'])
      .executeTakeFirst()
    if (!row) throw notFound('payment_intent', intentId)
    if (input.direction !== 'in') throw unprocessable('A payment intent can only fund a receipt')
    if (['cash', 'cheque', 'store_credit'].includes(input.method)) {
      throw unprocessable(`A ${input.method} payment cannot use a payment intent`)
    }
    if (row.status !== 'paid') {
      throw unprocessable('The payment intent is not paid', { status: row.status })
    }
    if (row.payment_id) {
      throw conflict('The payment intent was already used', { payment_id: row.payment_id })
    }
    const paid = row.paid_amount_paise ?? row.amount_paise
    if (paid !== input.amount_paise) {
      throw unprocessable('The amount differs from the amount paid through the intent', {
        intent_amount_paise: paid,
        amount_paise: input.amount_paise,
      })
    }
    if (row.store_id !== storeId) throw unprocessable('The payment intent belongs to another store')
    if (row.customer_id && party && (party.type !== 'customer' || party.id !== row.customer_id)) {
      throw unprocessable('The payment intent belongs to another customer')
    }
    intent = row
  }

  const account = await resolvePaymentAccount(tx, ctx, {
    method: input.method,
    account_id: input.account_id ? uuidOf(input.account_id, 'account_id') : null,
    intent,
  })

  if (input.method === 'store_credit' && input.direction === 'in') {
    const available = await storeCreditBalance(tx, ctx, party!.id)
    if (input.amount_paise > available) {
      throw unprocessable('Not enough store credit', {
        available_paise: available,
        amount_paise: input.amount_paise,
      })
    }
  }

  // ---- write -----------------------------------------------------------------------------
  const numbered = input.number
    ? await nextNumber(tx, ctx, {
        docType: input.direction === 'in' ? 'receipt' : 'payment_voucher',
        storeId,
        date: input.payment_date,
      })
    : null
  const paymentId = newId()
  await tx
    .insertInto('payments')
    .values({
      id: paymentId,
      tenant_id: ctx.tenantId,
      store_id: storeId,
      register_id: registerId,
      shift_id: shiftId,
      number: numbered?.number ?? null,
      fy: numbered?.fy ?? null,
      direction: input.direction,
      party_type: party?.type ?? null,
      party_id: party?.id ?? null,
      method: input.method,
      amount_paise: input.amount_paise,
      status: 'completed',
      payment_date: input.payment_date,
      paid_at: input.paid_at ?? new Date(),
      reference: cleanText(input.reference, 100) ?? intent?.utr ?? null,
      payment_intent_id: intent?.id ?? null,
      account_id: account.account_id,
      unallocated_paise: input.amount_paise - allocated,
      notes: cleanText(input.notes, 1000),
      client_ref: clientRef,
      created_by: ctx.userId,
    })
    .execute()

  if (allocations.length) {
    for (const a of allocations) await applyAllocation(tx, ctx, a, party, 1)
    await tx
      .insertInto('payment_allocations')
      .values(
        allocations.map((a) => ({
          id: newId(),
          tenant_id: ctx.tenantId,
          payment_id: paymentId,
          target_type: a.target_type,
          target_id: a.target_id,
          amount_paise: a.amount_paise,
        })),
      )
      .execute()
  }

  if (intent) {
    await tx
      .updateTable('payment_intents')
      .set({ payment_id: paymentId })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', intent.id)
      .execute()
  }

  const counter: SystemAccountSubtype = party?.type === 'supplier' ? 'payable' : 'receivable'
  const accountParty = account.subtype === 'customer_advance' && party ? party : null
  const memo = cleanText(input.reference, 100) ?? numbered?.number ?? null
  await postJournal(tx, ctx, {
    entry_date: input.payment_date,
    store_id: storeId,
    source_type: 'payment',
    source_id: paymentId,
    narration: `${input.direction === 'in' ? 'Receipt' : 'Payment'} (${input.method})${
      numbered ? ` ${numbered.number}` : ''
    }`,
    lines:
      input.direction === 'in'
        ? [
            { account: { id: account.account_id }, debit_paise: input.amount_paise, party: accountParty, memo },
            { account: { subtype: counter }, credit_paise: input.amount_paise, party, memo },
          ]
        : [
            { account: { subtype: counter }, debit_paise: input.amount_paise, party, memo },
            { account: { id: account.account_id }, credit_paise: input.amount_paise, party: accountParty, memo },
          ],
  })

  return getPayment(tx, ctx, paymentId)
}

export interface CancelPaymentInput {
  payment_id: string
  reason: string
  /** Date of the reversal entry (default: today in the tenant timezone). */
  date?: string
}

/**
 * Cancels a payment: reverses its journal, un-applies its allocations (documents' paid/due
 * restored), releases its payment intent (back to "paid, unused" for reconciliation), marks it
 * cancelled and audits 'payment.cancel'. Receipt numbers are kept (gapless series).
 */
export async function cancelPayment(
  tx: Tx,
  ctx: Ctx,
  input: CancelPaymentInput,
): Promise<{ reversal_entry_id: string | null }> {
  const reason = cleanText(input.reason, 500)
  if (!reason) throw invalidField('reason', 'A reason is required')
  if (input.date !== undefined && !isDateStr(input.date)) {
    throw invalidField('date', 'Expected a date (YYYY-MM-DD)')
  }
  const payment = await getPayment(tx, ctx, uuidOf(input.payment_id, 'payment_id'), {
    forUpdate: true,
  })
  assertStore(ctx, payment.store_id)
  if (payment.status !== 'completed') {
    throw conflict(`The payment is already ${payment.status}`, {
      payment_id: payment.id,
      status: payment.status,
    })
  }
  const party: PaymentParty | null =
    payment.party_type && payment.party_id ? { type: payment.party_type, id: payment.party_id } : null
  const allocations = [...payment.allocations].sort((x, y) =>
    `${x.target_type}:${x.target_id}` < `${y.target_type}:${y.target_id}` ? -1 : 1,
  )
  for (const a of allocations) await applyAllocation(tx, ctx, a, party, -1)

  const date = input.date ?? todayIn((await tenantCalendar(tx, ctx)).timezone)
  const reversal = await reverseJournal(tx, ctx, {
    source_type: 'payment',
    source_id: payment.id,
    entry_date: date,
    narration: `Cancelled${payment.number ? ` ${payment.number}` : ''}: ${reason}`,
  })

  if (payment.payment_intent_id) {
    await tx
      .updateTable('payment_intents')
      .set({ payment_id: null })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', payment.payment_intent_id)
      .where('payment_id', '=', payment.id)
      .execute()
  }
  await tx
    .updateTable('payments')
    .set({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancelled_by: ctx.userId,
      cancel_reason: reason,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', payment.id)
    .execute()
  await audit(tx, ctx, {
    action: 'payment.cancel',
    entity_type: 'payment',
    entity_id: payment.id,
    summary: `${payment.direction === 'in' ? 'Receipt' : 'Payment'} ${payment.number ?? payment.id.slice(-8)} of ${payment.amount_paise} paise cancelled: ${reason}`,
    changes: {
      reason,
      amount_paise: payment.amount_paise,
      method: payment.method,
      allocations: payment.allocations,
      reversal_entry_id: reversal.entry_id,
    },
  })
  return { reversal_entry_id: reversal.entry_id }
}
