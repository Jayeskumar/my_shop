import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { NotificationListQuerySchema } from '@kadai/shared/api/notifications'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { makeMe } from '@/test/fixtures'
import { errorResponse, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createNotificationsApi } from '../testing/handlers'

function setup(replies: Parameters<typeof createNotificationsApi>[0] = {}) {
  const api = createNotificationsApi(replies)
  server.use(...api.handlers)
  return api
}

/** The table once its rows (not the loading skeleton) are shown. */
async function loadedTable() {
  const table = await screen.findByRole('table', { name: 'Message log' })
  await within(table).findAllByText(/லட்சுமி|Priya/)
  return table
}

function lastListQuery(api: ReturnType<typeof setup>) {
  const calls = api.callsTo('listNotifications')
  const q = calls[calls.length - 1]!.query
  // What the server would parse (repeated keys → arrays, sort → {field, direction}).
  const raw: Record<string, string | string[]> = {}
  for (const key of new Set(q.keys())) {
    const all = q.getAll(key)
    raw[key] = all.length > 1 ? all : all[0]!
  }
  return NotificationListQuerySchema.parse(raw)
}

describe('Message log (/notifications)', () => {
  it('lists messages with channel, status chips and the reason of failures', async () => {
    const api = setup()
    await signIn()
    renderApp('/notifications')

    const table = await loadedTable()
    expect(within(table).getAllByRole('row')).toHaveLength(7) // header + 6
    expect(within(table).getByText('Delivered')).toBeInTheDocument()
    expect(within(table).getByText('Read')).toBeInTheDocument()
    // The failure reason travels with the chip (tooltip + screen-reader text).
    expect(within(table).getByText(/Invalid number or address/)).toBeInTheDocument()
    expect(within(table).getByText(/Customer opted out of WhatsApp/)).toBeInTheDocument()
    // OTP texts are never shown.
    expect(within(table).getByText('Hidden for security')).toBeInTheDocument()
    // Status tabs carry the facet counts.
    expect(screen.getByRole('tab', { name: /Failed\s*1/ })).toBeInTheDocument()
    expect(screen.getByText(/1 message could not be sent/)).toBeInTheDocument()

    const q = lastListQuery(api)
    expect(q).toMatchObject({
      limit: 50,
      offset: 0,
      sort: { field: 'created_at', direction: 'desc' },
    })
    expect(q.status).toBeUndefined()
  })

  it('filters by status tab, channel and search through the list query', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/notifications')
    await loadedTable()

    await user.click(screen.getByRole('tab', { name: /Waiting/ }))
    await waitFor(() => expect(lastListQuery(api).status).toEqual(['queued', 'sending']))

    await user.click(screen.getByRole('combobox', { name: 'Channel' }))
    await user.click(await screen.findByRole('option', { name: /SMS/ }))
    await waitFor(() => expect(lastListQuery(api).channel).toEqual(['sms']))

    await user.type(screen.getByRole('searchbox'), '98430{Enter}')
    await waitFor(() => expect(lastListQuery(api).q).toBe('98430'))
    // Changing a filter keeps the others and starts from the first page.
    const q = lastListQuery(api)
    expect(q).toMatchObject({ status: ['queued', 'sending'], channel: ['sms'], offset: 0 })

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => {
      const cleared = lastListQuery(api)
      expect(cleared.status).toBeUndefined()
      expect(cleared.channel).toBeUndefined()
      expect(cleared.q).toBeUndefined()
    })
  })

  it('pages through the list with offset', async () => {
    const rows = F.outboxRows()
    const api = setup({
      listNotifications: (c) =>
        HttpResponse.json(
          F.outboxList(rows, { total: 120, offset: Number(c.query.get('offset') ?? 0) }),
        ),
    })
    const user = userEvent.setup()
    await signIn()
    renderApp('/notifications')
    await loadedTable()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(lastListQuery(api).offset).toBe(50))
  })

  it('retries a failed message optimistically and confirms with a toast', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const api = setup({
      retryNotification: async () => {
        await gate
        return HttpResponse.json({
          data: {
            ...F.outboxRows()[1]!,
            status: 'queued',
            error: null,
            attempts: 0,
            can_retry: false,
          },
        })
      },
    })
    const user = userEvent.setup()
    await signIn()
    renderApp('/notifications')
    const table = await loadedTable()

    await user.click(within(table).getByRole('button', { name: 'Send again to கண்ணன்' }))
    // Optimistic: the row flips to "Queued" before the server answers.
    await waitFor(() =>
      expect(within(table).queryByText(/Invalid number or address/)).not.toBeInTheDocument(),
    )
    expect(api.callsTo('retryNotification')[0]!.params.id).toBe(F.nid(2))
    release()
    expect(await screen.findByText('Queued again — it will go out in a moment')).toBeInTheDocument()
  })

  it('rolls the row back and explains when the retry is refused', async () => {
    setup({
      retryNotification: () =>
        errorResponse(409, 'CONFLICT', 'not retryable', { reason: 'not_retryable' }),
    })
    const user = userEvent.setup()
    await signIn()
    renderApp('/notifications')
    const table = await loadedTable()
    await user.click(within(table).getByRole('button', { name: 'Send again to கண்ணன்' }))
    expect(
      await screen.findByText('Only failed or not-sent messages can be sent again'),
    ).toBeInTheDocument()
    expect(within(table).getByText(/Invalid number or address/)).toBeInTheDocument()
  })

  it('opens the detail drawer with the sent text, provider reference and linked bill', async () => {
    setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/notifications')
    const table = await loadedTable()
    await user.click(within(table).getAllByRole('row')[1]!)

    const drawer = await screen.findByRole('dialog', { name: 'Message details' })
    expect(within(drawer).getByTestId('detail-body')).toHaveTextContent('S1-A/2627/00042')
    expect(within(drawer).getByText(/wamid\.HBgM/)).toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: /Bill/ })).toHaveAttribute(
      'href',
      `/sales/invoices/${F.INVOICE_ID}`,
    )
  })

  it('tells a business without the plan feature that messages are not sent, without the settings link', async () => {
    setup()
    await signIn(
      makeMe({
        features: DEFAULT_PLAN_FEATURES.growth.filter((f) => f !== 'notifications'),
      }),
    )
    renderApp('/notifications')
    expect(await screen.findByText('WhatsApp & SMS are not in your plan')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Message settings' })).not.toBeInTheDocument()
  })

  it('warns when messages of a channel are only being recorded', async () => {
    setup()
    await signIn()
    renderApp('/notifications')
    expect(await screen.findByText('Some messages are only being recorded')).toBeInTheDocument()
    expect(screen.getByText(/SMS, Email sending is not set up/)).toBeInTheDocument()
  })

  it('is closed to members without settings.manage', async () => {
    const api = setup()
    await signIn(makeMe({ permissions: PERMISSION_CODES.filter((p) => p !== 'settings.manage') }))
    renderApp('/notifications')
    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument()
    expect(api.callsTo('listNotifications')).toHaveLength(0)
  })
})
