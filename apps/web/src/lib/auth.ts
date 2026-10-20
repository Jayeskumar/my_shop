/**
 * Auth/session store (ARCHITECTURE.md §7.4, §16): a tiny external store read with
 * useSyncExternalStore. Holds the session, GET /me (tenant, membership permissions, entitlements,
 * settings, stores, registers, mode), the deployment info, and the current store/register.
 *
 *  - bootstrap(): on app start, exchanges the refresh cookie for a session and loads /me, while
 *    probing GET /setup/status to learn the deployment mode (404 = cloud).
 *  - Offline boot: when the server cannot be reached at start-up but this device has a snapshot
 *    of the last /me, the app opens in `offline` mode (POS keeps billing into the outbox); the
 *    session is re-validated as soon as the server is reachable again.
 *  - The access token itself lives in lib/api.ts (memory only).
 */
import { useSyncExternalStore } from 'react'
import {
  MeResponseSchema,
  SetupStatusResponseSchema,
  type MeRegister,
  type MeResponse,
  type MeStore,
  type SessionResponse,
} from '@kadai/shared/api/auth'
import type { DeploymentMode } from '@kadai/shared/enums'
import { hasFeature as entitlementHasFeature, type Feature } from '@kadai/shared/features'
import { expandPermissions, hasPermission, type Permission } from '@kadai/shared/permissions'
import {
  api,
  clearSession,
  isApiError,
  onAuthEvent,
  refreshSession,
  setSession,
} from './api'
import { getSavedLanguage, setLanguage } from './i18n'
import { storage, isRecord } from './storage'

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type AuthStatus =
  /** Restoring the session on app start. */
  | 'booting'
  | 'unauthenticated'
  /** Signed in with a tenant-less token: pick a business (/select-business). */
  | 'needs_tenant'
  | 'authenticated'

export interface DeploymentInfo {
  /** null until known (server unreachable and nothing cached). */
  mode: DeploymentMode | null
  setupRequired: boolean
  setupTokenRequired: boolean
  version: string | null
}

export interface StoreSelection {
  storeId: string | null
  registerId: string | null
}

export interface AuthState {
  status: AuthStatus
  session: SessionResponse | null
  me: MeResponse | null
  /** Effective permissions of the current membership. */
  permissions: ReadonlySet<Permission>
  features: ReadonlySet<Feature>
  deployment: DeploymentInfo
  selection: StoreSelection
  /** Opened from the device snapshot because the server was unreachable at start-up. */
  offline: boolean
}

/** Trusted-device credentials (POST /devices returns the secret once; §7.4). */
export interface DeviceCredentials {
  device_id: string
  device_secret: string
  tenant_id: string
  store_id: string
  register_id: string | null
  name: string
  registered_at: string
}

const EMPTY_PERMISSIONS: ReadonlySet<Permission> = new Set()
const EMPTY_FEATURES: ReadonlySet<Feature> = new Set()

const initialState = (): AuthState => ({
  status: 'booting',
  session: null,
  me: null,
  permissions: EMPTY_PERMISSIONS,
  features: EMPTY_FEATURES,
  deployment: storage.get<DeploymentInfo>(
    'deployment',
    { mode: null, setupRequired: false, setupTokenRequired: false, version: null },
    isDeploymentInfo,
  ),
  selection: { storeId: null, registerId: null },
  offline: false,
})

function isDeploymentInfo(v: unknown): v is DeploymentInfo {
  return isRecord(v) && (v.mode === 'cloud' || v.mode === 'onprem' || v.mode === null)
}

// ---------------------------------------------------------------------------------------------
// Store plumbing
// ---------------------------------------------------------------------------------------------

let state: AuthState = initialState()
const listeners = new Set<() => void>()

export type AuthLifecycleEvent = 'signed_in' | 'tenant_changed' | 'signed_out'
const lifecycleListeners = new Set<(event: AuthLifecycleEvent) => void>()

