/**
 * Cloud billing routes (docs/API.md "platform, billing & system"; mode cloud, billing.manage):
 * plans, subscription overview, quotes, checkout (Razorpay payment link or subscription),
 * cancellation and our GST invoices.
 *
 * Vendor tables (license_products, offers, offer_redemptions, vendor_orders, vendor_customers,
 * platform_invoices) and system_settings are revoked from the runtime role, so handlers read and
 * write them through the SYSTEM database — always filtered by the caller's tenant id; tenant
 * tables (subscriptions, platform_checkouts, usage) go through the request's RLS transaction.
 */
import { sql } from 'kysely'
import {
  type BillingCycle,
  LIMIT_METRICS,
  addDays,
  addMonths,
  getState,
  instantRangeForDates,
  newId,
  toDateStr,
} from '@kadai/shared'
import {
  type InvoicePartySchema,
  OfferBannerSchema,
  type OfferPublic,
  type PriceQuote,
  type PricedOrderLine,
  VENDOR_GST_RATE_BP,
  type VendorInvoicePrint,
  invoiceTotals,
  priceWithGst,
} from '@kadai/shared/api/licensing'
import {
  type BillingInvoice,
  type BillingOverview,
  type BillingPlan,
  type BillingQuote,
  type CheckoutResponse,
  PAYMENT_LINK_TTL_HOURS,
  RAZORPAY_SUBSCRIPTION_TOTAL_COUNT,
  RECOMMENDED_CLOUD_PLAN,
  cloudPlanProductCode,
  daysLeft,
  platformRoutes,
  usageMeter,
  yearlySavings,
} from '@kadai/shared/api/platform'
import { RAZORPAY_NOTE_KEYS } from '@kadai/shared/api/licensing'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { countForLimit, toEntitlementsDto } from '../../core/entitlements'
import { AppError, notFound } from '../../core/errors'
import type { RouteImpls } from '../../core/http'
import { jsonb } from '../../db/json'
import { type Tx, withSystemTx } from '../../db/tenant'
import {
  type BillingBuyer,
  type CloudPlan,
  type OfferRecord,
  type Redemption,
  eligibleAutomaticOffers,
  isPurchasable,
  loadAutomaticOffers,
  loadBuyer,
  loadCloudPlans,
  loadCoupon,
  quotePlan,
  redemptionsOf,
} from './catalog'
import { fulfilPlanOrder, lockOrder, paidTermStart } from './fulfilment'
import type { RazorpayNotes } from './razorpay'
import type { PlatformRuntime } from './runtime'
import { razorpayPlanId } from './settings'
import {
  type SubscriptionRow,
  loadCurrentSubscription,
  loadLiveSubscription,
  subscriptionView,
} from './subscriptions'
import { BILLING_TZ, addMonthsInstant, iso, parseCloudPlanProductCode, periodEndDate } from './util'

type Routes = typeof platformRoutes
type InvoiceParty = z.output<typeof InvoicePartySchema>

const ALLOW_SUSPENDED = { allowSuspended: true } as const
/** A future first charge closer than this is charged immediately instead. */
const MIN_START_AT_LEAD_MS = 60 * 60 * 1000

function reasonError(
  code: 'UNPROCESSABLE' | 'CONFLICT' | 'PROVIDER_ERROR' | 'FORBIDDEN',
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): AppError {
  return new AppError(code, message, { reason, ...extra })
}

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

export function billingPlanDto(plan: CloudPlan, currentPlanCode: string): BillingPlan {
  const monthly = plan.display_monthly_paise
  const yearly = plan.display_yearly_paise
  const monthlyRate = plan.prices.monthly?.gst_rate_bp ?? VENDOR_GST_RATE_BP
  const yearlyRate = plan.prices.yearly?.gst_rate_bp ?? VENDOR_GST_RATE_BP
  const savings = yearlySavings(monthly, yearly)
  return {
    code: plan.code,
    name: plan.name,
    name_ta: plan.name_ta,
    description: plan.description,
    features: plan.features,
    limits: plan.limits,
    price_monthly_paise: monthly,
    price_yearly_paise: yearly,
    gst_rate_bp: yearlyRate,
    price_monthly_incl_gst_paise: priceWithGst(monthly, monthlyRate),
    price_yearly_incl_gst_paise: priceWithGst(yearly, yearlyRate),
    yearly_savings_paise: savings.savings_paise,
    yearly_savings_bp: savings.savings_bp,
    purchasable: isPurchasable(plan),
    is_current: plan.code === currentPlanCode,
    recommended: plan.code === RECOMMENDED_CLOUD_PLAN,
    sort_order: plan.sort_order,
    product_codes: {
      monthly: cloudPlanProductCode(plan.code, 'monthly'),
      yearly: cloudPlanProductCode(plan.code, 'yearly'),
    },
  }
}

export function offerPublicDto(o: OfferRecord): OfferPublic {
  const banner = o.banner == null ? null : OfferBannerSchema.safeParse(o.banner)
  const endsAt = o.ends_at == null ? null : o.ends_at instanceof Date ? o.ends_at.toISOString() : o.ends_at
  return {
    id: o.id,
    code: o.code,
    name: o.name,
    name_ta: o.name_ta ?? null,
    description: o.description,
    description_ta: o.description_ta,
    kind: o.kind,
    value: o.value,
    max_discount_paise: o.max_discount_paise ?? null,
    applies_to: [...(o.applies_to ?? [])],
    ends_at: endsAt,
    banner: banner?.success ? banner.data : null,
    automatic: o.code === null,
  }
}

