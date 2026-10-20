import { describe, expect, it } from 'vitest'
import {
  CROCKFORD_ALPHABET,
  EMPTY_BODY_SHA256,
  INSTALLATION_HEADER,
  LICENSE_KEY_RE,
  OFFER_REJECT_REASONS,
  SIGNATURE_HEADER,
  STAFF_ROLE_CAPABILITIES,
  TIMESTAMP_HEADER,
  VENDOR_CAPABILITIES,
  VENDOR_INVOICE_NUMBER_RE,
  VENDOR_ORDER_TRANSITIONS,
  activationRequestFilename,
  amcStatus,
  announcementAudienceMatches,
  buyerSegments,
  canTransitionCommission,
  canTransitionOrder,
  compareSemver,
  crockfordCheckChar,
  extendTermEnd,
  formatLicenseKeyInput,
  formatVendorInvoiceNumber,
  generateLicenseKey,
  installationSignaturePayload,
  invoiceTotals,
  isLicenseKey,
  isReleaseEligible,
  isScheduleActive,
  isSemver,
  isTimestampFresh,
  licenseEffectiveFeatures,
  licenseEffectiveLimits,
  licenseFilename,
  licenseKeyPrefix,
  licenseMaxStores,
  licenseTermStatus,
  maskLicenseKey,
  offerIneligibility,
  offerState,
  parseLicenseKey,
  parseSignedRequestHeaders,
  partnerCommissionPaise,
  placeOfSupplyName,
  planUpgrades,
  priceWithGst,
  releaseSignatureMessage,
  selectBanners,
  signedRequestHeaders,
  termEndDate,
  timestampSkewSeconds,
  unixSeconds,
  vendorCan,
  vendorCapabilitiesFor,
  vendorInvoiceCounterKey,
  vendorInvoiceFy,
  zLicenseKey,
  type AnnouncementLike,
  type BannerOfferLike,
  type PricingOffer,
  type ReleaseLike,
} from '../../src/api/licensing'
import { DEFAULT_PLAN_LIMITS } from '../../src/features'
import { PlatformStaffRoleSchema, VendorOrderStatusSchema } from '../../src/enums'
import { createRng } from '../helpers/prng'

const bytes = (seed: number) => (n: number) => {
  const rng = createRng(seed)
  return Uint8Array.from({ length: n }, () => rng.int(0, 255))
}

