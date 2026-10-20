import { describe, expect, it } from 'vitest'
import {
  AccessTokenClaimsSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  MeResponseSchema,
  OtpRequestSchema,
  OtpVerifyRequestSchema,
  OtpVerifyResponseSchema,
  PasswordChangeRequestSchema,
  PasswordResetRequestSchema,
  PinLoginRequestSchema,
  PinUsersQuerySchema,
  SessionResponseSchema,
  SetupRequestSchema,
  SetupStatusResponseSchema,
  SignupRequestSchema,
} from '../../src/api/auth'
import { DEFAULT_PLAN_FEATURES, DEFAULT_PLAN_LIMITS } from '../../src/features'
import { newId } from '../../src/ids'
import { DEFAULT_SETTINGS } from '../../src/settings'

const signup = {
  business_name: 'Murugan Stores',
  business_type: 'general_store',
  owner_name: 'Murugan',
  phone: '98765 43210',
  password: 'kadai@2026',
  state_code: '33',
}

describe('signup / setup', () => {
  it('normalises and defaults', () => {
    const parsed = SignupRequestSchema.parse({ ...signup, email: 'Owner@Example.COM' })
    expect(parsed).toMatchObject({
      phone: '+919876543210',
      locale: 'ta',
      gstin: null,
      email: 'owner@example.com',
    })
    expect(SignupRequestSchema.parse({ ...signup, email: '' }).email).toBeUndefined()
  })
  it.each<[string, Record<string, unknown>]>([
    ['short password', { password: 'short' }],
    ['whitespace password', { password: '          ' }],
    ['long password', { password: 'x'.repeat(129) }],
    ['bad phone', { phone: '12345' }],
    ['bad state', { state_code: '99x' }],
    ['bad business type', { business_type: 'casino' }],
    ['GSTIN of another state', { gstin: '27AAPFU0939F1ZV' }],
    [
      'unregistered with GSTIN',
      { state_code: '27', gstin: '27AAPFU0939F1ZV', gst_scheme: 'unregistered' },
    ],
    ['regular without GSTIN', { gst_scheme: 'regular' }],
    ['bad email', { email: 'not-an-email' }],
  ])('rejects %s', (_name, over) => {
    expect(SignupRequestSchema.safeParse({ ...signup, ...over }).success).toBe(false)
  })
  it('accepts a registered business whose GSTIN matches its state', () => {
    expect(
      SignupRequestSchema.safeParse({
        ...signup,
        state_code: '27',
        gstin: '27aapfu0939f1zv',
        gst_scheme: 'regular',
      }).success,
    ).toBe(true)
  })
  it('setup request and status', () => {
    expect(
      SetupRequestSchema.parse({ ...signup, store_name: 'Main', setup_token: 'abcd-1234' })
        .store_name,
    ).toBe('Main')
    expect(
      SetupStatusResponseSchema.parse({ setup_required: true, mode: 'onprem', version: '1.0.0' })
        .token_required,
    ).toBe(false)
  })
})

describe('login, OTP, passwords, PIN', () => {
  it('login', () => {
    expect(LoginRequestSchema.safeParse({ identifier: '9876543210', password: 'x' }).success).toBe(
      true,
    )
    expect(LoginRequestSchema.safeParse({ identifier: 'ab', password: 'x' }).success).toBe(false)
    expect(
      LoginRequestSchema.safeParse({ identifier: 'owner@example.com', password: '' }).success,
    ).toBe(false)
  })
  it('OTP', () => {
    expect(OtpRequestSchema.parse({ phone: '09876543210', purpose: 'login' }).phone).toBe(
      '+919876543210',
    )
    expect(OtpRequestSchema.safeParse({ phone: '9876543210', purpose: 'hack' }).success).toBe(false)
    expect(
      OtpVerifyRequestSchema.safeParse({ phone: '9876543210', code: '123456', purpose: 'signup' })
        .success,
    ).toBe(true)
    expect(
      OtpVerifyRequestSchema.safeParse({ phone: '9876543210', code: '12345', purpose: 'signup' })
        .success,
    ).toBe(false)
    expect(OtpVerifyResponseSchema.safeParse({ otp_token: 't', expires_in: 600 }).success).toBe(
      true,
    )
  })
  it('password reset / change', () => {
    expect(
      PasswordResetRequestSchema.safeParse({
        otp_token: 'x'.repeat(32),
        new_password: 'newpass123',
      }).success,
    ).toBe(true)
    expect(
      PasswordChangeRequestSchema.safeParse({
        current_password: 'oldpass123',
        new_password: 'newpass123',
      }).success,
    ).toBe(true)
    expect(
      PasswordChangeRequestSchema.safeParse({
        current_password: 'samepass1',
        new_password: 'samepass1',
      }).success,
    ).toBe(false)
  })
  it('PIN login', () => {
    const base = { device_id: newId(), device_secret: 's'.repeat(43), user_id: newId() }
    expect(PinLoginRequestSchema.safeParse({ ...base, pin: '1234' }).success).toBe(true)
    expect(PinLoginRequestSchema.safeParse({ ...base, pin: '123' }).success).toBe(false)
    expect(PinLoginRequestSchema.safeParse({ ...base, pin: '1234567' }).success).toBe(false)
    expect(
      PinUsersQuerySchema.safeParse({
        device_id: base.device_id,
        device_secret: base.device_secret,
      }).success,
    ).toBe(true)
  })
  it('logout defaults', () => {
    expect(LogoutRequestSchema.parse({})).toEqual({ all: false })
  })
})