function requirePlan(plans: readonly CloudPlan[], code: string, cycle: BillingCycle): CloudPlan {
  const plan = plans.find((p) => p.code === code)
  if (!plan || !isPurchasable(plan) || plan.prices[cycle] === null) {
    throw reasonError('UNPROCESSABLE', 'plan_not_purchasable', `Plan "${code}" cannot be bought ${cycle} online`, {
      plan_code: code,
      cycle,
    })
  }
  return plan
}

// ---------------------------------------------------------------------------------------------
// Pricing context
// ---------------------------------------------------------------------------------------------

interface PricingContext {
  plans: CloudPlan[]
  buyer: BillingBuyer
  offers: OfferRecord[]
}

async function pricingContext(rt: PlatformRuntime, tenantId: string, now: Date): Promise<PricingContext> {
  // systemDb: price book, vendor offers and the tenant's vendor-side history (system-only tables).
  const db = rt.deps.db.systemDb
  const [plans, buyer, offers] = await Promise.all([
    loadCloudPlans(db),
    loadBuyer(db, tenantId),
    loadAutomaticOffers(db, tenantId, now),
  ])
  return { plans, buyer, offers }
}

async function priceFor(
  rt: PlatformRuntime,
  ctx: PricingContext,
  input: { tenant_id: string; plan: CloudPlan; cycle: BillingCycle; coupon_code: string | null },
  now: Date,
): Promise<PriceQuote> {
  // systemDb: offers (coupon lookup) are vendor rows.
  const coupon = input.coupon_code
    ? await loadCoupon(rt.deps.db.systemDb, input.tenant_id, input.coupon_code)
    : null
  const quote = quotePlan({
    plan: input.plan,
    cycle: input.cycle,
    buyer: ctx.buyer,
    offers: ctx.offers,
    coupon,
    coupon_code: input.coupon_code,
    vendor_state_code: rt.settings.vendor.state_code,
    now,
  })
  if (!quote)
    throw reasonError('UNPROCESSABLE', 'plan_not_purchasable', 'Plan cannot be bought online', {
      plan_code: input.plan.code,
    })
  return quote
}

/** How a monthly auto-renew checkout is charged (see CheckoutRequestSchema). */
export interface AutoRenewSchedule {
  /** Coverage starts here (trial end / running prepaid period end / now). */
  base: Date
  /** First-cycle order needed (offers apply): discounted first cycle or free months. */
  order: 'discounted_cycle' | 'free_months' | null
  covers_months: number | null
  /** Amount charged with the authorisation (discounted first cycle), else 0. */
  upfront_paise: number
  /** First Razorpay plan charge; null = immediately. */
  start_at: Date | null
  first_charge_on: string
  first_charge_paise: number
}

export function autoRenewSchedule(
  quote: PriceQuote,
  live: SubscriptionRow | null,
  planCode: string,
  now: Date,
): AutoRenewSchedule {
  let base = now
  if (live && live.plan_code === planCode && !live.provider_subscription_id) {
    const end =
      live.status === 'trialing'
        ? (live.trial_ends_at ?? live.current_period_end)
        : live.status === 'active'
          ? live.current_period_end
          : null
    if (end && end.getTime() - now.getTime() > MIN_START_AT_LEAD_MS) base = end
  }
  const line = quote.lines[0]
  const free = line?.free_months ?? 0
  const today = toDateStr(now, BILLING_TZ)
  if (quote.offer_discount_paise > 0) {
    const covers = 1 + free
    const startAt = addMonthsInstant(base, covers)
    return {
      base,
      order: 'discounted_cycle',
      covers_months: covers,
      upfront_paise: quote.total_paise,
      start_at: startAt,
      first_charge_on: today,
      first_charge_paise: quote.total_paise,
    }
  }
  if (free > 0) {
    const startAt = addMonthsInstant(base, free)
    return {
      base,
      order: 'free_months',
      covers_months: free,
      upfront_paise: 0,
      start_at: startAt,
      first_charge_on: toDateStr(startAt, BILLING_TZ),
      first_charge_paise: quote.total_paise,
    }
  }
  const startAt = base.getTime() - now.getTime() > MIN_START_AT_LEAD_MS ? base : null
  return {
    base,
    order: null,
    covers_months: null,
    upfront_paise: 0,
    start_at: startAt,
    first_charge_on: startAt ? toDateStr(startAt, BILLING_TZ) : today,
    first_charge_paise: quote.total_paise,
  }
}

/** The first-cycle order lines of a free-months subscription (₹0 for the free months). */
function freeMonthsLines(quote: PriceQuote, months: number): PricedOrderLine[] {
  return quote.lines.map((l) => ({
    ...l,
    name: `${l.name} — ${months} free month${months === 1 ? '' : 's'}`,
    name_ta: l.name_ta ? `${l.name_ta} — ${months} மாதம் இலவசம்` : null,
    unit_price_paise: 0,
    term_months: months,
    free_months: 0,
    gross_paise: 0,
    partner_discount_paise: 0,
    offer_discount_paise: 0,
    discount_paise: 0,
    taxable_paise: 0,
    cgst_paise: 0,
    sgst_paise: 0,
    igst_paise: 0,
    tax_paise: 0,
    total_paise: 0,
  }))
}

// ---------------------------------------------------------------------------------------------
// Orders (system pool)
// ---------------------------------------------------------------------------------------------

interface NewOrder {
  id: string
  tenant_id: string
  buyer: BillingBuyer
  lines: PricedOrderLine[]
  quote: Pick<
    PriceQuote,
    'subtotal_paise' | 'discount_paise' | 'taxable_paise' | 'cgst_paise' | 'sgst_paise' | 'igst_paise' | 'total_paise' | 'offer_ids'
  >
  coupon_code: string | null
  created_by: string | null
  notes: string
}

