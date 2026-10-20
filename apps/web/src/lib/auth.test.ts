import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { LoginRequestSchema, MeResponseSchema } from '@kadai/shared/api/auth'
import { IDS, makeMe, makeSession, testMembership } from '@/test/fixtures'
import { apiPath, errorResponse, ORIGIN, server } from '@/test/msw'
import { getAccessToken } from './api'
import {
  acceptSession,
  authStore,
  bootstrap,
  can,
  getCurrentRegister,
  getCurrentStore,
  hasFeature,
  login,
  logout,
  onAuthLifecycle,
  resolveSelection,
  saveDeviceCredentials,
  selectRegister,
  selectStore,
  selectTenant,
  pinLogin,
} from './auth'
import { getLanguage, setLanguage } from './i18n'
import { storage } from './storage'

const meHandler = (me = makeMe()) => http.get(apiPath('/me'), () => HttpResponse.json({ data: me }))

describe('fixtures', () => {
  it('/me fixture satisfies the shared contract', () => {
    expect(MeResponseSchema.safeParse(makeMe()).success).toBe(true)
  })
})

describe('bootstrap', () => {
  it('ends signed out when there is no refresh cookie, and learns cloud mode from the setup probe', async () => {
    await bootstrap()
    const s = authStore.getState()
    expect(s.status).toBe('unauthenticated')
    expect(s.deployment.mode).toBe('cloud')
    expect(s.deployment.version).toBe('0.1.0')
    expect(storage.get('deployment', null)).toMatchObject({ mode: 'cloud' })
  })

  it('still reads a 404 setup probe (older servers) as cloud', async () => {
    server.use(http.get(apiPath('/setup/status'), () => errorResponse(404, 'NOT_FOUND')))
    await bootstrap()
    expect(authStore.getState().deployment.mode).toBe('cloud')
  })

  it('detects an on-prem server that still needs setup', async () => {
    server.use(
      http.get(apiPath('/setup/status'), () =>
        HttpResponse.json({
          data: { setup_required: true, mode: 'onprem', version: '1.0.0', token_required: true },
        }),
      ),
    )
    await bootstrap()
    expect(authStore.getState().deployment).toEqual({
      mode: 'onprem',
      setupRequired: true,
      setupTokenRequired: true,
      version: '1.0.0',
    })
  })

  it('restores the session from the refresh cookie and loads /me', async () => {
    server.use(
      http.post(apiPath('/auth/refresh'), () =>
        HttpResponse.json({ data: makeSession({ access_token: 'restored' }) }),
      ),
      meHandler(),
    )
    await bootstrap()
    const s = authStore.getState()
    expect(s.status).toBe('authenticated')
    expect(s.me?.tenant.name).toBe('Sri Murugan Stores')
    expect(getAccessToken()).toBe('restored')
  })

  it('opens offline from the device snapshot when the server is unreachable', async () => {
    server.use(
      http.post(apiPath('/auth/refresh'), () => HttpResponse.json({ data: makeSession() })),
      meHandler(),
    )
    await bootstrap()
    expect(authStore.getState().status).toBe('authenticated')

    // Next start: server down.
    const { _resetAuthForTests } = await import('./auth')
    _resetAuthForTests()
    server.use(http.post(apiPath('/auth/refresh'), () => HttpResponse.error()))
    await bootstrap()
    const s = authStore.getState()
    expect(s.status).toBe('authenticated')
    expect(s.offline).toBe(true)
    expect(s.me?.tenant.id).toBe(IDS.tenant)
  })
})