describe('licence keys', () => {
  it('generates canonical, checksum-valid keys', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const key = generateLicenseKey(bytes(seed))
      expect(key).toMatch(LICENSE_KEY_RE)
      expect(isLicenseKey(key)).toBe(true)
      expect(parseLicenseKey(key)).toBe(key)
    }
    // real randomness (Web Crypto in Node 22)
    const a = generateLicenseKey()
    const b = generateLicenseKey()
    expect(a).not.toBe(b)
    expect(isLicenseKey(a)).toBe(true)
  })

  it('check symbol detects every single-symbol substitution', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const key = generateLicenseKey(bytes(seed))
      const symbols = key.replaceAll('-', '').slice(2)
      for (let pos = 0; pos < 16; pos++) {
        for (const ch of CROCKFORD_ALPHABET) {
          if (ch === symbols[pos]) continue
          const typo = symbols.slice(0, pos) + ch + symbols.slice(pos + 1)
          expect(parseLicenseKey(typo), `${typo}`).toBeNull()
        }
      }
    }
  })

  it('check symbol detects most adjacent transpositions', () => {
    let detected = 0
    let total = 0
    for (let seed = 1; seed <= 50; seed++) {
      const symbols = generateLicenseKey(bytes(seed)).replaceAll('-', '').slice(2)
      for (let i = 0; i < 15; i++) {
        if (symbols[i] === symbols[i + 1]) continue
        const swapped = symbols.slice(0, i) + symbols[i + 1] + symbols[i] + symbols.slice(i + 2)
        total++
        if (parseLicenseKey(swapped) === null) detected++
      }
    }
    expect(detected / total).toBeGreaterThan(0.95)
  })

  it('normalizes typed input (case, separators, O/I/L, optional KD prefix)', () => {
    const key = generateLicenseKey(bytes(7))
    const body = key.slice(3)
    expect(parseLicenseKey(key.toLowerCase())).toBe(key)
    expect(parseLicenseKey(body.replaceAll('-', ''))).toBe(key)
    expect(parseLicenseKey(`kd ${body.replaceAll('-', ' ')}`)).toBe(key)
    expect(parseLicenseKey(` ${key} `)).toBe(key)
    const withAlias = key.replaceAll('0', 'O').replaceAll('1', 'I')
    expect(parseLicenseKey(withAlias)).toBe(key)
    expect(parseLicenseKey('KD-1234')).toBeNull()
    expect(parseLicenseKey('KD-UUUU-UUUU-UUUU-UUUU')).toBeNull()
    expect(isLicenseKey(key.toLowerCase())).toBe(false)
    expect(zLicenseKey.parse(key.toLowerCase())).toBe(key)
    expect(zLicenseKey.safeParse('KD-XXXX').success).toBe(false)
  })

  it('prefix, mask and auto-format', () => {
    const key = generateLicenseKey(bytes(3))
    expect(licenseKeyPrefix(key)).toBe(key.slice(0, 7))
    expect(licenseKeyPrefix(key)).toMatch(/^KD-[0-9A-Z]{4}$/)
    expect(maskLicenseKey('KD-7Q2M')).toBe('KD-7Q2M-••••-••••-••••')
    expect(() => licenseKeyPrefix('nope')).toThrow(RangeError)
    expect(formatLicenseKeyInput('')).toBe('')
    expect(formatLicenseKeyInput('7q2')).toBe('KD-7Q2')
    expect(formatLicenseKeyInput('7q2m9')).toBe('KD-7Q2M-9')
    expect(formatLicenseKeyInput('kd-7q2m-9x')).toBe('KD-7Q2M-9X')
    expect(formatLicenseKeyInput('o1l')).toBe('KD-011')
    expect(formatLicenseKeyInput('KD7Q2M9XAAAABBBBCCCCDDDD')).toBe('KD-7Q2M-9XAA-AABB-BBCC')
    expect(formatLicenseKeyInput(key)).toBe(key)
  })

  it('crockfordCheckChar rejects symbols outside the alphabet', () => {
    expect(() => crockfordCheckChar('ABCU')).toThrow(RangeError)
    expect(CROCKFORD_ALPHABET).toHaveLength(32)
  })
})

