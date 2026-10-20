import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { type RouteDef, routeUrl } from '../../src/api/common'
import {
  BackupSettingsUpdateSchema,
  CHECK_IN_INTERVAL_SECONDS,
  CLOUD_BACKUP_ENCRYPTION,
  LicenseDeactivateSchema,
  LicenseUploadSchema,
  ONPREM_ERROR_REASONS,
  RECOVERY_CODE_RE,
  RestoreRequestSchema,
  UpdateRequestFileSchema,
  UpdateStatusFileSchema,
  VendorStateSchema,
  backupFileName,
  backupHealth,
  backupsToPrune,
  checkInDelaySeconds,
  emptyVendorState,
  firewallCommand,
  generateRecoveryCode,
  isTerminalUpdateState,
  kioskShortcutTarget,
  lanUrls,
  localLicenseState,
  onpremRoutes,
  parseBackupFileName,
  parseRecoveryCode,
  redactConfig,
  visibleBanners,
  type RetentionCandidate,
} from '../../src/api/onprem'
import { CHECK_IN_INTERVAL_SECONDS as LICENSING_INTERVAL } from '../../src/api/licensing'
import { ERROR_CODES } from '../../src/errors'
import { createRng } from '../helpers/prng'
import {
  KEY_PREFIX,
  LICENSE_KEY,
  SHA,
  SIG,
  TS,
  TS2,
  addonEntitlements,
  amc,
  banners,
  cloudBackup,
  cloudQuota,
  entitlements,
  id,
  offerQuote,
  quote,
  releaseInfo,
  releasePlan,
  renewalInfo,
  signedLicense,
  term,
  vendorInfo,
} from './fixtures/vendor'

