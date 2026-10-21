/**
 * Payment intents — one UPI QR / dues link per collection (ARCHITECTURE.md §11.2):
 * `created → pending → paid | failed | expired | cancelled`.
 *
 * Creation never holds a database transaction during the provider call:
 *   1. tx: validate (store, register, document, customer, provider account, plan feature),
 *      claim the idempotency key (payment_intents.idempotency_key is unique per tenant) and
 *      insert the intent as `created`;
 *   2. provider call (Razorpay QR / link; the static UPI ID and mock build theirs locally);
 *   3. tx: `pending` with the QR / link (or `failed` + 502 PROVIDER_ERROR), NOTIFY.
 * A retry with the same key replays the intent; a different request → 409 IDEMPOTENCY_MISMATCH;
 * a concurrent retry while the provider call runs → 409 IDEMPOTENCY_IN_PROGRESS (an attempt
 * that died mid-call is taken over after 30 s). Expiry: now + settings.payments
 * .intent_expiry_seconds (links: expires_in_hours); the expire job closes provider QRs.
 *
 * Store scoping: an intent belongs to its store; members of other stores get 404 (reads) /
 * 403 (creating for a store they cannot access).
 */
import {
  type PaymentConfirmation,
  type PaymentIntentKind,
  type PaymentIntentPurpose,
  type PaymentIntentStatus,
  type PaymentProviderCode,
  generateReferenceCode,
  isUuid,
  newId,
} from '@kadai/shared'
import {
  PROVIDER_CAPABILITIES,
  type PaymentDetail,
  type PaymentIntent,
  type PaymentIntentApplySchema,
  type PaymentIntentConfirmSchema,
  type PaymentIntentListQuerySchema,
  type PaymentIntentListResponse,
  type PaymentIntentMockPaySchema,
  type PaymentIntentRefType,
  PaymentIntentRefTypeSchema,
  isDynamicProvider,
} from '@kadai/shared/api/payments'
import { type RawBuilder, sql } from 'kysely'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { canAccessStore } from '../../core/context'
import { assertFeature } from '../../core/entitlements'
import { AppError, notFound } from '../../core/errors'
import { assertStoreAccess, parsePage } from '../../core/http'
import { tenantCalendar } from '../../core/numbering'
import { recordPayment } from '../../core/payments'
import type { KadaiDeps } from '../../core/runtime'
import { getSettings } from '../../core/settings'
import { jsonb } from '../../db/json'
import { type Tx, withTenant } from '../../db/tenant'
import { loadAccountRuntime } from './accounts'
import {
  type Ctx,
  enqueueSafely,
  loadShop,
  reasonError,
  recordOf,
  stringOf,
  tenantDateOf,
} from './common'
import { markIntentPaid, notifyIntent } from './mark-paid'
import {
  type PaymentProvider,
  type ProviderAccountRuntime,
  type ProviderCustomer,
  type ProviderIntent,
  errorText,
  getProvider,
  isPollingProvider,
  isProviderFailure,
} from './providers'
import { MOCK_PAYER_VPA, mockPayment } from './providers/mock'
import { vpaIntentUri } from './providers/upi-vpa'
import { dateRangeInstants, fifoAllocations, getPaymentDetail } from './receipts'

type ListQuery = z.output<typeof PaymentIntentListQuerySchema>
type ConfirmBody = z.output<typeof PaymentIntentConfirmSchema>
type MockPayBody = z.output<typeof PaymentIntentMockPaySchema>
type ApplyBody = z.output<typeof PaymentIntentApplySchema>

export type IntentDeps = Pick<KadaiDeps, 'config' | 'crypto' | 'db' | 'logger' | 'metrics'>

/** An intent stuck in `created` this long (the creating request died) may be taken over. */
const CREATED_TAKEOVER_SECONDS = 30
/** Job that polls open intents (also kicked a few seconds after an intent opens). */
export const POLL_JOB = 'payments.poll-intents'
export const OPEN_STATUSES: readonly PaymentIntentStatus[] = ['created', 'pending']

// ---------------------------------------------------------------------------------------------
// Rows & mapping
// ---------------------------------------------------------------------------------------------

export function intentQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('payment_intents as i')
    .innerJoin('payment_provider_accounts as pa', (j) =>
      j.onRef('pa.tenant_id', '=', 'i.tenant_id').onRef('pa.id', '=', 'i.provider_account_id'),
    )
    .leftJoin('customers as c', (j) =>
      j.onRef('c.tenant_id', '=', 'i.tenant_id').onRef('c.id', '=', 'i.customer_id'),
    )
    .leftJoin('users as u', 'u.id', 'i.confirmed_by')
    .leftJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'i.tenant_id').onRef('p.id', '=', 'i.payment_id'),
    )
    .selectAll('i')
    .select([
      'pa.display_name as provider_display_name',
      'c.name as customer_name',
      'u.full_name as confirmed_by_name',
      'p.number as payment_number',
    ])
    .where('i.tenant_id', '=', ctx.tenantId)
}

export type IntentRow = Awaited<
  ReturnType<ReturnType<typeof intentQuery>['executeTakeFirstOrThrow']>
>

function refTypeOf(v: string | null): PaymentIntentRefType | null {
  const r = PaymentIntentRefTypeSchema.safeParse(v)
  return r.success ? r.data : null
}

