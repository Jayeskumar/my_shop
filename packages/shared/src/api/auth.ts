/**
 * Contract schemas for the auth (foundation) module — see docs/API.md "auth".
 * Response schemas here are the inner payloads; routes wrap them with dataOf() ({ data: … }).
 */
import { z } from 'zod'
import {
  AuthMethodSchema,
  BusinessTypeSchema,
  DeploymentModeSchema,
  GstSchemeSchema,
  LocaleSchema,
  OtpPurposeSchema,
  TenantStatusSchema,
} from '../enums'
import { EntitlementsSchema } from '../features'
import { PermissionSchema } from '../permissions'
import { TenantSettingsSchema } from '../settings'
import {
  AddressSchema,
  dataOf,
  defineRoutes,
  zE164,
  zId,
  zOptionalGstin,
  zOptionalText,
  zPhone,
  zStateCode,
  zTimestamp,
} from './common'

/**
 * Non-browser clients (scripts, native apps) send `X-Kadai-Token-Delivery: body` on session
 * endpoints to receive the refresh token in the JSON body instead of the httpOnly cookie.
 * POST /auth/refresh with a body `refresh_token` always answers in the body.
 */
export const TOKEN_DELIVERY_HEADER = 'x-kadai-token-delivery'
/** Cookie-authenticated refresh / logout must carry `X-Requested-With: kadai` (CSRF guard). */
export const CSRF_HEADER = 'x-requested-with'
export const CSRF_HEADER_VALUE = 'kadai'

// ---------------------------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

/** New passwords: 8–128 characters, not only whitespace. */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH)
  .refine((v) => v.trim().length >= PASSWORD_MIN_LENGTH, {
    message: 'Password cannot be only spaces',
  })

/** Existing password on login / change (no policy check, just bounds). */
const CurrentPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH)

export const OtpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit OTP')
export const PinSchema = z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits')

const OptionalEmailSchema = z
  .union([z.literal(''), z.email().max(254)])
  .optional()
  .transform((v) => (v === '' ? undefined : v?.toLowerCase()))

const BusinessFields = {
  business_name: z.string().trim().min(1).max(200),
  /** Shop name in Tamil (tenants.name_ta), printed on Tamil / bilingual invoices. */
  business_name_ta: zOptionalText(200),
  business_type: BusinessTypeSchema,
  owner_name: z.string().trim().min(1).max(120),
  phone: zPhone,
  password: PasswordSchema,
  email: OptionalEmailSchema,
  state_code: zStateCode,
  gstin: zOptionalGstin,
  /** Defaults to 'regular' when a GSTIN is given, otherwise 'unregistered'. */
  gst_scheme: GstSchemeSchema.optional(),
  locale: LocaleSchema.default('ta'),
}

type BusinessShape = {
  gstin: string | null
  gst_scheme?: z.infer<typeof GstSchemeSchema> | undefined
  state_code: string
}

