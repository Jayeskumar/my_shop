import {
  type ShiftCashEntryCreate,
  ShiftCashEntryCreateSchema,
  type ShiftClose,
  ShiftCloseSchema,
  type ShiftOpen,
  ShiftOpenSchema,
  accountingRoutes as r,
} from '@kadai/shared/api/accounting'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type * as PrintModule from '@/lib/print'
import { IDS, makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import {
  type AccountingRouteKey,
  type Reply,
  apiError,
  createAccountingApi,
} from '../testing/handlers'
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

describe('Shifts list', () => {
  it('shows expected vs counted cash with the difference and filters by status', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    const { router } = renderApp('/accounting/shifts')

    const table = await screen.findByRole('table', { name: 'Shifts & cash' })
    const closed = (await within(table).findByText('Short ₹20')).closest('tr')!
    expect(within(closed).getByText('₹12,980.00')).toBeInTheDocument()
    expect(within(closed).getByText('₹12,960.00')).toBeInTheDocument()
    expect(within(closed).getByText('42 bills')).toBeInTheDocument()
    expect(within(table).getAllByText('Open').length).toBeGreaterThan(0)
    // Summary of the whole filtered set.
    expect(screen.getByText('₹20.00')).toBeInTheDocument()

    const last = () => api.callsTo(r.listShifts).at(-1)!.query
    expect(last().get('sort')).toBe('-opened_at')
    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: 'Closed' }))
    await waitFor(() => expect(last().get('status')).toBe('closed'))

    await user.click(within(table).getByText('Short ₹20'))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/accounting/shifts/${F.SHIFT_CLOSED_ID}`),
    )
  })

  it('gives cashiers (shifts.operate only) their own shifts without the cashier filter', async () => {
    setup()
    await signIn(makeMe({ permissions: ['shifts.operate'] }))
    renderApp('/accounting/shifts')
    await screen.findByRole('table', { name: 'Shifts & cash' })
    // shifts.operate only: own shifts (server rule), no cashier filter.
    expect(screen.queryByRole('combobox', { name: 'Cashier' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open shift' })).toBeInTheDocument()
  })

  it('opens a shift with a typed total and the contract body', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    const { router } = renderApp('/accounting/shifts')
    await user.click(await screen.findByRole('button', { name: 'Open shift' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open shift' })
    await user.click(within(dialog).getByRole('radio', { name: /Type total/ }))
    await user.type(within(dialog).getByLabelText('Cash in the drawer'), '2500')
    await user.click(within(dialog).getByRole('button', { name: 'Open with ₹2,500.00' }))

    await waitFor(() => expect(api.callsTo(r.openShift)).toHaveLength(1))
    const call = api.callsTo(r.openShift)[0]!
    const body = call.body as ShiftOpen
    expect(ShiftOpenSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({
      register_id: IDS.register,
      opening_cash_paise: 250_000,
      notes: null,
    })
    expect(body.denominations).toBeUndefined()
    expect(call.headers.get('Idempotency-Key')).toBe(body.client_ref)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/accounting/shifts/${F.iid(4009)}`),
    )
  })

  it('counts notes to open and links to the running shift when one is already open', async () => {
    const api = setup({
      openShift: () =>
        apiError(409, 'CONFLICT', { reason: 'shift_already_open', shift_id: F.SHIFT_OPEN_ID }),
    })
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/accounting/shifts')
    await user.click(await screen.findByRole('button', { name: 'Open shift' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open shift' })
    await user.type(within(dialog).getByLabelText('Number of ₹500 notes'), '3')
    await user.click(within(dialog).getByRole('button', { name: 'One ₹100 note more' }))
    await user.click(within(dialog).getByRole('button', { name: 'One ₹100 note more' }))
    expect(within(dialog).getByTestId('denomination-total')).toHaveTextContent('₹1,700.00')
    await user.click(within(dialog).getByRole('button', { name: 'Open with ₹1,700.00' }))

    await waitFor(() => expect(api.callsTo(r.openShift)).toHaveLength(1))
    expect(api.callsTo(r.openShift)[0]!.body).toMatchObject({
      opening_cash_paise: 170_000,
      denominations: { '500': 3, '100': 2 },
    })
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('A shift is already open on this counter.')
    expect(within(alert).getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      `/accounting/shifts/${F.SHIFT_OPEN_ID}`,
    )
  })
})

describe('Shift report', () => {
  it('closes with a note count: live difference, confirmation and the close body', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/accounting/shifts/${F.SHIFT_OPEN_ID}`)
    expect(
      await screen.findByRole('heading', { name: /X report \(shift so far\) · A · Counter A/ }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close shift' }))
    const dialog = await screen.findByRole('dialog', { name: 'Close shift · Counter A' })
    expect(within(dialog).getByText('₹12,980.00')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Number of ₹500 notes'), '25')
    await user.type(within(dialog).getByLabelText('Number of ₹100 notes'), '5')
    await user.type(within(dialog).getByLabelText('Coins and ₹5 notes (amount)'), '70')
    expect(within(dialog).getByTestId('denomination-total')).toHaveTextContent('₹13,070.00')
    const diff = within(dialog).getByTestId('shift-difference')
    expect(diff).toHaveTextContent('Excess')
    expect(diff).toHaveTextContent('+₹90.00')
    await user.type(
      within(dialog).getByRole('textbox', { name: /Reason for the difference/ }),
      'Change not given',
    )

    await user.click(within(dialog).getByRole('button', { name: 'Close shift' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Close with ₹90.00 excess?' })
    await user.click(within(confirm).getByRole('button', { name: 'Close shift' }))

    await waitFor(() => expect(api.callsTo(r.closeShift)).toHaveLength(1))
    const call = api.callsTo(r.closeShift)[0]!
    expect(call.path).toBe(`/api/v1/shifts/${F.SHIFT_OPEN_ID}/close`)
    const body = call.body as ShiftClose
    expect(ShiftCloseSchema.safeParse(body).success).toBe(true)
    expect(body).toEqual({
      counted_cash_paise: 1_307_000,
      denominations: { '500': 25, '100': 5, coins: 7_000 },
      notes: 'Change not given',
    })
    // After closing: offer to print the Z report.
    const prompt = await screen.findByRole('alertdialog', { name: 'Print the Z report now?' })
    await user.click(within(prompt).getByRole('button', { name: 'Later' }))
    expect(printHtml).not.toHaveBeenCalled()
  })

  it('records cash out from a preset with the counter account', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/accounting/shifts/${F.SHIFT_OPEN_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Cash in / out' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cash in / out' })
    // Amount is required.
    await user.click(within(dialog).getByRole('button', { name: 'Take out ₹0.00' }))
    expect(await within(dialog).findByText('Enter the amount')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Deposited in bank' }))
    expect(within(dialog).getByRole('textbox', { name: /Reason/ })).toHaveValue('Deposited in bank')
    await user.type(within(dialog).getByLabelText(/Amount/), '1000')
    await user.click(within(dialog).getByRole('button', { name: 'Take out ₹1,000.00' }))

    await waitFor(() => expect(api.callsTo(r.addShiftCashEntry)).toHaveLength(1))
    const call = api.callsTo(r.addShiftCashEntry)[0]!
    expect(call.path).toBe(`/api/v1/shifts/${F.SHIFT_OPEN_ID}/cash-entries`)
    const body = call.body as ShiftCashEntryCreate
    expect(ShiftCashEntryCreateSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({
      kind: 'pay_out',
      amount_paise: 100_000,
      reason: 'Deposited in bank',
      counter: 'bank',
    })
    expect(call.headers.get('Idempotency-Key')).toBe(body.client_ref)
    expect(await screen.findByText('₹1,000.00 cash out recorded')).toBeInTheDocument()
  })

  it('prints the Z report on 80 mm paper and A4 and offers no close on a closed shift', async () => {
    setup()
    printHtml.mockClear()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/accounting/shifts/${F.SHIFT_CLOSED_ID}`)
    expect(
      await screen.findByRole('heading', { name: /Z report \(shift closing\) · A · Counter A/ }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close shift' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cash in / out' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Print' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Print receipt (80 mm)' }))
    await waitFor(() => expect(printHtml).toHaveBeenCalledTimes(1))
    const [html, options] = printHtml.mock.calls[0]!
    expect(options).toMatchObject({ paper: 'thermal_80' })
    expect(html).toContain('Z report (shift closing)')
    expect(html).toContain('₹500 × 20')
    expect(html).toContain('₹12,960.00')
    expect(html).toContain('-₹20.00')

    await user.click(screen.getByRole('button', { name: 'Print' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Print A4' }))
    await waitFor(() => expect(printHtml).toHaveBeenCalledTimes(2))
    expect(printHtml.mock.calls[1]![1]).toMatchObject({ paper: 'a4' })
  })
})
