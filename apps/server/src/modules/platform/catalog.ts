/**
 * What we sell to cloud tenants and to whom: cloud plans with their purchase prices (price book
 * rows `cloud_<plan>_<cycle>`, monthly lines synthesized from plans.price_monthly_paise), vendor
 * offers & coupons, and the buyer profile of a tenant (place of supply, audience, segments).
 *
 * Everything here reads the vendor tables of migration 0010 (license_products, offers,
 * offer_redemptions, vendor_orders, vendor_customers) and platform_invoices, which are revoked
 * from the runtime role. Callers pass the SYSTEM database (justified: tenants never see vendor
 * rows; every query below is filtered by the tenant id or by public, non-tenant data).
 */
import type { Kysely } from 'kysely'
import {
  type BillingCycle,
  type BusinessType,
  BusinessTypeSchema,
  type Feature,
  LIMIT_METRICS,
  type OfferKind,
  OfferKindSchema,
  type PlanLimits,
  isFeature,
  mulDiv,
  stateCodeFromGstin,
} from '@kadai/shared'
import { type Address, AddressSchema } from '@kadai/shared/api/common'
import {
  type OfferSegment,
  type PriceOrderLineInput,
  type PriceQuote,
  type PricingBuyer,
  type PricingOffer,
  VENDOR_GST_RATE_BP,
  buyerSegments,
  offerIneligibility,
  priceOrder,
} from '@kadai/shared/api/licensing'
import { CLOUD_PLAN_NAMES, PURCHASABLE_CLOUD_PLANS, cloudPlanProductCode } from '@kadai/shared/api/platform'
import type { DB } from '../../db/schema.generated'
import type { Tx } from '../../db/tenant'

type Db = Kysely<DB> | Tx

// ---------------------------------------------------------------------------------------------
// Plans & purchase prices
// ---------------------------------------------------------------------------------------------

export interface PlanPrice {
  product_code: string
  name: string
  name_ta: string | null
  /** Excl. GST, one term. */
  unit_price_paise: number
  gst_rate_bp: number
  term_months: number
}

export interface CloudPlan {
  code: string
  name: string
  name_ta: string | null
  description: string | null
  features: Feature[]
  limits: PlanLimits
  is_public: boolean
  sort_order: number
  /** Purchase price per cycle; null = cannot be bought for that cycle. */
  prices: Record<BillingCycle, PlanPrice | null>
  /** Shown on the plan cards (excl. GST): the purchase price, else the plans row. */
  display_monthly_paise: number
  display_yearly_paise: number
}

