/**
 * The counter end to end in the browser runtime: bootstrap → scan → price → pay with the F-keys
 * → POST /sales/invoices (Idempotency-Key = client_ref), the offline path with local numbering,
 * and actions hidden by permissions. MSW plays the server with contract-valid fixtures.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import type { InvoiceCreate, QuoteRequest } from '@kadai/shared/api/sales'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { makeScaleBarcode } from '@kadai/shared/scale'
import { offlineDb, outbox } from '@/lib/offline/db'
import { _resetOnlineForTests } from '@/lib/online'
import { IDS, makeMe } from '@/test/fixtures'
import { ORIGIN, apiPath, server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { applyBootstrap } from '../lib/catalog'
import { priceLocalCart } from '../lib/pricing'
import { readSeries } from '../lib/series'
import type { PosProduct } from '../lib/types'
import { cartOf, invoiceResultFor, lineOf, makeBootstrap, quoteFor } from './fixtures'
import { pricingEnvOf } from './helpers'

const bootstrap = makeBootstrap()
const products = new Map<string, PosProduct>(bootstrap.products.map((p) => [p.id, p]))

interface Recorded {
  quotes: QuoteRequest[]
  invoices: Array<{ body: InvoiceCreate; key: string | null }>
}

function serverApi(): Recorded {
  const rec: Recorded = { quotes: [], invoices: [] }
  const quoteOf = (body: QuoteRequest) => {
    const cart = cartOf(
      body.lines.map((l) => {
        const product = products.get(l.product_id ?? '')
        if (!product) throw new Error(`unknown product ${l.product_id}`)
        return lineOf(product, { key: l.key ?? product.id, qty_milli: l.qty_milli })
      }),
    )
    return quoteFor(cart, priceLocalCart(cart, pricingEnvOf(bootstrap, new Date())))
  }
  server.use(
    http.get(apiPath('/pos/bootstrap'), () => HttpResponse.json({ data: bootstrap })),
    http.get(apiPath('/shifts/current'), () => HttpResponse.json({ data: null })),
    http.post(apiPath('/pos/quote'), async ({ request }) => {
      const body = (await request.json()) as QuoteRequest
      rec.quotes.push(body)
      return HttpResponse.json({ data: quoteOf(body) })
    }),
    http.post(apiPath('/sales/invoices'), async ({ request }) => {
      const body = (await request.json()) as InvoiceCreate
      rec.invoices.push({ body, key: request.headers.get('Idempotency-Key') })
      const quote = quoteOf(body as unknown as QuoteRequest)
      const cash = body.tenders?.find((t) => t.method === 'cash')?.amount_paise ?? quote.total_paise
      return HttpResponse.json(
        {
          data: invoiceResultFor(quote, {
            client_ref: body.client_ref ?? '',
            number: 'S1-A/2627/00005',
            cash_paise: cash,
          }),
        },
        { status: 201 },
      )
    }),
  )
  return rec
}

async function openCounter(me = makeMe()) {
  await signIn(me)
  renderApp('/pos')
  return screen.findByRole(
    'combobox',
    { name: 'Search product or scan barcode' },
    { timeout: 5_000 },
  )
}

async function scan(user: ReturnType<typeof userEvent.setup>, search: HTMLElement, code: string) {
  await user.clear(search)
  await user.type(search, `${code}{Enter}`)
}

beforeEach(async () => {
  await Promise.all(offlineDb.tables.map((t) => t.clear()))
})

describe('POS counter', () => {
  it('scan, "2*" multiplier, F9 cash exact → invoice saved with the bill id as Idempotency-Key', async () => {
    const rec = serverApi()
    const user = userEvent.setup()
    const search = await openCounter()

    await scan(user, search, '8901234500011')
    await scan(user, search, '2*8901234500028')
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Ponni Rice 5 kg')).toBeInTheDocument()
    expect(within(table).getByText('Toor Dal 1 kg')).toBeInTheDocument()
    expect(within(table).getByRole('textbox', { name: 'Quantity of Toor Dal 1 kg' })).toHaveValue(
      '2',
    )
    expect(screen.getAllByText('₹725.00').length).toBeGreaterThan(0)
    expect(screen.getByText('You saved ₹55.00')).toBeInTheDocument()

    await user.keyboard('{F9}')
    expect(await screen.findByText('Bill saved')).toBeInTheDocument()
    expect(screen.getByText('S1-A/2627/00005')).toBeInTheDocument()

    expect(rec.quotes).toHaveLength(1)
    expect(rec.invoices).toHaveLength(1)
    const [{ body, key }] = rec.invoices as [Recorded['invoices'][number]]
    expect(key).toBe(body.client_ref)
    expect(body).toMatchObject({
      store_id: IDS.store,
      register_id: IDS.register,
      tenders: [{ method: 'cash', amount_paise: 72_500 }],
    })
    expect(body.lines.map((l) => [l.product_id, l.qty_milli])).toEqual([
      [bootstrap.products[0]!.id, 1000],
      [bootstrap.products[1]!.id, 2000],
    ])
    // The server took number 5 of the counter series: offline numbering continues after it.
    await waitFor(async () =>
      expect((await readSeries(IDS.tenant, IDS.register, 'sales_invoice'))?.next_number).toBe(6),
    )
    // The cart is empty again, ready for the next customer.
    expect(screen.getByText('Start the bill')).toBeInTheDocument()
  })

  it('F8 opens payment, the change shows as cash is typed, F12 completes (dialog hotkeys)', async () => {
    const rec = serverApi()
    const user = userEvent.setup()
    const search = await openCounter()
    await scan(user, search, '8901234500011')

    await user.keyboard('{F8}')
    const dialog = await screen.findByRole('dialog', { name: /Payment/ })
    const cash = within(dialog).getByLabelText('Cash received')
    await waitFor(() => expect(cash).toHaveFocus())
    await user.type(cash, '500')
    expect(within(dialog).getByTestId('pos-change')).toHaveTextContent('₹105.00')

    await user.keyboard('{F10}')
    expect(within(dialog).getByRole('tab', { name: /UPI/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.keyboard('{F8}')
    expect(within(dialog).getByRole('tab', { name: /Cash/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await user.keyboard('{F12}')
    expect(await screen.findByText('Bill saved')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Payment/ })).not.toBeInTheDocument()
    expect(rec.invoices[0]?.body.tenders).toEqual([{ method: 'cash', amount_paise: 50_000 }])
    expect(screen.getByText('₹105.00')).toBeInTheDocument()
  })

  it('offline: the bill is numbered from the local series and queued for upload', async () => {
    // A counter that synced earlier: the catalogue and series are in IndexedDB.
    await applyBootstrap(IDS.tenant, IDS.register, bootstrap)
    await signIn(makeMe())
    // Then the connection drops: nothing reaches the server any more.
    server.use(
      http.all(`${ORIGIN}/health/*`, () => HttpResponse.error()),
      http.all(apiPath('/*'), () => HttpResponse.error()),
    )
    _resetOnlineForTests({ browserOnline: false })
    const user = userEvent.setup()
    renderApp('/pos')
    const search = await screen.findByRole('combobox', { name: 'Search product or scan barcode' })
    expect(screen.getByText(/^No connection\. Keep billing/)).toBeInTheDocument()

    await scan(user, search, '8901234500011')
    await user.keyboard('{F9}')
    expect(await screen.findByText('Saved on this counter (will upload)')).toBeInTheDocument()
    expect(screen.getByText('S1-A/2627/00005')).toBeInTheDocument()

    const queued = await outbox.pending(IDS.tenant)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      kind: 'invoice',
      number: 'S1-A/2627/00005',
      register_id: IDS.register,
    })
    expect(queued[0]?.payload).toMatchObject({
      client_ref: queued[0]?.client_ref,
      offline_number: 'S1-A/2627/00005',
      tenders: [{ method: 'cash', amount_paise: 39_500 }],
    })
    expect((await readSeries(IDS.tenant, IDS.register, 'sales_invoice'))?.next_number).toBe(6)
  })

  it('weighed goods ask for the weight; a scale label adds its weight directly', async () => {
    serverApi()
    const user = userEvent.setup()
    const search = await openCounter()

    await user.type(search, 'sugar')
    await screen.findByRole('option', { name: /Sugar \(loose\)/ })
    await user.keyboard('{Enter}')
    const weigh = await screen.findByRole('dialog', { name: 'Weigh Sugar (loose)' })
    await user.click(within(weigh).getByRole('button', { name: '250 g' }))
    await user.click(within(weigh).getByRole('button', { name: 'Add · ₹11.00' }))
    expect(await screen.findByRole('textbox', { name: 'Quantity of Sugar (loose)' })).toHaveValue(
      '0.25',
    )

    // Scale label: prefix 21, PLU 00102, 1.250 kg.
    await scan(
      user,
      search,
      makeScaleBarcode('21', '00102', 1250, { item_code_length: 5, value_length: 5 }),
    )
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('textbox', { name: 'Quantity of Sugar (loose)' })
          .map((i) => (i as HTMLInputElement).value),
      ).toEqual(['0.25', '1.25']),
    )
    expect(screen.queryByRole('dialog', { name: /Weigh/ })).not.toBeInTheDocument()
  })

  it('F1 shows the keyboard help', async () => {
    serverApi()
    const user = userEvent.setup()
    await openCounter()
    await user.keyboard('{F1}')
    const help = await screen.findByRole('dialog', { name: 'Keyboard & counter help' })
    expect(within(help).getByText('Cash exact')).toBeInTheDocument()
    expect(within(help).getByText('Save & print')).toBeInTheDocument()
  })

  it('actions follow permissions: no Return key without sales.return', async () => {
    serverApi()
    await openCounter(makeMe({ permissions: PERMISSION_CODES.filter((p) => p !== 'sales.return') }))
    expect(await screen.findByRole('button', { name: /Hold bill/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Return' })).not.toBeInTheDocument()
  })

  it('with sales.return the Return key is there', async () => {
    serverApi()
    await openCounter()
    expect(await screen.findByRole('button', { name: 'Return' })).toBeInTheDocument()
  })
})
