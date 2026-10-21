import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { beforeAll, describe, expect, it } from 'vitest'
import { setLanguage } from '@/lib/i18n'
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

const PRO = [...DEFAULT_PLAN_FEATURES.pro]

function setup(replies: Partial<Record<InventoryRouteKey, Reply>> = {}) {
  const api = createInventoryApi(replies)
  server.use(...api.handlers)
  return api
}

describe('Stock page', () => {
  it('lists stock with packs + loose quantities, values, statuses and totals', async () => {
    const api = setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/stock')
    const table = await screen.findByRole('table', { name: 'Stock' })
    const para = (await within(table).findByText('Paracetamol 500 mg')).closest('tr')!
    expect(within(para).getByText('23 strips + 5 tabs')).toBeInTheDocument()
    expect(within(para).getByText('₹517.00')).toBeInTheDocument()
    expect(within(para).getByText('In stock')).toBeInTheDocument()
    const soap = within(table).getByText('Hamam Soap 100 g').closest('tr')!
    expect(within(soap).getByText('Negative stock')).toBeInTheDocument()
    expect(within(soap).getByText('-₹66.00')).toBeInTheDocument()
    const totals = screen.getByRole('region', { name: 'Stock totals' })
    expect(within(totals).getByText('₹26,677.00')).toBeInTheDocument()
    expect(within(totals).getByText('₹32,103.50')).toBeInTheDocument()
    // Expiry alert from /stock/alerts links to the batches page of the same store.
    expect(screen.getByRole('link', { name: /1 batch has expired/ })).toHaveAttribute(
      'href',
      `/inventory/batches?store=${F.STORE_ID}&tab=expired`,
    )
    const first = api.callsTo(inventoryRoutes.listStock)[0]!.query
    expect(first.get('store_id')).toBe(F.STORE_ID)
    expect(first.get('group')).toBe('product')
    expect(first.get('sort')).toBe('name')
    expect(first.get('limit')).toBe('50')
  })

  it('filters by chips, search, store and grouping through the list query', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/stock')
    await screen.findByRole('table', { name: 'Stock' })
    const last = () => api.callsTo(inventoryRoutes.listStock).at(-1)!.query

    const chips = screen.getByRole('group', { name: 'Stock filters' })
    await user.click(within(chips).getByRole('button', { name: /^Low stock/ }))
    await waitFor(() => expect(last().get('low_stock')).toBe('true'))
    await user.click(within(chips).getByRole('button', { name: /^Out of stock/ }))
    await waitFor(() => {
      expect(last().get('out_of_stock')).toBe('true')
      expect(last().get('low_stock')).toBeNull()
    })
    await user.type(screen.getByRole('searchbox'), '8901234500017{Enter}')
    await waitFor(() => expect(last().get('q')).toBe('8901234500017'))

    await user.click(screen.getByRole('combobox', { name: 'Store' }))
    await user.click(await screen.findByRole('option', { name: /All stores/ }))
    await waitFor(() => expect(last().get('store_id')).toBe('all'))
  })

  it('pages through the list with offset', async () => {
    const api = setup({
      listStock: (c) =>
        HttpResponse.json({
          ...F.stockList(F.stockRows(), 120),
          page: F.page(120, 50, Number(c.query.get('offset') ?? 0)),
        }),
    })
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/stock')
    await screen.findByText('1–50 of 120')
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() =>
      expect(api.callsTo(inventoryRoutes.listStock).at(-1)!.query.get('offset')).toBe('50'),
    )
  })

  it('opens the product panel with stock per batch and quick actions', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/stock')
    const table = await screen.findByRole('table', { name: 'Stock' })
    await user.click(await within(table).findByText('Paracetamol 500 mg'))
    const panel = await screen.findByRole('dialog', { name: 'Paracetamol 500 mg' })
    expect(await within(panel).findByText('PCM2408')).toBeInTheDocument()
    expect(within(panel).getByText('8 strips + 5 tabs')).toBeInTheDocument()
    expect(within(panel).getByText('41 days left')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'S1-A/2627/00042' })).toHaveAttribute(
      'href',
      `/sales/invoices/${F.iid(7501)}`,
    )
    expect(within(panel).getByRole('link', { name: 'Adjust' })).toHaveAttribute(
      'href',
      `/inventory/adjustments/new?kind=adjustment&store_id=${F.STORE_ID}&product_ids=${F.P.paracetamol}`,
    )
    expect(within(panel).getByRole('link', { name: 'Transfer' })).toHaveAttribute(
      'href',
      `/inventory/transfers/new?from_store_id=${F.STORE_ID}&product_ids=${F.P.paracetamol}`,
    )
    expect(within(panel).getByRole('link', { name: 'Reorder' })).toHaveAttribute(
      'href',
      `/purchases/orders/new?source=reorder&store_id=${F.STORE_ID}&product_ids=${F.P.paracetamol}`,
    )
    expect(api.callsTo(inventoryRoutes.productStock)[0]!.query.get('store_id')).toBe(F.STORE_ID)
  })

  it('exports the filtered list as CSV', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/stock?filter=low')
    await screen.findByRole('table', { name: 'Stock' })
    URL.createObjectURL = () => 'blob:stock'
    URL.revokeObjectURL = () => {}
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => {
      const csv = api
        .callsTo(inventoryRoutes.listStock)
        .find((c) => c.query.get('format') === 'csv')
      expect(csv?.query.get('low_stock')).toBe('true')
      expect(csv?.query.get('limit')).toBeNull()
    })
    expect(await screen.findByText('Stock list downloaded')).toBeInTheDocument()
  })

  it('explains an export that is too large instead of a generic error', async () => {
    setup({
      listStock: (c) =>
        c.query.get('format') === 'csv'
          ? apiError(422, 'UNPROCESSABLE', { reason: 'export_too_large' })
          : HttpResponse.json(F.stockList()),
    })
    const user = userEvent.setup()
    await signIn(makeMe({ features: PRO }))
    renderApp('/inventory/stock')
    await screen.findByRole('table', { name: 'Stock' })
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(
      await screen.findByText('Too many rows to export at once. Narrow the filters and try again.'),
    ).toBeInTheDocument()
  })

  it('hides opening stock, adjust and transfer actions from view-only members', async () => {
    setup()
    const user = userEvent.setup()
    await signIn(
      makeMe({
        features: PRO,
        permissions: PERMISSION_CODES.filter(
          (p) => !['inventory.adjust', 'inventory.transfer', 'purchases.write'].includes(p),
        ),
      }),
    )
    renderApp('/inventory/stock')
    const table = await screen.findByRole('table', { name: 'Stock' })
    await within(table).findByText('Ponni Rice 25 kg')
    expect(screen.queryByRole('button', { name: /Opening stock/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Adjust stock' })).not.toBeInTheDocument()
    // No bulk actions → no selection checkboxes.
    expect(within(table).queryByRole('checkbox')).not.toBeInTheDocument()
    await user.click(within(table).getByText('Ponni Rice 25 kg'))
    const panel = await screen.findByRole('dialog')
    expect(within(panel).queryByRole('link', { name: 'Adjust' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('link', { name: 'Reorder' })).not.toBeInTheDocument()
  })

  it('teaches opening stock when nothing is stocked yet, in Tamil', async () => {
    setup({
      listStock: () => HttpResponse.json({ ...F.stockList([], 0) }),
      stockAlerts: () => apiError(500, 'INTERNAL'),
    })
    await signIn(makeMe({ features: PRO }))
    await setLanguage('ta', { persist: false })
    renderApp('/inventory/stock')
    expect(await screen.findByText('இன்னும் இருப்பு பதியப்படவில்லை')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'தொடக்க இருப்பைப் பதியுங்கள்' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'இருப்பு' })).toBeInTheDocument()
  })
})
