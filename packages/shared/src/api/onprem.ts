/**
 * Contract for the onprem module — the shop-side Kadai Server experience (ARCHITECTURE.md §21;
 * docs/API.md "on-prem system"): licence activation (online / offline) and status with AMC,
 * renewals & upgrades through the vendor, signed check-ins and the vendor state they bring
 * (announcements, offers, releases, add-on entitlements), the update center + host-updater
 * request/status files, backups (local, external drive/USB, encrypted cloud add-on) and restore
 * requests, Kadai Connect opt-in, LAN access, disk, and the support bundle.
 *
 * Every route is mode 'onprem' (404 in cloud) and needs settings.manage unless noted. Every call
 * to the vendor (KADAI_VENDOR_URL, default https://kadai.app; wire formats in
 * `@kadai/shared/api/licensing`) is optional: the shop keeps working offline forever, and a
 * vendor failure surfaces as 502 PROVIDER_ERROR with details.reason 'vendor_unreachable' (or the
 * vendor's own LICENSING_ERROR_REASONS reason, relayed unchanged).
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; catalogue `response` = full envelope;
 * custom validation messages are snake_case keys (ONPREM_VALIDATION_KEYS).
 */
import { z } from 'zod'
import { PageQuerySchema, dataOf, defineRoutes, listOf, sortQuery, zId, zTimestamp } from './common'
import type { BilingualLabel } from './identity'
import {
  AddonEntitlementsSchema,
  AmcStatusSchema,
  BannerSchema,
  CROCKFORD_ALPHABET,
  CloudBackupQuotaSchema,
  CloudBackupSchema,
  LicenseAddonSchema,
  LicenseFileInputSchema,
  LicenseTermStatusSchema,
  OfferQuoteSchema,
  OfflineActivationRequestSchema,
  ReleaseInfoSchema,
  ReleasePlanSchema,
  ReleasePlatformSchema,
  RenewalCheckoutResponseSchema,
  RenewalInfoSchema,
  RenewalQuoteResponseSchema,
  RenewalRequestSchema,
  VendorPublicInfoSchema,
  crockfordCheckChar,
  zLicenseKey,
  zSemver,
  zSha256Hex,
} from './licensing'
import {
  ActivationStatusSchema,
  type BackupKind,
  BackupKindSchema,
  BackupStatusSchema,
  LicenseTypeSchema,
  ReleaseChannelSchema,
  VendorLicenseStatusSchema,
} from '../enums'
import type { ErrorCode } from '../errors'
import { EntitlementsSchema } from '../features'
import { DEFAULT_TIMEZONE, toDateStr } from '../fy'

// =============================================================================================
// Constants
// =============================================================================================

/** Default vendor control plane (KADAI_VENDOR_URL). */
export const DEFAULT_VENDOR_URL = 'https://kadai.app'

/** system_settings keys owned by the onprem module (system pool; never tenant data). */
export const ONPREM_SETTINGS_KEYS = {
  /** {public_key (base64 SPKI), private_key (core/crypto envelope, AAD 'onprem:installation_key'), created_at}. */
  installationKeypair: 'installation_keypair',
  /** VendorStateSchema — the last check-in result. */
  vendorState: 'vendor_state',
  /** BackupSettingsSchema minus derived fields. */
  backupSettings: 'backup_settings',
  /** Cloud backup: {verifier, salt, created_at, confirmed_at} — never the recovery code itself. */
  cloudBackupKey: 'cloud_backup_key',
  /** {enabled} — Kadai Connect opt-in. */
  connect: 'connect_settings',
  /** How the current licence arrived: {method, activated_at, activation_id}. */
  activation: 'license_activation',
} as const

/** Jobs of the onprem module. */
export const ONPREM_JOBS = {
  /** Every 6 h when online (plus on demand), exponential backoff while offline. */
  checkIn: 'onprem.check-in',
  /** Daily at backup_settings.schedule_time (default 23:00 IST) + retention + external copy. */
  backup: 'onprem.backup',
  /** Encrypt + upload a completed backup to the vendor (cloud_backup add-on). */
  cloudBackupUpload: 'onprem.cloud-backup-upload',
} as const

/** Files shared with the host updater, relative to KADAI_DATA_DIR. */
export const UPDATE_REQUEST_FILE = 'updates/request.json'
export const UPDATE_STATUS_FILE = 'updates/status.json'
export const UPDATE_REQUEST_FORMAT = 'kadai-update-request-v1'
export const UPDATE_STATUS_FORMAT = 'kadai-update-status-v1'
/** Host updater: how long it polls /health/ready after starting the new version. */
export const UPDATE_HEALTH_TIMEOUT_SECONDS = 120
/** Backups live in KADAI_DATA_DIR/backups; logs (support bundle) in KADAI_DATA_DIR/logs. */
export const BACKUPS_DIR = 'backups'
export const LOGS_DIR = 'logs'
/** GET /system/disk warns below this much free space in the data directory. */
export const DISK_LOW_THRESHOLD_BYTES = 2 * 1024 ** 3
/** Support bundle: at most this many log lines. */
export const SUPPORT_BUNDLE_LOG_LINES = 2000

/** Notifications provider code of the vendor messaging relay (used when no own SMS/WhatsApp). */
export const KADAI_RELAY_PROVIDER = 'kadai_relay'

/** Check-in backoff while the vendor is unreachable. */
export const CHECK_IN_BACKOFF_BASE_SECONDS = 300
export const CHECK_IN_INTERVAL_SECONDS = 6 * 60 * 60

/**
 * Seconds until the next check-in attempt: the regular 6 h after a success; after n consecutive
 * failures 5 min × 2^(n−1), capped at 6 h (5, 10, 20, 40, 80, 160, 320, 360 min …).
 */
export function checkInDelaySeconds(consecutiveFailures: number): number {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0)
    throw new RangeError('consecutiveFailures must be a non-negative integer')
  if (consecutiveFailures === 0) return CHECK_IN_INTERVAL_SECONDS
  const exp = Math.min(consecutiveFailures - 1, 20)
  return Math.min(CHECK_IN_INTERVAL_SECONDS, CHECK_IN_BACKOFF_BASE_SECONDS * 2 ** exp)
}

// =============================================================================================
// Validation keys & error reasons
// =============================================================================================

export const ONPREM_VALIDATION_KEYS = [
  'license_key',
  'license_document',
  'confirm_mismatch',
  'acknowledge_required',
  'schedule_time',
  'path',
  'recovery_code',
  'semver',
] as const
export type OnpremValidationKey = (typeof ONPREM_VALIDATION_KEYS)[number]

/**
 * `details.reason` of errors raised by the shop server itself (vendor errors are relayed with the
 * licensing reasons). The UI shows the localized text.
 */
