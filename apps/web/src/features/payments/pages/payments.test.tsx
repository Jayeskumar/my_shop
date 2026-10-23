import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import {
  PaymentCancelSchema,
  PaymentCreateSchema,
  PaymentListQuerySchema,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { IDS, makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import {
  createPaymentsApi,
  json,
  queryObject,
  type Reply,
  type RouteKey,
} from '../testing/handlers'

// Route chunks load lazily; under the parallel full suite that can take over a second.
configure({ asyncUtilTimeout: 5_000 })

function setup(replies: Partial<Record<RouteKey, Reply>> = {}) {
  const api = createPaymentsApi(replies)
  server.use(...api.handlers)
  return api
}

const owner = () => makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] })

type User = ReturnType<typeof userEvent.setup>

/** Opens a party picker inside `scope` and picks the option with this name. */
async function pick(user: User, scope: HTMLElement, name: string) {
  await user.click(within(scope).getByRole('combobox', { name: /Customer|Supplier/ }))
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }))
}

describe('Receipts & payments', () => {
  it('lists payments with the totals of the filtered range', async () => {
    const api = setup()
    await signIn(owner())
    renderApp('/payments')
    const table = await screen.findByRole('table', { name: 'Receipts & payments' })
    expect(await within(table).findByText('RC/2627/00042')).toBeInTheDocument()
    expect(within(table).getByText('+₹1,250.00')).toBeInTheDocument()
    expect(within(table).getByText('−₹12,500.00')).toBeInTheDocument()
    // POS tenders have no number: the origin is shown instead.
    expect(within(table).getByText('Bill payment')).toBeInTheDocument()
    // Totals come from the list summary (whole range, not only this page).
    expect(screen.getByText('₹1,430.00')).toBeInTheDocument()
    expect(screen.getAllByText('₹12,500.00').length).toBeGreaterThan(0)

    const first = api.callsTo(paymentsRoutes.listPayments)[0]!
    const q = PaymentListQuerySchema.parse(queryObject(first.query))
    expect(q).toMatchObject({ limit: 50, offset: 0, sort: { field: 'paid_at', direction: 'desc' } })
    expect(q.from).toMatch(/^\d{4}-\d{2}-01$/)
    expect(q.direction).toBeUndefined()
  })

  it('filters by direction, method and search, and pages through', async () => {
    const api = setup({
      listPayments: () => json(F.paymentList(F.paymentRows(), 120)),
    })
    const user = userEvent.setup()
    await signIn(owner())
    renderApp('/payments')
    await screen.findByRole('table', { name: 'Receipts & payments' })

    await user.click(screen.getByRole('tab', { name: 'Paid' }))
    await waitFor(() =>
      expect(api.callsTo(paymentsRoutes.listPayments).at(-1)!.query.get('direction')).toBe('out'),
    )
    // Method chips of the summary filter too.
    await user.click(screen.getByRole('button', { name: /UPI\s*\+₹1,250.00/ }))
    await waitFor(() => {
      const q = api.callsTo(paymentsRoutes.listPayments).at(-1)!.query
      expect(q.get('direction')).toBe('in')
      expect(q.getAll('method')).toEqual(['upi'])
    })
    await user.type(screen.getByRole('searchbox'), '628194')
    await waitFor(() =>
      expect(api.callsTo(paymentsRoutes.listPayments).at(-1)!.query.get('q')).toBe('628194'),
    )
    await user.click(screen.getByRole('button', { name: /next page/i }))
    await waitFor(() =>
      expect(api.callsTo(paymentsRoutes.listPayments).at(-1)!.query.get('offset')).toBe('50'),
    )
  })

  it('receives a payment from a customer with FIFO allocation', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp('/payments')
    await user.click(await screen.findByRole('button', { name: /Receive payment/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Receive payment' })
    await pick(user, dialog, 'Lakshmi Ammal')

    // The amount defaults to the total due; FIFO settles the oldest first.
    expect(await within(dialog).findByText('Owes you ₹2,000.00')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^Amount(?! for)/)).toHaveValue('2,000.00'),
    )
    expect(within(dialog).getByText('Settles the oldest bills first')).toBeInTheDocument()
    expect(within(dialog).getByText('16 days overdue')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('radio', { name: /UPI/ }))
    await user.type(within(dialog).getByLabelText(/UTR \/ UPI reference/), '628194773311')
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹2,000.00' }))

    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const call = api.callsTo(paymentsRoutes.createPayment)[0]!
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    const body = PaymentCreateSchema.parse(call.body)
    expect(body).toMatchObject({
      direction: 'in',
      store_id: IDS.store,
      party_type: 'customer',
      party_id: F.ID.customer,
      method: 'upi',
      amount_paise: 2_000_00,
      reference: '628194773311',
      auto_allocate: 'fifo',
    })
    expect(body.allocations).toBeUndefined()
    const open = api.callsTo(paymentsRoutes.openItems)[0]!
    expect(open.query.get('party_type')).toBe('customer')
    expect(open.query.get('direction')).toBe('in')
    // The new receipt opens in the drawer.
    expect(await screen.findByText('₹2,000.00 received from Lakshmi Ammal')).toBeInTheDocument()
  })

  it('sends manual allocations when the cashier picks the bills', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp('/payments?new=receive')
    const dialog = await screen.findByRole('dialog', { name: 'Receive payment' })
    await pick(user, dialog, 'Lakshmi Ammal')
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^Amount(?! for)/)).toHaveValue('2,000.00'),
    )
    const amount = within(dialog).getByLabelText(/^Amount(?! for)/)
    await user.clear(amount)
    await user.type(amount, '1500')
    // Skip the opening balance and settle the newest bill only.
    await user.click(within(dialog).getByRole('checkbox', { name: 'Settle Old balance (opening)' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Settle S1-A/2627/00412' }))
    expect(within(dialog).getByText('Choose bills and amounts')).toBeInTheDocument()
    // The remaining bill keeps its FIFO share until the cashier types its full due.
    const row = within(dialog).getByLabelText('Amount for S1-A/2627/00577')
    expect(row).toHaveValue('730.00')
    await user.clear(row)
    await user.type(row, '1230')
    expect(within(dialog).getByText('Kept as advance')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹1,500.00' }))

    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const body = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[0]!.body)
    expect(body.auto_allocate).toBeUndefined()
    expect(body.method).toBe('cash')
    expect(body.reference).toBeUndefined()
    expect(body.allocations).toEqual([
      { target_type: 'sales_invoice', target_id: F.ID.invoice2, amount_paise: 1_230_00 },
    ])
  })

  it('blocks allocations above the amount on the client', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp('/payments?new=receive')
    const dialog = await screen.findByRole('dialog', { name: 'Receive payment' })
    await pick(user, dialog, 'Lakshmi Ammal')
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^Amount(?! for)/)).toHaveValue('2,000.00'),
    )
    await user.click(within(dialog).getByRole('checkbox', { name: 'Settle S1-A/2627/00412' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Settle S1-A/2627/00412' }))
    const amount = within(dialog).getByLabelText(/^Amount(?! for)/)
    await user.clear(amount)
    await user.type(amount, '100')
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹100.00' }))
    expect(
      await within(dialog).findByText(/You have allocated more than the amount/),
    ).toBeInTheDocument()
    expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(0)
  })

  it('puts counter cash into the open shift drawer', async () => {
    const api = setup({ currentShift: () => json({ data: F.openShift() }) })
    const user = userEvent.setup()
    await signIn(owner())
    renderApp('/payments?new=receive')
    const dialog = await screen.findByRole('dialog', { name: 'Receive payment' })
    await pick(user, dialog, 'Lakshmi Ammal')
    await waitFor(() =>
      expect(api.callsTo(accountingRoutes.currentShift).length).toBeGreaterThan(0),
    )
    const drawer = await within(dialog).findByRole('checkbox', {
      name: /Add to Counter A cash drawer/,
    })
    expect(drawer).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹2,000.00' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const body = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[0]!.body)
    expect(body).toMatchObject({ shift_id: F.pid(9950), register_id: IDS.register, method: 'cash' })
  })

  it('pays a supplier against due bills', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp('/payments')
    await user.click(await screen.findByRole('button', { name: /Pay supplier/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Pay supplier' })
    await pick(user, dialog, 'Sri Lakshmi Traders')
    expect(await within(dialog).findByText('You owe ₹23,500.00')).toBeInTheDocument()
    expect(within(dialog).getByText('SLT/1182')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /Bank transfer/ }))
    await user.type(within(dialog).getByLabelText(/Transaction reference/), 'NEFT 99120')
    await user.click(within(dialog).getByRole('button', { name: 'Pay ₹23,500.00' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const body = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[0]!.body)
    expect(body).toMatchObject({
      direction: 'out',
      party_type: 'supplier',
      party_id: F.ID.supplier,
      method: 'bank_transfer',
      reference: 'NEFT 99120',
      auto_allocate: 'fifo',
      amount_paise: 23_500_00,
    })
    expect(api.callsTo(paymentsRoutes.openItems)[0]!.query.get('direction')).toBe('out')
  })

  it('shows the detail with allocations and cancels a manual receipt with a reason', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(`/payments?id=${F.ID.payment1}`)
    const drawer = await screen.findByRole('dialog', { name: 'RC/2627/00042' })
    expect(await within(drawer).findByTestId('payment-amount')).toHaveTextContent('₹1,250.00')
    expect(within(drawer).getByRole('link', { name: 'S1-A/2627/00412' })).toHaveAttribute(
      'href',
      `/sales/invoices/${F.ID.invoice1}`,
    )
    expect(within(drawer).getByText('still due ₹300.00')).toBeInTheDocument()
    expect(within(drawer).getByText('KD9Z1R4TW6YE')).toBeInTheDocument()

    await user.click(within(drawer).getByRole('button', { name: 'Cancel' }))
    const confirm = await screen.findByRole('dialog', { name: 'Cancel receipt RC/2627/00042?' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancel payment' }))
    expect(api.callsTo(paymentsRoutes.cancelPayment)).toHaveLength(0)
    await user.type(within(confirm).getByLabelText(/^Reason/), 'Entered twice')
    await user.click(within(confirm).getByRole('button', { name: 'Cancel payment' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.cancelPayment)).toHaveLength(1))
    const call = api.callsTo(paymentsRoutes.cancelPayment)[0]!
    expect(call.path.endsWith(`/payments/${F.ID.payment1}/cancel`)).toBe(true)
    expect(PaymentCancelSchema.parse(call.body)).toEqual({ reason: 'Entered twice' })
  })

  it('does not offer cancel for counter tenders', async () => {
    setup()
    await signIn(owner())
    renderApp(`/payments?id=${F.ID.payment2}`)
    const drawer = await screen.findByRole('dialog', { name: 'Bill payment' })
    expect(
      await within(drawer).findByText('This was paid with a bill. To undo it, cancel the bill.'),
    ).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Print receipt' })).toBeInTheDocument()
  })

  it('hides receive and pay for members without those permissions', async () => {
    setup()
    await signIn(
      makeMe({
        permissions: PERMISSION_CODES.filter(
          (p) => p !== 'payments.collect' && p !== 'payments.pay',
        ),
        features: [...DEFAULT_PLAN_FEATURES.pro],
      }),
    )
    renderApp('/payments?new=receive')
    await screen.findByRole('table', { name: 'Receipts & payments' })
    expect(screen.queryByRole('button', { name: /Receive payment/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pay supplier/ })).not.toBeInTheDocument()
    // A deep link to the dialog does nothing without the permission.
    expect(screen.queryByRole('dialog', { name: 'Receive payment' })).not.toBeInTheDocument()
  })
})
