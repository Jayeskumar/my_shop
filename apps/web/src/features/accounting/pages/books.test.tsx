import { accountingRoutes as r } from '@kadai/shared/api/accounting'
import { addDays, todayIn } from '@kadai/shared/fy'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PrintModule from '@/lib/print'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { type AccountingRouteKey, type Reply, createAccountingApi } from '../testing/handlers'
import { PRELOAD_TIMEOUT_MS, preloadAccountingPages } from '../testing/preload'

const printHtml = vi.hoisted(() => vi.fn((_html: string, _options: unknown) => Promise.resolve()))
vi.mock('@/lib/print', async (importOriginal) => ({
  ...(await importOriginal<typeof PrintModule>()),
  printHtml,
}))

beforeAll(preloadAccountingPages, PRELOAD_TIMEOUT_MS)

function setup(replies: Partial<Record<AccountingRouteKey, Reply>> = {}) {
  const api = createAccountingApi(replies)
  server.use(...api.handlers)
  return api
}

const today = () => todayIn('Asia/Kolkata')

describe('Day book', () => {
  it('shows the day with source links and totals, and steps through days and types', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    const { router } = renderApp('/accounting/day-book')

    expect(await screen.findByText('Cash withdrawn from bank for change')).toBeInTheDocument()
    expect(api.callsTo(r.dayBook)[0]!.query.get('date')).toBe(today())
    // Totals of the day and the source document link of the expense entry.
    expect(screen.getAllByText('₹8,840.00')).toHaveLength(2)
    const link = screen.getByRole('link', { name: 'EXPS1/2627/00012' })
    expect(link).toHaveAttribute('href', `/accounting/expenses?id=${F.EXPENSE_ID}`)

    const last = () => api.callsTo(r.dayBook).at(-1)!.query
    await user.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(last().get('date')).toBe(addDays(today(), -1)))
    expect(router.state.location.search).toContain(`date=${addDays(today(), -1)}`)

    const types = screen.getByRole('group', { name: 'Entries by type' })
    await user.click(within(types).getByRole('button', { name: /^Expense/ }))
    await waitFor(() => expect(last().getAll('source_type')).toEqual(['expense']))

    // Today is the latest day: "Next day" comes back to it and then stops.
    await user.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(last().get('date')).toBe(today()))
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled()
  })

  it('opens an entry in the journal drawer', async () => {
    setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/day-book')
    await screen.findByText('Cash withdrawn from bank for change')
    await user.click(screen.getAllByRole('button', { name: 'View' })[0]!)
    const drawer = await screen.findByRole('dialog', { name: 'JVS1/2627/00002' })
    expect(await within(drawer).findByText('1200 · Bank account')).toBeInTheDocument()
  })
})

describe('Ledgers', () => {
  const createObjectURL = URL.createObjectURL
  const revokeObjectURL = URL.revokeObjectURL
  beforeEach(() => {
    URL.createObjectURL = () => 'blob:ledger'
    URL.revokeObjectURL = () => {}
  })
  afterEach(() => {
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  })

  it('opens on the cash book with opening, running balance and closing', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/ledgers')
    const table = await screen.findByRole('table', { name: '1100 · Cash in hand' })
    expect(within(table).getByText('Opening balance')).toBeInTheDocument()
    expect(within(table).getByText('Closing balance')).toBeInTheDocument()
    expect(within(table).getByText('₹15,000.00 Dr')).toBeInTheDocument()
    expect(within(table).getAllByText('₹12,500.00 Dr').length).toBeGreaterThan(0)
    const first = api.callsTo(r.cashBook)[0]!.query
    expect(first.get('from')).toMatch(/^\d{4}-\d{2}-01$/)
    expect(first.get('to')).toBe(today())
    expect(first.get('account_id')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() =>
      expect(api.callsTo(r.cashBook).some((c) => c.query.get('format') === 'csv')).toBe(true),
    )
    const csv = api.callsTo(r.cashBook).find((c) => c.query.get('format') === 'csv')!.query
    // CSV streams the whole range: no page window.
    expect(csv.get('limit')).toBeNull()
    expect(csv.get('offset')).toBeNull()
  })

  it('switches to the customers’ dues ledger and narrows it to one customer', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/ledgers')
    await screen.findByRole('table', { name: '1100 · Cash in hand' })
    const shortcuts = screen.getByRole('group', { name: 'Quick ledgers' })
    await user.click(within(shortcuts).getByRole('button', { name: 'Customer dues' }))
    await waitFor(() => expect(api.callsTo(r.accountLedger)).toHaveLength(1))
    expect(api.callsTo(r.accountLedger)[0]!.path).toBe(`/api/v1/books/ledger/${F.A.receivable}`)
    expect(await screen.findByRole('combobox', { name: 'Customer' })).toBeInTheDocument()
    expect(
      await screen.findByRole('table', { name: /1300 · Accounts receivable/ }),
    ).toBeInTheDocument()
  })

  it('reads a bank ledger as a cash book with the account', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/ledgers')
    await screen.findByRole('table', { name: '1100 · Cash in hand' })
    const shortcuts = screen.getByRole('group', { name: 'Quick ledgers' })
    await user.click(within(shortcuts).getByRole('button', { name: 'Bank account' }))
    await waitFor(() =>
      expect(api.callsTo(r.cashBook).at(-1)!.query.get('account_id')).toBe(F.A.bank),
    )
    expect(await screen.findByRole('table', { name: '1200 · Bank account' })).toBeInTheDocument()
  })
})

describe('Print', () => {
  it('prints the day book as an A4 table', async () => {
    printHtml.mockClear()
    setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/day-book')
    await screen.findByText('Cash withdrawn from bank for change')
    await user.click(screen.getByRole('button', { name: 'Print' }))
    await waitFor(() => expect(printHtml).toHaveBeenCalled())
    const [html, options] = printHtml.mock.calls[0]!
    expect(options).toMatchObject({ paper: 'a4' })
    expect(html).toContain('Day book')
    expect(html).toContain('₹8,840.00')
  })
})
