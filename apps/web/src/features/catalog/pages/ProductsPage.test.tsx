import { ProductBulkUpdateSchema } from '@kadai/shared/api/catalog'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { IDS, makeMe } from '@/test/fixtures'
import { apiPath, errorResponse, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { page, productDetail, productItem } from '../testing/fixtures'
import { directoryHandlers, recorder } from '../testing/handlers'

function setup(
  rows = [
    productItem(),
    productItem({
      name: 'Toor Dal 1 kg',
      name_ta: 'துவரம் பருப்பு',
      sku: 'DAL-1',
      low_stock: true,
      stock_qty_milli: 2_000,
    }),
  ],
) {
  const rec = recorder()
  server.use(
    ...directoryHandlers(),
    http.get(apiPath('/products'), async ({ request }) => {
      const r = await rec.record(request)
      const q = r.query.get('q')
      const data = q ? rows.filter((p) => p.name.toLowerCase().includes(q)) : rows
      return HttpResponse.json({ data, page: page(data.length) })
    }),
  )
  return rec
}

describe('Products list', () => {
  it('lists products with stock of the current store and sends the default filters', async () => {
    await signIn(makeMe())
    const rec = setup()
    renderApp('/catalog/products')
    expect(
      await screen.findByText('Ponni Rice 1 kg', undefined, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.getByText('பொன்னி அரிசி 1 கிலோ')).toBeInTheDocument()
    expect(screen.getByText('Low stock')).toBeInTheDocument()
    expect(screen.getByText('2 products')).toBeInTheDocument()
    const first = rec.find('GET', '/products')[0]!
    expect(first.query.get('store_id')).toBe(IDS.store)
    expect(first.query.get('hide_variants')).toBe('true')
    expect(first.query.get('is_active')).toBe('true')
    expect(first.query.get('sort')).toBe('name')
    expect(first.query.get('limit')).toBe('50')
  })

  it('searches by name and filters low stock through the query', async () => {
    await signIn(makeMe())
    const rec = setup()
    const user = userEvent.setup()
    renderApp('/catalog/products')
    await screen.findByText('Ponni Rice 1 kg', undefined, { timeout: 5000 })
    await user.type(screen.getByRole('searchbox', { name: /Search name/ }), 'dal{Enter}')
    await waitFor(() =>
      expect(rec.find('GET', '/products').some((c) => c.query.get('q') === 'dal')).toBe(true),
    )
    expect(await screen.findByText('Toor Dal 1 kg')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Ponni Rice 1 kg')).not.toBeInTheDocument())
    await user.click(screen.getByRole('switch', { name: 'Low stock only' }))
    await waitFor(() =>
      expect(rec.find('GET', '/products').some((c) => c.query.get('low_stock') === 'true')).toBe(
        true,
      ),
    )
  })

  it('opens the product when a scanned barcode matches, and offers to create one when not', async () => {
    await signIn(makeMe())
    setup()
    const detail = productDetail()
    server.use(
      http.get(apiPath('/products/lookup'), ({ request }) => {
        const code = new URL(request.url).searchParams.get('code')
        if (code !== '8901234567890') return errorResponse(404, 'NOT_FOUND')
        return HttpResponse.json({
          data: {
            match: 'barcode',
            code,
            qty_milli: null,
            price_paise: null,
            barcode_id: detail.barcodes[0]!.id,
            product: {
              ...detail,
              store_price_applied: false,
            },
          },
        })
      }),
      http.get(apiPath('/products/:id'), () => HttpResponse.json({ data: detail })),
    )
    const user = userEvent.setup()
    const { router } = renderApp('/catalog/products')
    await screen.findByText('Ponni Rice 1 kg', undefined, { timeout: 5000 })
    const search = screen.getByRole('searchbox', { name: /Search name/ })
    await user.type(search, '4000000000000{Enter}')
    expect(await screen.findByText('No product has the code 4000000000000.')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Add a new product with this barcode' }),
    ).toHaveAttribute('href', '/catalog/products/new?barcode=4000000000000')
    await user.clear(search)
    await user.type(search, '8901234567890{Enter}')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/catalog/products/${detail.id}`),
    )
  })

  it('hides write actions without catalog.write', async () => {
    await signIn(makeMe({ permissions: ['catalog.read'] }))
    setup()
    renderApp('/catalog/products')
    await screen.findByText('Ponni Rice 1 kg', undefined, { timeout: 5000 })
    expect(screen.queryByRole('link', { name: 'New product' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Import' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
    // Labels are in the plan, so rows can still be selected for printing — but not edited in bulk.
    await userEvent.setup().click(screen.getAllByRole('checkbox', { name: 'Select' })[1]!)
    expect(screen.queryByRole('button', { name: 'Change together' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Print labels' })).toBeInTheDocument()
  })

  it('bulk-updates the GST of the selected products', async () => {
    await signIn(makeMe())
    const rows = [productItem(), productItem({ name: 'Toor Dal 1 kg', sku: 'DAL-1' })]
    setup(rows)
    const rec = recorder()
    server.use(
      http.post(apiPath('/products/bulk-update'), async ({ request }) => {
        await rec.record(request)
        return HttpResponse.json({
          data: { matched: 1, updated: 1, unchanged: 0, capped_at_mrp: 0, not_found: [] },
        })
      }),
    )
    const user = userEvent.setup()
    renderApp('/catalog/products')
    await screen.findByText('Toor Dal 1 kg', undefined, { timeout: 5000 })
    const dalRow = screen.getByText('Toor Dal 1 kg').closest('tr')!
    await user.click(within(dalRow).getByRole('checkbox', { name: 'Select' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change together' }))
    const dialog = await screen.findByRole('dialog', { name: 'Change 1 product' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'GST rate' }))
    await user.click(within(dialog).getByRole('combobox', { name: 'GST rate' }))
    await user.click(await screen.findByRole('option', { name: '18%' }))
    await user.click(within(dialog).getByRole('button', { name: 'Apply to 1 product' }))
    await waitFor(() => expect(rec.find('POST', '/products/bulk-update')).toHaveLength(1))
    const body = rec.find('POST', '/products/bulk-update')[0]!.body
    expect(body).toEqual({ ids: [rows[1]!.id], set: { gst_rate_bp: 1800 } })
    expect(ProductBulkUpdateSchema.safeParse(body).success).toBe(true)
    expect(await screen.findByText('1 product updated')).toBeInTheDocument()
  })

  it('teaches the first steps when the catalogue is empty', async () => {
    await signIn(makeMe())
    setup([])
    renderApp('/catalog/products')
    expect(
      await screen.findByText('Add your products', undefined, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Import from Excel / CSV' })).toHaveAttribute(
      'href',
      '/catalog/import',
    )
  })
})
