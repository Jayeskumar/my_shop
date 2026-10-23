import { inventoryRoutes, type OpeningStock } from '@kadai/shared/api/inventory'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
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

async function openDialog() {
  await signIn(makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] }))
  renderApp('/inventory/stock?opening=1')
  return screen.findByRole('dialog', { name: 'Opening stock' })
}

async function addItem(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  name: string,
) {
  await user.click(within(dialog).getByRole('combobox', { name: 'Add item' }))
  const list = await screen.findByRole('listbox')
  await user.click(await within(list).findByText(name))
}

describe('Opening stock', () => {
  it('posts the grid as the contract body after confirmation', async () => {
    const api = setup()
    const user = userEvent.setup()
    const dialog = await openDialog()
    await addItem(user, dialog, 'Ponni Rice 25 kg')
    await user.type(within(dialog).getByLabelText('Qty · 1'), '12')
    expect(within(dialog).getByLabelText('Cost / pack · 1')).toHaveValue('1,380.00')
    await addItem(user, dialog, 'Paracetamol 500 mg')
    await user.type(within(dialog).getByLabelText('Qty · 2'), '100')
    await user.type(within(dialog).getByLabelText('Batch · 2'), 'pcm9')
    expect(within(dialog).getByText(/2 items/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Post opening stock' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/₹16,780.00/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Post opening stock' }))

    await waitFor(() => expect(api.callsTo(inventoryRoutes.postOpeningStock)).toHaveLength(1))
    const call = api.callsTo(inventoryRoutes.postOpeningStock)[0]!
    const body = call.body as OpeningStock
    expect(body).toMatchObject({ store_id: F.STORE_ID, force: false, notes: null })
    expect(body.lines).toEqual([
      { product_id: F.P.rice, qty_milli: 12_000, unit_cost_paise: 138_000 },
      {
        product_id: F.P.paracetamol,
        qty_milli: 100_000,
        unit_cost_paise: 2_200,
        batch: { batch_no: 'PCM9', expiry_date: null, mrp_paise: 3_500 },
      },
    ])
    expect(call.headers.get('idempotency-key')).toBeTruthy()
    expect(await screen.findByText(/Opening stock of 2 items posted/)).toBeInTheDocument()
  })

  it('asks for a batch and a quantity before posting', async () => {
    const api = setup()
    const user = userEvent.setup()
    const dialog = await openDialog()
    await addItem(user, dialog, 'Paracetamol 500 mg')
    await user.click(within(dialog).getByRole('button', { name: 'Post opening stock' }))
    expect(await within(dialog).findByText('This field is required')).toBeInTheDocument()
    expect(within(dialog).getByText('Choose the batch')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.callsTo(inventoryRoutes.postOpeningStock)).toHaveLength(0)
  })

  it('re-posts with force after the user confirms items that already moved', async () => {
    const api = setup({
      postOpeningStock: (c) =>
        (c.body as OpeningStock).force
          ? HttpResponse.json(
              {
                data: {
                  adjustment: F.adjustmentDetail({ kind: 'opening' }),
                  total_value_paise: 1_380_000,
                  journal_entry_id: null,
                  batches_created: [],
                },
              },
              { status: 201 },
            )
          : apiError(409, 'CONFLICT', { reason: 'has_movements', product_ids: [F.P.rice] }),
    })
    const user = userEvent.setup()
    const dialog = await openDialog()
    await addItem(user, dialog, 'Ponni Rice 25 kg')
    await user.type(within(dialog).getByLabelText('Qty · 1'), '10')
    await user.click(within(dialog).getByRole('button', { name: 'Post opening stock' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Post opening stock',
      }),
    )
    const warning = await screen.findByRole('alertdialog', {
      name: '1 item already has stock entries',
    })
    expect(within(warning).getByText(/Ponni Rice 25 kg — already sold/)).toBeInTheDocument()
    await user.click(within(warning).getByRole('button', { name: 'Post anyway' }))
    await waitFor(() => expect(api.callsTo(inventoryRoutes.postOpeningStock)).toHaveLength(2))
    const [first, second] = api.callsTo(inventoryRoutes.postOpeningStock)
    expect((second!.body as OpeningStock).force).toBe(true)
    // A changed body is never sent with the same idempotency key.
    expect(second!.headers.get('idempotency-key')).not.toBe(first!.headers.get('idempotency-key'))
  })

  it('adds rows pasted from Excel by barcode / SKU and reports unknown codes', async () => {
    const api = setup()
    const user = userEvent.setup()
    const dialog = await openDialog()
    await user.click(within(dialog).getByRole('button', { name: 'Paste from Excel' }))
    await user.click(within(dialog).getByLabelText('Paste rows'))
    await user.paste('8901234500017\t18\t1400\nNOPE-1\t3\n')
    await user.click(within(dialog).getByRole('button', { name: 'Add pasted rows' }))
    expect(await within(dialog).findByText('Ponni Rice 25 kg')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Qty · 1')).toHaveValue('18')
    expect(within(dialog).getByLabelText('Cost / pack · 1')).toHaveValue('1,400.00')
    expect(within(dialog).getByText('Row 2: product “NOPE-1” not found')).toBeInTheDocument()
    expect(api.callsTo(inventoryRoutes.postOpeningStock)).toHaveLength(0)
  })
})
