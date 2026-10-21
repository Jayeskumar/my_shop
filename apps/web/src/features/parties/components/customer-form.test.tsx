import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import {
  CustomerCreateSchema,
  CustomerUpdateSchema,
  partiesRoutes,
} from '@kadai/shared/api/parties'
import { makeGstin } from '@kadai/shared/gst'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { makeMe } from '@/test/fixtures'
import { errorResponse, server } from '@/test/msw'
import { renderWithProviders, signIn } from '@/test/render'
import { customer as makeCustomer, pid } from '../testing/fixtures'
import { createPartiesApi } from '../testing/handlers'
import { CustomerFormDialog } from './CustomerFormDialog'
import { CustomerQuickAddDialog } from './CustomerQuickAddDialog'

function setup(replies: Parameters<typeof createPartiesApi>[0] = {}) {
  const api = createPartiesApi(replies)
  server.use(...api.handlers)
  return api
}

describe('CustomerFormDialog', () => {
  it('creates a customer with the state and type taken from a valid GSTIN', async () => {
    const api = setup()
    const onSaved = vi.fn()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<CustomerFormDialog open onOpenChange={() => {}} onSaved={onSaved} />)

    await user.type(screen.getByLabelText(/Customer name/), 'Kannan Stores')
    await user.type(screen.getByLabelText('Mobile number'), '98765 00001')
    const gstin = makeGstin('29', 'AABCK1234M')
    await user.type(screen.getByLabelText(/^GSTIN/), gstin.toLowerCase())
    expect(await screen.findByText(/Valid GSTIN · PAN AABCK1234M/)).toBeInTheDocument()
    expect(screen.getByText(/State set to Karnataka/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const call = api.callsTo(partiesRoutes.createCustomer)[0]!
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    const body = CustomerCreateSchema.parse(call.body)
    expect(body).toMatchObject({
      name: 'Kannan Stores',
      phone: '+919876500001',
      gstin,
      state_code: '29',
      customer_type: 'business',
      price_tier: 'retail',
      whatsapp_opt_in: true,
      opening_balance_paise: 0,
      credit_limit_paise: null,
      tags: [],
    })
    expect(body.address.state_code).toBe('29')
  })

  it('shows field errors in place and sends nothing while the form is invalid', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<CustomerFormDialog open onOpenChange={() => {}} />)

    await user.type(screen.getByLabelText('Mobile number'), '12345')
    await user.type(screen.getByLabelText(/^GSTIN/), '33ABCDE1234F1Z9')
    // A complete but wrong GSTIN is flagged while typing.
    expect(await screen.findByText(/This GSTIN is not valid/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(await screen.findByText('Enter a valid 10-digit mobile number')).toBeInTheDocument()
    expect(screen.getByText('This field is required')).toBeInTheDocument()
    expect(api.callsTo(partiesRoutes.createCustomer)).toHaveLength(0)
  })

  it('points to the existing customer when the mobile number is taken', async () => {
    const existing = pid(777)
    setup({
      createCustomer: () =>
        errorResponse(409, 'DUPLICATE', 'phone exists', {
          constraint: 'customers_tenant_phone_key',
          existing_id: existing,
        }),
    })
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<CustomerFormDialog open onOpenChange={() => {}} />)
    await user.type(screen.getByLabelText(/Customer name/), 'Murugan')
    await user.type(screen.getByLabelText('Mobile number'), '9843012345')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))

    expect(
      await screen.findByText('A customer with this mobile number already exists'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open that customer/ })).toHaveAttribute(
      'href',
      `/parties/customers/${existing}`,
    )
  })

  it('edits by sending only the changed fields with if_updated_at', async () => {
    const api = setup()
    const user = userEvent.setup()
    const c = makeCustomer({
      id: pid(101),
      credit_days: null,
      updated_at: '2026-10-20T10:00:00.000Z',
    })
    await signIn()
    renderWithProviders(<CustomerFormDialog open onOpenChange={() => {}} customer={c} />)

    await user.type(screen.getByLabelText('Credit days'), '15')
    await user.clear(screen.getByLabelText(/Name in Tamil/))
    await user.type(screen.getByLabelText(/Name in Tamil/), 'லட்சுமி அம்மா')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.callsTo(partiesRoutes.updateCustomer)).toHaveLength(1))
    const call = api.callsTo(partiesRoutes.updateCustomer)[0]!
    expect(call.path).toBe(`/api/v1/customers/${c.id}`)
    expect(call.body).toEqual({
      name_ta: 'லட்சுமி அம்மா',
      credit_days: 15,
      if_updated_at: '2026-10-20T10:00:00.000Z',
    })
    expect(() => CustomerUpdateSchema.parse(call.body)).not.toThrow()
  })

  it('says so instead of saving when nothing changed', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <CustomerFormDialog open onOpenChange={() => {}} customer={makeCustomer()} />,
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Nothing has changed yet')).toBeInTheDocument()
    expect(api.callsTo(partiesRoutes.updateCustomer)).toHaveLength(0)
  })

  it('locks the old balance on edit without the accounts permission', async () => {
    setup()
    await signIn(
      makeMe({ permissions: PERMISSION_CODES.filter((p) => !p.startsWith('accounting.')) }),
    )
    renderWithProviders(
      <CustomerFormDialog
        open
        onOpenChange={() => {}}
        customer={makeCustomer({ opening_balance_paise: 50_000 })}
      />,
    )
    expect(screen.getByLabelText('Amount')).toBeDisabled()
    expect(
      screen.getByText('Only staff with accounts permission can change an old balance.'),
    ).toBeInTheDocument()
  })
})

describe('CustomerQuickAddDialog', () => {
  it('starts short, prefilled with the typed mobile number, and returns the new customer', async () => {
    const api = setup({
      createCustomer: () =>
        HttpResponse.json({ data: makeCustomer({ id: pid(160), name: 'Kumar' }) }, { status: 201 }),
    })
    const onCreated = vi.fn()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <CustomerQuickAddDialog
        open
        onOpenChange={() => {}}
        draft={{ phone: '+919790011223' }}
        onCreated={onCreated}
      />,
    )
    expect(screen.getByLabelText('Mobile number')).toHaveValue('97900 11223')
    expect(screen.queryByLabelText(/^GSTIN/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add GST, credit limit/ })).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Customer name/), 'Kumar')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: pid(160) })),
    )
    const body = CustomerCreateSchema.parse(api.callsTo(partiesRoutes.createCustomer)[0]!.body)
    expect(body.phone).toBe('+919790011223')
  })

  it('picks the existing customer when the mobile number is already in the khata', async () => {
    const existing = pid(778)
    const api = setup({
      createCustomer: () =>
        errorResponse(409, 'DUPLICATE', 'phone exists', { field: 'phone', existing_id: existing }),
      getCustomer: () =>
        HttpResponse.json({ data: makeCustomer({ id: existing, name: 'Selvam' }) }),
    })
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <CustomerQuickAddDialog
        open
        onOpenChange={onOpenChange}
        draft={{ phone: '+919790011224' }}
        onCreated={onCreated}
      />,
    )
    await user.type(screen.getByLabelText(/Customer name/), 'Selvam')
    await user.click(screen.getByRole('button', { name: 'Save customer' }))
    // No link away from the bill: the cashier takes the customer already saved.
    expect(screen.queryByRole('link', { name: /Open that customer/ })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Use this customer' }))
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: existing })),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(api.callsTo(partiesRoutes.getCustomer)).toHaveLength(1)
  })
})