function refineBusiness(value: BusinessShape, ctx: z.RefinementCtx): void {
  if (value.gstin && value.gstin.slice(0, 2) !== value.state_code) {
    ctx.addIssue({
      code: 'custom',
      path: ['gstin'],
      message: 'GSTIN state code does not match the selected state',
    })
  }
  if (value.gst_scheme === 'unregistered' && value.gstin) {
    ctx.addIssue({
      code: 'custom',
      path: ['gst_scheme'],
      message: 'An unregistered business cannot have a GSTIN',
    })
  }
  if ((value.gst_scheme === 'regular' || value.gst_scheme === 'composition') && !value.gstin) {
    ctx.addIssue({
      code: 'custom',
      path: ['gstin'],
      message: 'GSTIN is required for registered businesses',
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** POST /auth/signup (cloud only). */
export const SignupRequestSchema = z
  .object({
    ...BusinessFields,
    /** From POST /auth/otp/verify {purpose: 'signup'}; required when phone verification is enabled. */
    otp_token: z.string().min(16).max(512).optional(),
  })
  .superRefine(refineBusiness)
export type SignupRequest = z.infer<typeof SignupRequestSchema>

/** POST /auth/login — identifier is a mobile number or an email. */
export const LoginRequestSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: CurrentPasswordSchema,
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

/**
 * OTP purposes served by /auth/otp/* (the server answers VALIDATION_ERROR for 'verify_phone',
 * which is reserved for in-app phone changes).
 */
export const AuthOtpPurposeSchema = OtpPurposeSchema.extract(['login', 'signup', 'reset_password'])
export type AuthOtpPurpose = z.infer<typeof AuthOtpPurposeSchema>

/** POST /auth/otp/request */
export const OtpRequestSchema = z.object({
  phone: zPhone,
  purpose: OtpPurposeSchema,
})
export type OtpRequest = z.infer<typeof OtpRequestSchema>

export const OtpRequestResponseSchema = z.object({
  /** Seconds until the OTP expires. */
  expires_in: z.int().min(0),
  /** Seconds before another OTP may be requested. */
  resend_after: z.int().min(0),
})
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>

/** POST /auth/otp/verify */
export const OtpVerifyRequestSchema = z.object({
  phone: zPhone,
  code: OtpCodeSchema,
  purpose: OtpPurposeSchema,
})
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>

/** Result of verifying a signup / reset_password OTP. */
export const OtpTokenResponseSchema = z.object({
  otp_token: z.string(),
  expires_in: z.int().min(0),
})
export type OtpTokenResponse = z.infer<typeof OtpTokenResponseSchema>

/** POST /auth/password/reset */
export const PasswordResetRequestSchema = z.object({
  otp_token: z.string().min(16).max(512),
  new_password: PasswordSchema,
})
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>

/** POST /auth/password/change (authenticated) */
export const PasswordChangeRequestSchema = z
  .object({
    current_password: CurrentPasswordSchema,
    new_password: PasswordSchema,
  })
  .refine((v) => v.current_password !== v.new_password, {
    message: 'New password must be different from the current password',
    path: ['new_password'],
  })
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>

/** POST /auth/select-tenant */
export const SelectTenantRequestSchema = z.object({ tenant_id: zId })
export type SelectTenantRequest = z.infer<typeof SelectTenantRequestSchema>

/** POST /auth/refresh — browsers use the httpOnly cookie; other clients send the token. */
export const RefreshRequestSchema = z.object({
  refresh_token: z.string().min(16).max(512).optional(),
})
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>

/** POST /auth/logout — `all: true` revokes every session of the user. */
export const LogoutRequestSchema = z.object({
  all: z.boolean().default(false),
  refresh_token: z.string().min(16).max(512).optional(),
})
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>

/** POST /auth/pin-login (trusted device) */
export const PinLoginRequestSchema = z.object({
  device_id: zId,
  device_secret: z.string().min(16).max(512),
  user_id: zId,
  pin: PinSchema,
})
export type PinLoginRequest = z.infer<typeof PinLoginRequestSchema>

/** GET /auth/pin-users?device_id=&device_secret= */
export const PinUsersQuerySchema = z.object({
  device_id: zId,
  device_secret: z.string().min(16).max(512),
})
export type PinUsersQuery = z.infer<typeof PinUsersQuerySchema>

export const PinUserSchema = z.object({
  user_id: zId,
  full_name: z.string(),
  role_code: z.string(),
  role_name: z.string(),
})
export const PinUsersResponseSchema = z.array(PinUserSchema)
export type PinUser = z.infer<typeof PinUserSchema>

// ---------------------------------------------------------------------------------------------
// Session & profile
// ---------------------------------------------------------------------------------------------

export const SessionUserSchema = z.object({
  id: zId,
  full_name: z.string(),
  phone: zE164.nullable(),
  email: z.string().nullable(),
  preferred_locale: LocaleSchema,
  is_platform_admin: z.boolean(),
})
export type SessionUser = z.infer<typeof SessionUserSchema>

export const MembershipSummarySchema = z.object({
  tenant_id: zId,
  tenant_name: z.string(),
  business_type: BusinessTypeSchema,
  role_code: z.string(),
})
export type MembershipSummary = z.infer<typeof MembershipSummarySchema>

/** Returned by login, OTP login, select-tenant, refresh, pin-login, signup and setup. */
export const SessionResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  /** Access token lifetime in seconds. */
  expires_in: z.int().min(1),
  /** Only for non-browser clients; browsers get an httpOnly cookie. */
  refresh_token: z.string().optional(),
  user: SessionUserSchema,
  memberships: z.array(MembershipSummarySchema),
  /** Tenant the token is scoped to; null when the user must call /auth/select-tenant. */
  tenant_id: zId.nullable(),
})
export type SessionResponse = z.infer<typeof SessionResponseSchema>

/** POST /auth/otp/verify: a session (purpose login) or an OTP token (signup / reset_password). */
export const OtpVerifyResponseSchema = z.union([SessionResponseSchema, OtpTokenResponseSchema])
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponseSchema>

/** Claims of the HS256 access JWT (ARCHITECTURE.md §7.4). */
export const AccessTokenClaimsSchema = z.object({
  sub: zId,
  /** Tenant id (null for a tenant-less token awaiting select-tenant). */
  tid: zId.nullable(),
  /** Membership id. */
  mid: zId.nullable(),
  /** auth_sessions id. */
  sid: zId,
  /** Trusted device id (PIN sessions). */
  did: zId.nullable(),
  /** Authentication methods used. */
  amr: z.array(AuthMethodSchema),
  iat: z.int().optional(),
  exp: z.int().optional(),
})
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>

export const MeTenantSchema = z.object({
  id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  legal_name: z.string().nullable(),
  business_type: BusinessTypeSchema,
  gst_scheme: GstSchemeSchema,
  gstin: z.string().nullable(),
  pan: z.string().nullable(),
  state_code: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: AddressSchema,
  logo_file_id: zId.nullable(),
  default_locale: LocaleSchema,
  timezone: z.string(),
  fy_start_month: z.int().min(1).max(12),
  status: TenantStatusSchema,
  plan_code: z.string(),
})
export type MeTenant = z.infer<typeof MeTenantSchema>

export const MeMembershipSchema = z.object({
  id: zId,
  role_code: z.string(),
  role_name: z.string(),
  /** Effective permissions (wildcards and implications already expanded). */
  permissions: z.array(PermissionSchema),
  /** null = all stores. */
  store_ids: z.array(zId).nullable(),
})
export type MeMembership = z.infer<typeof MeMembershipSchema>

export const MeStoreSchema = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  state_code: z.string(),
  gstin: z.string().nullable(),
  is_active: z.boolean(),
})
export type MeStore = z.infer<typeof MeStoreSchema>

