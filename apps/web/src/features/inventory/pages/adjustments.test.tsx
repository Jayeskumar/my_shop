import {
  type AdjustmentCreate,
  type AdjustmentUpdate,
  inventoryRoutes,
} from '@kadai/shared/api/inventory'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import {
  apiError,
  createInventoryApi,
  type InventoryRouteKey,
  type Reply,
} from '../testing/handlers'
import { PRELOAD_TIMEOUT_MS, preloadInventoryPages } from '../testing/preload'

beforeAll(preloadInventoryPages, PRELOAD_TIMEOUT_MS)

function setup(replies: Partial<Record<InventoryRouteKey, Reply>> = {}) {
  const api = createInventoryApi(replies)
  server.use(...api.handlers)
  return api
}

async function start(path: string) {
  await signIn(makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] }))
  return renderApp(path)
}

async function addItem(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('combobox', { name: 'Add item' }))
  const list = await screen.findByRole('listbox')
  await user.click(await within(list).findByText(name))
}

describe('Stock adjustments list', () => {
  it('lists adjustments and filters by kind, status and search', async () => {
    const api = setup()
    const user = userEvent.setup()
    const { router } = await start('/inventory/adjustments')
    const table = await screen.findByRole('table', { name: 'Stock adjustments' })
    const posted = (await within(table).findByText('ADJS1/2627/00003')).closest('tr')!
    expect(within(posted).getByText('Damage')).toBeInTheDocument()
    expect(within(posted).getByText('-₹1,380.00')).toBeInTheDocument()
    expect(within(posted).getByText('Posted')).toBeInTheDocument()
    const last = () => api.callsTo(inventoryRoutes.listAdjustments).at(-1)!.query
    expect(last().get('sort')).toBe('-adjustment_date')

    const kinds = screen.getByRole('group', { name: 'Adjustment kinds' })
    await user.click(within(kinds).getByRole('button', { name: 'Stock take' }))
    await waitFor(() => expect(last().get('kind')).toBe('stock_take'))
    await user.type(screen.getByRole('searchbox'), 'ADJS1{Enter}')
    await waitFor(() => expect(last().get('q')).toBe('ADJS1'))

    await user.click(within(table).getAllByText('Draft')[0]!)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/inventory/adjustments/${F.ADJ_DRAFT_ID}`),
    )
  })
})

describe('Adjustment editor', () => {
  it('records damage: scan, quantity, reason by default, post after confirmation', async () => {
    const api = setup()
    const user = userEvent.setup()
    const { router } = await start('/inventory/adjustments/new?kind=damage')
    expect(await screen.findByRole('radio', { name: /Damage/ })).toBeChecked()
    await addItem(user, 'Ponni Rice 25 kg')
    await user.type(screen.getByLabelText('Quantity for item 1'), '2{Enter}')
    // Loss estimate at the purchase price (2 × ₹1,380).
    const summary = screen.getByRole('complementary', { name: 'Value impact' })
    expect(within(summary).getAllByText('₹2,760.00').length).toBeGreaterThan(0)

    await user.click(within(summary).getByRole('button', { name: 'Post' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Post this Damage?' })
    expect(within(confirm).getByText(/1 item will change\. Loss ₹2,760\.00\./)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Post' }))

    await waitFor(() => expect(api.callsTo(inventoryRoutes.postAdjustment)).toHaveLength(1))
    const body = api.callsTo(inventoryRoutes.createAdjustment)[0]!.body as AdjustmentCreate
    expect(body).toMatchObject({ store_id: F.STORE_ID, kind: 'damage', notes: null })
    expect(body.adjustment_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.lines).toEqual([
      { product_id: F.P.rice, batch_id: null, reason: 'damaged', qty_delta_milli: -2_000 },
    ])
    expect(api.callsTo(inventoryRoutes.postAdjustment)[0]!.path).toBe(
      `/api/v1/stock-adjustments/${F.iid(7609)}/post`,
    )
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/inventory/adjustments/${F.ADJ_ID}`),
    )
    expect(await screen.findByRole('heading', { name: 'ADJS1/2627/00003' })).toBeInTheDocument()
  })

  it('retries a failed post by updating the draft it created, not creating it again', async () => {
    const created = F.adjustmentDetail({ id: F.iid(7609), status: 'draft', number: null })
    let posts = 0
    const api = setup({
      createAdjustment: () => HttpResponse.json({ data: created }, { status: 201 }),
      updateAdjustment: () =>
        HttpResponse.json({ data: { ...created, updated_at: '2026-10-21T09:30:00.000Z' } }),
      postAdjustment: () => {
        posts += 1
        return posts === 1
          ? apiError(422, 'INSUFFICIENT_STOCK', { product_id: F.P.rice, available_milli: 1_000 })
          : HttpResponse.json({ data: F.adjustmentDetail() })
      },
    })
    const user = userEvent.setup()
    const { router } = await start('/inventory/adjustments/new?kind=damage')
    await addItem(user, 'Ponni Rice 25 kg')
    await user.type(screen.getByLabelText('Quantity for item 1'), '2')
    const summary = screen.getByRole('complementary', { name: 'Value impact' })
    const post = async () => {
      await user.click(within(summary).getByRole('button', { name: 'Post' }))
      const confirm = await screen.findByRole('alertdialog', { name: 'Post this Damage?' })
      await user.click(within(confirm).getByRole('button', { name: 'Post' }))
    }
    await post()
    await waitFor(() => expect(api.callsTo(inventoryRoutes.postAdjustment)).toHaveLength(1))
    expect(router.state.location.pathname).toBe('/inventory/adjustments/new')

    // Only 1 bag is left: correct the quantity and post again.
    const qty = screen.getByLabelText('Quantity for item 1')
    await user.clear(qty)
    await user.type(qty, '1')
    await post()
    await waitFor(() => expect(api.callsTo(inventoryRoutes.postAdjustment)).toHaveLength(2))
    expect(api.callsTo(inventoryRoutes.createAdjustment)).toHaveLength(1)
    const updates = api.callsTo(inventoryRoutes.updateAdjustment)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.path).toBe(`/api/v1/stock-adjustments/${F.iid(7609)}`)
    const body = updates[0]!.body as AdjustmentUpdate
    expect(body.if_updated_at).toBe(created.updated_at)
    expect(body.lines?.map((l) => l.qty_delta_milli)).toEqual([-1_000])
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/inventory/adjustments/${F.ADJ_ID}`),
    )
  })

  it('uses the + / − toggle for adjustments and blocks lines without a quantity', async () => {
    const api = setup()
    const user = userEvent.setup()
    await start('/inventory/adjustments/new')
    await addItem(user, 'Ponni Rice 25 kg')
    await addItem(user, 'Gold Winner Sunflower Oil 1 L')
    const summary = screen.getByRole('complementary', { name: 'Value impact' })
    await user.click(within(summary).getByRole('button', { name: 'Save draft' }))
    expect(await screen.findAllByText('Enter the quantity')).toHaveLength(2)
    expect(api.callsTo(inventoryRoutes.createAdjustment)).toHaveLength(0)

    await user.type(screen.getByLabelText('Quantity for item 1'), '3')
    await user.click(
      within(screen.getByRole('group', { name: 'Increase or reduce item 2' })).getByRole('button', {
        name: 'Reduce',
      }),
    )
    await user.type(screen.getByLabelText('Quantity for item 2'), '1')
    await user.click(within(summary).getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(api.callsTo(inventoryRoutes.createAdjustment)).toHaveLength(1))
    const body = api.callsTo(inventoryRoutes.createAdjustment)[0]!.body as AdjustmentCreate
    expect(body.kind).toBe('adjustment')
    expect(body.lines?.map((l) => [l.product_id, l.qty_delta_milli])).toEqual([
      [F.P.rice, 3_000],
      [F.P.oil, -1_000],
    ])
    expect(api.callsTo(inventoryRoutes.postAdjustment)).toHaveLength(0)
  })

  it('prefills an expiry write-off from batches (whole batch quantity)', async () => {
    const api = setup({
      listBatches: () =>
        new Response(JSON.stringify({ data: [F.batch()], page: F.page(1) }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    const user = userEvent.setup()
    await start(
      `/inventory/adjustments/new?kind=expiry_writeoff&store_id=${F.STORE_ID}&batch_ids=${F.B.para1}&product_ids=${F.P.paracetamol}`,
    )
    expect(await screen.findByLabelText('Quantity for item 1')).toHaveValue('85')
    const prefillQuery = api.callsTo(inventoryRoutes.listBatches)[0]!.query
    expect(prefillQuery.getAll('ids')).toEqual([F.B.para1])
    expect(prefillQuery.get('store_id')).toBe(F.STORE_ID)
    const summary = screen.getByRole('complementary', { name: 'Value impact' })
    await user.click(within(summary).getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(api.callsTo(inventoryRoutes.createAdjustment)).toHaveLength(1))
    const body = api.callsTo(inventoryRoutes.createAdjustment)[0]!.body as AdjustmentCreate
    expect(body).toMatchObject({ kind: 'expiry_writeoff', store_id: F.STORE_ID })
    expect(body.lines).toEqual([
      {
        product_id: F.P.paracetamol,
        batch_id: F.B.para1,
        reason: 'expired',
        qty_delta_milli: -85_000,
      },
    ])
  })

  it('counts a draft stock take: differences, scan-to-count, PATCH then post', async () => {
    const api = setup()
    const user = userEvent.setup()
    await start(`/inventory/adjustments/${F.ADJ_DRAFT_ID}`)
    expect(await screen.findByRole('radio', { name: /Stock take/ })).toBeChecked()
    const oil = screen.getByLabelText('Counted quantity for item 2')
    expect(oil).toHaveValue('8')
    const oilRow = oil.closest('li')!
    expect(oilRow).toHaveTextContent('−1 pc')

    // Each scan of an already listed item adds one to its count.
    await addItem(user, 'Ponni Rice 25 kg')
    expect(screen.getByLabelText('Counted quantity for item 1')).toHaveValue('19')
    await user.clear(oil)
    await user.type(oil, '9')
    expect(within(oilRow).getByText('Matches')).toBeInTheDocument()

    const summary = screen.getByRole('complementary', { name: 'Value impact' })
    await user.click(within(summary).getByRole('button', { name: 'Post' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post' }),
    )
    await waitFor(() => expect(api.callsTo(inventoryRoutes.postAdjustment)).toHaveLength(1))
    const patch = api.callsTo(inventoryRoutes.updateAdjustment)[0]!.body as AdjustmentUpdate
    expect(patch).toMatchObject({ kind: 'stock_take', if_updated_at: F.NOW })
    expect(patch.lines).toEqual([
      { product_id: F.P.rice, batch_id: null, reason: null, counted_qty_milli: 19_000 },
      { product_id: F.P.oil, batch_id: null, reason: 'count_correction', counted_qty_milli: 9_000 },
    ])
    expect(api.callsTo(inventoryRoutes.createAdjustment)).toHaveLength(0)
  })

  it('loads the shelf to count, leaving out batches with nothing left', async () => {
    const batchRow = (id: number, batch_no: string, qty_milli: number) =>
      F.stockRow({
        product_id: F.P.paracetamol,
        name: 'Paracetamol 500 mg',
        unit: 'TAB',
        pack_size: 10,
        track_batches: true,
        batch_id: F.iid(id),
        batch_no,
        expiry_date: '2027-03-31',
        qty_milli,
      })
    setup({
      listStock: () =>
        HttpResponse.json(
          F.stockList([
            F.stockRow({ qty_milli: 0, status: 'out' }),
            batchRow(7101, 'PCM-OLD', 0),
            batchRow(7102, 'PCM2408', 120_000),
          ]),
        ),
    })
    const user = userEvent.setup()
    await start('/inventory/adjustments/new?kind=stock_take')
    await user.click(await screen.findByRole('button', { name: 'Load items' }))
    // The out-of-stock rice can still be found on the shelf; the empty PCM-OLD batch is skipped.
    expect(await screen.findByText('2 items loaded')).toBeInTheDocument()
    expect(screen.getByLabelText('Counted quantity for item 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Counted quantity for item 2')).toBeInTheDocument()
    expect(screen.queryByLabelText('Counted quantity for item 3')).not.toBeInTheDocument()
  })

  it('saves with Ctrl+S and asks to post with Ctrl+Enter from the keyboard', async () => {
    const api = setup()
    const user = userEvent.setup()
    await start('/inventory/adjustments/new?kind=damage')
    await addItem(user, 'Ponni Rice 25 kg')
    const qty = screen.getByLabelText('Quantity for item 1')
    await user.type(qty, '1')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(
      await screen.findByRole('alertdialog', { name: 'Post this Damage?' }),
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    qty.focus()
    await user.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(api.callsTo(inventoryRoutes.createAdjustment)).toHaveLength(1))
    expect(api.callsTo(inventoryRoutes.postAdjustment)).toHaveLength(0)
  })

  it('cancels a posted adjustment with a reason', async () => {
    const api = setup()
    const user = userEvent.setup()
    await start(`/inventory/adjustments/${F.ADJ_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel adjustment' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel ADJS1/2627/00003?' })
    const confirm = within(dialog).getByRole('button', { name: 'Cancel adjustment' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox'), 'Entered twice')
    await user.click(confirm)
    await waitFor(() => expect(api.callsTo(inventoryRoutes.cancelAdjustment)).toHaveLength(1))
    expect(api.callsTo(inventoryRoutes.cancelAdjustment)[0]!.body).toEqual({
      reason: 'Entered twice',
    })
  })
})
