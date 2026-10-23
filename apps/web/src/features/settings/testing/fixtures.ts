/**
 * Test fixtures for the settings screens, typed by the identity contract (and parsed by the
 * contract schemas in fixtures.test.ts), so MSW answers exactly what the server must answer.
 */
import type { MeResponse } from '@kadai/shared/api/auth'
import type {
  AuditLog,
  BusinessProfile,
  Device,
  Member,
  NumberSeries,
  Register,
  Role,
  SettingsResponse,
  Store,
} from '@kadai/shared/api/identity'
import { PERMISSION_CODES, ROLE_PRESETS, expandPermissions } from '@kadai/shared/permissions'
import {
  DEFAULT_SETTINGS,
  RegisterSettingsSchema,
  type TenantSettings,
} from '@kadai/shared/settings'
import { IDS, makeMe } from '@/test/fixtures'

export const NOW = '2026-10-20T10:00:00.000Z'

let seq = 0
/** Unique UUID-shaped ids for fixtures. */
export const uid = (): string =>
  `0192f0a0-0000-7000-8000-${String(900_000 + ++seq).padStart(12, '0')}`

export const page = (total: number, limit = 50, offset = 0) => ({ limit, offset, total })

export const ROLE_IDS = {
  owner: '0192f0a0-0000-7000-8000-000000000701',
  manager: '0192f0a0-0000-7000-8000-000000000702',
  cashier: '0192f0a0-0000-7000-8000-000000000703',
} as const

export function role(over: Partial<Role> = {}): Role {
  return {
    id: uid(),
    code: 'senior_cashier',
    name: 'Senior cashier',
    name_ta: 'மூத்த காசாளர்',
    description: 'Cashier who may give bigger discounts',
    permissions: ['pos.use', 'sales.create'],
    effective_permissions: ['pos.use', 'sales.create'],
    is_system: false,
    editable: true,
    member_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function systemRole(code: 'owner' | 'manager' | 'cashier', over: Partial<Role> = {}): Role {
  const preset = ROLE_PRESETS[code]
  return role({
    id: ROLE_IDS[code],
    code,
    name: preset.name_en,
    name_ta: preset.name_ta,
    description: preset.description,
    permissions: [...preset.permissions],
    effective_permissions: [...expandPermissions(preset.permissions)],
    is_system: true,
    editable: false,
    member_count: code === 'owner' ? 1 : 2,
    ...over,
  })
}

export function member(over: Partial<Member> = {}): Member {
  return {
    id: uid(),
    membership_id: uid(),
    full_name: 'Selvi R',
    phone: '+919894012345',
    email: null,
    preferred_locale: 'ta',
    role_id: ROLE_IDS.cashier,
    role_code: 'cashier',
    role_name: 'Cashier',
    role_name_ta: 'காசாளர்',
    is_owner: false,
    store_ids: null,
    status: 'active',
    user_status: 'active',
    has_pin: true,
    pin_locked_until: null,
    last_login_at: NOW,
    invited_by: IDS.user,
    invited_by_name: 'Murugan K',
    is_self: false,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

/** The signed-in owner as a member row. */
export function selfMember(over: Partial<Member> = {}): Member {
  return member({
    id: IDS.user,
    membership_id: IDS.membership,
    full_name: 'Murugan K',
    phone: '+919876543210',
    role_id: ROLE_IDS.owner,
    role_code: 'owner',
    role_name: 'Owner',
    role_name_ta: 'உரிமையாளர்',
    is_owner: true,
    is_self: true,
    ...over,
  })
}

export function store(over: Partial<Store> = {}): Store {
  return {
    id: IDS.store,
    code: 'S1',
    name: 'Main store',
    name_ta: 'முதன்மைக் கிளை',
    gstin: null,
    state_code: '33',
    address: {
      line1: '12 East Masi Street',
      line2: undefined,
      city: 'Madurai',
      district: 'Madurai',
      state_code: '33',
      pincode: '625001',
    },
    phone: '+919876543210',
    email: null,
    drug_license_numbers: null,
    fssai_number: null,
    is_active: true,
    register_count: 1,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function register(over: Partial<Register> = {}): Register {
  return {
    id: IDS.register,
    store_id: IDS.store,
    store_code: 'S1',
    store_name: 'Main store',
    code: 'A',
    name: 'Counter A',
    is_active: true,
    settings: RegisterSettingsSchema.parse({}),
    last_seen_at: NOW,
    device_count: 1,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function device(over: Partial<Device> = {}): Device {
  return {
    id: IDS.device,
    name: 'Counter A PC',
    store_id: IDS.store,
    store_code: 'S1',
    store_name: 'Main store',
    register_id: IDS.register,
    register_code: 'A',
    register_name: 'Counter A',
    user_agent: 'Mozilla/5.0',
    status: 'active',
    approved_by: IDS.user,
    approved_by_name: 'Murugan K',
    last_seen_at: NOW,
    revoked_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function series(over: Partial<NumberSeries> = {}): NumberSeries {
  const base: NumberSeries = {
    id: uid(),
    key: `${IDS.store}:${IDS.register}:sales_invoice:2026-27`,
    store_id: IDS.store,
    store_code: 'S1',
    register_id: IDS.register,
    register_code: 'A',
    doc_type: 'sales_invoice',
    fy: '2026-27',
    prefix: 'S1-A/2627/',
    padding: 5,
    next_number: 42,
    next: 'S1-A/2627/00042',
    issued_count: 41,
    max_length: 16,
    is_gst_document: true,
    updated_at: NOW,
  }
  return { ...base, ...over }
}

export function auditLog(over: Partial<AuditLog> = {}): AuditLog {
  return {
    id: ++seq,
    user_id: IDS.user,
    user_name: 'Murugan K',
    action: 'product.price_change',
    entity_type: 'product',
    entity_id: '0192f0a0-0000-7000-8000-000000000801',
    summary: 'Ponni Rice 5 kg: ₹399 → ₹389',
    changes: { before: { sale_price_paise: 39_900 }, after: { sale_price_paise: 38_900 } },
    ip: '192.168.1.20',
    user_agent: 'Mozilla/5.0',
    request_id: 'req-1',
    created_at: NOW,
    ...over,
  }
}

export function businessProfile(over: Partial<BusinessProfile> = {}): BusinessProfile {
  return {
    name: 'Sri Murugan Stores',
    name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
    legal_name: null,
    business_type: 'general_store',
    gst_scheme: 'regular',
    gstin: '33AAAPL1234C1ZL',
    pan: 'AAAPL1234C',
    state_code: '33',
    phone: '+919876543210',
    email: null,
    address: {
      line1: '12 East Masi Street',
      line2: undefined,
      city: 'Madurai',
      district: 'Madurai',
      state_code: '33',
      pincode: '625001',
    },
    logo_file_id: null,
    default_locale: 'ta',
    timezone: 'Asia/Kolkata',
    fy_start_month: 4,
    current_fy: '2026-27',
    gst_scheme_change_requires_confirm: false,
    updated_at: NOW,
    ...over,
  }
}

export function settingsResponse(settings: TenantSettings = DEFAULT_SETTINGS): SettingsResponse {
  const me = makeMe()
  return { tenant: me.tenant, settings }
}

/** /me of a store-scoped manager (settings.manage + users.manage on store S1 only). */
export function storeScopedMe(): MeResponse {
  const me = makeMe()
  return { ...me, membership: { ...me.membership, role_code: 'manager', store_ids: [IDS.store] } }
}

/** Every permission except the given ones. */
export function permissionsWithout(...drop: string[]) {
  return PERMISSION_CODES.filter((p) => !drop.includes(p))
}