describe('onprem helpers', () => {
  it('check-in backoff: 6 h when healthy, 5 min doubling while offline, capped', () => {
    expect(checkInDelaySeconds(0)).toBe(CHECK_IN_INTERVAL_SECONDS)
    expect(CHECK_IN_INTERVAL_SECONDS).toBe(LICENSING_INTERVAL)
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map(checkInDelaySeconds)).toEqual([
      300, 600, 1200, 2400, 4800, 9600, 19_200, 21_600, 21_600,
    ])
    expect(() => checkInDelaySeconds(-1)).toThrow(RangeError)
  })

  it('maps core licence status to the owner-facing state', () => {
    expect(localLicenseState('missing')).toBe('none')
    expect(localLicenseState('valid')).toBe('valid')
    expect(localLicenseState('valid', true)).toBe('grace')
    expect(localLicenseState('expired')).toBe('expired')
    expect(localLicenseState('not_yet_valid')).toBe('not_yet_valid')
    for (const s of ['bad_signature', 'malformed', 'unknown_key', 'installation_mismatch'] as const)
      expect(localLicenseState(s)).toBe('tampered')
  })

  it('recovery codes: generate, normalize, detect typos', () => {
    const rng = createRng(5)
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode((n) =>
        Uint8Array.from({ length: n }, () => rng.int(0, 255)),
      )
      expect(code).toMatch(RECOVERY_CODE_RE)
      expect(parseRecoveryCode(code)).toBe(code)
      expect(parseRecoveryCode(code.toLowerCase().replaceAll('-', ' '))).toBe(code)
      const flipped = code[0] === 'A' ? `B${code.slice(1)}` : `A${code.slice(1)}`
      expect(parseRecoveryCode(flipped)).toBeNull()
    }
    expect(generateRecoveryCode()).toMatch(RECOVERY_CODE_RE)
    expect(parseRecoveryCode('ABCD')).toBeNull()
    expect(CLOUD_BACKUP_ENCRYPTION.scrypt.keylen).toBe(32)
  })

  it('backup file names match the host scripts (IST timestamp)', () => {
    const at = new Date('2026-10-20T17:30:05Z') // 23:00:05 IST
    expect(backupFileName({ db: 'kadai', at, kind: 'scheduled' })).toBe(
      'kadai-kadai-20261020-230005-scheduled.dump',
    )
    const name = backupFileName({ db: 'kadai', at, kind: 'manual', label: 'Before GST change!' })
    expect(name).toBe('kadai-kadai-20261020-230005-manual-before-gst-change.dump')
    expect(parseBackupFileName(name)).toEqual({
      db: 'kadai',
      stamp: '20261020-230005',
      kind: 'manual',
      label: 'before-gst-change',
    })
    expect(parseBackupFileName('kadai-kadai-20261020-230005-pre_upgrade.dump')).toMatchObject({
      kind: 'pre_upgrade',
      label: null,
    })
    expect(parseBackupFileName('random.dump')).toBeNull()
    expect(() => backupFileName({ db: 'x;rm', at, kind: 'manual' })).toThrow(RangeError)
  })

  it('retention keeps 14 daily + 12 monthly + 10 manual + 5 pre-upgrade', () => {
    const rows: RetentionCandidate[] = []
    // 400 daily scheduled backups ending 2026-10-20 23:00 IST
    for (let d = 0; d < 400; d++)
      rows.push({
        id: `s${String(d).padStart(3, '0')}`,
        kind: 'scheduled',
        status: 'completed',
        started_at: new Date(Date.UTC(2026, 9, 20, 17, 30) - d * 86_400_000),
      })
    for (let m = 0; m < 15; m++)
      rows.push({
        id: `m${m}`,
        kind: 'manual',
        status: 'completed',
        started_at: new Date(Date.UTC(2026, 9, 1) - m * 86_400_000),
      })
    for (let u = 0; u < 7; u++)
      rows.push({
        id: `u${u}`,
        kind: 'pre_upgrade',
        status: 'completed',
        started_at: new Date(Date.UTC(2026, 8, 1) - u * 86_400_000),
      })
    rows.push({ id: 'running', kind: 'manual', status: 'running', started_at: new Date(0) })
    rows.push({ id: 'failed', kind: 'scheduled', status: 'failed', started_at: new Date(0) })
    const prune = new Set(backupsToPrune(rows))
    const kept = rows.filter((r) => !prune.has(r.id))
    const keptScheduled = kept.filter((r) => r.kind === 'scheduled' && r.status === 'completed')
    // 14 newest + the newest of 12 months (October's newest is already among the 14)
    expect(keptScheduled.length).toBe(14 + 11)
    expect(kept.filter((r) => r.kind === 'manual' && r.status === 'completed')).toHaveLength(10)
    expect(kept.filter((r) => r.kind === 'pre_upgrade')).toHaveLength(5)
    expect(prune.has('running')).toBe(false)
    expect(prune.has('failed')).toBe(false)
    for (let d = 0; d < 14; d++) expect(prune.has(`s${String(d).padStart(3, '0')}`)).toBe(false)
    expect(backupsToPrune(rows.slice(0, 3))).toEqual([])
  })

  it('backup health from the last completed backup', () => {
    expect(backupHealth(null, TS)).toBe('error')
    expect(backupHealth('2026-10-19T17:30:00Z', TS)).toBe('ok')
    expect(backupHealth('2026-10-18T10:30:00Z', TS)).toBe('warning')
    expect(backupHealth('2026-10-10T10:30:00Z', TS)).toBe('error')
  })

  it('LAN URLs, firewall hints, kiosk shortcut', () => {
    expect(lanUrls('192.168.1.20', 8080)).toEqual({
      app_url: 'http://192.168.1.20:8080/',
      pos_url: 'http://192.168.1.20:8080/pos',
    })
    expect(lanUrls('fe80::1', 80).pos_url).toBe('http://[fe80::1]/pos')
    expect(firewallCommand('windows', 8080)).toContain('localport=8080')
    expect(firewallCommand('linux', 8080)).toBe('sudo ufw allow 8080/tcp')
    expect(firewallCommand('docker', 8080)).toBeNull()
    expect(kioskShortcutTarget('edge', 'http://localhost:8080/pos')).toBe(
      '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --kiosk-printing --app=http://localhost:8080/pos',
    )
    expect(kioskShortcutTarget('chrome', 'http://localhost:8080/pos')).toContain('chrome.exe')
  })

  it('support bundle redaction removes secrets and URL credentials', () => {
    const out = redactConfig({
      KADAI_MODE: 'onprem',
      JWT_SECRET: 'super',
      KADAI_ENCRYPTION_KEYS: 'k1:abc',
      DATABASE_URL: 'postgres://kadai_app:hunter2@localhost:5432/kadai',
      RAZORPAY_PLATFORM_KEY_SECRET: 'x',
      METRICS_TOKEN: 't',
      KADAI_LICENSE_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----',
      PORT: 8080,
      EMPTY_SECRET: '',
      DEBUG: true,
      SKIPPED: undefined,
    })
    expect(out).toEqual({
      KADAI_MODE: 'onprem',
      JWT_SECRET: '[redacted]',
      KADAI_ENCRYPTION_KEYS: '[redacted]',
      DATABASE_URL: 'postgres://[redacted]@localhost:5432/kadai',
      RAZORPAY_PLATFORM_KEY_SECRET: '[redacted]',
      METRICS_TOKEN: '[redacted]',
      KADAI_LICENSE_SIGNING_KEY: '[redacted]',
      PORT: 8080,
      EMPTY_SECRET: '',
      DEBUG: true,
    })
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('visible banners skip dismissed (unless critical) and out-of-window ones', () => {
    const critical = {
      ...banners[0]!,
      id: id(401),
      severity: 'critical' as const,
      dismissible: false,
    }
    const old = { ...banners[0]!, id: id(402), ends_at: '2026-10-01T00:00:00.000Z' }
    expect(
      visibleBanners([...banners, critical, old], [banners[0]!.id, id(401)], TS).map((b) => b.id),
    ).toEqual([id(401)])
  })

  it('vendor state default and request rules', () => {
    expect(VendorStateSchema.parse(emptyVendorState())).toEqual(emptyVendorState())
    expect(isTerminalUpdateState('rolled_back')).toBe(true)
    expect(isTerminalUpdateState('migrating')).toBe(false)
    expect(
      RestoreRequestSchema.safeParse({ confirm: 'Murugan Medicals', acknowledge_data_loss: false })
        .success,
    ).toBe(false)
    expect(LicenseDeactivateSchema.safeParse({ confirm: '' }).success).toBe(false)
    expect(LicenseUploadSchema.safeParse({ license: signedLicense }).success).toBe(true)
    expect(LicenseUploadSchema.safeParse({ license: 'KDLIC1.abc' }).success).toBe(true)
    expect(LicenseUploadSchema.safeParse({ license: 'garbage' }).success).toBe(false)
    expect(BackupSettingsUpdateSchema.parse({})).toEqual({
      schedule_enabled: true,
      schedule_time: '23:00',
      retention: { daily: 14, monthly: 12, manual: 10, pre_upgrade: 5 },
      external_path: null,
      cloud_enabled: false,
    })
    expect(BackupSettingsUpdateSchema.safeParse({ schedule_time: '24:00' }).success).toBe(false)
    expect(BackupSettingsUpdateSchema.safeParse({ external_path: 'relative/dir' }).success).toBe(
      false,
    )
    expect(BackupSettingsUpdateSchema.safeParse({ external_path: 'E:\\KadaiBackup' }).success).toBe(
      true,
    )
    expect(
      BackupSettingsUpdateSchema.safeParse({ external_path: '/media/usb/kadai' }).success,
    ).toBe(true)
    for (const [reason, def] of Object.entries(ONPREM_ERROR_REASONS)) {
      expect(Object.hasOwn(ERROR_CODES, def.code), reason).toBe(true)
      expect(def.ta).toMatch(/[஀-௿]/)
    }
  })

  it('host updater files', () => {
    const request = {
      format: 'kadai-update-request-v1',
      id: id(1000),
      action: 'update',
      requested_at: TS,
      requested_by: { user_id: id(1), name: 'Murugan' },
      current_version: '1.3.2',
      update: {
        version: '1.4.0',
        platform: 'windows-x64',
        url: 'https://downloads.kadai.app/1.4.0/kadai-server-win-x64.zip',
        sha256: SHA,
        size_bytes: 85_000_000,
        signature: SIG,
      },
      restore: null,
      pre_backup: {
        backup_id: id(1001),
        path: 'C:\\Kadai\\data\\backups\\kadai-kadai-20261020-103000-pre_upgrade.dump',
      },
    }
    expect(UpdateRequestFileSchema.safeParse(request).success).toBe(true)
    expect(UpdateRequestFileSchema.safeParse({ ...request, format: 'v0' }).success).toBe(false)
    const status = {
      format: 'kadai-update-status-v1',
      request_id: id(1000),
      action: 'update',
      state: 'health_check',
      version: '1.4.0',
      previous_version: '1.3.2',
      progress_pct: 90,
      message: 'Waiting for /health/ready',
      started_at: TS,
      updated_at: TS2,
      finished_at: null,
      log_tail: ['downloaded 85 MB', 'sha256 ok', 'signature ok'],
      error: null,
    }
    expect(UpdateStatusFileSchema.safeParse(status).success).toBe(true)
    expect(UpdateStatusFileSchema.safeParse({ ...status, state: 'exploded' }).success).toBe(false)
  })
})

