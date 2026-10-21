import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreditNoteCancelSchema, CreditNoteCreateSchema } from '@kadai/shared/api/sales'
import type * as PosPrint from '@/features/pos/print'
import { printSalesDocument } from '@/features/pos/print'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { CREDIT_NOTE_ID, INVOICE_ID, LINE_ATTA } from '../testing/fixtures'
import { createSalesApi } from '../testing/handlers'

vi.mock('@/features/pos/print', async (importOriginal) => {
  const actual = await importOriginal<typeof PosPrint>()
  return { ...actual, printSalesDocument: vi.fn(async () => undefined) }
})

function setup(replies: Parameters<typeof createSalesApi>[0] = {}) {
  const api = createSalesApi(replies)
  server.use(...api.handlers)
  return api
}

beforeEach(() => {
  vi.mocked(printSalesDocument).mockClear()
})

describe('New sales return', () => {
  it('pro-rates the returned items, follows the reason for restock and posts the credit note', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/sales/returns/new?invoice_id=${INVOICE_ID}`)

    expect(await screen.findByRole('link', { name: 'S1-A/2627/00412' })).toHaveAttribute(
      'href',
      `/sales/invoices/${INVOICE_ID}`,
    )
    expect(api.callsTo('returnable')[0]!.params.id).toBe(INVOICE_ID)
    expect(screen.getByRole('button', { name: 'Choose items to return' })).toBeDisabled()

    const atta = screen.getByRole('textbox', { name: 'Aashirvaad Atta 5 kg' })
    await user.type(atta, '1')
    const note = screen.getByRole('region', { name: 'Credit note' })
    // 1 of 2 packs: taxable ₹271.43 + CGST/SGST ₹6.79 each = ₹285.01 → ₹285.00 after round off.
    await waitFor(() => expect(within(note).getByText('₹285.00')).toBeInTheDocument())
    expect(within(note).getByText('₹271.43')).toBeInTheDocument()

    // The bill has a due, so adjusting it is the default settlement.
    const settlement = screen.getByRole('radiogroup', {
      name: 'How does the customer get the money?',
    })
    expect(within(settlement).getByRole('radio', { name: /Adjusted against due/ })).toBeChecked()
    expect(
      within(settlement).getByText(
        "Reduce the bill's due (₹310.00) by ₹285.00. No money changes hands.",
      ),
    ).toBeInTheDocument()

    // Goods come back by default to stock; damaged goods do not.
    expect(
      screen.getByRole('switch', { name: 'Put back in stock: Aashirvaad Atta 5 kg' }),
    ).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Damaged' }))
    expect(
      screen.getByRole('switch', { name: 'Put back in stock: Aashirvaad Atta 5 kg' }),
    ).not.toBeChecked()

    await user.click(within(settlement).getByRole('radio', { name: /Cash refund/ }))
    await user.click(screen.getByRole('button', { name: 'Accept return · ₹285.00' }))

    await waitFor(() => expect(api.callsTo('createCreditNote')).toHaveLength(1))
    const call = api.callsTo('createCreditNote')[0]!
    const body = CreditNoteCreateSchema.parse(call.body)
    expect(body).toMatchObject({
      invoice_id: INVOICE_ID,
      lines: [{ invoice_line_id: LINE_ATTA, qty_milli: 1000, restock: false }],
      reason: 'damaged',
      settlement: 'cash',
    })
    expect(call.headers.get('idempotency-key')).toBe(body.client_ref)

    // The credit note opens, ready to print.
    expect(await screen.findByText('Return accepted · ₹285.00')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Print credit note' }))
    await waitFor(() =>
      expect(printSalesDocument).toHaveBeenCalledWith({
        kind: 'credit_note',
        id: CREDIT_NOTE_ID,
        locale: 'en',
      }),
    )
  })

  it('caps the quantity at what can still be returned', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/sales/returns/new?invoice_id=${INVOICE_ID}`)
    const atta = await screen.findByRole('textbox', { name: 'Aashirvaad Atta 5 kg' })
    await user.type(atta, '3')
    await user.click(screen.getByRole('button', { name: 'Return all of Toor dal (loose)' }))
    await user.click(screen.getByRole('button', { name: /Accept return/ }))
    expect(await screen.findByText(/Only 2 .* can be returned/)).toBeInTheDocument()
    expect(api.callsTo('createCreditNote')).toHaveLength(0)
  })

  it('finds the bill by its number', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/sales/returns/new')
    expect(await screen.findByText('Recent bills (last 30 days)')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Bill number' }), 'S1-A/2627/00412{Enter}')
    await waitFor(() =>
      expect(api.callsTo('listInvoices').some((c) => c.query.get('q') === 'S1-A/2627/00412')).toBe(
        true,
      ),
    )
    const search = api.callsTo('listInvoices').find((c) => c.query.get('q'))!.query
    expect(search.getAll('status')).toEqual(['completed'])
    expect(search.get('from')).toBeNull()
    expect(await screen.findByRole('textbox', { name: 'Aashirvaad Atta 5 kg' })).toBeInTheDocument()
    expect(api.callsTo('returnable')[0]!.params.id).toBe(INVOICE_ID)
  })
})

describe('Returns list and credit note', () => {
  it('lists credit notes and filters by reason', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/sales/returns')
    const table = await screen.findByRole('table', { name: 'Sales returns' })
    expect(await within(table).findByRole('link', { name: 'CN/S1/2627/00007' })).toHaveAttribute(
      'href',
      `/sales/returns/${CREDIT_NOTE_ID}`,
    )
    expect(within(table).getByText('Adjusted against due')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    const sheet = await screen.findByRole('dialog', { name: 'Filters' })
    await user.click(within(sheet).getByRole('combobox', { name: 'Reason' }))
    await user.click(await screen.findByRole('option', { name: 'Damaged' }))
    await waitFor(() =>
      expect(api.callsTo('listCreditNotes').at(-1)!.query.getAll('reason')).toEqual(['damaged']),
    )
    expect(api.callsTo('listCreditNotes').at(-1)!.query.get('sort')).toBe('-note_date')
  })

  it('cancels a credit note with a reason', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp(`/sales/returns/${CREDIT_NOTE_ID}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'CN/S1/2627/00007' }),
    ).toBeInTheDocument()
    expect(screen.getByText("₹285.00 was adjusted against the bill's due.")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel return' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Cancel credit note CN/S1/2627/00007?',
    })
    expect(within(dialog).getByText("The bill's due goes back up by ₹285.00.")).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Entered against the wrong bill' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cancel credit note' }))
    await waitFor(() => expect(api.callsTo('cancelCreditNote')).toHaveLength(1))
    expect(CreditNoteCancelSchema.parse(api.callsTo('cancelCreditNote')[0]!.body)).toEqual({
      reason: 'Entered against the wrong bill',
    })
  })

  it('a user without sales.cancel cannot cancel a credit note', async () => {
    setup()
    await signIn(makeMe({ permissions: ['sales.return'] }))
    renderApp(`/sales/returns/${CREDIT_NOTE_ID}`)
    await screen.findByRole('heading', { level: 1, name: 'CN/S1/2627/00007' })
    expect(screen.queryByRole('button', { name: 'Cancel return' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument()
  })
})
