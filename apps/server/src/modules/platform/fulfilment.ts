/**
 * Fulfilment of paid cloud-plan orders (vendor_orders kind 'cloud_plan') and bookkeeping of
 * Razorpay subscription charges: gapless GST invoice numbers (KD/<FY>/<seq>), offer
 * redemptions, the paid service period, the tenant's live subscription and plan.
 *
 * Runs inside the SYSTEM transaction of the Razorpay webhook (or of a ₹0 checkout): the vendor
 * tables and system_settings are revoked from the runtime role, and the whole fulfilment must
 * commit atomically with the webhook's dedup row.
 */
import { z } from 'zod'
import { type BillingCycle, newId, roundDiv, splitGst, toDateStr } from '@kadai/shared'
import {
  type PricedOrderLine,
  PricedOrderLineSchema,
  SAC_SOFTWARE,
  VENDOR_GST_RATE_BP,
  formatVendorInvoiceNumber,
  vendorInvoiceCounterKey,
  vendorInvoiceFy,
} from '@kadai/shared/api/licensing'
import { cloudPlanProductCode } from '@kadai/shared/api/platform'
import { audit } from '../../core/audit'
import { systemContext } from '../../core/context'
import type { EntitlementsService } from '../../core/entitlements'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import type { BillingBuyer, CloudPlan, Redemption } from './catalog'
import {
  type SubscriptionRow,
  activateSubscription,
  loadLiveSubscription,
  setTenantPlan,
} from './subscriptions'
import { BILLING_TZ, addMonthsInstant, maxDate, parseCloudPlanProductCode } from './util'

export interface FulfilmentDeps {
  entitlements: Pick<EntitlementsService, 'invalidate'>
}

// ---------------------------------------------------------------------------------------------
// Invoice numbers
// ---------------------------------------------------------------------------------------------

/** Reads the counter value of a vendor_invoice_seq row (a JSON number, or {value|seq: n}). */
function readCounter(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (value && typeof value === 'object') {
    const v = (value as Record<string, unknown>).value ?? (value as Record<string, unknown>).seq
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v
  }
  throw new Error('vendor invoice counter holds an unexpected value')
}

function writeCounter(previous: unknown, next: number): unknown {
  if (previous && typeof previous === 'object') {
    const key = 'value' in (previous as Record<string, unknown>) ? 'value' : 'seq'
    return { ...(previous as Record<string, unknown>), [key]: next }
  }
  return next
}

/**
 * Next gapless GST invoice number for `invoiceDate` (KD/2627/000001): locks the FY counter row
 * in system_settings (shared with the licensing module), increments it and returns the number.
 * Must run in the transaction that marks the order paid.
 */
export async function nextVendorInvoiceNumber(tx: Tx, invoiceDate: string): Promise<string> {
  const fy = vendorInvoiceFy(invoiceDate)
  const key = vendorInvoiceCounterKey(fy)
  await tx
    .insertInto('system_settings')
    .values({ key, value: jsonb(0) })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()
  const row = await tx
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', key)
    .forUpdate()
    .executeTakeFirstOrThrow()
  const next = readCounter(row.value) + 1
  await tx
    .updateTable('system_settings')
    .set({ value: jsonb(writeCounter(row.value, next)) })
    .where('key', '=', key)
    .execute()
  return formatVendorInvoiceNumber(fy, next)
}

// ---------------------------------------------------------------------------------------------
// Orders & checkouts
// ---------------------------------------------------------------------------------------------

export interface OrderRow {
  id: string
  number: string | null
  kind: string
  status: string
  tenant_id: string | null
  customer_id: string | null
  lines: PricedOrderLine[]
  offer_ids: string[]
  total_paise: number
  payment_ref: string | null
  paid_at: Date | null
}

export async function lockOrder(tx: Tx, orderId: string): Promise<OrderRow | null> {
  const row = await tx
    .selectFrom('vendor_orders')
    .select([
      'id',
      'number',
      'kind',
      'status',
      'tenant_id',
      'customer_id',
      'lines',
      'offer_ids',
      'total_paise',
      'payment_ref',
      'paid_at',
    ])
    .where('id', '=', orderId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) return null
  const lines = z.array(PricedOrderLineSchema).safeParse(row.lines)
  return { ...row, lines: lines.success ? lines.data : [] }
}

const RedemptionsSchema = z.array(z.object({ offer_id: z.uuid(), discount_paise: z.int().min(0) }))