async function insertDraftOrder(rt: PlatformRuntime, o: NewOrder): Promise<void> {
  // systemDb: vendor_orders is a vendor table (system pool only); the row belongs to this tenant.
  await rt.deps.db.systemDb
    .insertInto('vendor_orders')
    .values({
      id: o.id,
      kind: 'cloud_plan',
      customer_id: o.buyer.vendor_customer_id,
      tenant_id: o.tenant_id,
      lines: jsonb(o.lines),
      subtotal_paise: o.quote.subtotal_paise,
      discount_paise: o.quote.discount_paise,
      taxable_paise: o.quote.taxable_paise,
      cgst_paise: o.quote.cgst_paise,
      sgst_paise: o.quote.sgst_paise,
      igst_paise: o.quote.igst_paise,
      total_paise: o.quote.total_paise,
      place_of_supply: o.buyer.place_of_supply,
      buyer_gstin: o.buyer.gstin,
      offer_ids: o.quote.offer_ids,
      coupon_code: o.coupon_code,
      status: 'draft',
      created_by: o.created_by,
      notes: o.notes,
    })
    .execute()
}

async function markOrderPending(
  rt: PlatformRuntime,
  orderId: string,
  ref: { payment_ref: string; short_url: string },
): Promise<void> {
  // systemDb: vendor_orders (vendor table).
  await rt.deps.db.systemDb
    .updateTable('vendor_orders')
    .set({ status: 'pending_payment', payment_provider: 'razorpay', ...ref })
    .where('id', '=', orderId)
    .where('status', '=', 'draft')
    .execute()
}

async function cancelDraftOrder(rt: PlatformRuntime, orderId: string, why: string): Promise<void> {
  // systemDb: vendor_orders (vendor table). Best effort — the original error is what matters.
  await rt.deps.db.systemDb
    .updateTable('vendor_orders')
    .set({ status: 'cancelled', notes: why })
    .where('id', '=', orderId)
    .where('status', '=', 'draft')
    .execute()
    .catch((err: unknown) => rt.deps.logger.warn({ err, order_id: orderId }, 'could not cancel draft order'))
}

function couponApplied(quote: PriceQuote): string | null {
  return quote.coupon?.status === 'applied' ? quote.coupon.code : null
}

function notesFor(input: {
  tenant_id: string
  plan_code: string
  cycle: BillingCycle
  order_id: string | null
}): RazorpayNotes {
  const notes: RazorpayNotes = {
    [RAZORPAY_NOTE_KEYS.order_kind]: 'cloud_plan',
    [RAZORPAY_NOTE_KEYS.tenant_id]: input.tenant_id,
    [RAZORPAY_NOTE_KEYS.plan_code]: input.plan_code,
    [RAZORPAY_NOTE_KEYS.cycle]: input.cycle,
  }
  if (input.order_id) notes[RAZORPAY_NOTE_KEYS.order_id] = input.order_id
  return notes
}

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

const ORDER_INVOICE_STATUS: Record<string, BillingInvoice['status']> = {
  paid: 'paid',
  fulfilled: 'paid',
  refunded: 'refunded',
}

function vendorParty(rt: PlatformRuntime): InvoiceParty {
  const v = rt.settings.vendor
  return {
    name: v.name,
    legal_name: v.legal_name,
    gstin: v.gstin,
    address: v.address,
    state_code: v.state_code,
    state_name: getState(v.state_code)?.name_en ?? v.state_code,
    phone: v.phone,
    email: v.email,
  }
}

function buyerParty(b: BillingBuyer): InvoiceParty {
  return {
    name: b.name,
    legal_name: b.legal_name,
    gstin: b.gstin,
    address: { ...b.address, state_code: b.address.state_code ?? b.state_code },
    state_code: b.place_of_supply,
    state_name: getState(b.place_of_supply)?.name_en ?? b.place_of_supply,
    phone: b.phone,
    email: b.email,
  }
}

async function listInvoices(
  rt: PlatformRuntime,
  tenantId: string,
  range: { from?: string; to?: string },
): Promise<BillingInvoice[]> {
  // systemDb: vendor_orders / platform_invoices are vendor tables; filtered by this tenant.
  const db = rt.deps.db.systemDb
  const bounds =
    range.from || range.to
      ? instantRangeForDates(range.from ?? '2000-01-01', range.to ?? '2999-12-31', BILLING_TZ)
      : null
  let orders = db
    .selectFrom('vendor_orders as o')
    .leftJoin('platform_plan_periods as p', 'p.order_id', 'o.id')
    .select([
      'o.id',
      'o.number',
      'o.status',
      'o.lines',
      'o.taxable_paise',
      'o.cgst_paise',
      'o.sgst_paise',
      'o.igst_paise',
      'o.total_paise',
      'o.paid_at',
      'o.created_at',
      'p.plan_code',
      'p.billing_cycle',
      'p.period_start',
      'p.period_end',
    ])
    .where('o.tenant_id', '=', tenantId)
    .where('o.kind', '=', 'cloud_plan')
    .where('o.number', 'is not', null)
    .where('o.status', 'in', ['paid', 'fulfilled', 'refunded'])
  if (bounds) orders = orders.where('o.paid_at', '>=', bounds.start).where('o.paid_at', '<', bounds.end)
  let legacy = db
    .selectFrom('platform_invoices')
    .select([
      'id',
      'number',
      'status',
      'plan_code',
      'period_start',
      'period_end',
      'taxable_paise',
      'cgst_paise',
      'sgst_paise',
      'igst_paise',
      'total_paise',
      'paid_at',
      'created_at',
    ])
    .where('tenant_id', '=', tenantId)
    .where('status', '<>', 'draft')
  if (bounds) legacy = legacy.where('created_at', '>=', bounds.start).where('created_at', '<', bounds.end)
  const [orderRows, legacyRows] = await Promise.all([orders.execute(), legacy.execute()])
  const out: BillingInvoice[] = []
  for (const o of orderRows) {
    const lines = Array.isArray(o.lines) ? (o.lines as Array<{ product_code?: unknown }>) : []
    const code = typeof lines[0]?.product_code === 'string' ? lines[0].product_code : ''
    const parsed = parseCloudPlanProductCode(code)
    out.push({
      id: o.id,
      source: 'order',
      number: o.number,
      date: toDateStr(o.paid_at ?? o.created_at, BILLING_TZ),
      plan_code: o.plan_code ?? parsed?.plan_code ?? null,
      billing_cycle:
        o.billing_cycle === 'monthly' || o.billing_cycle === 'yearly'
          ? o.billing_cycle
          : (parsed?.cycle ?? null),
      period_start: o.period_start ? toDateStr(o.period_start, BILLING_TZ) : null,
      period_end: o.period_end ? periodEndDate(o.period_end) : null,
      taxable_paise: o.taxable_paise,
      cgst_paise: o.cgst_paise,
      sgst_paise: o.sgst_paise,
      igst_paise: o.igst_paise,
      total_paise: o.total_paise,
      status: ORDER_INVOICE_STATUS[o.status] ?? 'paid',
      paid_at: iso(o.paid_at),
    })
  }
  for (const i of legacyRows) {
    out.push({
      id: i.id,
      source: 'platform_invoice',
      number: i.number,
      date: toDateStr(i.created_at, BILLING_TZ),
      plan_code: i.plan_code,
      billing_cycle: null,
      period_start: i.period_start,
      period_end: i.period_end,
      taxable_paise: i.taxable_paise,
      cgst_paise: i.cgst_paise,
      sgst_paise: i.sgst_paise,
      igst_paise: i.igst_paise,
      total_paise: i.total_paise,
      status: i.status === 'paid' ? 'paid' : i.status === 'void' ? 'void' : 'issued',
      paid_at: iso(i.paid_at),
    })
  }
  return out
}

