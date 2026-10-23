import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { purchaseReturnPrefillPath } from '@kadai/shared/api/inventory'
import {
  DebitNoteCancelSchema,
  DebitNoteCreateSchema,
  purchasesRoutes,
} from '@kadai/shared/api/purchases'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createPurchasesApi } from '../testing/handlers'

// The first render loads the lazy route and the shell; on a busy machine that can take longer
// than Testing Library's 1 s default.
configure({ asyncUtilTimeout: 5_000 })

function setup(replies: Parameters<typeof createPurchasesApi>[0] = {}) {
  const api = createPurchasesApi(replies)
  server.use(...api.handlers)
  return api
}

describe('Purchase returns (debit notes)', () => {
  it('returns expired batches sent from the batches page as a cash refund', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    const { router } = renderApp(
      purchaseReturnPrefillPath({
        batch_ids: [F.IDS.batchDolo],
        store_id: F.STORE_ID,
        supplier_id: F.IDS.supplier,
      }),
    )
    expect(await screen.findByText(/1 batch from the batches page/)).toBeInTheDocument()
    const prefill = api.callsTo(purchasesRoutes.debitNotePrefill)[0]!.query
    expect(prefill.get('store_id')).toBe(F.STORE_ID)
    expect(prefill.get('supplier_id')).toBe(F.IDS.supplier)
    expect(prefill.getAll('batch_ids').join(',')).toContain(F.IDS.batchDolo)
    // Whole stock of the batch (2 strips of 15) at its landed cost; reason defaults to expired.
    expect(screen.getByRole('textbox', { name: 'Return quantity of Dolo 650 Tablet' })).toHaveValue(
      '2',
    )
    expect(screen.getByRole('combobox', { name: /Reason/ })).toHaveTextContent('Expired')

    await user.click(screen.getByRole('radio', { name: /Cash refund/ }))
    await user.click(screen.getByRole('button', { name: 'Save debit note' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(
      within(confirm).getByText(/Sri Lakshmi Traders refunds ₹49.46 in cash/),
    ).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Save debit note' }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.createDebitNote)).toHaveLength(1))
    const body = DebitNoteCreateSchema.parse(api.callsTo(purchasesRoutes.createDebitNote)[0]!.body)
    expect(body).toMatchObject({
      supplier_id: F.IDS.supplier,
      store_id: F.STORE_ID,
      is_interstate: false,
      reason: 'expired',
      settlement: 'refund_cash',
      lines: [
        {
          product_id: F.IDS.dolo,
          batch_id: F.IDS.batchDolo,
          qty_milli: 30_000,
          unit_cost_paise: 2_208,
          gst_rate_bp: 1200,
        },
      ],
    })
    expect(body.bill_id).toBeUndefined()
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/purchases/returns/${F.IDS.note}`),
    )
  })

  it('returns part of a bill line, capped by what can still be returned', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(`/purchases/returns/new?bill_id=${F.IDS.billPosted}`)
    const qty = await screen.findByRole('textbox', { name: 'Return quantity of Dolo 650 Tablet' })
    // 10 strips bought + 1 free = 11 strips returnable.
    await user.type(qty, '12')
    await user.click(screen.getByRole('button', { name: 'Save debit note' }))
    expect(await screen.findByText('More than can be returned')).toBeInTheDocument()
    expect(api.callsTo(purchasesRoutes.createDebitNote)).toHaveLength(0)

    await user.clear(qty)
    await user.type(qty, '1')
    await user.click(screen.getByRole('button', { name: 'Save debit note' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Save debit note',
      }),
    )
    await waitFor(() => expect(api.callsTo(purchasesRoutes.createDebitNote)).toHaveLength(1))
    const body = DebitNoteCreateSchema.parse(api.callsTo(purchasesRoutes.createDebitNote)[0]!.body)
    const doloLine = F.returnable().lines[1]!
    expect(body).toMatchObject({
      bill_id: F.IDS.billPosted,
      reason: 'return',
      settlement: 'adjust_due',
      lines: [{ bill_line_id: doloLine.bill_line_id, qty_milli: 15_000 }],
    })
  })

  it('filters returns to expiry returns', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/returns')
    const table = await screen.findByRole('table', { name: 'Purchase returns' })
    expect(await within(table).findByText('DNS1/2627/00003')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Expiry returns' }))
    await waitFor(() =>
      expect(api.callsTo(purchasesRoutes.listDebitNotes).at(-1)!.query.getAll('reason')).toEqual([
        'expired',
      ]),
    )
  })

  it('cancels a debit note with a reason', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(`/purchases/returns/${F.IDS.note}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'DNS1/2627/00003' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print debit note' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel debit note' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.type(within(dialog).getByRole('textbox'), 'Supplier refused the goods')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel debit note' }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.cancelDebitNote)).toHaveLength(1))
    expect(
      DebitNoteCancelSchema.parse(api.callsTo(purchasesRoutes.cancelDebitNote)[0]!.body),
    ).toEqual({
      reason: 'Supplier refused the goods',
    })
  })
})