export const MeRegisterSchema = z.object({
  id: zId,
  store_id: zId,
  code: z.string(),
  name: z.string(),
  is_active: z.boolean(),
})
export type MeRegister = z.infer<typeof MeRegisterSchema>

export const MeDeviceSchema = z.object({
  id: zId,
  store_id: zId,
  register_id: zId.nullable(),
})
export type MeDevice = z.infer<typeof MeDeviceSchema>

/** GET /me */
export const MeResponseSchema = z.object({
  user: SessionUserSchema,
  tenant: MeTenantSchema,
  membership: MeMembershipSchema,
  entitlements: EntitlementsSchema,
  settings: TenantSettingsSchema,
  /** Stores the member can access. */
  stores: z.array(MeStoreSchema),
  registers: z.array(MeRegisterSchema),
  mode: DeploymentModeSchema,
  /** Present when the session is bound to a trusted device. */
  device: MeDeviceSchema.nullable().optional(),
  /** Server time, for offline clock-skew checks. */
  server_time: zTimestamp.optional(),
})
export type MeResponse = z.infer<typeof MeResponseSchema>

// ---------------------------------------------------------------------------------------------
// On-prem first-run setup
// ---------------------------------------------------------------------------------------------

/**
 * GET /setup/status — public deployment probe answered in both modes (the web reads `mode` before
 * sign-in). Cloud always reports `setup_required: false`; POST /setup exists on-prem only.
 */
export const SetupStatusResponseSchema = z.object({
  setup_required: z.boolean(),
  mode: DeploymentModeSchema,
  version: z.string(),
  /** A setup token (printed in the server console) must accompany POST /setup. */
  token_required: z.boolean().default(false),
})
export type SetupStatusResponse = z.infer<typeof SetupStatusResponseSchema>

