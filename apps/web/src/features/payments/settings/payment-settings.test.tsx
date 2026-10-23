import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  PaymentProviderCreateSchema,
  PaymentProviderUpdateSchema,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { PERMISSION_CODES, type Permission } from '@kadai/shared/permissions'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createPaymentsApi, json, type Reply, type RouteKey } from '../testing/handlers'

// Route chunks load lazily; under the parallel full suite that can take over a second.
configure({ asyncUtilTimeout: 5_000 })

const PATH = '/settings/payments'

function setup(replies: Partial<Record<RouteKey, Reply>> = {}) {
  const api = createPaymentsApi(replies)
  server.use(...api.handlers)
  return api
}

function owner(features = [...DEFAULT_PLAN_FEATURES.pro]) {
  return makeMe({ features })
}

describe('UPI & payment setup', () => {
  it('explains both options and lists the accounts with the default first', async () => {
    setup()
    await signIn(owner())
    renderApp(PATH)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'UPI & payment setup' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Free with your UPI ID — cashier confirms')).toBeInTheDocument()
    expect(screen.getByText('Automatic confirmation — Razorpay charges a fee')).toBeInTheDocument()

    const vpa = await screen.findByTestId(`provider-${F.ID.vpaAccount}`)
    expect(within(vpa).getByText('murugan.stores@okaxis')).toBeInTheDocument()
    expect(within(vpa).getByText('Default')).toBeInTheDocument()
    expect(within(vpa).getByText('5411 · Grocery / supermarket')).toBeInTheDocument()

    // Razorpay card: masked key and the webhook URL to copy, with the events to tick.
    const rzp = screen.getByTestId(`provider-${F.ID.rzpAccount}`)
    expect(within(rzp).getByText('rzp_live_••••Ab12')).toBeInTheDocument()
    expect(within(rzp).getByText(/\/webhooks\/payments\/razorpay\//)).toBeInTheDocument()
    expect(within(rzp).getByText('qr_code.credited')).toBeInTheDocument()
    expect(within(rzp).getByRole('button', { name: 'Copy webhook URL' })).toBeInTheDocument()

    // The deactivated account stays out of the way until asked for.
    expect(screen.queryByTestId(`provider-${F.ID.oldAccount}`)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show deactivated accounts (1)' }))
    expect(screen.getByTestId(`provider-${F.ID.oldAccount}`)).toBeInTheDocument()
  })

  it('validates the UPI ID before saving and sends the contract body', async () => {
    const api = setup({
      listProviders: () => json({ data: [], page: F.page(0, 200) }),
    })
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    expect(await screen.findByText('No UPI ID added yet')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Add UPI ID' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Add your UPI ID' })
    // Payee name and MCC are preset from the business.
    expect(within(dialog).getByLabelText(/^Name customers see/)).toHaveValue('Sri Murugan Stores')
    expect(
      within(dialog).getByText('Type the UPI ID and name to see a ₹1 test QR here.'),
    ).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/^UPI ID/), 'murugan stores')
    await user.click(within(dialog).getByRole('button', { name: 'Add UPI ID' }))
    expect(await within(dialog).findByText(/This UPI ID looks wrong/)).toBeInTheDocument()
    expect(api.callsTo(paymentsRoutes.createProvider)).toHaveLength(0)

    const input = within(dialog).getByLabelText(/^UPI ID/)
    await user.clear(input)
    await user.type(input, 'Murugan.Stores@okaxis')
    // The ₹1 self-test QR is built locally from what was typed.
    expect(
      await within(dialog).findByRole('img', { name: '₹1 test QR for Murugan.Stores@okaxis' }),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Add UPI ID' }))

    await waitFor(() => expect(api.callsTo(paymentsRoutes.createProvider)).toHaveLength(1))
    const call = api.callsTo(paymentsRoutes.createProvider)[0]!
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    const body = PaymentProviderCreateSchema.parse(call.body)
    expect(body).toMatchObject({
      provider: 'upi_vpa',
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Sri Murugan Stores',
      merchant_code: '5411',
      store_id: null,
      // First account: suggested as the default.
      is_default: true,
    })
    // Saved → the ₹1 test from the server is offered straight away.
    await waitFor(() => expect(api.callsTo(paymentsRoutes.testProvider)).toHaveLength(1))
    expect(
      await screen.findByText('Check that it shows “Sri Murugan Stores” as the name.'),
    ).toBeInTheDocument()
  })

  it('makes an account the default with if_updated_at', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    const rzp = await screen.findByTestId(`provider-${F.ID.rzpAccount}`)
    await user.click(within(rzp).getByRole('button', { name: 'Make default' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.updateProvider)).toHaveLength(1))
    const call = api.callsTo(paymentsRoutes.updateProvider)[0]!
    expect(call.path.endsWith(F.ID.rzpAccount)).toBe(true)
    expect(PaymentProviderUpdateSchema.parse(call.body)).toEqual({
      is_default: true,
      if_updated_at: F.razorpayAccount().updated_at,
    })
    expect(await screen.findByText('Razorpay is now the default')).toBeInTheDocument()
  })

  it('asks before deactivating an account', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    const vpa = await screen.findByTestId(`provider-${F.ID.vpaAccount}`)
    await user.click(within(vpa).getByRole('button', { name: 'More actions for Shop UPI ID' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Shop UPI ID?' })
    expect(within(confirm).getByText(/This is the default account/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.deleteProvider)).toHaveLength(1))
    expect(api.callsTo(paymentsRoutes.deleteProvider)[0]!.path.endsWith(F.ID.vpaAccount)).toBe(true)
  })

  it('connects Razorpay: the key must match the mode, then shows the webhook setup', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: 'Connect Razorpay' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connect Razorpay' })
    await user.type(within(dialog).getByLabelText(/^Key ID/), 'rzp_test_AbCdEf123456')
    await user.type(within(dialog).getByLabelText(/^Key secret/), 'secret-12345678')
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    expect(await within(dialog).findByText(/This key does not match the mode/)).toBeInTheDocument()
    expect(api.callsTo(paymentsRoutes.createProvider)).toHaveLength(0)

    await user.click(within(dialog).getByRole('radio', { name: /Test/ }))
    await user.type(within(dialog).getByLabelText(/^Webhook secret/), 'whsec-murugan-2026')
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.createProvider)).toHaveLength(1))
    const body = PaymentProviderCreateSchema.parse(
      api.callsTo(paymentsRoutes.createProvider)[0]!.body,
    )
    expect(body).toMatchObject({
      provider: 'razorpay',
      mode: 'test',
      credentials: { key_id: 'rzp_test_AbCdEf123456', key_secret: 'secret-12345678' },
      webhook_secret: 'whsec-murugan-2026',
      merchant_code: '5411',
      is_default: false,
    })
    const done = await screen.findByRole('dialog', { name: 'Razorpay is connected' })
    expect(within(done).getByText('Set up the webhook in Razorpay')).toBeInTheDocument()
    expect(within(done).getByText('payment_link.paid')).toBeInTheDocument()
    await user.click(within(done).getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.testProvider)).toHaveLength(1))
  })

  it('offers Razorpay as an upgrade when the plan has no automatic UPI', async () => {
    setup()
    await signIn(owner(DEFAULT_PLAN_FEATURES.pro.filter((f) => f !== 'upi_dynamic')))
    renderApp(PATH)
    expect(
      await screen.findByText('Automatic UPI confirmation is part of a higher plan.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect Razorpay' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See plans' })).toBeInTheDocument()
  })

  it('prints the standee QR from the static UPI QR payload', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    // One in the page header, one on the UPI ID card.
    await screen.findByTestId(`provider-${F.ID.vpaAccount}`)
    await user.click(screen.getAllByRole('button', { name: 'Standee QR' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Counter standee QR' })
    expect(
      await within(dialog).findByRole('img', { name: 'Shop UPI QR for murugan.stores@okaxis' }),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('எந்த UPI செயலியிலும் ஸ்கேன் செய்யவும்')).toBeInTheDocument()
    const qr = api.callsTo(paymentsRoutes.upiQr)[0]!
    expect(qr.query.get('provider_account_id')).toBe(F.ID.vpaAccount)
    expect(qr.query.get('amount_paise')).toBeNull()
  })

  it('hides the standee for members who cannot collect payments', async () => {
    setup()
    const permissions: Permission[] = PERMISSION_CODES.filter((p) => p !== 'payments.collect')
    await signIn(makeMe({ permissions, features: [...DEFAULT_PLAN_FEATURES.pro] }))
    renderApp(PATH)
    await screen.findByTestId(`provider-${F.ID.vpaAccount}`)
    expect(screen.queryByRole('button', { name: 'Standee QR' })).not.toBeInTheDocument()
  })

  it('needs payments.configure', async () => {
    setup()
    await signIn(
      makeMe({
        permissions: PERMISSION_CODES.filter((p) => p !== 'payments.configure'),
        features: [...DEFAULT_PLAN_FEATURES.pro],
      }),
    )
    renderApp(PATH)
    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument()
  })
})