async function invoicePrint(
  rt: PlatformRuntime,
  tenantId: string,
  id: string,
): Promise<VendorInvoicePrint> {
  // systemDb: vendor_orders / platform_invoices / plan periods (vendor-side billing records).
  const db = rt.deps.db.systemDb
  const buyer = await loadBuyer(db, tenantId)
  const order = await db
    .selectFrom('vendor_orders as o')
    .leftJoin('platform_plan_periods as p', 'p.order_id', 'o.id')
    .select([
      'o.id',
      'o.number',
      'o.kind',
      'o.status',
      'o.lines',
      'o.place_of_supply',
      'o.buyer_gstin',
      'o.subtotal_paise',
      'o.discount_paise',
      'o.taxable_paise',
      'o.cgst_paise',
      'o.sgst_paise',
      'o.igst_paise',
      'o.total_paise',
      'o.payment_provider',
      'o.payment_ref',
      'o.paid_at',
      'o.created_at',
      'p.period_start',
      'p.period_end',
    ])
    .where('o.id', '=', id)
    .where('o.tenant_id', '=', tenantId)
    .where('o.kind', '=', 'cloud_plan')
    .where('o.number', 'is not', null)
    .executeTakeFirst()
  const seller = vendorParty(rt)
  if (order && order.number) {
    const lines = (Array.isArray(order.lines) ? order.lines : []) as PricedOrderLine[]
    const totals = invoiceTotals(lines)
    const pos = order.place_of_supply
    const interstate = pos !== seller.state_code
    return {
      number: order.number,
      date: toDateStr(order.paid_at ?? order.created_at, BILLING_TZ),
      order_id: order.id,
      kind: 'cloud_plan',
      seller,
      buyer: { ...buyerParty(buyer), gstin: order.buyer_gstin ?? buyer.gstin, state_code: pos },
      place_of_supply: pos,
      place_of_supply_name: `${pos}-${getState(pos)?.name_en ?? pos}`,
      is_interstate: interstate,
      reverse_charge: false,
      lines: lines.map((l, i) => ({
        sl: i + 1,
        description_en: l.name,
        description_ta: l.name_ta,
        sac: l.sac,
        qty: l.qty,
        unit_price_paise: l.unit_price_paise,
        discount_paise: l.discount_paise,
        taxable_paise: l.taxable_paise,
        gst_rate_bp: l.gst_rate_bp,
        cgst_paise: l.cgst_paise,
        sgst_paise: l.sgst_paise,
        igst_paise: l.igst_paise,
        total_paise: l.total_paise,
        period_from: order.period_start ? toDateStr(order.period_start, BILLING_TZ) : null,
        period_to: order.period_end ? periodEndDate(order.period_end) : null,
      })),
      tax_breakup: totals.tax_breakup,
      subtotal_paise: order.subtotal_paise,
      discount_paise: order.discount_paise,
      taxable_paise: order.taxable_paise,
      cgst_paise: order.cgst_paise,
      sgst_paise: order.sgst_paise,
      igst_paise: order.igst_paise,
      total_paise: order.total_paise,
      amount_in_words_en: totals.amount_in_words_en,
      amount_in_words_ta: totals.amount_in_words_ta,
      payment: {
        provider:
          order.payment_provider === 'razorpay' ||
          order.payment_provider === 'manual' ||
          order.payment_provider === 'partner_credit'
            ? order.payment_provider
            : null,
        reference: order.payment_ref,
        paid_at: iso(order.paid_at),
      },
      status: order.status === 'refunded' ? 'refunded' : 'paid',
      notes: null,
    }
  }
  const legacy = await db
    .selectFrom('platform_invoices')
    .selectAll()
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .where('status', '<>', 'draft')
    .executeTakeFirst()
  if (!legacy) throw notFound('invoice', id)
  const plans = await loadCloudPlans(db)
  const plan = plans.find((p) => p.code === legacy.plan_code)
  const pos = buyer.place_of_supply
  const line = {
    gst_rate_bp: VENDOR_GST_RATE_BP,
    taxable_paise: legacy.taxable_paise,
    cgst_paise: legacy.cgst_paise,
    sgst_paise: legacy.sgst_paise,
    igst_paise: legacy.igst_paise,
    total_paise: legacy.total_paise,
  }
  const totals = invoiceTotals([line])
  return {
    number: legacy.number,
    date: toDateStr(legacy.created_at, BILLING_TZ),
    order_id: null,
    kind: null,
    seller,
    buyer: buyerParty(buyer),
    place_of_supply: pos,
    place_of_supply_name: `${pos}-${getState(pos)?.name_en ?? pos}`,
    is_interstate: legacy.igst_paise > 0,
    reverse_charge: false,
    lines: [
      {
        sl: 1,
        description_en: plan?.name ?? legacy.plan_code,
        description_ta: plan?.name_ta ?? null,
        sac: '997331',
        qty: 1,
        unit_price_paise: legacy.taxable_paise,
        discount_paise: 0,
        ...line,
        period_from: legacy.period_start,
        period_to: legacy.period_end,
      },
    ],
    tax_breakup: totals.tax_breakup,
    subtotal_paise: legacy.taxable_paise,
    discount_paise: 0,
    taxable_paise: legacy.taxable_paise,
    cgst_paise: legacy.cgst_paise,
    sgst_paise: legacy.sgst_paise,
    igst_paise: legacy.igst_paise,
    total_paise: legacy.total_paise,
    amount_in_words_en: totals.amount_in_words_en,
    amount_in_words_ta: totals.amount_in_words_ta,
    payment: legacy.paid_at
      ? { provider: 'razorpay', reference: legacy.provider_payment_id, paid_at: iso(legacy.paid_at) }
      : null,
    status: legacy.status === 'paid' ? 'paid' : legacy.status === 'void' ? 'void' : 'issued',
    notes: null,
  }
}

