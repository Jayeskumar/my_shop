import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { type RouteDef, routePermissions, routeUrl } from '../../src/api/common'
import {
  ActivationRequestInputSchema,
  CONNECT_TOKEN_HEADER,
  ConnectSnapshotSchema,
  LICENSING_ERROR_REASONS,
  LICENSING_VALIDATION_KEYS,
  LicenseAddonSchema,
  LicenseIssueSchema,
  LicenseProductCreateSchema,
  OfferAudienceSchema,
  OfferCreateSchema,
  RelayMessageRequestSchema,
  StaffCreateSchema,
  VENDOR_CAPABILITIES,
  VendorOrderCreateSchema,
  type LicensingPublicRouteDef,
  type VendorRouteDef,
  licensingPublicRoutes,
  licensingRoutes,
} from '../../src/api/licensing'
import { ERROR_CODES } from '../../src/errors'
import { DEFAULT_PLAN_LIMITS } from '../../src/features'
import {
  KEY_PREFIX,
  LICENSE_KEY,
  PHONE,
  PUBKEY,
  SHA,
  SIG,
  TS,
  TS2,
  addonEntitlements,
  amc,
  banners,
  cloudBackup,
  cloudQuota,
  id,
  invoicePrint,
  offerPublic,
  offerQuote,
  quote,
  releaseInfo,
  releasePlan,
  renewalInfo,
  signedLicense,
  term,
  vendorInfo,
} from './fixtures/vendor'

// ---- realistic rows ------------------------------------------------------------------------

const staff = {
  user_id: id(1),
  full_name: 'Priya (sales)',
  phone: PHONE,
  email: 'priya@kadai.app',
  role: 'sales',
  partner_id: null,
  partner_name: null,
  is_active: true,
  last_login_at: TS,
  created_by: id(2),
  created_at: TS,
  updated_at: TS,
}

const partner = {
  id: id(10),
  code: 'MDUPOS',
  name: 'Madurai POS Solutions',
  contact_name: 'Karthik',
  phone: '+919843000000',
  email: 'sales@mdupos.in',
  gstin: null,
  state_code: '33',
  district: 'Madurai',
  address: { line1: '5 Town Hall Road', city: 'Madurai', state_code: '33' },
  tier: 'gold',
  discount_bp: 2500,
  commission_bp: 1000,
  payout_details: { vpa: 'mdupos@okhdfc', account_name: null, account_last4: null, ifsc: null },
  status: 'active',
  notes: null,
  created_at: TS,
  updated_at: TS,
}
const partnerRow = {
  ...partner,
  customers_count: 42,
  active_licenses: 40,
  renewals_due_30d: 3,
  users_count: 2,
}

const commission = {
  id: id(20),
  partner_id: id(10),
  partner_name: 'Madurai POS Solutions',
  order_id: id(500),
  order_number: 'KD/2627/000123',
  order_kind: 'new_license',
  customer_name: 'Murugan Medicals',
  order_taxable_paise: 1_499_900,
  amount_paise: 149_990,
  status: 'accrued',
  paid_ref: null,
  paid_at: null,
  created_at: TS,
  updated_at: TS,
}

const product = {
  code: 'onprem_standard',
  kind: 'edition',
  channel: 'onprem',
  name: 'Kadai Server Standard (perpetual, 3 counters)',
  name_ta: 'ஸ்டாண்டர்டு (நிரந்தர உரிமம், 3 கவுண்டர்)',
  description: null,
  description_ta: null,
  plan_code: 'onprem_standard',
  price_paise: 1_499_900,
  price_incl_gst_paise: 1_769_882,
  term_months: null,
  included_amc_months: 12,
  renewal_price_paise: 299_900,
  limits: {},
  features: [],
  hsn_sac: '997331',
  gst_rate_bp: 1800,
  is_active: true,
  sort_order: 20,
  created_at: TS,
  updated_at: TS,
}

const customer = {
  id: id(30),
  name: 'Murugan',
  business_name: 'Murugan Medicals',
  business_name_ta: 'முருகன் மெடிக்கல்ஸ்',
  business_type: 'pharmacy',
  phone: PHONE,
  email: null,
  gstin: null,
  state_code: '33',
  district: 'Madurai',
  address: { city: 'Madurai', state_code: '33', pincode: '625001' },
  partner_id: id(10),
  partner_name: 'Madurai POS Solutions',
  tenant_id: null,
  referred_by_customer_id: null,
  referral_code: 'MURUGAN1',
  tags: ['pharmacy', 'expo-2026'],
  notes: null,
  created_by: id(1),
  created_at: TS,
  updated_at: TS,
}
const customerRow = {
  ...customer,
  active_licenses: 1,
  active_activations: 1,
  next_due_on: '2027-10-19',
  amc,
  last_check_in_at: TS,
}

const event = {
  id: 9001,
  license_id: id(100),
  activation_id: id(110),
  kind: 'activated',
  details: { machine_name: 'BILLING-PC' },
  actor_user_id: null,
  actor_name: null,
  ip: '49.37.1.2',
  created_at: TS,
}

const activation = {
  id: id(110),
  license_id: id(100),
  key_prefix: KEY_PREFIX,
  customer_id: id(30),
  business_name_customer: 'Murugan Medicals',
  installation_id: id(120),
  fingerprint_short: 'abcdef012345',
  machine_name: 'BILLING-PC',
  os: 'windows 10.0.19045 x64',
  app_version: '1.3.0',
  last_version: '1.3.2',
  business_name: 'Murugan Medicals',
  method: 'online',
  status: 'active',
  activated_at: TS,
  last_check_in_at: TS2,
  last_check_in_ip: '49.37.1.2',
  last_stats: { stores: 1, registers: 2, users: 4, products: 3200, invoices_30d: 2100 },
  connect_enabled: true,
  cloud_backup_enabled: false,
  stale: false,
  snapshot_generated_at: TS2,
  cloud_backup_used_bytes: 0,
  deactivated_at: null,
  deactivation_reason: null,
  created_at: TS,
  updated_at: TS2,
}