/** POST /setup — creates the single tenant, owner, store S1 and register A; returns a session. */
export const SetupRequestSchema = z
  .object({
    ...BusinessFields,
    legal_name: z.string().trim().max(200).optional(),
    store_name: z.string().trim().min(1).max(200).optional(),
    setup_token: z.string().trim().min(8).max(200).optional(),
  })
  .superRefine(refineBusiness)
export type SetupRequest = z.infer<typeof SetupRequestSchema>

// ---------------------------------------------------------------------------------------------
// Route catalogue (docs/API.md "auth"; ARCHITECTURE.md §7.3, §7.4)
// ---------------------------------------------------------------------------------------------

export const authRoutes = defineRoutes({
  signup: {
    method: 'POST',
    path: '/auth/signup',
    auth: 'public',
    mode: 'cloud',
    body: SignupRequestSchema,
    response: dataOf(SessionResponseSchema),
    status: 201,
    summary: 'Create a business with its owner (cloud self-signup) and sign in',
  },
  login: {
    method: 'POST',
    path: '/auth/login',
    auth: 'public',
    body: LoginRequestSchema,
    response: dataOf(SessionResponseSchema),
    summary: 'Sign in with mobile number / email and password',
  },
  otpRequest: {
    method: 'POST',
    path: '/auth/otp/request',
    auth: 'public',
    body: OtpRequestSchema,
    response: dataOf(OtpRequestResponseSchema),
    summary: 'Send a one-time password by SMS',
  },
  otpVerify: {
    method: 'POST',
    path: '/auth/otp/verify',
    auth: 'public',
    body: OtpVerifyRequestSchema,
    response: dataOf(OtpVerifyResponseSchema),
    summary: 'Verify an OTP: a session (login) or an otp_token (signup / reset_password)',
  },
  passwordReset: {
    method: 'POST',
    path: '/auth/password/reset',
    auth: 'public',
    body: PasswordResetRequestSchema,
    summary: 'Set a new password with an otp_token (signs out every session)',
  },
  passwordChange: {
    method: 'POST',
    path: '/auth/password/change',
    body: PasswordChangeRequestSchema,
    summary: 'Change the password (signs out the other sessions)',
  },
  selectTenant: {
    method: 'POST',
    path: '/auth/select-tenant',
    body: SelectTenantRequestSchema,
    response: dataOf(SessionResponseSchema),
    summary: "Scope the session to one of the user's businesses",
  },
  refresh: {
    method: 'POST',
    path: '/auth/refresh',
    auth: 'public',
    body: RefreshRequestSchema.prefault({}),
    response: dataOf(SessionResponseSchema),
    summary: 'Rotate the refresh token (cookie or body) and get a new access token',
  },
  logout: {
    method: 'POST',
    path: '/auth/logout',
    body: LogoutRequestSchema.prefault({}),
    summary: 'Revoke this login (or every session with all: true)',
  },
  pinLogin: {
    method: 'POST',
    path: '/auth/pin-login',
    auth: 'public',
    body: PinLoginRequestSchema,
    response: dataOf(SessionResponseSchema),
    summary: 'PIN sign-in on a trusted counter device',
  },
  pinUsers: {
    method: 'GET',
    path: '/auth/pin-users',
    auth: 'public',
    query: PinUsersQuerySchema,
    response: dataOf(PinUsersResponseSchema),
    summary: 'Members who can PIN-login on a trusted device',
  },
  me: {
    method: 'GET',
    path: '/me',
    response: dataOf(MeResponseSchema),
    summary: 'Profile, membership, entitlements, settings, stores and registers',
  },
  setupStatus: {
    method: 'GET',
    path: '/setup/status',
    auth: 'public',
    response: dataOf(SetupStatusResponseSchema),
    summary: 'Deployment mode and on-prem first-run status (cloud: setup_required false)',
  },
  setup: {
    method: 'POST',
    path: '/setup',
    auth: 'public',
    mode: 'onprem',
    body: SetupRequestSchema,
    response: dataOf(SessionResponseSchema),
    status: 201,
    summary: 'On-prem first-run wizard: creates the business and its owner',
  },
})
