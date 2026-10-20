/**
 * Test fixtures that satisfy the shared auth contract schemas (validated in the fixtures test),
 * so MSW handlers answer exactly what the real server must answer.
 */
import type {
  MeResponse,
  MembershipSummary,
  SessionResponse,
  SessionUser,
} from '@kadai/shared/api/auth'
import { DEFAULT_PLAN_FEATURES, DEFAULT_PLAN_LIMITS } from '@kadai/shared/features'
import { PERMISSION_CODES, type Permission } from '@kadai/shared/permissions'
import { DEFAULT_SETTINGS } from '@kadai/shared/settings'

export const IDS = {
  user: '0192f0a0-0000-7000-8000-000000000001',
  tenant: '0192f0a0-0000-7000-8000-000000000101',
  tenant2: '0192f0a0-0000-7000-8000-000000000102',
  membership: '0192f0a0-0000-7000-8000-000000000201',
  store: '0192f0a0-0000-7000-8000-000000000301',
  store2: '0192f0a0-0000-7000-8000-000000000302',
  register: '0192f0a0-0000-7000-8000-000000000401',
  register2: '0192f0a0-0000-7000-8000-000000000402',
  session: '0192f0a0-0000-7000-8000-000000000501',
  device: '0192f0a0-0000-7000-8000-000000000601',
  cashier: '0192f0a0-0000-7000-8000-000000000002',
} as const

export const testUser: SessionUser = {
  id: IDS.user,
  full_name: 'Murugan K',
  phone: '+919876543210',
  email: 'murugan@example.com',
  preferred_locale: 'en',
  is_platform_admin: false,
}

export const testMembership: MembershipSummary = {
  tenant_id: IDS.tenant,
  tenant_name: 'Sri Murugan Stores',
  business_type: 'general_store',
  role_code: 'owner',
}

let tokenCounter = 0

export function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
  tokenCounter++
  return {
    access_token: `test-access-token-${tokenCounter}`,
    token_type: 'Bearer',
    expires_in: 900,
    user: testUser,
    memberships: [testMembership],
    tenant_id: IDS.tenant,
    ...overrides,
  }
}

export function makeMe(
  options: {
    permissions?: Permission[]
    features?: MeResponse['entitlements']['features']
    mode?: MeResponse['mode']
    businessType?: MeResponse['tenant']['business_type']
    tenantId?: string
    device?: MeResponse['device']
  } = {},
): MeResponse {
  return {
    user: testUser,
    tenant: {
      id: options.tenantId ?? IDS.tenant,
      name: 'Sri Murugan Stores',
      name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
      legal_name: null,
      business_type: options.businessType ?? 'general_store',
      gst_scheme: 'regular',
      gstin: '33AAAPL1234C1ZV',
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
      status: 'active',
      plan_code: 'growth',
    },
    membership: {
      id: IDS.membership,
      role_code: 'owner',
      role_name: 'Owner',
      permissions: options.permissions ?? [...PERMISSION_CODES],
      store_ids: null,
    },
    entitlements: {
      plan_code: 'growth',
      features: options.features ?? [...DEFAULT_PLAN_FEATURES.growth],
      limits: DEFAULT_PLAN_LIMITS.growth,
      source: 'plan',
      valid_until: null,
    },
    settings: DEFAULT_SETTINGS,
    stores: [
      {
        id: IDS.store,
        code: 'S1',
        name: 'Main store',
        name_ta: 'முதன்மைக் கிளை',
        state_code: '33',
        gstin: '33AAAPL1234C1ZV',
        is_active: true,
      },
      {
        id: IDS.store2,
        code: 'S2',
        name: 'Anna Nagar',
        name_ta: 'அண்ணா நகர்',
        state_code: '33',
        gstin: '33AAAPL1234C1ZV',
        is_active: true,
      },
    ],
    registers: [
      { id: IDS.register, store_id: IDS.store, code: 'A', name: 'Counter A', is_active: true },
      { id: IDS.register2, store_id: IDS.store2, code: 'A', name: 'Counter A', is_active: true },
    ],
    mode: options.mode ?? 'cloud',
    device: options.device ?? null,
    server_time: '2026-10-20T10:00:00.000Z',
  }
}