describe('installation-signed requests', () => {
  it('builds the canonical string', () => {
    expect(
      installationSignaturePayload({
        method: 'post',
        path: '/public/v1/licensing/check-in',
        timestamp: 1_792_000_000,
        body_sha256: 'AB'.repeat(32),
      }),
    ).toBe(`POST\n/public/v1/licensing/check-in\n1792000000\n${'ab'.repeat(32)}`)
    expect(
      installationSignaturePayload({
        method: 'GET',
        path: '/public/v1/licensing/releases?channel=stable&from_version=1.2.0',
        timestamp: '1792000000',
        body_sha256: EMPTY_BODY_SHA256,
      }),
    ).toBe(
      `GET\n/public/v1/licensing/releases?channel=stable&from_version=1.2.0\n1792000000\n${EMPTY_BODY_SHA256}`,
    )
  })

  it('rejects ambiguous parts', () => {
    const ok = { method: 'POST', path: '/x', timestamp: 1, body_sha256: EMPTY_BODY_SHA256 }
    expect(() => installationSignaturePayload({ ...ok, path: 'x' })).toThrow(RangeError)
    expect(() => installationSignaturePayload({ ...ok, path: '/x\nGET' })).toThrow(RangeError)
    expect(() => installationSignaturePayload({ ...ok, timestamp: '1.5' })).toThrow(RangeError)
    expect(() => installationSignaturePayload({ ...ok, body_sha256: 'abc' })).toThrow(RangeError)
    expect(() => installationSignaturePayload({ ...ok, method: 'GE T' })).toThrow(RangeError)
  })

  it('headers round-trip and validation', () => {
    const headers = signedRequestHeaders({
      installation_id: '0192f7a4-1111-7000-8000-000000000001',
      timestamp: 1_792_000_000,
      signature: 'A'.repeat(86) + '==',
    })
    expect(Object.keys(headers).sort()).toEqual(
      [INSTALLATION_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER].sort(),
    )
    expect(parseSignedRequestHeaders(headers)).toEqual({
      installation_id: '0192f7a4-1111-7000-8000-000000000001',
      timestamp: 1_792_000_000,
      signature: 'A'.repeat(86) + '==',
    })
    expect(
      parseSignedRequestHeaders({ ...headers, [TIMESTAMP_HEADER]: ['1792000000', 'x'] }),
    ).toMatchObject({ timestamp: 1_792_000_000 })
    expect(parseSignedRequestHeaders({ ...headers, [TIMESTAMP_HEADER]: 'soon' })).toBeNull()
    expect(parseSignedRequestHeaders({ ...headers, [SIGNATURE_HEADER]: 'not base64!' })).toBeNull()
    expect(parseSignedRequestHeaders({ [INSTALLATION_HEADER]: 'abcdefgh' })).toBeNull()
  })

  it('clock skew window is ±600 s inclusive', () => {
    const now = new Date('2026-10-20T10:00:00Z')
    const t = unixSeconds(now)
    expect(timestampSkewSeconds(t + 5, now)).toBe(5)
    expect(isTimestampFresh(t - 600, now)).toBe(true)
    expect(isTimestampFresh(t + 600, now)).toBe(true)
    expect(isTimestampFresh(t - 601, now)).toBe(false)
    expect(isTimestampFresh(t + 601, now)).toBe(false)
  })

  it('file names', () => {
    expect(activationRequestFilename('0192f7a4-1111-7000-8000-000000000001')).toBe(
      'kadai-activation-0192f7a4.kadai-request',
    )
    expect(licenseFilename('KD-7Q2M')).toBe('kadai-license-KD-7Q2M.kadai-license')
    expect(licenseFilename('../../etc')).toBe('kadai-license-etc.kadai-license')
  })
})

describe('semver & releases', () => {
  it('orders versions per semver precedence', () => {
    const ordered = [
      '0.9.9',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.2.9',
      '1.2.10',
      '1.10.0',
      '2.0.0',
    ]
    for (let i = 0; i < ordered.length; i++)
      for (let j = 0; j < ordered.length; j++)
        expect(compareSemver(ordered[i]!, ordered[j]!), `${ordered[i]} vs ${ordered[j]}`).toBe(
          Math.sign(i - j),
        )
    expect(isSemver('1.2.3')).toBe(true)
    expect(isSemver('1.2')).toBe(false)
    expect(() => compareSemver('1.2', '1.2.0')).toThrow(RangeError)
  })

  it('release eligibility uses the IST release date against updates_until', () => {
    // 2027-05-31 23:30 IST → eligible on the last AMC day
    expect(isReleaseEligible({ released_at: '2027-05-31T18:00:00Z' }, '2027-05-31')).toBe(true)
    // 2027-06-01 01:30 IST → after the AMC
    expect(isReleaseEligible({ released_at: '2027-05-31T20:00:00Z' }, '2027-05-31')).toBe(false)
    expect(isReleaseEligible({ released_at: new Date('2030-01-01') }, null)).toBe(true)
  })

  const rel = (
    version: string,
    released_at: string,
    extra: Partial<ReleaseLike> = {},
  ): ReleaseLike => ({
    version,
    channel: 'stable',
    released_at,
    artifacts: [{ platform: 'windows-x64' }, { platform: 'linux-x64' }],
    ...extra,
  })

  it('plans upgrades: channel, platform, eligibility, nudge and stepping stones', () => {
    const releases = [
      rel('1.1.0', '2026-01-10T06:00:00Z'),
      rel('1.2.0', '2026-03-10T06:00:00Z'),
      rel('1.3.0-beta.1', '2026-04-01T06:00:00Z', { channel: 'beta' }),
      rel('1.3.0', '2026-05-10T06:00:00Z', { min_upgrade_from: '1.2.0' }),
      rel('1.4.0', '2026-08-10T06:00:00Z'),
      rel('1.5.0', '2026-09-10T06:00:00Z', { artifacts: [{ platform: 'docker' }] }),
      rel('1.6.0', '2026-10-01T06:00:00Z', { is_active: false }),
    ]
    const plan = planUpgrades(releases, {
      current_version: '1.0.0',
      channel: 'stable',
      updates_until: '2026-06-30',
      platform: 'windows-x64',
    })
    expect(plan.newer.map((r) => r.version)).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.1.0'])
    expect(plan.eligible.map((r) => r.version)).toEqual(['1.3.0', '1.2.0', '1.1.0'])
    expect(plan.latest_eligible?.version).toBe('1.3.0')
    expect(plan.newest_ineligible?.version).toBe('1.4.0')
    // 1.3.0 needs ≥ 1.2.0 first
    expect(plan.next_step?.version).toBe('1.2.0')

    const beta = planUpgrades(releases, {
      current_version: '1.2.0',
      channel: 'beta',
      updates_until: null,
    })
    expect(beta.newer.map((r) => r.version)).toEqual(['1.5.0', '1.4.0', '1.3.0', '1.3.0-beta.1'])
    expect(beta.next_step?.version).toBe('1.5.0')
    expect(beta.newest_ineligible).toBeNull()

    const none = planUpgrades(releases, {
      current_version: '1.4.0',
      channel: 'stable',
      updates_until: '2026-01-01',
      platform: 'linux-x64',
    })
    expect(none.latest_eligible).toBeNull()
    expect(none.next_step).toBeNull()
    expect(none.newest_ineligible).toBeNull()
  })

  it('artifact signature message', () => {
    expect(releaseSignatureMessage('ab'.repeat(32), '1.4.0', 'windows-x64')).toBe(
      `${'ab'.repeat(32)}|1.4.0|windows-x64`,
    )
    expect(() => releaseSignatureMessage('AB'.repeat(32), '1.4.0', 'docker')).toThrow(RangeError)
    expect(() => releaseSignatureMessage('ab'.repeat(32), 'v1', 'docker')).toThrow(RangeError)
  })
})