const licenseRow = {
  id: id(100),
  key_prefix: KEY_PREFIX,
  customer_id: id(30),
  customer_name: 'Murugan',
  business_name: 'Murugan Medicals',
  customer_phone: PHONE,
  partner_id: id(10),
  partner_name: 'Madurai POS Solutions',
  product_code: 'onprem_standard',
  product_name: 'Kadai Server Standard',
  product_name_ta: 'கடை சர்வர் ஸ்டாண்டர்டு',
  license_type: 'perpetual',
  plan_code: 'onprem_standard',
  status: 'active',
  valid_from: '2026-10-20',
  valid_until: null,
  updates_until: '2027-10-19',
  support_until: '2027-10-19',
  grace_days: 15,
  max_activations: 1,
  active_activations: 1,
  amc,
  term,
  addons: [
    {
      product_code: 'addon_counter',
      qty: 1,
      features: [],
      limits: { registers: 1 },
      valid_until: null,
    },
    {
      product_code: 'addon_connect',
      qty: 1,
      features: ['connect'],
      limits: {},
      valid_until: '2027-10-19',
    },
  ],
  last_check_in_at: TS2,
  created_at: TS,
  updated_at: TS,
}

const orderRow = {
  id: id(500),
  number: 'KD/2627/000123',
  kind: 'renewal',
  status: 'fulfilled',
  customer_id: id(30),
  customer_name: 'Murugan',
  business_name: 'Murugan Medicals',
  tenant_id: null,
  tenant_name: null,
  license_id: id(100),
  key_prefix: KEY_PREFIX,
  partner_id: null,
  partner_name: null,
  subtotal_paise: quote.subtotal_paise,
  discount_paise: quote.discount_paise,
  taxable_paise: quote.taxable_paise,
  cgst_paise: quote.cgst_paise,
  sgst_paise: quote.sgst_paise,
  igst_paise: quote.igst_paise,
  total_paise: quote.total_paise,
  place_of_supply: '33',
  buyer_gstin: null,
  coupon_code: null,
  payment_provider: 'razorpay',
  payment_ref: 'plink_N1',
  short_url: 'https://rzp.io/i/abc',
  paid_at: TS,
  fulfilled_at: TS,
  created_by: null,
  created_at: TS,
  updated_at: TS,
}

const licenseDetail = {
  ...licenseRow,
  features_override: null,
  limits_override: {},
  effective_features: ['connect', 'pos'],
  effective_limits: { ...DEFAULT_PLAN_LIMITS.onprem_standard, registers: 4 },
  suspended_reason: null,
  notes: null,
  issued_by: id(1),
  issued_by_name: 'Priya (sales)',
  transfers_last_365d: 0,
  transfers_left: 3,
  activations: [activation],
  events: [event],
  orders: [orderRow],
}

const orderDetail = {
  ...orderRow,
  lines: quote.lines,
  offer_ids: quote.offer_ids,
  redemptions: [
    {
      id: id(510),
      offer_id: id(300),
      order_id: id(500),
      order_number: 'KD/2627/000123',
      customer_id: id(30),
      customer_name: 'Murugan',
      tenant_id: null,
      tenant_name: null,
      discount_paise: quote.offer_discount_paise,
      created_at: TS,
    },
  ],
  commission: null,
  notes: null,
  created_by_name: null,
  fulfilment: { license_id: id(100), events: [{ ...event, kind: 'renewed' }], error: null },
  has_invoice: true,
}

const offer = {
  ...offerPublic,
  automatic: undefined,
  channel: 'onprem',
  audience: OfferAudienceSchema.parse({ business_types: ['pharmacy'] }),
  starts_at: '2026-10-01T00:00:00.000Z',
  max_redemptions: 500,
  per_customer_limit: 1,
  partner_id: null,
  partner_name: null,
  stackable: false,
  is_active: true,
  state: 'active',
  redeemed_count: 37,
  discount_given_paise: 3_328_890,
  created_by: id(1),
  created_at: TS,
  updated_at: TS,
}

const release = {
  id: id(600),
  ...releaseInfo,
  eligible: undefined,
  is_active: true,
  installs: 120,
  created_by: id(1),
  created_at: TS,
  updated_at: TS,
}

const announcement = {
  id: id(400),
  severity: 'offer',
  title_en: 'Deepavali offer: AMC renewal 30% off',
  title_ta: 'தீபாவளி சலுகை: AMC புதுப்பிப்பு 30% தள்ளுபடி',
  body_en: 'Renew before 10 November.',
  body_ta: null,
  cta_label_en: 'Renew now',
  cta_label_ta: 'இப்போது புதுப்பி',
  cta_url: null,
  offer_id: id(300),
  offer_name: 'Deepavali AMC 30% off',
  audience: { channels: ['onprem'], amc: 'any' },
  starts_at: '2026-10-01T00:00:00.000Z',
  ends_at: '2026-11-10T18:30:00.000Z',
  is_active: true,
  state: 'active',
  created_by: id(1),
  created_at: TS,
  updated_at: TS,
}

