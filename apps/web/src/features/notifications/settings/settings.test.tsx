import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SettingsPatchSchema } from '@kadai/shared/api/identity'
import {
  NotificationTemplateParamsSchema,
  NotificationTemplateUpsertSchema,
} from '@kadai/shared/api/notifications'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { makeMe } from '@/test/fixtures'
import { errorResponse, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createNotificationsApi } from '../testing/handlers'

function setup(...args: Parameters<typeof createNotificationsApi>) {
  const api = createNotificationsApi(...args)
  server.use(...api.handlers)
  return api
}

async function openPage() {
  renderApp('/settings/notifications')
  await screen.findByRole('heading', { name: 'Automatic messages' })
}

describe('Notification settings (/settings/notifications)', () => {
  it('shows the status of each sending service', async () => {
    setup()
    await signIn()
    await openPage()
    const wa = screen.getByTestId('provider-whatsapp')
    expect(within(wa).getByText('Sending')).toBeInTheDocument()
    expect(within(wa).getByText('+91 98765 43210')).toBeInTheDocument()
    expect(within(wa).getByText(/\/webhooks\/notifications\/whatsapp_cloud$/)).toBeInTheDocument()
    expect(
      within(screen.getByTestId('provider-sms')).getByText('Only recorded'),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('provider-email')).getByText('Not set up')).toBeInTheDocument()
    // Cloud: Kadai sets up the services.
    expect(screen.getByText(/Kadai connects the sending services/)).toBeInTheDocument()
  })

  it('saves only the changed toggles and reminder days through PATCH /settings', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    await openPage()

    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Send bills by SMS' }))
    // SMS is only recorded: the toggle warns.
    expect(
      screen.getByText(/SMS is not set up — this message is recorded but not sent/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '60 days' }))
    await user.click(screen.getByRole('button', { name: '7 days' }))
    expect(screen.getByRole('button', { name: '60 days' })).toHaveAttribute('aria-pressed', 'true')

    const bar = screen.getByRole('region', { name: 'Unsaved changes' })
    await user.click(within(bar).getByRole('button', { name: /Save changes/ }))

    await waitFor(() => expect(api.callsTo('updateSettings')).toHaveLength(1))
    const body = api.callsTo('updateSettings')[0]!.body
    expect(SettingsPatchSchema.safeParse(body).success).toBe(true)
    expect(body).toEqual({ notifications: { sms_invoice: true, due_reminder_days: [15, 30, 60] } })
    expect(await screen.findByText('Message settings saved')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument(),
    )
  })

  it('switching due reminders off saves an empty day list; on again needs a day', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    await openPage()

    const dueSwitch = screen.getByRole('switch', { name: 'Due reminders' })
    await user.click(dueSwitch)
    expect(screen.getByText('Due reminders are switched off.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(api.callsTo('updateSettings')).toHaveLength(1))
    expect(api.callsTo('updateSettings')[0]!.body).toEqual({
      notifications: { due_reminder_days: [] },
    })

    // Back on: the default days come back; clearing them all blocks saving.
    await user.click(screen.getByRole('switch', { name: 'Due reminders' }))
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeEnabled()
    for (const d of [7, 15, 30]) await user.click(screen.getByRole('button', { name: `${d} days` }))
    expect(screen.getByText('Pick at least one day, or switch reminders off.')).toBeInTheDocument()
    // On without a day is the saved "off" state: nothing to save.
    expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument()
  })

  it('is read-only for a member limited to some stores', async () => {
    setup()
    const me = makeMe()
    await signIn({ ...me, membership: { ...me.membership, store_ids: [me.stores[0]!.id] } })
    await openPage()
    expect(screen.getByRole('switch', { name: 'Send bills by SMS' })).toBeDisabled()
    expect(screen.getAllByText(/Only a member with access to every store/).length).toBeGreaterThan(
      0,
    )
  })

  it('edits an SMS text: placeholder chips, live preview, DLT id required, then PUT', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    await openPage()

    await user.click(screen.getByRole('tab', { name: /SMS/ }))
    // The DLT note sits on the SMS tab.
    expect(screen.getByText(/TRAI DLT/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit Due reminder in English' }))

    const dialog = await screen.findByRole('dialog', { name: 'Due reminder' })
    const body = within(dialog).getByRole('textbox', { name: /Message text/ })
    await user.clear(body)
    await user.type(body, '{{{{shop_name}}: Dear {{{{customer_name}}, please pay {{{{amonut}}')
    expect(within(dialog).getByText('Not a known detail: {{amonut}}')).toBeInTheDocument()

    await user.clear(body)
    await user.type(body, 'Dear customer, your due is ')
    await user.click(within(dialog).getByRole('button', { name: /^Due amount/ }))
    expect(body).toHaveValue('Dear customer, your due is {{due}}')
    await user.click(within(dialog).getByRole('button', { name: /^Shop name/ }))
    expect(body).toHaveValue('Dear customer, your due is {{due}} {{shop_name}}')
    // Live preview with sample details and this shop's name.
    expect(within(dialog).getByTestId('template-preview')).toHaveTextContent(
      'Dear customer, your due is ₹2,450.00 Sri Murugan Stores',
    )

    // No DLT id yet: saving is blocked with an inline message.
    await user.click(within(dialog).getByRole('button', { name: 'Save text' }))
    expect(
      within(dialog).getByText('Enter the DLT template ID of this SMS text'),
    ).toBeInTheDocument()
    expect(api.callsTo('upsertTemplate')).toHaveLength(0)

    await user.type(
      within(dialog).getByRole('textbox', { name: /DLT template ID/ }),
      '1107161234567890123',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Save text' }))

    await waitFor(() => expect(api.callsTo('upsertTemplate')).toHaveLength(1))
    const call = api.callsTo('upsertTemplate')[0]!
    expect(NotificationTemplateParamsSchema.parse(call.params)).toEqual({
      code: 'due_reminder',
      channel: 'sms',
      locale: 'en',
    })
    expect(NotificationTemplateUpsertSchema.parse(call.body)).toEqual({
      subject: null,
      body: 'Dear customer, your due is {{due}} {{shop_name}}',
      provider_template_id: '1107161234567890123',
      is_active: true,
    })
    expect(await screen.findByText('Message text saved')).toBeInTheDocument()
    // The row now shows the shop's own text.
    expect(screen.getByRole('button', { name: 'Edit Due reminder in English' })).toHaveAttribute(
      'data-state',
      'custom',
    )
  })

  it('shows server validation issues on the right field', async () => {
    setup({
      upsertTemplate: () =>
        errorResponse(400, 'VALIDATION_ERROR', 'invalid', {
          issues: [
            {
              path: 'provider_template_id',
              message: 'provider_template_id_invalid',
              code: 'provider_template_id_invalid',
            },
          ],
          unknown_placeholders: [],
          missing_placeholders: [],
        }),
    })
    const user = userEvent.setup()
    await signIn()
    await openPage()
    await user.click(screen.getByRole('tab', { name: /SMS/ }))
    await user.click(screen.getByRole('button', { name: 'Edit Welcome message in தமிழ்' }))
    const dialog = await screen.findByRole('dialog', { name: 'Welcome message' })
    await user.type(within(dialog).getByRole('textbox', { name: /Message text/ }), ' நன்றி!')
    await user.type(within(dialog).getByRole('textbox', { name: /DLT template ID/ }), 'ABC123')
    await user.click(within(dialog).getByRole('button', { name: 'Save text' }))
    expect(
      await within(dialog).findByText('Use only letters, numbers and _ . : -'),
    ).toBeInTheDocument()
  })

  it('goes back to the standard text after confirming', async () => {
    const api = setup(
      {},
      {
        catalog: F.catalog({
          overrides: [
            {
              code: 'invoice_share',
              channel: 'whatsapp',
              locale: 'ta',
              body: 'நன்றி {{customer_name}}! பில்: {{link}}',
              provider_template_id: 'murugan_bill_ta',
            },
          ],
        }),
      },
    )
    const user = userEvent.setup()
    await signIn()
    await openPage()
    const row = screen.getByRole('button', { name: 'Edit Bill shared with customer in தமிழ்' })
    expect(row).toHaveAttribute('data-state', 'custom')
    await user.click(row)
    const dialog = await screen.findByRole('dialog', { name: 'Bill shared with customer' })
    // WhatsApp: the text to submit to Meta uses numbered parameters.
    expect(within(dialog).getByText('நன்றி {{1}}! பில்: {{2}}')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Back to standard' }))
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Go back to the standard text?',
    })
    await user.click(within(confirm).getByRole('button', { name: 'Back to standard' }))

    await waitFor(() => expect(api.callsTo('deleteTemplate')).toHaveLength(1))
    expect(api.callsTo('deleteTemplate')[0]!.params).toEqual({
      code: 'invoice_share',
      channel: 'whatsapp',
      locale: 'ta',
    })
    expect(await screen.findByText('Back to the standard text')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Edit Bill shared with customer in தமிழ்' }),
    ).toHaveAttribute('data-state', 'standard')
  })

  it('sends a test message to the owner through POST /notifications/send', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    await openPage()
    await user.click(
      within(screen.getByTestId('provider-whatsapp')).getByRole('button', { name: 'Send a test' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Send a test WhatsApp' })
    expect(within(dialog).getByTestId('test-preview')).toHaveTextContent('Sri Murugan Stores')
    await user.click(within(dialog).getByRole('button', { name: 'Send test' }))
    await waitFor(() => expect(api.callsTo('sendNotification')).toHaveLength(1))
    const call = api.callsTo('sendNotification')[0]!
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    expect(call.body).toMatchObject({
      channel: 'whatsapp',
      template_code: 'welcome',
      to: '98765 43210',
      locale: 'en',
    })
    expect(await within(dialog).findByRole('link', { name: 'Open message log' })).toHaveAttribute(
      'href',
      `/notifications?id=${F.nid(77)}`,
    )
  })

  it('shows the upgrade page when the plan has no WhatsApp & SMS', async () => {
    const api = setup()
    await signIn(
      makeMe({ features: DEFAULT_PLAN_FEATURES.growth.filter((f) => f !== 'notifications') }),
    )
    renderApp('/settings/notifications')
    expect(await screen.findByText(/WhatsApp & SMS/)).toBeInTheDocument()
    expect(api.callsTo('listTemplates')).toHaveLength(0)
  })
})