export const ONPREM_ERROR_REASONS = {
  vendor_unreachable: {
    code: 'PROVIDER_ERROR',
    en: 'Could not reach Kadai. Check the internet connection and try again.',
    ta: 'கடை சேவையகத்தை அடைய முடியவில்லை. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.',
  },
  license_file_invalid: {
    code: 'LICENSE_INVALID',
    en: 'This licence file is damaged or not from Kadai.',
    ta: 'இந்த உரிமக் கோப்பு சேதமடைந்துள்ளது அல்லது கடையிலிருந்து வந்தது அல்ல.',
  },
  license_other_installation: {
    code: 'LICENSE_INVALID',
    en: 'This licence file was made for another computer.',
    ta: 'இந்த உரிமக் கோப்பு வேறு கணினிக்காக உருவாக்கப்பட்டது.',
  },
  not_activated: {
    code: 'CONFLICT',
    en: 'This computer has no activated licence yet.',
    ta: 'இந்தக் கணினியில் இன்னும் உரிமம் செயல்படுத்தப்படவில்லை.',
  },
  release_not_eligible: {
    code: 'UNPROCESSABLE',
    en: 'This update was released after your AMC ended. Renew AMC to install it.',
    ta: 'உங்கள் AMC முடிந்த பிறகு இந்தப் புதுப்பிப்பு வெளியானது. நிறுவ AMC-ஐப் புதுப்பிக்கவும்.',
  },
  release_unknown: {
    code: 'NOT_FOUND',
    en: 'This version is not available.',
    ta: 'இந்தப் பதிப்பு கிடைக்கவில்லை.',
  },
  artifact_missing: {
    code: 'UNPROCESSABLE',
    en: 'This update has no download for this computer.',
    ta: 'இந்தக் கணினிக்கு இந்தப் புதுப்பிப்பின் பதிவிறக்கம் இல்லை.',
  },
  upgrade_step_required: {
    code: 'UNPROCESSABLE',
    en: 'Install the earlier update first.',
    ta: 'முதலில் முந்தைய புதுப்பிப்பை நிறுவவும்.',
  },
  operation_in_progress: {
    code: 'CONFLICT',
    en: 'An update or restore is already in progress.',
    ta: 'ஒரு புதுப்பிப்பு அல்லது மீட்டமைப்பு ஏற்கனவே நடைபெறுகிறது.',
  },
  backup_failed: {
    code: 'UNPROCESSABLE',
    en: 'The backup could not be created.',
    ta: 'காப்புப்பிரதியை உருவாக்க முடியவில்லை.',
  },
  backup_not_restorable: {
    code: 'UNPROCESSABLE',
    en: 'This backup cannot be restored (incomplete or missing file).',
    ta: 'இந்தக் காப்புப்பிரதியை மீட்டமைக்க முடியாது (முழுமையில்லை அல்லது கோப்பு இல்லை).',
  },
  path_not_writable: {
    code: 'UNPROCESSABLE',
    en: 'Kadai cannot write to this folder. Check that the drive is connected.',
    ta: 'இந்தக் கோப்புறையில் கடை எழுத முடியவில்லை. டிரைவ் இணைக்கப்பட்டுள்ளதா எனச் சரிபார்க்கவும்.',
  },
  recovery_code_mismatch: {
    code: 'VALIDATION_ERROR',
    en: 'The recovery code is not correct.',
    ta: 'மீட்புக் குறியீடு சரியானது அல்ல.',
  },
  cloud_backup_not_ready: {
    code: 'CONFLICT',
    en: 'Set up cloud backup (recovery code) first.',
    ta: 'முதலில் கிளவுட் காப்புப்பிரதியை (மீட்புக் குறியீடு) அமைக்கவும்.',
  },
} as const satisfies Record<string, { code: ErrorCode } & BilingualLabel>
export type OnpremErrorReason = keyof typeof ONPREM_ERROR_REASONS

// =============================================================================================
// Licence status on the shop server
// =============================================================================================

/**
 * core/entitlements LicenseStatus: 'valid' | 'missing' | core/license LicenseFailure (mirrored
 * here; keep in sync with apps/server/src/core/license.ts).
 */
export const CoreLicenseStatusSchema = z.enum([
  'valid',
  'missing',
  'malformed',
  'unknown_key',
  'dev_key_in_production',
  'bad_signature',
  'not_yet_valid',
  'expired',
  'installation_mismatch',
])
export type CoreLicenseStatus = z.infer<typeof CoreLicenseStatusSchema>

/** What the owner sees: none (free evaluation) · valid · grace · expired · not_yet_valid · tampered. */
export const LocalLicenseStateSchema = z.enum([
  'none',
  'valid',
  'grace',
  'expired',
  'not_yet_valid',
  'tampered',
])
export type LocalLicenseState = z.infer<typeof LocalLicenseStateSchema>

/** Maps the core verification result to the owner-facing state (tampered → read-only mode). */
export function localLicenseState(status: CoreLicenseStatus, inGrace = false): LocalLicenseState {
  switch (status) {
    case 'missing':
      return 'none'
    case 'valid':
      return inGrace ? 'grace' : 'valid'
    case 'expired':
      return 'expired'
    case 'not_yet_valid':
      return 'not_yet_valid'
    default:
      return 'tampered'
  }
}

export const LOCAL_LICENSE_STATE_LABELS: Readonly<Record<LocalLicenseState, BilingualLabel>> = {
  none: { en: 'Free evaluation (no licence)', ta: 'இலவச மதிப்பீடு (உரிமம் இல்லை)' },
  valid: { en: 'Licence active', ta: 'உரிமம் செயலில் உள்ளது' },
  grace: { en: 'Licence lapsed — grace period', ta: 'உரிமம் முடிந்தது — சலுகைக் காலம்' },
  expired: {
    en: 'Licence expired — free limits apply',
    ta: 'உரிமம் காலாவதியானது — இலவச வரம்புகள் பொருந்தும்',
  },
  not_yet_valid: { en: 'Licence not valid yet', ta: 'உரிமம் இன்னும் செல்லுபடியாகவில்லை' },
  tampered: {
    en: 'Licence problem — read-only mode',
    ta: 'உரிமச் சிக்கல் — படிக்க மட்டும் பயன்முறை',
  },
}

export const LicenseActivationMethodSchema = z.enum(['online', 'offline', 'file'])

