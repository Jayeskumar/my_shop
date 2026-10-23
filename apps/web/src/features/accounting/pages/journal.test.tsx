import {
  type JournalReverse,
  type ManualJournalCreate,
  ManualJournalCreateSchema,
  accountingRoutes as r,
} from '@kadai/shared/api/accounting'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { type AccountingRouteKey, type Reply, createAccountingApi } from '../testing/handlers'
import { PRELOAD_TIMEOUT_MS, preloadAccountingPages } from '../testing/preload'

beforeAll(preloadAccountingPages, PRELOAD_TIMEOUT_MS)

type User = ReturnType<typeof userEvent.setup>

function setup(replies: Partial<Record<AccountingRouteKey, Reply>> = {}) {
  const api = createAccountingApi(replies)
  server.use(...api.handlers)
  return api
}

async function pickAccount(user: User, scope: HTMLElement, line: number, name: RegExp) {
  await user.click(within(scope).getByRole('combobox', { name: `Account of line ${line}` }))
  await user.click(await screen.findByRole('option', { name }))
}

describe('Journal entries', () => {
  it('lists every posting and filters by type, reversals and search', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/journal')
    const table = await screen.findByRole('table', { name: 'Journal entries' })
    expect(await within(table).findByText('JVS1/2627/00002')).toBeInTheDocument()
    expect(within(table).getByText('EXPS1/2627/00012')).toBeInTheDocument()
    expect(screen.getByText('2 entries · ₹8,840.00')).toBeInTheDocument()

    const last = () => api.callsTo(r.listJournalEntries).at(-1)!.query
    expect(last().get('sort')).toBe('-entry_date')
    await user.click(screen.getByRole('combobox', { name: 'Type' }))
    await user.click(await screen.findByRole('option', { name: 'Expense' }))
    await waitFor(() => expect(last().getAll('source_type')).toEqual(['expense']))
    await user.click(screen.getByRole('combobox', { name: 'Reversals' }))
    await user.click(await screen.findByRole('option', { name: 'Hide reversed' }))
    await waitFor(() => expect(last().get('reversals')).toBe('false'))
    await user.type(screen.getByRole('searchbox'), 'JVS1{Enter}')
    await waitFor(() => expect(last().get('q')).toBe('JVS1'))
  })

  it('posts a balanced manual journal: live balance, add-line prefill and the contract body', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/journal')
    await screen.findByRole('table', { name: 'Journal entries' })
    await user.click(screen.getByRole('button', { name: /New journal entry/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New journal entry' })
    const balance = within(dialog).getByTestId('journal-balance')
    expect(balance).toHaveTextContent('Enter debit and credit amounts')

    await user.type(within(dialog).getByRole('textbox', { name: /Narration/ }), 'Cash from bank')
    await pickAccount(user, dialog, 1, /1100 · Cash in hand/)
    await user.type(within(dialog).getByLabelText('Debit of line 1'), '5000')
    await pickAccount(user, dialog, 2, /1200 · Bank account/)
    await user.type(within(dialog).getByLabelText('Credit of line 2'), '4000')
    expect(balance).toHaveTextContent('Difference ₹1,000.00')

    // Unbalanced: nothing is sent.
    await user.click(within(dialog).getByRole('button', { name: 'Save entry' }))
    expect(
      await within(dialog).findByText('Total debit and total credit must be equal'),
    ).toBeInTheDocument()
    expect(api.callsTo(r.createJournalEntry)).toHaveLength(0)

    // "Add line" pre-fills what balances the entry.
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }))
    expect(within(dialog).getByLabelText('Credit of line 3')).toHaveValue('1,000.00')
    expect(balance).toHaveTextContent('Balanced')
    await user.click(within(dialog).getByRole('button', { name: 'Remove line 3' }))
    const credit2 = within(dialog).getByLabelText('Credit of line 2')
    await user.clear(credit2)
    await user.type(credit2, '5000')
    expect(balance).toHaveTextContent('Balanced')

    await user.click(within(dialog).getByRole('button', { name: 'Save entry' }))
    await waitFor(() => expect(api.callsTo(r.createJournalEntry)).toHaveLength(1))
    const call = api.callsTo(r.createJournalEntry)[0]!
    const body = call.body as ManualJournalCreate
    expect(ManualJournalCreateSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({ narration: 'Cash from bank', store_id: F.STORE_ID })
    expect(body.lines).toEqual([
      { account_id: F.A.cash, debit_paise: 500_000, credit_paise: 0, memo: null },
      { account_id: F.A.bank, debit_paise: 0, credit_paise: 500_000, memo: null },
    ])
    expect(call.headers.get('Idempotency-Key')).toBe(body.client_ref)
    expect(await screen.findByText('Journal entry JVS1/2627/00003 saved')).toBeInTheDocument()
  })

  it('asks for the customer on a receivable line', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/journal')
    await user.click(await screen.findByRole('button', { name: /New journal entry/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New journal entry' })
    await pickAccount(user, dialog, 1, /1300 · Accounts receivable/)
    expect(within(dialog).getByRole('combobox', { name: /Customer/ })).toBeInTheDocument()
    await pickAccount(user, dialog, 1, /4300 · Other income/)
    expect(within(dialog).queryByRole('combobox', { name: /Customer/ })).toBeNull()
    expect(api.callsTo(r.createJournalEntry)).toHaveLength(0)
  })

  it('reverses a manual entry once with a reason', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/accounting/journal?id=${F.JV_ID}`)
    const drawer = await screen.findByRole('dialog', { name: 'JVS1/2627/00002' })
    await user.click(await within(drawer).findByRole('button', { name: 'Reverse entry' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reverse JVS1/2627/00002?' })
    await user.click(within(dialog).getByRole('button', { name: 'Reverse' }))
    expect(await within(dialog).findByText('Please write a reason')).toBeInTheDocument()
    expect(api.callsTo(r.reverseJournalEntry)).toHaveLength(0)
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Posted to wrong bank')
    await user.click(within(dialog).getByRole('button', { name: 'Reverse' }))
    await waitFor(() => expect(api.callsTo(r.reverseJournalEntry)).toHaveLength(1))
    const call = api.callsTo(r.reverseJournalEntry)[0]!
    expect(call.path).toBe(`/api/v1/journal-entries/${F.JV_ID}/reverse`)
    const body = call.body as JournalReverse
    expect(body.reason).toBe('Posted to wrong bank')
    expect(body.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await screen.findByText('Reversal JVS1/2627/00004 posted')).toBeInTheDocument()
  })

  it('shows read-only books to members without accounting.write', async () => {
    setup()
    await signIn(makeMe({ permissions: ['accounting.read'] }))
    renderApp(`/accounting/journal?id=${F.JV_ID}`)
    const drawer = await screen.findByRole('dialog', { name: 'JVS1/2627/00002' })
    expect(await within(drawer).findByText('1100 · Cash in hand')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Reverse entry' })).toBeNull()
    expect(screen.queryByRole('button', { name: /New journal entry/ })).toBeNull()
  })
})
