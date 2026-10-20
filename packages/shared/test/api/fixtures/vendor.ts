/**
 * Realistic fixtures for the licensing / platform / onprem contract smoke tests (shapes the
 * server would return; ids are fixed UUID v7-looking strings).
 */
import {
  type Banner,
  type PriceQuote,
  generateLicenseKey,
  licenseKeyPrefix,
  priceOrder,
  selectBanners,
} from '../../../src/api/licensing'
import { DEFAULT_PLAN_FEATURES, DEFAULT_PLAN_LIMITS } from '../../../src/features'

export const id = (n: number): string => `0192f7a4-5b6c-7d8e-9f01-${String(n).padStart(12, '0')}`
export const TS = '2026-10-20T10:30:00.000Z'
export const TS2 = '2026-10-21T04:00:00.000Z'
export const PHONE = '+919876543210'
export const SHA = 'a'.repeat(64)
export const SIG = `${'Q'.repeat(86)}==`
export const PUBKEY = `MCowBQYDK2VwAyEA${'x'.repeat(43)}=`
export const LICENSE_KEY = generateLicenseKey((n) =>
  Uint8Array.from({ length: n }, (_, i) => i * 7),
)
export const KEY_PREFIX = licenseKeyPrefix(LICENSE_KEY)

export const signedLicense = {
  format: 'kadai-license-v1' as const,
  kid: 'prod-2026',
  license: {
    license_id: id(100),
    licensee: 'Murugan',
    business_name: 'Murugan Medicals',
    plan_code: 'onprem_standard',
    max_stores: 1,
    valid_from: '2026-10-20',
    valid_until: null,
    issued_at: TS,
    edition: 'onprem_standard',
    license_type: 'perpetual',
    updates_until: '2027-10-19',
  },
  signature: SIG,
}

export const quote: PriceQuote = priceOrder({
  lines: [
    {
      product_code: 'amc_renewal',
      kind: 'amc',
      name: 'Updates & support (AMC) — 1 year',
      name_ta: 'புதுப்பிப்புகள் & ஆதரவு (AMC) — 1 ஆண்டு',
      qty: 1,
      unit_price_paise: 299_900,
      gst_rate_bp: 1800,
      term_months: 12,
    },
  ],
  offers: [
    { id: id(300), code: null, name: 'Deepavali AMC 30% off', kind: 'percent', value: 3000 },
  ],
  coupon_code: null,
  buyer: { channel: 'onprem', state_code: '33', business_type: 'pharmacy', segments: ['existing'] },
  vendor_state_code: '33',
  now: TS,
})

export const banners: Banner[] = selectBanners({
  announcements: [
    {
      id: id(400),
      severity: 'offer',
      title_en: 'Deepavali offer: AMC renewal 30% off',
      title_ta: 'தீபாவளி சலுகை: AMC புதுப்பிப்பு 30% தள்ளுபடி',
      body_en: 'Renew before 10 November.',
      body_ta: 'நவம்பர் 10க்குள் புதுப்பிக்கவும்.',
      offer_id: id(300),
      starts_at: '2026-10-01T00:00:00.000Z',
      ends_at: '2026-11-10T18:30:00.000Z',
    },
  ],
  offers: [],
  target: { channel: 'onprem', business_type: 'pharmacy' },
  now: TS,
})

export const amc = { status: 'active' as const, until: '2027-10-19', days_left: 364 }
export const term = {
  status: 'perpetual' as const,
  until: null,
  days_left: null,
  grace_ends_on: null,
}

export const releaseInfo = {
  version: '1.4.0',
  channel: 'stable' as const,
  released_at: '2026-10-01T06:00:00.000Z',
  notes_en: 'Faster billing, GSTR-1 JSON export fixes.',
  notes_ta: 'வேகமான பில்லிங், GSTR-1 திருத்தங்கள்.',
  min_upgrade_from: null,
  mandatory: false,
  eligible: true,
  artifacts: [
    {
      platform: 'windows-x64' as const,
      url: 'https://downloads.kadai.app/1.4.0/kadai-server-win-x64.zip',
      sha256: SHA,
      size_bytes: 85_000_000,
      signature: SIG,
    },
  ],
}

export const releasePlan = {
  current_version: '1.3.2',
  updates_until: '2027-10-19',
  releases: [releaseInfo],
  latest_eligible: releaseInfo,
  newest_ineligible: null,
  next_step: '1.4.0',
}

export const vendorInfo = {
  name: 'Kadai',
  legal_name: 'Kadai Software Pvt Ltd',
  gstin: '33AABCK1234F1Z5',
  state_code: '33',
  website: 'https://kadai.app',
  support_phone: '+914400000000',
  support_whatsapp: '+919800000000',
  support_email: 'support@kadai.app',
  support_hours_en: 'Mon–Sat 9am–9pm',
  support_hours_ta: 'திங்கள்–சனி காலை 9–இரவு 9',
  activation_url: 'https://kadai.app/activate',
  connect_url: 'https://kadai.app/connect',
}