// ---- fixtures ------------------------------------------------------------------------------

const installed = {
  license_id: id(100),
  key_prefix: KEY_PREFIX,
  licensee: 'Murugan',
  business_name: 'Murugan Medicals',
  edition_code: 'onprem_standard',
  edition_name: 'Kadai Server Standard',
  edition_name_ta: 'கடை சர்வர் ஸ்டாண்டர்டு',
  plan_code: 'onprem_standard',
  license_type: 'perpetual',
  valid_from: '2026-10-20',
  valid_until: null,
  updates_until: '2027-10-19',
  support_until: '2027-10-19',
  grace_days: 15,
  check_in_days: 7,
  addons: [],
  customer_id: id(30),
  partner_id: null,
  issued_at: TS,
  kid: 'prod-2026',
}
const licenseView = {
  state: 'valid',
  core_status: 'valid',
  read_only: false,
  installation_id: id(120),
  license: installed,
  term,
  amc,
  support: amc,
  entitlements,
  activation: { method: 'online', activated_at: TS },
  vendor: { license_status: 'active', activation_status: 'active', last_check_in_at: TS2 },
}
const vendorState = {
  last_check_in_at: TS2,
  last_attempt_at: TS2,
  last_error: null,
  consecutive_failures: 0,
  next_check_in_at: '2026-10-21T10:00:00.000Z',
  license_status: 'active',
  activation_status: 'active',
  banners,
  offers: [offerQuote],
  renewal: renewalInfo,
  releases: releasePlan,
  entitlements: addonEntitlements,
  vendor: vendorInfo,
  dismissed_banner_ids: [],
}
const vendorStateView = { ...vendorState, online: true, visible_banners: banners, amc }
const localBackup = {
  id: id(1001),
  kind: 'scheduled',
  status: 'completed',
  file_name: 'kadai-kadai-20261020-230005-scheduled.dump',
  label: null,
  location: 'C:\\Kadai\\data\\backups\\kadai-kadai-20261020-230005-scheduled.dump',
  size_bytes: 52_428_800,
  checksum_sha256: SHA,
  started_at: TS,
  finished_at: TS,
  error: null,
  external_copy: {
    path: 'E:\\KadaiBackup\\kadai-kadai-20261020-230005-scheduled.dump',
    copied_at: TS,
    verified: true,
  },
  uploaded_to_cloud: false,
  cloud_backup_id: null,
  restorable: true,
}
const accepted = {
  request_id: id(1000),
  action: 'update',
  version: '1.4.0',
  pre_backup_id: id(1001),
  requested_at: TS,
}
const cloudStatus = {
  licensed: true,
  ready: true,
  enabled: true,
  recovery_code_set_at: TS,
  quota: cloudQuota,
  backups: [cloudBackup],
  last_upload_at: TS,
  last_error: null,
  live: true,
}

