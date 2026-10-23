import { configure, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import { errorResponse, server } from '@/test/msw'
import { renderApp, signOutState } from '@/test/render'
import * as F from '../testing/fixtures'
import { createPaymentsApi, json, type Reply, type RouteKey } from '../testing/handlers'

// Route chunks load lazily; under the parallel full suite that can take over a second.
configure({ asyncUtilTimeout: 5_000 })

function setup(replies: Partial<Record<RouteKey, Reply>> = {}) {
  const api = createPaymentsApi(replies)
  server.use(...api.handlers)
  return api
}

describe('Public pay page', () => {
  it('shows the shop, the amount, a UPI deep link and the QR without signing in', async () => {
    const api = setup()
    await signOutState()
    renderApp(`/pay/${F.PAY_CODE}`)
    expect(await screen.findByRole('heading', { name: 'Sri Murugan Stores' })).toBeInTheDocument()
    expect(screen.getByText('ஸ்ரீ முருகன் ஸ்டோர்ஸ்')).toBeInTheDocument()
    expect(screen.getByText('Hello Ravi,')).toBeInTheDocument()
    expect(screen.getByTestId('pay-amount')).toHaveTextContent('₹1,430.00')
    const pay = screen.getByRole('link', { name: 'Pay ₹1,430.00 with UPI' })
    expect(pay.getAttribute('href')).toMatch(/^upi:\/\/pay\?pa=murugan\.stores@okaxis/)
    expect(pay.getAttribute('href')).toContain(`tr=${F.PAY_CODE}`)
    expect(screen.getByRole('img', { name: 'UPI QR code to pay ₹1,430.00' })).toBeInTheDocument()
    expect(screen.getByText(/Link valid till 23-10-2026/)).toBeInTheDocument()

    const call = api.callsTo(paymentsRoutes.publicPayPage)[0]!
    expect(call.path).toBe(`/public/v1/pay/${F.PAY_CODE}`)
    expect(call.headers.get('authorization')).toBeNull()
  })

  it('switches to Tamil', async () => {
    setup()
    const user = userEvent.setup()
    await signOutState()
    renderApp(`/pay/${F.PAY_CODE}`)
    await screen.findByRole('heading', { name: 'Sri Murugan Stores' })
    await user.click(screen.getByRole('radio', { name: 'தமிழ்' }))
    expect(
      await screen.findByRole('heading', { name: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /UPI/ })).toHaveTextContent('₹1,430.00')
  })

  it('shows the paid state', async () => {
    setup({
      publicPayPage: () =>
        json({
          data: F.publicPayPage({
            status: 'paid',
            upi_uri: null,
            paid_at: '2026-10-20T10:01:10.000Z',
          }),
        }),
    })
    await signOutState()
    renderApp(`/pay/${F.PAY_CODE}`)
    expect(await screen.findByText('Payment received')).toBeInTheDocument()
    expect(screen.getByText(/Paid on 20-10-2026/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /with UPI/ })).not.toBeInTheDocument()
  })

  it('says when a link has expired', async () => {
    setup({
      publicPayPage: () => json({ data: F.publicPayPage({ status: 'expired', upi_uri: null }) }),
    })
    await signOutState()
    renderApp(`/pay/${F.PAY_CODE}`)
    expect(await screen.findByText('This payment link has expired')).toBeInTheDocument()
    expect(screen.getByText('Please contact the shop for a new link.')).toBeInTheDocument()
  })

  it('handles unknown and malformed codes', async () => {
    const api = setup({ publicPayPage: () => errorResponse(404, 'NOT_FOUND') })
    await signOutState()
    const { unmount } = renderApp('/pay/KD0000000000')
    expect(await screen.findByText('Payment link not found')).toBeInTheDocument()
    unmount()
    renderApp('/pay/not-a-code')
    expect(await screen.findByText('Payment link not found')).toBeInTheDocument()
    await waitFor(() => expect(api.callsTo(paymentsRoutes.publicPayPage)).toHaveLength(1))
  })
})