describe('terms, AMC & validity', () => {
  it('term end and extension from max(today, current end)', () => {
    expect(termEndDate('2026-10-20', 12)).toBe('2027-10-19')
    expect(termEndDate('2026-01-31', 1)).toBe('2026-02-27')
    // still running → continues from the current end
    expect(extendTermEnd('2027-10-19', '2027-09-01', 12)).toBe('2028-10-19')
    expect(extendTermEnd('2027-10-19', '2027-10-19', 12)).toBe('2028-10-19')
    // lapsed → starts today
    expect(extendTermEnd('2026-01-31', '2026-10-20', 12)).toBe('2027-10-19')
    expect(extendTermEnd(null, '2026-10-20', 6)).toBe('2027-04-19')
  })

  it('AMC status with days', () => {
    expect(amcStatus(null, '2026-10-20')).toEqual({
      status: 'active',
      until: null,
      days_left: null,
    })
    expect(amcStatus('2027-10-19', '2026-10-20')).toMatchObject({
      status: 'active',
      days_left: 364,
    })
    expect(amcStatus('2026-11-19', '2026-10-20')).toMatchObject({
      status: 'ending_soon',
      days_left: 30,
    })
    expect(amcStatus('2026-10-20', '2026-10-20')).toMatchObject({
      status: 'ending_soon',
      days_left: 0,
    })
    expect(amcStatus('2026-10-19', '2026-10-20')).toMatchObject({
      status: 'expired',
      days_left: -1,
    })
    expect(amcStatus('2026-11-01', '2026-10-20', 7).status).toBe('active')
  })

  it('licence validity with grace', () => {
    expect(licenseTermStatus({ valid_until: null }, '2030-01-01').status).toBe('perpetual')
    const sub = { valid_until: '2026-12-31', grace_days: 15 }
    expect(licenseTermStatus(sub, '2026-10-01')).toMatchObject({ status: 'active' })
    expect(licenseTermStatus(sub, '2026-12-15')).toMatchObject({
      status: 'ending_soon',
      days_left: 16,
    })
    expect(licenseTermStatus(sub, '2027-01-15')).toMatchObject({
      status: 'grace',
      grace_ends_on: '2027-01-15',
    })
    expect(licenseTermStatus(sub, '2027-01-16').status).toBe('expired')
    expect(licenseTermStatus({ valid_until: '2026-12-31' }, '2027-01-01').status).toBe('expired')
  })
})