const usage = { stores: 1, users: 3, registers: 2, products: 850, invoices_this_month: 410 }
const tenantRow = {
  id: id(800),
  name: 'Lakshmi Stores',
  name_ta: 'லட்சுமி ஸ்டோர்ஸ்',
  business_type: 'general_store',
  state_code: '33',
  district: 'Salem',
  plan_code: 'growth',
  status: 'active',
  suspended_reason: null,
  owner_name: 'Lakshmi',
  owner_phone: '+919500000000',
  subscription_status: 'active',
  billing_cycle: 'yearly',
  current_period_end: '2027-10-20T00:00:00.000Z',
  trial_ends_at: null,
  usage,
  last_invoice_at: TS,
  created_at: TS,
}
const audit = {
  id: 77,
  actor_user_id: id(1),
  actor_name: 'Priya (sales)',
  tenant_id: id(800),
  tenant_name: 'Lakshmi Stores',
  action: 'tenant.plan_change',
  details: { from: 'free', to: 'growth' },
  ip: '10.0.0.1',
  request_id: 'req-1',
  created_at: TS,
}
const tenantDetail = {
  ...tenantRow,
  gstin: '33ABCDE1234F1Z5',
  gst_scheme: 'regular',
  phone: '+919500000000',
  email: null,
  subscription: {
    id: id(810),
    plan_code: 'growth',
    status: 'active',
    billing_cycle: 'yearly',
    current_period_start: '2026-10-20T00:00:00.000Z',
    current_period_end: '2027-10-20T00:00:00.000Z',
    trial_ends_at: null,
    cancel_at_period_end: false,
    provider: 'razorpay',
    provider_subscription_id: null,
    limit_overrides: {},
  },
  entitlements: {
    plan_code: 'growth',
    features: ['pos', 'catalog'],
    limits: DEFAULT_PLAN_LIMITS.growth,
  },
  invoices: [
    {
      id: id(500),
      source: 'order',
      number: 'KD/2627/000124',
      total_paise: 353_882,
      status: 'paid',
      created_at: TS,
    },
  ],
  vendor_customer: null,
  audit: [audit],
}
const plan = {
  code: 'growth',
  name: 'Valarchi (Growth)',
  name_ta: 'வளர்ச்சி',
  description: 'For busy single-store shops',
  price_monthly_paise: 29_900,
  price_yearly_paise: 299_900,
  limits: DEFAULT_PLAN_LIMITS.growth,
  features: ['pos', 'catalog', 'purchases'],
  is_public: true,
  sort_order: 20,
  channel: 'cloud',
  tenants_count: 1200,
  licenses_count: 0,
  updated_at: TS,
}

const metrics = {
  generated_at: TS,
  kpis: {
    mrr_paise: 35_000_000,
    license_revenue_this_month_paise: 120_000_000,
    active_licenses: 1840,
    amc_due_30d: 74,
    renewal_rate_bp: 7200,
    active_installs_7d: 1650,
  },
  cloud: {
    tenants_total: 5400,
    paying_tenants: 1300,
    trials_active: 210,
    by_plan: [{ key: 'growth', count: 1100 }],
    by_status: [{ key: 'active', count: 5300 }],
    by_business_type: [{ key: 'general_store', count: 3000 }],
    by_state: [{ key: '33', count: 5000 }],
    mrr_paise: 35_000_000,
    signups_90d: [{ date: '2026-10-19', count: 31 }],
    invoices_per_day: [{ date: '2026-10-19', count: 82_000 }],
  },
  onprem: {
    active_licenses: 1840,
    by_edition: [{ key: 'onprem_standard', count: 900 }],
    by_type: [{ key: 'perpetual', count: 1500 }],
    activations_active: 1790,
    check_ins_7d: 1650,
    version_adoption: [{ version: '1.4.0', count: 800 }],
    renewals_due: {
      d30: { count: 74, value_paise: 22_000_000 },
      d60: { count: 130, value_paise: 39_000_000 },
      d90: { count: 201, value_paise: 60_000_000 },
    },
    renewal_rate_bp: 7200,
    top_districts: [
      { state_code: '33', district: 'Madurai', customers: 210, active_licenses: 205 },
    ],
  },
  revenue_by_month: [{ period: '2026-10', onprem_paise: 120_000_000, cloud_paise: 35_000_000 }],
  partner_revenue: [
    {
      partner_id: id(10),
      partner_name: 'Madurai POS Solutions',
      revenue_paise: 9_000_000,
      commission_paise: 450_000,
    },
  ],
  recent_orders: [orderRow],
}

const licenseFile = {
  signed_license: signedLicense,
  filename: `kadai-license-${KEY_PREFIX}.kadai-license`,
  license_code: 'KDLIC1.eyJmb3JtYXQiOiJrYWRhaS1saWNlbnNlLXYxIn0',
  summary: {
    license_id: id(100),
    key_prefix: KEY_PREFIX,
    business_name: 'Murugan Medicals',
    edition_code: 'onprem_standard',
    edition_name: 'Kadai Server Standard',
    edition_name_ta: 'கடை சர்வர் ஸ்டாண்டர்டு',
    license_type: 'perpetual',
    valid_until: null,
    updates_until: '2027-10-19',
  },
  activation_id: id(110),
}

const identity = {
  installation_id: id(120),
  installation_public_key: PUBKEY,
  fingerprint_hash: 'b'.repeat(64),
  machine_name: 'BILLING-PC',
  os: 'windows 10.0.19045 x64',
  app_version: '1.3.2',
  business_name: 'Murugan Medicals',
}
const offlineRequest = {
  format: 'kadai-activation-request-v1',
  request: { ...identity, created_at: TS, nonce: 'n0nce-1234567890ab' },
  signature: SIG,
}

const snapshot = {
  schema_version: 1,
  generated_at: TS2,
  business_date: '2026-10-21',
  sales: {
    today_paise: 4_235_000,
    yesterday_paise: 5_100_000,
    bills_today: 118,
    bills_yesterday: 140,
    returns_today_paise: 12_000,
    avg_bill_paise: 35_890,
  },
  collections: {
    cash_paise: 2_100_000,
    upi_paise: 1_800_000,
    card_paise: 0,
    other_paise: 0,
    credit_paise: 335_000,
  },
  dues: { receivable_paise: 9_850_000, customers_with_due: 64, overdue_paise: 2_300_000 },
  stock: { low_stock: 23, out_of_stock: 4, expiring_30d: 11, expired: 2 },
  trend_7d: [{ date: '2026-10-21', sales_paise: 4_235_000, bills: 118 }],
  top_items: [{ name: 'Paracetamol 500mg', qty_milli: 240_000, amount_paise: 96_000 }],
  stores: [{ code: 'S1', name: 'Main', sales_today_paise: 4_235_000, bills_today: 118 }],
  open_shifts: 1,
}

const presigned = (method: 'PUT' | 'GET') => ({
  url: 'https://s3.ap-south-1.amazonaws.com/kadai-backups/x?X-Amz-Signature=…',
  method,
  headers: { 'content-type': 'application/octet-stream' },
  expires_at: TS2,
})

const relayMessage = {
  id: id(900),
  client_ref: 'notif-0192f7a4-0001',
  channel: 'whatsapp',
  template_code: 'invoice_share',
  status: 'queued',
  error: null,
  created_at: TS,
  sent_at: null,
  updated_at: TS,
  quota: { period: '2026-10', used: 121, quota: 1000 },
}

