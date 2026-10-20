/**
 * On-prem license files (ARCHITECTURE.md §2, §7.6, §17).
 *
 * A license is a JSON document signed by the vendor with Ed25519:
 *
 *   {
 *     "format": "kadai-license-v1",
 *     "kid": "prod-2026",
 *     "license": { license_id, licensee, business_name, plan_code, features?, limits?, max_stores,
 *                  valid_from, valid_until, installation_id?, issued_at },
 *     "signature": "<base64 Ed25519 signature of canonicalJson(license)>"
 *   }
 *
 * The signature covers the canonical JSON (keys sorted) of the raw `license` object, so any edit
 * — including fields this version does not know — invalidates it. Verification uses the embedded
 * keys (license-keys.ts) or KADAI_LICENSE_PUBLIC_KEY. The installed license lives in
 * system_settings under {@link LICENSE_SETTINGS_KEY}; the installation id under
 * {@link INSTALLATION_ID_KEY}.
 */
import { type KeyObject, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { type Kysely, sql } from 'kysely'
import { z } from 'zod'
import { FeatureSchema, PlanLimitsSchema, isDateStr, newId, todayIn } from '@kadai/shared'
import type { DB } from '../db/schema.generated'
import { jsonb } from '../db/json'
import { canonicalJson } from './crypto'
import { LICENSE_PUBLIC_KEYS, type LicensePublicKey } from './license-keys'

export const LICENSE_FORMAT = 'kadai-license-v1'
export const LICENSE_SETTINGS_KEY = 'license'
export const INSTALLATION_ID_KEY = 'installation_id'

const zDate = z.string().refine(isDateStr, 'expected YYYY-MM-DD')

export const LicensePayloadSchema = z.object({
  license_id: z.string().trim().min(1).max(100),
  licensee: z.string().trim().min(1).max(200),
  business_name: z.string().trim().min(1).max(200),
  plan_code: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  /** Overrides the plan's feature list when present. */
  features: z.array(FeatureSchema).optional(),
  /** Overrides individual plan limits when present (null = unlimited). */
  limits: PlanLimitsSchema.partial().optional(),
  max_stores: z.int().min(1).max(10_000),
  valid_from: zDate,
  /** Last valid business day (inclusive); null = perpetual. */
  valid_until: zDate.nullable(),
  /** Binds the license to one installation (system_settings.installation_id). */
  installation_id: z.string().trim().min(1).max(100).optional(),
  issued_at: z.iso.datetime({ offset: true }),
})
export type LicensePayload = z.infer<typeof LicensePayloadSchema>

export const SignedLicenseSchema = z.object({
  format: z.literal(LICENSE_FORMAT),
  kid: z.string().min(1).max(64),
  license: z.record(z.string(), z.unknown()),
  signature: z.string().min(1),
})
export type SignedLicense = z.infer<typeof SignedLicenseSchema>

export type LicenseFailure =
  | 'malformed'
  | 'unknown_key'
  | 'dev_key_in_production'
  | 'bad_signature'
  | 'not_yet_valid'
  | 'expired'
  | 'installation_mismatch'

export type LicenseVerification =
  | { ok: true; license: LicensePayload; kid: string }
  | { ok: false; reason: LicenseFailure; message: string; license?: LicensePayload }

export interface TrustedKey {
  kid: string | null
  key: KeyObject
  devOnly: boolean
}

/** Parses a PEM or base64 SPKI DER Ed25519 public key. */
export function parsePublicKey(text: string): KeyObject {
  const trimmed = text.trim()
  const key = trimmed.includes('-----BEGIN')
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('license public key must be Ed25519')
  return key
}

/** Keys trusted by this process: the override when configured, else the embedded list. */
export function trustedLicenseKeys(
  override: string | null,
  embedded: readonly LicensePublicKey[] = LICENSE_PUBLIC_KEYS,
): TrustedKey[] {
  if (override) return [{ kid: null, key: parsePublicKey(override), devOnly: false }]
  return embedded.map((k) => ({ kid: k.kid, key: parsePublicKey(k.pem), devOnly: k.dev_only }))
}

export interface VerifyLicenseOptions {
  keys: readonly TrustedKey[]
  /** Reject dev-only keys (production). */
  production: boolean
  /** Business date used for validity (default: today in Asia/Kolkata). */
  today?: string
  /** Installation id of this server; required to match when the license is bound. */
  installationId?: string | null
}

/** Verifies structure, signature, key policy, validity window and installation binding. */
export function verifyLicense(doc: unknown, opts: VerifyLicenseOptions): LicenseVerification {
  const envelope = SignedLicenseSchema.safeParse(doc)
  if (!envelope.success)
    return { ok: false, reason: 'malformed', message: 'Not a Kadai license file' }
  const { kid, license: raw, signature } = envelope.data
  const trusted = opts.keys.find((k) => k.kid === null || k.kid === kid)
  if (!trusted)
    return { ok: false, reason: 'unknown_key', message: `License signed with unknown key "${kid}"` }
  if (trusted.devOnly && opts.production) {
    return {
      ok: false,
      reason: 'dev_key_in_production',
      message: 'License was signed with a development key',
    }
  }
  let sigOk = false
  try {
    sigOk = verify(
      null,
      Buffer.from(canonicalJson(raw), 'utf8'),
      trusted.key,
      Buffer.from(signature, 'base64'),
    )
  } catch {
    sigOk = false
  }
  if (!sigOk)
    return {
      ok: false,
      reason: 'bad_signature',
      message: 'License signature is invalid (file was modified)',
    }
  const payload = LicensePayloadSchema.safeParse(raw)
  if (!payload.success)
    return { ok: false, reason: 'malformed', message: 'License payload is invalid' }
  const license = payload.data
  const today = opts.today ?? todayIn('Asia/Kolkata')
  if (today < license.valid_from) {
    return {
      ok: false,
      reason: 'not_yet_valid',
      message: `License is valid from ${license.valid_from}`,
      license,
    }
  }
  if (license.valid_until !== null && today > license.valid_until) {
    return {
      ok: false,
      reason: 'expired',
      message: `License expired on ${license.valid_until}`,
      license,
    }
  }
  if (license.installation_id && license.installation_id !== opts.installationId) {
    return {
      ok: false,
      reason: 'installation_mismatch',
      message: 'License belongs to another installation',
      license,
    }
  }
  return { ok: true, license, kid }
}

/** Signs a license payload (vendor side: scripts/issue-license.ts). */
export function signLicense(
  payload: LicensePayload,
  privateKeyPem: string,
  kid: string,
): SignedLicense {
  const parsed = LicensePayloadSchema.parse(payload)
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('license signing key must be Ed25519')
  // Sign exactly what is embedded (the parsed payload without undefined fields).
  const license = JSON.parse(canonicalJson(parsed)) as Record<string, unknown>
  const signature = sign(null, Buffer.from(canonicalJson(license), 'utf8'), key).toString('base64')
  return { format: LICENSE_FORMAT, kid, license, signature }
}

// ---------------------------------------------------------------------------------------------
// Storage (system_settings; system database only)
// ---------------------------------------------------------------------------------------------

/** Installation id of this server, created on first call. */
export async function getInstallationId(systemDb: Kysely<DB>): Promise<string> {
  const fresh = newId()
  await systemDb
    .insertInto('system_settings')
    .values({ key: INSTALLATION_ID_KEY, value: jsonb(fresh) })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()
  const row = await systemDb
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', INSTALLATION_ID_KEY)
    .executeTakeFirstOrThrow()
  if (typeof row.value !== 'string') throw new Error('system_settings.installation_id is corrupt')
  return row.value
}

/** The stored license document (unverified), or null. */
export async function loadStoredLicense(
  systemDb: Kysely<DB>,
  key: string = LICENSE_SETTINGS_KEY,
): Promise<unknown> {
  const row = await systemDb
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
  return row?.value ?? null
}

/**
 * Stores a license document (callers verify first, and call EntitlementsService.invalidate() /
 * notifyEntitlementsChanged() afterwards).
 */
export async function storeLicense(
  systemDb: Kysely<DB>,
  doc: SignedLicense,
  key: string = LICENSE_SETTINGS_KEY,
): Promise<void> {
  await systemDb
    .insertInto('system_settings')
    .values({ key, value: jsonb(doc) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: jsonb(doc), updated_at: sql`now()` }))
    .execute()
}