describe('licence add-ons', () => {
  const addons = [
    { product_code: 'addon_counter', qty: 2, limits: { registers: 1 }, valid_until: null },
    { product_code: 'addon_store', qty: 1, limits: { stores: 1 }, valid_until: null },
    {
      product_code: 'addon_connect',
      qty: 1,
      features: ['connect'],
      valid_until: '2026-12-31',
    },
    {
      product_code: 'addon_cloud_backup',
      qty: 1,
      features: ['cloud_backup', 'not_a_feature'],
      valid_until: '2026-06-30',
    },
  ]

  it('effective features: base + add-ons still valid, unknown codes dropped', () => {
    expect(licenseEffectiveFeatures(['pos', 'catalog', 'bogus'], addons, '2026-07-01')).toEqual([
      'catalog',
      'connect',
      'pos',
    ])
    expect(licenseEffectiveFeatures(['pos'], addons, '2026-06-30')).toEqual([
      'cloud_backup',
      'connect',
      'pos',
    ])
    expect(licenseEffectiveFeatures(['pos'], [], '2026-06-30')).toEqual(['pos'])
  })

  it('effective limits: edition → overrides → + add-ons (unlimited stays unlimited)', () => {
    const base = DEFAULT_PLAN_LIMITS.onprem_standard
    expect(licenseEffectiveLimits(base, {}, addons)).toEqual({
      ...base,
      registers: 5,
      stores: 2,
    })
    expect(licenseEffectiveLimits(base, { users: 20, stores: null }, addons, '2026-01-01')).toEqual(
      { ...base, users: 20, stores: null, registers: 5 },
    )
    expect(licenseMaxStores({ stores: null })).toBe(10_000)
    expect(licenseMaxStores({ stores: 0 })).toBe(1)
    expect(licenseMaxStores({ stores: 3 })).toBe(3)
  })
})

