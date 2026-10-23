import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  PaymentIntentApplySchema,
  PaymentIntentConfirmSchema,
  PaymentIntentListQuerySchema,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { salesRoutes } from '@kadai/shared/api/sales'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { IDS, makeMe } from '@/test/fixtures'
import { errorResponse, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createPaymentsApi, queryObject, type Reply, type RouteKey } from '../testing/handlers'

// Route chunks load lazily; under the parallel full suite that can take over a second.
configure({ asyncUtilTimeout: 5_000 })

const PATH = '/payments/upi'

function setup(replies: Partial<Record<RouteKey, Reply>> = {}) {
  const api = createPaymentsApi(replies)
  server.use(...api.handlers)
  return api
}

const owner = () => makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] })

describe('UPI reconciliation', () => {
  it("shows today's waiting QRs, the day's totals and totals per account", async () => {
    const api = setup()
    await signIn(owner())
    renderApp(PATH)
    const table = await screen.findByRole('table', { name: 'UPI & reconciliation' })
    expect(await within(table).findByText('KD7Q2M9XA4BC')).toBeInTheDocument()
    expect(within(table).getByText('KD2W4E6R8T0Y')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Waiting (2)' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(await screen.findByRole('tab', { name: /Not applied \(1\)/ })).toBeInTheDocument()
    expect(screen.getByText('₹1,810.00')).toBeInTheDocument()
    expect(screen.getAllByText('₹560.00').length).toBeGreaterThan(0)
    const byAccount = screen.getByRole('heading', { name: 'Paid by account' }).parentElement!
    expect(within(byAccount).getByText('Shop UPI ID')).toBeInTheDocument()
    expect(within(byAccount).getByText('₹1,250.00')).toBeInTheDocument()

    const list = api
      .callsTo(paymentsRoutes.listIntents)
      .map((c) => PaymentIntentListQuerySchema.parse(queryObject(c.query)))
    const tabQuery = list.find((q) => q.status?.includes('pending') && q.limit === 50)!
    expect(tabQuery.status).toEqual(['created', 'pending'])
    expect(tabQuery.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(tabQuery.to).toBe(tabQuery.from)
    expect(tabQuery.sort).toEqual({ field: 'created_at', direction: 'desc' })
    // The unapplied queue spans every day.
    const queue = api
      .callsTo(paymentsRoutes.listIntents)
      .find((c) => c.query.get('unapplied') === 'true')!
    expect(queue.query.get('from')).toBeNull()
    // A pending payment link can be copied again.
    expect(within(table).getByRole('button', { name: 'Copy payment link' })).toBeInTheDocument()
  })

  it('confirms a shop-UPI-ID payment by hand with a valid UTR', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    const table = await screen.findByRole('table', { name: 'UPI & reconciliation' })
    await within(table).findByText('KD7Q2M9XA4BC')
    await user.click(within(table).getAllByRole('button', { name: 'Received' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Mark ₹250.00 as received?' })
    await user.type(within(dialog).getByLabelText(/^UTR/), '12')
    await user.click(within(dialog).getByRole('button', { name: 'Payment received' }))
    expect(
      await within(dialog).findByText(/UTR should be 6–35 letters or numbers/),
    ).toBeInTheDocument()
    expect(api.callsTo(paymentsRoutes.confirmIntent)).toHaveLength(0)

    const utr = within(dialog).getByLabelText(/^UTR/)
    await user.clear(utr)
    await user.type(utr, '6281 9477 3311')
    await user.click(within(dialog).getByRole('button', { name: 'Payment received' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.confirmIntent)).toHaveLength(1))
    const call = api.callsTo(paymentsRoutes.confirmIntent)[0]!
    expect(call.path).toContain(F.ID.intentPending)
    expect(PaymentIntentConfirmSchema.parse(call.body)).toEqual({ utr: '628194773311' })
    expect(await screen.findByText('₹250.00 marked as received')).toBeInTheDocument()
  })

  it('cancels a waiting QR after asking', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    const table = await screen.findByRole('table', { name: 'UPI & reconciliation' })
    await within(table).findByText('KD7Q2M9XA4BC')
    await user.click(within(table).getAllByRole('button', { name: 'Cancel QR' })[0]!)
    const confirm = await screen.findByRole('alertdialog', { name: 'Cancel the ₹250.00 QR?' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancel QR' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.cancelIntent)).toHaveLength(1))
    expect(api.callsTo(paymentsRoutes.cancelIntent)[0]!.path).toContain(F.ID.intentPending)
  })

  it("applies an unapplied payment to a customer's dues", async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(`${PATH}?tab=unapplied`)
    const table = await screen.findByRole('table', { name: 'UPI & reconciliation' })
    expect(await within(table).findByText('KD3H8P2LQ7ZD')).toBeInTheDocument()
    expect(screen.getByText(/This money reached your account/)).toBeInTheDocument()
    await waitFor(() => {
      const q = api.callsTo(paymentsRoutes.listIntents).at(-1)!.query
      expect(q.get('unapplied')).toBe('true')
    })

    await user.click(within(table).getByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply ₹560.00' })
    expect(
      within(dialog).getByText('Paid by LAKSHMI A. Choose where this money should go.'),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Apply payment' }))
    expect(await within(dialog).findByText('Choose the customer')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('combobox', { name: /Customer/ }))
    await user.click(await screen.findByRole('option', { name: /Lakshmi Ammal/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Apply payment' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.applyIntent)).toHaveLength(1))
    const call = api.callsTo(paymentsRoutes.applyIntent)[0]!
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    expect(PaymentIntentApplySchema.parse(call.body)).toEqual({
      target_type: 'customer',
      target_id: F.ID.customer,
    })
    expect(await screen.findByText('₹560.00 applied · RC/2627/00043')).toBeInTheDocument()
  })

  it('applies an unapplied payment to one due bill of the store', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(`${PATH}?tab=unapplied`)
    const table = await screen.findByRole('table', { name: 'UPI & reconciliation' })
    await within(table).findByText('KD3H8P2LQ7ZD')
    await user.click(within(table).getByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply ₹560.00' })
    await user.click(within(dialog).getByRole('radio', { name: /One bill/ }))
    const bill = await within(dialog).findByRole('radio', { name: /S1-A\/2627\/00412/ })
    const invoices = api.callsTo(salesRoutes.listInvoices).at(-1)!.query
    expect(invoices.get('has_due')).toBe('true')
    expect(invoices.get('store_id')).toBe(IDS.store)
    await user.click(bill)
    // ₹560 against a ₹320 due: the rest becomes the customer's advance.
    expect(within(dialog).getByText(/₹240.00 more than the bill due/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Apply payment' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.applyIntent)).toHaveLength(1))
    expect(
      PaymentIntentApplySchema.parse(api.callsTo(paymentsRoutes.applyIntent)[0]!.body),
    ).toEqual({
      target_type: 'sales_invoice',
      target_id: F.ID.invoice1,
    })
  })

  it('explains a refused apply with the payments reason', async () => {
    setup({
      applyIntent: () => errorResponse(409, 'CONFLICT', 'used', { reason: 'intent_used' }),
    })
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(`${PATH}?tab=unapplied`)
    const table = await screen.findByRole('table', { name: 'UPI & reconciliation' })
    await within(table).findByText('KD3H8P2LQ7ZD')
    await user.click(within(table).getByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply ₹560.00' })
    await user.click(within(dialog).getByRole('combobox', { name: /Customer/ }))
    await user.click(await screen.findByRole('option', { name: /Lakshmi Ammal/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Apply payment' }))
    expect(
      await within(dialog).findByText('This UPI payment has already been applied.'),
    ).toBeInTheDocument()
  })

  it('shows the list without actions to members who cannot collect', async () => {
    setup()
    await signIn(
      makeMe({
        permissions: PERMISSION_CODES.filter((p) => p !== 'payments.collect'),
        features: [...DEFAULT_PLAN_FEATURES.pro],
      }),
    )
    renderApp(PATH)
    const table = await screen.findByRole('table', { name: 'UPI & reconciliation' })
    await within(table).findByText('KD7Q2M9XA4BC')
    expect(within(table).queryByRole('button', { name: 'Received' })).not.toBeInTheDocument()
    expect(within(table).queryByRole('button', { name: 'Cancel QR' })).not.toBeInTheDocument()
  })
})