/** The installed licence's payload fields shown to the owner (signed values; never the key). */
export const InstalledLicenseSchema = z.object({
  license_id: z.string(),
  key_prefix: z.string().nullable(),
  licensee: z.string(),
  business_name: z.string(),
  /** Payload `edition` (license_products.code); null for pre-0010 licences. */
  edition_code: z.string().nullable(),
  edition_name: z.string(),
  edition_name_ta: z.string().nullable(),
  plan_code: z.string(),
  license_type: LicenseTypeSchema.nullable(),
  valid_from: z.string(),
  valid_until: z.string().nullable(),
  updates_until: z.string().nullable(),
  support_until: z.string().nullable(),
  grace_days: z.int().min(0),
  check_in_days: z.int().min(1).nullable(),
  addons: z.array(LicenseAddonSchema),
  customer_id: z.string().nullable(),
  partner_id: z.string().nullable(),
  issued_at: zTimestamp,
  kid: z.string(),
})
export type InstalledLicense = z.output<typeof InstalledLicenseSchema>

/** GET /system/license — the License & AMC card. */
export const LicenseStatusViewSchema = z.object({
  state: LocalLicenseStateSchema,
  /** Core status (e.g. 'bad_signature', 'installation_mismatch'); 'valid' when fine. */
  core_status: CoreLicenseStatusSchema,
  read_only: z.boolean(),
  installation_id: z.string(),
  /** Payload of the stored licence (also when expired / mismatched); null when none. */
  license: InstalledLicenseSchema.nullable(),
  term: LicenseTermStatusSchema.nullable(),
  amc: AmcStatusSchema.nullable(),
  /** support_until as an AMC-style status. */
  support: AmcStatusSchema.nullable(),
  /** What this server grants right now (Free plan when none / expired / tampered). */
  entitlements: EntitlementsSchema,
  activation: z.object({
    method: LicenseActivationMethodSchema.nullable(),
    activated_at: zTimestamp.nullable(),
  }),
  /** From the last successful check-in. */
  vendor: z.object({
    license_status: VendorLicenseStatusSchema.nullable(),
    activation_status: ActivationStatusSchema.nullable(),
    last_check_in_at: zTimestamp.nullable(),
  }),
})
export type LicenseStatusView = z.output<typeof LicenseStatusViewSchema>

/** POST /system/license/activate — online activation through the vendor. */
export const LicenseActivateSchema = z.object({ license_key: zLicenseKey })
export type LicenseActivate = z.input<typeof LicenseActivateSchema>

/** GET /system/license/activation-request — for offline activation (no secret inside). */
export const ActivationRequestFileSchema = z.object({
  request: OfflineActivationRequestSchema,
  /** 'KDREQ1.' copy/paste code (also the QR payload). */
  code: z.string(),
  /** activationRequestFilename(installation_id). */
  filename: z.string(),
  /** Where the customer completes it (vendor public /activate page). */
  activation_url: z.string(),
  created_at: zTimestamp,
})
export type ActivationRequestFile = z.output<typeof ActivationRequestFileSchema>

/**
 * PUT /system/license — install a signed licence file (offline activation / support). Verified
 * with core/license (bound installation must match → 403 license_other_installation). Accepted in
 * read-only mode (that is how a tampered install is repaired).
 */
export const LicenseUploadSchema = z.object({ license: LicenseFileInputSchema })
export type LicenseUpload = z.input<typeof LicenseUploadSchema>

export const LicenseRefreshResultSchema = z.object({
  changed: z.boolean(),
  license: LicenseStatusViewSchema,
})
export type LicenseRefreshResult = z.output<typeof LicenseRefreshResultSchema>

/**
 * POST /system/license/deactivate — "move to a new computer": the vendor frees the seat first
 * (needs the internet; counts against LICENSE_TRANSFERS_PER_YEAR), then the local licence is
 * removed (Free limits; data kept). `confirm` must equal the business name shown in the dialog.
 */
export const LicenseDeactivateSchema = z.object({
  confirm: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
})
export type LicenseDeactivate = z.input<typeof LicenseDeactivateSchema>

export const LicenseDeactivateResultSchema = z.object({
  deactivated_at: zTimestamp,
  transfers_left: z.int().min(0),
  license: LicenseStatusViewSchema,
})
export type LicenseDeactivateResult = z.output<typeof LicenseDeactivateResultSchema>

// =============================================================================================
// Vendor state (check-ins)
// =============================================================================================

export const CheckInErrorSchema = z.object({
  /** LICENSING_ERROR_REASONS key or 'vendor_unreachable'. */
  reason: z.string(),
  message: z.string(),
  at: zTimestamp,
})

/**
 * system_settings 'vendor_state': what the last successful check-in brought, plus attempt
 * bookkeeping. On license_status 'revoked' or activation 'deactivated'/'blocked' the shop removes
 * its stored licence (Free limits; data kept).
 */
export const VendorStateSchema = z.object({
  last_check_in_at: zTimestamp.nullable(),
  last_attempt_at: zTimestamp.nullable(),
  last_error: CheckInErrorSchema.nullable(),
  consecutive_failures: z.int().min(0),
  next_check_in_at: zTimestamp.nullable(),
  license_status: VendorLicenseStatusSchema.nullable(),
  activation_status: ActivationStatusSchema.nullable(),
  banners: z.array(BannerSchema),
  offers: z.array(OfferQuoteSchema),
  renewal: RenewalInfoSchema.nullable(),
  releases: ReleasePlanSchema.nullable(),
  entitlements: AddonEntitlementsSchema.nullable(),
  vendor: VendorPublicInfoSchema.nullable(),
  dismissed_banner_ids: z.array(zId).max(500),
})
export type VendorState = z.output<typeof VendorStateSchema>

/** Empty state before the first check-in. */
export function emptyVendorState(): VendorState {
  return {
    last_check_in_at: null,
    last_attempt_at: null,
    last_error: null,
    consecutive_failures: 0,
    next_check_in_at: null,
    license_status: null,
    activation_status: null,
    banners: [],
    offers: [],
    renewal: null,
    releases: null,
    entitlements: null,
    vendor: null,
    dismissed_banner_ids: [],
  }
}

/** GET /system/vendor-state (also POST /system/check-in). */
export const VendorStateViewSchema = VendorStateSchema.extend({
  /** The last attempt succeeded. */
  online: z.boolean(),
  /** banners minus dismissed and out-of-window ones (render these). */
  visible_banners: z.array(BannerSchema),
  /** For the app-wide AMC reminder banner (ending_soon within 30 days / expired). */
  amc: AmcStatusSchema.nullable(),
})
export type VendorStateView = z.output<typeof VendorStateViewSchema>

/** Banners to render now: not dismissed (critical ones always) and within their window. */
export function visibleBanners(
  banners: readonly z.output<typeof BannerSchema>[],
  dismissedIds: readonly string[],
  now: string | Date,
): z.output<typeof BannerSchema>[] {
  const t = now instanceof Date ? now.getTime() : Date.parse(now)
  const dismissed = new Set(dismissedIds)
  return banners.filter(
    (b) =>
      (!b.dismissible || !dismissed.has(b.id)) &&
      (b.starts_at === null || Date.parse(b.starts_at) <= t) &&
      (b.ends_at === null || Date.parse(b.ends_at) > t),
  )
}