describe('audiences & banners', () => {
  const now = '2026-10-20T06:00:00Z'

  it('schedule window', () => {
    expect(isScheduleActive({}, now)).toBe(true)
    expect(isScheduleActive({ is_active: false }, now)).toBe(false)
    expect(isScheduleActive({ starts_at: '2026-10-21T00:00:00Z' }, now)).toBe(false)
    expect(isScheduleActive({ ends_at: now }, now)).toBe(false)
    expect(isScheduleActive({ ends_at: '2026-10-20T06:00:01Z' }, now)).toBe(true)
  })

  it('announcement audience matching', () => {
    const onprem = {
      channel: 'onprem' as const,
      business_type: 'pharmacy' as const,
      plan_code: 'onprem_standard',
      state_code: '33',
      version: '1.3.0',
      amc: 'ending_soon' as const,
    }
    expect(announcementAudienceMatches({}, onprem)).toBe(true)
    expect(announcementAudienceMatches(null, onprem)).toBe(true)
    expect(announcementAudienceMatches({ channels: ['cloud'] }, onprem)).toBe(false)
    expect(announcementAudienceMatches({ business_types: ['pharmacy'] }, onprem)).toBe(true)
    expect(announcementAudienceMatches({ business_types: ['apparel'] }, onprem)).toBe(false)
    expect(announcementAudienceMatches({ plan_codes: ['onprem_pro'] }, onprem)).toBe(false)
    expect(announcementAudienceMatches({ max_version: '1.4.0' }, onprem)).toBe(true)
    expect(announcementAudienceMatches({ max_version: '1.2.9' }, onprem)).toBe(false)
    expect(announcementAudienceMatches({ min_version: '1.3.0' }, onprem)).toBe(true)
    expect(announcementAudienceMatches({ amc: 'active' }, onprem)).toBe(true)
    expect(announcementAudienceMatches({ amc: 'expired' }, onprem)).toBe(false)
    const cloud = { channel: 'cloud' as const, business_type: 'general_store' as const }
    expect(announcementAudienceMatches({ amc: 'expired' }, cloud)).toBe(false)
    expect(announcementAudienceMatches({ min_version: '1.0.0' }, cloud)).toBe(false)
    expect(announcementAudienceMatches({ channels: ['cloud', 'onprem'] }, cloud)).toBe(true)
    // malformed stored audience never matches
    expect(announcementAudienceMatches({ amc: 'sometimes' } as never, cloud)).toBe(false)
  })

  const base: PricingOffer = {
    id: '0192f7a4-0000-7000-8000-00000000000a',
    code: null,
    name: 'Deepavali',
    kind: 'percent',
    value: 2000,
  }
  const buyer = {
    channel: 'onprem' as const,
    business_type: 'pharmacy' as const,
    state_code: '33',
    district: 'Madurai',
    segments: ['existing' as const],
  }

  it('offer eligibility reasons, in order', () => {
    const ctx = { now, buyer }
    expect(offerIneligibility(base, ctx)).toBeNull()
    expect(offerIneligibility({ ...base, is_active: false }, ctx)).toBe('inactive')
    expect(offerIneligibility({ ...base, starts_at: '2026-11-01T00:00:00Z' }, ctx)).toBe(
      'not_started',
    )
    expect(offerIneligibility({ ...base, ends_at: '2026-10-01T00:00:00Z' }, ctx)).toBe('ended')
    expect(offerIneligibility({ ...base, channel: 'cloud' }, ctx)).toBe('channel')
    expect(offerIneligibility({ ...base, channel: 'both' }, ctx)).toBeNull()
    expect(offerIneligibility({ ...base, partner_id: base.id }, ctx)).toBe('partner_only')
    expect(
      offerIneligibility(
        { ...base, partner_id: base.id },
        { now, buyer: { ...buyer, partner_id: base.id } },
      ),
    ).toBeNull()
    expect(offerIneligibility({ ...base, max_redemptions: 5, redeemed_count: 5 }, ctx)).toBe(
      'redemptions_exhausted',
    )
    expect(
      offerIneligibility({ ...base, per_customer_limit: 1, customer_redeemed_count: 1 }, ctx),
    ).toBe('customer_limit')
    expect(offerIneligibility({ ...base, audience: { business_types: ['apparel'] } }, ctx)).toBe(
      'business_type',
    )
    expect(offerIneligibility({ ...base, audience: { state_codes: ['29'] } }, ctx)).toBe('state')
    expect(offerIneligibility({ ...base, audience: { districts: ['madurai'] } }, ctx)).toBeNull()
    expect(offerIneligibility({ ...base, audience: { districts: ['Salem'] } }, ctx)).toBe(
      'district',
    )
    expect(offerIneligibility({ ...base, audience: { segment: 'new' } }, ctx)).toBe('segment')
    expect(offerIneligibility({ ...base, audience: { segment: 'existing' } }, ctx)).toBeNull()
    expect(
      offerIneligibility(
        { ...base, audience: { min_order_paise: 100_000 } },
        { ...ctx, order_base_paise: 99_999 },
      ),
    ).toBe('min_order')
    expect(offerIneligibility({ ...base, audience: { segment: 'everyone' } as never }, ctx)).toBe(
      'not_applicable',
    )
    expect(OFFER_REJECT_REASONS).toContain('better_offer_applied')
  })

  it('buyer segments', () => {
    expect(buyerSegments({ ever_paid: false, has_active: false, amc_lapsed: false })).toEqual([
      'new',
    ])
    expect(buyerSegments({ ever_paid: true, has_active: true, amc_lapsed: true })).toEqual([
      'existing',
      'lapsed_amc',
    ])
  })

  it('offer display state', () => {
    expect(offerState({}, now)).toBe('active')
    expect(offerState({ is_active: false }, now)).toBe('inactive')
    expect(offerState({ starts_at: '2026-11-01T00:00:00Z' }, now)).toBe('scheduled')
    expect(offerState({ ends_at: '2026-10-01T00:00:00Z' }, now)).toBe('expired')
    expect(offerState({ max_redemptions: 1, redeemed_count: 1 }, now)).toBe('exhausted')
  })

  it('selects banners: audience, offers, dismissals, dedupe, order', () => {
    const ann = (id: string, extra: Partial<AnnouncementLike> = {}): AnnouncementLike => ({
      id,
      severity: 'info',
      title_en: `T${id}`,
      body_en: 'b',
      starts_at: '2026-10-01T00:00:00Z',
      ...extra,
    })
    const id = (n: number) => `0192f7a4-0000-7000-8000-${String(n).padStart(12, '0')}`
    const offer = (n: number, extra: Partial<BannerOfferLike> = {}): BannerOfferLike => ({
      ...base,
      id: id(n),
      banner: { title_en: `Offer ${n}`, title_ta: 'சலுகை' },
      starts_at: '2026-10-10T00:00:00Z',
      ...extra,
    })
    const banners = selectBanners({
      announcements: [
        ann(id(1)),
        ann(id(2), { severity: 'critical' }),
        ann(id(3), { audience: { channels: ['cloud'] } }),
        ann(id(4), { severity: 'offer', offer_id: id(11) }),
        ann(id(5), { is_active: false }),
        ann(id(6), { severity: 'warning', starts_at: '2026-10-15T00:00:00Z' }),
        ann(id(7)),
      ],
      offers: [
        offer(11, { code: 'DEEPA30' }), // linked to announcement 4 → no own banner
        offer(12),
        offer(13, { partner_id: id(99) }), // partner-exclusive → never a banner
        offer(14, { audience: { business_types: ['apparel'] } }),
        offer(15, { banner: null }),
        offer(16, { max_redemptions: 1, redeemed_count: 1 }),
      ],
      target: { channel: 'onprem', business_type: 'pharmacy', state_code: '33', segments: [] },
      now,
      dismissed_ids: [id(7)],
    })
    expect(banners.map((b) => b.id)).toEqual([id(2), id(6), id(12), id(4), id(1)])
    const linked = banners.find((b) => b.id === id(4))!
    expect(linked).toMatchObject({
      cta_action: 'renewal',
      offer_code: 'DEEPA30',
      source: 'announcement',
    })
    expect(banners.find((b) => b.id === id(2))!.dismissible).toBe(false)
    expect(banners.find((b) => b.id === id(12))).toMatchObject({
      source: 'offer',
      severity: 'offer',
      title_ta: 'சலுகை',
      cta_action: 'renewal',
    })
    const cloud = selectBanners({
      announcements: [ann(id(1), { cta_url: 'https://kadai.app/deepavali' })],
      offers: [offer(12)],
      target: { channel: 'cloud' },
      now,
    })
    expect(cloud.map((b) => [b.id, b.cta_action])).toEqual([
      [id(12), 'billing'],
      [id(1), 'url'],
    ])
  })
})

