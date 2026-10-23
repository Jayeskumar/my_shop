import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CustomerOutstandingQuerySchema,
  SalesSummaryQuerySchema,
  reportDatePresetRange,
} from '@kadai/shared/api/reports'
import { todayIn } from '@kadai/shared/fy'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { salesSummaryFixture } from '../testing/fixtures'
import { createReportsApi, json } from '../testing/handlers'

/** The first render loads the lazy route module (slow on a busy machine). */
const FIRST_PAINT = { timeout: 8_000 }

function setup(replies: Parameters<typeof createReportsApi>[0] = {}) {
  const api = createReportsApi(replies)
  server.use(...api.handlers)
  return api
}

const today = todayIn('Asia/Kolkata')
const thisMonth = reportDatePresetRange('this_month', today, 4)

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:report')
  URL.revokeObjectURL = vi.fn()
})

describe('Generic report viewer', () => {
  it('asks for this month, grouped by day, and shows rows with the totals row', async () => {
    const api = setup()
    await signIn(makeMe())
    renderApp('/reports/sales-summary')
    const table = await screen.findByRole('table', { name: 'Sales summary' }, FIRST_PAINT)
    expect(within(table).getByRole('columnheader', { name: /Day/ })).toBeInTheDocument()
    expect(await within(table).findByText('01-10-2026')).toBeInTheDocument()
    expect(within(table).getByText('Total')).toBeInTheDocument()
    expect(within(table).getByText('₹6,46,629.90')).toBeInTheDocument()

    const query = api.callsTo('salesSummary')[0]!.query
    expect(query.get('from')).toBe(thisMonth.from)
    expect(query.get('to')).toBe(thisMonth.to)
    expect(query.get('group_by')).toBe('day')
    expect(query.get('sort')).toBe('group')
    expect(query.get('limit')).toBe('100')
    expect(query.get('offset')).toBe('0')
    // "All stores" is the default for an owner of two stores: no store filter is sent.
    expect(query.get('store_id')).toBeNull()
    expect(SalesSummaryQuerySchema.safeParse(Object.fromEntries(query)).success).toBe(true)
  })

  it('changes the grouping, sorts on a column and remembers the choice for next time', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    const first = renderApp('/reports/sales-summary')
    const table = await screen.findByRole('table', { name: 'Sales summary' }, FIRST_PAINT)

    await user.click(screen.getByRole('combobox', { name: 'Group by' }))
    await user.click(await screen.findByRole('option', { name: 'Month' }))
    await waitFor(() =>
      expect(api.callsTo('salesSummary').at(-1)!.query.get('group_by')).toBe('month'),
    )
    expect(within(table).getByRole('columnheader', { name: /Month/ })).toBeInTheDocument()

    await user.click(within(table).getByRole('button', { name: /Net sales/ }))
    await waitFor(() =>
      expect(api.callsTo('salesSummary').at(-1)!.query.get('sort')).toBe('-net_sales_paise'),
    )

    first.unmount()
    const before = api.callsTo('salesSummary').length
    renderApp('/reports/sales-summary')
    await screen.findByRole('table', { name: 'Sales summary' }, FIRST_PAINT)
    await waitFor(() => expect(api.callsTo('salesSummary').length).toBeGreaterThan(before))
    const again = api.callsTo('salesSummary')[before]!.query
    expect(again.get('group_by')).toBe('month')
    expect(again.get('sort')).toBe('-net_sales_paise')
  })

  it('pages through long reports', async () => {
    const page = salesSummaryFixture()
    const api = setup({
      salesSummary: (call) =>
        json({
          ...page,
          page: { limit: 100, offset: Number(call.query.get('offset') ?? 0), total: 250 },
        }),
    })
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/reports/sales-summary')
    await screen.findByRole('table', { name: 'Sales summary' }, FIRST_PAINT)
    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(api.callsTo('salesSummary').at(-1)!.query.get('offset')).toBe('100'))
  })

  it('takes filters from a link (dashboard → overdue customers)', async () => {
    const api = setup()
    await signIn(makeMe())
    renderApp('/reports/customer-outstanding?overdue_only=true')
    const table = await screen.findByRole('table', { name: 'Customer dues (ageing)' }, FIRST_PAINT)
    expect(await within(table).findByRole('link', { name: 'Lakshmi Stores' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/parties\/customers\//),
    )
    const query = api.callsTo('customerOutstanding')[0]!.query
    expect(query.get('overdue_only')).toBe('true')
    expect(query.get('from')).toBeNull()
    expect(CustomerOutstandingQuerySchema.safeParse(Object.fromEntries(query)).success).toBe(true)
  })

  it('exports the whole report as CSV for users who may export', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/reports/sales-summary')
    await screen.findByRole('table', { name: 'Sales summary' }, FIRST_PAINT)
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() =>
      expect(api.callsTo('salesSummary').some((c) => c.query.get('format') === 'csv')).toBe(true),
    )
    const csv = api.callsTo('salesSummary').find((c) => c.query.get('format') === 'csv')!
    expect(csv.query.get('from')).toBe(thisMonth.from)
    expect(csv.query.get('group_by')).toBe('day')
    expect(csv.query.get('limit')).toBeNull()
    expect(csv.query.get('offset')).toBeNull()
  })

  it('hides CSV export from members without data.export', async () => {
    setup()
    await signIn(makeMe({ permissions: ['reports.read'] }))
    renderApp('/reports/sales-summary')
    await screen.findByRole('table', { name: 'Sales summary' }, FIRST_PAINT)
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument()
  })

  it('explains the upgrade for a report outside the plan and does not call it', async () => {
    const api = setup()
    await signIn(makeMe())
    renderApp('/reports/profit')
    expect(
      await screen.findByText('Not included in your plan', {}, FIRST_PAINT),
    ).toBeInTheDocument()
    expect(api.callsTo('profit')).toHaveLength(0)
  })

  it('treats pharmacy reports as missing for other shops and unknown keys as not found', async () => {
    setup()
    await signIn(makeMe())
    renderApp('/reports/h1-register')
    expect(await screen.findByText('Page not found', {}, FIRST_PAINT)).toBeInTheDocument()
  })
})