/** plans.limits leniently (missing / malformed metric → 0, like core/entitlements). */
export function readPlanLimits(raw: unknown): PlanLimits {
  const out: PlanLimits = { stores: 0, users: 0, registers: 0, products: 0, invoices_per_month: 0 }
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

const CYCLE_LABEL: Record<BillingCycle, { en: string; ta: string; months: number }> = {
  monthly: { en: 'monthly', ta: 'மாதாந்திரம்', months: 1 },
  yearly: { en: 'yearly', ta: 'ஆண்டு', months: 12 },
}

/** Every plan row with its cloud purchase prices (system database). */
export async function loadCloudPlans(db: Db): Promise<CloudPlan[]> {
  const [plans, products] = await Promise.all([
    db
      .selectFrom('plans')
      .select([
        'code',
        'name',
        'name_ta',
        'description',
        'features',
        'limits',
        'is_public',
        'sort_order',
        'price_monthly_paise',
        'price_yearly_paise',
      ])
      .orderBy('sort_order')
      .orderBy('code')
      .execute(),
    db
      .selectFrom('license_products')
      .select(['code', 'name', 'name_ta', 'price_paise', 'gst_rate_bp', 'term_months', 'is_active'])
      .where('kind', '=', 'cloud_plan')
      .where('channel', 'in', ['cloud', 'both'])
      .execute(),
  ])
  const byCode = new Map(products.map((p) => [p.code, p]))
  return plans.map((p) => {
    const price = (cycle: BillingCycle): PlanPrice | null => {
      const code = cloudPlanProductCode(p.code, cycle)
      const row = byCode.get(code)
      if (row) {
        if (!row.is_active || row.price_paise <= 0) return null
        return {
          product_code: code,
          name: row.name,
          name_ta: row.name_ta,
          unit_price_paise: row.price_paise,
          gst_rate_bp: row.gst_rate_bp,
          term_months: row.term_months ?? CYCLE_LABEL[cycle].months,
        }
      }
      const amount = cycle === 'monthly' ? p.price_monthly_paise : p.price_yearly_paise
      if (amount <= 0) return null
      const short = CLOUD_PLAN_NAMES[p.code]
      return {
        product_code: code,
        name: `${p.name} — ${CYCLE_LABEL[cycle].en}`,
        name_ta: `${p.name_ta ?? short?.ta ?? p.name} — ${CYCLE_LABEL[cycle].ta}`,
        unit_price_paise: amount,
        gst_rate_bp: VENDOR_GST_RATE_BP,
        term_months: CYCLE_LABEL[cycle].months,
      }
    }
    const monthly = price('monthly')
    const yearly = price('yearly')
    return {
      code: p.code,
      name: p.name,
      name_ta: p.name_ta,
      description: p.description,
      features: p.features.filter(isFeature),
      limits: readPlanLimits(p.limits),
      is_public: p.is_public,
      sort_order: p.sort_order,
      prices: { monthly, yearly },
      display_monthly_paise: monthly?.unit_price_paise ?? p.price_monthly_paise,
      display_yearly_paise: yearly?.unit_price_paise ?? p.price_yearly_paise,
    }
  })
}

/** Can be bought online at all (public, on the purchasable list, priced for some cycle). */
export function isPurchasable(plan: CloudPlan): boolean {
  return (
    plan.is_public &&
    (PURCHASABLE_CLOUD_PLANS as readonly string[]).includes(plan.code) &&
    (plan.prices.monthly !== null || plan.prices.yearly !== null)
  )
}

/** priceOrder line for buying `plan` for one `cycle` (null = not sold for that cycle). */
export function planLine(plan: CloudPlan, cycle: BillingCycle): PriceOrderLineInput | null {
  const price = plan.prices[cycle]
  if (!price || !isPurchasable(plan)) return null
  return {
    key: '1',
    product_code: price.product_code,
    kind: 'cloud_plan',
    name: price.name,
    name_ta: price.name_ta,
    qty: 1,
    unit_price_paise: price.unit_price_paise,
    gst_rate_bp: price.gst_rate_bp,
    term_months: price.term_months,
  }
}

// ---------------------------------------------------------------------------------------------
// Buyer (tenant) profile
// ---------------------------------------------------------------------------------------------

export interface BillingBuyer {
  tenant_id: string
  name: string
  legal_name: string | null
  gstin: string | null
  /** tenants.state_code (registered office). */
  state_code: string
  /** GST place of supply: the GSTIN's state for registered buyers, else state_code. */
  place_of_supply: string
  business_type: BusinessType | null
  district: string | null
  address: Address
  phone: string | null
  email: string | null
  timezone: string
  default_locale: 'ta' | 'en'
  segments: OfferSegment[]
  partner_id: string | null
  vendor_customer_id: string | null
}

export async function loadBuyer(db: Db, tenantId: string): Promise<BillingBuyer> {
  const tenant = await db
    .selectFrom('tenants')
    .select([
      'id',
      'name',
      'legal_name',
      'gstin',
      'state_code',
      'business_type',
      'address',
      'phone',
      'email',
      'timezone',
      'default_locale',
    ])
    .where('id', '=', tenantId)
    .executeTakeFirstOrThrow()
  const [paid, invoices, live, customer, owner] = await Promise.all([
    db
      .selectFrom('vendor_orders')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('status', 'in', ['paid', 'fulfilled', 'refunded'])
      .where('total_paise', '>', 0)
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('platform_invoices')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'paid')
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('subscriptions')
      .select('status')
      .where('tenant_id', '=', tenantId)
      .where('status', 'in', ['active', 'past_due'])
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('vendor_customers')
      .select(['id', 'partner_id'])
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst(),
    tenant.phone
      ? Promise.resolve(undefined)
      : db
          .selectFrom('memberships as m')
          .innerJoin('roles as r', (j) => j.onRef('r.id', '=', 'm.role_id').onRef('r.tenant_id', '=', 'm.tenant_id'))
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select(['u.phone'])
          .where('m.tenant_id', '=', tenantId)
          .where('r.code', '=', 'owner')
          .where('m.status', '=', 'active')
          .where('u.phone', 'is not', null)
          .orderBy('m.created_at')
          .limit(1)
          .executeTakeFirst(),
  ])
  const address = AddressSchema.safeParse(tenant.address)
  const addr: Address = address.success
    ? address.data
    : { line1: undefined, line2: undefined, city: undefined, district: undefined, pincode: undefined }
  const business = BusinessTypeSchema.safeParse(tenant.business_type)
  const gstState = tenant.gstin ? stateCodeFromGstin(tenant.gstin) : null
  return {
    tenant_id: tenant.id,
    name: tenant.name,
    legal_name: tenant.legal_name,
    gstin: tenant.gstin,
    state_code: tenant.state_code,
    place_of_supply: gstState ?? tenant.state_code,
    business_type: business.success ? business.data : null,
    district: addr.district ?? null,
    address: addr,
    phone: tenant.phone ?? owner?.phone ?? null,
    email: tenant.email,
    timezone: tenant.timezone,
    default_locale: tenant.default_locale === 'en' ? 'en' : 'ta',
    segments: buyerSegments({
      ever_paid: paid !== undefined || invoices !== undefined,
      has_active: live !== undefined,
      amc_lapsed: false,
    }),
    partner_id: customer?.partner_id ?? null,
    vendor_customer_id: customer?.id ?? null,
  }
}

