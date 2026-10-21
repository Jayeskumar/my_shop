import { type BatchUpdate, inventoryRoutes } from '@kadai/shared/api/inventory'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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

const PRO = [...DEFAULT_PLAN_FEATURES.pro]

function setup(replies: Partial<Record<InventoryRouteKey, Reply>> = {}) {
  const api = createInventoryApi(replies)
  server.use(...api.handlers)
  return api
}

describe('Batches & expiry', () => {
  it('switches expiry windows through the batch query', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/batches')
    const table = await screen.findByRole('table', { name: 'Batches & expiry' })
    const ghee = (await within(table).findByText('AV0926')).closest('tr')!
    expect(within(ghee).getByText('Expired 8 days ago')).toBeInTheDocument()
    expect(within(ghee).getByText('12-10-2026')).toBeInTheDocument()
    const last = () => api.callsTo(inventoryRoutes.listBatches).at(-1)!.query
    expect(last().get('expiring_within_days')).toBe('90')
    expect(last().get('with_stock_only')).toBe('true')
    expect(last().get('sort')).toBe('expiry_date')

    await user.click(screen.getByRole('tab', { name: /Expired/ }))
    await waitFor(() => {
      expect(last().get('expired')).toBe('true')
      expect(last().get('expiring_within_days')).toBeNull()
    })
    await user.click(screen.getByRole('tab', { name: 'Within 30 days' }))
    await waitFor(() => expect(last().get('expiring_within_days')).toBe('30'))
  })

  it('writes off or returns selected batches through the prefill links', async () => {
    setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    const { router } = renderApp('/inventory/batches')
    const table = await screen.findByRole('table', { name: 'Batches & expiry' })
    const para1 = (await within(table).findByText('PCM2408')).closest('tr')!
    const para2 = within(table).getByText('PCM2502').closest('tr')!
    await user.click(within(para1).getByRole('checkbox'))
    await user.click(within(para2).getByRole('checkbox'))
    const bar = screen.getByRole('region', { name: 'Selected batches' })
    expect(bar).toHaveTextContent('2 batches selected')
    expect(within(bar).getByRole('link', { name: 'Return to supplier' })).toHaveAttribute(
      'href',
      `/purchases/returns/new?store_id=${F.STORE_ID}&supplier_id=${F.SUPPLIER_ID}&batch_ids=${encodeURIComponent(`${F.B.para1},${F.B.para2}`)}`,
    )
    await user.click(within(bar).getByRole('link', { name: 'Write off' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/inventory/adjustments/new'))
    const search = new URLSearchParams(router.state.location.search)
    expect(search.get('kind')).toBe('expiry_writeoff')
    expect(search.get('batch_ids')).toBe(`${F.B.para1},${F.B.para2}`)
    expect(search.get('product_ids')).toBe(F.P.paracetamol)
  })

  it('edits batch MRP and expiry, sending only what changed', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/batches')
    const table = await screen.findByRole('table', { name: 'Batches & expiry' })
    await user.click(await within(table).findByText('PCM2408'))
    const dialog = await screen.findByRole('dialog', { name: 'Edit batch PCM2408' })
    const mrp = within(dialog).getByLabelText('MRP')
    await user.clear(mrp)
    await user.type(mrp, '38')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.callsTo(inventoryRoutes.updateBatch)).toHaveLength(1))
    const call = api.callsTo(inventoryRoutes.updateBatch)[0]!
    expect(call.path).toBe(`/api/v1/batches/${F.B.para1}`)
    expect(call.body as BatchUpdate).toEqual({ if_updated_at: F.NOW, mrp_paise: 3_800 })
    expect(await screen.findByText('Batch updated')).toBeInTheDocument()
  })

  it('shows a friendly message when someone else edited the batch', async () => {
    setup({ updateBatch: () => apiError(409, 'STALE_WRITE') })
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/batches')
    const table = await screen.findByRole('table', { name: 'Batches & expiry' })
    await user.click(await within(table).findByText('PCM2502'))
    const dialog = await screen.findByRole('dialog')
    const mrp = within(dialog).getByLabelText('MRP')
    await user.clear(mrp)
    await user.type(mrp, '40')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/Someone else changed this batch/)).toBeInTheDocument()
  })

  it('hides write-off and supplier return when the member cannot use them', async () => {
    setup()
    await signIn(
      makeMe({
        features: PRO,
        permissions: PERMISSION_CODES.filter(
          (p) => !['inventory.adjust', 'purchases.write', 'catalog.write'].includes(p),
        ),
      }),
    )
    renderApp('/inventory/batches')
    const table = await screen.findByRole('table', { name: 'Batches & expiry' })
    await within(table).findByText('PCM2408')
    expect(within(table).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(
      within(table).queryByRole('button', { name: /Actions for batch/ }),
    ).not.toBeInTheDocument()
  })
})

describe('Stock movements', () => {
  it('shows the ledger with signed quantities, balances and document links', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp(`/inventory/movements?product=${F.P.rice}`)
    const table = await screen.findByRole('table', { name: 'Stock movements' })
    const purchase = (await within(table).findByText('PB/2627/00007')).closest('tr')!
    expect(purchase).toHaveTextContent('+10 pcs')
    expect(within(purchase).getByText('20 pcs')).toBeInTheDocument()
    expect(within(purchase).getByRole('link', { name: 'PB/2627/00007' })).toHaveAttribute(
      'href',
      `/purchases/bills/${F.iid(7503)}`,
    )
    const damage = within(table).getByText('ADJS1/2627/00003').closest('tr')!
    expect(damage).toHaveTextContent('−1 pc')
    expect(within(damage).getByText('Damaged')).toBeInTheDocument()
    const last = () => api.callsTo(inventoryRoutes.listMovements).at(-1)!.query
    expect(last().get('product_id')).toBe(F.P.rice)
    expect(last().get('sort')).toBe('-created_at')

    const types = screen.getByRole('group', { name: 'Movement types' })
    await user.click(within(types).getByRole('button', { name: 'Sale' }))
    await user.click(within(types).getByRole('button', { name: 'Sales return' }))
    await waitFor(() => expect(last().getAll('type')).toEqual(['sale', 'sale_return']))
  })
})
