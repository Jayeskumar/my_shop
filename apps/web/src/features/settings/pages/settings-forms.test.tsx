import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SettingsPatchSchema, identityRoutes } from '@kadai/shared/api/identity'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { DEFAULT_SETTINGS, mergeSettings, type TenantSettings } from '@kadai/shared/settings'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { ScaleBarcodeConfigSchema } from '@kadai/shared/scale'
import { sampleScaleBarcode } from '../lib/scale'
import { page, settingsResponse } from '../testing/fixtures'
import { onRoute, type RecordedRequest } from '../testing/handlers'

function serveSettings(initial: TenantSettings = DEFAULT_SETTINGS) {
  const calls: RecordedRequest[] = []
  let current = initial
  server.use(
    onRoute(identityRoutes.getSettings, () => ({ data: settingsResponse(current) })),
    onRoute(
      identityRoutes.updateSettings,
      (req) => {
        current = mergeSettings(current, req.body)
        return { data: settingsResponse(current) }
      },
      calls,
    ),
  )
  return calls
}

describe('invoice & printing', () => {
  it('patches only the changed fields and updates the live preview', async () => {
    const user = userEvent.setup()
    const calls = serveSettings()
    await signIn()
    renderApp('/settings/invoice')
    const preview = await screen.findByRole('img', { name: 'Sample bill with these settings' })
    expect(within(preview).getAllByText(/HSN 1006/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('switch', { name: 'Show HSN codes' }))
    expect(within(preview).queryByText(/HSN 1006/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /58 mm thermal receipt/ }))
    const footer = screen.getByLabelText(/^Footer \(English\)/)
    await user.clear(footer)
    await user.type(footer, 'Thank you! Come again.')
    expect(within(preview).getByText('Thank you! Come again.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({
      invoice: {
        print_format: 'thermal_58',
        show_hsn: false,
        footer_text: 'Thank you! Come again.',
      },
    })
    expect(SettingsPatchSchema.safeParse(calls[0]!.body).success).toBe(true)
    expect(await screen.findByText('Invoice settings saved')).toBeInTheDocument()
  })
})

describe('POS & stock', () => {
  it('reads a test scan with the scale layout and refuses a broken layout', async () => {
    const user = userEvent.setup()
    const calls = serveSettings(
      mergeSettings(DEFAULT_SETTINGS, { pos: { scale_barcode: { enabled: true } } }),
    )
    await signIn(makeMe({ features: [...DEFAULT_PLAN_FEATURES.growth] }))
    renderApp('/settings/pos')
    const scan = await screen.findByLabelText(/^Test a label/)
    const code = sampleScaleBarcode(ScaleBarcodeConfigSchema.parse({ enabled: true }))!
    await user.type(scan, code)
    expect(await screen.findByText('Item code 00123')).toBeInTheDocument()
    expect(screen.getByText(/^1\.25/)).toBeInTheDocument()

    const digits = screen.getByLabelText(/^Item code digits/)
    await user.clear(digits)
    await user.type(digits, '4')
    expect(await screen.findByText(/don't make 13 digits/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(
      await screen.findByText('Prefix + item code + value + 1 check digit must make 13 digits'),
    ).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('adds quick keys with the product picker', async () => {
    const user = userEvent.setup()
    const calls = serveSettings()
    const product = {
      id: '0192f0a0-0000-7000-8000-000000000901',
      parent_id: null,
      kind: 'standard' as const,
      sku: 'TEA',
      name: 'Tea powder 250 g',
      name_ta: 'டீத்தூள் 250 கி',
      category_id: null,
      category_name: null,
      category_path: null,
      brand_id: null,
      brand_name: null,
      unit: 'PCS',
      pack_size: 1,
      hsn_code: '0902',
      gst_rate_bp: 500,
      tax_slab_rule_id: null,
      price_includes_tax: true,
      mrp_paise: 15_000,
      sale_price_paise: 14_000,
      purchase_price_paise: 12_000,
      track_inventory: true,
      track_batches: false,
      is_active: true,
      image_file_id: null,
      primary_barcode: null,
      variant_attributes: {},
      variant_count: 0,
      reorder_level_milli: 0,
      stock_qty_milli: 10_000,
      low_stock: false,
      updated_at: '2026-10-20T10:00:00.000Z',
    }
    server.use(onRoute(catalogRoutes.listProducts, { data: [product], page: page(1, 20) }))
    await signIn()
    renderApp('/settings/pos')
    await user.click(await screen.findByRole('combobox', { name: 'Add a product to quick keys' }))
    await user.keyboard('tea')
    await user.click(await screen.findByRole('option', { name: /Tea powder 250 g/ }))
    expect(await screen.findByRole('list', { name: 'Quick keys' })).toHaveTextContent(
      'Tea powder 250 g',
    )
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({ pos: { quick_keys: [product.id] } })
  })
})

describe('loyalty & credit', () => {
  it('shows a worked example and saves the earn rate', async () => {
    const user = userEvent.setup()
    const calls = serveSettings(mergeSettings(DEFAULT_SETTINGS, { loyalty: { enabled: true } }))
    await signIn(makeMe({ features: [...DEFAULT_PLAN_FEATURES.growth] }))
    renderApp('/settings/loyalty')
    expect(
      await screen.findByText(/a ₹1,000 bill earns 10 points worth ₹10.00/),
    ).toBeInTheDocument()
    const rate = screen.getByLabelText(/^Points per ₹100/)
    await user.clear(rate)
    await user.type(rate, '2')
    expect(await screen.findByText(/earns 20 points worth ₹20.00/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({ loyalty: { points_per_100_rupees: 2 } })
  })
})
