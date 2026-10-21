import {
  type AccountCreate,
  type AccountUpdate,
  accountingRoutes as r,
  comparisonRange,
} from '@kadai/shared/api/accounting'
import { fyOf, fyRange, todayIn } from '@kadai/shared/fy'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { IDS, makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { type AccountingRouteKey, type Reply, createAccountingApi } from '../testing/handlers'
import { PRELOAD_TIMEOUT_MS, preloadAccountingPages } from '../testing/preload'

beforeAll(preloadAccountingPages, PRELOAD_TIMEOUT_MS)

function setup(replies: Partial<Record<AccountingRouteKey, Reply>> = {}) {
  const api = createAccountingApi(replies)
  server.use(...api.handlers)
  return api
}

const today = () => todayIn('Asia/Kolkata')
const fyStart = () => fyRange(fyOf(today(), 4), 4).from

describe('Financial statements', () => {
  it('shows the profit & loss for this financial year and compares with the previous period', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/statements')
    const table = await screen.findByRole('table', { name: 'Profit & loss' })
    expect(within(table).getByText('Gross profit')).toBeInTheDocument()
    expect(within(table).getByText('Net profit')).toBeInTheDocument()
    expect(within(table).getAllByText('₹7,160.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Margin 7.31%').length).toBeGreaterThan(0)
    // Accounts open their ledger for the same period.
    expect(within(table).getByRole('link', { name: 'Rent' })).toHaveAttribute(
      'href',
      `/accounting/ledgers?account=${F.A.rent}&from=${fyStart()}&to=${today()}`,
    )
    const first = api.callsTo(r.profitLoss)[0]!.query
    expect(first.get('from')).toBe(fyStart())
    expect(first.get('to')).toBe(today())
    expect(first.get('compare_from')).toBeNull()

    await user.click(screen.getByRole('combobox', { name: 'Compare with' }))
    await user.click(await screen.findByRole('option', { name: 'Previous period' }))
    const range = comparisonRange(fyStart(), today(), 'previous_period')
    await waitFor(() => {
      const q = api.callsTo(r.profitLoss).at(-1)!.query
      expect(q.get('compare_from')).toBe(range.from)
      expect(q.get('compare_to')).toBe(range.to)
    })
    expect(await screen.findByRole('columnheader', { name: 'Compared' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Change' })).toBeInTheDocument()
  })

  it('filters the profit & loss by store', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/statements')
    await screen.findByRole('table', { name: 'Profit & loss' })
    await user.click(screen.getByRole('combobox', { name: 'Store' }))
    await user.click(await screen.findByRole('option', { name: /Anna Nagar/ }))
    await waitFor(() =>
      expect(api.callsTo(r.profitLoss).at(-1)!.query.get('store_id')).toBe(IDS.store2),
    )
  })

  it('shows the balance sheet with the A = L + E check and the trial balance totals', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/statements?tab=bs')
    expect(await screen.findByText('Assets equal liabilities + capital.')).toBeInTheDocument()
    expect(screen.getAllByText('₹82,160.00').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Profit for the year so far')).toBeInTheDocument()
    expect(api.callsTo(r.balanceSheet)[0]!.query.get('as_of')).toBe(today())

    await user.click(screen.getByRole('tab', { name: 'Trial balance' }))
    const tb = await screen.findByRole('table', { name: 'Trial balance' })
    expect(within(tb).getAllByText('₹1,48,000.00')).toHaveLength(2)
    expect(screen.getByText('Debit and credit totals agree.')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Show accounts with zero balance' }))
    await waitFor(() =>
      expect(api.callsTo(r.trialBalance).at(-1)!.query.get('include_zero')).toBe('true'),
    )
  })

  it('explains that the balance sheet needs access to every store', async () => {
    const api = setup()
    const me = makeMe()
    await signIn({ ...me, membership: { ...me.membership, store_ids: [IDS.store] } })
    renderApp('/accounting/statements?tab=bs')
    expect(await screen.findByText(/Your access is limited to some stores/)).toBeInTheDocument()
    expect(api.callsTo(r.balanceSheet)).toHaveLength(0)
  })
})

describe('Chart of accounts', () => {
  it('shows the tree with roll-up balances and filters it by search', async () => {
    setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/accounts')
    const expenses = await screen.findByRole('region', { name: 'Expenses' })
    // Rent rolls up its custom child Godown rent (₹15,000 + ₹6,000).
    const rent = within(expenses).getByRole('link', { name: 'Rent' }).closest('li')!
    expect(within(rent).getByText('₹21,000.00 Dr')).toBeInTheDocument()
    expect(within(expenses).getByRole('link', { name: 'Godown rent' })).toBeInTheDocument()
    await user.click(within(expenses).getByRole('button', { name: 'Hide accounts under Rent' }))
    expect(within(expenses).queryByRole('link', { name: 'Godown rent' })).toBeNull()

    await user.type(screen.getByRole('searchbox'), 'electric')
    await waitFor(() => expect(within(expenses).queryByRole('link', { name: 'Rent' })).toBeNull())
    expect(within(expenses).getByRole('link', { name: 'Electricity' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Assets' })).toBeNull()
  })

  it('adds a custom expense head with the contract body', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/accounts')
    await screen.findByRole('region', { name: 'Expenses' })
    await user.click(screen.getByRole('button', { name: 'Add account' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add account' })
    // The code is suggested from the chart (next free multiple of 10 after 5390).
    expect(within(dialog).getByText('Leave empty to use 5400')).toBeInTheDocument()
    await user.type(
      within(dialog).getByRole('textbox', { name: /^Name(?! in Tamil)/ }),
      'Generator diesel',
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: /Name in Tamil/ }),
      'ஜெனரேட்டர் டீசல்',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }))
    await waitFor(() => expect(api.callsTo(r.createAccount)).toHaveLength(1))
    expect(api.callsTo(r.createAccount)[0]!.body as AccountCreate).toEqual({
      name: 'Generator diesel',
      name_ta: 'ஜெனரேட்டர் டீசல்',
      type: 'expense',
      parent_id: null,
      store_id: null,
    })
    expect(await screen.findByText('Account Generator diesel added')).toBeInTheDocument()
  })

  it('renames a built-in account with a stale-write guard', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/accounts')
    await screen.findByRole('region', { name: 'Expenses' })
    await user.click(screen.getByRole('button', { name: 'Edit Rent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit account' })
    const name = await within(dialog).findByRole('textbox', { name: /^Name(?! in Tamil)/ })
    await waitFor(() => expect(name).toHaveValue('Rent'))
    // Built-in: only names and bank details can change.
    expect(within(dialog).queryByRole('button', { name: 'Deactivate' })).toBeNull()
    await user.clear(name)
    await user.type(name, 'Shop rent')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.callsTo(r.updateAccount)).toHaveLength(1))
    const call = api.callsTo(r.updateAccount)[0]!
    expect(call.path).toBe(`/api/v1/accounts/${F.A.rent}`)
    expect(call.body as AccountUpdate).toEqual({ name: 'Shop rent', if_updated_at: F.NOW })
  })

  it('is read-only without accounting.write', async () => {
    setup()
    await signIn(makeMe({ permissions: ['accounting.read'] }))
    renderApp('/accounting/accounts')
    await screen.findByRole('region', { name: 'Expenses' })
    expect(screen.queryByRole('button', { name: 'Add account' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Rent' })).toBeNull()
  })
})