describe('login', () => {
  it('signs in, loads permissions/features, picks the first store and counter', async () => {
    let body: unknown = null
    server.use(
      http.post(apiPath('/auth/login'), async ({ request }) => {
        body = await request.json()
        expect(LoginRequestSchema.safeParse(body).success).toBe(true)
        return HttpResponse.json({ data: makeSession() })
      }),
      meHandler(makeMe({ permissions: ['sales.read', 'pos.use'], features: ['pos', 'catalog'] })),
    )
    const status = await login({ identifier: '+919876543210', password: 'secret-password' })
    expect(status).toBe('authenticated')
    expect(body).toEqual({ identifier: '+919876543210', password: 'secret-password' })
    expect(can('sales.read')).toBe(true)
    expect(can('sales.cancel')).toBe(false)
    expect(can(['sales.cancel', 'pos.use'])).toBe(true)
    expect(hasFeature('pos')).toBe(true)
    expect(hasFeature('purchases')).toBe(false)
    expect(getCurrentStore()?.id).toBe(IDS.store)
    expect(getCurrentRegister()?.id).toBe(IDS.register)
  })

  it('asks to choose a business when the token is tenant-less with several memberships', async () => {
    const memberships = [
      testMembership,
      {
        ...testMembership,
        tenant_id: IDS.tenant2,
        tenant_name: 'Lakshmi Medicals',
        business_type: 'pharmacy' as const,
      },
    ]
    server.use(
      http.post(apiPath('/auth/login'), () =>
        HttpResponse.json({ data: makeSession({ tenant_id: null, memberships }) }),
      ),
      http.post(apiPath('/auth/select-tenant'), async ({ request }) => {
        const { tenant_id } = (await request.json()) as { tenant_id: string }
        return HttpResponse.json({ data: makeSession({ tenant_id, memberships }) })
      }),
      meHandler(makeMe({ tenantId: IDS.tenant2, businessType: 'pharmacy' })),
    )
    expect(await login({ identifier: 'x@example.com', password: 'secret-password' })).toBe(
      'needs_tenant',
    )
    const events: string[] = []
    onAuthLifecycle((e) => events.push(e))
    expect(await selectTenant(IDS.tenant2)).toBe('authenticated')
    expect(authStore.getState().me?.tenant.business_type).toBe('pharmacy')
    expect(events).toEqual(['signed_in'])
  })

  it('auto-selects the only business of a tenant-less session', async () => {
    let selected: string | null = null
    server.use(
      http.post(apiPath('/auth/select-tenant'), async ({ request }) => {
        selected = ((await request.json()) as { tenant_id: string }).tenant_id
        return HttpResponse.json({ data: makeSession() })
      }),
      meHandler(),
    )
    expect(await acceptSession(makeSession({ tenant_id: null }))).toBe('authenticated')
    expect(selected).toBe(IDS.tenant)
  })

  it('propagates INVALID_CREDENTIALS without touching the session', async () => {
    server.use(http.post(apiPath('/auth/login'), () => errorResponse(401, 'INVALID_CREDENTIALS')))
    await expect(login({ identifier: '9876543210', password: 'wrong' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
    expect(authStore.getState().session).toBeNull()
  })

  it("adopts the user's preferred language unless the device has a saved choice", async () => {
    server.use(meHandler())
    await acceptSession(makeSession({ user: { ...makeSession().user, preferred_locale: 'ta' } }))
    expect(getLanguage()).toBe('ta')

    await setLanguage('en') // explicit device choice
    await acceptSession(makeSession())
    expect(getLanguage()).toBe('en')
  })
})

describe('logout', () => {
  it('revokes on the server, clears state and caches, and emits signed_out', async () => {
    const logoutBody = vi.fn()
    server.use(
      meHandler(),
      http.post(apiPath('/auth/logout'), async ({ request }) => {
        logoutBody(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await acceptSession(makeSession())
    const events: string[] = []
    onAuthLifecycle((e) => events.push(e))
    await logout({ all: true })
    expect(logoutBody).toHaveBeenCalledWith({ all: true })
    expect(authStore.getState().status).toBe('unauthenticated')
    expect(authStore.getState().me).toBeNull()
    expect(getAccessToken()).toBeNull()
    expect(storage.get('session.snapshot', null)).toBeNull()
    expect(events).toEqual(['signed_out'])
  })

  it('does not ask the server for a refresh on the next start after signing out', async () => {
    const refreshes = vi.fn()
    server.use(
      meHandler(),
      http.post(apiPath('/auth/refresh'), () => {
        refreshes()
        return HttpResponse.json({ data: makeSession() })
      }),
    )
    await acceptSession(makeSession())
    await logout()

    // Next start of the app (reload): known signed out → no POST /auth/refresh (and no 401).
    const { _resetAuthForTests } = await import('./auth')
    _resetAuthForTests()
    await bootstrap()
    expect(refreshes).not.toHaveBeenCalled()
    expect(authStore.getState().status).toBe('unauthenticated')

    // Signing in again restores the normal restore-on-start behaviour.
    await acceptSession(makeSession())
    _resetAuthForTests()
    await bootstrap()
    expect(refreshes).toHaveBeenCalledTimes(1)
    expect(authStore.getState().status).toBe('authenticated')
  })

  it('still signs out locally when the server is unreachable', async () => {
    server.use(
      meHandler(),
      http.post(apiPath('/auth/logout'), () => HttpResponse.error()),
    )
    await acceptSession(makeSession())
    await logout()
    expect(authStore.getState().status).toBe('unauthenticated')
  })
})

describe('store / counter selection', () => {
  it('persists the choice per business and restores it on the next sign-in', async () => {
    server.use(meHandler())
    await acceptSession(makeSession())
    selectStore(IDS.store2)
    expect(authStore.getState().selection).toEqual({
      storeId: IDS.store2,
      registerId: IDS.register2,
    })

    await acceptSession(makeSession())
    expect(authStore.getState().selection.storeId).toBe(IDS.store2)

    selectRegister(null)
    expect(authStore.getState().selection).toEqual({ storeId: IDS.store2, registerId: null })
  })

  it('uses the device register for device-bound sessions', () => {
    const me = makeMe({
      device: { id: IDS.device, store_id: IDS.store2, register_id: IDS.register2 },
    })
    expect(resolveSelection(me, { storeId: IDS.store, registerId: IDS.register })).toEqual({
      storeId: IDS.store2,
      registerId: IDS.register2,
    })
  })

  it('falls back to the first active store when the saved one is gone', () => {
    const me = makeMe()
    expect(resolveSelection(me, { storeId: 'gone', registerId: 'gone' })).toEqual({
      storeId: IDS.store,
      registerId: IDS.register,
    })
  })
})

describe('PIN login', () => {
  it('sends the trusted device credentials with the PIN', async () => {
    saveDeviceCredentials({
      device_id: IDS.device,
      device_secret: 'device-secret-0123456789',
      tenant_id: IDS.tenant,
      store_id: IDS.store,
      register_id: IDS.register,
      name: 'Counter A PC',
      registered_at: '2026-10-01T10:00:00.000Z',
    })
    let body: unknown = null
    server.use(
      http.post(`${ORIGIN}/api/v1/auth/pin-login`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ data: makeSession() })
      }),
      meHandler(),
    )
    expect(await pinLogin({ user_id: IDS.cashier, pin: '4321' })).toBe('authenticated')
    expect(body).toEqual({
      device_id: IDS.device,
      device_secret: 'device-secret-0123456789',
      user_id: IDS.cashier,
      pin: '4321',
    })
  })

  it('refuses without device credentials', async () => {
    await expect(pinLogin({ user_id: IDS.cashier, pin: '1234' })).rejects.toThrow(/trusted device/)
  })
})