const BannerParams = z.object({ id: zId })

// =============================================================================================
// Update center & host-updater files
// =============================================================================================

export const UpdateStateSchema = z.enum([
  'queued',
  'downloading',
  'verifying',
  'backing_up',
  'stopping',
  'restoring',
  'migrating',
  'starting',
  'health_check',
  'done',
  'rolled_back',
  'failed',
])
export type UpdateState = z.infer<typeof UpdateStateSchema>
export const TERMINAL_UPDATE_STATES: readonly UpdateState[] = ['done', 'rolled_back', 'failed']
export function isTerminalUpdateState(state: UpdateState): boolean {
  return TERMINAL_UPDATE_STATES.includes(state)
}

export const UPDATE_STATE_LABELS: Readonly<Record<UpdateState, BilingualLabel>> = {
  queued: { en: 'Waiting to start…', ta: 'தொடங்கக் காத்திருக்கிறது…' },
  downloading: { en: 'Downloading the update…', ta: 'புதுப்பிப்பு பதிவிறக்கப்படுகிறது…' },
  verifying: { en: 'Checking the download…', ta: 'பதிவிறக்கம் சரிபார்க்கப்படுகிறது…' },
  backing_up: { en: 'Taking a backup…', ta: 'காப்புப்பிரதி எடுக்கப்படுகிறது…' },
  stopping: { en: 'Stopping Kadai…', ta: 'கடை நிறுத்தப்படுகிறது…' },
  restoring: { en: 'Restoring the backup…', ta: 'காப்புப்பிரதி மீட்டமைக்கப்படுகிறது…' },
  migrating: { en: 'Updating the database…', ta: 'தரவுத்தளம் புதுப்பிக்கப்படுகிறது…' },
  starting: { en: 'Starting Kadai…', ta: 'கடை தொடங்கப்படுகிறது…' },
  health_check: { en: 'Making sure everything works…', ta: 'அனைத்தும் சரியாக இயங்குகிறதா எனச் சரிபார்க்கிறது…' },
  done: { en: 'Done', ta: 'முடிந்தது' },
  rolled_back: {
    en: 'The update did not work, so the previous version was restored',
    ta: 'புதுப்பிப்பு வேலை செய்யவில்லை, எனவே முந்தைய பதிப்பு மீட்டமைக்கப்பட்டது',
  },
  failed: { en: 'Failed', ta: 'தோல்வியடைந்தது' },
}

/**
 * KADAI_DATA_DIR/updates/request.json — written by the app (POST /system/updates/install or
 * /system/backups/:id/restore-request), picked up by the host updater (Windows scheduled task,
 * systemd timer, Docker script), which deletes it once it has written status.json. The app never
 * replaces or restores itself.
 */
export const UpdateRequestFileSchema = z.object({
  format: z.literal(UPDATE_REQUEST_FORMAT),
  id: zId,
  action: z.enum(['update', 'restore']),
  requested_at: z.iso.datetime({ offset: true }),
  requested_by: z.object({ user_id: zId.nullable(), name: z.string() }),
  current_version: zSemver,
  /** action 'update': the artifact for this platform (verify sha256 + Ed25519 signature). */
  update: z
    .object({
      version: zSemver,
      platform: ReleasePlatformSchema,
      url: z.string(),
      sha256: zSha256Hex,
      size_bytes: z.int().min(0),
      signature: z.string(),
    })
    .nullable(),
  /** action 'restore': the backup file to restore (pg_restore --clean, after a safety backup). */
  restore: z
    .object({
      backup_id: zId,
      path: z.string(),
      sha256: zSha256Hex,
      size_bytes: z.int().min(0),
    })
    .nullable(),
  /** Backup taken by the app right before requesting (pre_upgrade) — the rollback point. */
  pre_backup: z.object({ backup_id: zId, path: z.string() }).nullable(),
})
export type UpdateRequestFile = z.output<typeof UpdateRequestFileSchema>

/** KADAI_DATA_DIR/updates/status.json — written by the host updater as it progresses. */
export const UpdateStatusFileSchema = z.object({
  format: z.literal(UPDATE_STATUS_FORMAT),
  request_id: zId,
  action: z.enum(['update', 'restore']),
  state: UpdateStateSchema,
  version: zSemver.nullable(),
  previous_version: zSemver.nullable(),
  progress_pct: z.int().min(0).max(100).nullable(),
  message: z.string().max(1000).nullable(),
  started_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  finished_at: z.iso.datetime({ offset: true }).nullable(),
  /** Last lines of the updater log (≤ 200). */
  log_tail: z.array(z.string().max(2000)).max(200),
  error: z.string().max(2000).nullable(),
})
export type UpdateStatusFile = z.output<typeof UpdateStatusFileSchema>

/** GET /system/updates/status — 'idle' when there is neither a request nor a status file. */
export const UpdateStatusViewSchema = z.object({
  state: z.union([z.literal('idle'), UpdateStateSchema]),
  request: UpdateRequestFileSchema.nullable(),
  status: UpdateStatusFileSchema.nullable(),
})
export type UpdateStatusView = z.output<typeof UpdateStatusViewSchema>

export const UpdatesQuerySchema = z.object({
  /** true = ask the vendor now (GET /public/v1/licensing/releases) instead of the last check-in. */
  refresh: z.union([z.boolean(), z.stringbool()]).default(false),
})
export type UpdatesQuery = z.input<typeof UpdatesQuerySchema>

/** GET /system/updates — the update center. */
export const UpdatesViewSchema = z.object({
  current_version: z.string(),
  channel: ReleaseChannelSchema,
  platform: ReleasePlatformSchema,
  updates_until: z.string().nullable(),
  amc: AmcStatusSchema.nullable(),
  source: z.enum(['check_in', 'live', 'none']),
  checked_at: zTimestamp.nullable(),
  /** Newer releases (newest first) with eligibility. */
  releases: z.array(ReleaseInfoSchema),
  latest_eligible: ReleaseInfoSchema.nullable(),
  /** Newer than anything eligible — show the "renew AMC to get this" explanation. */
  newest_ineligible: ReleaseInfoSchema.nullable(),
  /** The release "Install update" installs (stepping stones honoured). */
  next_step: ReleaseInfoSchema.nullable(),
  in_progress: UpdateStatusViewSchema.nullable(),
})
export type UpdatesView = z.output<typeof UpdatesViewSchema>

