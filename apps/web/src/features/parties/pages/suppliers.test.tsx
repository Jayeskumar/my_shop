import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeGstin } from '@kadai/shared/gst'
import { describe, expect, it, vi } from 'vitest'
import { SupplierCreateSchema, partiesRoutes } from '@kadai/shared/api/parties'
import { PaymentCreateSchema, paymentsRoutes } from '@kadai/shared/api/payments'
import { purchasesRoutes } from '@kadai/shared/api/purchases'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, renderWithProviders, signIn } from '@/test/render'
import { SupplierFormDialog } from '../components/SupplierFormDialog'
import { pid, supplier as makeSupplier } from '../testing/fixtures'
import { createPartiesApi } from '../testing/handlers'

const SUPPLIER = pid(201)

function setup() {
  const api = createPartiesApi()
  server.use(...api.handlers)
  return api
}

describe('Suppliers', () => {
  it('lists suppliers with what the shop owes and filters to overdue', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/parties/suppliers')
    const table = await screen.findByRole('table', { name: 'Suppliers' })
    const row = (await within(table).findByText('Sri Lakshmi Traders')).closest('tr')!
    expect(within(row).getByText('₹23,500.00')).toBeInTheDocument()
    expect(within(row).getByText('to pay')).toBeInTheDocument()
    expect(within(row).getByText('₹12,500 overdue')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Overdue' }))
    await waitFor(() =>
      expect(api.callsTo(partiesRoutes.listSuppliers).at(-1)!.query.get('overdue')).toBe('true'),
    )
  })

  it('pays a supplier against chosen bills (payment voucher, direction out)', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(`/parties/suppliers/${SUPPLIER}`)
    await user.click(await screen.findByRole('button', { name: /Pay supplier/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Pay supplier' })
    const amount = within(dialog).getByLabelText(/^Amount/)
    await user.clear(amount)
    await user.type(amount, '12500')
    await user.click(within(dialog).getByRole('radio', { name: /Bank transfer/ }))
    await user.click(within(dialog).getByRole('radio', { name: /Choose bills/ }))
    await user.click(await within(dialog).findByRole('button', { name: /Fill oldest first/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Pay ₹12,500.00' }))

    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const body = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[0]!.body)
    expect(body).toMatchObject({
      direction: 'out',
      party_type: 'supplier',
      party_id: SUPPLIER,
      method: 'bank_transfer',
      amount_paise: 1_250_000,
      allocations: [{ target_type: 'purchase_bill', target_id: pid(860), amount_paise: 1_250_000 }],
    })
  })

  it('shows bank details as last 4 digits + IFSC and lists purchase bills', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(`/parties/suppliers/${SUPPLIER}?tab=profile`)
    expect(await screen.findByText('•••• 4321')).toBeInTheDocument()
    expect(screen.getByText('IOBA0001234')).toBeInTheDocument()
    expect(screen.getByText('srilakshmi@okaxis')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Bills' }))
    expect(await screen.findByText('SLT/1182')).toBeInTheDocument()
    expect(api.callsTo(purchasesRoutes.listBills)[0]!.query.get('supplier_id')).toBe(SUPPLIER)
  })

  it('hides Pay supplier without payments.pay', async () => {
    setup()
    await signIn(makeMe({ permissions: PERMISSION_CODES.filter((p) => p !== 'payments.pay') }))
    renderApp(`/parties/suppliers/${SUPPLIER}`)
    await screen.findByRole('heading', { level: 1, name: 'Sri Lakshmi Traders' })
    expect(screen.queryByRole('button', { name: /Pay supplier/ })).not.toBeInTheDocument()
  })
})

describe('SupplierFormDialog', () => {
  it('validates IFSC and sends only the last-4-derivable account number', async () => {
    const api = setup()
    const onSaved = vi.fn()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<SupplierFormDialog open onOpenChange={() => {}} onSaved={onSaved} />)
    await user.type(screen.getByLabelText(/Supplier name/), 'Kovai Traders')
    await user.type(screen.getByLabelText(/Account number/), '1234 5678 9012')
    await user.type(screen.getByLabelText(/^IFSC/), 'sbin01')
    await user.click(screen.getByRole('button', { name: 'Save supplier' }))
    expect(await screen.findByText(/Enter a valid 11-character IFSC/)).toBeInTheDocument()
    expect(api.callsTo(partiesRoutes.createSupplier)).toHaveLength(0)

    await user.clear(screen.getByLabelText(/^IFSC/))
    await user.type(screen.getByLabelText(/^IFSC/), 'sbin0001234')
    await user.type(screen.getByLabelText(/UPI ID/), 'Kovai@OKSBI')
    await user.click(screen.getByRole('button', { name: 'Save supplier' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const sent = api.callsTo(partiesRoutes.createSupplier)[0]!.body
    const body = SupplierCreateSchema.parse(sent)
    expect(body.bank_details).toEqual({
      account_name: null,
      account_no_last4: '9012',
      ifsc: 'SBIN0001234',
      bank_name: null,
    })
    expect(body.upi_vpa).toBe('kovai@oksbi')
    expect(body.state_code).toBe('33')
  })

  it('takes the PAN from a newly typed GSTIN (the PAN is part of the GSTIN)', async () => {
    setup()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<SupplierFormDialog open onOpenChange={() => {}} />)
    const pan = screen.getByLabelText(/^PAN/)
    await user.type(pan, 'AAACK1111A')
    await user.type(screen.getByLabelText(/^GSTIN/), makeGstin('29', 'BBGCK9876Q'))
    await waitFor(() => expect(pan).toHaveValue('BBGCK9876Q'))
  })

  it('keeps the saved account number unless a new one is typed', async () => {
    const api = createPartiesApi()
    server.use(...api.handlers)
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <SupplierFormDialog open onOpenChange={() => {}} supplier={makeSupplier()} />,
    )
    expect(screen.getByText(/Saved account ends with 4321/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText(/Payment terms/))
    await user.type(screen.getByLabelText(/Payment terms/), '45')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.callsTo(partiesRoutes.updateSupplier)).toHaveLength(1))
    expect(api.callsTo(partiesRoutes.updateSupplier)[0]!.body).toEqual({
      payment_terms_days: 45,
      if_updated_at: makeSupplier().updated_at,
    })
  })
})
