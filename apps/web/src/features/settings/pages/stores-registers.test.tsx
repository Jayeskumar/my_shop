import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DeviceCreateSchema, StoreCreateSchema, identityRoutes } from '@kadai/shared/api/identity'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { getDeviceCredentials, saveDeviceCredentials } from '@/lib/auth'
import { IDS, makeMe } from '@/test/fixtures'
import { errorResponse, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { device, page, register, store } from '../testing/fixtures'
import { onRoute, type RecordedRequest } from '../testing/handlers'

/** /me on a plan with several stores (multi_store, up to 5). */
function multiStoreMe() {
  const me = makeMe({ features: [...DEFAULT_PLAN_FEATURES.growth, 'multi_store'] })
  return {
    ...me,
    entitlements: { ...me.entitlements, limits: { ...me.entitlements.limits, stores: 5 } },
  }
}

describe('stores', () => {
  it('adds a store with the contract body', async () => {
    const user = userEvent.setup()
    const calls: RecordedRequest[] = []
    server.use(
      onRoute(identityRoutes.listStores, { data: [store()], page: page(1, 200) }),
      onRoute(
        identityRoutes.createStore,
        { data: store({ id: IDS.store2, code: 'S2', name: 'Anna Nagar' }) },
        calls,
      ),
    )
    await signIn(multiStoreMe())
    renderApp('/settings/stores')
    expect(await screen.findByText('Main store')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add store' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Store code/), 's2')
    await user.type(within(dialog).getByLabelText(/^Store name\*?$/), 'Anna Nagar')
    await user.type(within(dialog).getByLabelText(/^Town/), 'Chennai')
    await user.type(within(dialog).getByLabelText(/^FSSAI/), '12423012000123')
    await user.click(within(dialog).getByRole('button', { name: 'Add store' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({
      code: 'S2',
      name: 'Anna Nagar',
      name_ta: null,
      gstin: null,
      state_code: '33',
      phone: null,
      email: null,
      address: { city: 'Chennai', state_code: '33' },
      fssai_number: '12423012000123',
    })
    expect(StoreCreateSchema.safeParse(calls[0]!.body).success).toBe(true)
  })

  it('explains the plan limit instead of failing on save', async () => {
    server.use(onRoute(identityRoutes.listStores, { data: [store()], page: page(1, 200) }))
    await signIn(
      makeMe({ features: [...DEFAULT_PLAN_FEATURES.growth].filter((f) => f !== 'multi_store') }),
    )
    renderApp('/settings/stores')
    expect(await screen.findByText(/is not in your current plan/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add store' })).toBeDisabled()
  })

  it('shows an upgrade hint when the server answers 402', async () => {
    const user = userEvent.setup()
    server.use(
      onRoute(identityRoutes.listStores, { data: [store()], page: page(1, 200) }),
      onRoute(
        identityRoutes.createStore,
        errorResponse(402, 'PLAN_LIMIT_REACHED', 'limit', {
          metric: 'stores',
          limit: 1,
          current: 1,
          plan: 'growth',
        }),
      ),
    )
    await signIn(multiStoreMe())
    renderApp('/settings/stores')
    await user.click(await screen.findByRole('button', { name: 'Add store' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Store code/), 'S2')
    await user.type(within(dialog).getByLabelText(/^Store name\*?$/), 'Second')
    await user.click(within(dialog).getByRole('button', { name: 'Add store' }))
    expect(await within(dialog).findByText('Stores: your plan allows up to 1')).toBeInTheDocument()
  })
})

describe('counters & devices', () => {
  it('registers this computer as a counter and keeps the secret in this browser', async () => {
    const user = userEvent.setup()
    const calls: RecordedRequest[] = []
    server.use(
      onRoute(identityRoutes.listRegisters, { data: [register()], page: page(1, 200) }),
      onRoute(identityRoutes.listDevices, { data: [], page: page(0) }),
      onRoute(
        identityRoutes.createDevice,
        { data: { device: device(), device_secret: 'secret-0123456789abcdef' } },
        calls,
      ),
    )
    await signIn()
    renderApp('/settings/registers')
    await user.click(await screen.findByRole('button', { name: 'Register this computer' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText(/^Name of this computer/)).toHaveValue('Counter A PC')
    await user.click(within(dialog).getByRole('button', { name: 'Register this computer' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({
      name: 'Counter A PC',
      store_id: IDS.store,
      register_id: IDS.register,
    })
    expect(DeviceCreateSchema.safeParse(calls[0]!.body).success).toBe(true)
    expect(
      await screen.findByText('This computer now bills as Counter A at Main store'),
    ).toBeInTheDocument()
    expect(getDeviceCredentials()).toMatchObject({
      device_id: IDS.device,
      device_secret: 'secret-0123456789abcdef',
      tenant_id: IDS.tenant,
      store_id: IDS.store,
      register_id: IDS.register,
    })
  })

  it('revokes a device after confirmation and forgets it when it is this computer', async () => {
    const user = userEvent.setup()
    saveDeviceCredentials({
      device_id: IDS.device,
      device_secret: 'secret-0123456789abcdef',
      tenant_id: IDS.tenant,
      store_id: IDS.store,
      register_id: IDS.register,
      name: 'Counter A PC',
      registered_at: '2026-10-01T10:00:00.000Z',
    })
    const calls: RecordedRequest[] = []
    server.use(
      onRoute(identityRoutes.listRegisters, { data: [register()], page: page(1, 200) }),
      onRoute(identityRoutes.listDevices, { data: [device()], page: page(1) }),
      onRoute(
        identityRoutes.revokeDevice,
        { data: device({ status: 'revoked', revoked_at: '2026-10-20T10:00:00.000Z' }) },
        calls,
      ),
    )
    await signIn()
    renderApp('/settings/registers')
    expect(await screen.findByText('This computer is a registered counter')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/This is the computer you are using/)).toBeInTheDocument()
    await user.type(within(confirm).getByLabelText(/^Reason/), 'Replaced')
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.params).toEqual({ id: IDS.device })
    expect(calls[0]!.body).toEqual({ reason: 'Replaced' })
    await waitFor(() => expect(getDeviceCredentials()).toBeNull())
  })

  it('filters devices by status through the list query', async () => {
    const user = userEvent.setup()
    const calls: RecordedRequest[] = []
    server.use(
      onRoute(identityRoutes.listRegisters, { data: [register()], page: page(1, 200) }),
      onRoute(identityRoutes.listDevices, { data: [], page: page(0) }, calls),
    )
    await signIn()
    renderApp('/settings/registers')
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.at(-1)!.query.get('status')).toBe('active')
    await user.click(screen.getByRole('button', { name: 'Revoked' }))
    await waitFor(() => expect(calls.at(-1)!.query.get('status')).toBe('revoked'))
    expect(await screen.findByText('No revoked computers')).toBeInTheDocument()
  })
})