// ---------------------------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------------------------

async function lockTenantCheckout(tx: Tx, tenantId: string): Promise<void> {
  // Serialises checkouts of one tenant (no row locks: fulfilment of a ₹0 order runs in a system
  // transaction that updates the subscription row).
  await sql`select pg_advisory_xact_lock(hashtextextended(${`kadai_checkout:${tenantId}`}, 0))`.execute(tx)
}

async function reusablePaymentLink(
  tx: Tx,
  input: { tenant_id: string; plan_code: string; cycle: BillingCycle; coupon_code: string | null; total_paise: number; now: Date },
): Promise<CheckoutResponse | null> {
  let q = tx
    .selectFrom('platform_checkouts')
    .select(['order_id', 'short_url', 'total_paise', 'expires_at'])
    .where('tenant_id', '=', input.tenant_id)
    .where('mode', '=', 'payment_link')
    .where('status', '=', 'pending')
    .where('plan_code', '=', input.plan_code)
    .where('billing_cycle', '=', input.cycle)
    .where('total_paise', '=', input.total_paise)
    .where('expires_at', '>', new Date(input.now.getTime() + MIN_START_AT_LEAD_MS))
  q = input.coupon_code === null ? q.where('coupon_code', 'is', null) : q.where('coupon_code', '=', input.coupon_code)
  const row = await q.orderBy('created_at', 'desc').limit(1).executeTakeFirst()
  if (!row || !row.order_id) return null
  return {
    mode: 'payment_link',
    short_url: row.short_url,
    order_id: row.order_id,
    provider_subscription_id: null,
    total_paise: row.total_paise,
    first_charge_on: null,
    expires_at: iso(row.expires_at),
  }
}

interface CheckoutInsert {
  tenant_id: string
  mode: 'payment_link' | 'subscription'
  plan_code: string
  cycle: BillingCycle
  coupon_code: string | null
  order_id: string | null
  covers_months: number | null
  redemptions: Redemption[]
  provider_ref: string
  short_url: string
  total_paise: number
  first_charge_on: string | null
  start_at: Date | null
  expires_at: Date | null
  status?: 'pending' | 'completed'
  created_by: string | null
}

async function insertCheckout(tx: Tx, c: CheckoutInsert): Promise<string> {
  const id = newId()
  await tx
    .insertInto('platform_checkouts')
    .values({
      id,
      tenant_id: c.tenant_id,
      mode: c.mode,
      auto_renew: c.mode === 'subscription',
      plan_code: c.plan_code,
      billing_cycle: c.cycle,
      coupon_code: c.coupon_code,
      order_id: c.order_id,
      covers_months: c.covers_months,
      redemptions: jsonb(c.redemptions),
      provider_ref: c.provider_ref,
      short_url: c.short_url,
      total_paise: c.total_paise,
      first_charge_on: c.first_charge_on,
      start_at: c.start_at,
      expires_at: c.expires_at,
      status: c.status ?? 'pending',
      completed_at: c.status === 'completed' ? new Date() : null,
      created_by: c.created_by,
    })
    .execute()
  return id
}

function billingPageUrl(rt: PlatformRuntime, query: string): string {
  return `${rt.settings.publicBaseUrl}/settings/billing?${query}`
}

// ---------------------------------------------------------------------------------------------
// Route implementations
// ---------------------------------------------------------------------------------------------

