import {
  inventoryRoutes,
  type TransferCreate,
  type TransferReceive,
} from '@kadai/shared/api/inventory'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { printHtml } from '@/lib/print'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createInventoryApi, type InventoryRouteKey, type Reply } from '../testing/handlers'

vi.mock('@/lib/print', () => ({ printHtml: vi.fn(() => Promise.resolve()) }))

const PRO = [...DEFAULT_PLAN_FEATURES.pro]

function setup(replies: Partial<Record<InventoryRouteKey, Reply>> = {}) {
  const api = createInventoryApi(replies)
  server.use(...api.handlers)
  return api
}

beforeEach(() => vi.mocked(printHtml).mockClear())

describe('Stock transfers', () => {
  it('lists transfers of the current store and filters by status', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/transfers')
    const table = await screen.findByRole('table', { name: 'Stock transfers' })
    const row = (await within(table).findByText('TRS1/2627/00003')).closest('tr')!
    expect(within(row).getByText('Dispatched')).toBeInTheDocument()
    expect(within(row).getByText('₹15,360.00')).toBeInTheDocument()
    const last = () => api.callsTo(inventoryRoutes.listTransfers).at(-1)!.query
    expect(last().get('store_id')).toBe(F.STORE_ID)
    const chips = screen.getByRole('group', { name: 'Transfer status' })
    await user.click(within(chips).getByRole('button', { name: 'Received' }))
    await waitFor(() => expect(last().get('status')).toBe('received'))
  })

  it('creates and dispatches a transfer to another store', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    const { router } = renderApp('/inventory/transfers/new')
    await user.click(await screen.findByRole('combobox', { name: 'To store' }))
    await user.click(await screen.findByRole('option', { name: 'S2 · Anna Nagar' }))
    await user.click(screen.getByRole('combobox', { name: 'Add item' }))
    await user.click(
      await within(await screen.findByRole('listbox')).findByText('Ponni Rice 25 kg'),
    )
    await user.type(screen.getByLabelText('Quantity for item 1'), '4')
    await user.click(screen.getByRole('button', { name: 'Dispatch' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Dispatch this transfer?' })
    expect(
      within(confirm).getByText(
        /1 item worth ₹5,520\.00 leaves S1 · Main store for S2 · Anna Nagar/,
      ),
    ).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Dispatch' }))
    await waitFor(() => expect(api.callsTo(inventoryRoutes.dispatchTransfer)).toHaveLength(1))
    const body = api.callsTo(inventoryRoutes.createTransfer)[0]!.body as TransferCreate
    expect(body).toMatchObject({ from_store_id: F.STORE_ID, to_store_id: F.STORE2_ID, notes: null })
    expect(body.lines).toEqual([{ product_id: F.P.rice, batch_id: null, qty_milli: 4_000 }])
    expect(api.callsTo(inventoryRoutes.dispatchTransfer)[0]!.path).toBe(
      `/api/v1/stock-transfers/${F.iid(7809)}/dispatch`,
    )
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/inventory/transfers/${F.TRANSFER_ID}`),
    )
  })

  it('asks for both stores before saving', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp(`/inventory/transfers/new?from_store_id=${F.STORE_ID}&product_ids=${F.P.rice}`)
    expect(await screen.findByText('Ponni Rice 25 kg')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Quantity for item 1'), '1')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByText('Choose both stores.')).toBeInTheDocument()
    expect(api.callsTo(inventoryRoutes.createTransfer)).toHaveLength(0)
  })

  it('receives with a shortfall only after a reason is given', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp(`/inventory/transfers/${F.TRANSFER_ID}`)
    const timeline = await screen.findByRole('list', { name: 'Status' })
    expect(within(timeline).getByText('Dispatched')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Receive' }))
    const dialog = await screen.findByRole('dialog', { name: 'Receive TRS1/2627/00003' })
    const oil = within(dialog).getByLabelText('Received quantity for item 2')
    expect(oil).toHaveValue('12')
    await user.clear(oil)
    await user.type(oil, '10')
    expect(within(dialog).getByText(/Shortfall written off at the source store/)).toHaveTextContent(
      '₹260.00',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Confirm receipt' }))
    expect(await within(dialog).findByText('Tell us why some items are short.')).toBeInTheDocument()
    expect(api.callsTo(inventoryRoutes.receiveTransfer)).toHaveLength(0)
    await user.type(within(dialog).getByLabelText(/Reason for shortfall/), '2 tins dented')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm receipt' }))
    await waitFor(() => expect(api.callsTo(inventoryRoutes.receiveTransfer)).toHaveLength(1))
    const body = api.callsTo(inventoryRoutes.receiveTransfer)[0]!.body as TransferReceive
    expect(body.lines).toEqual([
      { line_id: F.iid(7851), received_qty_milli: 10_000 },
      { line_id: F.iid(7852), received_qty_milli: 10_000 },
    ])
    expect(body.shortfall_reason).toBe('2 tins dented')
    expect(body.received_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('shows receive only to members of the destination store; prints the note', async () => {
    setup()
    const user = userEvent.setup()
    const me = makeMe({ features: PRO })
    await signIn({
      ...me,
      membership: { ...me.membership, store_ids: [F.STORE_ID] },
      stores: me.stores.filter((s) => s.id === F.STORE_ID),
    })
    renderApp(`/inventory/transfers/${F.TRANSFER_ID}`)
    expect(await screen.findByText(/On the way — S2 · Anna Nagar will confirm/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel transfer' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Print note' }))
    await waitFor(() => expect(printHtml).toHaveBeenCalledTimes(1))
    const [html, options] = vi.mocked(printHtml).mock.calls[0]!
    expect(options).toMatchObject({ paper: 'a4', title: 'TRS1/2627/00003' })
    expect(html).toContain('Stock transfer note')
    expect(html).toContain('4 Second Avenue')
    expect(html).toContain('Gold Winner Sunflower Oil 1 L')
  })
})
