/**
 * Auth API calls (docs/API.md "auth"), typed with the shared contract schemas. Session-creating
 * calls return the SessionResponse; feed it to `acceptSession()` from lib/auth.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  OtpRequest,
  OtpRequestResponse,
  OtpVerifyRequest,
  OtpVerifyResponse,
  PasswordChangeRequest,
  PasswordResetRequest,
  PinUser,
  SessionResponse,
  SetupRequest,
  SetupStatusResponse,
  SignupRequest,
} from '@kadai/shared/api/auth'
import { SetupStatusResponseSchema } from '@kadai/shared/api/auth'
import { api, type Envelope } from '@/lib/api'
import { getDeviceCredentials } from '@/lib/auth'

export const authKeys = {
  setupStatus: ['auth', 'setup-status'] as const,
  pinUsers: (deviceId: string) => ['auth', 'pin-users', deviceId] as const,
}

export function isSessionResponse(value: OtpVerifyResponse): value is SessionResponse {
  return 'access_token' in value
}

export const authApi = {
  async requestOtp(body: OtpRequest): Promise<OtpRequestResponse> {
    const res = await api.post<Envelope<OtpRequestResponse>>('/auth/otp/request', body, {
      auth: false,
    })
    return res.data
  },
  async verifyOtp(body: OtpVerifyRequest): Promise<OtpVerifyResponse> {
    const res = await api.post<Envelope<OtpVerifyResponse>>('/auth/otp/verify', body, {
      auth: false,
    })
    return res.data
  },
  async resetPassword(body: PasswordResetRequest): Promise<void> {
    await api.post('/auth/password/reset', body, { auth: false })
  },
  async changePassword(body: PasswordChangeRequest): Promise<void> {
    await api.post('/auth/password/change', body)
  },
  async signup(body: SignupRequest): Promise<SessionResponse> {
    const res = await api.post<Envelope<SessionResponse>>('/auth/signup', body, { auth: false })
    return res.data
  },
  /** Deployment probe: cloud answers `{mode: 'cloud', setup_required: false}` (older servers 404). */
  async setupStatus(): Promise<SetupStatusResponse> {
    const res = await api.get<Envelope<unknown>>('/setup/status', { auth: false })
    return SetupStatusResponseSchema.parse(res.data)
  },
  async setup(body: SetupRequest): Promise<SessionResponse> {
    const res = await api.post<Envelope<SessionResponse>>('/setup', body, { auth: false })
    return res.data
  },
  /** Cashiers who can PIN-login on this trusted device. */
  async pinUsers(): Promise<PinUser[]> {
    const device = getDeviceCredentials()
    if (!device) return []
    const res = await api.get<Envelope<PinUser[]>>('/auth/pin-users', {
      auth: false,
      query: { device_id: device.device_id, device_secret: device.device_secret },
    })
    return res.data
  },
}

export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: authKeys.setupStatus,
    queryFn: () => authApi.setupStatus(),
    enabled,
    retry: false,
    staleTime: 0,
    meta: { errorToast: false },
  })
}

export function usePinUsers(enabled: boolean) {
  const device = getDeviceCredentials()
  return useQuery({
    queryKey: authKeys.pinUsers(device?.device_id ?? 'none'),
    queryFn: () => authApi.pinUsers(),
    enabled: enabled && device !== null,
    staleTime: 60_000,
    meta: { errorToast: false },
  })
}

export function useChangePassword() {
  return useMutation({ mutationFn: (body: PasswordChangeRequest) => authApi.changePassword(body) })
}