interface Fixture {
  params?: unknown
  query?: unknown
  body?: unknown
  response?: unknown
}

const fixtures: Record<keyof typeof onpremRoutes, Fixture> = {
  getLicense: { response: { data: licenseView } },
  activateLicense: {
    body: { license_key: LICENSE_KEY.toLowerCase() },
    response: { data: licenseView },
  },
  activationRequest: {
    response: {
      data: {
        request: {
          format: 'kadai-activation-request-v1',
          request: {
            installation_id: id(120),
            installation_public_key: `MCowBQYDK2VwAyEA${'x'.repeat(43)}=`,
            fingerprint_hash: 'b'.repeat(64),
            machine_name: 'BILLING-PC',
            os: 'windows 10.0.19045 x64',
            app_version: '1.3.2',
            business_name: 'Murugan Medicals',
            created_at: TS,
            nonce: 'n0nce-1234567890ab',
          },
          signature: SIG,
        },
        code: 'KDREQ1.eyJ…',
        filename: 'kadai-activation-0192f7a4.kadai-request',
        activation_url: 'https://kadai.app/activate',
        created_at: TS,
      },
    },
  },
  uploadLicense: {
    body: { license: JSON.stringify(signedLicense) },
    response: { data: licenseView },
  },
  refreshLicense: { response: { data: { changed: true, license: licenseView } } },
  deactivateLicense: {
    body: { confirm: 'Murugan Medicals', reason: 'New computer' },
    response: {
      data: {
        deactivated_at: TS2,
        transfers_left: 2,
        license: {
          ...licenseView,
          state: 'none',
          core_status: 'missing',
          license: null,
          term: null,
          amc: null,
          support: null,
        },
      },
    },
  },
  vendorState: { response: { data: vendorStateView } },
  checkInNow: { response: { data: vendorStateView } },
  dismissBanner: { params: { id: banners[0]!.id } },
  renewalQuote: {
    body: { items: [{ product_code: 'amc_renewal' }], coupon_code: 'DEEPA30' },
    response: { data: { order_kind: 'renewal', quote } },
  },
  renewalCheckout: {
    body: { items: [{ product_code: 'amc_renewal' }] },
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
  getUpdates: {
    query: { refresh: 'true' },
    response: {
      data: {
        current_version: '1.3.2',
        channel: 'stable',
        platform: 'windows-x64',
        updates_until: '2027-10-19',
        amc,
        source: 'live',
        checked_at: TS2,
        releases: [releaseInfo, { ...releaseInfo, version: '1.5.0', eligible: false }],
        latest_eligible: releaseInfo,
        newest_ineligible: { ...releaseInfo, version: '1.5.0', eligible: false },
        next_step: releaseInfo,
        in_progress: null,
      },
    },
  },
  installUpdate: { body: { version: '1.4.0' }, response: { data: accepted } },
  updateStatus: { response: { data: { state: 'idle', request: null, status: null } } },
  listBackups: {
    query: { kind: 'scheduled', sort: '-started_at' },
    response: { data: [localBackup], page: { limit: 50, offset: 0, total: 1 } },
  },
  createBackup: {
    body: { label: 'before GST change' },
    response: {
      data: {
        ...localBackup,
        kind: 'manual',
        status: 'running',
        finished_at: null,
        restorable: false,
        external_copy: null,
      },
    },
  },
  downloadBackup: { params: { id: id(1001) } },
  restoreRequest: {
    params: { id: id(1001) },
    body: { confirm: 'Murugan Medicals', acknowledge_data_loss: true },
    response: { data: { ...accepted, action: 'restore', version: null } },
  },
  getBackupSettings: {
    response: {
      data: {
        schedule_enabled: true,
        schedule_time: '23:00',
        retention: { daily: 14, monthly: 12, manual: 10, pre_upgrade: 5 },
        external_path: 'E:\\KadaiBackup',
        cloud_enabled: true,
        cloud_ready: true,
        last_backup: localBackup,
        next_run_at: '2026-10-21T17:30:00.000Z',
        health: 'ok',
      },
    },
  },
  updateBackupSettings: {
    body: { schedule_time: '22:30', external_path: 'E:\\KadaiBackup', cloud_enabled: true },
    response: {
      data: {
        schedule_enabled: true,
        schedule_time: '22:30',
        retention: { daily: 14, monthly: 12, manual: 10, pre_upgrade: 5 },
        external_path: 'E:\\KadaiBackup',
        cloud_enabled: true,
        cloud_ready: true,
        last_backup: null,
        next_run_at: null,
        health: 'error',
      },
    },
  },
  testBackupPath: {
    body: { path: 'E:\\KadaiBackup' },
    response: {
      data: {
        path: 'E:\\KadaiBackup',
        exists: true,
        writable: true,
        free_bytes: 64_000_000_000,
        same_device_as_data: false,
        error: null,
      },
    },
  },
  cloudBackupStatus: { response: { data: cloudStatus } },
  cloudBackupSetup: {
    response: { data: { recovery_code: generateRecoveryCode(), created_at: TS } },
  },
  cloudBackupConfirm: {
    body: { recovery_code: generateRecoveryCode().toLowerCase() },
    response: { data: cloudStatus },
  },
  uploadBackupToCloud: { params: { id: id(1001) }, response: { data: localBackup } },
  downloadCloudBackup: {
    params: { cloudId: id(700) },
    body: { recovery_code: generateRecoveryCode() },
    response: { data: { ...localBackup, id: id(1002), kind: 'manual', label: 'cloud-restore' } },
  },
  getConnect: {
    response: {
      data: {
        licensed: true,
        enabled: true,
        last_snapshot_at: TS2,
        last_snapshot_accepted: true,
        connect_url: 'https://kadai.app/connect',
      },
    },
  },
  updateConnect: {
    body: { enabled: false },
    response: {
      data: {
        licensed: true,
        enabled: false,
        last_snapshot_at: TS2,
        last_snapshot_accepted: null,
        connect_url: 'https://kadai.app/connect',
      },
    },
  },
  network: {
    response: {
      data: {
        hostname: 'BILLING-PC',
        port: 8080,
        addresses: [
          { interface: 'Wi-Fi', address: '192.168.1.20', family: 'IPv4', internal: false },
          { interface: 'Loopback', address: '127.0.0.1', family: 'IPv4', internal: true },
        ],
        urls: [{ address: '192.168.1.20', ...lanUrls('192.168.1.20', 8080) }],
        primary_url: 'http://192.168.1.20:8080/',
        firewall: { os: 'windows', command: firewallCommand('windows', 8080) },
      },
    },
  },
  disk: {
    response: {
      data: {
        data_dir: 'C:\\Kadai\\data',
        total_bytes: 256_000_000_000,
        free_bytes: 1_500_000_000,
        backups_bytes: 2_200_000_000,
        low: true,
        threshold_bytes: 2 * 1024 ** 3,
      },
    },
  },
  supportBundle: { body: { include_logs: false } },
}

describe('onprem catalogue', () => {
  const entries = Object.entries(onpremRoutes) as [string, RouteDef][]

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

  it.each(entries)('%s is on-prem only and well-formed', (_name, def) => {
    expect(def.mode).toBe('onprem')
    expect(def.path.startsWith('/system/')).toBe(true)
    const params = [...def.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!)
    if (params.length) {
      const shape = (def.params as unknown as z.ZodObject).shape as Record<string, unknown>
      expect(Object.keys(shape).sort()).toEqual(params.sort())
    }
    if (def.method === 'GET') expect('body' in def).toBe(false)
    if (!('stream' in def) && def.method !== 'DELETE' && !def.path.endsWith('/dismiss'))
      expect('response' in def).toBe(true)
  })

  it('unique paths; urls; LAN info open to counters', () => {
    const keys = entries.map(([, d]) => `${d.method} ${d.path}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(routeUrl(onpremRoutes.restoreRequest, { id: id(1) })).toBe(
      `/api/v1/system/backups/${id(1)}/restore-request`,
    )
    expect(onpremRoutes.network.permission).toEqual(['settings.manage', 'pos.use'])
    expect(onpremRoutes.cloudBackupSetup.feature).toBe('cloud_backup')
    expect(onpremRoutes.updateConnect.feature).toBe('connect')
  })

  it('fixtures are really validated', () => {
    expect(
      onpremRoutes.getLicense.response.safeParse({ data: { ...licenseView, state: 'great' } })
        .success,
    ).toBe(false)
  })
})