// ---- one fixture per catalogue entry ---------------------------------------------------------

interface Fixture {
  params?: unknown
  query?: unknown
  body?: unknown
  response?: unknown
}

const vendorFixtures: Record<keyof typeof licensingRoutes, Fixture> = {
  me: {
    response: {
      data: {
        user_id: id(1),
        full_name: 'Priya (sales)',
        role: 'sales',
        partner_id: null,
        partner_name: null,
        capabilities: ['vendor.dashboard', 'vendor.customers.read'],
        vendor_state_code: '33',
      },
    },
  },
  listStaff: {
    query: { role: 'sales', is_active: 'true', sort: '-created_at', limit: '20' },
    response: { data: [staff], page: { limit: 20, offset: 0, total: 1 } },
  },
  createStaff: {
    body: { phone: '98765 43210', full_name: 'Karthik', role: 'partner', partner_id: id(10) },
    response: {
      data: {
        staff: {
          ...staff,
          role: 'partner',
          partner_id: id(10),
          partner_name: 'Madurai POS Solutions',
        },
        existing_user: false,
        temporary_password: 'kd-Temp-9x2',
      },
    },
  },
  updateStaff: {
    params: { userId: id(1) },
    body: { role: 'support', if_updated_at: TS },
    response: { data: { ...staff, role: 'support' } },
  },
  listAuditLogs: {
    query: { action: 'tenant.', from: '2026-10-01', to: '2026-10-31' },
    response: { data: [audit], page: { limit: 50, offset: 0, total: 1 } },
  },
  metrics: { query: { months: '12' }, response: { data: metrics } },
  listProducts: {
    query: { kind: 'edition', channel: 'onprem', is_active: 'true' },
    response: { data: [product], page: { limit: 50, offset: 0, total: 1 } },
  },
  createProduct: {
    body: {
      code: 'addon_label_printer',
      kind: 'service',
      channel: 'onprem',
      name: 'Label printer setup',
      price_paise: 50_000,
    },
    response: {
      data: { ...product, code: 'addon_label_printer', kind: 'service', plan_code: null },
    },
  },
  updateProduct: {
    params: { code: 'onprem_standard' },
    body: { price_paise: 1_399_900, if_updated_at: TS },
    response: { data: { ...product, price_paise: 1_399_900 } },
  },
  listCustomers: {
    query: { q: '98765', amc: 'ending_soon', partner_id: id(10), sort: 'next_due_on' },
    response: { data: [customerRow], page: { limit: 50, offset: 0, total: 1 } },
  },
  createCustomer: {
    body: {
      name: 'Murugan',
      business_name: 'Murugan Medicals',
      business_type: 'pharmacy',
      phone: '9876543210',
      district: 'Madurai',
      tags: ['Expo-2026', 'expo-2026'],
    },
    response: { data: customer },
  },
  getCustomer: {
    params: { id: id(30) },
    response: {
      data: {
        ...customer,
        partner: { id: id(10), name: 'Madurai POS Solutions' },
        tenant: null,
        licenses: [licenseRow],
        activations: [activation],
        orders: [orderRow],
        timeline: [event],
        referrals: { referral_code: 'MURUGAN1', referred_customers: 2 },
        summary: {
          lifetime_value_paise: 2_017_599,
          amc,
          last_check_in_at: TS2,
          versions: ['1.3.2'],
        },
      },
    },
  },
  updateCustomer: {
    params: { id: id(30) },
    body: { notes: 'Prefers Tamil calls', if_updated_at: TS },
    response: { data: customer },
  },
  listLicenses: {
    query: { amc_due_within_days: '30', status: 'active', sort: 'updates_until' },
    response: { data: [licenseRow], page: { limit: 50, offset: 0, total: 1 } },
  },
  issueLicense: {
    body: {
      customer_id: id(30),
      product_code: 'onprem_standard',
      license_type: 'perpetual',
      addons: [{ product_code: 'addon_counter', qty: 1 }],
      send_key_via: ['whatsapp', 'email'],
    },
    response: {
      data: {
        license: licenseDetail,
        license_key: LICENSE_KEY,
        delivered_via: ['whatsapp'],
        whatsapp_url: 'https://wa.me/919876543210?text=…',
      },
    },
  },
  getLicense: { params: { id: id(100) }, response: { data: licenseDetail } },
  updateLicense: {
    params: { id: id(100) },
    body: { max_activations: 2, limits_override: { users: 15 } },
    response: { data: licenseDetail },
  },
  listLicenseEvents: {
    params: { id: id(100) },
    query: { kind: 'check_in' },
    response: { data: [event], page: { limit: 50, offset: 0, total: 1 } },
  },
  suspendLicense: {
    params: { id: id(100) },
    body: { reason: 'Payment dispute' },
    response: {
      data: { ...licenseDetail, status: 'suspended', suspended_reason: 'Payment dispute' },
    },
  },
  resumeLicense: {
    params: { id: id(100) },
    body: { reason: 'Resolved' },
    response: { data: licenseDetail },
  },
  revokeLicense: {
    params: { id: id(100) },
    body: { reason: 'Refunded' },
    response: { data: { ...licenseDetail, status: 'revoked' } },
  },
  reissueLicenseKey: {
    params: { id: id(100) },
    body: { reason: 'Customer lost the key' },
    response: {
      data: {
        license: licenseDetail,
        license_key: LICENSE_KEY,
        delivered_via: ['whatsapp'],
        whatsapp_url: null,
      },
    },
  },
  upgradeLicense: {
    params: { id: id(100) },
    body: { product_code: 'onprem_pro', order_id: id(500) },
    response: { data: { ...licenseDetail, product_code: 'onprem_pro', plan_code: 'onprem_pro' } },
  },
  addLicenseAddon: {
    params: { id: id(100) },
    body: { product_code: 'addon_cloud_backup' },
    response: { data: licenseDetail },
  },
  renewLicense: {
    params: { id: id(100) },
    body: { kind: 'amc', months: 12, order_id: id(500) },
    response: { data: { ...licenseDetail, updates_until: '2028-10-19' } },
  },
  offlineActivate: {
    body: { license_key: LICENSE_KEY.toLowerCase(), request: offlineRequest },
    response: { data: licenseFile },
  },
  listActivations: {
    query: { stale: 'true', status: 'active' },
    response: { data: [activation], page: { limit: 50, offset: 0, total: 1 } },
  },
  deactivateActivation: {
    params: { id: id(110) },
    body: { reason: 'Moved to a new PC' },
    response: {
      data: {
        ...activation,
        status: 'deactivated',
        deactivated_at: TS2,
        deactivation_reason: 'Moved to a new PC',
      },
    },
  },
  blockActivation: {
    params: { id: id(110) },
    body: { reason: 'Clone of another shop' },
    response: { data: { ...activation, status: 'blocked' } },
  },
  activationLicenseFile: { params: { id: id(110) }, response: { data: licenseFile } },
  listOffers: {
    query: { state: 'active', automatic: 'true' },
    response: { data: [offer], page: { limit: 50, offset: 0, total: 1 } },
  },
  createOffer: {
    body: {
      code: 'pongal20',
      name: 'Pongal 20% off editions',
      kind: 'percent',
      value: 2000,
      applies_to: ['onprem_starter', 'onprem_standard'],
      audience: { business_types: ['pharmacy'], segment: 'new' },
      starts_at: '2027-01-10T00:00:00+05:30',
      ends_at: '2027-01-20T00:00:00+05:30',
      banner: { title_en: 'Pongal offer', title_ta: 'பொங்கல் சலுகை' },
    },
    response: { data: { ...offer, code: 'PONGAL20' } },
  },
  getOffer: { params: { id: id(300) }, response: { data: offer } },
  updateOffer: {
    params: { id: id(300) },
    body: { is_active: false, if_updated_at: TS },
    response: { data: { ...offer, is_active: false, state: 'inactive' } },
  },
  listOfferRedemptions: {
    params: { id: id(300) },
    query: { limit: '10' },
    response: { data: orderDetail.redemptions, page: { limit: 10, offset: 0, total: 1 } },
  },
  validateOffer: {
    body: {
      coupon_code: 'pongal20',
      items: [{ product_code: 'onprem_standard' }],
      customer_id: id(30),
    },
    response: { data: { valid: true, offer: offerPublic, reason: null, quote } },
  },
  quoteOrder: {
    body: {
      kind: 'renewal',
      customer_id: id(30),
      license_id: id(100),
      items: [{ product_code: 'amc_renewal' }],
      coupon_code: '',
    },
    response: { data: quote },
  },
  listOrders: {
    query: { status: 'pending_payment', from: '2026-10-01', to: '2026-10-31', sort: '-paid_at' },
    response: { data: [orderRow], page: { limit: 50, offset: 0, total: 1 } },
  },
  createOrder: {
    body: {
      kind: 'new_license',
      customer_id: id(30),
      partner_id: id(10),
      items: [{ product_code: 'onprem_standard' }, { product_code: 'service_installation' }],
      payment_link: true,
    },
    response: { data: orderDetail },
  },
  getOrder: { params: { id: id(500) }, response: { data: orderDetail } },
  updateOrder: {
    params: { id: id(500) },
    body: { coupon_code: 'DEEPA30', status: 'pending_payment' },
    response: { data: orderDetail },
  },
  createPaymentLink: {
    params: { id: id(500) },
    body: { send_via: ['whatsapp'] },
    response: {
      data: {
        order_id: id(500),
        short_url: 'https://rzp.io/i/abc',
        payment_ref: 'plink_N1',
        amount_paise: quote.total_paise,
        expires_at: TS2,
        sent_via: ['whatsapp'],
      },
    },
  },
  markOrderPaid: {
    params: { id: id(500) },
    body: { provider: 'manual', payment_ref: '429817364512', amount_paise: quote.total_paise },
    response: { data: orderDetail },
  },
  fulfilOrder: { params: { id: id(500) }, response: { data: orderDetail } },
  cancelOrder: {
    params: { id: id(500) },
    body: { reason: 'Customer changed mind' },
    response: { data: { ...orderDetail, status: 'cancelled' } },
  },
  refundOrder: {
    params: { id: id(500) },
    body: { reason: 'Duplicate payment', refund_ref: 'rfnd_1' },
    response: { data: { ...orderDetail, status: 'refunded' } },
  },
  orderInvoice: { params: { id: id(500) }, response: { data: invoicePrint } },
  listPartners: {
    query: { tier: 'gold', district: 'Madurai' },
    response: { data: [partnerRow], page: { limit: 50, offset: 0, total: 1 } },
  },
  createPartner: {
    body: {
      code: 'mdupos',
      name: 'Madurai POS Solutions',
      phone: '9843000000',
      state_code: '33',
      tier: 'gold',
      payout_details: { vpa: 'mdupos@okhdfc', ifsc: 'hdfc0001234' },
    },
    response: { data: partner },
  },
  getPartner: {
    params: { id: id(10) },
    response: {
      data: {
        ...partner,
        stats: {
          customers: 42,
          active_licenses: 40,
          renewals_due_30d: 3,
          revenue_12m_paise: 9_000_000,
          commission_accrued_paise: 150_000,
          commission_approved_paise: 0,
          commission_paid_paise: 300_000,
        },
        users: [{ ...staff, role: 'partner', partner_id: id(10) }],
      },
    },
  },
  updatePartner: {
    params: { id: id(10) },
    body: { discount_bp: 3000, tier: 'platinum' },
    response: { data: { ...partner, tier: 'platinum', discount_bp: 3000 } },
  },
  listCommissions: {
    query: { partner_id: id(10), status: 'accrued' },
    response: { data: [commission], page: { limit: 50, offset: 0, total: 1 } },
  },
  approveCommission: {
    params: { id: id(20) },
    response: { data: { ...commission, status: 'approved' } },
  },
  payCommission: {
    params: { id: id(20) },
    body: { paid_ref: 'UPI-429817364' },
    response: { data: { ...commission, status: 'paid', paid_ref: 'UPI-429817364', paid_at: TS } },
  },
  listReleases: {
    query: { channel: 'stable' },
    response: { data: [release], page: { limit: 50, offset: 0, total: 1 } },
  },
  createRelease: {
    body: {
      version: '1.5.0',
      notes_en: 'Kadai Connect daily summary',
      notes_ta: 'கடை கனெக்ட் தினசரி சுருக்கம்',
      artifacts: [
        {
          platform: 'windows-x64',
          url: 'https://downloads.kadai.app/1.5.0/win.zip',
          sha256: SHA,
          size_bytes: 86_000_000,
        },
        { platform: 'docker', url: 'ghcr.io/kadai/server:1.5.0', sha256: SHA, size_bytes: 0 },
      ],
    },
    response: { data: { ...release, version: '1.5.0' } },
  },
  getRelease: { params: { id: id(600) }, response: { data: release } },
  updateRelease: {
    params: { id: id(600) },
    body: { mandatory: true },
    response: { data: { ...release, mandatory: true } },
  },
  listAnnouncements: {
    query: { state: 'active', channel: 'onprem' },
    response: { data: [announcement], page: { limit: 50, offset: 0, total: 1 } },
  },
  createAnnouncement: {
    body: {
      severity: 'offer',
      title_en: 'Deepavali offer: AMC renewal 30% off',
      body_en: 'Renew before 10 November.',
      cta_url: '/settings/system',
      offer_id: id(300),
      audience: { channels: ['onprem'], amc: 'active', max_version: '1.4.0' },
      ends_at: '2026-11-10T18:30:00.000Z',
    },
    response: { data: announcement },
  },
  getAnnouncement: { params: { id: id(400) }, response: { data: announcement } },
  updateAnnouncement: {
    params: { id: id(400) },
    body: { ends_at: null },
    response: { data: { ...announcement, ends_at: null } },
  },
  listTenants: {
    query: { plan_code: 'growth', created_from: '2026-01-01', sort: '-invoices_this_month' },
    response: { data: [tenantRow], page: { limit: 50, offset: 0, total: 1 } },
  },
  getTenant: { params: { id: id(800) }, response: { data: tenantDetail } },
  suspendTenant: {
    params: { id: id(800) },
    body: { reason: 'Fraudulent signup' },
    response: {
      data: { ...tenantDetail, status: 'suspended', suspended_reason: 'Fraudulent signup' },
    },
  },
  resumeTenant: { params: { id: id(800) }, body: {}, response: { data: tenantDetail } },
  changeTenantPlan: {
    params: { id: id(800) },
    body: {
      plan_code: 'pro',
      limit_overrides: { stores: 8 },
      period_end: '2027-03-31T18:30:00.000Z',
      reason: 'Enterprise pilot',
    },
    response: { data: { ...tenantDetail, plan_code: 'pro' } },
  },
  listPlans: { response: { data: [plan] } },
  updatePlan: {
    params: { code: 'growth' },
    body: {
      name: 'Valarchi (Growth)',
      name_ta: 'வளர்ச்சி',
      description: 'For busy single-store shops',
      price_monthly_paise: 29_900,
      price_yearly_paise: 299_900,
      limits: DEFAULT_PLAN_LIMITS.growth,
      features: ['pos', 'catalog'],
      is_public: true,
      sort_order: 20,
    },
    response: { data: plan },
  },
}