export function pricingBuyer(buyer: BillingBuyer): PricingBuyer {
  return {
    channel: 'cloud',
    state_code: buyer.place_of_supply,
    business_type: buyer.business_type,
    district: buyer.district,
    segments: buyer.segments,
    partner_id: buyer.partner_id,
  }
}

// ---------------------------------------------------------------------------------------------
// Offers & coupons
// ---------------------------------------------------------------------------------------------

export interface OfferRecord extends PricingOffer {
  description: string | null
  description_ta: string | null
  banner: unknown
  kind: OfferKind
}

function offerQuery(db: Db, tenantId: string) {
  return db
    .selectFrom('offers as o')
    .select([
      'o.id',
      'o.code',
      'o.name',
      'o.name_ta',
      'o.description',
      'o.description_ta',
      'o.kind',
      'o.value',
      'o.max_discount_paise',
      'o.applies_to',
      'o.channel',
      'o.audience',
      'o.starts_at',
      'o.ends_at',
      'o.max_redemptions',
      'o.per_customer_limit',
      'o.partner_id',
      'o.stackable',
      'o.banner',
      'o.is_active',
    ])
    .select((eb) => [
      eb
        .selectFrom('offer_redemptions as r')
        .whereRef('r.offer_id', '=', 'o.id')
        .select(eb.fn.countAll<number>().as('n'))
        .as('redeemed_count'),
      eb
        .selectFrom('offer_redemptions as r')
        .whereRef('r.offer_id', '=', 'o.id')
        .where('r.tenant_id', '=', tenantId)
        .select(eb.fn.countAll<number>().as('n'))
        .as('tenant_redeemed_count'),
    ])
}

type OfferRow = Awaited<ReturnType<ReturnType<typeof offerQuery>['execute']>>[number]

function toOffer(row: OfferRow): OfferRecord | null {
  const kind = OfferKindSchema.safeParse(row.kind)
  const channel = row.channel === 'cloud' || row.channel === 'onprem' || row.channel === 'both' ? row.channel : null
  if (!kind.success || channel === null) return null
  return {
    id: row.id,
    code: row.code === null ? null : row.code.toUpperCase(),
    name: row.name,
    name_ta: row.name_ta,
    description: row.description,
    description_ta: row.description_ta,
    kind: kind.data,
    value: row.value,
    max_discount_paise: row.max_discount_paise,
    applies_to: row.applies_to,
    channel,
    audience: (row.audience ?? {}) as PricingOffer['audience'],
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    max_redemptions: row.max_redemptions,
    per_customer_limit: row.per_customer_limit,
    partner_id: row.partner_id,
    stackable: row.stackable,
    is_active: row.is_active,
    banner: row.banner,
    redeemed_count: Number(row.redeemed_count ?? 0),
    customer_redeemed_count: Number(row.tenant_redeemed_count ?? 0),
  }
}

