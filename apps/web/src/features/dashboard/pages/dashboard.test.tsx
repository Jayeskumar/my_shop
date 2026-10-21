import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardQuerySchema } from '@kadai/shared/api/reports'
import { addDays, todayIn } from '@kadai/shared/fy'
import { IDS, makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { FIX_IDS, emptyDashboardFixture } from '@/features/reports/testing/fixtures'
import { createReportsApi, json } from '@/features/reports/testing/handlers'

const FIRST_PAINT = { timeout: 8_000 }
const today = todayIn('Asia/Kolkata')

function setup(replies: Parameters<typeof createReportsApi>[0] = {}) {
  const api = createReportsApi(replies)
  server.use(...api.handlers)
  return api
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Dashboard', () => {
  it('greets the owner and shows today against yesterday for all stores', async () => {
    const api = setup()
    await signIn(makeMe())
    renderApp('/')
    expect(
      await screen.findByRole('heading', { name: 'Sri Murugan Stores' }, FIRST_PAINT),
    ).toBeInTheDocument()
    expect(screen.getByText(/Good (morning|afternoon|evening), Murugan/)).toBeInTheDocument()

    const kpis = await screen.findByRole('region', { name: 'Key figures' })
    expect(await within(kpis).findByText('₹45,546')).toBeInTheDocument()
    expect(within(kpis).getByText('−11.04%')).toBeInTheDocument()
    expect(within(kpis).getByText('Margin 14.12% (−0.5 pts)')).toBeInTheDocument()

    const query = api.callsTo('dashboard')[0]!.query
    expect(query.get('store_id')).toBeNull()
    expect(query.get('date')).toBeNull()
    expect(DashboardQuerySchema.safeParse(Object.fromEntries(query)).success).toBe(true)

    // Alerts link into the modules that fix them.
    const alerts = screen.getByRole('region', { name: 'Things to look at' })
    expect(within(alerts).getByRole('link', { name: /Low stock/ })).toHaveAttribute(
      'href',
      '/inventory/stock?filter=low',
    )
    expect(within(alerts).getByRole('link', { name: /Expiring in 30 days/ })).toHaveAttribute(
      'href',
      '/reports/expiry?days=30&include_expired=false',
    )
    expect(within(alerts).getByRole('link', { name: /UPI to check/ })).toHaveAttribute(
      'href',
      '/payments/upi?tab=unapplied',
    )
    expect(within(alerts).getByRole('link', { name: /Counter A · Priya/ })).toHaveAttribute(
      'href',
      `/accounting/shifts/${FIX_IDS.shift}`,
    )

    const actions = screen.getByRole('navigation', { name: 'Quick actions' })
    expect(within(actions).getByRole('link', { name: /New bill/ })).toHaveAttribute('href', '/pos')
    expect(within(actions).getByRole('link', { name: /Receive payment/ })).toHaveAttribute(
      'href',
      '/payments?new=receive',
    )
  })

  it('filters by store and steps back a day', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/')
    await screen.findByRole('region', { name: 'Key figures' }, FIRST_PAINT)

    await user.click(screen.getByRole('combobox', { name: 'Store' }))
    await user.click(await screen.findByRole('option', { name: /Anna Nagar/ }))
    await waitFor(() =>
      expect(api.callsTo('dashboard').at(-1)!.query.get('store_id')).toBe(IDS.store2),
    )

    await user.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() =>
      expect(api.callsTo('dashboard').at(-1)!.query.get('date')).toBe(addDays(today, -1)),
    )
    expect(api.callsTo('dashboard').at(-1)!.query.get('store_id')).toBe(IDS.store2)
    expect(screen.getAllByText('vs previous day').length).toBeGreaterThan(0)
  })

  it('sends a WhatsApp due reminder in one tap, or opens wa.me when the customer has not opted in', async () => {
    const api = setup()
    const user = userEvent.setup()
    const popup = { opener: {}, location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await signIn(makeMe())
    renderApp('/')
    const dues = await screen.findByRole(
      'list',
      { name: 'Customers with the biggest dues' },
      FIRST_PAINT,
    )

    await user.click(within(dues).getByRole('button', { name: /reminder to Lakshmi Stores/ }))
    await waitFor(() => expect(api.callsTo('remindCustomer')).toHaveLength(1))
    const first = api.callsTo('remindCustomer')[0]!
    expect(first.params.id).toBe(FIX_IDS.lakshmi)
    expect(first.body).toEqual({ channel: 'whatsapp', include_payment_link: true })
    expect(
      await screen.findByText('Reminder sent to Lakshmi Stores on WhatsApp'),
    ).toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()

    await user.click(within(dues).getByRole('button', { name: /reminder to Selvam K/ }))
    await waitFor(() => expect(api.callsTo('remindCustomer')).toHaveLength(2))
    expect(api.callsTo('remindCustomer')[1]!.body).toEqual({
      channel: 'wa_me',
      include_payment_link: true,
    })
    await waitFor(() =>
      expect(popup.location.href).toBe('https://wa.me/919790054321?text=Vanakkam'),
    )
    // Customers without a phone get no reminder button.
    expect(within(dues).queryByRole('button', { name: /Ramesh Tea Stall/ })).not.toBeInTheDocument()
  })

  it('teaches what will appear before the first bill of the day', async () => {
    setup({ dashboard: () => json({ data: emptyDashboardFixture() }) })
    await signIn(makeMe())
    renderApp('/')
    expect(await screen.findByText('No bills yet', {}, FIRST_PAINT)).toBeInTheDocument()
    expect(screen.getByText('Nothing sold yet')).toBeInTheDocument()
    expect(screen.getByText('No dues pending')).toBeInTheDocument()
    expect(screen.queryByText('No sales in the last 30 days')).not.toBeInTheDocument()
  })

  it('shows a brand-new shop an empty trend instead of a flat ₹0 chart', async () => {
    const fresh = emptyDashboardFixture()
    const trend = fresh.trend.map((d) => ({
      ...d,
      net_sales_paise: 0,
      gross_profit_paise: 0,
      bills: 0,
    }))
    setup({ dashboard: () => json({ data: { ...fresh, trend } }) })
    await signIn(makeMe())
    renderApp('/')
    expect(
      await screen.findByText('No sales in the last 30 days', {}, FIRST_PAINT),
    ).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Daily net sales/ })).not.toBeInTheDocument()
  })

  it('gives a cashier without report access only the greeting and their quick actions', async () => {
    const api = setup()
    await signIn(makeMe({ permissions: ['pos.use', 'sales.read', 'sales.create'] }))
    renderApp('/')
    expect(
      await screen.findByText(/Sales figures are visible to the owner/, {}, FIRST_PAINT),
    ).toBeInTheDocument()
    const actions = screen.getByRole('navigation', { name: 'Quick actions' })
    expect(within(actions).getAllByRole('link')).toHaveLength(1)
    expect(within(actions).getByRole('link', { name: /New bill/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Key figures' })).not.toBeInTheDocument()
    expect(api.callsTo('dashboard')).toHaveLength(0)
  })
})
