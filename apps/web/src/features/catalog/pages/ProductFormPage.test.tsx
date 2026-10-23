import { ProductCreateSchema, ProductUpdateSchema } from '@kadai/shared/api/catalog'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { makeMe } from '@/test/fixtures'
import { apiPath, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { page, productDetail } from '../testing/fixtures'
import { directoryHandlers, recorder } from '../testing/handlers'

function handlers(detail = productDetail()) {
  const rec = recorder()
  server.use(
    ...directoryHandlers(),
    http.get(apiPath('/products'), () => HttpResponse.json({ data: [], page: page(0) })),
    http.get(apiPath('/products/:id'), () => HttpResponse.json({ data: detail })),
    http.post(apiPath('/products'), async ({ request }) => {
      const r = await rec.record(request)
      return HttpResponse.json(
        { data: { ...detail, ...(r.body as object), barcodes: [], primary_barcode: null } },
        { status: 201 },
      )
    }),
    http.patch(apiPath('/products/:id'), async ({ request }) => {
      const r = await rec.record(request)
      return HttpResponse.json({
        data: { ...detail, ...(r.body as object), updated_at: '2026-10-21T10:00:00.000Z' },
      })
    }),
  )
  return { rec, detail }
}

describe('Product form — new product', () => {
  it('fills GST from the category and posts a contract-valid body', async () => {
    await signIn(makeMe())
    const { rec, detail } = handlers()
    const user = userEvent.setup()
    const { router } = renderApp('/catalog/products/new')
    const name = await screen.findByRole('textbox', { name: 'Name (English)' }, { timeout: 5000 })
    // A fresh form is not dirty (no "unsaved changes" warning before typing).
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    await user.type(name, 'Ponni Rice 1 kg')
    await user.type(screen.getByRole('textbox', { name: /Name in Tamil/ }), 'பொன்னி அரிசி')
    await user.click(screen.getByRole('combobox', { name: /Category/ }))
    const picker = await screen.findByRole('dialog')
    await user.click(await within(picker).findByRole('option', { name: /Rice/ }))
    expect(await screen.findByText(/Filled from “Rice”: HSN 1006, GST 5%/)).toBeInTheDocument()
    const price = screen.getByRole('textbox', { name: /Selling price/ })
    await user.type(price, '68')
    await user.type(screen.getByRole('textbox', { name: /^MRP/ }), '72')
    await user.type(screen.getByRole('textbox', { name: /Purchase price/ }), '60')
    // Live margin: 68 incl. 5% GST = 64.76 excl.; profit 4.76 on 64.76 → 7.35%.
    expect(await screen.findByText('7.35% · ₹4.76')).toBeInTheDocument()
    expect(screen.getByText('₹4.00 (5.56%)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save product/ }))

    await waitFor(() => expect(rec.find('POST', '/products')).toHaveLength(1))
    const body = rec.find('POST', '/products')[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({
      kind: 'standard',
      name: 'Ponni Rice 1 kg',
      name_ta: 'பொன்னி அரிசி',
      hsn_code: '1006',
      gst_rate_bp: 500,
      sale_price_paise: 6_800,
      mrp_paise: 7_200,
      purchase_price_paise: 6_000,
      unit: 'PCS',
      price_includes_tax: true,
    })
    expect(ProductCreateSchema.safeParse(body).success).toBe(true)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/catalog/products/${detail.id}`),
    )
  }, 40_000) // types into many fields; slow on a loaded CI machine

  it('shows required and MRP errors and sends nothing', async () => {
    await signIn(makeMe())
    const { rec } = handlers()
    const user = userEvent.setup()
    renderApp('/catalog/products/new')
    await screen.findByRole('textbox', { name: 'Name (English)' }, { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: /Save product/ }))
    expect(await screen.findByText('Please correct the highlighted fields.')).toBeInTheDocument()
    expect(screen.getAllByText('This field is required').length).toBeGreaterThan(0)
    await user.type(screen.getByRole('textbox', { name: 'Name (English)' }), 'Soap')
    await user.type(screen.getByRole('textbox', { name: /Selling price/ }), '50')
    await user.type(screen.getByRole('textbox', { name: /^MRP/ }), '45')
    await user.click(screen.getByRole('button', { name: /Save product/ }))
    expect(await screen.findByText('Selling price is more than the MRP.')).toBeInTheDocument()
    expect(rec.find('POST', '/products')).toHaveLength(0)
  })

  it('prefills a scanned barcode and shows the strip helper for pharmacies', async () => {
    await signIn(makeMe({ businessType: 'pharmacy' }))
    handlers()
    const user = userEvent.setup()
    renderApp('/catalog/products/new?barcode=8901234567890')
    expect(
      await screen.findByText('8901234567890', undefined, { timeout: 5000 }),
    ).toBeInTheDocument()
    const pack = screen.getByRole('textbox', { name: /Pack size/ })
    await user.clear(pack)
    await user.type(pack, '10')
    await user.type(screen.getByRole('textbox', { name: /Selling price/ }), '25')
    expect(await screen.findByText(/1 strip = 10 pcs · ₹2.50 per pc/)).toBeInTheDocument()
    expect(screen.getByText('Medicine details')).toBeInTheDocument()
    expect(screen.getByText('Over the counter — no prescription needed.')).toBeInTheDocument()
  })
})

describe('Product form — edit', () => {
  it('saves only the changed fields with Ctrl+S', async () => {
    await signIn(makeMe())
    const { rec, detail } = handlers()
    const user = userEvent.setup()
    renderApp(`/catalog/products/${detail.id}`)
    const price = await screen.findByRole('textbox', { name: /Selling price/ }, { timeout: 5000 })
    expect(screen.getByRole('heading', { level: 1, name: 'Ponni Rice 1 kg' })).toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    await user.clear(price)
    await user.type(price, '65')
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true })
    await waitFor(() => expect(rec.find('PATCH', `/products/${detail.id}`)).toHaveLength(1))
    const body = rec.find('PATCH', `/products/${detail.id}`)[0]!.body
    expect(body).toEqual({ sale_price_paise: 6_500, if_updated_at: detail.updated_at })
    expect(ProductUpdateSchema.safeParse(body).success).toBe(true)
    expect(await screen.findByText('“Ponni Rice 1 kg” saved')).toBeInTheDocument()
  })

  it('explains a 409 stock_on_hand on the field that cannot change', async () => {
    await signIn(makeMe())
    const { detail } = handlers()
    server.use(
      http.patch(apiPath('/products/:id'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'Batch tracking cannot change while the product has stock',
              details: { reason: 'stock_on_hand', field: 'track_batches' },
              request_id: 'r1',
            },
          },
          { status: 409 },
        ),
      ),
    )
    const user = userEvent.setup()
    renderApp(`/catalog/products/${detail.id}`)
    const batches = await screen.findByRole(
      'switch',
      { name: /Batches & expiry/ },
      { timeout: 5000 },
    )
    await user.click(batches)
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true })
    expect((await screen.findAllByText(/This product still has stock/)).length).toBeGreaterThan(0)
  })

  it('is read-only without catalog.write', async () => {
    await signIn(makeMe({ permissions: ['catalog.read'] }))
    const { detail } = handlers()
    renderApp(`/catalog/products/${detail.id}`)
    const price = await screen.findByRole('textbox', { name: /Selling price/ }, { timeout: 5000 })
    expect(price).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument()
    expect(screen.getByText(/You can view this product/)).toBeInTheDocument()
  })
})