export const addonEntitlements = {
  connect: { licensed: true, valid_until: '2027-10-19', snapshot_accepted: true },
  cloud_backup: {
    licensed: false,
    valid_until: null,
    quota_bytes: 0,
    used_bytes: 0,
    retention_days: 30,
  },
  relay: { licensed: true, period: '2026-10', used: 120, quota: 1000 },
}

export const offerPublic = {
  id: id(300),
  code: null,
  name: 'Deepavali AMC 30% off',
  name_ta: 'தீபாவளி AMC 30% தள்ளுபடி',
  description: null,
  description_ta: null,
  kind: 'percent' as const,
  value: 3000,
  max_discount_paise: null,
  applies_to: ['amc_renewal'],
  ends_at: '2026-11-10T18:30:00.000Z',
  banner: {
    title_en: 'Deepavali offer',
    title_ta: 'தீபாவளி சலுகை',
    body_en: null,
    body_ta: null,
    cta_en: 'Renew',
    cta_ta: 'புதுப்பி',
  },
  automatic: true,
}

export const offerQuote = {
  purpose: 'renewal' as const,
  offer: offerPublic,
  items: [{ product_code: 'amc_renewal', qty: 1 }],
  quote,
}

export const renewalInfo = {
  kind: 'amc' as const,
  due_on: '2027-10-19',
  amc,
  term,
  items: [{ product_code: 'amc_renewal', qty: 1 }],
  quote,
  checkout_available: true,
  checkout_url: null,
}

export const cloudBackup = {
  id: id(700),
  size_bytes: 52_428_800,
  sha256: SHA,
  status: 'stored' as const,
  created_at: TS,
  expires_at: '2026-11-19T10:30:00.000Z',
}

export const cloudQuota = {
  quota_bytes: 10 * 1024 ** 3,
  used_bytes: 52_428_800,
  retention_days: 30,
}

export const entitlements = {
  plan_code: 'onprem_standard',
  features: [...DEFAULT_PLAN_FEATURES.onprem_standard],
  limits: DEFAULT_PLAN_LIMITS.onprem_standard,
  source: 'license' as const,
  valid_until: null,
}

export const invoicePrint = {
  number: 'KD/2627/000123',
  date: '2026-10-20',
  order_id: id(500),
  kind: 'renewal' as const,
  seller: {
    name: 'Kadai',
    legal_name: 'Kadai Software Pvt Ltd',
    gstin: '33AABCK1234F1Z5',
    address: { line1: '12 Anna Salai', city: 'Chennai', state_code: '33', pincode: '600002' },
    state_code: '33',
    state_name: 'Tamil Nadu',
    phone: '+914400000000',
    email: 'billing@kadai.app',
  },
  buyer: {
    name: 'Murugan Medicals',
    legal_name: null,
    gstin: null,
    address: { city: 'Madurai', state_code: '33' },
    state_code: '33',
    state_name: 'Tamil Nadu',
    phone: PHONE,
    email: null,
  },
  place_of_supply: '33',
  place_of_supply_name: '33-Tamil Nadu',
  is_interstate: false,
  reverse_charge: false,
  lines: [
    {
      sl: 1,
      description_en: 'Updates & support (AMC) — 1 year',
      description_ta: 'புதுப்பிப்புகள் & ஆதரவு (AMC) — 1 ஆண்டு',
      sac: '997331',
      qty: 1,
      unit_price_paise: 299_900,
      discount_paise: 89_970,
      taxable_paise: 209_930,
      gst_rate_bp: 1800,
      cgst_paise: 18_894,
      sgst_paise: 18_893,
      igst_paise: 0,
      total_paise: 247_717,
      period_from: '2027-10-20',
      period_to: '2028-10-19',
    },
  ],
  tax_breakup: [
    {
      gst_rate_bp: 1800,
      taxable_paise: 209_930,
      cgst_paise: 18_894,
      sgst_paise: 18_893,
      igst_paise: 0,
    },
  ],
  subtotal_paise: 299_900,
  discount_paise: 89_970,
  taxable_paise: 209_930,
  cgst_paise: 18_894,
  sgst_paise: 18_893,
  igst_paise: 0,
  total_paise: 247_717,
  amount_in_words_en: 'Rupees Two Thousand Four Hundred Seventy Seven and Seventeen Paise Only',
  amount_in_words_ta: 'ரூபாய் இரண்டாயிரத்து நானூற்று எழுபத்தேழு',
  payment: { provider: 'razorpay' as const, reference: 'pay_N1', paid_at: TS },
  status: 'paid' as const,
  notes: null,
}