/** True when the offer can apply to a cloud plan purchase (applies_to empty or a cloud SKU). */
export function targetsCloudPlans(offer: Pick<PricingOffer, 'applies_to'>): boolean {
  const codes = offer.applies_to ?? []
  return codes.length === 0 || codes.some((c) => c.startsWith('cloud_'))
}

/** Active automatic campaigns (code NULL) on the cloud channel, with redemption counts. */
export async function loadAutomaticOffers(db: Db, tenantId: string, now: Date): Promise<OfferRecord[]> {
  const rows = await offerQuery(db, tenantId)
    .where('o.code', 'is', null)
    .where('o.is_active', '=', true)
    .where('o.channel', 'in', ['cloud', 'both'])
    .where((eb) => eb.or([eb('o.starts_at', 'is', null), eb('o.starts_at', '<=', now)]))
    .where((eb) => eb.or([eb('o.ends_at', 'is', null), eb('o.ends_at', '>', now)]))
    .orderBy('o.created_at')
    .execute()
  return rows.map(toOffer).filter((o): o is OfferRecord => o !== null)
}

/** Offers that may carry an in-app banner (automatic or coupon; schedule checked by the caller). */
export async function loadBannerOffers(db: Db, tenantId: string, now: Date): Promise<OfferRecord[]> {
  const rows = await offerQuery(db, tenantId)
    .where('o.banner', 'is not', null)
    .where('o.is_active', '=', true)
    .where('o.channel', 'in', ['cloud', 'both'])
    .where((eb) => eb.or([eb('o.ends_at', 'is', null), eb('o.ends_at', '>', now)]))
    .execute()
  return rows.map(toOffer).filter((o): o is OfferRecord => o !== null)
}

/** The offer of an entered coupon code (case-insensitive), or null when unknown. */
export async function loadCoupon(db: Db, tenantId: string, code: string): Promise<OfferRecord | null> {
  const row = await offerQuery(db, tenantId).where('o.code', '=', code.trim()).executeTakeFirst()
  return row ? toOffer(row) : null
}

/** Automatic offers this tenant may use right now on a cloud plan (GET /billing/subscription). */
export function eligibleAutomaticOffers(
  offers: readonly OfferRecord[],
  buyer: BillingBuyer,
  now: Date,
): OfferRecord[] {
  return offers.filter(
    (o) =>
      targetsCloudPlans(o) &&
      offerIneligibility(o, { now, buyer: { ...pricingBuyer(buyer), channel: 'cloud' } }) === null,
  )
}

// ---------------------------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------------------------

export interface PlanQuoteInput {
  plan: CloudPlan
  cycle: BillingCycle
  buyer: BillingBuyer
  offers: readonly OfferRecord[]
  coupon: OfferRecord | null
  coupon_code: string | null
  vendor_state_code: string
  now: Date
}

/** priceOrder for one cloud plan purchase; null when the plan is not sold for the cycle. */
export function quotePlan(input: PlanQuoteInput): PriceQuote | null {
  const line = planLine(input.plan, input.cycle)
  if (!line) return null
  return priceOrder({
    lines: [line],
    offers: input.offers.filter(targetsCloudPlans),
    coupon: input.coupon,
    coupon_code: input.coupon_code,
    buyer: pricingBuyer(input.buyer),
    vendor_state_code: input.vendor_state_code,
    now: input.now,
  })
}

export interface Redemption {
  offer_id: string
  discount_paise: number
}

/**
 * Value each applied offer gives (offer_redemptions.discount_paise): its discount plus free
 * months valued at the line's price per month.
 */
export function redemptionsOf(quote: PriceQuote): Redemption[] {
  return quote.applied_offers.map((a) => {
    let value = a.discount_paise
    if (a.free_months > 0) {
      for (const line of quote.lines) {
        if (!a.line_keys.includes(line.key)) continue
        const term = line.term_months ?? 12
        value += mulDiv(line.gross_paise - line.partner_discount_paise, a.free_months, term)
      }
    }
    return { offer_id: a.offer_id, discount_paise: value }
  })
}
