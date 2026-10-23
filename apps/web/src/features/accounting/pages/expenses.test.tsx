import {
  type AccountCreate,
  type ExpenseCancel,
  type ExpenseCreate,
  ExpenseCreateSchema,
  ExpenseListQuerySchema,
  accountingRoutes as r,
} from '@kadai/shared/api/accounting'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
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

const queryObject = (q: URLSearchParams): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(q.keys())) {
    const all = q.getAll(key)
    out[key] = all.length > 1 ? all : all[0]!
  }
  return out
}

async function openAddDialog(user: User) {
  await user.click(await screen.findByRole('button', { name: /Add expense/ }))
  const dialog = await screen.findByRole('dialog', { name: 'Add expense' })
  // The tiles appear once the expense heads are loaded.
  await within(dialog).findByRole('radio', { name: 'Electricity' })
  return dialog
}

describe('Expenses list', () => {
  it('shows the totals, the category chart and filters through the URL', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/expenses')

    const table = await screen.findByRole('table', { name: 'Expenses' })
    expect(await within(table).findByText('EXPS1/2627/00012 · EB bill — Sept/Oct')).toBeVisible()
    // The cancelled voucher stays listed with its status.
    expect(within(table).getByText('Cancelled')).toBeInTheDocument()
    // Totals of the whole filtered range come from the list summary.
    expect(screen.getByText('₹6,790.00')).toBeInTheDocument()
    expect(screen.getByText('2 expenses')).toBeInTheDocument()
    expect(screen.getAllByText('₹450.00').length).toBeGreaterThan(0)

    const first = api.callsTo(r.listExpenses)[0]!
    const parsed = ExpenseListQuerySchema.parse(queryObject(first.query))
    expect(parsed.sort).toEqual({ field: 'expense_date', direction: 'desc' })
    expect(parsed.limit).toBe(50)
    expect(parsed.from).toMatch(/^\d{4}-\d{2}-01$/)
    const last = () => api.callsTo(r.listExpenses).at(-1)!.query

    // Tapping a bar of the chart filters the list by that category.
    const chart = screen.getByRole('list', { name: 'Where the money went' })
    await user.click(within(chart).getByRole('button', { name: /^Electricity:/ }))
    await waitFor(() => expect(last().getAll('expense_account_id')).toEqual([F.A.electricity]))

    await user.click(screen.getByRole('combobox', { name: 'Paid via' }))
    await user.click(await screen.findByRole('option', { name: 'UPI' }))
    await waitFor(() => expect(last().getAll('payment_method')).toEqual(['upi']))

    await user.type(screen.getByRole('searchbox'), 'EB-2291{Enter}')
    await waitFor(() => expect(last().get('q')).toBe('EB-2291'))

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => {
      expect(last().get('payment_method')).toBeNull()
      expect(last().get('expense_account_id')).toBeNull()
    })
  })

  it('pages through the vouchers with offset', async () => {
    const api = setup({
      listExpenses: (c) =>
        HttpResponse.json(
          F.expenseList({ total: 120, offset: Number(c.query.get('offset') ?? 0) || 0 }),
        ),
    })
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/expenses')
    await screen.findByText('1–50 of 120')
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(api.callsTo(r.listExpenses).at(-1)!.query.get('offset')).toBe('50'))
  })

  it('hides recording and cancelling from members who can only read the books', async () => {
    setup()
    await signIn(makeMe({ permissions: ['accounting.read'] }))
    renderApp(`/accounting/expenses?id=${F.EXPENSE_ID}`)
    const drawer = await screen.findByRole('dialog', { name: 'Expense EXPS1/2627/00012' })
    expect(await within(drawer).findByText('Electricity')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Cancel expense' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add expense/ })).toBeNull()
  })

  it('cancels an expense with a reason after confirmation', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/accounting/expenses?id=${F.EXPENSE_ID}`)
    const drawer = await screen.findByRole('dialog', { name: 'Expense EXPS1/2627/00012' })
    await user.click(await within(drawer).findByRole('button', { name: 'Cancel expense' }))
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Cancel this expense of ₹3,840.00?',
    })
    // A reason is required.
    await user.click(within(confirm).getByRole('button', { name: 'Yes, cancel' }))
    expect(api.callsTo(r.cancelExpense)).toHaveLength(0)
    await user.type(within(confirm).getByRole('textbox', { name: /Reason/ }), 'Entered twice')
    await user.click(within(confirm).getByRole('button', { name: 'Yes, cancel' }))
    await waitFor(() => expect(api.callsTo(r.cancelExpense)).toHaveLength(1))
    const call = api.callsTo(r.cancelExpense)[0]!
    expect(call.path).toBe(`/api/v1/expenses/${F.EXPENSE_ID}/cancel`)
    expect(call.body as ExpenseCancel).toMatchObject({ reason: 'Entered twice' })
    expect(await screen.findByText('Expense EXPS1/2627/00012 cancelled')).toBeInTheDocument()
  })
})

describe('Quick add expense', () => {
  it('records a tile + amount + payment method with the contract body and an idempotency key', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/expenses')
    const dialog = await openAddDialog(user)

    await user.click(within(dialog).getByRole('radio', { name: 'Electricity' }))
    await user.type(within(dialog).getByLabelText(/Amount paid/), '1500')
    await user.click(within(dialog).getByRole('radio', { name: 'UPI' }))
    await user.click(screen.getByRole('button', { name: /Save ₹1,500\.00/ }))

    await waitFor(() => expect(api.callsTo(r.createExpense)).toHaveLength(1))
    const call = api.callsTo(r.createExpense)[0]!
    const body = call.body as ExpenseCreate
    expect(ExpenseCreateSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({
      store_id: F.STORE_ID,
      expense_account_id: F.A.electricity,
      total_paise: 150_000,
      gst_rate_bp: 0,
      itc_eligible: false,
      payment_method: 'upi',
      supplier_id: null,
      reference: null,
      description: null,
      attachment_file_id: null,
    })
    expect(body.taxable_paise).toBeUndefined()
    expect(body.register_id).toBeUndefined()
    expect(body.expense_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(call.headers.get('Idempotency-Key')).toBe(body.client_ref)
    expect(await screen.findByText(/Expense of ₹3,840\.00 recorded/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add expense' })).toBeNull())
  })

  it('blocks saving without a category and an amount', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/expenses')
    const dialog = await openAddDialog(user)
    await user.click(screen.getByRole('button', { name: /^Save(?! &)/ }))
    expect(
      await within(dialog).findByText('Choose what the money was spent on'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Amount paid/)).toHaveAttribute('aria-invalid', 'true')
    expect(api.callsTo(r.createExpense)).toHaveLength(0)
  })

  it('splits GST from the bill total and claims input credit', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/expenses')
    const dialog = await openAddDialog(user)
    await user.click(within(dialog).getByRole('radio', { name: 'Repairs' }))
    await user.type(within(dialog).getByLabelText(/Amount paid/), '2950')
    await user.click(within(dialog).getByRole('button', { name: '18%' }))
    await user.click(within(dialog).getByRole('switch', { name: /Claim GST input credit/ }))

    const breakup = within(dialog).getByTestId('gst-breakup')
    expect(within(breakup).getByText('₹2,500.00')).toBeInTheDocument()
    expect(within(breakup).getAllByText('₹225.00')).toHaveLength(2)

    await user.click(within(dialog).getByRole('radio', { name: 'Card' }))
    await user.click(screen.getByRole('button', { name: /Save ₹2,950\.00/ }))
    await waitFor(() => expect(api.callsTo(r.createExpense)).toHaveLength(1))
    expect(api.callsTo(r.createExpense)[0]!.body).toMatchObject({
      expense_account_id: F.A.repairs,
      total_paise: 295_000,
      gst_rate_bp: 1800,
      itc_eligible: true,
      payment_method: 'card',
    })
  })

  it('needs the supplier when bought on credit', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/expenses')
    const dialog = await openAddDialog(user)
    await user.click(within(dialog).getByRole('radio', { name: 'Transport' }))
    await user.type(within(dialog).getByLabelText(/Amount paid/), '450')
    await user.click(within(dialog).getByRole('radio', { name: 'On credit' }))
    await user.click(screen.getByRole('button', { name: /Save ₹450\.00/ }))
    expect(
      await within(dialog).findByText('Choose the supplier you will pay later'),
    ).toBeInTheDocument()
    expect(api.callsTo(r.createExpense)).toHaveLength(0)

    await user.click(within(dialog).getByRole('combobox', { name: /Supplier/ }))
    await user.click(await screen.findByRole('option', { name: /Sri Balaji Agencies/ }))
    await user.click(screen.getByRole('button', { name: /Save ₹450\.00/ }))
    await waitFor(() => expect(api.callsTo(r.createExpense)).toHaveLength(1))
    const body = api.callsTo(r.createExpense)[0]!.body as ExpenseCreate
    expect(body).toMatchObject({
      payment_method: 'credit',
      supplier_id: F.SUPPLIER_ID,
      total_paise: 45_000,
    })
    expect(body.paid_from_account_id).toBeUndefined()
  })

  it('creates the Tea & snacks head on first use', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/expenses')
    const dialog = await openAddDialog(user)
    await user.click(within(dialog).getByRole('radio', { name: 'Tea & snacks' }))
    await waitFor(() => expect(api.callsTo(r.createAccount)).toHaveLength(1))
    expect(api.callsTo(r.createAccount)[0]!.body as AccountCreate).toEqual({
      type: 'expense',
      name: 'Tea & refreshments',
      name_ta: 'டீ & சிற்றுண்டி',
    })
    await user.type(within(dialog).getByLabelText(/Amount paid/), '180')
    await user.click(screen.getByRole('button', { name: /Save ₹180\.00/ }))
    await waitFor(() => expect(api.callsTo(r.createExpense)).toHaveLength(1))
    expect(api.callsTo(r.createExpense)[0]!.body).toMatchObject({
      expense_account_id: F.iid(5410),
      payment_method: 'cash',
    })
  })
})