export function billingImpls(rt: PlatformRuntime): RouteImpls<Routes> {
  const { deps } = rt
  return {
    billingPlans: {
      config: ALLOW_SUSPENDED,
      handler: async (req) => {
        const ent = await deps.entitlements.get(req.ctx.tenantId)
        // systemDb: the price book (license_products) is a vendor table.
        const plans = await loadCloudPlans(deps.db.systemDb)
        const visible = plans.filter(
          (p) => p.is_public || (p.code === ent.plan_code && !p.code.startsWith('onprem_')),
        )
        return {
          data: {
            plans: visible.map((p) => billingPlanDto(p, ent.plan_code)),
            current_plan_code: ent.plan_code,
            gst_rate_bp: VENDOR_GST_RATE_BP,
          },
        }
      },
    },

    billingSubscription: {
      config: ALLOW_SUSPENDED,
      handler: async (req) => {
        const now = rt.now()
        const tenantId = req.ctx.tenantId
        const ent = await deps.entitlements.get(tenantId)
        const { sub, usage, pending } = await req.tx(async (tx) => {
          const sub = await loadCurrentSubscription(tx, tenantId)
          const usage = []
          for (const metric of LIMIT_METRICS) {
            usage.push(usageMeter(metric, await countForLimit(tx, req.ctx, metric), ent.limits[metric]))
          }
          const pending = await tx
            .selectFrom('platform_checkouts')
            .select(['order_id', 'short_url', 'total_paise', 'plan_code', 'billing_cycle', 'expires_at'])
            .where('tenant_id', '=', tenantId)
            .where('status', '=', 'pending')
            .where('order_id', 'is not', null)
            .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst()
          return { sub, usage, pending }
        })
        const ctx = await pricingContext(rt, tenantId, now)
        const plan = ctx.plans.find((p) => p.code === ent.plan_code) ?? ctx.plans.find((p) => p.code === 'free')
        if (!plan) throw new AppError('INTERNAL', `Plan "${ent.plan_code}" is missing`)
        const planNames = sub ? (ctx.plans.find((p) => p.code === sub.plan_code) ?? null) : null
        const live = sub && ['trialing', 'active', 'past_due'].includes(sub.status)
        const trialActive =
          sub?.status === 'trialing' && sub.trial_ends_at !== null && sub.trial_ends_at.getTime() > now.getTime()
        const overview: BillingOverview = {
          plan: billingPlanDto(plan, ent.plan_code),
          subscription: sub ? subscriptionView(sub, planNames, now) : null,
          entitlements: toEntitlementsDto(ent),
          usage,
          trial: {
            active: trialActive,
            ends_at: trialActive ? iso(sub.trial_ends_at) : null,
            days_left: trialActive ? daysLeft(sub.trial_ends_at, now) : null,
          },
          offers: eligibleAutomaticOffers(ctx.offers, ctx.buyer, now).map(offerPublicDto),
          pending_checkout:
            pending && pending.order_id
              ? {
                  order_id: pending.order_id,
                  short_url: pending.short_url,
                  total_paise: pending.total_paise,
                  plan_code: pending.plan_code,
                  cycle: pending.billing_cycle === 'yearly' ? 'yearly' : 'monthly',
                  expires_at: iso(pending.expires_at),
                }
              : null,
          can_cancel: Boolean(
            live && sub && (sub.status === 'active' || sub.status === 'past_due') && !sub.cancel_at_period_end,
          ),
          tenant_state_code: ctx.buyer.place_of_supply,
          vendor_state_code: rt.settings.vendor.state_code,
        }
        return { data: overview }
      },
    },

    billingQuote: {
      config: ALLOW_SUSPENDED,
      handler: async (req) => {
        const now = rt.now()
        const tenantId = req.ctx.tenantId
        const ctx = await pricingContext(rt, tenantId, now)
        const plan = requirePlan(ctx.plans, req.body.plan_code, req.body.cycle)
        const quote = await priceFor(
          rt,
          ctx,
          { tenant_id: tenantId, plan, cycle: req.body.cycle, coupon_code: req.body.coupon_code },
          now,
        )
        const live = await req.tx((tx) => loadLiveSubscription(tx, tenantId))
        const line = quote.lines[0]
        const months = (line?.term_months ?? 1) + (line?.free_months ?? 0)
        const base = paidTermStart(live, plan.code, now).base
        const start = toDateStr(base, BILLING_TZ)
        const monthly = req.body.cycle === 'monthly'
        const autoRenewAvailable =
          monthly && rt.razorpay.configured && razorpayPlanId(rt.settings, plan.code) !== null
        const result: BillingQuote = {
          plan_code: plan.code,
          cycle: req.body.cycle,
          quote,
          period_start: start,
          period_end: addDays(addMonths(start, months), -1),
          first_charge_on: monthly ? autoRenewSchedule(quote, live, plan.code, now).first_charge_on : null,
          auto_renew_available: autoRenewAvailable,
        }
        return { data: result }
      },
    },

    billingCheckout: {
      config: ALLOW_SUSPENDED,
      tx: async (tx, req) => {
        const now = rt.now()
        const tenantId = req.ctx.tenantId
        const body = req.body
        await lockTenantCheckout(tx, tenantId)
        const ctx = await pricingContext(rt, tenantId, now)
        const plan = requirePlan(ctx.plans, body.plan_code, body.cycle)
        const live = await loadLiveSubscription(tx, tenantId)
        if (
          live?.provider_subscription_id &&
          !live.cancel_at_period_end &&
          (live.status === 'active' || live.status === 'past_due' || live.status === 'trialing')
        ) {
          throw reasonError(
            'CONFLICT',
            'auto_renew_active',
            'An automatic monthly renewal is active; cancel it before buying another plan',
          )
        }
        const quote = await priceFor(
          rt,
          ctx,
          { tenant_id: tenantId, plan, cycle: body.cycle, coupon_code: body.coupon_code },
          now,
        )
        const coupon = couponApplied(quote)
        const redemptions = redemptionsOf(quote)
        const line = quote.lines[0]
        const userId = req.ctx.userId
        const auditCheckout = (data: CheckoutResponse) =>
          audit(tx, req.ctx, {
            action: 'billing.checkout',
            entity_type: 'vendor_order',
            entity_id: data.order_id,
            summary: `${plan.code} ${body.cycle}${body.auto_renew ? ' auto-renew' : ''} — ${data.total_paise} paise`,
            changes: {
              plan_code: plan.code,
              cycle: body.cycle,
              auto_renew: body.auto_renew,
              coupon_code: coupon,
              total_paise: data.total_paise,
              provider_subscription_id: data.provider_subscription_id,
            },
          })

        if (!body.auto_renew) {
          // ---- prepaid: payment link ---------------------------------------------------------
          if (quote.total_paise > 0 && quote.total_paise < 100)
            throw reasonError('UNPROCESSABLE', 'amount_too_small', 'Amount is below the online payment minimum')
          if (quote.total_paise > 0) {
            if (!rt.razorpay.configured)
              throw reasonError('PROVIDER_ERROR', 'billing_not_configured', 'Razorpay platform billing is not configured', {
                provider: 'razorpay_platform',
              })
            const reuse = await reusablePaymentLink(tx, {
              tenant_id: tenantId,
              plan_code: plan.code,
              cycle: body.cycle,
              coupon_code: coupon,
              total_paise: quote.total_paise,
              now,
            })
            if (reuse) return { data: reuse }
          }
          const orderId = newId()
          await insertDraftOrder(rt, {
            id: orderId,
            tenant_id: tenantId,
            buyer: ctx.buyer,
            lines: quote.lines,
            quote,
            coupon_code: coupon,
            created_by: userId,
            notes: `Cloud plan ${plan.code} (${body.cycle}, prepaid)`,
          })
          const covers = (line?.term_months ?? 1) + (line?.free_months ?? 0)
          if (quote.total_paise === 0) {
            // Fully discounted: nothing to pay — fulfil now (system transaction: vendor tables).
            await withSystemTx(deps.db.systemDb, async (stx) => {
              const order = await lockOrder(stx, orderId)
              if (!order) throw new AppError('INTERNAL', 'order vanished')
              await fulfilPlanOrder(stx, deps, {
                order,
                terms: {
                  plan_code: plan.code,
                  cycle: body.cycle,
                  covers_months: covers,
                  redemptions,
                  checkout_id: null,
                },
                payment: { provider: 'manual', reference: null, paid_at: now },
                now,
                request_id: req.ctx.requestId,
              })
            })
            const shortUrl = billingPageUrl(rt, `checkout=${orderId}`)
            await insertCheckout(tx, {
              tenant_id: tenantId,
              mode: 'payment_link',
              plan_code: plan.code,
              cycle: body.cycle,
              coupon_code: coupon,
              order_id: orderId,
              covers_months: covers,
              redemptions,
              provider_ref: `free:${orderId}`,
              short_url: shortUrl,
              total_paise: 0,
              first_charge_on: null,
              start_at: null,
              expires_at: null,
              status: 'completed',
              created_by: userId,
            })
            const data: CheckoutResponse = {
              mode: 'payment_link',
              short_url: shortUrl,
              order_id: orderId,
              provider_subscription_id: null,
              total_paise: 0,
              first_charge_on: null,
              expires_at: null,
            }
            await auditCheckout(data)
            return { data }
          }
          const expireBy = new Date(now.getTime() + PAYMENT_LINK_TTL_HOURS * 3_600_000)
          let link
          try {
            link = await rt.razorpay.createPaymentLink({
              amount_paise: quote.total_paise,
              reference_id: orderId,
              description: `Kadai ${plan.name} — ${body.cycle === 'yearly' ? 'yearly' : 'monthly'} plan`,
              customer: { name: ctx.buyer.name, contact: ctx.buyer.phone, email: ctx.buyer.email },
              notes: notesFor({ tenant_id: tenantId, plan_code: plan.code, cycle: body.cycle, order_id: orderId }),
              callback_url: billingPageUrl(rt, `checkout=${orderId}`),
              expire_by: expireBy,
              notify_sms: true,
            })
          } catch (err) {
            await cancelDraftOrder(rt, orderId, 'Payment link could not be created')
            throw err
          }
          await markOrderPending(rt, orderId, { payment_ref: link.id, short_url: link.short_url })
          const expiresAt = link.expire_by ?? expireBy
          await insertCheckout(tx, {
            tenant_id: tenantId,
            mode: 'payment_link',
            plan_code: plan.code,
            cycle: body.cycle,
            coupon_code: coupon,
            order_id: orderId,
            covers_months: covers,
            redemptions,
            provider_ref: link.id,
            short_url: link.short_url,
            total_paise: quote.total_paise,
            first_charge_on: null,
            start_at: null,
            expires_at: expiresAt,
            created_by: userId,
          })
          const data: CheckoutResponse = {
            mode: 'payment_link',
            short_url: link.short_url,
            order_id: orderId,
            provider_subscription_id: null,
            total_paise: quote.total_paise,
            first_charge_on: null,
            expires_at: iso(expiresAt),
          }
          await auditCheckout(data)
          return { data }
        }

        // ---- monthly auto-renew: Razorpay subscription ---------------------------------------
        const planId = razorpayPlanId(rt.settings, plan.code)
        if (!planId)
          throw reasonError('UNPROCESSABLE', 'auto_renew_unavailable', 'Automatic monthly renewal is not configured for this plan', {
            plan_code: plan.code,
          })
        if (!rt.razorpay.configured)
          throw reasonError('PROVIDER_ERROR', 'billing_not_configured', 'Razorpay platform billing is not configured', {
            provider: 'razorpay_platform',
          })
        const schedule = autoRenewSchedule(quote, live, plan.code, now)
        if (schedule.upfront_paise > 0 && schedule.upfront_paise < 100)
          throw reasonError('UNPROCESSABLE', 'amount_too_small', 'Amount is below the online payment minimum')
        let orderId: string | null = null
        if (schedule.order) {
          orderId = newId()
          const zero = schedule.order === 'free_months'
          const lines = zero ? freeMonthsLines(quote, schedule.covers_months ?? 1) : quote.lines
          await insertDraftOrder(rt, {
            id: orderId,
            tenant_id: tenantId,
            buyer: ctx.buyer,
            lines,
            quote: zero
              ? {
                  subtotal_paise: 0,
                  discount_paise: 0,
                  taxable_paise: 0,
                  cgst_paise: 0,
                  sgst_paise: 0,
                  igst_paise: 0,
                  total_paise: 0,
                  offer_ids: quote.offer_ids,
                }
              : quote,
            coupon_code: coupon,
            created_by: userId,
            notes: zero
              ? `Cloud plan ${plan.code}: ${schedule.covers_months ?? 0} free month(s) before monthly auto-renew`
              : `Cloud plan ${plan.code}: discounted first cycle of monthly auto-renew`,
          })
        }
        const expireBy = new Date(now.getTime() + PAYMENT_LINK_TTL_HOURS * 3_600_000)
        let sub
        try {
          sub = await rt.razorpay.createSubscription({
            plan_id: planId,
            total_count: RAZORPAY_SUBSCRIPTION_TOTAL_COUNT,
            start_at: schedule.start_at,
            expire_by: expireBy,
            upfront:
              schedule.upfront_paise > 0
                ? { name: `${plan.name} — first month (offer)`, amount_paise: schedule.upfront_paise }
                : null,
            notes: notesFor({ tenant_id: tenantId, plan_code: plan.code, cycle: 'monthly', order_id: orderId }),
          })
        } catch (err) {
          if (orderId) await cancelDraftOrder(rt, orderId, 'Razorpay subscription could not be created')
          throw err
        }
        if (orderId) await markOrderPending(rt, orderId, { payment_ref: sub.id, short_url: sub.short_url })
        await insertCheckout(tx, {
          tenant_id: tenantId,
          mode: 'subscription',
          plan_code: plan.code,
          cycle: 'monthly',
          coupon_code: coupon,
          order_id: orderId,
          covers_months: schedule.covers_months,
          redemptions: orderId ? redemptions : [],
          provider_ref: sub.id,
          short_url: sub.short_url,
          total_paise: schedule.first_charge_paise,
          first_charge_on: schedule.first_charge_on,
          start_at: schedule.start_at,
          expires_at: expireBy,
          created_by: userId,
        })
        const data: CheckoutResponse = {
          mode: 'subscription',
          short_url: sub.short_url,
          order_id: orderId,
          provider_subscription_id: sub.id,
          total_paise: schedule.first_charge_paise,
          first_charge_on: schedule.first_charge_on,
          expires_at: iso(expireBy),
        }
        await auditCheckout(data)
        return { data }
      },
    },

    billingCancel: {
      config: ALLOW_SUSPENDED,
      tx: async (tx, req) => {
        const now = rt.now()
        const tenantId = req.ctx.tenantId
        const live = await loadLiveSubscription(tx, tenantId, { forUpdate: true })
        if (!live || (live.status !== 'active' && live.status !== 'past_due'))
          throw reasonError('CONFLICT', 'not_cancellable', 'There is no paid subscription to cancel')
        if (live.cancel_at_period_end)
          throw reasonError('CONFLICT', 'already_cancelled', 'The subscription is already set to cancel')
        if (live.provider_subscription_id) {
          await rt.razorpay.cancelSubscription(live.provider_subscription_id, { atCycleEnd: true })
        }
        await tx
          .updateTable('subscriptions')
          .set({
            cancel_at_period_end: true,
            cancel_requested_at: now,
            cancel_reason: req.body.reason ?? null,
            cancel_feedback: req.body.feedback ?? null,
          })
          .where('id', '=', live.id)
          .execute()
        await audit(tx, req.ctx, {
          action: 'billing.cancel',
          entity_type: 'subscription',
          entity_id: live.id,
          summary: `${live.plan_code} cancels at period end`,
          changes: {
            reason: req.body.reason ?? null,
            feedback: req.body.feedback ?? null,
            period_end: live.current_period_end.toISOString(),
            provider_subscription_id: live.provider_subscription_id,
          },
        })
        // systemDb: plan names come from plans (read-only reference) via the shared catalogue.
        const plans = await loadCloudPlans(deps.db.systemDb)
        const updated = { ...live, cancel_at_period_end: true, cancel_requested_at: now }
        return {
          data: subscriptionView(updated, plans.find((p) => p.code === live.plan_code) ?? null, now),
        }
      },
    },

    billingInvoices: {
      config: ALLOW_SUSPENDED,
      handler: async (req) => {
        const q = req.query
        const all = await listInvoices(rt, req.ctx.tenantId, { from: q.from, to: q.to })
        const dir = q.sort.direction === 'asc' ? 1 : -1
        all.sort((a, b) => {
          const primary =
            q.sort.field === 'total_paise'
              ? a.total_paise - b.total_paise
              : a.date < b.date
                ? -1
                : a.date > b.date
                  ? 1
                  : 0
          if (primary !== 0) return primary * dir
          return ((a.number ?? '') < (b.number ?? '') ? -1 : 1) * dir
        })
        const page = all.slice(q.offset, q.offset + q.limit)
        return { data: page, page: { limit: q.limit, offset: q.offset, total: all.length } }
      },
    },

    billingInvoicePrint: {
      config: ALLOW_SUSPENDED,
      handler: async (req) => ({ data: await invoicePrint(rt, req.ctx.tenantId, req.params.id) }),
    },
  }
}
