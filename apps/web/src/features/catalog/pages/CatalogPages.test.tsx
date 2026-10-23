import {
  BrandCreateSchema,
  CategoryCreateSchema,
  LABEL_TEMPLATES,
  LabelRequestSchema,
  ProductImportSchema,
  PromotionCreateSchema,
  StorePricesUpdateSchema,
  TaxSlabRuleCreateSchema,
} from '@kadai/shared/api/catalog'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { IDS, makeMe } from '@/test/fixtures'
import { apiPath, errorResponse, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import {
  brand,
  category,
  importJob,
  page,
  productItem,
  promotion,
  slabRule,
  uid,
} from '../testing/fixtures'
import { directoryHandlers, recorder } from '../testing/handlers'

const LONG = { timeout: 5000 }

describe('Categories', () => {
  it('shows the tree with counts and adds a sub-category', async () => {
    await signIn(makeMe())
    const rec = recorder()
    const grocery = category({
      name: 'Grocery',
      name_ta: 'மளிகை',
      product_count: 12,
      child_count: 1,
    })
    const rice = category({
      name: 'Rice',
      name_ta: 'அரிசி',
      parent_id: grocery.id,
      depth: 2,
      path: 'Grocery > Rice',
      product_count: 3,
    })
    server.use(
      http.get(apiPath('/categories'), ({ request }) => {
        const flat = new URL(request.url).searchParams.get('flat') === 'true'
        return HttpResponse.json({
          data: flat ? [grocery, rice] : [{ ...grocery, children: [rice] }],
        })
      }),
      http.post(apiPath('/categories'), async ({ request }) => {
        const r = await rec.record(request)
        return HttpResponse.json(
          { data: category({ ...(r.body as object), depth: 2 }) },
          { status: 201 },
        )
      }),
      ...directoryHandlers(),
    )
    const user = userEvent.setup()
    renderApp('/catalog/categories')
    expect(await screen.findByText('Grocery', undefined, LONG)).toBeInTheDocument()
    expect(screen.getByText('Rice')).toBeInTheDocument()
    // A parent counts the products of its sub-categories too (the link filters them all).
    const groceryLinks = screen.getAllByRole('link', { name: '15 products' })
    expect(groceryLinks.length).toBeGreaterThan(0)
    for (const link of groceryLinks)
      expect(link).toHaveAttribute('href', `/catalog/products?category_id=${grocery.id}`)
    expect(screen.getAllByRole('link', { name: '3 products' })[0]).toHaveAttribute(
      'href',
      `/catalog/products?category_id=${rice.id}`,
    )
    await user.click(screen.getByRole('button', { name: 'Add sub-category to Grocery' }))
    const dialog = await screen.findByRole('dialog', { name: 'New sub-category of Grocery' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Name (English)' }), 'Oil')
    await user.type(within(dialog).getByRole('textbox', { name: /Name in Tamil/ }), 'எண்ணெய்')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(rec.find('POST', '/categories')).toHaveLength(1))
    const body = rec.find('POST', '/categories')[0]!.body
    expect(body).toMatchObject({ name: 'Oil', name_ta: 'எண்ணெய்', parent_id: grocery.id })
    expect(CategoryCreateSchema.safeParse(body).success).toBe(true)
  })

  it('offers to deactivate a category that is still used', async () => {
    await signIn(makeMe())
    const used = category({ name: 'Snacks', product_count: 4 })
    const rec = recorder()
    server.use(
      http.get(apiPath('/categories'), () => HttpResponse.json({ data: [used] })),
      http.delete(apiPath('/categories/:id'), () =>
        errorResponse(409, 'CONFLICT', 'in use', {
          reason: 'in_use_deactivate',
          hint: 'deactivate',
        }),
      ),
      http.patch(apiPath('/categories/:id'), async ({ request }) => {
        await rec.record(request)
        return HttpResponse.json({ data: { ...used, is_active: false } })
      }),
      ...directoryHandlers(),
    )
    const user = userEvent.setup()
    renderApp('/catalog/categories')
    await screen.findByText('Snacks', undefined, LONG)
    await user.click(screen.getByRole('button', { name: 'More actions for Snacks' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('“Snacks” is in use')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(rec.find('PATCH', `/categories/${used.id}`)).toHaveLength(1))
    expect(rec.find('PATCH', `/categories/${used.id}`)[0]!.body).toEqual({
      is_active: false,
      if_updated_at: used.updated_at,
    })
  })

  it('hides editing without catalog.write', async () => {
    await signIn(makeMe({ permissions: ['catalog.read'] }))
    server.use(...directoryHandlers())
    renderApp('/catalog/categories')
    await screen.findByText('Grocery', undefined, LONG)
    expect(screen.queryByRole('button', { name: 'Add category' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add sub-category/ })).not.toBeInTheDocument()
  })
})

describe('Brands', () => {
  it('adds a brand inline with Enter and renames it', async () => {
    await signIn(makeMe())
    const rec = recorder()
    const aachi = brand({ name: 'Aachi' })
    server.use(
      http.get(apiPath('/brands'), () => HttpResponse.json({ data: [aachi], page: page(1) })),
      http.post(apiPath('/brands'), async ({ request }) => {
        const r = await rec.record(request)
        return HttpResponse.json({ data: brand(r.body as object) }, { status: 201 })
      }),
      http.patch(apiPath('/brands/:id'), async ({ request }) => {
        const r = await rec.record(request)
        return HttpResponse.json({ data: { ...aachi, ...(r.body as object) } })
      }),
    )
    const user = userEvent.setup()
    renderApp('/catalog/brands')
    await screen.findByText('Aachi', undefined, LONG)
    await user.type(screen.getByRole('textbox', { name: 'New brand name' }), 'Sakthi{Enter}')
    await waitFor(() => expect(rec.find('POST', '/brands')).toHaveLength(1))
    expect(BrandCreateSchema.parse(rec.find('POST', '/brands')[0]!.body)).toEqual({
      name: 'Sakthi',
    })
    await user.click(screen.getByRole('button', { name: 'Rename Aachi' }))
    const input = screen.getByRole('textbox', { name: 'Rename Aachi' })
    await user.clear(input)
    await user.type(input, 'Aachi Masala{Enter}')
    await waitFor(() => expect(rec.find('PATCH', `/brands/${aachi.id}`)).toHaveLength(1))
    expect(rec.find('PATCH', `/brands/${aachi.id}`)[0]!.body).toEqual({
      name: 'Aachi Masala',
      if_updated_at: aachi.updated_at,
    })
  })
})

describe('Price-based GST rules', () => {
  it('lists rules and checks a price with the live calculator before saving', async () => {
    await signIn(makeMe({ businessType: 'apparel' }))
    const rec = recorder()
    server.use(
      ...directoryHandlers(),
      http.post(apiPath('/tax-slab-rules'), async ({ request }) => {
        const r = await rec.record(request)
        return HttpResponse.json({ data: slabRule(r.body as object) }, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderApp('/catalog/tax-rules')
    expect(await screen.findByText('Readymade garments', undefined, LONG)).toBeInTheDocument()
    expect(screen.getByText('Up to ₹2,500')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New rule' }))
    const dialog = await screen.findByRole('dialog', { name: 'New price-based GST rule' })
    expect(within(dialog).getByText('₹2,400.00 → GST 5%')).toBeInTheDocument()
    expect(within(dialog).getByText(/₹2,400 → 5%, ₹2,800 → 18%/)).toBeInTheDocument()
    const price = within(dialog).getByRole('textbox', { name: 'Price of one piece' })
    await user.clear(price)
    await user.type(price, '2800')
    expect(within(dialog).getByText('₹2,800.00 → GST 18%')).toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: 'Name (English)' }), 'Shirts')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(rec.find('POST', '/tax-slab-rules')).toHaveLength(1))
    const body = rec.find('POST', '/tax-slab-rules')[0]!.body
    expect(body).toEqual({
      name: 'Shirts',
      description: null,
      is_active: true,
      slabs: [
        { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
        { max_unit_value_paise: null, gst_rate_bp: 1800 },
      ],
    })
    expect(TaxSlabRuleCreateSchema.safeParse(body).success).toBe(true)
  })
})

describe('Promotions', () => {
  it('lists offers with status and explains them', async () => {
    await signIn(makeMe())
    const rec = recorder()
    server.use(
      ...directoryHandlers(),
      http.get(apiPath('/promotions'), async ({ request }) => {
        await rec.record(request)
        return HttpResponse.json({
          data: [
            promotion(),
            promotion({
              name: 'Soap 2+1',
              name_ta: null,
              kind: 'buy_x_get_y',
              status: 'scheduled',
              rules: { all_items: true, buy_qty: 2, get_qty: 1 },
            }),
          ],
          page: page(2),
        })
      }),
    )
    const user = userEvent.setup()
    renderApp('/catalog/promotions')
    expect(await screen.findByText('Deepavali 10% off', undefined, LONG)).toBeInTheDocument()
    expect(screen.getByText('10% off the bill')).toBeInTheDocument()
    expect(screen.getByText('Buy 2 get 1 free')).toBeInTheDocument()
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('tab', { name: 'Scheduled' }))
    await waitFor(() =>
      expect(
        rec.find('GET', '/promotions').some((c) => c.query.get('status') === 'scheduled'),
      ).toBe(true),
    )
  })

  it('creates a buy-X-get-Y offer on a category with a worked example', async () => {
    await signIn(makeMe())
    const rec = recorder()
    server.use(
      ...directoryHandlers(),
      http.get(apiPath('/promotions'), () => HttpResponse.json({ data: [], page: page(0) })),
      http.post(apiPath('/promotions'), async ({ request }) => {
        const r = await rec.record(request)
        return HttpResponse.json(
          { data: promotion({ ...(r.body as object), status: 'active' }) },
          { status: 201 },
        )
      }),
    )
    const user = userEvent.setup()
    renderApp('/catalog/promotions?new=1')
    const panel = await screen.findByRole('dialog', { name: 'New offer' }, LONG)
    await user.type(within(panel).getByRole('textbox', { name: 'Offer name' }), 'Rice 2+1')
    await user.click(within(panel).getByRole('radio', { name: /Buy X get Y/ }))
    await user.click(within(panel).getByRole('combobox', { name: /Categories/ }))
    const picker = (await screen.findAllByRole('dialog')).at(-1)!
    await user.click(await within(picker).findByRole('option', { name: /Rice/ }))
    expect(within(panel).getByText('Buy 2 get 1 free')).toBeInTheDocument()
    expect(
      within(panel).getByText('Example: 3 pieces × ₹100 = ₹300 → ₹100 off, customer pays ₹200.'),
    ).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Create offer' }))
    await waitFor(() => expect(rec.find('POST', '/promotions')).toHaveLength(1))
    const body = rec.find('POST', '/promotions')[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({
      name: 'Rice 2+1',
      kind: 'buy_x_get_y',
      store_ids: null,
      starts_at: null,
      ends_at: null,
      rules: { buy_qty: 2, get_qty: 1, get_discount_bp: 10_000, all_items: false },
    })
    expect((body.rules as { category_ids: string[] }).category_ids).toHaveLength(1)
    expect(PromotionCreateSchema.safeParse(body).success).toBe(true)
  })
})

describe('Labels', () => {
  it('prefills from the product list, previews and requests the print model', async () => {
    await signIn(makeMe())
    const rec = recorder()
    const rice = productItem()
    server.use(
      ...directoryHandlers(),
      http.get(apiPath('/products'), () => HttpResponse.json({ data: [rice], page: page(1) })),
      http.post(apiPath('/labels'), async ({ request }) => {
        await rec.record(request)
        return HttpResponse.json({
          data: {
            template: LABEL_TEMPLATES['50x25'],
            shop: { name: 'Sri Murugan Stores', name_ta: null },
            labels: [
              {
                product_id: rice.id,
                batch_id: null,
                sku: rice.sku,
                name: rice.name,
                name_ta: rice.name_ta,
                price_paise: rice.sale_price_paise,
                mrp_paise: rice.mrp_paise,
                barcode: null,
                barcode_format: null,
                barcode_generated: false,
                batch_no: null,
                expiry_date: null,
                mfg_date: null,
                size: null,
                color: null,
                variant_label: null,
                unit: 'PCS',
                pack_size: 1,
                copies: 3,
              },
            ],
            total_copies: 3,
          },
        })
      }),
    )
    const user = userEvent.setup()
    renderApp(`/catalog/labels?product_ids=${rice.id}`)
    expect(await screen.findByText('Ponni Rice 1 kg', undefined, LONG)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'One label more' }))
    await user.click(screen.getByRole('button', { name: 'One label more' }))
    expect(screen.getByText('3 labels')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(rec.find('POST', '/labels')).toHaveLength(1))
    const body = rec.find('POST', '/labels')[0]!.body
    expect(body).toEqual({
      template: '50x25',
      items: [{ product_id: rice.id, batch_id: null, copies: 3 }],
      store_id: IDS.store,
      generate_missing_barcodes: false,
    })
    expect(LabelRequestSchema.safeParse(body).success).toBe(true)
    expect(await screen.findByTitle('Preview — 3 labels')).toBeInTheDocument()
    expect(screen.getByText(/1 product has no barcode/)).toBeInTheDocument()
  })
})

describe('Import', () => {
  it('uploads a file, shows the dry-run errors and imports the valid rows', async () => {
    await signIn(makeMe())
    const rec = recorder()
    const fileId = uid()
    server.use(
      http.post(apiPath('/files'), ({ request }) => {
        expect(new URL(request.url).searchParams.get('purpose')).toBe('import')
        return HttpResponse.json(
          {
            data: {
              id: fileId,
              purpose: 'import',
              filename: 'products.csv',
              content_type: 'text/csv',
              size_bytes: 20,
              checksum_sha256: 'x',
              created_by: null,
              created_at: '2026-10-20T10:00:00.000Z',
              content_path: `/files/${fileId}/content`,
            },
          },
          { status: 201 },
        )
      }),
      http.post(apiPath('/products/import'), async ({ request }) => {
        const r = await rec.record(request)
        const dry = (r.body as { dry_run: boolean }).dry_run
        return HttpResponse.json(
          {
            data: importJob({
              file_id: fileId,
              dry_run: dry,
              ...(dry ? {} : { errors: [], error_rows: 1 }),
            }),
          },
          { status: 201 },
        )
      }),
    )
    const user = userEvent.setup()
    renderApp('/catalog/import')
    const input = await screen.findByLabelText('Choose a file', undefined, LONG)
    await user.upload(
      input,
      new File(['sku,name\nRICE-1,Rice'], 'products.csv', { type: 'text/csv' }),
    )
    expect(await screen.findByText('Not a valid amount (e.g. 68.50).')).toBeInTheDocument()
    expect(screen.getByText(/1 row has problems/)).toBeInTheDocument()
    const dry = rec.find('POST', '/products/import')[0]!.body
    expect(dry).toEqual({
      file_id: fileId,
      mode: 'upsert',
      dry_run: true,
      match_by: 'sku_or_barcode',
      create_categories: true,
      create_brands: true,
    })
    expect(ProductImportSchema.safeParse(dry).success).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Import the 2 correct rows' }))
    await waitFor(() => expect(rec.find('POST', '/products/import')).toHaveLength(2))
    expect(rec.find('POST', '/products/import')[1]!.body).toMatchObject({ dry_run: false })
    expect(await screen.findByText('2 products imported')).toBeInTheDocument()
  })
})

describe('Branch prices', () => {
  it('saves edited and cleared branch prices in one request', async () => {
    await signIn(makeMe({ features: ['catalog', 'store_pricing', 'multi_store'] }))
    const rec = recorder()
    const a = uid()
    const b = uid()
    const row = (id: string, name: string, store: number | null) => ({
      store_id: IDS.store,
      product_id: id,
      sku: null,
      name,
      name_ta: null,
      unit: 'PCS',
      pack_size: 1,
      base_sale_price_paise: 10_000,
      base_mrp_paise: 12_000,
      store_sale_price_paise: store,
      store_mrp_paise: null,
      updated_at: null,
    })
    server.use(
      ...directoryHandlers(),
      http.get(apiPath('/store-prices'), () =>
        HttpResponse.json({
          data: [row(a, 'Sugar 1 kg', 9_500), row(b, 'Salt 1 kg', null)],
          page: page(2),
        }),
      ),
      http.put(apiPath('/store-prices'), async ({ request }) => {
        await rec.record(request)
        return HttpResponse.json({ data: { upserted: 1, deleted: 1 } })
      }),
    )
    const user = userEvent.setup()
    renderApp('/catalog/store-prices')
    await screen.findByText('Salt 1 kg', undefined, LONG)
    await user.type(screen.getByRole('textbox', { name: 'Branch price of Salt 1 kg' }), '95')
    await user.click(screen.getByRole('button', { name: 'Use normal price for Sugar 1 kg' }))
    expect(screen.getByText('2 changes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save 2 prices' }))
    await waitFor(() => expect(rec.find('PUT', '/store-prices')).toHaveLength(1))
    const body = rec.find('PUT', '/store-prices')[0]!.body
    expect(body).toEqual({
      store_id: IDS.store,
      upserts: [{ product_id: b, sale_price_paise: 9_500, mrp_paise: null }],
      deletes: [a],
    })
    expect(StorePricesUpdateSchema.safeParse(body).success).toBe(true)
  })

  it('is behind the store_pricing feature', async () => {
    await signIn(makeMe({ features: ['catalog'] }))
    renderApp('/catalog/store-prices')
    expect(
      await screen.findByText('Not included in your plan', undefined, LONG),
    ).toBeInTheDocument()
  })
})