export interface CheckoutRow {
  id: string
  tenant_id: string
  mode: 'payment_link' | 'subscription'
  plan_code: string
  billing_cycle: BillingCycle
  auto_renew: boolean
  order_id: string | null
  covers_months: number | null
  redemptions: Redemption[]
  provider_ref: string
  status: string
  start_at: Date | null
}

const CHECKOUT_COLUMNS = [
  'id',
  'tenant_id',
  'mode',
  'plan_code',
  'billing_cycle',
  'auto_renew',
  'order_id',
  'covers_months',
  'redemptions',
  'provider_ref',
  'status',
  'start_at',
] as const

function checkoutQuery(tx: Tx) {
  return tx.selectFrom('platform_checkouts').select([...CHECKOUT_COLUMNS])
}
type RawCheckout = Awaited<ReturnType<ReturnType<typeof checkoutQuery>['executeTakeFirstOrThrow']>>

function toCheckout(r: RawCheckout): CheckoutRow {
  const redemptions = RedemptionsSchema.safeParse(r.redemptions)
  return {
    ...r,
    mode: r.mode === 'subscription' ? 'subscription' : 'payment_link',
    billing_cycle: r.billing_cycle === 'yearly' ? 'yearly' : 'monthly',
    redemptions: redemptions.success ? redemptions.data : [],
  }
}

export async function loadCheckoutByRef(tx: Tx, providerRef: string): Promise<CheckoutRow | null> {
  const row = await checkoutQuery(tx).where('provider_ref', '=', providerRef).executeTakeFirst()
  return row ? toCheckout(row) : null
}

