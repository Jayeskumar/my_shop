import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PaymentIntentConfirmSchema, paymentsRoutes } from '@kadai/shared/api/payments'
import { parseUpiUri } from '@kadai/shared/upi'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderWithProviders, signIn } from '@/test/render'
import * as F from '../testing/fixtures'
import { createPaymentsApi } from '../testing/handlers'
import { sseResponse } from '../testing/sse'
import { PaymentMethodIcon, UpiQrPanel } from './index'

function setup(replies: Parameters<typeof createPaymentsApi>[0] = {}) {
  const api = createPaymentsApi(replies)
  server.use(...api.handlers)
  return api
}

describe('UpiQrPanel', () => {
  it('shows the QR, amount and countdown of a shop-UPI-ID intent and confirms it by hand', async () => {
    const api = setup()
    const onPaid = vi.fn()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderWithProviders(<UpiQrPanel intent={F.intent()} onPaid={onPaid} />)

    expect(screen.getByTestId('upi-amount')).toHaveTextContent('₹250.00')
    const qr = screen.getByRole('img', { name: 'UPI QR code to pay ₹250.00' })
    const parsed = parseUpiUri(qr.getAttribute('data-qr-value') ?? '')
    expect(parsed).toMatchObject({ vpa: 'murugan.stores@okaxis', amount_paise: 250_00 })
    expect(screen.getByText(/^[45]:\d\d left$/)).toBeInTheDocument()
    expect(screen.getByText('Waiting — confirm when the money arrives')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/UTR \/ transaction number/), 'abc')
    await user.click(screen.getByRole('button', { name: 'Payment received' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/UTR should be 6–35/)
    expect(api.callsTo(paymentsRoutes.confirmIntent)).toHaveLength(0)

    await user.clear(screen.getByLabelText(/UTR \/ transaction number/))
    await user.type(screen.getByLabelText(/UTR \/ transaction number/), '6281 9477 3311')
    await user.click(screen.getByRole('button', { name: 'Payment received' }))
    await waitFor(() => expect(api.callsTo(paymentsRoutes.confirmIntent)).toHaveLength(1))
    expect(
      PaymentIntentConfirmSchema.parse(api.callsTo(paymentsRoutes.confirmIntent)[0]!.body),
    ).toEqual({ utr: '628194773311' })
    expect(await screen.findByTestId('upi-paid')).toHaveTextContent('₹250.00 received')
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1))
    expect(onPaid.mock.calls[0]![0]).toMatchObject({ id: F.ID.intentPending, status: 'paid' })
  })

  it('turns green by itself when Razorpay confirms over the live stream', async () => {
    const rzp = F.intent({
      id: F.ID.intentRzp,
      provider: 'razorpay',
      provider_display_name: 'Razorpay',
      upi_uri: null,
      image_url: 'https://rzp.io/qr/abc.png',
    })
    setup({ streamIntent: () => sseResponse([rzp, F.paidIntent(rzp)], { delayMs: 40 }) })
    const onPaid = vi.fn()
    const onStatusChange = vi.fn()
    await signIn(makeMe())
    renderWithProviders(<UpiQrPanel intent={rzp} onPaid={onPaid} onStatusChange={onStatusChange} />)
    // The provider-hosted QR image is used when there is no upi:// URI.
    expect(screen.getByRole('img', { name: 'UPI QR code to pay ₹250.00' })).toHaveAttribute(
      'src',
      'https://rzp.io/qr/abc.png',
    )
    // No manual confirmation for automatic providers.
    expect(screen.queryByRole('button', { name: 'Payment received' })).not.toBeInTheDocument()
    expect(await screen.findByTestId('upi-paid')).toHaveTextContent('₹250.00 received')
    expect(screen.getByText('628194773311')).toBeInTheDocument()
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1))
    expect(onStatusChange.mock.calls.map(([i]) => (i as { status: string }).status)).toEqual([
      'pending',
      'paid',
    ])
  })

  it('warns when the customer paid a different amount', async () => {
    setup()
    await signIn(makeMe())
    const paid = F.paidIntent(F.intent(), { paid_amount_paise: 200_00, amount_mismatch: true })
    renderWithProviders(<UpiQrPanel intent={paid} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Customer paid ₹200.00, but the bill was ₹250.00. Please check.',
    )
  })

  it('offers a new QR for an expired intent', async () => {
    setup()
    const onRegenerate = vi.fn()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderWithProviders(
      <UpiQrPanel
        intent={F.intent({ status: 'expired', expires_in_seconds: 0 })}
        onRegenerate={onRegenerate}
      />,
    )
    expect(screen.getByText('QR expired')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New QR' }))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
  })

  it('cancels a waiting intent at the server', async () => {
    const api = setup()
    const onCancelled = vi.fn()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderWithProviders(<UpiQrPanel intent={F.intent()} onCancelled={onCancelled} />)
    await user.click(screen.getByRole('button', { name: 'Cancel QR' }))
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1))
    expect(api.callsTo(paymentsRoutes.cancelIntent)).toHaveLength(1)
    expect(await screen.findByText('QR cancelled')).toBeInTheDocument()
  })

  it('hides manual confirmation from members who cannot collect', async () => {
    setup()
    await signIn(makeMe({ permissions: PERMISSION_CODES.filter((p) => p !== 'payments.collect') }))
    renderWithProviders(<UpiQrPanel intent={F.intent()} />)
    expect(screen.getByRole('img', { name: 'UPI QR code to pay ₹250.00' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Payment received' })).not.toBeInTheDocument()
  })

  it('builds an offline QR from the shop UPI ID in static mode', async () => {
    const onManualConfirm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <UpiQrPanel
        static={{
          vpa: 'murugan.stores@okaxis',
          payee_name: 'Sri Murugan Stores',
          amount_paise: 1_234_50,
          note: 'Bill S1-A/2627/00981',
          reference: 'S1A262700981',
        }}
        onManualConfirm={onManualConfirm}
      />,
    )
    const qr = screen.getByRole('img', { name: 'UPI QR code to pay ₹1,234.50' })
    expect(parseUpiUri(qr.getAttribute('data-qr-value') ?? '')).toMatchObject({
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Sri Murugan Stores',
      amount_paise: 1_234_50,
      reference: 'S1A262700981',
    })
    await user.click(screen.getByRole('button', { name: 'Payment received' }))
    expect(onManualConfirm).toHaveBeenCalledWith({ utr: null })
    expect(screen.getByRole('button', { name: 'Payment received' })).toBeDisabled()
  })

  it('names the payment method icon only when asked', () => {
    const { rerender } = renderWithProviders(<PaymentMethodIcon method="upi" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    rerender(<PaymentMethodIcon method="cash" label="Cash" />)
    expect(screen.getByRole('img', { name: 'Cash' })).toBeInTheDocument()
  })
})
