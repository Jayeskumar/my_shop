import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { PaymentCreateSchema, paymentsRoutes } from '@kadai/shared/api/payments'
import { PurchaseBillCancelSchema, purchasesRoutes } from '@kadai/shared/api/purchases'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createPurchasesApi } from '../testing/handlers'

function setup(replies: Parameters<typeof createPurchasesApi>[0] = {}) {
  const api = createPurchasesApi(replies)
  server.use(...api.handlers)
  return api
}

const without = (...perms: string[]) => PERMISSION_CODES.filter((p) => !perms.includes(p))

describe('Purchase bills list', () => {
  it('shows what is due, flags overdue bills and filters to overdue', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/bills')
    const table = await screen.findByRole('table', { name: 'Purchase bills' })
    const overdueRow = (await within(table).findByText('GRNS1/2627/00011')).closest('tr')!
    expect(within(overdueRow).getByText('18 days overdue')).toBeInTheDocument()
    expect(within(overdueRow).getByText('Inv. SLT/1101 · 02-09-2026')).toBeInTheDocument()
    const draftRow = within(table).getByText('Inv. SLT/1190 · 12-10-2026').closest('tr')!
    expect(within(draftRow).getAllByText('Draft')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Overdue' }))
    await waitFor(() => {
      const q = api.callsTo(purchasesRoutes.listBills).at(-1)!.query
      expect(q.getAll('status')).toEqual(['posted'])
      expect(q.get('overdue')).toBe('true')
      expect(q.get('offset')).toBe('0')
    })
  })

  it('searches and pages through the server list', async () => {
    const list = F.billList()
    const api = setup({
      listBills: (c) =>
        HttpResponse.json({
          ...list,
          page: { limit: 50, offset: Number(c.query.get('offset') ?? 0), total: 120 },
        }),
    })
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/bills')
    await screen.findByRole('table', { name: 'Purchase bills' })
    await user.type(
      screen.getByRole('searchbox', { name: 'GRN, invoice no. or supplier' }),
      'SLT/11',
    )
    await waitFor(() =>
      expect(api.callsTo(purchasesRoutes.listBills).at(-1)!.query.get('q')).toBe('SLT/11'),
    )
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() =>
      expect(api.callsTo(purchasesRoutes.listBills).at(-1)!.query.get('offset')).toBe('50'),
    )
    expect(api.callsTo(purchasesRoutes.listBills).at(-1)!.query.get('q')).toBe('SLT/11')
  })

  it('opens the supplier quick view from the list', async () => {
    setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/bills')
    const table = await screen.findByRole('table', { name: 'Purchase bills' })
    await user.click(
      (await within(table).findAllByRole('button', { name: 'Sri Lakshmi Traders' }))[0]!,
    )
    const drawer = await screen.findByRole('dialog', { name: 'Sri Lakshmi Traders' })
    expect(await within(drawer).findByText('₹23,500.00')).toBeInTheDocument()
    expect(within(drawer).getByText('30 days')).toBeInTheDocument()
  })

  it('hides New bill without purchases.write', async () => {
    setup()
    await signIn(makeMe({ permissions: without('purchases.write') }))
    renderApp('/purchases/bills')
    await screen.findByRole('table', { name: 'Purchase bills' })
    expect(screen.queryByRole('button', { name: /New purchase bill/ })).not.toBeInTheDocument()
  })
})

describe('Posted bill', () => {
  it('pays the supplier against the bill (payment voucher, direction out)', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(`/purchases/bills/${F.IDS.billPosted}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'GRNS1/2627/00018' }),
    ).toBeInTheDocument()
    const due = F.bill().due_paise
    await user.click(screen.getByRole('button', { name: 'Pay now' }))
    const dialog = await screen.findByRole('dialog', { name: 'Pay Sri Lakshmi Traders' })
    await user.click(within(dialog).getByRole('radio', { name: /UPI/ }))
    await user.click(within(dialog).getByRole('button', { name: /^Pay ₹/ }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.createPayment)).toHaveLength(1))
    const body = PaymentCreateSchema.parse(api.callsTo(paymentsRoutes.createPayment)[0]!.body)
    expect(body).toMatchObject({
      direction: 'out',
      party_type: 'supplier',
      party_id: F.IDS.supplier,
      store_id: F.STORE_ID,
      method: 'upi',
      amount_paise: due,
      allocations: [
        { target_type: 'purchase_bill', target_id: F.IDS.billPosted, amount_paise: due },
      ],
    })
  })

  it('cancels a posted bill only after the payments are cancelled', async () => {
    const api = setup({
      getBill: () => HttpResponse.json({ data: F.bill({ paid_paise: 0, payments: [] }) }),
    })
    const user = userEvent.setup()
    await signIn()
    renderApp(`/purchases/bills/${F.IDS.billPosted}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel bill' }))
    const dialog = await screen.findByRole('alertdialog')
    const confirm = within(dialog).getByRole('button', { name: 'Cancel bill' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox'), 'Entered twice')
    await user.click(confirm)
    await waitFor(() => expect(api.callsTo(purchasesRoutes.cancelBill)).toHaveLength(1))
    expect(
      PurchaseBillCancelSchema.parse(api.callsTo(purchasesRoutes.cancelBill)[0]!.body),
    ).toEqual({
      reason: 'Entered twice',
    })
  })

  it('hides Pay now without payments.pay and Cancel while payments exist', async () => {
    setup()
    await signIn(makeMe({ permissions: without('payments.pay') }))
    renderApp(`/purchases/bills/${F.IDS.billPosted}`)
    await screen.findByRole('heading', { level: 1, name: 'GRNS1/2627/00018' })
    expect(screen.queryByRole('button', { name: 'Pay now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel bill' })).not.toBeInTheDocument()
    expect(screen.getByText(/first cancel the supplier payments/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return goods' })).toBeInTheDocument()
  })
})