/** POST /system/updates/install → 202. Validates eligibility + artifact, takes a pre_upgrade backup. */
export const UpdateInstallSchema = z.object({ version: zSemver })
export type UpdateInstall = z.input<typeof UpdateInstallSchema>

/** 202 body of install / restore requests. */
export const HostRequestAcceptedSchema = z.object({
  request_id: zId,
  action: z.enum(['update', 'restore']),
  version: z.string().nullable(),
  pre_backup_id: zId.nullable(),
  requested_at: zTimestamp,
})
export type HostRequestAccepted = z.output<typeof HostRequestAcceptedSchema>

// =============================================================================================
// Backups
// =============================================================================================

export const BackupRetentionSchema = z.object({
  /** Newest scheduled backups kept. */
  daily: z.int().min(1).max(365).default(14),
  /** Newest scheduled backup of each of the last N months (IST). */
  monthly: z.int().min(0).max(120).default(12),
  manual: z.int().min(1).max(100).default(10),
  pre_upgrade: z.int().min(1).max(50).default(5),
})
export type BackupRetention = z.output<typeof BackupRetentionSchema>
export const DEFAULT_BACKUP_RETENTION: BackupRetention = {
  daily: 14,
  monthly: 12,
  manual: 10,
  pre_upgrade: 5,
}
export const DEFAULT_BACKUP_TIME = '23:00'

export interface RetentionCandidate {
  id: string
  kind: BackupKind
  status: 'running' | 'completed' | 'failed'
  started_at: string | Date
}

/**
 * Ids of completed backups to delete under the retention policy: keep the newest `daily`
 * scheduled backups, the newest scheduled backup of each of the newest `monthly` months (IST),
 * the newest `manual` manual and `pre_upgrade` pre-upgrade backups. Running / failed rows are
 * never returned. Deterministic (ties by id).
 */
export function backupsToPrune(
  backups: readonly RetentionCandidate[],
  policy: BackupRetention = DEFAULT_BACKUP_RETENTION,
): string[] {
  const ms = (b: RetentionCandidate) =>
    b.started_at instanceof Date ? b.started_at.getTime() : Date.parse(b.started_at)
  const completed = backups
    .filter((b) => b.status === 'completed')
    .sort((a, b) => ms(b) - ms(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const keep = new Set<string>()
  const ofKind = (k: BackupKind) => completed.filter((b) => b.kind === k)
  ofKind('scheduled')
    .slice(0, policy.daily)
    .forEach((b) => keep.add(b.id))
  const months = new Set<string>()
  for (const b of ofKind('scheduled')) {
    const month = toDateStr(new Date(ms(b)), DEFAULT_TIMEZONE).slice(0, 7)
    if (months.has(month)) continue
    if (months.size >= policy.monthly) break
    months.add(month)
    keep.add(b.id)
  }
  ofKind('manual')
    .slice(0, policy.manual)
    .forEach((b) => keep.add(b.id))
  ofKind('pre_upgrade')
    .slice(0, policy.pre_upgrade)
    .forEach((b) => keep.add(b.id))
  return completed.filter((b) => !keep.has(b.id)).map((b) => b.id)
}

const BACKUP_NAME_RE = /^kadai-([A-Za-z0-9_]+)-(\d{8}-\d{6})-(scheduled|manual|pre_upgrade)(?:-([a-z0-9-]{1,40}))?\.dump$/

/**
 * Backup file name shared with deploy/onprem/backup.sh & backup.ps1 (so host retention covers
 * app-made backups): `kadai-<db>-<YYYYmmdd-HHMMSS>-<kind>[-label].dump` (+ `<file>.sha256`),
 * timestamp in IST.
 */
export function backupFileName(input: {
  db: string
  at: Date
  kind: BackupKind
  label?: string | null
}): string {
  if (!/^[A-Za-z0-9_]+$/.test(input.db)) throw new RangeError('invalid database name')
  const d = toDateStr(input.at, DEFAULT_TIMEZONE).replaceAll('-', '')
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(input.at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const label = input.label
    ? `-${input.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)}`
    : ''
  return `kadai-${input.db}-${d}-${get('hour')}${get('minute')}${get('second')}-${input.kind}${label === '-' ? '' : label}.dump`
}

export function parseBackupFileName(
  name: string,
): { db: string; stamp: string; kind: BackupKind; label: string | null } | null {
  const m = BACKUP_NAME_RE.exec(name)
  if (!m) return null
  return { db: m[1]!, stamp: m[2]!, kind: m[3] as BackupKind, label: m[4] ?? null }
}

/** A row of `backups` with what the onprem module knows about its copies. */
export const LocalBackupSchema = z.object({
  id: zId,
  kind: BackupKindSchema,
  status: BackupStatusSchema,
  file_name: z.string().nullable(),
  label: z.string().nullable(),
  /** Path the app sees (KADAI_DATA_DIR/backups/<file>). */
  location: z.string().nullable(),
  size_bytes: z.int().min(0).nullable(),
  checksum_sha256: z.string().nullable(),
  started_at: zTimestamp,
  finished_at: zTimestamp.nullable(),
  error: z.string().nullable(),
  /** Second copy on the external drive / USB folder. */
  external_copy: z
    .object({ path: z.string(), copied_at: zTimestamp, verified: z.boolean() })
    .nullable(),
  uploaded_to_cloud: z.boolean(),
  cloud_backup_id: zId.nullable(),
  /** File present and checksum known (download / restore possible). */
  restorable: z.boolean(),
})
export type LocalBackup = z.output<typeof LocalBackupSchema>

export const BackupListQuerySchema = PageQuerySchema.extend({
  kind: BackupKindSchema.optional(),
  status: BackupStatusSchema.optional(),
  sort: sortQuery(['started_at', 'size_bytes'] as const).prefault('-started_at'),
})
export type BackupListQuery = z.input<typeof BackupListQuerySchema>

/** POST /system/backups → 202 (pg_dump -Fc runs in the background; poll the list). */
export const BackupCreateSchema = z.object({
  label: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9 _-]*$/)
    .optional(),
  /** Also copy to the external folder when configured (default true). */
  copy_external: z.boolean().default(true),
  /** Also upload to cloud backup when enabled (default true). */
  upload_cloud: z.boolean().default(true),
})
export type BackupCreate = z.input<typeof BackupCreateSchema>

/**
 * POST /system/backups/:id/restore-request → 202: writes a restore request for the host
 * updater (never restores from inside the running process). `confirm` must equal the business
 * name; a safety backup is taken first.
 */
export const RestoreRequestSchema = z.object({
  confirm: z.string().trim().min(1).max(200),
  acknowledge_data_loss: z.literal(true, { message: 'acknowledge_required' }),
})
export type RestoreRequest = z.input<typeof RestoreRequestSchema>

const zScheduleTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'schedule_time')

const zFolderPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((v) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(v) && !/[\0]/.test(v), { message: 'path' })
  .describe("Absolute folder path, e.g. 'E:\\KadaiBackup' or '/media/usb/kadai'")

/** PUT /system/backup-settings (full replacement). */
export const BackupSettingsUpdateSchema = z.object({
  schedule_enabled: z.boolean().default(true),
  schedule_time: zScheduleTime.default(DEFAULT_BACKUP_TIME).describe('HH:MM in IST'),
  retention: BackupRetentionSchema.prefault({}),
  external_path: zFolderPath.nullable().default(null),
  /** Upload each scheduled backup to the encrypted cloud store (needs the add-on + setup). */
  cloud_enabled: z.boolean().default(false),
})
export type BackupSettingsUpdate = z.input<typeof BackupSettingsUpdateSchema>

export const BackupSettingsSchema = z.object({
  schedule_enabled: z.boolean(),
  schedule_time: z.string(),
  retention: BackupRetentionSchema,
  external_path: z.string().nullable(),
  cloud_enabled: z.boolean(),
  /** Licence has cloud_backup and the recovery code is set up. */
  cloud_ready: z.boolean(),
  last_backup: LocalBackupSchema.nullable(),
  next_run_at: zTimestamp.nullable(),
  /** Health colour of the Backups card: ok = completed within 26 h. */
  health: z.enum(['ok', 'warning', 'error']),
})
export type BackupSettings = z.output<typeof BackupSettingsSchema>

/** Backups card colour from the last completed backup's age. */
export function backupHealth(
  lastCompletedAt: string | Date | null,
  now: string | Date,
): 'ok' | 'warning' | 'error' {
  if (lastCompletedAt === null) return 'error'
  const age =
    (now instanceof Date ? now.getTime() : Date.parse(now)) -
    (lastCompletedAt instanceof Date ? lastCompletedAt.getTime() : Date.parse(lastCompletedAt))
  const hours = age / 3_600_000
  return hours <= 26 ? 'ok' : hours <= 72 ? 'warning' : 'error'
}

/** POST /system/backup-settings/test-path — create + delete a probe file. */
export const PathTestSchema = z.object({ path: zFolderPath })
export type PathTest = z.input<typeof PathTestSchema>

export const PathTestResultSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  writable: z.boolean(),
  free_bytes: z.int().min(0).nullable(),
  /** Same disk as KADAI_DATA_DIR: a copy there does not survive a disk failure. */
  same_device_as_data: z.boolean(),
  error: z.enum(['not_found', 'not_directory', 'not_writable', 'unknown']).nullable(),
})
export type PathTestResult = z.output<typeof PathTestResultSchema>

// ---- encrypted cloud backup -----------------------------------------------------------------

/**
 * Client-side encryption of cloud backups (the vendor stores opaque blobs). Key =
 * scrypt(normalized recovery code, salt, N=2^15, r=8, p=1, 32 bytes). Blob layout:
 * magic 'KDBK1' (5 bytes) | salt (16) | iv (12) | AES-256-GCM ciphertext | tag (16).
 * The salt travels in the blob, so any Kadai server with the recovery code can decrypt.
 */
export const CLOUD_BACKUP_ENCRYPTION = {
  magic: 'KDBK1',
  cipher: 'aes-256-gcm',
  kdf: 'scrypt',
  scrypt: { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 },
  salt_bytes: 16,
  iv_bytes: 12,
  tag_bytes: 16,
} as const

/** Recovery code: 6 groups of 4 Crockford symbols (23 random + Luhn mod 32 check, 115 bits). */
export const RECOVERY_CODE_RE = /^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/

function groupRecovery(symbols: string): string {
  return (symbols.match(/.{4}/g) ?? []).join('-')
}

/** New recovery code (shown ONCE to the owner; only a verifier is stored). */
export function generateRecoveryCode(
  randomBytes: (n: number) => Uint8Array = (n) => {
    const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto
    if (!c) throw new Error('Web Crypto (crypto.getRandomValues) is not available')
    return c.getRandomValues(new Uint8Array(n))
  },
): string {
  const bytes = randomBytes(23)
  let body = ''
  for (let i = 0; i < 23; i++) body += CROCKFORD_ALPHABET[bytes[i]! & 31]
  return groupRecovery(body + crockfordCheckChar(body))
}

/** Normalizes typed input (case, O/I/L, spaces) to the canonical code, or null when invalid. */
export function parseRecoveryCode(input: string): string | null {
  const symbols = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[OIL]/g, (c) => (c === 'O' ? '0' : '1'))
  if (symbols.length !== 24) return null
  for (const ch of symbols) if (!CROCKFORD_ALPHABET.includes(ch)) return null
  if (crockfordCheckChar(symbols.slice(0, 23)) !== symbols[23]) return null
  return groupRecovery(symbols)
}

export const zRecoveryCode = z
  .string()
  .trim()
  .max(64)
  .refine((v) => parseRecoveryCode(v) !== null, { message: 'recovery_code' })
  .transform((v) => parseRecoveryCode(v) ?? v)

/** POST /system/backups/cloud/setup → the recovery code, ONCE (re-running replaces it). */
export const CloudBackupSetupResultSchema = z.object({
  recovery_code: z.string().describe('Shown once — the owner must write it down / print it'),
  created_at: zTimestamp,
})
export type CloudBackupSetupResult = z.output<typeof CloudBackupSetupResultSchema>

/** POST /system/backups/cloud/confirm — the owner re-types the code; enables uploads. */
export const CloudBackupConfirmSchema = z.object({ recovery_code: zRecoveryCode })
export type CloudBackupConfirm = z.input<typeof CloudBackupConfirmSchema>

/** GET /system/backups/cloud — status + the vendor's list (live call). */
export const CloudBackupStatusViewSchema = z.object({
  licensed: z.boolean(),
  /** Recovery code set up and confirmed. */
  ready: z.boolean(),
  enabled: z.boolean(),
  recovery_code_set_at: zTimestamp.nullable(),
  quota: CloudBackupQuotaSchema.nullable(),
  backups: z.array(CloudBackupSchema),
  last_upload_at: zTimestamp.nullable(),
  last_error: z.string().nullable(),
  /** false when the vendor could not be reached (list from the last known state). */
  live: z.boolean(),
})
export type CloudBackupStatusView = z.output<typeof CloudBackupStatusViewSchema>

/** POST /system/backups/cloud/:cloudId/download → 202: fetch + decrypt into a local backup. */
export const CloudBackupRestoreDownloadSchema = z.object({ recovery_code: zRecoveryCode })
export type CloudBackupRestoreDownload = z.input<typeof CloudBackupRestoreDownloadSchema>

