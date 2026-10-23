import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvoiceListQuerySchema } from '@kadai/shared/api/sales'
import { todayIn } from '@kadai/shared/fy'
import { presetRange } from '@/lib/date-presets'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { INVOICE_ID } from '../testing/fixtures'
import { createSalesApi } from '../testing/handlers'

/** The first render loads the lazy route module (slow on a busy machine). */
const FIRST_PAINT = { timeout: 5_000 }

function setup(replies: Parameters<typeof createSalesApi>[0] = {}) {
  const api = createSalesApi(replies)
  server.use(...api.handlers)
  return api
}

const today = todayIn('Asia/Kolkata')

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:bills')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Sales invoices list', () => {
  it("shows today's bills with the totals of the whole range", async () => {
    const api = setup()
    await signIn(makeMe())
    renderApp('/sales/invoices')
    const table = await screen.findByRole('table', { name: 'Sales invoices' }, FIRST_PAINT)
    expect(await within(table).findByRole('link', { name: 'S1-A/2627/00412' })).toHaveAttribute(
      'href',
      `/sales/invoices/${INVOICE_ID}`,
    )
    expect(within(table).getAllByText('Lakshmi Stores')).toHaveLength(2)
    expect(within(table).getByText('Part paid')).toBeInTheDocument()
    expect(within(table).getByText('Offline')).toBeInTheDocument()
    const summary = screen.getByRole('region', { name: 'Totals for the selected period' })
    expect(within(summary).getByText('₹1,164.50')).toBeInTheDocument()
    expect(within(summary).getByText('₹310')).toBeInTheDocument()

    const query = api.callsTo('listInvoices')[0]!.query
    expect(query.get('from')).toBe(today)
    expect(query.get('to')).toBe(today)
    expect(query.get('sort')).toBe('-invoice_at')
    expect(query.get('limit')).toBe('50')
    expect(query.get('doc_type')).toBeNull()
    expect(InvoiceListQuerySchema.safeParse(Object.fromEntries(query)).success).toBe(true)
  })

  it('searches by bill number / customer and filters by status', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/sales/invoices')
    await screen.findByRole('table', { name: 'Sales invoices' }, FIRST_PAINT)
    await user.type(screen.getByRole('searchbox', { name: /Bill number/ }), '00412{Enter}')
    await waitFor(() => expect(api.callsTo('listInvoices').at(-1)!.query.get('q')).toBe('00412'))

    await user.click(screen.getByRole('button', { name: 'Filters' }))
    const sheet = await screen.findByRole('dialog', { name: 'Filters' })
    await user.click(within(sheet).getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: 'Cancelled' }))
    await waitFor(() => {
      const q = api.callsTo('listInvoices').at(-1)!.query
      expect(q.getAll('status')).toEqual(['cancelled'])
      expect(q.get('q')).toBe('00412')
    })
    await user.click(within(sheet).getByRole('combobox', { name: 'Payment' }))
    await user.click(await screen.findByRole('option', { name: 'With due' }))
    await waitFor(() =>
      expect(api.callsTo('listInvoices').at(-1)!.query.get('has_due')).toBe('true'),
    )
    await user.click(within(sheet).getByRole('button', { name: 'Show results' }))

    // Active filters show as removable chips.
    const chips = screen.getByRole('list', { name: 'Active filters' })
    await user.click(within(chips).getByRole('button', { name: /Cancelled/ }))
    await waitFor(() =>
      expect(api.callsTo('listInvoices').at(-1)!.query.getAll('status')).toEqual([]),
    )
  })

  it('exports the filtered list as CSV for users who may export', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/sales/invoices')
    await screen.findByRole('table', { name: 'Sales invoices' }, FIRST_PAINT)
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() =>
      expect(api.callsTo('listInvoices').some((c) => c.query.get('format') === 'csv')).toBe(true),
    )
    const csv = api.callsTo('listInvoices').find((c) => c.query.get('format') === 'csv')!
    expect(csv.query.get('from')).toBe(today)
    expect(csv.query.get('limit')).toBeNull()
  })

  it('hides export and billing for a cashier who can only view bills', async () => {
    setup()
    await signIn(makeMe({ permissions: ['sales.read'] }))
    renderApp('/sales/invoices')
    await screen.findByRole('table', { name: 'Sales invoices' }, FIRST_PAINT)
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open billing' })).not.toBeInTheDocument()
  })

  it('teaches what to do when there are no bills today', async () => {
    const api = setup({
      listInvoices: () =>
        Response.json({
          data: [],
          page: { limit: 50, offset: 0, total: 0 },
          summary: {
            count: 0,
            total_paise: 0,
            paid_paise: 0,
            due_paise: 0,
            returned_paise: 0,
            taxable_paise: 0,
            tax_paise: 0,
          },
        }),
    })
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/sales/invoices')
    expect(await screen.findByText('No bills yet today')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Open billing' })[0]).toHaveAttribute('href', '/pos')
    await user.click(screen.getByRole('button', { name: 'Show this month' }))
    const month = presetRange('this_month', { timezone: 'Asia/Kolkata' })
    await waitFor(() => {
      const q = api.callsTo('listInvoices').at(-1)!.query
      expect([q.get('from'), q.get('to')]).toEqual([month.from, month.to])
    })
  })
})
