/**
 * UPI helpers of the counter: which provider takes a payment (a dynamic QR provider with
 * automatic confirmation when online, else the shop's own UPI ID — which also works offline,
 * confirmed by the cashier), and the static `upi://pay` QR (shared buildUpiUri).
 */
import type { PaymentProviderPublic } from '@kadai/shared/api/payments'
import { buildUpiUri } from '@kadai/shared/upi'
import type { PosContext } from './types'

type Providers = PosContext['payment_providers']

function rank(storeId: string): (a: PaymentProviderPublic, b: PaymentProviderPublic) => number {
  return (a, b) =>
    Number(b.store_id === storeId) - Number(a.store_id === storeId) ||
    Number(b.is_default) - Number(a.is_default)
}

/** The shop's UPI ID account (upi_vpa) for the store, if any. */
export function staticUpiProvider(
  providers: Providers,
  storeId: string,
): PaymentProviderPublic | null {
  return (
    providers
      .filter(
        (p) => p.provider === 'upi_vpa' && p.vpa && (p.store_id === null || p.store_id === storeId),
      )
      .sort(rank(storeId))[0] ?? null
  )
}

/** A provider with dynamic, auto-confirmed QR codes (Razorpay / mock), if any. */
export function dynamicUpiProvider(
  providers: Providers,
  storeId: string,
): PaymentProviderPublic | null {
  return (
    providers
      .filter(
        (p) =>
          p.capabilities.dynamic_qr &&
          p.capabilities.implemented &&
          (p.store_id === null || p.store_id === storeId),
      )
      .sort(rank(storeId))[0] ?? null
  )
}

/** Static UPI QR with the amount (null when the account has no usable UPI ID). */
export function staticUpiUri(
  provider: PaymentProviderPublic,
  input: { payee: string; amount_paise: number; note?: string; reference?: string },
): string | null {
  if (!provider.vpa) return null
  try {
    return buildUpiUri({
      vpa: provider.vpa,
      payee_name: provider.payee_name?.trim() || input.payee,
      amount_paise: input.amount_paise,
      ...(input.note ? { note: input.note } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(provider.merchant_code ? { mcc: provider.merchant_code } : {}),
    })
  } catch {
    return null
  }
}
