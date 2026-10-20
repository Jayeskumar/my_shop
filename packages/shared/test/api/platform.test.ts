import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { type RouteDef, routePermissions, routeUrl } from '../../src/api/common'
import { priceWithGst } from '../../src/api/licensing'
import {
  API_KEY_RE,
  ApiKeyCreateSchema,
  BillingQuoteRequestSchema,
  CLOUD_PLAN_NAMES,
  CheckoutRequestSchema,
  PLATFORM_RAZORPAY_EVENTS,
  PLATFORM_VALIDATION_KEYS,
  RAZORPAY_SUBSCRIPTION_EVENT_STATUS,
  apiKeyState,
  cloudPlanProductCode,
  daysLeft,
  missingPermissions,
  platformRoutes,
  razorpayPlanEnvVar,
  usageMeter,
  yearlySavings,
} from '../../src/api/platform'
import { CLOUD_PLAN_CODES, DEFAULT_PLAN_FEATURES, DEFAULT_PLAN_LIMITS } from '../../src/features'
import { isFeature } from '../../src/features'
import { isPermission } from '../../src/permissions'
import { PHONE, TS, TS2, banners, id, invoicePrint, offerPublic, quote } from './fixtures/vendor'

describe('platform helpers', () => {
  it('cloud plan product codes & Razorpay plan env vars', () => {
    expect(cloudPlanProductCode('growth', 'yearly')).toBe('cloud_growth_yearly')
    expect(cloudPlanProductCode('pro', 'monthly')).toBe('cloud_pro_monthly')
    expect(razorpayPlanEnvVar('growth', 'monthly')).toBe('RAZORPAY_PLAN_GROWTH_MONTHLY')
    for (const code of CLOUD_PLAN_CODES) expect(CLOUD_PLAN_NAMES[code]?.ta).toMatch(/[஀-௿]/)
    expect(CLOUD_PLAN_NAMES.growth?.short).toBe('Valarchi')
  })

  it('yearly savings', () => {
    // ₹299 × 12 = ₹3,588 vs ₹2,999 → ₹589 (16.42%)
    expect(yearlySavings(29_900, 299_900)).toEqual({ savings_paise: 58_900, savings_bp: 1642 })
    expect(yearlySavings(0, 0)).toEqual({ savings_paise: 0, savings_bp: 0 })
    expect(yearlySavings(10_000, 200_000)).toEqual({ savings_paise: 0, savings_bp: 0 })
    expect(priceWithGst(29_900)).toBe(35_282)
  })

  it('days left rounds up and never goes negative', () => {
    expect(daysLeft(null, TS)).toBeNull()
    expect(daysLeft('2026-10-20T10:30:00.001Z', TS)).toBe(1)
    expect(daysLeft('2026-11-03T10:30:00.000Z', TS)).toBe(14)
    expect(daysLeft('2026-10-01T00:00:00.000Z', TS)).toBe(0)
  })

  it('usage meters', () => {
    expect(usageMeter('users', 3, null)).toEqual({
      metric: 'users',
      used: 3,
      limit: null,
      used_bp: null,
      state: 'ok',
    })
    expect(usageMeter('invoices_per_month', 120, 300)).toMatchObject({ used_bp: 4000, state: 'ok' })
    expect(usageMeter('invoices_per_month', 240, 300)).toMatchObject({
      used_bp: 8000,
      state: 'warning',
    })
    expect(usageMeter('invoices_per_month', 300, 300)).toMatchObject({
      used_bp: 10_000,
      state: 'at_limit',
    })
    expect(usageMeter('stores', 2, 1)).toMatchObject({ used_bp: 10_000, state: 'at_limit' })
    expect(usageMeter('stores', 0, 0)).toMatchObject({ state: 'at_limit' })
  })

  it('subscription state machine for Razorpay events', () => {
    expect(RAZORPAY_SUBSCRIPTION_EVENT_STATUS['subscription.charged']).toBe('active')
    expect(RAZORPAY_SUBSCRIPTION_EVENT_STATUS['subscription.halted']).toBe('past_due')
    expect(RAZORPAY_SUBSCRIPTION_EVENT_STATUS['subscription.completed']).toBe('expired')
    for (const e of PLATFORM_RAZORPAY_EVENTS)
      if (e.startsWith('subscription.'))
        expect(Object.hasOwn(RAZORPAY_SUBSCRIPTION_EVENT_STATUS, e), e).toBe(true)
  })

  it('API keys: state, permission subset, format', () => {
    expect(apiKeyState({ revoked_at: null, expires_at: null }, TS)).toBe('active')
    expect(apiKeyState({ revoked_at: TS, expires_at: null }, TS2)).toBe('revoked')
    expect(apiKeyState({ revoked_at: null, expires_at: TS }, TS2)).toBe('expired')
    expect(apiKeyState({ revoked_at: null, expires_at: TS2 }, TS)).toBe('active')
    expect(missingPermissions(['catalog.read', 'catalog.write'], ['catalog.write'])).toEqual([])
    expect(missingPermissions(['sales.read', 'billing.manage'], ['sales.*'])).toEqual([
      'billing.manage',
    ])
    expect(missingPermissions(['billing.manage'], ['*'])).toEqual([])
    expect(API_KEY_RE.test(`kd_live_ab12cd34_${'x'.repeat(43)}`)).toBe(true)
    expect(API_KEY_RE.test('kd_live_AB12CD34_short')).toBe(false)
    const parsed = ApiKeyCreateSchema.parse({
      name: 'Tally sync',
      permissions: ['sales.read', 'sales.read', 'customers.read'],
    })
    expect(parsed).toEqual({
      name: 'Tally sync',
      permissions: ['sales.read', 'customers.read'],
      store_ids: null,
      expires_at: null,
    })
    expect(ApiKeyCreateSchema.safeParse({ name: 'x', permissions: [] }).success).toBe(false)
    expect(ApiKeyCreateSchema.safeParse({ name: 'x', permissions: ['nope'] }).success).toBe(false)
    expect(
      ApiKeyCreateSchema.safeParse({ name: 'x', permissions: ['sales.read'], store_ids: [] })
        .success,
    ).toBe(false)
  })

  it('checkout rules', () => {
    expect(
      BillingQuoteRequestSchema.safeParse({ plan_code: 'free', cycle: 'yearly' }).success,
    ).toBe(false)
    expect(
      BillingQuoteRequestSchema.parse({ plan_code: 'growth', cycle: 'yearly', coupon_code: '' }),
    ).toEqual({ plan_code: 'growth', cycle: 'yearly', coupon_code: null })
    expect(
      CheckoutRequestSchema.safeParse({ plan_code: 'pro', cycle: 'yearly', auto_renew: true })
        .success,
    ).toBe(false)
    expect(
      CheckoutRequestSchema.parse({ plan_code: 'pro', cycle: 'monthly', auto_renew: true }),
    ).toMatchObject({ auto_renew: true })
    for (const k of PLATFORM_VALIDATION_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

// ---- fixtures ------------------------------------------------------------------------------

const plan = {
  code: 'growth',
  name: 'Valarchi (Growth)',
  name_ta: 'வளர்ச்சி',
  description: 'For busy single-store shops',
  features: [...DEFAULT_PLAN_FEATURES.growth],
  limits: DEFAULT_PLAN_LIMITS.growth,
  price_monthly_paise: 29_900,
  price_yearly_paise: 299_900,
  gst_rate_bp: 1800,
  price_monthly_incl_gst_paise: 35_282,
  price_yearly_incl_gst_paise: 353_882,
  yearly_savings_paise: 58_900,
  yearly_savings_bp: 1642,
  purchasable: true,
  is_current: false,
  recommended: true,
  sort_order: 20,
  product_codes: { monthly: 'cloud_growth_monthly', yearly: 'cloud_growth_yearly' },
}
const subscription = {
  id: id(810),
  plan_code: 'growth',
  plan_name: 'Valarchi (Growth)',
  plan_name_ta: 'வளர்ச்சி',
  status: 'trialing',
  billing_cycle: 'monthly',
  current_period_start: TS,
  current_period_end: '2026-11-03T10:30:00.000Z',
  trial_ends_at: '2026-11-03T10:30:00.000Z',
  cancel_at_period_end: false,
  provider: null,
  auto_renew: false,
  days_left: 14,
}
const apiKey = {
  id: id(950),
  name: 'Tally sync',
  key_prefix: 'kd_live_ab12cd34',
  permissions: ['sales.read', 'customers.read'],
  store_ids: null,
  last_used_at: TS2,
  expires_at: null,
  revoked_at: null,
  state: 'active',
  created_by: id(1),
  created_by_name: 'Lakshmi',
  created_at: TS,
  updated_at: TS,
}

interface Fixture {
  params?: unknown
  query?: unknown
  body?: unknown
  response?: unknown
}

const fixtures: Record<keyof typeof platformRoutes, Fixture> = {
  billingPlans: {
    response: {
      data: {
        plans: [plan, { ...plan, code: 'free', recommended: false, is_current: true }],
        current_plan_code: 'free',
      },
    },
  },
  billingSubscription: {
    response: {
      data: {
        plan,
        subscription,
        entitlements: {
          plan_code: 'growth',
          features: plan.features,
          limits: plan.limits,
          source: 'plan',
          valid_until: subscription.current_period_end,
        },
        usage: [usageMeter('stores', 1, 1), usageMeter('invoices_per_month', 410, null)],
        trial: { active: true, ends_at: subscription.trial_ends_at, days_left: 14 },
        offers: [{ ...offerPublic, applies_to: ['cloud_growth_yearly'] }],
        pending_checkout: null,
        can_cancel: false,
        tenant_state_code: '33',
        vendor_state_code: '33',
      },
    },
  },
  billingQuote: {
    body: { plan_code: 'growth', cycle: 'yearly', coupon_code: 'deepa30' },
    response: {
      data: {
        plan_code: 'growth',
        cycle: 'yearly',
        quote,
        period_start: '2026-10-20',
        period_end: '2027-10-19',
        first_charge_on: null,
        auto_renew_available: false,
      },
    },
  },
  billingCheckout: {
    body: { plan_code: 'growth', cycle: 'monthly', auto_renew: true },
    response: {
      data: {
        mode: 'subscription',
        short_url: 'https://rzp.io/i/sub_1',
        order_id: null,
        provider_subscription_id: 'sub_N1',
        total_paise: 35_282,
        first_charge_on: '2026-11-03',
        expires_at: null,
      },
    },
  },
  billingCancel: {
    body: { reason: 'moving_to_onprem', feedback: 'Buying Kadai Server' },
    response: { data: { ...subscription, status: 'active', cancel_at_period_end: true } },
  },
  billingInvoices: {
    query: { from: '2026-04-01', sort: '-date' },
    response: {
      data: [
        {
          id: id(500),
          source: 'order',
          number: 'KD/2627/000124',
          date: '2026-10-20',
          plan_code: 'growth',
          billing_cycle: 'yearly',
          period_start: '2026-10-20',
          period_end: '2027-10-19',
          taxable_paise: 299_900,
          cgst_paise: 26_991,
          sgst_paise: 26_991,
          igst_paise: 0,
          total_paise: 353_882,
          status: 'paid',
          paid_at: TS,
        },
      ],
      page: { limit: 50, offset: 0, total: 1 },
    },
  },
  billingInvoicePrint: {
    params: { id: id(500) },
    response: { data: { ...invoicePrint, kind: 'cloud_plan' } },
  },
  razorpayWebhook: { response: { data: { ok: true } } },
  announcements: { response: { data: banners } },
  dismissAnnouncement: { params: { id: id(400) } },
  systemInfo: {
    response: {
      data: {
        version: '1.4.0',
        git_commit: 'a1b2c3d',
        mode: 'onprem',
        node_version: 'v22.12.0',
        platform: 'win32',
        arch: 'x64',
        started_at: TS,
        uptime_seconds: 3600,
        server_time: TS2,
        timezone: 'Asia/Kolkata',
        db: {
          server_version: '16.4',
          size_bytes: 524_288_000,
          migrations_applied: 10,
          last_migration: '0010_vendor_licensing.sql',
          last_migration_at: TS,
          pending_migrations: 0,
        },
        worker: { embedded: true, heartbeat_at: TS2, heartbeat_age_seconds: 12, healthy: true },
        storage: { driver: 'local' },
        entitlements: { plan_code: 'onprem_standard', source: 'license' },
        onprem: {
          installation_id: id(120),
          license_state: 'valid',
          edition_name: 'Kadai Server Standard',
          updates_until: '2027-10-19',
          last_backup_at: TS,
          last_backup_status: 'completed',
          last_check_in_at: TS2,
          data_dir: 'C:\\Kadai\\data',
          data_dir_free_bytes: 120_000_000_000,
          update_state: 'idle',
        },
      },
    },
  },
  listApiKeys: {
    query: { state: 'active', sort: 'name' },
    response: { data: [apiKey], page: { limit: 50, offset: 0, total: 1 } },
  },
  createApiKey: {
    body: {
      name: 'Tally sync',
      permissions: ['sales.read', 'customers.read'],
      expires_at: '2027-10-20T00:00:00+05:30',
    },
    response: { data: { api_key: apiKey, key: `kd_live_ab12cd34_${'s'.repeat(43)}` } },
  },
  revokeApiKey: {
    params: { id: id(950) },
    body: { reason: 'Integration retired' },
    response: { data: { ...apiKey, revoked_at: TS2, state: 'revoked' } },
  },
}

describe('platform catalogue', () => {
  const entries = Object.entries(platformRoutes) as [string, RouteDef][]

  it.each(entries)('%s parses its fixture', (name, def) => {
    const fx = fixtures[name as keyof typeof fixtures]
    for (const part of ['params', 'query', 'body', 'response'] as const) {
      const schema = def[part]
      if (!schema) {
        expect(fx[part], `${name}.${part}`).toBeUndefined()
        continue
      }
      const r = schema.safeParse(fx[part])
      if (!r.success) throw new Error(`${name}.${part}: ${JSON.stringify(r.error.issues, null, 1)}`)
    }
  })

  it.each(entries)('%s is well-formed', (_name, def) => {
    for (const p of routePermissions(def)) expect(isPermission(p)).toBe(true)
    if ('feature' in def && def.feature) expect(isFeature(def.feature)).toBe(true)
    const params = [...def.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!)
    if (params.length) {
      const shape = (def.params as unknown as z.ZodObject).shape as Record<string, unknown>
      expect(Object.keys(shape).sort()).toEqual(params.sort())
    }
    if (def.method === 'GET') expect('body' in def).toBe(false)
  })

  it('billing is cloud-only; system info & API keys exist in both modes; webhook path is fixed', () => {
    for (const [name, def] of entries) {
      if (name.startsWith('billing') || name.includes('nnouncement')) expect(def.mode).toBe('cloud')
    }
    expect('mode' in platformRoutes.systemInfo).toBe(false)
    expect('mode' in platformRoutes.createApiKey).toBe(false)
    expect(routeUrl(platformRoutes.razorpayWebhook)).toBe('/webhooks/platform/razorpay')
    expect(routeUrl(platformRoutes.billingInvoicePrint, { id: id(1) })).toBe(
      `/api/v1/billing/invoices/${id(1)}/print`,
    )
  })

  it('fixtures are really validated', () => {
    expect(
      platformRoutes.billingSubscription.response.safeParse({
        data: {
          ...(fixtures.billingSubscription.response as { data: object }).data,
          usage: [{ metric: 'bogus' }],
        },
      }).success,
    ).toBe(false)
    expect(PHONE).toMatch(/^\+91/)
  })
})
