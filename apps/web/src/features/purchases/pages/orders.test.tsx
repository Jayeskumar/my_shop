import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import {
  PurchaseOrderCreateSchema,
  PurchaseOrderSendSchema,
  purchasesRoutes,
} from '@kadai/shared/api/purchases'
import { reorderPrefillPath } from '@kadai/shared/api/inventory'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { makeMe } from '@/test/fixtures'
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

describe('Purchase orders', () => {
  it('filters the list to open orders', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/purchases/orders')
    const table = await screen.findByRole('table', { name: 'Purchase orders' })
    expect(await within(table).findByText('POS1/2627/00004')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() =>
      expect(api.callsTo(purchasesRoutes.listOrders).at(-1)!.query.getAll('status')).toEqual([
        'sent',
        'partially_received',
      ]),
    )
  })

  it('creates a purchase order from the reorder list with the chosen quantities', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    const { router } = renderApp('/purchases/orders?tab=reorder')
    expect(await screen.findByRole('heading', { name: 'Sri Lakshmi Traders' })).toBeInTheDocument()
    expect(api.callsTo(purchasesRoutes.reorderSuggestions)[0]!.query.get('store_id')).toBe(
      F.STORE_ID,
    )
    // Never-bought items need a supplier before an order can be made.
    expect(screen.getByRole('heading', { name: 'Never purchased' })).toBeInTheDocument()
    const groupButtons = screen.getAllByRole('button', { name: /Create order/ })
    expect(groupButtons[1]).toBeDisabled()

    const qty = screen.getByRole('textbox', { name: 'Quantity of Aashirvaad Atta 5 kg' })
    await user.clear(qty)
    await user.type(qty, '25')
    await user.click(screen.getByRole('checkbox', { name: 'Order Dolo 650 Tablet' }))
    await user.click(screen.getAllByRole('button', { name: 'Create order (1 item)' })[0]!)
    await waitFor(() => expect(api.callsTo(purchasesRoutes.createOrder)).toHaveLength(1))
    const body = PurchaseOrderCreateSchema.parse(api.callsTo(purchasesRoutes.createOrder)[0]!.body)
    expect(body).toMatchObject({
      store_id: F.STORE_ID,
      supplier_id: F.IDS.supplier,
      lines: [{ product_id: F.IDS.atta, qty_milli: 25_000, unit_cost_paise: 24_000 }],
    })
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/purchases/orders/${F.IDS.orderDraft}`),
    )
  })

  it('opens the editor prefilled from inventory reorder links', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(reorderPrefillPath({ store_id: F.STORE_ID, product_ids: [F.IDS.atta] }))
    expect(await screen.findByText(/1 item from the reorder list/)).toBeInTheDocument()
    const call = api.callsTo(purchasesRoutes.reorderSuggestions)[0]!
    expect(call.query.get('product_ids') ?? call.query.getAll('product_ids').join(',')).toContain(
      F.IDS.atta,
    )
    expect(screen.getByRole('textbox', { name: 'Qty, line 1' })).toHaveValue('20')
    await user.click(screen.getByRole('button', { name: /Save order/ }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.createOrder)).toHaveLength(1))
    const body = PurchaseOrderCreateSchema.parse(api.callsTo(purchasesRoutes.createOrder)[0]!.body)
    expect(body).toMatchObject({
      supplier_id: F.IDS.supplier,
      lines: [
        { product_id: F.IDS.atta, qty_milli: 20_000, unit_cost_paise: 24_000, gst_rate_bp: 500 },
      ],
    })
  })

  it('sends an order to share on WhatsApp from this device', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp(`/purchases/orders/${F.IDS.orderDraft}`)
    await user.click(await screen.findByRole('button', { name: 'Send to supplier' }))
    const dialog = await screen.findByRole('dialog', { name: 'Send POS1/2627/00005' })
    expect(within(dialog).getByRole('textbox', { name: /Supplier's mobile/ })).toHaveValue(
      '94430 12345',
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: /Extra line/ }),
      'Deliver by Friday',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.sendOrder)).toHaveLength(1))
    const sent = api.callsTo(purchasesRoutes.sendOrder)[0]!.body
    expect(sent).toEqual({ via: null, message: 'Deliver by Friday' })
    expect(PurchaseOrderSendSchema.safeParse(sent).success).toBe(true)
    expect(await within(dialog).findByRole('link', { name: 'Open WhatsApp' })).toHaveAttribute(
      'href',
      'https://wa.me/919443012345?text=PO',
    )
  })

  it('receives goods into a new draft bill with the pending quantities', async () => {
    const fromOrder = F.draftBill({
      purchase_order_id: F.IDS.order,
      purchase_order: { id: F.IDS.order, number: 'POS1/2627/00004' },
      supplier_invoice_no: '',
    })
    const api = setup({
      billFromOrder: () => HttpResponse.json({ data: fromOrder }, { status: 201 }),
    })
    const user = userEvent.setup()
    await signIn()
    const { router } = renderApp(`/purchases/orders/${F.IDS.order}`)
    const table = await screen.findByRole('table', { name: 'Items' })
    expect(
      within(table).getByText('20 pcs', { selector: 'span.font-medium.text-warning *' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Receive goods' }))
    await waitFor(() => expect(api.callsTo(purchasesRoutes.billFromOrder)).toHaveLength(1))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/purchases/bills/${F.IDS.billDraft}`),
    )
    expect(
      await screen.findByText(/Receiving against purchase order POS1\/2627\/00004/),
    ).toBeInTheDocument()
  })

  it('shows no order actions without purchases.write', async () => {
    setup()
    await signIn(makeMe({ permissions: PERMISSION_CODES.filter((p) => p !== 'purchases.write') }))
    renderApp(`/purchases/orders/${F.IDS.order}`)
    await screen.findByRole('heading', { level: 1, name: 'POS1/2627/00004' })
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive goods' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close order' })).not.toBeInTheDocument()
  })
})