const CloudIdParams = z.object({ cloudId: zId })

// =============================================================================================
// Kadai Connect, network, disk, support bundle
// =============================================================================================

export const ConnectSettingsSchema = z.object({
  licensed: z.boolean(),
  enabled: z.boolean(),
  last_snapshot_at: zTimestamp.nullable(),
  /** The vendor stored the last snapshot. */
  last_snapshot_accepted: z.boolean().nullable(),
  connect_url: z.string(),
})
export type ConnectSettings = z.output<typeof ConnectSettingsSchema>

export const ConnectSettingsUpdateSchema = z.object({ enabled: z.boolean() })
export type ConnectSettingsUpdate = z.input<typeof ConnectSettingsUpdateSchema>

export const NetworkInfoSchema = z.object({
  hostname: z.string(),
  port: z.int().min(1).max(65_535),
  addresses: z.array(
    z.object({
      interface: z.string(),
      address: z.string(),
      family: z.enum(['IPv4', 'IPv6']),
      internal: z.boolean(),
    }),
  ),
  /** One entry per non-internal IPv4 address. */
  urls: z.array(z.object({ address: z.string(), app_url: z.string(), pos_url: z.string() })),
  /** Best guess for the QR code (first private IPv4). */
  primary_url: z.string().nullable(),
  firewall: z.object({
    os: z.enum(['windows', 'linux', 'docker', 'unknown']),
    /** Command to allow the port (shown with a copy button), when known. */
    command: z.string().nullable(),
  }),
})
export type NetworkInfo = z.output<typeof NetworkInfoSchema>

/** App and POS URLs for a LAN address (IPv6 literals are bracketed). */
export function lanUrls(address: string, port: number): { app_url: string; pos_url: string } {
  const host = address.includes(':') ? `[${address}]` : address
  const base = port === 80 ? `http://${host}` : `http://${host}:${port}`
  return { app_url: `${base}/`, pos_url: `${base}/pos` }
}

/** Firewall command that opens the Kadai port. */
export function firewallCommand(os: 'windows' | 'linux' | 'docker' | 'unknown', port: number):
  | string
  | null {
  if (os === 'windows')
    return `netsh advfirewall firewall add rule name="Kadai" dir=in action=allow protocol=TCP localport=${port}`
  if (os === 'linux') return `sudo ufw allow ${port}/tcp`
  return null
}

export const DiskInfoSchema = z.object({
  data_dir: z.string(),
  total_bytes: z.int().min(0),
  free_bytes: z.int().min(0),
  backups_bytes: z.int().min(0),
  low: z.boolean(),
  threshold_bytes: z.int().min(0),
})
export type DiskInfo = z.output<typeof DiskInfoSchema>

/** POST /system/support-bundle → tar.gz download (never database data). */
export const SupportBundleRequestSchema = z.object({
  include_logs: z.boolean().default(true),
})
export type SupportBundleRequest = z.input<typeof SupportBundleRequestSchema>

const SECRET_KEY_RE = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|_KEY|KEYS|CREDENTIAL|SALT)$/i

/**
 * Redacts a configuration map for the support bundle: secret-looking keys → '[redacted]';
 * credentials inside URLs (postgres://user:pass@host) → '[redacted]'.
 */
export function redactConfig(
  config: Readonly<Record<string, string | number | boolean | null | undefined>>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue
    if (value !== null && value !== '' && SECRET_KEY_RE.test(key)) {
      out[key] = '[redacted]'
    } else if (typeof value === 'string') {
      out[key] = value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(:[^/@\s]*)?@/gi, (_m, p) =>
        `${p}[redacted]@`,
      )
    } else {
      out[key] = value
    }
  }
  return out
}

/** Summary of the on-prem server for GET /system/info (platform module; extension hook). */
export const OnPremSystemInfoSchema = z.object({
  installation_id: z.string(),
  license_state: LocalLicenseStateSchema,
  edition_name: z.string().nullable(),
  updates_until: z.string().nullable(),
  last_backup_at: zTimestamp.nullable(),
  last_backup_status: BackupStatusSchema.nullable(),
  last_check_in_at: zTimestamp.nullable(),
  data_dir: z.string(),
  data_dir_free_bytes: z.int().min(0).nullable(),
  update_state: z.union([z.literal('idle'), UpdateStateSchema]),
})
export type OnPremSystemInfo = z.output<typeof OnPremSystemInfoSchema>

/**
 * Windows desktop shortcut target for silent receipt printing (Hardware guide): the browser in
 * app mode with --kiosk-printing (prints to the default printer without a dialog).
 */
export function kioskShortcutTarget(browser: 'edge' | 'chrome', posUrl: string): string {
  const exe =
    browser === 'edge'
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  return `"${exe}" --kiosk-printing --app=${posUrl}`
}

// =============================================================================================
// Route catalogue (all mode 'onprem')
// =============================================================================================

const IdParams = z.object({ id: zId })