const publicFixtures: Record<keyof typeof licensingPublicRoutes, Fixture> = {
  activate: {
    body: { ...identity, license_key: LICENSE_KEY.replaceAll('-', ' ').toLowerCase() },
    response: {
      data: {
        signed_license: signedLicense,
        license_id: id(100),
        activation_id: id(110),
        key_prefix: KEY_PREFIX,
        reactivated: false,
        check_in_days: 7,
        vendor: vendorInfo,
      },
    },
  },
  offlineActivate: {
    body: {
      license_key: LICENSE_KEY,
      request: 'KDREQ1.eyJmb3JtYXQiOiJrYWRhaS1hY3RpdmF0aW9uLXJlcXVlc3QtdjEifQ',
    },
    response: { data: licenseFile },
  },
  checkIn: {
    body: {
      license_id: id(100),
      app_version: '1.3.2',
      platform: 'windows-x64',
      license_issued_at: TS,
      stats: { stores: 1, registers: 2, users: 4, products: 3200, invoices_30d: 2100 },
      connect_enabled: true,
      connect_snapshot: snapshot,
      update_status: {
        current_version: '1.3.2',
        last_action: 'update',
        last_state: 'done',
        last_version: '1.3.2',
        last_finished_at: TS,
        error: null,
      },
    },
    response: {
      data: {
        server_time: TS,
        next_check_in_seconds: 21_600,
        license: null,
        license_status: 'active',
        activation_status: 'active',
        banners,
        offers: [offerQuote],
        renewal: renewalInfo,
        releases: releasePlan,
        entitlements: addonEntitlements,
        vendor: vendorInfo,
      },
    },
  },
  releases: {
    query: { channel: 'stable', from_version: '1.3.2', platform: 'windows-x64' },
    response: { data: releasePlan },
  },
  renewalQuote: {
    body: { items: [{ product_code: 'amc_renewal' }], coupon_code: 'deepa30' },
    response: { data: { order_kind: 'renewal', quote } },
  },
  renewalCheckout: {
    body: { items: [{ product_code: 'amc_renewal', qty: 1 }] },
    response: {
      data: {
        order_id: id(500),
        order_kind: 'renewal',
        quote,
        total_paise: quote.total_paise,
        payment_url: 'https://rzp.io/i/abc',
        expires_at: TS2,
      },
    },
  },
  refreshLicense: {
    body: { license_id: id(100), license_issued_at: TS },
    response: { data: { changed: true, signed_license: signedLicense, license_status: 'active' } },
  },
  deactivate: {
    body: { license_id: id(100), reason: 'New computer' },
    response: { data: { deactivated_at: TS, transfers_last_365d: 1, transfers_left: 2 } },
  },
  backupUploadUrl: {
    body: { size_bytes: 52_428_800, sha256: SHA.toUpperCase(), kind: 'scheduled' },
    response: {
      data: {
        backup: { ...cloudBackup, status: 'pending' },
        upload: presigned('PUT'),
        quota: cloudQuota,
      },
    },
  },
  backupComplete: { params: { id: id(700) }, response: { data: cloudBackup } },
  listBackups: { response: { data: { backups: [cloudBackup], quota: cloudQuota } } },
  backupDownloadUrl: {
    params: { id: id(700) },
    response: { data: { backup: cloudBackup, download: presigned('GET') } },
  },
  deleteBackup: { params: { id: id(700) } },
  relaySend: {
    body: {
      channel: 'whatsapp',
      template_code: 'invoice_share',
      locale: 'ta',
      to: PHONE,
      params: { invoice_no: 'S1-A/2627/00042', amount: '₹1,180.00' },
      client_ref: 'notif-0192f7a4-0001',
    },
    response: { data: relayMessage },
  },
  relayStatus: {
    params: { id: id(900) },
    response: { data: { ...relayMessage, status: 'delivered', sent_at: TS } },
  },
  connectOtpRequest: {
    body: { phone: '98765 43210' },
    response: { data: { expires_in: 300, resend_after: 30 } },
  },
  connectOtpVerify: {
    body: { phone: '+91 98765 43210', code: '123456' },
    response: {
      data: {
        connect_token: 'ct_…',
        expires_in: 86_400,
        owner: { name: 'Murugan', business_name: 'Murugan Medicals' },
      },
    },
  },
  connectShops: {
    response: {
      data: [
        {
          activation_id: id(110),
          business_name: 'Murugan Medicals',
          machine_name: 'BILLING-PC',
          edition_name: 'Kadai Server Standard',
          edition_name_ta: 'கடை சர்வர் ஸ்டாண்டர்டு',
          connect_active: true,
          last_check_in_at: TS2,
          snapshot_generated_at: TS2,
        },
      ],
    },
  },
  connectSnapshot: {
    params: { activationId: id(110) },
    response: {
      data: {
        activation_id: id(110),
        business_name: 'Murugan Medicals',
        generated_at: TS2,
        received_at: TS2,
        stale: false,
        snapshot,
      },
    },
  },
}

