/**
 * Platform module settings: environment variables owned by this module (cloud billing, vendor
 * identity on our GST invoices, Razorpay plan ids). They are read here rather than in the
 * foundation config so the module stays self-contained; every variable has a safe default.
 *
 *   KADAI_VENDOR_STATE_CODE        our GST state (place of supply comparison), default '33'
 *   KADAI_VENDOR_NAME              seller name on GST invoices, default 'Kadai'
 *   KADAI_VENDOR_LEGAL_NAME        seller legal name
 *   KADAI_VENDOR_GSTIN             seller GSTIN (must belong to KADAI_VENDOR_STATE_CODE)
 *   KADAI_VENDOR_ADDRESS           seller address line (KADAI_VENDOR_CITY, KADAI_VENDOR_PINCODE)
 *   KADAI_VENDOR_PHONE / _EMAIL    seller contact on invoices
 *   RAZORPAY_PLATFORM_API_URL      Razorpay API base URL, default https://api.razorpay.com
 *   RAZORPAY_PLAN_<CODE>_<CYCLE>   Razorpay plan id for monthly auto-renew (razorpayPlanEnvVar)
 *   KADAI_GIT_COMMIT               build commit shown in GET /system/info (set by the image)
 *
 * Razorpay key id / secret / webhook secret come from the foundation config
 * (RAZORPAY_PLATFORM_KEY_ID, RAZORPAY_PLATFORM_KEY_SECRET, RAZORPAY_PLATFORM_WEBHOOK_SECRET).
 */
import { isValidGstin, isValidStateCode, normalizeGstin } from '@kadai/shared'
import type { Address } from '@kadai/shared/api/common'
import { DEFAULT_VENDOR_STATE_CODE } from '@kadai/shared/api/licensing'
import { PURCHASABLE_CLOUD_PLANS, razorpayPlanEnvVar } from '@kadai/shared/api/platform'
import type { Config } from '../../config'

export interface VendorIdentity {
  name: string
  legal_name: string | null
  gstin: string | null
  state_code: string
  address: Address
  phone: string | null
  email: string | null
}

export interface RazorpayPlatformSettings {
  apiUrl: string
  keyId: string | null
  keySecret: string | null
  webhookSecret: string | null
  /** Razorpay plan ids by env var name (RAZORPAY_PLAN_GROWTH_MONTHLY → plan_…). */
  planIds: Readonly<Record<string, string>>
}

export interface PlatformSettings {
  vendor: VendorIdentity
  razorpay: RazorpayPlatformSettings
  /** PUBLIC_BASE_URL: checkout callbacks and reminder links. */
  publicBaseUrl: string
  gitCommit: string | null
}

const clean = (v: string | undefined): string | null => {
  const t = v?.trim()
  return t ? t : null
}

export class PlatformSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlatformSettingsError'
  }
}

/** Validated platform settings from the foundation config + the process environment. */
export function resolvePlatformSettings(
  config: Pick<Config, 'razorpayPlatform' | 'publicBaseUrl'>,
  env: NodeJS.ProcessEnv = process.env,
): PlatformSettings {
  const stateCode = clean(env.KADAI_VENDOR_STATE_CODE) ?? DEFAULT_VENDOR_STATE_CODE
  if (!isValidStateCode(stateCode))
    throw new PlatformSettingsError(`KADAI_VENDOR_STATE_CODE "${stateCode}" is not a GST state code`)
  const rawGstin = clean(env.KADAI_VENDOR_GSTIN)
  const gstin = rawGstin ? normalizeGstin(rawGstin) : null
  if (gstin !== null) {
    if (!isValidGstin(gstin)) throw new PlatformSettingsError('KADAI_VENDOR_GSTIN is not valid')
    if (gstin.slice(0, 2) !== stateCode)
      throw new PlatformSettingsError('KADAI_VENDOR_GSTIN does not belong to KADAI_VENDOR_STATE_CODE')
  }
  const apiUrl = (clean(env.RAZORPAY_PLATFORM_API_URL) ?? 'https://api.razorpay.com').replace(
    /\/+$/,
    '',
  )
  if (!/^https?:\/\//.test(apiUrl))
    throw new PlatformSettingsError('RAZORPAY_PLATFORM_API_URL must be an http(s) URL')
  const planIds: Record<string, string> = {}
  for (const plan of PURCHASABLE_CLOUD_PLANS) {
    for (const cycle of ['monthly', 'yearly'] as const) {
      const name = razorpayPlanEnvVar(plan, cycle)
      const value = clean(env[name])
      if (value) planIds[name] = value
    }
  }
  const commit = clean(env.KADAI_GIT_COMMIT)
  return {
    vendor: {
      name: clean(env.KADAI_VENDOR_NAME) ?? 'Kadai',
      legal_name: clean(env.KADAI_VENDOR_LEGAL_NAME),
      gstin,
      state_code: stateCode,
      address: vendorAddress(env, stateCode),
      phone: clean(env.KADAI_VENDOR_PHONE),
      email: clean(env.KADAI_VENDOR_EMAIL),
    },
    razorpay: {
      apiUrl,
      keyId: config.razorpayPlatform.keyId,
      keySecret: config.razorpayPlatform.keySecret,
      webhookSecret: config.razorpayPlatform.webhookSecret,
      planIds,
    },
    publicBaseUrl: config.publicBaseUrl,
    gitCommit: commit && commit !== 'unknown' ? commit : null,
  }
}

function vendorAddress(env: NodeJS.ProcessEnv, stateCode: string): Address {
  const address: Address = {
    line1: undefined,
    line2: undefined,
    city: undefined,
    district: undefined,
    pincode: undefined,
    state_code: stateCode,
  }
  const line1 = clean(env.KADAI_VENDOR_ADDRESS)
  const city = clean(env.KADAI_VENDOR_CITY)
  const pincode = clean(env.KADAI_VENDOR_PINCODE)
  if (line1) address.line1 = line1
  if (city) address.city = city
  if (pincode) {
    if (!/^[1-9][0-9]{5}$/.test(pincode))
      throw new PlatformSettingsError('KADAI_VENDOR_PINCODE must be a 6-digit PIN code')
    address.pincode = pincode
  }
  return address
}

/** Razorpay plan id for monthly auto-renew of `planCode`, or null when not configured. */
export function razorpayPlanId(settings: PlatformSettings, planCode: string): string | null {
  return settings.razorpay.planIds[razorpayPlanEnvVar(planCode, 'monthly')] ?? null
}