export const onpremRoutes = defineRoutes({
  // ---- licence -------------------------------------------------------------------------------
  getLicense: {
    method: 'GET',
    path: '/system/license',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(LicenseStatusViewSchema),
    summary: 'Licence & AMC status, limits, validity and activation',
  },
  activateLicense: {
    method: 'POST',
    path: '/system/license/activate',
    mode: 'onprem',
    permission: 'settings.manage',
    body: LicenseActivateSchema,
    response: dataOf(LicenseStatusViewSchema),
    summary: 'Online activation with a licence key (vendor call)',
  },
  activationRequest: {
    method: 'GET',
    path: '/system/license/activation-request',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(ActivationRequestFileSchema),
    summary: 'Signed offline activation request (file / copy code / QR)',
  },
  uploadLicense: {
    method: 'PUT',
    path: '/system/license',
    mode: 'onprem',
    permission: 'settings.manage',
    body: LicenseUploadSchema,
    response: dataOf(LicenseStatusViewSchema),
    summary: 'Install a signed licence file (offline activation); allowed in read-only mode',
  },
  refreshLicense: {
    method: 'POST',
    path: '/system/license/refresh',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(LicenseRefreshResultSchema),
    summary: 'Fetch the refreshed licence after a renewal / upgrade (vendor call)',
  },
  deactivateLicense: {
    method: 'POST',
    path: '/system/license/deactivate',
    mode: 'onprem',
    permission: 'settings.manage',
    body: LicenseDeactivateSchema,
    response: dataOf(LicenseDeactivateResultSchema),
    summary: 'Move to a new computer: vendor frees the seat, local licence removed (audited)',
  },

  // ---- vendor state, renewals ----------------------------------------------------------------
  vendorState: {
    method: 'GET',
    path: '/system/vendor-state',
    mode: 'onprem',
    response: dataOf(VendorStateViewSchema),
    summary: 'Last check-in: banners, offers, renewal, releases, add-on entitlements (any member)',
  },
  checkInNow: {
    method: 'POST',
    path: '/system/check-in',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(VendorStateViewSchema),
    summary: 'Check in with the vendor now',
  },
  dismissBanner: {
    method: 'POST',
    path: '/system/banners/:id/dismiss',
    mode: 'onprem',
    params: IdParams,
    summary: 'Hide an announcement / offer banner on this server (any member)',
  },
  renewalQuote: {
    method: 'POST',
    path: '/system/renewal-quote',
    mode: 'onprem',
    permission: 'settings.manage',
    body: RenewalRequestSchema,
    response: dataOf(RenewalQuoteResponseSchema),
    summary: 'Live price of a renewal / upgrade / add-on with coupon & GST (vendor call)',
  },
  renewalCheckout: {
    method: 'POST',
    path: '/system/renewal-checkout',
    mode: 'onprem',
    permission: 'settings.manage',
    body: RenewalRequestSchema,
    response: dataOf(RenewalCheckoutResponseSchema),
    status: 201,
    summary: 'Vendor order + payment URL; the extended licence arrives on the next check-in',
  },

  // ---- updates -------------------------------------------------------------------------------
  getUpdates: {
    method: 'GET',
    path: '/system/updates',
    mode: 'onprem',
    permission: 'settings.manage',
    query: UpdatesQuerySchema,
    response: dataOf(UpdatesViewSchema),
  },
  installUpdate: {
    method: 'POST',
    path: '/system/updates/install',
    mode: 'onprem',
    permission: 'settings.manage',
    body: UpdateInstallSchema,
    response: dataOf(HostRequestAcceptedSchema),
    status: 202,
    summary: 'Pre-upgrade backup + update request for the host updater',
  },
  updateStatus: {
    method: 'GET',
    path: '/system/updates/status',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(UpdateStatusViewSchema),
    summary: 'Progress written by the host updater (status.json)',
  },

  // ---- backups -------------------------------------------------------------------------------
  listBackups: {
    method: 'GET',
    path: '/system/backups',
    mode: 'onprem',
    permission: 'settings.manage',
    query: BackupListQuerySchema,
    response: listOf(LocalBackupSchema),
  },
  createBackup: {
    method: 'POST',
    path: '/system/backups',
    mode: 'onprem',
    permission: 'settings.manage',
    body: BackupCreateSchema.prefault({}),
    response: dataOf(LocalBackupSchema),
    status: 202,
    summary: 'Back up now (pg_dump -Fc; copies to external / cloud per settings)',
  },
  downloadBackup: {
    method: 'GET',
    path: '/system/backups/:id/download',
    mode: 'onprem',
    permission: 'settings.manage',
    params: IdParams,
    stream: 'file',
  },
  restoreRequest: {
    method: 'POST',
    path: '/system/backups/:id/restore-request',
    mode: 'onprem',
    permission: 'settings.manage',
    params: IdParams,
    body: RestoreRequestSchema,
    response: dataOf(HostRequestAcceptedSchema),
    status: 202,
    summary: 'Ask the host updater to restore this backup (safety backup first)',
  },
  getBackupSettings: {
    method: 'GET',
    path: '/system/backup-settings',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(BackupSettingsSchema),
  },
  updateBackupSettings: {
    method: 'PUT',
    path: '/system/backup-settings',
    mode: 'onprem',
    permission: 'settings.manage',
    body: BackupSettingsUpdateSchema,
    response: dataOf(BackupSettingsSchema),
  },
  testBackupPath: {
    method: 'POST',
    path: '/system/backup-settings/test-path',
    mode: 'onprem',
    permission: 'settings.manage',
    body: PathTestSchema,
    response: dataOf(PathTestResultSchema),
  },
  cloudBackupStatus: {
    method: 'GET',
    path: '/system/backups/cloud',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(CloudBackupStatusViewSchema),
    summary: 'Cloud backup add-on status and stored backups (vendor call)',
  },
  cloudBackupSetup: {
    method: 'POST',
    path: '/system/backups/cloud/setup',
    mode: 'onprem',
    permission: 'settings.manage',
    feature: 'cloud_backup',
    response: dataOf(CloudBackupSetupResultSchema),
    status: 201,
    summary: 'Generate the recovery code (shown once; replaces an earlier one)',
  },
  cloudBackupConfirm: {
    method: 'POST',
    path: '/system/backups/cloud/confirm',
    mode: 'onprem',
    permission: 'settings.manage',
    feature: 'cloud_backup',
    body: CloudBackupConfirmSchema,
    response: dataOf(CloudBackupStatusViewSchema),
  },
  uploadBackupToCloud: {
    method: 'POST',
    path: '/system/backups/:id/upload-cloud',
    mode: 'onprem',
    permission: 'settings.manage',
    feature: 'cloud_backup',
    params: IdParams,
    response: dataOf(LocalBackupSchema),
    status: 202,
  },
  downloadCloudBackup: {
    method: 'POST',
    path: '/system/backups/cloud/:cloudId/download',
    mode: 'onprem',
    permission: 'settings.manage',
    feature: 'cloud_backup',
    params: CloudIdParams,
    body: CloudBackupRestoreDownloadSchema,
    response: dataOf(LocalBackupSchema),
    status: 202,
    summary: 'Fetch + decrypt a cloud backup into a local backup (then restore as usual)',
  },

  // ---- connect, network, disk, support -------------------------------------------------------
  getConnect: {
    method: 'GET',
    path: '/system/connect',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(ConnectSettingsSchema),
  },
  updateConnect: {
    method: 'PUT',
    path: '/system/connect',
    mode: 'onprem',
    permission: 'settings.manage',
    feature: 'connect',
    body: ConnectSettingsUpdateSchema,
    response: dataOf(ConnectSettingsSchema),
    summary: "Opt in / out of pushing the dashboard snapshot to the owner's phone",
  },
  network: {
    method: 'GET',
    path: '/system/network',
    mode: 'onprem',
    permission: ['settings.manage', 'pos.use'],
    response: dataOf(NetworkInfoSchema),
    summary: 'LAN addresses and URLs for other counters, phones and tablets',
  },
  disk: {
    method: 'GET',
    path: '/system/disk',
    mode: 'onprem',
    permission: 'settings.manage',
    response: dataOf(DiskInfoSchema),
  },
  supportBundle: {
    method: 'POST',
    path: '/system/support-bundle',
    mode: 'onprem',
    permission: 'settings.manage',
    body: SupportBundleRequestSchema.prefault({}),
    stream: 'file',
    summary: 'tar.gz with version, redacted config, migrations, logs, disk, last check-in',
  },
})