function parseFixture(name: string, def: RouteDef, fx: Fixture) {
  for (const part of ['params', 'query', 'body', 'response'] as const) {
    const schema = def[part]
    if (!schema) {
      expect(fx[part], `${name}.${part} has no schema`).toBeUndefined()
      continue
    }
    expect(fx[part], `${name}.${part} fixture`).toBeDefined()
    const r = schema.safeParse(fx[part])
    if (!r.success) throw new Error(`${name}.${part}: ${JSON.stringify(r.error.issues, null, 1)}`)
  }
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!).sort()
}

describe('licensing vendor console catalogue', () => {
  const entries = Object.entries(licensingRoutes) as [string, VendorRouteDef][]

  it.each(entries)('%s parses its fixture', (name, def) => {
    parseFixture(name, def, vendorFixtures[name as keyof typeof vendorFixtures])
  })

  it.each(entries)('%s is a well-formed vendor route', (_name, def) => {
    expect(def.path.startsWith('/platform/')).toBe(true)
    expect(def.mode).toBe('cloud')
    expect(def.scope ?? 'api').toBe('api')
    expect(routePermissions(def)).toEqual([])
    if (def.vendor.capability !== null) expect(VENDOR_CAPABILITIES).toContain(def.vendor.capability)
    const params = pathParams(def.path)
    if (params.length) {
      const shape = (def.params as unknown as z.ZodObject).shape as Record<string, unknown>
      expect(Object.keys(shape).sort()).toEqual(params)
    } else expect('params' in def).toBe(false)
    if (def.method === 'GET') expect('body' in def).toBe(false)
    if (def.method !== 'DELETE') expect(def.response).toBeDefined()
    const shape = (def.response as unknown as z.ZodObject).shape as Record<string, unknown>
    expect('data' in shape).toBe(true)
  })

  it('method + path are unique; every capability is used', () => {
    const keys = entries.map(([, d]) => `${d.method} ${d.path}`)
    expect(new Set(keys).size).toBe(keys.length)
    const used = new Set(entries.map(([, d]) => d.vendor.capability))
    for (const c of VENDOR_CAPABILITIES) expect(used.has(c), c).toBe(true)
  })

  it('fixtures are really validated', () => {
    expect(
      licensingRoutes.getLicense.response.safeParse({ data: { ...licenseDetail, status: 'bogus' } })
        .success,
    ).toBe(false)
    expect(licensingRoutes.createOrder.body.safeParse({ kind: 'renewal', items: [] }).success).toBe(
      false,
    )
  })

  it('urls', () => {
    expect(routeUrl(licensingRoutes.getLicense, { id: id(1) })).toBe(
      `/api/v1/platform/licenses/${id(1)}`,
    )
    expect(routeUrl(licensingRoutes.updatePlan, { code: 'growth' })).toBe(
      '/api/v1/platform/plans/growth',
    )
  })
})