describe('invoices, commissions, status machines', () => {
  it('gapless vendor invoice numbers', () => {
    expect(vendorInvoiceFy('2026-10-20')).toBe('2026-27')
    expect(vendorInvoiceFy('2027-03-31')).toBe('2026-27')
    expect(vendorInvoiceFy('2027-04-01')).toBe('2027-28')
    expect(vendorInvoiceCounterKey('2026-27')).toBe('vendor_invoice_seq:2026-27')
    expect(formatVendorInvoiceNumber('2026-27', 123)).toBe('KD/2627/000123')
    expect(formatVendorInvoiceNumber('2026-27', 1_234_567)).toBe('KD/2627/1234567')
    expect(formatVendorInvoiceNumber('2026-27', 1).length).toBeLessThanOrEqual(16)
    expect(formatVendorInvoiceNumber('2026-27', 99_999_999)).toMatch(VENDOR_INVOICE_NUMBER_RE)
    expect(() => formatVendorInvoiceNumber('2026-27', 0)).toThrow(RangeError)
  })

  it('partner commission only on referred direct sales', () => {
    expect(
      partnerCommissionPaise({
        taxable_paise: 1_499_900,
        commission_bp: 1000,
        partner_placed: false,
      }),
    ).toBe(149_990)
    expect(
      partnerCommissionPaise({
        taxable_paise: 1_499_900,
        commission_bp: 1000,
        partner_placed: true,
      }),
    ).toBe(0)
  })

  it('order & commission transitions', () => {
    expect(canTransitionOrder('draft', 'pending_payment')).toBe(true)
    expect(canTransitionOrder('pending_payment', 'paid')).toBe(true)
    expect(canTransitionOrder('paid', 'fulfilled')).toBe(true)
    expect(canTransitionOrder('fulfilled', 'refunded')).toBe(true)
    expect(canTransitionOrder('draft', 'paid')).toBe(false)
    expect(canTransitionOrder('cancelled', 'pending_payment')).toBe(false)
    expect(canTransitionOrder('refunded', 'paid')).toBe(false)
    expect(Object.keys(VENDOR_ORDER_TRANSITIONS).sort()).toEqual(
      [...VendorOrderStatusSchema.options].sort(),
    )
    expect(canTransitionCommission('accrued', 'approved')).toBe(true)
    expect(canTransitionCommission('approved', 'paid')).toBe(true)
    expect(canTransitionCommission('paid', 'void')).toBe(true)
    expect(canTransitionCommission('accrued', 'paid')).toBe(false)
    expect(canTransitionCommission('void', 'accrued')).toBe(false)
  })

  it('invoice totals, words and place of supply', () => {
    const t = invoiceTotals([
      {
        gst_rate_bp: 1800,
        taxable_paise: 100_000,
        cgst_paise: 9000,
        sgst_paise: 9000,
        igst_paise: 0,
        total_paise: 118_000,
      },
      {
        gst_rate_bp: 1800,
        taxable_paise: 50_000,
        cgst_paise: 4500,
        sgst_paise: 4500,
        igst_paise: 0,
        total_paise: 59_000,
      },
    ])
    expect(t.tax_breakup).toEqual([
      {
        gst_rate_bp: 1800,
        taxable_paise: 150_000,
        cgst_paise: 13_500,
        sgst_paise: 13_500,
        igst_paise: 0,
      },
    ])
    expect(t.total_paise).toBe(177_000)
    expect(t.amount_in_words_en).toMatch(/one thousand seven hundred seventy/i)
    expect(t.amount_in_words_ta.length).toBeGreaterThan(0)
    expect(placeOfSupplyName('33')).toBe('33-Tamil Nadu')
    expect(placeOfSupplyName('00')).toBe('00')
    expect(priceWithGst(299_900)).toBe(353_882)
  })
})