describe('session & me', () => {
  const user = {
    id: newId(),
    full_name: 'Murugan',
    phone: '+919876543210',
    email: null,
    preferred_locale: 'ta',
    is_platform_admin: false,
  }
  it('SessionResponseSchema', () => {
    const session = {
      access_token: 'jwt',
      token_type: 'Bearer',
      expires_in: 900,
      user,
      memberships: [
        {
          tenant_id: newId(),
          tenant_name: 'Murugan Stores',
          business_type: 'general_store',
          role_code: 'owner',
        },
      ],
      tenant_id: null,
    }
    expect(SessionResponseSchema.safeParse(session).success).toBe(true)
    expect(OtpVerifyResponseSchema.safeParse(session).success).toBe(true)
    expect(SessionResponseSchema.safeParse({ ...session, token_type: 'bearer' }).success).toBe(
      false,
    )
  })
  it('MeResponseSchema accepts a realistic payload and fills settings defaults', () => {
    const tenantId = newId()
    const storeId = newId()
    const me = MeResponseSchema.parse({
      user,
      tenant: {
        id: tenantId,
        name: 'Murugan Stores',
        name_ta: 'முருகன் ஸ்டோர்ஸ்',
        legal_name: null,
        business_type: 'general_store',
        gst_scheme: 'regular',
        gstin: '33AAPFU0939F1ZT',
        pan: null,
        state_code: '33',
        phone: '+919876543210',
        email: null,
        address: { city: 'Madurai', state_code: '33' },
        logo_file_id: null,
        default_locale: 'ta',
        timezone: 'Asia/Kolkata',
        fy_start_month: 4,
        status: 'active',
        plan_code: 'growth',
      },
      membership: {
        id: newId(),
        role_code: 'owner',
        role_name: 'Owner',
        permissions: ['pos.use', 'sales.create'],
        store_ids: null,
      },
      entitlements: {
        plan_code: 'growth',
        features: DEFAULT_PLAN_FEATURES.growth,
        limits: DEFAULT_PLAN_LIMITS.growth,
        source: 'plan',
        valid_until: null,
      },
      settings: { invoice: { print_format: 'a4' } },
      stores: [
        {
          id: storeId,
          code: 'S1',
          name: 'Main',
          name_ta: null,
          state_code: '33',
          gstin: null,
          is_active: true,
        },
      ],
      registers: [
        { id: newId(), store_id: storeId, code: 'A', name: 'Counter A', is_active: true },
      ],
      mode: 'cloud',
      device: null,
      server_time: new Date('2026-10-20T06:00:00Z'),
    })
    expect(me.settings.invoice.print_format).toBe('a4')
    expect(me.settings.inventory).toEqual(DEFAULT_SETTINGS.inventory)
    expect(me.server_time).toBe('2026-10-20T06:00:00.000Z')
  })
  it('AccessTokenClaimsSchema', () => {
    expect(
      AccessTokenClaimsSchema.safeParse({
        sub: newId(),
        tid: newId(),
        mid: newId(),
        sid: newId(),
        did: null,
        amr: ['password'],
        iat: 1,
        exp: 2,
      }).success,
    ).toBe(true)
    expect(
      AccessTokenClaimsSchema.safeParse({
        sub: newId(),
        tid: null,
        mid: null,
        sid: newId(),
        did: null,
        amr: ['magic'],
      }).success,
    ).toBe(false)
  })
})