describe('licensing public catalogue', () => {
  const entries = Object.entries(licensingPublicRoutes) as [string, LicensingPublicRouteDef][]

  it.each(entries)('%s parses its fixture', (name, def) => {
    parseFixture(name, def, publicFixtures[name as keyof typeof publicFixtures])
  })

  it.each(entries)('%s is a well-formed public route', (_name, def) => {
    expect(def.scope).toBe('public')
    expect(def.auth).toBe('public')
    expect(def.mode).toBe('cloud')
    expect(def.path.startsWith('/licensing/') || def.path.startsWith('/connect/')).toBe(true)
    expect(def.licensing.rate_limit.max).toBeGreaterThan(0)
    if (def.path.startsWith('/connect/shops')) expect(def.licensing.authn).toBe('connect_token')
    const params = pathParams(def.path)
    if (params.length) {
      const shape = (def.params as unknown as z.ZodObject).shape as Record<string, unknown>
      expect(Object.keys(shape).sort()).toEqual(params)
    }
    if (def.method === 'GET') expect('body' in def).toBe(false)
  })

  it('urls and unique paths', () => {
    expect(routeUrl(licensingPublicRoutes.checkIn)).toBe('/public/v1/licensing/check-in')
    expect(routeUrl(licensingPublicRoutes.connectSnapshot, { activationId: id(1) })).toBe(
      `/public/v1/connect/shops/${id(1)}/snapshot`,
    )
    const keys = entries.map(([, d]) => `${d.method} ${d.path}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(CONNECT_TOKEN_HEADER).toBe('x-kadai-connect-token')
  })
})

describe('licensing request rules', () => {
  it('staff partner role ↔ partner_id', () => {
    expect(
      StaffCreateSchema.safeParse({ phone: PHONE, full_name: 'X', role: 'partner' }).success,
    ).toBe(false)
    expect(
      StaffCreateSchema.safeParse({
        phone: PHONE,
        full_name: 'X',
        role: 'sales',
        partner_id: id(1),
      }).success,
    ).toBe(false)
  })

  it('licence issue date rules and defaults', () => {
    const base = { customer_id: id(1), product_code: 'onprem_standard_yearly' }
    expect(LicenseIssueSchema.safeParse({ ...base, license_type: 'subscription' }).success).toBe(
      false,
    )
    expect(
      LicenseIssueSchema.safeParse({
        ...base,
        license_type: 'perpetual',
        valid_until: '2027-01-01',
      }).success,
    ).toBe(false)
    const ok = LicenseIssueSchema.parse({
      ...base,
      license_type: 'subscription',
      valid_until: '2027-10-19',
    })
    expect(ok).toMatchObject({
      max_activations: 1,
      grace_days: 15,
      check_in_days: 7,
      send_key_via: ['whatsapp'],
    })
    expect(
      LicenseIssueSchema.safeParse({
        ...base,
        license_type: 'trial',
        valid_until: '2026-11-01',
        addons: [{ product_code: 'addon_counter' }, { product_code: 'addon_counter' }],
      }).success,
    ).toBe(false)
  })

  it('price book kind rules', () => {
    const base = { code: 'x_edition', channel: 'onprem', name: 'X', price_paise: 1 }
    expect(LicenseProductCreateSchema.safeParse({ ...base, kind: 'edition' }).success).toBe(false)
    expect(
      LicenseProductCreateSchema.safeParse({ ...base, kind: 'edition', plan_code: 'onprem_pro' })
        .success,
    ).toBe(true)
    expect(LicenseProductCreateSchema.safeParse({ ...base, kind: 'amc' }).success).toBe(false)
    expect(
      LicenseProductCreateSchema.safeParse({ ...base, kind: 'amc', term_months: 12 }).success,
    ).toBe(true)
    expect(
      LicenseProductCreateSchema.safeParse({ ...base, kind: 'addon', plan_code: 'onprem_pro' })
        .success,
    ).toBe(false)
  })

  it('offer rules', () => {
    const base = { name: 'X', kind: 'percent', value: 2000 }
    expect(OfferCreateSchema.parse(base).code).toBeNull()
    expect(OfferCreateSchema.safeParse({ ...base, value: 10_001 }).success).toBe(false)
    expect(OfferCreateSchema.safeParse({ ...base, kind: 'free_months', value: 40 }).success).toBe(
      false,
    )
    expect(OfferCreateSchema.safeParse({ ...base, partner_id: id(1) }).success).toBe(false)
    expect(
      OfferCreateSchema.safeParse({ ...base, code: 'DEALER', partner_id: id(1) }).success,
    ).toBe(true)
    expect(OfferCreateSchema.safeParse({ ...base, starts_at: TS2, ends_at: TS }).success).toBe(
      false,
    )
    expect(OfferCreateSchema.safeParse({ ...base, code: 'no spaces' }).success).toBe(false)
  })

  it('orders need a buyer and (for renewals) a licence; items unique', () => {
    const items = [{ product_code: 'amc_renewal' }]
    expect(VendorOrderCreateSchema.safeParse({ kind: 'renewal', items }).success).toBe(false)
    expect(
      VendorOrderCreateSchema.safeParse({ kind: 'renewal', customer_id: id(1), items }).success,
    ).toBe(false)
    expect(
      VendorOrderCreateSchema.safeParse({
        kind: 'new_license',
        customer_id: id(1),
        items: [...items, ...items],
      }).success,
    ).toBe(false)
    const ok = VendorOrderCreateSchema.parse({ kind: 'cloud_plan', tenant_id: id(2), items })
    expect(ok).toMatchObject({ status: 'pending_payment', payment_link: false, coupon_code: null })
  })

  it('relay recipient by channel', () => {
    const base = {
      template_code: 'payment_link',
      locale: 'ta',
      params: {},
      client_ref: 'notif-12345678',
    }
    expect(
      RelayMessageRequestSchema.safeParse({ ...base, channel: 'sms', to: PHONE }).success,
    ).toBe(true)
    expect(
      RelayMessageRequestSchema.safeParse({ ...base, channel: 'sms', to: 'a@b.in' }).success,
    ).toBe(false)
    expect(
      RelayMessageRequestSchema.safeParse({ ...base, channel: 'email', to: 'a@b.in' }).success,
    ).toBe(true)
  })

  it('activation request input accepts the envelope, its code or JSON text', () => {
    expect(ActivationRequestInputSchema.safeParse(offlineRequest).success).toBe(true)
    expect(ActivationRequestInputSchema.safeParse('KDREQ1.abc').success).toBe(true)
    expect(ActivationRequestInputSchema.safeParse(JSON.stringify(offlineRequest)).success).toBe(
      true,
    )
    expect(ActivationRequestInputSchema.safeParse('hello').success).toBe(false)
  })

  it('licence add-on defaults & snapshot size bound', () => {
    expect(LicenseAddonSchema.parse({ product_code: 'addon_counter', qty: 1 })).toEqual({
      product_code: 'addon_counter',
      qty: 1,
      features: [],
      limits: {},
      valid_until: null,
    })
    expect(ConnectSnapshotSchema.safeParse({ ...snapshot, schema_version: 2 }).success).toBe(false)
  })

  it('error reasons map to real error codes; validation keys are snake_case', () => {
    for (const [reason, def] of Object.entries(LICENSING_ERROR_REASONS)) {
      expect(Object.hasOwn(ERROR_CODES, def.code), reason).toBe(true)
      expect(def.ta).toMatch(/[஀-௿]/)
    }
    for (const k of LICENSING_VALIDATION_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})