export async function loadCheckoutByOrder(tx: Tx, orderId: string): Promise<CheckoutRow | null> {
  const row = await checkoutQuery(tx)
    .where('order_id', '=', orderId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ? toCheckout(row) : null
}

// ---------------------------------------------------------------------------------------------
// Paid terms
// ---------------------------------------------------------------------------------------------

/**
 * Where a newly paid prepaid term starts: after the running trial or prepaid period of the same
 * plan (renewals extend, nothing is lost), otherwise now. `period_start` is the start the live
 * subscription shows (kept when an active period is extended).
 */
export function paidTermStart(
  live: SubscriptionRow | null,
  planCode: string,
  now: Date,
): { base: Date; period_start: Date } {
  if (live && live.plan_code === planCode) {
    if (live.status === 'trialing') {
      return { base: maxDate(now, live.trial_ends_at ?? live.current_period_end), period_start: now }
    }
    if (live.status === 'active' && live.current_period_end.getTime() > now.getTime()) {
      return { base: live.current_period_end, period_start: live.current_period_start }
    }
  }
  return { base: now, period_start: now }
}

export interface PaymentInfo {
  provider: 'razorpay' | 'manual'
  /** Razorpay payment id / subscription id; null for a ₹0 order. */
  reference: string | null
  paid_at: Date
}

export interface FulfilledOrder {
  order_id: string
  number: string | null
  subscription_id: string
  plan_code: string
  period_start: Date
  period_end: Date
  /** Razorpay subscription to stop renewing after a prepaid purchase replaced it. */
  superseded_provider_subscription_id: string | null
}

/** What a paid cloud-plan order buys (from its checkout, else from the order lines). */
export interface OrderTerms {
  plan_code: string
  cycle: BillingCycle
  /** Months the payment covers (term + free months). */
  covers_months: number
  redemptions: Redemption[]
  /** platform_checkouts row to complete (null when the order has none). */
  checkout_id: string | null
}

export function orderTerms(order: OrderRow, checkout: CheckoutRow | null): OrderTerms | null {
  const line = order.lines[0]
  const parsed = line ? parseCloudPlanProductCode(line.product_code) : null
  const planCode = checkout?.plan_code ?? parsed?.plan_code
  if (!planCode) return null
  return {
    plan_code: planCode,
    cycle: checkout?.billing_cycle ?? parsed?.cycle ?? 'monthly',
    covers_months:
      checkout?.covers_months ?? (line ? (line.term_months ?? 1) + line.free_months : 1),
    redemptions:
      checkout?.redemptions ??
      order.offer_ids.map((offerId) => ({
        offer_id: offerId,
        discount_paise: order.lines
          .filter((l) => l.offer_ids.includes(offerId))
          .reduce(
            (sum, l) => sum + roundDiv(l.offer_discount_paise, Math.max(1, l.offer_ids.length)),
            0,
          ),
      })),
    checkout_id: checkout?.id ?? null,
  }
}

/**
 * Marks a cloud-plan order paid and fulfils it: invoice number (when the total is > 0), status
 * fulfilled, offer redemptions, paid period, live subscription and tenants.plan_code.
 *
 * `first_cycle` is set for the first-cycle order of a Razorpay subscription (free months /
 * discounted first cycle): the subscription becomes active until the first Razorpay charge.
 */
export async function fulfilPlanOrder(
  tx: Tx,
  deps: FulfilmentDeps,
  input: {
    order: OrderRow
    terms: OrderTerms
    payment: PaymentInfo
    now: Date
    request_id: string
    first_cycle?: { provider_subscription_id: string; until: Date } | null
  },
): Promise<FulfilledOrder> {
  const { order, terms, now } = input
  if (!order.tenant_id) throw new Error(`cloud plan order ${order.id} has no tenant`)
  const tenantId = order.tenant_id
  const planCode = terms.plan_code
  const cycle = terms.cycle
  const months = terms.covers_months

  const live = await loadLiveSubscription(tx, tenantId, { forUpdate: true })
  let periodStart: Date
  let base: Date
  let end: Date
  if (input.first_cycle) {
    // Active until the first Razorpay charge (start_at); a late authorisation past start_at
    // still gets the months it paid for.
    base = now
    periodStart = now
    end =
      input.first_cycle.until.getTime() > now.getTime()
        ? input.first_cycle.until
        : addMonthsInstant(now, months)
  } else {
    const start = paidTermStart(live, planCode, now)
    base = start.base
    periodStart = start.period_start
    end = addMonthsInstant(base, months)
  }

  const number =
    order.total_paise > 0
      ? await nextVendorInvoiceNumber(tx, toDateStr(input.payment.paid_at, BILLING_TZ))
      : null
  await tx
    .updateTable('vendor_orders')
    .set({
      status: 'fulfilled',
      number,
      payment_provider: input.payment.provider,
      payment_ref: input.payment.reference,
      paid_at: input.payment.paid_at,
      fulfilled_at: now,
    })
    .where('id', '=', order.id)
    .execute()

  const superseded =
    !input.first_cycle && live?.provider_subscription_id ? live.provider_subscription_id : null
  const subscriptionId = await activateSubscription(tx, {
    tenant_id: tenantId,
    plan_code: planCode,
    billing_cycle: input.first_cycle ? 'monthly' : cycle,
    period_start: periodStart,
    period_end: end,
    provider: input.payment.provider,
    provider_subscription_id: input.first_cycle?.provider_subscription_id ?? null,
  })

  await tx
    .insertInto('platform_plan_periods')
    .values({
      order_id: order.id,
      tenant_id: tenantId,
      subscription_id: subscriptionId,
      plan_code: planCode,
      billing_cycle: input.first_cycle ? 'monthly' : cycle,
      period_start: base,
      period_end: end,
    })
    .onConflict((oc) => oc.column('order_id').doNothing())
    .execute()

  for (const r of terms.redemptions) {
    await tx
      .insertInto('offer_redemptions')
      .values({
        id: newId(),
        offer_id: r.offer_id,
        order_id: order.id,
        customer_id: order.customer_id,
        tenant_id: tenantId,
        discount_paise: r.discount_paise,
      })
      .onConflict((oc) => oc.columns(['offer_id', 'order_id']).doNothing())
      .execute()
  }

  if (terms.checkout_id) {
    await tx
      .updateTable('platform_checkouts')
      .set({ status: 'completed', completed_at: now })
      .where('id', '=', terms.checkout_id)
      .execute()
  }

  await setTenantPlan(tx, deps.entitlements, tenantId, planCode)
  await audit(tx, systemContext(tenantId, { requestId: input.request_id }), {
    action: 'billing.plan_paid',
    entity_type: 'vendor_order',
    entity_id: order.id,
    summary: `${planCode} ${cycle}${number ? ` — invoice ${number}` : ''}`,
    changes: {
      plan_code: planCode,
      billing_cycle: cycle,
      period_start: base.toISOString(),
      period_end: end.toISOString(),
      total_paise: order.total_paise,
      payment_ref: input.payment.reference,
    },
  })

  return {
    order_id: order.id,
    number,
    subscription_id: subscriptionId,
    plan_code: planCode,
    period_start: base,
    period_end: end,
    superseded_provider_subscription_id: superseded,
  }
}

// ---------------------------------------------------------------------------------------------
// Subscription charges (monthly auto-renew)
// ---------------------------------------------------------------------------------------------

/**
 * One invoice line for an amount charged incl. GST (Razorpay subscription plans are priced
 * incl. 18% GST): taxable = amount ÷ 1.18, GST split by place of supply.
 */
export function inclusiveChargeLine(input: {
  plan: Pick<CloudPlan, 'code' | 'name' | 'name_ta'> | null
  plan_code: string
  amount_paise: number
  is_interstate: boolean
}): PricedOrderLine {
  const rate = VENDOR_GST_RATE_BP
  const taxable = roundDiv(input.amount_paise * 10_000, 10_000 + rate)
  const tax = input.amount_paise - taxable
  const split = input.is_interstate ? { cgst_paise: 0, sgst_paise: 0 } : splitGst(tax)
  const name = input.plan?.name ?? input.plan_code
  return {
    key: '1',
    product_code: cloudPlanProductCode(input.plan_code, 'monthly'),
    kind: 'cloud_plan',
    name: `${name} — monthly`,
    name_ta: input.plan?.name_ta ? `${input.plan.name_ta} — மாதாந்திரம்` : null,
    qty: 1,
    unit_price_paise: taxable,
    term_months: 1,
    free_months: 0,
    gross_paise: taxable,
    partner_discount_paise: 0,
    offer_discount_paise: 0,
    discount_paise: 0,
    taxable_paise: taxable,
    gst_rate_bp: rate,
    cgst_paise: split.cgst_paise,
    sgst_paise: split.sgst_paise,
    igst_paise: input.is_interstate ? tax : 0,
    tax_paise: tax,
    total_paise: input.amount_paise,
    offer_ids: [],
    sac: SAC_SOFTWARE,
  }
}

/**
 * Records a Razorpay subscription charge as a paid, numbered cloud-plan order with its service
 * period. Idempotent per Razorpay payment id. Returns the order id (null for a ₹0 charge).
 */
export async function recordSubscriptionCharge(
  tx: Tx,
  input: {
    buyer: BillingBuyer
    plan: CloudPlan | null
    plan_code: string
    subscription_id: string
    payment_id: string
    amount_paise: number
    paid_at: Date
    period_start: Date
    period_end: Date
    vendor_state_code: string
    request_id: string
  },
): Promise<string | null> {
  if (input.amount_paise <= 0) return null
  const existing = await tx
    .selectFrom('vendor_orders')
    .select('id')
    .where('tenant_id', '=', input.buyer.tenant_id)
    .where('payment_ref', '=', input.payment_id)
    .executeTakeFirst()
  if (existing) return existing.id
  const line = inclusiveChargeLine({
    plan: input.plan,
    plan_code: input.plan_code,
    amount_paise: input.amount_paise,
    is_interstate: input.buyer.place_of_supply !== input.vendor_state_code,
  })
  const number = await nextVendorInvoiceNumber(tx, toDateStr(input.paid_at, BILLING_TZ))
  const id = newId()
  await tx
    .insertInto('vendor_orders')
    .values({
      id,
      number,
      kind: 'cloud_plan',
      customer_id: input.buyer.vendor_customer_id,
      tenant_id: input.buyer.tenant_id,
      lines: jsonb([line]),
      subtotal_paise: line.gross_paise,
      discount_paise: 0,
      taxable_paise: line.taxable_paise,
      cgst_paise: line.cgst_paise,
      sgst_paise: line.sgst_paise,
      igst_paise: line.igst_paise,
      total_paise: line.total_paise,
      place_of_supply: input.buyer.place_of_supply,
      buyer_gstin: input.buyer.gstin,
      status: 'fulfilled',
      payment_provider: 'razorpay',
      payment_ref: input.payment_id,
      paid_at: input.paid_at,
      fulfilled_at: input.paid_at,
      notes: 'Monthly auto-renew charge (Razorpay subscription)',
    })
    .execute()
  if (input.period_end.getTime() > input.period_start.getTime()) {
    await tx
      .insertInto('platform_plan_periods')
      .values({
        order_id: id,
        tenant_id: input.buyer.tenant_id,
        subscription_id: input.subscription_id,
        plan_code: input.plan_code,
        billing_cycle: 'monthly',
        period_start: input.period_start,
        period_end: input.period_end,
      })
      .execute()
  }
  await audit(tx, systemContext(input.buyer.tenant_id, { requestId: input.request_id }), {
    action: 'billing.subscription_charged',
    entity_type: 'vendor_order',
    entity_id: id,
    summary: `${input.plan_code} monthly — invoice ${number}`,
    changes: { total_paise: input.amount_paise, payment_ref: input.payment_id },
  })
  return id
}
