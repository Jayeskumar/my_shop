import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import { notificationsRoutes } from '@kadai/shared/api/notifications'
import { LoyaltyAdjustSchema, partiesRoutes } from '@kadai/shared/api/parties'
import { PaymentCreateSchema, paymentsRoutes } from '@kadai/shared/api/payments'
import { salesRoutes } from '@kadai/shared/api/sales'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { DEFAULT_SETTINGS } from '@kadai/shared/settings'
import { IDS, makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { NOW, openShift, pid } from '../testing/fixtures'
import { createPartiesApi } from '../testing/handlers'

const CUSTOMER = pid(101)
const PATH = `/parties/customers/${CUSTOMER}`

function setup(replies: Parameters<typeof createPartiesApi>[0] = {}) {
  const api = createPartiesApi(replies)
  server.use(...api.handlers)
  return api
}

function owner() {
  const me = makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] })
  me.settings = { ...DEFAULT_SETTINGS, loyalty: { ...DEFAULT_SETTINGS.loyalty, enabled: true } }
  return me
}

describe('Customer khata page', () => {
  it('shows the current due, overdue warning, credit use and the statement', async () => {
    setup()
    await signIn(owner())
    renderApp(PATH)
    expect(await screen.findByRole('heading', { level: 1, name: 'Murugan K' })).toBeInTheDocument()
    expect(await screen.findByText('Current due')).toBeInTheDocument()
    expect(await screen.findByText(/₹1,200.00 overdue in 2 bills/)).toBeInTheDocument()
    expect(screen.getByText('₹2,550 available')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Credit limit used' })).toHaveAttribute(
      'aria-valuenow',
      '49',
    )
    const statement = await screen.findByRole('table', { name: 'Statement' })
    expect(within(statement).getByRole('link', { name: 'S1-A/2627/00412' })).toHaveAttribute(
      'href',
      `/sales/invoices/${pid(801)}`,
    )
    expect(within(statement).getByText('Closing balance')).toBeInTheDocument()
    // WhatsApp / call shortcuts for the customer's phone.
    expect(screen.getByRole('link', { name: /Call 98430 12345/ })).toHaveAttribute(
      'href',
      'tel:+919843012345',
    )
    expect(screen.getByRole('link', { name: /WhatsApp/ })).toHaveAttribute(
      'href',
      'https://wa.me/919843012345',
    )
  })

  it('asks the ledger for a period when a preset is chosen', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    await screen.findByRole('table', { name: 'Statement' })
    expect(api.callsTo(partiesRoutes.customerLedger)[0]!.query.get('from')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Pick dates/ }))
    await user.click(await screen.findByRole('button', { name: 'This month' }))
    await waitFor(() => {
      const q = api.callsTo(partiesRoutes.customerLedger).at(-1)!.query
      expect(q.get('from')).toMatch(/^\d{4}-\d{2}-01$/)
      expect(q.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  it('receives a payment with FIFO allocation through POST /payments', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: /Receive payment/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Receive payment' })
    // Defaults to the full due; the preview says which bills it clears.
    expect(within(dialog).getByLabelText(/^Amount/)).toHaveValue('2,450.00')
    expect(await within(dialog).findByText('Clears 4 bills fully.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /UPI/ }))
    await user.type(within(dialog).getByLabelText(/UPI reference/), '628194773311')
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹2,450.00' }))

    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const call = api.callsTo(paymentsRoutes.createPayment)[0]!
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    const body = PaymentCreateSchema.parse(call.body)
    expect(body).toMatchObject({
      direction: 'in',
      party_type: 'customer',
      party_id: CUSTOMER,
      method: 'upi',
      amount_paise: 245_000,
      auto_allocate: 'fifo',
      reference: '628194773311',
      store_id: IDS.store,
    })
    expect(body.allocations).toBeUndefined()
    const open = api.callsTo(paymentsRoutes.openItems)[0]!
    expect(open.query.get('party_type')).toBe('customer')
    expect(open.query.get('direction')).toBe('in')
  })

  it('lets the cashier choose the bills a part payment settles', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: /Receive payment/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Receive payment' })
    const amount = within(dialog).getByLabelText(/^Amount/)
    await user.clear(amount)
    await user.type(amount, '700')
    await user.click(within(dialog).getByRole('radio', { name: /Choose bills/ }))
    await user.click(
      await within(dialog).findByRole('checkbox', { name: 'Settle S1-A/2627/00577' }),
    )
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹700.00' }))

    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const body = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[0]!.body)
    expect(body.auto_allocate).toBeUndefined()
    expect(body.allocations).toEqual([
      { target_type: 'sales_invoice', target_id: pid(802), amount_paise: 38_000 },
    ])
  })

  it('puts cash received at the counter into its open shift (and lets the cashier opt out)', async () => {
    const api = setup({ currentShift: () => HttpResponse.json({ data: openShift() }) })
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: /Receive payment/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Receive payment' })
    const drawer = await within(dialog).findByRole('checkbox', {
      name: /Put this cash in the Counter A drawer/,
    })
    expect(drawer).toBeChecked()
    expect(api.callsTo(accountingRoutes.currentShift)[0]!.query.get('register_id')).toBe(
      IDS.register,
    )
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹2,450.00' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const body = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[0]!.body)
    expect(body).toMatchObject({ method: 'cash', shift_id: openShift().id, store_id: IDS.store })

    // UPI never goes to the drawer; unticking keeps cash out of the shift too.
    await user.click(await screen.findByRole('button', { name: /Receive payment/ }))
    const again = await screen.findByRole('dialog', { name: 'Receive payment' })
    await user.click(
      await within(again).findByRole('checkbox', { name: /Put this cash in the Counter A drawer/ }),
    )
    await user.click(within(again).getByRole('button', { name: 'Receive ₹2,450.00' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(2))
    const second = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[1]!.body)
    expect(second.shift_id).toBeUndefined()
    await user.click(await screen.findByRole('button', { name: /Receive payment/ }))
    const third = await screen.findByRole('dialog', { name: 'Receive payment' })
    await user.click(within(third).getByRole('radio', { name: /UPI/ }))
    expect(
      within(third).queryByRole('checkbox', { name: /Put this cash in the Counter A drawer/ }),
    ).not.toBeInTheDocument()
  })

  it('sends a reminder through the cashier’s own WhatsApp (wa.me)', async () => {
    const api = setup({
      remindCustomer: () =>
        HttpResponse.json({
          data: {
            customer_id: CUSTOMER,
            due_paise: 245_000,
            amount_paise: 245_000,
            channel: 'wa_me',
            notification: null,
            link: null,
            message: 'வணக்கம் முருகன், …',
            wa_me_url: 'https://wa.me/919843012345?text=hello',
            last_reminded_at: NOW,
          },
        }),
    })
    const user = userEvent.setup()
    // A plan without WhatsApp/SMS: only "My WhatsApp" is possible.
    await signIn(
      makeMe({ features: DEFAULT_PLAN_FEATURES.pro.filter((f) => f !== 'notifications') }),
    )
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: /Send reminder/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Remind Murugan K' })
    expect(within(dialog).getByRole('radio', { name: /WhatsApp \(from Kadai\)/ })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /My WhatsApp/ })).toBeChecked()
    // Tamil preview by default (business locale), with the due amount.
    expect(within(dialog).getByTestId('reminder-preview')).toHaveTextContent(/₹2,450.00/)
    expect(within(dialog).getByTestId('reminder-preview')).toHaveTextContent(/வணக்கம்/)
    await user.click(within(dialog).getByRole('button', { name: 'Prepare message' }))

    expect(await within(dialog).findByRole('link', { name: /Open WhatsApp/ })).toHaveAttribute(
      'href',
      'https://wa.me/919843012345?text=hello',
    )
    const call = api.callsTo(notificationsRoutes.remindCustomer)[0]!
    expect(call.path).toBe(`/api/v1/customers/${CUSTOMER}/remind`)
    expect(call.body).toEqual({ channel: 'wa_me', locale: 'ta', include_payment_link: true })
  })

  it('adjusts loyalty points with a reason', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(owner())
    renderApp(`${PATH}?tab=loyalty`)
    expect(await screen.findByText('340 points')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Adjust points' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust points' })
    await user.click(within(dialog).getByRole('radio', { name: /Remove points/ }))
    await user.type(within(dialog).getByLabelText(/^Points/), '40')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('Please write a reason')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Wrong bill corrected')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.callsTo(partiesRoutes.adjustLoyalty)).toHaveLength(1))
    expect(LoyaltyAdjustSchema.parse(api.callsTo(partiesRoutes.adjustLoyalty)[0]!.body)).toEqual({
      points: -40,
      notes: 'Wrong bill corrected',
    })
  })

  it('lists the customer’s bills from the sales contract', async () => {
    const api = setup()
    await signIn(owner())
    renderApp(`${PATH}?tab=invoices`)
    expect(await screen.findByText('S1-A/2627/00350')).toBeInTheDocument()
    const q = api.callsTo(salesRoutes.listInvoices)[0]!.query
    expect(q.get('customer_id')).toBe(CUSTOMER)
    expect(q.get('sort')).toBe('-invoice_at')
  })

  it('hides money actions and tabs the user may not use', async () => {
    setup()
    const allowed = PERMISSION_CODES.filter(
      (p) => !p.startsWith('payments.') && !p.startsWith('sales.') && p !== 'customers.write',
    )
    await signIn(
      makeMe({
        permissions: allowed,
        features: DEFAULT_PLAN_FEATURES.pro.filter((f) => f !== 'loyalty'),
      }),
    )
    renderApp(PATH)
    await screen.findByRole('heading', { level: 1, name: 'Murugan K' })
    expect(screen.queryByRole('button', { name: /Receive payment/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send reminder/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Payment link/ })).not.toBeInTheDocument()
    const tabs = screen.getByRole('tablist')
    expect(within(tabs).getByRole('tab', { name: 'Ledger' })).toBeInTheDocument()
    expect(within(tabs).queryByRole('tab', { name: 'Bills' })).not.toBeInTheDocument()
    expect(within(tabs).queryByRole('tab', { name: 'Payments' })).not.toBeInTheDocument()
    expect(within(tabs).queryByRole('tab', { name: 'Loyalty' })).not.toBeInTheDocument()
  })

  it('shows a friendly not-found page', async () => {
    setup({
      getCustomer: () =>
        HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'no' } }, { status: 404 }),
    })
    await signIn(owner())
    renderApp(PATH)
    expect(await screen.findByText('Customer not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to customers' })).toHaveAttribute(
      'href',
      '/parties/customers',
    )
  })
})
