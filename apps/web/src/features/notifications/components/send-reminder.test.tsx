import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CustomerRemindSchema } from '@kadai/shared/api/notifications'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { makeMe } from '@/test/fixtures'
import { errorResponse, server } from '@/test/msw'
import { renderWithProviders, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createNotificationsApi } from '../testing/handlers'
import { SendReminderDialog } from './index'

function setup(replies: Parameters<typeof createNotificationsApi>[0] = {}) {
  const api = createNotificationsApi(replies)
  server.use(...api.handlers)
  return api
}

const summary = F.customerSummary()

describe('SendReminderDialog', () => {
  it('previews the Tamil reminder, switches to English and sends on WhatsApp', async () => {
    const api = setup()
    const onSent = vi.fn()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <SendReminderDialog
        open
        onOpenChange={() => {}}
        customer={F.customer()}
        summary={summary}
        onSent={onSent}
      />,
    )
    const dialog = await screen.findByRole('dialog', { name: 'Remind Lakshmi' })
    expect(within(dialog).getByRole('radio', { name: /^WhatsApp/ })).toBeChecked()
    // Tamil is the business language: name, due and shop in Tamil; 15 days since the oldest bill.
    const preview = within(dialog).getByTestId('reminder-preview')
    expect(preview).toHaveTextContent('வணக்கம் லட்சுமி, ஸ்ரீ முருகன் ஸ்டோர்ஸ் கடையிலிருந்து')
    expect(preview).toHaveTextContent('₹2,450.00')

    await user.click(within(dialog).getByRole('radio', { name: 'English' }))
    expect(preview).toHaveTextContent('Hello Lakshmi, a friendly reminder from Sri Murugan Stores')

    await user.click(within(dialog).getByRole('button', { name: 'Send reminder' }))
    await waitFor(() => expect(api.callsTo('remindCustomer')).toHaveLength(1))
    const call = api.callsTo('remindCustomer')[0]!
    expect(call.params.id).toBe(F.CUSTOMER_ID)
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    expect(CustomerRemindSchema.parse(call.body)).toMatchObject({
      channel: 'whatsapp',
      locale: 'en',
      include_payment_link: true,
    })
    expect(call.body).not.toHaveProperty('amount_paise')
    expect(call.body).not.toHaveProperty('phone')
    expect(await within(dialog).findByText(/Reminder queued/)).toBeInTheDocument()
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp' }))
  })

  it('uses "My WhatsApp" when the customer has not agreed to WhatsApp messages', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <SendReminderDialog
        open
        onOpenChange={() => {}}
        customer={F.customer({ whatsapp_opt_in: false })}
        summary={summary}
      />,
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: /^WhatsApp/ })).toBeDisabled()
    expect(
      within(dialog).getByText('Customer has not agreed to WhatsApp messages'),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /My WhatsApp/ })).toBeChecked()

    await user.click(within(dialog).getByRole('button', { name: 'Prepare message' }))
    await waitFor(() => expect(api.callsTo('remindCustomer')).toHaveLength(1))
    expect(api.callsTo('remindCustomer')[0]!.body).toMatchObject({ channel: 'wa_me' })
    expect(await within(dialog).findByRole('link', { name: /Open WhatsApp/ })).toHaveAttribute(
      'href',
      'https://wa.me/919876543210?text=hello',
    )
  })

  it('checks the amount and a changed mobile number before sending', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <SendReminderDialog open onOpenChange={() => {}} customer={F.customer()} summary={summary} />,
    )
    const dialog = await screen.findByRole('dialog')
    const amount = within(dialog).getByRole('textbox', { name: /Amount to ask/ })
    await user.clear(amount)
    await user.type(amount, '3000')
    expect(within(dialog).getByText('Cannot be more than the due of ₹2,450.00')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Send reminder' })).toBeDisabled()

    await user.clear(amount)
    await user.type(amount, '1000')
    const phone = within(dialog).getByRole('textbox', { name: /Mobile number/ })
    await user.clear(phone)
    await user.type(phone, '12345')
    expect(within(dialog).getByRole('button', { name: 'Send reminder' })).toBeDisabled()
    await user.clear(phone)
    await user.type(phone, '9843012345')
    await user.click(within(dialog).getByRole('button', { name: 'Send reminder' }))
    await waitFor(() => expect(api.callsTo('remindCustomer')).toHaveLength(1))
    expect(CustomerRemindSchema.parse(api.callsTo('remindCustomer')[0]!.body)).toMatchObject({
      amount_paise: 100_000,
      phone: '+919843012345',
    })
  })

  it('offers "My WhatsApp" when the channel is not set up', async () => {
    setup({
      remindCustomer: () =>
        errorResponse(422, 'UNPROCESSABLE', 'not configured', {
          reason: 'channel_not_configured',
        }),
    })
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(
      <SendReminderDialog open onOpenChange={() => {}} customer={F.customer()} summary={summary} />,
    )
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Send reminder' }))
    expect(
      await within(dialog).findByText('This channel is not set up yet. Use “My WhatsApp” instead.'),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Send from my WhatsApp instead' }))
    expect(within(dialog).getByRole('radio', { name: /My WhatsApp/ })).toBeChecked()
    expect(within(dialog).getByRole('button', { name: 'Prepare message' })).toBeInTheDocument()
  })

  it('offers only "My WhatsApp" without the plan feature, and fetches the khata summary itself', async () => {
    const api = setup()
    await signIn(
      makeMe({ features: DEFAULT_PLAN_FEATURES.growth.filter((f) => f !== 'notifications') }),
    )
    renderWithProviders(<SendReminderDialog open onOpenChange={() => {}} customer={F.customer()} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: /^WhatsApp/ })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /^SMS/ })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /My WhatsApp/ })).toBeChecked()
    await waitFor(() => expect(api.callsTo('customerSummary')).toHaveLength(1))
    expect(await within(dialog).findByText('2 bills overdue · ₹1,200.00')).toBeInTheDocument()
  })

  it('starts with a customer search when no customer is given', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<SendReminderDialog open onOpenChange={() => {}} />)
    const dialog = await screen.findByRole('dialog', { name: 'Send a due reminder' })
    await user.click(within(dialog).getByRole('combobox', { name: 'Customer' }))
    await user.click(await screen.findByRole('option', { name: /கண்ணன்|Kannan/ }))
    expect(await screen.findByRole('dialog', { name: 'Remind Kannan' })).toBeInTheDocument()
    const list = api.callsTo('listCustomers')[0]!
    expect(list.query.get('has_due')).toBe('true')
  })
})
