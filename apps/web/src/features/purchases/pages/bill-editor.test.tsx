import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import {
  PurchaseBillCreateSchema,
  PurchaseBillPostSchema,
  purchasesRoutes,
} from '@kadai/shared/api/purchases'
import { errorResponse, server } from '@/test/msw'
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

type User = ReturnType<typeof userEvent.setup>

async function pickSupplier(user: User, name = 'Sri Lakshmi Traders') {
  await user.click(await screen.findByRole('combobox', { name: /^Supplier/ }))
  const dialog = await screen.findByRole('dialog')
  await user.click(await within(dialog).findByText(name))
}

async function addProduct(user: User, search: string, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Add item' }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByRole('combobox'), search)
  await user.click(await within(dialog).findByText(name))
}

describe('Purchase bill entry', () => {
  it('enters a bill with the keyboard grid and saves the draft (contract body)', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    const { router } = renderApp('/purchases/bills/new')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'New purchase bill' }),
    ).toBeInTheDocument()
    await pickSupplier(user)
    // Supplier summary: what the shop owes and the credit days.
    expect(await screen.findByText('30 days')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: /Supplier invoice no/ }), 'SLT/1200')

    await addProduct(user, 'atta', 'Aashirvaad Atta 5 kg')
    const qty = await screen.findByRole('textbox', { name: 'Qty, line 1' })
    await waitFor(() => expect(qty).toHaveFocus())
    await user.type(qty, '20{Enter}')
    // Enter moves across the row: qty → free → rate.
    expect(screen.getByRole('textbox', { name: 'Free, line 1' })).toHaveFocus()
    await user.keyboard('{Enter}')
    const rate = screen.getByRole('textbox', { name: 'Rate, line 1' })
    expect(rate).toHaveFocus()
    await user.clear(rate)
    await user.type(rate, '245')
    // Live totals: 20 × ₹245 + 5% GST = ₹5,145.00 (shown in the row and the totals panel).
    expect((await screen.findAllByText('₹5,145.00')).length).toBeGreaterThan(0)
    // Rate above the last purchase cost (₹240) is flagged.
    expect(screen.getByText(/Rate is higher than last time \(₹240.00\)/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.createBill)).toHaveLength(1))
    const call = api.callsTo(purchasesRoutes.createBill)[0]!
    const body = PurchaseBillCreateSchema.parse(call.body)
    expect(body).toMatchObject({
      supplier_id: F.IDS.supplier,
      store_id: F.STORE_ID,
      supplier_invoice_no: 'SLT/1200',
      is_interstate: false,
      reverse_charge: false,
      itc_eligible: true,
      other_charges_paise: 0,
      lines: [
        {
          product_id: F.IDS.atta,
          qty_milli: 20_000,
          unit_cost_paise: 24_500,
          gst_rate_bp: 500,
          mrp_paise: 29_000,
        },
      ],
    })
    expect(body.client_ref).toBeTruthy()
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/purchases/bills/${F.IDS.billDraft}`),
    )
  })

  it('uses the product cess rate in the live totals and sends it with the line', async () => {
    const api = setup({
      getProduct: () =>
        HttpResponse.json({ data: F.productDetail(F.product(), { cess_rate_bp: 500 }) }),
    })
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/bills/new')
    await pickSupplier(user)
    await user.type(screen.getByRole('textbox', { name: /Supplier invoice no/ }), 'SLT/1300')
    await addProduct(user, 'atta', 'Aashirvaad Atta 5 kg')
    const qty = await screen.findByRole('textbox', { name: 'Qty, line 1' })
    await user.type(qty, '20')
    const rate = screen.getByRole('textbox', { name: 'Rate, line 1' })
    await user.clear(rate)
    await user.type(rate, '245')
    // 20 × ₹245 = ₹4,900 + 5% GST ₹245 + 5% cess ₹245 = ₹5,390.00 (what the server will save).
    expect((await screen.findAllByText('₹5,390.00')).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.createBill)).toHaveLength(1))
    const body = PurchaseBillCreateSchema.parse(api.callsTo(purchasesRoutes.createBill)[0]!.body)
    expect(body.lines[0]).toMatchObject({ product_id: F.IDS.atta, cess_rate_bp: 500 })
  })

  it('requires batch and expiry for batch-tracked items before saving', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/bills/new')
    await pickSupplier(user)
    await user.type(screen.getByRole('textbox', { name: /Supplier invoice no/ }), 'SLT/1201')
    await addProduct(user, 'dolo', 'Dolo 650 Tablet')
    // The first cell of a batch-tracked row is the batch number.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Batch, line 1' })).toHaveFocus(),
    )
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    expect(await screen.findByText('Enter the batch number')).toBeInTheDocument()
    expect(screen.getByText('Enter the expiry (MM/YY)')).toBeInTheDocument()
    expect(api.callsTo(purchasesRoutes.createBill)).toHaveLength(0)

    await user.type(screen.getByRole('textbox', { name: 'Batch, line 1' }), 'dl2411')
    await user.type(screen.getByRole('textbox', { name: 'Expiry, line 1' }), '0328')
    expect(screen.getByRole('textbox', { name: 'Expiry, line 1' })).toHaveValue('03/28')
    await user.type(screen.getByRole('textbox', { name: 'Qty, line 1' }), '10')
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.createBill)).toHaveLength(1))
    const body = PurchaseBillCreateSchema.parse(api.callsTo(purchasesRoutes.createBill)[0]!.body)
    // 10 strips of 15 tablets; prices per strip.
    expect(body.lines[0]).toMatchObject({
      product_id: F.IDS.dolo,
      batch_no: 'DL2411',
      expiry_date: '2028-03-31',
      qty_milli: 150_000,
      unit_cost_paise: 2_300,
      gst_rate_bp: 1200,
    })
  })

  it('points to the existing bill when the supplier invoice number was already entered', async () => {
    setup({
      createBill: () =>
        errorResponse(409, 'DUPLICATE', 'duplicate', {
          reason: 'duplicate_supplier_invoice',
          existing_bill_id: F.IDS.billPosted,
          existing_number: 'GRNS1/2627/00018',
          existing_status: 'posted',
        }),
    })
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/bills/new')
    await pickSupplier(user)
    await user.type(screen.getByRole('textbox', { name: /Supplier invoice no/ }), 'SLT/1182')
    await addProduct(user, 'atta', 'Aashirvaad Atta 5 kg')
    await user.type(await screen.findByRole('textbox', { name: 'Qty, line 1' }), '5')
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    expect(
      await screen.findByRole('link', { name: 'Open the existing bill GRNS1/2627/00018' }),
    ).toHaveAttribute('href', `/purchases/bills/${F.IDS.billPosted}`)
    expect(
      screen.getAllByText('This supplier invoice number is already entered').length,
    ).toBeGreaterThan(0)
  })

  it('posts a saved draft after the confirmation summary', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(`/purchases/bills/${F.IDS.billDraft}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Draft purchase bill' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Batch, line 2' })).toHaveValue('DL2410')
    await user.click(screen.getByRole('button', { name: /Post bill/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Post this bill?' })
    expect(within(dialog).getByText('You will owe the supplier')).toBeInTheDocument()
    expect(within(dialog).getByText('2 lines are added to stock')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Post bill' }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.postBill)).toHaveLength(1))
    // Not edited since it was saved: no PATCH before posting.
    expect(api.callsTo(purchasesRoutes.updateBill)).toHaveLength(0)
    expect(PurchaseBillPostSchema.parse(api.callsTo(purchasesRoutes.postBill)[0]!.body)).toEqual({
      if_updated_at: F.NOW,
      update_prices: true,
      allow_past_expiry: false,
    })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'GRNS1/2627/00018' }),
    ).toBeInTheDocument()
  })
})
