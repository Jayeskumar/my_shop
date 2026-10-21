import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type * as PosPrint from '@/features/pos/print'
import { printSalesModel } from '@/features/pos/print'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { ESTIMATE_ID, SHARE_TOKEN, publicInvoice } from '../testing/fixtures'
import { apiError, createSalesApi, json } from '../testing/handlers'

/** The first render loads the lazy route module (slow on a busy machine). */
const FIRST_PAINT = { timeout: 5_000 }

vi.mock('@/features/pos/print', async (importOriginal) => {
  const actual = await importOriginal<typeof PosPrint>()
  return { ...actual, printSalesModel: vi.fn(async () => undefined) }
})

function setup(replies: Parameters<typeof createSalesApi>[0] = {}) {
  const api = createSalesApi(replies)
  server.use(...api.handlers)
  return api
}

describe('Estimates', () => {
  it('lists open estimates and switches views', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/sales/estimates')
    const table = await screen.findByRole('table', { name: 'Estimates' }, FIRST_PAINT)
    expect(await within(table).findByRole('link', { name: 'EST/2627/00021' })).toHaveAttribute(
      'href',
      `/sales/invoices/${ESTIMATE_ID}`,
    )
    const first = api.callsTo('listInvoices')[0]!.query
    expect(first.getAll('doc_type')).toEqual(['estimate'])
    expect(first.getAll('status')).toEqual(['completed'])
    expect(first.get('from')).toBeNull()
    await user.click(screen.getByRole('tab', { name: 'Converted' }))
    await waitFor(() =>
      expect(api.callsTo('listInvoices').at(-1)!.query.getAll('status')).toEqual(['converted']),
    )
  })
})

describe('Public invoice page', () => {
  it("shows the bill in the document's language with a UPI pay button", async () => {
    const api = setup()
    const user = userEvent.setup()
    renderApp(`/i/${SHARE_TOKEN}`)
    expect(
      await screen.findByRole('heading', { name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' }, FIRST_PAINT),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'வரி விலைப்பட்டியல்' })).toBeInTheDocument()
    expect(api.callsTo('publicInvoice')[0]!.headers.get('authorization')).toBeNull()
    const pay = screen.getByRole('link', { name: 'UPI மூலம் ₹310.00 செலுத்துங்கள்' })
    expect(pay.getAttribute('href')).toMatch(/^upi:\/\/pay\?pa=murugan@okaxis/)

    await user.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByRole('heading', { name: 'Sri Murugan Stores' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Pay ₹310.00 by UPI' })).toBeInTheDocument()
    expect(screen.getByText('Rupees Eight Hundred Ten Only')).toBeInTheDocument()
    expect(screen.getByText('2 pcs × ₹285.00')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Download / print' }))
    await waitFor(() => expect(printSalesModel).toHaveBeenCalledTimes(1))
    const [model, options] = vi.mocked(printSalesModel).mock.calls[0]!
    expect(options).toEqual({ format: 'a4' })
    expect(model.locale.primary).toBe('en')
  })

  it('has no pay button when nothing is due', async () => {
    setup({ publicInvoice: () => json({ data: publicInvoice({ pay: null }) }) })
    renderApp(`/i/${SHARE_TOKEN}`)
    expect(
      await screen.findByRole('heading', { name: 'வரி விலைப்பட்டியல்' }, FIRST_PAINT),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /UPI/ })).not.toBeInTheDocument()
  })

  it('explains an expired link', async () => {
    setup({ publicInvoice: () => apiError(404, 'NOT_FOUND') })
    renderApp(`/i/${SHARE_TOKEN}`)
    expect(await screen.findByText('This bill link is not valid')).toBeInTheDocument()
    expect(screen.getByText('Please ask the shop to send the bill again.')).toBeInTheDocument()
  })

  it('does not even ask the server for a malformed link', async () => {
    const api = setup()
    renderApp('/i/not-a-token')
    expect(await screen.findByText('This bill link is not valid')).toBeInTheDocument()
    expect(api.callsTo('publicInvoice')).toHaveLength(0)
  })
})