describe('staff capabilities', () => {
  it('owner & admin have everything; others a subset; partner is scoped', () => {
    for (const role of PlatformStaffRoleSchema.options) {
      for (const c of vendorCapabilitiesFor(role)) expect(VENDOR_CAPABILITIES).toContain(c)
      expect(new Set(STAFF_ROLE_CAPABILITIES[role]).size).toBe(STAFF_ROLE_CAPABILITIES[role].length)
    }
    expect([...vendorCapabilitiesFor('owner')]).toEqual([...VENDOR_CAPABILITIES])
    expect([...vendorCapabilitiesFor('admin')]).toEqual([...VENDOR_CAPABILITIES])
    expect(vendorCan('sales', 'vendor.licenses.issue')).toBe(true)
    expect(vendorCan('sales', 'vendor.orders.payments')).toBe(false)
    expect(vendorCan('support', 'vendor.activations.manage')).toBe(true)
    expect(vendorCan('support', 'vendor.releases.write')).toBe(false)
    expect(vendorCan('finance', 'vendor.commissions.manage')).toBe(true)
    expect(vendorCan('finance', 'vendor.licenses.issue')).toBe(false)
    for (const c of [
      'vendor.dashboard',
      'vendor.tenants.read',
      'vendor.staff.manage',
      'vendor.commissions.manage',
      'vendor.orders.payments',
      'vendor.offers.write',
    ] as const)
      expect(vendorCan('partner', c), c).toBe(false)
    for (const role of PlatformStaffRoleSchema.options)
      expect(vendorCan(role, 'vendor.products.read')).toBe(true)
  })
})