export function toIntent(row: IntentRow, now = Date.now()): PaymentIntent {
  const status = row.status as PaymentIntentStatus
  const open = status === 'created' || status === 'pending'
  return {
    id: row.id,
    store_id: row.store_id,
    register_id: row.register_id,
    provider_account_id: row.provider_account_id,
    provider: row.provider as PaymentProviderCode,
    provider_display_name: row.provider_display_name,
    kind: row.kind as PaymentIntentKind,
    purpose: row.purpose as PaymentIntentPurpose,
    ref_type: refTypeOf(row.ref_type),
    ref_id: row.ref_id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    reference_code: row.reference_code,
    amount_paise: row.amount_paise,
    currency: 'INR',
    status,
    upi_uri: row.upi_uri,
    image_url: row.image_url,
    short_url: row.short_url,
    provider_ref: row.provider_ref,
    provider_payment_id: row.provider_payment_id,
    payer_vpa: row.payer_vpa,
    payer_name: row.payer_name,
    utr: row.utr,
    paid_amount_paise: row.paid_amount_paise,
    fee_paise: row.fee_paise,
    amount_mismatch: row.paid_amount_paise !== null && row.paid_amount_paise !== row.amount_paise,
    confirmation: (row.confirmation as PaymentConfirmation | null) ?? null,
    confirmed_by: row.confirmed_by,
    confirmed_by_name: row.confirmed_by_name,
    payment_id: row.payment_id,
    payment_number: row.payment_number,
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
    expires_in_seconds:
      open && row.expires_at
        ? Math.max(0, Math.ceil((row.expires_at.getTime() - now) / 1000))
        : null,
    paid_at: row.paid_at ? row.paid_at.toISOString() : null,
    failure_reason: row.failure_reason,
    poll_count: row.poll_count,
    last_polled_at: row.last_polled_at ? row.last_polled_at.toISOString() : null,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

/** The intent as adapters see it. */
export function providerIntentOf(row: {
  id: string
  tenant_id: string
  kind: string
  purpose: string
  reference_code: string
  amount_paise: number
  provider_ref: string | null
  created_at: Date
  expires_at: Date | null
  metadata: unknown
}): ProviderIntent {
  const metadata = recordOf(row.metadata)
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind as PaymentIntentKind,
    purpose: row.purpose as PaymentIntentPurpose,
    reference_code: row.reference_code,
    amount_paise: row.amount_paise,
    note: stringOf(metadata.note),
    provider_ref: row.provider_ref,
    created_at: row.created_at,
    expires_at: row.expires_at,
    metadata,
  }
}

/** Loads an intent the member can see (other stores' intents are 404). */
export async function loadIntent(
  tx: Tx,
  ctx: Ctx,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<IntentRow> {
  if (!isUuid(id)) throw notFound('payment_intent', id)
  let q = intentQuery(tx, ctx).where('i.id', '=', id)
  if (opts.forUpdate) q = q.forUpdate(['i'])
  const row = await q.executeTakeFirst()
  if (!row || !canAccessStore(ctx, row.store_id)) throw notFound('payment_intent', id)
  return row
}

export async function getIntent(tx: Tx, ctx: Ctx, id: string): Promise<PaymentIntent> {
  return toIntent(await loadIntent(tx, ctx, id))
}

// ---------------------------------------------------------------------------------------------
// List (reconciliation)
// ---------------------------------------------------------------------------------------------

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * WHERE fragments over `payment_intents i` (shared by the page and the summary). The date range
 * applies to the paid instant of paid intents and the creation instant of the others.
 */
async function intentConditions(tx: Tx, ctx: Ctx, q: ListQuery): Promise<RawBuilder<unknown>[]> {
  const c: RawBuilder<unknown>[] = [sql`i.tenant_id = ${ctx.tenantId}`]
  if (ctx.storeIds !== null) {
    const ids = [...ctx.storeIds]
    c.push(ids.length ? sql`i.store_id = any(${ids}::uuid[])` : sql`false`)
  }
  if (q.store_id) {
    assertStoreAccess(ctx, q.store_id)
    c.push(sql`i.store_id = ${q.store_id}`)
  }
  if (q.status?.length) c.push(sql`i.status = any(${q.status}::text[])`)
  if (q.provider?.length) c.push(sql`i.provider = any(${q.provider}::text[])`)
  if (q.purpose?.length) c.push(sql`i.purpose = any(${q.purpose}::text[])`)
  if (q.provider_account_id) c.push(sql`i.provider_account_id = ${q.provider_account_id}`)
  if (q.register_id) c.push(sql`i.register_id = ${q.register_id}`)
  if (q.customer_id) c.push(sql`i.customer_id = ${q.customer_id}`)
  if (q.unapplied === true) c.push(sql`(i.status = 'paid' and i.payment_id is null)`)
  if (q.unapplied === false) c.push(sql`not (i.status = 'paid' and i.payment_id is null)`)
  if (q.from || q.to) {
    const tz = (await tenantCalendar(tx, ctx)).timezone
    const range = dateRangeInstants(q.from, q.to, tz)
    if (range.start) c.push(sql`coalesce(i.paid_at, i.created_at) >= ${range.start}`)
    if (range.end) c.push(sql`coalesce(i.paid_at, i.created_at) < ${range.end}`)
  }
  if (q.q) {
    const like = `%${escapeLike(q.q)}%`
    c.push(sql`(i.reference_code ilike ${like} or i.utr ilike ${like} or i.payer_vpa ilike ${like}
      or i.provider_ref ilike ${like} or i.provider_payment_id ilike ${like})`)
  }
  return c
}

const SORT_SQL: Readonly<Record<ListQuery['sort']['field'], string>> = {
  created_at: 'i.created_at',
  paid_at: 'i.paid_at',
  amount_paise: 'i.amount_paise',
  status: 'i.status',
}

export async function listIntents(
  tx: Tx,
  ctx: Ctx,
  q: ListQuery,
): Promise<PaymentIntentListResponse> {
  const page = parsePage(q)
  const conds = await intentConditions(tx, ctx, q)
  const where = sql.join(conds, sql` and `)
  const dir = q.sort.direction === 'desc' ? sql.raw('desc') : sql.raw('asc')
  const rows = await intentQuery(tx, ctx)
    .where(sql<boolean>`${where}`)
    .select(sql<number>`count(*) over()`.as('__total'))
    .orderBy(sql`${sql.raw(SORT_SQL[q.sort.field])} ${dir} nulls last`)
    .orderBy(sql`i.created_at ${dir}`)
    .orderBy(sql`i.id ${dir}`)
    .limit(page.limit)
    .offset(page.offset)
    .execute()
  let total = rows[0] ? Number(rows[0].__total) : 0
  if (rows.length === 0 && page.offset > 0) {
    const c = await sql<{
      n: number
    }>`select count(*) as n from payment_intents i where ${where}`.execute(tx)
    total = Number(c.rows[0]?.n ?? 0)
  }
  const byStatus = await sql<{ status: string; n: number; amount: number }>`
    select i.status, count(*) as n, coalesce(sum(i.amount_paise), 0)::bigint as amount
      from payment_intents i where ${where} group by i.status order by i.status`.execute(tx)
  const totals = await sql<{
    paid_total: number
    unapplied_count: number
    unapplied_total: number
  }>`
    select
      coalesce(sum(coalesce(i.paid_amount_paise, i.amount_paise)) filter (where i.status = 'paid'), 0)::bigint as paid_total,
      count(*) filter (where i.status = 'paid' and i.payment_id is null) as unapplied_count,
      coalesce(sum(coalesce(i.paid_amount_paise, i.amount_paise)) filter (where i.status = 'paid' and i.payment_id is null), 0)::bigint as unapplied_total
      from payment_intents i where ${where}`.execute(tx)
  const byProvider = await sql<{
    provider_account_id: string
    provider: string
    display_name: string
    paid_count: number
    paid_total: number
  }>`
    select i.provider_account_id, i.provider, pa.display_name,
           count(*) as paid_count,
           coalesce(sum(coalesce(i.paid_amount_paise, i.amount_paise)), 0)::bigint as paid_total
      from payment_intents i
      join payment_provider_accounts pa on pa.tenant_id = i.tenant_id and pa.id = i.provider_account_id
     where ${where} and i.status = 'paid'
     group by i.provider_account_id, i.provider, pa.display_name
     order by paid_total desc, pa.display_name`.execute(tx)
  const t = totals.rows[0]
  const now = Date.now()
  return {
    data: rows.map((r) => toIntent(r, now)),
    page: { limit: page.limit, offset: page.offset, total },
    summary: {
      by_status: byStatus.rows.map((r) => ({
        status: r.status as PaymentIntentStatus,
        count: Number(r.n),
        amount_paise: Number(r.amount),
      })),
      paid_total_paise: Number(t?.paid_total ?? 0),
      unapplied_count: Number(t?.unapplied_count ?? 0),
      unapplied_total_paise: Number(t?.unapplied_total ?? 0),
      by_provider: byProvider.rows.map((r) => ({
        provider_account_id: r.provider_account_id,
        provider: r.provider as PaymentProviderCode,
        display_name: r.display_name,
        paid_count: Number(r.paid_count),
        paid_total_paise: Number(r.paid_total),
      })),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Provider account resolution
// ---------------------------------------------------------------------------------------------

export interface ResolvedAccount {
  id: string
  provider: PaymentProviderCode
  store_id: string | null
}

/**
 * The account an intent of `storeId` goes through: the explicit one (active, of that store or
 * all stores), else the store's default, else the all-stores default.
 */
export async function resolveProviderAccount(
  tx: Tx,
  ctx: Ctx,
  storeId: string,
  accountId: string | null | undefined,
): Promise<ResolvedAccount> {
  if (accountId) {
    const row = await tx
      .selectFrom('payment_provider_accounts')
      .select(['id', 'provider', 'store_id', 'is_active'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', accountId)
      .executeTakeFirst()
    if (!row || (row.store_id !== null && row.store_id !== storeId)) {
      throw reasonError(
        'UNPROCESSABLE',
        'The payment provider account does not serve this store',
        'provider_account_invalid',
        { provider_account_id: accountId },
      )
    }
    if (!row.is_active) {
      throw reasonError(
        'UNPROCESSABLE',
        'The payment provider account is inactive',
        'provider_account_inactive',
        {
          provider_account_id: accountId,
        },
      )
    }
    return { id: row.id, provider: row.provider as PaymentProviderCode, store_id: row.store_id }
  }
  const row = await tx
    .selectFrom('payment_provider_accounts')
    .select(['id', 'provider', 'store_id'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('is_active', '=', true)
    .where('is_default', '=', true)
    .where((eb) => eb.or([eb('store_id', '=', storeId), eb('store_id', 'is', null)]))
    .orderBy(sql`store_id is null`)
    .executeTakeFirst()
  if (!row) {
    throw reasonError(
      'UNPROCESSABLE',
      'No UPI payment account is set up for this store',
      'no_payment_provider',
      { store_id: storeId },
    )
  }
  return { id: row.id, provider: row.provider as PaymentProviderCode, store_id: row.store_id }
}

/** Plan feature + adapter availability of a provider for collecting money. */
async function assertProviderUsable(
  deps: IntentDeps,
  ctx: Ctx,
  provider: PaymentProviderCode,
): Promise<PaymentProvider> {
  const caps = PROVIDER_CAPABILITIES[provider]
  if (!caps.implemented) {
    throw reasonError(
      'UNPROCESSABLE',
      `No adapter for the ${provider} provider`,
      'provider_not_implemented',
    )
  }
  await assertFeature(ctx, isDynamicProvider(provider) ? 'upi_dynamic' : 'upi_static')
  return getProvider(provider, deps)
}

// ---------------------------------------------------------------------------------------------
// Opening an intent (POST /payments/intents, POST /payments/links)
// ---------------------------------------------------------------------------------------------

export interface OpenIntentInput {
  kind: 'qr' | 'link'
  purpose: PaymentIntentPurpose
  store_id: string
  register_id?: string | null
  ref_type?: PaymentIntentRefType | null
  ref_id?: string | null
  customer_id?: string | null
  provider_account_id?: string | null
  amount_paise: number
  note?: string | null
  idempotency_key?: string | null
  /** Lifetime (default settings.payments.intent_expiry_seconds). */
  lifetime_seconds?: number
  /** Extra metadata stored with the intent. */
  metadata?: Record<string, unknown>
  /** Recipient of a provider-hosted link (default: the customer's name and phone). */
  link_customer?: ProviderCustomer | null
}

export interface OpenIntentHooks {
  /** Runs in the transaction that turns the intent pending (e.g. queue a notification). */
  onPending?: (tx: Tx, row: IntentRow) => Promise<Record<string, unknown> | void>
}

export interface OpenIntentResult {
  row: IntentRow
  replayed: boolean
}

function sameRequest(row: IntentRow, input: OpenIntentInput): boolean {
  return (
    row.kind === input.kind &&
    row.purpose === input.purpose &&
    row.store_id === input.store_id &&
    row.amount_paise === input.amount_paise &&
    (row.ref_type ?? null) === (input.ref_type ?? null) &&
    (row.ref_id ?? null) === (input.ref_id ?? null) &&
    (input.customer_id == null || row.customer_id === input.customer_id) &&
    (input.provider_account_id == null || row.provider_account_id === input.provider_account_id)
  )
}

function mismatch(key: string, intentId: string): AppError {
  return new AppError(
    'IDEMPOTENCY_MISMATCH',
    'The idempotency key was used for a different payment intent',
    {
      idempotency_key: key,
      intent_id: intentId,
    },
  )
}

/** Default UPI note: shop name + reference (≤ 50 characters). */
function defaultNote(shopName: string, reference: string): string {
  const room = 50 - reference.length - 1
  const name = [...shopName].slice(0, Math.max(0, room)).join('').trim()
  return name ? `${name} ${reference}` : reference
}

interface Claimed {
  row: IntentRow
  /** Provider step still to run (fresh intent or a takeover of a dead attempt). */
  run: boolean
  account: ProviderAccountRuntime | null
  customer: ProviderCustomer | null
}

async function validateRefs(
  tx: Tx,
  ctx: Ctx,
  input: OpenIntentInput,
): Promise<{ customer_id: string | null }> {
  let customerId = input.customer_id ?? null
  if (input.ref_type === 'sales_invoice' && input.ref_id) {
    const inv = await tx
      .selectFrom('sales_invoices')
      .select(['id', 'store_id', 'status', 'doc_type', 'customer_id', 'due_paise'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', input.ref_id)
      .executeTakeFirst()
    if (!inv) throw notFound('sales_invoice', input.ref_id)
    if (inv.store_id !== input.store_id) {
      throw reasonError('UNPROCESSABLE', 'The bill belongs to another store', 'invoice_store', {
        invoice_store_id: inv.store_id,
      })
    }
    if (inv.status !== 'completed' || inv.doc_type === 'estimate' || inv.due_paise <= 0) {
      throw reasonError('UNPROCESSABLE', 'The bill has nothing due', 'invoice_not_payable', {
        status: inv.status,
        due_paise: inv.due_paise,
      })
    }
    if (input.amount_paise > inv.due_paise) {
      throw reasonError(
        'UNPROCESSABLE',
        'The amount is more than the bill due',
        'amount_exceeds_due',
        {
          due_paise: inv.due_paise,
          amount_paise: input.amount_paise,
        },
      )
    }
    if (customerId && inv.customer_id && customerId !== inv.customer_id) {
      throw reasonError(
        'UNPROCESSABLE',
        'The bill belongs to another customer',
        'customer_mismatch',
      )
    }
    customerId = customerId ?? inv.customer_id
  }
  if (input.ref_type === 'customer' && input.ref_id) {
    if (customerId && customerId !== input.ref_id) {
      throw reasonError(
        'UNPROCESSABLE',
        'ref_id and customer_id name different customers',
        'customer_mismatch',
      )
    }
    customerId = input.ref_id
  }
  if (customerId) {
    const c = await tx
      .selectFrom('customers')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', customerId)
      .executeTakeFirst()
    if (!c) throw notFound('customer', customerId)
  }
  if (input.register_id) {
    const reg = await tx
      .selectFrom('registers')
      .select(['store_id'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', input.register_id)
      .executeTakeFirst()
    if (!reg) throw notFound('register', input.register_id)
    if (reg.store_id !== input.store_id) {
      throw reasonError('UNPROCESSABLE', 'The register belongs to another store', 'register_store')
    }
  }
  return { customer_id: customerId }
}

async function customerOf(tx: Tx, ctx: Ctx, id: string | null): Promise<ProviderCustomer | null> {
  if (!id) return null
  const c = await tx
    .selectFrom('customers')
    .select(['name', 'phone'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst()
  return c ? { name: c.name, phone: c.phone } : null
}

async function claimIntent(
  deps: IntentDeps,
  tx: Tx,
  ctx: Ctx,
  input: OpenIntentInput,
): Promise<Claimed> {
  assertStoreAccess(ctx, input.store_id)
  const key = input.idempotency_key ?? null
  const replay = async (existing: IntentRow): Promise<Claimed> => {
    if (!sameRequest(existing, input)) throw mismatch(key ?? '', existing.id)
    if (existing.status === 'created') {
      const taken = await tx
        .updateTable('payment_intents')
        .set({ updated_at: new Date() })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', existing.id)
        .where('status', '=', 'created')
        .where(
          sql<boolean>`updated_at < now() - make_interval(secs => ${CREATED_TAKEOVER_SECONDS})`,
        )
        .returning('id')
        .executeTakeFirst()
      if (!taken) {
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'This payment intent is still being created',
          {
            intent_id: existing.id,
          },
        )
      }
      return {
        row: existing,
        run: true,
        account: await loadAccountRuntime(deps, tx, ctx, existing.provider_account_id),
        customer: input.link_customer ?? (await customerOf(tx, ctx, existing.customer_id)),
      }
    }
    return { row: existing, run: false, account: null, customer: null }
  }
  if (key) {
    const existing = await intentQuery(tx, ctx)
      .where('i.idempotency_key', '=', key)
      .executeTakeFirst()
    if (existing) return replay(existing)
  }
  const store = await tx
    .selectFrom('stores')
    .select(['id', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', input.store_id)
    .executeTakeFirst()
  if (!store) throw notFound('store', input.store_id)
  if (!store.is_active)
    throw reasonError('UNPROCESSABLE', 'The store is inactive', 'store_inactive')
  const { customer_id } = await validateRefs(tx, ctx, input)
  const resolved = await resolveProviderAccount(tx, ctx, input.store_id, input.provider_account_id)
  const caps = PROVIDER_CAPABILITIES[resolved.provider]
  await assertProviderUsable(deps, ctx, resolved.provider)
  if (input.kind === 'qr' && !caps.dynamic_qr && resolved.provider !== 'upi_vpa') {
    throw reasonError('UNPROCESSABLE', 'This provider cannot show a payment QR', 'provider_no_qr')
  }
  if (input.kind === 'link' && !caps.links && resolved.provider !== 'upi_vpa') {
    throw reasonError(
      'UNPROCESSABLE',
      'This provider cannot create payment links',
      'provider_no_links',
    )
  }
  const account = await loadAccountRuntime(deps, tx, ctx, resolved.id)
  const settings = await getSettings(tx, ctx)
  const lifetime = input.lifetime_seconds ?? settings.payments.intent_expiry_seconds
  const shop = await loadShop(tx, ctx)
  const id = newId()
  const reference = generateReferenceCode()
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    note: input.note?.trim() || defaultNote(shop.name, reference),
  }
  if (resolved.provider === 'mock') metadata.delay_ms = account.config.auto_pay_delay_ms ?? 0
  const inserted = await tx
    .insertInto('payment_intents')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: input.store_id,
      register_id: input.register_id ?? null,
      provider_account_id: resolved.id,
      provider: resolved.provider,
      kind: input.kind,
      purpose: input.purpose,
      ref_type: input.ref_type ?? null,
      ref_id: input.ref_id ?? null,
      customer_id,
      reference_code: reference,
      amount_paise: input.amount_paise,
      status: 'created',
      expires_at: new Date(Date.now() + lifetime * 1000),
      metadata: jsonb(metadata),
      idempotency_key: key,
      created_by: ctx.userId,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst()
  if (!inserted && key) {
    // A concurrent request with the same key won the insert.
    const existing = await intentQuery(tx, ctx)
      .where('i.idempotency_key', '=', key)
      .executeTakeFirstOrThrow()
    return replay(existing)
  }
  const row = await intentQuery(tx, ctx).where('i.id', '=', id).executeTakeFirstOrThrow()
  return {
    row,
    run: true,
    account,
    customer: input.link_customer ?? (await customerOf(tx, ctx, customer_id)),
  }
}

/** Kadai pay page URL of a dues link. */
export function payPageUrl(publicBaseUrl: string, referenceCode: string): string {
  return `${publicBaseUrl}/pay/${referenceCode}`
}

interface ProviderOutcome {
  upi_uri: string | null
  image_url: string | null
  short_url: string | null
  provider_ref: string | null
}

async function providerStep(
  deps: IntentDeps,
  account: ProviderAccountRuntime,
  row: IntentRow,
  customer: ProviderCustomer | null,
): Promise<ProviderOutcome> {
  const intent = providerIntentOf(row)
  const adapter = getProvider(account.provider, deps)
  if (row.kind === 'link') {
    if (account.provider === 'upi_vpa') {
      return {
        upi_uri: vpaIntentUri(account, intent),
        image_url: null,
        short_url: payPageUrl(deps.config.publicBaseUrl, row.reference_code),
        provider_ref: null,
      }
    }
    const link = await adapter.createLink(
      account,
      intent,
      customer ?? { name: 'Customer', phone: null },
    )
    return {
      upi_uri: null,
      image_url: null,
      short_url: link.short_url,
      provider_ref: link.provider_ref,
    }
  }
  const qr = await adapter.createQr(account, intent)
  return {
    upi_uri: qr.upi_uri,
    image_url: qr.image_url,
    short_url: null,
    provider_ref: qr.provider_ref,
  }
}

function creationFailure(row: IntentRow): AppError {
  const meta = recordOf(row.metadata)
  return new AppError(
    'PROVIDER_ERROR',
    row.failure_reason ?? 'The payment provider could not create the QR',
    {
      provider: row.provider,
      provider_error_code: stringOf(meta.provider_error_code),
      intent_id: row.id,
      reason: 'intent_failed',
    },
  )
}

/**
 * Opens an intent (see the module comment). Returns the intent row; throws PROVIDER_ERROR after
 * recording the intent as failed when the provider call fails.
 */
export async function openIntent(
  deps: IntentDeps,
  ctx: Ctx,
  input: OpenIntentInput,
  hooks: OpenIntentHooks = {},
): Promise<OpenIntentResult> {
  const claimed = await withTenant(deps.db.appDb, ctx, (tx) => claimIntent(deps, tx, ctx, input))
  if (!claimed.run || !claimed.account) {
    const row = claimed.row
    if (row.status === 'failed' && recordOf(row.metadata).creation_failed === true) {
      throw creationFailure(row)
    }
    return { row, replayed: true }
  }
  let outcome: ProviderOutcome
  try {
    outcome = await providerStep(deps, claimed.account, claimed.row, claimed.customer)
  } catch (err) {
    const failed = await withTenant(deps.db.appDb, ctx, async (tx) => {
      const meta = recordOf(claimed.row.metadata)
      const code = isProviderFailure(err) ? err.details?.provider_error_code : null
      await tx
        .updateTable('payment_intents')
        .set({
          status: 'failed',
          failure_reason: errorText(err),
          metadata: jsonb({
            ...meta,
            creation_failed: true,
            provider_error_code: typeof code === 'string' ? code : null,
          }),
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', claimed.row.id)
        .where('status', '=', 'created')
        .execute()
      await notifyIntent(tx, ctx.tenantId, claimed.row.id, 'failed')
      return intentQuery(tx, ctx).where('i.id', '=', claimed.row.id).executeTakeFirstOrThrow()
    })
    deps.metrics.paymentIntents.inc({ provider: failed.provider, status: 'failed' })
    deps.logger.warn(
      { err, intent_id: failed.id, provider: failed.provider },
      'payment intent creation failed',
    )
    if (isProviderFailure(err)) {
      throw new AppError(
        'PROVIDER_ERROR',
        err.message,
        { ...(err.details ?? {}), intent_id: failed.id },
        { cause: err },
      )
    }
    throw err
  }
  const opened = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const updated = await tx
      .updateTable('payment_intents')
      .set({
        status: 'pending',
        upi_uri: outcome.upi_uri,
        image_url: outcome.image_url,
        short_url: outcome.short_url,
        provider_ref: outcome.provider_ref,
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', claimed.row.id)
      .where('status', '=', 'created')
      .returning('id')
      .executeTakeFirst()
    if (!updated && outcome.provider_ref) {
      // Cancelled / expired / paid while the provider call ran: keep the provider reference so
      // the expire job can still close the QR / link at the provider (and late payments match).
      await tx
        .updateTable('payment_intents')
        .set({
          provider_ref: outcome.provider_ref,
          upi_uri: outcome.upi_uri,
          image_url: outcome.image_url,
          short_url: outcome.short_url,
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', claimed.row.id)
        .where('provider_ref', 'is', null)
        .execute()
    }
    let current = await intentQuery(tx, ctx)
      .where('i.id', '=', claimed.row.id)
      .executeTakeFirstOrThrow()
    if (updated && hooks.onPending) {
      const extra = await hooks.onPending(tx, current)
      if (extra && Object.keys(extra).length) {
        await tx
          .updateTable('payment_intents')
          .set({ metadata: jsonb({ ...recordOf(current.metadata), ...extra }) })
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', current.id)
          .execute()
        current = await intentQuery(tx, ctx)
          .where('i.id', '=', current.id)
          .executeTakeFirstOrThrow()
      }
    }
    if (updated) await notifyIntent(tx, ctx.tenantId, current.id, 'pending')
    return { current, opened: Boolean(updated) }
  })
  const row = opened.current
  if (opened.opened) deps.metrics.paymentIntents.inc({ provider: row.provider, status: 'pending' })
  if (
    row.status === 'pending' &&
    row.provider_ref &&
    isPollingProvider(row.provider as PaymentProviderCode)
  ) {
    await enqueueSafely(
      deps.logger,
      POLL_JOB,
      {},
      {
        startAfter: 3,
        singletonKey: `${POLL_JOB}:soon`,
        singletonSeconds: 3,
      },
    )
  }
  return { row, replayed: false }
}

// ---------------------------------------------------------------------------------------------
// Cancel / confirm / mock-pay / apply
// ---------------------------------------------------------------------------------------------

/** POST /payments/intents/:id/cancel — closes the QR / link at the provider (best effort). */
export async function cancelIntent(
  deps: IntentDeps,
  ctx: Ctx,
  id: string,
  reason: string | undefined,
): Promise<PaymentIntent> {
  const first = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const row = await loadIntent(tx, ctx, id)
    if (row.status === 'paid') {
      throw reasonError('CONFLICT', 'The intent is already paid', 'intent_paid')
    }
    if (row.status !== 'created' && row.status !== 'pending' && row.status !== 'cancelled') {
      throw reasonError('CONFLICT', `The intent is ${row.status}`, 'intent_not_open', {
        status: row.status,
      })
    }
    const account =
      row.status !== 'cancelled' && row.provider_ref
        ? await loadAccountRuntime(deps, tx, ctx, row.provider_account_id)
        : null
    return { row, account }
  })
  if (first.row.status === 'cancelled') return toIntent(first.row)
  let closedAt: Date | null = null
  if (first.account && first.row.provider_ref) {
    const adapter = getProvider(first.account.provider, deps)
    const intent = providerIntentOf(first.row)
    if (adapter.capabilities.polling) {
      // A payment may have arrived without its webhook: never cancel paid money.
      const status = await adapter.fetchStatus(first.account, intent).catch((err: unknown) => {
        deps.logger.warn({ err, intent_id: id }, 'status check before cancel failed')
        return null
      })
      if (status?.status === 'paid') {
        await withTenant(deps.db.appDb, ctx, (tx) =>
          markIntentPaid(
            tx,
            ctx,
            { intent_id: id, confirmation: 'poll', payment: status },
            { metrics: deps.metrics },
          ),
        )
        throw reasonError('CONFLICT', 'The intent was paid meanwhile', 'intent_paid')
      }
    }
    try {
      await adapter.cancel(first.account, intent)
      closedAt = new Date()
    } catch (err) {
      deps.logger.warn(
        { err, intent_id: id },
        'closing the QR at the provider failed (retried by the expire job)',
      )
    }
  }
  return withTenant(deps.db.appDb, ctx, async (tx) => {
    const row = await loadIntent(tx, ctx, id, { forUpdate: true })
    if (row.status === 'paid')
      throw reasonError('CONFLICT', 'The intent is already paid', 'intent_paid')
    if (row.status !== 'created' && row.status !== 'pending') return toIntent(row)
    await tx
      .updateTable('payment_intents')
      .set({
        status: 'cancelled',
        failure_reason: reason ? `cancelled: ${reason}` : null,
        provider_closed_at: closedAt,
        close_attempts: closedAt ? 0 : row.close_attempts + 1,
        metadata: jsonb({
          ...recordOf(row.metadata),
          cancel_reason: reason ?? null,
          cancelled_by: ctx.userId,
        }),
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    await notifyIntent(tx, ctx.tenantId, id, 'cancelled')
    deps.metrics.paymentIntents.inc({ provider: row.provider, status: 'cancelled' })
    return toIntent(await loadIntent(tx, ctx, id))
  })
}

/** POST /payments/intents/:id/confirm — manual confirmation of a UPI ID payment (audited). */
export async function confirmIntent(
  deps: IntentDeps,
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: ConfirmBody,
): Promise<PaymentIntent> {
  const row = await loadIntent(tx, ctx, id, { forUpdate: true })
  if (!PROVIDER_CAPABILITIES[row.provider as PaymentProviderCode]?.manual_confirm) {
    throw reasonError(
      'UNPROCESSABLE',
      'Only UPI ID payments are confirmed by hand; this provider confirms automatically',
      'manual_confirm_not_supported',
      { provider: row.provider },
    )
  }
  if (row.status === 'paid')
    throw reasonError('CONFLICT', 'The intent is already paid', 'intent_paid')
  if (row.status !== 'pending' && row.status !== 'created' && row.status !== 'expired') {
    throw reasonError('CONFLICT', `The intent is ${row.status}`, 'intent_not_open', {
      status: row.status,
    })
  }
  const utr = body.utr ?? null
  if (utr) {
    const other = await tx
      .selectFrom('payment_intents')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('utr', '=', utr)
      .where('status', '=', 'paid')
      .where('id', '<>', id)
      .executeTakeFirst()
    if (other) {
      throw reasonError(
        'CONFLICT',
        'This UTR already confirmed another payment',
        'utr_already_used',
        {
          intent_id: other.id,
        },
      )
    }
  }
  const received = body.paid_amount_paise ?? row.amount_paise
  await markIntentPaid(
    tx,
    ctx,
    {
      intent_id: id,
      confirmation: 'manual',
      confirmed_by: ctx.userId,
      payment: {
        provider_payment_id: null,
        amount_paise: received,
        payer_vpa: body.payer_vpa ?? null,
        payer_name: null,
        utr,
        fee_paise: null,
        paid_at: new Date(),
      },
    },
    { metrics: deps.metrics },
  )
  await audit(tx, ctx, {
    action: 'payment_intent.confirm',
    entity_type: 'payment_intent',
    entity_id: id,
    summary: `UPI payment ${row.reference_code} of ${received} paise confirmed by hand${utr ? ` (UTR ${utr})` : ''}`,
    changes: {
      amount_paise: row.amount_paise,
      paid_amount_paise: received,
      utr,
      payer_vpa: body.payer_vpa ?? null,
      note: body.note ?? null,
      previous_status: row.status,
    },
  })
  return toIntent(await loadIntent(tx, ctx, id))
}

/** POST /payments/intents/:id/mock-pay — dev/test only. */
export async function mockPayIntent(
  deps: IntentDeps,
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: MockPayBody,
): Promise<PaymentIntent> {
  if (!deps.config.enableMockPayments) {
    throw new AppError('NOT_FOUND', 'Mock payments are disabled on this server', {
      reason: 'mock_payments_disabled',
    })
  }
  const row = await loadIntent(tx, ctx, id, { forUpdate: true })
  if (row.provider !== 'mock') {
    throw reasonError('UNPROCESSABLE', 'Only mock intents can be paid this way', 'not_mock_intent')
  }
  if (body.outcome === 'failed') {
    if (row.status !== 'created' && row.status !== 'pending') {
      throw reasonError('CONFLICT', `The intent is ${row.status}`, 'intent_not_open', {
        status: row.status,
      })
    }
    await tx
      .updateTable('payment_intents')
      .set({ status: 'failed', failure_reason: 'mock_failed: payment declined (simulated)' })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    await notifyIntent(tx, ctx.tenantId, id, 'failed')
    deps.metrics.paymentIntents.inc({ provider: 'mock', status: 'failed' })
  } else {
    const payment = mockPayment(row, body.amount_paise)
    await markIntentPaid(
      tx,
      ctx,
      {
        intent_id: id,
        confirmation: 'webhook',
        payment: {
          ...payment,
          payer_vpa: body.payer_vpa ?? MOCK_PAYER_VPA,
          utr: body.utr ?? payment.utr,
        },
      },
      { metrics: deps.metrics },
    )
  }
  return toIntent(await loadIntent(tx, ctx, id))
}

/**
 * POST /payments/intents/:id/apply — consumes a paid, unapplied intent: a receipt for the
 * invoice (the part above its due becomes the invoice customer's advance) or for a customer
 * (FIFO over their dues, the rest advance). Audited.
 */
export async function applyIntent(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: ApplyBody,
): Promise<{ intent: PaymentIntent; payment: PaymentDetail }> {
  const row = await loadIntent(tx, ctx, id, { forUpdate: true })
  if (row.status !== 'paid') {
    throw reasonError('UNPROCESSABLE', 'The intent is not paid', 'intent_not_paid', {
      status: row.status,
    })
  }
  if (row.payment_id) {
    throw reasonError('CONFLICT', 'The intent was already used', 'intent_used', {
      payment_id: row.payment_id,
    })
  }
  const received = row.paid_amount_paise ?? row.amount_paise
  const paymentDate = body.payment_date ?? (await tenantDateOf(tx, ctx, row.paid_at ?? new Date()))
  let party: { type: 'customer'; id: string } | null
  let allocations: {
    target_type: 'sales_invoice' | 'opening_balance' | 'debit_note'
    target_id: string
    amount_paise: number
  }[]
  if (body.target_type === 'sales_invoice') {
    const inv = await tx
      .selectFrom('sales_invoices')
      .select(['id', 'number', 'status', 'doc_type', 'customer_id', 'due_paise'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', body.target_id)
      .executeTakeFirst()
    if (!inv) throw notFound('sales_invoice', body.target_id)
    if (inv.status !== 'completed' || inv.doc_type === 'estimate' || inv.due_paise <= 0) {
      throw reasonError('UNPROCESSABLE', 'The bill has nothing due', 'invoice_not_payable', {
        status: inv.status,
        due_paise: inv.due_paise,
      })
    }
    if (received > inv.due_paise && !inv.customer_id) {
      throw reasonError(
        'UNPROCESSABLE',
        'The payment is more than the due of a walk-in bill; apply it to a customer instead',
        'intent_exceeds_due',
        { due_paise: inv.due_paise, amount_paise: received },
      )
    }
    party = inv.customer_id ? { type: 'customer', id: inv.customer_id } : null
    allocations = [
      {
        target_type: 'sales_invoice',
        target_id: inv.id,
        amount_paise: Math.min(received, inv.due_paise),
      },
    ]
  } else {
    const fifo = await fifoAllocations(tx, ctx, {
      party_type: 'customer',
      party_id: body.target_id,
      direction: 'in',
      amount_paise: received,
    })
    party = { type: 'customer', id: body.target_id }
    allocations = fifo.allocations.map((a) => ({
      target_type: a.target_type as 'sales_invoice' | 'opening_balance' | 'debit_note',
      target_id: a.target_id,
      amount_paise: a.amount_paise,
    }))
  }
  const payment = await recordPayment(tx, ctx, {
    direction: 'in',
    store_id: row.store_id,
    method: 'upi',
    amount_paise: received,
    payment_date: paymentDate,
    party,
    payment_intent_id: id,
    allocations,
    notes: body.notes ?? `UPI ${row.reference_code}`,
    number: true,
    paid_at: row.paid_at ?? new Date(),
  })
  await audit(tx, ctx, {
    action: 'payment_intent.apply',
    entity_type: 'payment_intent',
    entity_id: id,
    summary: `UPI payment ${row.reference_code} of ${received} paise applied to ${body.target_type} → receipt ${payment.number ?? payment.id}`,
    changes: {
      target_type: body.target_type,
      target_id: body.target_id,
      payment_id: payment.id,
      allocations,
    },
  })
  await notifyIntent(tx, ctx.tenantId, id, 'paid')
  return {
    intent: toIntent(await loadIntent(tx, ctx, id)),
    payment: await getPaymentDetail(tx, ctx, payment.id),
  }
}