function setState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

function emitLifecycle(event: AuthLifecycleEvent): void {
  for (const l of [...lifecycleListeners]) l(event)
}

export const authStore = {
  getState: (): AuthState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/**
 * Called on sign-in, business switch and sign-out (the query client clears its cache, the POS
 * drops tenant caches). Returns an unsubscribe function.
 */
export function onAuthLifecycle(listener: (event: AuthLifecycleEvent) => void): () => void {
  lifecycleListeners.add(listener)
  return () => lifecycleListeners.delete(listener)
}

// ---------------------------------------------------------------------------------------------
// Device snapshot (offline boot) & selection persistence
// ---------------------------------------------------------------------------------------------

const SNAPSHOT_KEY = 'session.snapshot'

interface Snapshot {
  me: MeResponse
  saved_at: string
}

function saveSnapshot(me: MeResponse): void {
  storage.set(SNAPSHOT_KEY, { me, saved_at: new Date().toISOString() } satisfies Snapshot)
}

function loadSnapshot(): MeResponse | null {
  const raw = storage.get<unknown>(SNAPSHOT_KEY, null)
  if (!isRecord(raw)) return null
  const parsed = MeResponseSchema.safeParse(raw.me)
  return parsed.success ? parsed.data : null
}

function clearSnapshot(): void {
  storage.remove(SNAPSHOT_KEY)
}

const selectionKey = (tenantId: string): string => `selection.${tenantId}`

function isSelection(v: unknown): v is StoreSelection {
  return (
    isRecord(v) &&
    (v.storeId === null || typeof v.storeId === 'string') &&
    (v.registerId === null || typeof v.registerId === 'string')
  )
}

function activeRegistersOf(me: MeResponse, storeId: string | null): MeRegister[] {
  return me.registers.filter((r) => r.is_active && r.store_id === storeId)
}

/**
 * Store/register for this session: a device-bound session uses the device's register; otherwise
 * the saved choice when still valid, else the first active store and its first active register.
 */
export function resolveSelection(me: MeResponse, saved: StoreSelection | null): StoreSelection {
  if (me.device) {
    return { storeId: me.device.store_id, registerId: me.device.register_id }
  }
  const activeStores = me.stores.filter((s) => s.is_active)
  const store =
    activeStores.find((s) => s.id === saved?.storeId) ?? activeStores[0] ?? me.stores[0] ?? null
  const storeId = store?.id ?? null
  const registers = activeRegistersOf(me, storeId)
  const register = registers.find((r) => r.id === saved?.registerId) ?? registers[0] ?? null
  return { storeId, registerId: register?.id ?? null }
}

// ---------------------------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------------------------

function applyMe(me: MeResponse, options: { offline?: boolean } = {}): void {
  const saved = storage.get<StoreSelection | null>(
    selectionKey(me.tenant.id),
    null,
    (v): v is StoreSelection | null => v === null || isSelection(v),
  )
  const selection = resolveSelection(me, saved)
  const deployment: DeploymentInfo = { ...state.deployment, mode: me.mode }
  storage.set('deployment', deployment)
  setState({
    status: 'authenticated',
    me,
    permissions: expandPermissions(me.membership.permissions),
    features: new Set(me.entitlements.features),
    selection,
    deployment,
    offline: options.offline ?? false,
  })
}

function adoptPreferredLanguage(session: SessionResponse): void {
  // A choice made on this device wins; otherwise follow the user's profile language.
  if (getSavedLanguage() === null) void setLanguage(session.user.preferred_locale, { persist: false })
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/** GET /me and apply it. Throws ApiError (callers decide whether that is fatal). */
export async function reloadMe(): Promise<MeResponse> {
  const body = await api.get<{ data: unknown }>('/me')
  const parsed = MeResponseSchema.safeParse(body.data)
  if (!parsed.success) {
    console.error('GET /me does not match MeResponseSchema', parsed.error)
  }
  const me = parsed.success ? parsed.data : (body.data as MeResponse)
  saveSnapshot(me)
  applyMe(me)
  return me
}

/**
 * Installs a session returned by login / OTP / signup / setup / select-tenant / PIN login and
 * loads the profile. Resolves to the resulting status.
 */
export async function acceptSession(session: SessionResponse): Promise<AuthStatus> {
  const previousTenant = state.me?.tenant.id ?? null
  setSession(session)
  setState({ session, offline: false })
  adoptPreferredLanguage(session)

  if (session.tenant_id) {
    await reloadMe()
    emitLifecycle(previousTenant && previousTenant !== session.tenant_id ? 'tenant_changed' : 'signed_in')
    return state.status
  }
  const memberships = session.memberships
  if (memberships.length === 1 && memberships[0]) {
    return selectTenant(memberships[0].tenant_id)
  }
  if (memberships.length === 0 && session.user.is_platform_admin) {
    setState({
      status: 'authenticated',
      me: null,
      permissions: EMPTY_PERMISSIONS,
      features: EMPTY_FEATURES,
      selection: { storeId: null, registerId: null },
    })
    emitLifecycle('signed_in')
    return state.status
  }
  setState({ status: 'needs_tenant', me: null, permissions: EMPTY_PERMISSIONS, features: EMPTY_FEATURES })
  return state.status
}

/** POST /auth/login with a mobile number / email and password. */
export async function login(input: { identifier: string; password: string }): Promise<AuthStatus> {
  const body = await api.post<{ data: SessionResponse }>('/auth/login', input, { auth: false })
  return acceptSession(body.data)
}

/** POST /auth/select-tenant → session scoped to that business. */
export async function selectTenant(tenantId: string): Promise<AuthStatus> {
  const body = await api.post<{ data: SessionResponse }>('/auth/select-tenant', {
    tenant_id: tenantId,
  })
  return acceptSession(body.data)
}

/** PIN switch on a trusted device (POST /auth/pin-login). */
export async function pinLogin(input: { user_id: string; pin: string }): Promise<AuthStatus> {
  const device = getDeviceCredentials()
  if (!device) throw new Error('This browser is not registered as a trusted device')
  const body = await api.post<{ data: SessionResponse }>(
    '/auth/pin-login',
    {
      device_id: device.device_id,
      device_secret: device.device_secret,
      user_id: input.user_id,
      pin: input.pin,
    },
    { auth: false },
  )
  return acceptSession(body.data)
}

async function clearOfflineCaches(): Promise<void> {
  // The POS bootstrap response is cached by the service worker (vite.config.ts); it holds
  // tenant data and must not outlive the session on a shared PC.
  try {
    if (typeof caches !== 'undefined') await caches.delete('kadai-pos-bootstrap')
  } catch {
    // Cache Storage unavailable
  }
}

function resetToSignedOut(): void {
  clearSnapshot()
  setState({
    status: 'unauthenticated',
    session: null,
    me: null,
    permissions: EMPTY_PERMISSIONS,
    features: EMPTY_FEATURES,
    selection: { storeId: null, registerId: null },
    offline: false,
  })
  void clearOfflineCaches()
  emitLifecycle('signed_out')
}

/** POST /auth/logout (best effort: the local session is cleared even when offline). */
export async function logout(options: { all?: boolean } = {}): Promise<void> {
  try {
    await api.post('/auth/logout', { all: options.all ?? false }, { timeoutMs: 8_000 })
  } catch {
    // offline or already revoked — the local sign-out still happens
  }
  clearSession()
  resetToSignedOut()
}

let bootPromise: Promise<void> | null = null

/** Restores the session on app start (idempotent). */
export function bootstrap(): Promise<void> {
  bootPromise ??= runBootstrap()
  return bootPromise
}

/** GET /setup/status: 200 → on-prem (maybe needing setup), 404 → cloud. */
export async function probeDeployment(): Promise<DeploymentInfo> {
  try {
    const body = await api.get<{ data: unknown }>('/setup/status', { auth: false, timeoutMs: 10_000 })
    const parsed = SetupStatusResponseSchema.safeParse(body.data)
    const info: DeploymentInfo = parsed.success
      ? {
          mode: parsed.data.mode,
          setupRequired: parsed.data.setup_required,
          setupTokenRequired: parsed.data.token_required,
          version: parsed.data.version,
        }
      : { ...state.deployment }
    storage.set('deployment', info)
    setState({ deployment: info })
    return info
  } catch (error) {
    if (isApiError(error) && error.status === 404) {
      const info: DeploymentInfo = {
        mode: 'cloud',
        setupRequired: false,
        setupTokenRequired: false,
        version: state.deployment.version,
      }
      storage.set('deployment', info)
      setState({ deployment: info })
      return info
    }
    return state.deployment // unreachable: keep the cached value
  }
}

async function runBootstrap(): Promise<void> {
  const deployment = probeDeployment()
  try {
    const session = await refreshSession()
    if (!session) {
      resetToSignedOut()
    } else {
      await acceptSession(session)
    }
  } catch (error) {
    // No response from the server: open from the device snapshot when there is one.
    const snapshot = isApiError(error) && error.isNetworkError ? loadSnapshot() : null
    if (snapshot) {
      applyMe(snapshot, { offline: true })
    } else if (isApiError(error) && !error.isNetworkError) {
      // /me failed with an HTTP error (e.g. 403 TENANT_SUSPENDED is handled by the shell).
      setState({ status: state.session ? 'needs_tenant' : 'unauthenticated' })
    } else {
      setState({ status: 'unauthenticated' })
    }
  }
  await deployment
}

/**
 * After an offline boot, re-validate the session once the server answers again.
 * Called by the shell when connectivity returns.
 */
export async function revalidateOfflineSession(): Promise<void> {
  if (!state.offline) return
  try {
    const session = await refreshSession()
    if (!session) {
      resetToSignedOut()
      return
    }
    await acceptSession(session)
  } catch {
    // still unreachable
  }
}

export function selectStore(storeId: string): void {
  const me = state.me
  if (!me || me.device) return
  const store = me.stores.find((s) => s.id === storeId)
  if (!store) return
  const register = activeRegistersOf(me, storeId)[0] ?? null
  const selection = { storeId, registerId: register?.id ?? null }
  storage.set(selectionKey(me.tenant.id), selection)
  setState({ selection })
}

export function selectRegister(registerId: string | null): void {
  const me = state.me
  if (!me || me.device) return
  if (registerId !== null) {
    const register = me.registers.find((r) => r.id === registerId)
    if (!register) return
    const selection = { storeId: register.store_id, registerId }
    storage.set(selectionKey(me.tenant.id), selection)
    setState({ selection })
    return
  }
  const selection = { storeId: state.selection.storeId, registerId: null }
  storage.set(selectionKey(me.tenant.id), selection)
  setState({ selection })
}

// ---------------------------------------------------------------------------------------------
// Queries (non-React)
// ---------------------------------------------------------------------------------------------

/** Permission check (any-of for arrays), from the current membership. */
export function can(permission: Permission | readonly Permission[]): boolean {
  return hasPermission(state.permissions, permission)
}

/** Plan / licence feature check. */
export function hasFeature(feature: Feature): boolean {
  return state.me ? entitlementHasFeature(state.me.entitlements, feature) : false
}

export function getCurrentStore(): MeStore | null {
  return state.me?.stores.find((s) => s.id === state.selection.storeId) ?? null
}

export function getCurrentRegister(): MeRegister | null {
  return state.me?.registers.find((r) => r.id === state.selection.registerId) ?? null
}

// ---------------------------------------------------------------------------------------------
// Device credentials (trusted counters)
// ---------------------------------------------------------------------------------------------

const DEVICE_KEY = 'device'

function isDeviceCredentials(v: unknown): v is DeviceCredentials {
  return (
    isRecord(v) &&
    typeof v.device_id === 'string' &&
    typeof v.device_secret === 'string' &&
    typeof v.tenant_id === 'string' &&
    typeof v.store_id === 'string' &&
    (v.register_id === null || typeof v.register_id === 'string') &&
    typeof v.name === 'string'
  )
}

export function getDeviceCredentials(): DeviceCredentials | null {
  return storage.get<DeviceCredentials | null>(
    DEVICE_KEY,
    null,
    (v): v is DeviceCredentials | null => v === null || isDeviceCredentials(v),
  )
}

export function saveDeviceCredentials(credentials: DeviceCredentials): void {
  storage.set(DEVICE_KEY, credentials)
}

export function clearDeviceCredentials(): void {
  storage.remove(DEVICE_KEY)
}

// ---------------------------------------------------------------------------------------------
// Session events from the API client (refresh / other tabs / revocation)
// ---------------------------------------------------------------------------------------------

let apiSubscription: (() => void) | null = null

function handleApiAuthEvent(event: Parameters<Parameters<typeof onAuthEvent>[0]>[0]): void {
  if (event.type === 'unauthenticated') {
    if (state.status === 'unauthenticated' || state.status === 'booting') return
    resetToSignedOut()
    return
  }
  const previousTenant = state.session?.tenant_id ?? null
  setState({ session: event.session, offline: false })
  if (event.source === 'broadcast' && event.session.tenant_id !== previousTenant) {
    // Another tab switched business (the refresh cookie is shared): follow it.
    if (event.session.tenant_id) {
      void reloadMe()
        .then(() => emitLifecycle('tenant_changed'))
        .catch(() => undefined)
    } else {
      setState({ status: 'needs_tenant', me: null })
    }
  } else if (event.source === 'broadcast' && state.status === 'unauthenticated') {
    // Signed in from another tab.
    void acceptSession(event.session).catch(() => undefined)
  }
}

/** Connects the store to the API client's session events (done once at start-up). */
export function connectAuthEvents(): void {
  apiSubscription ??= onAuthEvent(handleApiAuthEvent)
}
connectAuthEvents()

// ---------------------------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------------------------

/**
 * Subscribes to a slice of the auth state. The selector must return a stable value (a field of
 * the state or a primitive) — never build a new object/array inside it.
 */
export function useAuth<T>(selector: (s: AuthState) => T): T {
  return useSyncExternalStore(
    authStore.subscribe,
    () => selector(state),
    () => selector(state),
  )
}

export function useAuthState(): AuthState {
  return useAuth((s) => s)
}

export function useMe(): MeResponse | null {
  return useAuth((s) => s.me)
}

export function useCan(permission: Permission | readonly Permission[]): boolean {
  const permissions = useAuth((s) => s.permissions)
  return hasPermission(permissions, permission)
}

export function useFeature(feature: Feature): boolean {
  const features = useAuth((s) => s.features)
  return features.has(feature)
}

export function useDeployment(): DeploymentInfo {
  return useAuth((s) => s.deployment)
}

export function useCurrentStore(): MeStore | null {
  const me = useAuth((s) => s.me)
  const storeId = useAuth((s) => s.selection.storeId)
  return me?.stores.find((s) => s.id === storeId) ?? null
}

export function useCurrentRegister(): MeRegister | null {
  const me = useAuth((s) => s.me)
  const registerId = useAuth((s) => s.selection.registerId)
  return me?.registers.find((r) => r.id === registerId) ?? null
}

/** Test helper: back to the initial (booting) state. */
export function _resetAuthForTests(): void {
  state = initialState()
  bootPromise = null
  lifecycleListeners.clear()
  for (const l of [...listeners]) l()
  apiSubscription?.()
  apiSubscription = null
  connectAuthEvents()
}
