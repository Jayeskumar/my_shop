import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentIntentCreateSchema } from '@kadai/shared/api/payments'
import {
  CollectPaymentSchema,
  EstimateConvertSchema,
  InvoiceCancelSchema,
  InvoiceShareSchema,
} from '@kadai/shared/api/sales'
import type * as PosPrint from '@/features/pos/print'
import { printSalesDocument } from '@/features/pos/print'
import { IDS, makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { CUSTOMER_ID, ESTIMATE_ID, INVOICE_ID, pid } from '../testing/fixtures'
import { createSalesApi } from '../testing/handlers'

vi.mock('@/features/pos/print', async (importOriginal) => {
  const actual = await importOriginal<typeof PosPrint>()
  return {
    ...actual,
    printSalesDocument: vi.fn(async () => undefined),
    printSalesModel: vi.fn(async () => undefined),
  }
})

const PATH = `/sales/invoices/${INVOICE_ID}`

function setup(replies: Parameters<typeof createSalesApi>[0] = {}) {
  const api = createSalesApi(replies)
  server.use(...api.handlers)
  return api
}

beforeEach(() => {
  vi.mocked(printSalesDocument).mockClear()
})

describe('Invoice detail', () => {
  it('shows the bill: lines, GST, totals, payments, customer khata and history', async () => {
    setup()
    await signIn(makeMe())
    renderApp(PATH)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'S1-A/2627/00412' }),
    ).toBeInTheDocument()
    const lines = screen.getByRole('table', { name: 'Bill items' })
    expect(within(lines).getByText('Aashirvaad Atta 5 kg')).toBeInTheDocument()
    expect(within(lines).getByText('1.5 kg')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'GST breakup' })).toBeInTheDocument()
    expect(screen.getAllByText('₹810.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Balance due').at(-1)!.closest('div')).toHaveTextContent('₹310.00')
    expect(screen.getByText('Rupees Eight Hundred Ten Only')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open khata' })).toHaveAttribute(
      'href',
      `/parties/customers/${CUSTOMER_ID}`,
    )
    expect(screen.getByText('Bill shared')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Return items' })).toHaveAttribute(
      'href',
      `/sales/returns/new?invoice_id=${INVOICE_ID}`,
    )
  })

  it('collects the due in cash and works out the change', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(PATH)
    await user.click((await screen.findAllByRole('button', { name: 'Collect payment' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Collect payment' })
    const cash = within(dialog).getByLabelText(/Cash given by the customer/)
    expect(cash).toHaveValue('310.00')
    await user.clear(cash)
    await user.type(cash, '500')
    expect(within(dialog).getByText('Give back ₹190.00')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹310.00' }))

    await waitFor(() => expect(api.callsTo('collectPayment')).toHaveLength(1))
    const call = api.callsTo('collectPayment')[0]!
    const body = CollectPaymentSchema.parse(call.body)
    expect(body.tenders).toEqual([{ method: 'cash', amount_paise: 50_000 }])
    expect(body.client_ref).toBeTruthy()
    expect(call.headers.get('idempotency-key')).toBe(body.client_ref)
    expect(call.params.id).toBe(INVOICE_ID)
    expect(await screen.findByText('₹310.00 received')).toBeInTheDocument()
  })

  it("records a UPI payment to the shop's UPI ID with the UTR", async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(PATH)
    await user.click((await screen.findAllByRole('button', { name: 'Collect payment' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Collect payment' })
    await user.click(within(dialog).getByRole('radio', { name: /UPI/ }))
    // The plan has auto-confirm QR; the shop's own UPI ID is one tap away.
    expect(within(dialog).getByRole('button', { name: 'Show QR for ₹310.00' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: "Use the shop's UPI QR instead" }))
    expect(
      await within(dialog).findByRole('img', { name: 'Scan to pay ₹310.00' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(api.callsTo('upiQr').length).toBeGreaterThan(0))
    const qr = api.callsTo('upiQr').at(-1)!.query
    expect(qr.get('amount_paise')).toBe('31000')
    expect(qr.get('store_id')).toBe(IDS.store)

    // Submitting before confirming is refused in place.
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹310.00' }))
    expect(await within(dialog).findByText('Confirm the UPI payment first')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/UTR \/ UPI reference/), '412345678901')
    await user.click(
      await within(dialog).findByRole('button', { name: 'Payment received · ₹310.00' }),
    )
    expect(within(dialog).getByText(/UPI ₹310.00 received/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹310.00' }))
    await waitFor(() => expect(api.callsTo('collectPayment')).toHaveLength(1))
    const body = CollectPaymentSchema.parse(api.callsTo('collectPayment')[0]!.body)
    expect(body.tenders).toEqual([
      {
        method: 'upi',
        amount_paise: 31_000,
        provider_account_id: pid(601),
        reference: '412345678901',
      },
    ])
  })

  it('takes UPI with an auto-confirm QR and pays the due with the intent', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(PATH)
    await user.click((await screen.findAllByRole('button', { name: 'Collect payment' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Collect payment' })
    await user.click(within(dialog).getByRole('radio', { name: /UPI/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Show QR for ₹310.00' }))
    await waitFor(() => expect(api.callsTo('createIntent')).toHaveLength(1))
    expect(PaymentIntentCreateSchema.parse(api.callsTo('createIntent')[0]!.body)).toMatchObject({
      amount_paise: 31_000,
      purpose: 'invoice_due',
      store_id: IDS.store,
      ref_type: 'sales_invoice',
      ref_id: INVOICE_ID,
      customer_id: CUSTOMER_ID,
    })
    expect(await within(dialog).findByText(/UPI ₹310.00 received/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Receive ₹310.00' }))
    await waitFor(() => expect(api.callsTo('collectPayment')).toHaveLength(1))
    const body = CollectPaymentSchema.parse(api.callsTo('collectPayment')[0]!.body)
    expect(body.tenders).toEqual([
      { method: 'upi', amount_paise: 31_000, payment_intent_id: pid(651) },
    ])
    // A paid intent is not cancelled when the dialog closes.
    expect(api.callsTo('cancelIntent')).toHaveLength(0)
  })

  it('cancels with a reason after showing what will happen', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: 'More' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel bill' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel bill S1-A/2627/00412?' })
    expect(within(dialog).getByText('Items go back into stock.')).toBeInTheDocument()
    expect(within(dialog).getByText(/Payments of ₹500.00 are cancelled/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel bill' }))
    expect(
      await within(dialog).findByText('Write a reason (at least 3 letters)'),
    ).toBeInTheDocument()
    expect(api.callsTo('cancelInvoice')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Duplicate bill' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cancel bill' }))
    await waitFor(() => expect(api.callsTo('cancelInvoice')).toHaveLength(1))
    expect(InvoiceCancelSchema.parse(api.callsTo('cancelInvoice')[0]!.body)).toEqual({
      reason: 'Duplicate bill',
    })
    expect(await screen.findByText('Bill S1-A/2627/00412 cancelled')).toBeInTheDocument()
    expect(screen.getByText(/Return ₹500.00 cash to the customer/)).toBeInTheDocument()
  })

  it('shares the bill on WhatsApp with the customer mobile', async () => {
    const api = setup()
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await signIn(makeMe())
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: 'Share' }))
    const dialog = await screen.findByRole('dialog', { name: 'Share the bill' })
    expect(within(dialog).getByLabelText(/Customer mobile/)).toHaveValue('98430 12345')
    await user.click(within(dialog).getByRole('button', { name: 'Open WhatsApp' }))
    await waitFor(() => expect(api.callsTo('shareInvoice')).toHaveLength(1))
    expect(InvoiceShareSchema.parse(api.callsTo('shareInvoice')[0]!.body)).toEqual({
      channel: 'whatsapp',
      phone: '+919843012345',
      locale: 'en',
    })
    expect(open).toHaveBeenCalledWith(
      'https://wa.me/919843012345?text=bill',
      '_blank',
      'noopener,noreferrer',
    )
    expect(await within(dialog).findByText(/WhatsApp opened with the message/)).toBeInTheDocument()
  })

  it('prints in the default format, or the chosen paper', async () => {
    setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: 'Print' }))
    await waitFor(() =>
      expect(printSalesDocument).toHaveBeenCalledWith({
        kind: 'invoice',
        id: INVOICE_ID,
        locale: 'en',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Print options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'A4 tax invoice' }))
    await waitFor(() =>
      expect(printSalesDocument).toHaveBeenLastCalledWith({
        kind: 'invoice',
        id: INVOICE_ID,
        locale: 'en',
        format: 'a4',
      }),
    )
  })

  it('hides money and cancel actions from a user who can only view bills', async () => {
    setup()
    await signIn(makeMe({ permissions: ['sales.read'] }))
    renderApp(PATH)
    await screen.findByRole('heading', { level: 1, name: 'S1-A/2627/00412' })
    expect(screen.queryByRole('button', { name: 'Collect payment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Return items' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open khata' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument()
  })

  it('converts an estimate into a draft bill', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/sales/invoices/${ESTIMATE_ID}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'EST/2627/00021' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Collect payment' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Convert to bill' }))
    const dialog = await screen.findByRole('dialog', { name: 'Convert EST/2627/00021 into a bill' })
    await user.click(within(dialog).getByRole('button', { name: 'Make draft bill' }))
    await waitFor(() => expect(api.callsTo('convertEstimate')).toHaveLength(1))
    const call = api.callsTo('convertEstimate')[0]!
    const body = EstimateConvertSchema.parse(call.body)
    expect(body).toMatchObject({
      status: 'draft',
      keep_prices: true,
      tenders: [],
      channel: 'backoffice',
    })
    expect(call.params.id).toBe(ESTIMATE_ID)
    await waitFor(() =>
      expect(api.callsTo('getInvoice').some((c) => c.params.id === pid(860))).toBe(true),
    )
  })
})
